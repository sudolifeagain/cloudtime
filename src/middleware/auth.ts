import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { getApiKey, getUserId } from "../utils/auth";

type AuthEnv = {
  Bindings: Env;
  Variables: { userId: string };
};

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const apiKey = getApiKey(c.req);
  if (!apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const userId = await getUserId(apiKey, c.env);
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId", userId);
  await next();
});
