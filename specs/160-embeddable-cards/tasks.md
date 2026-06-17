# Tasks: Embeddable Stat Cards

**Input**: Design documents from `/specs/160-embeddable-cards/`

**Organization**: PR1 is complete in this branch. PR2 tasks are grouped by
priority so the P1 heatmap + visibility switch can ship independently before
P2/P3.

## Phase 1: PR1 - Spec + Contract

- [x] T001 Update `specs/160-embeddable-cards/spec.md` with cache, visibility, and SVG-template safety requirements.
- [x] T002 Add `specs/160-embeddable-cards/research.md` documenting GitHub image embeds/Camo cache, Cloudflare cache behavior, SVG safety, and OpenAPI media-type decisions.
- [x] T003 Add `specs/160-embeddable-cards/data-model.md` for embed settings, templates, and rendered-card cache entries.
- [x] T004 Add `specs/160-embeddable-cards/quickstart.md` for PR2 manual validation.
- [x] T005 Add `specs/160-embeddable-cards/contracts/openapi-diff.md`.
- [x] T006 Update OpenAPI paths/components for public SVG cards, embed settings, and template CRUD.
- [ ] T007 Run `npm run generate` and commit regenerated `src/types/generated.ts`.
- [ ] T008 Run `npm run lint:api` and `npm run typecheck`.

---

## Phase 2: PR2 - Foundational

- [ ] T101 Add `embed_settings` and `embed_templates` D1 tables to `src/db/schema.sql`, including `user_id` on every new table and indexes from `data-model.md`.
- [ ] T102 Add optional `RATE_LIMIT_EMBED_CARDS?: RateLimit` to `src/types.ts` and `tests/env.d.ts`.
- [ ] T103 Add a commented `[[ratelimits]]` block for `RATE_LIMIT_EMBED_CARDS` to `wrangler.toml`, continuing the namespace-id sequence.
- [ ] T104 Create `src/routes/cards.ts` and mount public/authenticated card routes in `src/index.ts`.
- [ ] T105 Add `src/utils/cards/cache.ts` for normalized cache keys, ETag generation, and `Cache-Control` policy.
- [ ] T106 Add `src/utils/cards/data.ts` for aggregate reads and current-day overlay using existing timezone/timeout helpers.
- [ ] T107 Add `src/utils/cards/render.ts` for built-in heatmap, summary, and languages SVG renderers.
- [ ] T108 Add `src/utils/cards/templates.ts` for placeholder substitution and safe SVG validation.

**Checkpoint**: Storage, route mount, cache policy, data builders, renderers, and validators exist before user-story behavior lands.

---

## Phase 3: User Story 1 - Public heatmap + visibility (P1 MVP)

**Goal**: A user can enable public embeds and serve a current heatmap SVG; when
disabled, every card URL returns `404` before cache/data access.

**Independent Test**: Toggle OFF/ON, request
`/api/v1/users/{username}/cards/heatmap.svg`, and verify OFF `404`, ON SVG,
cache headers, no secret URL, current-day overlay, and zero-activity SVG.

- [ ] T201 [P] Add integration tests in `tests/integration/embeddable-cards.test.ts` for default OFF, explicit OFF with warm cache, ON heatmap SVG, no API key in URL/body, and `Cache-Control`/`ETag` headers.
- [ ] T202 [P] Add unit tests in `tests/unit/cards-render.test.ts` for heatmap SVG shape, escaping, and zero-activity rendering.
- [ ] T203 Implement authenticated `GET/PATCH /users/current/embed_settings` using generated `EmbedSettings` types.
- [ ] T204 Implement public username lookup and OFF `404` gate before rate-limit/cache/data work.
- [ ] T205 Implement heatmap aggregate read + current-day overlay.
- [ ] T206 Implement heatmap SVG rendering and KV cache write/read.
- [ ] T207 Wire optional `RATE_LIMIT_EMBED_CARDS` on public card requests after the OFF gate and before cache misses.

**Checkpoint**: P1 is independently usable and safe to demo.

---

## Phase 4: User Stories 3-5 - Summary, languages, themes (P2)

**Goal**: Summary and top-language cards render from the same foundation, with
styling-only theme selection and fallback.

**Independent Test**: Request summary/languages cards for ranges and verify
values match existing stats aggregates; invalid theme falls back to default.

- [ ] T301 [P] Add integration tests for `summary.svg` and `languages.svg` ranges, unsupported range fallback, invalid card type `404`, and theme fallback.
- [ ] T302 [P] Add renderer unit tests for built-in themes and SVG escaping.
- [ ] T303 Implement summary-card data builder and renderer.
- [ ] T304 Implement languages-card data builder and renderer.
- [ ] T305 Implement theme normalization and default-theme fallback across all card types.

**Checkpoint**: P1 and P2 card types share settings, cache, and visibility behavior.

---

## Phase 5: User Story 6 - Custom templates (P3)

**Goal**: A user can store a safe SVG template with placeholders and render a
card through that template.

**Independent Test**: Valid template placeholders are substituted; unsafe or
unknown-placeholder templates return `400` and are never rendered.

- [ ] T401 [P] Add integration tests for template list/create/get/patch/delete, user scoping, 404 cross-user access, and validation failures.
- [ ] T402 [P] Add unit tests for safe SVG validation: script, event handler, `foreignObject`, external href, remote font, data URL, processing instruction, malformed SVG, oversized input, and unknown placeholder.
- [ ] T403 Implement authenticated template CRUD with generated `EmbedTemplate` types.
- [ ] T404 Implement placeholder substitution with XML/text escaping.
- [ ] T405 Implement template-backed rendering on public card requests with template revalidation before render.

**Checkpoint**: P3 customization works without weakening public-route safety.

---

## Phase 6: Docs and Validation

- [ ] T501 Update `docs/deployment-guide.md` with embed visibility, freshness, and force-refresh guidance.
- [ ] T502 Update `docs/cloudflare-constraints.md` with public card cache/rate-limit behavior.
- [ ] T503 Run `npm run generate` if PR2 changes OpenAPI further, then `npm run lint:api`.
- [ ] T504 Run `npm run typecheck && npm test`.
- [ ] T505 Open PR2 targeting `develop`, referencing PR1 and noting that embeds default OFF.

## Dependencies

- T101-T108 block all user-story implementation.
- P1 (T201-T207) must land before P2 and P3 because it establishes public
  visibility, cache, and renderer foundations.
- P2 can proceed after P1.
- P3 can proceed after P1 and can run in parallel with P2 only if template
  routing does not change shared renderer interfaces.
