/**
 * rail-zero-fixture.cjs — proves the U10 badge guards on PRESENCE, not truth.
 *
 * The live data has no "linked project with zero tasks" case, and inventing one
 * would mean writing a project row into Konrad's real database. So the fixture
 * is applied in the browser instead: the `/api/proxy/chat` response is
 * intercepted and rewritten so that
 *
 *   row 0 → tasks_done: 0, tasks_total: 0   (linked, nothing planned yet)
 *   row 1 → fields deleted                  (never started a project)
 *
 * Expected: row 0 renders `0/0 tasks` in muted (NOT green — `allDone` requires
 * tasks_total > 0), row 1 renders no counter at all. A truthiness guard would
 * hide row 0's badge; that is the bug this check exists to catch.
 *
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     RAIL_URL=http://127.0.0.1:7795 node docs/plan/artifacts/phase400/rail-zero-fixture.cjs
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

  await page.route("**/api/proxy/chat?**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (!body.runs || body.runs.length < 2) throw new Error("fewer than 2 chats — cannot fixture");
    body.runs[0] = {
      ...body.runs[0],
      project_id: "00000000-0000-4000-8000-000000000400",
      project_status: "running",
      tasks_done: 0,
      tasks_total: 0,
    };
    const bare = { ...body.runs[1] };
    delete bare.project_id;
    delete bare.project_status;
    delete bare.tasks_done;
    delete bare.tasks_total;
    body.runs[1] = bare;
    await route.fulfill({ response: res, json: body });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);

  const rows = await page.evaluate(() => {
    const rail = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    const scroller = Array.from(rail.querySelectorAll("div")).find(
      (d) => d.style && d.style.overflowY === "auto",
    );
    return Array.from(scroller.children).map((el) => {
      const badge = Array.from(el.querySelectorAll("span")).find((s) =>
        /^\d+\/\d+ tasks$/.test(s.textContent ?? ""),
      );
      return {
        head: (el.innerText || "").split("\n")[0],
        badge: badge ? badge.textContent : null,
        badge_color: badge ? getComputedStyle(badge).color : null,
      };
    });
  });
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));

  const ok =
    rows[0].badge === "0/0 tasks" && rows[1].badge === null;
  fs.writeFileSync(
    path.join(OUT, "rail-zero-fixture.json"),
    `${JSON.stringify({ pass: ok, rows: rows.slice(0, 3) }, null, 2)}\n`,
  );
  console.log(ok ? "PASS: 0/0 renders, absent stays absent" : "FAIL: presence guard is wrong");

  const rail = (await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    ),
  )).asElement();
  await rail.screenshot({ path: path.join(OUT, "rail-zero-fixture-dark.png") });

  await browser.close();
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
