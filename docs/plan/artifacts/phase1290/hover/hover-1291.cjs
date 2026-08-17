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
 * ROUND 1305 — THE ANTI-LYING CHECK DID NOT CHECK WHAT IT CLAIMED (red-team F1).
 * Until this round `pass` was `sameNode && deepest is not BODY/HTML`, and the
 * row membership it computed one line above (`teamRowHovered`) was reported but
 * NOT required. A coordinate landing on a plan-Kanban card, a panel header, or
 * a post-reflow gap therefore passed, and `hoverProbesAllPassed: true` in
 * `hover-1291.json` says nothing about rows: on the team surface, crossing 40
 * carried `teamRow=false pass=true` in 10 of 10 pairs. Two changes close it:
 *
 *   (a) `pass` now REQUIRES the hovered element to resolve to a row of the
 *       surface under measurement — `[data-team-row]` on the team panel,
 *       `.chat-row` on the rail — passed in per surface as `rowSelector`.
 *       A failing probe is fatal: the run writes its JSON, prints SWEEP INVALID
 *       and exits 1, because a sweep that cannot prove it hovered rows must not
 *       be quotable as a hover measurement (`HOVER_ALLOW_PROBE_FAILURE=1`
 *       downgrades it to a recorded warning, for diagnosing a miss).
 *
 *   (b) the team surface targets rows CLIPPED TO THEIR SCROLL CONTAINER
 *       (`[data-team-scroll]`), not merely to the viewport. That was the actual
 *       cause of the misses: a row scrolled out of the panel's own overflow box
 *       still has a viewport-visible rect, so its centre coordinate lands on
 *       whatever paints there — the plan Kanban below the panel.
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
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
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
/** Deliberately aim the sweep off the rows, to demonstrate the row assertion
 *  failing a run. 0 = off, which is every real measurement. */
const SABOTAGE_PX = ((raw) => {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n === 0) {
    throw new Error(`HOVER_SABOTAGE_BOXES must be a non-zero integer of pixels; got ${JSON.stringify(raw)}`);
  }
  return n;
})(process.env.HOVER_SABOTAGE_BOXES);

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

/**
 * The guards run when the script RUNS, not when it is required (round 1305).
 * `probe-gate-1305.cjs` requires this file to test `HOVER_PROBE` and
 * `CLIPPED_BOXES` against a synthetic page — the gate that proves the row
 * assertion actually rejects a non-row. Importing must therefore neither throw
 * for a missing cookie nor create directories; running still does both, first.
 */
function preflight() {
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
 * rows"), and until round 1305 the answer was: this probe could not tell. It
 * asserted only that the element at the target coordinates was the element the
 * browser reports as `:hover` and that it was not BODY/HTML — true of a Kanban
 * card, a header, or a gap. Row membership was computed and then not required.
 *
 * Now `pass` requires all three, and the row is the ROW OF THE SURFACE BEING
 * SWEPT: `arg.rowSelector` — `[data-team-row]` for the team panel, `.chat-row`
 * for the rail. Both directions are checked, because they fail differently:
 *   - `rowHovered`     — the hovered chain resolves into a row (the browser
 *                        agrees the pointer is on one);
 *   - `atPointInRow`   — the element painted at the coordinate is in a row
 *                        (the coordinate itself is still on the list, i.e. no
 *                        reflow has moved the list out from under the sweep).
 * `teamRowHovered` is kept, computed exactly as before against
 * `[data-team-row]`, so numbers in the old `hover-1291.json` stay readable.
 */
const HOVER_PROBE = (arg) => {
  const { target, rowSelector } = arg;
  const hot = [...document.querySelectorAll(":hover")];
  const deepest = hot.length ? hot[hot.length - 1] : null;
  const atPoint = document.elementFromPoint(target.x, target.y);
  const sameNode = Boolean(
    deepest && atPoint && (atPoint === deepest || atPoint.contains(deepest) || deepest.contains(atPoint)),
  );
  const row = deepest ? deepest.closest(rowSelector) : null;
  const atPointRow = atPoint ? atPoint.closest(rowSelector) : null;
  const teamRow = deepest ? deepest.closest("[data-team-row]") : null;
  return {
    target,
    rowSelector,
    hoverChainLength: hot.length,
    deepestTag: deepest ? deepest.tagName : null,
    deepestClass: deepest ? String(deepest.className).slice(0, 80) : null,
    elementAtTargetIsTheHoveredOne: sameNode,
    rowHovered: Boolean(row),
    atPointInRow: Boolean(atPointRow),
    // kept for continuity with the pre-1305 artifacts; on the rail it is
    // expected to be false and is not what `pass` reads.
    teamRowHovered: Boolean(teamRow),
    hoveredRowText: ((row ?? deepest)?.textContent ?? "").slice(0, 60) || null,
    // what the pointer ACTUALLY landed on when it missed — the diagnostic that
    // was absent when this probe passed a plan-Kanban card as a hovered row.
    missedOnto: row ? null : ((atPoint ?? deepest)?.textContent ?? "").slice(0, 60) || null,
    pass: Boolean(
      sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML" && row && atPointRow,
    ),
  };
};

/**
 * WHERE THE SWEEP MAY AIM (round 1305) — and why the viewport was the wrong test.
 *
 * Round 1291 picked `[data-team-row]` elements whose rect lay inside the VIEWPORT.
 * The team list lives in its own overflow box (`[data-team-scroll]`), so a row
 * scrolled past the bottom of that box still has a viewport-visible rect and was
 * still targeted — and its centre coordinate paints the plan Kanban that sits
 * below the panel. That is red-team F1's "hovered a Kanban card, called it a row".
 *
 * This picks boxes the way the browser will read them back:
 *   1. intersect the row rect with EVERY scrolling/clipping ancestor's client
 *      rect and with the viewport, so the box is the visible part of the row;
 *   2. take the centre of that intersection;
 *   3. ask `elementFromPoint` what actually paints there and keep the box only
 *      if the answer resolves to a row of this surface.
 * Step 3 is the same question `HOVER_PROBE` asks during the sweep, asked once
 * OUTSIDE the measured window, so a box can no longer be born wrong. A box that
 * goes wrong LATER — the list reflowing mid-window — still has to be caught by
 * the in-window probe, which is now allowed to fail the run.
 */
const CLIPPED_BOXES = (arg) => {
  const { rowSelector, limit } = arg;
  const isClipper = (el) => {
    const s = getComputedStyle(el);
    return /auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`);
  };
  const out = [];
  const rejected = [];
  for (const el of document.querySelectorAll(rowSelector)) {
    const r = el.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, window.innerHeight);
    let left = Math.max(r.left, 0);
    let right = Math.min(r.right, window.innerWidth);
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (!isClipper(a)) continue;
      const c = a.getBoundingClientRect();
      top = Math.max(top, c.top);
      bottom = Math.min(bottom, c.bottom);
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
    }
    if (bottom - top < 8 || right - left < 8) {
      rejected.push({ reason: "clipped away", rect: [r.left, r.top, r.right, r.bottom] });
      continue;
    }
    const x = Math.round(left + (right - left) / 2);
    const y = Math.round(top + (bottom - top) / 2);
    const at = document.elementFromPoint(x, y);
    if (!at || !at.closest(rowSelector)) {
      rejected.push({ reason: "another element paints at the centre", x, y, at: at ? at.tagName : null });
      continue;
    }
    out.push({ x, y });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error(`no targetable ${rowSelector} rows: ${JSON.stringify(rejected.slice(0, 5))}`);
  return out;
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

// ------------------------------------------------------------- provenance

/**
 * "DID THEY MEASURE WHAT THEY SHIPPED?" (round 1305, red-team F3.)
 *
 * `buildShaUnderTest` alone cannot answer that, and its own `shaNote` said so:
 * it is `git rev-parse HEAD` of the worktree that was rsynced, and a worktree
 * with uncommitted work — the normal case while building — names a commit that
 * was never what got built. `lattice-1302.json` recorded `b3bd80f` for a build
 * of the fix that landed as `92aeb0f`; nothing there was disproven, but the
 * field could not carry the weight the artifacts leaned on it for.
 *
 * So the run records, itself, without trusting the caller's environment:
 *   - `head` / `headSubject` / `dirty` / `statusPorcelain` — the tree state at
 *     run time, so a dirty tree is visible instead of implied;
 *   - `sourceTreeSha256` of the directory that was actually built
 *     (`HOVER_BUILD_DIR`), over its real source bytes — the hash that answers
 *     the question a commit id cannot.
 * Failures are recorded as `{ ok: false, error }`, never as a null that reads
 * like "nothing to report".
 */
function gitProvenance(repoRoot) {
  const git = (args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  try {
    const status = git(["status", "--porcelain"]).replace(/\n$/, "");
    const lines = status === "" ? [] : status.split("\n");
    return {
      ok: true,
      repoRoot,
      head: git(["rev-parse", "HEAD"]).trim(),
      headSubject: git(["log", "-1", "--pretty=%s"]).trim(),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      dirty: lines.length > 0,
      dirtyFileCount: lines.length,
      statusPorcelain: lines,
      note:
        "tree state of the WORKTREE at run time. `dirty: true` means the recorded HEAD does not " +
        "describe what was built — read sourceTree instead.",
    };
  } catch (e) {
    return { ok: false, repoRoot, error: String(e).slice(0, 300) };
  }
}

/** sha256 over the source bytes of a built copy: sorted `relpath\0sha256` lines. */
function sourceTreeHash(dir) {
  const SKIP = new Set(["node_modules", ".next", ".git", ".turbo", "coverage"]);
  const files = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP.has(ent.name)) continue;
      const abs = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue; // node_modules is symlinked in; its bytes are not this tree's
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) files.push([r, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")]);
    }
  };
  walk(dir, "");
  const h = crypto.createHash("sha256");
  let bytes = 0;
  for (const [r, sha] of files) {
    h.update(`${r}\0${sha}\n`);
    bytes += fs.statSync(path.join(dir, r)).size;
  }
  return { ok: true, dir, sha256: h.digest("hex"), fileCount: files.length, byteCount: bytes };
}

function buildTreeProvenance() {
  const dir = (process.env.HOVER_BUILD_DIR ?? "").trim();
  if (!dir) {
    return {
      ok: false,
      hashed: false,
      reason:
        "HOVER_BUILD_DIR not set — the copy that was rsynced and built is unidentified, so this run " +
        "cannot prove which source bytes it measured. Set it to the built copy (e.g. /tmp/phase1305-web).",
    };
  }
  try {
    if (!fs.existsSync(dir)) throw new Error(`HOVER_BUILD_DIR does not exist: ${dir}`);
    // `.next` itself is deliberately NOT hashed — it is build output, and its ids
    // and timestamps differ between two builds of identical source, which would
    // make the hash useless for comparing runs. `BUILD_ID` is recorded instead:
    // it names the compiled bundle actually being served, which the source hash
    // cannot (an edited-but-not-rebuilt copy changes the hash and not the build).
    const idFile = path.join(dir, ".next", "BUILD_ID");
    const buildId = fs.existsSync(idFile) ? fs.readFileSync(idFile, "utf8").trim() : null;
    return { hashed: true, buildId, ...sourceTreeHash(dir) };
  } catch (e) {
    return { ok: false, hashed: false, dir, error: String(e).slice(0, 300) };
  }
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
async function hoverWindow(page, cdp, boxes, ms, probeAtCrossings, rowSelector) {
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
        hoverProbes.push({
          atCrossing: i,
          rowIndex: b,
          ...(await page.evaluate(HOVER_PROBE, { target: boxes[b], rowSelector })),
        });
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

/**
 * `PROBE_CROSSINGS` — where inside a hover window the row assertion fires.
 * Round 1291 probed three crossings (5, 40, 90) out of ~150. Round 1305 adds
 * the first and the last, because the two failure modes found by the red team
 * live at the ends: a mis-picked box shows at crossing 0, and a reflow that
 * walks the list out from under the sweep shows late. Five short `evaluate`
 * calls per 10 s hover window; the idle windows pay none, which is what bounds
 * their cost in the attributable difference.
 */
const PROBE_CROSSINGS = [0, 5, 40, 90, 140];

async function measureSurface(page, cdp, name, getBoxes, report, rowSelector) {
  if (!rowSelector) throw new Error(`${name}: no rowSelector — the sweep could not prove it hovered rows`);
  const pairs = [];
  for (let p = 0; p < PAIRS; p++) {
    // Boxes are re-read per pair, OUTSIDE the measured windows. The team panel
    // is live: a worker finishing mid-run reflows the list, and a box captured
    // once at surface start would slowly stop landing on a row — which is the
    // exact failure the hover probes exist to catch.
    const picked = await getBoxes();
    if (!picked.length) throw new Error(`${name}: zero rows targeted — the sweep would measure nothing`);
    // SABOTAGE (round 1305, opt-in). Shifts every target off the list on
    // purpose, so a reviewer can watch the row assertion fail and the run exit
    // 1 instead of taking the gate's word that it would. Never set in a real
    // measurement; recorded in the JSON when it is.
    const boxes = SABOTAGE_PX === 0 ? picked : picked.map((b) => ({ x: b.x, y: b.y + SABOTAGE_PX }));
    if (p === 0) console.log(`${name}: ${boxes.length} rows targeted`);

    const osBefore = osSample();
    await page.mouse.move(900, 500); // park: over the transcript, on no row — same spot round 904 used
    await page.waitForTimeout(500);
    const idle = await idleWindow(page, cdp, WINDOW_MS);
    const hover = await hoverWindow(page, cdp, boxes, WINDOW_MS, PROBE_CROSSINGS, rowSelector);
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
        `attributable lt=${pair.attributable.longTasks} | hoverProbes ${hover.hoverProbes.filter((x) => x.pass).length}/${hover.hoverProbes.length} ` +
        `on ${rowSelector} | load ${osBefore.loadavg[0]}`,
    );
    for (const miss of hover.hoverProbes.filter((x) => !x.pass)) {
      console.log(
        `    MISS ${name} pair ${p + 1} crossing ${miss.atCrossing} box ${miss.rowIndex} @(${miss.target.x},${miss.target.y}): ` +
          `rowHovered=${miss.rowHovered} atPointInRow=${miss.atPointInRow} sameNode=${miss.elementAtTargetIsTheHoveredOne} ` +
          `deepest=<${miss.deepestTag} class="${miss.deepestClass}"> onto=${JSON.stringify(miss.missedOnto)}`,
      );
    }
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
      rowSelector,
      hoverProbePerPair: pairs.map((p) => ({
        pair: p.pair,
        probes: p.hover.hoverProbes.length,
        passed: p.hover.hoverProbes.filter((x) => x.pass).length,
        rowsHovered: p.hover.hoverProbes.filter((x) => x.rowHovered).length,
        teamRowsHovered: p.hover.hoverProbes.filter((x) => x.teamRowHovered).length,
      })),
      hoverProbeTotal: pairs.reduce((a, p) => a + p.hover.hoverProbes.length, 0),
      hoverProbePassedTotal: pairs.reduce((a, p) => a + p.hover.hoverProbes.filter((x) => x.pass).length, 0),
      // Round 1305: `pass` now REQUIRES row membership, so this is the claim it
      // was always read as — "every probe was on a row of this surface".
      // `rowHoveredTotal` is quoted beside it so the two can never drift again.
      hoverProbeAllPassed: pairs.every((p) => p.hover.hoverProbesAllPassed === true),
      rowHoveredTotal: pairs.reduce((a, p) => a + p.hover.hoverProbes.filter((x) => x.rowHovered).length, 0),
      probeMisses: pairs.flatMap((p) =>
        p.hover.hoverProbes
          .filter((x) => !x.pass)
          .map((x) => ({
            pair: p.pair,
            atCrossing: x.atCrossing,
            rowIndex: x.rowIndex,
            target: x.target,
            rowHovered: x.rowHovered,
            atPointInRow: x.atPointInRow,
            elementAtTargetIsTheHoveredOne: x.elementAtTargetIsTheHoveredOne,
            deepestTag: x.deepestTag,
            deepestClass: x.deepestClass,
            missedOnto: x.missedOnto,
          })),
      ),
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

/** Required by `probe-1305.cjs`; running the file still runs the sweep, below. */
module.exports = { HOVER_PROBE, CLIPPED_BOXES, PROBE_CROSSINGS, sourceTreeHash, gitProvenance };

if (require.main !== module) return;

preflight();

(async () => {
  const report = {
    script: "docs/plan/artifacts/phase1290/hover/hover-1291.cjs",
    round: 1291,
    runLabel: RUN_LABEL,
    base: BASE,
    note:
      `five interleaved idle/hover pairs per surface against a WORKTREE build served at ${BASE}, talking to whichever ` +
      "API harness that build was compiled against — never production. " +
      "Every long task is emitted with its TaskAttributionTiming and its gap to the nearest pointer crossing.",
    config: {
      pairs: PAIRS,
      windowMs: WINDOW_MS,
      viewport: { width: 1600, height: 1000 },
      crossingDwellMs: 40,
      probeCrossings: PROBE_CROSSINGS,
      sabotageBoxesPx: SABOTAGE_PX,
    },
    env: {
      startedAt: new Date().toISOString(),
      buildShaUnderTest: (process.env.HOVER_BUILD_SHA ?? "").trim() || null,
      shaNote:
        "HOVER_BUILD_SHA as PASSED IN — git rev-parse HEAD of the worktree that was rsynced and built; " +
        "not a hash of the build output, and blind to uncommitted work. Round 1305: do not read it alone. " +
        "`gitProvenance` (measured here, not passed in) says whether the tree was dirty, and " +
        "`sourceTree` hashes the bytes that were actually built.",
      gitProvenance: gitProvenance(REPO_ROOT),
      sourceTree: buildTreeProvenance(),
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
    report.sweepValid = null;
    report.sweepValidity = { note: "control run — the pointer never moved, so there is no sweep to validate" };
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
  //
  // ROUND 1305. The rail rows are `.chat-row` — the class `globals.css` hangs the
  // CSS-only ✕/age swap on, i.e. the app's own name for a rail row, not a name
  // invented by this script. Round 1291 matched them by text and geometry
  // (`/completed|running|queued|stuck/`, 40–140 px tall, left of 500), which also
  // matches any container that happens to WRAP the rows: the outer list, the pane,
  // ultimately `<body>`. Selecting on the class and then clipping to the scroller
  // gives the same rows without that hazard, and gives the probe a row selector
  // that means something.
  await measureSurface(
    page,
    cdp,
    "rail",
    () => page.evaluate(CLIPPED_BOXES, { rowSelector: ".chat-row", limit: 24 }),
    report,
    ".chat-row",
  );

  // ---- surface 2: the team panel of the manager chat ---------------------
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(6_000);
  report.teamRunId = TEAM_RUN_ID;
  await measureSurface(
    page,
    cdp,
    "team",
    () => page.evaluate(CLIPPED_BOXES, { rowSelector: "[data-team-row]", limit: 26 }),
    report,
    "[data-team-row]",
  );

  // No screenshot is written: round 1291 is allowed exactly three files, and the
  // ":hover" DOM assertion inside every hover window is the stronger of the two
  // anti-lying checks 03-quality §5 offers anyway — it proves the pointer was on
  // a row at the moment it claims to be, which a PNG only suggests.
  report.env.osEnd = osSample();
  report.env.finishedAt = new Date().toISOString();
  report.longTaskCadence = cadence(collectAllLongTasks(report));

  /**
   * THE SWEEP CERTIFIES ITSELF, OR IT DOES NOT CERTIFY (round 1305).
   * Every probe of every hover window must have landed on a row of the surface
   * it was sweeping. If one did not, the numbers above describe a pointer that
   * was somewhere else for part of the window, and they are not a hover
   * measurement — the process says so and exits 1, so a caller piping this into
   * an artifact cannot quietly inherit a lie. `HOVER_ALLOW_PROBE_FAILURE=1`
   * keeps the exit code at 0 for diagnosing a miss; the JSON records that the
   * override was used either way.
   */
  const invalid = Object.entries(report.surfaces).filter(([, v]) => v.summary.hoverProbeAllPassed !== true);
  report.sweepValid = invalid.length === 0;
  report.sweepValidity = {
    note:
      "true only if EVERY hover probe landed on a row of the surface being swept (rowSelector). " +
      "Round 1305: `pass` requires row membership; before that it did not, and `hoverProbesAllPassed: true` " +
      "in pre-1305 artifacts does NOT mean rows were hovered.",
    invalidSurfaces: invalid.map(([k, v]) => ({
      surface: k,
      rowSelector: v.summary.rowSelector,
      probes: v.summary.hoverProbeTotal,
      passed: v.summary.hoverProbePassedTotal,
      misses: v.summary.probeMisses,
    })),
    failureOverridden: process.env.HOVER_ALLOW_PROBE_FAILURE === "1",
  };

  const labels = writeMerged(path.join(OUT, "hover-1291.json"), RUN_LABEL, report);

  console.log(`\nerrors: ${report.errors.length}`);
  for (const s of Object.keys(report.surfaces)) {
    const sum = report.surfaces[s].summary;
    console.log(
      `${s}: median attributable long tasks >50ms over ${PAIRS} pairs = ${sum.medianAttributableLongTasks} ` +
        `(per pair ${JSON.stringify(sum.attributableLongTasksPerPair)}; idle floor ${JSON.stringify(sum.idleLongTasksPerPair)}; hover ${JSON.stringify(sum.hoverLongTasksPerPair)})`,
    );
    console.log(
      `${s}: hover probes ${sum.hoverProbePassedTotal}/${sum.hoverProbeTotal} passed on ${sum.rowSelector} ` +
        `(rowHovered ${sum.rowHoveredTotal}/${sum.hoverProbeTotal})`,
    );
  }
  const c = report.longTaskCadence;
  // Round 1305: with the 1302 payload work shipped, a whole session can contain
  // FEWER THAN THREE long tasks, and `cadence()` then returns a note instead of
  // a fit. Printing its absent fields as "undefined ms" read like a broken
  // instrument; say what actually happened.
  console.log(
    c.fits === null
      ? `cadence: no fit — ${c.note}`
      : `cadence: ${c.events} long tasks in the session, base period ${c.basePeriodMs}ms, ` +
          `worst residual ${c.worstResidualMs}ms (${c.worstResidualPctOfPeriod}% of period), fits=${c.fits}`,
  );
  console.log(
    `wrote ${RUN_LABEL} → ${path.join(OUT, "hover-1291.json")} (runs now: ${labels.join(", ")})`,
  );
  await browser.close();

  if (!report.sweepValid) {
    console.error(
      `\nSWEEP INVALID — ${invalid.map(([k, v]) => `${k}: ${v.summary.hoverProbePassedTotal}/${v.summary.hoverProbeTotal} probes on a row`).join("; ")}.\n` +
        `These numbers are NOT a hover measurement: the pointer was provably off the rows for part of at least one window.\n` +
        `Misses are in the JSON at surfaces.<s>.summary.probeMisses. Set HOVER_ALLOW_PROBE_FAILURE=1 to keep exit 0 while diagnosing.`,
    );
    if (process.env.HOVER_ALLOW_PROBE_FAILURE !== "1") process.exit(1);
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
