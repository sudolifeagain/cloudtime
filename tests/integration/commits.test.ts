/**
 * Integration tests for the Commits read endpoints (specs/107-commits/).
 * Seeds the `commits` table directly (ingestion is deferred) and exercises
 * list pagination/ordering/filters, single + 404, empty project, invalid
 * page, cross-user isolation, and auth.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const PROJECT = "cloudtime";
const COMMITS = `/api/v1/users/current/projects/${PROJECT}/commits`;

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("commits", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
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

async function postCommit(project: string, body: unknown, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) Object.assign(headers, bearer(apiKey));
  return call(`/api/v1/users/current/projects/${project}/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface SeedCommit {
  hash: string;
  authorDate?: string | null;
  message?: string | null;
  totalSeconds?: number | null;
  authorEmail?: string;
  ref?: string;
  project?: string;
}

async function seedCommits(userId: string, items: SeedCommit[]): Promise<void> {
  const stmts = items.map((c) =>
    env.DB.prepare(
      `INSERT INTO commits (id, user_id, project, hash, message, author_name, author_email, author_date, total_seconds, ref)
       VALUES (?, ?, ?, ?, ?, 'Nao', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      c.project ?? PROJECT,
      c.hash,
      Object.prototype.hasOwnProperty.call(c, "message") ? (c.message ?? null) : `msg ${c.hash}`,
      c.authorEmail ?? "nao@example.com",
      c.authorDate ?? null,
      c.totalSeconds ?? null,
      c.ref ?? "main",
    ),
  );
  await env.DB.batch(stmts);
}

interface CommitShape {
  hash: string;
  message: string;
  author_date: string;
  human_readable_total: string;
  total_seconds?: number;
  ref?: string;
}

describe("GET .../commits (list)", () => {
  it("returns 401 when unauthenticated", async () => {
    expect((await call(COMMITS)).status).toBe(401);
  });

  it("lists newest-first with page/total_pages and human_readable_total", async () => {
    await seedCommits(user.userId, [
      { hash: "old", authorDate: "2026-05-20T10:00:00Z", totalSeconds: 1800 },
      { hash: "new", authorDate: "2026-05-22T10:00:00Z", totalSeconds: 3600 },
      { hash: "mid", authorDate: "2026-05-21T10:00:00Z", totalSeconds: null },
    ]);

    const res = await call(COMMITS, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: CommitShape[]; page: number; total_pages: number };
    expect(body.page).toBe(1);
    expect(body.total_pages).toBe(1);
    expect(body.data.map((c) => c.hash)).toEqual(["new", "mid", "old"]);
    // NULL total_seconds → human_readable_total still present
    expect(body.data.find((c) => c.hash === "mid")?.human_readable_total).toBeTruthy();
  });

  it("paginates at 100 per page", async () => {
    const items: SeedCommit[] = Array.from({ length: 101 }, (_, i) => ({
      hash: `h${String(i).padStart(3, "0")}`,
      authorDate: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    await seedCommits(user.userId, items);

    const p1 = await call(`${COMMITS}?page=1`, { headers: bearer(user.apiKey) });
    const b1 = (await p1.json()) as { data: CommitShape[]; total_pages: number };
    expect(b1.data).toHaveLength(100);
    expect(b1.total_pages).toBe(2);

    const p2 = await call(`${COMMITS}?page=2`, { headers: bearer(user.apiKey) });
    const b2 = (await p2.json()) as { data: CommitShape[] };
    expect(b2.data).toHaveLength(1);
  });

  it("filters by author and branch", async () => {
    await seedCommits(user.userId, [
      { hash: "a", authorDate: "2026-05-20T10:00:00Z", authorEmail: "nao@example.com", ref: "main" },
      { hash: "b", authorDate: "2026-05-21T10:00:00Z", authorEmail: "other@example.com", ref: "dev" },
    ]);

    const byAuthor = await call(`${COMMITS}?author=nao@example.com`, { headers: bearer(user.apiKey) });
    expect(((await byAuthor.json()) as { data: CommitShape[] }).data.map((c) => c.hash)).toEqual(["a"]);

    const byBranch = await call(`${COMMITS}?branch=dev`, { headers: bearer(user.apiKey) });
    expect(((await byBranch.json()) as { data: CommitShape[] }).data.map((c) => c.hash)).toEqual(["b"]);
  });

  it("returns {data:[], total_pages:0} for an empty project", async () => {
    const res = await call("/api/v1/users/current/projects/never-seen/commits", { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], page: 1, total_pages: 0 });
  });

  it("400s on an invalid page", async () => {
    expect((await call(`${COMMITS}?page=abc`, { headers: bearer(user.apiKey) })).status).toBe(400);
    expect((await call(`${COMMITS}?page=0`, { headers: bearer(user.apiKey) })).status).toBe(400);
  });

  it("isolates commits per user (same project name)", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await seedCommits(bob.userId, [{ hash: "bobs", authorDate: "2026-05-20T10:00:00Z" }]);

    const res = await call(COMMITS, { headers: bearer(user.apiKey) });
    expect(((await res.json()) as { data: CommitShape[] }).data).toEqual([]);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});

describe("GET .../commits/:hash (single)", () => {
  it("returns the commit, with branch filter support", async () => {
    await seedCommits(user.userId, [{ hash: "abc123", authorDate: "2026-05-20T10:00:00Z", totalSeconds: 1800, ref: "main" }]);

    const res = await call(`${COMMITS}/abc123`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.hash).toBe("abc123");
    expect(data.total_seconds).toBe(1800);

    // matching branch ok
    expect((await call(`${COMMITS}/abc123?branch=main`, { headers: bearer(user.apiKey) })).status).toBe(200);
    // branch mismatch → 404
    expect((await call(`${COMMITS}/abc123?branch=dev`, { headers: bearer(user.apiKey) })).status).toBe(404);
  });

  it("404s on an unknown hash", async () => {
    const res = await call(`${COMMITS}/nope`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(404);
  });

  it("keeps required response fields schema-valid when nullable DB fields are missing", async () => {
    await seedCommits(user.userId, [{ hash: "partial", authorDate: null, message: null, totalSeconds: null }]);

    const res = await call(`${COMMITS}/partial`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.message).toBe("");
    expect(data.author_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(data.human_readable_total).toBe("0 secs");
    expect(data).not.toHaveProperty("total_seconds");
  });

  it("404s for another user's commit", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await seedCommits(bob.userId, [{ hash: "bobs", authorDate: "2026-05-20T10:00:00Z" }]);

    const res = await call(`${COMMITS}/bobs`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(404);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });

  it("returns 401 when unauthenticated", async () => {
    expect((await call(`${COMMITS}/abc123`)).status).toBe(401);
  });
});

describe("POST .../commits (ingestion)", () => {
  it("ingests a commit and returns it, readable via the read endpoints", async () => {
    const res = await postCommit(
      PROJECT,
      {
        hash: "a1b2c3",
        message: "fix: handle empty range",
        author_name: "Nao",
        author_email: "nao@example.com",
        author_date: "2026-06-05T01:00:00Z",
        ref: "main",
        total_seconds: 1800,
        url: "https://github.com/org/cloudtime/commit/a1b2c3",
      },
      user.apiKey,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.hash).toBe("a1b2c3");
    expect(data.total_seconds).toBe(1800);
    expect(data.human_readable_total).toBe("30 mins");
    expect(data.author_date).toBe("2026-06-05T01:00:00Z");
    expect(data.ref).toBe("main");

    const list = await call(COMMITS, { headers: bearer(user.apiKey) });
    expect(((await list.json()) as { data: CommitShape[] }).data.map((c) => c.hash)).toContain("a1b2c3");

    const single = await call(`${COMMITS}/a1b2c3`, { headers: bearer(user.apiKey) });
    expect(single.status).toBe(200);
    expect((await single.json() as { data: CommitShape }).data.hash).toBe("a1b2c3");
  });

  it("is idempotent on (user, project, hash): re-post updates in place", async () => {
    await postCommit(PROJECT, { hash: "dup", message: "v1", total_seconds: 1000 }, user.apiKey);
    const second = await postCommit(PROJECT, { hash: "dup", message: "v2", total_seconds: 2000 }, user.apiKey);
    expect(second.status).toBe(201);

    const list = await call(COMMITS, { headers: bearer(user.apiKey) });
    const dups = ((await list.json()) as { data: CommitShape[] }).data.filter((c) => c.hash === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0].message).toBe("v2");
    expect(dups[0].total_seconds).toBe(2000);
  });

  it("omitted total_seconds reads back as '0 secs' with no total_seconds field", async () => {
    const res = await postCommit(PROJECT, { hash: "notime", message: "docs" }, user.apiKey);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.human_readable_total).toBe("0 secs");
    expect(data).not.toHaveProperty("total_seconds");
  });

  it("400s on missing/blank hash, negative total_seconds, or bad date", async () => {
    expect((await postCommit(PROJECT, { message: "no hash" }, user.apiKey)).status).toBe(400);
    expect((await postCommit(PROJECT, { hash: "" }, user.apiKey)).status).toBe(400);
    expect((await postCommit(PROJECT, { hash: "x", total_seconds: -5 }, user.apiKey)).status).toBe(400);
    expect((await postCommit(PROJECT, { hash: "x", author_date: "nope" }, user.apiKey)).status).toBe(400);
  });

  it("401s when unauthenticated", async () => {
    expect((await postCommit(PROJECT, { hash: "x" })).status).toBe(401);
  });

  it("stores project from the path, ignoring any project in the body", async () => {
    await postCommit(PROJECT, { hash: "p1", project: "other" }, user.apiKey);
    expect((await call(`${COMMITS}/p1`, { headers: bearer(user.apiKey) })).status).toBe(200);
    expect(
      (await call("/api/v1/users/current/projects/other/commits/p1", { headers: bearer(user.apiKey) })).status,
    ).toBe(404);
  });

  it("isolates ingested commits per user", async () => {
    await postCommit(PROJECT, { hash: "mine", total_seconds: 100 }, user.apiKey);
    const bob = await seedUser({ username: "bobpost", email: "bobpost@example.test" });
    const bobList = await call(COMMITS, { headers: bearer(bob.apiKey) });
    expect(((await bobList.json()) as { data: CommitShape[] }).data).toEqual([]);
    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});
