/**
 * Per-commit coding-time endpoints (specs/107-commits/, specs/135-commits-ingestion/,
 * specs/145-commit-duration-correlation/, specs/147-commits-bulk-ingestion/).
 *
 * Read: a paginated list and a single-commit lookup over the `commits` table.
 * Write: `POST .../commits` ingests one commit (a git post-commit hook or a
 * webhook adapter), idempotent on (user_id, project, hash). A client-supplied
 * `total_seconds` (including an explicit `0`) is stored verbatim; when omitted,
 * the server derives it at ingest time by correlating the user's heartbeats
 * around the commit (Issue #145 — see {@link correlateCommitSeconds}).
 * `POST .../commits.bulk` ingests up to 100 commits in one all-or-nothing
 * `db.batch()`; it stores each `total_seconds` verbatim and never correlates
 * heartbeats (Issue #147 — a per-commit scan over the batch would blow the
 * Workers per-request subrequest/CPU budget; callers wanting derived time use
 * the single endpoint).
 */
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware, getUserTimeout } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";
import { formatHumanReadable } from "../utils/time-format";
import {
  validateCommitInput,
  validateCommitInputBatch,
  type ValidatedCommit,
} from "../utils/commit-input";
import {
  CORRELATION_HEARTBEAT_LIMIT,
  MAX_CORRELATION_WINDOW,
  resolveWindow,
  sumActiveSeconds,
  type CorrelationRow,
} from "../utils/commit-correlation";

type Commit = components["schemas"]["Commit"];

const PAGE_SIZE = 100;
const MAX_BULK = 100;

export interface CommitRow {
  hash: string;
  message: string | null;
  author_name: string | null;
  author_email: string | null;
  author_date: string | null;
  committer_name: string | null;
  committer_email: string | null;
  committer_date: string | null;
  total_seconds: number | null;
  ref: string | null;
  url: string | null;
  created_at: string;
}

const SELECT_COLUMNS =
  "hash, message, author_name, author_email, author_date, committer_name, committer_email, committer_date, total_seconds, ref, url, created_at";

// Idempotent on the existing UNIQUE(user_id, project, hash) index: re-posting a
// hash updates the row's mutable fields in place (id/created_at preserved).
const UPSERT_SQL = `INSERT INTO commits
  (id, user_id, project, hash, message, author_name, author_email, author_date,
   committer_name, committer_email, committer_date, total_seconds, ref, url)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, project, hash) DO UPDATE SET
  message = excluded.message,
  author_name = excluded.author_name,
  author_email = excluded.author_email,
  author_date = excluded.author_date,
  committer_name = excluded.committer_name,
  committer_email = excluded.committer_email,
  committer_date = excluded.committer_date,
  total_seconds = excluded.total_seconds,
  ref = excluded.ref,
  url = excluded.url
RETURNING ${SELECT_COLUMNS}`;

function rowToCommit(row: CommitRow): Commit {
  return {
    hash: row.hash,
    message: row.message ?? "",
    author_name: row.author_name ?? undefined,
    author_email: row.author_email ?? undefined,
    author_date: normalizeDateTime(row.author_date ?? row.created_at),
    committer_name: row.committer_name ?? undefined,
    committer_email: row.committer_email ?? undefined,
    committer_date: row.committer_date ? normalizeDateTime(row.committer_date) : undefined,
    total_seconds: row.total_seconds ?? undefined,
    human_readable_total: formatHumanReadable(row.total_seconds ?? 0),
    ref: row.ref ?? undefined,
    url: row.url ?? undefined,
  };
}

/**
 * Bind the idempotent commit upsert for one validated commit. Shared by the
 * single-commit `POST` (which passes the correlated or client-supplied
 * `totalSeconds`) and the bulk `POST` (which passes the supplied value
 * verbatim, no correlation). `project` comes from the path, not the body. Also
 * reused by the git-webhook receiver (Issue #146), which passes each mapped
 * commit's `total_seconds` (always null — git payloads carry no coding time).
 */
export function commitUpsertStmt(
  db: D1Database,
  userId: string,
  project: string,
  v: ValidatedCommit,
  totalSeconds: number | null,
): D1PreparedStatement {
  return db.prepare(UPSERT_SQL).bind(
    crypto.randomUUID(),
    userId,
    project,
    v.hash,
    v.message,
    v.author_name,
    v.author_email,
    v.author_date,
    v.committer_name,
    v.committer_email,
    v.committer_date,
    totalSeconds,
    v.ref,
    v.url,
  );
}

/** Parse the 1-based `page` query param; null when invalid (non-integer or < 1). */
function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * Derive a commit's coding time from the authenticated user's heartbeats around
 * it (Issue #145), run only when the client omitted `total_seconds`. Bounded:
 * a previous-commit-partitioned, 24h-capped window and a heartbeat read capped
 * at {@link CORRELATION_HEARTBEAT_LIMIT} rows — never a full scan (FR-007).
 *
 * The window is `[lower, upper]` (upper inclusive): `upper` is the commit's
 * `author_date` epoch (or ingest `now` when omitted); `lower` is the greater of
 * the previous same-project commit's `author_date` and `upper - 24h`. Epochs are
 * resolved in SQLite via `strftime('%s', …)` to avoid JS parse ambiguity on the
 * stored space-separated datetime text. The heartbeat read is NOT project-
 * filtered — the full in-window user stream is gapped and each interval credited
 * to its earlier heartbeat's project, so attribution matches `computeDurations`
 * (research D-4). Returns the rounded seconds when `> 0`, else `null`.
 */
async function correlateCommitSeconds(
  c: Context<AuthEnv>,
  userId: string,
  project: string,
  hash: string,
  authorDateText: string | null,
): Promise<number | null> {
  // Resolve both window epochs server-side: the upper bound (author_date, or
  // `now` when omitted) and the previous same-project commit's boundary
  // (greatest author_date strictly before upper, excluding this commit's hash;
  // a null-author_date prior is not eligible via MAX).
  const bounds = await c.env.DB.prepare(
    `SELECT
       CAST(strftime('%s', COALESCE(?, 'now')) AS INTEGER) AS upper_epoch,
       CAST(strftime('%s', (
         SELECT MAX(author_date) FROM commits
         WHERE user_id = ? AND project = ? AND hash != ?
           AND author_date < COALESCE(?, datetime('now'))
       )) AS INTEGER) AS prev_epoch`,
  )
    .bind(authorDateText, userId, project, hash, authorDateText)
    .first<{ upper_epoch: number | null; prev_epoch: number | null }>();

  const upperEpoch = bounds?.upper_epoch;
  if (upperEpoch == null) return null; // unparseable author_date guarded upstream

  const lowerEpoch = resolveWindow(upperEpoch, bounds?.prev_epoch ?? null, MAX_CORRELATION_WINDOW);
  const timeoutSec = (await getUserTimeout(c)) * 60; // stored minutes → seconds

  const { results } = await c.env.DB.prepare(
    `SELECT time, project FROM heartbeats
      WHERE user_id = ? AND time >= ? AND time <= ?
      ORDER BY time ASC
      LIMIT ?`,
  )
    .bind(userId, lowerEpoch, upperEpoch, CORRELATION_HEARTBEAT_LIMIT)
    .all<CorrelationRow>();

  const derived = sumActiveSeconds(results, project, timeoutSec);
  return derived > 0 ? derived : null;
}

const commits = new Hono<AuthEnv>();

commits.use("/projects/:project/commits", authMiddleware);
commits.use("/projects/:project/commits.bulk", authMiddleware);
commits.use("/projects/:project/commits/*", authMiddleware);

commits.post("/projects/:project/commits", async (c) => {
  const userId = c.get("userId");
  const project = c.req.param("project");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateCommitInput(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const v = parsed.value;

  try {
    // A client-supplied value (incl. explicit 0) wins and skips correlation,
    // preserving the fast single-upsert path (FR-002). Only an omitted/null
    // total_seconds triggers the heartbeat correlation query (FR-001).
    const totalSeconds =
      v.total_seconds !== null
        ? v.total_seconds
        : await correlateCommitSeconds(c, userId, project, v.hash, v.author_date);

    const row = await commitUpsertStmt(c.env.DB, userId, project, v, totalSeconds).first<CommitRow>();
    if (!row) {
      console.error("POST /projects/:project/commits error: upsert returned no row");
      return c.json({ error: "Internal server error" }, 500);
    }
    return c.json({ data: rowToCommit(row) }, 201);
  } catch (err) {
    console.error("POST /projects/:project/commits error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

commits.post("/projects/:project/commits.bulk", async (c) => {
  const userId = c.get("userId");
  const project = c.req.param("project");

  let inputs: unknown;
  try {
    inputs = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  // All-or-nothing: reject a non-array / over-cap body and validate every
  // element before writing anything (FR-003); the first failure reports its
  // index and nothing is persisted.
  const parsed = validateCommitInputBatch(inputs, MAX_BULK);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const validated = parsed.value;

  if (validated.length === 0) {
    return c.json({ data: [] }, 201);
  }

  try {
    // Bulk stores each supplied total_seconds verbatim (an explicit 0 included,
    // omitted → null) and NEVER correlates heartbeats (FR-005, FR-011): a
    // per-commit scan across the batch would exceed the Workers per-request
    // subrequest/CPU budget. One db.batch() runs the idempotent upserts in a
    // single transaction, so an in-batch duplicate (project, hash) applies
    // last-wins while the response still returns one entry per input in order.
    const batchResults = await c.env.DB.batch<CommitRow>(
      validated.map((v) => commitUpsertStmt(c.env.DB, userId, project, v, v.total_seconds)),
    );
    const data = batchResults
      .map((res) => res.results?.[0])
      .filter((row): row is CommitRow => row !== undefined)
      .map(rowToCommit);
    return c.json({ data }, 201);
  } catch (err) {
    console.error("POST /projects/:project/commits.bulk error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

commits.get("/projects/:project/commits", async (c) => {
  const userId = c.get("userId");
  const project = c.req.param("project");

  const page = parsePage(c.req.query("page"));
  if (page === null) {
    return c.json({ error: "Invalid page; must be an integer >= 1" }, 400);
  }

  const conditions = ["user_id = ?", "project = ?"];
  const binds: (string | number)[] = [userId, project];
  const author = c.req.query("author");
  if (author !== undefined) {
    conditions.push("author_email = ?");
    binds.push(author);
  }
  const branch = c.req.query("branch");
  if (branch !== undefined) {
    conditions.push("ref = ?");
    binds.push(branch);
  }
  const where = conditions.join(" AND ");

  try {
    const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM commits WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    const total = countRow?.n ?? 0;

    const { results } = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM commits
        WHERE ${where}
        ORDER BY author_date DESC, hash ASC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<CommitRow>();

    return c.json({
      data: results.map(rowToCommit),
      page,
      total_pages: Math.ceil(total / PAGE_SIZE),
    });
  } catch (err) {
    console.error("GET /projects/:project/commits error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

commits.get("/projects/:project/commits/:hash", async (c) => {
  const userId = c.get("userId");
  const project = c.req.param("project");
  const hash = c.req.param("hash");

  const conditions = ["user_id = ?", "project = ?", "hash = ?"];
  const binds: string[] = [userId, project, hash];
  const branch = c.req.query("branch");
  if (branch !== undefined) {
    conditions.push("ref = ?");
    binds.push(branch);
  }

  try {
    const row = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM commits WHERE ${conditions.join(" AND ")}`,
    )
      .bind(...binds)
      .first<CommitRow>();
    if (!row) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ data: rowToCommit(row) });
  } catch (err) {
    console.error("GET /projects/:project/commits/:hash error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default commits;
