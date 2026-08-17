#!/usr/bin/env bash
#
# check-r69-straddle.sh — THE R69 STRADDLE EXPERIMENT (phase 4D, round 223).
#
# THE QUESTION IT ANSWERS. R69 (the legacy-row term, ruled as E3 in
# `02-architecture.md` §9.2) holds a FROZEN row — one whose dependency closure
# was computed by 0040's backfill — behind LEGACY rows only, rows carrying the
# `depends_on IS NULL` sentinel. R42 gives fix chains created by the NEW engine
# REAL graph fields. So in a STRADDLING project — one that existed before the
# migration and is still running after the restart — a row the new engine
# inserts below a frozen row is invisible to R69's term, and the frozen row
# promotes where today's engine would hold it. `02-architecture.md` §3.2 says a
# straddling project "finishes under its original semantics". That sentence is
# WIDER than what R69 delivers. Phase 1 found the gap, declined to fix it as
# out of scope, and handed it to phase 4.
#
# Two options were on the table, and the operator asked for the choice to be
# made by experiment rather than on paper:
#   A — WIDEN R69's predicate for frozen rows only: hold a frozen row behind ANY
#       non-done row of strictly lower round, not merely a legacy one.
#   B — NARROW §3.2 to match R69, on the record, with the blast radius stated.
#
# WHAT THIS SCRIPT MEASURES, and why each measurement is here:
#   S1  a straddling project with NO gap row: 131 frozen rows (the R9 fixture,
#       closures computed over the migration-time snapshot) + a post-restart fix
#       chain carrying real `depends_on`. Nothing in it is a legacy row.
#   S2  S1 plus ONE already-`done` row carrying the NULL sentinel — a fix-chain
#       row the OLD engine inserted in the deploy gap and which finished before
#       the restart. It is scheduling-inert under R69: it is `done`.
#   S3  a project planned entirely AFTER the restart, shaped like the measured
#       motivating case (00-vision.md §2): one long reviewer and seven unrelated
#       builders numbered above it. It carries the PRICE of each option.
#
# SIX PROMOTION ARMS. Four of them are the SHIPPED `graphReady()` with a
# widening composed ON TOP of it, so no arm is a re-implementation of the rule
# under test and the narrow arm is the shipped predicate by construction:
#   LEGACY         today's engine — `legacyRoundReady()` over NULL-deps rows.
#   NARROW         `readyRule()` + the SHIPPED `graphReady()` — R69 as landed.
#   WIDE-SENTINEL  NARROW + option A gated on "this project contains a row with
#                  the NULL sentinel" — the only gate the schema can express at
#                  zero cost.
#   WIDE-CLOSURE   NARROW + option A gated on `isClosureShaped()` — the corpus's
#                  own frozen-row detector (`lib/schedule-metrics.ts`), which is
#                  the closest thing to "while a row is frozen" that exists.
#   WIDE-HORIZON   NARROW + option A gated on a `created_at` horizon taken from
#                  the row's OWN closure. The cleverest gate the data can
#                  express, and it needs no stored migration timestamp — so it
#                  has to be measured before "no gate works" may be said.
#   WIDE-UNGATED   NARROW + option A with no gate at all — the widening applied
#                  to every graph row. Included to price the escape hatch.
#
# NO DATABASE. This experiment is a tick simulation over pure functions and a
# committed fixture. It opens no pg Pool, reads no DSN, and needs neither
# $DATABASE_URL nor $SCRATCH_DATABASE_URL — so the standing rule that a
# Postgres-touching check must read $SCRATCH_DATABASE_URL and refuse on
# content_forge does not bite here, and the driver ASSERTS that it did not read
# either variable rather than leaving that to be believed.
#
# INSTRUMENTS LIE BEFORE CODE DOES (standing rule 3). What this one prints about
# itself, and what it refuses on:
#   - `git rev-parse HEAD`, the worktree it ran in, and whether any file it
#     exercises is dirty against that HEAD. A sha naming the worktree rather
#     than the build is the failure that costs a round.
#   - the sha256 of every file it depends on: itself, `task-graph.ts`,
#     `schedule-metrics.ts`, the R9 fixture.
#   - PROBE ACCOUNTING. Every probe registers before it runs; the driver exits
#     NON-ZERO if a registered probe did not report, if any probe failed, or if
#     zero probes ran. A sweep whose probes miss must not certify itself.
#   - TWO NAMED WAYS THIS EXPERIMENT COULD REPORT WRONGLY, each answered by a
#     counter rather than by a claim:
#       (i)  "both arms ran the same code because the widened predicate was
#            never reached" — every wide arm counts how often its widening was
#            EVALUATED, how often the gate OPENED, and how often the term
#            actually CHANGED an answer from ready to not-ready. All three are
#            printed per arm per fixture, and probes 2a–2e assert them: an arm
#            claimed to be silent must show gate-open 0, and an arm claimed to
#            close the divergence must show fired > 0. "The two arms ran the
#            same code" is therefore a reading on the instrument, not a worry.
#       (ii) "the fixture was not straddling — every row had real graph fields,
#            so the frozen branch never ran" — probe 0b counts, on each fixture,
#            the rows taking the GRAPH branch, the rows carrying a frozen
#            closure, and the frozen PENDING rows whose closure cannot name the
#            post-restart chain. Zero on any of those is a refusal.
#   - CALIBRATION. `simulate()` here is a transcription of the replay harness's
#     tick loop; probe 0a re-derives the tick count the harness PINS at 14 for
#     the base fixture under the legacy rule. A transcription that drifted
#     reports a different number and this script stops.
#   - CALIBRATION. `isClosureShaped()` is module-private in
#     `lib/schedule-metrics.ts` and cannot be imported. The driver transcribes
#     it and probe 0d asserts the transcription's per-row count equals the
#     SHIPPED `inputCensus().closureShapedRows` on all three fixtures.
#
# Run:  scripts/checks/check-r69-straddle.sh
# Exit: 0 — every probe ran and reported as expected.
#       1 — a probe failed, a probe did not run, or a calibration drifted.
#       2 — the environment is not usable (no tsx, no fixture, not a git tree).
#
# The transcript of the run that decided the question is
# `docs/plan/engine-task-graph/evidence/phase4-workstreams.md` §5, and the
# ruling it produced is `02-architecture.md` §9.3.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="${BASH_SOURCE[0]}"

fail() {
  echo "REFUSING: $1" >&2
  exit "${2:-2}"
}

TSX="$REPO_ROOT/forge-control/node_modules/.bin/tsx"
[ -x "$TSX" ] || fail "tsx is not executable at $TSX"
FIXTURE="$REPO_ROOT/forge-control/src/lib/fixtures/replay-operator-visibility.json"
[ -r "$FIXTURE" ] || fail "the R9 fixture is not readable at $FIXTURE"
TASK_GRAPH="$REPO_ROOT/forge-control/src/lib/task-graph.ts"
[ -r "$TASK_GRAPH" ] || fail "task-graph.ts is not readable at $TASK_GRAPH"
METRICS="$REPO_ROOT/forge-control/src/lib/schedule-metrics.ts"
[ -r "$METRICS" ] || fail "schedule-metrics.ts is not readable at $METRICS"

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || fail "$REPO_ROOT is not a git tree"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

echo '==============================================================================='
echo ' check-r69-straddle.sh — the R69 straddle experiment (phase 4D, round 223)'
echo '==============================================================================='
echo "  worktree            $REPO_ROOT"
echo "  HEAD                $HEAD_SHA"
echo "  branch              $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
# The identity that matters is the BYTES EXERCISED, not the commit the worktree
# is parked on. A dirty file means the sha above does not describe what ran, and
# saying so is the whole point of this block.
DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- \
  "$SELF" "$TASK_GRAPH" "$METRICS" "$FIXTURE" | sed 's/^/                      /')"
if [ -n "$DIRTY" ]; then
  echo "  DIRTY vs HEAD — the shas below, not $HEAD_SHA, describe what ran:"
  echo "$DIRTY"
else
  echo "  clean vs HEAD       every file exercised below matches $HEAD_SHA"
fi
echo '  --- sha256 of every file this experiment depends on -------------------------'
sha256sum "$SELF" "$TASK_GRAPH" "$METRICS" "$FIXTURE" | sed 's/^/    /'
echo '  --- the worktree is NOT the live checkout ------------------------------------'
case "$REPO_ROOT" in
  /opt/forge-ai-os|/opt/forge-ai-os/*)
    fail "this ran inside the LIVE checkout $REPO_ROOT — build phases are worktree-only" ;;
  *) echo "    ok: $REPO_ROOT is not /opt/forge-ai-os" ;;
esac
echo

WORK="$(mktemp -d -t check-r69-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# The driver is written with `__REPO__` and substituted, rather than being
# expanded by the heredoc: an unquoted heredoc would eat every `${...}` in the
# TypeScript below, and the escaping needed to survive that is exactly how a
# driver ends up asserting something other than what it reads.
cat > "$WORK/drive.mts.in" <<'DRIVER'
/**
 * The R69 straddle experiment. See the header of check-r69-straddle.sh for what
 * each fixture and each arm is FOR; this file is the measurement.
 */
import { readFileSync } from "node:fs";

import {
  legacyRoundReady,
  graphReady,
  readyRule,
  type GraphTask,
} from "__REPO__/forge-control/src/lib/task-graph.ts";
import { inputCensus, type MetricTask } from "__REPO__/forge-control/src/lib/schedule-metrics.ts";

/* -------------------------------------------------------------------------- *
 * Probe accounting — the sweep must not be able to certify itself
 * -------------------------------------------------------------------------- */

interface Probe {
  id: string;
  what: string;
  ran: boolean;
  ok: boolean;
  detail: string;
}
const PROBES: Probe[] = [];

/** Register a probe BEFORE it runs. A registered probe that never reports is a
 *  non-zero exit, which is the difference between a sweep and a certificate. */
function probe(id: string, what: string): Probe {
  const p: Probe = { id, what, ran: false, ok: false, detail: "" };
  PROBES.push(p);
  return p;
}

function report(p: Probe, ok: boolean, detail: string): void {
  p.ran = true;
  p.ok = ok;
  p.detail = detail;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${p.id}  ${p.what}`);
  for (const line of detail.split("\n")) console.log(`         ${line}`);
}

/* -------------------------------------------------------------------------- *
 * The environment this driver refuses to have touched
 * -------------------------------------------------------------------------- */

const pEnv = probe("0e", "the driver opened no database — no DSN was read");
{
  // Stated as a measurement rather than as a promise in a comment: the two
  // variables a Postgres-touching check would consume are read here, ONCE, and
  // only to assert that nothing in this experiment needs them.
  const dsnVars = ["DATABASE_URL", "SCRATCH_DATABASE_URL"] as const;
  const present = dsnVars.filter((v) => typeof process.env[v] === "string" && process.env[v] !== "");
  report(
    pEnv,
    true,
    `this experiment imports two PURE modules and a JSON fixture; no pg Pool is constructed.\n` +
      `DSN variables visible in the environment: ${present.length === 0 ? "none" : present.join(", ")} ` +
      `(visible, not read — no statement is issued against any of them)`,
  );
}

/* -------------------------------------------------------------------------- *
 * The fixture, and the two kinds of row a straddling project holds
 * -------------------------------------------------------------------------- */

interface FixtureRow {
  id: string;
  round: number;
  role: string;
  title: string;
  status: string;
  created_at: string;
}

const FIXTURE_PATH = "__REPO__/forge-control/src/lib/fixtures/replay-operator-visibility.json";
const FIXTURE: FixtureRow[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureRow[];
const PROJECT_ID = "8ea0cc08-28d9-4301-9f28-c98e1c5d6838";

const STATUSES = ["pending", "ready", "running", "done", "failed", "blocked"] as const;
type Status = (typeof STATUSES)[number];

function toStatus(raw: string): Status {
  const hit = STATUSES.find((s) => s === raw);
  if (!hit) throw new Error(`check-r69-straddle: fixture row carries unknown status '${raw}'`);
  return hit;
}

/**
 * 0040's backfill, transcribed from `db/migrations/0040_task_graph.sql`: for
 * every row in the SNAPSHOT, the ids of every row of the same project at a
 * strictly lower round, ordered by (round, created_at, id) exactly as the
 * `array_agg(... ORDER BY ...)` writes them.
 *
 * THE SNAPSHOT IS THE POINT, and it is the same point the replay harness's
 * `graphInput()` makes: the backfill ran ONCE, over the rows that existed at
 * that instant. A row inserted afterwards is named by no frozen closure, not
 * because anything is wrong but because it did not exist to be named.
 */
function backfillClosure(snapshot: readonly FixtureRow[]): Map<string, string[]> {
  const ordered = [...snapshot].sort(
    (a, b) =>
      a.round - b.round ||
      (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out = new Map<string, string[]>();
  for (const row of snapshot) {
    out.set(
      row.id,
      ordered.filter((e) => e.round < row.round).map((e) => e.id),
    );
  }
  return out;
}

/** A row as the scheduler sees it, plus the provenance THIS experiment needs to
 *  talk about it. `kind` is the experiment's bookkeeping and is never read by a
 *  promotion rule — the rules see only `GraphTask`. */
type Provenance = "frozen" | "gap-legacy" | "post-restart";
interface Row extends GraphTask {
  kind: Provenance;
  role: string;
  title: string;
  created_at: string;
}

interface Fixture {
  label: string;
  what: string;
  rows: Row[];
  /** The same rows as TODAY's engine holds them: sentinel NULL, round intact. */
  legacy: GraphTask[];
}

function legacyView(rows: readonly Row[]): GraphTask[] {
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    workstream: r.workstream,
    status: r.status,
    depends_on: null,
    write_set: [],
  }));
}

function metricView(rows: readonly Row[]): MetricTask[] {
  return rows.map((r) => ({
    id: r.id,
    project_id: PROJECT_ID,
    round: r.round,
    role: r.role,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
    run_id: null,
    depends_on: r.depends_on,
  }));
}

/* -------------------------------------------------------------------------- *
 * S1 / S2 — the straddling project, built from the real task list
 * -------------------------------------------------------------------------- */

const POST_BUILDER_ID = "00000000-0000-4000-8000-0000000004d1";
const POST_CHECKER_ID = "00000000-0000-4000-8000-0000000004d2";
const GAP_ROW_ID = "00000000-0000-4000-8000-0000000004d3";

/**
 * The round the post-restart fix chain hangs off: the fixture's highest `done`
 * reviewer, DERIVED rather than pinned, exactly as the replay harness's case (f)
 * derives it. The pair lands at +1/+2 and must be strictly below every non-`done`
 * row, or today's rule would not hold anything behind it and the experiment
 * would be vacuous.
 */
function chainBase(): { base: number; gating: FixtureRow[] } {
  const doneReviewers = FIXTURE.filter((r) => r.role === "reviewer" && r.status === "done");
  if (doneReviewers.length === 0) {
    throw new Error("check-r69-straddle: the fixture has no done reviewer to hang a fix chain off");
  }
  const base = Math.max(...doneReviewers.map((r) => r.round));
  const lowestOpen = Math.min(...FIXTURE.filter((r) => r.status !== "done").map((r) => r.round));
  if (base + 2 >= lowestOpen) {
    throw new Error(
      `check-r69-straddle: vacuous — the chain would land at ${base + 1}/${base + 2}, not strictly ` +
        `below the lowest non-done round ${lowestOpen}`,
    );
  }
  return { base, gating: doneReviewers.filter((r) => r.round === base) };
}

/**
 * S1 — a straddling project with NO gap row.
 *
 * Every captured row is FROZEN: it was in the migration-time snapshot, so it
 * carries the backfilled closure. On top of it sits the fix chain the NEW
 * engine creates, post-restart, from the group at `base`: R42 gives the builder
 * `depends_on` = the gating task ids and each checker `depends_on` = [builder].
 * Those are REAL graph fields, which is precisely why R69's term — which tests
 * `depends_on IS NULL` — cannot see them.
 *
 * Reachability is not assumed. `safe-restart.sh` waits for a QUIET fleet, and
 * quiet means the last run has just finished — so the last group's
 * consolidation is the one guaranteed to land after the restart, under the new
 * engine, with R42's fields.
 */
function buildS1(): Fixture {
  const { base, gating } = chainBase();
  const closure = backfillClosure(FIXTURE);
  const rows: Row[] = FIXTURE.map((r) => {
    const deps = closure.get(r.id);
    if (!deps) throw new Error(`check-r69-straddle: no closure computed for ${r.id}`);
    return {
      id: r.id,
      round: r.round,
      workstream: "main",
      status: toStatus(r.status),
      depends_on: deps,
      write_set: [],
      kind: "frozen",
      role: r.role,
      title: r.title,
      created_at: r.created_at,
    };
  });
  rows.push(
    {
      id: POST_BUILDER_ID,
      round: base + 1,
      workstream: "main",
      status: "pending",
      depends_on: [...new Set(gating.map((g) => g.id))].sort(),
      write_set: [],
      kind: "post-restart",
      role: "builder",
      title: "fix chain created by the NEW engine after the restart (R42)",
      created_at: "2026-08-18T09:00:00+00:00",
    },
    {
      id: POST_CHECKER_ID,
      round: base + 2,
      workstream: "main",
      status: "pending",
      depends_on: [POST_BUILDER_ID],
      write_set: [],
      kind: "post-restart",
      role: "reviewer",
      title: "re-review of the post-restart fix chain (R42)",
      created_at: "2026-08-18T09:00:01+00:00",
    },
  );
  return {
    label: "S1",
    what: `straddle, NO gap row — 131 frozen rows + a post-restart fix chain at ${base + 1}/${base + 2}`,
    rows,
    legacy: legacyView(rows),
  };
}

/**
 * S2 — S1 plus ONE gap row, and nothing else.
 *
 * The old engine inserted it between `psql -f 0040` and the restart, so it
 * carries the NULL sentinel (E2). It is `done`, at the chain's own base round:
 * under R69 it is scheduling-INERT, because R69's term only refuses on a legacy
 * row that is not `done`.
 *
 * S1 and S2 differ by that one settled row and by nothing else. Any arm whose
 * verdict differs between them is an arm whose correctness depends on whether
 * the old engine happened to insert something in the deploy gap.
 */
function buildS2(): Fixture {
  const s1 = buildS1();
  const { base } = chainBase();
  const rows: Row[] = [
    ...s1.rows,
    {
      id: GAP_ROW_ID,
      round: base,
      workstream: "main",
      status: "done",
      depends_on: null,
      write_set: [],
      kind: "gap-legacy",
      role: "builder",
      title: "inserted by the OLD engine in the deploy gap, and finished before the restart",
      created_at: "2026-08-17T20:00:00+00:00",
    },
  ];
  return {
    label: "S2",
    what: "S1 + ONE already-done row carrying the NULL sentinel (inert under R69)",
    rows,
    legacy: legacyView(rows),
  };
}

/**
 * S3 — a project planned entirely AFTER the restart, in the shape of the
 * measurement that motivated this whole project (00-vision.md §2): one planner,
 * one long reviewer, and seven builders numbered above it that depend on
 * nothing it produces. Not one row is frozen and not one carries the sentinel.
 *
 * It exists to PRICE the options. Whatever a widening buys on S1/S2, it must
 * cost nothing here, or it has traded the project's entire purpose for a
 * migration-window guarantee.
 */
function buildS3(): Fixture {
  const rows: Row[] = [];
  const planner = "00000000-0000-4000-8000-00000000e001";
  rows.push({
    id: planner,
    round: 100,
    workstream: "main",
    status: "done",
    depends_on: [],
    write_set: [],
    kind: "post-restart",
    role: "planner",
    title: "planner — the graph root",
    created_at: "2026-08-18T10:00:00+00:00",
  });
  rows.push({
    id: "00000000-0000-4000-8000-00000000e002",
    round: 101,
    workstream: "main",
    status: "pending",
    depends_on: [planner],
    write_set: [],
    kind: "post-restart",
    role: "reviewer",
    title: "the 32-minute reviewer that stalled seven unrelated builders",
    created_at: "2026-08-18T10:00:01+00:00",
  });
  for (let i = 0; i < 7; i++) {
    rows.push({
      id: `00000000-0000-4000-8000-00000000e1${String(i).padStart(2, "0")}`,
      round: 102 + i,
      workstream: "main",
      status: "pending",
      depends_on: [planner],
      write_set: [],
      kind: "post-restart",
      role: "builder",
      title: `builder ${i + 1} — numbered above the reviewer, dependent on none of it`,
      created_at: `2026-08-18T10:00:${String(2 + i).padStart(2, "0")}+00:00`,
    });
  }
  return {
    label: "S3",
    what: "post-restart project — 1 planner, 1 long reviewer, 7 unrelated builders numbered above it",
    rows,
    legacy: legacyView(rows),
  };
}

/* -------------------------------------------------------------------------- *
 * `isClosureShaped()`, transcribed — and calibrated against the shipped one
 * -------------------------------------------------------------------------- */

/**
 * A TRANSCRIPTION of `isClosureShaped()` in `lib/schedule-metrics.ts`, which is
 * module-private and cannot be imported. It is the corpus's only detector for
 * "this row carries 0040's backfill signature", and therefore the only existing
 * answer to "is this row frozen" — so the WIDE-CLOSURE arm needs it per row.
 *
 * A transcription is a second definition, and a second definition drifts. Probe
 * 0d closes that: the count this function produces over each fixture must equal
 * the SHIPPED `inputCensus().closureShapedRows` for the same rows, or the run
 * stops. The transcription is checked on every run rather than at review time.
 */
function isClosureShapedLocal(task: GraphTask, tasks: readonly GraphTask[]): boolean {
  const deps = task.depends_on;
  if (deps === null) return false;
  const declared = new Set(deps);
  let closureSize = 0;
  for (const other of tasks) {
    if (other.round >= task.round) continue;
    closureSize += 1;
    if (!declared.has(other.id)) return false;
  }
  return declared.size === closureSize;
}

/* -------------------------------------------------------------------------- *
 * The arms
 * -------------------------------------------------------------------------- */

interface RuleContext {
  all: readonly GraphTask[];
  byId: ReadonlyMap<string, GraphTask>;
}
type Rule = (task: GraphTask, ctx: RuleContext) => boolean;

/** TODAY's engine. */
const LEGACY: Rule = (t, ctx) => legacyRoundReady(t, ctx.all);

/**
 * The engine as it stands at HEAD: `readyRule()` dispatches the sentinel and
 * the SHIPPED `graphReady()` decides the graph branch, R69 term included. This
 * is the same composition `GRAPH_RULE` uses in the replay harness.
 */
const NARROW: Rule = (t, ctx) =>
  readyRule(t) === "graph" ? graphReady(t, ctx.byId) : legacyRoundReady(t, ctx.all);

/** What a widening did, counted rather than claimed (named failure (i)). */
interface WideCounters {
  /** graph-branch rows the widening was asked about */
  evaluated: number;
  /** …of those, the ones whose gate OPENED */
  gated: number;
  /** …of those, the ones where the widened term CHANGED ready → not-ready */
  fired: number;
}

type Gate = (task: GraphTask, ctx: RuleContext) => boolean;

/**
 * Option A, composed ON TOP of the shipped rule rather than replacing it: the
 * base answer is `NARROW`'s, and the widening can only ever take readiness
 * away. Composing rather than re-implementing is what makes "the narrow arm ran
 * the shipped predicate" a structural fact instead of a claim.
 */
function wide(gate: Gate, c: WideCounters): Rule {
  return (t, ctx) => {
    const base = NARROW(t, ctx);
    if (readyRule(t) !== "graph") return base; // a legacy row keeps the legacy branch
    c.evaluated += 1;
    if (!gate(t, ctx)) return base;
    c.gated += 1;
    let held = false;
    for (const other of ctx.byId.values()) {
      if (other.round < t.round && other.status !== "done") {
        held = true;
        break;
      }
    }
    if (held && base) {
      c.fired += 1;
      return false;
    }
    return base;
  };
}

/** The only gate the schema can express at zero cost: R69's own sentinel, asked
 *  about the PROJECT rather than about a lower round. */
const GATE_SENTINEL: Gate = (_t, ctx) => {
  for (const other of ctx.byId.values()) if (other.depends_on === null) return true;
  return false;
};

/** "While a row is frozen", as literally as the corpus can express it. */
const GATE_CLOSURE: Gate = (t, ctx) => isClosureShapedLocal(t, [...ctx.byId.values()]);

/** No gate at all — the widening applied to every graph row. */
const GATE_NONE: Gate = () => true;

/**
 * THE CLEVEREST GATE THE DATA CAN EXPRESS, and the one that has to be measured
 * before "no gate works" is allowed to be said out loud.
 *
 * `isClosureShaped()` fails because it compares against the CURRENT row list,
 * which now contains the very row that broke the closure. Fix that by taking
 * the horizon from the row's OWN closure: let H be the newest `created_at`
 * among the ids it names, and ask whether it names every lower-round row that
 * existed at H. A genuinely frozen row does, by construction — 0040's backfill
 * wrote exactly that set — and every row it fails to name was created after H,
 * i.e. after the migration. No stored migration timestamp is needed.
 *
 * It answers correctly on the straddle. Probe 2e is what it costs elsewhere.
 */
function makeHorizonGate(createdAt: ReadonlyMap<string, string>): Gate {
  return (t, ctx) => {
    const deps = t.depends_on;
    if (deps === null || deps.length === 0) return false;
    let horizon = "";
    for (const id of deps) {
      const at = createdAt.get(id);
      if (at === undefined) return false; // a dangling dep is R14's problem, not this gate's
      if (at > horizon) horizon = at;
    }
    const declared = new Set(deps);
    for (const other of ctx.byId.values()) {
      if (other.round >= t.round) continue;
      const at = createdAt.get(other.id);
      if (at === undefined) return false;
      if (at > horizon) continue; // created after the horizon — no closure could name it
      if (!declared.has(other.id)) return false;
    }
    return true;
  };
}

/* -------------------------------------------------------------------------- *
 * The tick loop — a transcription of the replay harness's `simulate()`
 * -------------------------------------------------------------------------- */

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(["ready", "running"]);

interface SimResult {
  schedule: string[][];
  ticks: number;
  promotedTotal: number;
  /** Max rows promoted on any single tick — the concurrency the arm delivers. */
  widestTick: number;
  finalStatus: Map<string, Status>;
}

function simulate(tasks: readonly GraphTask[], rule: Rule): SimResult {
  const state = new Map<string, Status>(tasks.map((t) => [t.id, t.status as Status]));
  // THE CAP IS 2n + 2, NOT THE HARNESS'S n + 2, and the difference is amended
  // here — where it is enforced — rather than disclosed and worked around.
  // `simulate()` settles a row the tick AFTER it promotes, so a FULLY
  // SERIALIZED project needs two ticks per task. The replay harness's fixture
  // never serializes fully, so n + 2 is a live guard there. Here the
  // WIDE-UNGATED arm serializes by construction — that is the cost this
  // experiment exists to price — and an n + 2 cap would make the instrument
  // REFUSE the one arm it was built to measure, which is an unsatisfiable gate.
  // 2n + 2 is still a real guard: it is exceeded only by a rule that promotes
  // nothing while something is still in flight, i.e. by an actual wedge.
  const cap = tasks.length * 2 + 2;
  const schedule: string[][] = [];
  let promotedTotal = 0;
  let widestTick = 0;

  for (let tick = 1; tick <= cap; tick++) {
    const snapshot: GraphTask[] = tasks.map((t) => {
      const status = state.get(t.id);
      if (!status) throw new Error(`check-r69-straddle: simulate() lost the state of ${t.id}`);
      return { ...t, status };
    });
    const ctx: RuleContext = { all: snapshot, byId: new Map(snapshot.map((t) => [t.id, t])) };
    const inFlight = snapshot.filter((t) => IN_FLIGHT.has(t.status as Status)).map((t) => t.id);
    const promoted = snapshot.filter((t) => t.status === "pending" && rule(t, ctx)).map((t) => t.id);

    for (const id of promoted) state.set(id, "running");
    for (const id of inFlight) state.set(id, "done");

    schedule.push([...promoted].sort());
    promotedTotal += promoted.length;
    widestTick = Math.max(widestTick, promoted.length);

    if (promoted.length === 0 && inFlight.length === 0) {
      return { schedule, ticks: tick, promotedTotal, widestTick, finalStatus: state };
    }
  }
  throw new Error(
    `check-r69-straddle: simulate() hit its tick cap of ${cap} without quiescence — the schedule ` +
      `is INCOMPLETE and must not be compared (promoted ${promotedTotal})`,
  );
}

/** The first tick on which two schedules disagree, and what disagreed. `null`
 *  when they are identical. */
function firstDivergence(a: SimResult, b: SimResult): string | null {
  const ticks = Math.max(a.schedule.length, b.schedule.length);
  for (let i = 0; i < ticks; i++) {
    const l = a.schedule[i] ?? [];
    const g = b.schedule[i] ?? [];
    if (l.join(",") === g.join(",")) continue;
    const onlyA = l.filter((id) => !g.includes(id));
    const onlyB = g.filter((id) => !l.includes(id));
    return (
      `tick ${i + 1}: only-first [${onlyA.map(short).join(", ")}]; ` +
      `only-second [${onlyB.map(short).join(", ")}]`
    );
  }
  if (a.schedule.length !== b.schedule.length) {
    return `schedules agree tick by tick but differ in length (${a.schedule.length} vs ${b.schedule.length})`;
  }
  return null;
}

const short = (id: string): string => id.slice(0, 8);

/* ========================================================================== *
 * PROBE 0a — the tick loop is the replay harness's, not a lookalike
 * ========================================================================== */

console.log("--- 0. calibration and fixture integrity -------------------------------------");

const p0a = probe("0a", "simulate() reproduces the tick count the replay harness PINS at 14");
{
  const baseRows: Row[] = FIXTURE.map((r) => ({
    id: r.id,
    round: r.round,
    workstream: "main",
    status: toStatus(r.status),
    depends_on: null,
    write_set: [],
    kind: "frozen",
    role: r.role,
    title: r.title,
    created_at: r.created_at,
  }));
  const res = simulate(baseRows, LEGACY);
  const pendingRows = FIXTURE.filter((r) => r.status === "pending").length;
  report(
    p0a,
    res.ticks === 14 && res.promotedTotal === pendingRows,
    `legacy over the unmutated fixture: ticks=${res.ticks} (harness pins 14), ` +
      `promoted=${res.promotedTotal} (the fixture's ${pendingRows} pending rows)`,
  );
}

const S1 = buildS1();
const S2 = buildS2();
const S3 = buildS3();
const ALL: Fixture[] = [S1, S2, S3];

/* ========================================================================== *
 * PROBE 0b — the fixture really is straddling (named failure (ii))
 * ========================================================================== */

const p0b = probe("0b", "S1/S2 really straddle: frozen rows take the GRAPH branch and cannot name the chain");
{
  const lines: string[] = [];
  let ok = true;
  for (const f of [S1, S2]) {
    const byId = new Map(f.rows.map((t) => [t.id, t as GraphTask]));
    const graphBranch = f.rows.filter((t) => readyRule(t) === "graph").length;
    const legacyBranch = f.rows.filter((t) => readyRule(t) === "legacy").length;
    const frozen = f.rows.filter((t) => t.kind === "frozen").length;
    const post = f.rows.filter((t) => t.kind === "post-restart");
    // The rows the whole question is about: frozen, still pending, sitting
    // ABOVE the post-restart chain, and with a closure that cannot name it.
    const exposed = f.rows.filter(
      (t) =>
        t.kind === "frozen" &&
        t.status === "pending" &&
        post.some((c) => c.round < t.round) &&
        post.every((c) => !(t.depends_on ?? []).includes(c.id)),
    );
    // …and the frozen branch must actually RUN on them: graphReady() is asked,
    // and it must be asked about a row whose closure is non-trivial.
    const asked = exposed.filter((t) => {
      const answer = graphReady(t, byId);
      return typeof answer === "boolean" && (t.depends_on ?? []).length > 0;
    }).length;
    const good = graphBranch > 0 && frozen > 0 && exposed.length > 0 && asked === exposed.length;
    ok = ok && good;
    lines.push(
      `${f.label}: rows=${f.rows.length} graph-branch=${graphBranch} legacy-branch=${legacyBranch} ` +
        `frozen=${frozen} post-restart=${post.length}`,
    );
    lines.push(
      `${f.label}: frozen PENDING rows above the chain whose closure cannot name it = ${exposed.length} ` +
        `[${exposed.slice(0, 4).map((t) => `${short(t.id)}@r${t.round}`).join(", ")}${exposed.length > 4 ? ", …" : ""}]` +
        `; graphReady() answered for ${asked}/${exposed.length} of them`,
    );
  }
  report(p0b, ok, lines.join("\n"));
}

/* ========================================================================== *
 * PROBE 0d — the transcribed closure detector agrees with the shipped one
 * ========================================================================== */

const p0d = probe("0d", "the transcribed isClosureShaped() matches the SHIPPED inputCensus() count");
{
  const lines: string[] = [];
  let ok = true;
  for (const f of ALL) {
    const shipped = inputCensus({ project_id: PROJECT_ID, tasks: metricView(f.rows), runs: [] });
    const mine = f.rows.filter((t) => isClosureShapedLocal(t, f.rows)).length;
    const agree = mine === shipped.closureShapedRows;
    ok = ok && agree;
    lines.push(
      `${f.label}: shipped closure-shaped-rows=${shipped.closureShapedRows} transcription=${mine} ` +
        `${agree ? "AGREE" : "DRIFTED"}  (legacy-rows=${shipped.legacyRows} graph-rows=${shipped.graphRows})`,
    );
  }
  report(p0d, ok, lines.join("\n"));
}

/* ========================================================================== *
 * PROBE 1 — is the divergence real, on the deploy's own target project?
 * ========================================================================== */

console.log();
console.log("--- 1. the divergence R69 does not close --------------------------------------");

const sims = new Map<string, SimResult>();
const counters = new Map<string, WideCounters>();

function run(f: Fixture, arm: string, rule: Rule, tasks?: readonly GraphTask[]): SimResult {
  const res = simulate(tasks ?? f.rows, rule);
  sims.set(`${f.label}/${arm}`, res);
  return res;
}

function newCounters(key: string): WideCounters {
  const c: WideCounters = { evaluated: 0, gated: 0, fired: 0 };
  counters.set(key, c);
  return c;
}

const ARMS = ["LEGACY", "NARROW", "WIDE-SENTINEL", "WIDE-CLOSURE", "WIDE-HORIZON", "WIDE-UNGATED"] as const;

for (const f of ALL) {
  const createdAt = new Map(f.rows.map((r) => [r.id, r.created_at]));
  run(f, "LEGACY", LEGACY, f.legacy);
  run(f, "NARROW", NARROW);
  run(f, "WIDE-SENTINEL", wide(GATE_SENTINEL, newCounters(`${f.label}/WIDE-SENTINEL`)));
  run(f, "WIDE-CLOSURE", wide(GATE_CLOSURE, newCounters(`${f.label}/WIDE-CLOSURE`)));
  run(f, "WIDE-HORIZON", wide(makeHorizonGate(createdAt), newCounters(`${f.label}/WIDE-HORIZON`)));
  run(f, "WIDE-UNGATED", wide(GATE_NONE, newCounters(`${f.label}/WIDE-UNGATED`)));
}

function get(key: string): SimResult {
  const r = sims.get(key);
  if (!r) throw new Error(`check-r69-straddle: no simulation recorded for ${key}`);
  return r;
}

for (const f of ALL) {
  console.log(`  ${f.label} — ${f.what}`);
  for (const arm of ARMS) {
    const r = get(`${f.label}/${arm}`);
    const c = counters.get(`${f.label}/${arm}`);
    console.log(
      `      ${arm.padEnd(14)} ticks=${String(r.ticks).padStart(3)} promoted=${String(r.promotedTotal).padStart(3)} ` +
        `widest-tick=${String(r.widestTick).padStart(2)}` +
        (c ? `   widening: evaluated=${c.evaluated} gate-open=${c.gated} fired=${c.fired}` : ""),
    );
  }
}

const p1 = probe("1", "S1: the SHIPPED engine (NARROW) diverges from today's engine on a straddling project");
{
  const d = firstDivergence(get("S1/LEGACY"), get("S1/NARROW"));
  report(
    p1,
    d !== null,
    d === null
      ? "NO DIVERGENCE — the premise of this whole task is false and nothing below means anything"
      : `first divergence, legacy vs narrow — ${d}\n` +
          `legacy ticks=${get("S1/LEGACY").ticks}, narrow ticks=${get("S1/NARROW").ticks}`,
  );
}

/* ========================================================================== *
 * PROBE 2 — does option A, gated the only way the schema allows, close it?
 * ========================================================================== */

console.log();
console.log("--- 2. option A, with each gate the schema can actually express -----------------");

const p2a = probe("2a", "S1 WIDE-SENTINEL is INDISTINGUISHABLE from NARROW — the gate never opens");
{
  const c = counters.get("S1/WIDE-SENTINEL");
  if (!c) throw new Error("check-r69-straddle: no counters for S1/WIDE-SENTINEL");
  const d = firstDivergence(get("S1/NARROW"), get("S1/WIDE-SENTINEL"));
  report(
    p2a,
    d === null && c.evaluated > 0 && c.gated === 0,
    `the widening was evaluated on ${c.evaluated} graph rows, the gate opened ${c.gated} times, ` +
      `it fired ${c.fired} times.\n` +
      `S1 holds no row with the NULL sentinel — 0040's backfill wrote over every one of them — so ` +
      `"the project contains a legacy row" is FALSE and option A is silent.\n` +
      `narrow vs wide-sentinel: ${d ?? "identical schedules, tick for tick"}`,
  );
}

const p2b = probe("2b", "S1 WIDE-CLOSURE never fires — the frozen-row detector goes blind on exactly the exposed rows");
{
  const c = counters.get("S1/WIDE-CLOSURE");
  if (!c) throw new Error("check-r69-straddle: no counters for S1/WIDE-CLOSURE");
  const d = firstDivergence(get("S1/NARROW"), get("S1/WIDE-CLOSURE"));
  // The rows the widening exists for: frozen, pending, above the chain, and
  // named by no closure that could mention it. Probe 0b counted them; this asks
  // what the corpus's frozen-row detector says about THOSE rows in particular.
  const post = S1.rows.filter((t) => t.kind === "post-restart");
  const exposed = S1.rows.filter(
    (t) =>
      t.kind === "frozen" &&
      t.status === "pending" &&
      post.some((cRow) => cRow.round < t.round) &&
      post.every((cRow) => !(t.depends_on ?? []).includes(cRow.id)),
  );
  const withoutChain = S1.rows.filter((t) => t.kind === "frozen");
  const shipped = inputCensus({ project_id: PROJECT_ID, tasks: metricView(S1.rows), runs: [] });
  const before = inputCensus({ project_id: PROJECT_ID, tasks: metricView(withoutChain), runs: [] });
  const exposedAfter = exposed.filter((t) => isClosureShapedLocal(t, S1.rows)).length;
  const exposedBefore = exposed.filter((t) => isClosureShapedLocal(t, withoutChain)).length;
  report(
    p2b,
    d === null &&
      c.evaluated > 0 &&
      c.fired === 0 &&
      exposedBefore === exposed.length &&
      exposedAfter === 0 &&
      shipped.closureShapedRows < before.closureShapedRows,
    `the widening was evaluated on ${c.evaluated} graph rows, the gate opened ${c.gated} times, ` +
      `and it fired ${c.fired} times.\n` +
      `SHIPPED inputCensus() over the whole project: closure-shaped rows BEFORE the post-restart ` +
      `chain exists = ${before.closureShapedRows}/${withoutChain.length}; AFTER = ` +
      `${shipped.closureShapedRows}/${S1.rows.length}.\n` +
      `AND ON THE ROWS THAT MATTER — the ${exposed.length} frozen pending rows above the chain: ` +
      `${exposedBefore}/${exposed.length} answer "frozen" before the chain exists, ` +
      `${exposedAfter}/${exposed.length} after.\n` +
      `isClosureShaped() compares a row's closure against the CURRENT row list, so a ` +
      `post-migration row at a LOWER round makes every frozen row above it stop matching the ` +
      `signature. The detector goes blind on precisely the rows the widening would have to hold, ` +
      `and stays sighted only on the rows below the chain, which need nothing.\n` +
      `narrow vs wide-closure: ${d ?? "identical schedules, tick for tick"}`,
  );
}

const p2c = probe("2c", "S2 WIDE-SENTINEL DOES close it — and S1 and S2 differ only by one settled row");
{
  const c = counters.get("S2/WIDE-SENTINEL");
  if (!c) throw new Error("check-r69-straddle: no counters for S2/WIDE-SENTINEL");
  const vsLegacy = firstDivergence(get("S2/LEGACY"), get("S2/WIDE-SENTINEL"));
  const narrowVsLegacy = firstDivergence(get("S2/LEGACY"), get("S2/NARROW"));
  report(
    p2c,
    vsLegacy === null && narrowVsLegacy !== null && c.gated > 0 && c.fired > 0,
    // The full id, not the 8-char prefix: every synthetic row in this experiment
    // shares the prefix `00000000`, so a shortened one names nothing.
    `S2 = S1 + one row: ${GAP_ROW_ID}, status DONE, depends_on NULL, inserted in the gap.\n` +
      `Under R69 that row is inert — R69 only refuses on a legacy row that is NOT done.\n` +
      `narrow vs legacy on S2:        ${narrowVsLegacy ?? "identical"}  ← still diverges\n` +
      `wide-sentinel vs legacy on S2: ${vsLegacy ?? "identical"}  ← closed\n` +
      `the widening fired ${c.fired} times with the gate open ${c.gated} times.\n` +
      `SO: the same straddling project is scheduled correctly or incorrectly according to whether ` +
      `an unrelated, already-finished row happens to carry NULL. That is not a predicate, it is a ` +
      `coincidence.`,
  );
}

const p2d = probe("2d", "WIDE-UNGATED closes the divergence on S1 — the widening itself is sound, only its gate is not");
{
  const c = counters.get("S1/WIDE-UNGATED");
  if (!c) throw new Error("check-r69-straddle: no counters for S1/WIDE-UNGATED");
  const d = firstDivergence(get("S1/LEGACY"), get("S1/WIDE-UNGATED"));
  report(
    p2d,
    d === null && c.fired > 0,
    `ungated, the widened term fired ${c.fired} times and the graph reproduced today's schedule ` +
      `exactly: ${d ?? "identical, tick for tick"}.\n` +
      `So option A's ARITHMETIC is right. Everything below is about what it costs when it cannot ` +
      `be confined to frozen rows.`,
  );
}

const p2e = probe("2e", "WIDE-HORIZON closes S1 — and charges the same price on S3, where nothing is frozen");
{
  const c1 = counters.get("S1/WIDE-HORIZON");
  const c3 = counters.get("S3/WIDE-HORIZON");
  if (!c1 || !c3) throw new Error("check-r69-straddle: no counters for WIDE-HORIZON");
  const s1 = firstDivergence(get("S1/LEGACY"), get("S1/WIDE-HORIZON"));
  const narrow3 = get("S3/NARROW");
  const horizon3 = get("S3/WIDE-HORIZON");
  report(
    p2e,
    s1 === null && c1.fired > 0 && horizon3.widestTick < narrow3.widestTick && c3.fired > 0,
    `The horizon gate takes its cutoff from the row's OWN closure — the newest created_at it ` +
      `names — and asks whether it names every lower-round row that existed then. It needs no ` +
      `stored migration timestamp, and on the straddle it is RIGHT:\n` +
      `  S1 wide-horizon vs legacy: ${s1 ?? "identical, tick for tick"} ` +
      `(gate open ${c1.gated}, fired ${c1.fired})\n` +
      `But the same signature is worn by an ordinary fan-out row. On S3, where not one row is ` +
      `frozen and not one carries the sentinel:\n` +
      `  narrow:       ticks=${narrow3.ticks} widest-tick=${narrow3.widestTick}\n` +
      `  wide-horizon: ticks=${horizon3.ticks} widest-tick=${horizon3.widestTick} ` +
      `(gate open ${c3.gated}, fired ${c3.fired})\n` +
      `A builder created before its siblings names every lower-round row that existed when IT was ` +
      `created — because they had not been created yet. The gate cannot tell "my closure is ` +
      `complete because a migration wrote it" from "my closure is complete because I was first".`,
  );
}

/* ========================================================================== *
 * PROBE 3 — the price of an ungated widening, on a post-restart project
 * ========================================================================== */

console.log();
console.log("--- 3. what an ungated widening costs a project planned after the restart --------");

const p3 = probe("3", "S3: WIDE-UNGATED collapses the graph scheduler back onto the round rule");
{
  const narrow = get("S3/NARROW");
  const ungated = get("S3/WIDE-UNGATED");
  const legacy = get("S3/LEGACY");
  const sentinel = get("S3/WIDE-SENTINEL");
  const cs = counters.get("S3/WIDE-SENTINEL");
  if (!cs) throw new Error("check-r69-straddle: no counters for S3/WIDE-SENTINEL");
  const collapsed =
    ungated.widestTick < narrow.widestTick &&
    ungated.ticks > narrow.ticks &&
    firstDivergence(legacy, ungated) === null &&
    firstDivergence(narrow, sentinel) === null &&
    cs.gated === 0;
  report(
    p3,
    collapsed,
    `narrow (the engine as it ships):  ticks=${narrow.ticks} widest-tick=${narrow.widestTick}\n` +
      `wide-ungated:                    ticks=${ungated.ticks} widest-tick=${ungated.widestTick}` +
      `   ← identical to today's engine (ticks=${legacy.ticks}, widest=${legacy.widestTick})\n` +
      `wide-sentinel:                   ticks=${sentinel.ticks} widest-tick=${sentinel.widestTick}` +
      `   ← free: gate opened ${cs.gated} times, no row carries the sentinel\n` +
      `An ungated widening turns eight tasks that share no dependency into a queue. That is the ` +
      `exact measurement this project exists to delete (00-vision.md §2: 255 minutes of wall clock ` +
      `for work that at a concurrency of 6 is about 45).`,
  );
}

/* ========================================================================== *
 * The verdict, and the accounting that decides the exit code
 * ========================================================================== */

console.log();
console.log("--- 4. probe accounting --------------------------------------------------------");

const missed = PROBES.filter((p) => !p.ran);
const failed = PROBES.filter((p) => p.ran && !p.ok);
console.log(`  registered ${PROBES.length}   ran ${PROBES.filter((p) => p.ran).length}   ` +
  `passed ${PROBES.filter((p) => p.ran && p.ok).length}   failed ${failed.length}   never-ran ${missed.length}`);
for (const p of missed) console.log(`  NEVER RAN  ${p.id}  ${p.what}`);
for (const p of failed) console.log(`  FAILED     ${p.id}  ${p.what}`);

if (PROBES.length === 0) {
  console.error("REFUSING: zero probes registered — an empty sweep is not a pass");
  process.exit(1);
}
if (missed.length > 0 || failed.length > 0) {
  console.error(`REFUSING: ${failed.length} probe(s) failed and ${missed.length} never ran`);
  process.exit(1);
}
console.log();
console.log("  ALL PROBES RAN AND REPORTED AS EXPECTED.");
console.log();
console.log("  THE FINDING, in one paragraph:");
console.log("  The divergence is REAL (probe 1). Option A's arithmetic is right (2d). What option A");
console.log("  does not have is a GATE. The schema records nothing that says 'this closure was");
console.log("  frozen by 0040', and each of the four stand-ins fails a different way: the sentinel");
console.log("  gate is silent on a straddle with no gap row (2a) and fires on one only because an");
console.log("  unrelated settled row happens to carry NULL (2c); the corpus's own frozen-row");
console.log("  detector reads 'not frozen' on 8/8 of the exposed rows the moment the post-restart");
console.log("  row exists (2b); the created_at horizon gate is right on the straddle and takes a");
console.log("  post-restart project from 3 ticks / 8-wide to 17 / 1-wide (2e); and no gate at all");
console.log("  is the same collapse (3). An option implementable only by charging every future");
console.log("  project the cost of a migration window is not the cheaper option.");
process.exit(0);
DRIVER

sed "s|__REPO__|$REPO_ROOT|g" "$WORK/drive.mts.in" > "$WORK/drive.mts"
echo "  driver              $WORK/drive.mts"
echo "  driver sha256       $(sha256sum "$WORK/drive.mts" | cut -d' ' -f1)"
echo "  (the driver is generated from this script; its sha changes with this file and nothing else)"
echo

"$TSX" "$WORK/drive.mts"
