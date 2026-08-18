/**
 * lib.cjs — round 1875's evidence harness (builder side).
 *
 * Deliberately the round-1874 TESTER's harness, copied rather than reinvented:
 * the point of this run is to answer the five findings in the same terms they
 * were raised in, against the same stack shape.
 *
 *   web :7844  — worktree `next start`, this branch's build
 *   api :7842  — worktree routers via scripts/checks/serve-v3-7798.ts
 *   db         — the real content_forge, READ ONLY. Every dismissal write is
 *                stubbed in the page and every run-control verb is blocked, so
 *                nothing here can hide a row of Konrad's or touch a live run.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function chrome() {
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

const BASE = process.env.R1875_BASE ?? "http://127.0.0.1:7844";
const COOKIE = fs.readFileSync("/tmp/session-cookie-1874.txt", "utf8").trim();
const CHAT = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const SHOTS = __dirname;

const results = [];
const say = (label, ok, detail) => {
  results.push({ label, ok, detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (msg) => console.log(`  ·  ${msg}`);

const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

/** Refuse every run-control verb the ✕ / stop / terminate controls can reach. */
async function guardRunControl(page, log) {
  await page.route("**/api/proxy/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const m = req.method();
    const isWrite = m !== "GET" && m !== "HEAD";
    const lethal =
      /\/runs\/[^/]+\/(cancel|stop|terminate|kill|pause|resume|retry)/.test(url) ||
      /\/(cancel|stop|terminate|kill)(\?|$)/.test(url);
    if (isWrite && lethal) {
      log.push({ blocked: true, method: m, url });
      console.log(`  !! BLOCKED lethal ${m} ${url}`);
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    if (isWrite) log.push({ blocked: false, method: m, url, body: req.postData() });
    return route.fallback();
  });
}

/** Answer dismissal writes locally with the route's own shape, and record the
 *  bodies — the confirm/undo machine runs fully without hiding one real row. */
async function stubDismissalWrites(page, log, cascadeIds) {
  const store = new Set();
  await page.route("**/api/proxy/agents/dismissals**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    const url = req.url();
    if (/restore/.test(url)) {
      const ids = body.ids ?? [...store];
      ids.forEach((i) => store.delete(i));
      log.push({ kind: "restore", ids, count: ids.length });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ restored: ids, ok: true, count: ids.length }),
      });
    }
    /* The cascade the SERVER would return. Supplied by the caller so a test can
     * reproduce the exact shape of finding 2 — 180 ids of which only some are
     * rows in this tree — without asking the real route to hide anything. */
    const ids = cascadeIds ? cascadeIds(body) : (body.ids ?? (body.id ? [body.id] : []));
    ids.forEach((i) => store.add(i));
    log.push({ kind: "dismiss", ids, count: ids.length, raw: body });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dismissed: ids, ok: true, count: ids.length }),
    });
  });
  return log;
}

async function open(opts = {}) {
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 1560, height: 980 },
    deviceScaleFactor: 1,
    ...(opts.mobile
      ? {
          isMobile: true,
          hasTouch: true,
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        }
      : {}),
  });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  CONSOLE-ERR ${m.text().slice(0, 200)}`);
  });
  return { browser, ctx, page };
}

/** click the top-strip destination with this label */
async function gotoSurface(page, name) {
  const box = await page.evaluate((n) => {
    const els = [...document.querySelectorAll("div.mono")].filter(
      (e) => (e.textContent || "").trim() === n,
    );
    const el = els[els.length - 1] || els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  if (!box) throw new Error(`surface ${name} not clickable`);
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(2500);
}

module.exports = {
  BASE,
  COOKIE,
  CHAT,
  SHOTS,
  results,
  say,
  note,
  shot,
  open,
  guardRunControl,
  stubDismissalWrites,
  gotoSurface,
  chrome,
  fs,
  path,
};
