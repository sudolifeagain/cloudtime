/**
 * Integration tests for the heartbeat endpoint fixes shipped with
 * Issues #97 (GET TZ), #98 (users.timeout), #99 (user_agent_id resolution).
 *
 * Uses a real in-memory D1 (vitest-pool-workers) and exercises the
 * authMiddleware via API key bearer authentication.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", timezone: "Asia/Tokyo" });
});

afterEach(async () => {
  await truncate("heartbeats", "user_projects", "user_agents", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://test.cloudtime.dev${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function auth(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

// 2026-05-18 02:00 JST == 2026-05-17 17:00 UTC.
// Used to verify the GET endpoint resolves the date in user TZ, not UTC.
const JST_2026_05_18_02_00 = Date.UTC(2026, 4, 17, 17, 0, 0) / 1000;
// 2026-05-17 23:00 JST == 2026-05-17 14:00 UTC. Falls on the previous JST day
// vs the same UTC day, so a TZ-naive query for 2026-05-18 would mis-include
// this row when interpreted in UTC and exclude it when interpreted in JST.
const JST_2026_05_17_23_00 = Date.UTC(2026, 4, 17, 14, 0, 0) / 1000;

describe("Issue #97: GET /heartbeats applies user's profile timezone", () => {
  it("returns only heartbeats inside the local-tz day, not the UTC day", async () => {
    // Seed two heartbeats: one inside 2026-05-18 JST, one in 2026-05-17 JST.
    await env.DB.prepare(
      "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, 'file', ?, 0)",
    )
      .bind(crypto.randomUUID(), user.userId, "may18.ts", JST_2026_05_18_02_00)
      .run();
    await env.DB.prepare(
      "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, 'file', ?, 0)",
    )
      .bind(crypto.randomUUID(), user.userId, "may17.ts", JST_2026_05_17_23_00)
      .run();

    const res = await call(
      "/api/v1/users/current/heartbeats?date=2026-05-18",
      { headers: auth(user.apiKey) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ entity: string; timezone: string }> };
    expect(body.data.map((hb) => hb.entity)).toEqual(["may18.ts"]);
    expect(body.data[0].timezone).toBe("Asia/Tokyo");
  });

  it("honours the explicit ?timezone= override (used by clients in another zone)", async () => {
    // Same setup: the may17.ts row sits at 14:00 UTC, which is inside the
    // UTC calendar day 2026-05-17 but outside 2026-05-18 in JST.
    await env.DB.prepare(
      "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, 'file', ?, 0)",
    )
      .bind(crypto.randomUUID(), user.userId, "utc-row.ts", JST_2026_05_17_23_00)
      .run();

    const res = await call(
      "/api/v1/users/current/heartbeats?date=2026-05-17&timezone=UTC",
      { headers: auth(user.apiKey) },
    );

    const body = (await res.json()) as { data: Array<{ entity: string; timezone: string }> };
    expect(body.data.map((hb) => hb.entity)).toContain("utc-row.ts");
    expect(body.data[0].timezone).toBe("UTC");
  });

  it("rejects an invalid ?timezone=", async () => {
    const res = await call(
      "/api/v1/users/current/heartbeats?date=2026-05-18&timezone=Mars/Olympus",
      { headers: auth(user.apiKey) },
    );
    expect(res.status).toBe(400);
  });
});

describe("Issue #98: GET /heartbeats end calc uses users.timeout (in minutes)", () => {
  it("treats two heartbeats 20 minutes apart as one session when timeout=30", async () => {
    await env.DB.prepare("UPDATE users SET timeout = 30 WHERE id = ?")
      .bind(user.userId)
      .run();

    const t0 = JST_2026_05_18_02_00;
    const t1 = t0 + 20 * 60; // 20 minutes later
    for (const [entity, time] of [["a.ts", t0], ["b.ts", t1]] as const) {
      await env.DB.prepare(
        "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, 'file', ?, 0)",
      )
        .bind(crypto.randomUUID(), user.userId, entity, time)
        .run();
    }

    const res = await call(
      "/api/v1/users/current/heartbeats?date=2026-05-18",
      { headers: auth(user.apiKey) },
    );
    const body = (await res.json()) as { data: Array<{ entity: string; start: number; end: number }> };
    const first = body.data.find((hb) => hb.entity === "a.ts")!;
    expect(first.end).toBe(t1); // joined into the next heartbeat (20 < 30 min)
    expect(first.end - first.start).toBe(20 * 60);
  });

  it("does not join across the 15-minute default when timeout is unchanged", async () => {
    // Default seeded user has timeout=15.
    const t0 = JST_2026_05_18_02_00;
    const t1 = t0 + 20 * 60; // 20 minutes later — exceeds the default 15 min
    for (const [entity, time] of [["a.ts", t0], ["b.ts", t1]] as const) {
      await env.DB.prepare(
        "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, 'file', ?, 0)",
      )
        .bind(crypto.randomUUID(), user.userId, entity, time)
        .run();
    }

    const res = await call(
      "/api/v1/users/current/heartbeats?date=2026-05-18",
      { headers: auth(user.apiKey) },
    );
    const body = (await res.json()) as { data: Array<{ entity: string; start: number; end: number }> };
    const first = body.data.find((hb) => hb.entity === "a.ts")!;
    // Not joined — end equals start because the gap exceeds 15 min.
    expect(first.end).toBe(first.start);
  });
});

describe("Issue #99: heartbeat.user_agent_id resolves to a user_agents row", () => {
  const STD_UA =
    "wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 vscode-wakatime/24.0.4";

  it("POST /heartbeats stores user_agents.id (UUID) and populates the table", async () => {
    const res = await call("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": STD_UA,
        ...auth(user.apiKey),
      },
      body: JSON.stringify({
        entity: "main.ts",
        type: "file",
        time: JST_2026_05_18_02_00,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; user_agent_id: string } };

    const uaRows = await env.DB.prepare(
      "SELECT id, value, editor, version, os FROM user_agents WHERE user_id = ?",
    )
      .bind(user.userId)
      .all<{ id: string; value: string; editor: string | null; version: string | null; os: string | null }>();

    expect(uaRows.results).toHaveLength(1);
    expect(uaRows.results[0].value).toBe(STD_UA);
    expect(uaRows.results[0].editor).toBe("vscode-wakatime");
    expect(uaRows.results[0].version).toBe("24.0.4");
    expect(uaRows.results[0].os).toBe("linux");
    expect(body.data.user_agent_id).toBe(uaRows.results[0].id);

    // heartbeats row stores the FK, not the raw string.
    const hbRow = await env.DB.prepare(
      "SELECT user_agent_id FROM heartbeats WHERE id = ?",
    )
      .bind(body.data.id)
      .first<{ user_agent_id: string }>();
    expect(hbRow?.user_agent_id).toBe(uaRows.results[0].id);
  });

  it("POST /heartbeats.bulk dedupes resolution: same UA across 5 items → 1 user_agents row", async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      entity: `f${i}.ts`,
      type: "file" as const,
      time: JST_2026_05_18_02_00 + i,
    }));
    const res = await call("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": STD_UA,
        ...auth(user.apiKey),
      },
      body: JSON.stringify(inputs),
    });
    expect(res.status).toBe(202);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_agents WHERE user_id = ?",
    )
      .bind(user.userId)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);

    // All 5 heartbeats share the same FK.
    const hbRows = await env.DB.prepare(
      "SELECT DISTINCT user_agent_id FROM heartbeats WHERE user_id = ?",
    )
      .bind(user.userId)
      .all<{ user_agent_id: string }>();
    expect(hbRows.results).toHaveLength(1);
  });

  it("body field input.user_agent overrides the HTTP User-Agent header", async () => {
    const bodyUa = "wakatime/v1.99 (darwin-23.4-arm64) go1.22 jetbrains-wakatime/14.0.3";
    const res = await call("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": STD_UA, // would parse as linux/vscode if used
        ...auth(user.apiKey),
      },
      body: JSON.stringify({
        entity: "main.ts",
        type: "file",
        time: JST_2026_05_18_02_00,
        user_agent: bodyUa,
      }),
    });
    expect(res.status).toBe(201);

    const ua = await env.DB.prepare(
      "SELECT editor, os FROM user_agents WHERE user_id = ?",
    )
      .bind(user.userId)
      .first<{ editor: string; os: string }>();
    expect(ua?.editor).toBe("jetbrains-wakatime");
    expect(ua?.os).toBe("darwin");
  });
});
