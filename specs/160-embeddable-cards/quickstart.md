# Quickstart: Embeddable Stat Cards

**Branch**: `spec/160-embeddable-cards` | **Scope**: PR2 behavior (PR1 ships contract only)

## Prerequisites

- Deployed or local Worker with the PR2 migration applied.
- One authenticated CloudTime user with an API key or session.
- At least one day of seeded summaries/heartbeats for visible non-empty cards.

## 1. Confirm embeds default OFF

Request a public card before enabling embeds:

```bash
curl -i "https://time.example.com/api/v1/users/YOUR_USERNAME/cards/heatmap.svg"
```

Expected:

- `HTTP/1.1 404 Not Found`
- no SVG body containing coding stats
- `Cache-Control: no-store`

## 2. Enable embeds and set freshness

```bash
curl -X PATCH "https://time.example.com/api/v1/users/current/embed_settings" \
  -H "Authorization: Bearer $CLOUDTIME_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"enabled":true,"freshness_minutes":15,"default_theme":"default"}'
```

Expected JSON response includes:

- `data.enabled: true`
- `data.freshness_minutes: 15`

## 3. Render the heatmap card

```bash
curl -i "https://time.example.com/api/v1/users/YOUR_USERNAME/cards/heatmap.svg?theme=default"
```

Expected:

- `HTTP/1.1 200 OK`
- `Content-Type: image/svg+xml`
- `Cache-Control` max-age derived from the freshness window
- SVG contains no API key or secret
- image renders in a browser and in Markdown:

```markdown
![CloudTime coding heatmap](https://time.example.com/api/v1/users/YOUR_USERNAME/cards/heatmap.svg?theme=default)
```

## 4. Verify current-day freshness

1. Record new coding activity for today.
2. Wait for the configured freshness window, or change `v`:

```bash
curl -i "https://time.example.com/api/v1/users/YOUR_USERNAME/cards/heatmap.svg?v=manual-1"
```

Expected: the card reflects today's additional activity without editing the
host page beyond the optional `v` value.

## 5. Verify card variants

```bash
curl -i "https://time.example.com/api/v1/users/YOUR_USERNAME/cards/summary.svg?range=last_7_days&theme=dark"
curl -i "https://time.example.com/api/v1/users/YOUR_USERNAME/cards/languages.svg?range=last_30_days&theme=unknown"
```

Expected:

- summary and language card totals match aggregated stats for the range
- unknown theme falls back to the user's default theme
- zero-activity ranges still return a valid readable SVG

## 6. Verify custom template rejection

```bash
curl -X POST "https://time.example.com/api/v1/users/current/embed_templates" \
  -H "Authorization: Bearer $CLOUDTIME_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"name":"bad","template_svg":"<svg><script>alert(1)</script></svg>"}'
```

Expected:

- `HTTP/1.1 400 Bad Request`
- clear validation error
- no template is created

Repeat with event handlers, external `href`, `foreignObject`, data URLs, and an
unknown placeholder token; all must be rejected.

## 7. Turn embeds OFF with a warm cache

1. Request a card successfully.
2. Disable embeds:

```bash
curl -X PATCH "https://time.example.com/api/v1/users/current/embed_settings" \
  -H "Authorization: Bearer $CLOUDTIME_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"enabled":false}'
```

3. Request the same card URL again.

Expected:

- `404 Not Found`
- no stale SVG served from KV

## Automated Validation

Run:

```bash
npm run lint:api
npm run typecheck
npm test
```

The PR2 test suite should include integration coverage for default OFF, ON
rendering, cache headers, cache-busting, unsupported range fallback, invalid
card type, theme fallback, zero activity, unsafe template rejection, and OFF
with a pre-existing cached render.
