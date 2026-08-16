/**
 * canvas-layout-probe.cjs — U31 cause #1: WHAT forces eleven layout passes?
 *
 * PHASE 800, round 803. Round 801 proved the COST of layout on Excalidraw's
 * mount (149–160 ms of `Layout` self time over 11 passes, the largest single
 * line item in the trace) and was explicit that it had NOT proved the
 * MECHANISM. The operator's instruction for this round was equally explicit:
 *
 *     "Diagnose first — what forces 11 passes, who reads geometry during
 *      mount, is something measuring in a loop — and write the mechanism down
 *      BEFORE changing code. A guessed layout fix is worse than none."
 *
 * So this file changes nothing and fixes nothing. It answers three questions
 * with trace evidence, or reports that it could not:
 *
 *   Q1  How many `Layout` events are there really, and how big is each?
 *   Q2  For each one, WHO ran it — the JS stack that forced it, or the frame
 *       that scheduled it. This is the question round 801 left open.
 *   Q3  What invalidated the layout tree beforehand, and for what reason?
 *
 * ── WHY THIS IS A SEPARATE FILE ───────────────────────────────────────────
 *
 * `canvas-open.cjs` is the round's BEFORE/AFTER instrument and must run
 * UNCHANGED across both legs, or the comparison is not one. Diagnosis needs
 * two extra trace categories that materially change what the renderer does:
 *
 *   disabled-by-default-devtools.timeline.invalidationTracking
 *   disabled-by-default-devtools.timeline.stack
 *
 * Stack capture in particular makes every layout more expensive to record, so
 * the ABSOLUTE numbers this file prints are inflated and are NOT the round's
 * numbers. They are here to attribute cost, not to measure it. Anyone quoting
 * a millisecond figure out of this file instead of out of canvas-open.cjs is
 * quoting the wrong instrument.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * Same environment as canvas-open.cjs (see its header for the isolated build
 * and cookie recipe). Then:
 *
 * ```bash
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-803.txt)"
 * export PHASE700_BASE_URL=http://127.0.0.1:7815      # the build under test
 * export PHASE800_OUT_DIR=/tmp/phase803-out
 * node docs/plan/artifacts/phase800/canvas-layout-probe.cjs
 * ```
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

const OUT_FILE = process.env.PHASE800_OUT_FILE ?? "canvas-layout-probe.json";
const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";
/** Kept in step with canvas-open.cjs deliberately — see that file's long note
 *  on why round 803 had to replace round 801's `45%` selector. */
const PANE_SEL = 'div[style*="min-width: 320px"]';

/* ── trace ────────────────────────────────────────────────────────────────── */

async function startTrace(cdp, sink) {
  sink.length = 0;
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordAsMuchAsPossible",
      includedCategories: [
        "devtools.timeline",
        "blink.user_timing",
        "disabled-by-default-devtools.timeline",
        /* The two categories that make this file a diagnosis rather than
         * another measurement. */
        "disabled-by-default-devtools.timeline.invalidationTracking",
        "disabled-by-default-devtools.timeline.stack",
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
      /* Instant events carry the invalidation records. They have no duration
       * and would be dropped by an X/B/E-only reader — which is precisely how
       * a round concludes "mechanism not proven". */
      out.push({ name: e.name, ts: e.ts, dur: 0, args: e.args, instant: true });
    }
  }
  out.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  return out;
}

/** Self time = own duration minus DIRECT children, with the enclosing stack
 *  kept so a Layout can name the JS frame it ran inside. */
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

/** Flatten whatever shape this Chrome puts a stack trace in. Chrome has moved
 *  this between `args.beginData.stackTrace`, `args.data.stackTrace` and
 *  `args.stackTrace` across versions; checking all three is cheaper than
 *  pinning a version and silently reporting "no stack". */
function stackOf(e) {
  const raw =
    e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? e.args?.stackTrace ?? null;
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 8).map((f) => ({
    fn: f.functionName || "(anonymous)",
    url: typeof f.url === "string" ? f.url.split("/").pop() : null,
    line: f.lineNumber ?? null,
  }));
}

/* ── the probe ────────────────────────────────────────────────────────────── */

function probeSource(paneSel) {
  return `(() => {
    const PANE = ${JSON.stringify(paneSel)};
    const cp = { cycle: null, marks: [] };
    window.__cp = cp;
    const mark = (s) => {
      performance.mark(cp.cycle + ":" + s);
      cp.marks.push({ name: s, t: performance.now(), cycle: cp.cycle });
    };
    addEventListener("click", (e) => {
      const el = e.target;
      if (!cp.cycle || !(el instanceof Element)) return;
      const b = el.closest("button");
      if (b && (b.textContent || "").trim() === "CANVAS") mark("click");
    }, true);
    let paneUp = false, excUp = false;
    const sweep = () => {
      const pane = !!document.querySelector(PANE);
      if (pane !== paneUp) { paneUp = pane; if (cp.cycle && pane) mark("dom"); }
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

(async () => {
  const chk = L.makeChecker();
  const chat = await L.resolveChat();
  chk.note("fixture", { chat: chat.id, base: L.BASE, drawing: SEED_PATH });

  let report = null;

  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const sink = [];
    cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
    await cdp.send("Network.enable");

    await page.addInitScript({ content: probeSource(PANE_SEL) });
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

    /* Same reason canvas-open.cjs routes it: a diagnosis has no business
     * writing 2 revisions of Konrad's drawing back to the vault. */
    await page.route("**/api/proxy/canvas/file", async (route) => {
      const req = route.request();
      if (req.method() !== "PUT") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: SEED_PATH, mtime: 1 }),
      });
    });

    await L.openChat(page);
    await page.waitForTimeout(2_000);

    await page.evaluate(() => {
      window.__cp.cycle = "diag";
      window.__cp.marks = [];
    });
    await startTrace(cdp, sink);
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "CANVAS", exact: true }).click();
    await page.waitForSelector(".excalidraw", { timeout: 30_000 });
    await page.waitForTimeout(2_500);
    const events = await stopTrace(cdp, sink);

    const main = findRendererMain(events);
    const evts = withContext(completeEvents(events, main.pid, main.tid));

    const t0 = markTs(events, "diag", "click");
    const t1 = markTs(events, "diag", "excpaint");
    if (t0 === null || t1 === null)
      throw new Error("diag: missing click/excpaint mark — probe never saw the open");

    const inSpan = (e) => e.ts >= t0 && e.ts <= t1;

    /* Q1 + Q2 — every Layout in the interval, with what it ran inside. */
    const layouts = evts
      .filter((e) => e.name === "Layout" && inSpan(e))
      .map((e, i) => {
        const bd = e.args?.beginData ?? {};
        return {
          n: i + 1,
          ms_total: +(e.dur / 1000).toFixed(2),
          ms_self: +(Math.max(0, e.self) / 1000).toFixed(2),
          ms_after_click: +((e.ts - t0) / 1000).toFixed(2),
          dirty_objects: bd.dirtyObjects ?? null,
          total_objects: bd.totalObjects ?? null,
          partial_layout: bd.partialLayout ?? null,
          /* THE answer to "who forced this". A stack here means synchronous
           * JS read geometry and Blink had to lay out to answer it. No stack
           * means the layout came from the normal frame lifecycle. */
          forced_by_stack: stackOf(e),
          /* The enclosing trace events, innermost last — a Layout inside a
           * FunctionCall is forced; one inside a frame's UpdateLayerTree is
           * scheduled. */
          ran_inside: e.ancestorIdx
            .map((i2) => evts[i2].name)
            .filter((n) => n !== "RunTask" && !n.startsWith("ThreadControllerImpl"))
            .slice(-4),
        };
      });

    /* Q3 — what dirtied the tree, and why Blink says it did. */
    const invalidations = evts
      .filter(
        (e) =>
          inSpan(e) &&
          /Invalidat|ScheduleStyleRecalculation|StyleRecalcInvalidationTracking/.test(e.name),
      )
      .map((e) => ({
        name: e.name,
        ms_after_click: +((e.ts - t0) / 1000).toFixed(2),
        reason: e.args?.data?.reason ?? e.args?.reason ?? null,
        node: e.args?.data?.nodeName ?? e.args?.nodeName ?? null,
        stack: stackOf(e),
      }));

    const reasonCounts = {};
    for (const iv of invalidations) {
      const k = `${iv.name}${iv.reason ? ` · ${iv.reason}` : ""}`;
      reasonCounts[k] = (reasonCounts[k] ?? 0) + 1;
    }

    /* Which JS frames forced layout at all, ranked by the cost they caused. */
    const byForcer = new Map();
    for (const l of layouts) {
      if (!l.forced_by_stack?.length) continue;
      const top = l.forced_by_stack[0];
      const k = `${top.fn} (${top.url ?? "?"}:${top.line ?? "?"})`;
      const acc = byForcer.get(k) ?? { frame: k, count: 0, ms_self: 0 };
      acc.count++;
      acc.ms_self += l.ms_self;
      byForcer.set(k, acc);
    }

    const forcedCount = layouts.filter((l) => l.forced_by_stack?.length).length;

    report = {
      interval: {
        click_to_excalidraw_paint_ms: +((t1 - t0) / 1000).toFixed(2),
        note: "categories invalidationTracking + stack are ON — these ms are INFLATED by instrumentation and are not the round's numbers. Attribution only.",
      },
      layout: {
        count: layouts.length,
        total_self_ms: +layouts.reduce((a, b) => a + b.ms_self, 0).toFixed(2),
        forced_by_js_count: forcedCount,
        scheduled_count: layouts.length - forcedCount,
        top_forcing_frames: [...byForcer.values()]
          .map((a) => ({ ...a, ms_self: +a.ms_self.toFixed(2) }))
          .sort((a, b) => b.ms_self - a.ms_self)
          .slice(0, 10),
        passes: layouts,
      },
      invalidation: {
        count: invalidations.length,
        by_reason: reasonCounts,
        sample: invalidations.slice(0, 40),
      },
      trace_events: events.length,
    };

    chk.check("the probe captured the open (click→excalidraw paint)", t1 > t0, true);
    chk.check("at least one Layout was recorded in the interval", layouts.length > 0, true);
    /* Not a pass/fail on the app — a pass/fail on whether this file ANSWERED
     * its question. A run with no stacks anywhere has diagnosed nothing, and
     * must say so instead of shipping an empty table as a finding. */
    chk.check(
      "stack attribution is available (otherwise this probe proved nothing and the mechanism stays open)",
      layouts.some((l) => l.forced_by_stack?.length) ||
        invalidations.some((i) => i.stack?.length),
      true,
    );

    await page.close();
  });

  const out = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "canvas-layout-probe.cjs",
        requirement: "U31 cause #1 — mechanism behind the layout passes on Excalidraw mount",
        base_url: L.BASE,
        generated_at: new Date().toISOString(),
        ...report,
        results: chk.results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${chk.failed() === 0 ? "ALL PASS" : `${chk.failed()} FAILURE(S)`} → ${out}`);
  console.log(
    `\nLayout passes: ${report.layout.count} (${report.layout.forced_by_js_count} forced by JS, ${report.layout.scheduled_count} scheduled)`,
  );
  for (const f of report.layout.top_forcing_frames)
    console.log(`   ${f.ms_self.toFixed(2).padStart(8)} ms  ×${f.count}  ${f.frame}`);
  process.exit(chk.failed() === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\ncanvas-layout-probe.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
