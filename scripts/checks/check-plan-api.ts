/**
 * check-plan-api.ts — the behavioural proof of phase 6's read path: R54, R55,
 * and the mechanical half of R56.
 *
 * `03-quality.md` §3.2's phase-6 gate asks the reviewer to "load the /plan
 * response for a fixture project and confirm `deps` are real edges for graph
 * rows and synthesised for NULL rows". Nothing in this repo could do that: the
 * straddle lives in `groupPlanPhases`, which reads rows out of Postgres, and a
 * build task may not touch a live database. This is the instrument that can,
 * against $SCRATCH_DATABASE_URL and nothing else.
 *
 * THE ASSERTIONS ARE WRITTEN FROM THE CONTRACT, NOT FROM THE CODE — R54, R55
 * and R56 in `01-requirements.md` §G, and `groupPlanPhases`'s own doc-comment,
 * which named this refinement before it existed and promised it would not
 * change the response shape. Where the shipped code and the requirement
 * disagree, the disagreement is a FINDING in
 * `docs/plan/engine-task-graph/evidence/phase6-plan-api.md` and the assertion
 * keeps saying what the requirement says. A probe derived from the code it
 * tests proves only that the code equals itself.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR PREAMBLE — run these three lines once, by hand, before this script.
 * This script NEVER invents credentials: it only consumes
 * $SCRATCH_DATABASE_URL. Creating a scratch DATABASE on this host is authorised
 * and conventional (forge_tg_scratch, forge_r850_dryrun, fleet_selftest and a
 * dozen siblings already exist). Authorised means CREATE DATABASE issued while
 * connected to the `postgres` MAINTENANCE database. It never means a statement
 * of any kind against content_forge.
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
 *   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options — the same gap
 * 03-quality.md §3.2 named for scripts/measure-schedule.ts at phase 7):
 *   cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
 *     --module ESNext --moduleResolution bundler --lib ES2022 --skipLibCheck \
 *     --allowImportingTsExtensions --resolveJsonModule --types node \
 *     ../scripts/checks/check-plan-api.ts
 *
 * Exit: 0 = every case ran, executed exactly the assertions it declares, and
 * every one of them passed. Anything else is non-zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A *.test.ts
 *
 * NF3: the unit suite is hermetic and never touches a database. The straddle
 * this proves is a property of ROWS — a NULL `depends_on` beside a `'{}'` one
 * in a single result set — and JSON `null` versus an empty array is exactly the
 * distinction a hand-built object fixture cannot keep honest. It therefore
 * lives here beside check-task-api.ts and check-migration-0040.sh and must
 * NEVER be added to `pnpm test`.
 *
 * ---------------------------------------------------------------------------
 * HOW THE HARNESS IS BUILT — three constraints, each verified, not assumed.
 * check-task-api.ts's header documents the same three; they are restated rather
 * than cross-referenced because getting the third one wrong points a build task
 * at production.
 *
 * 1. MOUNT ONLY THE ROUTERS. NEVER boot forge-control/src/index.ts: it starts
 *    startCronTick(), startTelegramBridge() and startVaultSyncTick() against the
 *    same database and the same Telegram bot token. A second instance would
 *    double-fire cron schedules and spawn real runs, STEAL KONRAD'S TELEGRAM
 *    LONG-POLL, and write to the vault. `scripts/checks/serve-agents-7798.ts`
 *    is the precedent and its header documents this.
 *
 * 2. NO BARE IMPORTS. `scripts/checks/` has no node_modules and there is none at
 *    the repo root: a file here doing `import pg from "pg"` dies with
 *    MODULE_NOT_FOUND. So: node:http + `router.fetch(new Request(...))` for the
 *    API, node:child_process + `psql` for the database, and RELATIVE imports of
 *    ../../forge-control/src/routes/*.ts, whose own bare imports resolve from
 *    forge-control/node_modules.
 *
 * 3. THE POOL IS BUILT AT MODULE LOAD, and this probe loads FOUR of them.
 *    `routes/chat.ts` builds `teamPool` from `process.env.DATABASE_URL` at
 *    import time and DEFAULTS TO content_forge when unset; so do
 *    `routes/chat-linkage.ts`, `db/runs.ts` and `db/projects.ts`, each reached
 *    transitively by the two routers under test. A STATIC import hoists above
 *    every statement in this file, so all four pools would be built against the
 *    live database before the first line runs — and the very first thing this
 *    probe does is seed rows and read them back. The routers are therefore
 *    loaded through a DYNAMIC `await import()`, after DATABASE_URL and PGOPTIONS
 *    have been set. THIS IS THE MOST DANGEROUS LINE IN THE FILE.
 *
 *    PGOPTIONS reaching the startup packet was verified empirically for
 *    check-task-api.ts (2026-08-17, in this worktree) and is re-proved on every
 *    run here by positive control 0a, which fails the whole script if the
 *    routers are not reading the throwaway schema.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY (standing rule 3)
 *
 *  (a) A FIXTURE WHERE THE SYNTHESISED SET AND THE REAL SET COINCIDE. Then
 *      `deps: [...lower]` for every row — the exact mutation this phase must
 *      rule out — passes case A. Disarmed by ASSERTION, not by inspection:
 *      case A recomputes the synthesised set from the response itself and
 *      asserts it DIFFERS from the declared `depends_on`, in content and in
 *      order, before asserting `deps` equals the declared one. A fixture edited
 *      into coincidence fails on that assertion instead of passing quietly.
 *      Case B does the same for the `'{}'` root: two lower rounds are seeded so
 *      `[]` and the synthesised set cannot be confused.
 *
 *  (b) A PROBE THAT NEVER REACHED THE ROUTE — the dynamic import failed, a
 *      friendly catch printed a message, and the run "passed" having asserted
 *      nothing. Disarmed three ways: the import is NOT wrapped in a try (an
 *      ImportError aborts the process through the top-level catch, which prints
 *      "ABORTED — NOT a pass" and exits 1); positive controls 0a and 0b run
 *      first and abort the run unless a real HTTP round-trip returns rows this
 *      script seeded; and every case DECLARES its assertion count, with the
 *      runner comparing declared against executed in BOTH directions plus cases
 *      planned against cases that asserted anything. On the night of
 *      2026-08-16/17 a hover probe clipping to the viewport left 9 of 21 targets
 *      untouched and reported success; a sweep whose probes miss must fail.
 *
 *  (c) A DEPTH FIELD THAT SIMPLY RETURNS `round`. Indistinguishable from a
 *      working `taskDepth()` on any fixture where the two agree. Case F seeds
 *      the disagreement the gate needs — rounds 100/101/102 where 102 depends
 *      only on 100, so depth is 0/1/1 — and asserts the depths AND the rounds,
 *      so the transcript shows the two answers side by side.
 *
 *  (d) READING NULL-VS-EMPTY THROUGH JSON. `null` and `[]` can both arrive
 *      looking like absence depending on the serializer, and the distinction
 *      between them IS the straddle. Every fixture row's sentinel is asserted
 *      against `SELECT depends_on IS NULL` in psql, not through the API, before
 *      the API's answer is judged.
 *
 *  (e) A CYCLE CASE THAT PASSES BECAUSE THE ROUTE 500ed. Case G asserts the
 *      status is 200 AND that `graph_error` names BOTH cyclic ids AND that
 *      every depth equals its round — including a graph root whose depth would
 *      be 0 if a partial map had been returned instead of the disclosed
 *      fallback.
 *
 *  (f) A HARNESS THAT DOES NOT SAY WHICH BYTES IT CHECKED. The provenance block
 *      prints the worktree, its git SHA, the sha256 of each shipped file under
 *      test, the scratch database NAME (never the DSN), and the row counts
 *      seeded — so a transcript produced against a mutated tree is legible as
 *      such rather than reading as authoritative.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
/** Typed `number` and not the literal `7797`: the never-7700 guard below is a
 *  RUNTIME check that must survive someone editing this constant, and against a
 *  literal type tsc folds it away as "no overlap" (TS2367) instead. 7797 rather
 *  than check-task-api.ts's 7799 so the two probes can run side by side. */
const PORT: number = 7797;
const CHAT_MOUNT = "/api/chat";
const PROJECTS_MOUNT = "/api/projects";
const SCHEMA = "tg_check_plan";

/* Fixed uuids, so a rerun is byte-comparable with the transcript in the
 * evidence file. They exist only inside the throwaway schema. */
const C_MIXED = "00000000-0000-4000-8000-0000000f0001";
const C_DEPTH = "00000000-0000-4000-8000-0000000f0002";
const C_CYCLE = "00000000-0000-4000-8000-0000000f0003";

const P_MIXED = "00000000-0000-4000-8000-00000000a001";
const P_DEPTH = "00000000-0000-4000-8000-00000000a002";
const P_CYCLE = "00000000-0000-4000-8000-00000000a003";

/* P_MIXED — the straddle. Three legacy rows, three graph rows, one legacy row
 * ABOVE the graph rows, in one project and one response (case D). */
const L1 = "00000000-0000-4000-8000-00000000b001"; // round 100, legacy
const L2 = "00000000-0000-4000-8000-00000000b002"; // round 100, legacy, L1's sibling
const L3 = "00000000-0000-4000-8000-00000000b003"; // round 101, legacy
const G_POP = "00000000-0000-4000-8000-00000000b004"; // round 102, depends_on {L3,L1}
const G_ROOT = "00000000-0000-4000-8000-00000000b005"; // round 102, depends_on '{}'
const G_DANGLE = "00000000-0000-4000-8000-00000000b006"; // round 103, depends_on {T_ABSENT}
const L4 = "00000000-0000-4000-8000-00000000b007"; // round 104, legacy, ABOVE the graph rows
/** Names no row, in this schema or anywhere else. R27 makes it unreachable
 *  through the API; `groupPlanPhases` emits it verbatim anyway. */
const T_ABSENT = "00000000-0000-4000-8000-00000000bfff";

/* P_DEPTH — depth and round DISAGREE (case F). */
const D0 = "00000000-0000-4000-8000-00000000c001"; // round 100, depends_on '{}'
const D1 = "00000000-0000-4000-8000-00000000c002"; // round 101, depends_on {D0}
const D2 = "00000000-0000-4000-8000-00000000c003"; // round 102, depends_on {D0}

/* P_CYCLE — a 2-cycle closed with UPDATE (case G). */
const Y1 = "00000000-0000-4000-8000-00000000d001"; // round 200
const Y2 = "00000000-0000-4000-8000-00000000d002"; // round 201
const Y3 = "00000000-0000-4000-8000-00000000d003"; // round 202, graph ROOT, not in the cycle

/* ------------------------------------------------------------------------- *
 * 0. Repo root, resolved by structure rather than by __dirname/import.meta —
 *    this file is transpiled to CJS by tsx (there is no package.json at the
 *    repo root) and neither identifier is guaranteed across that boundary.
 * ------------------------------------------------------------------------- */

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "db", "migrations")) && existsSync(join(dir, "forge-control"))) {
      return dir;
    }
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `check-plan-api.ts: could not find the repo root above ${process.cwd()} ` +
      "(looked for db/migrations + forge-control). Run it as: " +
      "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-plan-api.ts",
  );
}

const REPO_ROOT = findRepoRoot();

/* ------------------------------------------------------------------------- *
 * 1. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
 *    Ported verbatim in shape from check-task-api.ts, which ported it from
 *    check-migration-0040.sh: resolve the target NAME, refuse content_forge,
 *    refuse the maintenance and template databases, refuse any database this
 *    fleet actually runs on (every DSN found in the fleet's env files), refuse
 *    a non-local host, and print the NAME only — never the DSN.
 *
 *    "A check that can be pointed at production by forgetting an environment
 *    variable is an incident waiting for a tired night" (03-quality.md §2.2).
 * ------------------------------------------------------------------------- */

function refuse(why: string): never {
  console.error(`REFUSING TO RUN: ${why}`);
  process.exit(2);
}

function resolveScratchDatabase(): { dsn: string; name: string } {
  const dsn = (process.env.SCRATCH_DATABASE_URL ?? "").trim();
  if (!dsn) {
    refuse(
      "$SCRATCH_DATABASE_URL is unset. This check never guesses a connection " +
        "string; see the operator preamble in the header.",
    );
  }
  let url: URL;
  try {
    url = new URL(dsn);
  } catch (e) {
    refuse(
      `$SCRATCH_DATABASE_URL is not a parsable URL (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("$SCRATCH_DATABASE_URL is not a postgres:// URL.");
  }
  const name = url.pathname.replace(/^\//, "").split("?")[0] ?? "";
  if (!name) refuse("$SCRATCH_DATABASE_URL names no database.");
  const host = url.hostname || "localhost";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // Never echo the DSN; the host alone is enough to diagnose.
    refuse(`scratch database must be local, host resolved to ${JSON.stringify(host)}.`);
  }

  const banned = new Set(["content_forge", "postgres", "template0", "template1"]);
  if (banned.has(name)) {
    refuse(
      `${JSON.stringify(name)} is a protected database. Point $SCRATCH_DATABASE_URL ` +
        "at a throwaway scratch database.",
    );
  }

  // Soft denylist, computed: every database named by a DSN in the fleet's own
  // config, so this stays correct when a new service is added. The DSNs are
  // read and discarded; only database NAMES are ever compared, and none of them
  // is printed.
  const configs: string[] = ["/opt/forge-ai-os/.env", "/opt/content-forge/.env"];
  const secretsDir = "/opt/ai-os/.secrets";
  if (existsSync(secretsDir)) {
    for (const f of readdirSync(secretsDir)) {
      if (f.endsWith(".env")) configs.push(join(secretsDir, f));
    }
  }
  const live = new Set<string>();
  for (const path of configs) {
    let blob: string;
    try {
      blob = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const m of blob.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)) {
      try {
        const found = new URL(m[0]).pathname.replace(/^\//, "").split("?")[0];
        if (found) live.add(found);
      } catch {
        continue;
      }
    }
  }
  if (live.has(name)) {
    refuse(
      `${JSON.stringify(name)} is a database this fleet runs on (found in the fleet ` +
        "config). Use a throwaway scratch database.",
    );
  }

  return { dsn, name };
}

const SCRATCH = resolveScratchDatabase();

/* A real runtime check rather than a comment: 7700 is the live forge-control
 * and this harness must never bind it even if someone edits the constant. */
if (PORT === 7700) {
  refuse("this harness must never bind 7700 — that is the live forge-control API.");
}

/* ------------------------------------------------------------------------- *
 * 2. psql plumbing. Every statement this script issues against the database
 *    goes through here, with the search_path pinned to the throwaway schema and
 *    ON_ERROR_STOP so a SQL error is a failure with a location rather than a
 *    silently skipped statement. The DSN is passed in argv and never logged.
 * ------------------------------------------------------------------------- */

function psqlArgs(extra: readonly string[]): string[] {
  return [SCRATCH.dsn, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...extra];
}

function runPsql(extra: readonly string[], label: string): string {
  const r = spawnSync("psql", psqlArgs(extra), {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: `-c search_path=${SCHEMA}` },
  });
  if (r.error) throw new Error(`psql (${label}) failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `psql (${label}) exited ${r.status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`,
    );
  }
  return r.stdout;
}

/** One scalar/row-set answer, tab-free, trimmed. */
function q(sql: string): string {
  return runPsql(["-At", "-c", sql], sql.slice(0, 60)).trim();
}

/** Statements whose output is not read. */
function exec(sql: string, label: string): void {
  runPsql(["-c", sql], label);
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/* ------------------------------------------------------------------------- *
 * 3. Assertions, and the accounting that makes a missed probe a failure.
 * ------------------------------------------------------------------------- */

class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionFailure";
  }
}

let assertionsRun = 0;
let assertionsFailed = 0;

function pass(name: string, detail: string): void {
  assertionsRun += 1;
  console.log(`      ok   ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string): never {
  assertionsRun += 1;
  assertionsFailed += 1;
  console.error(`      FAIL ${name} — ${detail}`);
  throw new AssertionFailure(`${name}: ${detail}`);
}

function assertEq(name: string, expected: unknown, actual: unknown): void {
  if (expected === actual) pass(name, `= ${JSON.stringify(actual)}`);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(name: string, expected: readonly string[], actual: readonly string[]): void {
  const a = JSON.stringify(expected);
  const b = JSON.stringify(actual);
  if (a === b) pass(name, b);
  else fail(name, `expected ${a}, got ${b}`);
}

/** The self-defeat guard of failure mode (a): two edge sets that must NOT be
 *  equal, so a fixture edited into coincidence fails instead of certifying. */
function assertDiffers(name: string, a: readonly string[], b: readonly string[]): void {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) pass(name, `${x} !== ${y}`);
  else {
    fail(
      name,
      `the two edge sets COINCIDE (${x}). This fixture cannot tell a real edge ` +
        "set from the synthesised one, so nothing below it proves R54.",
    );
  }
}

function assertHas(name: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) pass(name, `body names ${JSON.stringify(needle)}`);
  else fail(name, `body does not contain ${JSON.stringify(needle)}; body was ${haystack}`);
}

function assertAbsent(name: string, body: Record<string, unknown>, key: string): void {
  if (!(key in body)) pass(name, `no '${key}' key`);
  else fail(name, `'${key}' unexpectedly present: ${JSON.stringify(body[key])}`);
}

/* ------------------------------------------------------------------------- *
 * 4. The HTTP surface. BOTH routers are mounted on 127.0.0.1:7797 behind node's
 *    own http server and driven with real `fetch` requests, so what is proved is
 *    the wire behaviour — status line and body bytes — and not a function call
 *    that happens to return an object. Two mounts because R54/R55 live on
 *    routes/chat.ts and R56's verification lives on routes/projects.ts, and the
 *    point of case H is that the two agree on the same row.
 * ------------------------------------------------------------------------- */

type HonoLike = { fetch: (req: Request) => Response | Promise<Response> };
type RouterModule = { default: HonoLike };
type Reply = { status: number; body: Record<string, unknown>; text: string };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

/** `/api/chat/<id>/plan` → `/<id>/plan` — what app.route() does. */
function stripMount(pathname: string, mount: string): string {
  const rest = pathname.slice(mount.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

async function request(path: string): Promise<Reply> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      /* A NON-JSON body is not a bug in this harness — it is the API answering
       * with something no caller can read, which is what Hono emits ("Internal
       * Server Error", text/plain) when a handler throws. Returning it verbatim
       * keeps the transcript legible and lets the case fail on its status
       * assertion; dying inside JSON.parse would report a SyntaxError about the
       * harness instead of the 500 about the API. */
      return { status: res.status, body: {}, text };
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return { status: res.status, body: {}, text };
    }
    parsed = decoded as Record<string, unknown>;
  }
  return { status: res.status, body: parsed, text };
}

/** GET a plan response and PRINT the exchange. */
async function plan(label: string, chatId: string): Promise<Reply> {
  const reply = await request(`${CHAT_MOUNT}/${chatId}/plan`);
  console.log(`    ${label}`);
  console.log(`      GET  ${CHAT_MOUNT}/${chatId}/plan`);
  console.log(`      res  ${reply.status} ${reply.text}`);
  return reply;
}

/* ------------------------------------------------------------------------- *
 * 4b. Reading the response. Every accessor THROWS rather than returning a
 *     default: a plan body missing the key under test must fail the case, not
 *     silently satisfy it with `undefined` compared against `undefined`.
 * ------------------------------------------------------------------------- */

type PlanTaskView = {
  id: string;
  round: number;
  deps: string[];
  workstream: string;
  depth: number;
};

function objOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AssertionFailure(`${what} is not an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    throw new AssertionFailure(`${what} is not an array: ${JSON.stringify(value)}`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new AssertionFailure(`${what}[${i}] is not a string: ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

function numberField(row: Record<string, unknown>, key: string, what: string): number {
  const v = row[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AssertionFailure(`${what}.${key} is not a finite number: ${JSON.stringify(v)}`);
  }
  return v;
}

function stringField(row: Record<string, unknown>, key: string, what: string): string {
  const v = row[key];
  if (typeof v !== "string") {
    throw new AssertionFailure(`${what}.${key} is not a string: ${JSON.stringify(v)}`);
  }
  return v;
}

/** Every task of a plan response, flattened across phases IN RESPONSE ORDER. */
function planTasks(reply: Reply): PlanTaskView[] {
  const phases = reply.body.phases;
  if (!Array.isArray(phases)) {
    throw new AssertionFailure(`plan body has no 'phases' array: ${reply.text.slice(0, 300)}`);
  }
  const out: PlanTaskView[] = [];
  for (const [pi, rawPhase] of phases.entries()) {
    const phase = objOf(rawPhase, `phases[${pi}]`);
    const tasks = phase.tasks;
    if (!Array.isArray(tasks)) {
      throw new AssertionFailure(`phases[${pi}].tasks is not an array`);
    }
    for (const [ti, rawTask] of tasks.entries()) {
      const what = `phases[${pi}].tasks[${ti}]`;
      const t = objOf(rawTask, what);
      out.push({
        id: stringField(t, "id", what),
        round: numberField(t, "round", what),
        deps: stringArray(t.deps, `${what}.deps`),
        workstream: stringField(t, "workstream", what),
        depth: numberField(t, "depth", what),
      });
    }
  }
  return out;
}

function taskOf(reply: Reply, id: string): PlanTaskView {
  const found = planTasks(reply).find((t) => t.id === id);
  if (!found) {
    throw new AssertionFailure(
      `no task ${id} in the plan response (saw ${planTasks(reply).map((t) => t.id).join(", ")})`,
    );
  }
  return found;
}

/**
 * Recompute the SYNTHESISED edge set — "every task id in a strictly lower
 * round" — from the response's own task list.
 *
 * Deliberately reimplemented here rather than imported: this is the value the
 * probe must show is DIFFERENT from the real edge set, and importing the
 * function under test to compute the thing it is being compared against would
 * make case A prove that the code equals itself.
 */
function synthesisedFor(reply: Reply, id: string): string[] {
  const all = planTasks(reply);
  const self = all.find((t) => t.id === id);
  if (!self) throw new AssertionFailure(`no task ${id} in the plan response`);
  return all.filter((t) => t.round < self.round).map((t) => t.id);
}

/* ------------------------------------------------------------------------- *
 * 5. The cases. Each declares the number of assertions it contains, next to
 *    itself — the accounting of failure mode (b). A case that returns early, or
 *    whose helper throws before asserting, comes in under its declared count and
 *    the run fails even if nothing it did assert was wrong. Declaring MORE than
 *    the case executes and declaring FEWER are both failures, on purpose.
 * ------------------------------------------------------------------------- */

type Case = {
  /** Letter from the phase-6A brief's case list (section 5). */
  id: string;
  title: string;
  assertions: number;
  run: () => Promise<void>;
};

const CASES: Case[] = [
  {
    id: "A",
    title: "R54 — a graph row with a populated depends_on: deps is that array, ids AND order",
    /* 5 = the psql sentinel check, the self-defeat guard, deps deep-equal,
     * order-not-sorted, and the response's own copy-not-alias witness. */
    assertions: 5,
    run: async () => {
      const reply = await plan("A  mixed project", C_MIXED);
      assertEq(
        "A sentinel in the DATABASE: G_POP.depends_on IS NOT NULL",
        "f",
        q(`SELECT depends_on IS NULL FROM project_tasks WHERE id = ${lit(G_POP)}`),
      );
      const declared = q(
        `SELECT array_to_string(depends_on, ',') FROM project_tasks WHERE id = ${lit(G_POP)}`,
      ).split(",");
      const synthesised = synthesisedFor(reply, G_POP);
      assertDiffers("A the fixture discriminates (real vs synthesised)", declared, synthesised);
      assertDeepEq("A deps == depends_on, verbatim", declared, taskOf(reply, G_POP).deps);
      /* The declared order is {L3,L1} — round-DESCENDING, which no synthesised
       * set could produce and no accidental sort would preserve. Asserted as a
       * property so a future fixture cannot quietly lose it. */
      assertEq(
        "A the declared order is not the round order",
        true,
        declared[0] === L3 && declared[1] === L1,
      );
      /* COPIED, not aliased: G_ROOT's deps must not have been mutated by
       * building G_POP's. Both are read from the same response object. */
      assertDeepEq("A sibling graph row unaffected by A's read", [], taskOf(reply, G_ROOT).deps);
    },
  },
  {
    id: "B",
    title: "R54 — depends_on = '{}' is an EXPLICIT root: deps [], NOT the synthesised set",
    assertions: 4,
    run: async () => {
      const reply = await plan("B  mixed project", C_MIXED);
      assertEq(
        "B sentinel in the DATABASE: G_ROOT.depends_on IS NOT NULL",
        "f",
        q(`SELECT depends_on IS NULL FROM project_tasks WHERE id = ${lit(G_ROOT)}`),
      );
      assertEq(
        "B and it is empty",
        "0",
        q(`SELECT coalesce(array_length(depends_on, 1), 0) FROM project_tasks WHERE id = ${lit(G_ROOT)}`),
      );
      const synthesised = synthesisedFor(reply, G_ROOT);
      /* Two lower rounds are seeded (100 and 101, three rows) precisely so `[]`
       * and the synthesised set differ. A fixture where they coincide proves
       * nothing, so the difference is asserted rather than assumed. */
      assertDiffers("B the fixture discriminates ([] vs synthesised)", [], synthesised);
      assertDeepEq("B deps == []", [], taskOf(reply, G_ROOT).deps);
    },
  },
  {
    id: "C",
    title: "R54 — a legacy row (depends_on IS NULL) keeps the synthesised strictly-lower set",
    assertions: 5,
    run: async () => {
      const reply = await plan("C  mixed project", C_MIXED);
      assertEq(
        "C sentinel in the DATABASE: L3.depends_on IS NULL",
        "t",
        q(`SELECT depends_on IS NULL FROM project_tasks WHERE id = ${lit(L3)}`),
      );
      assertDeepEq("C L3 (round 101) deps == the two round-100 rows", [L1, L2], taskOf(reply, L3).deps);
      /* SAME-ROUND SIBLINGS ARE ABSENT FROM EACH OTHER'S DEPS — the running
       * accumulator's whole purpose. L1 and L2 share round 100 and there is no
       * round below them, so both must be empty. */
      assertDeepEq("C L1 deps == [] (no round below 100)", [], taskOf(reply, L1).deps);
      assertDeepEq("C L2 deps == [] — its sibling L1 is NOT a dep", [], taskOf(reply, L2).deps);
      assertEq("C L2's deps do not name L1", false, taskOf(reply, L2).deps.includes(L1));
    },
  },
  {
    id: "D",
    title: "R54 — a MIXED project: both kinds of row in ONE response, and graph rows still feed the accumulator",
    assertions: 5,
    run: async () => {
      const reply = await plan("D  mixed project", C_MIXED);
      /* Both sentinels distinguishable in ONE query over the same project —
       * the straddle as the database sees it, not as JSON renders it. */
      assertEq(
        "D the project holds 4 legacy rows and 3 graph rows",
        "4|3",
        q(
          `SELECT count(*) FILTER (WHERE depends_on IS NULL) || '|' || ` +
            `count(*) FILTER (WHERE depends_on IS NOT NULL) ` +
            `FROM project_tasks WHERE project_id = ${lit(P_MIXED)}`,
        ),
      );
      assertEq("D every seeded task is in the response", 7, planTasks(reply).length);
      /* L4 is LEGACY and sits ABOVE the graph rows. Its synthesised set must
       * include them: a straddling project that reported two disconnected
       * boards would be the visible failure. */
      assertDeepEq(
        "D L4 (legacy, round 104) sees every strictly-lower row INCLUDING the graph ones",
        [L1, L2, L3, G_POP, G_ROOT, G_DANGLE],
        taskOf(reply, L4).deps,
      );
      /* A DANGLING dep is emitted VERBATIM (R27 makes it unreachable through
       * the API; suppressing it here would hide a corrupt row from the one
       * surface an operator looks at). */
      assertDeepEq("D a dangling dep id survives to the client", [T_ABSENT], taskOf(reply, G_DANGLE).deps);
      assertAbsent("D no graph_error on a well-formed graph", reply.body, "graph_error");
    },
  },
  {
    id: "E",
    title: "R55 — workstream present on every task; a non-'main' value survives verbatim",
    assertions: 3,
    run: async () => {
      const reply = await plan("E  mixed project", C_MIXED);
      const tasks = planTasks(reply);
      /* `planTasks` already threw if any row lacked a string `workstream`;
       * this states the census the gate asks for. */
      assertEq("E every task carries a workstream", 7, tasks.length);
      assertEq("E G_POP's non-default workstream survives", "alpha", taskOf(reply, G_POP).workstream);
      assertEq(
        "E the other six are 'main'",
        6,
        tasks.filter((t) => t.workstream === "main").length,
      );
    },
  },
  {
    id: "F",
    title: "R55 — depth is the DERIVED longest path, and it DISAGREES with round",
    assertions: 8,
    run: async () => {
      const reply = await plan("F  depth-vs-round project", C_DEPTH);
      /* Rounds 100/101/102 where 102 depends only on 100. A `depth` field that
       * returned `round` would answer 100/101/102 here; taskDepth() answers
       * 0/1/1. Both numbers are asserted so the transcript shows them side by
       * side and neither can be mistaken for the other. */
      assertEq("F D0 round", 100, taskOf(reply, D0).round);
      assertEq("F D1 round", 101, taskOf(reply, D1).round);
      assertEq("F D2 round", 102, taskOf(reply, D2).round);
      assertEq("F D0 depth (explicit root)", 0, taskOf(reply, D0).depth);
      assertEq("F D1 depth", 1, taskOf(reply, D1).depth);
      assertEq("F D2 depth — 1, NOT 2: it depends only on D0", 1, taskOf(reply, D2).depth);
      /* The discriminating property, asserted rather than eyeballed. */
      assertEq(
        "F depth differs from round on every row of this fixture",
        3,
        planTasks(reply).filter((t) => t.depth !== t.round).length,
      );
      assertAbsent("F no graph_error on an acyclic graph", reply.body, "graph_error");
    },
  },
  {
    id: "G",
    title: "R55 — a stored CYCLE: HTTP 200, graph_error naming the ids, every depth == its round",
    assertions: 8,
    run: async () => {
      const reply = await plan("G  cyclic project", C_CYCLE);
      assertEq(
        "G the cycle really is in the DATABASE (Y1→Y2, Y2→Y1)",
        "t",
        q(
          `SELECT (SELECT depends_on = ARRAY[${lit(Y2)}]::uuid[] FROM project_tasks WHERE id = ${lit(Y1)}) ` +
            `AND (SELECT depends_on = ARRAY[${lit(Y1)}]::uuid[] FROM project_tasks WHERE id = ${lit(Y2)})`,
        ),
      );
      /* NOT a 500: the panel must still render. */
      assertEq("G status is 200, not 500", 200, reply.status);
      const graphError = reply.body.graph_error;
      if (typeof graphError !== "string") {
        fail("G graph_error is a string", `got ${JSON.stringify(graphError)}`);
      }
      pass("G graph_error is present and a string", graphError.slice(0, 80));
      assertHas("G graph_error names Y1", graphError, Y1);
      assertHas("G graph_error names Y2", graphError, Y2);
      /* DISCLOSED DEGRADATION: depth falls back to round for EVERY row. Y3 is a
       * graph ROOT at round 202 — a partial map would have given it depth 0, so
       * this row distinguishes the fallback from a half-computed answer. */
      assertEq("G Y1 depth == its round", 200, taskOf(reply, Y1).depth);
      assertEq("G Y3 (graph root, round 202) depth == 202, NOT 0", 202, taskOf(reply, Y3).depth);
      assertEq(
        "G every depth equals its round",
        3,
        planTasks(reply).filter((t) => t.depth === t.round).length,
      );
    },
  },
  {
    id: "H",
    title: "R56 — the projects router carries depends_on, workstream and write_set, and its two column lists agree",
    assertions: 8,
    run: async () => {
      const detail = await request(`${PROJECTS_MOUNT}/${P_MIXED}`);
      console.log(`    H  GET ${PROJECTS_MOUNT}/${P_MIXED} → ${detail.status}`);
      assertEq("H detail status", 200, detail.status);
      const detailTasks = detail.body.tasks;
      if (!Array.isArray(detailTasks)) {
        fail("H detail body has a tasks array", `got ${JSON.stringify(detail.body.tasks)}`);
      }
      const detailRow = objOf(
        detailTasks.find((t) => objOf(t, "detail task").id === G_POP),
        "detail row for G_POP",
      );
      pass("H detail row for G_POP found", `${detailTasks.length} tasks in the project`);
      /* TASK_COLS: the three columns, correctly typed. */
      assertDeepEq(
        "H detail depends_on (TASK_COLS)",
        [L3, L1],
        stringArray(detailRow.depends_on, "detail.depends_on"),
      );
      assertEq("H detail workstream (TASK_COLS)", "alpha", stringField(detailRow, "workstream", "detail"));
      assertDeepEq(
        "H detail write_set (TASK_COLS)",
        ["forge-control/src/routes/chat.ts"],
        stringArray(detailRow.write_set, "detail.write_set"),
      );

      const board = await request(`${PROJECTS_MOUNT}/board`);
      console.log(`    H  GET ${PROJECTS_MOUNT}/board → ${board.status}`);
      const boardTasks = board.body.tasks;
      if (!Array.isArray(boardTasks)) {
        fail("H board body has a tasks array", `got ${JSON.stringify(board.body.tasks)}`);
      }
      const boardRow = objOf(
        boardTasks.find((t) => objOf(t, "board task").id === G_POP),
        "board row for G_POP",
      );
      /* THE AGREEMENT ASSERTION. TASK_COLS_PT exists so "a new column can never
       * again be added to TASK_COLS and silently forgotten in a hand-written
       * joined SELECT". This compares the KEY SETS of the same row seen through
       * both lists: identical but for `project_name`, which the board's join
       * adds on purpose. A column present in one and missing from the other is
       * named here rather than discovered in production. */
      const missing = Object.keys(detailRow).filter((k) => !(k in boardRow));
      assertDeepEq("H no TASK_COLS column is missing from TASK_COLS_PT", [], missing.sort());
      const extra = Object.keys(boardRow).filter((k) => !(k in detailRow));
      assertDeepEq("H TASK_COLS_PT adds only the joined project_name", ["project_name"], extra.sort());
      assertDeepEq(
        "H the board row's depends_on matches the detail row's",
        stringArray(detailRow.depends_on, "detail.depends_on"),
        stringArray(boardRow.depends_on, "board.depends_on"),
      );
    },
  },
];

/* ------------------------------------------------------------------------- *
 * 6. Schema, fixtures, and the run.
 * ------------------------------------------------------------------------- */

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(args: readonly string[]): string {
  const r = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Apply every db/migrations/*.sql in lexical order into the throwaway schema,
 *  exactly as check-migration-0040.sh and check-task-api.ts do, INCLUDING their
 *  one named deviation: 0021_ai_os_tables.sql declares foreign keys onto
 *  `content_jobs`, a table no migration in this repo creates (it belongs to the
 *  content-forge pipeline schema the AI OS tables were grafted onto). One
 *  placeholder table satisfies the FK; nothing in project_tasks is
 *  hand-written here. */
function buildSchema(): number {
  exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`, "create schema");
  exec("CREATE TABLE content_jobs (id uuid PRIMARY KEY)", "content_jobs placeholder");
  const dir = join(REPO_ROOT, "db", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);
  for (const f of files) runPsql(["-f", join(dir, f)], f);
  return files.length;
}

/**
 * Seed the three fixture projects.
 *
 * `created_at` IS EXPLICIT AND DISTINCT PER ROW, and that is load-bearing:
 * `PLAN_TASKS_SQL` orders by `round, created_at`, `now()` is the TRANSACTION
 * timestamp, and every row of a single multi-statement `psql -c` would
 * otherwise share one value — leaving the order of same-round siblings up to
 * the planner, and cases A and C assert on exactly that order.
 *
 * The chat↔project link is `projects.metadata->>'origin_chat_id'`, the PRIMARY
 * resolver in `resolveChatProject`. No `runs` row is needed, and none is
 * created: the thread-scan fallback is not on this probe's path.
 */
function seedFixtures(): { projects: number; tasks: number } {
  const brief = "check-plan-api.ts fixture row. Not a real task.";
  let seq = 0;

  const project = (id: string, name: string, chatId: string, status: string): string =>
    `INSERT INTO projects (id, name, brief, repo, status, metadata) VALUES (` +
    `${lit(id)}, ${lit(name)}, ${lit("check-plan-api.ts scratch project.")}, 'ai-os', ` +
    `${lit(status)}, ${lit(JSON.stringify({ origin_chat_id: chatId }))}::jsonb);`;

  const task = (
    id: string,
    projectId: string,
    round: number,
    title: string,
    opts: { workstream?: string; dependsOn?: string[]; writeSet?: string[] } = {},
  ): string => {
    seq += 1;
    const deps =
      opts.dependsOn === undefined ? "NULL" : `${lit(`{${opts.dependsOn.join(",")}}`)}::uuid[]`;
    const writeSet = `${lit(`{${(opts.writeSet ?? []).map((p) => `"${p}"`).join(",")}}`)}::text[]`;
    return (
      `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, ` +
      `workstream, depends_on, write_set, created_at) VALUES (` +
      `${lit(id)}, ${lit(projectId)}, ${round}, 'builder', ${lit(title)}, ${lit(brief)}, 'done', ` +
      `${lit(opts.workstream ?? "main")}, ${deps}, ${writeSet}, ` +
      `timestamptz '2026-08-17 00:00:00+00' + interval '${seq} seconds');`
    );
  };

  const sql = [
    project(P_MIXED, "check-plan-api mixed", C_MIXED, "active"),
    project(P_DEPTH, "check-plan-api depth", C_DEPTH, "active"),
    project(P_CYCLE, "check-plan-api cycle", C_CYCLE, "active"),

    // ── P_MIXED: legacy below, graph above, legacy above that (case D).
    task(L1, P_MIXED, 100, "legacy A at round 100"),
    task(L2, P_MIXED, 100, "legacy B at round 100 (L1's sibling)"),
    task(L3, P_MIXED, 101, "legacy C at round 101"),
    /* depends_on written round-DESCENDING on purpose: no synthesised set could
     * produce {L3,L1}, and an accidental sort would not preserve it. */
    task(G_POP, P_MIXED, 102, "graph row with real deps", {
      dependsOn: [L3, L1],
      workstream: "alpha",
      writeSet: ["forge-control/src/routes/chat.ts"],
    }),
    task(G_ROOT, P_MIXED, 102, "graph row, EXPLICIT root", { dependsOn: [] }),
    task(G_DANGLE, P_MIXED, 103, "graph row with a dangling dep", { dependsOn: [T_ABSENT] }),
    task(L4, P_MIXED, 104, "legacy D above the graph rows"),

    // ── P_DEPTH: depth and round disagree (case F).
    task(D0, P_DEPTH, 100, "depth root", { dependsOn: [] }),
    task(D1, P_DEPTH, 101, "depends on the root", { dependsOn: [D0] }),
    task(D2, P_DEPTH, 102, "ALSO depends only on the root", { dependsOn: [D0] }),

    // ── P_CYCLE: inserted acyclic, closed with UPDATE below (case G).
    task(Y1, P_CYCLE, 200, "cycle node 1", { dependsOn: [] }),
    task(Y2, P_CYCLE, 201, "cycle node 2", { dependsOn: [Y1] }),
    task(Y3, P_CYCLE, 202, "graph ROOT outside the cycle", { dependsOn: [] }),
  ].join("\n");

  exec(sql, "seed fixtures");

  /* THE CYCLE, closed with UPDATE. The API refuses to create one (R25/R26:
   * every edge points backwards in insert order, so a cycle is structurally
   * unreachable through the write path), and the display-side belt still has to
   * be exercised. This is the only way to hand it a cyclic graph. */
  exec(
    `UPDATE project_tasks SET depends_on = ARRAY[${lit(Y2)}]::uuid[] WHERE id = ${lit(Y1)};`,
    "close the cycle",
  );

  return {
    projects: Number(q("SELECT count(*) FROM projects")),
    tasks: Number(q("SELECT count(*) FROM project_tasks")),
  };
}

async function main(): Promise<void> {
  /* THE POOL IS BUILT AT MODULE LOAD (constraint 3 of the header) — both of
   * these must be set BEFORE the dynamic imports below, and a static import
   * would hoist above them. FOUR pools are built by those two imports. */
  process.env.DATABASE_URL = SCRATCH.dsn;
  process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;

  const subjectFiles = [
    "forge-control/src/routes/chat.ts",
    "forge-control/src/lib/task-graph.ts",
    "forge-control/src/routes/projects.ts",
    "forge-control/src/db/projects.ts",
  ];

  console.log("=== check-plan-api.ts — provenance ===========================================");
  console.log(`  repo worktree      : ${REPO_ROOT}`);
  console.log(`  git HEAD           : ${git(["rev-parse", "--short", "HEAD"])}`);
  console.log(`  git branch         : ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
  const dirty = git(["status", "--porcelain", "--", ...subjectFiles]);
  console.log(`  uncommitted (subj) : ${dirty === "" ? "none" : dirty.replace(/\n/g, " | ")}`);
  for (const f of subjectFiles) {
    console.log(`  sha256             : ${sha256(join(REPO_ROOT, f))}  ${f}`);
  }
  console.log(`  scratch database   : ${SCRATCH.name} (local; DSN never printed)`);
  console.log(`  throwaway schema   : ${SCHEMA}`);
  console.log(`  schema reached by  : PGOPTIONS=-c search_path=${SCHEMA} (re-proved by control 0a)`);
  console.log(`  bind               : http://${HOST}:${PORT} (never 7700)`);
  console.log(`  mounts             : ${CHAT_MOUNT}, ${PROJECTS_MOUNT}`);

  const migrations = buildSchema();
  const seeded = seedFixtures();
  const declared = CASES.reduce((sum, c) => sum + c.assertions, 0);
  console.log(`  migrations applied : ${migrations} (+1 forced content_jobs placeholder)`);
  console.log(`  rows seeded        : ${seeded.projects} projects, ${seeded.tasks} tasks`);
  console.log(`  cases to run       : ${CASES.length}`);
  console.log(`  assertions declared: ${declared}`);
  console.log("==============================================================================");
  console.log();

  /* NOT wrapped in a try: an import failure must ABORT (failure mode (b)), and
   * the top-level catch prints "ABORTED — NOT a pass" and exits non-zero. A
   * friendly message here is exactly how a probe certifies a route it never
   * reached. */
  const chatMod = (await import("../../forge-control/src/routes/chat.ts")) as unknown as RouterModule;
  const projectsMod = (await import(
    "../../forge-control/src/routes/projects.ts"
  )) as unknown as RouterModule;
  const mounts: { prefix: string; router: HonoLike }[] = [
    { prefix: CHAT_MOUNT, router: chatMod.default },
    { prefix: PROJECTS_MOUNT, router: projectsMod.default },
  ];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const mount = mounts.find((m) => url.pathname.startsWith(m.prefix));
      try {
        if (!mount) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no router mounted for ${url.pathname}` }));
          return;
        }
        const target = `http://${HOST}:${PORT}${stripMount(url.pathname, mount.prefix)}${url.search}`;
        const upstream = await mount.router.fetch(new Request(target, { method: "GET" }));
        const out = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(out);
      } catch (e) {
        // Explicit diagnostics, never a silent empty 200 — a harness that lies
        // about the API under test is worse than no harness.
        const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
        console.error(`[${PORT}] GET ${url.pathname} threw:`, message);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "worktree router threw", message }));
      }
    })();
  });

  await new Promise<void>((res, rej) => {
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        console.error(
          `REFUSING TO RUN: port ${PORT} is already in use. This harness never falls back ` +
            "to another port — a probe on an unknown port proves nothing about this one.",
        );
        process.exit(3);
      }
      rej(e);
    });
    server.listen(PORT, HOST, () => res());
  });

  let exitCode = 0;
  const casesWithAssertions: string[] = [];
  const failedCases: string[] = [];

  try {
    /* ── POSITIVE CONTROLS, first and aborting (failure mode (b)) ─────────── */
    console.log("--- 0a. positive control: is the CHAT router reading the scratch schema? ------");
    const control = await request(`${CHAT_MOUNT}/${C_MIXED}/plan`);
    console.log(`      GET ${CHAT_MOUNT}/${C_MIXED}/plan → ${control.status}`);
    if (control.status !== 200) {
      console.error(
        `      FAIL the plan endpoint did not answer 200 (status ${control.status}). ` +
          `Body: ${control.text.slice(0, 300)}`,
      );
      throw new AssertionFailure("positive control 0a failed");
    }
    const project = control.body.project;
    const seenId =
      typeof project === "object" && project !== null
        ? (project as Record<string, unknown>).id
        : undefined;
    if (seenId !== P_MIXED) {
      console.error(
        `      FAIL the router resolved chat ${C_MIXED} to project ${JSON.stringify(seenId)}, ` +
          `not the ${P_MIXED} this script seeded with psql into ${SCHEMA}. Its pools are ` +
          "reading a DIFFERENT database or schema, so every assertion below would have been " +
          "produced by whatever database that is.",
      );
      throw new AssertionFailure("positive control 0a resolved the wrong project");
    }
    console.log(
      `      ok   chat.ts + chat-linkage.ts read ${SCHEMA}: chat ${C_MIXED} → project ${P_MIXED}`,
    );

    console.log("--- 0b. positive control: is the PROJECTS router reading the scratch schema? --");
    const control2 = await request(`${PROJECTS_MOUNT}/${P_MIXED}`);
    console.log(`      GET ${PROJECTS_MOUNT}/${P_MIXED} → ${control2.status}`);
    if (control2.status !== 200) {
      console.error(
        `      FAIL db/projects.ts's pool did not find the seeded project (status ` +
          `${control2.status}). Body: ${control2.text.slice(0, 300)}`,
      );
      throw new AssertionFailure("positive control 0b failed");
    }
    console.log(`      ok   db/projects.ts reads ${SCHEMA}`);
    console.log();

    /* ── The cases ────────────────────────────────────────────────────────── */
    for (const c of CASES) {
      console.log(`--- case ${c.id}: ${c.title}`);
      const before = assertionsRun;
      try {
        await c.run();
      } catch (e) {
        if (!(e instanceof AssertionFailure)) {
          console.error(
            `      ERROR case ${c.id} threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
          );
          assertionsFailed += 1;
        }
        failedCases.push(c.id);
        exitCode = 1;
      }
      const ran = assertionsRun - before;
      if (ran > 0) casesWithAssertions.push(c.id);
      if (ran !== c.assertions) {
        console.error(
          `      MISSED case ${c.id} declares ${c.assertions} assertion(s) but executed ${ran} — ` +
            "a case that does not run what it declares cannot certify anything.",
        );
        exitCode = 1;
        if (!failedCases.includes(c.id)) failedCases.push(c.id);
      }
      console.log();
    }

    /* ── Census (failure mode (b)) ────────────────────────────────────────── */
    console.log("--- census -------------------------------------------------------------------");
    console.log(`  cases planned              : ${CASES.length}`);
    console.log(`  cases that ran an assertion: ${casesWithAssertions.length}`);
    console.log(`  assertions declared        : ${declared}`);
    console.log(`  assertions executed        : ${assertionsRun}`);
    console.log(`  assertions failed          : ${assertionsFailed}`);
    if (casesWithAssertions.length !== CASES.length) {
      const missing = CASES.filter((c) => !casesWithAssertions.includes(c.id)).map((c) => c.id);
      console.error(`  FAIL ${missing.length} case(s) never executed an assertion: ${missing.join(", ")}`);
      exitCode = 1;
    }
    if (assertionsRun !== declared) {
      console.error(`  FAIL executed ${assertionsRun} assertions but ${declared} are declared`);
      exitCode = 1;
    }
    if (assertionsFailed > 0) exitCode = 1;
    console.log();

    if (exitCode === 0) {
      console.log(
        `PASS — ${CASES.length} cases, every declared assertion executed and green: real edges ` +
          "for graph rows and synthesised edges for NULL rows in ONE response (R54), the " +
          "explicit '{}' root, the dangling dep emitted verbatim, workstream and the derived " +
          "depth (R55), the disclosed graph_error on a stored cycle, and TASK_COLS / " +
          "TASK_COLS_PT agreeing on the same row (R56).",
      );
    } else {
      console.error(`FAILED — ${failedCases.length} case(s): ${failedCases.join(", ")}`);
    }
  } finally {
    /* TEARDOWN on EVERY exit path. Leaving a schema behind is untidy; leaving
     * the HTTP server listening wedges the run. */
    await new Promise<void>((res) => server.close(() => res()));
    try {
      exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`, "teardown");
      console.log(`  teardown           : schema ${SCHEMA} dropped, :${PORT} closed`);
    } catch (e) {
      console.error(`  teardown FAILED    : ${e instanceof Error ? e.message : String(e)}`);
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

void main().catch((e: unknown) => {
  console.error(
    "check-plan-api.ts ABORTED — NOT a pass:",
    e instanceof Error ? (e.stack ?? e.message) : String(e),
  );
  process.exit(1);
});
