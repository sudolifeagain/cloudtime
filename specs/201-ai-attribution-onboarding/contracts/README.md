# Contracts: AI Coding Model Attribution Onboarding

## MVP (P1/P2): no new API contract

This feature ships **no new or changed API endpoint** and therefore **no change to
`schemas/openapi.yaml` or `src/types/generated.ts`**. The guidance is rendered
server-side into the existing owner dashboard HTML from the `AIUsageSummary` the
page already computes. There is nothing to add under `contracts/` for the MVP.

Per the Constitution's SDD principle, "spec-first" applies to API/contract changes;
because the MVP introduces none, PR2 (implementation) carries no OpenAPI or
generated-types delta. This is intentional and allowed.

### The effective "UI contract" (validated in quickstart.md, not OpenAPI)

The owner dashboard `GET /app` render MUST behave as:

- **Shown** when the AI usage summary (recent window) has any `by_model` group with
  `provider !== "unknown"` and `model === "unknown"` and `heartbeat_count > 0`.
  For `provider === "openai"`, it includes the Codex cause, exact local command,
  and canonical public URL
  `https://github.com/sudolifeagain/cloudtime/blob/develop/docs/codex-model-attribution.md`.
  For an unmapped provider, it includes generic attribution troubleshooting and
  canonical public URL
  `https://github.com/sudolifeagain/cloudtime/blob/develop/docs/ai-usage.md#deriving-provider-and-model-from-the-user-agent`, but no command.
- **Hidden** when no such group exists in the window — including Claude-Code-only
  usage and cases where only out-of-window historical unknowns exist.
- **Never** contains a secret, credential, or raw client configuration value.
- **Never** presents the Codex command or Codex documentation link for an
  unmapped provider.

These behaviors are the acceptance surface and are exercised by the integration
test described in `quickstart.md`.

## Future (out of MVP): would add contracts, spec-first

- **`attribution_status` on `GET /ai/usage`** — only if a non-dashboard client
  needs the signal. Additive, optional field → its own spec-first PR.
- **Persisted dismissal endpoint** — if "don't show again" is built. New endpoint
  + owner-scoped storage → its own spec-first PR (see data-model.md).
