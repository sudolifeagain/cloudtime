# Implementation Plan: Embeddable Stat Cards

**Branch**: `spec/160-embeddable-cards` | **Date**: 2026-06-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/160-embeddable-cards/spec.md`

## Summary

Add a public, read-only SVG card surface for CloudTime stats, plus
authenticated settings and template-management endpoints. Public cards are
addressed by a non-secret username and card type, respect an explicit per-user
embed visibility switch that defaults OFF, and are cacheable with a short
operator-configurable freshness window. The first implementation renders SVG
from aggregated summaries with a current-day overlay, so a GitHub README image
can stay current without commits or scheduled repository jobs.

**PR1 (this PR)**: SpecKit artifacts + OpenAPI paths/components for the public
SVG card endpoint, embed settings, and custom template CRUD + regenerated
types. **No route handlers, migrations, bindings, or docs-behavior changes.**

**PR2 (after PR1 merges)**: D1 schema, Hono routes, render/cache helpers,
SVG-template validation, rate-limit binding, integration tests, and operator
docs.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing D1/KV bindings; existing
generated OpenAPI types. No new rendering dependency is planned for P1/P2; P3
template validation may add a small XML/SVG parser only if an allowlist parser
cannot be implemented safely with platform APIs.
**Storage**: D1 for per-user embed settings and custom templates; KV for
short-lived rendered-card cache entries. Existing `summaries` and
`hourly_summaries` remain the source of aggregate data. Raw heartbeats are read
only for the current-day overlay within a bounded local-day window.
**Testing**: Vitest + workers pool. Contract/integration tests cover public
card visibility, no-auth/no-secret URLs, cache headers, invalid parameters,
theme fallback, current-day overlay, zero-activity SVG, and unsafe template
rejection.
**Performance Goals**: Public card hit path returns from KV; cache misses stay
within the Workers 10 ms CPU budget by reading pre-aggregates and at most the
current local day of heartbeats. Popular embeds must not trigger one D1 render
per view.
**Constraints**: Visibility OFF returns `404` before cache lookup or data reads;
public card routes are `security: []` and never accept API keys; SVG output must
not contain user-supplied active content; cache-busting query values only affect
cache keys, never authorization or data selection.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | PR1 updates OpenAPI before implementation and regenerates `src/types/generated.ts`; PR2 will use generated route types. |
| II. Cloudflare-Native | PASS | Public rendering is cache-first in KV and reads pre-aggregates on miss; current-day work is bounded. OFF path performs no cache/D1 work. |
| III. Type Safety | PASS | All new endpoint and schema shapes are generated from `schemas/openapi.yaml`; no hand-edits to generated types. |
| IV. Legal/Trademark | PASS | The feature is original; references are limited to "WakaTime-compatible" docs wording and no WakaTime source or assets are consulted. |
| V. Simplicity First | PASS | Three fixed card types, styling-only built-in themes, one settings resource, and template customization deferred to P3. |

## Project Structure

### Documentation (this feature)

```text
specs/160-embeddable-cards/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/openapi.yaml                         # CHANGE: embeddable_cards tag and path refs
schemas/paths/cards/public-card.yaml         # ADD: unauthenticated SVG card operation
schemas/paths/cards/embed-settings.yaml      # ADD: authenticated settings get/patch
schemas/paths/cards/embed-templates.yaml     # ADD: authenticated template list/create
schemas/paths/cards/embed-template.yaml      # ADD: authenticated template get/patch/delete
schemas/components/schemas/EmbedSettings.yaml
schemas/components/schemas/EmbedSettingsUpdate.yaml
schemas/components/schemas/EmbedTemplate.yaml
schemas/components/schemas/EmbedTemplateInput.yaml
src/types/generated.ts                       # REGENERATED

# PR2 (after PR1 merges)
src/db/schema.sql                            # CHANGE: embed_settings, embed_templates
src/types.ts                                 # CHANGE: optional RATE_LIMIT_EMBED_CARDS binding if configured
src/index.ts                                 # CHANGE: mount public/authenticated card routes
src/routes/cards.ts                          # ADD: public SVG + settings/templates handlers
src/utils/cards/cache.ts                     # ADD: normalized cache keys and TTL policy
src/utils/cards/data.ts                      # ADD: aggregate reads + current-day overlay
src/utils/cards/render.ts                    # ADD: built-in SVG renderers
src/utils/cards/templates.ts                 # ADD: placeholder substitution + safe SVG validation
tests/integration/embeddable-cards.test.ts   # ADD: route and privacy contract tests
tests/unit/cards-render.test.ts              # ADD: renderer/template unit tests
docs/deployment-guide.md                     # CHANGE: embed privacy and freshness settings
docs/cloudflare-constraints.md               # CHANGE: cache/rate-limit notes for public card traffic
wrangler.toml                                # CHANGE: commented RATE_LIMIT_EMBED_CARDS block
```

**Structure Decision**: Use one `src/routes/cards.ts` sub-app mounted in two
places: a public route under `/api/v1/users/{username}/cards/{card_type}.svg`
with `security: []`, and authenticated management routes under
`/api/v1/users/current`. The public handler begins with username/settings
lookup and the OFF gate, then rate limiting, then KV cache, then bounded D1
reads/rendering. Template upload is authenticated and validates/rejects unsafe
SVG at write time so public rendering never evaluates untrusted active content.

## Phases

- **PR1 - Spec + Design (this PR)**: complete SpecKit artifacts; add OpenAPI
  contract; run `npm run generate`; run API lint/typecheck.
- **PR2 - Implementation**: add storage, routes, renderer/cache helpers,
  template validation, tests, and docs; run `npm run typecheck && npm test`;
  open PR targeting `develop` referencing PR1.

## Risks & Mitigations

- **GitHub image proxy keeps a stale image longer than CloudTime's TTL** -> send
  explicit `Cache-Control`/`ETag`, document the configured freshness as the
  server guarantee, and provide `v` cache-busting for immediate refresh.
- **Embeds accidentally leak private stats** -> default OFF, `404` before cache
  lookup or data reads, no API-key query parameters, integration tests for OFF
  with a warm cache.
- **Popular README causes per-view D1 work** -> KV-rendered SVG cache keyed by
  normalized card options and freshness window; rate-limit binding for misses
  and abusive clients.
- **Unsafe user SVG executes when opened directly** -> reject unsafe constructs
  at template write time and revalidate before render; never rely only on image
  context restrictions.
- **Current-day overlay scans too much raw heartbeat data** -> limit overlay to
  the target user's current local day and reuse existing timeout/date helpers;
  if the bounded query exceeds budget, fall back to the latest aggregate and
  mark the renderer as pending in PR2 tests.
