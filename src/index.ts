import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import webApp from "./routes/app";
import meta from "./routes/meta";
import auth from "./routes/auth";
import heartbeats from "./routes/heartbeats";
import summaries from "./routes/summaries";
import stats from "./routes/stats";
import users from "./routes/users";
import goals from "./routes/goals";
import customRules from "./routes/custom-rules";
import insights from "./routes/insights";
import externalDurations from "./routes/external-durations";
import commits from "./routes/commits";
import dataDumps from "./routes/data-dumps";
import machines from "./routes/machines";
import userAgents from "./routes/user-agents";
import { cardsPublic, cardsSettings } from "./routes/cards";
import ai from "./routes/ai";
import { webhooksCrud, webhooksReceiver } from "./routes/webhooks";
import { aggregateHeartbeats } from "./cron/aggregate";
import { backfillHourlySummaries } from "./cron/hourly-backfill";
import { parseRetentionDays, purgeOldHeartbeats } from "./cron/purge";
import { processPendingDumps, purgeExpiredDumps } from "./cron/data-dumps";

const app = new Hono<{ Bindings: Env }>();

// ENVIRONMENT=development relaxes the __Host-/Secure cookie attributes, CSRF
// origin checks, and OAuth redirect-URI validation. If such an instance is
// serving non-local traffic the operator has almost certainly misconfigured a
// production deployment — surface it loudly, once per isolate (Issue #153).
// Log-only on purpose: intentional dev tunnels keep working.
let warnedDevEnvironment = false;
const LOCAL_HOSTNAME_RE = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;

app.use("/*", async (c, next) => {
  if (!warnedDevEnvironment && c.env.ENVIRONMENT === "development") {
    const hostname = new URL(c.req.url).hostname;
    if (!LOCAL_HOSTNAME_RE.test(hostname)) {
      warnedDevEnvironment = true;
      console.warn(
        `[env] ENVIRONMENT=development is serving non-local host "${hostname}" — ` +
          "cookie security attributes, CSRF origin checks, and OAuth redirect-URI " +
          "validation are relaxed in this mode. Unset ENVIRONMENT for production deployments.",
      );
    }
  }
  return next();
});

app.use(
  "/*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      imgSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
);
app.use("/*", bodyLimit({ maxSize: 256 * 1024 })); // 256 KB (CVE-2025-59139 mitigation)

// CORS configuration for browser-based clients.
// NOTE: CORS is a browser-only protection — curl/Postman/server-side requests
// ignore CORS headers entirely. Actual access control is enforced by authMiddleware
// (API key) and session validation, not by CORS.
// NOTE: Hono's CORS middleware sends `Access-Control-Allow-Credentials: true`
// even when the origin function returns null (rejecting the origin). Browsers
// still block the response because `Access-Control-Allow-Origin` is omitted,
// so this is not exploitable, but security scanners may flag it.
// Assumes same-origin deployment (frontend and API share APP_URL origin).
// Session cookies use SameSite=Lax which prevents cross-origin fetch from
// sending cookies — only top-level navigation GETs include them. If a
// cross-origin frontend is needed, SameSite=None must be considered.
app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      const appUrl = c.env.APP_URL;
      if (!appUrl) {
        // Only reflect origin in development; fail closed in production
        return c.env.ENVIRONMENT === "development" && origin ? origin : null;
      }
      try {
        const allowed = new URL(appUrl).origin;
        return origin === allowed ? origin : null;
      } catch {
        return null;
      }
    },
    credentials: true,
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

// Global CSRF protection — validates Origin header for non-safe methods
// (POST, PUT, PATCH, DELETE). Safe methods (GET, HEAD, OPTIONS) are skipped.
// Requests with an Authorization header are exempt because API key auth is not
// vulnerable to CSRF (browsers cannot set custom headers via forms/navigation,
// and fetch with custom headers triggers a CORS preflight blocked by origin policy).
// NOTE: ?api_key= query param auth is intentionally NOT exempt. Query params can
// be forged via HTML forms, and authMiddleware rejects invalid API keys with 401
// without falling back to session cookies — but empty ?api_key= values are falsy
// and DO fall through to session auth. Editor plugins use Authorization:
// Basic/Bearer so this does not affect them.
const csrfMiddleware = csrf({
  origin: (origin, c) => {
    const env = c.env as Env;
    if (!env.APP_URL) {
      return env.ENVIRONMENT === "development";
    }
    try {
      return origin === new URL(env.APP_URL).origin;
    } catch {
      return false;
    }
  },
});
app.use("/*", async (c, next) => {
  if (c.req.header("Authorization")) {
    return next();
  }
  // The out-of-band email verification endpoint (Issue #80) is intentionally
  // exempt from CSRF: it is method-restricted at the route layer (GET success,
  // 405 for other methods) and the bearer is the URL token itself, which is
  // unguessable. CSRF would otherwise convert non-GET probes into 403 before
  // the route handler can return the documented 405.
  if (c.req.path.startsWith("/api/v1/auth/link/verify/")) {
    return next();
  }
  // The public git-webhook receiver (Issue #146) is CSRF-exempt: a git-host
  // POST carries no Authorization header and no same-origin Origin, so CSRF
  // would otherwise 403 it before the handler runs. Its authenticity is the
  // per-repo signature (research D-3), which a CSRF attacker cannot forge — not
  // an ambient session cookie. This is the first CSRF-exempt public write POST.
  if (c.req.path.startsWith("/api/v1/webhooks/git/")) {
    return next();
  }
  return csrfMiddleware(c, next);
});

// Health check
app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

// Web UI
app.route("/", webApp);

// Meta routes (public, no auth — /meta, /editors, /program_languages, /stats/:range)
app.route("/api/v1", meta);

// Public embeddable card images (no auth — /users/:username/cards/:type.svg, spec 160)
app.route("/api/v1", cardsPublic);

// Public git-host webhook receiver (no auth; per-repo signature —
// POST /webhooks/git/:provider, Issue #146)
app.route("/api/v1", webhooksReceiver);

// Auth routes (OAuth, sessions, providers — before other authenticated routes)
app.route("/api/v1/auth", auth);

// Heartbeat routes (mounted at /users/current, sub-app defines /heartbeats and /heartbeats.bulk)
app.route("/api/v1/users/current", heartbeats);

// Summary routes (mounted at /users/current, sub-app defines /summaries)
app.route("/api/v1/users/current", summaries);

// Stats routes (mounted at /users/current, sub-app defines /stats, /status_bar, /all_time_since_today, /durations)
app.route("/api/v1/users/current", stats);

// User routes (mounted at /users/current, sub-app defines /, /profile, /projects)
app.route("/api/v1/users/current", users);

// Goals routes (mounted at /users/current, sub-app defines /goals, /goals/:goal_id)
app.route("/api/v1/users/current", goals);

// Custom rules routes (mounted at /users/current, sub-app defines /custom_rules, /custom_rules/:rule_id)
app.route("/api/v1/users/current", customRules);

// Insights routes (mounted at /users/current, sub-app defines /insights/:insight_type/:range)
app.route("/api/v1/users/current", insights);

// External durations routes (mounted at /users/current, sub-app defines /external_durations, /external_durations.bulk)
app.route("/api/v1/users/current", externalDurations);

// Commits routes (mounted at /users/current, sub-app defines /projects/:project/commits[/:hash])
app.route("/api/v1/users/current", commits);

// Data dumps routes (mounted at /users/current, sub-app defines /data_dumps[/:id/download])
app.route("/api/v1/users/current", dataDumps);

// Machine names routes (mounted at /users/current, sub-app defines /machine_names)
app.route("/api/v1/users/current", machines);

// User agents routes (mounted at /users/current, sub-app defines /user_agents)
app.route("/api/v1/users/current", userAgents);

// Embed settings routes (mounted at /users/current, sub-app defines /embed_settings, spec 160)
app.route("/api/v1/users/current", cardsSettings);

// AI model price + usage routes (mounted at /users/current, sub-app defines /ai/*, Issue #200)
app.route("/api/v1/users/current", ai);

// Git-host webhook registration CRUD (mounted at /users/current, sub-app
// defines /webhooks[/:webhook_id], Issue #146)
app.route("/api/v1/users/current", webhooksCrud);

// Cron trigger handler for periodic aggregation + session cleanup
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Run cron tasks independently so a failure in one does not prevent
        // the others from completing.
        const retentionDays = parseRetentionDays(env.HEARTBEAT_RETENTION_DAYS);
        const [
          aggregationResult,
          batchResults,
          purgeResult,
          dumpBuildResult,
          dumpPurgeResult,
          hourlyBackfillResult,
        ] = await Promise.allSettled([
          aggregateHeartbeats(env.DB),
          // Atomic DELETE + RETURNING avoids TOCTOU between SELECT and DELETE
          env.DB.batch([
            env.DB.prepare(
              "DELETE FROM sessions WHERE expires_at < datetime('now') OR last_active_at < datetime('now', '-1 day') RETURNING token_hash",
            ),
            env.DB.prepare("DELETE FROM pending_links WHERE expires_at < datetime('now')"),
          ]),
          // Purge raw heartbeats past the retention window (Issue #108).
          // No-op when retention is unset; throttled per run so a backlog
          // clears over several cron cycles.
          retentionDays !== null ? purgeOldHeartbeats(env.DB, retentionDays) : Promise.resolve(0),
          // Build pending data dumps and purge expired ones (Issue #102).
          // No-ops when R2_BUCKET is unbound.
          processPendingDumps(env),
          purgeExpiredDumps(env),
          // One-off Issue #142 backfill. It stops after COMPLETED_KEY is set
          // and skips user/date pairs that already have hourly rows.
          backfillHourlySummaries(env.DB),
        ]);

        // Clean up KV cache for deleted sessions
        if (batchResults?.status === "fulfilled") {
          const expired = (batchResults.value[0].results ?? []) as { token_hash: string }[];
          if (expired.length > 0) {
            await Promise.all(expired.map((r) => env.KV.delete(`session:${r.token_hash}`)));
          }
        }

        if (aggregationResult?.status === "rejected") {
          console.error("Heartbeat aggregation failed:", aggregationResult.reason);
        }
        if (purgeResult?.status === "rejected") {
          console.error("Heartbeat purge failed:", purgeResult.reason);
        }
        if (dumpBuildResult?.status === "rejected") {
          console.error("Data dump build failed:", dumpBuildResult.reason);
        }
        if (dumpPurgeResult?.status === "rejected") {
          console.error("Data dump purge failed:", dumpPurgeResult.reason);
        }
        if (hourlyBackfillResult?.status === "fulfilled") {
          const result = hourlyBackfillResult.value;
          if (result.insertedRows > 0) {
            console.log(
              `Hourly summaries backfill inserted ${result.insertedRows} rows ` +
                `through cursor ${result.cursor}` +
                (result.earliestDate ? `; earliest backfilled date ${result.earliestDate}` : ""),
            );
          }
        } else if (hourlyBackfillResult?.status === "rejected") {
          console.error("Hourly summaries backfill failed:", hourlyBackfillResult.reason);
        }
      })(),
    );
  },
};
