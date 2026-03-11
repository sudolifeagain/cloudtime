/**
 * OAuth authentication routes — composed from sub-modules.
 * CSRF protection is applied globally in src/index.ts.
 */
import { Hono } from "hono";
import type { Env } from "../../types";
import sessions from "./sessions";
import login from "./login";
import link from "./link";

const auth = new Hono<{ Bindings: Env }>();

// Session-authenticated routes (static paths first)
auth.route("/", sessions);

// Public routes (parameterized, last)
auth.route("/", login);

// Account linking routes (session required for initiation, cookie-based for callback)
auth.route("/", link);

export default auth;
