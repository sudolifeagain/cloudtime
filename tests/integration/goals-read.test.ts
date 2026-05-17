/**
 * Integration tests for the Goals read endpoints (specs/100-goals-read/).
 * Seeds goal + summary rows directly in D1 to exercise list, single-goal,
 * filter semantics, snoozed override, inverse goals, cross-user isolation,
 * and authentication.
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

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("summaries", "goals", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function auth(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

interface SeedGoalInput {
  ownerId: string;
  title?: string;
  type?: "coding" | "languages" | "editors" | "projects";
  delta?: "day" | "week";
  target?: number;
  isSnoozed?: boolean;
  isInverse?: boolean;
  languages?: string[];
  editors?: string[];
  projects?: string[];
  createdAt?: string;
}

async function seedGoal(opts: SeedGoalInput): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
                        is_enabled, is_snoozed, is_inverse, languages, editors, projects,
                        created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?,
             COALESCE(?, datetime('now')), datetime('now'))`,
  )
    .bind(
      id,
      opts.ownerId,
      opts.title ?? "Test goal",
      opts.type ?? "coding",
      opts.delta ?? "day",
      opts.target ?? 3600,
      opts.isSnoozed ? 1 : 0,
      opts.isInverse ? 1 : 0,
      opts.languages ? JSON.stringify(opts.languages) : null,
      opts.editors ? JSON.stringify(opts.editors) : null,
      opts.projects ? JSON.stringify(opts.projects) : null,
      opts.createdAt ?? null,
    )
    .run();
  return id;
}

async function seedSummary(opts: {
  userId: string;
  date: string;
  totalSeconds: number;
  language?: string;
  editor?: string;
  project?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO summaries (user_id, date, project, language, editor, total_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.userId,
      opts.date,
      opts.project ?? null,
      opts.language ?? null,
      opts.editor ?? null,
      opts.totalSeconds,
    )
    .run();
}

function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcDateOffset(daysBack: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

describe("GET /api/v1/users/current/goals (list)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call("/api/v1/users/current/goals");
    expect(res.status).toBe(401);
  });

  it("returns {data:[]} for a user with no goals", async () => {
    const res = await call("/api/v1/users/current/goals", { headers: auth(user.apiKey) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("returns goals ordered by created_at ASC, without chart_data or status", async () => {
    await seedGoal({ ownerId: user.userId, title: "first", createdAt: "2026-05-01 10:00:00" });
    await seedGoal({ ownerId: user.userId, title: "second", createdAt: "2026-05-02 10:00:00" });
    await seedGoal({ ownerId: user.userId, title: "third", createdAt: "2026-05-03 10:00:00" });

    const res = await call("/api/v1/users/current/goals", { headers: auth(user.apiKey) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((g) => g.title)).toEqual(["first", "second", "third"]);
    expect(body.data[0].created_at).toBe("2026-05-01T10:00:00Z");
    for (const g of body.data) {
      expect(g).not.toHaveProperty("chart_data");
      expect(g).not.toHaveProperty("status");
    }
  });

  it("isolates results to the authenticated user", async () => {
    const other = await seedUser({ username: "bob" });
    await seedGoal({ ownerId: user.userId, title: "mine" });
    await seedGoal({ ownerId: other.userId, title: "theirs" });

    const res = await call("/api/v1/users/current/goals", { headers: auth(user.apiKey) });
    const body = (await res.json()) as { data: Array<{ title: string }> };
    expect(body.data.map((g) => g.title)).toEqual(["mine"]);

    await env.KV.delete(`apikey:${other.apiKeyHash}`);
  });

  it("decodes JSON filter columns into arrays and tolerates invalid JSON", async () => {
    // Valid JSON
    const goodId = await seedGoal({
      ownerId: user.userId,
      type: "languages",
      languages: ["TypeScript", "Go"],
    });
    // Manually corrupt one goal's languages column
    await env.DB.prepare(
      "UPDATE goals SET languages = 'not-valid-json' WHERE id = ?",
    ).bind(goodId).run();
    const goodId2 = await seedGoal({
      ownerId: user.userId,
      type: "editors",
      editors: ["VSCode"],
    });

    const res = await call("/api/v1/users/current/goals", { headers: auth(user.apiKey) });
    const body = (await res.json()) as { data: Array<{ id: string; languages: string[]; editors: string[] }> };
    const corrupted = body.data.find((g) => g.id === goodId);
    const intact = body.data.find((g) => g.id === goodId2);
    expect(corrupted?.languages).toEqual([]);
    expect(intact?.editors).toEqual(["VSCode"]);
  });
});

describe("GET /api/v1/users/current/goals/:goal_id (single)", () => {
  it("returns 404 for unknown goal IDs", async () => {
    const res = await call("/api/v1/users/current/goals/missing", {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("falls back to UTC when the stored user timezone is invalid", async () => {
    await env.DB.prepare("UPDATE users SET timezone = 'Invalid/Zone' WHERE id = ?")
      .bind(user.userId)
      .run();
    const goalId = await seedGoal({ ownerId: user.userId });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { chart_data: Array<{ range: { timezone: string } }> };
    };
    expect(body.data.chart_data.every((entry) => entry.range.timezone === "UTC")).toBe(true);
  });

  it("returns 404 when the goal belongs to another user (no 403 / no leak)", async () => {
    const other = await seedUser({ username: "carol" });
    const otherGoal = await seedGoal({ ownerId: other.userId });

    const res = await call(`/api/v1/users/current/goals/${otherGoal}`, {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(404);

    await env.KV.delete(`apikey:${other.apiKeyHash}`);
  });

  it("returns 7-entry chart_data with last entry pending and correct daily actuals", async () => {
    const goalId = await seedGoal({
      ownerId: user.userId,
      type: "coding",
      delta: "day",
      target: 3600,
    });

    // Seed a few daily summaries within the 7-day window.
    const today = todayUtcIso();
    const yesterday = utcDateOffset(1);
    const dayBefore = utcDateOffset(2);
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 7200, project: "p" });
    await seedSummary({ userId: user.userId, date: dayBefore, totalSeconds: 100, project: "p" });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        chart_data: Array<{ actual_seconds: number; goal_seconds: number; range_status: string; range: { date: string } }>;
        status: string;
      };
    };
    expect(body.data.chart_data).toHaveLength(7);
    expect(body.data.chart_data[body.data.chart_data.length - 1].range_status).toBe("pending");
    expect(body.data.chart_data[body.data.chart_data.length - 1].range.date).toBe(today);

    // Find the per-date entries we seeded.
    const yesterdayEntry = body.data.chart_data.find((e) => e.range.date === yesterday);
    const dayBeforeEntry = body.data.chart_data.find((e) => e.range.date === dayBefore);
    expect(yesterdayEntry?.actual_seconds).toBe(7200);
    expect(yesterdayEntry?.range_status).toBe("success"); // 7200 >= 3600
    expect(dayBeforeEntry?.actual_seconds).toBe(100);
    expect(dayBeforeEntry?.range_status).toBe("fail"); // 100 < 3600

    expect(body.data.status).toBe(yesterdayEntry?.range_status);
    expect(body.data.chart_data.every((e) => e.goal_seconds === 3600)).toBe(true);
  });

  it("applies the languages filter to actual_seconds", async () => {
    const goalId = await seedGoal({
      ownerId: user.userId,
      type: "languages",
      delta: "day",
      target: 60,
      languages: ["TypeScript"],
    });

    const yesterday = utcDateOffset(1);
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 600, language: "TypeScript" });
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 9999, language: "Python" });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });
    const body = (await res.json()) as { data: { chart_data: Array<{ range: { date: string }; actual_seconds: number }> } };
    const entry = body.data.chart_data.find((e) => e.range.date === yesterday);
    expect(entry?.actual_seconds).toBe(600);
  });

  it("returns zero actuals (and no DB scan effects) when a filtered goal has empty filter array", async () => {
    const goalId = await seedGoal({
      ownerId: user.userId,
      type: "languages",
      delta: "day",
      target: 60,
      languages: [], // matches nothing by intent
    });

    const yesterday = utcDateOffset(1);
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 600, language: "TypeScript" });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });
    const body = (await res.json()) as { data: { chart_data: Array<{ actual_seconds: number; range_status: string }> } };
    expect(body.data.chart_data.every((e) => e.actual_seconds === 0)).toBe(true);
    // All completed periods fail (0 < 60); the last is pending.
    expect(body.data.chart_data.slice(0, -1).every((e) => e.range_status === "fail")).toBe(true);
    expect(body.data.chart_data[body.data.chart_data.length - 1].range_status).toBe("pending");
  });

  it("inverse goal: under-target days succeed, over-target days fail", async () => {
    const goalId = await seedGoal({
      ownerId: user.userId,
      type: "coding",
      delta: "day",
      target: 1800,
      isInverse: true,
    });

    const yesterday = utcDateOffset(1);
    const dayBefore = utcDateOffset(2);
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 600, project: "p" });
    await seedSummary({ userId: user.userId, date: dayBefore, totalSeconds: 3600, project: "p" });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });
    const body = (await res.json()) as { data: { chart_data: Array<{ range: { date: string }; range_status: string }> } };
    expect(body.data.chart_data.find((e) => e.range.date === yesterday)?.range_status).toBe("success");
    expect(body.data.chart_data.find((e) => e.range.date === dayBefore)?.range_status).toBe("fail");
  });

  it("snoozed goal: top-level status is 'pending' but per-period statuses are computed normally", async () => {
    const goalId = await seedGoal({
      ownerId: user.userId,
      type: "coding",
      delta: "day",
      target: 3600,
      isSnoozed: true,
    });

    const yesterday = utcDateOffset(1);
    await seedSummary({ userId: user.userId, date: yesterday, totalSeconds: 7200, project: "p" });

    const res = await call(`/api/v1/users/current/goals/${goalId}`, {
      headers: auth(user.apiKey),
    });
    const body = (await res.json()) as {
      data: { status: string; chart_data: Array<{ range: { date: string }; range_status: string }> };
    };
    expect(body.data.status).toBe("pending");
    // The per-period status for the seeded day is still correctly computed.
    expect(body.data.chart_data.find((e) => e.range.date === yesterday)?.range_status).toBe("success");
  });
});
