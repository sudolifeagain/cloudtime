# Quickstart: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter`

Manual verification scenarios (run against a worker with seeded `summaries`). These also map directly to the PR2 integration tests. Auth via API key (Bearer) per project test helpers.

Assume a user whose `summaries` contain activity on a spread of dates, e.g.
`2026-06-01` (Mon), `2026-06-02` (Tue), `2026-06-08` (Mon), `2026-06-09` (Tue).

## A. Unfiltered baseline

```
GET /api/v1/users/current/insights/days/last_30_days
```
Expect `data.days[]` with all four dates, ascending.

## B. Filter by name

```
GET /api/v1/users/current/insights/days/last_30_days?weekday=monday
```
Expect `data.days[]` = only `2026-06-01` and `2026-06-08`, ascending; no Tuesdays.

## C. Filter by integer (equivalence)

```
GET /api/v1/users/current/insights/days/last_30_days?weekday=1
```
Expect a response byte-identical to B (1 = Monday).

## D. Case-insensitivity

```
GET /api/v1/users/current/insights/days/last_30_days?weekday=MONDAY
```
Expect a response identical to B.

## E. No matches → empty

```
GET /api/v1/users/current/insights/days/last_30_days?weekday=saturday
```
Expect `data.days` = `[]`, HTTP 200.

## F. Invalid value → 400

```
GET /api/v1/users/current/insights/days/last_30_days?weekday=funday
GET /api/v1/users/current/insights/days/last_30_days?weekday=7
```
Expect HTTP 400 for both.

## G. Ignored by non-`days` types

```
GET /api/v1/users/current/insights/languages/last_30_days?weekday=monday
```
Expect the same payload as without `weekday` (HTTP 200), even for an invalid value:

```
GET /api/v1/users/current/insights/languages/last_30_days?weekday=funday
```
Expect HTTP 200, unfiltered languages payload.

## H. Consistency with the `weekday` insight

The dates returned by B must be exactly the dates the `weekday` insight counts under "Monday":

```
GET /api/v1/users/current/insights/weekday/last_30_days
```
Cross-check that the Monday average in this response is the mean of the `total_seconds` from B.
