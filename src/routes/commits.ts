/**
 * Per-commit coding-time read endpoints (specs/107-commits/).
 *
 * Read surface only: a paginated list and a single-commit lookup over the
 * existing `commits` table. Ingestion (a coding-time plugin posting commits,
 * or a git webhook) is a deliberate follow-up; the table is seeded out of
 * band until then.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";
import { formatHumanReadable } from "../utils/time-format";

type Commit = components["schemas"]["Commit"];

const PAGE_SIZE = 100;

interface CommitRow {
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

/** Parse the 1-based `page` query param; null when invalid (non-integer or < 1). */
function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

const commits = new Hono<AuthEnv>();

commits.use("/projects/:project/commits", authMiddleware);
commits.use("/projects/:project/commits/*", authMiddleware);

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
