# Quickstart: Insights Endpoint

Manual verification once PR2 (implementation) is deployed.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
```

Seed some `summaries` (until heartbeats accumulate naturally):

```bash
wrangler d1 execute cloudtime-db --remote --command "
  INSERT INTO summaries (user_id, date, project, language, editor, total_seconds) VALUES
   ('<uid>','2026-05-26','api','TypeScript','vscode',7200),
   ('<uid>','2026-05-27','api','Go','vscode',3600),
   ('<uid>','2026-05-28','web','TypeScript','vscode',1800);
"
```

## Scenario A — Languages (dimension insight)

```bash
curl -sH "$H" "$BASE/users/current/insights/languages/last_7_days"
```

**Expected**: `data.type="languages"`, `data.range` set, `data.items` ordered by `total_seconds` desc (`TypeScript` then `Go`), each with `percent` of the range total and `text`/`digital`.

## Scenario B — Editors / projects / categories / machines / operating_systems

```bash
curl -sH "$H" "$BASE/users/current/insights/projects/last_30_days"
```

**Expected**: same shape, grouped by the chosen dimension. Rows with a NULL dimension appear as an `"Unknown"` item.

## Scenario C — Days

```bash
curl -sH "$H" "$BASE/users/current/insights/days/last_7_days"
```

**Expected**: `data.days` lists active dates ascending, each `{date, total_seconds, text}`.

## Scenario D — Best day

```bash
curl -sH "$H" "$BASE/users/current/insights/best_day/last_30_days"
```

**Expected**: `data.best_day` is the highest-total date (`2026-05-26` for the seed above).

## Scenario E — Daily average

```bash
curl -sH "$H" "$BASE/users/current/insights/daily_average/last_30_days"
```

**Expected**: `data.daily_average.seconds` = total ÷ number of **active** days (here `(7200+3600+1800)/3 = 4200`), with a human `text`.

## Scenario F — Weekday

```bash
curl -sH "$H" "$BASE/users/current/insights/weekday/last_year"
```

**Expected**: `data.items` has one entry per occurring weekday (`name` = Monday…Sunday), `total_seconds` = mean for that weekday, ordered most-active-first.

## Scenario G — all_time / YYYY / YYYY-MM ranges

```bash
curl -sH "$H" "$BASE/users/current/insights/languages/all_time"
curl -sH "$H" "$BASE/users/current/insights/languages/2026"
curl -sH "$H" "$BASE/users/current/insights/languages/2026-05"
```

**Expected**: 200 with the range scoped accordingly; `daily_average` over `all_time` divides by active days (not diluted to ~0).

## Scenario H — Validation

```bash
curl -si "$H" "$BASE/users/current/insights/bogus/last_7_days"     # bad type
curl -si "$H" "$BASE/users/current/insights/languages/since_forever" # bad range
```

**Expected**: 400 for both.

## Scenario I — Empty range / auth

```bash
curl -sH "$H" "$BASE/users/current/insights/languages/2099"   # no data
curl -si "$BASE/users/current/insights/languages/last_7_days" # no auth
```

**Expected**: empty range → 200 with `items: []` (or zeroed `best_day`/`daily_average`); no auth → 401.

## Reverting / cleanup

Read-only. Removing the route + helper disables the feature with no data impact.
