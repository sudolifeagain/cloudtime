# Feature Specification: Embeddable Stat Cards

**Feature Branch**: `spec/160-embeddable-cards`

**Created**: 2026-06-18

**Status**: Draft

**Input**: User description: "Embeddable stat cards — continuously-updated dynamic image cards that a user embeds in their GitHub profile README (and other sites), inspired by WakaTime-compatible embeddable charts. Card types: coding-time heatmap, stats summary, top-languages. Multiple selectable themes. User-supplied custom template/background. Public ON/OFF toggle. Short configurable freshness window so the image stays current."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Embed an always-current coding-time heatmap (Priority: P1)

A user wants to showcase their coding activity on their GitHub profile README. They copy a single image URL from CloudTime and paste it into their README as an image. From then on, the image shows a contribution-graph-style heatmap of their daily coding time that keeps itself up to date — including today's activity — with no further action, no scheduled job, and no commits pushed to their repository.

**Why this priority**: This is the core motivation for the feature and the reason CloudTime is hosted on an edge platform — a self-updating image that reflects current coding activity. It delivers value on its own: a single embeddable heatmap is a complete, demonstrable MVP.

**Independent Test**: Embed the heatmap URL on a page, record some coding activity, and confirm the image reflects the new activity within the freshness window without editing the embed or the host page.

**Acceptance Scenarios**:

1. **Given** a user with recorded coding activity, **When** the heatmap image URL is requested, **Then** an image is returned showing daily coding-time intensity over a trailing period, including the current day.
2. **Given** the user records additional coding time, **When** the image is requested again after the freshness window elapses, **Then** the heatmap reflects the new activity without any manual refresh or repository commit.
3. **Given** the image is embedded in a GitHub README, **When** a visitor views the README, **Then** the heatmap renders inline as an image.

---

### User Story 2 - Control whether cards are publicly visible (Priority: P1)

The person operating the CloudTime instance decides whether their coding stats may be served as public embeddable cards at all. They can turn embeds OFF entirely (the default-safe stance), in which case no card URL returns any data.

**Why this priority**: Cards are served without authentication so they can be embedded on public pages; therefore the ability to keep them private is a prerequisite for shipping the feature safely. It must land together with the first card.

**Independent Test**: Toggle embeds OFF and confirm every card URL returns a non-data response (403/404); toggle ON and confirm cards render.

**Acceptance Scenarios**:

1. **Given** embeds are turned OFF, **When** any card URL is requested, **Then** no coding data is returned (the request is refused).
2. **Given** embeds are turned ON, **When** a card URL is requested, **Then** the card renders normally.
3. **Given** any card URL, **When** it is inspected, **Then** it contains no API key or secret credential.

---

### User Story 3 - Embed a stats summary card (Priority: P2)

A user embeds a compact card summarizing their coding totals — total time, daily average, best day, and top language — for a selectable time range (e.g. last 7 days, last 30 days, all time).

**Why this priority**: A second card type that broadens the feature's appeal once the foundation (US1/US2) exists. Independently valuable but not required for the MVP.

**Independent Test**: Request the summary card for a range and confirm the displayed totals match the user's aggregated stats for that range.

**Acceptance Scenarios**:

1. **Given** a user with activity over a range, **When** the summary card is requested for that range, **Then** the card shows total time, daily average, best day, and top language for that range.
2. **Given** an unsupported or missing range, **When** the card is requested, **Then** a sensible default range is used.

---

### User Story 4 - Embed a top-languages card (Priority: P2)

A user embeds a card showing the share of their coding time per language as a bar or pie representation.

**Why this priority**: A third card type. Reuses the same foundation and language data already available; independently valuable.

**Independent Test**: Request the languages card and confirm the language shares match the user's aggregated language breakdown.

**Acceptance Scenarios**:

1. **Given** a user with multi-language activity, **When** the languages card is requested, **Then** the card shows each top language with its relative share.

---

### User Story 5 - Choose a visual theme (Priority: P2)

A user picks from several built-in visual themes (for example a dark and a light theme plus additional presets) so the card matches their README's look. Switching theme requires only changing the embed URL.

**Why this priority**: Theming materially affects adoption (cards must blend into a README) but is styling-only and applies across all card types, so it follows the card types themselves.

**Independent Test**: Request the same card with two different theme selections and confirm only the visual styling differs while the data is identical; request an unknown theme and confirm it falls back to the default.

**Acceptance Scenarios**:

1. **Given** a valid theme selection, **When** a card is requested with that theme, **Then** the card renders with that theme's colors/typography and unchanged data.
2. **Given** an unknown or invalid theme selection, **When** a card is requested, **Then** the card renders with the default theme rather than failing.

---

### User Story 6 - Define a custom card template (Priority: P3)

Beyond the built-in presets, a user supplies their own card template containing placeholder tokens (a marked-up vector template). The system fills the placeholders with the user's current stats and serves the result as a card, giving the user full control over layout and styling.

**Why this priority**: A personalization layer on top of the established card + theme system. It carries the highest complexity and the strictest safety requirements because the template is untrusted user content, so it ships last.

**Independent Test**: Supply a template with placeholders, request a card that uses it, and confirm the placeholders are replaced with the user's current stats and the result renders as a valid image.

**Acceptance Scenarios**:

1. **Given** a user has supplied a valid template with recognized placeholder tokens, **When** a card is requested referencing it, **Then** the placeholders are replaced with the user's current stats and a valid image is returned.
2. **Given** a template that exceeds size limits, contains unsupported/unsafe content (scripts or external resource references), or uses unknown placeholder tokens, **When** it is supplied, **Then** it is rejected with a clear reason and no card is produced from it.

---

### Edge Cases

- **Embeds OFF**: every card URL must refuse to return data (no leak), not merely hide the link.
- **No activity / new user**: cards must render a valid, readable "no activity yet" state — never a broken image.
- **Invalid theme name**: fall back to the default theme instead of erroring.
- **Today not yet aggregated**: today's column/number must still reflect activity recorded since the last aggregation run (freshness must not depend solely on the periodic aggregation cadence).
- **Timezone**: day boundaries (which day a heartbeat counts toward, "best day", today's column) must use the user's configured timezone.
- **Image proxy caching**: consumers like GitHub proxy and cache embedded images; the freshness window must be expressible so the proxy refetches on a reasonable cadence, while accepting the proxy's own cache as a best-effort upper bound on staleness.
- **High view volume**: a popular README can drive many image requests; cards must be cacheable and rate-limitable so the instance stays within edge-platform limits.
- **Oversized/malformed custom base**: must be validated and rejected within size limits.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST serve each card as an image that renders inline when embedded in a GitHub README or any site that embeds images by URL.
- **FR-002**: Card images MUST reflect the user's latest coding activity — including the current day — without requiring any manual refresh, scheduled job, or commit to the user's repository.
- **FR-003**: System MUST provide a **coding-time heatmap** card showing daily coding-time intensity over a trailing period in a contribution-graph style.
- **FR-004**: System MUST provide a **stats summary** card showing total time, daily average, best day, and top language for a selectable time range.
- **FR-005**: System MUST provide a **top-languages** card showing each top language and its relative share of coding time.
- **FR-006**: Users MUST be able to select among multiple built-in visual themes; an unknown or invalid theme MUST fall back to a default theme rather than fail.
- **FR-007**: Users MUST be able to supply a custom card template containing recognized placeholder tokens; the system MUST fill those placeholders with the user's current stats and MUST reject templates that exceed size limits or contain unsupported/unsafe content (scripts, external resource references, or unknown placeholder tokens).
- **FR-008**: Operators MUST be able to turn embeddable cards ON or OFF; when OFF, every card URL MUST refuse to return any coding data.
- **FR-009**: Card URLs MUST NOT require, contain, or expose the user's API key or any secret credential.
- **FR-010**: System MUST provide a configurable freshness window controlling how current an embedded image is, so operators can trade staleness against load.
- **FR-011**: Cards MUST NOT expose data the operator has chosen to keep private; visibility settings MUST be honored consistently across all card types.
- **FR-012**: Cards MUST render a valid, readable result when the user has zero recorded activity (no broken image).
- **FR-013**: All day-boundary and time-of-day calculations underlying a card MUST use the user's configured timezone.
- **FR-014**: Card data and any custom base MUST be scoped to a specific user, preserving the path to multi-user support even though single-user is the default.
- **FR-015**: System MUST allow a card to be re-fetched on demand bypassing cached copies (e.g. via a changeable URL parameter) so a user can force an immediate update when needed.

### Key Entities *(include if feature involves data)*

- **Embeddable Card**: a rendered image of a user's coding stats. Attributes: card type (heatmap / summary / top-languages), selected theme, time range, target user, and freshness metadata. Derived from aggregated data; not stored as user-editable content.
- **Theme**: a named visual preset defining colors and typography only — never which data is shown.
- **Custom Card Template**: a user-supplied template containing placeholder tokens for stat values. Scoped to a user; subject to size limits and a safe-content policy (no scripts or external references); only a defined set of placeholder tokens is recognized and substituted.
- **Embed Visibility Setting**: configuration controlling whether cards are publicly retrievable for a user/instance.
- **Aggregated Activity (existing)**: the daily/hourly coding-time summaries and commit data already maintained by CloudTime; the source of every number a card displays.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a one-time embed, a card stays current with no further user action — 0 manual steps and 0 repository commits are required to keep it updated.
- **SC-002**: After a user records new coding activity, the embedded card reflects it within the configured freshness window (target: 15 minutes by default).
- **SC-003**: A card image is returned to a viewer in under 2 seconds at typical view volumes.
- **SC-004**: Changing a card's theme or range requires editing only the embed URL — no re-setup or re-upload.
- **SC-005**: When embeds are turned OFF, 100% of card requests return no coding data.
- **SC-006**: No card URL exposes an API key or secret credential (verifiable by inspection of any generated URL).
- **SC-007**: Cards render a valid image in 100% of cases including zero-activity users (no broken images).
- **SC-008**: A user can force an immediate refresh of a card and see updated data on the next view.

## Assumptions

- Cards intentionally present **aggregated** stats (totals, per-day intensity, per-language share), never raw individual heartbeats.
- The data source is CloudTime's **existing aggregated summaries, hourly summaries, and commit data**; the current day is computed on demand so freshness does not depend solely on the periodic aggregation cadence.
- **Single-user mode is the default**; user scoping is retained throughout for a future multi-user upgrade, but no multi-user logic is built now (per constitution Principle V).
- The default **freshness window is short** (assumed ~15 minutes) and is configurable; an external image proxy's own caching is accepted as a best-effort upper bound on staleness, mitigated by a force-refresh mechanism (FR-015).
- Cards are delivered as **vector images** suitable for README embedding; raster (PNG/JPG) output is out of scope for the first version.
- **Themes are styling-only** (colors/typography) and apply uniformly across card types.
- A user-supplied custom template is stored using the project's **existing object-storage capability** and is treated as untrusted input: only a defined set of stat placeholder tokens is substituted, and scripts/external references are stripped or rejected to satisfy image-proxy sanitization constraints.
- Access to cards is **read-only**; cards never mutate data.

## Dependencies

- Existing aggregation pipeline (daily/hourly summaries) and commit data.
- Existing per-user settings (timezone) and public-visibility settings.
- Existing object storage for user-supplied custom templates.
