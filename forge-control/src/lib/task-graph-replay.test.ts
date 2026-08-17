/**
 * THE REPLICA PROOF (R18) — does the graph schedule exactly what the round
 * numbers schedule today?
 *
 * Run: pnpm test   (node:test via tsx, no test framework dependency)
 *
 * Its own file, separate from `task-graph.test.ts`, because it is the single
 * most important test in the project and must be findable
 * (`03-quality.md` §2.1).
 *
 * The claim it exists to prove: migration `0040_task_graph.sql` turns today's
 * round ordering into `depends_on` edges WITHOUT changing what the engine does.
 * The proof is a replay — the real task list of `operator-visibility` (the R9
 * fixture) driven through a simulated tick loop twice, once under
 * `legacyRoundReady()` and once under `graphReady()` over the backfilled
 * closure, asserting the same tasks are promoted on the same tick, every tick.
 *
 * TWO ORDERS, NOT ONE (R18 case (f), F13). A row can join the task list either
 * side of the migration, and the two are not the same scenario:
 *
 *  - MIGRATE-AFTER-INSERT — the row existed when 0040 ran, so the backfill gave
 *    it a closure and named it in every higher row's closure. Cases (b) and (c).
 *  - INSERT-AFTER-MIGRATE — the OLD engine inserted it in the gap between
 *    `psql -f` and the executor restart (R64). It is born `depends_on IS NULL`,
 *    and no already-frozen closure names it, because it did not exist when they
 *    were computed. Case (f).
 *
 * `graphInput()` therefore takes an explicit MIGRATION-TIME SNAPSHOT: rows in it
 * get the closure computed over the snapshot ALONE, rows outside it get
 * `depends_on: null`. Closing over the whole mutated list — which this harness
 * did until round 106 — can only ever model the first order, so the divergence
 * the second one produces was invisible to all five original cases. Round 105's
 * reviewer found that; R69 (the legacy-row term on the graph branch) is the
 * ruling that closes it, and case (f) is what fails without it.
 *
 * PHASE 2 STATE — the six cases are LIVE. Through phase 1 `graphReady()` threw,
 * so all six R18 comparison cases (a–f) carried a `{ todo: … }` option with
 * their BODIES WRITTEN IN FULL, and the contract was that phase 2 deletes the
 * option and nothing else. Phase 2 has landed and this file honours that
 * contract exactly: the six `todo` options are gone, the six bodies are
 * unchanged from the text phase 1 committed, and no expected value was moved.
 * They now pass — the evidence, per case, is
 * `docs/plan/engine-task-graph/evidence/phase2-replay.md`.
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY (standing rule 3;
 * `03-quality.md` §3.2 Phase 2 requires the reviewer to answer this):
 *
 *  1. A fixture whose every task is already `done` — nothing would ever be
 *     promoted and two empty schedules would compare equal. Guarded twice: the
 *     banner prints the status histogram, and `assertReplica()` fails unless
 *     the LEGACY side promoted at least one task.
 *  2. A tick loop that terminates before the divergence — a short schedule
 *     compared against another short schedule. Guarded by the tick cap, which
 *     THROWS on being hit instead of returning what it has, and by the
 *     quiescence rule requiring both "nothing promoted" and "nothing running".
 *  3. A "legacy" side secretly reading the backfilled array rather than the
 *     round rule. Guarded structurally: `legacyInput()` and `graphInput()` are
 *     built separately from the same rows, the legacy side's `depends_on` is
 *     `null` throughout, and the graph side's `round` is `ROUND_WITHHELD`
 *     (−1) on every row — so a graph side that ever applied the round rule
 *     promotes EVERYTHING on tick 1 and case (a) fails loudly.
 *
 *     AMENDED IN ROUND 106, WHERE IT IS ENFORCED (standing rule 2): the
 *     withholding holds only for a PURE-GRAPH input. A MIXED input — case (f),
 *     frozen rows beside post-migration legacy rows — must carry real rounds on
 *     both sides, because R69's legacy-row term IS a round predicate and a
 *     withheld round would make it unevaluable, so case (f) would fail for a
 *     reason that is an artefact of the instrument. `graphInput()` decides this
 *     from its OWN OUTPUT (withhold iff no row came out legacy), not from
 *     whether an option was passed, and the test below asserts both directions.
 *     The guard is not weakened, only relocated: cases (a)–(e) are pure-graph
 *     and still withhold, so a `graphReady()` that quietly applied the round
 *     rule is still caught loudly there — by five cases instead of six.
 *  4. A harness whose build identity is unknown — the banner prints the fixture
 *     path, its row count, its sha256 cross-checked against the capture
 *     record's own sha, `git rev-parse --short HEAD`, and whether the two files
 *     that define this instrument are dirty against that HEAD. A sha naming the
 *     worktree rather than the build is the failure this last line answers.
 *  5. A CLAIM CREDITED TO THIS PROOF THAT IT DOES NOT PERFORM — found in round
 *     203 and struck in 204. Four places (this list's own subject aside:
 *     `conflicts()`, `claimReadyTasks()`, R17 in `01-requirements.md`, and §9 of
 *     `evidence/phase2-replay.md`) said the replay proved R17's contention
 *     clause, because every fixture row carries an empty `write_set`. It does
 *     not. THIS FILE SCHEDULES ONLY, and the boundary is worth stating rather
 *     than leaving to be inferred from an import list:
 *       - IT PROVES: that `graphReady()` over the backfilled closure promotes
 *         exactly what `legacyRoundReady()` over the round rule promotes, tick
 *         for tick, across the six R18 cases.
 *       - IT IS SILENT ABOUT: contention and the claim path. `conflicts()` and
 *         `selectClaimable()` are not imported here, and `simulate()` moves rows
 *         `pending → running` with no claim step, so no write-set of any shape
 *         is ever consulted. Measured: inverting `conflicts()`'s empty-set rule
 *         to `return true` leaves all 35 tests in this file green.
 *       - WHERE THAT HALF IS PROVED: `conflicts()`/`selectClaimable()`'s table
 *         cases in `task-graph.test.ts`, and case 7 of
 *         `scripts/checks/check-scheduler-sql.sh`, which drives the shipped
 *         `claimReadyTasks()` against a real Postgres.
 *     An import added here that changes that is a change to what this file
 *     claims, and the paragraph above must change with it.
 *
 * NF3: `db/*` is imported TYPE-ONLY. A value import would open a pg Pool in the
 * test process; this suite runs with Postgres stopped.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  legacyRoundReady,
  graphReady,
  readyRule,
  computeRound,
  findCycle,
  groupKey,
  normaliseWritePath,
  validateWorkstream,
  type GraphTask,
} from "./task-graph.ts";
import type { TaskStatus } from "../db/projects.ts";

/* -------------------------------------------------------------------------- *
 * The fixture, and its provenance
 * -------------------------------------------------------------------------- */

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE_REL = "forge-control/src/lib/fixtures/replay-operator-visibility.json";
const FIXTURE_URL = new URL("./fixtures/replay-operator-visibility.json", import.meta.url);
const RECORD_URL = new URL("./fixtures/replay-operator-visibility.md", import.meta.url);

/**
 * The six projected columns of R9, and NOTHING else. The closed key set is what
 * makes "no brief text, no prompts, no run ids, no secrets" a mechanical
 * property rather than a promise (`03-quality.md` §3.2, Phase 1, as amended at
 * capture).
 */
interface FixtureRow {
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
  created_at: string;
}

const FIXTURE_KEYS = ["created_at", "id", "role", "round", "status", "title"] as const;

// FIXTURE_URL pattern per perplexity-cli.test.ts — NOT a JSON module import,
// which isolatedModules + `tsx --test` do not support.
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, "utf8");
const FIXTURE = JSON.parse(FIXTURE_TEXT) as FixtureRow[];
const FIXTURE_SHA256 = createHash("sha256").update(FIXTURE_TEXT, "utf8").digest("hex");

/**
 * The sha256 the capture record (`replay-operator-visibility.md` §1) claims for
 * the JSON beside it. Read from the record rather than hardcoded here, so the
 * harness cross-checks the fixture against its own receipt instead of against a
 * number a later editor could quietly update in one place.
 */
function recordedSha256(): string {
  const md = readFileSync(RECORD_URL, "utf8");
  const m = md.match(/`sha256\(\.json\)`\s*\|\s*`([0-9a-f]{64})`/);
  if (!m) {
    throw new Error(
      `task-graph-replay: capture record ${RECORD_URL.pathname} carries no ` +
        "`sha256(.json)` row; the fixture's provenance cannot be checked (R9)",
    );
  }
  return m[1];
}

/** `git rev-parse --short HEAD` of the worktree this harness is running from. */
function gitShort(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (err) {
    // No silent "unknown" (NF1): a harness that cannot state its build identity
    // is not evidence, and standing rule 3 makes that a hard failure, not a
    // footnote.
    throw new Error(
      `task-graph-replay: cannot resolve build identity — ` +
        `git rev-parse --short HEAD failed in ${REPO_ROOT}: ${(err as Error).message}`,
    );
  }
}

/**
 * Which of the two files that DEFINE this instrument differ from HEAD. A sha
 * that names the worktree rather than the build was one of the ways the
 * previous project's instruments lied; this line is the difference.
 */
function dirtyInstrumentFiles(): string {
  const out = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      FIXTURE_REL,
      "forge-control/src/lib/task-graph.ts",
      "forge-control/src/lib/task-graph-replay.test.ts",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
  ).trim();
  return out === "" ? "(none — all three match HEAD)" : out.replace(/\n/g, " | ");
}

function statusHistogram(rows: readonly FixtureRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([s, n]) => `${s}=${n}`)
    .join(" ");
}

/* -------------------------------------------------------------------------- *
 * BUILD IDENTITY — printed at import, before the first assertion runs
 * (standing rule 3; R18: "prints the fixture row count and its own git SHA
 * before asserting"). Phase 2's reviewer is required to read this banner.
 * -------------------------------------------------------------------------- */

console.log(`task-graph-replay: FIXTURE  ${FIXTURE_REL}`);
console.log(`task-graph-replay: ROWS     ${Array.isArray(FIXTURE) ? FIXTURE.length : "NOT-AN-ARRAY"}`);
console.log(`task-graph-replay: SHA256   ${FIXTURE_SHA256}`);
console.log(
  `task-graph-replay: RECORD   ${recordedSha256() === FIXTURE_SHA256 ? "sha matches capture record" : "SHA MISMATCH vs capture record"}`,
);
console.log(`task-graph-replay: STATUS   ${statusHistogram(FIXTURE)}`);
console.log(`task-graph-replay: HEAD     ${gitShort()}`);
console.log(`task-graph-replay: DIRTY    ${dirtyInstrumentFiles()}`);

/* -------------------------------------------------------------------------- *
 * The backfill, mirrored in TypeScript
 * -------------------------------------------------------------------------- */

/** The columns the closure reads. Deliberately narrower than `FixtureRow`. */
interface ClosureRow {
  id: string;
  round: number;
  created_at: string;
}

/**
 * The TypeScript MIRROR of `0040_task_graph.sql`'s backfill UPDATE, which is
 * written out in `02-architecture.md` §3.3: for each task, the ids of every
 * task of the SAME PROJECT in a strictly lower round, ordered by
 * `(round, created_at, id)`.
 *
 *     UPDATE project_tasks pt
 *        SET depends_on = COALESCE((
 *              SELECT array_agg(e.id ORDER BY e.round, e.created_at, e.id)
 *                FROM project_tasks e
 *               WHERE e.project_id = pt.project_id
 *                 AND e.round < pt.round
 *            ), '{}'::uuid[])
 *      WHERE pt.depends_on IS NULL;
 *
 * THREE IMPLEMENTATIONS OF ONE RULE ARE A DIVERGENCE RISK, and naming it is how
 * it stays honest: **phase 2's reviewer must diff this function against
 * `db/migrations/0040_task_graph.sql` and say in the review that it did.** If
 * the SQL changes and this does not, the replay proves the wrong thing while
 * still reporting green. The third is the Python `expected` closure inside
 * `scripts/checks/check-migration-0040.sh` §5, which recomputes the same rule
 * to verify the migration against the database; it uses the same sort key and
 * the same strictly-lower-round filter, and it too moves when the SQL moves.
 * The independent check this function is NOT allowed to lean on is its own
 * output — hence the test below asserts membership and ordering from the
 * fixture's rounds directly rather than against another implementation.
 *
 * Not mirrored, deliberately: the `WHERE pt.depends_on IS NULL` guard (every
 * row in this harness is a pre-migration row by construction) and
 * `e.project_id = pt.project_id` (the fixture is one project — the same
 * precondition `legacyRoundReady()` documents).
 *
 * ORDERING. Postgres orders `created_at` chronologically and `id` by uuid
 * bytes. Both are reproduced here by plain string comparison, which is exact
 * for this data rather than approximately right:
 *  - `created_at` is fixed-width ISO-8601 through the seconds and carries the
 *    SAME `+00:00` offset on every row (asserted below), so digits compare
 *    positionally; where Postgres trimmed trailing zeros from the fractional
 *    part, the terminating `+` (0x2B) sorts before every digit, which is what
 *    numeric comparison of a truncated fraction does too.
 *  - a canonical lowercase uuid text is fixed-width with hyphens at fixed
 *    positions, so its lexicographic order is its byte order.
 * `Date.parse` was rejected: it truncates the microseconds Postgres orders on.
 *
 * EXPORTED, in phase 2, for the THREE-WAY DIFF and for nothing else. The diff
 * described above is a requirement of this phase, and a diff that re-types this
 * function into a scratch script compares the script against the SQL — not this
 * function against the SQL — which is precisely the mistake the paragraph above
 * warns about. So the real symbol is exported and called. The comparison itself
 * is not a unit test because its third input is a Postgres database, which
 * `pnpm test` must never touch (NF3); it lives in
 * `evidence/phase2-replay.md` §4, with the transcript and the command.
 */
export function backfillClosure(tasks: readonly ClosureRow[]): Map<string, string[]> {
  const ordered = [...tasks].sort(
    (a, b) =>
      a.round - b.round ||
      (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const closure = new Map<string, string[]>();
  for (const t of tasks) {
    closure.set(
      t.id,
      ordered.filter((e) => e.round < t.round).map((e) => e.id),
    );
  }
  return closure;
}

/* -------------------------------------------------------------------------- *
 * The two inputs, built SEPARATELY from the same rows
 * -------------------------------------------------------------------------- */

/**
 * The graph side's `round`. Every scheduling input the graph rule is allowed to
 * read is `depends_on` and `status`; withholding `round` makes "the graph side
 * is secretly applying the round rule" a LOUD failure rather than a silent
 * pass — with every round equal, no row has a strictly lower round, so the
 * legacy rule would promote every pending task on tick 1 and case (a) diverges
 * on its first tick.
 */
const ROUND_WITHHELD = -1;

/** Fixture status → the scheduler's vocabulary, unchanged. */
function toStatus(raw: string): TaskStatus {
  const known: readonly TaskStatus[] = ["pending", "ready", "running", "done", "failed", "blocked"];
  const hit = known.find((s) => s === raw);
  if (!hit) {
    throw new Error(`task-graph-replay: fixture row carries unknown status '${raw}' (R9)`);
  }
  return hit;
}

/**
 * TODAY's input: rounds intact, `depends_on` NULL on every row — the legacy
 * sentinel (`02-architecture.md` §2.2). Nothing here can see the closure.
 */
function legacyInput(rows: readonly FixtureRow[]): GraphTask[] {
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    workstream: "main",
    status: toStatus(r.status),
    depends_on: null,
    write_set: [],
  }));
}

interface GraphInputOptions {
  /**
   * The ids that existed AT MIGRATION TIME — the rows `0040_task_graph.sql`'s
   * backfill could see, and therefore the only rows any frozen closure can
   * name. Omitted means "every row was there", i.e. migrate-after-insert, which
   * is what cases (a)–(e) model.
   */
  snapshot?: ReadonlySet<string>;
}

/**
 * THE GRAPH's input: `depends_on` from the closure, `round` withheld where it
 * can be. Built from `rows` directly — not from `legacyInput()`'s output — so
 * the two sides share their ground truth and nothing else.
 *
 * THE SNAPSHOT IS THE POINT. The backfill runs ONCE, at a moment, over the rows
 * that exist at that moment (R6). A row inserted afterwards by the old engine is
 * born `depends_on IS NULL` (E2) and is named by NO frozen closure — not because
 * anything is wrong, but because it did not exist to be named. Computing the
 * closure over the post-mutation list, as this function did until round 106,
 * silently repairs that gap and makes the divergence R69 exists to close
 * invisible to the very test that is supposed to find it.
 *
 * ROUND WITHHOLDING is decided from the OUTPUT, not from the options: withheld
 * on a pure-graph input, real on a mixed one. See the header, guard 3. Deciding
 * it from `opts.snapshot` instead would let a caller passing a snapshot of every
 * id get real rounds by accident and quietly lose the guard.
 */
function graphInput(rows: readonly FixtureRow[], opts: GraphInputOptions = {}): GraphTask[] {
  const present = new Set(rows.map((r) => r.id));
  const snapshotIds = opts.snapshot ?? present;
  for (const id of snapshotIds) {
    if (!present.has(id)) {
      throw new Error(
        `task-graph-replay: the migration-time snapshot names task ${id}, which is not in the row list — ` +
          "the snapshot must be a subset of the rows, or the closure is computed over a graph that never existed",
      );
    }
  }
  const frozen = rows.filter((r) => snapshotIds.has(r.id));
  if (frozen.length === 0) {
    throw new Error(
      "task-graph-replay: the migration-time snapshot is empty — every row would be legacy and the graph side " +
        "would be testing nothing",
    );
  }

  // The closure sees the SNAPSHOT and nothing else — exactly what the UPDATE saw.
  const closure = backfillClosure(frozen);
  const built: GraphTask[] = rows.map((r) => {
    const base = {
      id: r.id,
      round: r.round,
      workstream: "main",
      status: toStatus(r.status),
      write_set: [],
    };
    if (!snapshotIds.has(r.id)) {
      // Inserted after 0040 ran, by an INSERT that does not name the column.
      return { ...base, depends_on: null };
    }
    const deps = closure.get(r.id);
    if (!deps) {
      throw new Error(`task-graph-replay: closure produced no entry for task ${r.id}`);
    }
    return { ...base, depends_on: deps };
  });

  const mixed = built.some((t) => t.depends_on === null);
  return mixed ? built : built.map((t) => ({ ...t, round: ROUND_WITHHELD }));
}

/* -------------------------------------------------------------------------- *
 * The tick loop
 * -------------------------------------------------------------------------- */

/**
 * The non-terminal, already-promoted states. A row in either will finish; a row
 * in neither is `pending` (awaiting promotion) or terminal (`done`, `failed`,
 * `blocked`).
 */
const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["ready", "running"]);

interface RuleContext {
  all: readonly GraphTask[];
  byId: ReadonlyMap<string, GraphTask>;
}

type PromotionRule = (task: GraphTask, ctx: RuleContext) => boolean;

const LEGACY_RULE: PromotionRule = (t, ctx) => legacyRoundReady(t, ctx.all);

/**
 * The NEW engine's rule, which is BOTH branches of `promoteReadyTasks()`'s one
 * statement (`02-architecture.md` §3.1), dispatched through `readyRule()` —
 * the only place the `depends_on` NULL sentinel is interpreted (R12).
 *
 * Dispatching here rather than inside `graphReady()` is deliberate. A mixed
 * input (case (f)) contains legacy rows, and a legacy row is promoted by the
 * LEGACY branch, not by a `graphReady()` quietly widened to understand NULL.
 * Keeping the sentinel in one place is the property that lets the whole legacy
 * surface be deleted in one commit. TODO(R12-retire) — after which this
 * collapses back to `graphReady(t, ctx.byId)`.
 *
 * In phase 1 `readyRule()` throws first, so the six comparison cases report
 * `task-graph: readyRule() lands in phase 2 (R12)` rather than `graphReady`'s
 * message. That is the dispatch being exercised, not a regression.
 */
const GRAPH_RULE: PromotionRule = (t, ctx) =>
  readyRule(t) === "graph" ? graphReady(t, ctx.byId) : legacyRoundReady(t, ctx.all);

interface SimOptions {
  /**
   * Ticks (1-based) on which the project is NOT `active`. Models R18 case (d):
   * `promoteReadyTasks()`'s `AND p.status = 'active'` is the CALLER's gate on a
   * joined `projects` row, never a per-task predicate (R13 — `E7`/`R8` is
   * `db/projects.ts`'s lineage pin on `main`, not a citation in this corpus),
   * so a pause
   * suppresses promotion only — runs already in flight still settle.
   */
  pausedTicks?: ReadonlySet<number>;
}

interface SimResult {
  /** Per tick, the SET of ids promoted, sorted so a set compares as a set. */
  schedule: string[][];
  ticks: number;
  promotedTotal: number;
  /** Terminal status of every task, keyed by id — the wedge, for case (e). */
  finalStatus: Map<string, TaskStatus>;
}

/**
 * Tick until quiescent, recording per tick the SET of task ids promoted.
 *
 * The tick, in order:
 *  1. evaluate `rule` against the state AS IT WAS AT TICK START and promote
 *     every `pending` task it accepts — one snapshot, because
 *     `promoteReadyTasks()` is a single set-based UPDATE and two tasks
 *     promoted on the same tick therefore cannot see each other;
 *  2. the promoted tasks become `running`;
 *  3. the tasks that were ALREADY IN FLIGHT at tick start become `done`.
 *
 * So a task promoted on tick k is in flight through tick k+1, becomes `done` at
 * the END of tick k+1, and is therefore first visible as `done` to the
 * promotion evaluated on tick k+2. The schedule consequently alternates between
 * a promoting tick and an empty one, and those empty ticks are RECORDED rather
 * than compressed away: they are where the engine is waiting on a run, and
 * squeezing them out would hide the very latency this project exists to
 * measure.
 *
 * Settling before promoting instead would let every in-flight row of the
 * fixture vanish before the first promotion is evaluated — the retried task in
 * case (b) would never be seen blocking anything, and the case that
 * distinguishes the closure backfill from a previous-round-only one would
 * quietly stop distinguishing them.
 *
 * IN FLIGHT IS `ready` OR `running`, and the distinction is deliberately
 * collapsed to one tick. Both are states the engine reaches only by having
 * promoted the row — `ready` is claimed-but-not-yet-spawned — so both are rows
 * that will finish, and neither is `done` yet. Treating `ready` as terminal
 * instead is not a modelling nicety: it wedges every higher round forever, and
 * it is exactly what `retryTask()` produces, which is R18 case (b)'s whole
 * input. (Found the hard way — the case's legacy half failed with "the
 * inserted 1292 task was never promoted at all" until this rule was stated.)
 *
 * `failed` and `blocked` rows are terminal: never promoted, never settled,
 * never `done`. That is the wedge R18 case (e) requires both schedulers to
 * reproduce identically.
 *
 * Fully deterministic: no wall clock, no randomness, no `Date.now`.
 *
 * TERMINATION IS ASSERTED, NOT HOPED FOR. The cap is `rowCount + 2` — one tick
 * per row is the worst case of a total ordering, plus the settling tick and the
 * quiescent tick — and hitting it THROWS. A tick loop that quietly returns a
 * short schedule is one of the named ways this instrument could report a pass
 * wrongly (`03-quality.md` §3.2, Phase 2).
 */
function simulate(
  tasks: readonly GraphTask[],
  rule: PromotionRule,
  opts: SimOptions = {},
): SimResult {
  const paused = opts.pausedTicks ?? new Set<number>();
  const state = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));
  const cap = tasks.length + 2;
  const schedule: string[][] = [];
  let promotedTotal = 0;

  for (let tick = 1; tick <= cap; tick++) {
    // The tick-start snapshot both the rule and the settle step read.
    const snapshot = tasks.map((t) => {
      const status = state.get(t.id);
      if (!status) {
        throw new Error(`task-graph-replay: simulate() lost the state of task ${t.id} — duplicate ids in the input?`);
      }
      return { ...t, status };
    });
    const ctx: RuleContext = {
      all: snapshot,
      byId: new Map(snapshot.map((t) => [t.id, t])),
    };
    const inFlight = snapshot.filter((t) => IN_FLIGHT.has(t.status)).map((t) => t.id);

    const promoted = paused.has(tick)
      ? []
      : snapshot.filter((t) => t.status === "pending" && rule(t, ctx)).map((t) => t.id);

    for (const id of promoted) state.set(id, "running");
    for (const id of inFlight) state.set(id, "done");

    schedule.push([...promoted].sort());
    promotedTotal += promoted.length;

    if (!paused.has(tick) && promoted.length === 0 && inFlight.length === 0) {
      return { schedule, ticks: tick, promotedTotal, finalStatus: state };
    }
  }

  throw new Error(
    `task-graph-replay: simulate() hit its tick cap of ${cap} over ${tasks.length} ` +
      `tasks without reaching quiescence — the schedule is INCOMPLETE and must not ` +
      `be compared. Promoted so far: ${promotedTotal}. ` +
      `Last tick: [${schedule[schedule.length - 1]?.join(", ") ?? ""}]`,
  );
}

/* -------------------------------------------------------------------------- *
 * Comparison
 * -------------------------------------------------------------------------- */

/**
 * A validation function for `assert.throws` that tests the error's MESSAGE.
 *
 * A bare RegExp as the second argument to `assert.throws` is matched against
 * the error's *string representation* — `"Error: task-graph: …"` — so
 * `/^task-graph:/` would never match and every stub case would report a
 * failure that reads like a missing throw. This is the same gate, enforced
 * where it is actually checkable (standing rule 2).
 */
function throwsMessageMatching(pattern: RegExp, what: string): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(err instanceof Error, `${what}() threw a non-Error: ${String(err)}`);
    assert.match(err.message, pattern, `${what}() threw without the expected diagnostic prefix`);
    return true;
  };
}

function formatDivergence(legacy: SimResult, graph: SimResult): string {
  const ticks = Math.max(legacy.schedule.length, graph.schedule.length);
  for (let i = 0; i < ticks; i++) {
    const l = legacy.schedule[i] ?? [];
    const g = graph.schedule[i] ?? [];
    if (l.join(",") === g.join(",")) continue;
    const onlyLegacy = l.filter((id) => !g.includes(id));
    const onlyGraph = g.filter((id) => !l.includes(id));
    return (
      `first divergence on tick ${i + 1}: ` +
      `legacy promoted [${l.join(", ")}], graph promoted [${g.join(", ")}]; ` +
      `only-legacy [${onlyLegacy.join(", ")}]; only-graph [${onlyGraph.join(", ")}]`
    );
  }
  return `schedules agree tick by tick but differ in length (legacy ${legacy.schedule.length}, graph ${graph.schedule.length})`;
}

/**
 * The assertion R18 names: the same set of tasks promoted on the same tick, for
 * every tick, plus the same terminal state.
 *
 * The `promotedTotal > 0` guard is not decoration. Two empty schedules compare
 * equal, so a fixture in which nothing can ever be promoted would certify the
 * replica while proving nothing — the first of the four ways this instrument
 * could lie.
 */
interface ReplicaOptions extends SimOptions, GraphInputOptions {}

/**
 * Every comparison this file performs, keyed by its label, recorded by
 * `assertReplica()` from the RUN IT ASSERTED ON — never re-simulated afterwards
 * for reporting.
 *
 * Why it exists: `evidence/phase2-replay.md` has to state a tick count and a
 * promotion total per case on BOTH sides, and round 103 predicted those numbers
 * from an independent throwaway model before any of this ran. A number a builder
 * re-derives in a scratch script beside the test is a number nobody can check;
 * these come out of the harness's own mouth, on the same input, in the same
 * process, and `"the round-103 prediction"` below pins them so a later edit to
 * `simulate()`'s ordering fails LOUDLY instead of quietly proving nothing —
 * the same argument as the base schedule's pinned 14.
 *
 * Recorded BEFORE the assertions, deliberately: a diverging case must still
 * leave its numbers behind for the report.
 */
const MEASURED = new Map<string, { legacy: SimResult; graph: SimResult }>();

function assertReplica(label: string, rows: readonly FixtureRow[], opts: ReplicaOptions = {}): void {
  const legacy = simulate(legacyInput(rows), LEGACY_RULE, opts);
  const graph = simulate(graphInput(rows, opts), GRAPH_RULE, opts);
  MEASURED.set(label, { legacy, graph });

  assert.ok(
    legacy.promotedTotal > 0,
    `${label}: the legacy side promoted NOTHING — the comparison would be vacuous`,
  );
  assert.deepEqual(
    graph.schedule,
    legacy.schedule,
    `${label}: promotion order diverged — ${formatDivergence(legacy, graph)}`,
  );
  assert.deepEqual(
    [...graph.finalStatus.entries()].sort(),
    [...legacy.finalStatus.entries()].sort(),
    `${label}: the two schedulers ended in different terminal states`,
  );
}

/* -------------------------------------------------------------------------- *
 * Row surgery for the R18 cases
 * -------------------------------------------------------------------------- */

/** A fresh, independent copy of the fixture — every case mutates its own. */
const rows = (): FixtureRow[] => structuredClone(FIXTURE);

/**
 * Pick exactly one row, or throw naming what was looked for. A case built on a
 * row that silently was not there is a case that asserts nothing.
 */
function pickRow(all: readonly FixtureRow[], want: (r: FixtureRow) => boolean, description: string): FixtureRow {
  const hits = all.filter(want);
  if (hits.length === 0) {
    throw new Error(`task-graph-replay: no fixture row matches ${description}`);
  }
  return [...hits].sort(
    (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : 1),
  )[0];
}

/**
 * A task inserted after the fixture was captured. Synthetic ids are canonical
 * v4-shaped uuids so `backfillClosure()`'s id ordering behaves exactly as
 * Postgres' would, and `created_at` is later than every captured row
 * (the newest is 2026-08-17T03:51:57Z).
 */
function insertedTask(id: string, round: number, over: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id,
    round,
    role: "builder",
    title: "inserted by the replay harness",
    status: "pending",
    created_at: "2026-08-17T09:00:00+00:00",
    ...over,
  };
}

/** (a) The base fixture, straight through. */
export function caseA(): FixtureRow[] {
  return rows();
}

/**
 * (b) An early-round task retried to `ready` after a later round has drained,
 * with a task then inserted into a round above it. MIGRATE-AFTER-INSERT: the
 * inserted row is part of the migration-time snapshot, so the backfill sees it
 * and every higher closure names it. Case (f) is the other order.
 *
 * This is `02-architecture.md` §3.3's own scenario, and the case that kills a
 * previous-round-only backfill: rounds 1290/1291/1292 are all drained; an
 * operator retries the 1290 planner back to `ready` (`retryTask()` sets exactly
 * that status); a task is added at 1292. Under today's rule the new task is NOT
 * promotable, because *every* strictly lower round must be `done` and 1290 is
 * not. Under a previous-round-only backfill it would depend on 1291 alone,
 * which is `done`, and would promote a tick early. The divergence window is
 * tick 1 — the retried task settles at the end of it — and one tick is all a
 * set-per-tick comparison needs to fail.
 */
export function caseB(): FixtureRow[] {
  const all = rows();
  const retried = pickRow(all, (r) => r.round === 1290 && r.status === "done", "round 1290, status done");
  retried.status = "ready";
  all.push(insertedTask("00000000-0000-4000-8000-00000000000b", 1292));
  return all;
}

/**
 * (c) A task inserted into an already-drained round — the control for (b),
 * without the retry. Every round below 1292 is `done` at capture, so both
 * schedulers must promote it on tick 1: the legacy rule because no strictly
 * lower round holds a non-`done` task, the graph rule because the closure
 * computed over the MUTATED row list gives it exactly those rows as
 * dependencies and all of them are `done`.
 *
 * MIGRATE-AFTER-INSERT, like (b), and deliberately so: this is the row the
 * migration ran *over*. The same insertion in the other order is case (f), and
 * the two do not have the same answer.
 */
export function caseC(): FixtureRow[] {
  const all = rows();
  all.push(insertedTask("00000000-0000-4000-8000-00000000000c", 1292));
  return all;
}

/**
 * (d) is not a row mutation — a pause is a gate on the joined project row, not
 * a task state — so it is expressed as `SimOptions.pausedTicks`.
 */
const PAUSED_TICKS = new Set([3, 4]);

/**
 * (e) A permanently failed task. The lowest-round `pending` row is failed
 * outright: its own round's sibling still promotes (a same-round task is not a
 * strictly lower one, and is not a dependency either), and everything above it
 * wedges forever. Both schedulers must wedge on the SAME set of rows.
 */
export function caseE(): FixtureRow[] {
  const all = rows();
  const lowestPendingRound = Math.min(...all.filter((r) => r.status === "pending").map((r) => r.round));
  const doomed = pickRow(
    all,
    (r) => r.status === "pending" && r.round === lowestPendingRound,
    `the lowest-round pending row (round ${lowestPendingRound})`,
  );
  doomed.status = "failed";
  return all;
}

/**
 * (f) INSERT-AFTER-MIGRATE — the fix chain the OLD engine inserts in the gap
 * between `psql -f 0040` (R64) and the executor restart, which `safe-restart.sh`
 * may leave open for up to 43200 seconds.
 *
 * `createFixChain` in `db/projects.ts` reconciles a `NEEDS_FIXES` reviewer by
 * inserting a fix builder at `round + 1` and a re-reviewer at `round + 2`. Its
 * `INSERT INTO project_tasks` names its columns explicitly and `depends_on` is
 * not among them, so both rows take the column default — `NULL` (E2). They are
 * therefore legacy rows, and — this is the whole case — **no frozen closure
 * names them**, because the backfill ran before they existed.
 *
 * The chain is hung off the fixture's HIGHEST `done` reviewer round, derived
 * rather than pinned, and the builder asserts the resulting pair lands strictly
 * below every non-`done` row. That is what makes the case bite: today's rule
 * holds all eight pending rows behind the new chain, while a graph branch
 * without R69 releases them the moment their FROZEN deps drain — deps that
 * cannot mention the chain.
 *
 * Returns its snapshot alongside its rows: the two are one input, and handing
 * back rows whose snapshot a caller has to reconstruct is how the first version
 * of this harness lost the distinction in the first place.
 */
const FIX_BUILDER_ID = "00000000-0000-4000-8000-00000000000f";
const FIX_REVIEWER_ID = "00000000-0000-4000-8000-0000000000f2";

interface CaseF {
  rows: FixtureRow[];
  snapshot: Set<string>;
  /** The round `createFixChain` was reconciling — the pair sits at +1 and +2. */
  base: number;
}

export function caseF(): CaseF {
  const all = rows();
  // The migration ran over the fixture exactly as captured.
  const snapshot = new Set(all.map((r) => r.id));

  const reviewerRounds = all.filter((r) => r.role === "reviewer" && r.status === "done").map((r) => r.round);
  if (reviewerRounds.length === 0) {
    throw new Error("task-graph-replay: case (f) needs a done reviewer to hang a fix chain off; the fixture has none");
  }
  const base = Math.max(...reviewerRounds);

  const lowestOpen = Math.min(...all.filter((r) => r.status !== "done").map((r) => r.round));
  if (base + 2 >= lowestOpen) {
    throw new Error(
      `task-graph-replay: case (f) is vacuous — the fix chain would land at ${base + 1}/${base + 2}, ` +
        `not strictly below the lowest non-done round ${lowestOpen}, so today's rule would not hold anything behind it`,
    );
  }

  all.push(
    insertedTask(FIX_BUILDER_ID, base + 1, {
      role: "builder",
      title: "fix chain inserted by the OLD engine after 0040 was applied",
    }),
    insertedTask(FIX_REVIEWER_ID, base + 2, {
      role: "reviewer",
      title: "re-review of the fix chain inserted after 0040 was applied",
    }),
  );
  return { rows: all, snapshot, base };
}

/* -------------------------------------------------------------------------- *
 * GREEN IN PHASE 1 — the fixture, the harness, and the stubs
 * -------------------------------------------------------------------------- */

describe("R9 — the fixture is what the requirement says it is", () => {
  test("loads, is a list of > 100 rows, and every row has exactly the six keys", () => {
    assert.ok(Array.isArray(FIXTURE), "fixture is not a JSON array");
    assert.ok(FIXTURE.length > 100, `fixture has ${FIXTURE.length} rows, R9 requires > 100`);

    for (const [i, row] of FIXTURE.entries()) {
      assert.deepEqual(
        Object.keys(row).sort(),
        [...FIXTURE_KEYS],
        `row ${i} (${row.id}) does not carry exactly the six R9 keys`,
      );
    }
  });

  test("sha256 matches the sibling capture record, so the input has provenance", () => {
    assert.equal(
      FIXTURE_SHA256,
      recordedSha256(),
      "the fixture does not hash to the sha256 its capture record states — one of the two was edited",
    );
  });

  test("not every task is already done — otherwise the replica proof is vacuous", () => {
    const notDone = FIXTURE.filter((r) => r.status !== "done");
    assert.ok(
      notDone.length > 0,
      `every one of the ${FIXTURE.length} rows is 'done'; no scheduler could promote anything`,
    );
    assert.ok(
      FIXTURE.some((r) => r.status === "pending"),
      "no row is 'pending'; the promotion rule would never be exercised",
    );
  });

  test("created_at is uniform ISO-8601 at +00:00 — backfillClosure()'s ordering precondition", () => {
    for (const row of FIXTURE) {
      assert.match(
        row.created_at,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/,
        `row ${row.id} has a created_at this harness cannot order the way Postgres does`,
      );
    }
  });
});

describe("R18 — the harness itself runs over the real fixture", () => {
  test("simulate(legacyRoundReady) reaches quiescence and promotes real work", () => {
    const result = simulate(legacyInput(FIXTURE), LEGACY_RULE);
    assert.ok(result.promotedTotal > 0, "the legacy schedule promoted nothing at all");
    assert.ok(
      result.schedule.some((tickSet) => tickSet.length > 0),
      "every tick of the legacy schedule is empty",
    );
    assert.ok(
      result.ticks <= FIXTURE.length + 2,
      `the run used ${result.ticks} ticks — the cap should have thrown`,
    );
    // Every `pending` row of the fixture, and only those, gets promoted: the
    // three `running` rows settle without being promoted again, and the 120
    // `done` rows are never touched.
    assert.equal(
      result.promotedTotal,
      FIXTURE.filter((r) => r.status === "pending").length,
      "the legacy schedule did not promote exactly the fixture's pending rows",
    );
    // The tick count is PINNED, because it is where the tick semantics are
    // observable. The fixture's eight pending rows sit on six distinct rounds
    // (1352×2, 1353×2, 1354, 1355, 1860, 1870) above three `running` rows at
    // 1350; at two ticks per level plus the settling tick and the quiescent
    // tick that is 14. If a future edit settles before promoting, this drops to
    // 8 and says so, instead of silently making case (b) vacuous.
    assert.equal(result.ticks, 14, "the tick cadence changed — read simulate()'s doc-comment before editing this");
    // Quiescence means terminal, not merely stopped: nothing may still be in
    // flight when the loop returns.
    assert.equal(
      [...result.finalStatus.values()].filter((s) => IN_FLIGHT.has(s)).length,
      0,
      "the simulation returned with tasks still ready or running",
    );
  });

  test("simulate() is deterministic — two runs, identical schedule", () => {
    const a = simulate(legacyInput(FIXTURE), LEGACY_RULE);
    const b = simulate(legacyInput(FIXTURE), LEGACY_RULE);
    assert.deepEqual(b.schedule, a.schedule, "two runs over the same input disagreed");
    assert.equal(b.ticks, a.ticks);
  });

  test("the tick cap throws rather than returning a short schedule", () => {
    // A rule that never promotes anything while a task is permanently running
    // can never reach quiescence. The loop must say so, not hand back what it
    // has: an instrument that stops early would compare two truncated
    // schedules and call them equal.
    const stuck: GraphTask[] = [
      { id: "a", round: 1, workstream: "main", status: "running", depends_on: null, write_set: [] },
    ];
    const neverSettles: PromotionRule = () => true;
    assert.throws(
      () =>
        simulate(stuck, neverSettles, {
          // Every tick paused → nothing promotes, nothing settles, quiescence
          // is never declared, and the cap is the only way out.
          pausedTicks: new Set(Array.from({ length: stuck.length + 2 }, (_, i) => i + 1)),
        }),
      throwsMessageMatching(/^task-graph-replay: simulate\(\) hit its tick cap/, "simulate"),
    );
  });

  test("the legacy and graph inputs are built separately from the same rows", () => {
    const legacy = legacyInput(FIXTURE);
    const graph = graphInput(FIXTURE);

    // The legacy side cannot read an edge: it has none.
    assert.ok(
      legacy.every((t) => t.depends_on === null),
      "a legacy input row carries depends_on — it would no longer be the round rule under test",
    );
    // The graph side cannot read a round: it has none.
    assert.ok(
      graph.every((t) => t.round === ROUND_WITHHELD),
      "a graph input row carries a real round — the graph side could be applying the round rule",
    );
    assert.ok(
      graph.every((t) => Array.isArray(t.depends_on)),
      "a graph input row has no depends_on array",
    );
    // And the closure is not empty theatre: the fixture spans many rounds, so
    // the last row by round must depend on nearly everything.
    const widest = Math.max(...graph.map((t) => (t.depends_on ?? []).length));
    assert.ok(widest > 100, `the widest closure row carries ${widest} ids; expected > 100`);
  });

  test("backfillClosure() is the strictly-lower-round closure, ordered as the SQL orders it", () => {
    const closure = backfillClosure(FIXTURE);
    const byId = new Map(FIXTURE.map((r) => [r.id, r]));

    for (const row of FIXTURE) {
      const deps = closure.get(row.id);
      assert.ok(deps, `no closure entry for ${row.id}`);
      // Membership: every strictly lower round, nothing else.
      const expected = FIXTURE.filter((e) => e.round < row.round).length;
      assert.equal(deps.length, expected, `closure for ${row.id} has the wrong cardinality`);
      assert.ok(
        deps.every((id) => (byId.get(id)?.round ?? Infinity) < row.round),
        `closure for ${row.id} names a task that is not in a strictly lower round`,
      );
      // Order: (round, created_at, id), ascending.
      for (let i = 1; i < deps.length; i++) {
        const prev = byId.get(deps[i - 1]);
        const cur = byId.get(deps[i]);
        assert.ok(prev && cur, "closure names an unknown id");
        const ordered =
          prev.round < cur.round ||
          (prev.round === cur.round && prev.created_at < cur.created_at) ||
          (prev.round === cur.round && prev.created_at === cur.created_at && prev.id < cur.id);
        assert.ok(ordered, `closure for ${row.id} is out of order at position ${i}`);
      }
    }
  });

  test("every R18 case builder produces a usable row list", () => {
    // The case BODIES are todo until phase 2, but their inputs are not: a case
    // whose fixture surgery silently failed would land in phase 2 as a green
    // test that asserts nothing.
    for (const [name, build] of [
      ["a", caseA],
      ["b", caseB],
      ["c", caseC],
      ["e", caseE],
      ["f", () => caseF().rows],
    ] as const) {
      const built = build();
      assert.ok(built.length >= FIXTURE.length, `case ${name} lost rows`);
      assert.equal(new Set(built.map((r) => r.id)).size, built.length, `case ${name} has duplicate ids`);
    }
    assert.equal(caseB().filter((r) => r.status === "ready").length, 1, "case b retried no task");
    assert.equal(caseC().length, FIXTURE.length + 1, "case c inserted no task");
    assert.equal(caseE().filter((r) => r.status === "failed").length, 1, "case e failed no task");
    assert.equal(caseF().rows.length, FIXTURE.length + 2, "case f inserted no fix chain");
  });
});

/* -------------------------------------------------------------------------- *
 * F13 — THE FROZEN CLOSURE CANNOT SEE A ROW INSERTED AFTER THE MIGRATION
 *
 * These tests are NOT `todo`. They run green today, and that is the point:
 * every claim R69 rests on is established here WITHOUT `graphReady()`, from the
 * frozen closure and today's own rule. Case (f) below then asserts the
 * consequence — that the two schedulers agree — and can only pass once phase 2
 * implements the legacy-row term.
 *
 * RETIRED BY R12-retire, with R69 and the legacy branch, in one commit
 * (standing rule 4).
 * -------------------------------------------------------------------------- */

/** The 1-based tick on which `id` was promoted, or 0 if it never was. */
function promotedOnTick(result: SimResult, id: string): number {
  return result.schedule.findIndex((tickSet) => tickSet.includes(id)) + 1;
}

describe("F13 — a row inserted after 0040 is named by no frozen closure", () => {
  test("the post-migration fix chain is legacy, and no frozen row depends on it", () => {
    const { rows: built, snapshot, base } = caseF();
    const graph = graphInput(built, { snapshot });
    const byId = new Map(graph.map((t) => [t.id, t]));

    for (const id of [FIX_BUILDER_ID, FIX_REVIEWER_ID]) {
      assert.equal(
        byId.get(id)?.depends_on,
        null,
        `the fix chain row ${id} should be born legacy — createFixChain's INSERT does not name depends_on (E2)`,
      );
    }
    for (const t of graph) {
      if (t.depends_on === null) continue;
      assert.ok(
        !t.depends_on.includes(FIX_BUILDER_ID) && !t.depends_on.includes(FIX_REVIEWER_ID),
        `frozen row ${t.id} names a post-migration row in its closure — the snapshot leaked`,
      );
    }
    assert.equal(
      graph.filter((t) => t.depends_on === null).length,
      2,
      "exactly the two appended rows should be legacy",
    );
    assert.ok(base > 0, "case (f) derived a non-positive fix-chain base round");
  });

  test("a mixed input carries real rounds; a pure-graph input withholds them", () => {
    const { rows: built, snapshot } = caseF();
    const mixed = graphInput(built, { snapshot });
    assert.ok(
      mixed.every((t) => t.round !== ROUND_WITHHELD),
      "a mixed input withheld round — R69's legacy-row term would be unevaluable",
    );
    assert.ok(
      graphInput(FIXTURE).every((t) => t.round === ROUND_WITHHELD),
      "a pure-graph input kept its rounds — guard 3 of this file's header is lost",
    );
    // And the decision is made from the output, not from the option: passing a
    // snapshot that happens to cover every row is still pure-graph.
    assert.ok(
      graphInput(FIXTURE, { snapshot: new Set(FIXTURE.map((r) => r.id)) }).every((t) => t.round === ROUND_WITHHELD),
      "a snapshot covering every row produced real rounds — withholding is being decided from the option",
    );
  });

  test("graphInput() refuses a snapshot it cannot honour", () => {
    assert.throws(
      () => graphInput(FIXTURE, { snapshot: new Set(["00000000-0000-4000-8000-0000000000aa"]) }),
      throwsMessageMatching(/migration-time snapshot names task/, "graphInput"),
    );
    assert.throws(
      () => graphInput(FIXTURE, { snapshot: new Set<string>() }),
      throwsMessageMatching(/migration-time snapshot is empty/, "graphInput"),
    );
  });

  test("today's rule holds every captured pending row behind the new fix chain", () => {
    const { rows: built } = caseF();
    const legacy = simulate(legacyInput(built), LEGACY_RULE);

    const builderTick = promotedOnTick(legacy, FIX_BUILDER_ID);
    const reviewerTick = promotedOnTick(legacy, FIX_REVIEWER_ID);
    assert.ok(builderTick > 0 && reviewerTick > builderTick, "the fix chain did not run in order under today's rule");

    for (const row of FIXTURE.filter((r) => r.status === "pending")) {
      const tick = promotedOnTick(legacy, row.id);
      assert.ok(tick > 0, `captured pending row ${row.id} was never promoted`);
      assert.ok(
        tick > reviewerTick,
        `today's rule promoted captured row ${row.id} (round ${row.round}) on tick ${tick}, before the fix chain ` +
          `re-reviewer at round finished on tick ${reviewerTick} — the premise of F13 no longer holds`,
      );
    }
  });

  test("a frozen closure whose deps all settle on tick 1 releases its row while the fix chain is still pending", () => {
    // The finding, stated mechanically and proved without `graphReady()`.
    //
    // Not every captured pending row qualifies, and the first draft of this test
    // claimed they all did — the harness rejected it, which is the point of
    // writing the claim as an assertion. A row at round 1353 has 1352's pending
    // rows inside its frozen closure and is genuinely held by them. The rows
    // that matter are the LOWEST pending ones: their frozen closure contains
    // only `done` and `running` rows, every one of which is `done` at the end of
    // tick 1, so a graph branch reading the closure ALONE releases them on tick
    // 2. Today's rule does not — it holds them until the post-migration fix
    // chain has drained, several ticks later. That gap is the divergence R69
    // closes, and it is why case (f) must fail until phase 2 implements the term.
    const { rows: built, snapshot } = caseF();
    const graph = graphInput(built, { snapshot });
    const statusById = new Map(built.map((r) => [r.id, r.status]));
    const settlesOnTick1 = new Set(["done", "running", "ready"]);

    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    const reviewerTick = promotedOnTick(legacy, FIX_REVIEWER_ID);
    assert.ok(reviewerTick > 2, `the fix chain's re-reviewer ran on tick ${reviewerTick}; F13 needs it after tick 2`);

    const releasedEarly: FixtureRow[] = [];
    for (const row of FIXTURE.filter((r) => r.status === "pending")) {
      const deps = graph.find((t) => t.id === row.id)?.depends_on;
      assert.ok(deps, `captured pending row ${row.id} has no frozen closure`);
      assert.ok(deps.length > 0, `captured pending row ${row.id} froze an empty closure`);
      for (const dep of deps) {
        assert.ok(statusById.get(dep), `frozen closure of ${row.id} names unknown id ${dep}`);
      }
      if (deps.every((dep) => settlesOnTick1.has(statusById.get(dep) ?? ""))) releasedEarly.push(row);
    }

    assert.ok(
      releasedEarly.length > 0,
      "no captured pending row has a frozen closure that drains on tick 1 — F13's divergence is not reachable from " +
        "this fixture and the argument for R69 must be re-derived before phase 2 relies on it",
    );
    // Exactly the lowest pending round, and it is far above the chain.
    const lowestPendingRound = Math.min(...FIXTURE.filter((r) => r.status === "pending").map((r) => r.round));
    for (const row of releasedEarly) {
      assert.equal(
        row.round,
        lowestPendingRound,
        `row ${row.id} at round ${row.round} drains on tick 1 but is not at the lowest pending round`,
      );
      const tick = promotedOnTick(legacy, row.id);
      assert.ok(
        tick > reviewerTick,
        `today's rule promoted ${row.id} on tick ${tick}, not after the fix chain's tick ${reviewerTick} — ` +
          "there would be no divergence to close",
      );
    }
  });
});

/* -------------------------------------------------------------------------- *
 * STUB DISCIPLINE
 *
 * Every STILL-unimplemented export of task-graph.ts must THROW, never return a
 * plausible default. `graphReady() → false` would let the replay pass for the
 * wrong reason on a fixture where nothing was promotable, and `conflicts() →
 * false` would silently disable the contention belt. This block is the guard
 * that stops that, and standing rule 4 says each clause is deleted in the same
 * commit as the stub it guards — not left to rot into a test that asserts a
 * phase never happened.
 *
 * PARTIALLY RETIRED IN PHASE 2 (standing rule 4, named in the commit message).
 * `graphReady` (R11/R14/R69), `readyRule` (R12), `taskDepth` (R19), `conflicts`
 * (R16/R17) and `selectClaimable` (R16) are implemented as of phase 2A, so
 * their clauses retire here, WITH the requirement they guarded — the guard was
 * "the phase-2 exports throw until phase 2", and phase 2 is what this commit
 * is. Leaving them would be a test asserting phase 2 never landed.
 *
 * THE FIVE THAT REMAIN ARE NOT A DEFECT, and they are listed by requirement id
 * rather than by phase prose because requirement ids are authoritative
 * (`04-phases.md` §10 is the map): `computeRound` (R23) and `findCycle`
 * (R25, R26) land in phase 3 with `normaliseWritePath` and `validateWorkstream`
 * (R28); `groupKey` (R40) lands in phase 4. Each retires with its own phase.
 * -------------------------------------------------------------------------- */

describe("stub discipline — every export not yet implemented throws", () => {
  const t: GraphTask = {
    id: "00000000-0000-4000-8000-0000000000ff",
    round: 1,
    workstream: "main",
    status: "pending",
    depends_on: [],
    write_set: [],
  };

  const stubs: ReadonlyArray<readonly [string, () => unknown]> = [
    ["computeRound", () => computeRound([])],
    ["findCycle", () => findCycle({ id: t.id, depends_on: [] }, new Map())],
    ["groupKey", () => groupKey({ round: 1, workstream: "main" })],
    ["normaliseWritePath", () => normaliseWritePath("src/a.ts")],
    ["validateWorkstream", () => validateWorkstream("main")],
  ];

  for (const [name, call] of stubs) {
    test(`${name}() throws a task-graph: diagnostic`, () => {
      assert.throws(call, throwsMessageMatching(/^task-graph:/, name));
    });
  }

  test("legacyRoundReady() is NOT a stub — it is the rule under test", () => {
    const done: GraphTask = { ...t, id: "x", round: 0, status: "done" };
    assert.equal(legacyRoundReady(t, [done, t]), true);
    assert.equal(legacyRoundReady({ ...t, round: 2 }, [{ ...done, status: "pending" }]), false);
  });
});

/* -------------------------------------------------------------------------- *
 * THE SIX R18 COMPARISON CASES (a–f)
 *
 * `todo` through phase 1 because `graphReady()` threw until phase 2 landed. The
 * option is now deleted and NOTHING ELSE in these bodies moved — no expected
 * value was relaxed, no assertion dropped, no snapshot widened. `git diff` over
 * this block against phase 1's HEAD is the check, and it is quoted in
 * `evidence/phase2-replay.md`.
 *
 * EVERY BODY PUTS ITS LEGACY-SIDE EXPECTATIONS FIRST, before the call that
 * reaches the graph side. That ordering ran through phase 1 — each `todo`
 * reported `task-graph: readyRule() lands in phase 2 (R12)`, the first stub
 * `GRAPH_RULE` touched, which is how phase 2 inherited six bodies whose legacy
 * halves had already been exercised rather than six that had never run at all.
 * Keep the ordering: it is what makes a future divergence report the LEGACY
 * side's disagreement rather than a stub's message.
 *
 * CASE (f) MUST NOT BE MADE TO PASS BY WIDENING `graphInput()`'s
 * migration-time snapshot (`03-quality.md` §3.2, Phase 2). That is the one edit
 * that turns it green while leaving F13 wide open, and the mutation transcripts
 * in `evidence/phase2-replay.md` §5 are what prove the term, not the snapshot,
 * is carrying it.
 * -------------------------------------------------------------------------- */

describe("R18 — the graph is an exact replica of today's rounds", () => {
  test("(a) the base fixture, straight through", () => {
    assertReplica("R18-a base fixture", caseA());
  });

  test("(b) an early round retried to ready after a later round drained", () => {
    const built = caseB();

    // The point of the case, asserted rather than implied: the task inserted at
    // 1292 must NOT be promoted on tick 1, because the retried 1290 task is not
    // done. A previous-round-only backfill promotes it there.
    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    const inserted = "00000000-0000-4000-8000-00000000000b";
    assert.ok(
      !legacy.schedule[0].includes(inserted),
      "the inserted 1292 task promoted on tick 1 while a 1290 task was still ready — today's rule does not do that",
    );
    assert.ok(
      legacy.schedule.some((tickSet) => tickSet.includes(inserted)),
      "the inserted 1292 task was never promoted at all",
    );

    assertReplica("R18-b retry under a drained later round", built);
  });

  test("(c) a task inserted into an already-drained round", () => {
    const built = caseC();

    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    assert.ok(
      legacy.schedule[0].includes("00000000-0000-4000-8000-00000000000c"),
      "a task inserted into a fully drained round should promote on the first tick",
    );

    assertReplica("R18-c insertion into a drained round", built);
  });

  test("(d) a project paused mid-run and resumed", () => {
    const built = caseA();

    const paused = simulate(legacyInput(built), LEGACY_RULE, { pausedTicks: PAUSED_TICKS });
    for (const tick of PAUSED_TICKS) {
      assert.deepEqual(paused.schedule[tick - 1], [], `tick ${tick} promoted while the project was paused`);
    }
    // A pause DELAYS; it must not reorder or drop. Strip the empty ticks from
    // both runs and the promotion sequence is identical to the unpaused one.
    const nonEmpty = (r: SimResult): string[][] => r.schedule.filter((s) => s.length > 0);
    assert.deepEqual(
      nonEmpty(paused),
      nonEmpty(simulate(legacyInput(built), LEGACY_RULE)),
      "pausing changed WHICH tasks were promoted, not merely when",
    );

    assertReplica("R18-d pause and resume", built, { pausedTicks: PAUSED_TICKS });
  });

  test("(e) a permanently failed task — both schedulers wedge identically", () => {
    const built = caseE();
    const stuck = (r: SimResult): string[] =>
      [...r.finalStatus.entries()].filter(([, s]) => s !== "done").map(([id]) => id).sort();

    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    assert.ok(stuck(legacy).length > 0, "nothing wedged — case (e) would be vacuous");
    assert.ok(legacy.promotedTotal > 0, "the wedge swallowed the whole schedule; nothing ran before it");

    assertReplica("R18-e permanent failure", built);

    const graph = simulate(graphInput(built), GRAPH_RULE);
    assert.deepEqual(stuck(graph), stuck(legacy), "the two schedulers wedged on different tasks");
  });

  test("(f) a fix chain inserted by the OLD engine AFTER 0040 was applied", () => {
    const { rows: built, snapshot } = caseF();

    // Legacy-side expectations first, so this half runs today (see the block
    // comment above). Today's rule holds the whole project behind the new chain.
    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    const reviewerTick = promotedOnTick(legacy, FIX_REVIEWER_ID);
    assert.ok(reviewerTick > 0, "the post-migration re-reviewer was never promoted under today's rule");
    for (const row of FIXTURE.filter((r) => r.status === "pending")) {
      assert.ok(
        promotedOnTick(legacy, row.id) > reviewerTick,
        `today's rule released ${row.id} before the post-migration fix chain drained`,
      );
    }

    // THE ASSERTION. Without R69's legacy-row term the graph side releases every
    // frozen row on tick 2, because its closure — computed before the chain
    // existed — cannot name it. With the term, the two schedules are identical.
    // This case is the reason R69 exists; it must not be made to pass by
    // widening the snapshot.
    assertReplica("R18-f fix chain inserted after the migration", built, { snapshot });
  });
});

/* -------------------------------------------------------------------------- *
 * THE ROUND-103 PREDICTION, PINNED
 *
 * Before `graphReady()` existed, round 103 ran an INDEPENDENT throwaway model
 * (Python, same fixture, no database, deliberately not committed) and predicted
 * what a closure-based graph rule would produce: ticks 14/16/15/15/4 and
 * promotion totals 8/9/9/8/1 for cases (a)–(e), with case (e) wedging 7 tasks on
 * both sides. Round 106 added case (f) and confirmed it agrees once R69's term
 * is present. That prediction is worth exactly as much as its being CHECKED,
 * so it is checked here rather than quoted in a document.
 *
 * WHY A SEPARATE TEST AND NOT SIX MORE ASSERTIONS INSIDE THE CASES: the six
 * bodies were written in phase 1 and phase 2's contract was to delete their
 * `todo` option and nothing else. This block adds the pin without touching them,
 * and reads its numbers out of `MEASURED` — the results the six cases actually
 * asserted on, in this same process — so it can neither re-simulate a different
 * input nor disagree with what was proved above.
 *
 * A DEVIATION HERE IS A FINDING, NOT A NUMBER TO UPDATE. The prediction was made
 * by a model with no shared code with this harness; the two agreeing is the
 * evidence. If a later edit makes them disagree, the honest response is a
 * written argument in `evidence/phase2-replay.md`, per this task's ordering of
 * hypotheses — not a quiet edit to the table below.
 * -------------------------------------------------------------------------- */

interface CasePin {
  /** The `assertReplica()` label the case recorded under. */
  label: string;
  ticks: number;
  promoted: number;
  /** Rows not `done` when the loop returned — case (e)'s wedge. */
  wedged: number;
  /** `true` where the number came from round 103/106, `false` where it did not. */
  predicted: boolean;
}

const CASE_PINS: readonly CasePin[] = [
  { label: "R18-a base fixture", ticks: 14, promoted: 8, wedged: 0, predicted: true },
  { label: "R18-b retry under a drained later round", ticks: 16, promoted: 9, wedged: 0, predicted: true },
  { label: "R18-c insertion into a drained round", ticks: 15, promoted: 9, wedged: 0, predicted: true },
  { label: "R18-d pause and resume", ticks: 15, promoted: 8, wedged: 0, predicted: true },
  { label: "R18-e permanent failure", ticks: 4, promoted: 1, wedged: 7, predicted: true },
  // Case (f) carried no round-103 number — it did not exist until round 106,
  // which established only that the two sides AGREE, not what they agree on.
  // Pinned from this round's measurement and labelled as such, so the next
  // reader knows which of these six numbers is a prediction that held and which
  // is a baseline this round set.
  { label: "R18-f fix chain inserted after the migration", ticks: 17, promoted: 10, wedged: 0, predicted: false },
];

describe("R18 — the schedules match the round-103 prediction, on both sides", () => {
  test("every case recorded a measurement", () => {
    // A case that threw before recording, or a label edited on one side only,
    // must fail here rather than let the pins below silently skip it.
    assert.deepEqual(
      [...MEASURED.keys()].sort(),
      CASE_PINS.map((p) => p.label).sort(),
      "the recorded comparisons are not exactly the six pinned cases",
    );
  });

  for (const pin of CASE_PINS) {
    test(`${pin.label} — ${pin.ticks} ticks, ${pin.promoted} promoted, both sides`, () => {
      const m = MEASURED.get(pin.label);
      assert.ok(m, `no measurement recorded for ${pin.label} — did the case run?`);

      const wedged = (r: SimResult): number =>
        [...r.finalStatus.values()].filter((s) => s !== "done").length;

      // Stated per side rather than "legacy === graph": the six cases above
      // already prove the two sides equal, so repeating that here would add
      // nothing. What this adds is the ABSOLUTE number, which is what an
      // independent model can be compared against.
      for (const [side, r] of [["legacy", m.legacy], ["graph", m.graph]] as const) {
        assert.equal(r.ticks, pin.ticks, `${pin.label}: ${side} side used ${r.ticks} ticks, pinned ${pin.ticks}`);
        assert.equal(
          r.promotedTotal,
          pin.promoted,
          `${pin.label}: ${side} side promoted ${r.promotedTotal}, pinned ${pin.promoted}`,
        );
        assert.equal(wedged(r), pin.wedged, `${pin.label}: ${side} side wedged ${wedged(r)}, pinned ${pin.wedged}`);
      }
    });
  }

  test("prints the per-case table the evidence record quotes", () => {
    // Printed from `MEASURED`, not from `CASE_PINS`: a table printed from the
    // pins would restate what a reader already typed and would keep printing
    // the right answer while the harness produced a different one.
    for (const pin of CASE_PINS) {
      const m = MEASURED.get(pin.label)!;
      const wedged = (r: SimResult): number =>
        [...r.finalStatus.values()].filter((s) => s !== "done").length;
      console.log(
        `task-graph-replay: CASE     ${pin.label.padEnd(44)} ` +
          `legacy ${m.legacy.ticks}t/${m.legacy.promotedTotal}p/${wedged(m.legacy)}w  ` +
          `graph ${m.graph.ticks}t/${m.graph.promotedTotal}p/${wedged(m.graph)}w  ` +
          `[${pin.predicted ? "round-103 prediction" : "baseline set this round"}]`,
      );
    }
  });
});
