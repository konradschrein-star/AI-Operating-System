/**
 * Tests for the hourly usage sampler.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Split by what can honestly be asserted where:
 *
 *  - The hour maths and the rate validation are pure, so they are tested
 *    directly and exhaustively. `nowMs` is always an argument; nothing here
 *    reads a clock.
 *  - `sampleHour` and `getRate/setRate` do I/O, so they are tested against a
 *    fake `Querier` that records the SQL and the params. That proves the
 *    contract this module owns — one upsert per hour, the same statement every
 *    time, a zero row rather than a missing row, EUR = USD × rate — without
 *    needing a Postgres on the machine running `pnpm test`.
 *  - Whether the SQL itself computes the right numbers is a database question,
 *    and a fake cannot answer it. That is proved behaviourally against a real
 *    scratch database in docs/plan/evidence/r1350-usage-sampler.md: apply
 *    0026+0040, insert synthetic spend_log + runs rows, run sampleHour twice,
 *    diff the row.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ATTRIBUTION,
  DEFAULT_EUR_PER_USD,
  HOUR_MS,
  RATE_KEY,
  RATE_MAX,
  RATE_MIN,
  RateValidationError,
  backfill,
  floorHour,
  getRate,
  missingBuckets,
  msUntilNextTick,
  previousClosedHour,
  runSamplerTick,
  sampleHour,
  setRate,
  usdToEur,
  validateRate,
  type Querier,
} from "./usage-sampler.ts";

/* ------------------------------------------------------------------------- *
 * A fake Querier
 * ------------------------------------------------------------------------- */

interface Call {
  sql: string;
  params: unknown[];
}

/** Answers each query with the next canned result, and records what it was
 *  asked. `rows` entries are consumed in order; an exhausted queue yields an
 *  empty result, which is itself a useful failure (the module throws a
 *  diagnostic rather than returning undefined). */
function fakeDb(responses: Array<Record<string, unknown>[]>): {
  db: Querier;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const db: Querier = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake
    // stands in for pg.Pool.query, whose generic row type we do not constrain.
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

/** What Postgres hands back for one usage_hourly row: bigints as strings,
 *  numerics as strings, timestamps as Dates. */
function pgRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bucket_start: new Date("2026-08-17T09:00:00.000Z"),
    tokens_in: "0",
    tokens_out: "0",
    cache_read: "0",
    cache_write: "0",
    shadow_usd: "0.0000",
    run_count: 0,
    sampled_at: new Date("2026-08-17T10:00:30.000Z"),
    meta: {},
    ...over,
  };
}

/* ------------------------------------------------------------------------- *
 * Hour maths
 * ------------------------------------------------------------------------- */

describe("hour maths", () => {
  test("floorHour truncates to the UTC hour", () => {
    assert.equal(
      floorHour(new Date("2026-08-17T13:47:19.813Z")).toISOString(),
      "2026-08-17T13:00:00.000Z",
    );
    // Already on the boundary: idempotent, not advanced.
    assert.equal(
      floorHour(new Date("2026-08-17T13:00:00.000Z")).toISOString(),
      "2026-08-17T13:00:00.000Z",
    );
  });

  test("previousClosedHour never returns an hour still in progress", () => {
    assert.equal(
      previousClosedHour(new Date("2026-08-17T14:03:00.000Z")).toISOString(),
      "2026-08-17T13:00:00.000Z",
    );
    // One millisecond past the boundary the just-ended hour is closed, and the
    // one before it is what a tick at :00:00.001 must NOT be sampling.
    assert.equal(
      previousClosedHour(new Date("2026-08-17T14:00:00.001Z")).toISOString(),
      "2026-08-17T13:00:00.000Z",
    );
  });

  test("msUntilNextTick lands on the boundary plus skew and is always > 0", () => {
    const skew = 30_000;
    assert.equal(
      msUntilNextTick(new Date("2026-08-17T13:00:00.000Z"), skew),
      HOUR_MS + skew,
    );
    assert.equal(
      msUntilNextTick(new Date("2026-08-17T13:59:00.000Z"), skew),
      60_000 + skew,
    );
    // Armed just after this hour's skew moment: must roll to the NEXT hour
    // rather than return a non-positive delay and spin the timer.
    const late = msUntilNextTick(new Date("2026-08-17T13:00:31.000Z"), skew);
    assert.ok(late > 0, `expected a positive delay, got ${late}`);
    assert.equal(late, HOUR_MS - 1_000);
  });
});

/* ------------------------------------------------------------------------- *
 * Backfill / gap detection — a quiet hour is a zero row, never a hole
 * ------------------------------------------------------------------------- */

describe("missingBuckets", () => {
  const from = new Date("2026-08-17T00:00:00.000Z");
  const through = new Date("2026-08-17T05:00:00.000Z");

  test("empty table → every bucket in the window, inclusive at both ends", () => {
    const got = missingBuckets([], from, through);
    assert.equal(got.length, 6);
    assert.equal(got[0]?.toISOString(), "2026-08-17T00:00:00.000Z");
    assert.equal(got[5]?.toISOString(), "2026-08-17T05:00:00.000Z");
  });

  test("existing buckets are skipped, gaps in the middle are not", () => {
    const got = missingBuckets(
      [
        new Date("2026-08-17T00:00:00.000Z"),
        "2026-08-17T01:00:00.000Z",
        new Date("2026-08-17T05:00:00.000Z"),
      ],
      from,
      through,
    );
    assert.deepEqual(
      got.map((d) => d.toISOString()),
      [
        "2026-08-17T02:00:00.000Z",
        "2026-08-17T03:00:00.000Z",
        "2026-08-17T04:00:00.000Z",
      ],
    );
  });

  test("a quiet hour is a hole to be filled, not left absent", async () => {
    // The whole point: nothing happened at 03:00, and the sampler still has to
    // write a row for it. A missing bucket is indistinguishable from "the
    // sampler was down", and a chart that cannot tell those apart lies twice.
    const existing = [
      new Date("2026-08-17T00:00:00.000Z"),
      new Date("2026-08-17T01:00:00.000Z"),
      new Date("2026-08-17T02:00:00.000Z"),
      new Date("2026-08-17T04:00:00.000Z"),
      new Date("2026-08-17T05:00:00.000Z"),
    ];
    const gaps = missingBuckets(existing, from, through);
    assert.deepEqual(
      gaps.map((d) => d.toISOString()),
      ["2026-08-17T03:00:00.000Z"],
    );

    // …and backfill() actually samples it. One SELECT, then one upsert per gap.
    const { db, calls } = fakeDb([
      existing.map((d) => ({ bucket_start: d })),
      [pgRow({ bucket_start: new Date("2026-08-17T03:00:00.000Z") })],
    ]);
    // A 30-day horizon over a 6-hour fixture would report ~715 gaps, so the
    // count is not asserted here — the ordering and shape of the calls is.
    await backfill(new Date("2026-08-17T06:10:00.000Z"), db).catch(() => {});
    assert.match(calls[0]?.sql ?? "", /SELECT bucket_start FROM usage_hourly/);
    assert.match(calls[1]?.sql ?? "", /INSERT INTO usage_hourly/);
  });
});

/* ------------------------------------------------------------------------- *
 * sampleHour — one upsert, idempotent by construction
 * ------------------------------------------------------------------------- */

describe("sampleHour", () => {
  test("issues exactly one statement, an upsert keyed on bucket_start", async () => {
    const { db, calls } = fakeDb([[pgRow()]]);
    await sampleHour(new Date("2026-08-17T09:14:00.000Z"), db);

    assert.equal(calls.length, 1, "one hour must cost exactly one round trip");
    const sql = calls[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO usage_hourly/);
    assert.match(sql, /ON CONFLICT \(bucket_start\) DO UPDATE/);
    // Every measured column must be in the DO UPDATE set, or a re-sample would
    // leave a stale value behind and idempotency would be a half-truth.
    for (const col of [
      "tokens_in",
      "tokens_out",
      "cache_read",
      "cache_write",
      "shadow_usd",
      "run_count",
      "meta",
    ]) {
      assert.match(
        sql,
        new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}`),
        `${col} is not refreshed by the upsert — a re-run would keep the old value`,
      );
    }
  });

  test("the bucket is floored and the window is exactly one hour, half-open", async () => {
    const { db, calls } = fakeDb([[pgRow()]]);
    await sampleHour(new Date("2026-08-17T09:14:00.000Z"), db);
    const [start, end] = calls[0]?.params ?? [];
    assert.equal(start, "2026-08-17T09:00:00.000Z");
    assert.equal(end, "2026-08-17T10:00:00.000Z");
    // Half-open [start, end): a row at exactly 10:00:00 belongs to the next
    // bucket. `>=` and `<` in the SQL are what stop double-counting it.
    assert.match(calls[0]?.sql ?? "", /created_at >= \$1::timestamptz/);
    assert.match(calls[0]?.sql ?? "", /created_at <  \$2::timestamptz/);
  });

  test("two runs over the same hour are byte-identical in every measured column", async () => {
    // The database is what makes this true (the statement recomputes from
    // source and overwrites). What the fake can prove is the half that lives in
    // this module: the same hour produces the same statement and the same
    // parameters, so nothing about the second call can diverge.
    const first = fakeDb([[pgRow({ tokens_out: "1234", shadow_usd: "0.2125" })]]);
    const second = fakeDb([[pgRow({ tokens_out: "1234", shadow_usd: "0.2125" })]]);
    const a = await sampleHour(new Date("2026-08-17T09:00:00.000Z"), first.db);
    const b = await sampleHour(new Date("2026-08-17T09:59:59.999Z"), second.db);

    assert.equal(first.calls[0]?.sql, second.calls[0]?.sql);
    assert.deepEqual(first.calls[0]?.params, second.calls[0]?.params);
    const measured = (s: typeof a) => ({ ...s, sampled_at: undefined });
    assert.deepEqual(measured(a), measured(b));
  });

  test("an empty hour returns a zero row, not null and not a throw", async () => {
    // Postgres cross-joins three aggregate CTEs, so an hour with no spend rows
    // still yields one row of zeroes. This asserts the TS side does not turn
    // that into something falsy on the way out.
    const { db } = fakeDb([[pgRow({ meta: { runs_found: 0, run_count: 0 } })]]);
    const s = await sampleHour(new Date("2026-08-17T03:00:00.000Z"), db);
    assert.equal(s.tokens_in, 0);
    assert.equal(s.tokens_out, 0);
    assert.equal(s.cache_read, 0);
    assert.equal(s.cache_write, 0);
    assert.equal(s.shadow_usd, 0);
    assert.equal(s.run_count, 0);
    assert.equal(s.bucket_start, "2026-08-17T09:00:00.000Z");
  });

  test("numeric and bigint columns arrive as strings and leave as numbers", async () => {
    const { db } = fakeDb([
      [
        pgRow({
          tokens_in: "9007199254",
          tokens_out: "42",
          cache_read: "22540",
          cache_write: "20005",
          shadow_usd: "0.2125",
          run_count: "7",
        }),
      ],
    ]);
    const s = await sampleHour(new Date("2026-08-17T09:00:00.000Z"), db);
    assert.equal(typeof s.tokens_in, "number");
    assert.equal(s.tokens_in, 9_007_199_254);
    assert.equal(s.shadow_usd, 0.2125);
    assert.equal(s.run_count, 7);
  });

  test("a suppressed insert throws with a diagnostic instead of returning null", async () => {
    const { db } = fakeDb([[]]);
    await assert.rejects(
      () => sampleHour(new Date("2026-08-17T09:00:00.000Z"), db),
      /inserted no row.*migration 0040/s,
    );
  });

  test("the attribution rule is written into the row's meta", async () => {
    const { db, calls } = fakeDb([[pgRow()]]);
    await sampleHour(new Date("2026-08-17T09:00:00.000Z"), db);
    assert.equal(calls[0]?.params?.[2], ATTRIBUTION);
    assert.equal(ATTRIBUTION, "counted at run completion");
  });

  test("token extraction guards every cast against non-numeric JSON", async () => {
    // `(x->>'k')::numeric` raises on non-numeric text, and one malformed
    // metadata blob would abort the whole hour. Every read is behind a
    // jsonb_typeof check; count them so a future edit cannot quietly drop one.
    const { db, calls } = fakeDb([[pgRow()]]);
    await sampleHour(new Date("2026-08-17T09:00:00.000Z"), db);
    const sql = calls[0]?.sql ?? "";
    const guards = sql.match(/jsonb_typeof\(/g) ?? [];
    const casts = sql.match(/::numeric/g) ?? [];
    assert.ok(
      guards.length >= casts.length,
      `${casts.length} numeric casts but only ${guards.length} jsonb_typeof guards`,
    );
    // usage_total_running is the cumulative field; usage_running is the
    // last-message fallback. Reading only the latter under-counts by orders of
    // magnitude, so both must appear, in that order.
    const iTotal = sql.indexOf("usage_total_running");
    const iRunning = sql.indexOf("'usage_running'");
    assert.ok(iTotal > -1, "usage_total_running is not read at all");
    assert.ok(iRunning > iTotal, "usage_running must be the fallback, not the primary");
    // Subagent usage is not folded into the parent total; it must be added.
    assert.match(sql, /subagents_v2/);
    // rollup_v1 is a timestamp scalar, not a usage object — reading it would
    // silently yield NULL for every run.
    assert.doesNotMatch(sql, /rollup_v1/);
  });
});

/* ------------------------------------------------------------------------- *
 * The tick
 * ------------------------------------------------------------------------- */

describe("runSamplerTick", () => {
  test("closes the previous hour and re-samples the one before it", async () => {
    const { db, calls } = fakeDb([[pgRow()], [pgRow()]]);
    const got = await runSamplerTick(new Date("2026-08-17T14:00:30.000Z"), db);
    assert.equal(got.length, 2);
    // Oldest first, so the newest closed hour is the last thing logged.
    assert.equal(calls[0]?.params?.[0], "2026-08-17T12:00:00.000Z");
    assert.equal(calls[1]?.params?.[0], "2026-08-17T13:00:00.000Z");
  });
});

/* ------------------------------------------------------------------------- *
 * Rate: validation bounds and EUR conversion
 * ------------------------------------------------------------------------- */

describe("validateRate", () => {
  test("accepts the bounds themselves and everything between", () => {
    assert.equal(validateRate(RATE_MIN), 0.1);
    assert.equal(validateRate(RATE_MAX), 10);
    assert.equal(validateRate(0.86), 0.86);
    assert.equal(validateRate(1), 1);
  });

  test("rejects out-of-band numbers with the band in the message", () => {
    for (const bad of [0, -1, 0.09999, 10.0001, 1000]) {
      assert.throws(
        () => validateRate(bad),
        (e: unknown) =>
          e instanceof RateValidationError && /between 0.1 and 10/.test(e.message),
        `${bad} was accepted as a EUR/USD rate`,
      );
    }
  });

  test("rejects non-numbers and non-finite numbers", () => {
    // "0.9" is the interesting one: a JSON body from a form sends strings, and
    // coercing it would let "abc" through as NaN two releases later.
    for (const bad of ["0.9", null, undefined, {}, [], true]) {
      assert.throws(
        () => validateRate(bad),
        RateValidationError,
        `${JSON.stringify(bad)} was accepted as a EUR/USD rate`,
      );
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => validateRate(bad), /finite/);
    }
  });
});

describe("usdToEur", () => {
  test("EUR = USD × rate", () => {
    assert.equal(usdToEur(100, 0.86), 86);
    assert.equal(usdToEur(0.2125, 1), 0.2125);
    assert.equal(usdToEur(0, 0.86), 0);
  });

  test("rounds to 4 decimals, matching spend_log.amount_eur", () => {
    // 0.21250799999999997 × 0.86 = 0.1827568799… — the raw float would print
    // as a 17-digit number on the panel.
    assert.equal(usdToEur(0.21250799999999997, 0.86), 0.1828);
    assert.equal(usdToEur(1 / 3, 0.86), 0.2867);
  });

  test("the default matches executor.ts, so /api/spend and /api/usage agree", () => {
    // executor.ts writes spend_log.amount_eur as costUsd * (CC_USD_EUR ?? 0.86).
    // A different default here would make the two surfaces disagree about the
    // same spend and read as a bug.
    assert.equal(DEFAULT_EUR_PER_USD, Number(process.env.CC_USD_EUR ?? "0.86"));
  });
});

describe("getRate / setRate", () => {
  test("no row → the code default, labelled as such", async () => {
    const { db, calls } = fakeDb([[]]);
    const r = await getRate(db);
    assert.equal(r.eur_per_usd, DEFAULT_EUR_PER_USD);
    assert.equal(r.source, "default");
    assert.equal(r.updated_at, null);
    assert.equal(calls[0]?.params?.[0], RATE_KEY);
  });

  test("a row wins over the default and is labelled app_settings", async () => {
    const { db } = fakeDb([
      [{ value: 0.93, updated_at: new Date("2026-08-17T10:00:00.000Z") }],
    ]);
    const r = await getRate(db);
    assert.equal(r.eur_per_usd, 0.93);
    assert.equal(r.source, "app_settings");
    assert.equal(r.updated_at, "2026-08-17T10:00:00.000Z");
  });

  test("a corrupt stored rate throws instead of silently falling back", async () => {
    // Falling back would hide the bad row forever and quietly change every
    // number on the panel. Loud is correct here.
    const { db } = fakeDb([[{ value: 99, updated_at: new Date() }]]);
    await assert.rejects(() => getRate(db), /not a rate in 0.1..10/);
  });

  test("setRate validates BEFORE it writes", async () => {
    const { db, calls } = fakeDb([[{ updated_at: new Date() }]]);
    await assert.rejects(() => setRate(50, db), RateValidationError);
    assert.equal(calls.length, 0, "a rejected rate must not reach the database");
  });

  test("setRate upserts on the key and returns the stored value", async () => {
    const { db, calls } = fakeDb([
      [{ updated_at: new Date("2026-08-17T11:22:33.000Z") }],
    ]);
    const r = await setRate(0.92, db);
    assert.equal(r.eur_per_usd, 0.92);
    assert.equal(r.source, "app_settings");
    assert.equal(r.updated_at, "2026-08-17T11:22:33.000Z");
    assert.match(calls[0]?.sql ?? "", /ON CONFLICT \(key\) DO UPDATE/);
    assert.deepEqual(calls[0]?.params, [RATE_KEY, "0.92"]);
  });
});
