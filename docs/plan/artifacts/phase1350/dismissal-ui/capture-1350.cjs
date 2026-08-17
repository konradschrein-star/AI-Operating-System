/**
 * capture-1350.cjs — round 1350, client half of server-backed dismissal.
 *
 * Proves the ONE thing a localStorage store could fake and a server-backed one
 * cannot: a dismissal survives a HARD RELOAD in a browser context that shares
 * no JavaScript state with the one that made it, and the panel can bring it
 * back. Both surfaces (/live and the chat team panel), both themes.
 *
 * The reload is deliberately the strong form. `page.reload()` keeps the same
 * renderer, the same react-query cache is rebuilt from scratch either way, but
 * a sceptical reviewer can still say "same tab". So each surface is also
 * re-opened in a FRESH BROWSER CONTEXT — new cookie jar apart from the session
 * cookie, new storage, new everything — and the row must still be hidden.
 *
 * WHAT IS REAL HERE. Nothing is stubbed, no route is intercepted. The web app
 * is an isolated production build of this worktree baked against the worktree
 * API harness (`scripts/checks/serve-v3-7798.ts`), and that harness runs
 * against a SCRATCH DATABASE — `forge_dismiss_ui_1350`, a schema clone of
 * content_forge holding a copy of the last two days of `runs` plus `projects`
 * and `project_tasks`. Production was read, never written. See README.md in
 * this directory for the exact boot procedure.
 *
 * Run:
 *   R1350_BASE_URL=http://127.0.0.1:7861 R1350_API_URL=http://127.0.0.1:7860 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/r1350-cookie.txt)" \
 *     node docs/plan/artifacts/phase1350/dismissal-ui/capture-1350.cjs
 *
 * Writes PNGs next to this file and prints a PASS/FAIL line per assertion.
 * NFU8: playwright is loaded by absolute path from /opt/hermes-workspace and
 * is not a dependency of either repo (same as lib-604.cjs).
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

const BASE = process.env.R1350_BASE_URL ?? "http://127.0.0.1:7861";
const API = process.env.R1350_API_URL ?? "http://127.0.0.1:7860";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const CHAT_TEXT = process.env.R1350_CHAT ?? "Okay when I click the file section";
const OUT = __dirname;

/** Copied verbatim from scripts/checks/frozen-dom.cjs:30-58. */
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

const results = [];
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
  );
}
function note(name, value) {
  results.push({ name, note: value });
  console.log(`      ${name}: ${JSON.stringify(value)}`);
}

async function apiDismissals() {
  const r = await fetch(`${API}/api/agents/dismissals`);
  if (!r.ok) throw new Error(`GET dismissals → ${r.status}`);
  return r.json();
}

async function restoreEverything() {
  const r = await fetch(`${API}/api/agents/dismissals`, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE dismissals → ${r.status}`);
  return r.json();
}

/** The chat the team walk uses, resolved from the API by its title — the same
 *  chat the browser opens by clicking that text. */
async function resolveChatId() {
  const r = await fetch(`${API}/api/chat?limit=60`);
  if (!r.ok) throw new Error(`GET /api/chat → ${r.status}`);
  const body = await r.json();
  const run = body.runs.find((x) => (x.title ?? "").includes(CHAT_TEXT));
  if (!run) throw new Error(`no chat whose title contains ${JSON.stringify(CHAT_TEXT)}`);
  return run.id;
}

/**
 * The LAST SETTLED node of the tree, in the order `flattenTeam` renders it
 * (manager → its sub-agents → each worker → its sub-agents). That is the node
 * behind the last enabled ✕ in the DOM, derived from the API rather than read
 * off the page — which is what makes "the server holds this id" an independent
 * check instead of a tautology.
 */
async function lastSettledNodeId() {
  const chatId = await resolveChatId();
  const r = await fetch(`${API}/api/chat/${chatId}/team`);
  if (!r.ok) throw new Error(`GET team → ${r.status}`);
  const tree = await r.json();
  const flat = [];
  const push = (n) => {
    flat.push(n);
    for (const s of n.subagents) push(s);
  };
  push(tree.manager);
  for (const w of tree.workers) push(w);
  const settled = flat.filter((n) => n.settled);
  if (settled.length === 0) throw new Error("no settled node in the tree");
  return settled[settled.length - 1].id;
}

/* ── page helpers ───────────────────────────────────────────────────────── */

async function newContext(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  // The theme is read from localStorage by an inline script in app/layout.tsx
  // before first paint; setting it here means the page never renders the other
  // palette, so the screenshot is of a real theme, not a flash of one.
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem("forge.theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
  return ctx;
}

async function openLive(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(1_500);
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector("[data-agent-kind]", { timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

async function openTeam(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(1_500);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(2_500);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
    { timeout: 25_000 },
  );
  await page.waitForTimeout(1_200);
}

/** What the Live panel currently shows. */
const liveState = () => ({
  rows: [...document.querySelectorAll("[data-agent-kind]:not([data-agent-kind='subagent'])")].length,
  xButtons: [...document.querySelectorAll("[data-live-x]")].map((b) => b.getAttribute("data-live-x")),
  peeked: [...document.querySelectorAll("[data-live-peeked='true']")].map(
    (d) => d.querySelector("[data-live-restore]")?.getAttribute("data-live-restore") ?? null,
  ),
  toggle: document.querySelector("[data-live-dismissed-toggle]")?.textContent?.trim() ?? null,
  visibleIds: [...document.querySelectorAll("[data-live-x]")].map((b) =>
    b.getAttribute("data-live-x"),
  ),
});

/** What the team panel currently shows. */
const teamState = () => ({
  rows: [...document.querySelectorAll("[data-team-row]")].length,
  restore: document.querySelector("[data-team-restore]")?.textContent?.trim() ?? null,
  state: document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? null,
});

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return path.basename(file);
}

/* ── the walk ───────────────────────────────────────────────────────────── */

async function liveWalk(browser, theme) {
  const tag = `live-${theme}`;
  await restoreEverything();

  const ctx = await newContext(browser, theme);
  const page = await ctx.newPage();
  await openLive(page);

  const before = await page.evaluate(liveState);
  note(`${tag} · before`, before);
  check(`${tag} · a settled row offers ✕`, before.xButtons.length > 0, true);
  check(`${tag} · nothing dismissed yet`, before.toggle, null);
  await shot(page, `${tag}-1-before`);

  const target = before.xButtons[0];
  await page.click(`[data-live-x="${target}"]`);
  await page.waitForTimeout(1_200);

  const afterClick = await page.evaluate(liveState);
  check(`${tag} · the row is gone from the list`, afterClick.visibleIds.includes(target), false);
  check(`${tag} · header offers the way back`, /dismissed · show$/.test(afterClick.toggle ?? ""), true);
  note(`${tag} · after dismiss`, afterClick);
  await shot(page, `${tag}-2-dismissed`);

  const server = await apiDismissals();
  check(
    `${tag} · the server holds it (not localStorage)`,
    server.node_ids.includes(target),
    true,
  );
  note(`${tag} · server set`, { count: server.count, cascaded: server.node_ids.length });

  // HARD RELOAD — same tab, brand-new document and JS heap. Which surface is
  // open is component state and does not survive it (13 §2 — deliberately no
  // persisted nav), so the LIVE tab is clicked again afterwards. The reload is
  // the proof; the click is just how you get back to the panel.
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1_500);
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector("[data-agent-kind]", { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const afterReload = await page.evaluate(liveState);
  check(`${tag} · still hidden after a hard reload`, afterReload.visibleIds.includes(target), false);
  check(
    `${tag} · and the panel still says so`,
    /dismissed · show$/.test(afterReload.toggle ?? ""),
    true,
  );
  await shot(page, `${tag}-3-after-reload`);

  // FRESH CONTEXT — no shared JS state at all.
  const ctx2 = await newContext(browser, theme);
  const page2 = await ctx2.newPage();
  await openLive(page2);
  const fresh = await page2.evaluate(liveState);
  check(`${tag} · still hidden in a brand-new context`, fresh.visibleIds.includes(target), false);
  await ctx2.close();

  // PEEK — the way back, and the muted rendering.
  await page.click("[data-live-dismissed-toggle]");
  await page.waitForTimeout(800);
  const peeked = await page.evaluate(liveState);
  check(`${tag} · peeking reveals it, with a restore control`, peeked.peeked.includes(target), true);
  check(`${tag} · the toggle flips to hide`, /dismissed · hide$/.test(peeked.toggle ?? ""), true);
  const opacity = await page.evaluate(
    () => getComputedStyle(document.querySelector("[data-live-peeked='true']")).opacity,
  );
  note(`${tag} · peeked row opacity`, opacity);
  // The panel scrolls inside a 380px card; scroll the DISMISSED section into
  // it so the screenshot shows what the assertion just proved.
  await page.locator("[data-live-peeked='true']").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, `${tag}-4-peek`);

  // RESTORE — one row, from the peek list.
  await page.click(`[data-live-restore="${target}"]`);
  await page.waitForTimeout(1_200);
  const restored = await page.evaluate(liveState);
  check(`${tag} · restored into the list`, restored.visibleIds.includes(target), true);
  check(`${tag} · and the toggle is gone`, restored.toggle, null);
  const serverAfter = await apiDismissals();
  check(`${tag} · the server forgot it too`, serverAfter.node_ids.includes(target), false);
  await shot(page, `${tag}-5-restored`);

  /* THE CASCADE, IN ONE FRAME. Dismissing the operator chat must take its
   * project's settled workers with it — and must do so from the POST's own
   * answer, not by waiting for the 4s poll. So the panel is read 500ms after
   * the click, well inside one poll interval, and more than one row must
   * already be gone. */
  const managerId = await page.evaluate(() => {
    const row = [...document.querySelectorAll("[data-agent-kind='operator']")].find((r) =>
      r.querySelector("[data-live-x]"),
    );
    return row?.querySelector("[data-live-x]")?.getAttribute("data-live-x") ?? null;
  });
  if (managerId) {
    const idsBefore = (await page.evaluate(liveState)).visibleIds;
    await page.click(`[data-live-x="${managerId}"]`);
    await page.waitForTimeout(500);
    const idsAfter = (await page.evaluate(liveState)).visibleIds;
    const gone = idsBefore.filter((id) => !idsAfter.includes(id));
    check(`${tag} · the manager takes its settled workers with it`, gone.length > 1, true);
    note(`${tag} · rows gone within 500ms of the click`, gone.length);
    const cascade = await apiDismissals();
    note(`${tag} · server cascade size`, cascade.count);
    await shot(page, `${tag}-6-manager-cascade`);
    await restoreEverything();
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await page.getByText("LIVE", { exact: true }).first().click();
    await page.waitForSelector("[data-agent-kind]", { timeout: 30_000 });
    await page.waitForTimeout(1_500);
  } else {
    note(`${tag} · no settled operator row in this feed`, true);
  }

  // A RUNNING ROW HAS NO ✕ — the gate, asserted rather than eyeballed.
  const running = await page.evaluate(() => {
    const out = [];
    for (const row of document.querySelectorAll("[data-agent-kind]:not([data-agent-kind='subagent'])")) {
      const x = row.querySelector("[data-live-x]");
      const dot = row.querySelector("[title='running for this long']");
      if (dot) out.push({ hasX: Boolean(x) });
    }
    return out;
  });
  check(
    `${tag} · no running row carries a ✕`,
    running.every((r) => !r.hasX),
    true,
  );
  note(`${tag} · running rows inspected`, running.length);

  await ctx.close();
}

async function teamWalk(browser, theme) {
  const tag = `team-${theme}`;
  await restoreEverything();

  const ctx = await newContext(browser, theme);
  const page = await ctx.newPage();
  await openTeam(page);

  const before = await page.evaluate(teamState);
  note(`${tag} · before`, before);
  check(`${tag} · tree is ready`, before.state, "ready");
  check(`${tag} · nothing hidden yet`, before.restore, null);
  await shot(page, `${tag}-1-before`);

  /* The X on a SETTLED row dismisses in one click (no confirm — it is
   * reversible). The LAST row is used: `data-team-row` is a boolean attribute
   * with no id in it, and `flattenTeam`'s order is manager → its sub-agents →
   * each worker → its sub-agents, so the last DOM row is the last node of the
   * last worker in the payload. That is the id asserted against the server —
   * derived from the API rather than read off the DOM, which is what makes it
   * an independent check and not a tautology. */
  const targetId = await lastSettledNodeId();
  note(`${tag} · target row (last settled node of the tree)`, targetId);
  /* Selected by TITLE, not by `:not([disabled])`. A running row's ✕ is
   * terminate, and `/api/capabilities` on this harness now answers
   * `terminate: true` (the engine lane shipped the control plane), so a
   * running ✕ is enabled — clicking it ARMS a terminate instead of dismissing,
   * which is how the first version of this script silently proved nothing. */
  await page.locator('[data-team-row] [data-team-x][title^="Hide this row"]').last().click();
  await page.waitForTimeout(1_200);

  const afterClick = await page.evaluate(teamState);
  check(`${tag} · one fewer row`, afterClick.rows < before.rows, true);
  check(`${tag} · "N hidden · show" appears`, /hidden · show$/.test(afterClick.restore ?? ""), true);
  note(`${tag} · after dismiss`, afterClick);
  await shot(page, `${tag}-2-dismissed`);

  const server = await apiDismissals();
  check(`${tag} · the server holds it`, server.node_ids.includes(targetId), true);
  note(`${tag} · server set size`, server.count);

  // HARD RELOAD, then back to the chat — see the note in `liveWalk`.
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await openTeam(page);
  const afterReload = await page.evaluate(teamState);
  check(`${tag} · still hidden after a hard reload`, afterReload.rows, afterClick.rows);
  check(
    `${tag} · and still offers the way back`,
    /hidden · show$/.test(afterReload.restore ?? ""),
    true,
  );
  await shot(page, `${tag}-3-after-reload`);

  const ctx2 = await newContext(browser, theme);
  const page2 = await ctx2.newPage();
  await openTeam(page2);
  const fresh = await page2.evaluate(teamState);
  check(`${tag} · still hidden in a brand-new context`, fresh.rows, afterClick.rows);
  await ctx2.close();

  await page.click("[data-team-restore]");
  await page.waitForTimeout(1_200);
  const restored = await page.evaluate(teamState);
  check(`${tag} · "show" brings every row back`, restored.rows, before.rows);
  check(`${tag} · and the label is gone`, restored.restore, null);
  const serverAfter = await apiDismissals();
  check(`${tag} · the server is empty again`, serverAfter.count, 0);
  await shot(page, `${tag}-4-restored`);

  await ctx.close();
}

async function main() {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is required");
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  try {
    for (const theme of ["dark", "light"]) {
      console.log(`\n──────── ${theme} ────────`);
      await liveWalk(browser, theme);
      await teamWalk(browser, theme);
    }
  } finally {
    await browser.close();
    await restoreEverything();
  }

  const payload = { base: BASE, api: API, results, failures };
  fs.writeFileSync(path.join(OUT, "capture-1350.json"), JSON.stringify(payload, null, 2));
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — dismissal UI`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
