import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Health check
app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

// Cron trigger handler for periodic aggregation
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // TODO: Aggregate heartbeats into daily/weekly summaries
    console.log("Cron triggered:", event.cron);
  },
};
