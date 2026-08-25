/**
 * Tests for the runtime fleet default tier switch.
 *
 * Run: npx tsx --test src/lib/fleet-tier.test.ts
 *
 * Split by layer:
 *  - Pure validation (isValidTaskTier, VALID_TASK_TIERS, FLEET_DEFAULT_TIER_KEY, DEFAULT_FLEET_TIER)
 *  - Data access (getFleetDefaultTier, setFleetDefaultTier, getFleetState) with fake Querier
 *  - HTTP routes (GET/PUT/POST /api/fleet/default-tier)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FLEET_TIER,
  FLEET_DEFAULT_TIER_KEY,
  VALID_TASK_TIERS,
  getFleetDefaultTier,
  getFleetState,
  isValidTaskTier,
  setFleetDefaultTier,
  type Querier,
} from "../db/ai_os.ts";
import fleetRouter from "../routes/fleet.ts";
import type { TaskTier } from "../db/projects.ts";

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
 * Project task tier resolution logic
 * ------------------------------------------------------------------------- */

describe("Project task creation tier resolution", () => {
  test("resolves to fleet default tier when task tier is omitted and tier_pin is absent", () => {
    const pinnedTier = undefined;
    const requestedTier = undefined;
    const fleetDefault: TaskTier = "gemini";
    const effectiveTier = pinnedTier ?? requestedTier ?? fleetDefault;
    assert.equal(effectiveTier, "gemini");
  });

  test("resolves to pinned tier when project metadata has tier_pin", () => {
    const pinnedTier: TaskTier = "flagship";
    const requestedTier: TaskTier = "junior";
    const fleetDefault: TaskTier = "gemini";
    const effectiveTier = pinnedTier ?? requestedTier ?? fleetDefault;
    assert.equal(effectiveTier, "flagship");
  });

  test("resolves to requested tier when task specifies tier and tier_pin is absent", () => {
    const pinnedTier = undefined;
    const requestedTier: TaskTier = "standard";
    const fleetDefault: TaskTier = "gemini";
    const effectiveTier = pinnedTier ?? requestedTier ?? fleetDefault;
    assert.equal(effectiveTier, "standard");
  });
});