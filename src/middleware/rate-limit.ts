import { createMiddleware } from "hono/factory";
import type { Env, RateLimit } from "../types";

const warned = new WeakSet<object>();

function stripIpDecoration(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  return trimmed;
}

function normalizeHextet(group: string): string | undefined {
  if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
  return parseInt(group, 16).toString(16);
}

function truncateIpv6(ip: string): string | undefined {
  const withoutZone = stripIpDecoration(ip).split("%", 1)[0].toLowerCase();
  const compressed = withoutZone.split("::");
  if (compressed.length > 2) return undefined;

  const head = compressed[0] ? compressed[0].split(":") : [];
  const prefix: string[] = [];

  for (const group of head.slice(0, 3)) {
    const normalized = normalizeHextet(group);
    if (!normalized) return undefined;
    prefix.push(normalized);
  }

  if (prefix.length < 3 && compressed.length === 2) {
    while (prefix.length < 3) prefix.push("0");
  }

  if (prefix.length !== 3) return undefined;
  return `${prefix.join(":")}::/48`;
}

function truncateIp(ip: string): string {
  if (ip.includes(":")) {
    return truncateIpv6(ip) ?? ip;
  }
  const parts = stripIpDecoration(ip).split(".");
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
  endpointName: string,
  ruleName: string,
) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const binding = getBinding(c.env);

    if (!binding) {
      if (!warned.has(c.env as object)) {
        warned.add(c.env as object);
        console.warn(`[rate-limit] binding ${ruleName} is undefined; failing open for this isolate`);
      }
      return next();
    }

    const key = truncateIp(getClientIp(c.req.raw.headers));
    const { success } = await binding.limit({ key });

    if (success) return next();

    console.warn(`[rate-limit] rejected endpoint=${endpointName} rule=${ruleName} key=${key}`);
    return c.json({ error: "Too many requests" }, 429, {
      "Retry-After": "60",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
  });
}
