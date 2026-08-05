/**
 * rail-shot.cjs — U9/U10 evidence: the chat rail with no manager cards and
 * with `x/y tasks` badges, in both themes.
 *
 * Must be pointed at a web build whose proxy target is the WORKTREE api
 * (:7798) — production :7700 runs main, which has no rollup fields, so the
 * badges would be absent for a reason that has nothing to do with this round
 * (REPRODUCE.md trap 1).
 *
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     RAIL_URL=http://127.0.0.1:7795 node docs/plan/artifacts/phase400/rail-shot.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const c = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!c.length) throw new Error(`no chromium under ${cache}`);
  return c[0];
}

const BASE = process.env.RAIL_URL ?? "http://127.0.0.1:7795";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT = __dirname;

async function shootRail(page, name) {
  const rail = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    ),
  );
  const el = rail.asElement();
  if (!el) throw new Error("rail not found");
  await el.screenshot({ path: path.join(OUT, name) });
  console.log(`wrote ${name}`);
}

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);

  // What the rail actually says, as text — the screenshot's machine-readable twin.
  const rows = await page.evaluate(() => {
    const rail = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    const scroller = Array.from(rail.querySelectorAll("div")).find(
      (d) => d.style && d.style.overflowY === "auto",
    );
    return Array.from(scroller.children).map((el) =>
      el.innerText.split("\n").slice(0, 2).join(" | "),
    );
  });
  console.log(JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(OUT, "rail-rows.json"), `${JSON.stringify(rows, null, 2)}\n`);

  await shootRail(page, "rail-dark.png");

  // Hover reveal (CSS-only): the ✕ appears, and NOTHING moves. Row geometry is
  // compared before/after the pointer lands — the ✕ is absolutely positioned
  // over the age stamp precisely so the swap cannot reflow the row.
  const geom = () =>
    page.evaluate(() => {
      const rail = Array.from(document.querySelectorAll("div")).find(
        (d) => d.style && d.style.width === "300px",
      );
      const scroller = Array.from(rail.querySelectorAll("div")).find(
        (d) => d.style && d.style.overflowY === "auto",
      );
      return Array.from(scroller.children).map((el) => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.y)}x${Math.round(r.height)}`;
      });
    });
  const before = await geom();
  const box = await page.evaluate(() => {
    const rail = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    const scroller = Array.from(rail.querySelectorAll("div")).find(
      (d) => d.style && d.style.overflowY === "auto",
    );
    const r = scroller.children[1].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(600);
  const after = await geom();
  const reflow = JSON.stringify(before) !== JSON.stringify(after);
  console.log(reflow ? "FAIL: rail reflowed on hover" : "no reflow on hover: row geometry identical");
  await shootRail(page, "rail-hover-dark.png");
  if (reflow) process.exitCode = 1;
  await page.mouse.move(1400, 500);
  await page.waitForTimeout(400);

  await page.getByText("light_mode", { exact: true }).first().click();
  await page.waitForTimeout(1_200);
  await shootRail(page, "rail-light.png");

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
