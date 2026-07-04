# Implementation Plan: Profile Badge and Composite Card Expansion

**Branch**: `198-profile-card-expansion` | **Date**: 2026-07-05 | **Spec**: [spec.md](./spec.md)
**Input**: GitHub Issue #198

## Summary

Extend CloudTime's public image surface for individual users with focused SVG
badges and one composite `profile` card. Badges live at
`GET /users/{username}/badges/{badge_type}.svg`; the composite card extends the
existing public card route with `card_type=profile`. Both surfaces reuse the
existing embed visibility/freshness model, public non-secret URLs, explicit
cache headers, and original CloudTime visual language.

**PR1 (this PR)**: SpecKit artifacts, OpenAPI path/parameter changes, and
regenerated types. **No route handlers, renderers, migrations, UI changes, or
docs behavior changes.**

**PR2 (after PR1 merges)**: badge/profile data builders, SVG renderers, cache
keys, route wiring, dashboard snippets, and tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing generated OpenAPI types;
existing D1/KV bindings. No new dependency is planned for fixed SVG badges or
the composite card.
**Storage**: no new tables in PR1. PR2 should reuse `embed_settings`, `goals`,
`summaries`, and bounded current-day heartbeat reads. KV cache entries should be
separate for badges and profile cards.
**Testing**: Vitest + workers pool. PR2 should cover public visibility,
invalid query parameters, cache headers, badge fallback/default behavior,
accessible SVG names, snippet secrecy, and cross-user isolation.
**Performance Goals**: Public image cache hits return from KV. Cache misses read
pre-aggregated summaries and bounded current-day data only. Disabled embeds
return before cache lookup or data reads.
**Constraints**: GitHub profile README images are public remote images; snippets
must use standard Markdown image syntax with meaningful alt text and no
credentials. SVG images must be accessible and static. Public image cache
semantics should remain explicit with `Cache-Control` and `ETag`.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | PR1 updates OpenAPI before implementation and regenerates types. |
| II. Cloudflare-Native | PASS | PR2 reuses KV/D1 and bounded aggregate reads; no server-side image dependency. |
| III. Type Safety | PASS | New contracts are generated from OpenAPI. |
| IV. Legal/Trademark | PASS | Designs, labels, and docs are CloudTime-original; research uses official public docs only. |
| V. Simplicity First | PASS | Four badge types plus one composite card; team features and integrations deferred. |

## Project Structure

### Documentation (this feature)

```text
specs/198-profile-card-expansion/
|-- plan.md
|-- spec.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- tasks.md
|-- contracts/
|   `-- openapi-diff.md
`-- checklists/
    `-- requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/openapi.yaml                    # CHANGE: add public badge path ref
schemas/paths/cards/public-card.yaml    # CHANGE: add profile card type and params
schemas/paths/cards/public-badge.yaml   # ADD: public SVG badge operation
src/types/generated.ts                  # REGENERATED

# PR2 (after PR1 merges)
src/routes/cards.ts                     # CHANGE: badge route + profile card branch
src/utils/cards/data.ts                 # CHANGE: badge/profile metric data helpers
src/utils/cards/render.ts               # CHANGE: badge/profile SVG renderers
src/utils/cards/cache.ts                # CHANGE: badge/profile cache keys
src/utils/cards/snippets.ts             # CHANGE: Markdown snippets for new images
src/ui/settings.tsx                     # CHANGE: settings snippets/previews
tests/unit/cards-render.test.ts         # CHANGE: renderer tests
tests/unit/cards-snippets.test.ts       # CHANGE: snippet tests
tests/integration/embeddable-cards.test.ts # CHANGE: route/privacy/cache tests
docs/deployment-guide.md                # CHANGE: operator/user usage docs
```

**Structure Decision**: Add badges as a new public route rather than overloading
the card route. Add `profile` as a new `card_type` because it is visually and
semantically a card, not a one-metric badge. Reuse one route module in PR2 so
visibility, rate-limit, cache, and username lookup behavior remain shared.

## Phases

- **PR1 - Spec + Design**: create this SpecKit set; update OpenAPI contract;
  run `npm run generate`; run `npm run lint:api` and `npm run typecheck`;
  open a draft PR against `develop`.
- **PR2 - Implementation**: add route/render/data/cache/snippet logic and tests;
  update user docs; run `npm run typecheck && npm test`; open PR referencing
  #198 and PR1.

## Risks & Mitigations

- **Secret leakage in snippets** -> snippets are built only from public username
  and app base URL; tests assert no API/session/OAuth token appears.
- **Private profile probed through cache** -> disabled embeds return `404`
  before cache lookup, matching existing card privacy behavior.
- **Badge/card cache keys collide** -> PR2 uses route kind, username, metric,
  normalized query options, template/theme, and freshness window in cache keys.
- **Metrics query becomes too flexible** -> PR1 limits metric names and item
  count; invalid names and duplicates are `400`.
- **GitHub proxy freshness differs from CloudTime TTL** -> keep
  `Cache-Control`, `ETag`, and `v` cache-busting behavior in the contract.
- **Accessible image names drift from Markdown alt text** -> renderer and
  snippet tests assert meaningful names for badges and profile cards.
- **All-time reads become expensive** -> PR2 may compute from summaries and
  cache aggressively; no raw full-history scan is required by the contract.
