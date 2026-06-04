# OpenAPI Contract Diff: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day`
**Files**: `schemas/paths/insights/insights.yaml` (operation `getInsight`), `schemas/components/schemas/Insight.yaml`

This PR1 change is **additive**: a new enum value, a new response field, and clarified operation prose. `npm run generate` produces a new `hours` literal in the `insight_type` parameter union and an additive `hours?: …` field on the `Insight` schema in `src/types/generated.ts`. No existing field or type is removed or changed.

## 1. `insight_type` enum — add `hours`

**Before**
```yaml
        enum:
          - weekday
          - days
          - best_day
          - daily_average
          - projects
          - languages
          - editors
          - categories
          - machines
          - operating_systems
```

**After**
```yaml
        enum:
          - weekday
          - days
          - best_day
          - daily_average
          - hours
          - projects
          - languages
          - editors
          - categories
          - machines
          - operating_systems
```

## 2. Operation description — data source + the `hours` field mapping

**Before** (opening paragraph)
```
Derives an insight of the requested `insight_type` over `range` from the
pre-aggregated `summaries` table (no raw-heartbeat scan). All listed
insight types ship in the first cut; an `hours`-of-day insight is
intentionally absent because `summaries` has day granularity only (it
would require an hourly aggregate - a future addition).
```

**After**
```
Derives an insight of the requested `insight_type` over `range`. Most types
read from the pre-aggregated `summaries` table (day granularity, no
raw-heartbeat scan); the `hours`-of-day type reads from the `hourly_summaries`
aggregate, which the same hourly cron maintains at hour-of-day granularity.
```

**Field mapping** — add one bullet (placed with the temporal types, before the dimension types):
```
- `hours` -> `hours[]`, one bucket per hour of day (0-23, computed in the
  user's profile timezone), `total_seconds` = mean coding time in that hour
  across the active days in the range, ordered by hour ascending. Always 24
  buckets; hours with no activity report `total_seconds` 0.
```

The `weekday`, `timeout`, and `writes_only` paragraphs are unchanged.

## 3. `Insight` schema — add the `hours[]` field

**Before** (`schemas/components/schemas/Insight.yaml`, after `daily_average`)
```yaml
  daily_average:
    type: object
    properties:
      seconds:
        type: number
        format: double
      text:
        type: string
  items:
    type: array
    items:
      $ref: ./SummaryItem.yaml
```

**After**
```yaml
  daily_average:
    type: object
    properties:
      seconds:
        type: number
        format: double
      text:
        type: string
  hours:
    type: array
    items:
      type: object
      properties:
        hour:
          type: integer
          minimum: 0
          maximum: 23
        total_seconds:
          type: number
          format: double
        text:
          type: string
  items:
    type: array
    items:
      $ref: ./SummaryItem.yaml
```

## Generated types impact

- `src/types/generated.ts`: the `getInsight` `insight_type` path parameter union gains the `"hours"` literal; the `Insight` schema gains an additive optional `hours?: { hour?: number; total_seconds?: number; text?: string }[]`. No existing member changes.
- Verified by `npm run generate` followed by reviewing the `git diff` of `src/types/generated.ts` (expected: the new enum literal + the additive field + the updated operation JSDoc).
