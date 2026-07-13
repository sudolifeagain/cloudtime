/**
 * Shipped default AI model prices (Issue #200 follow-up). A code-maintained
 * catalog of API-equivalent list rates so a fresh CloudTime instance estimates
 * cost out of the box, before an owner configures anything. Values are per
 * 1,000,000 tokens in USD.
 *
 * Design: resolve prices by the *shape* of a model id rather than pinning every
 * version, so a steady stream of new models does not go stale immediately.
 *   - **Anthropic** prices are flat within a family generation (every
 *     `claude-opus-*` is $5/$25, `claude-haiku-*` $1/$5, …), so a default is
 *     resolved from the family — a future `claude-opus-4-9` is priced with no
 *     code change.
 *   - **OpenAI** prices per version with no flat family rate, so its models are
 *     listed explicitly. An OpenAI model not in the list resolves to nothing.
 * An unresolved model stays unpriced and surfaces in `missing_price_count`
 * (never a silent zero); the owner can add a row for it.
 *
 * A family/model may carry more than one time window when a list rate changes
 * on a known date (e.g. Sonnet 5's introductory rate through 2026-08-31). Each
 * window becomes its own default row; `selectEffectivePrice` picks the one whose
 * `[effective_from, effective_to)` contains the usage day, so cost is accurate
 * across the boundary. `resolveDefaultPrices` therefore returns 0..n rows.
 *
 * Defaults materialize as read-only `is_default = 1` rows merged into price
 * reads, not stored in D1 — nothing to seed or migrate. `selectEffectivePrice`
 * ranks any owner row ahead of a default, so overrides win; the synthetic
 * `default:<provider>:<model>` ids never exist in D1, so the single-row price
 * endpoints 404 on them (id existence is not leaked). Model ids match what
 * `deriveAiIdentity` produces (`opus/4-8` → `claude-opus-4-8`).
 *
 * Rate conventions: `cached_input` (cache-hit input) = 0.1× input; `reasoning_output`
 * is billed at the output rate. `cache_write` = 1.25× input (5-minute write) is set
 * for Anthropic and for OpenAI's gpt-5.6+ tiers, which adopted the same cache-write
 * surcharge; earlier OpenAI versions leave it null. `cache_read` = 0.1× input is set
 * for Anthropic; OpenAI leaves it null and reports cache reads as `cached_input`.
 * Unused token classes never affect a bucket, so over-specifying a rate is harmless.
 */
import type { AiModelPriceRow } from "./pricing";

/** Effective-from for every open-ended shipped default: a broad past window. */
export const DEFAULT_PRICE_EFFECTIVE_FROM = "2020-01-01 00:00:00";

const ANTHROPIC_SRC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_SRC = "https://developers.openai.com/api/docs/pricing";

/** One time-windowed list rate. `to = null` is open-ended. Per-MTok USD. */
interface RateWindow {
  readonly from: string;
  readonly to: string | null;
  readonly input: number;
  readonly output: number;
}

/**
 * Anthropic family → time-windowed [input, output] per-MTok USD. Flat within a
 * family generation, so any version resolves from its family (verified 2026-07).
 * Sonnet 5 ships an introductory rate ($2/$10) through 2026-08-31, then its
 * standard $3/$15 — expressed as two windows so each usage day prices correctly.
 */
const ANTHROPIC_FAMILY_RATES: Record<string, readonly RateWindow[]> = {
  opus: [{ from: DEFAULT_PRICE_EFFECTIVE_FROM, to: null, input: 5, output: 25 }],
  sonnet: [
    { from: DEFAULT_PRICE_EFFECTIVE_FROM, to: "2026-09-01 00:00:00", input: 2, output: 10 },
    { from: "2026-09-01 00:00:00", to: null, input: 3, output: 15 },
  ],
  haiku: [{ from: DEFAULT_PRICE_EFFECTIVE_FROM, to: null, input: 1, output: 5 }],
  fable: [{ from: DEFAULT_PRICE_EFFECTIVE_FROM, to: null, input: 10, output: 50 }],
  mythos: [{ from: DEFAULT_PRICE_EFFECTIVE_FROM, to: null, input: 10, output: 50 }],
};

/**
 * OpenAI is priced per version, so each model id is listed explicitly (verified
 * 2026-07). gpt-5.6 ships three tiers; the bare `gpt-5.6` slug maps to Sol.
 */
const OPENAI_MODEL_RATES: Record<string, readonly [number, number]> = {
  "gpt-5": [1.25, 10],
  "gpt-5.3-codex": [1.75, 14],
  "gpt-5.4": [2.5, 15],
  "gpt-5.5": [5, 30],
  "gpt-5.6": [5, 30], // bare slug → Sol tier
  "gpt-5.6-sol": [5, 30],
  "gpt-5.6-terra": [2.5, 15],
  "gpt-5.6-luna": [1, 6],
};

/**
 * OpenAI models that bill cache writes at 1.25× input, matching Anthropic's
 * 5-minute cache-write surcharge. Introduced with gpt-5.6; earlier versions
 * leave `cache_write` null (verified 2026-07).
 */
const OPENAI_CACHE_WRITE_MODELS = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

/** Avoid binary-float noise in derived rates (e.g. 1.25 * 0.1). */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Inputs for one synthetic default row. */
interface RowSpec {
  provider: string;
  model: string;
  input: number;
  output: number;
  from: string;
  to: string | null;
  source: string;
  /** Set `cache_write` = 1.25× input (Anthropic; OpenAI gpt-5.6+). */
  cacheWrite: boolean;
  /** Set `cache_read` = 0.1× input (Anthropic only; OpenAI uses `cached_input`). */
  cacheRead: boolean;
  /** Disambiguates the synthetic id when a model has more than one window. */
  idSuffix?: string;
}

/** Build a synthetic `is_default = 1` row from a spec. */
function makeRow(userId: string, s: RowSpec): AiModelPriceRow {
  return {
    id: `default:${s.provider}:${s.model}${s.idSuffix ? `:${s.idSuffix}` : ""}`,
    user_id: userId,
    provider: s.provider,
    model: s.model,
    currency: "USD",
    input_cost_per_mtok: s.input,
    cached_input_cost_per_mtok: round(s.input * 0.1),
    output_cost_per_mtok: s.output,
    reasoning_output_cost_per_mtok: s.output,
    cache_write_cost_per_mtok: s.cacheWrite ? round(s.input * 1.25) : null,
    cache_read_cost_per_mtok: s.cacheRead ? round(s.input * 0.1) : null,
    effective_from: s.from,
    effective_to: s.to,
    source_url: s.source,
    is_default: 1,
    is_enabled: 1,
    created_at: s.from,
    updated_at: s.from,
  };
}

/** The family in a derived Anthropic id (`claude-opus-4-8` → `opus`), else null. */
function anthropicFamily(model: string): string | null {
  const m = /^claude-([a-z]+)-/.exec(model);
  return m ? m[1] : null;
}

/** Date portion of an effective-from timestamp, for a unique multi-window id. */
function windowKey(from: string): string {
  return from.slice(0, 10);
}

/**
 * Resolve the shipped default price row(s) for a concrete (provider, model): one
 * per time window, or an empty array when none applies (the model stays unpriced
 * → `missing_price_count`). Anthropic resolves by family (new versions covered
 * without a code change); OpenAI resolves from the explicit per-version list.
 * The cost path pushes every returned row into the candidate set and lets
 * `selectEffectivePrice` pick the one effective on each usage day.
 */
export function resolveDefaultPrices(
  userId: string,
  provider: string,
  model: string,
): AiModelPriceRow[] {
  if (provider === "anthropic") {
    const fam = anthropicFamily(model);
    const windows = fam ? ANTHROPIC_FAMILY_RATES[fam] : undefined;
    if (!windows) return [];
    const multi = windows.length > 1;
    return windows.map((w) =>
      makeRow(userId, {
        provider,
        model,
        input: w.input,
        output: w.output,
        from: w.from,
        to: w.to,
        source: ANTHROPIC_SRC,
        cacheWrite: true,
        cacheRead: true,
        idSuffix: multi ? windowKey(w.from) : undefined,
      }),
    );
  }
  if (provider === "openai") {
    const rate = OPENAI_MODEL_RATES[model];
    if (!rate) return [];
    return [
      makeRow(userId, {
        provider,
        model,
        input: rate[0],
        output: rate[1],
        from: DEFAULT_PRICE_EFFECTIVE_FROM,
        to: null,
        source: OPENAI_SRC,
        cacheWrite: OPENAI_CACHE_WRITE_MODELS.has(model),
        cacheRead: false,
      }),
    ];
  }
  return [];
}

/**
 * Representative default rows for the price-list UI (`GET /ai/prices`). Anthropic
 * entries are family-level (`claude-opus-*`), signalling they apply to every
 * version; OpenAI entries are the explicit per-version models. A family/model
 * with more than one time window contributes one row per window. Cost estimation
 * uses {@link resolveDefaultPrices} per concrete model, so a version absent from
 * this list is still priced by its family.
 */
export function defaultPriceRows(userId: string): AiModelPriceRow[] {
  const rows: AiModelPriceRow[] = [];
  for (const [fam, windows] of Object.entries(ANTHROPIC_FAMILY_RATES)) {
    const multi = windows.length > 1;
    for (const w of windows) {
      rows.push(
        makeRow(userId, {
          provider: "anthropic",
          model: `claude-${fam}-*`,
          input: w.input,
          output: w.output,
          from: w.from,
          to: w.to,
          source: ANTHROPIC_SRC,
          cacheWrite: true,
          cacheRead: true,
          idSuffix: multi ? windowKey(w.from) : undefined,
        }),
      );
    }
  }
  for (const [model, [input, output]] of Object.entries(OPENAI_MODEL_RATES)) {
    rows.push(
      makeRow(userId, {
        provider: "openai",
        model,
        input,
        output,
        from: DEFAULT_PRICE_EFFECTIVE_FROM,
        to: null,
        source: OPENAI_SRC,
        cacheWrite: OPENAI_CACHE_WRITE_MODELS.has(model),
        cacheRead: false,
      }),
    );
  }
  return rows;
}
