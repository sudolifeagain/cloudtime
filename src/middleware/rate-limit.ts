import { createMiddleware } from "hono/factory";
import type { Env, RateLimit } from "../types";

const warned = new WeakSet<object>();

function truncateIp(ip: string): string {
  if (ip.includes(":")) {
    const groups = ip.split(":");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function getClientIp(headers: Headers): string {
  const cfip = headers.get("CF-Connecting-IP");
  if (cfip) return cfip.trim();

  const xff = headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}

export function rateLimitMiddleware(
  getBinding: (env: Env) => RateLimit | undefined,
  ruleName: string,
) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const binding = getBinding(c.env);

    if (!binding) {
      if (!warned.has(c.env as object)) {
        warned.add(c.env as object);
        console.warn(`[rate-limit] binding for ${ruleName} is undefined; failing open for this isolate`);
      }
      return next();
    }

    const key = truncateIp(getClientIp(c.req.raw.headers));
    const { success } = await binding.limit({ key });

    if (success) return next();

    console.warn(`[rate-limit] rejected endpoint=${ruleName} key=${key}`);
    return c.json({ error: "Too many requests" }, 429, {
      "Retry-After": "60",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
  });
}
