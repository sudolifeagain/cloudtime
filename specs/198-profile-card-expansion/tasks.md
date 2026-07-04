# Tasks: Profile Badge and Composite Card Expansion

## PR1 - Spec + Design

- [x] T001 Create GitHub Issue #198 for the individual profile image expansion.
- [x] T002 Research official GitHub Markdown/profile README image behavior.
- [x] T003 Research official accessibility guidance for informative images and SVG image names.
- [x] T004 Research official HTTP/Cloudflare cache guidance for public image responses.
- [x] T005 Add SpecKit artifacts under `specs/198-profile-card-expansion/`.
- [x] T006 Add public badge OpenAPI operation.
- [x] T007 Extend public card OpenAPI operation with `profile`, `metrics`, and `layout`.
- [x] T008 Run `npm run generate`.
- [x] T009 Run `npm run lint:api`.
- [x] T010 Run `npm run typecheck`.
- [ ] T011 Commit PR1 in spec-first order and open a draft PR against `develop`.

## PR2 - Implementation

- [ ] T101 Add badge/profile request parsing and validation in `src/routes/cards.ts`.
- [ ] T102 Add badge/profile cache-key support in `src/utils/cards/cache.ts`.
- [ ] T103 Add data helpers for badge metrics and profile metric sections.
- [ ] T104 Add SVG renderers for `flat` and `pill` badges.
- [ ] T105 Add SVG renderer for default and compact profile composite card layouts.
- [ ] T106 Add dashboard snippets and previews for badges and profile card.
- [ ] T107 Add unit tests for badge/profile renderers.
- [ ] T108 Add unit tests for badge/profile snippets and alt text.
- [ ] T109 Add integration tests for public badge routes.
- [ ] T110 Add integration tests for `cards/profile.svg`.
- [ ] T111 Add privacy tests proving disabled embeds return `404` before cache hits.
- [ ] T112 Update deployment guide with badge/profile card usage.
- [ ] T113 Run `npm run typecheck && npm test`.
