import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import heartbeats from "./routes/heartbeats";
import summaries from "./routes/summaries";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Health check
app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

// Heartbeat routes (mounted at /users/current, sub-app defines /heartbeats and /heartbeats.bulk)
app.route("/api/v1/users/current", heartbeats);

// Summary routes (mounted at /users/current, sub-app defines /summaries)
app.route("/api/v1/users/current", summaries);

// Cron trigger handler for periodic aggregation
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // TODO: Aggregate heartbeats into daily/weekly summaries
    console.log("Cron triggered:", event.cron);
  },
};
