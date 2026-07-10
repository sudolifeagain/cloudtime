/**
 * Per-provider webhook adapters (Issue #146, specs/146-git-webhook-adapter/).
 * Pure — no D1, no `Context` — so the delivery logic unit-tests without a
 * database: event detection, signature verification, repository extraction, and
 * payload → `CommitInput` mapping, isolated per git host (research D-2..D-5).
 *
 * GitHub authenticates with an HMAC-SHA256 of the *raw* request body keyed by
 * the registration secret (`X-Hub-Signature-256`); GitLab compares the
 * `X-Gitlab-Token` header to the secret. Both are constant-time (research D-3).
 */
import type { ValidatedCommit } from "../commit-input";
import { normalizeOptionalDate } from "../datetime";
import { INPUT_LIMITS, truncateTo } from "../input-limits";
import { timingSafeEqual } from "../crypto";

export type Provider = "github" | "gitlab";

/** True when `p` is a supported git host — any other `{provider}` is a 404. */
export function isSupportedProvider(p: unknown): p is Provider {
  return p === "github" || p === "gitlab";
}

/** The header carrying the event name for each provider. */
const EVENT_HEADER: Record<Provider, string> = {
  github: "X-GitHub-Event",
  gitlab: "X-Gitlab-Event",
};

/** The provider's push event name (mapped to commit ingestion). */
const PUSH_EVENT: Record<Provider, string> = {
  github: "push",
  gitlab: "Push Hook",
};

/**
 * Read the delivery's event name from the provider header. Returns null when the
 * header is missing or empty — the route treats that as a 400 (the delivery
 * names no event). A present, non-empty value (e.g. `ping`, `Push Hook`) is
 * returned verbatim for {@link isPushEvent} to classify.
 */
export function detectEvent(provider: Provider, headers: Headers): string | null {
  const value = headers.get(EVENT_HEADER[provider]);
  return value !== null && value.length > 0 ? value : null;
}

/** True when the detected event is the provider's push event. */
export function isPushEvent(provider: Provider, event: string): boolean {
  return event === PUSH_EVENT[provider];
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A non-empty string clamped to `cap`, else null (best-effort omit; research D-5). */
function clampString(v: unknown, cap: number): string | null {
  const s = nonEmptyString(v);
  return s === null ? null : truncateTo(s, cap);
}

/**
 * The repository identity a delivery targets, read from the payload: GitHub
 * `repository.full_name`, GitLab `project.path_with_namespace`. Null when the
 * body carries no such field — the route maps that to a 400 (FR-007).
 */
export function extractRepo(provider: Provider, payload: unknown): string | null {
  const body = asObject(payload);
  if (body === null) return null;
  if (provider === "github") {
    const repository = asObject(body.repository);
    return repository ? nonEmptyString(repository.full_name) : null;
  }
  const project = asObject(body.project);
  return project ? nonEmptyString(project.path_with_namespace) : null;
}

async function hmacSha256Hex(rawBody: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, rawBody);
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify the delivery's authenticity against the registration secret, over the
 * *raw* request bytes (never a re-serialized body — JSON round-tripping would
 * change the signed bytes). GitHub: `HMAC-SHA256(rawBody, secret)` compared
 * constant-time to `X-Hub-Signature-256`. GitLab: `X-Gitlab-Token` compared
 * constant-time to the secret. A missing header fails closed.
 */
export async function verify(
  provider: Provider,
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  if (provider === "github") {
    const signature = headers.get("X-Hub-Signature-256");
    if (signature === null) return false;
    const expected = `sha256=${await hmacSha256Hex(rawBody, secret)}`;
    return timingSafeEqual(signature, expected);
  }
  const token = headers.get("X-Gitlab-Token");
  if (token === null) return false;
  return timingSafeEqual(token, secret);
}

/** A push payload mapped to commit-ingestion inputs, plus the raw commit count. */
export interface MappedPush {
  /** Commit objects present in the payload (`received` in the ack). */
  received: number;
  /** Successfully mapped commits (usable hash), before the 100-per-delivery cap. */
  commits: ValidatedCommit[];
}

/**
 * Map a provider `push` payload to `CommitInput`s (research D-5). Uses only
 * documented public fields, parsed originally; clamps each field to its
 * `CommitInput` length cap and omits any it cannot normalize (an unparseable
 * `timestamp` → no `author_date`, which the read path backfills). A commit
 * object without a usable `id`/`hash` is dropped and shows up in the ack's
 * `skipped` (received − ingested). `total_seconds` is always absent — git
 * payloads carry no coding time. GitLab payloads have no committer, so those
 * fields are omitted for GitLab.
 */
export function mapCommits(provider: Provider, payload: unknown): MappedPush {
  const body = asObject(payload);
  const rawCommits = body && Array.isArray(body.commits) ? body.commits : [];
  const ref = clampString(body?.ref, INPUT_LIMITS.name);

  const commits: ValidatedCommit[] = [];
  for (const item of rawCommits) {
    const co = asObject(item);
    if (co === null) continue;
    const hash = nonEmptyString(co.id);
    if (hash === null) continue; // no usable hash → dropped (counted in skipped)

    const author = asObject(co.author);
    const committer = provider === "github" ? asObject(co.committer) : null;
    const authorDate = normalizeOptionalDate(co.timestamp);

    commits.push({
      hash: truncateTo(hash, INPUT_LIMITS.commitHash),
      message: clampString(co.message, INPUT_LIMITS.commitMessage),
      author_name: author ? clampString(author.name, INPUT_LIMITS.name) : null,
      author_email: author ? clampString(author.email, INPUT_LIMITS.email) : null,
      author_date: authorDate.ok ? authorDate.value : null,
      committer_name: committer ? clampString(committer.name, INPUT_LIMITS.name) : null,
      committer_email: committer ? clampString(committer.email, INPUT_LIMITS.email) : null,
      committer_date: null,
      total_seconds: null,
      ref,
      url: clampString(co.url, INPUT_LIMITS.url),
    });
  }
  return { received: rawCommits.length, commits };
}
