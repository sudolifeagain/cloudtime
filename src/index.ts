import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import meta from "./routes/meta";
import auth from "./routes/auth";
import heartbeats from "./routes/heartbeats";
import summaries from "./routes/summaries";
import stats from "./routes/stats";
import users from "./routes/users";
import { aggregateHeartbeats } from "./cron/aggregate";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", secureHeaders());

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

// Health check
app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

// Meta routes (public, no auth — /meta, /editors, /program_languages, /stats/:range)
app.route("/api/v1", meta);

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

// Cron trigger handler for periodic aggregation + session cleanup
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Atomic DELETE + RETURNING avoids TOCTOU between SELECT and DELETE
        const [, batchResults] = await Promise.all([
          aggregateHeartbeats(env.DB),
          env.DB.batch([
            env.DB.prepare(
              "DELETE FROM sessions WHERE expires_at < datetime('now') OR last_active_at < datetime('now', '-1 day') RETURNING token_hash",
            ),
            env.DB.prepare("DELETE FROM pending_links WHERE expires_at < datetime('now')"),
          ]),
        ]);

        // Clean up KV cache for deleted sessions
        const expired = (batchResults[0].results ?? []) as { token_hash: string }[];
        if (expired.length > 0) {
          await Promise.all(expired.map((r) => env.KV.delete(`session:${r.token_hash}`)));
        }
      })(),
    );
  },
};
