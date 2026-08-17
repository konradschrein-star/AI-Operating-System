/**
 * check-task-api.ts — the behavioural proof of phase 3's write path: R22–R31,
 * plus R39's cap (whose API half lands in phase 3, 01-requirements.md §R39).
 *
 * `POST /api/projects/:id/tasks` has fifteen refusal families and five happy
 * paths. Round 212 shipped all of them and could exercise NONE of them: they
 * need a database, and a build task may not touch one that is live. This is
 * the instrument that exercises them, against $SCRATCH_DATABASE_URL and
 * nothing else.
 *
 * THE ASSERTIONS ARE WRITTEN FROM THE CONTRACT, NOT FROM THE CODE — phase 3's
 * fifteen-row 400 table and `01-requirements.md` §C. Where the shipped code
 * and the table disagree, the disagreement is recorded as a FINDING in
 * `docs/plan/engine-task-graph/evidence/phase3-api.md` and the assertion keeps
 * saying what the contract says. A probe derived from the code it tests proves
 * only that the code equals itself.
 *
 * ---------------------------------------------------------------------------
 * OPERATOR PREAMBLE — run these three lines once, by hand, before this script.
 * This script NEVER invents credentials: it only consumes
 * $SCRATCH_DATABASE_URL. Creating a scratch DATABASE on this host is
 * authorised and conventional (forge_r850_dryrun, fleet_selftest and a dozen
 * siblings already exist). Authorised means CREATE DATABASE issued while
 * connected to the `postgres` MAINTENANCE database. It never means a statement
 * of any kind against content_forge.
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
 *   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-task-api.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options — the same gap
 * 03-quality.md §3.2 named for scripts/measure-schedule.ts at phase 7):
 *   cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
 *     --module ESNext --moduleResolution bundler --lib ES2022 --skipLibCheck \
 *     --allowImportingTsExtensions --resolveJsonModule --types node \
 *     ../scripts/checks/check-task-api.ts
 *
 * Exit: 0 = every case ran, executed exactly the assertions it declares, and
 * every one of them passed. Anything else is non-zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A *.test.ts
 *
 * NF3: the unit suite is hermetic and never touches a database. This needs a
 * real Postgres to prove a 400 that only a real row can trigger (a dangling
 * dependency id, a cross-project id, a stored cycle). It therefore lives here
 * beside check-migration-0040.sh and check-scheduler-sql.sh and must NEVER be
 * added to `pnpm test`.
 *
 * ---------------------------------------------------------------------------
 * HOW THE HARNESS IS BUILT — three constraints, each verified, not assumed
 *
 * 1. MOUNT ONLY `routes/projects.ts`. NEVER boot forge-control/src/index.ts:
 *    it starts startCronTick(), startTelegramBridge() and startVaultSyncTick()
 *    against the same database and the same Telegram bot token. A second
 *    instance would double-fire cron schedules and spawn real runs, steal
 *    Konrad's Telegram long-poll, and write to the vault.
 *    `scripts/checks/serve-agents-7798.ts` is the precedent and its header
 *    documents this.
 *
 * 2. NO BARE IMPORTS. `scripts/checks/` has no node_modules and there is none
 *    at the repo root. RE-VERIFIED for this script, 2026-08-17: a file here
 *    doing `import pg from "pg"` dies with MODULE_NOT_FOUND. So: node:http +
 *    `router.fetch(new Request(...))` for the API, node:child_process + `psql`
 *    for the database, and a RELATIVE import of
 *    ../../forge-control/src/routes/projects.ts, whose own bare imports
 *    resolve from forge-control/node_modules.
 *
 * 3. THE POOL IS BUILT AT MODULE LOAD. `db/projects.ts` reads
 *    `process.env.DATABASE_URL` at import time and defaults to content_forge
 *    when unset. A STATIC import hoists above every statement in this file, so
 *    the pool would be built against the wrong DSN before the first line runs.
 *    The router is therefore loaded through a DYNAMIC `await import()`, after
 *    DATABASE_URL and PGOPTIONS have been set. This is a real failure mode,
 *    not a hypothetical.
 *
 *    PGOPTIONS reaching the startup packet was VERIFIED EMPIRICALLY before
 *    this script relied on it (2026-08-17, in this worktree): a `pg.Pool` built
 *    from a bare connection string, with `PGOPTIONS="-c search_path=X"` in the
 *    environment, answered `show search_path` with `X` and resolved an
 *    unqualified table in that schema. That matches pg's
 *    connection-parameters.js, where `this.options = val('options', config)`
 *    and `val` falls back to `process.env['PG' + KEY]`. The fallback path — a
 *    dedicated scratch database whose `public` schema carries the migrations —
 *    was therefore NOT needed and NOT taken.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY (standing rule 3)
 *
 *  (a) THE ROUTER IS TALKING TO THE WRONG DATABASE, and every 400 it certifies
 *      was produced by production. Disarmed by a POSITIVE CONTROL that runs
 *      FIRST and aborts the run: the subject project is seeded with `psql`
 *      into the throwaway schema and then read back through the ROUTER with
 *      GET /api/projects/:id. If the router's pool were pointed at
 *      content_forge, or at an empty public schema, that GET returns 404 and
 *      the script exits before asserting anything.
 *  (b) A PROBE THAT NEVER FIRED. Every case DECLARES the number of assertions
 *      it contains, next to itself; the runner compares declared against
 *      executed for each case AND compares cases planned against cases that
 *      executed at least one assertion. Any mismatch is a non-zero exit. On the
 *      night of 2026-08-16/17 a hover probe clipping to the viewport instead of
 *      its scroll container left 9 of 21 targets untouched and reported
 *      success; a sweep whose probes miss must fail, never certify itself.
 *  (c) A 400 MATCHED BY STATUS ALONE. Every refusal asserts the status AND a
 *      substring of the body that NAMES THE OFFENDER — the offending id, path,
 *      entry, workstream or block. Case 8 deep-equals the `cycle` array's IDS
 *      IN ORDER rather than its length: a detector reporting "a cycle exists"
 *      without naming the path fails R25.
 *  (d) A DOUBLE-POST THAT LOOKS IDEMPOTENT BECAUSE THE FIRST POST FAILED. Case
 *      15 asserts 201 then 409 AND `SELECT count(*)` = 1 through psql, not
 *      through the API, AND that the 409 returned the SAME task id.
 *  (e) READING NULL-VS-EMPTY THROUGH JSON. Cases 16 and 17 assert against
 *      `SELECT depends_on IS NULL` in psql. JSON `null` and an empty array can
 *      both arrive looking like absence depending on the serializer, and the
 *      distinction between them IS the E2 deploy race (02-architecture.md
 *      §2.2, §9.1). Case 17 also asserts the two rows are distinguishable in
 *      one query over both.
 *  (f) A HARNESS THAT DOES NOT SAY WHICH BYTES IT CHECKED. The build identity
 *      block below prints the worktree, its git SHA, and the sha256 of each of
 *      the three shipped files under test — so a transcript produced against a
 *      mutated tree is legible as such rather than reading as authoritative.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
/** Typed `number` and not the literal `7799`: the never-7700 guard below is a
 *  RUNTIME check that must survive someone editing this constant, and against a
 *  literal type tsc folds it away as "no overlap" (TS2367) instead. */
const PORT: number = 7799;
const MOUNT = "/api/projects";
const SCHEMA = "tg_check_api";

/* Fixed uuids, so a rerun is byte-comparable with the transcript in the
 * evidence file. They exist only inside the throwaway schema. */
const P_MAIN = "00000000-0000-4000-8000-0000000000a1";
const P_OTHER = "00000000-0000-4000-8000-0000000000a2";
const P_STRICT = "00000000-0000-4000-8000-0000000000a3";
const P_CAP = "00000000-0000-4000-8000-0000000000a4";
const T_300 = "00000000-0000-4000-8000-0000000000b1";
const T_305 = "00000000-0000-4000-8000-0000000000b2";
const T_399 = "00000000-0000-4000-8000-0000000000b3";
const T_CYC_A = "00000000-0000-4000-8000-0000000000b4";
const T_CYC_B = "00000000-0000-4000-8000-0000000000b5";
const T_FOREIGN = "00000000-0000-4000-8000-0000000000c1";
/** Names no row in any project, in this schema or anywhere else. */
const T_UNKNOWN = "00000000-0000-4000-8000-0000000000d1";

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
    `check-task-api.ts: could not find the repo root above ${process.cwd()} ` +
      "(looked for db/migrations + forge-control). Run it as: " +
      "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-task-api.ts",
  );
}

const REPO_ROOT = findRepoRoot();

/* ------------------------------------------------------------------------- *
 * 1. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
 *    The shape is check-migration-0040.sh's guard block, ported: resolve the
 *    target NAME, refuse content_forge, refuse the maintenance and template
 *    databases, refuse any database this fleet actually runs on (every DSN
 *    found in the fleet's env files), refuse a non-local host, and print the
 *    NAME only — never the DSN.
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

  // Hard denylist: the live database by name, the maintenance database, the
  // templates. content_forge is named explicitly because it is THE database
  // this fleet runs on and the one mistake this guard exists to prevent.
  const banned = new Set(["content_forge", "postgres", "template0", "template1"]);
  if (banned.has(name)) {
    refuse(
      `${JSON.stringify(name)} is a protected database. Point $SCRATCH_DATABASE_URL ` +
        "at a throwaway scratch database.",
    );
  }

  // Soft denylist, computed: every database named by a DSN in the fleet's own
  // config, so this stays correct when a new service is added. The DSNs are
  // read and discarded; only database NAMES are ever compared, and none of
  // them is printed.
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

/* The port assertion the brief asks for, made a real runtime check rather than
 * a comment: 7700 is the live forge-control and this harness must never bind
 * it even if someone edits the constant above. */
if (PORT === 7700) {
  refuse("this harness must never bind 7700 — that is the live forge-control API.");
}

/* ------------------------------------------------------------------------- *
 * 2. psql plumbing. Every statement this script issues against the database
 *    goes through here, with the search_path pinned to the throwaway schema
 *    and ON_ERROR_STOP so a SQL error is a failure with a location rather than
 *    a silently skipped statement. The DSN is passed in argv and never logged.
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

function assertHas(name: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) pass(name, `body names ${JSON.stringify(needle)}`);
  else fail(name, `body does not contain ${JSON.stringify(needle)}; body was ${haystack}`);
}

function assertLacks(name: string, haystack: string, needle: string): void {
  if (!haystack.includes(needle)) pass(name, `body omits ${JSON.stringify(needle)}`);
  else fail(name, `body unexpectedly contains ${JSON.stringify(needle)}; body was ${haystack}`);
}

/* ------------------------------------------------------------------------- *
 * 4. The HTTP surface. The router is mounted on 127.0.0.1:7799 behind node's
 *    own http server and driven with real `fetch` requests, so what is proved
 *    is the wire behaviour — status line and body bytes — and not a function
 *    call that happens to return an object.
 * ------------------------------------------------------------------------- */

type RouterModule = {
  default: { fetch: (req: Request) => Response | Promise<Response> };
  PROJECT_MAX_WORKSTREAMS: number;
};

type Reply = { status: number; body: Record<string, unknown>; text: string };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

/** `/api/projects` → `/`, `/api/projects/<id>` → `/<id>` — what app.route() does. */
function stripMount(pathname: string): string {
  const rest = pathname.slice(MOUNT.length);
  return rest === "" || rest === "/" ? "/" : rest;
}

async function request(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`http://${HOST}:${PORT}${MOUNT}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      /* A NON-JSON body is not a bug in this harness — it is the API answering
       * with something no caller can read, which is exactly what Hono emits
       * ("Internal Server Error", text/plain) when a handler throws. Returning
       * it verbatim keeps the transcript legible and lets the case fail on its
       * status assertion; dying inside JSON.parse would report a SyntaxError
       * about the harness instead of the 500 about the API. */
      return { status: res.status, body: {}, text };
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return { status: res.status, body: {}, text };
    }
    parsed = decoded as Record<string, unknown>;
  }
  return { status: res.status, body: parsed, text };
}

/** POST a task-creation body and PRINT the exchange. The printed body is the
 *  artefact 03-quality.md §3.2 makes phase 3's gate ("the 400 bodies pasted"),
 *  so it is emitted verbatim, never summarised. */
async function post(label: string, projectId: string, body: unknown): Promise<Reply> {
  const reply = await request("POST", `/${projectId}/tasks`, body);
  console.log(`    ${label}`);
  console.log(`      req  ${JSON.stringify(body)}`);
  console.log(`      res  ${reply.status} ${reply.text}`);
  return reply;
}

/** The `error` string of a refusal, or a loud failure if the body has none —
 *  a 400 whose body cannot name the offender is the very defect case (c)
 *  exists to catch, so it must not degrade into an empty string. */
function errorOf(reply: Reply): string {
  const e = reply.body.error;
  if (typeof e !== "string") {
    throw new AssertionFailure(
      `response body has no string 'error' field: ${reply.text.slice(0, 300)}`,
    );
  }
  return e;
}

function stringArrayOf(reply: Reply, key: string): string[] {
  const raw = reply.body[key];
  if (!Array.isArray(raw)) {
    throw new AssertionFailure(`response body has no '${key}' array: ${reply.text.slice(0, 300)}`);
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new AssertionFailure(`${key}[${i}] is not a string: ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/** The `cycle` array's ids, IN ORDER (R25). Deep-equalled by case 8; a
 *  detector that reports only "a cycle exists" fails the requirement. */
function cycleIdsOf(reply: Reply): string[] {
  const raw = reply.body.cycle;
  if (!Array.isArray(raw)) {
    throw new AssertionFailure(`response body has no 'cycle' array: ${reply.text.slice(0, 300)}`);
  }
  return raw.map((node, i) => {
    if (typeof node !== "object" || node === null) {
      throw new AssertionFailure(`cycle[${i}] is not an object: ${JSON.stringify(node)}`);
    }
    const id = (node as Record<string, unknown>).id;
    if (typeof id !== "string") {
      throw new AssertionFailure(`cycle[${i}].id is not a string: ${JSON.stringify(node)}`);
    }
    return id;
  });
}

function taskField(reply: Reply, field: string): unknown {
  const task = reply.body.task;
  if (typeof task !== "object" || task === null) {
    throw new AssertionFailure(`response body has no 'task' object: ${reply.text.slice(0, 300)}`);
  }
  return (task as Record<string, unknown>)[field];
}

/* ------------------------------------------------------------------------- *
 * 5. The cases. Each declares the number of assertions it contains, next to
 *    itself — the accounting of failure mode (b). A case that returns early,
 *    or whose helper throws before asserting, comes in under its declared
 *    count and the run fails even if nothing it did assert was wrong.
 * ------------------------------------------------------------------------- */

type Case = {
  /** Row of phase 3's contract table, or the happy-path number above it. */
  id: string;
  title: string;
  assertions: number;
  run: () => Promise<void>;
};

/** A body that is valid in every respect except the one field under test.
 *  SINGLE-FAULT REQUESTS ARE THE POINT: two broken fields report only one
 *  error, and which one depends on the route's order of operations, so a
 *  two-fault request would assert against an order rather than against a rule. */
function goodBody(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "builder",
    title,
    brief: "check-task-api.ts fixture body — never executed by any agent.",
    ...extra,
  };
}

const ROLE_MSG =
  "role must be one of: architect, planner, scout, researcher, builder, reviewer, steward, tester";
const ROUND_MSG = "round must be a non-negative integer";
const DEPS_SHAPE_MSG = "depends_on must be an array of task uuids";
const WRITE_SET_SHAPE_MSG = "write_set must be an array of at most 200 repo-relative paths";

const CASES: Case[] = [
  {
    id: "1",
    title: "role missing or unknown → 400 (existing message)",
    assertions: 4,
    run: async () => {
      const missing = await post("1a role absent", P_MAIN, {
        title: "c1a",
        brief: "b",
      });
      assertEq("1a status", 400, missing.status);
      assertEq("1a message", ROLE_MSG, errorOf(missing));
      const unknown = await post("1b role unknown", P_MAIN, {
        role: "wizard",
        title: "c1b",
        brief: "b",
      });
      assertEq("1b status", 400, unknown.status);
      assertEq("1b message", ROLE_MSG, errorOf(unknown));
    },
  },
  {
    id: "2",
    title: "round supplied but not a non-negative int4 → 400 (two operator rulings, round 213)",
    /* 11 = 2a:2 + 2b:2 + 2c:2 + 2d:3 + 2e:2. First written as 9, which is the
     * count before 2d's third assertion and 2e existed; the runner refused to
     * certify a case that executed MORE than it declared, which is the half of
     * failure mode (b) that catches a stale declaration rather than a skipped
     * probe. Both directions are failures on purpose. */
    assertions: 11,
    run: async () => {
      const notNumber = await post("2a round: \"abc\"", P_MAIN, goodBody("c2a", { round: "abc" }));
      assertEq("2a status", 400, notNumber.status);
      assertEq("2a message", ROUND_MSG, errorOf(notNumber));

      const negative = await post("2b round: -1", P_MAIN, goodBody("c2b", { round: -1 }));
      assertEq("2b status", 400, negative.status);
      assertEq("2b message", ROUND_MSG, errorOf(negative));

      /* THE OPERATOR RULING, round 213. Round 212 kept today's guard verbatim
       * — `Number()` + `isFinite` + `>= 0`, which ACCEPTS 1.5 — and reported
       * the conflict with the contract table's "finite integer" rather than
       * guessing. The ruling: a fractional round is unambiguously CALLER
       * input, so it is a GraphValidationError-class 400 and not a
       * GraphIntegrityError-class 500. Letting it through to an integer column
       * produces a 500 that tells the caller "the server is broken" when the
       * truth is "your request was malformed", and sends whoever debugs it to
       * entirely the wrong place — the exact failure the two-error-class split
       * exists to prevent. */
      const fractional = await post("2c round: 1.5 (ruling 1)", P_MAIN, goodBody("c2c", { round: 1.5 }));
      assertEq("2c status is 400 and NOT 500", 400, fractional.status);
      assertEq("2c message", ROUND_MSG, errorOf(fractional));

      /* THE SECOND OPERATOR RULING, round 213, on F2 — the other end of the
       * same expression. `Number.isInteger(2147483648)` is `true`, so ruling 1
       * waved it through to a column declared `round int` in
       * `db/migrations/0030_coding_projects.sql`, and Postgres answered
       * SQLSTATE 22003 `integer out of range` — a 500, by ruling 1's exact
       * mechanism. Widening the column was rejected: `round` is becoming a
       * DERIVED value, the longest-path depth from the graph's roots, and a
       * dependency graph's depth cannot approach 2^31, so a bigint column would
       * be permanent dead weight bought to accommodate a value the engine will
       * never legitimately produce.
       *
       * THE MESSAGE IS ITS OWN, not ROUND_MSG. `2147483648` IS a non-negative
       * integer, so answering "round must be a non-negative integer" would tell
       * a caller something that is false about their input — the same species of
       * misleading response both rulings exist to remove. Same precedent as the
       * non-string workstream in case 9b, which does not borrow
       * validateWorkstream()'s message for a value it never judged. */
      const overflow = await post("2d round: 2147483648 (ruling 2, F2)", P_MAIN, goodBody("c2d", { round: 2147483648 }));
      assertEq("2d status is 400 and NOT 500", 400, overflow.status);
      assertHas("2d message names the bound", errorOf(overflow), "at most 2147483647");
      assertHas("2d message names the offending value", errorOf(overflow), "got 2147483648");

      /* THE BOUNDARY IS SATISFIABLE, and asserted as such (standing rule 2):
       * 2147483647 itself is accepted. A gate that refused the largest legal
       * value would be an off-by-one nobody notices until a real round sits on
       * the edge. It is a happy path inside a refusal case on purpose — the
       * refusal is only meaningful if the value one below it is not refused. */
      const maxLegal = await post("2e round: 2147483647 (the boundary, accepted)", P_MAIN, goodBody("c2e boundary", { round: 2147483647 }));
      assertEq("2e status", 201, maxLegal.status);
      assertEq("2e stored round is int4's maximum", 2147483647, taskField(maxLegal, "round"));
    },
  },
  {
    id: "3",
    title: "title or brief missing → 400 (existing messages)",
    assertions: 4,
    run: async () => {
      const noTitle = await post("3a title absent", P_MAIN, { role: "builder", brief: "b" });
      assertEq("3a status", 400, noTitle.status);
      assertEq("3a message", "title required", errorOf(noTitle));
      const noBrief = await post("3b brief absent", P_MAIN, { role: "builder", title: "c3b" });
      assertEq("3b status", 400, noBrief.status);
      assertEq("3b message", "brief required", errorOf(noBrief));
    },
  },
  {
    id: "4",
    title: "tier unknown → 400 (existing message)",
    assertions: 2,
    run: async () => {
      const r = await post("4 tier: \"wizard\"", P_MAIN, goodBody("c4", { tier: "wizard" }));
      assertEq("4 status", 400, r.status);
      assertEq("4 message", "tier must be one of: fast, junior, standard, flagship", errorOf(r));
    },
  },
  {
    id: "5",
    title: "depends_on present and not an array of uuid strings → 400",
    assertions: 8,
    run: async () => {
      const notArray = await post("5a depends_on: \"x\"", P_MAIN, goodBody("c5a", { depends_on: "x" }));
      assertEq("5a status", 400, notArray.status);
      assertEq("5a message", DEPS_SHAPE_MSG, errorOf(notArray));

      const notUuid = await post("5b depends_on: [\"not-a-uuid\"]", P_MAIN, goodBody("c5b", { depends_on: ["not-a-uuid"] }));
      assertEq("5b status", 400, notUuid.status);
      assertEq("5b message", DEPS_SHAPE_MSG, errorOf(notUuid));

      /* CONTRACT GAP, specified by the round-213 brief rather than matched off
       * the code: rows 5 and 11 are silent about NON-STRING elements. A
       * non-string in depends_on gets row 5's message. */
      const nonString = await post("5c depends_on: [123] (non-string element)", P_MAIN, goodBody("c5c", { depends_on: [123] }));
      assertEq("5c status", 400, nonString.status);
      assertEq("5c message", DEPS_SHAPE_MSG, errorOf(nonString));

      /* CONTRACT GAP: an explicit JSON `null` is REFUSED, not read as absent.
       * createTask() treats null as a synonym for undefined internally, but at
       * the wire boundary reinterpreting null as "make this a legacy row" is a
       * guess with the E2 deploy race behind it (02-architecture.md §2.2). */
      const explicitNull = await post("5d depends_on: null (explicit null)", P_MAIN, goodBody("c5d", { depends_on: null }));
      assertEq("5d status", 400, explicitNull.status);
      assertEq("5d message", DEPS_SHAPE_MSG, errorOf(explicitNull));
    },
  },
  {
    id: "6",
    title: "depends_on names ids that exist in NO project → 400 naming them (R27)",
    assertions: 7,
    run: async () => {
      const r = await post("6a one unknown id", P_MAIN, goodBody("c6a", { depends_on: [T_UNKNOWN] }));
      assertEq("6a status", 400, r.status);
      assertHas("6a message names the id", errorOf(r), `do not exist: ${T_UNKNOWN}`);
      assertDeepEq("6a unknown_dependencies", [T_UNKNOWN], stringArrayOf(r, "unknown_dependencies"));

      /* BOTH BUCKETS FIRE. The unknown ids are returned FIRST and ALONE, so
       * the structured field always matches the message it accompanies. */
      const both = await post("6b unknown + cross-project in one body", P_MAIN, goodBody("c6b", { depends_on: [T_UNKNOWN, T_FOREIGN] }));
      assertEq("6b status", 400, both.status);
      assertHas("6b message is the unknown-id family", errorOf(both), "do not exist");
      assertDeepEq("6b unknown_dependencies alone", [T_UNKNOWN], stringArrayOf(both, "unknown_dependencies"));
      assertLacks("6b carries no cross_project_dependencies", both.text, "cross_project_dependencies");
    },
  },
  {
    id: "7",
    title: "depends_on names ids belonging to ANOTHER project → 400 naming them (R27)",
    assertions: 3,
    run: async () => {
      const r = await post("7 cross-project dependency", P_MAIN, goodBody("c7", { depends_on: [T_FOREIGN] }));
      assertEq("7 status", 400, r.status);
      assertHas("7 message names the id", errorOf(r), `belonging to another project: ${T_FOREIGN}`);
      assertDeepEq("7 cross_project_dependencies", [T_FOREIGN], stringArrayOf(r, "cross_project_dependencies"));
    },
  },
  {
    id: "8",
    title: "depends_on would close a cycle → 400 naming the PATH (R25)",
    assertions: 5,
    run: async () => {
      /* The stored 2-cycle (T_CYC_A → T_CYC_B → T_CYC_A) was seeded with psql,
       * not created through this API — R26 says a cycle is structurally
       * unreachable through the API given R27 and R29, so the belt can only be
       * exercised against a graph that got corrupt some other way. */
      const r = await post("8 depends_on: [cycle node A]", P_MAIN, goodBody("c8", { depends_on: [T_CYC_A] }));
      assertEq("8 status", 400, r.status);
      assertHas("8 message opens with the cycle family", errorOf(r), "depends_on would close a cycle: ");
      // R25: the offending path, IDS IN ORDER, from the repeated node back to
      // itself. Not its length — that is case (c) of the header.
      assertDeepEq("8 cycle ids in order", [T_CYC_A, T_CYC_B, T_CYC_A], cycleIdsOf(r));
      assertHas("8 message uses the house separator", errorOf(r), " -> ");
      assertHas("8 message names a title, not just an id", errorOf(r), "cycle node B");
    },
  },
  {
    id: "9",
    title: "workstream invalid → 400 with validateWorkstream's message (R28/R4)",
    assertions: 6,
    run: async () => {
      const bad = await post("9a workstream: \"UI Team\"", P_MAIN, goodBody("c9a", { workstream: "UI Team" }));
      assertEq("9a status", 400, bad.status);
      assertHas("9a message is validateWorkstream's", errorOf(bad), "task-graph: validateWorkstream()");
      assertHas("9a message quotes the offender", errorOf(bad), '"UI Team"');

      /* CONTRACT GAP: a NON-STRING workstream gets its own message, because
       * validateWorkstream() takes a string and handing it a number would need
       * an as-cast to produce a message about a value it never judged. */
      const nonString = await post("9b workstream: 42 (non-string)", P_MAIN, goodBody("c9b", { workstream: 42 }));
      assertEq("9b status", 400, nonString.status);
      assertEq("9b message", "workstream must be a string; got number", errorOf(nonString));
      assertLacks("9b did not reach validateWorkstream", nonString.text, "validateWorkstream");
    },
  },
  {
    id: "10",
    title: "a write_set entry invalid → 400 with normaliseWritePath's message (R28)",
    assertions: 6,
    run: async () => {
      const absolute = await post("10a write_set: [\"/etc/passwd\"]", P_MAIN, goodBody("c10a", { write_set: ["/etc/passwd"] }));
      assertEq("10a status", 400, absolute.status);
      assertHas("10a message is normaliseWritePath's", errorOf(absolute), "task-graph: normaliseWritePath()");
      assertHas("10a message names the entry", errorOf(absolute), '"/etc/passwd"');

      const dotdot = await post("10b write_set: [\"src/../../etc/x\"]", P_MAIN, goodBody("c10b", { write_set: ["src/../../etc/x"] }));
      assertEq("10b status", 400, dotdot.status);
      assertHas("10b message names the rule", errorOf(dotdot), "'..' path segment");
      assertHas("10b message names the entry", errorOf(dotdot), '"src/../../etc/x"');
    },
  },
  {
    id: "11",
    title: "write_set not an array, or > 200 entries → 400",
    assertions: 8,
    run: async () => {
      const notArray = await post("11a write_set: \"src/a.ts\"", P_MAIN, goodBody("c11a", { write_set: "src/a.ts" }));
      assertEq("11a status", 400, notArray.status);
      assertEq("11a message", WRITE_SET_SHAPE_MSG, errorOf(notArray));

      const tooMany = await post("11b write_set: 201 entries", P_MAIN, goodBody("c11b", {
        write_set: Array.from({ length: 201 }, (_unused, i) => `src/f${i}.ts`),
      }));
      assertEq("11b status", 400, tooMany.status);
      assertEq("11b message", WRITE_SET_SHAPE_MSG, errorOf(tooMany));

      /* CONTRACT GAP: a non-string ELEMENT gets row 11's message, not row
       * 10's — a non-string is a malformed ARRAY, not an invalid PATH. */
      const nonString = await post("11c write_set: [42] (non-string element)", P_MAIN, goodBody("c11c", { write_set: [42] }));
      assertEq("11c status", 400, nonString.status);
      assertEq("11c message is row 11's, not normaliseWritePath's", WRITE_SET_SHAPE_MSG, errorOf(nonString));

      /* CONTRACT GAP: explicit null refused, same reasoning as 5d. */
      const explicitNull = await post("11d write_set: null (explicit null)", P_MAIN, goodBody("c11d", { write_set: null }));
      assertEq("11d status", 400, explicitNull.status);
      assertEq("11d message", WRITE_SET_SHAPE_MSG, errorOf(explicitNull));
    },
  },
  {
    id: "12",
    title: "computed round leaves its phase block → 400 with computeRound's message (R24)",
    assertions: 4,
    run: async () => {
      // Dependency at round 399: computed 400, block of the shallowest
      // dependency is 3, floor(400/100) is 4 — the 100th depth level.
      const r = await post("12 dep at round 399, round omitted", P_MAIN, goodBody("c12", { depends_on: [T_399] }));
      assertEq("12 status", 400, r.status);
      assertHas("12 message is computeRound's", errorOf(r), "task-graph: computeRound()");
      assertHas("12 message names the computed round and block", errorOf(r), "computed round 400 leaves phase block 3");
      assertHas("12 message names the requirement", errorOf(r), "(R24)");
    },
  },
  {
    id: "13",
    title: "project would exceed the workstream cap → 400 (R39)",
    assertions: 4,
    run: async () => {
      const r = await post("13 seventh workstream on a capped project", P_CAP, goodBody("c13", { workstream: "zeta" }));
      assertEq("13 status", 400, r.status);
      assertHas("13 message names the limit", errorOf(r), "limit PROJECT_MAX_WORKSTREAMS=6");
      // SORTED, so the message is byte-identical for one project state
      // regardless of insert order (house style, round 213 brief).
      assertHas("13 message lists the workstreams sorted", errorOf(r), "alpha, beta, delta, epsilon, gamma, main");
      assertHas("13 message names the refused workstream", errorOf(r), 'new workstream "zeta"');
    },
  },
  {
    id: "14",
    title: "strict_write_sets + builder/tester with empty write_set → 400 (R31)",
    assertions: 7,
    run: async () => {
      const builder = await post("14a builder, no write_set, strict project", P_STRICT, goodBody("c14a"));
      assertEq("14a status", 400, builder.status);
      assertHas("14a message names the flag", errorOf(builder), "metadata.strict_write_sets");
      assertHas("14a message names the rule", errorOf(builder), "builder task requires a non-empty write_set");

      const tester = await post("14b tester, write_set: [] , strict project", P_STRICT, {
        ...goodBody("c14b", { write_set: [] }),
        role: "tester",
      });
      assertEq("14b status", 400, tester.status);
      assertHas("14b message names the role", errorOf(tester), "tester task requires a non-empty write_set");

      /* THE OTHER BRANCH (R31 says "both branches"): the flag binds builders
       * and testers only. A reviewer with no write_set is created, which is
       * what keeps the gate a rule rather than a blanket refusal. */
      const reviewer = await post("14c reviewer, no write_set, strict project", P_STRICT, {
        ...goodBody("c14c"),
        role: "reviewer",
      });
      assertEq("14c status", 201, reviewer.status);
      assertEq("14c reviewer row was created", "reviewer", taskField(reviewer, "role"));
    },
  },
  {
    id: "15",
    title: "identical body POSTed twice → 409, and exactly ONE row (R30)",
    assertions: 5,
    run: async () => {
      const body = goodBody("c15 idempotency subject", { round: 500 });
      const first = await post("15a first POST", P_MAIN, body);
      assertEq("15a status", 201, first.status);

      const second = await post("15b identical POST", P_MAIN, body);
      assertEq("15b status", 409, second.status);
      assertHas("15b message", errorOf(second), "duplicate task");
      // Failure mode (d): a double-post looks idempotent if the FIRST post
      // failed. The id must be the SAME row, and the count is read through
      // psql, never through the API.
      assertEq("15b returned the same task id", taskField(first, "id"), taskField(second, "id"));
      assertEq(
        "15c exactly one row exists (psql, not the API)",
        "1",
        q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c15 idempotency subject")}`),
      );
    },
  },
  {
    id: "16",
    title: "depends_on ABSENT → 201, stored as SQL NULL — the legacy sentinel (E2)",
    assertions: 3,
    run: async () => {
      const r = await post("16 depends_on absent", P_MAIN, goodBody("c16 legacy sentinel", { round: 501 }));
      assertEq("16 status", 201, r.status);
      /* THE SINGLE MOST IMPORTANT ASSERTION IN THIS SCRIPT. `[]` here would
       * re-open the deploy race E2 closed (02-architecture.md §2.2, §9.1):
       * every row an old-engine caller writes between the migration and the
       * executor restart would become a graph ROOT and be promoted en masse
       * the moment the new engine loads. Asserted through psql against
       * `depends_on IS NULL`, never through the API's JSON — failure mode (e).
       */
      assertEq(
        "16 stored depends_on IS NULL (psql)",
        "t",
        q(`SELECT depends_on IS NULL FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c16 legacy sentinel")}`),
      );
      assertEq(
        "16 the column is NULL, not an empty array",
        "NULL",
        q(`SELECT coalesce(depends_on::text, 'NULL') FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c16 legacy sentinel")}`),
      );
    },
  },
  {
    id: "17",
    title: "depends_on: [] → 201, stored as '{}' — a graph ROOT, not NULL",
    assertions: 4,
    run: async () => {
      const r = await post("17 depends_on: []", P_MAIN, goodBody("c17 explicit root", { round: 502, depends_on: [] }));
      assertEq("17 status", 201, r.status);
      assertEq(
        "17 stored depends_on IS NOT NULL (psql)",
        "f",
        q(`SELECT depends_on IS NULL FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c17 explicit root")}`),
      );
      assertEq(
        "17 stored depends_on is the empty array",
        "{}",
        q(`SELECT depends_on::text FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c17 explicit root")}`),
      );
      /* The two rows side by side in ONE query: the distinction is visible in
       * the database, which is the only place it means anything. */
      assertEq(
        "16 vs 17 are distinguishable in one query",
        "c16 legacy sentinel=NULL|c17 explicit root={}",
        q(
          `SELECT string_agg(title || '=' || coalesce(depends_on::text, 'NULL'), '|' ORDER BY title) ` +
            `FROM project_tasks WHERE project_id = ${lit(P_MAIN)} ` +
            `AND title IN (${lit("c16 legacy sentinel")}, ${lit("c17 explicit root")})`,
        ),
      );
    },
  },
  {
    id: "18",
    title: "round omitted, deps at rounds {300, 305} → 201 with round 306 (R23)",
    assertions: 3,
    run: async () => {
      const r = await post("18 round omitted, two deps", P_MAIN, goodBody("c18 computed round", { depends_on: [T_300, T_305] }));
      assertEq("18 status", 201, r.status);
      assertEq("18 response round is 1 + max(dep.round)", 306, taskField(r, "round"));
      assertEq(
        "18 stored round is 306 (psql)",
        "306",
        q(`SELECT round FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c18 computed round")}`),
      );
    },
  },
  {
    id: "19",
    title: "round SUPPLIED (700) is honoured untouched, even with deps (R23/E1)",
    assertions: 3,
    run: async () => {
      const r = await post("19 round 700 supplied with deps", P_MAIN, goodBody("c19 supplied round", { round: 700, depends_on: [T_300, T_305] }));
      assertEq("19 status", 201, r.status);
      assertEq("19 response round is the supplied 700, not 306", 700, taskField(r, "round"));
      assertEq(
        "19 stored round is 700 (psql)",
        "700",
        q(`SELECT round FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c19 supplied round")}`),
      );
    },
  },
  {
    id: "20",
    title: "workstream + write_set valid → 201, write_set stored NORMALISED (R28)",
    assertions: 4,
    run: async () => {
      const r = await post("20 workstream ui, write_set needing normalisation", P_MAIN, goodBody("c20 normalised write set", {
        round: 503,
        workstream: "ui",
        write_set: ["./src/a.ts", "src//b.ts"],
      }));
      assertEq("20 status", 201, r.status);
      assertEq("20 workstream stored", "ui", taskField(r, "workstream"));
      /* R16's contention test is exact string equality, so two spellings of one
       * file would stop conflicting: the NORMALISED form is what must land. */
      assertEq(
        "20 write_set stored normalised (psql)",
        "{src/a.ts,src/b.ts}",
        q(`SELECT write_set::text FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c20 normalised write set")}`),
      );
      assertEq(
        "20 workstream stored (psql)",
        "ui",
        q(`SELECT workstream FROM project_tasks WHERE project_id = ${lit(P_MAIN)} AND title = ${lit("c20 normalised write set")}`),
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
 *  exactly as check-migration-0040.sh does, INCLUDING its one named deviation:
 *  0021_ai_os_tables.sql declares foreign keys onto `content_jobs`, a table no
 *  migration in this repo creates (it belongs to the content-forge pipeline
 *  schema the AI OS tables were grafted onto). One placeholder table satisfies
 *  the FK; nothing in project_tasks is hand-written here. */
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

function seedFixtures(): void {
  const brief = "check-task-api.ts fixture row. Not a real task.";
  const project = (id: string, name: string, metadata: string): string =>
    `INSERT INTO projects (id, name, brief, repo, status, metadata) VALUES (` +
    `${lit(id)}, ${lit(name)}, ${lit("check-task-api.ts scratch project.")}, 'ai-os', 'active', ${lit(metadata)}::jsonb);`;
  const task = (
    id: string,
    projectId: string,
    round: number,
    title: string,
    opts: { workstream?: string; dependsOn?: string[] } = {},
  ): string =>
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, depends_on) VALUES (` +
    `${lit(id)}, ${lit(projectId)}, ${round}, 'builder', ${lit(title)}, ${lit(brief)}, 'done', ` +
    `${lit(opts.workstream ?? "main")}, ` +
    `${opts.dependsOn === undefined ? "NULL" : `${lit(`{${opts.dependsOn.join(",")}}`)}::uuid[]`});`;

  const capWorkstreams = ["main", "alpha", "beta", "gamma", "delta", "epsilon"];

  const sql = [
    project(P_MAIN, "check-task-api subject", "{}"),
    project(P_OTHER, "check-task-api other project", "{}"),
    project(P_STRICT, "check-task-api strict project", '{"strict_write_sets": true}'),
    project(P_CAP, "check-task-api capped project", "{}"),
    task(T_300, P_MAIN, 300, "dep at round 300"),
    task(T_305, P_MAIN, 305, "dep at round 305"),
    task(T_399, P_MAIN, 399, "dep at round 399 (block edge)"),
    /* A STORED 2-CYCLE, seeded with psql because this API refuses to create one
     * (R26: every edge points backwards in insert order, so a cycle is
     * structurally unreachable through the write path). The belt still has to
     * be exercised, and this is the only way to hand it a cyclic graph. */
    task(T_CYC_A, P_MAIN, 310, "cycle node A", { dependsOn: [T_CYC_B] }),
    task(T_CYC_B, P_MAIN, 311, "cycle node B", { dependsOn: [T_CYC_A] }),
    task(T_FOREIGN, P_OTHER, 0, "a task of another project"),
    ...capWorkstreams.map((ws, i) =>
      task(
        `00000000-0000-4000-8000-0000000000e${i + 1}`,
        P_CAP,
        i,
        `capped project task ${i}`,
        { workstream: ws },
      ),
    ),
  ].join("\n");

  exec(sql, "seed fixtures");
}

async function main(): Promise<void> {
  /* THE POOL IS BUILT AT MODULE LOAD (constraint 3 of the header) — both of
   * these must be set BEFORE the dynamic import below, and a static import
   * would hoist above them. */
  process.env.DATABASE_URL = SCRATCH.dsn;
  process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;

  const routerFiles = [
    "forge-control/src/routes/projects.ts",
    "forge-control/src/lib/task-graph.ts",
    "forge-control/src/db/projects.ts",
  ];

  console.log("=== check-task-api.ts — build identity =======================================");
  console.log(`  repo worktree      : ${REPO_ROOT}`);
  console.log(`  git HEAD           : ${git(["rev-parse", "--short", "HEAD"])}`);
  console.log(`  git branch         : ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
  const dirty = git(["status", "--porcelain", "--", ...routerFiles]);
  console.log(`  uncommitted (subj) : ${dirty === "" ? "none" : dirty.replace(/\n/g, " | ")}`);
  for (const f of routerFiles) {
    console.log(`  sha256             : ${sha256(join(REPO_ROOT, f))}  ${f}`);
  }
  console.log(`  scratch database   : ${SCRATCH.name} (local; DSN never printed)`);
  console.log(`  throwaway schema   : ${SCHEMA}`);
  console.log(`  schema reached by  : PGOPTIONS=-c search_path=${SCHEMA} (verified empirically; see header)`);
  console.log(`  bind               : http://${HOST}:${PORT}${MOUNT} (never 7700)`);

  const migrations = buildSchema();
  seedFixtures();
  const declared = CASES.reduce((sum, c) => sum + c.assertions, 0);
  console.log(`  migrations applied : ${migrations} (+1 forced content_jobs placeholder)`);
  console.log(`  cases to run       : ${CASES.length}`);
  console.log(`  assertions declared: ${declared}`);
  console.log("==============================================================================");
  console.log();

  const mod = (await import("../../forge-control/src/routes/projects.ts")) as unknown as RouterModule;
  const router = mod.default;
  console.log(`  PROJECT_MAX_WORKSTREAMS (from the router module) = ${mod.PROJECT_MAX_WORKSTREAMS}`);
  console.log();

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody ? await readBody(req) : undefined;
      try {
        const target = `http://${HOST}:${PORT}${stripMount(url.pathname)}${url.search}`;
        const headers = new Headers();
        const ct = req.headers["content-type"];
        if (typeof ct === "string") headers.set("content-type", ct);
        const upstream = await router.fetch(new Request(target, { method, headers, body }));
        const out = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(out);
      } catch (e) {
        // Explicit diagnostics, never a silent empty 200 — a harness that lies
        // about the API under test is worse than no harness.
        const message = e instanceof Error ? e.stack ?? e.message : String(e);
        console.error(`[7799] ${method} ${url.pathname} threw:`, message);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "worktree projects router threw", message }));
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
    /* ── POSITIVE CONTROL, first and aborting (failure mode (a)) ──────────── */
    console.log("--- 0. positive control: is the ROUTER reading the scratch schema? ------------");
    const control = await request("GET", `/${P_MAIN}`);
    console.log(`      GET ${MOUNT}/${P_MAIN} → ${control.status}`);
    if (control.status !== 200) {
      console.error(
        `      FAIL the router did not find the project this script seeded with psql into ` +
          `${SCHEMA} (status ${control.status}). Its pool is reading a DIFFERENT database or ` +
          "schema, so every refusal below would have been produced by whatever database that " +
          `is. Body: ${control.text.slice(0, 300)}`,
      );
      throw new AssertionFailure("positive control failed");
    }
    const project = control.body.project;
    const seenId =
      typeof project === "object" && project !== null
        ? (project as Record<string, unknown>).id
        : undefined;
    if (seenId !== P_MAIN) {
      console.error(`      FAIL positive control returned project id ${JSON.stringify(seenId)}`);
      throw new AssertionFailure("positive control returned the wrong project");
    }
    const seededTasks = q(`SELECT count(*) FROM project_tasks WHERE project_id = ${lit(P_MAIN)}`);
    console.log(`      ok   router reads ${SCHEMA}: project ${P_MAIN} found, ${seededTasks} seeded tasks`);
    console.log();

    /* ── The cases ────────────────────────────────────────────────────────── */
    for (const c of CASES) {
      console.log(`--- case ${c.id}: ${c.title}`);
      const before = assertionsRun;
      try {
        await c.run();
      } catch (e) {
        if (!(e instanceof AssertionFailure)) {
          console.error(`      ERROR case ${c.id} threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
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
        `PASS — ${CASES.length} cases, every declared assertion executed and green: the ` +
          "fifteen 400 families (R22, R22a, R24, R25, R27, R28, R31, R39), the 409 (R30), " +
          "and the happy paths — the NULL-vs-'{}' sentinel (E2), the computed and the " +
          "supplied round, the normalised write-set, and int4's maximum accepted at the bound.",
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
  console.error("check-task-api.ts ABORTED — NOT a pass:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
