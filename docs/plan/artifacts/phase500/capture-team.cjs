/**
 * capture-team.cjs — both-theme screenshots of every Team panel state, in the
 * style of phase400/capture.cjs.
 *
 * Seven cases, each shot dark AND light (`phase500-<case>-<theme>.png`):
 *
 *   ready      — a linked chat with a normal tree (data-team-state="ready")
 *   ambiguous  — a thread_scan/ambiguous-linked chat, [data-link-marker] visible
 *   unlinked   — a chat with no project (data-team-state="unlinked")
 *   empty      — a linked chat with zero workers (data-team-state="empty")
 *   error      — a fetch failure (data-team-state="error")
 *   hover      — a row hovered, [.team-row-controls] revealed
 *   armed      — [data-team-x] clicked once, data-confirm="armed"
 *
 * Fixture notes (verified via curl against :7798, 2026-08-05):
 *   - "ready": c0de0304 (phase300 fixture) — link_source "metadata", 2 workers.
 *   - "ambiguous": 11dd264b — link_source "thread_scan", link_ambiguous true,
 *     11 workers.
 *   - "unlinked": bfd1283a — project: null (today's data; NOT the "owns THIS
 *     project" chat the round-501b brief names — that chat currently resolves
 *     unlinked too. See README §Fixture drift.)
 *   - "empty": no chat in the live rail resolves to "linked project, zero
 *     workers" (same finding as phase400's round403 README §3, deviation 3).
 *     This case FAKES the response client-side via page.route, exactly as
 *     phase400/rail-zero-fixture.cjs faked `0/0 tasks` — labelled synthetic
 *     in the output JSON.
 *   - "error": rewrites the outgoing `/team` request to the nonsense uuid
 *     00000000-0000-0000-0000-000000000000 via page.route so the backend
 *     genuinely answers 404 — not a synthetic fulfill.
 *
 * Playwright by absolute path, chromium from the shared cache — copied from
 * scripts/checks/frozen-dom.cjs:30-58. Not a dependency of either repo (NFU8).
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     node docs/plan/artifacts/phase500/capture-team.cjs
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
  if (!candidates.length) throw new Error(`no chromium under ${cache}`);
  return candidates[0];
}

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7789";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT = __dirname;
const NONSENSE_ID = "00000000-0000-0000-0000-000000000000";

const CHATS = {
  ready: process.env.TEAM_CHAT_READY ?? "phase300 round-304 linkage fixture",
  ambiguous: process.env.TEAM_CHAT_AMBIGUOUS ?? "Okay this session is very important",
  unlinked: process.env.TEAM_CHAT_UNLINKED ?? "Okay when I click the file section",
  empty: process.env.TEAM_CHAT_EMPTY ?? "phase300 round-304 linkage fixture",
  error: process.env.TEAM_CHAT_ERROR ?? "phase300 round-304 linkage fixture",
  hover: process.env.TEAM_CHAT_HOVER ?? "phase300 round-304 linkage fixture",
  armed: process.env.TEAM_CHAT_ARMED ?? "phase300 round-304 linkage fixture",
};

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

async function newPage(browser) {
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
  return ctx.newPage();
}

async function openChat(page, chatText) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale (re-mint, 60min)");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(chatText, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
}

async function waitForState(page, expected, timeoutMs = 15_000) {
  await page
    .waitForFunction(
      (want) => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === want,
      expected,
      { timeout: timeoutMs },
    )
    .catch(async () => {
      const found = await page
        .evaluate(() => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state"))
        .catch(() => undefined);
      const panelExists = await page.locator("[data-team-panel]").count().catch(() => 0);
      if (!panelExists)
        throw new Error(`no [data-team-panel] found in the DOM within ${timeoutMs}ms — the Team panel does not exist yet`);
      throw new Error(`[data-team-panel] never reached data-team-state="${expected}" — last seen "${found}"`);
    });
}

async function shootBothThemes(page, caseName) {
  const files = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(500);
    const file = path.join(OUT, `phase500-${caseName}-${theme}.png`);
    const panel = page.locator("[data-team-panel]");
    if (await panel.count()) await panel.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: false });
    files.push(file);
    console.log(`  wrote ${file}`);
  }
  return files;
}

async function caseReady(browser) {
  const page = await newPage(browser);
  await openChat(page, CHATS.ready);
  await waitForState(page, "ready");
  const files = await shootBothThemes(page, "ready");
  await page.close();
  return { case: "ready", chat: CHATS.ready, files, data: "real" };
}

async function caseAmbiguous(browser) {
  const page = await newPage(browser);
  await openChat(page, CHATS.ambiguous);
  await waitForState(page, "ready");
  const markerCount = await page.locator("[data-link-marker]").count();
  if (!markerCount) console.log(`  WARNING: [data-link-marker] not found on ${CHATS.ambiguous} — fixture may no longer be ambiguous`);
  const files = await shootBothThemes(page, "ambiguous");
  await page.close();
  return { case: "ambiguous", chat: CHATS.ambiguous, files, link_marker_present: markerCount > 0, data: "real" };
}

async function caseUnlinked(browser) {
  const page = await newPage(browser);
  await openChat(page, CHATS.unlinked);
  await waitForState(page, "unlinked");
  const files = await shootBothThemes(page, "unlinked");
  await page.close();
  return { case: "unlinked", chat: CHATS.unlinked, files, data: "real" };
}

/** No live chat resolves to "linked project, zero workers" (verified via the
 *  same rail scan phase400's round403 documented). Faked client-side, exactly
 *  as rail-zero-fixture.cjs faked `0/0 tasks` — same precedent, same honesty
 *  requirement: label it synthetic in the output. */
async function caseEmpty(browser) {
  const page = await newPage(browser);
  await page.route("**/api/proxy/chat/*/team", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const chatId = url.pathname.match(/chat\/([^/]+)\/team/)?.[1] ?? "unknown";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat_id: chatId,
        now: new Date().toISOString(),
        project: { id: "00000000-0000-4000-8000-000000000001", status: "active" },
        link_source: "metadata",
        link_ambiguous: false,
        manager: {
          id: chatId,
          kind: "operator",
          role: null,
          model: "claude-fable-5",
          status: "completed",
          tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
          working_ms: 1000,
          working_ms_source: "thread",
          started_at: new Date().toISOString(),
          settled: true,
          description: "phase500 synthetic empty fixture",
          parent_id: null,
          subagents: [],
          task: null,
        },
        workers: [],
        complete: true,
        errors: [],
      }),
    });
  });
  await openChat(page, CHATS.empty);
  await waitForState(page, "empty");
  const files = await shootBothThemes(page, "empty");
  await page.close();
  return { case: "empty", chat: CHATS.empty, files, data: "synthetic (browser-side fulfilled response, no chat in the live rail resolves to this state)" };
}

/** Rewrites the outgoing /team request to the nonsense uuid so the backend
 *  genuinely answers 404 — a real error, not a synthetic fulfill. */
async function caseError(browser) {
  const page = await newPage(browser);
  await page.route("**/api/proxy/chat/*/team", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const rewritten = url.href.replace(/chat\/[^/]+\/team/, `chat/${NONSENSE_ID}/team`);
    await route.continue({ url: rewritten });
  });
  await openChat(page, CHATS.error);
  await waitForState(page, "error");
  const files = await shootBothThemes(page, "error");
  await page.close();
  return { case: "error", chat: CHATS.error, files, data: `real 404 from ${NONSENSE_ID}` };
}

async function caseHover(browser) {
  const page = await newPage(browser);
  await openChat(page, CHATS.hover);
  await waitForState(page, "ready");
  const box = await page.evaluate(() => {
    const row = document.querySelector("[data-team-scroll] [data-team-row]");
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no [data-team-row] found inside [data-team-scroll] to hover");
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(500);
  const files = await shootBothThemes(page, "hover");
  await page.mouse.move(1400, 500);
  await page.close();
  return { case: "hover", chat: CHATS.hover, files, data: "real" };
}

async function caseArmed(browser) {
  const page = await newPage(browser);
  await openChat(page, CHATS.armed);
  await waitForState(page, "ready");
  const box = await page.evaluate(() => {
    const row = document.querySelector("[data-team-scroll] [data-team-row][data-settled='true']") ??
      document.querySelector("[data-team-scroll] [data-team-row]");
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no [data-team-row] found inside [data-team-scroll] to arm");
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(400);
  const xBtn = page.locator("[data-team-x]").first();
  if (!(await xBtn.count())) throw new Error("no [data-team-x] button found on the hovered row");
  await xBtn.click();
  await page
    .waitForFunction(() => document.querySelector('[data-team-x][data-confirm="armed"]') !== null, { timeout: 5_000 })
    .catch(() => {
      throw new Error('[data-team-x] did not reach data-confirm="armed" after one click');
    });
  const files = await shootBothThemes(page, "armed");
  await page.close();
  return { case: "armed", chat: CHATS.armed, files, data: "real" };
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  const cases = [
    ["ready", caseReady],
    ["ambiguous", caseAmbiguous],
    ["unlinked", caseUnlinked],
    ["empty", caseEmpty],
    ["error", caseError],
    ["hover", caseHover],
    ["armed", caseArmed],
  ];

  const results = [];
  for (const [name, fn] of cases) {
    console.log(`\n── ${name} ──`);
    try {
      const r = await fn(browser);
      results.push({ ...r, ok: true });
      console.log(`  ${name}: OK`);
    } catch (e) {
      results.push({ case: name, ok: false, error: e.message });
      console.log(`  FAIL: ${name}: ${e.message}`);
    }
  }

  await browser.close();

  const out = path.join(OUT, "capture-team.json");
  fs.writeFileSync(out, `${JSON.stringify({ base: BASE, chats: CHATS, results }, null, 2)}\n`);
  console.log(`\n→ ${out}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nCAPTURE-TEAM: ${failed.length ? "FAIL" : "PASS"} (${results.length - failed.length}/${results.length} cases)`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  FAIL: ${f.case}: ${f.error}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
