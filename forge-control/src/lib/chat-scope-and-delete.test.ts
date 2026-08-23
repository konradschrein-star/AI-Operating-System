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

/** The same source with its doc-comments removed. Any assertion that COUNTS
 *  occurrences across the whole file has to run against this: `deleteRun`'s
 *  own doc-comment quotes the SQL it replaced, so a naive count of
 *  `DELETE FROM runs` reads the documentation as a second delete path. Only
 *  block comments and whole-line `//` are stripped — a `//` inside a string
 *  literal (`'chat://' || …`) must survive, and it does. */
const RUNS_CODE = RUNS_SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

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

  test("'open' also excludes sub-runs — it must mean the same thing as the rail", () => {
    // Round 7's finding. `listRuns` is `archived = false AND parent_run_id IS
    // NULL`; "open" promised "runs still on the rail" but filtered only the
    // first half, so a term inside a worker thread returned a sub-run that the
    // rail cannot display. Both halves are now gated by the SAME bound
    // boolean, which is why they cannot drift apart again.
    assert.match(body, /AND \(parent_run_id IS NULL OR \$3::boolean\)/);
  });

  test("the two scope predicates are driven by one parameter, so they cannot diverge", () => {
    const archivedArm = /\(archived = false OR \$(\d)::boolean\)/.exec(body);
    const parentArm = /\(parent_run_id IS NULL OR \$(\d)::boolean\)/.exec(body);
    assert.ok(archivedArm, "the archived arm is gone from searchRuns");
    assert.ok(parentArm, "the parent_run_id arm is gone from searchRuns");
    assert.equal(
      archivedArm[1],
      parentArm[1],
      "the scope arms read different bound parameters — one can be widened without the other",
    );
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

  test("removes the run rows AND their embeddings, not one of the two", () => {
    assert.match(body, /DELETE FROM knowledge_embeddings/);
    assert.match(body, /DELETE FROM runs WHERE id = ANY\(\$1::uuid\[\]\)/);
  });

  test("the delete set is the whole parent_run_id subtree, not the one row", () => {
    // THE round-7 blocker. `runs_parent_run_id_fkey` is ON DELETE SET NULL, so
    // `DELETE FROM runs WHERE id = $1` does not delete a conversation — it
    // PROMOTES it: every sub-run reappears on the rail as a fresh top-level
    // chat with its embeddings still searchable. Measured on live data: run
    // 58096061 would have produced 10 of them carrying 38 chunks. Two review
    // rounds passed the feature because the proof used a CHILDLESS scratch run.
    assert.match(body, /resolveRunTree\(client, id\)/);
    assert.match(
      RUNS_SRC,
      /WITH RECURSIVE tree AS \(/,
      "the descendant walk is no longer a recursive CTE",
    );
    assert.match(
      RUNS_SRC,
      /JOIN tree ON r\.parent_run_id = tree\.id/,
      "the recursive term no longer follows parent_run_id",
    );
  });

  test("the embeddings predicate spans every run in the set, not just the target", () => {
    // Deleting the parent's chunks while leaving the children's behind is the
    // same resurrection by another door: the sub-run rows are gone but a
    // memory search still returns their text.
    assert.match(body, /source_path = ANY\(\$1::text\[\]\)/);
    assert.match(body, /source_path LIKE ANY\(\$2::text\[\]\)/);
  });

  test("a partial delete rolls back instead of leaving half a tree", () => {
    assert.match(body, /if \(runs\.rowCount !== ids\.length\)/);
    assert.match(body, /Rolling back rather than leaving a partial tree/);
  });

  test("the set is locked and re-resolved, so a late child cannot be orphaned", () => {
    // FOR UPDATE on every member conflicts with the KEY SHARE lock an FK
    // insert takes on its parent, so no new sub-run can attach once it is
    // held. The re-resolve catches one that landed just before the lock.
    assert.match(body, /FOR UPDATE/);
    assert.match(body, /const settled = await resolveRunTree\(client, id\)/);
    assert.match(body, /settled\.length !== planned\.length/);
  });

  test("a run still executing is refused, never deleted underneath its agent", () => {
    assert.match(body, /planned\.filter\(\(m\) => m\.status === "running"\)/);
    assert.match(body, /throw new RunStillRunningError\(running\)/);
  });

  test("project_tasks are counted and reported, never deleted", () => {
    // The other FK into `runs` is also SET NULL, and there it is correct: a
    // Kanban card outlives the thread. It must still be DISCLOSED — 685 rows
    // point at top-level runs, so a silent unlink is a card that quietly
    // stops linking anywhere.
    assert.match(body, /SELECT count\(\*\)::text AS count FROM project_tasks WHERE run_id = ANY/);
    assert.doesNotMatch(body, /DELETE FROM project_tasks/);
    assert.match(body, /tasks_unlinked/);
  });

  test("the recursive walk is depth-capped and refuses a truncated set", () => {
    // `parent_run_id` has no constraint forbidding a cycle, and an unbounded
    // recursive CTE on one would never return.
    assert.match(RUNS_CODE, /WHERE tree\.depth < \$\{RUN_TREE_MAX_DEPTH\}/);
    const walk = RUNS_CODE.slice(
      RUNS_CODE.indexOf("async function resolveRunTree"),
      RUNS_CODE.indexOf("export async function planRunDeletion"),
    );
    assert.match(
      walk,
      /rows\.some\(\(row\) => row\.depth >= RUN_TREE_MAX_DEPTH\)/,
      "nothing checks whether the cap was reached",
    );
    assert.match(
      walk,
      /throw new Error\(/,
      "hitting the depth cap must throw, not silently delete a partial tree",
    );
  });

  test("both deletes land before the COMMIT that ends the delete", () => {
    // lastIndexOf, not indexOf: the not-found path COMMITs an empty
    // transaction and returns early, and that COMMIT is textually first.
    const commit = body.lastIndexOf('client.query("COMMIT")');
    assert.ok(commit > 0, "no COMMIT in deleteRun");
    assert.ok(
      body.indexOf("DELETE FROM knowledge_embeddings") < commit,
      "the embeddings delete is outside the transaction",
    );
    assert.ok(
      body.indexOf("DELETE FROM runs") < commit,
      "the run delete is outside the transaction",
    );
    assert.ok(
      body.indexOf("DELETE FROM knowledge_embeddings") <
        body.indexOf("DELETE FROM runs"),
      "the runs delete runs first — a failure after it would erase the search " +
        "trail of chats that survived",
    );
  });

  test("the embeddings predicate covers chunk-suffixed source paths", () => {
    // The indexer writes `chat://<id>` for a whole chat and `chat://<id>#<n>`
    // per chunk. Matching only the exact path would leave every chunk behind
    // and the deleted chat would come back in the next semantic search — the
    // precise failure the brief calls out ("a deleted chat cannot come back
    // in a search result"). Both arms are now arrays over the whole subtree,
    // so the assertion is on the pair passed to them.
    assert.match(body, /ids\.map\(chatSourcePath\)/);
    assert.match(body, /ids\.map\(\(i\) => `\$\{chatSourcePath\(i\)\}%`\)/);
    assert.match(RUNS_CODE, /return `chat:\/\/\$\{runId\}`/);
  });

  test("it is scoped to ONE named chat — no bulk delete path exists", () => {
    // The set widened from one row to one SUBTREE, so "no bulk delete" can no
    // longer be spelled "no = ANY". What still holds, and is what the brief
    // means by "never bulk-delete, never delete anything the user did not
    // name": the array bound to the DELETE is `ids`, and `ids` is derived from
    // exactly one place — the tree rooted at the single id passed in.
    assert.match(body, /const ids = planned\.map\(\(m\) => m\.id\)/);
    assert.match(body, /DELETE FROM runs WHERE id = ANY\(\$1::uuid\[\]\)`, \[ids\]\)/);
    // No second source of ids, and no predicate over anything but that array.
    assert.doesNotMatch(body, /DELETE FROM runs(?! WHERE id = ANY\(\$1::uuid\[\]\))/);
    assert.doesNotMatch(body, /WHERE archived/);
    assert.doesNotMatch(body, /WHERE status/);
  });

  test("only one function in db/runs.ts deletes run rows at all", () => {
    const deletes = RUNS_CODE.match(/DELETE FROM runs\b/g) ?? [];
    assert.equal(
      deletes.length,
      1,
      `expected exactly one DELETE FROM runs in db/runs.ts, found ${deletes.length}`,
    );
  });
});

describe("planRunDeletion — the modal's numbers are measured, not assumed", () => {
  const body = functionBody("planRunDeletion");

  test("it is read-only", () => {
    assert.doesNotMatch(body, /\bDELETE\b/);
    assert.doesNotMatch(body, /\bUPDATE\b/);
    assert.doesNotMatch(body, /\bINSERT\b/);
    assert.doesNotMatch(body, /BEGIN/);
  });

  test("it walks the same subtree the delete will remove", () => {
    // If the preview and the delete resolved the set two different ways, the
    // modal would be exact about a number the delete does not honour — worse
    // than the round "1 PostgreSQL row" it replaced, because it looks checked.
    assert.match(body, /resolveRunTree\(client, id\)/);
  });

  test("it reports descendants, embeddings, linked tasks and live runs", () => {
    assert.match(body, /descendants: tree\.filter\(\(m\) => m\.depth > 0\)/);
    assert.match(body, /FROM knowledge_embeddings/);
    assert.match(body, /FROM project_tasks/);
    assert.match(body, /running: tree\.filter\(\(m\) => m\.status === "running"\)/);
  });

  test("a missing run is a null, not an empty plan that reads as 'nothing to delete'", () => {
    assert.match(body, /if \(!self\)/);
    assert.match(body, /return \{ run: null/);
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
