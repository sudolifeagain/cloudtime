/**
 * AI coding model-attribution detection (Issue #201, US1/US2). Pure: no D1, no I/O.
 *
 * Some AI clients send `ai coding` heartbeats that identify the provider but not
 * the active model, so the rollup buckets them as `<provider>` / `"unknown"`
 * (see `src/cron/aggregate.ts`, which coalesces a null `ai_model` to `"unknown"`).
 * Those buckets cannot be priced and are surfaced to the owner as an actionable
 * setup step in the dashboard (`src/ui/dashboard.tsx`).
 *
 * This module derives that state from the `AIUsageSummary` the dashboard already
 * computes (`buildUsageSummary` → `by_model`) — no extra query, no stored state.
 * It only *reads* the summary; pricing, aggregation, and ingestion are untouched.
 *
 * The canonical instructions live in the repository docs (CloudTime does not serve
 * its docs as web pages), so the guidance links to their public URLs.
 */
import type { components } from "../../types/generated";

type AIUsageSummary = components["schemas"]["AIUsageSummary"];

/** The rollup's sentinel for a heartbeat whose model could not be derived. */
const UNKNOWN = "unknown";

/** Public, canonical instructions (the repo is the docs' canonical home). */
const CODEX_DOC_URL =
  "https://github.com/sudolifeagain/cloudtime/blob/develop/docs/codex-model-attribution.md";
const GENERIC_DOC_URL =
  "https://github.com/sudolifeagain/cloudtime/blob/develop/docs/ai-usage.md#deriving-provider-and-model-from-the-user-agent";

/**
 * Provider-specific ("tailored") guidance. A provider listed here has a concrete
 * one-time client-side fix; a provider absent here gets generic troubleshooting
 * with no command (FR-009). Keyed by the `ai_provider` value the rollup stores.
 */
const TAILORED_GUIDANCE: Record<string, { tool: string; command: string; docUrl: string }> = {
  openai: {
    tool: "Codex",
    command: "node scripts/patch-codex-wakatime.mjs",
    docUrl: CODEX_DOC_URL,
  },
};

/** One provider whose recent usage is model-unknown, plus the guidance to show. */
export interface UnattributedTool {
  /** The known provider (e.g. `"openai"`); never `"unknown"`. */
  provider: string;
  /** Human tool name for copy (e.g. `"Codex"`); the provider itself when unmapped. */
  tool: string;
  /** Recent heartbeats (in the summary window) attributed to this provider but no model. */
  heartbeatCount: number;
  /** Whether a provider-specific command exists (else generic troubleshooting only). */
  hasTailoredGuidance: boolean;
  /** Exact one-time local command for tailored providers, else `null`. */
  command: string | null;
  /** Canonical public instructions URL. */
  docUrl: string;
}

/** Derived attribution state for the dashboard. Not persisted. */
export interface AttributionStatus {
  hasUnattributed: boolean;
  affected: UnattributedTool[];
}

/**
 * Detect providers whose recent usage is "provider-known, model-unknown", folded
 * to one entry per provider and sorted by provider for a stable render.
 *
 * A `by_model` group is affected when `provider !== "unknown"` (the tool is
 * identifiable) AND `model === "unknown"` (its model is not) AND `heartbeat_count > 0`.
 * A group whose provider is itself `"unknown"` is skipped: with no identifiable
 * tool there is nothing actionable to guide.
 *
 * Pure and windowed by construction — it reflects only the summary it is given, so
 * a fixed pile of out-of-window historical unknowns stops surfacing once it ages
 * out of that summary (FR-006/FR-007). Multiple same-provider groups fold and their
 * counts sum.
 */
export function detectUnattributedTools(summary: AIUsageSummary): AttributionStatus {
  const counts = new Map<string, number>();
  for (const group of summary.by_model) {
    if (group.provider === UNKNOWN || group.model !== UNKNOWN || group.heartbeat_count <= 0) {
      continue;
    }
    counts.set(group.provider, (counts.get(group.provider) ?? 0) + group.heartbeat_count);
  }

  const affected: UnattributedTool[] = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([provider, heartbeatCount]) => {
      const tailored = TAILORED_GUIDANCE[provider];
      if (tailored) {
        return {
          provider,
          tool: tailored.tool,
          heartbeatCount,
          hasTailoredGuidance: true,
          command: tailored.command,
          docUrl: tailored.docUrl,
        };
      }
      return {
        provider,
        tool: provider,
        heartbeatCount,
        hasTailoredGuidance: false,
        command: null,
        docUrl: GENERIC_DOC_URL,
      };
    });

  return { hasUnattributed: affected.length > 0, affected };
}
