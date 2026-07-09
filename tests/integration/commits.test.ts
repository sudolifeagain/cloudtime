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
  await truncate("commits", "heartbeats", "users");
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

async function postBulk(project: string, body: unknown, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) Object.assign(headers, bearer(apiKey));
  return call(`/api/v1/users/current/projects/${project}/commits.bulk`, {
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

interface HeartbeatSeed {
  time: number;
  project?: string;
}

/** Seed raw heartbeats (epoch-second `time`, project) for correlation tests. */
async function seedHeartbeats(userId: string, items: HeartbeatSeed[]): Promise<void> {
  const stmts = items.map((h) =>
    env.DB.prepare(
      "INSERT INTO heartbeats (id, user_id, entity, time, project) VALUES (?, ?, 'file.ts', ?, ?)",
    ).bind(crypto.randomUUID(), userId, h.time, h.project ?? PROJECT),
  );
  await env.DB.batch(stmts);
}

/** Epoch seconds → RFC3339 string for an `author_date` body field. */
function rfc(sec: number): string {
  return new Date(sec * 1000).toISOString();
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
    expect((await postCommit(PROJECT, { hash: "x", author_date: "2026-06-05" }, user.apiKey)).status).toBe(400);
    expect((await postCommit(PROJECT, { hash: "x", author_date: "2026-02-31T00:00:00Z" }, user.apiKey)).status).toBe(400);
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

describe("POST .../commits (heartbeat correlation, #145)", () => {
  // Fixed base instant; the seeded user's timeout defaults to 15 minutes (900s).
  const BASE = Math.floor(Date.parse("2026-06-05T00:00:00Z") / 1000);

  it("US1: derives total_seconds from surrounding heartbeats when omitted", async () => {
    // 16 beats at a 2-minute cadence → 15 gaps × 120s = 1800s of active coding.
    const beats = Array.from({ length: 16 }, (_, i) => ({ time: BASE + i * 120 }));
    await seedHeartbeats(user.userId, beats);

    const res = await postCommit(PROJECT, { hash: "derive", author_date: rfc(BASE + 1800) }, user.apiKey);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(1800);
    expect(data.human_readable_total).toBe("30 mins");
  });

  it("US2: a client-supplied total_seconds wins over correlation", async () => {
    await seedHeartbeats(
      user.userId,
      Array.from({ length: 16 }, (_, i) => ({ time: BASE + i * 120 })),
    );

    const res = await postCommit(
      PROJECT,
      { hash: "supplied", author_date: rfc(BASE + 1800), total_seconds: 1234 },
      user.apiKey,
    );
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(1234); // not the correlated ~1800
  });

  it("US2: an explicit 0 is a supplied value (correlation skipped)", async () => {
    await seedHeartbeats(user.userId, [{ time: BASE }, { time: BASE + 120 }, { time: BASE + 240 }]);

    const res = await postCommit(
      PROJECT,
      { hash: "zero", author_date: rfc(BASE + 240), total_seconds: 0 },
      user.apiKey,
    );
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(0); // stored 0, not the correlated 240
    expect(data.human_readable_total).toBe("0 secs");
  });

  it("no heartbeats in window → total_seconds absent, '0 secs' (pre-#145 output)", async () => {
    const res = await postCommit("empty", { hash: "notime", author_date: rfc(BASE + 100) }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data).not.toHaveProperty("total_seconds");
    expect(data.human_readable_total).toBe("0 secs");
  });

  it("US3: consecutive commits split the session without double-counting", async () => {
    // One continuous 40-minute session at a 2-minute cadence.
    await seedHeartbeats(
      user.userId,
      Array.from({ length: 21 }, (_, i) => ({ time: BASE + i * 120 })),
    );

    const a = await postCommit(PROJECT, { hash: "A", author_date: rfc(BASE + 1200) }, user.apiKey);
    const b = await postCommit(PROJECT, { hash: "B", author_date: rfc(BASE + 2400) }, user.apiKey);
    const aSecs = ((await a.json()) as { data: CommitShape }).data.total_seconds;
    const bSecs = ((await b.json()) as { data: CommitShape }).data.total_seconds;

    expect(aSecs).toBe(1200);
    expect(bSecs).toBe(1200); // window lower bound is A's author_date — no re-count
    expect((aSecs ?? 0) + (bSecs ?? 0)).toBe(2400);
  });

  it("US3: an idle gap beyond the timeout is excluded (matches summaries)", async () => {
    // t,+60,+120,[30-min idle],+1920,+1980 → 60 + 60 + 0 + 60 = 180
    await seedHeartbeats(user.userId, [
      { time: BASE },
      { time: BASE + 60 },
      { time: BASE + 120 },
      { time: BASE + 1920 },
      { time: BASE + 1980 },
    ]);

    const res = await postCommit(PROJECT, { hash: "idle", author_date: rfc(BASE + 1980) }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(180);
  });

  it("interleaved other-project heartbeats are attributed by project, not absorbed", async () => {
    await seedHeartbeats(user.userId, [
      { time: BASE, project: PROJECT },
      { time: BASE + 120, project: "other-proj" },
      { time: BASE + 240, project: PROJECT },
    ]);

    const res = await postCommit(PROJECT, { hash: "multi", author_date: rfc(BASE + 240) }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(120); // the other-proj detour (would be 240 under a pre-filter) is excluded
  });

  it("heartbeats only in other projects → total_seconds absent", async () => {
    await seedHeartbeats(user.userId, [
      { time: BASE, project: "other-proj" },
      { time: BASE + 120, project: "other-proj" },
    ]);

    const res = await postCommit(PROJECT, { hash: "elsewhere", author_date: rfc(BASE + 120) }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data).not.toHaveProperty("total_seconds");
  });

  it("re-posting an omitted commit re-derives as heartbeats arrive late", async () => {
    const T = BASE + 240;
    const first = await postCommit(PROJECT, { hash: "late", author_date: rfc(T) }, user.apiKey);
    expect(((await first.json()) as { data: CommitShape }).data).not.toHaveProperty("total_seconds");

    // Heartbeats flush after the first post, then the same commit is re-posted.
    await seedHeartbeats(user.userId, [{ time: T - 240 }, { time: T - 120 }, { time: T }]);
    const again = await postCommit(PROJECT, { hash: "late", author_date: rfc(T) }, user.apiKey);
    const { data } = (await again.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(240); // now derived from the late heartbeats
  });

  it("omitted author_date correlates against a window ending at now", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Two 120s gaps well before now, safely inside [now - 24h, now].
    await seedHeartbeats(user.userId, [{ time: now - 300 }, { time: now - 180 }, { time: now - 60 }]);

    const res = await postCommit(PROJECT, { hash: "nodate" }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(240);
  });

  it("excludes the previous commit's own hash from the boundary lookup", async () => {
    // A prior same-project commit at BASE+1200 partitions this commit's window.
    await seedHeartbeats(
      user.userId,
      Array.from({ length: 21 }, (_, i) => ({ time: BASE + i * 120 })),
    );
    await postCommit(PROJECT, { hash: "prev", author_date: rfc(BASE + 1200) }, user.apiKey);

    // Re-posting the SAME hash must not use itself as its own lower bound.
    const res = await postCommit(PROJECT, { hash: "prev", author_date: rfc(BASE + 1200) }, user.apiKey);
    const { data } = (await res.json()) as { data: CommitShape };
    expect(data.total_seconds).toBe(1200); // window [BASE, BASE+1200], not [BASE+1200, BASE+1200]
  });

  it("does not modify the summaries aggregate (commits stay an independent series)", async () => {
    await seedHeartbeats(
      user.userId,
      Array.from({ length: 16 }, (_, i) => ({ time: BASE + i * 120 })),
    );
    await postCommit(PROJECT, { hash: "indep", author_date: rfc(BASE + 1800) }, user.apiKey);

    const summaries = await env.DB.prepare("SELECT COUNT(*) AS n FROM summaries WHERE user_id = ?")
      .bind(user.userId)
      .first<{ n: number }>();
    expect(summaries?.n).toBe(0);
  });
});

describe("POST .../commits.bulk (bulk ingestion, #147)", () => {
  async function countCommits(userId: string, hash: string): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM commits WHERE user_id = ? AND hash = ?",
    )
      .bind(userId, hash)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("creates every commit in one batch and returns them in request order", async () => {
    const res = await postBulk(
      PROJECT,
      [
        { hash: "b1", message: "first", total_seconds: 1800 },
        { hash: "b2", message: "second", total_seconds: 600 },
        { hash: "b3", message: "third" },
      ],
      user.apiKey,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape[] };
    expect(data.map((c) => c.hash)).toEqual(["b1", "b2", "b3"]);
    expect(data[0].human_readable_total).toBe("30 mins");
    expect(data[1].total_seconds).toBe(600);
    expect(data[2]).not.toHaveProperty("total_seconds"); // omitted → absent
    expect(data[2].human_readable_total).toBe("0 secs");

    // Read-back via the list endpoint confirms all three persisted.
    const list = await call(COMMITS, { headers: bearer(user.apiKey) });
    const hashes = ((await list.json()) as { data: CommitShape[] }).data.map((c) => c.hash);
    expect(hashes).toEqual(expect.arrayContaining(["b1", "b2", "b3"]));
  });

  it("is all-or-nothing: a mid-batch invalid element writes nothing (400)", async () => {
    const res = await postBulk(
      PROJECT,
      [{ hash: "good1" }, { hash: "" }, { hash: "good2" }],
      user.apiKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("item 1: hash is required and must be a non-empty string");

    // Nothing from the rejected batch was persisted.
    expect(await countCommits(user.userId, "good1")).toBe(0);
    expect(await countCommits(user.userId, "good2")).toBe(0);
  });

  it("400s on a non-array body", async () => {
    const res = await postBulk(PROJECT, { hash: "x" }, user.apiKey);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Request body must be an array");
  });

  it("400s on more than 100 commits", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ hash: `c${i}` }));
    const res = await postBulk(PROJECT, items, user.apiKey);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Maximum 100 commits per request");
    expect(await countCommits(user.userId, "c0")).toBe(0);
  });

  it("accepts an empty array and returns 201 { data: [] }", async () => {
    const res = await postBulk(PROJECT, [], user.apiKey);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("stores omitted total_seconds as '0 secs' with NO correlation, even when heartbeats surround the commit", async () => {
    const base = Math.floor(Date.parse("2026-06-05T00:00:00Z") / 1000);
    // A dense session that the single endpoint WOULD correlate to ~1800s.
    await seedHeartbeats(
      user.userId,
      Array.from({ length: 16 }, (_, i) => ({ time: base + i * 120 })),
    );

    const res = await postBulk(PROJECT, [{ hash: "nocorr", author_date: rfc(base + 1800) }], user.apiKey);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape[] };
    expect(data[0]).not.toHaveProperty("total_seconds"); // bulk never derives
    expect(data[0].human_readable_total).toBe("0 secs");

    const single = await call(`${COMMITS}/nocorr`, { headers: bearer(user.apiKey) });
    expect((await single.json() as { data: CommitShape }).data).not.toHaveProperty("total_seconds");
  });

  it("is idempotent on (user, project, hash) across separate batches", async () => {
    await postBulk(PROJECT, [{ hash: "reb", message: "v1", total_seconds: 100 }], user.apiKey);
    const second = await postBulk(PROJECT, [{ hash: "reb", message: "v2", total_seconds: 200 }], user.apiKey);
    expect(second.status).toBe(201);

    expect(await countCommits(user.userId, "reb")).toBe(1);
    const single = await call(`${COMMITS}/reb`, { headers: bearer(user.apiKey) });
    const { data } = (await single.json()) as { data: CommitShape };
    expect(data.message).toBe("v2");
    expect(data.total_seconds).toBe(200);
  });

  it("an in-batch duplicate applies last-wins in DB but returns one entry per input in order", async () => {
    const res = await postBulk(
      PROJECT,
      [
        { hash: "dup", message: "earlier", total_seconds: 100 },
        { hash: "dup", message: "later", total_seconds: 900 },
      ],
      user.apiKey,
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CommitShape[] };
    // N inputs → N response entries in request order: the first is the inserted
    // snapshot, the second is the last-wins overwrite.
    expect(data).toHaveLength(2);
    expect(data[0].message).toBe("earlier");
    expect(data[0].total_seconds).toBe(100);
    expect(data[1].message).toBe("later");
    expect(data[1].total_seconds).toBe(900);

    // Only one row persists, holding the last-wins values.
    expect(await countCommits(user.userId, "dup")).toBe(1);
    const single = await call(`${COMMITS}/dup`, { headers: bearer(user.apiKey) });
    const persisted = ((await single.json()) as { data: CommitShape }).data;
    expect(persisted.message).toBe("later");
    expect(persisted.total_seconds).toBe(900);
  });

  it("stores project from the path, ignoring any project in the body", async () => {
    const res = await postBulk(PROJECT, [{ hash: "bp1", project: "other" }], user.apiKey);
    expect(res.status).toBe(201);
    expect((await call(`${COMMITS}/bp1`, { headers: bearer(user.apiKey) })).status).toBe(200);
    expect(
      (await call("/api/v1/users/current/projects/other/commits/bp1", { headers: bearer(user.apiKey) })).status,
    ).toBe(404);
  });

  it("isolates bulk-ingested commits per user", async () => {
    await postBulk(PROJECT, [{ hash: "mineb", total_seconds: 100 }], user.apiKey);
    const bob = await seedUser({ username: "bobbulk", email: "bobbulk@example.test" });
    const bobList = await call(COMMITS, { headers: bearer(bob.apiKey) });
    expect(((await bobList.json()) as { data: CommitShape[] }).data).toEqual([]);
    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });

  it("401s before validation when unauthenticated (nothing written)", async () => {
    // Body would fail validation too; auth must short-circuit first.
    const res = await postBulk(PROJECT, [{ message: "no hash" }]);
    expect(res.status).toBe(401);
  });

  it("does not touch the summaries or user_projects aggregates", async () => {
    await postBulk(
      PROJECT,
      [
        { hash: "agg1", total_seconds: 100 },
        { hash: "agg2", total_seconds: 200 },
      ],
      user.apiKey,
    );

    const summaries = await env.DB.prepare("SELECT COUNT(*) AS n FROM summaries WHERE user_id = ?")
      .bind(user.userId)
      .first<{ n: number }>();
    expect(summaries?.n).toBe(0);
    const projects = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_projects WHERE user_id = ?")
      .bind(user.userId)
      .first<{ n: number }>();
    expect(projects?.n).toBe(0);
  });
});
