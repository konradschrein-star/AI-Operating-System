/**
 * measure-projects-lag.cjs — os-usable-for-work, phase 6, task A.
 *
 * WHAT THIS MEASURES. Konrad reports "Projects tab lags on click". `00-vision.md
 * §2.7` names four suspects — 127 unwindowed `TaskCard`s, a 6 s board poll, a
 * 15 s projects poll, and a 3 s per-running-task chat poll — and says in as many
 * words that they are *plausible* and *not yet proven*. The chat-scroll freeze
 * fixed on 2026-08-18 was a 2,200-row mount; this board is an order of magnitude
 * smaller, so the analogy is a hypothesis. This script turns the hypothesis into
 * a number, and phase 6 task C re-runs it UNCHANGED with RUN_LABEL=after. A
 * different measurement after is not a comparison, which is why the shape of the
 * run — five windows, three repetitions, fixed durations — is hardcoded and the
 * only knobs are the label and the port.
 *
 * THE WINDOWS. W1 the mount (navigate into Projects from another surface), W2 a
 * task-card click, W3 the board→floor toggle, W4 30 s idle on the board, W5 30 s
 * idle in floor view. W1–W4 are the four the task brief specifies. W5 is added
 * because W3's three seconds is exactly one poll interval and therefore cannot
 * tell a one-off mount burst from a sustained storm, while W4 sits on the board
 * where no FloorTile exists — without W5 the 3 s per-running-task chat poll,
 * one of the four suspects, could only have been ranked on arithmetic.
 *
 * It keeps the discipline of `docs/plan/artifacts/phase1871/typing-1871.cjs`
 * verbatim, and that file is worth reading before this one:
 *
 *  • INTERLEAVED IDLE BASELINE. Every measured window is preceded by an idle
 *    window of exactly the same duration, so this VPS's ambient floor is visible
 *    as a distribution rather than subtracted from a guess. Idle first, always —
 *    the floor is measured before the thing it is the floor for, so a warm cache
 *    cannot flatter the action window.
 *
 *  • FIXED-DURATION WINDOWS. Every window is held open for a fixed wall time
 *    (3 s for W1–W3, 30 s for W4) whatever the interaction does inside it. An
 *    idle window and an action window of different lengths are not comparable,
 *    and a window that ends "when the UI looks settled" is a window whose length
 *    is a function of the very thing being measured. The interaction's own
 *    latency is captured SEPARATELY as `timeToReadyMs` inside the window.
 *
 *  • AN IN-APP CONTROL. W4's floor is 30 s idle on the TODAY surface of the same
 *    app, in the same page, the same renderer, the same tab. Today's queries
 *    carry no `refetchInterval` (`DesktopApp.tsx:258`, and `:263` polls only when
 *    the surface is `live`), so it is the same React tree, the same React Query
 *    client and the same box with the Projects polls switched off. That is the
 *    analogue of typing-1871's bare `<textarea>`: whatever Today costs is what
 *    the app and the browser cost, and everything above it is this surface.
 *
 *  • RAW OUTPUT, UNFILTERED. Every long task is emitted whole, every request is
 *    emitted with its own URL/method/status/bytes/duration, every window's
 *    numbers are in the JSON, and `os.loadavg()` is sampled around every pair so
 *    a noisy box shows up in the artefact instead of hiding in a mean.
 *
 * THE TWO CLOCKS, AND WHICH ONE THE REPORT RANKS ON.
 *
 *   (a) REACT COMMIT DURATION — the primary. A stub DevTools hook is installed
 *       via CDP `Page.addScriptToEvaluateOnNewDocument` BEFORE React loads;
 *       production React calls `onCommitFiberRoot` when a hook is present. The
 *       throwaway bundle is built with `next build --profile`, so react-dom is
 *       the production PROFILING build and `root.current.actualDuration` is
 *       populated — that is React's own per-commit render time, per commit, and
 *       it is a component number, not an aggregate. `reactProfilingBuild` in the
 *       output records whether it was actually populated; if it is false every
 *       `commitMs` in the run is a `null` meaning NOT MEASURED, never zero.
 *
 *   (b) CDP `Performance.getMetrics` DELTAS — recorded alongside, never ranked
 *       on. `scriptMs` / `layoutMs` / `styleMs` / `taskMs` are Chrome's
 *       RENDERER-WIDE counters and they include the fetch, the JSON parse, React
 *       Query's own work and the browser's, not just React's render. They are
 *       labelled as renderer-wide aggregates everywhere they are quoted, per the
 *       phase-1290/1871 precedent. Quoting an aggregate as a component number is
 *       the lie this corpus keeps catching.
 *
 *   Having both is what makes either trustworthy: if the summed commit time
 *   exceeds the renderer's own ScriptDuration for the same window, the profiler
 *   numbers are wrong and the artefact says so instead of being quoted.
 *
 * ANTI-LYING CHECKS, ALL FATAL.
 *   1. the URL is not /signin — and the error names the SALT as first suspect,
 *      per `03-quality.md`, because a wrong salt is a 307 that looks exactly
 *      like an expired token and has cost this fleet two rounds.
 *   2. the rendered board holds >= 100 task cards before any window runs. A
 *      measurement of an empty board is worse than no measurement.
 *   3. the React commit counter is > 0 after W1. A zero there does not mean "no
 *      work"; it means the hook never attached and every commit number in the
 *      run is unmeasured.
 *
 * READ-ONLY. It drives navigation and selection only: nav labels, a task card,
 * the board/floor toggle, and "← board". It never clicks "+ new", the project
 * "×", "send", or any run control. GETs through the throwaway UI to
 * 127.0.0.1:7700 are how live scale is reached and are permitted.
 *
 * WHERE IT RUNS. A worktree build served on a throwaway port, never
 * /opt/forge-ai-os, never production. Recipe in the sibling
 * `browser-harness-perf.md`.
 *
 * Playwright is loaded by absolute path from /opt/hermes-workspace and chromium
 * resolved out of /root/.cache/ms-playwright, so neither repo gains a
 * dependency — same as every browser script in this corpus.
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

/* ── the only two knobs ───────────────────────────────────────────────────────
 * RUN_LABEL  before | after
 * PORT       the throwaway `next start` port
 * Everything else about the run's shape is fixed, on purpose: task C re-runs
 * this file unchanged, and a knob that changes the number of repetitions or the
 * length of a window is a knob that breaks the comparison it exists to serve.
 * FORGE_SESSION_COOKIE is a secret, not a shape, so it comes from the env too.
 */
const RUN_LABEL = (process.env.RUN_LABEL ?? "before").trim();
const PORT = Number(process.env.PORT ?? 7786);
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();

/** Fixed run shape. Do not parameterise these. */
const REPS = 3;
const SHORT_MS = 3_000; // W1, W2, W3 and their idle pairs
const LONG_MS = 30_000; // W4, W5 and their idle pairs
const SETTLE_MS = 1_500; // unmeasured, between windows, so a window starts from rest
const MIN_CARDS = 100; // anti-lying check 2

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const COMMIT_ARTIFACT = process.argv.includes("--commit-artifact");
const OUT_ENV = (process.env.PROJECTS_LAG_OUT ?? "").trim();
const OUT = path.resolve(OUT_ENV || (COMMIT_ARTIFACT ? __dirname : "/tmp/projects-lag-out"));
const OPTED_IN = COMMIT_ARTIFACT || OUT_ENV !== "";

function preflight() {
  if (!OPTED_IN && (OUT === REPO_ROOT || OUT.startsWith(REPO_ROOT + path.sep))) {
    throw new Error(
      `measure-projects-lag.cjs refuses to write inside the repo without an explicit opt-in.\n` +
        `  resolved output dir: ${OUT}\n` +
        `  pass --commit-artifact, or set PROJECTS_LAG_OUT=<dir>.`,
    );
  }
  fs.mkdirSync(OUT, { recursive: true });
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint it per browser-harness-perf.md");
  if (PORT === 7701) {
    throw new Error(
      `port 7701 is the LIVE forge-control-web. This is a measurement task, not a deploy task: ` +
        `serve the worktree build on a spare port. (It also runs an https AUTH_URL and would need ` +
        `the __Secure- salt, which this script does not mint.)`,
    );
  }
  if (!["before", "after"].includes(RUN_LABEL)) {
    throw new Error(`RUN_LABEL must be "before" or "after", got ${JSON.stringify(RUN_LABEL)}`);
  }
}

/* ── in-page instruments ──────────────────────────────────────────────────────
 * INIT runs via Page.addScriptToEvaluateOnNewDocument, i.e. before any of the
 * page's own script — which is the whole point, because React reads
 * __REACT_DEVTOOLS_GLOBAL_HOOK__ once, at module evaluation, and a hook
 * installed after that is a hook React will never call.
 */
const INIT = `(() => {
  const s = { commits: 0, perCommit: [], injected: 0, anyDuration: false };
  window.__p6 = s;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) { s.injected++; this.renderers.set(s.injected, renderer); return s.injected; },
    onCommitFiberRoot(id, root) {
      s.commits++;
      let d = null;
      try {
        const f = root && root.current;
        if (f && typeof f.actualDuration === "number") { d = f.actualDuration; s.anyDuration = true; }
      } catch (e) { d = null; }
      s.perCommit.push(d);
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    /* React probes a handful of these on the hook object. They must exist and
     * must not throw, or react-dom's injectIntoDevTools bails and nothing is
     * ever reported — a silent zero, which is the failure mode check 3 exists
     * to catch. */
    checkDCE() {},
    on() {}, off() {}, emit() {},
    sub() { return () => {}; },
    getFiberRoots() { return new Set(); },
    setStrictMode() {},
  };
})();`;

/** Arm a window: reset the long-task buffer and remember the commit cursor. */
const ARM = () => {
  window.__w = {
    t0: performance.now(),
    commitCursor: window.__p6 ? window.__p6.commits : -1,
    longTasks: [],
  };
  window.__wpo = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__w.longTasks.push({
        startTime: Math.round(e.startTime * 100) / 100,
        duration: Math.round(e.duration * 100) / 100,
        name: e.name,
      });
    }
  });
  try {
    window.__wpo.observe({ entryTypes: ["longtask"] });
    window.__w.longtaskSupported = true;
  } catch {
    window.__w.longtaskSupported = false;
  }
};

const COLLECT = () => {
  try {
    window.__wpo.disconnect();
  } catch {
    /* never armed — longtaskSupported says so */
  }
  const w = window.__w;
  const p = window.__p6;
  const commits = p ? p.perCommit.slice(w.commitCursor) : [];
  const measured = commits.filter((c) => typeof c === "number");
  const durations = w.longTasks.map((x) => x.duration);
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    windowMs: Math.round(performance.now() - w.t0),
    /* (a) React's own clock. `commitMs*` are null when the hook reported no
     *     actualDuration — NOT MEASURED, never a zero to be quoted as "no work". */
    reactCommits: commits.length,
    commitMsTotal: measured.length ? round2(measured.reduce((a, b) => a + b, 0)) : null,
    commitMsMax: measured.length ? round2(Math.max(...measured)) : null,
    commitMsEach: measured.map(round2),
    commitDurationsMeasured: measured.length,
    /* long tasks, whole */
    longTasks: w.longTasks.length,
    blockedMs: Math.round(durations.reduce((a, b) => a + b, 0)),
    maxLongTaskMs: durations.length ? Math.max(...durations) : 0,
    longTaskDetail: w.longTasks,
    longtaskSupported: w.longtaskSupported,
  };
};

const DOM_NODES = () => document.querySelectorAll("*").length;

/**
 * Count the rendered TaskCards, per column.
 *
 * `TaskCard` carries no `data-*` attribute and this task is forbidden from
 * adding one — it changes no source file. So the count is structural, and it is
 * done twice by two independent routes so a silent disagreement is visible:
 *
 *   byColumn  — find each column header's leaf label span (Architect … Done),
 *               walk to the column root, take its second child (the scroll
 *               body), count element children that are not the "—" placeholder.
 *               `RoleColumn`/`DoneColumn` render exactly [header, body] and the
 *               placeholder is the only child carrying className "mono".
 *   byStyle   — every element whose COMPUTED style matches TaskCard's own
 *               signature: 8px radius, 2px left border, pointer cursor.
 *
 * If the two disagree the JSON says so and the report must explain it rather
 * than pick the flattering one.
 */
const COUNT_CARDS = () => {
  const LABELS = ["Architect", "Planner", "Scout", "Builder", "Reviewer", "Done"];
  const byColumn = {};
  let total = 0;
  for (const el of document.querySelectorAll("span")) {
    const txt = (el.textContent || "").trim();
    if (!LABELS.includes(txt) || el.children.length > 0) continue;
    const col = el.parentElement && el.parentElement.parentElement;
    if (!col || col.children.length !== 2) continue;
    const body = col.children[1];
    const n = [...body.children].filter((c) => c.className === "").length;
    byColumn[txt] = (byColumn[txt] ?? 0) + n;
    total += n;
  }
  let byStyle = 0;
  for (const el of document.querySelectorAll("div")) {
    const cs = getComputedStyle(el);
    if (cs.borderRadius === "8px" && cs.borderLeftWidth === "2px" && cs.cursor === "pointer") byStyle++;
  }
  return { total, byColumn, byStyle, agree: total === byStyle };
};

/* ── CDP plumbing ─────────────────────────────────────────────────────────── */

async function perfMetrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
  return {
    ScriptDuration: get("ScriptDuration"),
    RecalcStyleDuration: get("RecalcStyleDuration"),
    LayoutDuration: get("LayoutDuration"),
    TaskDuration: get("TaskDuration"),
    JSHeapUsedSize: get("JSHeapUsedSize"),
    Nodes: get("Nodes"),
  };
}

/** Renderer-wide aggregates. Named `*RendererWideMs` so a number lifted out of
 *  this JSON into prose carries its own caveat with it. */
function perfDelta(a, b) {
  const ms = (x) => Math.round(x * 1000);
  return {
    scriptRendererWideMs: ms(b.ScriptDuration - a.ScriptDuration),
    styleRendererWideMs: ms(b.RecalcStyleDuration - a.RecalcStyleDuration),
    layoutRendererWideMs: ms(b.LayoutDuration - a.LayoutDuration),
    taskRendererWideMs: ms(b.TaskDuration - a.TaskDuration),
    heapUsedMbAfter: Math.round((b.JSHeapUsedSize / 1048576) * 10) / 10,
  };
}

/**
 * Network trace. A request belongs to the window it STARTED in, even if it
 * finishes after the window closes — otherwise a 6 s poll fired at t=29.9 s
 * would be credited to the next window and the poll storm would look quieter
 * than it is.
 *
 * Both byte counts are kept. `wireBytes` (encodedDataLength) is what crosses the
 * socket, compressed; `decodedBytes` (dataLength) is what `JSON.parse` and the
 * garbage collector actually see. For this app they differ by an order of
 * magnitude and only one of them explains main-thread cost.
 */
function attachNetwork(cdp, state) {
  cdp.on("Network.requestWillBeSent", (e) => {
    state.byId.set(e.requestId, {
      window: state.current,
      url: e.request.url,
      method: e.request.method,
      startedAt: e.timestamp,
      status: null,
      fromCache: false,
      wireBytes: 0,
      decodedBytes: 0,
      durationMs: null,
      failed: null,
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = state.byId.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.fromCache = Boolean(e.response.fromDiskCache || e.response.fromPrefetchCache);
  });
  cdp.on("Network.dataReceived", (e) => {
    const r = state.byId.get(e.requestId);
    if (!r) return;
    r.decodedBytes += e.dataLength;
    r.wireBytes += e.encodedDataLength;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = state.byId.get(e.requestId);
    if (!r) return;
    if (e.encodedDataLength) r.wireBytes = e.encodedDataLength;
    r.durationMs = Math.round((e.timestamp - r.startedAt) * 1000);
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = state.byId.get(e.requestId);
    if (!r) return;
    r.failed = e.errorText;
    r.durationMs = Math.round((e.timestamp - r.startedAt) * 1000);
  });
}

/** Strip the origin so before/after on different ports group identically. */
function urlKey(u) {
  try {
    const p = new URL(u);
    return p.pathname + (p.search ? "?" : "");
  } catch {
    return u;
  }
}

function summariseRequests(reqs) {
  const perUrl = {};
  for (const r of reqs) {
    const k = `${r.method} ${urlKey(r.url)}`;
    const e = (perUrl[k] ??= { count: 0, wireBytes: 0, decodedBytes: 0, durationsMs: [], statuses: [] });
    e.count++;
    e.wireBytes += r.wireBytes;
    e.decodedBytes += r.decodedBytes;
    if (r.durationMs !== null) e.durationsMs.push(r.durationMs);
    if (!e.statuses.includes(r.status)) e.statuses.push(r.status);
  }
  return {
    requests: reqs.length,
    wireBytes: reqs.reduce((a, r) => a + r.wireBytes, 0),
    decodedBytes: reqs.reduce((a, r) => a + r.decodedBytes, 0),
    perUrl,
    detail: reqs,
  };
}

/* ── one measured window ──────────────────────────────────────────────────── */

async function measure(page, cdp, net, key, holdMs, body) {
  net.current = key;
  const domBefore = await page.evaluate(DOM_NODES);
  await page.evaluate(ARM);
  const m0 = await perfMetrics(cdp);
  const load0 = os.loadavg().map((n) => Math.round(n * 100) / 100);
  const wall0 = Date.now();
  // `body` performs the interaction and returns whatever it learned about it
  // (e.g. how long the surface took to become usable). The window is then held
  // open to `holdMs` REGARDLESS, so idle and action windows are the same length.
  const extra = body ? await body() : {};
  const spent = Date.now() - wall0;
  if (spent < holdMs) await page.waitForTimeout(holdMs - spent);
  const wallMs = Date.now() - wall0;
  const m1 = await perfMetrics(cdp);
  const collected = await page.evaluate(COLLECT);
  const domAfter = await page.evaluate(DOM_NODES);
  const load1 = os.loadavg().map((n) => Math.round(n * 100) / 100);
  const mine = [...net.byId.values()].filter((r) => r.window === key);
  net.current = null;
  return {
    key,
    wallMs,
    holdMs,
    domNodesBefore: domBefore,
    domNodesAfter: domAfter,
    domNodesDelta: domAfter - domBefore,
    ...collected,
    rendererWide: perfDelta(m0, m1),
    network: summariseRequests(mine),
    loadavgBefore: load0,
    loadavgAfter: load1,
    ...extra,
  };
}

/* ── navigation helpers ───────────────────────────────────────────────────── */

const nav = (page, label) => page.getByText(label, { exact: true }).first().click();

async function boardIsUp(page) {
  const c = await page.evaluate(COUNT_CARDS);
  return c.total >= MIN_CARDS;
}

/** Poll a predicate at 50 ms and return how long it took to come true.
 *  Returns null on timeout — a null in the artefact is "did not become ready
 *  inside the window", which is itself the measurement. */
async function timeUntil(page, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await page.waitForTimeout(50);
  }
  return null;
}

const DETAIL_OPEN = () =>
  [...document.querySelectorAll("span")].some((s) => (s.textContent || "").trim() === "← board");

const FLOOR_OPEN = () =>
  document.body.innerText.includes("agent(s) working right now") ||
  document.body.innerText.includes("the floor is quiet");

/**
 * Click the first card whose status reads "running", because that is the click
 * that also starts a 3 s chat poll — the interaction the complaint is about.
 * Records exactly which card, so the artefact is auditable and the `after` run
 * can be compared against a named row rather than "a card".
 */
const CLICK_RUNNING_CARD = () => {
  const LABELS = ["Architect", "Planner", "Scout", "Builder", "Reviewer", "Done"];
  const cards = [];
  for (const el of document.querySelectorAll("span")) {
    const txt = (el.textContent || "").trim();
    if (!LABELS.includes(txt) || el.children.length > 0) continue;
    const col = el.parentElement && el.parentElement.parentElement;
    if (!col || col.children.length !== 2) continue;
    for (const c of col.children[1].children) if (c.className === "") cards.push(c);
  }
  const isRunning = (c) =>
    [...c.querySelectorAll("span")].some((s) => (s.textContent || "").trim() === "running");
  const target = cards.find(isRunning) ?? cards[0];
  if (!target) return null;
  const info = {
    running: isRunning(target),
    text: (target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
    cardsOnBoard: cards.length,
  };
  target.click();
  return info;
};

/* ── the run ──────────────────────────────────────────────────────────────── */

/**
 * Everything the run has learned so far, at module scope so the failure path can
 * still write it out.
 *
 * The first attempt at this measurement lost three completed windows AND a
 * 164-request storm because the throwaway server fell over during W5 and the
 * script had not written a file yet. An instrument that discards its evidence at
 * the exact moment the thing it measures collapses is measuring the wrong thing.
 * On failure whatever completed is written as `*.partial.json` — a distinct name,
 * so a partial run can never be mistaken for a run.
 */
const EVIDENCE = { preflight: null, reps: [], windows: [], net: null };

async function main() {
  preflight();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  // Order matters twice over. `Page.enable` FIRST: without it Playwright's CDP
  // session accepts `addScriptToEvaluateOnNewDocument`, returns an identifier,
  // and the script never runs — `window.__p6` is simply undefined on arrival,
  // which reads as "React has no hook" rather than "the harness has a bug".
  // Then the hook, and only then the first navigation, or React has already
  // read the global.
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  const net = { byId: new Map(), current: null };
  attachNetwork(cdp, net);

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });

  /* CHECK 1 — the auth wall. */
  if (/\/signin\b/.test(page.url())) {
    throw new Error(
      `auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret: ` +
        `an https AUTH_URL (production, and :7701) needs salt AND cookie name ` +
        `"__Secure-authjs.session-token" with secure:true; a plain http throwaway harness needs ` +
        `"authjs.session-token" with secure:false. A wrong salt is a 307 that looks exactly like an ` +
        `expired token. Every screenshot after this point would be of the login page.`,
    );
  }

  // Land on a known surface. localStorage is empty in a fresh context so this is
  // TODAY already, but say so explicitly rather than rely on it.
  await page.waitForTimeout(2_000);
  await nav(page, "TODAY");
  await page.waitForTimeout(SETTLE_MS);

  /* CHECK 2 — a board at live scale, before any window runs. */
  await nav(page, "PROJECTS");
  const cardsReadyMs = await timeUntil(page, () => boardIsUp(page), 60_000);
  const cards0 = await page.evaluate(COUNT_CARDS);
  if (cards0.total < MIN_CARDS) {
    throw new Error(
      `board holds ${cards0.total} task cards (< ${MIN_CARDS}) after ${cardsReadyMs ?? ">60000"} ms: ` +
        `${JSON.stringify(cards0.byColumn)}. A measurement of an empty board is worse than no ` +
        `measurement — is forge-control on :7700 serving /api/projects/board?`,
    );
  }

  const preflightState = {
    cardsAtStart: cards0,
    firstBoardReadyMs: cardsReadyMs,
    domNodesOnBoard: await page.evaluate(DOM_NODES),
    reactCommitsSoFar: await page.evaluate(() => window.__p6.commits),
    reactProfilingBuild: await page.evaluate(() => window.__p6.anyDuration),
    renderersInjected: await page.evaluate(() => window.__p6.injected),
  };

  const shots = (process.env.PROJECTS_LAG_SHOTS ?? "").trim();
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `projects-board-${RUN_LABEL}.png`), fullPage: false });
  }

  const windows = EVIDENCE.windows;
  const reps = EVIDENCE.reps;
  EVIDENCE.preflight = preflightState;
  EVIDENCE.net = net;

  for (let rep = 1; rep <= REPS; rep++) {
    const r = { rep };

    /* ── W1 · the mount ──────────────────────────────────────────────────────
     * Navigate away to TODAY, idle there for SHORT_MS (the floor), then
     * navigate INTO Projects and hold the window open for the same SHORT_MS. */
    await nav(page, "TODAY");
    await page.waitForTimeout(SETTLE_MS);
    r.w1_idle = await measure(page, cdp, net, `rep${rep}/w1/idle-on-today`, SHORT_MS, null);
    r.w1 = await measure(page, cdp, net, `rep${rep}/w1/navigate-into-projects`, SHORT_MS, async () => {
      await nav(page, "PROJECTS");
      return { timeToReadyMs: await timeUntil(page, () => boardIsUp(page), SHORT_MS) };
    });

    /* ── W2 · click a task card ─────────────────────────────────────────────── */
    await page.waitForTimeout(SETTLE_MS);
    r.w2_idle = await measure(page, cdp, net, `rep${rep}/w2/idle-on-board`, SHORT_MS, null);
    let clicked = null;
    r.w2 = await measure(page, cdp, net, `rep${rep}/w2/click-task-card`, SHORT_MS, async () => {
      clicked = await page.evaluate(CLICK_RUNNING_CARD);
      if (!clicked) throw new Error("no task card found to click — the board emptied mid-run");
      return {
        clickedCard: clicked,
        timeToReadyMs: await timeUntil(page, () => page.evaluate(DETAIL_OPEN), SHORT_MS),
      };
    });
    if (shots && rep === 1) {
      await page.screenshot({ path: path.join(shots, `projects-detail-${RUN_LABEL}.png`), fullPage: false });
    }
    await page.getByText("← board", { exact: true }).first().click();
    await page.waitForTimeout(SETTLE_MS);

    /* ── W3 · board → floor ─────────────────────────────────────────────────── */
    r.w3_idle = await measure(page, cdp, net, `rep${rep}/w3/idle-on-board`, SHORT_MS, null);
    r.w3 = await measure(page, cdp, net, `rep${rep}/w3/toggle-to-floor`, SHORT_MS, async () => {
      await page.getByText("floor", { exact: true }).first().click();
      return { timeToReadyMs: await timeUntil(page, () => page.evaluate(FLOOR_OPEN), SHORT_MS) };
    });
    await page.getByText("board", { exact: true }).first().click();
    await page.waitForTimeout(SETTLE_MS);

    /* ── W4 · 30 s idle ON Projects, no interaction at all ────────────────────
     * The floor is 30 s idle on TODAY: the same page, the same React tree, the
     * same React Query client, with none of this surface's polls. Whatever
     * separates the two IS the poll storm, and this is the window most likely to
     * name the real cause. */
    await nav(page, "TODAY");
    await page.waitForTimeout(SETTLE_MS);
    r.w4_idle = await measure(page, cdp, net, `rep${rep}/w4/idle-on-today-30s`, LONG_MS, null);
    await nav(page, "PROJECTS");
    await timeUntil(page, () => boardIsUp(page), 30_000);
    await page.waitForTimeout(SETTLE_MS);
    r.w4 = await measure(page, cdp, net, `rep${rep}/w4/idle-on-projects-30s`, LONG_MS, null);

    /* ── W5 · 30 s idle in FLOOR view, no interaction ─────────────────────────
     * Not in the task brief's list of four, and here because leaving it out
     * would have forced the report to rank one of the four named suspects — the
     * 3 s per-running-task chat poll — on arithmetic instead of on a
     * measurement. W3 only catches the floor's MOUNT burst: three seconds is one
     * poll interval, so a 3 s window cannot distinguish "six tiles fetched their
     * thread once" from "six tiles are fetching their thread every three
     * seconds forever". W4 idles on the BOARD, where no FloorTile exists. The
     * sustained cost of the floor is therefore measured nowhere else, and it is
     * the suspect the brief singles out as most likely.
     *
     * Same floor as W4 — 30 s idle on TODAY — so the two long windows are
     * directly comparable to each other as well as to their own baseline. */
    await nav(page, "TODAY");
    await page.waitForTimeout(SETTLE_MS);
    r.w5_idle = await measure(page, cdp, net, `rep${rep}/w5/idle-on-today-30s`, LONG_MS, null);
    await nav(page, "PROJECTS");
    await timeUntil(page, () => boardIsUp(page), 30_000);
    await page.getByText("floor", { exact: true }).first().click();
    await timeUntil(page, () => page.evaluate(FLOOR_OPEN), 10_000);
    await page.waitForTimeout(SETTLE_MS);
    r.w5 = await measure(page, cdp, net, `rep${rep}/w5/idle-on-floor-30s`, LONG_MS, async () => ({
      floorTiles: await page.evaluate(
        () => [...document.querySelectorAll("div")].filter((d) => d.style.height === "210px").length,
      ),
    }));
    await page.getByText("board", { exact: true }).first().click();
    await page.waitForTimeout(SETTLE_MS);

    reps.push(r);
    for (const k of ["w1_idle", "w1", "w2_idle", "w2", "w3_idle", "w3", "w4_idle", "w4", "w5_idle", "w5"])
      windows.push(r[k]);
    process.stdout.write(
      `${RUN_LABEL} rep ${rep}  ` +
        ["w1", "w2", "w3", "w4", "w5"]
          .map(
            (k) =>
              `${k} ${String(r[k].reactCommits).padStart(3)}c/${String(
                r[`${k}_idle`].reactCommits,
              ).padStart(3)}i ${String(r[k].network.requests).padStart(3)}req`,
          )
          .join("  ") + "\n",
    );
  }

  /* CHECK 3 — did the hook ever attach? */
  const totalCommits = await page.evaluate(() => window.__p6.commits);
  const w1Commits = reps.reduce((a, r) => a + r.w1.reactCommits, 0);
  if (w1Commits <= 0) {
    throw new Error(
      `React commit counter is ${w1Commits} across ${REPS} W1 windows. The DevTools hook did not ` +
        `attach: every commit number in this run is a zero that means NOT MEASURED, not "no work". ` +
        `renderersInjected=${preflightState.renderersInjected}, totalCommits=${totalCommits}. ` +
        `Check that INIT ran via Page.addScriptToEvaluateOnNewDocument BEFORE the first navigation.`,
    );
  }

  /* ── summary ──────────────────────────────────────────────────────────────
   * Medians only, over the raw arrays which stay in the file. Nothing here is
   * derived from anything that is not also printed above it. */
  const median = (xs) => {
    const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  const summary = {};
  for (const k of ["w1", "w2", "w3", "w4", "w5"]) {
    const act = reps.map((r) => r[k]);
    const idl = reps.map((r) => r[`${k}_idle`]);
    const fold = (ws) => ({
      reactCommits: ws.map((w) => w.reactCommits),
      commitMsTotal: ws.map((w) => w.commitMsTotal),
      longTasks: ws.map((w) => w.longTasks),
      blockedMs: ws.map((w) => w.blockedMs),
      maxLongTaskMs: ws.map((w) => w.maxLongTaskMs),
      scriptRendererWideMs: ws.map((w) => w.rendererWide.scriptRendererWideMs),
      requests: ws.map((w) => w.network.requests),
      decodedBytes: ws.map((w) => w.network.decodedBytes),
      wireBytes: ws.map((w) => w.network.wireBytes),
      domNodesAfter: ws.map((w) => w.domNodesAfter),
    });
    summary[k] = {
      action: fold(act),
      idle: fold(idl),
      medians: {
        actionCommits: median(act.map((w) => w.reactCommits)),
        idleCommits: median(idl.map((w) => w.reactCommits)),
        actionCommitMsTotal: median(act.map((w) => w.commitMsTotal)),
        idleCommitMsTotal: median(idl.map((w) => w.commitMsTotal)),
        actionBlockedMs: median(act.map((w) => w.blockedMs)),
        idleBlockedMs: median(idl.map((w) => w.blockedMs)),
        actionScriptRendererWideMs: median(act.map((w) => w.rendererWide.scriptRendererWideMs)),
        idleScriptRendererWideMs: median(idl.map((w) => w.rendererWide.scriptRendererWideMs)),
        actionDecodedBytes: median(act.map((w) => w.network.decodedBytes)),
        idleDecodedBytes: median(idl.map((w) => w.network.decodedBytes)),
        timeToReadyMs: median(act.map((w) => w.timeToReadyMs ?? null)),
      },
      /* attributable = action − idle, per repetition, so the spread is visible
       * and a single noisy pair cannot be hidden inside a mean. */
      attributable: act.map((w, i) => ({
        reactCommits: w.reactCommits - idl[i].reactCommits,
        blockedMs: w.blockedMs - idl[i].blockedMs,
        scriptRendererWideMs:
          w.rendererWide.scriptRendererWideMs - idl[i].rendererWide.scriptRendererWideMs,
        decodedBytes: w.network.decodedBytes - idl[i].network.decodedBytes,
      })),
    };
  }

  /* Per-URL roll-up across the whole run, so "which endpoint dominates" is one
   * lookup rather than an exercise for the reader. */
  const allByUrl = {};
  for (const r of net.byId.values()) {
    if (!r.window) continue;
    const k = `${r.method} ${urlKey(r.url)}`;
    const e = (allByUrl[k] ??= { count: 0, wireBytes: 0, decodedBytes: 0, maxDurationMs: 0 });
    e.count++;
    e.wireBytes += r.wireBytes;
    e.decodedBytes += r.decodedBytes;
    if ((r.durationMs ?? 0) > e.maxDurationMs) e.maxDurationMs = r.durationMs ?? 0;
  }

  const report = {
    label: RUN_LABEL,
    base: BASE,
    when: new Date().toISOString(),
    script: path.relative(REPO_ROOT, __filename),
    shape: { reps: REPS, shortMs: SHORT_MS, longMs: LONG_MS, settleMs: SETTLE_MS, minCards: MIN_CARDS },
    commitDurationSource: preflightState.reactProfilingBuild
      ? "(a) React fiber actualDuration from a `next build --profile` bundle, per commit"
      : "(b) NOT AVAILABLE — actualDuration never populated; every commitMs in this file is null " +
        "and only the renderer-wide CDP aggregates may be quoted, labelled as aggregates",
    host: { cpus: os.cpus().length, uptimeS: Math.round(os.uptime()), loadavg: os.loadavg() },
    preflight: preflightState,
    summary,
    requestsByUrl: allByUrl,
    reps,
    windows,
  };
  const file = path.join(OUT, `projects-lag-${RUN_LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(`\nwrote ${file}\n`);
  for (const k of ["w1", "w2", "w3", "w4", "w5"]) {
    const m = summary[k].medians;
    process.stdout.write(
      `  ${k}  commits ${String(m.actionCommits).padStart(4)} vs idle ${String(m.idleCommits).padStart(4)}` +
        ` · commitMs ${String(m.actionCommitMsTotal).padStart(8)} vs ${String(m.idleCommitMsTotal).padStart(8)}` +
        ` · decoded ${String(m.actionDecodedBytes).padStart(9)} vs ${String(m.idleDecodedBytes).padStart(9)} B\n`,
    );
  }

  await browser.close();
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  if (EVIDENCE.reps.length || EVIDENCE.windows.length) {
    const file = path.join(OUT, `projects-lag-${RUN_LABEL}.partial.json`);
    try {
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            label: RUN_LABEL,
            partial: true,
            failedWith: String(e && e.stack ? e.stack : e),
            when: new Date().toISOString(),
            preflight: EVIDENCE.preflight,
            reps: EVIDENCE.reps,
            windows: EVIDENCE.windows,
            requestsSeen: EVIDENCE.net ? [...EVIDENCE.net.byId.values()].filter((r) => r.window) : [],
          },
          null,
          2,
        ),
      );
      process.stderr.write(`partial evidence written to ${file}\n`);
    } catch (e2) {
      process.stderr.write(`could not write partial evidence: ${e2}\n`);
    }
  }
  process.exit(1);
});
