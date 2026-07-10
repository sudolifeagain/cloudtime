/**
 * Git-host webhook adapter (Issue #146, specs/146-git-webhook-adapter/).
 *
 * Two sub-apps:
 *   - `webhooksCrud` (owner-authenticated): manage repo→project registrations,
 *     mirroring the `/ai/prices` owner CRUD — `user_id`-scoped, `404`-not-`403`
 *     for unknown/cross-user ids, the shared secret write-only. `provider`/`repo`
 *     are the immutable natural key; a duplicate `(provider, repo)` is a `409`.
 *   - `webhooksReceiver` (public, `security: []`): the `POST /webhooks/git/{provider}`
 *     delivery endpoint. It authenticates each delivery by the per-repo signature
 *     (GitHub HMAC / GitLab token), resolves the target user + project from the
 *     stored registration, and upserts the pushed commits through the SAME bulk
 *     write path `commits.bulk` uses (one `db.batch()`, no heartbeat correlation
 *     — git payloads carry no coding time, so `total_seconds` is stored absent).
 *
 * The receiver must be CSRF-exempt and read the RAW body once (for the HMAC);
 * both are wired in `src/index.ts` (research D-10).
 */
import { Hono } from "hono";
import type { AuthEnv, Env } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";
import { decryptToken } from "../utils/crypto";
import { commitUpsertStmt } from "./commits";
import { validateCreateEndpoint, validateUpdateEndpoint } from "../utils/webhooks/input";
import {
  deleteEndpoint,
  getEndpoint,
  insertEndpoint,
  listEndpoints,
  lookupEndpoint,
  updateEndpoint,
  type WebhookEndpointRow,
} from "../utils/webhooks/store";
import {
  detectEvent,
  extractRepo,
  isPushEvent,
  isSupportedProvider,
  mapCommits,
  verify,
} from "../utils/webhooks/providers";

type WebhookEndpoint = components["schemas"]["WebhookEndpoint"];

/** Max commits ingested per delivery — the `commits.bulk` cap (research D-6). */
const MAX_WEBHOOK_COMMITS = 100;

/** Row → API response. `secret_encrypted` is never projected (write-only, FR-009). */
function rowToWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    provider: row.provider as WebhookEndpoint["provider"],
    repo: row.repo,
    project: row.project,
    is_enabled: row.is_enabled === 1,
    created_at: normalizeDateTime(row.created_at),
    modified_at: normalizeDateTime(row.modified_at),
  };
}

// ─── Owner CRUD (authenticated) ──────────────────────────────────────────────

const webhooksCrud = new Hono<AuthEnv>();

webhooksCrud.use("/webhooks", authMiddleware);
webhooksCrud.use("/webhooks/*", authMiddleware);

// GET /webhooks — list the owner's registrations.
webhooksCrud.get("/webhooks", async (c) => {
  const userId = c.get("userId");
  try {
    const rows = await listEndpoints(c.env.DB, userId);
    return c.json({ data: rows.map(rowToWebhookEndpoint) });
  } catch (err) {
    console.error("GET /webhooks error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /webhooks — create a registration.
webhooksCrud.post("/webhooks", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateCreateEndpoint(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const result = await insertEndpoint(c.env.DB, userId, c.env.ENCRYPTION_KEY, parsed.value);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ data: rowToWebhookEndpoint(result.row) }, 201);
  } catch (err) {
    console.error("POST /webhooks error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// GET /webhooks/:webhook_id — a single owner registration.
webhooksCrud.get("/webhooks/:webhook_id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("webhook_id");
  try {
    const row = await getEndpoint(c.env.DB, userId, id);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ data: rowToWebhookEndpoint(row) });
  } catch (err) {
    console.error("GET /webhooks/:webhook_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// PATCH /webhooks/:webhook_id — partial update (project/secret/is_enabled).
webhooksCrud.patch("/webhooks/:webhook_id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("webhook_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  try {
    // Existence + ownership resolved BEFORE body validation so a 400 never
    // confirms an id the caller cannot edit exists (mirrors /ai/prices).
    const row = await getEndpoint(c.env.DB, userId, id);
    if (!row) return c.json({ error: "Not found" }, 404);

    const parsed = validateUpdateEndpoint(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const updated = await updateEndpoint(c.env.DB, userId, c.env.ENCRYPTION_KEY, row, parsed.value);
    return c.json({ data: rowToWebhookEndpoint(updated) });
  } catch (err) {
    console.error("PATCH /webhooks/:webhook_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// DELETE /webhooks/:webhook_id — remove a registration.
webhooksCrud.delete("/webhooks/:webhook_id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("webhook_id");
  try {
    const deleted = await deleteEndpoint(c.env.DB, userId, id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /webhooks/:webhook_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Public receiver (no auth; per-repo signature) ───────────────────────────

const webhooksReceiver = new Hono<{ Bindings: Env }>();

// POST /webhooks/git/:provider — receive a push delivery and ingest its commits.
// Ordered handling (data-model.md): provider → raw body + parse → event → repo
// → verify → map → write. Nothing is written until the signature verifies.
webhooksReceiver.post("/webhooks/git/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isSupportedProvider(provider)) {
    return c.json({ error: "Not found" }, 404);
  }

  // Read the raw bytes once — the HMAC signs them, so we must not re-serialize
  // (never call c.req.json() then re-read). Parse that same buffer.
  const rawBody = await c.req.arrayBuffer();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const event = detectEvent(provider, c.req.raw.headers);
  if (event === null) {
    return c.json({ error: "Missing event header" }, 400);
  }
  if (!isPushEvent(provider, event)) {
    // ping / recognized non-push event → acknowledged, zero counts (no project).
    return c.json({ data: { received: 0, ingested: 0, skipped: 0 } }, 202);
  }

  const repo = extractRepo(provider, payload);
  if (repo === null) {
    return c.json({ error: "Payload does not identify a repository" }, 400);
  }

  try {
    const registration = await lookupEndpoint(c.env.DB, provider, repo);
    if (!registration) {
      return c.json({ error: "Not found" }, 404);
    }

    const secret = await decryptToken(
      registration.secret_encrypted,
      c.env.ENCRYPTION_KEY,
      `webhook:${registration.id}`,
    );
    const verified = await verify(provider, rawBody, c.req.raw.headers, secret);
    if (!verified) {
      // A registered repo with a bad signature is 401 (a mis-set secret is
      // debuggable); nothing is written (FR-003, research D-7).
      return c.json({ error: "Signature verification failed" }, 401);
    }

    const { received, commits } = mapCommits(provider, payload);
    const capped = commits.slice(0, MAX_WEBHOOK_COMMITS);
    const skipped = received - capped.length;

    // One db.batch() of the shared idempotent upsert — the bulk write path, no
    // heartbeat correlation, total_seconds always null (FR-005, FR-011).
    if (capped.length > 0) {
      await c.env.DB.batch(
        capped.map((v) =>
          commitUpsertStmt(c.env.DB, registration.user_id, registration.project, v, v.total_seconds),
        ),
      );
    }

    return c.json(
      { data: { received, ingested: capped.length, skipped, project: registration.project } },
      202,
    );
  } catch (err) {
    console.error("POST /webhooks/git/:provider error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export { webhooksCrud, webhooksReceiver };
