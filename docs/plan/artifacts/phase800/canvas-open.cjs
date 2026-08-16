/**
 * canvas-open.cjs — U31 BEFORE trace: what does opening the canvas cost?
 *
 * PHASE 800, round 801. This round MEASURES. It changes no application code;
 * round 803 fixes whatever this finds. `docs/plan/12-ui-v3-requirements.md`
 * U31 gates at **"open > 100ms scripting"**, so the number that decides the
 * gate is *scripting time on the renderer main thread between the click on the
 * CANVAS button and the frame that first paints the pane*. Everything below
 * exists to produce that number honestly, twice, from a build nobody was
 * editing while it ran.
 *
 * ── WHAT IS REAL HERE ─────────────────────────────────────────────────────
 *
 * Nothing is stubbed, injected or rewritten. The harness clicks the real
 * button in a real Chromium against a real Next production build of committed
 * HEAD, talking to the worktree API on :7798. The ONLY things this file adds
 * to the page are (a) an inert observer that calls `performance.mark()` and
 * (b) a `localStorage` seed of `forge.canvasByRun` — which is the app's OWN
 * persistence key, written the same way the app writes it when Konrad picks a
 * drawing. No response is routed, no module is patched.
 *
 * ── WHY FOUR SCENARIOS AND NOT ONE ────────────────────────────────────────
 *
 * `ChatSurface.tsx:883` mounts `<CanvasPane>` on toggle, but `CanvasPane.tsx`
 * only renders `<Excalidraw>` once BOTH `path` and the loaded scene exist
 * (`CanvasPane.tsx:626-645`). `path` comes from `localStorage["forge.canvasByRun"]`
 * (`ChatSurface.tsx:367-392`), per chat. So "opening the canvas" is two
 * different events:
 *
 *   S1 empty          first-ever open on a chat — no drawing remembered.
 *                     Konrad sees "no drawing open — pick one above".
 *   S2 drawing        every open after he has picked one — the remembered path
 *                     is loaded and the Excalidraw editor mounts. This is the
 *                     steady state, and the one the brief suspects.
 *   S3 drawing-nocache  S2 with `Network.setCacheDisabled(true)` for the whole
 *                     scenario. Answers "your number is just a cold cache".
 *   S4 drawing-reload   open once (chunks fetched), close, RELOAD the page with
 *                     the cache ON, open again. Warm HTTP cache, cold JS
 *                     module graph — the case a "just re-parse it" objection
 *                     lives in.
 *
 * Measuring only one of these and calling it "the canvas open cost" is how a
 * fix round optimises the wrong path.
 *
 * ── HOW THE NUMBER IS COMPUTED (auditable, not a black box) ───────────────
 *
 * Per cycle the page emits four `performance.mark`s — `click`, `dom`,
 * `paint`, and (when it mounts) `excdom` / `excpaint`. `paint` is stamped in a
 * double-rAF after the pane node enters the DOM, i.e. after the frame that
 * showed it. Those marks land in the trace as `blink.user_timing` events, in
 * the SAME clock as every other trace event, so the interval needs no clock
 * conversion.
 *
 * Inside `[click, paint]` on `CrRendererMain` this file computes, from a CDP
 * `devtools.timeline` trace:
 *
 *   scripting_ms          sum of SELF time of events DevTools buckets as
 *                         "Scripting", clipped to the interval. Self time =
 *                         own duration minus direct children, so nesting is
 *                         never double-counted. The full name→bucket map is
 *                         `EVENT_BUCKET` below — it is in the artifact so a
 *                         reviewer can argue with it rather than trust it.
 *   scripting_toplevel_ms sum of the FULL duration of script events that have
 *                         no script ancestor. Reported beside the self-time
 *                         figure precisely so a gap between the two is visible
 *                         instead of hidden behind whichever is convenient.
 *   longest_task_ms       longest top-level task overlapping the interval.
 *   main_thread_busy_ms   all top-level task time clipped to the interval.
 *   requests[]            every resource whose request was sent inside the
 *                         interval, with the bytes `ResourceFinish` reports
 *                         and — for .js under /_next/static/chunks — whether
 *                         that chunk file contains the string "excalidraw",
 *                         read off the build directory. Hashed chunk names
 *                         mean nothing on their own.
 *
 * ── REPRODUCE (runnable; ports and cookie exactly as round 801 used them) ──
 *
 * ```bash
 * cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
 * set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *
 * # A) worktree API on :7798. NEVER boot forge-control/src/index.ts on any
 * #    port (cron tick + Telegram bridge + vault sync against LIVE). Skip if up:
 * curl -s 127.0.0.1:7798/api/health >/dev/null || \
 *   (cd forge-control && nohup ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts \
 *      > /tmp/phase800-api-7798.log 2>&1 &)
 *
 * # B) a DETERMINISTIC copy of committed HEAD — immune to builders editing
 * #    ChatSurface.tsx / api.ts in the worktree while this runs. The sha this
 * #    round measured is recorded in canvas-open-before.json as `head_sha`.
 * rm -rf /tmp/phase800-canvas-before && mkdir -p /tmp/phase800-canvas-before
 * git archive HEAD | tar -x -C /tmp/phase800-canvas-before
 * git rev-parse HEAD > /tmp/phase800-head-sha.txt      # ← names the baseline
 * ln -s "$(pwd)/forge-control-web/node_modules" \
 *       /tmp/phase800-canvas-before/forge-control-web/node_modules
 * cd /tmp/phase800-canvas-before/forge-control-web
 * FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
 * grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 7798
 * #    NEVER rebuild the worktree's own forge-control-web/.next — other rounds
 * #    are serving out of it.
 *
 * # C) mint the session cookie from inside the copy (/desktop is behind OAuth)
 * cat > mint-cookie.mjs <<'EOF'
 * import { encode } from "next-auth/jwt";
 * const name = "authjs.session-token";
 * console.log(await encode({ token: { name: "phase800 round801 evidence", email: "check@localhost",
 *   sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 300 }));
 * EOF
 * set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 * node ./mint-cookie.mjs > /tmp/session-cookie-801.txt && rm mint-cookie.mjs
 *
 * # D) serve on a FREE port at/above 7811. Never kill another round's server.
 * AUTH_URL=http://127.0.0.1:7811 FORGE_CONTROL_URL=http://127.0.0.1:7798 \
 *   AUTH_SECRET="$AUTH_SECRET" nohup ./node_modules/.bin/next start -p 7811 \
 *   > /tmp/phase800-web-7811.log 2>&1 &
 *
 * # E) run THIS file from the worktree. Non-destructive by default (phase 700
 * #    round 705 convention): writes /tmp/phase800-out/, `git status` stays
 * #    clean. `--write` re-records in place, which is what round 801 did.
 * cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-801.txt)"
 * export PHASE700_BASE_URL=http://127.0.0.1:7811
 * export PHASE800_BUILD_DIR=/tmp/phase800-canvas-before/forge-control-web/.next
 * node docs/plan/artifacts/phase800/canvas-open.cjs            # ~6 min
 * git status --porcelain                                       # ← empty
 * ```
 *
 * A second, independent run (the reproducibility leg this round attaches) is
 * the same command with `PHASE800_OUT_FILE=canvas-open-before-run2.json`.
 *
 * NFU8: playwright is reached through `lib-703.cjs`, by absolute path out of
 * /opt/hermes-workspace. Neither repo gains a dependency.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * ROUND 705's NON-DESTRUCTIVE CONVENTION, with one constant NOT borrowed.
 *
 * `lib-703.cjs` derives its `SRC_DIR` from its own `__dirname` — correct for
 * phase 700's protocols, which live beside it, and wrong for a sibling phase:
 * `finish("canvas-open-before.json")` under `--write` would drop this round's
 * artifact into `docs/plan/artifacts/phase700/`. So the OUT_DIR the library
 * computes is steered here, before it is required, and `finish800` below is a
 * verbatim re-statement of `L.finish` against phase 800's own directory.
 * The convention is honoured; the constant is not inherited.
 */
const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
/* Keep the library's own OUT_DIR in step, so anything it writes lands here
 * too rather than in phase700's committed evidence. */
process.env.PHASE700_OUT_DIR = OUT_DIR;

const L = require("../phase700/lib-703.cjs");

/** `L.finish`, retargeted at phase 800. Same stdout, same exit code. */
function finish800(fileName, payload, failures) {
  const out = path.join(OUT_DIR, fileName);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} → ${out}`);
  if (OUT_DIR !== SRC_DIR) {
    console.log(`      committed evidence left untouched (${path.join(SRC_DIR, fileName)})`);
    console.log(`      diff -u "${path.join(SRC_DIR, fileName)}" "${out}"`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** The sha of the tree that was archived, built and served. Written by README
 *  step B; an env var wins so a reviewer can name a baseline explicitly. */
function headSha() {
  if (process.env.PHASE800_HEAD_SHA) return process.env.PHASE800_HEAD_SHA.trim();
  const f = "/tmp/phase800-head-sha.txt";
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error(
    "no baseline sha — set PHASE800_HEAD_SHA or run `git rev-parse HEAD > /tmp/phase800-head-sha.txt` beside the archive (README §2 step B)",
  );
}

/* ── knobs ────────────────────────────────────────────────────────────────── */

/** U31's gate, in ms of main-thread scripting on the click→paint interval. */
const GATE_SCRIPTING_MS = 100;

/** Cycles per scenario. The brief asks for N>=5; 6 leaves five warm samples
 *  after the cold one is pulled out and reported on its own. */
const CYCLES = 6;

/** The build whose hashed chunk names get resolved to contents. */
const BUILD_DIR =
  process.env.PHASE800_BUILD_DIR ??
  "/tmp/phase800-canvas-before/forge-control-web/.next";

/** The drawing S2/S3/S4 remember. Deliberately the SMALLEST real canvas in the
 *  vault (531 bytes, `GET /api/canvas/list`), so the number this round reports
 *  is the cost of the EDITOR, not of somebody's 500 KB scene. A big scene only
 *  makes it worse; measuring the floor keeps the finding unarguable. */
const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";

const OUT_FILE = process.env.PHASE800_OUT_FILE ?? "canvas-open-before.json";

/** The pane wrapper `ChatSurface.tsx:884` renders around <CanvasPane>. React
 *  emits the inline style verbatim, and `1 1 45%` appears nowhere else in the
 *  surface (the chat column next to it is `1 1 55%`). Asserted at run time by
 *  `check("pane selector matches exactly one node while open")`. */
const PANE_SEL = 'div[style*="45%"]';

/* ── the trace-event → DevTools bucket map ────────────────────────────────── */

/**
 * Named rather than inferred, so the scripting figure can be audited line by
 * line. Anything not in here contributes its self time to `other_ms`, which is
 * reported per cycle — if `other_ms` were ever large it would mean this map is
 * missing something, and that is visible instead of silently folded into
 * whichever bucket flattered the verdict.
 */
const EVENT_BUCKET = {
  /* Scripting */
  FunctionCall: "scripting",
  EvaluateScript: "scripting",
  "v8.evaluateModule": "scripting",
  "v8.compile": "scripting",
  "v8.compileModule": "scripting",
  "v8.parseOnBackground": "scripting",
  "v8.produceCache": "scripting",
  "v8.deserializeOnBackground": "scripting",
  StreamingCompileScript: "scripting",
  TimerFire: "scripting",
  TimerInstall: "scripting",
  TimerRemove: "scripting",
  FireAnimationFrame: "scripting",
  RequestAnimationFrame: "scripting",
  CancelAnimationFrame: "scripting",
  FireIdleCallback: "scripting",
  RequestIdleCallback: "scripting",
  XHRReadyStateChange: "scripting",
  XHRLoad: "scripting",
  EventDispatch: "scripting",
  RunMicrotasks: "scripting",
  ProfileCall: "scripting",
  MajorGC: "scripting",
  MinorGC: "scripting",
  GCEvent: "scripting",
  "V8.GCFinalizeMC": "scripting",
  "V8.GCScheduleIdleGC": "scripting",
  BlinkGC: "scripting",
  "BlinkGC.AtomicPhase": "scripting",
  /* Rendering */
  ScheduleStyleRecalculation: "rendering",
  RecalculateStyles: "rendering",
  UpdateLayoutTree: "rendering",
  InvalidateLayout: "rendering",
  Layout: "rendering",
  UpdateLayerTree: "rendering",
  HitTest: "rendering",
  PrePaint: "rendering",
  Layerize: "rendering",
  ComputeIntersections: "rendering",
  /* Painting */
  Paint: "painting",
  PaintImage: "painting",
  RasterTask: "painting",
  CompositeLayers: "painting",
  Commit: "painting",
  DecodeImage: "painting",
  "Decode Image": "painting",
  ResizeImage: "painting",
  GPUTask: "painting",
  DrawFrame: "painting",
  /* Loading */
  ParseHTML: "loading",
  ParseAuthorStyleSheet: "loading",
  ResourceWillSendRequest: "loading",
  ResourceSendRequest: "loading",
  ResourceReceiveResponse: "loading",
  ResourceReceivedData: "loading",
  ResourceFinish: "loading",
  ResourceMarkAsCached: "loading",
};

/** Top-level task wrappers. Their own self time is "other"; their duration is
 *  what `longest_task_ms` and `main_thread_busy_ms` are made of. */
const TOPLEVEL = new Set([
  "RunTask",
  "ThreadControllerImpl::RunTask",
  "ThreadControllerImpl::DoWork",
  "MessageLoop::RunTask",
  "TaskQueueManager::ProcessTaskFromWorkQueue",
]);

/* ── the in-page probe ────────────────────────────────────────────────────── */

/**
 * Installed with `addInitScript`, so it is in place before any app module runs
 * and survives the reload S4 needs. It observes and stamps; it never touches
 * app state.
 *
 * `paint` is a DOUBLE rAF after the mutation: the first callback runs before
 * the frame that renders the new node, the second after it has been committed.
 * A single rAF would report the frame the pane was scheduled in, not the frame
 * it was visible in — about one vsync of free credit.
 */
function probeSource(paneSel) {
  return `(() => {
    const PANE = ${JSON.stringify(paneSel)};
    const cp = { cycle: null, marks: [] };
    window.__cp = cp;
    const mark = (suffix) => {
      const name = cp.cycle + ":" + suffix;
      performance.mark(name);
      cp.marks.push({ name: suffix, t: performance.now(), cycle: cp.cycle });
    };
    addEventListener("click", (e) => {
      const el = e.target;
      if (!cp.cycle || !(el instanceof Element)) return;
      const b = el.closest("button");
      if (b && (b.textContent || "").trim() === "CANVAS") mark("click");
    }, true);
    let paneUp = false;
    let excUp = false;
    const sweep = () => {
      const pane = !!document.querySelector(PANE);
      if (pane !== paneUp) {
        paneUp = pane;
        if (cp.cycle) {
          mark(pane ? "dom" : "gone");
          const which = pane ? "paint" : "closepaint";
          requestAnimationFrame(() => requestAnimationFrame(() => mark(which)));
        }
      }
      const exc = !!document.querySelector(".excalidraw");
      if (exc !== excUp) {
        excUp = exc;
        if (cp.cycle && exc) {
          mark("excdom");
          requestAnimationFrame(() => requestAnimationFrame(() => mark("excpaint")));
        }
      }
    };
    /* "document", not "document.documentElement": an init script runs at
     * document-start, where documentElement is still null and observe(null, …)
     * throws — after the click listener is already registered. The first run of
     * this protocol recorded a click mark and no dom/paint mark for exactly
     * that reason, and the failure looked like a missing UserTiming category
     * rather than a dead observer. "document" always exists, and subtree:true
     * reaches the same nodes. */
    new MutationObserver(sweep).observe(document, { childList: true, subtree: true });
  })();`;
}

/* ── trace plumbing ──────────────────────────────────────────────────────── */

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
      ],
    },
  });
}

async function stopTrace(cdp, sink) {
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  /* `dataCollected` is delivered as a burst; `tracingComplete` can win the race
   * with the last batch on a busy machine. A short drain is cheaper than a
   * silently truncated interval, and `check("every cycle has trace coverage")`
   * would catch it if it were not. */
  await new Promise((r) => setTimeout(r, 300));
  return sink.slice();
}

/** The renderer main thread's (pid,tid), from the trace's own metadata. */
function findRendererMain(events) {
  const named = events.filter(
    (e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain",
  );
  if (!named.length) throw new Error("no CrRendererMain thread_name metadata in trace");
  /* More than one renderer can appear (a prerender, an about:blank). Pick the
   * one that actually did work in this trace. */
  let best = null;
  for (const m of named) {
    const n = events.filter((e) => e.pid === m.pid && e.tid === m.tid && e.ph === "X").length;
    if (!best || n > best.n) best = { pid: m.pid, tid: m.tid, n };
  }
  return best;
}

/** B/E pairs → complete events, so both encodings feed one algorithm. */
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
    }
  }
  out.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  return out;
}

/** Self time = own duration minus the duration of DIRECT children. Trace events
 *  on one thread nest properly, so a stack is enough. */
function withSelfTime(evts) {
  const stack = [];
  const self = evts.map((e) => e.dur);
  const scriptAncestor = evts.map(() => false);
  for (let i = 0; i < evts.length; i++) {
    const e = evts[i];
    while (stack.length && evts[stack[stack.length - 1]].ts + evts[stack[stack.length - 1]].dur <= e.ts)
      stack.pop();
    if (stack.length) {
      const p = stack[stack.length - 1];
      self[p] -= e.dur;
      scriptAncestor[i] =
        scriptAncestor[p] || EVENT_BUCKET[evts[p].name] === "scripting";
    }
    stack.push(i);
  }
  return evts.map((e, i) => ({ ...e, self: self[i], scriptAncestor: scriptAncestor[i] }));
}

const overlap = (ts, dur, a, b) => Math.max(0, Math.min(ts + dur, b) - Math.max(ts, a));

/**
 * Everything the trace says about one [t0,t1] µs interval on the main thread.
 *
 * Self-time buckets are clipped PROPORTIONALLY (self * overlapRatio) rather
 * than by nothing: an event that straddles the boundary would otherwise donate
 * all of its time to whichever side it started on. At these durations it
 * rarely matters — but "rarely" is not a thing an artifact should assume.
 */
function analyseInterval(evts, t0, t1) {
  const buckets = { scripting: 0, rendering: 0, painting: 0, loading: 0, other: 0 };
  let toplevelScripting = 0;
  let busy = 0;
  let longest = 0;
  let longestName = null;
  const topScripts = [];
  /** "chunk N is X KB and evaluates for Y ms" — the evidence shape the brief
   *  asks for, taken straight from `EvaluateScript`'s own `args.data.url`
   *  rather than inferred from a stack. Compile/parse of a streamed script is
   *  nested inside its EvaluateScript, so the full duration is the right
   *  number here, not the self time. */
  const evalByUrl = new Map();
  /** Self time per trace-event NAME, so the rendering and painting buckets are
   *  as answerable as the scripting one. A ranked cause that says "rendering:
   *  180 ms" and cannot name the event is a guess with a number attached. */
  const byName = new Map();
  for (const e of evts) {
    if (e.dur <= 0 && !TOPLEVEL.has(e.name)) continue;
    const ov = overlap(e.ts, e.dur, t0, t1);
    if (ov <= 0) continue;
    if (TOPLEVEL.has(e.name)) {
      busy += ov;
      if (e.dur > longest) {
        longest = e.dur;
        longestName = e.name;
      }
      buckets.other += e.dur > 0 ? (Math.max(0, e.self) * ov) / e.dur : 0;
      continue;
    }
    const bucket = EVENT_BUCKET[e.name] ?? "other";
    const selfShare = e.dur > 0 ? (Math.max(0, e.self) * ov) / e.dur : 0;
    buckets[bucket] += selfShare;
    const acc = byName.get(e.name) ?? { name: e.name, bucket, self_us: 0, count: 0 };
    acc.self_us += selfShare;
    acc.count++;
    byName.set(e.name, acc);
    if (e.name === "EvaluateScript" && e.args?.data?.url)
      evalByUrl.set(e.args.data.url, (evalByUrl.get(e.args.data.url) ?? 0) + ov);
    if (bucket === "scripting" && !e.scriptAncestor) {
      toplevelScripting += ov;
      topScripts.push({
        name: e.name,
        ms: +(ov / 1000).toFixed(2),
        detail:
          e.args?.data?.url ??
          e.args?.data?.functionName ??
          e.args?.data?.type ??
          null,
      });
    }
  }
  topScripts.sort((a, b) => b.ms - a.ms);
  return {
    scripting_ms: +(buckets.scripting / 1000).toFixed(2),
    scripting_toplevel_ms: +(toplevelScripting / 1000).toFixed(2),
    rendering_ms: +(buckets.rendering / 1000).toFixed(2),
    painting_ms: +(buckets.painting / 1000).toFixed(2),
    loading_ms: +(buckets.loading / 1000).toFixed(2),
    other_ms: +(buckets.other / 1000).toFixed(2),
    main_thread_busy_ms: +(busy / 1000).toFixed(2),
    longest_task_ms: +(longest / 1000).toFixed(2),
    longest_task_name: longestName,
    top_script_events: topScripts.slice(0, 6),
    top_events_by_self_time: [...byName.values()]
      .map((a) => ({ name: a.name, bucket: a.bucket, self_ms: +(a.self_us / 1000).toFixed(2), count: a.count }))
      .filter((a) => a.self_ms >= 0.5)
      .sort((a, b) => b.self_ms - a.self_ms)
      .slice(0, 12),
    evaluate_by_script: [...evalByUrl.entries()]
      .map(([url, us]) => ({ file: url.split("/").pop().split("?")[0], ms: +(us / 1000).toFixed(2) }))
      .sort((a, b) => b.ms - a.ms),
  };
}

/**
 * Requests SENT inside the interval, with the bytes the trace reports and what
 * the chunk behind the hashed filename actually contains.
 *
 * `ResourceMarkAsCached` is what Chrome emits when a request is served from the
 * HTTP cache; carrying it through is the whole point of scenarios S3 and S4,
 * so it is a field rather than an inference from `encodedDataLength === 0`.
 * A request that is still in flight at `t1` is reported with a null finish
 * rather than dropped — a chunk that has not landed by first paint is a
 * finding, not an absence.
 */
function requestsIn(events, t0, t1, chunkIndex) {
  const sent = new Map();
  const finished = new Map();
  const cached = new Set();
  for (const e of events) {
    const id = e.args?.data?.requestId;
    if (!id) continue;
    if (e.name === "ResourceSendRequest") sent.set(id, { ts: e.ts, url: e.args.data.url });
    else if (e.name === "ResourceFinish")
      finished.set(id, { ts: e.ts, bytes: e.args.data.encodedDataLength ?? null });
    else if (e.name === "ResourceMarkAsCached") cached.add(id);
  }
  const out = [];
  for (const [id, s] of sent) {
    if (s.ts < t0 || s.ts > t1) continue;
    const f = finished.get(id) ?? null;
    const file = (s.url || "").split("/").pop()?.split("?")[0] ?? "";
    /* Excalidraw inlines its icons as `data:image/svg+xml,…`, and a handful of
     * those URLs are 1–2 KB each. Left whole they triple the size of this
     * artifact and bury the chunk rows a reader came for. Truncated, never
     * dropped: the row still counts, still carries its bytes, and says it was
     * cut. */
    const url = s.url.length > 160 ? `${s.url.slice(0, 160)}…` : s.url;
    out.push({
      url,
      url_truncated: url !== s.url,
      url_length: s.url.length,
      sent_ms_after_click: +((s.ts - t0) / 1000).toFixed(2),
      finished_ms_after_click: f ? +((f.ts - t0) / 1000).toFixed(2) : null,
      encoded_bytes: f ? f.bytes : null,
      served_from_http_cache: cached.has(id),
      chunk: chunkIndex[file] ?? null,
    });
  }
  out.sort((a, b) => a.sent_ms_after_click - b.sent_ms_after_click);
  return out;
}

/**
 * Hashed chunk names carry no meaning, so read the build and say what is in
 * them. A missing build directory is a hard error: silently reporting
 * `chunk: null` for every request would make the central claim of this round
 * unfalsifiable.
 */
function indexChunks(buildDir) {
  const dirs = [
    path.join(buildDir, "static", "chunks"),
    path.join(buildDir, "static", "css"),
  ];
  const index = {};
  for (const dir of dirs) {
    if (!fs.existsSync(dir))
      throw new Error(
        `PHASE800_BUILD_DIR looks wrong — ${dir} does not exist. Point it at the .next of the build being served (README §2 step B).`,
      );
    const walk = (d, prefix) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(p, `${prefix}${entry.name}/`);
          continue;
        }
        if (!/\.(js|css)$/.test(entry.name)) continue;
        const body = fs.readFileSync(p, "utf8");
        index[entry.name] = {
          bytes: fs.statSync(p).size,
          has_excalidraw: body.includes("excalidraw"),
        };
      }
    };
    walk(dir, "");
  }
  return index;
}

/* ── driving one cycle ───────────────────────────────────────────────────── */

const marksOf = async (page) => page.evaluate(() => window.__cp.marks);

async function setCycle(page, label) {
  await page.evaluate((l) => {
    window.__cp.cycle = l;
    window.__cp.marks = [];
  }, label);
}

/** Wall-clock delta between two marks of the current cycle, in ms. */
function delta(marks, a, b) {
  const ma = marks.find((m) => m.name === a);
  const mb = marks.find((m) => m.name === b);
  if (!ma || !mb) return null;
  return +(mb.t - ma.t).toFixed(2);
}

/** The trace's `blink.user_timing` copy of one mark, in trace µs.
 *  Matched on category rather than on `ph`, because Chrome has shipped
 *  UserTiming marks as `R`, as `I` and as `n` across versions and pinning the
 *  phase is how this silently starts returning null on the next upgrade. */
function markTs(events, label, suffix) {
  const want = `${label}:${suffix}`;
  const hit = events.find(
    (e) => e.name === want && (e.cat ?? "").includes("blink.user_timing"),
  );
  return hit ? hit.ts : null;
}

/**
 * Wait until nothing is in flight for `quietMs`.
 *
 * The brief says "wait for it to settle (no in-flight fetches)". On this
 * surface that is not always reachable: the chat detail, agents, team, plan and
 * canvas-intent pollers fire on 3 s/4 s/6 s/20 s/30 s timers, and a slow leg can
 * keep the in-flight count above zero indefinitely. So this returns the
 * LONGEST quiet gap it actually observed rather than a bare boolean — a run
 * that could not settle says how close it got, instead of the artifact
 * asserting a settled state it never reached.
 */
async function settle(page, inflight, quietMs = 1200, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = null;
  let longest = 0;
  for (;;) {
    if (inflight.n === 0) {
      quietSince ??= Date.now();
      longest = Math.max(longest, Date.now() - quietSince);
      if (longest >= quietMs)
        return { settled: true, longest_quiet_ms: longest, required_ms: quietMs };
    } else {
      quietSince = null;
    }
    if (Date.now() > deadline)
      return {
        settled: false,
        longest_quiet_ms: longest,
        required_ms: quietMs,
        note: "the surface's pollers never left a gap this long; cycles ran anyway, and every cycle's own request list shows what was in flight during it",
      };
    await page.waitForTimeout(100);
  }
}

async function runCycle({ page, cdp, sink, label, chunkIndex, expectPane }) {
  await setCycle(page, label);
  await startTrace(cdp, sink);
  await page.waitForTimeout(400);

  await page.getByRole("button", { name: "CANVAS", exact: true }).click();

  /* Wait for the outcome we asked for, then a beat for the double-rAF marks and
   * (on open) for Excalidraw's own async mount to either happen or not. */
  if (expectPane) await page.waitForSelector(PANE_SEL, { timeout: 20_000 });
  else await page.waitForSelector(PANE_SEL, { state: "detached", timeout: 20_000 });
  await page.waitForTimeout(2_500);

  const events = await stopTrace(cdp, sink);
  const marks = await marksOf(page);

  const main = findRendererMain(events);
  const evts = withSelfTime(completeEvents(events, main.pid, main.tid));

  const t0 = markTs(events, label, "click");
  const tEnd = markTs(events, label, expectPane ? "paint" : "closepaint");
  if (t0 === null)
    throw new Error(`${label}: no click mark in the trace — the probe never saw the CANVAS button`);
  if (tEnd === null)
    throw new Error(`${label}: no ${expectPane ? "paint" : "closepaint"} mark in the trace`);

  const tExc = markTs(events, label, "excpaint");
  const analysis = analyseInterval(evts, t0, tEnd);
  /* Excalidraw finishes mounting AFTER the pane's first paint, so its cost sits
   * outside [click,paint]. Reported as its own interval rather than folded in —
   * U31 gates the open, and a reader has to be able to see both. */
  const excAnalysis = tExc === null ? null : analyseInterval(evts, t0, tExc);

  return {
    cycle: label,
    direction: expectPane ? "open" : "close",
    wallclock_ms: {
      click_to_dom: delta(marks, "click", "dom") ?? delta(marks, "click", "gone"),
      click_to_paint:
        delta(marks, "click", expectPane ? "paint" : "closepaint"),
      click_to_excalidraw_dom: delta(marks, "click", "excdom"),
      click_to_excalidraw_paint: delta(marks, "click", "excpaint"),
    },
    interval_us: { start: t0, end: tEnd, span_ms: +((tEnd - t0) / 1000).toFixed(2) },
    ...analysis,
    requests: requestsIn(events, t0, tEnd, chunkIndex),
    excalidraw_interval: excAnalysis && {
      span_ms: +((tExc - t0) / 1000).toFixed(2),
      ...excAnalysis,
      requests: requestsIn(events, t0, tExc, chunkIndex),
    },
    trace_events: events.length,
  };
}

/* ── one scenario ────────────────────────────────────────────────────────── */

async function runScenario({
  browserCtx,
  name,
  seedPath,
  cacheDisabled,
  reloadBefore,
  /** false ONLY for the scenario that needs a live HTTP cache — see the long
   *  comment on the route below. */
  interceptSaves = true,
  chunkIndex,
  chatId,
  chk,
}) {
  const page = await browserCtx.newPage();
  const errs = L.watchErrors(page);
  const inflight = { n: 0 };
  page.on("request", () => inflight.n++);
  page.on("requestfinished", () => inflight.n--);
  page.on("requestfailed", () => inflight.n--);

  const cdp = await browserCtx.newCDPSession(page);
  const sink = [];
  cdp.on("Tracing.dataCollected", ({ value }) => sink.push(...value));
  await cdp.send("Network.enable");
  if (cacheDisabled) await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  /* The probe goes in FIRST, so it is watching before any app module runs and
   * is reinstalled by the reload S4 performs. */
  await page.addInitScript({ content: probeSource(PANE_SEL) });

  /**
   * THE ONE INTERCEPTION IN THIS FILE, declared here and nowhere else — and
   * the reason exactly one scenario runs without it.
   *
   * `CanvasPane.tsx:263-269` flushes on unmount so closing the pane never drops
   * a stroke — and Excalidraw fires `onChange` while it loads a scene, so the
   * ref is dirty by the time the close click unmounts it. The consequence is
   * that MEASURING the canvas 24 times writes Konrad's real vault file 24
   * times: an early run of this protocol did exactly that, and one close came
   * back `409 Conflict` because two of those writes raced.
   *
   * A measurement has no business mutating the vault, so the PUT is answered
   * locally with the shape `saveCanvas` expects (`api.ts:127`) and never
   * forwarded. What it does NOT change: the request is still issued, still on
   * the same code path, and `flush()` is fire-and-forget — the close paint has
   * already happened by the time any response arrives. GET /canvas/list and
   * GET /canvas/file are untouched and hit the real API. The glob carries no
   * query string and `getCanvas` GETs `/canvas/file?path=…`, so the READ path
   * should never enter this handler and never pay interception latency on the
   * interval being measured; "should" is not evidence, so non-PUT arrivals are
   * counted and asserted to be zero.
   *
   * ── AND THE CATCH, which cost this round a rerun ────────────────────────
   *
   * Enabling routing in Playwright DISABLES THE BROWSER'S HTTP CACHE for that
   * page. Registering this handler therefore silently turned S4 — the scenario
   * whose entire purpose is to measure an open with the chunks already on disk
   * — back into a cold-network run: its "cold open" re-downloaded 352 KB and
   * `check("S4's measured cold open served the Excalidraw chunks from the HTTP
   * cache")` failed. Re-asserting `Network.setCacheDisabled:false` over CDP
   * after the route is registered does not win it back (measured: chunks still
   * came over the wire on reload).
   *
   * So the two properties are split rather than fudged. S1–S3 route, and write
   * nothing. S4 does NOT route, because a real HTTP cache is the thing it
   * exists to test — and the cost is that S4 alone lets the app's unmount
   * flush reach the vault. That is bounded and checked: the drawing's CONTENT
   * is compared before and after the whole run and must be identical; only its
   * mtime moves, which is what re-saving an unchanged scene does.
   */
  const savePuts = [];
  const nonPutHits = [];
  if (interceptSaves) {
    await page.route("**/api/proxy/canvas/file", async (route) => {
      const req = route.request();
      if (req.method() !== "PUT") {
        nonPutHits.push(`${req.method()} ${req.url()}`);
        return route.continue();
      }
      savePuts.push((req.postData() ?? "").length);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: seedPath ?? "", mtime: 1 }),
      });
    });
  }

  /* Seed the app's OWN persistence key, exactly as ChatSurface writes it
   * (ChatSurface.tsx:381-388) — `open:false` so the first click is an open. */
  await page.addInitScript(
    ({ key, id, p }) => {
      try {
        localStorage.setItem(key, JSON.stringify({ [id]: { open: false, path: p } }));
      } catch {
        /* first navigation is about:blank where localStorage may be denied;
         * the next one (the real origin) succeeds and that is the one that
         * matters. */
      }
    },
    { key: "forge.canvasByRun", id: chatId, p: seedPath },
  );

  const pageLoadRequests = [];
  page.on("response", (r) => {
    const u = r.url();
    if (/\/_next\/static\/(chunks|css)\//.test(u)) pageLoadRequests.push(u);
  });

  await L.openChat(page);

  /**
   * S4 only means something if the Excalidraw chunks are ALREADY in the HTTP
   * cache when the measured cycles start — otherwise it is S2 with an extra
   * navigation, which is exactly what the first run of this protocol recorded
   * (identical numbers, an inert scenario). So: open the canvas once, wait for
   * the editor to actually mount (that is what pulls the chunks), close it,
   * and only THEN reload. After the reload the bytes are on disk and the
   * module graph is cold — the precise state a "your number is just a cold
   * cache" objection appeals to.
   */
  let warmup = null;
  if (reloadBefore) {
    const warmed = [];
    const tap = (r) => {
      if (/\/_next\/static\/chunks\//.test(r.url())) warmed.push(r.url().split("/").pop());
    };
    page.on("response", tap);
    await page.getByRole("button", { name: "CANVAS", exact: true }).click();
    await page.waitForSelector(".excalidraw", { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await page.getByRole("button", { name: "CANVAS", exact: true }).click();
    await page.waitForSelector(PANE_SEL, { state: "detached", timeout: 20_000 });
    page.off("response", tap);
    warmup = {
      chunks_fetched_before_reload: [...new Set(warmed)]
        .filter((f) => chunkIndex[f]?.has_excalidraw)
        .map((f) => ({ file: f, ...chunkIndex[f] })),
    };
    pageLoadRequests.length = 0;
    await L.openChat(page);
  }

  const settled = await settle(page, inflight);

  const loadChunks = [...new Set(pageLoadRequests)].map((u) => {
    const file = u.split("/").pop().split("?")[0];
    return { file, ...(chunkIndex[file] ?? {}) };
  });

  const cycles = [];
  for (let i = 1; i <= CYCLES; i++) {
    cycles.push(
      await runCycle({
        page,
        cdp,
        sink,
        label: `${name}-c${i}-open`,
        chunkIndex,
        expectPane: true,
      }),
    );
    await page.waitForTimeout(700);
    cycles.push(
      await runCycle({
        page,
        cdp,
        sink,
        label: `${name}-c${i}-close`,
        chunkIndex,
        expectPane: false,
      }),
    );
    await page.waitForTimeout(700);
  }

  /* The one structural claim this file makes about the DOM. If ChatSurface's
   * wrapper style ever changes, this fails loudly instead of measuring the
   * wrong node. */
  await page.getByRole("button", { name: "CANVAS", exact: true }).click();
  await page.waitForSelector(PANE_SEL, { timeout: 20_000 });
  chk.check(
    `[${name}] pane selector matches exactly one node while open`,
    await page.locator(PANE_SEL).count(),
    1,
  );
  await page.getByRole("button", { name: "CANVAS", exact: true }).click();

  await page.close();

  const opens = cycles.filter((c) => c.direction === "open");
  const closes = cycles.filter((c) => c.direction === "close");
  const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);

  return {
    scenario: name,
    seed_path: seedPath,
    cache_disabled: !!cacheDisabled,
    reloaded_before_cycles: !!reloadBefore,
    warmup: warmup,
    settle: settled,
    /* How many vault writes this scenario WOULD have made if the PUT above
     * were not answered locally. Reported so the interception is a number a
     * reviewer can see, not a claim in a comment. */
    save_puts_intercepted: {
      routing_enabled: interceptSaves,
      count: savePuts.length,
      body_bytes: savePuts,
      non_put_requests_that_entered_the_handler: nonPutHits,
      note: interceptSaves
        ? "PUT /canvas/file answered locally; this scenario wrote nothing to the vault"
        : "NOT routed — Playwright routing disables the HTTP cache and this scenario measures it. The app's unmount flush reached the real vault; content equality is asserted at the end of the run.",
    },
    page_load_chunks: {
      count: loadChunks.length,
      excalidraw_bearing: loadChunks.filter((c) => c.has_excalidraw),
    },
    console_errors: errs.consoleErrors,
    failed_requests: [...new Set(errs.failedRequests)],
    cycles,
    summary: {
      cold_open: {
        scripting_ms: opens[0].scripting_ms,
        click_to_paint_ms: opens[0].wallclock_ms.click_to_paint,
        longest_task_ms: opens[0].longest_task_ms,
        main_thread_busy_ms: opens[0].main_thread_busy_ms,
        click_to_excalidraw_paint_ms: opens[0].wallclock_ms.click_to_excalidraw_paint,
        excalidraw_scripting_ms: opens[0].excalidraw_interval?.scripting_ms ?? null,
      },
      warm_open: {
        n: opens.length - 1,
        scripting_ms_mean: mean(opens.slice(1).map((c) => c.scripting_ms)),
        scripting_ms_max: opens.slice(1).length
          ? Math.max(...opens.slice(1).map((c) => c.scripting_ms))
          : null,
        click_to_paint_ms_mean: mean(opens.slice(1).map((c) => c.wallclock_ms.click_to_paint)),
        longest_task_ms_max: opens.slice(1).length
          ? Math.max(...opens.slice(1).map((c) => c.longest_task_ms))
          : null,
        click_to_excalidraw_paint_ms_mean: mean(
          opens.slice(1).map((c) => c.wallclock_ms.click_to_excalidraw_paint).filter((x) => x !== null),
        ),
      },
      close: {
        n: closes.length,
        scripting_ms_mean: mean(closes.map((c) => c.scripting_ms)),
        scripting_ms_max: Math.max(...closes.map((c) => c.scripting_ms)),
        click_to_paint_ms_mean: mean(closes.map((c) => c.wallclock_ms.click_to_paint)),
        longest_task_ms_max: Math.max(...closes.map((c) => c.longest_task_ms)),
      },
    },
  };
}

/* ── main ────────────────────────────────────────────────────────────────── */

(async () => {
  const chk = L.makeChecker();
  /* Both fail fast, before six minutes of browser time: a missing baseline sha
   * or a build directory that is not the one being served makes every number
   * below unattributable. */
  const sha = headSha();
  const chunkIndex = indexChunks(BUILD_DIR);
  chk.note("baseline", { head_sha: sha, build_dir: BUILD_DIR, base_url: L.BASE });

  const excalidrawChunks = Object.entries(chunkIndex)
    .filter(([, v]) => v.has_excalidraw)
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.bytes - a.bytes);
  chk.note(
    "build chunks whose source contains 'excalidraw' (top 6 by size)",
    excalidrawChunks.slice(0, 6),
  );

  const chat = await L.resolveChat();
  chk.note("fixture chat", { id: chat.id, title: chat.title });

  /**
   * The fixture drawing before anything runs, compared again at the end.
   *
   * S4 cannot route the save PUT (see runScenario), so the app's unmount flush
   * genuinely reaches the vault during that scenario. What must survive is the
   * DRAWING, not the mtime: a re-save of an unchanged scene moves the mtime by
   * definition. So the scene itself is captured and deep-compared, and the
   * mtime is reported rather than asserted — an assertion that could only fail
   * would be dropped at the first inconvenient rerun, which is worse than an
   * honest note.
   */
  const sceneOf = async (p) => {
    const doc = await L.api(`/api/canvas/file?path=${encodeURIComponent(p)}`);
    return {
      mtime: doc.mtime,
      scene: JSON.stringify({
        elements: doc.elements,
        appState: doc.appState,
        files: doc.files,
      }),
    };
  };
  const before = await sceneOf(SEED_PATH);
  if (before.mtime === undefined)
    throw new Error(`seed drawing not readable: ${SEED_PATH}`);

  const scenarios = [];
  await L.withBrowser(async (ctx) => {
    scenarios.push(
      await runScenario({
        browserCtx: ctx,
        name: "S1-empty",
        seedPath: null,
        chunkIndex,
        chatId: chat.id,
        chk,
      }),
    );
  });
  await L.withBrowser(async (ctx) => {
    scenarios.push(
      await runScenario({
        browserCtx: ctx,
        name: "S2-drawing",
        seedPath: SEED_PATH,
        chunkIndex,
        chatId: chat.id,
        chk,
      }),
    );
  });
  await L.withBrowser(async (ctx) => {
    scenarios.push(
      await runScenario({
        browserCtx: ctx,
        name: "S3-drawing-nocache",
        seedPath: SEED_PATH,
        cacheDisabled: true,
        chunkIndex,
        chatId: chat.id,
        chk,
      }),
    );
  });
  await L.withBrowser(async (ctx) => {
    scenarios.push(
      await runScenario({
        browserCtx: ctx,
        name: "S4-drawing-reload",
        seedPath: SEED_PATH,
        reloadBefore: true,
        /* The one scenario that must see a real HTTP cache, so the one that
         * cannot route. */
        interceptSaves: false,
        chunkIndex,
        chatId: chat.id,
        chk,
      }),
    );
  });

  const byName = Object.fromEntries(scenarios.map((s) => [s.scenario, s]));

  /* ── instrument-validity checks. This round measures; it does not gate on
   *    the measurement being good or bad. What it DOES assert is that the
   *    measurement is real — a BEFORE number that cannot be shown to have come
   *    from a working instrument is worth nothing to round 803. ───────────── */

  const allCycles = scenarios.flatMap((s) => s.cycles);
  chk.check(
    "every cycle produced a click→paint interval (no missing marks)",
    allCycles.filter((c) => c.wallclock_ms.click_to_paint === null).length,
    0,
  );
  chk.check(
    "every cycle's interval is positive",
    allCycles.filter((c) => c.interval_us.span_ms <= 0).length,
    0,
  );
  chk.check(
    "every cycle has trace coverage on the renderer main thread",
    allCycles.filter((c) => c.main_thread_busy_ms <= 0).length,
    0,
  );
  chk.check(
    "unbucketed self time never dominates a cycle (map is complete enough)",
    allCycles.filter((c) => c.other_ms > c.scripting_ms && c.other_ms > 20).length,
    0,
  );
  chk.check(
    "each scenario ran CYCLES opens and CYCLES closes",
    scenarios.map((s) => s.cycles.length),
    scenarios.map(() => CYCLES * 2),
  );
  chk.check(
    "S1 (no drawing remembered) never mounts Excalidraw — the two scenarios are genuinely different",
    byName["S1-empty"].cycles.filter((c) => c.wallclock_ms.click_to_excalidraw_paint !== null).length,
    0,
  );
  chk.check(
    "S2 cold open does mount Excalidraw",
    byName["S2-drawing"].cycles[0].wallclock_ms.click_to_excalidraw_paint !== null,
    true,
  );
  chk.check(
    "S3 really ran with the HTTP cache disabled",
    byName["S3-drawing-nocache"].cache_disabled,
    true,
  );
  chk.check(
    "S4 fetched the Excalidraw chunks BEFORE its reload — otherwise it is S2 with an extra navigation and proves nothing about caching",
    (byName["S4-drawing-reload"].warmup?.chunks_fetched_before_reload ?? []).length > 0,
    true,
  );
  chk.check(
    "S4's measured cold open served the Excalidraw chunks from the HTTP cache",
    byName["S4-drawing-reload"].cycles[0].excalidraw_interval.requests.filter(
      (r) => r.chunk?.has_excalidraw && r.served_from_http_cache,
    ).length > 0,
    true,
  );
  chk.check(
    "the build index found at least one excalidraw-bearing artefact (chunk names are resolved, not guessed)",
    excalidrawChunks.length > 0,
    true,
  );
  chk.check(
    "the save interception never entered on a read — GET /canvas/file paid no route latency on the measured interval",
    scenarios.flatMap((s) => s.save_puts_intercepted.non_put_requests_that_entered_the_handler),
    [],
  );
  chk.check(
    "S1–S3 wrote nothing to the vault (their save PUTs were answered locally)",
    scenarios
      .filter((s) => s.save_puts_intercepted.routing_enabled)
      .map((s) => s.scenario),
    ["S1-empty", "S2-drawing", "S3-drawing-nocache"],
  );
  const after = await sceneOf(SEED_PATH);
  chk.check(
    "the fixture drawing's SCENE is byte-identical after the run — S4's unmount flush round-tripped it, it did not damage it",
    after.scene === before.scene,
    true,
  );
  chk.note("vault side effects", {
    seed_path: SEED_PATH,
    scene_unchanged: after.scene === before.scene,
    scene_bytes: before.scene.length,
    mtime_before: before.mtime,
    mtime_after: after.mtime,
    mtime_moved: after.mtime !== before.mtime,
    why: "S4 cannot route the save PUT (Playwright routing disables the HTTP cache it measures), so its unmount flush re-saved the same scene. S1–S3 wrote nothing.",
    suppressed_put_count_by_scenario: Object.fromEntries(
      scenarios.map((s) => [
        s.scenario,
        s.save_puts_intercepted.routing_enabled ? s.save_puts_intercepted.count : "not routed",
      ]),
    ),
  });

  /* ── the verdict ─────────────────────────────────────────────────────────
   *
   * "Open" has TWO defensible end points on this surface, and reporting only
   * one of them is how a fix round optimises nothing:
   *
   *   A. PANE PAINT   — click → the frame that shows <CanvasPane>. This is
   *      what U31's wording most literally names, and it is the number the
   *      pane's own loading/empty state is measured against.
   *   B. EDITOR PAINT — click → the frame that shows the Excalidraw editor,
   *      which is what "the canvas is open" means once Konrad has picked a
   *      drawing (`forge.canvasByRun.path`), i.e. every open after the first.
   *      B only exists in the drawing scenarios; S1 has no editor to wait for.
   *
   * Both are computed, both are reported, and the verdict names which reading
   * it is failing or passing on. The worst COLD figure is used, never a mean:
   * the first open is the one Konrad feels. */
  const coldPane = scenarios.map((s) => ({
    scenario: s.scenario,
    scripting_ms: s.summary.cold_open.scripting_ms,
  }));
  const worstColdPane = coldPane.reduce((a, b) => (b.scripting_ms > a.scripting_ms ? b : a));
  const warmPaneMax = Math.max(...scenarios.map((s) => s.summary.warm_open.scripting_ms_max ?? 0));

  const editorScenarios = scenarios.filter(
    (s) => s.summary.cold_open.excalidraw_scripting_ms !== null,
  );
  const coldEditor = editorScenarios.map((s) => ({
    scenario: s.scenario,
    scripting_ms: s.summary.cold_open.excalidraw_scripting_ms,
    click_to_paint_ms: s.summary.cold_open.click_to_excalidraw_paint_ms,
  }));
  const worstColdEditor = coldEditor.length
    ? coldEditor.reduce((a, b) => (b.scripting_ms > a.scripting_ms ? b : a))
    : null;
  const warmEditorMax = editorScenarios.length
    ? Math.max(
        ...editorScenarios.flatMap((s) =>
          s.cycles
            .filter((c) => c.direction === "open" && c.excalidraw_interval)
            .slice(1)
            .map((c) => c.excalidraw_interval.scripting_ms),
        ),
      )
    : null;

  const paneExceeded = worstColdPane.scripting_ms > GATE_SCRIPTING_MS || warmPaneMax > GATE_SCRIPTING_MS;
  const editorExceeded =
    worstColdEditor !== null &&
    (worstColdEditor.scripting_ms > GATE_SCRIPTING_MS ||
      (warmEditorMax ?? 0) > GATE_SCRIPTING_MS);

  const gate = {
    requirement: "U31 — open > 100ms scripting is a fail",
    threshold_ms: GATE_SCRIPTING_MS,
    reading_A_pane_paint: {
      what: "click → frame showing <CanvasPane> (its own chrome / empty state)",
      worst_cold_open: worstColdPane,
      worst_warm_open_scripting_ms: +warmPaneMax.toFixed(2),
      exceeded: paneExceeded,
    },
    reading_B_editor_paint: {
      what: "click → frame showing the Excalidraw editor, i.e. every open on a chat with a remembered drawing",
      applies_to: editorScenarios.map((s) => s.scenario),
      worst_cold_open: worstColdEditor,
      worst_warm_open_scripting_ms: warmEditorMax === null ? null : +warmEditorMax.toFixed(2),
      exceeded: editorExceeded,
    },
    exceeded_on_any_reading: paneExceeded || editorExceeded,
    verdict: editorExceeded
      ? `GATE EXCEEDED on reading B (editor paint): worst cold open is ${worstColdEditor.scripting_ms} ms scripting over ${worstColdEditor.click_to_paint_ms} ms wall, against a 100 ms gate. Reading A (pane paint) is ${paneExceeded ? "ALSO over" : "under"} the gate at ${worstColdPane.scripting_ms} ms — the pane's frame is cheap; the editor behind it is not.`
      : paneExceeded
        ? `GATE EXCEEDED on reading A (pane paint): ${worstColdPane.scripting_ms} ms scripting against a 100 ms gate.`
        : `UNDER GATE on both readings (pane ${worstColdPane.scripting_ms} ms, editor ${worstColdEditor?.scripting_ms ?? "n/a"} ms) — U31's own threshold requires no fix.`,
  };
  chk.note("U31 gate", gate);

  finish800(
    OUT_FILE,
    {
      protocol: "canvas-open.cjs",
      requirement: "U31 — canvas button perf (BEFORE baseline, round 801)",
      head_sha: headSha(),
      base_url: L.BASE,
      api_url: L.API,
      build_dir: BUILD_DIR,
      viewport: L.VIEWPORT,
      gate,
      generated_at: new Date().toISOString(),
      excalidraw_bearing_build_artefacts: excalidrawChunks,
      scenarios,
      results: chk.results,
    },
    chk.failed(),
  );
})().catch((e) => {
  console.error(`\ncanvas-open.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
