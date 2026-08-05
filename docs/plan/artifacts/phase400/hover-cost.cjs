/**
 * hover-cost.cjs — measures what hovering the chat rail actually costs
 * (NFU2, round 401a; Konrad: "hovering the sidebar still lags").
 *
 * Two numbers, both taken in a real Chromium against a real server:
 *
 *   1. REACT COMMITS attributable to hover. A shim installed as
 *      `__REACT_DEVTOOLS_GLOBAL_HOOK__` BEFORE any bundle loads counts every
 *      `onCommitFiberRoot` — i.e. every render commit react-dom performs. The
 *      app polls on its own (chat list 8s, detail 3s/20s, agents 4s), so a raw
 *      count means nothing: the script measures an idle window first and
 *      reports `hover − idle` as the cost of the pointer.
 *   2. DOM MUTATIONS inside the rail's scroll container during the same two
 *      windows. This is the visible half of the same story: the old rail
 *      swapped `<age>` for `<✕>` on every pointer enter/leave, so each row the
 *      pointer crossed detached and re-created a node.
 *
 * BEFORE/AFTER is taken by pointing HOVER_URL at two servers — production
 * :7701 (running main, the useState rail) and a `next start` of this
 * worktree's build. No code is edited between runs; the two builds are the
 * comparison.
 *
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     HOVER_URL=http://127.0.0.1:7701 HOVER_LABEL=before \
 *     node docs/plan/artifacts/phase400/hover-cost.cjs
 *
 * Chromium resolution is lifted verbatim from scripts/checks/frozen-dom.cjs:
 * the global playwright wants a browser build the shared cache does not have,
 * and `playwright install` would write into a cache other agents share.
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const candidates = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const BASE = process.env.HOVER_URL ?? "http://127.0.0.1:7701";
const LABEL = process.env.HOVER_LABEL ?? "unlabelled";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT_DIR = __dirname;
const WINDOW_MS = 10_000; // per NFU2: a 10s hover sweep
const SWEEP_STEP_MS = 120; // one pointer move per step → ~83 crossings / 10s

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see frozen-dom.cjs header)");

/** Counts react-dom commits. Must be installed before the bundle evaluates. */
const INSTALL_HOOK = () => {
  window.__forgeCommits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    _renderers: new Map(),
    _nextId: 0,
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      const id = ++this._nextId;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {
      window.__forgeCommits += 1;
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
    emit() {},
    on() {},
    off() {},
    sub() {
      return () => {};
    },
    getFiberRoots() {
      return new Set();
    },
    setStrictMode() {},
  };
};

/** The rail's scrolling list, found structurally so the SAME selector works on
 *  both builds (the new one has a `.chat-row` class the old one does not). */
const FIND_RAIL = () => {
  const rail = Array.from(document.querySelectorAll("div")).find(
    (d) => d.style && d.style.width === "300px",
  );
  if (!rail) return null;
  const scroller = Array.from(rail.querySelectorAll("div")).find(
    (d) => d.style && d.style.overflowY === "auto",
  );
  return scroller ?? null;
};

async function main() {
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
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.addInitScript(INSTALL_HOOK);
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale (re-mint, 60min)");
  await page.waitForTimeout(2_000);
  // /desktop opens on TODAY; the rail under test lives on the CHAT destination.
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000); // let the first polls land and the rail fill

  const rowBoxes = await page.evaluate(() => {
    const rail = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    if (!rail) return [];
    const scroller = Array.from(rail.querySelectorAll("div")).find(
      (d) => d.style && d.style.overflowY === "auto",
    );
    if (!scroller) return [];
    return Array.from(scroller.children)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height };
      })
      .filter((b) => b.h > 20 && b.y < 980);
  });
  if (rowBoxes.length < 2)
    throw new Error(
      `only ${rowBoxes.length} rail rows on screen at ${BASE} — cannot measure a hover sweep`,
    );

  // Instrument: reset counters and attach a MutationObserver to the rail.
  const arm = () =>
    page.evaluate(() => {
      window.__forgeCommits = 0;
      window.__forgeMutations = 0;
      if (window.__forgeObs) window.__forgeObs.disconnect();
      const rail = Array.from(document.querySelectorAll("div")).find(
        (d) => d.style && d.style.width === "300px",
      );
      const scroller = Array.from(rail.querySelectorAll("div")).find(
        (d) => d.style && d.style.overflowY === "auto",
      );
      window.__forgeObs = new MutationObserver((recs) => {
        window.__forgeMutations += recs.length;
      });
      window.__forgeObs.observe(scroller, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });
  const read = () =>
    page.evaluate(() => ({
      commits: window.__forgeCommits,
      mutations: window.__forgeMutations,
    }));

  // ── window 1: idle. Pointer parked far away from the rail. ──────────────
  await page.mouse.move(1400, 500);
  await page.waitForTimeout(500);
  await arm();
  await page.waitForTimeout(WINDOW_MS);
  const idle = await read();

  // ── window 2: hover sweep. Pointer walks the rows for the same duration. ─
  await arm();
  const t0 = Date.now();
  let crossings = 0;
  while (Date.now() - t0 < WINDOW_MS) {
    const b = rowBoxes[crossings % rowBoxes.length];
    await page.mouse.move(b.x, b.y);
    crossings += 1;
    await page.waitForTimeout(SWEEP_STEP_MS);
  }
  const hover = await read();
  await page.mouse.move(1400, 500);

  const result = {
    label: LABEL,
    base: BASE,
    rows_on_screen: rowBoxes.length,
    window_ms: WINDOW_MS,
    crossings,
    idle,
    hover,
    attributable_to_hover: {
      commits: hover.commits - idle.commits,
      mutations: hover.mutations - idle.mutations,
    },
  };
  const out = path.join(OUT_DIR, `hover-cost-${LABEL}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`→ ${out}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
