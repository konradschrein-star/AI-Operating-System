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
 * PHASE 1 STATE. `graphReady()` throws until phase 2 lands, so all five R18
 * comparison cases (a–e) are declared `todo` with their BODIES WRITTEN IN FULL:
 * phase 2 deletes the `{ todo: … }` option and nothing else. `04-phases.md`
 * Phase 1 deliverable 4 and `03-quality.md` §3.2 both say this harness must RUN
 * and report at this phase, not that it must pass. A failing `todo` body was
 * verified empirically — not assumed — to leave `# fail 0` and exit 0 under
 * node v22.22.2 + tsx, so `03-quality.md` §3.1's "all green, zero skipped" gate
 * stays satisfiable here; the numbers are in this task's report.
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
 *  4. A harness whose build identity is unknown — the banner prints the fixture
 *     path, its row count, its sha256 cross-checked against the capture
 *     record's own sha, `git rev-parse --short HEAD`, and whether the two files
 *     that define this instrument are dirty against that HEAD. A sha naming the
 *     worktree rather than the build is the failure this last line answers.
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
  taskDepth,
  computeRound,
  findCycle,
  conflicts,
  selectClaimable,
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
 */
function backfillClosure(tasks: readonly ClosureRow[]): Map<string, string[]> {
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

/**
 * THE GRAPH's input: `depends_on` from the closure, `round` withheld. Built
 * from `rows` directly — not from `legacyInput()`'s output — so the two sides
 * share their ground truth and nothing else.
 */
function graphInput(rows: readonly FixtureRow[]): GraphTask[] {
  const closure = backfillClosure(rows);
  return rows.map((r) => {
    const deps = closure.get(r.id);
    if (!deps) {
      throw new Error(`task-graph-replay: closure produced no entry for task ${r.id}`);
    }
    return {
      id: r.id,
      round: ROUND_WITHHELD,
      workstream: "main",
      status: toStatus(r.status),
      depends_on: deps,
      write_set: [],
    };
  });
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
const GRAPH_RULE: PromotionRule = (t, ctx) => graphReady(t, ctx.byId);

interface SimOptions {
  /**
   * Ticks (1-based) on which the project is NOT `active`. Models R18 case (d):
   * `promoteReadyTasks()`'s `AND p.status = 'active'` is the CALLER's gate on a
   * joined `projects` row, never a per-task predicate (E7/R8/R13), so a pause
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
function assertReplica(label: string, rows: readonly FixtureRow[], opts: SimOptions = {}): void {
  const legacy = simulate(legacyInput(rows), LEGACY_RULE, opts);
  const graph = simulate(graphInput(rows), GRAPH_RULE, opts);

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
 * with a task then inserted into a round above it.
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
    ] as const) {
      const built = build();
      assert.ok(built.length >= FIXTURE.length, `case ${name} lost rows`);
      assert.equal(new Set(built.map((r) => r.id)).size, built.length, `case ${name} has duplicate ids`);
    }
    assert.equal(caseB().filter((r) => r.status === "ready").length, 1, "case b retried no task");
    assert.equal(caseC().length, FIXTURE.length + 1, "case c inserted no task");
    assert.equal(caseE().filter((r) => r.status === "failed").length, 1, "case e failed no task");
  });
});

/* -------------------------------------------------------------------------- *
 * STUB DISCIPLINE
 *
 * RETIRED BY PHASE 2 (R10/R18) — delete with the stubs, in the same commit.
 *
 * Every unimplemented export of task-graph.ts must THROW, never return a
 * plausible default. `graphReady() → false` would let the replay pass for the
 * wrong reason on a fixture where nothing was promotable, and `conflicts() →
 * false` would silently disable the contention belt. This block is the guard
 * that stops that, and standing rule 4 says it is deleted in the same commit as
 * the stubs it guards — not left to rot into a test that asserts phase 2 never
 * happened.
 * -------------------------------------------------------------------------- */

describe("phase 1 stub discipline — every unimplemented export throws", () => {
  const t: GraphTask = {
    id: "00000000-0000-4000-8000-0000000000ff",
    round: 1,
    workstream: "main",
    status: "pending",
    depends_on: [],
    write_set: [],
  };

  const stubs: ReadonlyArray<readonly [string, () => unknown]> = [
    ["graphReady", () => graphReady(t, new Map())],
    ["readyRule", () => readyRule(t)],
    ["taskDepth", () => taskDepth([t])],
    ["computeRound", () => computeRound([])],
    ["findCycle", () => findCycle({ id: t.id, depends_on: [] }, new Map())],
    ["conflicts", () => conflicts([], [])],
    ["selectClaimable", () => selectClaimable([], [])],
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
 * THE FIVE R18 COMPARISON CASES (a–e)
 *
 * `todo` in phase 1 because `graphReady()` throws until phase 2 lands. The
 * bodies are complete: phase 2 deletes the `{ todo: … }` option and nothing
 * else. Verified empirically under node v22.22.2 + tsx: a failing `todo` body
 * reports `# fail 0` and exits 0, so this block cannot make `03-quality.md`
 * §3.1's "pnpm test green, zero skipped" gate unsatisfiable for phase 1.
 *
 * EVERY BODY PUTS ITS LEGACY-SIDE EXPECTATIONS FIRST, before the call that
 * reaches `graphReady()`. Those halves therefore RUN today, and each todo's
 * reported error is evidence rather than noise: if a case reports anything
 * other than `task-graph: graphReady() lands in phase 2 (R11, R14)`, its
 * legacy-side expectation is wrong and phase 2 would have inherited a body that
 * was never exercised. Phase 2's reviewer should re-read this paragraph before
 * deleting the `todo` options.
 * -------------------------------------------------------------------------- */

const TODO_PHASE_2 = { todo: "phase 2: graphReady() is stubbed (R18)" } as const;

describe("R18 — the graph is an exact replica of today's rounds", () => {
  test("(a) the base fixture, straight through", TODO_PHASE_2, () => {
    assertReplica("R18-a base fixture", caseA());
  });

  test("(b) an early round retried to ready after a later round drained", TODO_PHASE_2, () => {
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

  test("(c) a task inserted into an already-drained round", TODO_PHASE_2, () => {
    const built = caseC();

    const legacy = simulate(legacyInput(built), LEGACY_RULE);
    assert.ok(
      legacy.schedule[0].includes("00000000-0000-4000-8000-00000000000c"),
      "a task inserted into a fully drained round should promote on the first tick",
    );

    assertReplica("R18-c insertion into a drained round", built);
  });

  test("(d) a project paused mid-run and resumed", TODO_PHASE_2, () => {
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

  test("(e) a permanently failed task — both schedulers wedge identically", TODO_PHASE_2, () => {
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
});
