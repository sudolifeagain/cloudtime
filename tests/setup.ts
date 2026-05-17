/**
 * Vitest setup for vitest-pool-workers. Runs once per test file before
 * any test, inside the Workers runtime. Initialises the test D1 with our
 * production schema so tests can prepare/run queries directly against env.DB.
 *
 * Vite's `?raw` import keeps the SQL bundled at build time — there is no
 * filesystem at runtime in a Worker.
 */
import { env } from "cloudflare:test";
// @ts-expect-error — Vite ?raw import; types provided by vite-env.d.ts
import schemaSql from "../src/db/schema.sql?raw";

function splitStatements(sql: string): string[] {
  // Strip line comments, then split on `;` at statement boundaries.
  // D1 schema.sql in this project contains only simple CREATE TABLE /
  // CREATE INDEX statements — no triggers, procedures, or embedded `;`.
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const statements = splitStatements(schemaSql);
for (const stmt of statements) {
  await env.DB.prepare(stmt).run();
}
