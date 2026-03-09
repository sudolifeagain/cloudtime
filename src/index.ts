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
app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      const appUrl = (c.env as Env).APP_URL?.replace(/\/+$/, "");
      if (appUrl) return origin === appUrl ? origin : "";
      // Development: reflect origin (allow all)
      return origin;
    },
    credentials: true,
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
        // Query expired sessions first (before deletion) for KV cache cleanup
        const [, expiredSessions] = await Promise.all([
          aggregateHeartbeats(env.DB),
          env.DB.prepare(
            "SELECT token_hash FROM sessions WHERE expires_at < datetime('now') OR last_active_at < datetime('now', '-1 day')",
          ).all<{ token_hash: string }>(),
        ]);

        // Delete expired records from D1
        await env.DB.batch([
          env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
          env.DB.prepare("DELETE FROM sessions WHERE last_active_at < datetime('now', '-1 day')"),
          env.DB.prepare("DELETE FROM pending_links WHERE expires_at < datetime('now')"),
        ]);

        // Clean up KV cache for deleted sessions
        if (expiredSessions.results.length > 0) {
          await Promise.all(
            expiredSessions.results.map((r) => env.KV.delete(`session:${r.token_hash}`)),
          );
        }
      })(),
    );
  },
};
