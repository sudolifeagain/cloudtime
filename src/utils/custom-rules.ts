/**
 * Custom-rule matcher + KV-cached rule loading (specs/101-custom-rules-crud/).
 *
 * `applyRules` is pure: it rewrites or drops a heartbeat-like object in
 * memory according to the user's rules. `loadRules` / `invalidateRules`
 * wrap the per-user KV cache that keeps the heartbeat hot path off D1.
 */
import type { Env } from "../types";

export const RULE_FIELDS = [
  "project",
  "language",
  "editor",
  "operating_system",
  "category",
  "entity",
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export const RULE_OPERATIONS = ["equals", "contains", "starts_with", "ends_with"] as const;
export type RuleOperation = (typeof RULE_OPERATIONS)[number];

export const RULE_ACTIONS = ["change", "hide"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface CompiledRule {
  action: RuleAction;
  source: RuleField;
  operation: RuleOperation;
  source_value: string;
  destination: RuleField | "";
  destination_value: string;
}

const CACHE_TTL = 3600; // seconds; correctness comes from explicit invalidation
const cacheKey = (userId: string): string => `customrules:${userId}`;

interface RuleRow {
  action: string;
  source: string;
  operation: string;
  source_value: string;
  destination: string;
  destination_value: string;
  priority: number;
  created_at: string;
}

function matches(value: string, op: RuleOperation, target: string): boolean {
  switch (op) {
    case "equals":
      return value === target;
    case "contains":
      return value.includes(target);
    case "starts_with":
      return value.startsWith(target);
    case "ends_with":
      return value.endsWith(target);
  }
}

/**
 * Apply rules in order to a heartbeat-like object. Each `change` rule whose
 * `source` field matches rewrites the `destination` field in place, so later
 * rules see the new value. The first matching `hide` rule drops the heartbeat
 * (returns null). Returns the (possibly mutated) object, or null if hidden.
 */
export function applyRules<T extends Partial<Record<RuleField, unknown>>>(
  hb: T,
  rules: CompiledRule[],
): T | null {
  for (const rule of rules) {
    const field = hb[rule.source];
    if (typeof field !== "string" || !matches(field, rule.operation, rule.source_value)) {
      continue;
    }
    if (rule.action === "hide") {
      return null;
    }
    if (rule.destination !== "") {
      (hb as Record<RuleField, unknown>)[rule.destination] = rule.destination_value;
    }
  }
  return hb;
}

/**
 * Load the user's rules, KV-cached and pre-sorted by application order.
 * An empty set is cached too, so users without rules still skip the D1 read
 * on the heartbeat hot path.
 */
export async function loadRules(env: Env, userId: string): Promise<CompiledRule[]> {
  const cached = (await env.KV.get(cacheKey(userId), "json")) as CompiledRule[] | null;
  if (cached !== null) {
    return cached;
  }
  const { results } = await env.DB.prepare(
    `SELECT action, source, operation, source_value, destination, destination_value, priority, created_at
       FROM custom_rules WHERE user_id = ? ORDER BY priority ASC, created_at ASC`,
  )
    .bind(userId)
    .all<RuleRow>();
  const rules: CompiledRule[] = results.map((r) => ({
    action: r.action as RuleAction,
    source: r.source as RuleField,
    operation: r.operation as RuleOperation,
    source_value: r.source_value,
    destination: (r.destination || "") as RuleField | "",
    destination_value: r.destination_value,
  }));
  await env.KV.put(cacheKey(userId), JSON.stringify(rules), { expirationTtl: CACHE_TTL });
  return rules;
}

/** Drop the cached rule set so the next ingestion reloads from D1. */
export async function invalidateRules(env: Env, userId: string): Promise<void> {
  await env.KV.delete(cacheKey(userId));
}
