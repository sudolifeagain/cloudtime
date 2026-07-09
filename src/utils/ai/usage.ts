/**
 * Owner-only AI usage summary builders (Issue #200, US2). Pure: no D1, no I/O.
 * `src/routes/ai.ts` owns fetching the `ai_daily_usage` rollup rows and the
 * enabled price rows; this module turns them into the `AIUsageSummary` shape
 * (aggregate-then-price), plus the deterministic request-range resolution.
 *
 * Cost is computed once per rollup bucket from the effective enabled price row
 * whose window contains the bucket day's start-of-day instant in the fixed
 * aggregation timezone (the owner's profile timezone), never per raw heartbeat.
 * A single summary `currency` is chosen deterministically and costs are never
 * summed across currencies (FR-022); a bucket the summary currency cannot fully
 * price surfaces in `missing_price_count` with no silent zero (FR-010).
 */
import type { components } from "../../types/generated";
import {
  priceBucket,
  selectEffectivePrice,
  type AiModelPriceRow,
  type BucketTokens,
} from "./pricing";
import { addDays, formatDate, getEpochBoundsForDate, getToday } from "../time-format";

type AIUsageSummary = components["schemas"]["AIUsageSummary"];
type AITokenTotals = components["schemas"]["AITokenTotals"];

/** Maximum inclusive-day span of a usage range (FR-008, matches `days` maximum). */
export const USAGE_MAX_DAYS = 366;
/** Trailing window size used when no explicit range is supplied (FR-008). */
export const USAGE_DEFAULT_DAYS = 30;

/** One `ai_daily_usage` rollup row as read from D1 (`project` `''` = no project). */
export interface AiDailyUsageRow {
  day: string;
  provider: string;
  model: string;
  agent: string;
  project: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  prompt_length_total: number;
  prompt_length_count: number;
  heartbeat_count: number;
}

export const AI_DAILY_USAGE_SELECT_COLUMNS =
  "day, provider, model, agent, project, input_tokens, output_tokens, " +
  "cached_input_tokens, reasoning_output_tokens, cache_write_tokens, cache_read_tokens, " +
  "prompt_length_total, prompt_length_count, heartbeat_count";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a `YYYY-MM-DD` calendar date (round-trips through UTC). */
function isValidYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Inclusive day count between two `YYYY-MM-DD` dates (`start == end` → 1). */
function inclusiveDaySpan(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000 + 1;
}

export type RangeResolution =
  | { ok: true; start: string; end: string }
  | { ok: false; error: string };

/**
 * Deterministic `/ai/usage` range resolution (FR-008). Explicit `start`+`end`
 * wins and `days` is ignored; exactly one of `start`/`end` is a `400`; otherwise
 * a trailing `days` window (default {@link USAGE_DEFAULT_DAYS}) ending on the
 * local "today" in `tz`. `tz` only anchors "today" and labels the range — it
 * never re-buckets stored days. Rejects `start > end`, spans over
 * {@link USAGE_MAX_DAYS}, and out-of-range `days`.
 */
export function resolveUsageRange(
  startQ: string | undefined,
  endQ: string | undefined,
  daysQ: string | undefined,
  tz: string,
): RangeResolution {
  const hasStart = startQ !== undefined;
  const hasEnd = endQ !== undefined;
  if (hasStart !== hasEnd) {
    return { ok: false, error: "start and end must be supplied together" };
  }
  if (hasStart && hasEnd) {
    if (!isValidYmd(startQ as string) || !isValidYmd(endQ as string)) {
      return { ok: false, error: "start and end must be valid YYYY-MM-DD dates" };
    }
    // Lexical comparison is chronological for zero-padded YYYY-MM-DD.
    if ((startQ as string) > (endQ as string)) {
      return { ok: false, error: "start must not be after end" };
    }
    if (inclusiveDaySpan(startQ as string, endQ as string) > USAGE_MAX_DAYS) {
      return { ok: false, error: `range must not exceed ${USAGE_MAX_DAYS} days` };
    }
    return { ok: true, start: startQ as string, end: endQ as string };
  }

  let days = USAGE_DEFAULT_DAYS;
  if (daysQ !== undefined) {
    if (!/^\d+$/.test(daysQ)) {
      return { ok: false, error: "days must be a positive integer" };
    }
    days = Number(daysQ);
    if (!Number.isInteger(days) || days < 1 || days > USAGE_MAX_DAYS) {
      return { ok: false, error: `days must be between 1 and ${USAGE_MAX_DAYS}` };
    }
  }
  const today = getToday(tz);
  return {
    ok: true,
    start: formatDate(addDays(today, -(days - 1))),
    end: formatDate(today),
  };
}

/** Mutable per-group accumulator; finalized into an {@link AITokenTotals}. */
interface Accumulator {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  prompt_length_total: number;
  prompt_length_count: number;
  heartbeat_count: number;
  cost_sum: number;
  /** True once at least one contributing heartbeat fell in a fully-priced bucket. */
  priced: boolean;
  missing_price_count: number;
}

function newAccumulator(): Accumulator {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    prompt_length_total: 0,
    prompt_length_count: 0,
    heartbeat_count: 0,
    cost_sum: 0,
    priced: false,
    missing_price_count: 0,
  };
}

/** A rollup row plus its resolved cost (`null` = unpriced in the summary currency). */
interface PricedBucket {
  row: AiDailyUsageRow;
  cost: number | null;
}

function bucketTokens(row: AiDailyUsageRow): BucketTokens {
  return {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_input_tokens: row.cached_input_tokens,
    reasoning_output_tokens: row.reasoning_output_tokens,
    cache_write_tokens: row.cache_write_tokens,
    cache_read_tokens: row.cache_read_tokens,
  };
}

function accumulate(acc: Accumulator, pb: PricedBucket): void {
  const r = pb.row;
  acc.input_tokens += r.input_tokens;
  acc.output_tokens += r.output_tokens;
  acc.cached_input_tokens += r.cached_input_tokens;
  acc.reasoning_output_tokens += r.reasoning_output_tokens;
  acc.cache_write_tokens += r.cache_write_tokens;
  acc.cache_read_tokens += r.cache_read_tokens;
  acc.prompt_length_total += r.prompt_length_total;
  acc.prompt_length_count += r.prompt_length_count;
  acc.heartbeat_count += r.heartbeat_count;
  if (pb.cost === null) {
    // Unpriced bucket: every contributing heartbeat surfaces as missing, and
    // nothing is added to the cost sum (never a silent zero, FR-010).
    acc.missing_price_count += r.heartbeat_count;
  } else {
    acc.cost_sum += pb.cost;
    acc.priced = true;
  }
}

function finalize(acc: Accumulator): AITokenTotals {
  return {
    input_tokens: acc.input_tokens,
    output_tokens: acc.output_tokens,
    cached_input_tokens: acc.cached_input_tokens,
    reasoning_output_tokens: acc.reasoning_output_tokens,
    cache_write_tokens: acc.cache_write_tokens,
    cache_read_tokens: acc.cache_read_tokens,
    prompt_length_total: acc.prompt_length_total,
    prompt_length_avg:
      acc.prompt_length_count > 0 ? acc.prompt_length_total / acc.prompt_length_count : null,
    heartbeat_count: acc.heartbeat_count,
    estimated_cost: acc.priced ? acc.cost_sum : null,
    missing_price_count: acc.missing_price_count,
  };
}

/** Ascending code-point comparator (deterministic; no locale dependence). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Injective composite map key over arbitrary strings. `provider`/`model`/
 * `project` are unrestricted user text, so a plain-delimiter join could collide;
 * `JSON.stringify` of a string array is unambiguous and deterministic.
 */
function tupleKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

export interface BuildUsageParams {
  start: string;
  end: string;
  /** Request timezone, echoed in the response for labeling (FR-008). */
  timezone: string;
  /** Fixed aggregation timezone (owner profile tz) the `day` keys were built in. */
  aggregationTz: string;
  rows: AiDailyUsageRow[];
  /** Owner + default price rows for the user (enabled and disabled; filtered here). */
  prices: AiModelPriceRow[];
}

/** A `by_model` group keyed by (provider, model), carrying both labels. */
interface ModelGroup {
  provider: string;
  model: string;
  acc: Accumulator;
}

/**
 * Build the owner-only `AIUsageSummary` from pre-aggregated rollup rows and the
 * user's price rows (aggregate-then-price). Resolves each bucket's effective
 * enabled price row at the bucket day's start-of-day instant in the fixed
 * aggregation timezone, chooses one summary currency (FR-022), and rolls the
 * buckets up into totals, a daily trend, and project/agent/provider/model
 * breakdowns. Cross-currency and partially-priced buckets contribute to
 * `missing_price_count`, never to a silent-zero cost (FR-010).
 */
export function buildUsageSummary(params: BuildUsageParams): AIUsageSummary {
  const { start, end, timezone, aggregationTz, rows, prices } = params;

  // Enabled price rows grouped by (provider, model) for effective-row selection.
  const enabledByProviderModel = new Map<string, AiModelPriceRow[]>();
  for (const p of prices) {
    if (p.is_enabled !== 1) continue;
    const key = tupleKey(p.provider, p.model);
    const list = enabledByProviderModel.get(key);
    if (list) list.push(p);
    else enabledByProviderModel.set(key, [p]);
  }

  // Bucket day's start-of-day instant, memoized per day (all buckets on a day
  // share it), evaluated in the fixed aggregation timezone (FR-009/FR-025).
  const instantByDay = new Map<string, number>();
  const instantFor = (day: string): number => {
    let ms = instantByDay.get(day);
    if (ms === undefined) {
      ms = getEpochBoundsForDate(day, aggregationTz).start * 1000;
      instantByDay.set(day, ms);
    }
    return ms;
  };

  // Match each bucket to its effective enabled price row (memoized per
  // day+provider+model). `undefined` = uncached; `null` = no matching row.
  const matchCache = new Map<string, AiModelPriceRow | null>();
  const matchedFor = (row: AiDailyUsageRow): AiModelPriceRow | null => {
    const key = tupleKey(row.day, row.provider, row.model);
    const cached = matchCache.get(key);
    if (cached !== undefined) return cached;
    const candidates = enabledByProviderModel.get(tupleKey(row.provider, row.model));
    const match = candidates ? selectEffectivePrice(candidates, instantFor(row.day)) : null;
    matchCache.set(key, match);
    return match;
  };

  // FR-022 currency selection: tally contributing heartbeats by their matched
  // row's currency; pick the max, ties broken by smallest code, else USD.
  const tally = new Map<string, number>();
  for (const row of rows) {
    const match = matchedFor(row);
    if (match) tally.set(match.currency, (tally.get(match.currency) ?? 0) + row.heartbeat_count);
  }
  let currency = "USD";
  let bestCount = -1;
  for (const [cur, count] of tally) {
    if (count > bestCount || (count === bestCount && cur < currency)) {
      bestCount = count;
      currency = cur;
    }
  }

  // Price each bucket in the chosen summary currency; flag any cross-currency
  // match. A different-currency or partial-rate match yields `cost: null`.
  let mixedCurrency = false;
  const priced: PricedBucket[] = rows.map((row) => {
    const match = matchedFor(row);
    if (!match) return { row, cost: null };
    if (match.currency !== currency) {
      mixedCurrency = true;
      return { row, cost: null };
    }
    return { row, cost: priceBucket(bucketTokens(row), match) };
  });

  const totals = newAccumulator();
  const daily = new Map<string, Accumulator>();
  const byProject = new Map<string, Accumulator>();
  const byAgent = new Map<string, Accumulator>();
  const byProvider = new Map<string, Accumulator>();
  const byModel = new Map<string, ModelGroup>();

  const groupAcc = (map: Map<string, Accumulator>, key: string): Accumulator => {
    let acc = map.get(key);
    if (!acc) {
      acc = newAccumulator();
      map.set(key, acc);
    }
    return acc;
  };

  for (const pb of priced) {
    const r = pb.row;
    accumulate(totals, pb);
    accumulate(groupAcc(daily, r.day), pb);
    accumulate(groupAcc(byProject, r.project), pb);
    accumulate(groupAcc(byAgent, r.agent), pb);
    accumulate(groupAcc(byProvider, r.provider), pb);

    const modelKey = tupleKey(r.provider, r.model);
    let modelGroup = byModel.get(modelKey);
    if (!modelGroup) {
      modelGroup = { provider: r.provider, model: r.model, acc: newAccumulator() };
      byModel.set(modelKey, modelGroup);
    }
    accumulate(modelGroup.acc, pb);
  }

  const summary: AIUsageSummary = {
    start,
    end,
    timezone,
    currency,
    totals: finalize(totals),
    daily: [...daily.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([date, acc]) => ({ date, ...finalize(acc) })),
    by_project: [...byProject.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([project, acc]) => ({ project: project === "" ? null : project, ...finalize(acc) })),
    by_agent: [...byAgent.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([agent, acc]) => ({ agent, ...finalize(acc) })),
    by_provider: [...byProvider.entries()]
      .sort((a, b) => cmp(a[0], b[0]))
      .map(([provider, acc]) => ({ provider, ...finalize(acc) })),
    by_model: [...byModel.values()]
      .sort((a, b) => cmp(a.provider, b.provider) || cmp(a.model, b.model))
      .map((g) => ({ provider: g.provider, model: g.model, ...finalize(g.acc) })),
  };
  if (mixedCurrency) summary.mixed_currency = true;
  return summary;
}
