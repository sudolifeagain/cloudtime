/**
 * Webhook-registration persistence service (Issue #146,
 * specs/146-git-webhook-adapter/). D1-facing; owns the queries, the
 * `(user_id, provider, repo)` uniqueness rule, and the secret-at-rest
 * encryption. Field-level request validation lives in `input.ts` (pure); this
 * module owns everything that needs the database.
 *
 * The secret is stored AES-256-GCM encrypted (recoverable) via the existing
 * `encryptToken`/`decryptToken` OAuth-token helpers with a per-row AAD
 * `webhook:<id>`, because GitHub HMAC verification must recompute the signature
 * from the raw secret — a one-way hash would not work (research D-4).
 */
import { encryptToken } from "../crypto";
import type { CreateEndpointValue, UpdateEndpointValue } from "./input";
import type { Provider } from "./providers";

export interface WebhookEndpointRow {
  id: string;
  user_id: string;
  provider: string;
  repo: string;
  project: string;
  secret_encrypted: string;
  is_enabled: number;
  created_at: string;
  modified_at: string;
}

const SELECT_COLUMNS =
  "id, user_id, provider, repo, project, secret_encrypted, is_enabled, created_at, modified_at";

/** Result of a create: the persisted row, or a duplicate the route maps to 409. */
export type EndpointCreateResult =
  | { ok: true; row: WebhookEndpointRow }
  | { ok: false; status: 409; error: string };

/** Read one owner-scoped registration by id, or null (unknown / cross-user). */
export async function getEndpoint(
  db: D1Database,
  userId: string,
  id: string,
): Promise<WebhookEndpointRow | null> {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM webhook_endpoints WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<WebhookEndpointRow>();
}

/** List the owner's registrations, ordered by the immutable natural key. */
export async function listEndpoints(
  db: D1Database,
  userId: string,
): Promise<WebhookEndpointRow[]> {
  const { results } = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM webhook_endpoints WHERE user_id = ? ORDER BY provider, repo`)
    .bind(userId)
    .all<WebhookEndpointRow>();
  return results;
}

/**
 * Resolve the enabled registration a public delivery targets, matched by
 * `(provider, repo)` read from the payload (research D-9). In single-user mode
 * this resolves to exactly one row; disabled and unregistered repos return null,
 * which the receiver maps to 404. Carries `secret_encrypted` for verification.
 */
export async function lookupEndpoint(
  db: D1Database,
  provider: Provider,
  repo: string,
): Promise<WebhookEndpointRow | null> {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM webhook_endpoints WHERE provider = ? AND repo = ? AND is_enabled = 1`,
    )
    .bind(provider, repo)
    .first<WebhookEndpointRow>();
}

/**
 * Insert a validated owner-scoped registration. Rejects a duplicate
 * `(user_id, provider, repo)` with a 409-worthy result (FR-010). The secret is
 * encrypted with the freshly generated id as AAD before it is written — never
 * stored in plaintext.
 */
export async function insertEndpoint(
  db: D1Database,
  userId: string,
  encryptionKey: string,
  v: CreateEndpointValue,
): Promise<EndpointCreateResult> {
  const existing = await db
    .prepare("SELECT id FROM webhook_endpoints WHERE user_id = ? AND provider = ? AND repo = ?")
    .bind(userId, v.provider, v.repo)
    .first<{ id: string }>();
  if (existing) {
    return { ok: false, status: 409, error: "a registration for this provider and repo already exists" };
  }

  const id = crypto.randomUUID();
  const secretEncrypted = await encryptToken(v.secret, encryptionKey, `webhook:${id}`);
  await db
    .prepare(
      `INSERT INTO webhook_endpoints
         (id, user_id, provider, repo, project, secret_encrypted, is_enabled, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, userId, v.provider, v.repo, v.project, secretEncrypted, v.is_enabled ? 1 : 0)
    .run();

  const row = await getEndpoint(db, userId, id);
  if (!row) throw new Error("webhook endpoint vanished after insert");
  return { ok: true, row };
}

/**
 * Apply a validated partial update to an owner row. The caller has already
 * resolved existence/ownership (404) and rejected immutable `provider`/`repo`
 * changes (400). A replacement secret is re-encrypted with the row's id AAD.
 * Bumps `modified_at`.
 */
export async function updateEndpoint(
  db: D1Database,
  userId: string,
  encryptionKey: string,
  row: WebhookEndpointRow,
  v: UpdateEndpointValue,
): Promise<WebhookEndpointRow> {
  const columns: string[] = [];
  const values: (string | number)[] = [];
  if (v.projectProvided) {
    columns.push("project = ?");
    values.push(v.project!);
  }
  if (v.secretProvided) {
    columns.push("secret_encrypted = ?");
    values.push(await encryptToken(v.secret!, encryptionKey, `webhook:${row.id}`));
  }
  if (v.isEnabledProvided) {
    columns.push("is_enabled = ?");
    values.push(v.isEnabled ? 1 : 0);
  }
  columns.push("modified_at = datetime('now')");

  await db
    .prepare(`UPDATE webhook_endpoints SET ${columns.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...values, row.id, userId)
    .run();

  const updated = await getEndpoint(db, userId, row.id);
  if (!updated) throw new Error("webhook endpoint vanished after update");
  return updated;
}

/**
 * Delete an owner-created registration. Unknown and cross-user ids match zero
 * rows and return false, so id existence is never leaked. Returns true only when
 * a row was removed.
 */
export async function deleteEndpoint(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM webhook_endpoints WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return res.meta.changes > 0;
}
