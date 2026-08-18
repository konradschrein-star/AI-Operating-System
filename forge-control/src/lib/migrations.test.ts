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

  // Named guard for 0040 (R1, R2). The generic lint above already proves every
  // statement carries its IF NOT EXISTS; this case pins the *specific* shape the
  // graph scheduler depends on, so that losing a piece of it reads as the bug it
  // is rather than as a silently smaller migration.
  test("0040 (task graph) adds four guarded columns, two named indexes, and a no-op-on-replay backfill", () => {
    // The generic per-file lint is driven by readdirSync + .endsWith(".sql").
    // Assert 0040 is in that list rather than assuming it: a file this case
    // reads directly by path but that FILES never enumerated would be linted by
    // nothing, and this whole suite would report a pass over an unexamined
    // migration.
    assert.ok(
      FILES.includes("0040_task_graph.sql"),
      `0040_task_graph.sql is not in the enumerated corpus (${FILES.join(", ")}) — ` +
        `the per-file lint never saw it, so its green result means nothing`,
    );

    const sql = readFileSync(`${MIGRATIONS_DIR}/0040_task_graph.sql`, "utf8");
    const stmts = statements(sql);

    // Select on the UNGUARDED pattern, so the selector cannot presuppose the
    // guard the assertion is about to check.
    const adds = stmts.filter((s) => /\bADD COLUMN\b/.test(s));
    // FOUR since round 242: `graph_frozen` joined depends_on/workstream/
    // write_set with E4. The count is not decoration — it is what catches a
    // column added to this migration without a corresponding decision, and it
    // moves in the same commit as the column, never after it (standing rule 4).
    assert.equal(
      adds.length,
      4,
      `expected exactly four ADD COLUMN statements (depends_on, workstream, write_set, graph_frozen), found ${adds.length}: ${adds.join(" | ")}`,
    );

    /** The one ADD COLUMN statement for `col`. Never a COMMENT ON that merely
     *  mentions the column name — the search space is the ADD COLUMN list. */
    const addFor = (col: string): string => {
      const hits = adds.filter((s) => new RegExp(`\\bIF NOT EXISTS ${col}\\b`).test(s));
      assert.equal(
        hits.length,
        1,
        `expected exactly one guarded ADD COLUMN for ${col}, found ${hits.length}: ${adds.join(" | ")}`,
      );
      return hits[0]!;
    };

    const dependsOn = addFor("DEPENDS_ON");
    assert.match(dependsOn, /ADD COLUMN IF NOT EXISTS DEPENDS_ON UUID\[\]/);
    assert.match(addFor("WORKSTREAM"), /ADD COLUMN IF NOT EXISTS WORKSTREAM TEXT NOT NULL DEFAULT 'MAIN'/);
    assert.match(addFor("WRITE_SET"), /ADD COLUMN IF NOT EXISTS WRITE_SET TEXT\[\] NOT NULL DEFAULT '\{\}'/);
    // R71. `NOT NULL DEFAULT false` is the whole of what makes this column
    // additive: every row any engine ever wrote, before or after 0040 runs, is
    // correctly not-frozen without being visited, so no behaviour changes for a
    // row the backfill never touched.
    assert.match(
      addFor("GRAPH_FROZEN"),
      /ADD COLUMN IF NOT EXISTS GRAPH_FROZEN BOOLEAN NOT NULL DEFAULT FALSE/,
      "graph_frozen must be NOT NULL DEFAULT false — a nullable marker would make 'unknown provenance' " +
        "expressible, which is the archaeology E4 exists to end (02-architecture.md 9.3)",
    );

    // R3. depends_on must carry NO default clause at all. NULL is a sentinel
    // meaning "never graph-scheduled, apply the legacy round rule"; '{}' means
    // "graph-scheduled, explicitly a root, promote now". A DEFAULT '{}' here
    // makes every row the OLD engine writes between `psql -f` and the executor
    // restart a graph root, releasing re-reviews before their fix builders run.
    assert.doesNotMatch(
      dependsOn,
      /\bDEFAULT\b/,
      `depends_on must have NO DEFAULT clause: the NULL sentinel is load-bearing; ` +
        `see 02-architecture.md 2.2 and 9.1 (Konrad ruled on it, escalation E2). ` +
        `Statement: ${dependsOn}`,
    );

    // R7. Both indexes, by name — a renamed index is a silently missing one.
    const indexes = stmts.filter((s) => /\bCREATE (UNIQUE )?INDEX\b/.test(s));
    assert.ok(
      indexes.some((s) =>
        /CREATE INDEX IF NOT EXISTS PROJECT_TASKS_DEPENDS_ON_GIN ON PROJECT_TASKS USING GIN \(DEPENDS_ON\)/.test(s),
      ),
      `0040 no longer creates project_tasks_depends_on_gin (R7). Indexes found: ${indexes.join(" | ")}`,
    );
    assert.ok(
      indexes.some((s) =>
        /CREATE INDEX IF NOT EXISTS PROJECT_TASKS_WORKSTREAM_IDX ON PROJECT_TASKS \(PROJECT_ID, WORKSTREAM, STATUS\)/.test(s),
      ),
      `0040 no longer creates project_tasks_workstream_idx (R7). Indexes found: ${indexes.join(" | ")}`,
    );

    // R2 + R6. The backfill is the migration's only non-DDL statement, and the
    // WHERE guard is the entire reason a second `psql -f` changes zero rows
    // instead of overwriting graph-scheduled edges with round-derived ones.
    const backfill = stmts.filter((s) => s.startsWith("UPDATE PROJECT_TASKS"));
    assert.equal(
      backfill.length,
      1,
      `expected exactly one backfill UPDATE, found ${backfill.length}: ${backfill.join(" | ")}`,
    );
    assert.match(
      backfill[0]!,
      /WHERE PT\.DEPENDS_ON IS NULL/,
      `the backfill UPDATE must be guarded by WHERE pt.depends_on IS NULL — without it a ` +
        `second application rewrites every graph-scheduled row's edges from its round (R2, R6). ` +
        `Statement: ${backfill[0]}`,
    );
    // R71. The marker must be set by THIS statement — same UPDATE, same WHERE,
    // same transaction as the closure it describes — so a row's closure and its
    // provenance can never disagree. A separate UPDATE would be re-runnable and
    // still correct, but it would also be a second statement whose WHERE could
    // drift from this one's, which is the shape of every bug E4's four failed
    // gates were built out of.
    assert.match(
      backfill[0]!,
      /GRAPH_FROZEN = TRUE/,
      `the backfill UPDATE must set graph_frozen = true on the rows whose closure it writes (R71, E4). ` +
        `Statement: ${backfill[0]}`,
    );
    // R6: the closure, not the previous round. `e.round < pt.round` is the whole
    // claim; `= pt.round - 1` would diverge from today's engine under retry.
    assert.match(
      backfill[0]!,
      /E\.ROUND < PT\.ROUND/,
      `the backfill must be the full transitive closure (every strictly lower round), not the ` +
        `previous round only — see 02-architecture.md 3.3 for the retryTask() divergence. ` +
        `Statement: ${backfill[0]}`,
    );
  });
});
