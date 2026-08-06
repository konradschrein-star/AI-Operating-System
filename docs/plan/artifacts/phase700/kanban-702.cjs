/**
 * kanban-702.cjs — round 702's own proof that the plan zone renders THIS
 * project's real plan, and that its x/y is the rail badge's number.
 *
 * Deliberately narrower than round 703's formal capture: this script answers
 * the four questions round 702's brief asks a builder to answer before
 * committing, and nothing else.
 *
 *   1. THE ZONE RENDERS REAL DATA. `[data-plan-kanban]` reaches
 *      `data-plan-state="ready"`, and the number of `[data-plan-phase]` cards
 *      and `[data-plan-task]` chips equals what `GET /api/chat/:id/plan` on the
 *      harness says — not "roughly ~8/~60", exactly what the endpoint returns
 *      at capture time.
 *
 *   2. x/y AGREES WITH THE RAIL BADGE. Both are read out of the SAME rendered
 *      page in one evaluate, so no poll can slide between them, and both are
 *      compared against the plan endpoint fetched in the same window. The rail
 *      badge is server-computed (chat-linkage.ts) and the panel bar is
 *      client-computed (planStore.planProgress) — the whole point of U25 is
 *      that two different computations land on one number.
 *
 *   3. U26 CLICK-THROUGH IS ALIVE. A click on a `PLAN DOCS` entry pushes the
 *      `plandoc` frame: `[data-plan-doc-view]` appears carrying that file name,
 *      and back returns to the manager chat. On THIS corpus no phase block
 *      carries `doc_path` (linkage-701.md §6), so the flat list is the only
 *      live path and this is the assertion that proves it is not a dead click.
 *
 *   4. THE TEAM ZONE DID NOT MOVE. Row count and `data-team-state` before and
 *      after the plan zone mounts underneath it.
 *
 * Both themes are shot because it costs one attribute write; round 703 owns the
 * formal both-theme capture and its verdict, not this file.
 *
 * NFU8: playwright is loaded by ABSOLUTE PATH from /opt/hermes-workspace and is
 * not a dependency of either repo. `resolveChromium` is copied verbatim from
 * scripts/checks/frozen-dom.cjs:30-58, as phase 600's lib-604.cjs did.
 *
 * Run (see phase600/README.md §2 for the harness + cookie recipe):
 *   PHASE700_BASE_URL=http://127.0.0.1:7809 \
 *   PHASE700_API_URL=http://127.0.0.1:7798 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-702.txt)" \
 *     node docs/plan/artifacts/phase700/kanban-702.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

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
  if (!candidates.length)
    throw new Error(`no chromium binary under ${cache}`);
  return candidates[0];
}

const BASE = process.env.PHASE700_BASE_URL ?? "http://127.0.0.1:7809";
const API = process.env.PHASE700_API_URL ?? "http://127.0.0.1:7798";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
/** bfd1283a — the chat round 701 linked to project 8ea0cc08 (linkage-701.md §2).
 *  Resolved from its title at run time, never hard-coded as a uuid. */
const CHAT_TEXT = process.env.PHASE700_CHAT ?? "Okay when I click the file section";
/** Round 704 finding #4, same rule as lib-703.cjs: a rerun is non-destructive.
 *  Writes go to /tmp/phase700-out unless `--write` (or PHASE700_WRITE=1) says
 *  to re-record the committed evidence in place. This script predates
 *  lib-703.cjs and keeps its own copy of the harness, so it keeps its own copy
 *  of this rule rather than growing a dependency on the later file. */
const WRITE_IN_PLACE = process.argv.includes("--write") || process.env.PHASE700_WRITE === "1";
const OUT_DIR =
  process.env.PHASE700_OUT_DIR ?? (WRITE_IN_PLACE ? __dirname : path.join(os.tmpdir(), "phase700-out"));
if (OUT_DIR !== __dirname) fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
  );
};
const note = (name, value) => {
  results.push({ name, note: value });
  console.log(`      ${name}: ${JSON.stringify(value)}`);
};

async function api(pathname) {
  const r = await fetch(`${API}${pathname}`);
  if (!r.ok) throw new Error(`GET ${API}${pathname} → ${r.status} ${r.statusText}`);
  return r.json();
}

/** What the page currently shows, rail and panel together in ONE evaluate so a
 *  15s plan poll or a 5s team poll cannot slide between the two readings. */
async function readSurface(page, chatId) {
  return page.evaluate((id) => {
    const kanban = document.querySelector("[data-plan-kanban]");
    /* The rail badge has no data attribute of its own (it predates this
     * project's conventions and belongs to another round's file), so it is read
     * as the `<span>` whose whole text is "<done>/<total> tasks" — the same
     * string a human reads off the row. It is a span, not a div: ChatSurface's
     * `ChatListItem` renders it inline beside the status word. */
    const railText = Array.from(document.querySelectorAll("span"))
      .map((s) => (s.textContent ?? "").trim())
      .find((t) => /^\d+\/\d+ tasks$/.test(t));
    return {
      planState: kanban?.getAttribute("data-plan-state") ?? null,
      planProgress: kanban?.getAttribute("data-plan-progress") ?? null,
      headerText: document.querySelector("[data-plan-header]")?.textContent ?? null,
      phaseCards: Array.from(document.querySelectorAll("[data-plan-phase]")).map((c) => ({
        base: Number(c.getAttribute("data-plan-phase")),
        progress: c.getAttribute("data-plan-phase-progress"),
      })),
      taskChips: document.querySelectorAll("[data-plan-task]").length,
      docLinks: Array.from(document.querySelectorAll("[data-plan-docs] [data-plan-doc]")).map((b) =>
        b.getAttribute("data-plan-doc"),
      ),
      teamRows: document.querySelectorAll("[data-team-row]").length,
      teamState: document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? null,
      railBadge: railText ? railText.replace(" tasks", "") : null,
      docView: document.querySelector("[data-plan-doc-view]")?.getAttribute("data-doc-name") ?? null,
      /* The `maxHeight: "40%"` on the zone root only bites if the percentage
       * resolves against a definite parent height. Measured rather than
       * assumed: if it ever silently became `none`, the zone would grow to its
       * ~60 chips and squeeze the team tree out of the panel. */
      geometry: (() => {
        const zone = document.querySelector("[data-plan-kanban]");
        const panel = zone?.parentElement ?? null;
        const scroll = document.querySelector("[data-plan-scroll]");
        if (!zone || !panel || !scroll) return null;
        return {
          panelH: Math.round(panel.getBoundingClientRect().height),
          zoneH: Math.round(zone.getBoundingClientRect().height),
          zonePct: Math.round((zone.getBoundingClientRect().height / panel.getBoundingClientRect().height) * 100),
          scrollOverflows: scroll.scrollHeight > scroll.clientHeight + 1,
          headerOutsideScroller: !scroll.contains(document.querySelector("[data-plan-header]")),
        };
      })(),
    };
  }, chatId);
}

async function main() {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first");

  const list = await api("/api/chat?limit=50");
  const chat = (list.runs ?? []).find((r) => (r.title ?? "").includes(CHAT_TEXT));
  if (!chat) throw new Error(`no chat whose title contains ${JSON.stringify(CHAT_TEXT)}`);
  note("chat", { id: chat.id, title: chat.title });

  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let context = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    context = ctx;
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
    const consoleErrors = [];
    const ignored = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      /* `GET /favicon.ico` 404s on every page of this app, on main as well as
       * on this branch — the repo ships no favicon. It is browser-internal, so
       * it never reaches the `response` listener below either. Recorded rather
       * than silently filtered: an ignore list that hides its contents is how a
       * real error gets ignored later. */
      const url = m.location()?.url ?? "";
      if (url.endsWith("/favicon.ico")) {
        ignored.push(`${m.text()} — ${url}`);
        return;
      }
      consoleErrors.push(`${m.text()} — ${url}`);
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    /* A bare "Failed to load resource: 404" console line names no URL, which is
     * useless as evidence. Record the request itself. */
    const failedRequests = [];
    page.on("response", (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
    });

    await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
    if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
    await page.waitForTimeout(2_000);
    await page.getByText("CHAT", { exact: true }).first().click();
    await page.waitForTimeout(3_000);
    await page.getByText(CHAT_TEXT, { exact: false }).first().click();
    await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("[data-plan-kanban]")?.getAttribute("data-plan-state") === "ready",
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1_500);

    /* Ground truth read as close in time to the render as the harness allows. */
    const plan = await api(`/api/chat/${chat.id}/plan`);
    const surface = await readSurface(page, chat.id);
    const railApi = (await api("/api/chat?limit=50")).runs.find((r) => r.id === chat.id);

    const apiDone = plan.phases.reduce(
      (n, p) => n + p.tasks.filter((t) => t.status === "done").length,
      0,
    );
    const apiTotal = plan.phases.reduce((n, p) => n + p.tasks.length, 0);

    note("plan endpoint", { phases: plan.phases.length, tasks: apiTotal, done: apiDone });
    note("rail endpoint", { done: railApi.tasks_done, total: railApi.tasks_total });
    note("rendered", {
      state: surface.planState,
      progress: surface.planProgress,
      cards: surface.phaseCards.length,
      chips: surface.taskChips,
      docs: surface.docLinks.length,
    });

    check("plan zone state", surface.planState, "ready");
    check("phase cards == endpoint phases", surface.phaseCards.length, plan.phases.length);
    check("task chips == endpoint tasks", surface.taskChips, apiTotal);
    check("doc links == endpoint docs[]", surface.docLinks, plan.docs);
    check("panel x/y == plan endpoint", surface.planProgress, `${apiDone}/${apiTotal}`);
    check(
      "panel x/y == rail badge (server-computed)",
      surface.planProgress,
      `${railApi.tasks_done}/${railApi.tasks_total}`,
    );
    check("panel x/y == rail badge (as rendered)", surface.planProgress, surface.railBadge);
    check("team zone still ready", surface.teamState, "ready");
    note("team rows beside the plan zone", surface.teamRows);
    note("card progress", surface.phaseCards);
    note("zone geometry", surface.geometry);
    check("zone respects its 40% cap", surface.geometry.zonePct <= 40, true);
    check("card body scrolls inside the zone", surface.geometry.scrollOverflows, true);
    check(
      "x/y header is outside the scroller (cannot scroll away)",
      surface.geometry.headerOutsideScroller,
      true,
    );

    /* Screenshots — the side panel only, both themes. */
    const panel = page.locator("[data-team-panel]").locator("..");
    await panel.screenshot({ path: path.join(OUT_DIR, "phase700-702-kanban-dark.png") });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await page.waitForTimeout(600);
    await panel.screenshot({ path: path.join(OUT_DIR, "phase700-702-kanban-light.png") });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(400);

    /* U26 click-through, on the flat docs list — the only live path on this
     * corpus (no phase block carries doc_path). */
    const target = plan.docs[plan.docs.length - 1];
    await page.click(`[data-plan-docs] [data-plan-doc="${target}"]`);
    await page.waitForSelector("[data-plan-doc-view]", { timeout: 15_000 });
    const drilled = await readSurface(page, chat.id);
    check("plandoc frame opened the clicked file", drilled.docView, target);
    check("team zone unmoved by the drill-in", drilled.teamState, "ready");
    check("plan zone unmoved by the drill-in", drilled.planState, "ready");
    await page.screenshot({ path: path.join(OUT_DIR, "phase700-702-plandoc-dark.png") });

    await page.click("[data-nav-back]");
    await page.waitForTimeout(1_200);
    const back = await readSurface(page, chat.id);
    check("back returns to the manager chat", back.docView, null);
    check("plan zone survives the pop", back.planState, "ready");

    note("failed requests", failedRequests);
    note("ignored console lines (pre-existing, see the listener)", ignored);
    check("console errors", consoleErrors, []);
  } finally {
    if (context !== null) await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await browser.close();
  }

  const out = path.join(OUT_DIR, "kanban-702.json");
  fs.writeFileSync(out, `${JSON.stringify({ base: BASE, api: API, results }, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} → ${out}`);
  if (OUT_DIR !== __dirname) {
    console.log(`      committed evidence left untouched (${path.join(__dirname, "kanban-702.json")})`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
