/**
 * pseudo-invalidation.cjs — phase 800 §9.7's open question, run as a probe.
 *
 * ROUND 1291. `canvas-perf.md` §9.7 recorded, and refused to explain,
 * **4,636 `StyleRecalcInvalidationTracking · PseudoClass` records on the cold
 * canvas open and 4,637 on the warm one**, against 4,716 DOM elements on
 * `/desktop` — ~one per element, on every canvas toggle, and identical when
 * `document.fonts` is already warm. §9.8 item 3 named it "the next real
 * question on this surface" because it is the one that touches the panel's
 * HOVER requirement rather than the canvas.
 *
 * This file changes NO application code. It answers three questions with
 * trace evidence, or reports that it could not:
 *
 *   Q1  Is this a hover cost at all, or only a canvas-toggle cost? Records
 *       produced by (i) one canvas toggle, (ii) ONE crossing of a chat-rail
 *       row, (iii) ONE crossing of a team-panel row, (iv) a 30-crossing
 *       sweep — reported as records-per-crossing.
 *   Q2  Who owns the records? Grouped and ranked by Blink's own invalidation
 *       fields: `reason`, `changedPseudo`, `selectorPart`,
 *       `invalidatedSelectorId`, `nodeName`, `subtree`, `extraData`.
 *   Q3  Do OUR rules multiply it? The (ii)/(iii)/(iv) legs are repeated with
 *       the suspect rules neutralised AT RUNTIME by `deleteRule` — the CSS
 *       files are never edited — in three cumulative levels, so a collapse
 *       can be attributed to a level rather than to "some CSS".
 *
 * ── THE CAVEAT THIS FILE INHERITS AND RESTATES ────────────────────────────
 *
 * `canvas-layout-probe.cjs`, which this file is adapted from, says it and it
 * is just as true here: the two extra trace categories
 *
 *   disabled-by-default-devtools.timeline.invalidationTracking
 *   disabled-by-default-devtools.timeline.stack
 *
 * MATERIALLY CHANGE WHAT THE RENDERER DOES. Every number in this file is a
 * RECORD COUNT — an attribution of cost. It is **not** a measurement of
 * milliseconds, and anyone quoting an ms figure out of this file is quoting
 * the wrong instrument. §9.8 item 4 also warns that
 * `canvas-layout-probe.cjs`'s `top_forcing_frames` contains a Playwright
 * artifact; this file inherits that file's rig, not that field's
 * interpretation, and emits no equivalent field.
 *
 * ── WHY THE A/B RUNS ON ONE DOCUMENT ──────────────────────────────────────
 *
 * The neutralisation levels are CUMULATIVE and all five pointer rounds run
 * against the SAME loaded page: same transcript, same element count, same
 * warm caches. A fresh page per level would put page-to-page drift inside the
 * comparison, which is the one thing an A/B cannot afford. `base` is measured
 * TWICE, back to back, before anything is deleted, so a reader can see this
 * instrument's own repeatability before reading any difference as a finding.
 * Element count is re-read at every level and recorded next to every count.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * Environment per `docs/plan/artifacts/phase500/README.md` §2 steps A–E, with
 * this round's ports (`:7798` harness already up, isolated build served on
 * `:7791`). Then:
 *
 * ```bash
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-1291c.txt)"
 * export PHASE700_BASE_URL=http://127.0.0.1:7791
 * export PHASE1290_OUT_DIR=/tmp/phase1291c-out
 * node docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.cjs
 * ```
 *
 * NFU8: playwright via `../../phase700/lib-703.cjs` by absolute path. No new
 * dependency in either repo.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE1290_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE1290_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase1290-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
process.env.PHASE700_OUT_DIR = OUT_DIR;

const L = require("../../phase700/lib-703.cjs");

const OUT_FILE = process.env.PHASE1290_OUT_FILE ?? "pseudo-invalidation.json";

/** The drawing `canvas-layout-probe.cjs` seeds from. Same one, so the canvas
 *  leg is comparable to §9.7's number rather than to a different scene. */
const SEED_PATH =
  process.env.PHASE1290_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";

/**
 * The confirmed descendant-`:hover` suspects, re-derived from the sheets in
 * THIS worktree at the top of the round with
 *
 *   grep -nE ':hover[^,{]*[ >+~][^,{]+\{|:hover' \
 *     forge-control-web/app/globals.css forge-control-web/app/v2.css
 *
 * and matched here by SELECTOR TEXT, not by file, because the production
 * build concatenates both files into one `/_next/static/css/*.css` chunk and
 * `href` can no longer tell them apart.
 *
 * Matching is substring-on-`selectorText`, which means a grouped rule is
 * deleted whole: `.chat-row:hover .chat-row-x` and
 * `.chat-row:focus-within .chat-row-x` are one CSSStyleRule and both go. That
 * is recorded rather than worked around — `:focus-within` is the same class of
 * sibling/descendant invalidation and neutralising it too only strengthens a
 * negative result.
 */
const SUSPECTS = [
  { file: "globals.css", line: 101, sel: ".chat-row:hover .chat-row-x" },
  { file: "globals.css", line: 105, sel: ".chat-row:hover .chat-row-age" },
  { file: "globals.css", line: 119, sel: ".team-row:hover .team-row-controls" },
  { file: "globals.css", line: 179, sel: ".nav-back:hover .nav-back-arrow" },
  {
    file: "globals.css",
    line: 196,
    sel: ".nav-back:hover .nav-back-arrow",
    note: "inside @media (prefers-reduced-motion: reduce) — reached by the recursive walk",
  },
  { file: "v2.css", line: 291, sel: ".v2-nav-item:hover:not(.v2-nav-active) span" },
];

/** Marks our own bundle apart from Excalidraw's 144 KB sheet without relying
 *  on `href`: our sheet is the one that carries the rail's own class. */
const APP_SHEET_FINGERPRINT = ".chat-row";

const ROW_SEL = { rail: ".chat-row", team: "[data-team-row]" };
const SWEEP_CROSSINGS = 30;

/* ── trace ────────────────────────────────────────────────────────────────── */

/**
 * `bufferUsageReportingInterval` is not decoration either. The first run of
 * this probe failed with "user_timing marks missing from trace" on the canvas
 * leg while an identical control trace on the same page kept both of its
 * marks — the signature of Chrome's `recordAsMuchAsPossible` buffer filling
 * mid-leg and dropping everything after it. A probe that silently loses trace
 * events reports an undercount as a finding, so buffer fill and
 * `dataLossOccurred` are now recorded on EVERY leg and printed in the JSON.
 */
/**
 * Three category sets, because one instrument could not answer the question
 * and stay honest at the same time.
 *
 *   full      everything, stacks included. Attributes a record to a JS frame,
 *             and fills Chrome's buffer on the canvas leg.
 *   counting  the same minus stacks. ~3× fewer bytes.
 *   minimal   user timing + invalidation tracking only. Nothing else is
 *             recorded, so if a count is IDENTICAL here and under `full`, the
 *             count is not buffer-limited — that is a measurement of the
 *             instrument's own truncation, not an argument about it.
 */
const TRACE_PROFILES = {
  full: [
    "devtools.timeline",
    "blink.user_timing",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.invalidationTracking",
    "disabled-by-default-devtools.timeline.stack",
  ],
  counting: [
    "devtools.timeline",
    "blink.user_timing",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.invalidationTracking",
  ],
  minimal: ["blink.user_timing", "disabled-by-default-devtools.timeline.invalidationTracking"],
};

async function startTrace(cdp, sink, usage, profile = "full") {
  const includedCategories = TRACE_PROFILES[profile];
  if (!includedCategories) throw new Error(`unknown trace profile ${JSON.stringify(profile)}`);
  sink.length = 0;
  usage.percent_full_max = 0;
  await cdp.send("Tracing.start", {
    bufferUsageReportingInterval: 250,
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      /* The canvas leg fills Chrome's default buffer to 99.94% and loses the
       * tail — see the note on `bufferUsageReportingInterval` above. 250 MB
       * is ~8× the default and holds the whole storm. Verified accepted by
       * this Chrome build before it was relied on; a Chrome that rejects the
       * field fails loudly at `Tracing.start` rather than silently truncating. */
      traceBufferSizeInKb: 250_000,
      /* `traceBufferSizeInKb` above is ACCEPTED by this Chrome and then
       * ignored — the buffer still reports 99.95% full, to the same sixteen
       * digits, with and without it. Shrinking the category set is therefore
       * the only lever that works, and `TRACE_PROFILES` is that lever. */
      includedCategories,
    },
  });
}

async function stopTrace(cdp, sink) {
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  const complete = await done;
  await new Promise((r) => setTimeout(r, 500));
  return { events: sink.slice(), data_loss_occurred: complete?.dataLossOccurred ?? null };
}

/**
 * Copied from `canvas-layout-probe.cjs` — pick the renderer main thread with
 * the most complete events, not the first `thread_name` metadata seen.
 *
 * The `minimal` profile records no `devtools.timeline`, so there are no `X`
 * events to rank threads by and possibly no `thread_name` metadata either.
 * Falling back to the thread that owns the most invalidation records is the
 * right answer for this file specifically: those records ARE its subject, and
 * a thread that has none of them is not the thread it wants.
 */
function findRendererMain(events) {
  const named = events.filter(
    (e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  const rank = (pid, tid) => {
    const x = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === "X").length;
    if (x) return x;
    return events.filter(
      (e) => e.pid === pid && e.tid === tid && INVALIDATION_EVENTS.includes(e.name),
    ).length;
  };
  let best = null;
  for (const m of named) {
    const n = rank(m.pid, m.tid);
    if (!best || n > best.n) best = { pid: m.pid, tid: m.tid, n, from: "thread_name metadata" };
  }
  if (best && best.n > 0) return best;

  const byThread = new Map();
  for (const e of events) {
    if (!INVALIDATION_EVENTS.includes(e.name)) continue;
    const k = `${e.pid}:${e.tid}`;
    byThread.set(k, (byThread.get(k) ?? 0) + 1);
  }
  const top = [...byThread.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top)
    throw new Error(
      "no CrRendererMain thread_name metadata AND no invalidation records on any thread — the trace covered nothing",
    );
  const [pid, tid] = top[0].split(":").map(Number);
  return { pid, tid, n: top[1], from: "most invalidation records (no usable metadata)" };
}

const markTs = (events, name) => {
  const hit = events.find(
    (e) => e.name === name && (e.cat ?? "").includes("blink.user_timing"),
  );
  return hit ? hit.ts : null;
};

/** Chrome has moved stack traces between three arg shapes across versions;
 *  checking all three is cheaper than pinning a version and silently
 *  reporting "no stack". (Verbatim reasoning from canvas-layout-probe.cjs.) */
function stackOf(e) {
  const raw =
    e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? e.args?.stackTrace ?? null;
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 6).map((f) => ({
    fn: f.functionName || "(anonymous)",
    url: typeof f.url === "string" ? f.url.split("/").pop() : null,
    url_full: typeof f.url === "string" ? f.url : null,
    line: f.lineNumber ?? null,
    /* The bundle is one line, so the LINE tells a reader nothing and the
     * COLUMN tells them everything: it is the only way to get from a frame
     * called `O` back to the DOM call that produced 5,851 records. */
    col: f.columnNumber ?? null,
  }));
}

/**
 * Blink emits THREE invalidation-tracking events, and round 1291's first run
 * proved that reading only one of them answers only one third of Q2:
 *
 *   ScheduleStyleInvalidationTracking    an invalidation being SCHEDULED.
 *                                        Carries `changedPseudo`,
 *                                        `selectorPart` and
 *                                        `invalidatedSelectorId` — i.e. the
 *                                        authored rule, by name.
 *   StyleInvalidatorInvalidationTracking the invalidator WALKING a subtree,
 *                                        with the selector it is applying.
 *   StyleRecalcInvalidationTracking      an element actually marked dirty,
 *                                        with a coarse `reason`. This is the
 *                                        one §9.7 counted. It carries NO
 *                                        selector fields at all, which is why
 *                                        §9.7 could see 4,636 records and
 *                                        still not know who owned them.
 *
 * All three are `ph: "I"` instants. An X/B/E-only reader drops them entirely,
 * which is exactly how a round concludes "mechanism not proven" while the
 * evidence sits unread in its own trace.
 */
const INVALIDATION_EVENTS = [
  "ScheduleStyleInvalidationTracking",
  "StyleInvalidatorInvalidationTracking",
  "StyleRecalcInvalidationTracking",
];

function invalidationRecords(events, pid, tid, t0 = null, t1 = null) {
  const out = [];
  for (const e of events) {
    if (e.pid !== pid || e.tid !== tid) continue;
    if (!INVALIDATION_EVENTS.includes(e.name)) continue;
    if (!["I", "i", "R", "n"].includes(e.ph)) continue;
    if (t0 !== null && e.ts < t0) continue;
    if (t1 !== null && e.ts > t1) continue;
    const d = e.args?.data ?? e.args ?? {};
    out.push({
      event: e.name,
      ts: e.ts,
      reason: d.reason ?? null,
      changedPseudo: d.changedPseudo ?? null,
      changedClass: d.changedClass ?? null,
      changedAttribute: d.changedAttribute ?? null,
      changedId: d.changedId ?? null,
      selectorPart: d.selectorPart ?? null,
      invalidatedSelectorId: d.invalidatedSelectorId ?? null,
      nodeName: d.nodeName ?? null,
      subtree: d.subtree ?? null,
      extraData: d.extraData ?? null,
      stack: stackOf(e),
    });
  }
  return out;
}

const isRecalc = (r) => r.event === "StyleRecalcInvalidationTracking";
/** §9.7's metric, reproduced exactly: recalc records whose reason is
 *  `PseudoClass`. Nothing else counts towards the 4,636. */
const isPseudo = (r) => isRecalc(r) && r.reason === "PseudoClass";
/** The hover half: anything Blink itself attributed to the `hover` pseudo. */
const isHoverAttributed = (r) => r.changedPseudo === "hover";

/** Q2's table: rank by the exact fields Blink itself emits. */
function groupRecords(records, top = 15) {
  const map = new Map();
  for (const r of records) {
    const key = JSON.stringify({
      event: r.event,
      reason: r.reason,
      changedPseudo: r.changedPseudo,
      changedClass: r.changedClass,
      selectorPart: r.selectorPart,
      invalidatedSelectorId: r.invalidatedSelectorId,
      nodeName: r.nodeName,
      subtree: r.subtree,
      extraData: r.extraData,
    });
    const acc = map.get(key) ?? { ...JSON.parse(key), count: 0, sample_stack: r.stack };
    acc.count++;
    if (!acc.sample_stack && r.stack) acc.sample_stack = r.stack;
    map.set(key, acc);
  }
  return {
    distinct_groups: map.size,
    top: [...map.values()].sort((a, b) => b.count - a.count).slice(0, top),
  };
}

/* ── in-page helpers, injected as source so `page.evaluate` can name them ─── */

/**
 * Walk every same-origin stylesheet, including nested grouping rules
 * (`@media`, `@supports`), and hand each rule to `fn` with its parent list.
 * A cross-origin sheet throws on `.cssRules`; that is recorded, not swallowed.
 */
const SHEET_WALKER = `
function __walkSheets(fn) {
  const inaccessible = [];
  const sheets = Array.from(document.styleSheets);
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    let rules = null;
    try { rules = sheet.cssRules; } catch (err) {
      inaccessible.push({ index: s, href: sheet.href ?? null, error: String(err && err.message || err) });
      continue;
    }
    if (!rules) { inaccessible.push({ index: s, href: sheet.href ?? null, error: "cssRules is null" }); continue; }
    const descend = (parent, depth) => {
      const list = parent.cssRules;
      if (!list) return;
      /* Reverse order: deleteRule shifts every later index down by one. */
      for (let i = list.length - 1; i >= 0; i--) {
        const rule = list[i];
        if (rule.cssRules && rule.cssRules.length) descend(rule, depth + 1);
        fn(rule, parent, i, s, sheet.href ?? null);
      }
    };
    descend(sheet, 0);
  }
  return inaccessible;
}
function __sheetIsApp(sheet) {
  try {
    const rules = sheet.cssRules;
    if (!rules) return false;
    for (let i = 0; i < rules.length; i++) {
      const t = rules[i].selectorText;
      if (typeof t === "string" && t.indexOf(${JSON.stringify(APP_SHEET_FINGERPRINT)}) !== -1) return true;
    }
  } catch { return false; }
  return false;
}
`;

/* ── the probe ────────────────────────────────────────────────────────────── */

/** Mark the trace so a leg's records can be clipped to the leg. */
async function mark(page, name) {
  await page.evaluate((n) => performance.mark(n), name);
}

/** A neutral resting point for the pointer: over no row of either kind. */
async function findNeutralPoint(page) {
  const candidates = [
    [720, 894],
    [720, 4],
    [4, 894],
    [1436, 4],
  ];
  for (const [x, y] of candidates) {
    await page.mouse.move(x, y);
    const hovered = await page.evaluate(
      (sels) => document.querySelectorAll(`${sels.rail}:hover, ${sels.team}:hover`).length,
      ROW_SEL,
    );
    if (hovered === 0) return { x, y };
  }
  throw new Error(
    "no neutral pointer position found — every candidate rests over a rail or team row",
  );
}

/** `document.querySelectorAll("*").length` — §9.7's 4,716, re-measured. */
const elementCount = (page) => page.evaluate(() => document.querySelectorAll("*").length);

/**
 * Turn a minified stack frame into readable evidence.
 *
 * A frame called `O` at `60568ccb….js:1` names nothing. The bundle is a
 * single line, so the COLUMN is the whole address: fetch the exact script the
 * browser ran and quote the characters either side of it. This is how a
 * reader checks the attribution instead of taking it, and it needs no
 * source-map and no new dependency.
 */
async function frameSource(page, frame, radius = 420) {
  if (!frame?.url_full || typeof frame.col !== "number") return null;
  const res = await page.request.get(frame.url_full);
  if (!res.ok()) return { frame: frame.fn, error: `GET ${frame.url_full} → ${res.status()}` };
  const text = await res.text();
  const start = Math.max(0, frame.col - radius);
  return {
    frame: `${frame.fn} @ ${frame.url}:${frame.line}:${frame.col}`,
    script_bytes: text.length,
    excerpt_starts_at_column: start,
    excerpt: text.slice(start, frame.col + radius),
  };
}

/**
 * ONE crossing = neutral → row centre → neutral. Two moves, one enter and one
 * leave. Stated explicitly because "crossing" is the unit every number in Q1
 * and Q3 is divided by, and phase 400's sweep counted a row-to-row move as
 * one instead.
 *
 * `assertHover` runs while the pointer is ON the row, and its result is
 * written into the JSON: a leg that silently failed to hover would otherwise
 * report a beautiful zero.
 */
async function crossings(page, sel, count, neutral, assertHover) {
  const boxes = await page.evaluate((s) => {
    const out = [];
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    }
    return out;
  }, sel);
  if (!boxes.length) throw new Error(`no visible rows matched ${sel}`);

  const proofs = [];
  for (let i = 0; i < count; i++) {
    const b = boxes[i % boxes.length];
    await page.mouse.move(b.x, b.y);
    if (assertHover && (i === 0 || i === count - 1)) {
      proofs.push(
        await page.evaluate(
          ([s, idx]) => {
            const hovered = Array.from(document.querySelectorAll(`${s}:hover`));
            const deepest = Array.from(document.querySelectorAll(":hover")).pop();
            return {
              crossing_index: idx,
              rows_matching_hover: hovered.length,
              row_matches_hover: hovered.length > 0,
              deepest_hovered: deepest
                ? `${deepest.tagName.toLowerCase()}${deepest.className && typeof deepest.className === "string" ? `.${deepest.className.trim().split(/\s+/).join(".")}` : ""}`
                : null,
              hover_chain_depth: document.querySelectorAll(":hover").length,
            };
          },
          [sel, i],
        ),
      );
    }
    await page.mouse.move(neutral.x, neutral.y);
  }
  return { rows_available: boxes.length, crossings: count, hover_proof: proofs };
}

const tally = (records) => {
  const recalc = records.filter(isRecalc);
  const pseudo = recalc.filter(isPseudo);
  const otherRecalc = recalc.filter((r) => !isPseudo(r));
  return {
    invalidation_records_total: records.length,
    by_event: records.reduce((a, r) => {
      a[r.event] = (a[r.event] ?? 0) + 1;
      return a;
    }, {}),
    /* §9.7's metric, byte for byte. */
    pseudo_class: pseudo.length,
    /* Blink's own attribution of the `hover` pseudo, on the two event types
     * that carry it. §9.7's metric cannot see this at all. */
    hover_attributed: records.filter(isHoverAttributed).length,
    style_recalc_total: recalc.length,
    style_recalc_other_reasons: otherRecalc.reduce((a, r) => {
      const k = r.reason ?? "(null)";
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {}),
  };
};

/**
 * One traced leg: mark, interact, stop, clip to the leg's own window, count,
 * group.
 *
 * `subWindows` lets a leg report a NARROWER span inside itself — the canvas
 * leg uses it to quote a click→paint count directly comparable with §9.7's
 * 4,636, which was taken over exactly that span, without giving up the wider
 * window that shows what the settle costs afterwards.
 */
async function tracedLeg(ctx, name, fn, subWindows = [], profile = "full") {
  const { page, cdp, sink } = ctx;
  const usage = { percent_full_max: 0 };
  const onUsage = ({ percentFull }) => {
    if (typeof percentFull === "number")
      usage.percent_full_max = Math.max(usage.percent_full_max, percentFull);
  };
  cdp.on("Tracing.bufferUsage", onUsage);
  try {
    await page.waitForTimeout(400);
    await startTrace(cdp, sink, usage, profile);
    await page.waitForTimeout(200);
    await mark(page, `${name}:start`);
    const detail = await fn();
    await mark(page, `${name}:end`);
    await page.waitForTimeout(300);
    const { events, data_loss_occurred } = await stopTrace(cdp, sink);

    const main = findRendererMain(events);
    const t0 = markTs(events, `${name}:start`);
    const tEnd = markTs(events, `${name}:end`);
    if (t0 === null)
      throw new Error(
        `${name}: the ":start" user_timing mark is missing from the trace — tracing did not cover this leg at all`,
      );
    /* A missing END mark with a full buffer is the documented failure above,
     * not a mystery: the leg's tail was dropped. Say which it was in the
     * artifact instead of quoting the survivors as if they were the total. */
    const t1 =
      tEnd ??
      Math.max(...events.filter((e) => e.pid === main.pid && e.tid === main.tid).map((e) => e.ts));

    const all = invalidationRecords(events, main.pid, main.tid, t0, t1);

    const subs = {};
    for (const sw of subWindows) {
      const a = markTs(events, sw.from);
      const b = markTs(events, sw.to);
      subs[sw.name] =
        a === null || b === null
          ? { available: false, missing: a === null ? sw.from : sw.to }
          : {
              available: true,
              window_ms: +((b - a) / 1000).toFixed(1),
              ...tally(invalidationRecords(events, main.pid, main.tid, a, b)),
            };
    }

    return {
      leg: name,
      trace_profile: profile,
      trace_categories: TRACE_PROFILES[profile],
      elements_on_page: await elementCount(page),
      window_ms: +((t1 - t0) / 1000).toFixed(1),
      window_end_source: tEnd === null ? "TRACE TAIL FALLBACK — end mark lost" : "mark",
      trace_integrity: {
        data_loss_occurred,
        buffer_percent_full_max: usage.percent_full_max,
        /* The only honest reading: if either of these fires, the counts in
         * this leg are LOWER BOUNDS. */
        counts_are_lower_bounds: data_loss_occurred === true || tEnd === null,
      },
      records: tally(all),
      ...(subWindows.length ? { sub_windows: subs } : {}),
      /* Q2, three ways: the whole population, §9.7's own metric on its own,
       * and the records Blink itself blamed on `:hover`. */
      groups: {
        all_records: groupRecords(all),
        pseudo_class_only: groupRecords(all.filter(isPseudo)),
        hover_attributed_only: groupRecords(all.filter(isHoverAttributed)),
      },
      trace_events: events.length,
      ...detail,
    };
  } finally {
    cdp.off("Tracing.bufferUsage", onUsage);
  }
}

/* ── neutralisation levels (Q3) ───────────────────────────────────────────── */

/**
 * Levels are CUMULATIVE supersets, applied to the live CSSOM of the page
 * under test. The CSS FILES ARE NEVER TOUCHED — this is `deleteRule` on
 * `document.styleSheets`, exactly as the brief specifies, and it dies with
 * the page.
 *
 *   1 ours_descendant  the six confirmed descendant-`:hover` rules
 *   2 ours_all_hover   every `:hover` rule in OUR bundle (the sheet carrying
 *                      `.chat-row`), suspects included
 *   3 all_hover        every `:hover` rule in EVERY same-origin sheet,
 *                      Excalidraw's 144 KB sheet included. If the records
 *                      survive THIS, no authored selector owns them.
 */
const V2_NAV_SPAN = ".v2-nav-item:hover:not(.v2-nav-active) span";

const LEVELS = [
  {
    id: "v2_nav_item_span_only",
    label: `ONE rule: ${V2_NAV_SPAN}`,
  },
  { id: "ours_descendant", label: "our six descendant :hover rules" },
  { id: "ours_all_hover", label: "every :hover rule in our own bundle" },
  { id: "all_hover", label: "every :hover rule in every same-origin sheet" },
];

async function surveySheets(page) {
  return page.evaluate(
    `(() => { ${SHEET_WALKER}
      const sheets = [];
      const inaccessible = [];
      const all = Array.from(document.styleSheets);
      for (let s = 0; s < all.length; s++) {
        const sheet = all[s];
        let rules = null;
        try { rules = sheet.cssRules; } catch (err) {
          inaccessible.push({ index: s, href: sheet.href ?? null, error: String(err && err.message || err) });
          continue;
        }
        let total = 0, hover = 0;
        const count = (parent) => {
          const list = parent.cssRules; if (!list) return;
          for (let i = 0; i < list.length; i++) {
            const r = list[i];
            if (r.cssRules && r.cssRules.length) count(r);
            total++;
            if (typeof r.selectorText === "string" && r.selectorText.indexOf(":hover") !== -1) hover++;
          }
        };
        count(sheet);
        sheets.push({
          index: s,
          href: sheet.href ? sheet.href.split("/").pop() : null,
          is_app_bundle: __sheetIsApp(sheet),
          rules_total: total,
          rules_with_hover: hover,
        });
      }
      return { sheets, inaccessible };
    })()`,
  );
}

/**
 * Apply one level and PROVE it applied: the matching `selectorText`s are
 * re-read after the pass and asserted gone. Before/after rule counts are
 * returned and land in the JSON.
 */
async function neutralise(page, levelId, suspectSelectors) {
  return page.evaluate(
    `(() => { ${SHEET_WALKER}
      const LEVEL = ${JSON.stringify(levelId)};
      const SUSPECTS = ${JSON.stringify(suspectSelectors)};
      const appSheets = new Set();
      Array.from(document.styleSheets).forEach((sh, i) => { if (__sheetIsApp(sh)) appSheets.add(i); });

      const matches = (rule, sheetIndex) => {
        const t = rule.selectorText;
        if (typeof t !== "string") return false;
        if (LEVEL === "v2_nav_item_span_only") return t.indexOf(${JSON.stringify(V2_NAV_SPAN)}) !== -1;
        if (LEVEL === "ours_descendant") return SUSPECTS.some((s) => t.indexOf(s) !== -1);
        if (LEVEL === "ours_all_hover") return appSheets.has(sheetIndex) && t.indexOf(":hover") !== -1;
        if (LEVEL === "all_hover") return t.indexOf(":hover") !== -1;
        throw new Error("unknown neutralisation level " + LEVEL);
      };

      const before = [];
      __walkSheets((rule, parent, i, sheetIndex) => {
        if (matches(rule, sheetIndex)) before.push(rule.selectorText);
      });

      const deleted = [];
      const failed = [];
      __walkSheets((rule, parent, i, sheetIndex) => {
        if (!matches(rule, sheetIndex)) return;
        const t = rule.selectorText;
        try { parent.deleteRule(i); deleted.push(t); }
        catch (err) { failed.push({ selector: t, error: String(err && err.message || err) }); }
      });

      const after = [];
      __walkSheets((rule, parent, i, sheetIndex) => {
        if (matches(rule, sheetIndex)) after.push(rule.selectorText);
      });

      /* Independent of the level's own predicate: how many :hover rules are
       * left in the whole document, and how many of the six named suspects
       * survive anywhere. A level that reports 0 remaining by its own
       * definition can still have missed a suspect in a @media block. */
      let hoverRulesLeft = 0;
      const suspectsLeft = [];
      __walkSheets((rule) => {
        const t = rule.selectorText;
        if (typeof t !== "string") return;
        if (t.indexOf(":hover") !== -1) hoverRulesLeft++;
        if (SUSPECTS.some((s) => t.indexOf(s) !== -1)) suspectsLeft.push(t);
      });

      return {
        level: LEVEL,
        rules_matching_before: before.length,
        rules_deleted: deleted.length,
        rules_matching_after: after.length,
        delete_failures: failed,
        deleted_selectors: deleted,
        hover_rules_remaining_document_wide: hoverRulesLeft,
        named_suspects_remaining: suspectsLeft,
      };
    })()`,
  );
}

/* ── main ─────────────────────────────────────────────────────────────────── */

(async () => {
  const chk = L.makeChecker();
  const chat = await L.resolveChat();
  chk.note("fixture", {
    chat: chat.id,
    title: chat.title ?? null,
    base: L.BASE,
    api: L.API,
    drawing: SEED_PATH,
  });
  chk.note("instrument_caveat", {
    categories: ["invalidationTracking", "stack"],
    meaning:
      "record counts attribute cost; they are NOT milliseconds. Do not quote an ms figure out of this file.",
  });
  chk.note("suspect_rules_confirmed_in_this_worktree", SUSPECTS);

  const suspectSelectors = [...new Set(SUSPECTS.map((s) => s.sel))];
  const report = { canvas: null, pointer_rounds: [], sheets: null };

  await L.withBrowser(async (bctx) => {
    /* ── Q1(i) + the canvas A/B: one toggle per fresh page ────────────────── */
    /**
     * Run twice. The second run deletes every `:hover` rule in the document
     * BEFORE the toggle, which is the only way to ask whether §9.7's 4,636
     * belong to an authored `:hover` rule at all. Q3 as briefed only covers
     * the pointer legs, but the records live on THIS leg, so ruling our rules
     * in or out here is what the question was actually about.
     *
     * A fresh page each time, because the toggle is the interaction and it
     * only happens once per page in this fixture.
     */
    const runCanvasLeg = async (legName, neutraliseFirst, profile) => {
      const page = await bctx.newPage();
      const cdp = await bctx.newCDPSession(page);
      const sink = [];
      cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));

      await page.addInitScript(
        ({ key, id, p }) => {
          try {
            localStorage.setItem(key, JSON.stringify({ [id]: { open: false, path: p } }));
          } catch {
            /* about:blank — the real origin's write is the one that counts */
          }
        },
        { key: "forge.canvasByRun", id: chat.id, p: SEED_PATH },
      );

      /* §9.9: CanvasPane.tsx:263-269 flushes on unmount and Excalidraw marks
       * the scene dirty while loading, so an unguarded probe writes Konrad's
       * real drawing back once per cycle. Stubbed exactly as phase 800 did. */
      let putsStubbed = 0;
      let putsSeen = 0;
      page.on("request", (r) => {
        if (r.method() === "PUT" && r.url().includes("/api/proxy/canvas/file")) putsSeen++;
      });
      await page.route("**/api/proxy/canvas/file", async (route) => {
        const req = route.request();
        if (req.method() !== "PUT") return route.continue();
        putsStubbed++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, path: SEED_PATH, mtime: 1 }),
        });
      });

      await L.openChat(page);
      await page.waitForTimeout(2_000);

      const sheets = await surveySheets(page);
      const elements = await elementCount(page);
      const applied = neutraliseFirst
        ? await neutralise(page, "all_hover", suspectSelectors)
        : null;

      const leg = await tracedLeg(
        { page, cdp, sink },
        legName,
        async () => {
          await mark(page, "canvas:click");
          await page.getByRole("button", { name: "CANVAS", exact: true }).click();
          await page.waitForSelector(".excalidraw", { timeout: 30_000 });
          /* Two rAFs = the frame Excalidraw actually painted in, the same
           * definition `canvas-layout-probe.cjs` uses for `excpaint`. */
          await page.evaluate(
            () =>
              new Promise((r) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    performance.mark("canvas:paint");
                    r(null);
                  }),
                ),
              ),
          );
          await page.waitForTimeout(1_200);
          return {
            interaction:
              "one CANVAS toggle (closed → open): click → .excalidraw painted → 1.2s settle",
          };
        },
        [{ name: "click_to_excalidraw_paint", from: "canvas:click", to: "canvas:paint" }],
        profile,
      );
      leg.canvas_put_requests_seen = putsSeen;
      leg.canvas_put_requests_stubbed = putsStubbed;
      leg.elements_before_toggle = elements;
      leg.neutralisation = applied;
      /* Q2, made checkable: the innermost three frames of the stack behind
       * the largest group of records, quoted out of the shipped bundle. */
      if (profile === "full") {
        const frames = leg.groups.pseudo_class_only.top[0]?.sample_stack ?? [];
        leg.top_group_frame_sources = [];
        for (const f of frames.slice(0, 3))
          leg.top_group_frame_sources.push(await frameSource(page, f));
      }
      /* Excalidraw's sheet arrives WITH the editor, so the after-toggle
       * survey is the only place a reader can see how many :hover rules the
       * mount added back on top of a document we had just emptied of them. */
      leg.sheets_after_toggle = await surveySheets(page);
      await page.close();
      return { leg, sheets, elements };
    };

    {
      /* Counting legs first, stacks OFF, so the A/B is between two COMPLETE
       * traces. Then one attribution leg with stacks on, which is allowed to
       * be truncated because nothing is being counted off it. */
      const base = await runCanvasLeg("canvas_toggle", false, "counting");
      report.sheets = base.sheets;
      report.elements_before_canvas = base.elements;
      report.canvas = base.leg;
      report.canvas_neutralised = (
        await runCanvasLeg("canvas_toggle_all_hover_deleted", true, "counting")
      ).leg;
      report.canvas_attribution = (
        await runCanvasLeg("canvas_toggle_stack_attribution", false, "full")
      ).leg;
      /* The truncation control. If `minimal` — which records nothing but user
       * timing and the invalidation records themselves — returns the same
       * count as `full`, then no count in this file was clipped by Chrome's
       * buffer, and the equality of the two A/B legs is a result rather than
       * an artifact of both hitting the same cap. */
      report.canvas_minimal = (
        await runCanvasLeg("canvas_toggle_minimal_categories", false, "minimal")
      ).leg;
    }

    /* ── The hypothesis the attribution leg handed us, tested directly ───── */
    /**
     * `top_group_frame_sources` resolved the innermost frame of all 5,851
     * records to this, at column 7063 of Excalidraw's chunk:
     *
     *   O = async e => { if (_ = e,
     *         document.documentElement.dir  = _.rtl ? "rtl" : "ltr",
     *         document.documentElement.lang = _.code, …
     *
     * — Excalidraw's `setLanguage`, called from its init effect on mount.
     * `lang` and `dir` back the `:lang()` and `:dir()` PSEUDO-CLASSES, so
     * writing them on `<html>` is a pseudo-state change on the root, and
     * Blink propagates it to every descendant.
     *
     * That is a hypothesis until it is run WITHOUT the canvas. These three
     * legs do exactly that on a plain `/desktop`: write `lang`, write `dir`,
     * and — the control that makes the other two mean anything — write `lang`
     * with the value it ALREADY has, which is a write but not a change. If
     * the storm is the attribute change, the control produces ~nothing and
     * the other two produce ~one record per element with no canvas in sight.
     */
    {
      const page = await bctx.newPage();
      const cdp = await bctx.newCDPSession(page);
      const sink = [];
      cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
      await L.openChat(page);
      await page.waitForTimeout(2_000);

      const ctx = { page, cdp, sink };
      const before = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
      }));

      /** Set an attribute and force the style engine to settle inside the
       *  traced window, so nothing lands after the leg's end mark. */
      const writeAttr = (attr, value) =>
        page.evaluate(
          ([a, v]) => {
            document.documentElement[a] = v;
            /* Read a computed style back: forces the recalc the write just
             * scheduled to happen now rather than at the next frame. */
            return getComputedStyle(document.body).color;
          },
          [attr, value],
        );

      report.attribute_writes = {
        html_attributes_before: before,
        legs: {},
      };
      report.attribute_writes.legs.control_lang_unchanged = await tracedLeg(
        ctx,
        "attr:control_lang_unchanged",
        async () => {
          await writeAttr("lang", before.lang);
          return {
            interaction: `document.documentElement.lang = ${JSON.stringify(before.lang)} — the value it already had. A write, not a change.`,
            crossings: 1,
          };
        },
      );
      report.attribute_writes.legs.lang_changed = await tracedLeg(
        ctx,
        "attr:lang_changed",
        async () => {
          await writeAttr("lang", "de-DE");
          return {
            interaction:
              'document.documentElement.lang = "de-DE" — one attribute write, no canvas, no pointer',
            crossings: 1,
          };
        },
      );
      report.attribute_writes.legs.dir_changed = await tracedLeg(
        ctx,
        "attr:dir_changed",
        async () => {
          await writeAttr("dir", "rtl");
          return {
            interaction:
              'document.documentElement.dir = "rtl" — one attribute write, no canvas, no pointer',
            crossings: 1,
          };
        },
      );
      report.attribute_writes.html_attributes_after = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
      }));
      await page.close();
    }

    /* ── Q1(ii)(iii)(iv) + Q3: pointer legs, one document, five rounds ────── */
    {
      const page = await bctx.newPage();
      const cdp = await bctx.newCDPSession(page);
      const sink = [];
      cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));

      await L.openChat(page);
      await page.waitForTimeout(2_000);

      const neutral = await findNeutralPoint(page);
      chk.note("neutral_pointer_point", neutral);

      const ctx = { page, cdp, sink };
      const runRound = async (roundId, neutralisation) => {
        const rail_one = await tracedLeg(ctx, `${roundId}:rail_one`, () =>
          crossings(page, ROW_SEL.rail, 1, neutral, true).then((d) => ({
            interaction: "ONE crossing of a single chat-rail row (neutral → row → neutral)",
            ...d,
          })),
        );
        const team_one = await tracedLeg(ctx, `${roundId}:team_one`, () =>
          crossings(page, ROW_SEL.team, 1, neutral, true).then((d) => ({
            interaction: "ONE crossing of a single team-panel row (neutral → row → neutral)",
            ...d,
          })),
        );
        const sweep = await tracedLeg(ctx, `${roundId}:rail_sweep30`, () =>
          crossings(page, ROW_SEL.rail, SWEEP_CROSSINGS, neutral, true).then((d) => ({
            interaction: `${SWEEP_CROSSINGS} crossings over the chat rail, cycling rows`,
            ...d,
          })),
        );
        for (const l of [rail_one, team_one, sweep])
          l.records_per_crossing = {
            pseudo_class: +(l.records.pseudo_class / l.crossings).toFixed(2),
            hover_attributed: +(l.records.hover_attributed / l.crossings).toFixed(2),
            all_invalidation_records: +(
              l.records.invalidation_records_total / l.crossings
            ).toFixed(2),
          };
        return { round: roundId, neutralisation, legs: { rail_one, team_one, sweep } };
      };

      report.pointer_rounds.push(await runRound("base", null));
      /* Measured twice before anything is deleted: this instrument's own
       * repeatability, so no reader has to take a difference on faith. */
      report.pointer_rounds.push(await runRound("base_repeat", null));

      for (const lvl of LEVELS) {
        const applied = await neutralise(page, lvl.id, suspectSelectors);
        applied.label = lvl.label;
        report.pointer_rounds.push(await runRound(lvl.id, applied));
      }

      report.sheets_after_neutralisation = await surveySheets(page);
      await page.close();
    }
  });

  /* ── verdict checks — on whether this file ANSWERED its questions ─────── */

  const byRound = Object.fromEntries(report.pointer_rounds.map((r) => [r.round, r]));
  const legsOf = (r) => [r.legs.rail_one, r.legs.team_one, r.legs.sweep];

  chk.check(
    "the canvas leg captured a toggle and produced PseudoClass records",
    report.canvas.records.pseudo_class > 0,
    true,
  );
  /* Not "zero PUTs" — CanvasPane flushes and that is the app behaving. The
   * claim is that every one of them died in the stub, so the vault never saw
   * a revision of Konrad's drawing. seen === stubbed is that claim. */
  chk.check(
    "every PUT /canvas/file was fulfilled by the stub — none reached the vault",
    {
      seen: report.canvas.canvas_put_requests_seen,
      stubbed: report.canvas.canvas_put_requests_stubbed,
    },
    {
      seen: report.canvas.canvas_put_requests_seen,
      stubbed: report.canvas.canvas_put_requests_seen,
    },
  );
  chk.check(
    "every pointer leg proved it actually hovered a row",
    report.pointer_rounds.every((r) =>
      legsOf(r).every(
        (l) => l.hover_proof.length > 0 && l.hover_proof.every((p) => p.row_matches_hover),
      ),
    ),
    true,
  );
  for (const lvl of LEVELS) {
    const n = byRound[lvl.id].neutralisation;
    chk.check(
      `neutralisation "${lvl.id}" deleted every matching rule (after = 0)`,
      { matching_after: n.rules_matching_after, failures: n.delete_failures.length },
      { matching_after: 0, failures: 0 },
    );
  }
  chk.check(
    'the six named suspects are gone document-wide once "ours_descendant" ran',
    byRound.ours_descendant.neutralisation.named_suspects_remaining.length,
    0,
  );
  chk.check(
    'no :hover rule survives anywhere after "all_hover"',
    byRound.all_hover.neutralisation.hover_rules_remaining_document_wide,
    0,
  );
  chk.check(
    "the A/B ran on one document (element count stable within 5% across rounds)",
    (() => {
      const counts = report.pointer_rounds.flatMap((r) => legsOf(r).map((l) => l.elements_on_page));
      const lo = Math.min(...counts);
      const hi = Math.max(...counts);
      return (hi - lo) / hi <= 0.05;
    })(),
    true,
  );

  /* ── the one-screen answer ────────────────────────────────────────────── */

  chk.check(
    'the canvas A/B deleted every :hover rule before the toggle ("all_hover", 0 left)',
    report.canvas_neutralised.neutralisation.hover_rules_remaining_document_wide,
    0,
  );
  /* `canvas_toggle_stack_attribution` is deliberately excluded: it exists to
   * name a JS frame, nothing is counted off it, and its trace is expected to
   * truncate. Its integrity is recorded in the leg and noted here so the
   * exemption is visible rather than convenient. */
  chk.note("attribution_leg_integrity", report.canvas_attribution.trace_integrity);
  /**
   * The truncation control, stated as a TOLERANCE and not as an equality.
   *
   * The first version of this check demanded that `minimal` and `counting`
   * return the identical integer, and it failed at 5,895 vs 5,890 — 0.08%.
   * That was the check being wrong, not the legs: each canvas leg is a fresh
   * page load of a LIVE chat, and the document is not byte-identical between
   * loads (the element count itself moved 5,859 → 5,899 across runs of this
   * file). Integer equality was measuring page-load drift.
   *
   * What actually rules out buffer-limitation is that four legs, under four
   * different category sets — one of which records nothing but user timing
   * and the invalidation records themselves and therefore cannot overflow —
   * agree to within 1%. A truncated count would fall away from the others as
   * the byte volume rose, and none of them does.
   */
  const canvasLegs = [
    report.canvas,
    report.canvas_neutralised,
    report.canvas_attribution,
    report.canvas_minimal,
  ];
  const canvasCounts = canvasLegs.map((l) => l.records.pseudo_class);
  chk.note(
    "canvas_legs_counts_vs_elements",
    canvasLegs.map((l) => ({
      leg: l.leg,
      profile: l.trace_profile,
      pseudo_class: l.records.pseudo_class,
      elements: l.elements_before_toggle,
      per_element: +(l.records.pseudo_class / l.elements_before_toggle).toFixed(3),
      data_loss: l.trace_integrity.data_loss_occurred,
    })),
  );
  chk.check(
    "four canvas legs under four category sets agree within 1% — the count is not buffer-limited",
    (Math.max(...canvasCounts) - Math.min(...canvasCounts)) / Math.max(...canvasCounts) <= 0.01,
    true,
  );
  chk.check(
    "every canvas leg produced ~one PseudoClass record per DOM element (0.95–1.05)",
    canvasLegs
      .map((l) => +(l.records.pseudo_class / l.elements_before_toggle).toFixed(3))
      .filter((r) => r < 0.95 || r > 1.05),
    [],
  );
  /**
   * Which legs lost trace data, recorded rather than checked.
   *
   * Chrome drops the TAIL of a canvas leg on most runs whatever the category
   * set — the `canvas:paint` mark survives on some runs and not others, and
   * `traceBufferSizeInKb` does not help. That is a fact about the instrument
   * and it belongs in the artifact, but it is not a pass/fail: the canvas
   * counts are defended by the two checks above (four category sets, one
   * record per element), not by any single trace being perfect.
   *
   * The POINTER legs are a different matter. They are small, they never lose
   * data, and every hover conclusion in the README rests on them — so there
   * the check stays strict.
   */
  chk.note(
    "legs_that_lost_trace_data",
    [
      report.canvas,
      report.canvas_neutralised,
      report.canvas_attribution,
      report.canvas_minimal,
      ...Object.values(report.attribute_writes.legs),
      ...report.pointer_rounds.flatMap(legsOf),
    ]
      .filter((l) => l.trace_integrity.counts_are_lower_bounds)
      .map((l) => l.leg),
  );
  chk.check(
    "no POINTER or attribute leg lost trace data — every hover number is a total",
    [...report.pointer_rounds.flatMap(legsOf), ...Object.values(report.attribute_writes.legs)]
      .filter((l) => l.trace_integrity.counts_are_lower_bounds)
      .map((l) => l.leg),
    [],
  );

  const canvasNumbers = (l) => ({
    elements_before_toggle: l.elements_before_toggle,
    pseudo_class_whole_leg: l.records.pseudo_class,
    pseudo_class_click_to_paint: l.sub_windows?.click_to_excalidraw_paint?.pseudo_class ?? null,
    hover_attributed: l.records.hover_attributed,
    records_per_element: +(l.records.pseudo_class / l.elements_before_toggle).toFixed(3),
  });

  const aw = report.attribute_writes.legs;
  chk.check(
    "writing <html lang> alone reproduces the storm with NO canvas: >0.9 records per element",
    aw.lang_changed.records.pseudo_class / aw.lang_changed.elements_on_page > 0.9,
    true,
  );
  /**
   * The control was written expecting "a write is not a change" and the
   * measurement said otherwise, so the check now asserts what was measured
   * rather than what was expected. Re-writing `lang` with the value it
   * ALREADY holds costs exactly as much as changing it: Blink's `lang`
   * handler fires the `:lang()` pseudo-state change on the subtree
   * unconditionally. That makes the cost a property of the WRITE, which
   * matters for anything downstream that might try to fix this by
   * short-circuiting on the value.
   */
  chk.check(
    "the `lang` write costs the same whether or not the value changes (±2%)",
    Math.abs(
      aw.control_lang_unchanged.records.pseudo_class - aw.lang_changed.records.pseudo_class,
    ) /
      Math.max(1, aw.lang_changed.records.pseudo_class) <=
      0.02,
    true,
  );
  /* And it is `lang`, not `dir` — the other attribute the same Excalidraw
   * line writes. Without this leg the finding would name both and prove
   * neither. */
  chk.check(
    "the storm follows `lang`, not `dir` — a `dir` write costs under 10 records",
    aw.dir_changed.records.pseudo_class < 10,
    true,
  );

  const summary = {
    elements_on_desktop: report.elements_before_canvas,
    attribute_writes: Object.fromEntries(
      Object.entries(aw).map(([k, l]) => [
        k,
        {
          pseudo_class: l.records.pseudo_class,
          elements: l.elements_on_page,
          records_per_element: +(l.records.pseudo_class / l.elements_on_page).toFixed(3),
        },
      ]),
    ),
    phase800_ss9_7_reference: { pseudo_class_records: 4636, elements: 4716 },
    canvas: {
      base: canvasNumbers(report.canvas),
      all_hover_rules_deleted_first: canvasNumbers(report.canvas_neutralised),
      stack_attribution_leg_LOWER_BOUND: canvasNumbers(report.canvas_attribution),
      minimal_categories_truncation_control: canvasNumbers(report.canvas_minimal),
    },
    per_crossing: Object.fromEntries(
      report.pointer_rounds.map((r) => [
        r.round,
        {
          rail_one: {
            pseudo_class: r.legs.rail_one.records.pseudo_class,
            hover_attributed: r.legs.rail_one.records.hover_attributed,
            all_invalidation_records: r.legs.rail_one.records.invalidation_records_total,
          },
          team_one: {
            pseudo_class: r.legs.team_one.records.pseudo_class,
            hover_attributed: r.legs.team_one.records.hover_attributed,
            all_invalidation_records: r.legs.team_one.records.invalidation_records_total,
          },
          sweep30: {
            pseudo_class: r.legs.sweep.records.pseudo_class,
            hover_attributed: r.legs.sweep.records.hover_attributed,
            all_invalidation_records: r.legs.sweep.records.invalidation_records_total,
            per_crossing: r.legs.sweep.records_per_crossing,
          },
        },
      ]),
    ),
  };
  report.summary = summary;

  const out = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "pseudo-invalidation.cjs",
        question:
          "phase800 canvas-perf.md §9.7 — what produces ~4,636 StyleRecalcInvalidationTracking·PseudoClass records, and is it a hover cost or a canvas cost?",
        instrument_caveat:
          "invalidationTracking + stack categories are ON. These are RECORD COUNTS attributing cost. They are NOT milliseconds. §9.8 item 4's top_forcing_frames artifact is not inherited: this file emits no such field.",
        base_url: L.BASE,
        generated_at: new Date().toISOString(),
        crossing_definition:
          "one crossing = pointer moves neutral → row centre → neutral (one enter, one leave)",
        ...report,
        results: chk.results,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n${chk.failed() === 0 ? "ALL PASS" : `${chk.failed()} FAILURE(S)`} → ${out}`);
  console.log(`\nelements on /desktop: ${summary.elements_on_desktop}   (§9.7 saw 4,716)`);
  for (const [k, v] of Object.entries(summary.canvas))
    console.log(
      `canvas ${k.padEnd(30)} PseudoClass ${String(v.pseudo_class_whole_leg).padStart(6)} ` +
        `(click→paint ${String(v.pseudo_class_click_to_paint).padStart(6)}, ` +
        `${v.records_per_element}/element, hover-attributed ${v.hover_attributed})`,
    );
  console.log("\n<html> attribute writes, no canvas, no pointer:");
  for (const [k, v] of Object.entries(summary.attribute_writes))
    console.log(
      `  ${k.padEnd(24)} PseudoClass ${String(v.pseudo_class).padStart(6)}  over ${v.elements} elements  (${v.records_per_element}/element)`,
    );
  console.log("\npointer legs — PseudoClass / hover-attributed / all invalidation records");
  for (const [round, v] of Object.entries(summary.per_crossing))
    console.log(
      `  ${round.padEnd(17)} rail×1 ${`${v.rail_one.pseudo_class}/${v.rail_one.hover_attributed}/${v.rail_one.all_invalidation_records}`.padStart(12)}` +
        `   team×1 ${`${v.team_one.pseudo_class}/${v.team_one.hover_attributed}/${v.team_one.all_invalidation_records}`.padStart(12)}` +
        `   sweep×30 ${`${v.sweep30.pseudo_class}/${v.sweep30.hover_attributed}/${v.sweep30.all_invalidation_records}`.padStart(14)}`,
    );
  if (OUT_DIR !== SRC_DIR) {
    console.log(`\n      committed evidence left untouched (${path.join(SRC_DIR, OUT_FILE)})`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(chk.failed() === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\npseudo-invalidation.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
