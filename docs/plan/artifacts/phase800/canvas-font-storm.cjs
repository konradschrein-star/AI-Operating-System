/**
 * canvas-font-storm.cjs — U31 cause #1, the MECHANISM. Round 808.
 *
 * Four rounds have now measured the same thing. Round 801 named it ("Layout is
 * 149–160 ms over 11 passes, the largest single line item in the trace") and
 * said plainly that it had proved the cost and not the mechanism. Round 803
 * wrote `canvas-layout-probe.cjs` to close that gap and never ran it. Round 806
 * unserialised the bundle fetch, bought real time on a real network, and left
 * the gate red for exactly this reason. This file is round 808's answer.
 *
 * ── WHAT canvas-layout-probe.cjs ALREADY SAID (run at last, this round) ────
 *
 * 13 Layout events, 214.7 ms of self time, and the invalidation histogram is
 * not ambiguous:
 *
 *     16353  LayoutInvalidationTracking · Fonts changed        ← 75 % of all
 *      4624  StyleRecalcInvalidationTracking · PseudoClass
 *       397  LayoutInvalidationTracking · Added to layout
 *       ...
 *
 * and two of the thirteen passes are the whole document at once:
 *
 *     n=11   99.19 ms   dirty 8258 / 8258 objects
 *     n=13   89.27 ms   dirty 8248 / 8256 objects
 *
 * The other eleven passes together cost 26 ms. So "ten layout passes" was
 * always a slightly wrong frame: it is TWO document-wide relayouts, plus
 * noise, and both of them are font invalidations.
 *
 * ── THE HYPOTHESIS THIS FILE TESTS ────────────────────────────────────────
 *
 * Excalidraw 0.18.1 `Fonts.loadFontFaces` (dist/prod/chunk-K2UTITRG.js) walks
 * every registered family and does:
 *
 *     window.document.fonts.has(d) || window.document.fonts.add(d)
 *
 * Mutating the DOCUMENT's FontFaceSet invalidates the document's font
 * selector, and Blink answers that by marking every layout object in the
 * document dirty — `LayoutInvalidationTracking · Fonts changed`, once per
 * object. The cost of that sweep is therefore a PRODUCT of two things:
 *
 *     (a) how many times the font set is mutated during mount   ← Excalidraw's
 *     (b) how many layout objects the document has              ← OURS
 *
 * /desktop carries 8,099 layout objects BEFORE the canvas is opened; the
 * editor itself only adds ~190. That is the part of this cost we own, and it
 * is the part nobody has looked at.
 *
 * Three legs, chosen so each one falsifies a different half of the claim:
 *
 *   L1 desktop-cold   /desktop, first CANVAS click of the page. The real case.
 *   L2 desktop-warm   close, click again on the SAME page. The font faces are
 *                     already in `document.fonts`, so `has()` short-circuits
 *                     the `add()`. If the storm is font-driven it must be GONE
 *                     here — same component, same bundle, same document size.
 *                     If it is still there, the hypothesis is dead.
 *   L3 standalone     a fresh load of `/canvas?path=…`, which mounts the SAME
 *                     `CanvasPane` with the SAME Excalidraw into a document of
 *                     a few hundred layout objects instead of 8,099. Fonts are
 *                     added exactly as coldly as in L1. If the sweep cost
 *                     tracks document size, this leg is cheap; if it is
 *                     intrinsic to Excalidraw, it is just as expensive.
 *
 * L2 and L3 are controls, not fixes. Together they say whether anything on our
 * side of the boundary can move the number at all.
 *
 * ── WHY NOT waitForSelector ───────────────────────────────────────────────
 *
 * `canvas-layout-probe.cjs`'s single largest "forced by JS" frame was
 * `computeBox (…:2765)` at 89.27 ms — which is Playwright's OWN injected
 * `isElementVisible`, called by the `page.waitForSelector('.excalidraw')` in
 * that same file. The instrument was in its own trace.
 *
 * The WORK is real either way: those 8,248 objects were already dirty from the
 * font invalidation and Blink would have laid them out in the next frame
 * regardless. Playwright only pulled the flush earlier and stamped its own
 * name on it. But an artifact that reads as "our tooling forces a 90 ms
 * layout" is exactly the kind of thing a fifth round would chase for a day, so
 * this file waits by polling the page's own `performance.mark` list through
 * `page.evaluate` — which reads no geometry — and never calls a locator wait
 * inside a traced interval. The click itself still goes through a real
 * locator, because a real input event is the point; its actionability check
 * lands BEFORE the `click` mark and therefore outside the measured span.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * Same environment as `canvas-open.cjs` (see its header for the isolated build
 * and the cookie recipe). Round 808 used `/tmp/phase808-canvas` on `:7831`.
 *
 * ```bash
 * cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-808.txt)"
 * export PHASE700_BASE_URL=http://127.0.0.1:7831
 * export PHASE800_OUT_DIR=/tmp/phase808-out
 * for i in 1 2 3 4; do
 *   PHASE800_OUT_FILE=canvas-font-storm-run$i.json \
 *     node docs/plan/artifacts/phase800/canvas-font-storm.cjs
 * done
 * ```
 *
 * n≥4 is not decoration: round 806 documented a 52 % spread inside one tree on
 * this surface, and a single sample here would be worth nothing.
 *
 * ABSOLUTE MILLISECONDS FROM THIS FILE ARE INFLATED and are not the round's
 * numbers — `invalidationTracking` + `stack` make every layout more expensive
 * to record. Quote `canvas-open.cjs` for cost. Quote this file for ATTRIBUTION:
 * pass counts, dirty-object counts, invalidation reasons, and the ratios
 * between the three legs, all of which are measured under identical
 * instrumentation and so compare honestly.
 *
 * NFU8: playwright via `lib-703.cjs` by absolute path. No new dependency.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
process.env.PHASE700_OUT_DIR = OUT_DIR;

const L = require("../phase700/lib-703.cjs");

const OUT_FILE = process.env.PHASE800_OUT_FILE ?? "canvas-font-storm.json";
const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";

/** A pass is "document-wide" when it dirtied essentially everything. The 0.9
 *  is deliberately loose: Blink reports 8258/8258 and 8248/8256 for the two
 *  real ones and 21/8106 for the largest of the incremental ones, so nothing
 *  lives near the threshold and the classification is not a judgement call. */
const FULL_DOC_RATIO = 0.9;

/**
 * The analysis window, measured from the click, and the reason it is not
 * `click → excpaint`.
 *
 * Round 808's first successful run caught the instrument racing the thing it
 * was measuring. Excalidraw asks for its font files when it mounts; the
 * document-wide `Fonts changed` sweep happens when those files LAND. On the
 * `/canvas` leg the fonts landed 235–726 ms in and the editor painted at
 * 917 ms, so the sweep was inside the interval. On the `/desktop` leg the same
 * fonts were requested at 1957–2008 ms and the editor's node appeared at
 * 2239 ms, so the sweep fell *outside* it — and the leg reported zero
 * `Fonts changed` invalidations for an open that demonstrably added 230 font
 * faces to the document.
 *
 * Closing the window on a paint mark therefore measures a RACE, not a cost,
 * and would let a round conclude "the storm is gone" from a build that merely
 * got slower somewhere earlier. The window is a fixed 4 s from the click for
 * every leg; `excdom` and `excpaint` are reported as landmarks INSIDE it, so
 * both readings are available and neither is assumed:
 *
 *   layout_self_ms          all of it, wherever it falls  ← the storm
 *   layout_self_before_paint_ms   the part U31's gate can see
 *
 * A storm that lands 40 ms after the frame that shows the editor is still a
 * 90 ms freeze on Konrad's screen. It just is not a freeze U31 measures.
 */
const WINDOW_MS = 4_000;

/* ── trace ────────────────────────────────────────────────────────────────── */

/**
 * `withInvalidations: false` is the LOW-FIDELITY mode, and it exists to answer
 * one question the high-fidelity legs cannot.
 *
 * Recording invalidations costs one trace event per dirtied layout object —
 * 11,117 of them on a cold /desktop open. That volume overflows the trace
 * buffer during the sweep, and the events emitted after it are dropped,
 * `excpaint` among them. So the leg that proves WHY the storm happens is
 * structurally unable to say WHERE the frame that shows the editor falls
 * relative to it — which is exactly what decides whether U31's click→paint
 * gate can see the storm at all.
 *
 * L4 runs the same cold open with invalidation tracking off. It learns nothing
 * about causes; it keeps a small enough trace that the paint mark survives,
 * at roughly the fidelity `canvas-open.cjs` runs at.
 */
async function startTrace(cdp, sink, { withInvalidations = true } = {}) {
  sink.length = 0;
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      includedCategories: [
        "devtools.timeline",
        "blink.user_timing",
        "disabled-by-default-devtools.timeline",
        ...(withInvalidations
          ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
          : []),
        /* `…timeline.stack` is DELIBERATELY ABSENT, and its absence is a
         * finding rather than an omission. With it on, the cold leg emits
         * >16,000 invalidation records each carrying a JS stack, the trace
         * buffer overflows mid-burst, and Chrome silently drops the events
         * that come after it — including the `excpaint` mark this file uses
         * to close its own interval. The first two runs of round 808 failed
         * exactly there, with `cold:excdom` present and `cold:excpaint` gone.
         *
         * A truncated trace does not announce itself; it just reports fewer
         * layout passes and fewer invalidations than really happened, which
         * on this question is the difference between "two document-wide
         * sweeps" and "one". Stack attribution is already recorded, once,
         * by `canvas-layout-probe.cjs`; this file needs COUNTS, and counts
         * are worthless if the buffer ate half of them. */
      ],
    },
  });
}

async function stopTrace(cdp, sink) {
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end");
  await done;
  await new Promise((r) => setTimeout(r, 500));
  return sink.slice();
}

function findRendererMain(events) {
  const named = events.filter(
    (e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  if (!named.length) throw new Error("no CrRendererMain thread_name metadata in trace");
  let best = null;
  for (const m of named) {
    const n = events.filter((e) => e.pid === m.pid && e.tid === m.tid && e.ph === "X").length;
    if (!best || n > best.n) best = { pid: m.pid, tid: m.tid, n };
  }
  return best;
}

/** Identical to `canvas-layout-probe.cjs`'s reader, including the instant-event
 *  branch — the invalidation records ARE instant events, and an X/B/E-only
 *  reader drops all 16,353 of them and concludes "mechanism not proven". */
function completeEvents(events, pid, tid) {
  const out = [];
  const stacks = [];
  for (const e of events) {
    if (e.pid !== pid || e.tid !== tid) continue;
    if (e.ph === "X") out.push({ name: e.name, ts: e.ts, dur: e.dur ?? 0, args: e.args });
    else if (e.ph === "B") stacks.push(e);
    else if (e.ph === "E") {
      const b = stacks.pop();
      if (b) out.push({ name: b.name, ts: b.ts, dur: e.ts - b.ts, args: b.args ?? e.args });
    } else if (e.ph === "I" || e.ph === "i" || e.ph === "R" || e.ph === "n") {
      out.push({ name: e.name, ts: e.ts, dur: 0, args: e.args, instant: true });
    }
  }
  out.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  return out;
}

function withContext(evts) {
  const stack = [];
  const self = evts.map((e) => e.dur);
  const ancestors = evts.map(() => []);
  for (let i = 0; i < evts.length; i++) {
    const e = evts[i];
    while (
      stack.length &&
      evts[stack[stack.length - 1]].ts + evts[stack[stack.length - 1]].dur <= e.ts
    )
      stack.pop();
    if (stack.length) {
      const p = stack[stack.length - 1];
      if (!e.instant) self[p] -= e.dur;
      ancestors[i] = [...ancestors[p], p];
    }
    if (!e.instant) stack.push(i);
  }
  return evts.map((e, i) => ({ ...e, self: self[i], ancestorIdx: ancestors[i] }));
}

const markTs = (events, label, suffix) => {
  const hit = events.find(
    (e) => e.name === `${label}:${suffix}` && (e.cat ?? "").includes("blink.user_timing"),
  );
  return hit ? hit.ts : null;
};

function stackOf(e) {
  const raw =
    e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? e.args?.stackTrace ?? null;
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 6).map((f) => ({
    fn: f.functionName || "(anonymous)",
    url: typeof f.url === "string" ? f.url.split("/").pop() : null,
    line: f.lineNumber ?? null,
  }));
}

/* ── the in-page probe ────────────────────────────────────────────────────── */

/**
 * `startCycle` exists for L3, where there is no click to observe: the leg's
 * t0 is document-start, stamped here, and the report says so rather than
 * pretending a navigation is a click.
 */
function probeSource(startCycle) {
  return `(() => {
    const cp = { cycle: ${JSON.stringify(startCycle)}, marks: [] };
    window.__cp = cp;
    const mark = (s) => {
      performance.mark(cp.cycle + ":" + s);
      cp.marks.push({ name: s, t: performance.now(), cycle: cp.cycle });
    };
    window.__cpMark = mark;
    if (cp.cycle) mark("click");
    addEventListener("click", (e) => {
      const el = e.target;
      if (!cp.cycle || !(el instanceof Element)) return;
      const b = el.closest("button");
      if (b && (b.textContent || "").trim() === "CANVAS") mark("click");
    }, true);
    let excUp = false;
    const sweep = () => {
      const exc = !!document.querySelector(".excalidraw");
      if (exc !== excUp) {
        excUp = exc;
        if (cp.cycle && exc) {
          mark("excdom");
          requestAnimationFrame(() => requestAnimationFrame(() => mark("excpaint")));
        }
      }
    };
    new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
  })();`;
}

/** Poll the page's own mark list. Reads no geometry, so it cannot appear in
 *  the trace as a forced layout the way `waitForSelector` does. */
async function waitForMark(page, cycle, name, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await page.evaluate(
      ([c, n]) => (window.__cp?.marks ?? []).some((m) => m.cycle === c && m.name === n),
      [cycle, name],
    );
    if (hit) return;
    if (Date.now() > deadline)
      throw new Error(`mark "${cycle}:${name}" never appeared within ${timeoutMs} ms`);
    await page.waitForTimeout(50);
  }
}

const fontState = (page) =>
  page.evaluate(() => ({
    size: document.fonts.size,
    status: document.fonts.status,
    layout_nodes: document.querySelectorAll("*").length,
  }));

/* ── analysis ─────────────────────────────────────────────────────────────── */

function analyse(events, cycle) {
  const main = findRendererMain(events);
  const evts = withContext(completeEvents(events, main.pid, main.tid));

  const t0 = markTs(events, cycle, "click");
  const tPaint = markTs(events, cycle, "excpaint");
  const tDom = markTs(events, cycle, "excdom");
  /* The window is fixed (see WINDOW_MS); the paint marks are landmarks in it,
   * not its edges. `excpaint` may be missing from a trace whose buffer
   * overflowed — that is recorded rather than fatal, because the window does
   * not depend on it. `excdom` is required: without it the leg never mounted
   * the editor at all and there is nothing to attribute. */
  const t1 = t0 === null ? null : t0 + WINDOW_MS * 1000;
  if (t0 === null || tDom === null) {
    /* Name WHICH mark is missing and what the trace did carry. A bare "missing
     * mark" sends the next reader hunting the wrong half of the harness. */
    const seen = [
      ...new Set(
        events
          .filter((e) => (e.cat ?? "").includes("blink.user_timing"))
          .map((e) => e.name),
      ),
    ].slice(0, 30);
    throw new Error(
      `${cycle}: missing ${t0 === null ? "click" : "excdom"} mark in the trace ` +
        `(user_timing names present: ${seen.join(", ") || "none"})`,
    );
  }
  const inSpan = (e) => e.ts >= t0 && e.ts <= t1;

  const raw = evts
    .filter((e) => e.name === "Layout" && inSpan(e))
    .map((e, i) => {
      const bd = e.args?.beginData ?? {};
      const dirty = bd.dirtyObjects ?? null;
      const total = bd.totalObjects ?? null;
      return {
        n: i + 1,
        ms_self: +(Math.max(0, e.self) / 1000).toFixed(2),
        ms_after_t0: +((e.ts - t0) / 1000).toFixed(2),
        dirty_objects: dirty,
        total_objects: total,
        /* Always null while the `stack` category is off — see startTrace. Kept
         * in the shape so a run WITH stacks drops straight into the same
         * reader, and so its emptiness is visible rather than assumed. */
        forced_by_stack: stackOf(e),
        ran_inside: e.ancestorIdx
          .map((i2) => evts[i2].name)
          .filter((n) => n !== "RunTask" && !n.startsWith("ThreadControllerImpl"))
          .slice(-3),
      };
    });

  /**
   * The document this leg is really about. Blink lays out several *other*
   * documents on this page — Next's dev overlay, an SVG sub-document, the
   * Excalidraw font-measurement scratch element — and each of those reports
   * its own tiny `totalObjects` (3, 4, 5). By a bare dirty/total ratio all of
   * them are "100 % of their document" and the count of document-wide passes
   * comes out at 4 when the number that matters is 2. So a sweep must be BOTH
   * essentially-all-dirty AND about the main document, which is the one
   * carrying most of the layout objects on the page.
   */
  const mainDocObjects = Math.max(0, ...raw.map((p) => p.total_objects ?? 0));
  const passes = raw.map((p) => ({
    ...p,
    document_wide:
      p.dirty_objects !== null &&
      !!p.total_objects &&
      p.dirty_objects / p.total_objects >= FULL_DOC_RATIO &&
      p.total_objects >= mainDocObjects / 2,
  }));

  const inval = evts.filter(
    (e) => inSpan(e) && /Invalidat|ScheduleStyleRecalculation/.test(e.name),
  );
  const byReason = {};
  for (const iv of inval) {
    const r = iv.args?.data?.reason ?? iv.args?.reason ?? null;
    const k = `${iv.name}${r ? ` · ${r}` : ""}`;
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  const fontsChanged = inval.filter(
    (e) => (e.args?.data?.reason ?? e.args?.reason) === "Fonts changed",
  );

  /* Font FILE traffic, distinguished from font SET mutation. They are not the
   * same event and conflating them is how "it's just the download" survives. */
  const fontRequests = evts
    .filter(
      (e) =>
        inSpan(e) &&
        e.name === "ResourceSendRequest" &&
        /\.woff2?(\?|$)/.test(e.args?.data?.url ?? ""),
    )
    .map((e) => ({
      ms_after_t0: +((e.ts - t0) / 1000).toFixed(2),
      url: (e.args?.data?.url ?? "").split("/").pop(),
    }));

  const full = passes.filter((p) => p.document_wide);
  const paintAt = tPaint === null ? null : +((tPaint - t0) / 1000).toFixed(2);
  const beforePaint =
    paintAt === null ? [] : passes.filter((p) => p.ms_after_t0 <= paintAt);
  return {
    window_ms: WINDOW_MS,
    excdom_ms_after_click: +((tDom - t0) / 1000).toFixed(2),
    excpaint_ms_after_click: paintAt,
    layout_passes: passes.length,
    layout_self_ms: +passes.reduce((a, b) => a + b.ms_self, 0).toFixed(2),
    /* What U31's click→paint gate can actually see, reported beside the total
     * so the gap between "what it costs" and "what the gate measures" is
     * visible instead of chosen. */
    layout_self_before_paint_ms:
      paintAt === null ? null : +beforePaint.reduce((a, b) => a + b.ms_self, 0).toFixed(2),
    document_wide_passes_before_paint:
      paintAt === null ? null : beforePaint.filter((p) => p.document_wide).length,
    document_wide_passes: full.length,
    document_wide_self_ms: +full.reduce((a, b) => a + b.ms_self, 0).toFixed(2),
    incremental_self_ms: +passes
      .filter((p) => !p.document_wide)
      .reduce((a, b) => a + b.ms_self, 0)
      .toFixed(2),
    /* The denominator of the whole argument: how big is the document that the
     * font sweep has to walk. */
    layout_objects: mainDocObjects,
    fonts_changed_invalidations: fontsChanged.length,
    invalidations_total: inval.length,
    invalidation_by_reason: byReason,
    font_requests: fontRequests.length,
    font_requests_sample: fontRequests.slice(0, 8),
    passes,
  };
}

/* ── the run ──────────────────────────────────────────────────────────────── */

(async () => {
  const chk = L.makeChecker();
  const chat = await L.resolveChat();
  chk.note("fixture", { chat: chat.id, base: L.BASE, drawing: SEED_PATH });

  const legs = {};

  /* Both pages get the same PUT stub for the same reason canvas-open.cjs has
   * one: a diagnosis has no business writing revisions of Konrad's drawing
   * back to the vault. Routing disables the HTTP cache, which is fine here —
   * no leg of this file is a cache claim, and L1/L3 are both cold by design. */
  const stubSave = async (ctx) => {
    await ctx.route("**/api/proxy/canvas/file", async (route) => {
      const req = route.request();
      if (req.method() !== "PUT") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: SEED_PATH, mtime: 1 }),
      });
    });
  };

  /* ── L1 + L2: /desktop, cold open then warm re-open on the SAME page ────── */
  await L.withBrowser(async (ctx) => {
    await stubSave(ctx);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const sink = [];
    cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
    await cdp.send("Network.enable");

    await page.addInitScript({ content: probeSource(null) });
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

    await L.openChat(page);
    await page.waitForTimeout(2_000);

    const canvasBtn = page.getByRole("button", { name: "CANVAS", exact: true });

    /* L1 — cold */
    legs.fonts_before_cold = await fontState(page);
    await page.evaluate(() => {
      window.__cp.cycle = "cold";
      window.__cp.marks = [];
    });
    await startTrace(cdp, sink);
    await page.waitForTimeout(300);
    await canvasBtn.click();
    await waitForMark(page, "cold", "excpaint");
    /* The window is 4 s from the click and the editor can paint 2.2 s in, so
     * the trace has to outlive the paint by more than the paint cost. */
    await page.waitForTimeout(3_500);
    legs.cold = analyse(await stopTrace(cdp, sink), "cold");
    legs.fonts_after_cold = await fontState(page);

    /* close — unmounts the editor entirely, which is what makes the re-open a
     * genuine second mount rather than a re-render */
    await canvasBtn.click();
    await page.waitForTimeout(1_500);

    /* L2 — warm: same page, same document, font faces already registered */
    await page.evaluate(() => {
      window.__cp.cycle = "warm";
      window.__cp.marks = [];
    });
    await startTrace(cdp, sink);
    await page.waitForTimeout(300);
    await canvasBtn.click();
    await waitForMark(page, "warm", "excpaint");
    await page.waitForTimeout(3_500);
    legs.warm = analyse(await stopTrace(cdp, sink), "warm");
    legs.fonts_after_warm = await fontState(page);

    await page.close();
  });

  /* ── L3: the SAME CanvasPane in a small document, cold in every other way ─ */
  await L.withBrowser(async (ctx) => {
    await stubSave(ctx);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const sink = [];
    cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
    await cdp.send("Network.enable");

    await page.addInitScript({ content: probeSource("std") });
    await startTrace(cdp, sink);
    await page.goto(`${L.BASE}/canvas?path=${encodeURIComponent(SEED_PATH)}`, {
      waitUntil: "commit",
      timeout: 60_000,
    });
    if (page.url().includes("/signin"))
      throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
    await waitForMark(page, "std", "excpaint");
    await page.waitForTimeout(3_500);
    legs.standalone = analyse(await stopTrace(cdp, sink), "std");
    legs.fonts_after_standalone = await fontState(page);
    await page.close();
  });

  /* ── L4: the same cold open, traced cheaply enough that `excpaint` lives ── */
  await L.withBrowser(async (ctx) => {
    await stubSave(ctx);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const sink = [];
    cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
    await cdp.send("Network.enable");

    await page.addInitScript({ content: probeSource(null) });
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

    await L.openChat(page);
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      window.__cp.cycle = "lofi";
      window.__cp.marks = [];
    });
    await startTrace(cdp, sink, { withInvalidations: false });
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "CANVAS", exact: true }).click();
    await waitForMark(page, "lofi", "excpaint");
    await page.waitForTimeout(3_500);
    legs.cold_lowfi = analyse(await stopTrace(cdp, sink), "lofi");
    await page.close();
  });

  const { cold, warm, standalone, cold_lowfi: lofi } = legs;

  /* ── the verdict, stated as falsifiable checks ───────────────────────────── */

  const legNote = (l) => ({
    layout_objects: l.layout_objects,
    passes: l.layout_passes,
    document_wide_passes: l.document_wide_passes,
    layout_self_ms: l.layout_self_ms,
    document_wide_self_ms: l.document_wide_self_ms,
    fonts_changed: l.fonts_changed_invalidations,
    excdom_ms: l.excdom_ms_after_click,
    excpaint_ms: l.excpaint_ms_after_click,
    layout_self_before_paint_ms: l.layout_self_before_paint_ms,
  });
  chk.note("L1 cold  /desktop", legNote(cold));
  chk.note("L2 warm  /desktop (2nd open, same page)", legNote(warm));
  chk.note("L3 cold  /canvas standalone", legNote(standalone));
  chk.note("L4 cold  /desktop, invalidation tracking OFF", legNote(lofi));
  chk.note("document.fonts.size", {
    before_cold: legs.fonts_before_cold.size,
    after_cold: legs.fonts_after_cold.size,
    after_warm: legs.fonts_after_warm.size,
    standalone_after: legs.fonts_after_standalone.size,
  });
  chk.note("DOM elements on the page", {
    desktop_before_canvas: legs.fonts_before_cold.layout_nodes,
    desktop_after_canvas: legs.fonts_after_cold.layout_nodes,
    standalone: legs.fonts_after_standalone.layout_nodes,
  });

  /* 1. Excalidraw's mount really does mutate the document's font set, and by a
   *    lot. This is the trigger; everything below is its consequence. */
  chk.check(
    "the cold open adds >100 font faces to document.fonts",
    legs.fonts_after_cold.size - legs.fonts_before_cold.size > 100,
    true,
  );
  /* 2. …and Blink answers by dirtying the whole document, once per object. */
  chk.check(
    "'Fonts changed' is the largest LAYOUT invalidation reason on the cold open",
    Object.entries(cold.invalidation_by_reason)
      .filter(([k]) => k.startsWith("LayoutInvalidationTracking"))
      .sort((a, b) => b[1] - a[1])[0][0]
      .includes("Fonts changed"),
    true,
  );
  /* 3. The result is document-wide relayout, and it is where the time goes.
   *    "Ten layout passes" was always a slightly wrong frame: it is a couple
   *    of whole-document sweeps plus a dozen cheap incremental ones. */
  chk.check(
    "cold open contains at least one DOCUMENT-WIDE layout pass",
    cold.document_wide_passes >= 1,
    true,
  );
  chk.check(
    "document-wide passes are the majority of cold layout self time",
    cold.document_wide_self_ms > cold.incremental_self_ms,
    true,
  );
  /* 4. THE decisive control. Same component, same bundle, same 8k-object
   *    document, same code path — the only difference is that document.fonts
   *    is already populated, so `has()` short-circuits every `add()`. If the
   *    storm survives this, the font hypothesis is dead and this round has to
   *    say so out loud. */
  chk.check(
    "warm re-open on the same page emits no 'Fonts changed' invalidations",
    warm.fonts_changed_invalidations,
    0,
  );
  chk.check(
    "warm re-open has NO document-wide layout pass",
    warm.document_wide_passes,
    0,
  );
  chk.check(
    "warm re-open costs a fraction of the cold open's layout time",
    warm.layout_self_ms < cold.layout_self_ms / 2,
    true,
  );
  /* 4b. Where the storm falls relative to the frame that shows the editor.
   *     Not a pass/fail on the app — a recording of which side of U31's gate
   *     the cost lands on, taken at a fidelity where the paint mark survives. */
  chk.note("L4 storm vs paint", {
    excpaint_ms: lofi.excpaint_ms_after_click,
    layout_self_ms_total: lofi.layout_self_ms,
    layout_self_ms_before_paint: lofi.layout_self_before_paint_ms,
    document_wide_passes_total: lofi.document_wide_passes,
    document_wide_passes_before_paint: lofi.document_wide_passes_before_paint,
  });
  chk.check(
    "L4 reproduces the document-wide sweep with invalidation tracking off (so it is not an artifact of the instrument)",
    lofi.document_wide_passes >= 1,
    true,
  );

  /* 5. The other half of the product: the sweep's price is set by OUR document
   *    size. `/canvas` mounts the identical editor and pays the identical cold
   *    font registration into a document ~35x smaller. */
  chk.check(
    "the standalone route's document is far smaller than /desktop's",
    standalone.layout_objects * 4 < cold.layout_objects,
    true,
  );
  chk.check(
    "…and it registers the same fonts (so the difference is size, not path)",
    standalone.fonts_changed_invalidations > 0,
    true,
  );
  chk.check(
    "…and its cold font sweep costs proportionally less layout time",
    standalone.layout_self_ms < cold.layout_self_ms / 2,
    true,
  );

  const out = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "canvas-font-storm.cjs",
        requirement:
          "U31 cause #1 — the mechanism behind the layout storm on Excalidraw mount",
        base_url: L.BASE,
        build_dir: process.env.PHASE800_BUILD_DIR ?? null,
        generated_at: new Date().toISOString(),
        note: "milliseconds here are INFLATED by invalidationTracking+stack. Ratios between legs are the finding; absolute cost belongs to canvas-open.cjs.",
        legs,
        results: chk.results,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n${chk.failed() === 0 ? "ALL PASS" : `${chk.failed()} FAILURE(S)`} → ${out}`);
  console.log(
    `\n  leg          objects   passes  doc-wide   layout ms   'Fonts changed'   paint@\n` +
      `  cold          ${String(cold.layout_objects).padStart(6)}   ${String(cold.layout_passes).padStart(5)}   ${String(cold.document_wide_passes).padStart(7)}   ${cold.layout_self_ms.toFixed(2).padStart(9)}   ${String(cold.fonts_changed_invalidations).padStart(6)}   ${String(cold.excpaint_ms_after_click).padStart(7)}\n` +
      `  warm          ${String(warm.layout_objects).padStart(6)}   ${String(warm.layout_passes).padStart(5)}   ${String(warm.document_wide_passes).padStart(7)}   ${warm.layout_self_ms.toFixed(2).padStart(9)}   ${String(warm.fonts_changed_invalidations).padStart(6)}   ${String(warm.excpaint_ms_after_click).padStart(7)}\n` +
      `  cold-lowfi    ${String(lofi.layout_objects).padStart(6)}   ${String(lofi.layout_passes).padStart(5)}   ${String(lofi.document_wide_passes).padStart(7)}   ${lofi.layout_self_ms.toFixed(2).padStart(9)}   ${"n/a".padStart(6)}   ${String(lofi.excpaint_ms_after_click).padStart(7)}\n` +
      `  standalone    ${String(standalone.layout_objects).padStart(6)}   ${String(standalone.layout_passes).padStart(5)}   ${String(standalone.document_wide_passes).padStart(7)}   ${standalone.layout_self_ms.toFixed(2).padStart(9)}   ${String(standalone.fonts_changed_invalidations).padStart(6)}   ${String(standalone.excpaint_ms_after_click).padStart(7)}`,
  );
  process.exit(chk.failed() === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\ncanvas-font-storm.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
