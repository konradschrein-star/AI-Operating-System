/**
 * typing-1871.cjs — round 1871, finding 1: "a customer expects a text box to
 * feel free".
 *
 * WHAT THIS MEASURES. The round-1870 customer test reported 60 keystrokes
 * taking 5,541 ms in the manager-chat composer (92 ms/key) against a 1.0 ms/key
 * floor in a bare textarea in the same browser, and 17–30 long tasks over six
 * seconds of typing against 2 tasks while idle. The chat-list search box
 * measured 83 ms/key. This script reproduces those three numbers on demand so
 * the fix can be measured rather than asserted.
 *
 * It is the typing analogue of `docs/plan/artifacts/phase1290/hover/hover-1291.cjs`
 * and keeps that file's discipline verbatim:
 *
 *  • INTERLEAVED IDLE BASELINE. Every typing window is paired with an idle
 *    window of the same duration on the same surface, alternating idle/type,
 *    so this VPS's ambient long-task floor is visible as a distribution rather
 *    than subtracted from a guess. `attributable = type − idle`.
 *
 *  • AN IN-PAGE CONTROL. A bare `<textarea>` is injected into the SAME page,
 *    the same document, the same renderer, and typed into with the same driver
 *    at the same cadence. That is the floor: whatever it costs is what the
 *    browser and Playwright cost, and everything above it is the application.
 *
 *  • AN ANTI-LYING CHECK. After each typing window the script reads the target
 *    element's `value` back and requires that it grew by exactly the number of
 *    characters sent. A window whose keystrokes did not land is fatal — it must
 *    not be quotable as a typing measurement. `TYPING_ALLOW_MISS=1` downgrades
 *    it to a recorded warning, for diagnosing a miss.
 *
 *  • RAW OUTPUT, UNFILTERED. Every long task is emitted whole, every per-window
 *    number is in the JSON, and `os.loadavg()` is sampled around every pair so
 *    a noisy box shows up in the artifact instead of hiding in a mean.
 *
 * WHAT IT DOES NOT DO. It does not attribute a long task to a component. The
 * `longtask` entry type cannot; React's own profiler could, and the phase-1290
 * corpus already establishes that this project quotes aggregate counters as
 * aggregates. `scriptMs`/`layoutMs` below are Chrome's renderer-wide counters
 * via CDP `Performance.getMetrics`, deltas across each window, and they are
 * labelled as aggregates everywhere they are reported.
 *
 * WHERE IT RUNS. A worktree build served on a throwaway port, never
 * `/opt/forge-ai-os`, never production. Recipe in the sibling README.
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

const BASE = (process.env.TYPING_BASE_URL ?? "http://127.0.0.1:7799").trim();
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
/** The chat the customer test typed into — the big one, 449 tool rows and 117
 *  comms cards. A small chat would not reproduce the complaint. */
const CHAT_RUN_ID = (
  process.env.TYPING_CHAT_ID ?? "bfd1283a-b71b-4f35-b577-7d09aad803f2"
).trim();
const PAIRS = Number(process.env.TYPING_PAIRS ?? 3);
/** Keystrokes per typing window. 60 is the customer test's own batch size. */
const KEYS = Number(process.env.TYPING_KEYS ?? 60);
const RUN_LABEL = (process.env.TYPING_RUN_LABEL ?? "before").trim();
const ALLOW_MISS = process.env.TYPING_ALLOW_MISS === "1";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const COMMIT_ARTIFACT = process.argv.includes("--commit-artifact");
const TYPING_OUT = (process.env.TYPING_OUT ?? "").trim();
const OUT = path.resolve(TYPING_OUT || (COMMIT_ARTIFACT ? __dirname : "/tmp/typing-1871-out"));
const OPTED_IN = COMMIT_ARTIFACT || TYPING_OUT !== "";

function preflight() {
  if (!OPTED_IN && (OUT === REPO_ROOT || OUT.startsWith(REPO_ROOT + path.sep))) {
    throw new Error(
      `typing-1871.cjs refuses to write inside the repo without an explicit opt-in.\n` +
        `  resolved output dir: ${OUT}\n` +
        `  pass --commit-artifact, or set TYPING_OUT=<dir>.`,
    );
  }
  fs.mkdirSync(OUT, { recursive: true });
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint it per the README");
  if (BASE.includes("os.schreinercontentsystems.com")) {
    throw new Error("round 1871 is a build task: production URLs are out of bounds");
  }
}

/* ── in-page observers ────────────────────────────────────────────────────── */

const ARM = () => {
  window.__t = { longTasks: [], t0: performance.now() };
  window.__po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__t.longTasks.push({
        startTime: Math.round(e.startTime * 100) / 100,
        duration: Math.round(e.duration * 100) / 100,
        name: e.name,
      });
    }
  });
  try {
    window.__po.observe({ entryTypes: ["longtask"] });
    window.__t.longtaskSupported = true;
  } catch {
    window.__t.longtaskSupported = false;
  }
};

const COLLECT = () => {
  try {
    window.__po.disconnect();
  } catch {
    /* never armed — longtaskSupported says so */
  }
  const t = window.__t;
  const durations = t.longTasks.map((x) => x.duration);
  return {
    longTasks: t.longTasks.length,
    blockedMs: Math.round(durations.reduce((a, b) => a + b, 0)),
    maxLongTaskMs: durations.length ? Math.max(...durations) : 0,
    longTaskDetail: t.longTasks,
    longtaskSupported: t.longtaskSupported,
    windowMs: Math.round(performance.now() - t.t0),
  };
};

/** The control. Injected once, styled out of the way, never removed — so the
 *  DOM it adds is present during the application windows too and cannot be
 *  claimed as a reason the app looked slower. */
const ADD_CONTROL = () => {
  if (document.getElementById("__typing_control")) return;
  const ta = document.createElement("textarea");
  ta.id = "__typing_control";
  ta.style.cssText =
    "position:fixed;left:-9999px;top:0;width:300px;height:80px;font-size:13px;";
  document.body.appendChild(ta);
};

/* ── driver ───────────────────────────────────────────────────────────────── */

const LOREM =
  "the operator panel should feel free under the fingers and never lag behind ";

async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
  return {
    ScriptDuration: get("ScriptDuration"),
    RecalcStyleDuration: get("RecalcStyleDuration"),
    LayoutDuration: get("LayoutDuration"),
    TaskDuration: get("TaskDuration"),
  };
}

function deltaMs(before, after) {
  return {
    scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
  };
}

/** One measured window: arm, run `body`, collect. */
async function window_(page, cdp, body) {
  await page.evaluate(ARM);
  const m0 = await metrics(cdp);
  const wall0 = Date.now();
  const extra = await body();
  const wallMs = Date.now() - wall0;
  const m1 = await metrics(cdp);
  const collected = await page.evaluate(COLLECT);
  return { ...collected, wallMs, ...deltaMs(m0, m1), ...extra };
}

/**
 * Type `KEYS` characters into `selector` and report the cost per key.
 *
 * `page.keyboard.type` with `delay: 0` is the fastest the driver can deliver
 * keys, which is what makes the number a measure of the page rather than of a
 * chosen cadence. The value is read before and after: a window where the text
 * did not land is not a measurement of typing.
 */
async function typeWindow(page, cdp, selector, label) {
  const before = await page.$eval(selector, (el) => el.value.length);
  const text = LOREM.slice(0, KEYS);
  const out = await window_(page, cdp, async () => {
    await page.focus(selector);
    await page.keyboard.type(text, { delay: 0 });
    return {};
  });
  const after = await page.$eval(selector, (el) => el.value.length);
  const landed = after - before;
  const ok = landed === KEYS;
  if (!ok && !ALLOW_MISS) {
    throw new Error(
      `TYPING WINDOW INVALID (${label}): sent ${KEYS} keys, ${landed} landed in ${selector}. ` +
        `A window whose keystrokes did not arrive is not a typing measurement.`,
    );
  }
  // Leave the field as we found it, so the next window starts from the same
  // length and the autogrow height is not a hidden variable.
  await page.$eval(selector, (el) => {
    /* React installs its own `value` setter on the instance, so assigning
     * `el.value` directly is swallowed. Call the PROTOTYPE's setter — and pick
     * the prototype from the element, because the chat-list search box is an
     * `<input>` and the composer is a `<textarea>`. */
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return {
    ...out,
    label,
    keys: KEYS,
    keysLanded: landed,
    keystrokesOk: ok,
    msPerKey: Math.round((out.wallMs / KEYS) * 100) / 100,
  };
}

async function idleWindow(page, cdp, ms, label) {
  const out = await window_(page, cdp, async () => {
    await page.waitForTimeout(ms);
    return {};
  });
  return { ...out, label };
}

function loadSample() {
  return { loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100) };
}

async function main() {
  preflight();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const url = new URL(BASE);
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle" });
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForSelector(".chat-row", { timeout: 30_000 });

  // Open the big chat. Clicking by run id keeps the choice reproducible.
  const opened = await page.evaluate((id) => {
    const row = document.querySelector(`[data-chat-id="${id}"]`);
    if (!row) return null;
    row.click();
    return id;
  }, CHAT_RUN_ID);
  if (!opened) {
    await page.locator(".chat-row").first().click();
  }
  await page.waitForSelector("textarea", { timeout: 30_000 });
  // Let the transcript, the team panel and the plan board all settle, so the
  // measurement is of a loaded surface rather than of its first paint.
  await page.waitForTimeout(6000);

  const composer = await page.evaluate(() => {
    const tas = [...document.querySelectorAll("textarea")];
    const c = tas.find((t) => (t.placeholder ?? "").includes("Enter to send"));
    if (c) c.setAttribute("data-typing-target", "composer");
    return Boolean(c);
  });
  if (!composer) throw new Error("composer textarea not found — is a chat open?");
  const search = await page.evaluate(() => {
    const s = [...document.querySelectorAll("input,textarea")].find((t) =>
      (t.placeholder ?? "").includes("search past chats"),
    );
    if (s) s.setAttribute("data-typing-target", "search");
    return Boolean(s);
  });
  await page.evaluate(ADD_CONTROL);

  const surfaces = [
    { key: "composer", selector: '[data-typing-target="composer"]' },
    ...(search ? [{ key: "search", selector: '[data-typing-target="search"]' }] : []),
    { key: "control-textarea", selector: "#__typing_control" },
  ];

  const transcript = await page.evaluate(() => ({
    commsCards: document.querySelectorAll("[data-comms-direction]").length,
    toolRows: document.querySelectorAll("[data-tool-row]").length,
    teamRows: document.querySelectorAll("[data-team-row]").length,
  }));

  const pairs = [];
  for (let i = 0; i < PAIRS; i++) {
    for (const s of surfaces) {
      const loadBefore = loadSample();
      // Idle first, always: the floor is measured before the thing it is the
      // floor for, never after, so a warm cache cannot flatter the app window.
      const idle = await idleWindow(page, cdp, 3000, `${s.key}:idle`);
      const type = await typeWindow(page, cdp, s.selector, `${s.key}:type`);
      pairs.push({
        pair: i + 1,
        surface: s.key,
        idle,
        type,
        attributable: {
          longTasks: type.longTasks - idle.longTasks,
          blockedMs: type.blockedMs - idle.blockedMs,
        },
        loadBefore,
        loadAfter: loadSample(),
      });
      process.stdout.write(
        `${RUN_LABEL} pair ${i + 1} ${s.key.padEnd(16)} ` +
          `${String(type.msPerKey).padStart(7)} ms/key  ` +
          `type ${type.longTasks} tasks/${type.blockedMs}ms  ` +
          `idle ${idle.longTasks} tasks/${idle.blockedMs}ms\n`,
      );
    }
  }

  const bySurface = {};
  for (const s of surfaces) {
    const mine = pairs.filter((p) => p.surface === s.key);
    const perKey = mine.map((p) => p.type.msPerKey).sort((a, b) => a - b);
    bySurface[s.key] = {
      pairs: mine.length,
      msPerKeyMedian: perKey[Math.floor(perKey.length / 2)],
      msPerKeyAll: perKey,
      typeLongTasks: mine.map((p) => p.type.longTasks),
      idleLongTasks: mine.map((p) => p.idle.longTasks),
      typeBlockedMs: mine.map((p) => p.type.blockedMs),
      idleBlockedMs: mine.map((p) => p.idle.blockedMs),
      attributableLongTasks: mine.map((p) => p.attributable.longTasks),
      scriptMsPerWindow: mine.map((p) => p.type.scriptMs),
      allKeystrokesLanded: mine.every((p) => p.type.keystrokesOk),
    };
  }

  const report = {
    label: RUN_LABEL,
    base: BASE,
    chat: CHAT_RUN_ID,
    keysPerWindow: KEYS,
    pairsPerSurface: PAIRS,
    when: new Date().toISOString(),
    host: { cpus: os.cpus().length, uptimeS: Math.round(os.uptime()) },
    transcript,
    summary: bySurface,
    pairs,
  };
  const file = path.join(OUT, `typing-1871.${RUN_LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  process.stdout.write(`\nwrote ${file}\n`);
  for (const [k, v] of Object.entries(bySurface)) {
    process.stdout.write(
      `  ${k.padEnd(18)} median ${String(v.msPerKeyMedian).padStart(7)} ms/key ` +
        `· type longtasks ${JSON.stringify(v.typeLongTasks)} ` +
        `· idle ${JSON.stringify(v.idleLongTasks)}\n`,
    );
  }

  await browser.close();
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});
