/**
 * P1-1, route half: every WRITE to a guardrail is audited and announced.
 *
 * Run: pnpm test   (node --test via tsx — the script globs src/lib/*.test.ts,
 * which is why a test for src/routes/autonomy.ts lives in this directory. A
 * file placed in src/routes/ would never be executed by gate 8 of
 * scripts/checks/gates-808.sh.)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * Before this change, `POST /api/autonomy/rules/:id` and
 * `POST /api/autonomy/trips/:id/resolve` were unauthenticated on localhost,
 * wrote no audit row and sent no notification. Round 0 measured all three
 * demonstrations as single Bash calls any run can make — switch a rule off,
 * poison its config, then resolve the trip whose id the block message had just
 * handed the agent. The loud ACK door had a quiet door next to it.
 *
 * The router is spun up in-process with every DB call injected as a stub, so
 * this file needs no database, writes no `guardrail_rule_changes` row and
 * queues no real Telegram push. The stubs record what WOULD have been written,
 * which is the thing under test.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createAutonomyRouter,
  ruleChangeNotice,
  tripResolveNotice,
  type AutonomyRouterDeps,
} from "../routes/autonomy.ts";
import type {
  AutonomyResponse,
  GuardrailRule,
  RuleChangeKind,
  RuleChangeSource,
} from "../db/autonomy.ts";

/* -------------------------------------------------------------------------- *
 * Stubs. Every side effect the handlers can reach is captured here, including
 * the ones a test does not mean to exercise (memory:
 * destructive-control-test-stubs) — an unstubbed dep would reach the real
 * database.
 * -------------------------------------------------------------------------- */

interface Recorded {
  audits: Array<{
    kind: RuleChangeKind;
    rule_id?: string | null;
    trip_id?: string | null;
    patch?: Record<string, unknown>;
    source: RuleChangeSource;
  }>;
  notes: Array<{ text: string; source: string | undefined }>;
  /** Interleaved order of every side effect, so ordering is assertable. */
  order: string[];
}

const RULE: GuardrailRule = {
  id: "fs.destructive",
  label: "Destructive file ops",
  description: "",
  category: "destructive",
  enabled: false,
  builtin: true,
  config: {},
  updated_at: "2026-08-25T03:00:00.000Z",
};

const KNOWN_TRIP = "7c9f1c58-1c0e-4a2b-9d43-4b6b6f2ab111";

let rec: Recorded;
let auditThrows: boolean;

function deps(): AutonomyRouterDeps {
  return {
    getAutonomy: async (): Promise<AutonomyResponse> => ({
      fleet: { status: "running", updated_at: "", updated_by: "system" },
      rules: [RULE],
      trips: [],
      categories: [],
      rule_changes: [],
      gemini_daily: null,
    }),
    // Only `fs.destructive` exists; anything else is the "unknown rule" case
    // and returns null, exactly as the real updateRule does for a missing row
    // or a no-op patch.
    updateRule: async (id, patch) => {
      rec.order.push(`updateRule:${id}`);
      if (id !== RULE.id) return null;
      if (patch.enabled === undefined && patch.config === undefined) return null;
      return { ...RULE, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) };
    },
    resolveTrip: async (id) => {
      rec.order.push(`resolveTrip:${id}`);
      return id === KNOWN_TRIP;
    },
    evaluateGuardrails: async () => {
      rec.order.push("evaluateGuardrails");
      return { allow: true };
    },
    recordRuleChange: async (input) => {
      rec.order.push(`audit:${input.kind}`);
      if (auditThrows) throw new Error("relation guardrail_rule_changes does not exist");
      rec.audits.push(input);
    },
    queueNotification: async (text, source) => {
      rec.order.push("notify");
      rec.notes.push({ text, source });
    },
  };
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return createAutonomyRouter(deps()).request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  rec = { audits: [], notes: [], order: [] };
  auditThrows = false;
});

/* ========================================================================== *
 * 1. A rule patch is audited and announced
 * ========================================================================== */

describe("POST /rules/:id", () => {
  test("a successful patch writes exactly one audit row and one push", async () => {
    const res = await post("/rules/fs.destructive", { enabled: false });
    assert.equal(res.status, 200);

    assert.equal(rec.audits.length, 1);
    assert.deepEqual(rec.audits[0], {
      kind: "rule.update",
      rule_id: "fs.destructive",
      patch: { enabled: false },
      source: "api",
    });

    assert.equal(rec.notes.length, 1);
    assert.equal(
      rec.notes[0].text,
      "🛡 guardrail fs.destructive: enabled=false (source api)",
    );
    assert.equal(rec.notes[0].source, "guardrail");
  });

  test("the config-poisoning patch is announced too — that was the quiet one", async () => {
    // The round-0 P1-1 demonstration #2, verbatim. The engine now blocks on it
    // (autonomy-blanket.test.ts); this asserts Konrad also HEARS about it.
    await post("/rules/fs.destructive", { config: { note: "x" } });
    assert.equal(rec.audits.length, 1);
    assert.deepEqual(rec.audits[0].patch, { config: { note: "x" } });
    assert.equal(
      rec.notes[0].text,
      "🛡 guardrail fs.destructive: config updated (source api)",
    );
  });

  test("the console is NOT exempt — x-forge-source only labels, never silences", async () => {
    await post("/rules/fs.destructive", { enabled: true }, { "x-forge-source": "console" });
    assert.equal(rec.audits.length, 1, "a console toggle is still audited");
    assert.equal(rec.notes.length, 1, "a console toggle still pings Konrad");
    assert.equal(rec.audits[0].source, "console");
    assert.equal(
      rec.notes[0].text,
      "🛡 guardrail fs.destructive: enabled=true (source console)",
    );
  });

  test("a caller-invented source lands in the log as 'api'", async () => {
    await post("/rules/fs.destructive", { enabled: false }, { "x-forge-source": "konrads-phone" });
    assert.equal(rec.audits[0].source, "api");
    assert.match(rec.notes[0].text, /\(source api\)$/);
  });

  test("an unknown rule id 404s and writes NOTHING", async () => {
    const res = await post("/rules/does.not.exist", { enabled: false });
    assert.equal(res.status, 404);
    assert.deepEqual(rec.audits, []);
    assert.deepEqual(rec.notes, []);
    assert.deepEqual(rec.order, ["updateRule:does.not.exist"]);
  });

  test("a no-op patch 404s and writes NOTHING", async () => {
    // {} reaches updateRule, which returns null because it has no SET clause to
    // build. Auditing it would fill the log with changes that never happened.
    const res = await post("/rules/fs.destructive", {});
    assert.equal(res.status, 404);
    assert.deepEqual(rec.audits, []);
    assert.deepEqual(rec.notes, []);
  });
});

/* ========================================================================== *
 * 2. A trip resolve is audited and announced
 * ========================================================================== */

describe("POST /trips/:id/resolve", () => {
  test("resolving writes one audit row and one push", async () => {
    const res = await post(`/trips/${KNOWN_TRIP}/resolve`);
    assert.equal(res.status, 200);

    assert.equal(rec.audits.length, 1);
    assert.deepEqual(rec.audits[0], {
      kind: "trip.resolve",
      trip_id: KNOWN_TRIP,
      source: "api",
    });
    assert.equal(rec.audits[0].rule_id, undefined);

    assert.equal(rec.notes.length, 1);
    assert.equal(
      rec.notes[0].text,
      "🛡 guardrail trip 7c9f1c58 resolved (source api)",
    );
  });

  test("an unknown trip id 404s and writes NOTHING", async () => {
    // This is the erase-the-evidence path: the block message hands the agent a
    // trip id, so a wrong or already-used id must not leave a trace either.
    const res = await post("/trips/00000000-0000-0000-0000-000000000000/resolve");
    assert.equal(res.status, 404);
    assert.deepEqual(rec.audits, []);
    assert.deepEqual(rec.notes, []);
  });
});

/* ========================================================================== *
 * 3. The loud path does not depend on the audit path
 * ========================================================================== */

describe("failure ordering", () => {
  test("the push is queued BEFORE the audit row is written", async () => {
    await post("/rules/fs.destructive", { enabled: false });
    assert.deepEqual(rec.order, ["updateRule:fs.destructive", "notify", "audit:rule.update"]);
  });

  test("a broken audit table still pings Konrad, and says so in the body", async () => {
    // The change has already landed in `guardrail_rules` by this point. Round 1
    // let the audit error propagate, so the caller saw a 500 for a rule change
    // that had really happened — the console then rendered "failed" over a guard
    // that was genuinely off. The status code now describes the MUTATION and the
    // `audit` field describes the LOG, separately, because they really did have
    // different outcomes. `queueNotification` never throws (db/notifications.ts).
    auditThrows = true;
    const res = await post("/rules/fs.destructive", { enabled: false });
    assert.equal(res.status, 200, "the rule change happened; do not report it as failed");
    const body = (await res.json()) as {
      rule: unknown;
      audit: string;
      audit_error?: string;
    };
    assert.ok(body.rule, "the patched rule is still returned");
    assert.equal(body.audit, "failed");
    assert.match(
      body.audit_error ?? "",
      /guardrail_rule_changes/,
      "the reason is reported, not swallowed",
    );
    assert.equal(rec.notes.length, 1, "Konrad is told even when the log is broken");
    assert.deepEqual(rec.audits, [], "and the row genuinely did not land");
  });

  test("a broken audit table on a trip resolve reports the same way", async () => {
    auditThrows = true;
    const res = await post(`/trips/${KNOWN_TRIP}/resolve`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { resolved: boolean; audit: string };
    assert.equal(body.resolved, true, "resolveTrip committed; the body must say so");
    assert.equal(body.audit, "failed");
    assert.equal(rec.notes.length, 1);
  });

  test("the happy path carries audit:'ok', so a caller can tell them apart", async () => {
    const patched = await post("/rules/fs.destructive", { enabled: false });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { audit: string }).audit, "ok");

    const resolved = await post(`/trips/${KNOWN_TRIP}/resolve`);
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { audit: string }).audit, "ok");
    assert.equal(rec.audits.length, 2);
  });

  test("a FAILED mutation is still a failure — the audit field never rescues it", async () => {
    // The discrimination that matters: `audit` reports the LOG, and must not be
    // readable as "the change went through". A 404 keeps its 404 and writes
    // neither a notification nor an audit row.
    auditThrows = true;
    const res = await post("/rules/no-such-rule", { enabled: false });
    assert.equal(res.status, 404);
    assert.deepEqual(rec.notes, []);
    assert.deepEqual(rec.audits, []);
  });
});

/* ========================================================================== *
 * 4. Untouched routes stay untouched
 * ========================================================================== */

describe("the read and check routes are unchanged", () => {
  test("GET / carries the additive rule_changes field", async () => {
    const res = await createAutonomyRouter(deps()).request("/");
    assert.equal(res.status, 200);
    const body = (await res.json()) as AutonomyResponse;
    assert.deepEqual(body.rule_changes, []);
    assert.ok(Array.isArray(body.trips), "trips keeps its shape for AutonomySurface");
    assert.deepEqual(rec.audits, [], "a read is not a change");
    assert.deepEqual(rec.notes, []);
  });

  test("POST /check audits nothing — asking is not changing", async () => {
    const res = await post("/check", { agent: "bash-hook", action: "rm" });
    assert.equal(res.status, 200);
    assert.deepEqual(rec.audits, []);
    assert.deepEqual(rec.notes, []);
  });

  test("POST /check still rejects a payload with no agent/action", async () => {
    const res = await post("/check", { agent: "bash-hook" });
    assert.equal(res.status, 400);
    assert.deepEqual(rec.order, [], "a rejected check never reaches the engine");
  });
});

/* ========================================================================== *
 * 5. The notice strings, in isolation
 * ========================================================================== */

describe("notice text", () => {
  test("both fields in one patch read as one line", () => {
    assert.equal(
      ruleChangeNotice("comm.outbound", { enabled: false, config: { note: "x" } }, "deploy"),
      "🛡 guardrail comm.outbound: enabled=false, config updated (source deploy)",
    );
  });

  test("the trip notice carries the first 8 characters of the id", () => {
    assert.equal(
      tripResolveNotice(KNOWN_TRIP, "console"),
      "🛡 guardrail trip 7c9f1c58 resolved (source console)",
    );
  });
});
