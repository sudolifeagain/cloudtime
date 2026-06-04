# Quickstart: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day`

Manual verification scenarios (run against a worker with seeded `hourly_summaries`). These also map directly to the PR2 integration tests. Auth via API key (Bearer) per project test helpers.

Assume a user (profile timezone `UTC` for the baseline) whose `hourly_summaries` contain, across **two active days** `2026-06-01` and `2026-06-02`:

| date       | hour | total_seconds |
|------------|------|---------------|
| 2026-06-01 | 9    | 3600          |
| 2026-06-01 | 10   | 1800          |
| 2026-06-02 | 9    | 1800          |
| 2026-06-02 | 14   | 600           |

Active days = 2. Expected means: hour 9 → (3600+1800)/2 = 2700; hour 10 → 1800/2 = 900; hour 14 → 600/2 = 300; every other hour → 0.

## A. Basic profile

```
GET /api/v1/users/current/insights/hours/last_30_days
```
Expect `data.type === "hours"` and `data.hours` with **24 entries** ordered `0…23`. Bucket `hour:9` → `total_seconds:2700`, `hour:10` → `900`, `hour:14` → `300`, all others → `0`.

## B. Sums to daily_average

```
GET /api/v1/users/current/insights/daily_average/last_30_days
```
Expect `data.daily_average.seconds === 3900` (= 2700+900+300), i.e. the sum of all 24 `hours[]` buckets from A.

## C. Empty range → 24 zeros

```
GET /api/v1/users/current/insights/hours/2099
```
Expect HTTP 200 with `data.hours` still 24 entries, every `total_seconds === 0`.

## D. Range vocabulary + year/month

```
GET /api/v1/users/current/insights/hours/2026-06
GET /api/v1/users/current/insights/hours/last_7_days
```
Expect HTTP 200, `type:"hours"`, 24 buckets, for both.

## E. Invalid range → 400

```
GET /api/v1/users/current/insights/hours/not_a_range
```
Expect HTTP 400.

## F. Unauthenticated → 401

```
GET /api/v1/users/current/insights/hours/last_30_days   (no/invalid Bearer)
```
Expect HTTP 401.

## G. Timezone basis

Seed a user with profile timezone `America/New_York` and heartbeats whose UTC hour differs from the local hour; re-run the cron. Expect the bucket to land on the **local** hour (e.g. 14:00 UTC → 09:00 or 10:00 New York depending on DST), matching the date bucketed into `summaries` for the same activity.

## H. Reserved params ignored

```
GET /api/v1/users/current/insights/hours/last_30_days?weekday=monday&timeout=30&writes_only=true
```
Expect a response identical to A — `weekday`, `timeout`, `writes_only` have no effect on `hours`.
