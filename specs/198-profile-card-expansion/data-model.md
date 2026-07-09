# Data Model: Profile Badge and Composite Card Expansion

PR1 does not add database tables or migrations. The following are contract-level
entities for PR2 implementation.

## ProfileBadgeRequest

Represents a public badge image request.

| Field | Type | Source | Validation |
|---|---|---|---|
| username | string | path | 1-64 chars |
| badge_type | enum | path | `coding_time`, `top_language`, `current_streak`, `goal_progress` |
| range | enum | query | optional; `today`, `last_7_days`, `last_30_days`, `last_6_months`, `last_year`, `all_time` |
| goal_id | uuid | query | optional; applies to `goal_progress` |
| label | string | query | optional; 1-24 chars |
| theme | string | query | optional; same theme rules as cards |
| style | enum | query | optional; `flat`, `pill` |
| v | string | query | optional; cache key only |

## ProfileCardRequest

Extends the existing public card request when `card_type=profile`.

| Field | Type | Source | Validation |
|---|---|---|---|
| username | string | path | 1-64 chars |
| card_type | enum | path | includes `profile` |
| metrics | enum array | query | optional; 1-8 unique items |
| layout | enum | query | optional; `default`, `compact` |
| theme | string | query | optional; same theme rules as cards |
| template_id | uuid | query | optional; same ownership rules as cards |
| v | string | query | optional; cache key only |

## ProfileMetric

Metric sections supported by the profile composite card.

| Metric | Description | Initial data source |
|---|---|---|
| today | Coding time for the user's current local day | summaries + bounded current-day heartbeat overlay |
| week | Coding time for the trailing 7 days | summaries + bounded current-day heartbeat overlay |
| all_time | Total CloudTime coding time | existing all-time/summaries semantics |
| top_language | Top language for the selected/default range | summaries |
| current_streak | Current CloudTime tracked-day streak | summaries + bounded current-day heartbeat overlay |
| goal_progress | Progress for a selected/default enabled goal; inverse (cap) goals are framed as share of the cap, not achievement (FR-018) | goals + summaries |

## Cache Keys

PR2 should use separate cache namespaces/prefixes for badges and profile cards.
Cache keys must include:

- route kind (`badge` or `card`)
- user id or username
- badge/card type
- normalized theme/style/layout
- normalized range/metrics/goal id/label/template id
- freshness window
- optional `v`

## Privacy Rules

- Missing user, disabled embeds, unavailable goal/template, or unsupported
  metric data returns `404`.
- Invalid request shape returns `400`.
- Disabled embeds return before cache lookup and before aggregate data reads.
- No public request may include an API key or session credential.
