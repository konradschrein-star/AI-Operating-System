/**
 * Migration hygiene: every DDL statement under db/migrations/ must be
 * re-runnable.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * There is no ledger table and no runner script — applying a migration is a
 * manual `psql -f`, and the only defence against applying one twice is the
 * statement itself being a no-op the second time. 0039 shipped without
 * `IF NOT EXISTS` on either statement and the P6 gate caught it; this file is
 * the guard that stops the next one.
 *
 * Deliberately a lint over the .sql text rather than a live-database test:
 * it must run in `pnpm test` on a machine with no Postgres, and the property
 * being asserted ("the statement carries the guard clause") is textual.
 * The behavioural proof — apply twice, second is a no-op — is recorded in
 * docs/plan/evidence/p6-fix-cycle-1.md.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** src/lib → src → forge-control → repo root → db/migrations. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/** Strip `--` line comments so a header paragraph that *describes* the DDL
 *  ("...a partial index...", "CREATE UNIQUE INDEX ... WHERE ...") is never
 *  mistaken for the DDL itself. Block comments are not used in this corpus. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Split into statements and normalise each to a single upper-case line, so a
 *  clause wrapped onto the next line still matches as one statement. */
function statements(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim().toUpperCase())
    .filter(Boolean);
}

/** The guard each statement kind must carry. `CREATE TYPE` is absent on
 *  purpose: Postgres has no `IF NOT EXISTS` for it, so it cannot be linted
 *  this way and is guarded with a DO-block instead where it appears. */
const RULES: Array<{ kind: string; present: RegExp; guarded: RegExp }> = [
  {
    kind: "ADD COLUMN",
    present: /\bADD COLUMN\b/,
    guarded: /\bADD COLUMN IF NOT EXISTS\b/,
  },
  {
    kind: "CREATE INDEX",
    present: /\bCREATE (UNIQUE )?INDEX\b/,
    guarded: /\bCREATE (UNIQUE )?INDEX (CONCURRENTLY )?IF NOT EXISTS\b/,
  },
  {
    kind: "CREATE TABLE",
    present: /\bCREATE TABLE\b/,
    guarded: /\bCREATE TABLE IF NOT EXISTS\b/,
  },
];

const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("db/migrations re-runnability", () => {
  test("the corpus is found and non-trivial", () => {
    assert.ok(
      FILES.length >= 19,
      `expected the migration corpus at ${MIGRATIONS_DIR}, found ${FILES.length} files — this test has gone stale`,
    );
  });

  for (const file of FILES) {
    test(`${file} guards every re-runnable DDL statement`, () => {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
      for (const stmt of statements(sql)) {
        for (const rule of RULES) {
          if (!rule.present.test(stmt)) continue;
          assert.match(
            stmt,
            rule.guarded,
            `${file}: "${rule.kind}" without IF NOT EXISTS — re-applying this migration by hand errors ` +
              `instead of no-opping. Statement: ${stmt.slice(0, 160)}`,
          );
        }
      }
    });
  }

  // Named guard for the specific finding, so a regression reads as the bug it
  // is rather than as an anonymous lint failure.
  test("0039 (reviewer chain_key) is idempotent in both statements", () => {
    const sql = readFileSync(`${MIGRATIONS_DIR}/0039_reviewer_chain_key.sql`, "utf8");
    const stmts = statements(sql);
    const add = stmts.find((s) => s.includes("ADD COLUMN"));
    const idx = stmts.find((s) => s.includes("CREATE UNIQUE INDEX"));
    assert.ok(add, "0039 no longer adds chain_key — this test has gone stale");
    assert.ok(idx, "0039 no longer creates the partial unique index — this test has gone stale");
    assert.match(add, /ADD COLUMN IF NOT EXISTS CHAIN_KEY TEXT/);
    assert.match(idx, /CREATE UNIQUE INDEX IF NOT EXISTS PROJECT_TASKS_CHAIN_KEY_UNIQ/);
    // The partial predicate is what lets historical NULL rows stand; losing it
    // would turn a hygiene fix into a migration that cannot apply at all.
    assert.match(idx, /WHERE CHAIN_KEY IS NOT NULL/);
  });
});
