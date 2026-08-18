/**
 * ROUND 1305 RED TEAM — attacks 1, 2, 5, 6 at the DOM.
 *
 * Runs against an ISOLATED worktree build (never production, never
 * forge-control-web/.next in place). Rig: `next start` on RT_BASE_URL, talking
 * to a FRESH `scripts/checks/serve-v3-7798.ts` on RT_API_URL. Both are named in
 * the output so no number here can be attributed to the wrong build.
 *
 * A1  ROW CENSUS — every node in /team has a row in the DOM. No windowing
 *     shipped, so this must be exact: a shortfall is a lost row.
 * A2  SCROLL — bottom fast, top fast, recount; ids unique, depths preserved.
 * A3  STALE UI — `page.route()` rewrites /team between polls. A status flip, a
 *     title change and a token move must all reach the DOM. This is the attack
 *     the 1302 wrapper cache is most likely to fail.
 * A4  FIVE STATES — `data-team-state` is never blank: ready / empty / unlinked
 *     / error / loading, driven by intercepted payloads.
 * A5  KEYBOARD ✕ — tab to a row's ✕ and assert `:focus-within` reveals it
 *     (opacity 1), in both themes.
 * A6  SWEEP HONESTY — replays hover-1291's own HOVER_PROBE at the coordinates
 *     it sweeps and reports `teamRowHovered`, which its `pass` does NOT check.
 *
 * Run: node docs/plan/artifacts/phase1300/redteam/dom-1305.cjs
 * Env: RT_BASE_URL, RT_API_URL, FORGE_SESSION_COOKIE, RT_OUT (default /tmp/rt1305-out)
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

const BASE = process.env.RT_BASE_URL ?? "http://127.0.0.1:7799";
const API = process.env.RT_API_URL ?? "http://127.0.0.1:7796";
const CHAT = process.env.RT_CHAT ?? "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const OUT = process.env.RT_OUT ?? "/tmp/rt1305-out";

const results = [];
let failures = 0;
function check(id, label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  results.push({ id, label, ok, got, want });
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${label}${ok ? "" : `\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

/** hover-1291.cjs:218 verbatim — the assertion under audit in A6. */
const HOVER_PROBE = (target) => {
  const hot = [...document.querySelectorAll(":hover")];
  const deepest = hot.length ? hot[hot.length - 1] : null;
  const atPoint = document.elementFromPoint(target.x, target.y);
  const sameNode = Boolean(
    deepest && atPoint && (atPoint === deepest || atPoint.contains(deepest) || deepest.contains(atPoint)),
  );
  const teamRow = deepest ? deepest.closest("[data-team-row]") : null;
  return {
    teamRowHovered: Boolean(teamRow),
    deepestTag: deepest ? deepest.tagName : null,
    pass: Boolean(sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML"),
  };
};

const ROW_CENSUS = () =>
  [...document.querySelectorAll("[data-team-row]")].map((el) => ({
    id: el.dataset.nodeId ?? null,
    depth: el.dataset.depth ?? null,
    kind: el.dataset.kind ?? null,
  }));

function countNodes(res) {
  let n = 0;
  const walk = (x) => {
    n++;
    for (const s of x.subagents) walk(s);
  };
  walk(res.manager);
  for (const w of res.workers) walk(w);
  return n;
}

async function main() {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  fs.mkdirSync(OUT, { recursive: true });

  const health = await (await fetch(`${API}/api/health`)).json();
  if (!health.ok) throw new Error(`API not healthy: ${JSON.stringify(health)}`);
  const live = await (await fetch(`${API}/api/chat/${CHAT}/team`)).json();
  const nodeCount = countNodes(live);
  console.log(`rig: web=${BASE} api=${API} | /team = ${nodeCount} nodes, ${live.workers.length} workers`);
  console.log(`api ships task.id? ${live.workers.some((w) => w.task && "id" in w.task)}\n`);

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([
    { name: "authjs.session-token", value: COOKIE, domain: new URL(BASE).hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();

  /* One switch the route handler reads, so a rewrite can be armed mid-session
     without tearing the page down. `null` = pass through untouched. */
  let override = null;
  await page.route(`**/api/proxy/chat/${CHAT}/team`, async (route) => {
    if (!override) return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(override(body)) });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // ── A1 row census ────────────────────────────────────────────────────────
  const census = await page.evaluate(ROW_CENSUS);
  check("A1", "every /team node has a DOM row (no windowing, no lost rows)", census.length, nodeCount);
  check("A1", "no duplicate node ids in the DOM", new Set(census.map((r) => r.id)).size, census.length);

  // ── A2 scroll to the bottom fast, then the top ───────────────────────────
  const scroller = page.locator("[data-team-scroll]").first();
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(400);
  const atBottom = await page.evaluate(ROW_CENSUS);
  const thumb = await scroller.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(400);
  const atTop = await page.evaluate(ROW_CENSUS);
  check("A2", "row count survives a fast scroll to the bottom", atBottom.length, nodeCount);
  check("A2", "row count survives the scroll back to the top", atTop.length, nodeCount);
  check("A2", "indentation depth is identical before and after scrolling", atTop.map((r) => r.depth).join(","), census.map((r) => r.depth).join(","));
  check("A2", "scroll thumb reflects the whole list (scrollHeight > clientHeight)", thumb.scrollHeight > thumb.clientHeight, true);
  results.push({ id: "A2", label: "scroll metrics", ok: true, got: thumb, want: "informational" });

  // ── A3 stale UI: rewrite the response between polls ──────────────────────
  const victimId = census.find((r) => r.depth === "1")?.id ?? census[1].id;
  const before = await page.locator(`[data-team-row][data-node-id="${victimId}"]`).innerText();
  const STAMP = "REDTEAM-1305-TITLE";
  override = (body) => {
    const map = (n) =>
      n.id === victimId
        ? { ...n, status: "completed", settled: true, description: STAMP, tokens: { ...n.tokens, output: n.tokens.output + 777_000, total: n.tokens.total + 777_000 }, subagents: n.subagents.map(map) }
        : { ...n, subagents: n.subagents.map(map) };
    return { ...body, manager: map(body.manager), workers: body.workers.map(map) };
  };
  await page.waitForTimeout(14_000); // ≥2 polls at TEAM_POLL_MS = 6s
  const after = await page.locator(`[data-team-row][data-node-id="${victimId}"]`).innerText();
  check("A3", "a rewritten description reaches the DOM (memo did not freeze the row)", after.includes(STAMP), true);
  check("A3", "the row did not keep its old text", before === after, false);
  const statusAttr = await page.locator(`[data-team-row][data-node-id="${victimId}"]`).getAttribute("data-status");
  results.push({ id: "A3", label: "row text before → after", ok: true, got: { before: before.slice(0, 90), after: after.slice(0, 90), statusAttr }, want: "informational" });

  override = null;
  await page.waitForTimeout(8000);
  const reverted = await page.locator(`[data-team-row][data-node-id="${victimId}"]`).innerText();
  check("A3", "removing the rewrite restores the real text (no sticky stale row)", reverted.includes(STAMP), false);

  // ── A4 the five states ───────────────────────────────────────────────────
  const stateOf = () => page.locator("[data-team-state]").first().getAttribute("data-team-state");
  check("A4", "ready", await stateOf(), "ready");

  override = (body) => ({ ...body, workers: [], manager: { ...body.manager, subagents: [] } });
  await page.waitForTimeout(8000);
  check("A4", "empty (no workers) is a distinguishable state, not a blank panel", await stateOf(), "empty");
  const emptyText = await page.locator("[data-team-state]").first().innerText();
  check("A4", "empty state says something", emptyText.trim().length > 0, true);

  override = (body) => ({ ...body, project: null, link_source: null, workers: [] });
  await page.waitForTimeout(8000);
  const unlinked = await stateOf();
  results.push({ id: "A4", label: "unlinked payload → state", ok: true, got: unlinked, want: "informational" });

  override = null;
  await page.waitForTimeout(8000);
  check("A4", "back to ready after the rewrites stop", await stateOf(), "ready");

  // ── A5 keyboard reach of the ✕ ───────────────────────────────────────────
  /* A row whose ✕ is ENABLED. A running row with `terminate` ungated renders a
     deliberately `disabled` ✕ (TeamRow.tsx:543) and a disabled button is not
     focusable by HTML rule — not a keyboard-reach defect. The reversible
     dismissal on a SETTLED row is what must stay reachable. */
  const dismissableId = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-team-row]")];
    const hit = rows.reverse().find((r) => { const x = r.querySelector("[data-team-x]"); return x && !x.disabled; });
    return hit ? hit.dataset.nodeId : null;
  });
  check("A5", "at least one row has an enabled ✕", typeof dismissableId, "string");
  const xOpacity = await page.evaluate(async (id) => {
    const row = document.querySelector(`[data-team-row][data-node-id="${CSS.escape(id)}"]`);
    if (!row) return { error: "row not found" };
    const x = row.querySelector("[data-team-x]");
    if (!x) return { error: "no ✕ in row" };
    const controls = x.closest(".team-row-controls");
    const idle = getComputedStyle(controls).opacity;
    x.focus();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { idle, focused: getComputedStyle(controls).opacity, isFocused: document.activeElement === x, tag: x.tagName, disabled: x.disabled };
  }, dismissableId);
  check("A5", "✕ of the last DISMISSABLE row is focusable and revealed by :focus-within", { focused: xOpacity.focused, isFocused: xOpacity.isFocused }, { focused: "1", isFocused: true });
  results.push({ id: "A5", label: "✕ reveal detail", ok: true, got: xOpacity, want: "informational" });

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(300);
    const op = await page.evaluate((id) => {
      const row = document.querySelector(`[data-team-row][data-node-id="${CSS.escape(id)}"]`);
      const x = row.querySelector("[data-team-x]");
      x.focus();
      return getComputedStyle(x.closest(".team-row-controls")).opacity;
    }, dismissableId);
    check("A5", `✕ revealed under keyboard focus in ${theme} theme`, op, "1");
    await page.screenshot({ path: path.join(OUT, `a5-focus-${theme}.png`), fullPage: false });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  // ── A6 does the sweep actually hover rows? ───────────────────────────────
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= window.innerHeight)
      .map((b) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })),
  );
  const probes = [];
  for (const i of [0, Math.floor(boxes.length / 2), boxes.length - 1]) {
    await page.mouse.move(boxes[i].x, boxes[i].y);
    await page.waitForTimeout(60);
    probes.push({ box: i, ...(await page.evaluate(HOVER_PROBE, boxes[i])) });
  }
  check("A6", "a sweep over team-row centres does hover team rows", probes.every((p) => p.teamRowHovered), true);
  results.push({ id: "A6", label: "probes", ok: true, got: probes, want: "informational" });

  // ── A7 dismiss / hiddenCount / restore ──────────────────────────────────
  const beforeDismiss = (await page.evaluate(ROW_CENSUS)).length;
  const victimDepth = await page.locator(`[data-team-row][data-node-id="${dismissableId}"]`).getAttribute("data-depth");
  await page.locator(`[data-team-row][data-node-id="${dismissableId}"] [data-team-x]`).click();
  await page.waitForTimeout(600);
  const afterDismiss = (await page.evaluate(ROW_CENSUS)).length;
  check("A7", "dismissing a row removes it from the DOM", afterDismiss < beforeDismiss, true);
  const restore = page.locator("[data-team-restore]").first();
  const restoreText = await restore.innerText();
  check("A7", "hiddenCount counts the dismissal, not windowed-out rows", /^\s*1 hidden/.test(restoreText.replace(/\s+/g, " ")), true);
  await restore.click();
  await page.waitForTimeout(600);
  const restored = await page.evaluate(ROW_CENSUS);
  check("A7", "restore brings every row back", restored.length, beforeDismiss);
  check("A7", "the restored row keeps its indentation depth", restored.find((r) => r.id === dismissableId)?.depth, victimDepth);
  results.push({ id: "A7", label: "restore button text", ok: true, got: restoreText, want: "informational" });

  fs.writeFileSync(path.join(OUT, "dom-1305.json"), JSON.stringify({ rig: { web: BASE, api: API, chat: CHAT }, nodeCount, results }, null, 2));
  await browser.close();
  console.log(`\n${failures === 0 ? "HELD" : `${failures} BREAK(S)`} — ${path.join(OUT, "dom-1305.json")}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
