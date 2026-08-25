/**
 * Tests for the runtime fleet default tier switch.
 *
 * Run: npx tsx --test src/lib/fleet-tier.test.ts
 *
 * Split by layer:
 *  - Pure validation (isValidTaskTier, VALID_TASK_TIERS, FLEET_DEFAULT_TIER_KEY, DEFAULT_FLEET_TIER)
 *  - Data access (getFleetDefaultTier, setFleetDefaultTier, getFleetState) with fake Querier
 *  - HTTP routes (GET/PUT/POST /api/fleet/default-tier)
 *  - The REAL creation route (POST /api/projects/:id/tasks) over a faked pg pool
 *  - Pause safety: a malformed tier row must not decide whether the fleet runs
 *  - Drift pin: the web picker's model ids against the engine's TIER_MODELS
 *
 * Nothing in this file touches a database. See "THE PG SEAM" below before
 * adding an import.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Querier } from "../db/ai_os.ts";
import type { TaskTier } from "../db/projects.ts";

/* ------------------------------------------------------------------------- *
 * THE PG SEAM — read this before adding a static import to this file
 *
 * `db/ai_os.ts`, `db/projects.ts` and everything `routes/projects.ts` pulls in
 * construct `new Pool(...)` at MODULE SCOPE. `pg` is CommonJS, so
 * `import pg from "pg"` hands every one of them the same `module.exports`
 * object and they destructure `Pool` off it at THEIR load time — which means
 * replacing `pg.Pool` before their first `import()` gives them all a fake, with
 * no injection parameter added to production code.
 *
 * EVERY db/route import in this file is therefore DYNAMIC and lives below the
 * swap. A static `import … from "../db/ai_os.ts"` is hoisted above all
 * top-level code by the ESM loader, so it would bind the REAL pool — which is
 * not a harmless detail: an earlier draft of this file did exactly that, and
 * `POST /:id/tasks` went and read `app_settings` out of the LIVE
 * `content_forge` database. The suite passed, by coincidence, because the live
 * row happened to say `gemini`; the `junior` and `flagship` cases below failed
 * and are what caught it. A unit test that reaches a real database is not a
 * unit test, and one whose expected value is whatever Konrad last clicked is
 * not a test at all.
 * ------------------------------------------------------------------------- */

interface FakeQuery {
  sql: string;
  params: unknown[];
}

/** Queries recorded by the fake pool, in order. */
const routeQueries: FakeQuery[] = [];

/** What the fake pool answers next, keyed by a distinctive SQL fragment.
 *  Reassigned per test; never merged, so one test cannot inherit another's
 *  fixture. */
let routeResponses: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];

class FakePgPool {
  constructor(_config: unknown) {}
  on(_event: string, _handler: unknown): this {
    return this;
  }
  async query(sql: string, params?: unknown[]) {
    routeQueries.push({ sql, params: params ?? [] });
    const hit = routeResponses.find((r) => r.match.test(sql));
    if (!hit) {
      throw new Error(
        `fleet-tier.test: the route issued a query this fake has no answer for.\n` +
          `SQL: ${sql.replace(/\s+/g, " ").trim().slice(0, 240)}\n` +
          `params: ${JSON.stringify(params)}`,
      );
    }
    return { rows: hit.rows, rowCount: hit.rows.length, command: "", oid: 0, fields: [] };
  }
  /** A dedicated client over the SAME routing table, so a transaction is
   *  observable: BEGIN/COMMIT/ROLLBACK are recorded like any other statement
   *  and a test can assert which of them ran. */
  async connect() {
    const self = this;
    return {
      query: (sql: string, params?: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
          routeQueries.push({ sql: sql.trim().toUpperCase(), params: params ?? [] });
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return self.query(sql, params);
      },
      release: () => {},
    };
  }
  async end() {}
}

/** Did the fake see this statement? Matched against the recorded SQL. */
function sawQuery(re: RegExp): boolean {
  return routeQueries.some((q) => re.test(q.sql));
}

const pgModule = (await import("pg")).default as unknown as { Pool: unknown };
const realPool = pgModule.Pool;
pgModule.Pool = FakePgPool;
const {
  DEFAULT_FLEET_TIER,
  FLEET_DEFAULT_TIER_KEY,
  VALID_TASK_TIERS,
  getFleetDefaultTier,
  getFleetState,
  isValidTaskTier,
  readFleetDefaultTierOrDegrade,
  setFleetDefaultTier,
  setFleetState,
} = await import("../db/ai_os.ts");
const fleetRouter = (await import("../routes/fleet.ts")).default;
const projectsRouter = (await import("../routes/projects.ts")).default;
pgModule.Pool = realPool;

/* ------------------------------------------------------------------------- *
 * Fake Querier
 * ------------------------------------------------------------------------- */

interface Call {
  sql: string;
  params: unknown[];
}

function fakeDb(responses: Array<Record<string, unknown>[]>): {
  db: Querier;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const db: Querier = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = queue.shift() ?? [];
      return {
        rows,
        rowCount: rows.length,
        command: "",
        oid: 0,
        fields: [],
      } as never;
    },
  };
  return { db, calls };
}

/* ------------------------------------------------------------------------- *
 * Pure validation
 * ------------------------------------------------------------------------- */

describe("tier validation & constants", () => {
  test("constants are defined with documented values", () => {
    assert.equal(FLEET_DEFAULT_TIER_KEY, "fleet.default_tier");
    assert.equal(DEFAULT_FLEET_TIER, "gemini");
    assert.deepEqual(
      [...VALID_TASK_TIERS].sort(),
      ["fast", "flagship", "gemini", "junior", "standard"].sort(),
    );
  });

  test("isValidTaskTier accepts all valid tiers", () => {
    for (const tier of VALID_TASK_TIERS) {
      assert.equal(isValidTaskTier(tier), true, `should accept ${tier}`);
    }
  });

  test("isValidTaskTier rejects invalid tiers and non-strings", () => {
    const invalid = [
      "opus",
      "sonnet",
      "haiku",
      "gpt-4",
      "claude",
      "",
      " ",
      null,
      undefined,
      123,
      true,
      false,
      {},
      [],
    ];
    for (const val of invalid) {
      assert.equal(isValidTaskTier(val), false, `should reject ${JSON.stringify(val)}`);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * getFleetDefaultTier
 * ------------------------------------------------------------------------- */

describe("getFleetDefaultTier", () => {
  test("no row in app_settings → code default ('gemini'), source='default', updated_at=null", async () => {
    const { db, calls } = fakeDb([[]]);
    const r = await getFleetDefaultTier(db);

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app_settings WHERE key = \$1/);
    assert.deepEqual(calls[0].params, ["fleet.default_tier"]);

    assert.equal(r.default_tier, "gemini");
    assert.equal(r.source, "default");
    assert.equal(r.updated_at, null);
  });

  test("stored row in app_settings → returns stored tier, source='app_settings', ISO updated_at", async () => {
    const isoDate = "2026-08-25T17:00:00.000Z";
    const { db, calls } = fakeDb([
      [{ value: "standard", updated_at: new Date(isoDate) }],
    ]);
    const r = await getFleetDefaultTier(db);

    assert.equal(calls.length, 1);
    assert.equal(r.default_tier, "standard");
    assert.equal(r.source, "app_settings");
    assert.equal(r.updated_at, isoDate);
  });

  test("stored row with JSON-quoted string parses correctly", async () => {
    const isoDate = "2026-08-25T17:05:00.000Z";
    const { db } = fakeDb([
      [{ value: '"flagship"', updated_at: isoDate }],
    ]);
    const r = await getFleetDefaultTier(db);

    assert.equal(r.default_tier, "flagship");
    assert.equal(r.source, "app_settings");
    assert.equal(r.updated_at, isoDate);
  });

  test("supports each valid tier when read from database", async () => {
    const tiers: TaskTier[] = ["fast", "junior", "standard", "flagship", "gemini"];
    for (const tier of tiers) {
      const { db } = fakeDb([
        [{ value: tier, updated_at: "2026-08-25T17:10:00.000Z" }],
      ]);
      const r = await getFleetDefaultTier(db);
      assert.equal(r.default_tier, tier);
      assert.equal(r.source, "app_settings");
    }
  });

  test("corrupt stored row throws with informative diagnostic rather than silent fallback", async () => {
    const { db } = fakeDb([
      [{ value: "invalid_tier_value", updated_at: "2026-08-25T17:00:00.000Z" }],
    ]);
    await assert.rejects(
      async () => await getFleetDefaultTier(db),
      /app_settings\['fleet\.default_tier'\] holds "invalid_tier_value".*Fix the row or delete it/,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * setFleetDefaultTier
 * ------------------------------------------------------------------------- */

describe("setFleetDefaultTier", () => {
  test("validates input tier before issuing SQL query", async () => {
    const { db, calls } = fakeDb([]);
    await assert.rejects(
      async () => await setFleetDefaultTier("invalid" as TaskTier, "user", db),
      /Invalid tier 'invalid': tier must be one of:/,
    );
    assert.equal(calls.length, 0, "must not query db when validation fails");
  });

  test("issues upsert query and returns updated setting", async () => {
    const isoDate = "2026-08-25T17:30:00.000Z";
    const { db, calls } = fakeDb([
      [{ updated_at: isoDate }],
    ]);
    const res = await setFleetDefaultTier("fast", "konrad", db);

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO app_settings/);
    assert.match(calls[0].sql, /ON CONFLICT \(key\) DO UPDATE/);
    assert.deepEqual(calls[0].params, ["fleet.default_tier", JSON.stringify("fast")]);

    assert.equal(res.default_tier, "fast");
    assert.equal(res.source, "app_settings");
    assert.equal(res.updated_at, isoDate);
  });

  test("throws if upsert returns no row", async () => {
    const { db } = fakeDb([[]]);
    await assert.rejects(
      async () => await setFleetDefaultTier("gemini", "user", db),
      /setting fleet\.default_tier returned no row/,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * getFleetState widening
 * ------------------------------------------------------------------------- */

describe("getFleetState", () => {
  test("returns widened state with default_tier and default_tier_source", async () => {
    const { db } = fakeDb([
      [{ status: "running", updated_at: "2026-08-25T17:00:00.000Z", updated_by: "system" }],
      [{ value: "junior", updated_at: "2026-08-25T17:00:00.000Z" }],
    ]);
    const state = await getFleetState(db);

    assert.equal(state.status, "running");
    assert.equal(state.default_tier, "junior");
    assert.equal(state.default_tier_source, "app_settings");
  });

  test("returns code default tier when no setting exists in app_settings", async () => {
    const { db } = fakeDb([
      [{ status: "paused", updated_at: "2026-08-25T17:00:00.000Z", updated_by: "konrad" }],
      [],
    ]);
    const state = await getFleetState(db);

    assert.equal(state.status, "paused");
    assert.equal(state.default_tier, "gemini");
    assert.equal(state.default_tier_source, "default");
  });
});

/* ------------------------------------------------------------------------- *
 * HTTP routes: GET / PUT / POST /default-tier
 * ------------------------------------------------------------------------- */

describe("HTTP fleet routes (/api/fleet)", () => {
  test("PUT /default-tier validates invalid tier and returns 400", async () => {
    const res = await fleetRouter.request("/default-tier", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "opus" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /tier must be one of:/);
  });

  test("POST /default-tier validates invalid tier and returns 400", async () => {
    const res = await fleetRouter.request("/default-tier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_tier: "unknown_tier" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /tier must be one of:/);
  });

  test("PUT /default-tier rejects empty body with 400", async () => {
    const res = await fleetRouter.request("/default-tier", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /tier must be one of:/);
  });
});

/* ------------------------------------------------------------------------- *
 * Project task creation — the REAL route, not a copy of its expression
 *
 * ── WHY THIS BLOCK LOOKS LIKE THIS ────────────────────────────────────────
 * What stood here declared `pinnedTier` / `requestedTier` / `fleetDefault` as
 * local consts, re-implemented `pinnedTier ?? requestedTier ?? fleetDefault` in
 * the test body, and asserted on its own variable. `routes/projects.ts` was
 * never imported. Deleting `?? (await getFleetDefaultTier()).default_tier` from
 * the route — the actual deliverable of this project — left all of it green.
 * That is the shape memory note `probe-etag-shim-tests-itself-not-the-route`
 * describes: an instrument that reimplements the thing it verifies cannot fail
 * when the thing is missing.
 *
 * The fake pool is defined at the top of this file. Every query the route
 * issues is answered by SQL shape below, and an unrecognised statement THROWS
 * naming its own SQL rather than returning an empty result set: a fake that
 * answers `{rows: []}` to everything turns a route change into a silent 404 and
 * the assertions below into tautologies.
 * ------------------------------------------------------------------------- */

const PROJECT_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** The `projects` row shape `PROJECT_COLS` returns, with the one field this
 *  route's tier decision reads left to the caller. */
function projectRow(metadata: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    name: "fleet tier probe",
    brief: "probe",
    repo: "ai-os",
    workspace_dir: "/tmp/does-not-need-to-exist",
    base_branch: "main",
    work_branch: "project/probe",
    status: "active",
    metadata,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}

/** Drive `POST /api/projects/:id/tasks` for real and return the tier the route
 *  actually sent to the INSERT, read out of the recorded parameter list rather
 *  than out of the response body — the body echoes the fake's RETURNING row,
 *  which the fake controls, so it could not fail. `$7` is `tier`. */
async function tierSentToInsert(opts: {
  metadata: Record<string, unknown> | null;
  body: Record<string, unknown>;
  /** `null` = the app_settings row is absent, so the code default applies. */
  settingValue: string | null;
}): Promise<{ status: number; insertTier: unknown; askedAppSettings: boolean }> {
  routeQueries.length = 0;
  routeResponses = [
    { match: /FROM projects\s+WHERE id = \$1/, rows: [projectRow(opts.metadata)] },
    { match: /FROM project_tasks\s+WHERE project_id = \$1/, rows: [] },
    {
      match: /FROM app_settings WHERE key = \$1/,
      rows: opts.settingValue === null ? [] : [{ value: opts.settingValue, updated_at: "2026-08-25T00:00:00.000Z" }],
    },
    {
      match: /INSERT INTO project_tasks/,
      rows: [
        {
          id: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
          project_id: PROJECT_ID,
          round: 0,
          role: "builder",
          title: "probe task",
          brief: "probe brief",
          status: "ready",
          run_id: null,
          fix_cycle: 0,
          tier: null,
          attempt: 0,
          chain_key: null,
          depends_on: null,
          workstream: "main",
          write_set: [],
          graph_frozen: false,
          created_at: "2026-08-25T00:00:00.000Z",
          updated_at: "2026-08-25T00:00:00.000Z",
        },
      ],
    },
  ];

  const res = await projectsRouter.request(`/${PROJECT_ID}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts.body),
  });

  const insert = routeQueries.find((q) => /INSERT INTO project_tasks/.test(q.sql));
  return {
    status: res.status,
    insertTier: insert ? insert.params[6] : undefined,
    askedAppSettings: routeQueries.some((q) => /FROM app_settings WHERE key = \$1/.test(q.sql)),
  };
}

describe("POST /api/projects/:id/tasks — tier resolution (real route)", () => {
  test("an untiered task on an unpinned project is written with the FLEET DEFAULT", async () => {
    const r = await tierSentToInsert({
      metadata: null,
      body: { role: "builder", title: "probe task", brief: "probe brief" },
      settingValue: "gemini",
    });
    assert.equal(r.status, 201);
    assert.equal(r.askedAppSettings, true, "the route must consult app_settings");
    assert.equal(r.insertTier, "gemini");
  });

  test("the fleet default is READ AT REQUEST TIME, not baked in — junior in the row, junior in the INSERT", async () => {
    const r = await tierSentToInsert({
      metadata: null,
      body: { role: "builder", title: "probe task", brief: "probe brief" },
      settingValue: "junior",
    });
    assert.equal(r.status, 201);
    assert.equal(r.insertTier, "junior");
  });

  test("a JSON-quoted setting value is unwrapped, not written through verbatim", async () => {
    const r = await tierSentToInsert({
      metadata: null,
      body: { role: "builder", title: "probe task", brief: "probe brief" },
      settingValue: '"flagship"',
    });
    assert.equal(r.status, 201);
    assert.equal(r.insertTier, "flagship");
  });

  test("with no app_settings row at all, the code default lands", async () => {
    const r = await tierSentToInsert({
      metadata: null,
      body: { role: "builder", title: "probe task", brief: "probe brief" },
      settingValue: null,
    });
    assert.equal(r.status, 201);
    assert.equal(r.insertTier, DEFAULT_FLEET_TIER);
  });

  test("an explicitly requested tier beats the fleet default and skips the lookup", async () => {
    const r = await tierSentToInsert({
      metadata: null,
      body: { role: "builder", title: "probe task", brief: "probe brief", tier: "standard" },
      settingValue: "gemini",
    });
    assert.equal(r.status, 201);
    assert.equal(r.insertTier, "standard");
    assert.equal(
      r.askedAppSettings,
      false,
      "`??` short-circuits — a tiered task must not pay for a settings read",
    );
  });

  test("the project's tier_pin beats both the request and the fleet default", async () => {
    const r = await tierSentToInsert({
      metadata: { tier_pin: "flagship" },
      body: { role: "builder", title: "probe task", brief: "probe brief", tier: "junior" },
      settingValue: "gemini",
    });
    assert.equal(r.status, 201);
    assert.equal(r.insertTier, "flagship");
    assert.equal(r.askedAppSettings, false);
  });

  test("the fake refuses an unanswered query rather than reporting an empty result", async () => {
    routeQueries.length = 0;
    routeResponses = [];
    const res = await projectsRouter.request(`/${PROJECT_ID}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "builder", title: "t", brief: "b" }),
    });
    /* Hono answers an unhandled throw with 500. The point of this case is that
     * the fake CAN fail: if it answered `{rows: []}` to everything, the six
     * cases above would still pass against a route that had lost the lookup. */
    assert.equal(res.status, 500);
  });
});
/* ------------------------------------------------------------------------- *
 * A MALFORMED TIER ROW MUST NEVER DECIDE WHETHER THE FLEET IS RUNNING
 *
 * The regression these cases exist for: `getFleetState()` awaited
 * `getFleetDefaultTier()` unconditionally, and that function DELIBERATELY
 * throws on a row that is not a valid TaskTier. All three pause gates spell
 * their call `getFleetState().catch(() => ({ status: "running" }))` —
 * lib/project-tick.ts, lib/cron-tick.ts, lib/telegram-bridge.ts — so the throw
 * was read as "running". A frozen fleet with `"sonnet"` hand-written into
 * `app_settings['fleet.default_tier']` therefore spawned paid runs, on every
 * tick, silently.
 *
 * The fix is asymmetric on purpose: the TIER read degrades to the code default
 * and says so on the log; the PAUSE read still propagates a real database
 * failure, because a fleet whose status cannot be read must not be assumed
 * safe by this layer either.
 * ------------------------------------------------------------------------- */

describe("pause safety — the tier read cannot take the fleet status down with it", () => {
  test("getFleetState survives a malformed tier row and still reports 'paused'", async () => {
    const { db } = fakeDb([
      [{ status: "paused", updated_at: "2026-08-25T17:00:00.000Z", updated_by: "konrad" }],
      [{ value: "sonnet", updated_at: "2026-08-25T17:00:00.000Z" }],
    ]);
    const state = await getFleetState(db);

    assert.equal(state.status, "paused", "a frozen fleet must still read as frozen");
    assert.equal(state.default_tier, DEFAULT_FLEET_TIER);
    assert.equal(
      state.default_tier_source,
      "default",
      "the degraded value must be reported as the code default, not as app_settings",
    );
  });

  test("readFleetDefaultTierOrDegrade never rejects, where getFleetDefaultTier does", async () => {
    const bad = () =>
      fakeDb([[{ value: 42, updated_at: "2026-08-25T17:00:00.000Z" }]]).db;

    await assert.rejects(async () => await getFleetDefaultTier(bad()));
    const degraded = await readFleetDefaultTierOrDegrade(bad());
    assert.equal(degraded.default_tier, DEFAULT_FLEET_TIER);
    assert.equal(degraded.source, "default");
    assert.equal(degraded.updated_at, null);
  });

  test("a genuine fleet_state read failure is NOT swallowed by the tier guard", async () => {
    const db: Querier = {
      query: async (sql: string) => {
        if (/FROM fleet_state/.test(sql)) throw new Error("connection terminated");
        return { rows: [] } as never;
      },
    };
    await assert.rejects(async () => await getFleetState(db), /connection terminated/);
  });

  test("all three pause gates read the status off getFleetState, so the guard covers them", () => {
    /* Named here rather than assumed: if a fourth gate appears, or one of these
     * stops routing through getFleetState, this list is where that shows up. */
    for (const rel of ["./project-tick.ts", "./cron-tick.ts", "./telegram-bridge.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      assert.match(
        src,
        /getFleetState\(\)[\s\S]{0,120}catch/,
        `${rel} should reach the fleet status through getFleetState()`,
      );
    }
  });
});

describe("setFleetState — a committed freeze is never reported as a failure", () => {
  test("a malformed tier row does not roll back or reject an applied freeze", async () => {
    routeQueries.length = 0;
    routeResponses = [
      {
        match: /UPDATE fleet_state/,
        rows: [
          { status: "paused", updated_at: "2026-08-25T18:00:00.000Z", updated_by: "konrad" },
        ],
      },
      { match: /UPDATE guardrail_rules/, rows: [] },
      { match: /FROM app_settings WHERE key = \$1/, rows: [{ value: "sonnet", updated_at: "x" }] },
    ];

    const state = await setFleetState("paused", "konrad");

    assert.equal(state.status, "paused");
    assert.equal(state.default_tier, DEFAULT_FLEET_TIER);
    assert.equal(state.default_tier_source, "default");
    assert.equal(sawQuery(/^COMMIT$/), true, "the freeze must commit");
    assert.equal(
      sawQuery(/^ROLLBACK$/),
      false,
      "a tier read after COMMIT must never issue ROLLBACK on a committed transaction",
    );
  });

  test("a missing fleet_state row returns the requested status instead of a TypeError", async () => {
    routeQueries.length = 0;
    routeResponses = [
      { match: /UPDATE fleet_state/, rows: [] },
      { match: /UPDATE guardrail_rules/, rows: [] },
      { match: /FROM app_settings WHERE key = \$1/, rows: [] },
    ];

    const state = await setFleetState("running", "konrad");
    assert.equal(state.status, "running");
    assert.equal(state.updated_by, "konrad");
    assert.equal(state.default_tier, DEFAULT_FLEET_TIER);
  });

  test("a real transaction failure still rolls back and propagates", async () => {
    routeQueries.length = 0;
    routeResponses = [
      { match: /UPDATE guardrail_rules/, rows: [] },
      /* No entry for UPDATE fleet_state → the fake throws, as a dead
       * connection would. */
    ];
    await assert.rejects(async () => await setFleetState("paused", "konrad"));
    assert.equal(sawQuery(/^ROLLBACK$/), true);
    assert.equal(sawQuery(/^COMMIT$/), false);
  });
});

/* ------------------------------------------------------------------------- *
 * THE PICKER'S MODEL IDS ARE PINNED TO THE ENGINE'S
 *
 * The settings control that chooses which model spends Konrad's money labelled
 * `junior` "Claude 3.5 Sonnet" and `fast` "Claude 3.5 Haiku" while TIER_MODELS
 * dispatched `claude-sonnet-5` and `claude-haiku-4-5-20251001` — a whole model
 * generation apart, at a different price. `TIER_MODELS` lives in a server
 * module the browser bundle cannot import, so the web copy is a copy; this is
 * what stops it rotting. It reads BOTH files' source text and fails on drift in
 * either direction, including a tier added to one side and not the other.
 *
 * This test lives in forge-control, not forge-control-web, deliberately: no
 * gate runs the web package's tests (memory: no-gate-runs-forge-control-web-tests),
 * and a drift pin nothing executes is decoration.
 * ------------------------------------------------------------------------- */

describe("fleet tier model ids — web picker vs engine TIER_MODELS", () => {
  const repoFile = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  /** `fast: { model: "claude-haiku-4-5-20251001", effort: "medium" },` */
  function engineModels(): Record<string, string> {
    const src = repoFile("./project-tick.ts");
    const block = /const TIER_MODELS: Record<TaskTier, \{[^}]*\}> = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(block, "TIER_MODELS not found in lib/project-tick.ts — did it move or get renamed?");
    const out: Record<string, string> = {};
    for (const m of block[1].matchAll(/^\s*(\w+):\s*\{\s*model:\s*"([^"]+)"/gm)) {
      out[m[1]] = m[2];
    }
    return out;
  }

  /** `gemini: { model: "gemini-3.7-flash-high", desc: "…" },` */
  function webModels(): Record<string, string> {
    const src = repoFile("../../../forge-control-web/app/desktop/settings/connections.ts");
    const block =
      /export const FLEET_TIER_COPY: Record<FleetTaskTier, FleetTierCopy> = \{([\s\S]*?)\n\};/.exec(
        src,
      );
    assert.ok(block, "FLEET_TIER_COPY not found in the web connections module");
    const out: Record<string, string> = {};
    for (const m of block[1].matchAll(/^\s*(\w+):\s*\{\s*\n?\s*model:\s*"([^"]+)"/gm)) {
      out[m[1]] = m[2];
    }
    return out;
  }

  test("every tier the engine knows is offered by the picker, with the same model id", () => {
    const engine = engineModels();
    const web = webModels();

    assert.deepEqual(
      Object.keys(engine).sort(),
      [...VALID_TASK_TIERS].sort(),
      "TIER_MODELS and VALID_TASK_TIERS disagree about which tiers exist",
    );
    assert.deepEqual(
      Object.keys(web).sort(),
      Object.keys(engine).sort(),
      "the picker and the engine offer different tiers",
    );
    for (const tier of Object.keys(engine)) {
      assert.equal(
        web[tier],
        engine[tier],
        `tier '${tier}': the picker says '${web[tier]}', dispatch uses '${engine[tier]}'`,
      );
    }
  });

  test("the picker's code default matches DEFAULT_FLEET_TIER", () => {
    const src = repoFile("../../../forge-control-web/app/desktop/settings/connections.ts");
    const m = /export const FLEET_CODE_DEFAULT_TIER: FleetTaskTier = "([^"]+)"/.exec(src);
    assert.ok(m, "FLEET_CODE_DEFAULT_TIER not found in the web connections module");
    assert.equal(m[1], DEFAULT_FLEET_TIER);
  });

  test("no marketing model name survives in the settings panel's option text", () => {
    const panel = repoFile("../../../forge-control-web/app/desktop/settings/ConnectionsPanel.tsx");
    for (const stale of ["Claude 3.5 Sonnet", "Claude 3.5 Haiku", "Claude Opus / Sonnet", "Claude Opus / Fable"]) {
      assert.equal(
        panel.includes(stale),
        false,
        `"${stale}" is a model generation the engine does not dispatch — label from FLEET_TIER_COPY`,
      );
    }
  });
});

/* ------------------------------------------------------------------------- *
 * THE FAILED-READ STATE — source assertions, and honest about being that
 *
 * The regression: `activeTier = tierData?.default_tier ?? "gemini"` and
 * `{tierData ? … : "GEMINI"}` meant a rejected `fetchFleetDefaultTier()`
 * rendered a confident "GEMINI / DEFAULT" — a fleet default nothing had
 * measured — in the one surface whose whole job is showing what the fleet is
 * actually set to, with the `<select>` dead and no way back but a page reload.
 *
 * WHY SOURCE TEXT AND NOT A RENDER. The component's failure state is reached
 * through `useEffect` + a rejected fetch; `react-dom/server` (which is what the
 * repo's settings harness uses, and which lives in the WEB package's
 * node_modules, not this one) never runs effects, so an SSR render can only
 * ever observe the loading state. Driving the real failure needs a browser
 * against a running app, which is a deploy/verify task, not a build one. These
 * assertions therefore pin the SHAPE, and say so rather than being dressed up
 * as behaviour. What they can catch is the exact regression above coming back.
 * ------------------------------------------------------------------------- */

describe("settings panel — a failed tier read must not fabricate a value", () => {
  const panelRaw = () =>
    readFileSync(
      fileURLToPath(
        new URL("../../../forge-control-web/app/desktop/settings/ConnectionsPanel.tsx", import.meta.url),
      ),
      "utf8",
    );

  /* COMMENTS STRIPPED FIRST. The doc-comment above the section quotes the exact
   * expression this block forbids, so a naive grep matches the explanation of
   * the fix and reports the fix as the defect — the trap in memory note
   * `checker-names-its-own-forbidden-strings`. Only executable text is judged. */
  const panel = () => panelRaw().replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("no `?? \"gemini\"` default stands behind the displayed tier", () => {
    assert.equal(
      /default_tier\s*\?\?\s*"gemini"/.test(panel()),
      false,
      'the displayed tier must not fall back to a hard-coded "gemini"',
    );
  });

  test('the badge renders an em dash, not "GEMINI", when nothing has been read', () => {
    const src = panel();
    assert.match(src, /data-fleet-tier-badge[\s\S]{0,900}loaded \? tierData\.default_tier\.toUpperCase\(\) : "—"/);
    assert.equal(
      /:\s*"GEMINI"/.test(src),
      false,
      "no branch may render the literal GEMINI for an unresolved read",
    );
  });

  test("a failed read is distinguishable from a slow one, and offers a retry", () => {
    const src = panel();
    assert.match(src, /"UNREADABLE"/);
    assert.match(src, /"READING…"/);
    assert.match(src, /data-fleet-tier-retry/, "the failure state needs a retry affordance");
    assert.match(src, /onClick=\{retry\}/);
  });
});
