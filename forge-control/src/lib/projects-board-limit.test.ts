/**
 * Tests for the board column projection.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The two most important tests in this file are:
 *  - "omitting a column that is not there is a hard error" — the silent no-op it
 *    forbids is the one that restores the entire 1.8 MB board payload the moment
 *    somebody renames `brief`, with no symptom until the next measurement.
 *  - "the REAL TASK_COLS_PT projects cleanly" — the canary. It reads the live
 *    constant out of db/projects.ts rather than a copy, because a copy of a
 *    column list rots the day a column is added and then asserts nothing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BOARD_OMITTED_COLUMNS,
  BOARD_REQUIRED_COLUMNS,
  BoardColumnProjectionError,
  omitSelectColumns,
  projectBoardColumns,
  selectEntryColumnName,
  selectListColumnNames,
  splitSelectList,
} from "./projects-board-limit.ts";

/** A stand-in with the same shape as TASK_COLS_PT — qualified, cast, multi-line. */
const SAMPLE = `pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title,
  pt.brief, pt.status, pt.run_id::text, pt.fix_cycle, pt.tier, pt.attempt,
  pt.chain_key, pt.depends_on::text[], pt.workstream, pt.write_set, pt.graph_frozen,
  pt.created_at::text, pt.updated_at::text`;

describe("splitSelectList", () => {
  test("splits on top-level commas and collapses the newlines", () => {
    assert.deepEqual(splitSelectList("a, b,\n  c"), ["a", "b", "c"]);
  });

  test("does not cut a parenthesised expression in half", () => {
    assert.deepEqual(splitSelectList("a, coalesce(b, c), d"), ["a", "coalesce(b, c)", "d"]);
  });

  test("unbalanced parentheses are a hard error, not a best-effort split", () => {
    assert.throws(() => splitSelectList("a, coalesce(b, c"), BoardColumnProjectionError);
  });
});

describe("selectEntryColumnName", () => {
  test("strips the table qualifier and the cast", () => {
    assert.equal(selectEntryColumnName("pt.id::text"), "id");
    assert.equal(selectEntryColumnName("pt.depends_on::text[]"), "depends_on");
    assert.equal(selectEntryColumnName("pt.round"), "round");
    assert.equal(selectEntryColumnName("round"), "round");
    assert.equal(selectEntryColumnName("pt.updated_at::text"), "updated_at");
  });

  test("an expression is refused rather than guessed at", () => {
    for (const entry of ["p.name AS project_name", "count(*)", "'x'", "(SELECT 1)"]) {
      assert.throws(
        () => selectEntryColumnName(entry),
        (e: unknown) => e instanceof BoardColumnProjectionError && e.message.includes(entry),
        `expected ${entry} to be refused`,
      );
    }
  });
});

describe("omitSelectColumns", () => {
  test("removes the named column and keeps order, qualifiers and casts", () => {
    const out = omitSelectColumns(SAMPLE, ["brief"]);
    assert.ok(!/\bbrief\b/.test(out), `brief survived: ${out}`);
    assert.ok(out.startsWith("pt.id::text, pt.project_id::text, pt.round, pt.role, pt.title, pt.status"));
    assert.ok(out.includes("pt.depends_on::text[]"), "the cast must survive the projection");
    assert.deepEqual(
      selectListColumnNames(out),
      selectListColumnNames(SAMPLE).filter((c) => c !== "brief"),
    );
  });

  test("omitting a column that is not there is a hard error", () => {
    assert.throws(
      () => omitSelectColumns(SAMPLE, ["task_brief"]),
      (e: unknown) =>
        e instanceof BoardColumnProjectionError &&
        e.message.includes('"task_brief"') &&
        e.message.includes("not present"),
    );
  });

  test("a projection that removes everything is refused", () => {
    assert.throws(() => omitSelectColumns("pt.brief", ["brief"]), BoardColumnProjectionError);
  });
});

describe("projectBoardColumns", () => {
  test("drops exactly BOARD_OMITTED_COLUMNS and nothing else", () => {
    const before = selectListColumnNames(SAMPLE);
    const after = selectListColumnNames(projectBoardColumns(SAMPLE));
    assert.deepEqual(
      after,
      before.filter((c) => !(BOARD_OMITTED_COLUMNS as readonly string[]).includes(c)),
    );
    assert.equal(before.length - after.length, BOARD_OMITTED_COLUMNS.length);
  });

  test("every R56 column survives", () => {
    const after = selectListColumnNames(projectBoardColumns(SAMPLE));
    for (const c of ["depends_on", "workstream", "write_set"]) {
      assert.ok(after.includes(c), `R56 requires ${c} on every board task; the projection dropped it`);
    }
  });

  test("every required column survives", () => {
    const after = selectListColumnNames(projectBoardColumns(SAMPLE));
    for (const c of BOARD_REQUIRED_COLUMNS) {
      assert.ok(after.includes(c), `${c} is required by the board and the projection dropped it`);
    }
  });

  test("a task column list missing a required column is refused, and the error names it", () => {
    const withoutWriteSet = SAMPLE.replace("pt.write_set, ", "");
    assert.throws(
      () => projectBoardColumns(withoutWriteSet),
      (e: unknown) =>
        e instanceof BoardColumnProjectionError &&
        e.message.includes("write_set") &&
        e.message.includes("R56"),
    );
  });

  test("it is idempotent on its own output only when nothing was dropped twice", () => {
    // Projecting an already-projected list must fail loudly rather than silently
    // succeed: `brief` is gone, so the omission has nothing to remove.
    const once = projectBoardColumns(SAMPLE);
    assert.throws(() => projectBoardColumns(once), BoardColumnProjectionError);
  });
});

describe("the canary: the REAL TASK_COLS_PT", () => {
  /** Read the constant out of the source rather than importing db/projects.ts —
   *  that module opens a pg Pool at import time, and a unit test has no business
   *  doing that. Reading the text also fails loudly if the constant is renamed,
   *  which importing a value would not. */
  function realTaskColsPt(): string {
    const src = readFileSync(
      fileURLToPath(new URL("../db/projects.ts", import.meta.url)),
      "utf8",
    );
    const m = /const TASK_COLS_PT = `([^`]+)`/.exec(src);
    if (!m) {
      throw new Error(
        "TASK_COLS_PT was not found in src/db/projects.ts. It was renamed or reshaped — " +
          "this canary is the reason you are reading this message rather than discovering " +
          "the board's column projection had silently stopped matching the real query.",
      );
    }
    return m[1];
  }

  test("projects cleanly, and the result is missing exactly `brief`", () => {
    const real = realTaskColsPt();
    const before = selectListColumnNames(real);
    assert.ok(before.includes("brief"), "TASK_COLS_PT no longer selects brief — update BOARD_OMITTED_COLUMNS");
    const after = selectListColumnNames(projectBoardColumns(real));
    assert.deepEqual(after, before.filter((c) => c !== "brief"));
  });

  test("carries every column BOARD_REQUIRED_COLUMNS names", () => {
    const present = selectListColumnNames(realTaskColsPt());
    for (const c of BOARD_REQUIRED_COLUMNS) {
      assert.ok(present.includes(c), `TASK_COLS_PT no longer carries ${c}`);
    }
  });

  test("BOARD_REQUIRED_COLUMNS + BOARD_OMITTED_COLUMNS accounts for the whole list", () => {
    // If a column is added to TASK_COLS_PT and to neither constant, the board
    // would carry it without anybody having decided that it should. This test is
    // the decision point.
    const present = selectListColumnNames(realTaskColsPt());
    const accounted = new Set<string>([...BOARD_REQUIRED_COLUMNS, ...BOARD_OMITTED_COLUMNS]);
    const unaccounted = present.filter((c) => !accounted.has(c));
    assert.deepEqual(
      unaccounted,
      [],
      `new task column(s) ${unaccounted.join(", ")}: decide whether the board needs them ` +
        `(add to BOARD_REQUIRED_COLUMNS) or not (add to BOARD_OMITTED_COLUMNS)`,
    );
  });
});
