# OpenAPI Contract Diff: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation`
**Files**: `schemas/paths/commits/commits.yaml` (`createProjectCommit` description), `schemas/components/schemas/CommitInput.yaml` (`total_seconds` description), `schemas/components/schemas/Commit.yaml` (`total_seconds` description)

This PR1 change is **description-only**. No operation, path, field, type, format, `required`, enum, or status code changes. `npm run generate` produces a **JSDoc-only** diff in `src/types/generated.ts` (comment text on the affected members; no shape change). The behavior lives entirely in PR2's handler.

## 1. `commits.yaml` — `createProjectCommit` description

The current prose asserts the opposite of this feature and must be corrected.

**Before** (excerpt):
> `hash` is required and must be non-empty. `total_seconds` is the optional client-supplied coding time for the commit (**the server does not correlate heartbeats**); when present it must be a number >= 0. …

**After** (excerpt):
> `hash` is required and must be non-empty. `total_seconds` is the optional coding time for the commit; when present it must be a number >= 0 and is stored verbatim. **When it is omitted, the server derives the commit's coding time by correlating the user's heartbeats for this project in a bounded window ending at `author_date` (falling back to the ingest time) and bounded below by the previous commit — using the same session-timeout rule as the daily summaries; if no heartbeats fall in the window the value stays absent.** …

(The idempotency, project-from-path, dates, and `ref` clauses are unchanged.)

## 2. `CommitInput.yaml` — `total_seconds` gains a description

**Before**:
```yaml
  total_seconds:
    type: number
    format: double
    minimum: 0
```

**After** (shape unchanged; description added):
```yaml
  total_seconds:
    type: number
    format: double
    minimum: 0
    description: >-
      Client-supplied coding time in seconds for the commit. Optional: when
      omitted the server derives it by correlating heartbeats around the commit
      (see the ingestion operation). An explicit value (including 0) is stored
      verbatim and is never overwritten by correlation.
```

## 3. `Commit.yaml` — `total_seconds` gains a description

**Before**:
```yaml
  total_seconds:
    type: number
    format: double
```

**After** (shape unchanged; description added):
```yaml
  total_seconds:
    type: number
    format: double
    description: >-
      Coding time in seconds for the commit. Either client-supplied at ingest or
      server-derived from surrounding heartbeats when the client omitted it.
      Absent when no time was supplied and none could be derived.
```

## Generated types impact

- `src/types/generated.ts`: JSDoc comments are added/updated on `operations["createProjectCommit"]`, `components["schemas"]["CommitInput"]["total_seconds"]`, and `components["schemas"]["Commit"]["total_seconds"]`. No member is added, removed, retyped, or made (non-)optional.
- Verified by `npm run generate` + reviewing the `git diff` of `src/types/generated.ts` (JSDoc/description text only; `git diff --numstat` shows only comment-line churn plus EOL normalization).
