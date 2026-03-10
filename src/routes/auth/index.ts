/**
 * OAuth authentication routes — composed from sub-modules.
 */
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { Env } from "../../types";
import sessions from "./sessions";

const auth = new Hono<{ Bindings: Env }>();

// CSRF protection — validates Origin header for non-safe methods (POST, DELETE)
auth.use(
  "/*",
  csrf({
    origin: (origin, c) => {
      const env = c.env as Env;
      const appUrl = env.APP_URL?.replace(/\/+$/, "");
      if (appUrl) return origin === appUrl;
      // Only bypass CSRF in development; fail closed in production
      return env.ENVIRONMENT === "development";
    },
  }),
);

// Session-authenticated routes (static paths first)
auth.route("/", sessions);

export default auth;
