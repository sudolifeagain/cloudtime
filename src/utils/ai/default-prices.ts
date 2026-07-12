/**
 * Shipped default AI model prices (Issue #200 follow-up). A code-maintained
 * catalog of API-equivalent list rates so a fresh CloudTime instance estimates
 * cost out of the box, before an owner configures anything. Values are per
 * 1,000,000 tokens in USD.
 *
 * Design: resolve prices by the *shape* of a model id rather than pinning every
 * version, so a steady stream of new models does not go stale immediately.
 *   - **Anthropic** prices are flat within a family generation (every
 *     `claude-opus-*` is $5/$25, `claude-sonnet-*` $3/$15, …), so a default is
 *     resolved from the family — a future `claude-opus-4-9` is priced with no
 *     code change.
 *   - **OpenAI** prices per version with no flat family rate, so its models are
 *     listed explicitly. An OpenAI model not in the list resolves to `null`.
 * An unresolved model stays unpriced and surfaces in `missing_price_count`
 * (never a silent zero); the owner can add a row for it.
 *
 * Defaults materialize as read-only `is_default = 1` rows merged into price
 * reads, not stored in D1 — nothing to seed or migrate. `selectEffectivePrice`
 * ranks any owner row ahead of a default, so overrides win; the synthetic
 * `default:<provider>:<model>` ids never exist in D1, so the single-row price
 * endpoints 404 on them (id existence is not leaked). Model ids match what
 * `deriveAiIdentity` produces (`opus/4-8` → `claude-opus-4-8`).
 *
 * Rate conventions: `cached_input` (cache-hit input) = 0.1× input; `reasoning_output`
 * is billed at the output rate; Anthropic also sets `cache_write` = 1.25× input
 * (5-minute write) and `cache_read` = 0.1× input, which OpenAI leaves null (it
 * reports cache reads as `cached_input`). Unused token classes never affect a
 * bucket, so over-specifying a rate is harmless.
 */
import type { AiModelPriceRow } from "./pricing";

/** Effective-from for every shipped default: a broad past window, open-ended. */
export const DEFAULT_PRICE_EFFECTIVE_FROM = "2020-01-01 00:00:00";

const ANTHROPIC_SRC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_SRC = "https://developers.openai.com/api/docs/pricing";

/**
 * Anthropic family → [input, output] per-MTok USD. Flat within a family
 * generation, so any version resolves from its family (verified 2026-07).
 */
const ANTHROPIC_FAMILY_RATES: Record<string, readonly [number, number]> = {
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
  fable: [10, 50],
  mythos: [10, 50],
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

/** Avoid binary-float noise in derived rates (e.g. 1.25 * 0.1). */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Build a synthetic `is_default = 1` row for one (provider, model). */
function makeRow(
  userId: string,
  provider: string,
  model: string,
  input: number,
  output: number,
  source: string,
  anthropicCache: boolean,
): AiModelPriceRow {
  const ts = DEFAULT_PRICE_EFFECTIVE_FROM;
  return {
    id: `default:${provider}:${model}`,
    user_id: userId,
    provider,
    model,
    currency: "USD",
    input_cost_per_mtok: input,
    cached_input_cost_per_mtok: round(input * 0.1),
    output_cost_per_mtok: output,
    reasoning_output_cost_per_mtok: output,
    cache_write_cost_per_mtok: anthropicCache ? round(input * 1.25) : null,
    cache_read_cost_per_mtok: anthropicCache ? round(input * 0.1) : null,
    effective_from: ts,
    effective_to: null,
    source_url: source,
    is_default: 1,
    is_enabled: 1,
    created_at: ts,
    updated_at: ts,
  };
}

/** The family in a derived Anthropic id (`claude-opus-4-8` → `opus`), else null. */
function anthropicFamily(model: string): string | null {
  const m = /^claude-([a-z]+)-/.exec(model);
  return m ? m[1] : null;
}

/**
 * Resolve the shipped default price for a concrete (provider, model), or null
 * when none applies (the model stays unpriced → `missing_price_count`). Anthropic
 * resolves by family (new versions covered without a code change); OpenAI resolves
 * from the explicit per-version list. Used by cost estimation for exactly the
 * models that appear in a usage summary.
 */
export function resolveDefaultPrice(
  userId: string,
  provider: string,
  model: string,
): AiModelPriceRow | null {
  if (provider === "anthropic") {
    const fam = anthropicFamily(model);
    const rate = fam ? ANTHROPIC_FAMILY_RATES[fam] : undefined;
    return rate ? makeRow(userId, provider, model, rate[0], rate[1], ANTHROPIC_SRC, true) : null;
  }
  if (provider === "openai") {
    const rate = OPENAI_MODEL_RATES[model];
    return rate ? makeRow(userId, provider, model, rate[0], rate[1], OPENAI_SRC, false) : null;
  }
  return null;
}

/**
 * Representative default rows for the price-list UI (`GET /ai/prices`). Anthropic
 * entries are family-level (`claude-opus-*`), signalling they apply to every
 * version; OpenAI entries are the explicit per-version models. Cost estimation
 * uses {@link resolveDefaultPrice} per concrete model, so a version absent from
 * this list is still priced by its family.
 */
export function defaultPriceRows(userId: string): AiModelPriceRow[] {
  const rows: AiModelPriceRow[] = [];
  for (const [fam, [input, output]] of Object.entries(ANTHROPIC_FAMILY_RATES)) {
    rows.push(makeRow(userId, "anthropic", `claude-${fam}-*`, input, output, ANTHROPIC_SRC, true));
  }
  for (const [model, [input, output]] of Object.entries(OPENAI_MODEL_RATES)) {
    rows.push(makeRow(userId, "openai", model, input, output, OPENAI_SRC, false));
  }
  return rows;
}
