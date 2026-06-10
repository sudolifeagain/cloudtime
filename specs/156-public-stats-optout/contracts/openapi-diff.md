# OpenAPI Contract Diff: public global stats opt-out

**Branch**: `156-public-stats-optout`
**Files**: `schemas/paths/meta/global-stats.yaml` (operation `getGlobalStats`)

This PR1 change is **additive**: one new documented response (`404`,
`$ref`-ing the existing shared `NotFound` component) and one sentence of
operation prose. No parameter, schema, or existing response changes.

## 1. Operation description — document the instance switch

**Before** (closing sentence of `description`)
```
    cache on an unauthenticated endpoint) and avoids ambiguous cross-user date
    boundaries when `summaries.date` is bucketed per user timezone (#29).
```

**After**
```
    cache on an unauthenticated endpoint) and avoids ambiguous cross-user date
    boundaries when `summaries.date` is bucketed per user timezone (#29).

    Operators can disable this endpoint entirely by setting the instance
    variable `PUBLIC_STATS` to `false`; a disabled instance responds `404`
    to every request, regardless of the range value (#156).
```

## 2. Responses — add `404`

**Before**
```yaml
    '400':
      $ref: ../../components/responses/BadRequest.yaml
```

**After**
```yaml
    '400':
      $ref: ../../components/responses/BadRequest.yaml
    '404':
      $ref: ../../components/responses/NotFound.yaml
```

Note: the shared `NotFound` component carries its own fixed description
("Resource not found") — OpenAPI 3.0 does not allow overriding a description
alongside a `$ref`, and the disabled-instance semantics are documented in the
operation prose above instead. The disabled gate precedes range validation,
so a disabled instance returns `404` even for range values that would
otherwise yield `400` (spec FR-002).

## Generated types impact

- `src/types/generated.ts`: the `getGlobalStats` operation's `responses` map
  gains a `404` entry referencing the shared not-found error shape
  (`{ error?: string }`). No existing member changes.
- Verified by `npm run generate` followed by reviewing the `git diff` of
  `src/types/generated.ts` (expected: the additive `404` response on
  `getGlobalStats` plus the updated operation JSDoc; nothing else).
