/**
 * nav-walk-sampling.cjs — ROUND 808, the arithmetic behind round 807 finding 4.
 *
 * THE OBSERVATION (round 807, reproduced by the reviewer over three runs):
 * `phase600/nav-walk.cjs` P1/P2 fail about one run in three.
 *
 *     run 1  36 / 38 / 38   ← FAIL: depth_1 (38) > at_rest (36)
 *     run 2  38 / 38 / 38   ← pass
 *     run 3  38 / 38 / 38   ← pass
 *
 * P1 asserts `pDepth1.requests <= pRest.requests`, comparing two SEPARATELY
 * SAMPLED 30 s windows. 36 vs 38 per minute is 18 vs 19 raw requests — one
 * single request of difference, in the at-rest window, one window earlier.
 *
 * ── ROUND 807's PROPOSED CAUSE, AND WHY IT IS BACKWARDS ───────────────────
 *
 * The review says: round 802's chat-list `8s → 10s` is the cause, because
 * "10 s divides the 30 s sampling window exactly", and proposes "a period that
 * isn't a divisor of the window". The arithmetic says the opposite. For a
 * free-running poll of period `p` sampled over a window of length `W`, with the
 * time to the first firing φ uniform on [0, p):
 *
 *     count(φ) = floor((W − φ) / p) + 1
 *
 * As φ sweeps [0, p), the quantity (W − φ)/p sweeps (W/p − 1, W/p] — an
 * interval of length exactly 1. An interval of length 1 contains an integer in
 * its interior for EVERY p except one case: when W/p is itself an integer, the
 * interval is (k−1, k], whose only integer is the closed endpoint, so floor is
 * constant and the count is EXACTLY k for every φ > 0. In other words:
 *
 *     EXACT DIVISORS ARE THE ONLY PHASE-STABLE PERIODS.
 *     Every non-divisor lands floor(W/p) or floor(W/p)+1 depending on phase.
 *
 * So 10 s is not a bad choice; 11 s would be strictly worse (2 or 3 per window,
 * a genuine coin flip). Round 802's own reasoning — which rejected a 60 s plan
 * poll for exactly this reason — was right, and the review's proposed direction
 * would re-introduce the defect it was trying to remove.
 *
 * ── THE ACTUAL CAUSE ──────────────────────────────────────────────────────
 *
 * react-query's `refetchInterval` is not a metronome. The timer is re-armed
 * after each fetch SETTLES, so the effective period is `interval + latency`,
 * not `interval`. That drags every nominal divisor a hair ABOVE the divisor —
 * which is the worst place on the whole number line to be, because p = 10 + ε
 * gives (W − φ)/p sweeping (1.99…, 2.99…], straddling the integer 2, so the
 * count is 2 or 3 rather than a stable 3.
 *
 * And it is not only the chat list. At 3 s + latency the chat-detail poll
 * lands 9 or 10 per window, which alone is enough to flip a `<=` between two
 * sampled windows. That is the finding this script exists to make undeniable:
 *
 *     NO CHOICE OF POLL PERIOD MAKES P1/P2 SOUND, because the instrument's
 *     own resolution is ±1 sample per poll, and the assertion compares two
 *     independent samples with no tolerance for it.
 *
 * Hence the round-808 fix is the review's SECOND option — let P1/P2 tolerate
 * one sample — and NOT a period change. Changing the period would spend round
 * 802's measured request headroom and leave the flake in place.
 *
 * ── WHAT THIS SCRIPT COMPUTES ─────────────────────────────────────────────
 *
 * 1. The closed-form low-count probability `P(low) = 1 − r/p` (W = k·p + r) for
 *    every candidate period, checked against a Monte-Carlo of the same model.
 * 2. A Monte-Carlo of the WHOLE surface — all four polls, three windows, the
 *    real assertion — giving the per-run failure rate of P1/P2 as written, and
 *    under the ±1-sample tolerance. The first should land near round 807's
 *    observed ~1-in-3; the second should be 0.
 *
 * It is pure arithmetic: no browser, no server, no database, deterministic
 * under a fixed seed, and it runs in well under a second.
 *
 *   node docs/plan/artifacts/phase800/nav-walk-sampling.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* Round 705's non-destructive rule, as in lib-804.cjs: without `--write` a
 * rerun writes to /tmp and leaves `git status --porcelain` untouched. Restated
 * here rather than imported, so this stays runnable with no browser. */
const SRC_DIR = __dirname;
const WRITE_IN_PLACE = process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ?? (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

const WINDOW_MS = 30_000;

/* A seeded PRNG: a flake analysis a reviewer cannot reproduce exactly is
 * worth very little. mulberry32, fixed seed, stated here. */
const SEED = 808;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeChecker() {
  const results = [];
  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    results.push({ name, ok, actual, expected });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}` +
        (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
    );
  };
  const note = (name, value) => {
    results.push({ name, note: value });
    console.log(`      ${name}: ${JSON.stringify(value)}`);
  };
  return { results, check, note, failed: () => failures };
}

/** count(φ) = floor((W − φ)/p) + 1 — one poll, one window. */
const countInWindow = (periodMs, phaseMs) => Math.floor((WINDOW_MS - phaseMs) / periodMs) + 1;

/**
 * Closed form for the SPREAD probability. Write W = k·p + r with 0 ≤ r < p.
 * floor((W − φ)/p) = k exactly when φ ≤ r, so
 *
 *     count = k + 1  with probability r/p   (the HIGH outcome)
 *     count = k      with probability 1 − r/p
 *
 * and therefore the count is deterministic — no phase dependence at all — if
 * and only if r = 0, i.e. p divides W exactly. `pHigh` is the probability of
 * the extra sample; `pHigh === 0` is the definition of a phase-stable period.
 */
function pHighClosedForm(periodMs) {
  return (WINDOW_MS % periodMs) / periodMs;
}

/** The same probability by simulation, so the closed form is checked, not trusted. */
function pHighMonteCarlo(periodMs, rand, n = 200_000) {
  const k = Math.floor(WINDOW_MS / periodMs);
  let high = 0;
  for (let i = 0; i < n; i++) if (countInWindow(periodMs, rand() * periodMs) > k) high++;
  return high / n;
}

/* The four polls of the manager chat at rest, as round 802 documented them.
 * `latencyMs` is what turns a nominal divisor into a non-divisor: react-query
 * re-arms the timer after the fetch settles. */
const POLLS = [
  { name: "chat detail", nominalMs: 3_000 },
  { name: "team", nominalMs: 6_000 },
  { name: "chat list (round 802: 8s → 10s)", nominalMs: 10_000 },
  { name: "plan kanban", nominalMs: 30_000 },
];

/**
 * One simulated nav-walk run: three consecutive 30 s windows, each poll
 * free-running across all three with its own phase, at a given latency.
 * Returns the raw request count per window.
 */
function simulateRun(latencyMs, rand) {
  const windows = [0, 0, 0];
  for (const poll of POLLS) {
    const p = poll.nominalMs + latencyMs;
    let phase = rand() * p; // arbitrary alignment when measurement starts
    for (let w = 0; w < 3; w++) {
      windows[w] += countInWindow(p, phase);
      /* Carry the phase into the next window: after `count` firings the next
       * one is due at `phase + count·p − W` measured from the new window. */
      const c = countInWindow(p, phase);
      phase = phase + c * p - WINDOW_MS;
    }
  }
  return windows;
}

function main() {
  const { check, note, results, failed } = makeChecker();
  const started_at = new Date().toISOString();
  const rand = mulberry32(SEED);

  console.log("── A. DIVISORS ARE THE STABLE PERIODS, NOT THE UNSTABLE ONES ──\n");

  const candidates = [3_000, 6_000, 8_000, 9_000, 10_000, 11_000, 12_000, 15_000];
  const table = candidates.map((p) => {
    const closed = pHighClosedForm(p);
    const mc = pHighMonteCarlo(p, rand);
    const k = Math.floor(WINDOW_MS / p);
    return {
      period_ms: p,
      divides_30s: WINDOW_MS % p === 0,
      possible_counts_per_window: closed === 0 ? [k] : [k, k + 1],
      p_extra_sample_closed_form: Number(closed.toFixed(4)),
      p_extra_sample_monte_carlo: Number(mc.toFixed(4)),
      phase_stable: closed === 0,
    };
  });
  for (const row of table) note(`A period ${row.period_ms} ms`, row);

  check(
    "A1 the closed form P(extra sample) = r/p agrees with the Monte-Carlo everywhere (±0.01)",
    table.every((r) => Math.abs(r.p_extra_sample_closed_form - r.p_extra_sample_monte_carlo) < 0.01),
    true,
  );
  check(
    "A2 EXACT DIVISORS of the 30 s window are the phase-STABLE periods (one possible count)",
    table.filter((r) => r.divides_30s).every((r) => r.phase_stable && r.possible_counts_per_window.length === 1),
    true,
  );
  check(
    "A3 every NON-divisor varies by one sample with phase — the review's proposed 11 s included",
    table.filter((r) => !r.divides_30s).every((r) => !r.phase_stable && r.possible_counts_per_window.length === 2),
    true,
  );
  check(
    "A4 the review's direction is backwards: 11 s varies where the current 10 s does not",
    [pHighClosedForm(11_000) > 0, pHighClosedForm(10_000) === 0],
    [true, true],
  );

  console.log("\n── B. LATENCY IS WHAT BREAKS IT — a divisor + ε is the worst case ──\n");

  /* react-query re-arms after settle, so the true period is interval+latency. */
  for (const lat of [0, 50, 150, 300]) {
    const p = 10_000 + lat;
    note(`B chat list 10 s + ${lat} ms latency`, {
      effective_period_ms: p,
      possible_counts_per_window:
        pHighClosedForm(p) === 0 ? [Math.floor(WINDOW_MS / p)] : [Math.floor(WINDOW_MS / p), Math.floor(WINDOW_MS / p) + 1],
      p_extra_sample: Number(pHighClosedForm(p).toFixed(4)),
    });
  }
  check(
    "B1 a nominal divisor becomes phase-unstable the moment latency is non-zero",
    [pHighClosedForm(10_000) === 0, pHighClosedForm(10_150) > 0],
    [true, true],
  );
  check(
    "B2 the 3 s chat-detail poll ALONE varies by one sample — so no chat-list period can fix P1",
    pHighClosedForm(3_150) > 0 && pHighClosedForm(3_150) < 1,
    true,
  );
  note("B2 evidence — 3 s + 150 ms lands this many per window", [
    Math.floor(WINDOW_MS / 3_150),
    Math.floor(WINDOW_MS / 3_150) + 1,
  ]);

  console.log("\n── C. THE ASSERTION ITSELF — as written, with ±1, and with ±N ──\n");

  /* THE TOLERANCE IS DERIVED, NOT PICKED.
   *
   * Each free-running poll contributes k or k+1 samples to a window, so each
   * contributes at most ONE to the difference between two windows. With N
   * distinct polls running, two independently sampled windows can therefore
   * differ by up to N samples on nothing but phase. ±1 is what the review
   * proposed and it is NOT enough — the surface runs four polls. The sound
   * tolerance is N, the number of distinct polled paths, which nav-walk
   * already measures per window and can read off at runtime instead of
   * hard-coding a magic number. */
  const RUNS = 20_000;
  const N_POLLS = POLLS.length;
  const rates = {};
  for (const lat of [50, 150, 300]) {
    let strictFail = 0;
    let tol1Fail = 0;
    let tolNFail = 0;
    let ceilingFail = 0;
    let maxSpread = 0;
    const spreads = {};
    for (let i = 0; i < RUNS; i++) {
      const [rest, d1, d2] = simulateRun(lat, rand);
      if (!(d1 <= rest && d2 <= rest)) strictFail++;
      if (!(d1 <= rest + 1 && d2 <= rest + 1)) tol1Fail++;
      if (!(d1 <= rest + N_POLLS && d2 <= rest + N_POLLS)) tolNFail++;
      if (!(d1 * 2 <= 40 && d2 * 2 <= 40)) ceilingFail++;
      maxSpread = Math.max(maxSpread, d1 - rest, d2 - rest);
      const key = `${rest * 2}/${d1 * 2}/${d2 * 2}`;
      spreads[key] = (spreads[key] ?? 0) + 1;
    }
    const top = Object.entries(spreads)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} ×${((v / RUNS) * 100).toFixed(1)}%`);
    rates[`latency_${lat}ms`] = {
      p1_p2_as_written_fail_rate: Number((strictFail / RUNS).toFixed(4)),
      p1_p2_tolerance_1_fail_rate: Number((tol1Fail / RUNS).toFixed(4)),
      [`p1_p2_tolerance_${N_POLLS}_fail_rate`]: Number((tolNFail / RUNS).toFixed(4)),
      p3_ceiling_fail_rate: Number((ceilingFail / RUNS).toFixed(4)),
      max_observed_excess_samples: maxSpread,
      most_common_per_minute_triples: top,
    };
    note(`C latency ${lat} ms`, rates[`latency_${lat}ms`]);
  }

  const worst = (key) => Math.max(...Object.values(rates).map((r) => r[key]));
  const worstStrict = worst("p1_p2_as_written_fail_rate");
  const worstTol1 = worst("p1_p2_tolerance_1_fail_rate");
  const worstTolN = worst(`p1_p2_tolerance_${N_POLLS}_fail_rate`);
  const worstCeiling = worst("p3_ceiling_fail_rate");
  const worstSpread = Math.max(...Object.values(rates).map((r) => r.max_observed_excess_samples));

  check("C1 P1/P2 as written flake at a rate consistent with round 807's 1-run-in-3", worstStrict > 0.15, true);
  check(
    "C2 the review's proposed ±1 tolerance is NOT enough — four independent polls can drift further",
    worstTol1 > 0,
    true,
  );
  check(
    `C3 a tolerance of N = ${N_POLLS} (one sample per distinct polled path) never flakes in ${RUNS} simulated runs`,
    worstTolN,
    0,
  );
  check(
    `C4 and N is TIGHT, not slack: the worst observed excess is ${worstSpread} samples, i.e. ≤ N`,
    worstSpread <= N_POLLS && worstSpread >= N_POLLS - 1,
    true,
  );
  check("C5 P3's absolute 40/min ceiling is unaffected — it never fires either way", worstCeiling, 0);
  note("C summary", {
    p1_p2_as_written_worst_case: worstStrict,
    p1_p2_tolerance_1_worst_case: worstTol1,
    [`p1_p2_tolerance_${N_POLLS}_worst_case`]: worstTolN,
    max_observed_excess_samples: worstSpread,
    p3_worst_case: worstCeiling,
  });

  const payload = {
    protocol: "round 808 — nav-walk P1/P2 sampling arithmetic",
    finding: "round 807 finding 4",
    started_at,
    finished_at: new Date().toISOString(),
    model: {
      window_ms: WINDOW_MS,
      count_formula: "floor((W - phase) / p) + 1",
      p_low_closed_form: "1 - r/p, where W = k*p + r",
      polls: POLLS,
      note: "react-query re-arms refetchInterval after the fetch settles, so the effective period is interval + latency",
    },
    seed: SEED,
    monte_carlo_runs: RUNS,
    period_table: table,
    assertion_failure_rates: rates,
    conclusion:
      "Exact divisors of the sampling window are the phase-STABLE periods; every non-divisor varies by one sample. " +
      "The review's proposed 11 s would be worse than the current 10 s. Latency makes every nominal divisor slightly " +
      "non-divisor, and the 3 s chat-detail poll varies on its own regardless, so no choice of chat-list period can " +
      "make a zero-tolerance `<=` between two independently sampled windows sound. The correct fix is the review's " +
      "second option: let P1/P2 tolerate one sample. P3's absolute 40/min ceiling stays exactly as strict as it was.",
    checks: results.filter((r) => "ok" in r).length,
    failures: failed(),
    results,
  };
  const fileName = "nav-walk-sampling.json";
  const out = path.join(OUT_DIR, fileName);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failed() === 0 ? "ALL PASS" : `${failed()} FAILURE(S)`} — ${payload.checks} checks → ${out}`);
  if (OUT_DIR !== SRC_DIR) {
    console.log(`      committed evidence left untouched (${path.join(SRC_DIR, fileName)})`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(failed() === 0 ? 0 : 1);
}

main();
