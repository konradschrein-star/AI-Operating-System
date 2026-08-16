/**
 * hover-904.cjs — U34 step 4: does hovering PRODUCTION lag?
 *
 * PHASE 900, round 904. This is NOT a re-run of the NFU2 protocol — phases 400
 * and 500 own that, and their numbers are quoted in verification-904.md. This
 * is the qualitative live check the brief asks for, made numeric so it is not
 * one agent's opinion: sweep the pointer across the real team panel and the
 * real chat rail on production and count what the hover actually costs.
 *
 * Measured per surface, over a 10s sweep:
 *   crossings   — pointermove events that landed on a NEW row
 *   mutations   — DOM mutations observed during the sweep (MutationObserver,
 *                 subtree+attributes+characterData), minus an idle baseline
 *                 taken over the same window with the pointer parked
 *   longTasks   — PerformanceObserver "longtask" entries (>50ms main-thread
 *                 blocks). This is the one a human feels as "lag".
 *   maxLongTask — the worst of them, ms
 *
 * Konrad's original complaint was "hovering the sidebar still lags". A sweep
 * that produces zero long tasks and zero net mutations is the machine-checkable
 * form of "it does not".
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = "/root/.cache/ms-playwright";
  return fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
}

const BASE = "https://os.schreinercontentsystems.com";
const COOKIE = (process.env.FORGE_SECURE_COOKIE ?? "").trim();
const CHAT_TEXT = "Okay when I click the file section";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty");

const report = { base: BASE, surfaces: {}, errors: [] };

/** Arm the observers. Returns nothing; results are read back by `collect`. */
const ARM = () => {
  window.__h = { mutations: 0, longTasks: [], t0: performance.now() };
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
    for (const e of l.getEntries()) window.__h.longTasks.push(Math.round(e.duration));
  });
  try {
    window.__po.observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported — reported as null below */
  }
};
const COLLECT = () => {
  window.__mo.disconnect();
  try {
    window.__po.disconnect();
  } catch {}
  const h = window.__h;
  return {
    mutations: h.mutations,
    longTasks: h.longTasks.length,
    maxLongTaskMs: h.longTasks.length ? Math.max(...h.longTasks) : 0,
    windowMs: Math.round(performance.now() - h.t0),
  };
};

/** Park the pointer and observe for the same window — the honest baseline.
 *  Without it, a polling app's own re-renders get billed to hover. */
async function idleBaseline(page, ms) {
  await page.evaluate(ARM);
  await page.waitForTimeout(ms);
  return page.evaluate(COLLECT);
}

async function sweep(page, boxes, ms) {
  await page.evaluate(ARM);
  const start = Date.now();
  let crossings = 0;
  while (Date.now() - start < ms) {
    for (const b of boxes) {
      if (Date.now() - start >= ms) break;
      await page.mouse.move(b.x, b.y, { steps: 2 });
      crossings++;
      await page.waitForTimeout(40);
    }
  }
  const res = await page.evaluate(COLLECT);
  return { crossings, ...res };
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    { name: "__Secure-authjs.session-token", value: COOKIE, domain: new URL(BASE).hostname,
      path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_500);

  // ---- surface 1: the chat rail (Konrad's "sidebar") -------------------
  const railBoxes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((el) => {
      const t = (el.textContent || "");
      return /completed|running|queued|stuck/.test(t) && el.getBoundingClientRect().height > 40 &&
             el.getBoundingClientRect().height < 140 && el.getBoundingClientRect().left < 500;
    });
    return rows.slice(0, 24).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  });
  console.log(`rail rows targeted: ${railBoxes.length}`);
  await page.mouse.move(900, 500);
  const railIdle = await idleBaseline(page, 10_000);
  const railHover = await sweep(page, railBoxes, 10_000);
  report.surfaces.rail = {
    rows: railBoxes.length, idle: railIdle, hover: railHover,
    attributable: {
      mutations: railHover.mutations - railIdle.mutations,
      longTasks: railHover.longTasks - railIdle.longTasks,
    },
  };
  console.log(`RAIL  idle=${JSON.stringify(railIdle)}\n      hover=${JSON.stringify(railHover)}`);

  // ---- surface 2: the team panel (20+ rows) ----------------------------
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(5_000);
  const teamBoxes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-team-row]")];
    const src = rows.length
      ? rows
      : [...document.querySelectorAll("div")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left > 1300 && r.height > 12 && r.height < 60 && r.width > 100;
        });
    return src.slice(0, 26).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  });
  console.log(`team rows targeted: ${teamBoxes.length}`);
  await page.mouse.move(900, 500);
  const teamIdle = await idleBaseline(page, 10_000);
  const teamHover = await sweep(page, teamBoxes, 10_000);
  report.surfaces.team = {
    rows: teamBoxes.length, idle: teamIdle, hover: teamHover,
    attributable: {
      mutations: teamHover.mutations - teamIdle.mutations,
      longTasks: teamHover.longTasks - teamIdle.longTasks,
    },
  };
  console.log(`TEAM  idle=${JSON.stringify(teamIdle)}\n      hover=${JSON.stringify(teamHover)}`);

  fs.writeFileSync(path.join(OUT, "hover-904.json"), JSON.stringify(report, null, 2));
  console.log(`\nerrors: ${report.errors.length}`);
  await browser.close();
})();
