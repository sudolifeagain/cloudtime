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

// `link` is mounted BEFORE `sessions` because the public verify endpoint
// (`/link/verify/:token`, Issue #80) must not be intercepted by the
// wildcard session middleware in `sessions`. Hono matches sub-apps in
// mount order, so the verify route resolves to `link`'s handler before
// sessions can claim it.
auth.route("/", link);

// Session-authenticated routes (static paths)
auth.route("/", sessions);

// Public routes (parameterized, last)
auth.route("/", login);

export default auth;
