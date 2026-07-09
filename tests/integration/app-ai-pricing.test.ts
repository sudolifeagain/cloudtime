/**
 * Integration tests for the owner dashboard AI pricing controls (Issue #200,
 * T114). Exercises the session-cookie authenticated `/app/ai/prices` surface
 * (view/add/edit/disable/delete) and the dashboard token/cost summary panel
 * against a real in-memory D1 (vitest-pool-workers). These forms POST to `/app`
 * (not the API-key `/api/v1` endpoints) and share the `price-store` service, so
 * the same stored-row invariants apply.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUserWithSession, truncate, type SeededSession } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";

afterEach(async () => {
  await truncate("ai_model_prices", "ai_daily_usage", "sessions", "users");
  const keys = await env.KV.list();
  await Promise.all(keys.keys.map((key) => env.KV.delete(key.name)));
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function formHeaders(sessionToken: string): Record<string, string> {
  return {
    Cookie: `__Host-session=${sessionToken}`,
    Origin: BASE,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function post(
  user: SeededSession,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return call(path, {
    method: "POST",
    headers: formHeaders(user.sessionToken),
    body: new URLSearchParams(fields).toString(),
  });
}

async function addPrice(user: SeededSession, overrides: Record<string, string> = {}): Promise<Response> {
  return post(user, "/app/ai/prices", {
    provider: "openai",
    model: "gpt-4o",
    currency: "USD",
    effective_from: "2026-01-01",
    output_cost_per_mtok: "10",
    is_enabled: "on",
    ...overrides,
  });
}

interface PriceRow {
  id: string;
  is_enabled: number;
  output_cost_per_mtok: number | null;
  effective_to: string | null;
}

async function onlyPrice(userId: string): Promise<PriceRow> {
  const row = await env.DB.prepare(
    "SELECT id, is_enabled, output_cost_per_mtok, effective_to FROM ai_model_prices WHERE user_id = ?",
  )
    .bind(userId)
    .first<PriceRow>();
  if (!row) throw new Error("expected exactly one price row");
  return row;
}

async function priceCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS value FROM ai_model_prices WHERE user_id = ?")
    .bind(userId)
    .first<{ value: number }>();
  return Number(row?.value ?? 0);
}

describe("dashboard AI pricing controls", () => {
  it("redirects anonymous visitors to the app", async () => {
    const list = await call("/app/ai/prices");
    expect(list.status).toBe(303);
    expect(list.headers.get("Location")).toBe("/app");

    const create = await call("/app/ai/prices", {
      method: "POST",
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ provider: "x", model: "y" }).toString(),
    });
    expect(create.status).toBe(303);
    expect(create.headers.get("Location")).toBe("/app");
  });

  it("renders the pricing page for a session-authenticated owner", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    const res = await call("/app/ai/prices", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Model prices");
    expect(html).toContain("Add price");
    expect(html).toContain("Price rows");
    expect(html).toContain("not your actual");
    expect(html).not.toContain(user.sessionToken);
  });

  it("creates a price row from the add form", async () => {
    const user = await seedUserWithSession({ username: "owner" });

    const res = await addPrice(user, { input_cost_per_mtok: "2.5" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app/ai/prices?ok=created");

    const row = await onlyPrice(user.userId);
    expect(row.is_enabled).toBe(1);

    const list = await call(res.headers.get("Location") ?? "/app/ai/prices", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    const html = await list.text();
    expect(html).toContain("Price added.");
    expect(html).toContain("openai");
    expect(html).toContain("gpt-4o");
  });

  it("rejects a price with no rate and surfaces the error", async () => {
    const user = await seedUserWithSession({ username: "owner" });

    const res = await addPrice(user, { output_cost_per_mtok: "", input_cost_per_mtok: "" });
    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/app/ai/prices?error=");
    expect(await priceCount(user.userId)).toBe(0);

    // The reflected error renders on the redirected page.
    const flash = await call(location, {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(await flash.text()).toContain("At least one rate field is required");
  });

  it("rejects an overlapping enabled window", async () => {
    const user = await seedUserWithSession({ username: "owner" });

    expect((await addPrice(user)).status).toBe(303);
    const overlap = await addPrice(user, { effective_from: "2026-06-01" });
    expect(overlap.status).toBe(303);
    expect(overlap.headers.get("Location")).toContain("error=");
    expect(await priceCount(user.userId)).toBe(1);
  });

  it("disables and re-enables a price via the toggle control", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    await addPrice(user);
    const { id } = await onlyPrice(user.userId);

    const disable = await post(user, `/app/ai/prices/${id}/toggle`, {});
    expect(disable.headers.get("Location")).toBe("/app/ai/prices?ok=disabled");
    expect((await onlyPrice(user.userId)).is_enabled).toBe(0);

    const enable = await post(user, `/app/ai/prices/${id}/toggle`, {});
    expect(enable.headers.get("Location")).toBe("/app/ai/prices?ok=enabled");
    expect((await onlyPrice(user.userId)).is_enabled).toBe(1);
  });

  it("edits a price from the edit form", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    await addPrice(user);
    const { id } = await onlyPrice(user.userId);

    const editPage = await call(`/app/ai/prices/${id}/edit`, {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(editPage.status).toBe(200);
    const editHtml = await editPage.text();
    expect(editHtml).toContain("Edit price");
    expect(editHtml).toContain("openai");
    expect(editHtml).toContain("immutable");

    const res = await post(user, `/app/ai/prices/${id}`, {
      currency: "USD",
      output_cost_per_mtok: "20",
      effective_to: "2026-12-31",
      is_enabled: "on",
    });
    expect(res.headers.get("Location")).toBe("/app/ai/prices?ok=updated");

    const row = await onlyPrice(user.userId);
    expect(row.output_cost_per_mtok).toBe(20);
    expect(row.effective_to).not.toBeNull();
  });

  it("deletes an owner price row", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    await addPrice(user);
    const { id } = await onlyPrice(user.userId);

    const res = await post(user, `/app/ai/prices/${id}/delete`, {});
    expect(res.headers.get("Location")).toBe("/app/ai/prices?ok=deleted");
    expect(await priceCount(user.userId)).toBe(0);
  });

  it("returns 404 for an unknown price on the edit page", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    const res = await call("/app/ai/prices/does-not-exist/edit", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Price not found");
  });
});

describe("dashboard AI token/cost summary", () => {
  it("shows an estimated cost from the rollup and enabled prices", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    await env.DB.prepare(
      `INSERT INTO ai_daily_usage
         (user_id, day, provider, model, agent, project, input_tokens, heartbeat_count)
       VALUES (?, ?, 'openai', 'gpt-4o', 'vscode', 'cloudtime', 1000000, 2)`,
    )
      .bind(user.userId, today)
      .run();

    await env.DB.prepare(
      `INSERT INTO ai_model_prices
         (id, user_id, provider, model, currency, input_cost_per_mtok,
          effective_from, is_default, is_enabled, created_at, updated_at)
       VALUES (?, ?, 'openai', 'gpt-4o', 'USD', 2.5, '2000-01-01 00:00:00', 0, 1, datetime('now'), datetime('now'))`,
    )
      .bind(crypto.randomUUID(), user.userId)
      .run();

    const res = await call("/app", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Token usage");
    expect(html).toContain("Estimated cost");
    expect(html).toContain("Manage AI pricing");
    expect(html).toContain("USD 2.50");
    expect(html).toContain("API-equivalent estimate, not a bill");
  });

  it("shows an empty state when there is no rollup usage", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    const res = await call("/app", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    const html = await res.text();
    expect(html).toContain("No aggregated AI token usage in this window yet");
  });
});
