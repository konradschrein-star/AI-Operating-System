/**
 * Tests for the two chat behaviours LIVE DATA CANNOT DEMONSTRATE.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Why these are source assertions and not round-trips:
 *
 *  - THE SEARCH SCOPE. `scope=open` and `scope=all` differ only in whether
 *    ARCHIVED runs are included. On 2026-08-23 the `runs` table held 18 rows
 *    and ZERO archived ones, so both scopes returned the identical 30 hits for
 *    every term tried. A screenshot of the toggle in both states therefore
 *    proves the icon flips and nothing about the predicate — the two filters
 *    collapse on today's data. The predicate itself is the thing to pin.
 *
 *  - THE DELETE. Proving it end-to-end means creating and destroying a real
 *    run, which is a write to the live database and belongs in a
 *    deploy/verify task (`forge-control-web/app/desktop/chat/delete-test.ts`
 *    is that proof, and it passed 9/9 in round 2). What a unit test CAN hold
 *    is the shape: both tables, one transaction, and — the part that would be
 *    silent and unrecoverable if it regressed — that CLOSING a chat with the
 *    X still deletes nothing.
 *
 * Reading the source is a weaker instrument than executing it, and it is used
 * here deliberately rather than for convenience: the alternative available to
 * a build task is asserting over data where the two branches are equal, which
 * is [[live-data-collapses-two-predicates]] — a test that passes at every
 * value of the thing it claims to check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNS_SRC = readFileSync(
  fileURLToPath(new URL("../db/runs.ts", import.meta.url)),
  "utf8",
);

/** The body of one exported function, from its signature to the next
 *  top-level `export` — enough to assert "this statement is inside THAT
 *  function" instead of "somewhere in the file", which is the difference
 *  between a real assertion and a whole-file grep. */
function functionBody(name: string): string {
  const start = RUNS_SRC.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `db/runs.ts no longer exports ${name}`);
  const rest = RUNS_SRC.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("searchRuns scope", () => {
  const body = functionBody("searchRuns");

  test("the default scope is 'all' — closing a chat must not hide it from search", () => {
    // Konrad's complaint in the brief: "all of the chats should be stored even
    // if I click on the X". A default of "open" would reintroduce exactly the
    // disappearance the scope toggle exists to end.
    assert.match(body, /opts\.scope \?\? "all"/);
  });

  test("'open' is the only value that excludes archived rows", () => {
    assert.match(body, /const includeArchived = \(opts\.scope \?\? "all"\) === "all"/);
  });

  test("the archived guard is a bound boolean parameter, not interpolated SQL", () => {
    assert.match(body, /WHERE \(archived = false OR \$3::boolean\)/);
    assert.match(body, /\[like, limit, includeArchived\]/);
  });

  test("the row projection still carries metadata — the rail gauge divides by it", () => {
    // Round 3 added `metadata` to this SELECT so the rail could compute
    // context occupancy. Dropping it does not fail a typecheck; it silently
    // renders every gauge as absent, which is what the live :7700 (still on
    // main) does today.
    assert.match(body, /\n\s+metadata\n/);
  });
});

describe("deleteRun", () => {
  const body = functionBody("deleteRun");

  test("runs in one transaction with an explicit rollback", () => {
    assert.match(body, /await client\.query\("BEGIN"\)/);
    assert.match(body, /await client\.query\("COMMIT"\)/);
    assert.match(body, /await client\.query\("ROLLBACK"\)/);
  });

  test("removes the run row AND its embeddings, not one of the two", () => {
    assert.match(body, /DELETE FROM knowledge_embeddings/);
    assert.match(body, /DELETE FROM runs WHERE id = \$1/);
  });

  test("both deletes land before the COMMIT", () => {
    const commit = body.indexOf('client.query("COMMIT")');
    assert.ok(commit > 0, "no COMMIT in deleteRun");
    assert.ok(
      body.indexOf("DELETE FROM knowledge_embeddings") < commit,
      "the embeddings delete is outside the transaction",
    );
    assert.ok(
      body.indexOf("DELETE FROM runs") < commit,
      "the run delete is outside the transaction",
    );
  });

  test("the embeddings predicate covers chunk-suffixed source paths", () => {
    // The indexer writes `chat://<id>` for a whole chat and `chat://<id>#<n>`
    // per chunk. Matching only the exact path would leave every chunk behind
    // and the deleted chat would come back in the next semantic search — the
    // precise failure the brief calls out ("a deleted chat cannot come back
    // in a search result").
    assert.match(body, /source_path = 'chat:\/\/' \|\| \$1/);
    assert.match(body, /source_path LIKE 'chat:\/\/' \|\| \$1 \|\| '%'/);
  });

  test("it is scoped to ONE id — no bulk delete path exists", () => {
    assert.doesNotMatch(body, /DELETE FROM runs\b(?!\s+WHERE id = \$1)/);
    assert.doesNotMatch(body, /= ANY\(/);
  });
});

describe("archiveRun — the X must never destroy", () => {
  const body = functionBody("archiveRun");

  test("closing a chat is an UPDATE and issues no DELETE at all", () => {
    assert.match(body, /UPDATE runs/);
    assert.match(body, /SET archived = true/);
    assert.doesNotMatch(body, /DELETE/);
  });
});
