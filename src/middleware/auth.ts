import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../types";
import { getApiKey, getUserId } from "../utils/auth";

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
