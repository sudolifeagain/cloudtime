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

interface SeedCommit {
  hash: string;
  authorDate: string;
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
      `msg ${c.hash}`,
      c.authorEmail ?? "nao@example.com",
      c.authorDate,
      c.totalSeconds ?? null,
      c.ref ?? "main",
    ),
  );
  await env.DB.batch(stmts);
}

interface CommitShape {
  hash: string;
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
