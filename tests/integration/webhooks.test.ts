/**
 * Integration tests for the git-host webhook adapter (Issue #146,
 * specs/146-git-webhook-adapter/) against a real in-memory D1.
 *
 * Receiver (POST /webhooks/git/{provider}): a verified GitHub/GitLab push
 * ingests commits under the registration's project with NO heartbeat
 * correlation (read-back "0 secs"), idempotent redelivery, the 401/404/400/202
 * response matrix, the 100-commit cap, project-from-registration, cross-user
 * isolation, and untouched aggregates. CRUD (/users/current/webhooks): the
 * create→list→read→patch→delete round-trip, the write-only secret, immutable
 * provider/repo, duplicate 409, unknown/cross-user 404, and owner-only 401.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const CRUD = "/api/v1/users/current/webhooks";

let user: SeededUser;
let other: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", timezone: "UTC" });
  other = await seedUser({ username: "bob", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("webhook_endpoints", "commits", "heartbeats", "summaries", "hourly_summaries", "user_projects", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
  await env.KV.delete(`apikey:${other.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", ...bearer(apiKey) };
}

async function githubSignature(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Register a webhook via the owner CRUD; returns the parsed response. */
async function register(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await call(CRUD, { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) });
  return { status: res.status, data: ((await res.json()) as { data?: Record<string, unknown> }).data ?? {} };
}

/** Sign and POST a GitHub delivery. */
async function postGithub(
  payload: unknown,
  secret: string,
  opts: { event?: string; signature?: string } = {},
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const signature = opts.signature ?? (await githubSignature(raw, secret));
  return call("/api/v1/webhooks/git/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": opts.event ?? "push", "X-Hub-Signature-256": signature },
    body: raw,
  });
}

function githubPush(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    repository: { full_name: "octo/hello" },
    commits: [
      {
        id: "a".repeat(40),
        message: "first commit",
        author: { name: "Ada", email: "ada@example.test" },
        committer: { name: "Grace", email: "grace@example.test" },
        timestamp: "2026-07-01T12:00:00Z",
        url: "https://github.test/octo/hello/commit/aaa",
      },
    ],
    ...overrides,
  };
}

async function listCommits(apiKey: string, project: string): Promise<{ status: number; commits: { hash: string; total_seconds?: number; human_readable_total: string }[] }> {
  const res = await call(`/api/v1/users/current/projects/${project}/commits`, { headers: bearer(apiKey) });
  const body = (await res.json()) as { data?: { hash: string; total_seconds?: number; human_readable_total: string }[] };
  return { status: res.status, commits: body.data ?? [] };
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── Receiver ────────────────────────────────────────────────────────────────

describe("POST /webhooks/git/:provider — receiver", () => {
  const SECRET = "owner-secret";

  it("ingests a verified GitHub push under the registration project with no correlation", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });

    // Heartbeats around the commit that WOULD correlate on the single-commit
    // endpoint — the receiver must ignore them (total_seconds stays absent).
    const epoch = Date.parse("2026-07-01T12:00:00Z") / 1000;
    for (const t of [epoch, epoch + 120]) {
      await env.DB.prepare(
        "INSERT INTO heartbeats (id, user_id, entity, time, project, category) VALUES (?, ?, ?, ?, 'backend', 'coding')",
      )
        .bind(crypto.randomUUID(), user.userId, "src/app.ts", t)
        .run();
    }

    const res = await postGithub(githubPush(), SECRET);
    expect(res.status).toBe(202);
    expect((await res.json()) as unknown).toEqual({
      data: { received: 1, ingested: 1, skipped: 0, project: "backend" },
    });

    const { commits } = await listCommits(user.apiKey, "backend");
    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe("a".repeat(40));
    expect(commits[0].total_seconds).toBeUndefined();
    expect(commits[0].human_readable_total).toBe("0 secs");
  });

  it("ingests a verified GitLab push (token header)", async () => {
    const token = "gitlab-token";
    await register(user.apiKey, { provider: "gitlab", repo: "grp/proj", project: "gl", secret: token });

    const payload = {
      ref: "refs/heads/main",
      project: { path_with_namespace: "grp/proj" },
      commits: [{ id: "b".repeat(40), message: "gl commit", timestamp: "2026-07-02T09:30:00Z" }],
    };
    const res = await call("/api/v1/webhooks/git/gitlab", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": token },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { data: { ingested: number } }).data.ingested).toBe(1);
    expect((await listCommits(user.apiKey, "gl")).commits).toHaveLength(1);
  });

  it("is idempotent on redelivery (one row per hash)", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    await postGithub(githubPush(), SECRET);
    const second = await postGithub(githubPush(), SECRET);
    expect(second.status).toBe(202);
    expect((await listCommits(user.apiKey, "backend")).commits).toHaveLength(1);
  });

  it("rejects a wrong signature with 401 and writes nothing", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    const res = await postGithub(githubPush(), SECRET, { signature: "sha256=deadbeef" });
    expect(res.status).toBe(401);
    expect((await listCommits(user.apiKey, "backend")).commits).toHaveLength(0);
    expect(await countRows("commits")).toBe(0);
  });

  it("returns 404 for an unregistered repo", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    const res = await postGithub(githubPush({ repository: { full_name: "octo/other" } }), SECRET);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unsupported provider", async () => {
    const res = await call("/api/v1/webhooks/git/bitbucket", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push" },
      body: JSON.stringify(githubPush()),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a disabled registration", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET, is_enabled: false });
    const res = await postGithub(githubPush(), SECRET);
    expect(res.status).toBe(404);
    expect(await countRows("commits")).toBe(0);
  });

  it("acknowledges a ping / non-push event with 202 and zero counts", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    const res = await postGithub({}, SECRET, { event: "ping" });
    expect(res.status).toBe(202);
    expect((await res.json()) as unknown).toEqual({ data: { received: 0, ingested: 0, skipped: 0 } });
    expect(await countRows("commits")).toBe(0);
  });

  it("returns 400 for an unparseable body", async () => {
    const res = await call("/api/v1/webhooks/git/github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=x" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the event header is missing", async () => {
    const raw = JSON.stringify(githubPush());
    const res = await call("/api/v1/webhooks/git/github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": await githubSignature(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a push that identifies no repository", async () => {
    const res = await postGithub({ ref: "refs/heads/main", commits: [{ id: "c".repeat(40) }] }, SECRET);
    expect(res.status).toBe(400);
  });

  it("caps at 100 commits and reports the remainder in skipped", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    const commits = Array.from({ length: 101 }, (_, i) => ({
      id: i.toString(16).padStart(40, "0"),
      message: `commit ${i}`,
      timestamp: "2026-07-01T12:00:00Z",
    }));
    const res = await postGithub(githubPush({ commits }), SECRET);
    expect(res.status).toBe(202);
    expect((await res.json()) as unknown).toEqual({
      data: { received: 101, ingested: 100, skipped: 1, project: "backend" },
    });
  });

  it("ingests under the registration project, not any payload field", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    // A misleading top-level `project` in the payload must be ignored.
    const res = await postGithub(githubPush({ project: "payload-project" }), SECRET);
    expect(((await res.json()) as { data: { project: string } }).data.project).toBe("backend");
    expect((await listCommits(user.apiKey, "backend")).commits).toHaveLength(1);
    expect((await listCommits(user.apiKey, "payload-project")).commits).toHaveLength(0);
  });

  it("resolves the delivery to the registering user (cross-user isolation)", async () => {
    await register(user.apiKey, { provider: "github", repo: "alice/repo", project: "aliceproj", secret: "alice-secret" });
    await register(other.apiKey, { provider: "github", repo: "bob/repo", project: "bobproj", secret: "bob-secret" });

    const res = await postGithub(githubPush({ repository: { full_name: "bob/repo" } }), "bob-secret");
    expect(res.status).toBe(202);

    expect((await listCommits(other.apiKey, "bobproj")).commits).toHaveLength(1);
    expect((await listCommits(user.apiKey, "aliceproj")).commits).toHaveLength(0);
  });

  it("does not touch the aggregate tables", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: SECRET });
    await postGithub(githubPush(), SECRET);
    expect(await countRows("summaries")).toBe(0);
    expect(await countRows("hourly_summaries")).toBe(0);
    expect(await countRows("user_projects")).toBe(0);
  });
});

// ─── Owner CRUD ──────────────────────────────────────────────────────────────

describe("/users/current/webhooks — owner CRUD", () => {
  it("round-trips create → list → read → patch → delete, never exposing the secret", async () => {
    const created = await register(user.apiKey, {
      provider: "github",
      repo: "octo/hello",
      project: "backend",
      secret: "s3cr3t",
    });
    expect(created.status).toBe(201);
    expect(created.data.id).toBeTruthy();
    expect(created.data.provider).toBe("github");
    expect(created.data.repo).toBe("octo/hello");
    expect(created.data.is_enabled).toBe(true);
    expect(created.data).not.toHaveProperty("secret");
    const id = created.data.id as string;

    const list = await call(CRUD, { headers: bearer(user.apiKey) });
    const listBody = (await list.json()) as { data: Record<string, unknown>[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).not.toHaveProperty("secret");

    const read = await call(`${CRUD}/${id}`, { headers: bearer(user.apiKey) });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("secret");

    const patch = await call(`${CRUD}/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ project: "frontend", secret: "rotated", is_enabled: false }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: Record<string, unknown> };
    expect(patched.data.project).toBe("frontend");
    expect(patched.data.is_enabled).toBe(false);
    expect(patched.data).not.toHaveProperty("secret");

    const del = await call(`${CRUD}/${id}`, { method: "DELETE", headers: bearer(user.apiKey) });
    expect(del.status).toBe(204);
    expect((await call(`${CRUD}/${id}`, { headers: bearer(user.apiKey) })).status).toBe(404);
  });

  it("rejects immutable provider/repo changes and an empty patch with 400", async () => {
    const created = await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: "s" });
    const id = created.data.id as string;

    for (const patch of [{ provider: "gitlab" }, { repo: "octo/other" }, {}]) {
      const res = await call(`${CRUD}/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(user.apiKey),
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a duplicate (provider, repo) with 409", async () => {
    await register(user.apiKey, { provider: "github", repo: "octo/hello", project: "backend", secret: "s" });
    const dup = await call(CRUD, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ provider: "github", repo: "octo/hello", project: "other", secret: "s2" }),
    });
    expect(dup.status).toBe(409);
  });

  it.each([
    ["missing provider", { repo: "octo/hello", project: "backend", secret: "s" }],
    ["unsupported provider", { provider: "bitbucket", repo: "octo/hello", project: "backend", secret: "s" }],
    ["empty repo", { provider: "github", repo: "", project: "backend", secret: "s" }],
    ["missing secret", { provider: "github", repo: "octo/hello", project: "backend" }],
  ])("rejects create with %s (400)", async (_label, body) => {
    const res = await call(CRUD, { method: "POST", headers: jsonHeaders(user.apiKey), body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown and cross-user ids", async () => {
    const bob = await register(other.apiKey, { provider: "github", repo: "bob/repo", project: "bobproj", secret: "s" });
    const bobId = bob.data.id as string;

    expect((await call(`${CRUD}/nope`, { headers: bearer(user.apiKey) })).status).toBe(404);
    expect((await call(`${CRUD}/${bobId}`, { headers: bearer(user.apiKey) })).status).toBe(404);
    expect(
      (await call(`${CRUD}/${bobId}`, { method: "PATCH", headers: jsonHeaders(user.apiKey), body: JSON.stringify({ project: "x" }) })).status,
    ).toBe(404);
    expect((await call(`${CRUD}/${bobId}`, { method: "DELETE", headers: bearer(user.apiKey) })).status).toBe(404);

    // Bob's row is untouched by Alice's failed cross-user calls.
    expect((await call(`${CRUD}/${bobId}`, { headers: bearer(other.apiKey) })).status).toBe(200);
  });

  it("returns 401 without authentication", async () => {
    expect((await call(CRUD)).status).toBe(401);
    expect(
      (await call(CRUD, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "github", repo: "r", project: "p", secret: "s" }) })).status,
    ).toBe(401);
  });
});
