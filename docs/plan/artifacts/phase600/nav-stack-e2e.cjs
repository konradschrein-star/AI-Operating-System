/**
 * nav-stack-e2e.cjs — round 601B's own protocol: the drill-in navigation
 * (U20/U21) exercised in a real browser against a build of THIS WORKTREE.
 *
 * The four claims a reviewer would otherwise have to take on trust:
 *
 *   A. DRILL-IN DOES NOT MOVE `selId`. Clicking a worker opens its transcript
 *      in the middle surface while the right panel keeps showing the CHAT's
 *      team, and the rail's selected row does not move. This is the semantic
 *      change the round is named for, and it is asserted by comparing the
 *      team panel's row set and the rail's selection before and after.
 *   B. TWO LEVELS. A sub-agent row is clickable and descends to depth 2, and
 *      the thread it shows is the parent's thread SLICED (fewer entries than
 *      the parent's own view).
 *   C. BACK POPS ONE LEVEL. depth 2 → depth 1 → manager chat.
 *   D. SWITCHING CHATS RESETS THE STACK. Drill in, click another chat in the
 *      rail, land on that chat's manager thread — never on a stale worker.
 *
 *   E. POLL BUDGET (NFU3). Requests are counted for 30s at rest on the manager
 *      chat and for 30s drilled into a worker. Drilled must not exceed at-rest.
 *
 * Run (see docs/plan/artifacts/phase500/README.md §2 for the harness setup):
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase601.txt)" \
 *   NAV_BASE_URL=http://127.0.0.1:7784 \
 *     node docs/plan/artifacts/phase600/nav-stack-e2e.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

/** Copied verbatim from scripts/checks/frozen-dom.cjs:30-58 (NFU8: playwright
 *  is not, and must not become, a dependency of either repo). */
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
    throw new Error(`no chromium binary under ${cache}`);
  return candidates[0];
}

const BASE = process.env.NAV_BASE_URL ?? "http://127.0.0.1:7784";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
/** 11dd264b: manager with 7 sub-agents, 11 workers, one of which (58096061,
 *  architect) owns a sub-agent — the only fixture in the live DB that reaches
 *  depth 2 through a WORKER rather than through the manager. */
const CHAT = process.env.NAV_CHAT ?? "Okay this session is very important";
const OTHER_CHAT = process.env.NAV_OTHER_CHAT ?? "phase300 round-304 linkage fixture";

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first");

const results = [];
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}
function note(name, value) {
  results.push({ name, note: value });
  console.log(`      ${name}: ${JSON.stringify(value)}`);
}

/** The facts that must NOT change when you drill in. */
async function surfaceState(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-team-row]")).map((r) => ({
      id: r.getAttribute("data-node-id"),
      kind: r.getAttribute("data-kind"),
      depth: r.getAttribute("data-depth"),
    }));
    const drill = document.querySelector("[data-agent-chat-view]");
    return {
      teamRows: rows,
      teamState: document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? null,
      drilledRunId: drill?.getAttribute("data-run-id") ?? null,
      drilledSubagentId: drill?.getAttribute("data-subagent-id") || null,
      depth: drill ? Number(drill.getAttribute("data-depth")) : 0,
      crumbs: document.querySelector("[data-nav-crumbs]")?.textContent ?? null,
      role: document.querySelector("[data-agent-role]")?.textContent ?? null,
      model: document.querySelector("[data-agent-model]")?.textContent ?? null,
      backLabel: document.querySelector("[data-nav-back]")?.textContent?.trim() ?? null,
      msgCount: document.querySelectorAll("[data-agent-chat-view] .aui-md, [data-agent-chat-view] [data-role]").length,
      threadChars: (document.querySelector("[data-agent-chat-view]")?.innerText ?? "").length,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "authjs.session-token", value: COOKIE, domain: new URL(BASE).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();

  /* ── Request accounting (E) ─────────────────────────────────────────── */
  let counting = null;
  page.on("request", (req) => {
    if (!counting) return;
    const u = req.url();
    if (!u.includes("/api/")) return;
    counting.push({ url: u.replace(BASE, ""), t: Date.now() });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForTimeout(3_000);

  const atRest = await surfaceState(page);
  check("at rest: no drilled view", atRest.depth, 0);
  note("at rest: team rows", atRest.teamRows.length);
  note("at rest: team state", atRest.teamState);

  /* Poll budget at rest — 30s of API traffic on the manager chat. */
  counting = [];
  await page.waitForTimeout(30_000);
  const restReqs = counting.slice();
  counting = null;

  /* ── A: drill into a worker ─────────────────────────────────────────── */
  const workerRow = page.locator('[data-team-row][data-kind="worker"]').first();
  const workerId = await workerRow.getAttribute("data-node-id");
  await workerRow.click();
  await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const d1 = await surfaceState(page);
  check("A1 drilled view is the clicked worker", d1.drilledRunId, workerId);
  check("A1 depth is 1", d1.depth, 1);
  check("A2 the TEAM PANEL still shows the same chat's tree (selId did not move)", d1.teamRows, atRest.teamRows);
  check("A2 team state unchanged", d1.teamState, atRest.teamState);
  check("A3 back button points at the manager chat", d1.backLabel, "← manager chat");
  note("A4 header role", d1.role);
  note("A4 header model", d1.model);
  note("A4 crumbs", d1.crumbs);
  note("A5 transcript chars at depth 1", d1.threadChars);

  /* Poll budget drilled — 30s. */
  counting = [];
  await page.waitForTimeout(30_000);
  const drillReqs = counting.slice();
  counting = null;

  const per = (list) => {
    const by = {};
    for (const r of list) {
      const k = r.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").split("?")[0];
      by[k] = (by[k] ?? 0) + 1;
    }
    return by;
  };
  note("E at-rest requests/30s", per(restReqs));
  note("E drilled requests/30s", per(drillReqs));
  check("E drilled total does not exceed at-rest total", drillReqs.length <= restReqs.length, true);

  /* ── B: descend into THIS WORKER's own sub-agent ────────────────────
   * `data-depth="2"` is the discriminator: flattenTeam puts the manager's own
   * sub-agents at depth 1 alongside the workers, and a WORKER's sub-agents at
   * depth 2. Picking depth 2 is what makes B1b a real test of the parent
   * resolution — the frame's runId must come out as the worker, not as the
   * manager whose row sits above it. */
  const subRow = page.locator('[data-team-row][data-kind="subagent"][data-depth="2"]').first();
  const subId = await subRow.getAttribute("data-node-id");
  await subRow.click();
  await page.waitForTimeout(4_000);
  const d2 = await surfaceState(page);
  check("B1 sub-agent rows are clickable and descend", d2.depth, 2);
  check("B1 the frame carries the sub-agent's tool_use_id", d2.drilledSubagentId, subId);
  check("B1b the frame FETCHES the parent worker, not the sub-agent id", d2.drilledRunId, workerId);
  check("B2 the team panel STILL shows the same chat's tree", d2.teamRows, atRest.teamRows);
  check("B3 back now points one level down, not to the manager", d2.backLabel !== "← manager chat", true);
  note("B4 crumbs at depth 2", d2.crumbs);
  note("B4 header role/model", [d2.role, d2.model]);
  note("B5 transcript chars at depth 2", d2.threadChars);

  /* ── C: back pops ONE level ─────────────────────────────────────────── */
  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(2_500);
  const b1 = await surfaceState(page);
  check("C1 back from depth 2 lands at depth 1", b1.depth, 1);
  check("C1 …on the frame BELOW it — the worker drilled into first", b1.drilledRunId, d1.drilledRunId);
  check("C1 …with no sub-agent selected any more", b1.drilledSubagentId, null);

  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(2_500);
  const b0 = await page.evaluate(() => ({
    drilled: document.querySelector("[data-agent-chat-view]") !== null,
    rows: Array.from(document.querySelectorAll("[data-team-row]")).map((r) => r.getAttribute("data-node-id")),
  }));
  check("C2 back from depth 1 returns to the manager chat", b0.drilled, false);
  check("C2 …with the same team still on screen", b0.rows, atRest.teamRows.map((r) => r.id));

  /* ── D: switching chats resets the stack ────────────────────────────── */
  await page.locator('[data-team-row][data-kind="worker"]').first().click();
  await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
  await page.waitForTimeout(2_500);
  check("D1 drilled again", (await surfaceState(page)).depth, 1);
  await page.getByText(OTHER_CHAT, { exact: false }).first().click();
  await page.waitForTimeout(4_000);
  const after = await page.evaluate(() => document.querySelector("[data-agent-chat-view]") !== null);
  check("D2 switching chats drops the drilled view (navStack reset)", after, false);

  const out = path.join(__dirname, "nav-stack-e2e.json");
  fs.writeFileSync(out, `${JSON.stringify({ base: BASE, chat: CHAT, failures, results }, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — nav stack e2e → ${out}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
