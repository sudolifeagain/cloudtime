/**
 * OAuth authentication routes — composed from sub-modules.
 */
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { Env } from "../../types";
import sessions from "./sessions";
import link from "./link";

const auth = new Hono<{ Bindings: Env }>();

// CSRF protection — validates Origin header for non-safe methods (POST, DELETE)
auth.use(
  "/*",
  csrf({
    origin: (origin, c) => {
      const appUrl = (c.env as Env).APP_URL?.replace(/\/+$/, "");
      return appUrl ? origin === appUrl : true;
    },
  }),
);

// Session-authenticated routes (static paths first)
auth.route("/", sessions);

// Account linking routes (session required for initiation, cookie-based for callback)
auth.route("/", link);

export default auth;
