# OpenAPI Diff: Profile Badge and Composite Card Expansion

## Added Path

### `GET /users/{username}/badges/{badge_type}.svg`

Public, unauthenticated SVG badge endpoint.

Path parameters:

- `username`: public CloudTime username, 1-64 chars.
- `badge_type`: one of `coding_time`, `top_language`, `current_streak`,
  `goal_progress`.

Query parameters:

- `range`: optional enum `today`, `last_7_days`, `last_30_days`,
  `last_6_months`, `last_year`, `all_time`.
- `goal_id`: optional UUID for `goal_progress`.
- `label`: optional 1-24 char label override.
- `theme`: optional built-in theme name.
- `style`: optional enum `flat`, `pill`.
- `v`: optional cache-busting value that changes only the cache key.

Responses:

- `200 image/svg+xml` with `Cache-Control` and `ETag`.
- `400 BadRequest`.
- `404 NotFound`.
- `429 TooManyRequests`.

## Changed Path

### `GET /users/{username}/cards/{card_type}.svg`

Changes:

- Adds `profile` to the `card_type` enum.
- Adds optional `metrics` query for the `profile` composite card.
- Adds optional `layout` query for the `profile` composite card.
- Clarifies GitHub profile README use and cache/visibility behavior.

The existing `heatmap`, `summary`, `languages`, and `streak` card types remain
unchanged.

## Generated Types

After `npm run generate`, TypeScript clients receive:

- new `getEmbeddableBadge` operation types
- updated `getEmbeddableCard` `card_type` enum including `profile`
- typed `metrics` and `layout` query fields for profile cards
