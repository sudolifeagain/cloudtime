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
  `provider !== "unknown"` and `model === "unknown"` and `heartbeat_count > 0`:
  a guided step with cause, the exact local command, and a link to
  `docs/codex-model-attribution.md`.
- **Hidden** when no such group exists in the window — including Claude-Code-only
  usage and cases where only out-of-window historical unknowns exist.
- **Never** contains a secret, credential, or raw client configuration value.

These behaviors are the acceptance surface and are exercised by the integration
test described in `quickstart.md`.

## Future (out of MVP): would add contracts, spec-first

- **`attribution_status` on `GET /ai/usage`** — only if a non-dashboard client
  needs the signal. Additive, optional field → its own spec-first PR.
- **Persisted dismissal endpoint** — if "don't show again" is built. New endpoint
  + owner-scoped storage → its own spec-first PR (see data-model.md).
