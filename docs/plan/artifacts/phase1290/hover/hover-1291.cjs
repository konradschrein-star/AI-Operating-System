/**
 * hover-1291.cjs — phase 1290, round 1291: close the 61 ms residual.
 *
 * WHAT THIS IS. `docs/plan/artifacts/phase900/hover-904.json` left exactly one
 * open number behind: run1's team panel showed 1 long task of 61 ms during the
 * hover window and 0 during the parked-pointer idle window, so
 * `attributable.longTasks` came out at +1. run2 showed 1 in BOTH windows (+0),
 * and the rail showed 1 idle / 0 hover in both runs (-1). That is a machine
 * emitting ambient 50–60 ms long tasks with nothing happening; two windows
 * cannot separate a hover cost from that floor. This script runs five
 * interleaved idle/hover pairs per surface so the floor becomes visible as a
 * distribution instead of a coin flip, and it attributes every long task it
 * sees rather than only counting them.
 *
 * It changes no application code. It is a measurement.
 *
 * WHAT IT ADDS OVER hover-904.cjs (counters and idle-baseline discipline kept
 * verbatim — same 10 s windows, same parked-pointer baseline, same crossings /
 * mutations / longTasks / maxLongTask):
 *
 *  1. LONG-TASK ATTRIBUTION. Every `longtask` PerformanceObserver entry is
 *     recorded whole: `startTime`, `duration`, `name` (the culprit browsing
 *     context: "self", "same-origin-descendant", "unknown", …) and the full
 *     `attribution` array of TaskAttributionTiming (`containerType`,
 *     `containerName`, `containerId`, `containerSrc`). The list is emitted, not
 *     just its length.
 *
 *  2. CROSSING TIMESTAMPS, aligned to the long tasks. Each long task is
 *     reported with the ms gap to the nearest crossing, so a task that fell
 *     BETWEEN crossings is distinguishable from one that fell inside a pointer
 *     move. Crossing times are on the page clock but are taken WITHOUT running
 *     any in-page code: the window records `performance.timeOrigin` once, and
 *     each crossing's page-relative time is `Date.now() - timeOrigin`. Adding a
 *     `pointermove` listener or an `evaluate` per crossing would have put the
 *     very script work we are trying to measure onto the main thread. The
 *     mapping is checked at both ends of every window (`clockCheck`), so its
 *     error is in the JSON rather than assumed away.
 *
 *  3. SCRIPTING / STYLE / LAYOUT ms VIA CDP. `Performance.enable` once per
 *     page, then `Performance.getMetrics` immediately before and after EACH
 *     window; the deltas for `ScriptDuration`, `RecalcStyleDuration`,
 *     `LayoutDuration` and `TaskDuration` are recorded in ms.
 *     *** These are Chrome's own aggregate counters for the whole renderer.
 *     They are NOT a trace attribution: they cannot tell hover handling from
 *     the app's 5 s poll, from React, or from GC. They are the cheapest honest
 *     thing that says anything at all about gate clause (b), and the README
 *     labels them as an aggregate, not as attributed scripting time. ***
 *
 *  4. FIVE INTERLEAVED REPETITIONS. Per surface: idle, hover, idle, hover, …
 *     for 5 pairs, alternating so VPS drift shows up in the raw per-pair table
 *     instead of hiding in a mean. `os.loadavg()`, `os.cpus().length` and
 *     `/proc/uptime` are sampled before and after every single pair.
 *
 * HONESTY (03-quality §4). No poll cadence is touched, no hover affordance is
 * removed, the raw JSON is committed unfiltered, and if the five pairs disagree
 * by more than 2× the script says so in `spread` — the README records the load
 * and the re-run rather than picking the good pair.
 *
 * ANTI-LYING CHECK (03-quality §5 names this attack by name: "sweep script not
 * actually hitting rows"). Mid-way through every hover window the script asks
 * the page which elements match `:hover` and asserts that a swept row — or a
 * descendant of one — is among them. That is one `evaluate` returning a short
 * string, inside the measured window; it is disclosed here and its cost is
 * bounded by the idle windows, which pay no such call.
 *
 * WHERE IT RUNS. A worktree build served on :7790 against the :7798 API
 * harness — never production, never `forge-control-web/.next`. Recipe in the
 * sibling README, derived from `docs/plan/artifacts/phase500/README.md` §2.
 *
 * Playwright is loaded by absolute path from /opt/hermes-workspace and chromium
 * resolved out of /root/.cache/ms-playwright, so neither repo gains a
 * dependency (NFU8) — same as every browser script in this corpus.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
  if (!found) throw new Error(`no chromium under ${cache} — playwright browsers not installed`);
  return found;
}

const BASE = (process.env.HOVER_BASE_URL ?? "http://127.0.0.1:7790").trim();
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const CHAT_TEXT = "Okay when I click the file section";
const TEAM_RUN_ID = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const PAIRS = Number(process.env.HOVER_PAIRS ?? 5);
const WINDOW_MS = Number(process.env.HOVER_WINDOW_MS ?? 10_000);
const RUN_LABEL = (process.env.HOVER_RUN_LABEL ?? "run1").trim();
const CONTROL = process.env.HOVER_CONTROL === "1";

/**
 * WHERE THE OUTPUT GOES — and why it is no longer `__dirname` (round 1301).
 *
 * Until round 1301 this was `const OUT = __dirname;`, unconditionally. Running
 * the README's own §7 reproduce block therefore OVERWROTE `hover-1291.json` —
 * the committed evidence the run is meant to verify against. Round 1293 had to
 * copy this script to /tmp to work around it, and this project has already been
 * bitten once by a round clobbering a predecessor's committed evidence.
 *
 * So: the default target is an uncommitted temp directory, and writing anywhere
 * inside the repo is an EXPLICIT opt-in — `HOVER_OUT=<dir>` naming the artifact
 * directory, or `--commit-artifact` meaning "yes, into `__dirname`, on purpose".
 * The guard below is a backstop rather than a routine path: with neither opt-in
 * the target is /tmp and cannot resolve into the repo unless someone edits the
 * default. It exists so that editing the default is loud instead of silent.
 *
 * ONLY output-path resolution changed. No measurement logic was touched, so the
 * numbers this script produces stay comparable to `hover-1291.json`.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const COMMIT_ARTIFACT = process.argv.includes("--commit-artifact");
const HOVER_OUT = (process.env.HOVER_OUT ?? "").trim();
const OUT = path.resolve(HOVER_OUT || (COMMIT_ARTIFACT ? __dirname : "/tmp/hover-1291-out"));
const OPTED_IN = COMMIT_ARTIFACT || HOVER_OUT !== "";
if (!OPTED_IN && (OUT === REPO_ROOT || OUT.startsWith(REPO_ROOT + path.sep))) {
  throw new Error(
    `hover-1291.cjs refuses to write inside the repo without an explicit opt-in.\n` +
      `  resolved output dir: ${OUT}\n` +
      `  repo root:           ${REPO_ROOT}\n` +
      `  pass --commit-artifact to write into ${__dirname}, or set HOVER_OUT=<dir>.`,
  );
}
fs.mkdirSync(OUT, { recursive: true });

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint it per the README §Reproduce");
if (BASE.includes("os.schreinercontentsystems.com")) {
  throw new Error("round 1291 is a build task: production URLs are out of bounds");
}

// ---------------------------------------------------------------- observers

/** Arm the observers. Results are read back by COLLECT. */
const ARM = () => {
  window.__h = {
    mutations: 0,
    longTasks: [],
    t0: performance.now(),
    timeOrigin: performance.timeOrigin,
  };
  window.__mo = new MutationObserver((recs) => {
    window.__h.mutations += recs.length;
  });
  window.__mo.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  window.__po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__h.longTasks.push({
        startTime: Math.round(e.startTime * 100) / 100,
        duration: Math.round(e.duration * 100) / 100,
        name: e.name,
        entryType: e.entryType,
        // TaskAttributionTiming — the culprit frame/container, when Chrome knows it.
        attribution: [...(e.attribution ?? [])].map((a) => ({
          name: a.name,
          entryType: a.entryType,
          containerType: a.containerType,
          containerName: a.containerName,
          containerId: a.containerId,
          containerSrc: a.containerSrc,
        })),
      });
    }
  });
  try {
    window.__po.observe({ entryTypes: ["longtask"] });
    window.__h.longtaskSupported = true;
  } catch {
    window.__h.longtaskSupported = false;
  }
  return { timeOrigin: performance.timeOrigin, pageNow: performance.now(), wall: Date.now() };
};

const COLLECT = () => {
  window.__mo.disconnect();
  try {
    window.__po.disconnect();
  } catch {
    /* observer was never armed — longtaskSupported already says so */
  }
  const h = window.__h;
  return {
    mutations: h.mutations,
    longTasks: h.longTasks.length,
    maxLongTaskMs: h.longTasks.length ? Math.max(...h.longTasks.map((t) => t.duration)) : 0,
    longTaskDetail: h.longTasks,
    longtaskSupported: h.longtaskSupported,
    windowMs: Math.round(performance.now() - h.t0),
    timeOrigin: h.timeOrigin,
    endPageNow: performance.now(),
    endWall: Date.now(),
  };
};

/**
 * Is the pointer REALLY on the row the sweep aimed at? 03-quality §5 tells the
 * red-team reviewer to attack exactly this ("sweep script not actually hitting
 * rows"), so the assertion is surface-agnostic and does not trust a class name:
 * the element the browser reports at the target coordinates must be the same
 * element the browser reports as `:hover`, and it must not be BODY/HTML.
 * `data-team-row` membership is reported as extra colour where it applies.
 */
const HOVER_PROBE = (target) => {
  const hot = [...document.querySelectorAll(":hover")];
  const deepest = hot.length ? hot[hot.length - 1] : null;
  const atPoint = document.elementFromPoint(target.x, target.y);
  const sameNode = Boolean(
    deepest && atPoint && (atPoint === deepest || atPoint.contains(deepest) || deepest.contains(atPoint)),
  );
  const teamRow = deepest ? deepest.closest("[data-team-row]") : null;
  return {
    target,
    hoverChainLength: hot.length,
    deepestTag: deepest ? deepest.tagName : null,
    deepestClass: deepest ? String(deepest.className).slice(0, 80) : null,
    elementAtTargetIsTheHoveredOne: sameNode,
    teamRowHovered: Boolean(teamRow),
    hoveredRowText: ((teamRow ?? deepest)?.textContent ?? "").slice(0, 60) || null,
    pass: Boolean(sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML"),
  };
};

// ------------------------------------------------------------------ CDP

const METRIC_KEYS = ["ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "TaskDuration"];

async function readMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const out = {};
  for (const k of METRIC_KEYS) {
    const m = metrics.find((x) => x.name === k);
    // Chrome reports these cumulative counters in SECONDS.
    out[k] = m ? Math.round(m.value * 1000 * 100) / 100 : null;
  }
  return out;
}

function metricsDelta(before, after) {
  const d = {};
  for (const k of METRIC_KEYS) {
    d[k + "Ms"] = before[k] === null || after[k] === null ? null : Math.round((after[k] - before[k]) * 100) / 100;
  }
  return d;
}

// ---------------------------------------------------------------- windows

function osSample() {
  const [l1, l5, l15] = os.loadavg();
  const up = fs.readFileSync("/proc/uptime", "utf8").trim().split(/\s+/).map(Number);
  return {
    loadavg: [Math.round(l1 * 100) / 100, Math.round(l5 * 100) / 100, Math.round(l15 * 100) / 100],
    cpus: os.cpus().length,
    procUptimeSec: up[0],
    procIdleSec: up[1],
  };
}

/**
 * Park the pointer far from any row and observe for the same window length.
 * Without this, a polling app's own re-renders get billed to hover. Round 904
 * proved why it matters: on this VPS the idle window regularly contains a
 * 50–60 ms long task all by itself.
 */
async function idleWindow(page, cdp, ms) {
  const m0 = await readMetrics(cdp);
  const armed = await page.evaluate(ARM);
  await page.waitForTimeout(ms);
  const res = await page.evaluate(COLLECT);
  const m1 = await readMetrics(cdp);
  return finish("idle", armed, res, m0, m1, [], []);
}

/**
 * Sweep the pointer across `boxes`, one crossing per box, cycling until the
 * window closes. Crossing page-times are derived from the wall clock and the
 * page's timeOrigin — see the header, point 2.
 */
async function hoverWindow(page, cdp, boxes, ms, probeAtCrossings) {
  const m0 = await readMetrics(cdp);
  const armed = await page.evaluate(ARM);
  const start = Date.now();
  const crossings = [];
  const hoverProbes = [];
  let i = 0;
  outer: while (Date.now() - start < ms) {
    for (let b = 0; b < boxes.length; b++) {
      if (Date.now() - start >= ms) break outer;
      await page.mouse.move(boxes[b].x, boxes[b].y, { steps: 2 });
      // page-clock time of this crossing, with no in-page code executed
      crossings.push({
        i,
        rowIndex: b,
        pageMs: Math.round((Date.now() - armed.timeOrigin) * 100) / 100,
      });
      if (probeAtCrossings.includes(i)) {
        hoverProbes.push({ atCrossing: i, rowIndex: b, ...(await page.evaluate(HOVER_PROBE, boxes[b])) });
      }
      i++;
      await page.waitForTimeout(40);
    }
  }
  const res = await page.evaluate(COLLECT);
  const m1 = await readMetrics(cdp);
  return finish("hover", armed, res, m0, m1, crossings, hoverProbes);
}

function finish(kind, armed, res, m0, m1, crossings, hoverProbes) {
  // How far the wall-clock ↔ page-clock mapping drifted across the window.
  const startErr = armed.wall - armed.timeOrigin - armed.pageNow;
  const endErr = res.endWall - res.timeOrigin - res.endPageNow;
  const longTasks = res.longTaskDetail.map((t) => {
    const end = t.startTime + t.duration;
    let nearest = null;
    let before = null; // last crossing strictly before the task started
    let after = null; // first crossing strictly after the task ended
    let inside = 0; // crossings whose instant fell within the task's span
    for (const c of crossings) {
      if (c.pageMs < t.startTime) {
        const gap = t.startTime - c.pageMs;
        if (before === null || gap < before.gapMs)
          before = { crossing: c.i, rowIndex: c.rowIndex, gapMs: Math.round(gap * 100) / 100 };
      } else if (c.pageMs > end) {
        const gap = c.pageMs - end;
        if (after === null || gap < after.gapMs)
          after = { crossing: c.i, rowIndex: c.rowIndex, gapMs: Math.round(gap * 100) / 100 };
      } else {
        inside++;
      }
      const gap = c.pageMs < t.startTime ? t.startTime - c.pageMs : c.pageMs > end ? c.pageMs - end : 0;
      if (nearest === null || gap < nearest.gapMs)
        nearest = {
          crossing: c.i,
          rowIndex: c.rowIndex,
          gapMs: Math.round(gap * 100) / 100,
          position: gap === 0 ? "inside" : c.pageMs < t.startTime ? "before" : "after",
        };
    }
    return {
      ...t,
      nearestCrossing: nearest,
      crossingsInsideTask: crossings.length ? inside : null,
      lastCrossingBefore: before,
      firstCrossingAfter: after,
      // NOTE, and it matters: a crossing time is stamped when `page.mouse.move`
      // RESOLVES. If the main thread is blocked, the CDP round-trip resolves only
      // after the block clears, so `crossingsInsideTask` is biased toward 0 by
      // construction. It is reported for completeness; the load-bearing evidence
      // for "not hover" is the idle floor and `longTaskCadence`, not this field.
      insideACrossing: crossings.length ? inside > 0 : null,
    };
  });
  return {
    kind,
    mutations: res.mutations,
    longTasks: res.longTasks,
    maxLongTaskMs: res.maxLongTaskMs,
    longTaskDetail: longTasks,
    longtaskSupported: res.longtaskSupported,
    windowMs: res.windowMs,
    crossings: crossings.length,
    crossingTimesMs: crossings.map((c) => c.pageMs),
    hoverProbes,
    hoverProbesAllPassed: hoverProbes.length ? hoverProbes.every((p) => p.pass) : null,
    cdpAggregate: {
      note: "Chrome renderer-wide cumulative counters (Performance.getMetrics), NOT a trace attribution to hover handling. Includes the app's own polls, React, GC and browser work.",
      before: m0,
      after: m1,
      ...metricsDelta(m0, m1),
    },
    clockCheck: {
      note: "crossing page-times = Date.now() - performance.timeOrigin; this is the residual error of that mapping at both ends of the window, ms",
      startErrMs: Math.round(startErr * 100) / 100,
      endErrMs: Math.round(endErr * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------- surfaces

async function measureSurface(page, cdp, name, getBoxes, report) {
  const pairs = [];
  for (let p = 0; p < PAIRS; p++) {
    // Boxes are re-read per pair, OUTSIDE the measured windows. The team panel
    // is live: a worker finishing mid-run reflows the list, and a box captured
    // once at surface start would slowly stop landing on a row — which is the
    // exact failure the hover probes exist to catch.
    const boxes = await getBoxes();
    if (!boxes.length) throw new Error(`${name}: zero rows targeted — the sweep would measure nothing`);
    if (p === 0) console.log(`${name}: ${boxes.length} rows targeted`);

    const osBefore = osSample();
    await page.mouse.move(900, 500); // park: over the transcript, on no row — same spot round 904 used
    await page.waitForTimeout(500);
    const idle = await idleWindow(page, cdp, WINDOW_MS);
    const hover = await hoverWindow(page, cdp, boxes, WINDOW_MS, [5, 40, 90]);
    await page.mouse.move(900, 500);
    const osAfter = osSample();
    const pair = {
      pair: p + 1,
      rows: boxes.length,
      osBefore,
      osAfter,
      idle,
      hover,
      attributable: {
        mutations: hover.mutations - idle.mutations,
        longTasks: hover.longTasks - idle.longTasks,
        ScriptDurationMs:
          hover.cdpAggregate.ScriptDurationMs === null || idle.cdpAggregate.ScriptDurationMs === null
            ? null
            : Math.round((hover.cdpAggregate.ScriptDurationMs - idle.cdpAggregate.ScriptDurationMs) * 100) / 100,
      },
    };
    pairs.push(pair);
    console.log(
      `  ${name} pair ${p + 1}/${PAIRS}: idle lt=${idle.longTasks} (max ${idle.maxLongTaskMs}ms, script ${idle.cdpAggregate.ScriptDurationMs}ms) | ` +
        `hover lt=${hover.longTasks} (max ${hover.maxLongTaskMs}ms, script ${hover.cdpAggregate.ScriptDurationMs}ms, ${hover.crossings} crossings) | ` +
        `attributable lt=${pair.attributable.longTasks} | hoverProbes ${hover.hoverProbes.filter((x) => x.pass).length}/${hover.hoverProbes.length} | load ${osBefore.loadavg[0]}`,
    );
  }

  const attributable = pairs.map((p) => p.attributable.longTasks).sort((a, b) => a - b);
  const median = attributable[Math.floor(attributable.length / 2)];
  const idleLt = pairs.map((p) => p.idle.longTasks);
  const hoverLt = pairs.map((p) => p.hover.longTasks);
  const hoverScript = pairs.map((p) => p.hover.cdpAggregate.ScriptDurationMs).filter((v) => v !== null);
  const idleScript = pairs.map((p) => p.idle.cdpAggregate.ScriptDurationMs).filter((v) => v !== null);
  const spreadOf = (xs) => {
    const pos = xs.filter((x) => x > 0);
    if (pos.length < 2) return { ratio: null, note: "fewer than two non-zero samples — a ratio would be meaningless" };
    const r = Math.max(...pos) / Math.min(...pos);
    return { ratio: Math.round(r * 100) / 100, exceeds2x: r > 2 };
  };

  report.surfaces[name] = {
    rows: pairs[0].rows,
    rowsPerPair: pairs.map((p) => p.rows),
    pairs,
    summary: {
      medianAttributableLongTasks: median,
      attributableLongTasksPerPair: pairs.map((p) => p.attributable.longTasks),
      idleLongTasksPerPair: idleLt,
      hoverLongTasksPerPair: hoverLt,
      idleLongTaskFloorTotal: idleLt.reduce((a, b) => a + b, 0),
      hoverLongTaskTotal: hoverLt.reduce((a, b) => a + b, 0),
      mutationsAttributablePerPair: pairs.map((p) => p.attributable.mutations),
      crossingsPerPair: pairs.map((p) => p.hover.crossings),
      hoverProbePerPair: pairs.map((p) => ({
        pair: p.pair,
        probes: p.hover.hoverProbes.length,
        passed: p.hover.hoverProbes.filter((x) => x.pass).length,
        teamRowsHovered: p.hover.hoverProbes.filter((x) => x.teamRowHovered).length,
      })),
      hoverProbeTotal: pairs.reduce((a, p) => a + p.hover.hoverProbes.length, 0),
      hoverProbePassedTotal: pairs.reduce((a, p) => a + p.hover.hoverProbes.filter((x) => x.pass).length, 0),
      hoverProbeAllPassed: pairs.every((p) => p.hover.hoverProbesAllPassed === true),
      cdpScriptMs: {
        note: "renderer-wide aggregate; see cdpAggregate.note",
        idlePerPair: idleScript,
        hoverPerPair: hoverScript,
        idleMedian: median1(idleScript),
        hoverMedian: median1(hoverScript),
      },
      spread: {
        hoverScriptMs: spreadOf(hoverScript),
        idleScriptMs: spreadOf(idleScript),
        hoverLongTasks: spreadOf(hoverLt),
      },
    },
  };
}

function median1(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Are the long tasks periodic? The page is loaded once and never reloaded, so
 * every `startTime` in the whole session is on ONE monotonic `performance.now()`
 * clock — across both surfaces and across idle and hover windows alike. If the
 * long tasks are a background timer, their start times will sit on a lattice: a
 * base period P, with every gap an integer multiple of P. If they were caused by
 * hovering, they would cluster in the hover windows and have no such structure.
 *
 * The base period is taken as the smallest observed consecutive gap; each gap is
 * then reported as gap/P with its residual, so a reader can reject the fit
 * instead of taking the word "periodic".
 */
function cadence(all) {
  const s = [...all].sort((a, b) => a.startTime - b.startTime);
  if (s.length < 3) return { fits: null, note: "fewer than 3 long tasks in the session — no cadence to fit" };
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push(Math.round((s[i].startTime - s[i - 1].startTime) * 10) / 10);
  const basePeriodMs = Math.min(...gaps);
  const fit = gaps.map((g) => {
    const k = Math.round(g / basePeriodMs);
    return { gapMs: g, multiple: k, residualMs: Math.round((g - k * basePeriodMs) * 10) / 10 };
  });
  const worst = Math.max(...fit.map((f) => Math.abs(f.residualMs)));
  return {
    events: s.length,
    basePeriodMs,
    gapsMs: gaps,
    fit,
    worstResidualMs: worst,
    worstResidualPctOfPeriod: Math.round((worst / basePeriodMs) * 1000) / 10,
    fits: worst <= basePeriodMs * 0.05,
    note:
      "fits=true means every inter-task gap is an integer multiple of the base period to within 5% — i.e. the >50ms long tasks are one periodic background timer, " +
      "present with the pointer parked and with the pointer sweeping, and therefore not attributable to hover handling.",
    perEvent: s.map((t) => ({
      surface: t.surface,
      pair: t.pair,
      window: t.window,
      startTime: t.startTime,
      duration: t.duration,
      name: t.name,
    })),
  };
}

function collectAllLongTasks(report) {
  const all = [];
  for (const [surface, sv] of Object.entries(report.surfaces)) {
    for (const p of sv.pairs) {
      for (const w of ["idle", "hover"]) {
        for (const t of p[w].longTaskDetail) all.push({ surface, pair: p.pair, window: w, ...t });
      }
    }
  }
  return all;
}

/**
 * Write into the shared `hover-1291.json`, one entry per labelled run. Round 1291
 * is allowed exactly three files, so both mandated repetitions of the 5-pair
 * sweep live in one document rather than one file each — the same shape
 * `phase900/hover-904.json` used for its two runs.
 */
function writeMerged(outPath, label, report) {
  let doc = { schema: "hover-1291/v1", runs: {} };
  if (fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (prev && typeof prev === "object" && prev.runs) doc = prev;
  }
  doc.runs[label] = report;
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return Object.keys(doc.runs);
}

// ---------------------------------------------------------------- control

/**
 * `HOVER_CONTROL=1` — the mechanism check, not a sweep. The five-pair result
 * already says the >50ms long tasks are not attributable to hover; this says
 * what they ARE, so phase 1300 gets a named cause instead of "ambient".
 *
 * Two windows, pointer never moved:
 *   blank — about:blank for `ms`. If the cadence is a property of this VPS or of
 *           chromium, it shows up here too. If this window is empty, whatever is
 *           producing the long tasks is the page.
 *   app   — the manager chat, parked pointer, for 3× `ms`, recording BOTH the
 *           long tasks and every team-poll resource-timing entry (any request
 *           whose URL path ends in `/team`).
 *           Each long task is then aligned to the nearest poll response, which
 *           turns a correlation ("~6.29s apart") into an attribution ("it lands
 *           when the 6s team poll lands").
 */
const ARM_RESOURCES = () => {
  window.__r = [];
  window.__ro = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (!/\/team(\?|$)/.test(e.name)) continue;
      window.__r.push({
        name: e.name.slice(-80),
        startTime: Math.round(e.startTime * 100) / 100,
        responseEnd: Math.round(e.responseEnd * 100) / 100,
        durationMs: Math.round(e.duration * 100) / 100,
        transferSize: e.transferSize,
        decodedBodySize: e.decodedBodySize,
      });
    }
  });
  window.__ro.observe({ entryTypes: ["resource"] });
};
const COLLECT_RESOURCES = () => {
  window.__ro.disconnect();
  return window.__r;
};

async function runControl(page, cdp, report, ms) {
  // (1) about:blank — is the cadence the machine, or the page?
  await page.goto("about:blank", { waitUntil: "load" });
  await page.waitForTimeout(1_000);
  const blank = await idleWindow(page, cdp, ms);

  // (2) the app, pointer parked, with the team poll's resource timing captured
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(6_000);
  await page.mouse.move(900, 500);
  await page.evaluate(ARM_RESOURCES);
  const app = await idleWindow(page, cdp, ms * 3);
  const polls = await page.evaluate(COLLECT_RESOURCES);

  const aligned = app.longTaskDetail.map((t) => {
    let nearest = null;
    for (const p of polls) {
      const gap = Math.round((t.startTime - p.responseEnd) * 100) / 100;
      if (nearest === null || Math.abs(gap) < Math.abs(nearest.gapFromResponseEndMs))
        nearest = {
          poll: p.name,
          pollResponseEnd: p.responseEnd,
          pollDurationMs: p.durationMs,
          decodedBodySize: p.decodedBodySize,
          gapFromResponseEndMs: gap,
        };
    }
    return { startTime: t.startTime, duration: t.duration, name: t.name, nearestTeamPoll: nearest };
  });

  const gaps = aligned.map((a) => a.nearestTeamPoll?.gapFromResponseEndMs).filter((g) => typeof g === "number");
  report.control = {
    note:
      "pointer never moved in either window. `blank` isolates the machine from the page; `app` aligns each long task to the /team poll response that preceded it.",
    windowMs: ms,
    blank: {
      url: "about:blank",
      windowMs: blank.windowMs,
      longTasks: blank.longTasks,
      maxLongTaskMs: blank.maxLongTaskMs,
      longTaskDetail: blank.longTaskDetail,
      cdpAggregate: blank.cdpAggregate,
    },
    app: {
      url: `${BASE}/desktop → ${CHAT_TEXT}`,
      windowMs: app.windowMs,
      longTasks: app.longTasks,
      maxLongTaskMs: app.maxLongTaskMs,
      cdpAggregate: app.cdpAggregate,
      teamPolls: polls,
      teamPollIntervalsMs: polls.slice(1).map((p, i) => Math.round((p.responseEnd - polls[i].responseEnd) * 10) / 10),
      longTasksAlignedToPolls: aligned,
      gapFromPollResponseEndMs: {
        note: "long task startTime minus the responseEnd of the nearest /team poll, ms. A small positive number means the long task is the work that follows the poll landing.",
        values: gaps,
        median: median1(gaps),
        allWithin250ms: gaps.length ? gaps.every((g) => g >= -20 && g <= 250) : null,
      },
    },
  };
  console.log(
    `control: blank ${blank.longTasks} long tasks in ${blank.windowMs}ms | app ${app.longTasks} long tasks in ${app.windowMs}ms ` +
      `across ${polls.length} team polls (intervals ${JSON.stringify(report.control.app.teamPollIntervalsMs)})`,
  );
  console.log(`control: gaps from poll responseEnd = ${JSON.stringify(gaps)} (median ${median1(gaps)}ms)`);
}

// ------------------------------------------------------------------- main

(async () => {
  const report = {
    script: "docs/plan/artifacts/phase1290/hover/hover-1291.cjs",
    round: 1291,
    runLabel: RUN_LABEL,
    base: BASE,
    note:
      "five interleaved idle/hover pairs per surface against a WORKTREE build on :7790 talking to the :7798 API harness — not production. " +
      "Every long task is emitted with its TaskAttributionTiming and its gap to the nearest pointer crossing.",
    config: { pairs: PAIRS, windowMs: WINDOW_MS, viewport: { width: 1600, height: 1000 }, crossingDwellMs: 40 },
    env: {
      startedAt: new Date().toISOString(),
      buildShaUnderTest: (process.env.HOVER_BUILD_SHA ?? "").trim() || null,
      shaNote: "git rev-parse HEAD of the worktree that was rsynced and built; not a hash of the build output",
      uptimeLine: (process.env.HOVER_UPTIME ?? "").trim() || null,
      osStart: osSample(),
    },
    surfaces: {},
    errors: [],
  };

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const url = new URL(BASE);
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  if (CONTROL) {
    await runControl(page, cdp, report, WINDOW_MS);
    report.env.osEnd = osSample();
    report.env.finishedAt = new Date().toISOString();
    report.longTaskCadence = { fits: null, note: "control run — no sweep, no surfaces; see report.control" };
    const ls = writeMerged(path.join(OUT, "hover-1291.json"), RUN_LABEL, report);
    console.log(`\nerrors: ${report.errors.length}`);
    console.log(
      `wrote ${RUN_LABEL} → ${path.join(OUT, "hover-1291.json")} (runs now: ${ls.join(", ")})`,
    );
    await browser.close();
    return;
  }

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);

  // ---- surface 1: the chat rail (Konrad's "sidebar") ---------------------
  await measureSurface(
    page,
    cdp,
    "rail",
    () =>
      page.evaluate(() => {
        // same selector family phase 900 used
        const rows = [...document.querySelectorAll("div")].filter((el) => {
          const t = el.textContent || "";
          const r = el.getBoundingClientRect();
          return /completed|running|queued|stuck/.test(t) && r.height > 40 && r.height < 140 && r.left < 500;
        });
        return rows.slice(0, 24).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
      }),
    report,
  );

  // ---- surface 2: the team panel of the manager chat ---------------------
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(6_000);
  report.teamRunId = TEAM_RUN_ID;
  await measureSurface(
    page,
    cdp,
    "team",
    () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-team-row]")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 8;
        });
        return rows.slice(0, 26).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
      }),
    report,
  );

  // No screenshot is written: round 1291 is allowed exactly three files, and the
  // ":hover" DOM assertion inside every hover window is the stronger of the two
  // anti-lying checks 03-quality §5 offers anyway — it proves the pointer was on
  // a row at the moment it claims to be, which a PNG only suggests.
  report.env.osEnd = osSample();
  report.env.finishedAt = new Date().toISOString();
  report.longTaskCadence = cadence(collectAllLongTasks(report));

  const labels = writeMerged(path.join(OUT, "hover-1291.json"), RUN_LABEL, report);

  console.log(`\nerrors: ${report.errors.length}`);
  for (const s of Object.keys(report.surfaces)) {
    const sum = report.surfaces[s].summary;
    console.log(
      `${s}: median attributable long tasks >50ms over ${PAIRS} pairs = ${sum.medianAttributableLongTasks} ` +
        `(per pair ${JSON.stringify(sum.attributableLongTasksPerPair)}; idle floor ${JSON.stringify(sum.idleLongTasksPerPair)}; hover ${JSON.stringify(sum.hoverLongTasksPerPair)})`,
    );
  }
  const c = report.longTaskCadence;
  console.log(
    `cadence: ${c.events} long tasks in the session, base period ${c.basePeriodMs}ms, ` +
      `worst residual ${c.worstResidualMs}ms (${c.worstResidualPctOfPeriod}% of period), fits=${c.fits}`,
  );
  console.log(
    `wrote ${RUN_LABEL} → ${path.join(OUT, "hover-1291.json")} (runs now: ${labels.join(", ")})`,
  );
  await browser.close();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
