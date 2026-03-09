import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import heartbeats from "./routes/heartbeats";
import summaries from "./routes/summaries";
import stats from "./routes/stats";
import users from "./routes/users";
import { aggregateHeartbeats } from "./cron/aggregate";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Health check
app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

// Heartbeat routes (mounted at /users/current, sub-app defines /heartbeats and /heartbeats.bulk)
app.route("/api/v1/users/current", heartbeats);

// Summary routes (mounted at /users/current, sub-app defines /summaries)
app.route("/api/v1/users/current", summaries);

// Stats routes (mounted at /users/current, sub-app defines /stats, /status_bar, /all_time_since_today, /durations)
app.route("/api/v1/users/current", stats);

// User routes (mounted at /users/current, sub-app defines /, /profile, /projects)
app.route("/api/v1/users/current", users);

// Cron trigger handler for periodic aggregation
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(aggregateHeartbeats(env.DB));
  },
};
