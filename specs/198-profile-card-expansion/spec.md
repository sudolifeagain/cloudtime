# Feature Specification: Profile Badge and Composite Card Expansion

**Feature Branch**: `198-profile-card-expansion`
**Created**: 2026-07-05
**Status**: Draft
**Input**: GitHub Issue #198

## User Stories & Testing

### User Story 1 - Add focused profile badges (Priority: P1)

As a CloudTime owner, I want small SVG badges for focused metrics so that my
GitHub profile README can show concise, continuously updated coding activity
without exposing credentials.

**Why this priority**: Badges are the fastest visible improvement for personal
profile customization. They reuse existing public embed controls and require no
team or external integration work.

**Independent Test**: With public embeds enabled, request each badge URL and
verify it returns `200 image/svg+xml`, includes public cache headers, contains a
non-empty accessible image name, and never includes API keys or session data.

**Acceptance Scenarios**:

1. Given public embeds are enabled, when a user requests
   `/api/v1/users/alice/badges/coding_time.svg?range=today`, then the response
   is an SVG badge showing today's CloudTime coding time.
2. Given public embeds are enabled and the user has language data, when
   `/badges/top_language.svg?range=last_7_days` is requested, then the badge
   shows the top language for that range.
3. Given public embeds are enabled and the user has an enabled goal, when
   `/badges/goal_progress.svg` is requested without `goal_id`, then the badge
   uses the first enabled, non-snoozed goal ordered by creation time.
4. Given public embeds are disabled, when any badge URL is requested, then the
   response is `404`, no cached image is served, and no private stats are
   disclosed.

---

### User Story 2 - Add one composite profile card (Priority: P1)

As a CloudTime owner, I want one composite profile card that combines several
personal metrics so that my README can show a compact dashboard with a single
image URL.

**Why this priority**: A composite image reduces README clutter and lets users
show richer personal analytics without relying on multiple images or team
features.

**Independent Test**: Request
`/api/v1/users/alice/cards/profile.svg?metrics=today,week,top_language,current_streak`
and verify that the SVG contains exactly those sections in the requested order,
uses original CloudTime copy, has a non-empty accessible image name, and shares
the existing public-card visibility/cache behavior.

**Acceptance Scenarios**:

1. Given public embeds are enabled, when a user requests `cards/profile.svg`
   without a `metrics` query, then the response uses the default metric set.
2. Given a valid comma-separated `metrics` query, when the composite profile
   card is requested, then the response includes the requested metrics in order.
3. Given an unknown or duplicate metric name, when the composite profile card is
   requested, then the response is `400`.
4. Given `layout=compact`, when the composite profile card is requested, then
   the response uses the compact layout contract while preserving the same data
   privacy and cache semantics.

---

### User Story 3 - Generate safe Markdown snippets (Priority: P2)

As a CloudTime owner, I want copyable Markdown snippets for badges and the
profile card so that I can paste them into my profile README without manually
building URLs.

**Why this priority**: Snippets prevent credential leaks and keep alt text
consistent with accessibility guidance.

**Independent Test**: In the authenticated dashboard, copy snippets for all new
badges and the composite card; verify every snippet uses a public URL, has
meaningful alt text, and contains no API key, session token, OAuth token, or
secret query parameter.

**Acceptance Scenarios**:

1. Given public embeds are enabled, when the settings page renders snippets,
   then it includes badge snippets and the composite profile card snippet.
2. Given public embeds are disabled, when the settings page renders snippets,
   then it keeps the existing disabled-warning behavior and does not imply that
   private stats are public.

## Requirements

### Functional Requirements

- **FR-001**: The API MUST add an unauthenticated public badge endpoint:
  `GET /api/v1/users/{username}/badges/{badge_type}.svg`.
- **FR-002**: `badge_type` MUST initially support `coding_time`,
  `top_language`, `current_streak`, and `goal_progress`.
- **FR-003**: Badge URLs MUST NOT require or accept API keys, session tokens,
  OAuth tokens, or other secrets.
- **FR-004**: Badge rendering MUST respect the existing per-user embed
  visibility setting; disabled or missing users MUST return `404`.
- **FR-005**: Badge responses MUST be `image/svg+xml` and include
  `Cache-Control` and `ETag` headers derived from the user's freshness window.
- **FR-006**: Badge URLs MUST support `theme`, `style`, `label`, `range`,
  `goal_id`, and `v` query parameters as documented in OpenAPI.
- **FR-007**: Unsupported enum values, invalid UUIDs, overlong labels, and
  otherwise invalid badge query parameters MUST return `400`.
- **FR-008**: The existing public card endpoint MUST add `profile` to
  `card_type`.
- **FR-009**: `profile` card URLs MUST support optional `metrics` and `layout`
  query parameters.
- **FR-010**: The default profile metric set MUST include personal metrics only:
  today's coding time, trailing-week coding time, top language, and current
  streak.
- **FR-011**: Supported profile metric names MUST be `today`, `week`,
  `all_time`, `top_language`, `current_streak`, and `goal_progress`.
- **FR-012**: Duplicate, unknown, empty, or unsupported `metrics` entries MUST
  return `400`.
- **FR-013**: Composite profile cards MUST preserve the existing public-card
  cache, visibility, template, and cache-busting semantics.
- **FR-014**: SVG badge and profile card output MUST include `role="img"` and a
  non-empty accessible name describing the metric or metric set.
- **FR-015**: Dashboard snippets MUST use meaningful Markdown alt text and MUST
  never include credentials.
- **FR-016**: Badge and profile card visuals, labels, and docs MUST be original
  CloudTime work and follow `docs/implementation-boundaries.md`.
- **FR-017**: PR1 MUST include only SpecKit artifacts, OpenAPI changes, and
  regenerated OpenAPI types. It MUST NOT include route handlers, renderers, UI
  code, DB migrations, or docs behavior changes.

### Entities

- **Profile Badge**: A small public SVG image for one CloudTime metric.
- **Profile Composite Card**: A larger public SVG image combining multiple
  CloudTime metrics in a requested or default order.
- **Profile Metric**: A named metric section used by the composite card.
- **Public Embed Settings**: Existing per-user settings controlling whether
  public image endpoints may reveal stats and how long rendered images remain
  fresh.

## Success Criteria

- **SC-001**: A user can embed at least four new public badge URLs in a GitHub
  profile README using standard Markdown image syntax.
- **SC-002**: A user can embed one composite profile card URL that replaces
  several separate image URLs.
- **SC-003**: Disabled public embeds always return `404` for badges and the
  profile card before serving cache hits.
- **SC-004**: All generated snippets contain meaningful alt text and no secrets.
- **SC-005**: The OpenAPI contract generates TypeScript types without manual
  edits.

## Assumptions

- Existing `embed_settings` controls public visibility for cards and badges.
- Badge/profile image data is derived from CloudTime summaries, goals, and
  bounded current-day heartbeat overlays.
- Goal progress badge behavior is owner-scoped; selecting the first enabled,
  non-snoozed goal is deterministic and avoids adding a new setting in PR1.
- All-time values may read aggregate summaries directly in PR2; if that is too
  expensive, PR2 may introduce a bounded cache or reuse existing all-time
  helpers without changing the public contract.

## Out of Scope

- Team dashboards, private leaderboards, organizations, SSO, SCIM, or other
  multi-user features.
- Third-party visual designs, logos, screenshots, source code, or product copy.
- New billing, invoice, or email report functionality.
- Implementation code in PR1.
