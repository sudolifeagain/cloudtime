---
applyTo: "**/*.sql"
---
# SQL Standards (Cloudflare D1 / SQLite)

- Always use parameterized queries (`?` placeholders). Never string-concatenate user input.
- Use `IF NOT EXISTS` on CREATE TABLE and CREATE INDEX.
- Every table must have a PRIMARY KEY.
- Foreign keys must specify `ON DELETE CASCADE` where appropriate.
- Use `TEXT` for IDs (UUIDs), `REAL` for timestamps and durations, `INTEGER` for booleans.
- Index columns used in WHERE and JOIN clauses.
- Keep queries simple — D1 has a 1MB result size limit per query.
