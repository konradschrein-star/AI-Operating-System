/**
 * network-700.cjs — NFU3 poll budget for phase 700, re-checked with BOTH zones
 * mounted. 14-ui-v3-quality.md schedules this for this phase explicitly.
 *
 * THE CLAIM UNDER TEST, as `PlanKanban.tsx`'s own header comment states it:
 * the v3 panel's slot costs a 6s team poll plus a 30s plan poll = 12 req/min,
 * against the pre-v3 panel's `/agents` every 4s plus `/projects/board` every
 * 6s = 25 req/min. Same slot, two polls either way, less than half the rate.
 *
 * ── Round 705: the assertion this script was missing ─────────────────────
 * Round 704 found that the panel-slot claim above was true while the number
 * that actually mattered had regressed: the WHOLE-SURFACE total went from
 * phase 500's recorded 40 req/min to 43-44, breaking
 * `phase600/nav-walk.cjs:310` (P3, ≤ 40/min). This script printed 43 in a
 * `note()` beside phase 500's 40 and never compared them, so it reported PASS
 * over a regression that was visible in its own output. The total is now a
 * `check()` against phase 500's recorded figure — see the block that computes
 * `p500Total`. The build was moved back under the ceiling (team 5s → 6s, plan
 * 15s → 30s); the ceiling was not moved to fit the build.
 *
 * ── A correction to the brief, stated up front ───────────────────────────
 * The brief says "compare against phase 500's recorded baseline HAR". THERE IS
 * NO BASELINE HAR anywhere in this corpus — phases 400/500/600 all recorded
 * per-request JSON logs from Playwright's `request` event, not HAR files
 * (`find docs/plan/artifacts -name '*.har'` → nothing). Rather than quietly
 * substitute a different file and call it the HAR, this round does both:
 *
 *   - it RECORDS a real HAR (`network-700.har`, via Playwright's `recordHar`),
 *     so the phase has the artifact the brief asks to attach and later rounds
 *     have the baseline HAR that did not exist until now;
 *   - it COMPARES against the actual recorded baselines, named by file:
 *     `phase400/managers-network-baseline.json` for the pre-v3 slot, and
 *     `phase500/team-network-after.json` for the one-zone v3 panel.
 *
 * ── Three windows, 60s each ──────────────────────────────────────────────
 *   1. PANEL VISIBLE   the project chat open, Team tab, both zones mounted.
 *   2. PANEL COLLAPSED the ✕ in the panel header. Both zone polls must stop.
 *   3. FILES TAB       the Files tab selected, panel still open. Both zone
 *                      polls must stop here too — `visible` is
 *                      `!collapsed && tab === "team"` (ChatSurface.tsx), so
 *                      this is a genuinely different code path from (2) and
 *                      the brief asks for both.
 *
 * FAIL if the two zone endpoints exceed their rates with the panel visible, or
 * if a single request to either is observed in window 2 or window 3.
 *
 * Run:
 *   PHASE700_BASE_URL=http://127.0.0.1:7809 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)" \
 *     node docs/plan/artifacts/phase700/network-700.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { BASE, OUT_DIR, SRC_DIR, finish, makeChecker, openChat, resolveChat, withBrowser } =
  require("./lib-703.cjs");

const { results, check, note, failed } = makeChecker();

const SECONDS = Number(process.env.PHASE700_WATCH_SECONDS ?? "60");
/** SSE aborted, matching every baseline in this corpus: with the event stream
 *  up the transcript's detail query idles at 20s, and with it aborted the query
 *  falls back to 3s. Both baselines this compares against were recorded with it
 *  aborted, so this one is too — comparing across that switch would be a lie by
 *  arithmetic. */
const ABORT_SSE = process.env.ABORT_SSE !== "0";

const TEAM_ENDPOINT = "/chat/:id/team";
const PLAN_ENDPOINT = "/chat/:id/plan";
/** 6s and 30s (round 705), with one request of slack each for a window boundary
 *  landing mid-period. 10/min and 2/min are the nominal rates. */
const TEAM_CAP = 11;
const PLAN_CAP = 3;

const HAR_PATH = path.join(OUT_DIR, "network-700.har");
/* SRC_DIR, not OUT_DIR: these are COMMITTED baselines being read. When a rerun
 * writes to /tmp (lib-703.cjs's default since round 705), the baselines it
 * compares against must still come out of the repo. */
const PRE_V3 = path.resolve(SRC_DIR, "../phase400/managers-network-baseline.json");
const PHASE500 = path.resolve(SRC_DIR, "../phase500/team-network-after.json");

/** uuid → `:id`, so a per-path count is a per-ENDPOINT count. Copied from
 *  phase400/network-watch.cjs, which every baseline here was summarised with —
 *  a different normaliser would make the comparison meaningless. */
function endpointOf(pathWithQuery) {
  return pathWithQuery
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

function summarize(requests, elapsedMs) {
  const counts = {};
  for (const r of requests) counts[r.endpoint] = (counts[r.endpoint] ?? 0) + 1;
  const per_minute = {};
  for (const [k, v] of Object.entries(counts)) per_minute[k] = +(v / (elapsedMs / 60_000)).toFixed(2);
  return {
    window_ms: elapsedMs,
    total_requests: requests.length,
    total_per_minute: +(requests.length / (elapsedMs / 60_000)).toFixed(2),
    counts,
    per_minute,
  };
}

async function watch(page, requests, label) {
  console.log(`  watching ${SECONDS}s — ${label} …`);
  const from = requests.length;
  const t0 = Date.now();
  await page.waitForTimeout(SECONDS * 1_000);
  const slice = requests.slice(from);
  return { label, requests: slice, ...summarize(slice, Date.now() - t0) };
}

function loadBaseline(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { __error: e.message };
  }
}

async function main() {
  const chatRow = await resolveChat();
  note("chat", { id: chatRow.id, title: chatRow.title });

  const windows = await withBrowser(
    async (ctx) => {
      const page = await ctx.newPage();
      if (ABORT_SSE) await page.route("**/api/events/**", (route) => route.abort());

      const requests = [];
      const t0 = Date.now();
      page.on("request", (r) => {
        const url = r.url();
        if (!url.includes("/api/proxy/")) return;
        const rest = url.split("/api/proxy")[1];
        requests.push({ ms: Date.now() - t0, method: r.method(), url: rest, endpoint: endpointOf(rest) });
      });

      await openChat(page);

      /* ── 1: panel visible, both zones mounted ───────────────────────────── */
      const visible = await watch(page, requests, "panel visible, Team tab, both zones");

      /* ── 2: panel collapsed ─────────────────────────────────────────────── */
      const collapse = page.getByTitle("Collapse").first();
      if (!(await collapse.isVisible().catch(() => false)))
        throw new Error('no button[title="Collapse"] — the panel chrome changed; cannot run window 2');
      await collapse.click();
      await page.waitForTimeout(1_000);
      if (await page.locator("[data-team-panel]").isVisible().catch(() => false))
        throw new Error('clicked Collapse but [data-team-panel] is still visible');
      if (await page.locator("[data-plan-kanban]").isVisible().catch(() => false))
        throw new Error('clicked Collapse but [data-plan-kanban] is still visible');
      const collapsed = await watch(page, requests, "panel collapsed");

      /* ── 3: Files tab, panel re-expanded ────────────────────────────────── */
      /* The collapsed rail's own control, not phase 500's `title="Show live
       * projects panel"` — that button no longer exists (the collapsed rail was
       * rewritten in this project's phase 400/500; today it offers "Show the
       * team for this chat" and "Show file explorer", ChatSurface.tsx:137/155).
       * "Show file explorer" both expands the panel and selects the Files tab
       * in one click, which is exactly the state window 3 wants. */
      const expandToFiles = page.getByTitle("Show file explorer").first();
      if (!(await expandToFiles.isVisible().catch(() => false)))
        throw new Error('no button[title="Show file explorer"] on the collapsed rail — cannot reach window 3');
      await expandToFiles.click();
      await page.waitForTimeout(2_000);
      const filesTabState = await page.evaluate(() => ({
        team_panel: document.querySelector("[data-team-panel]") !== null,
        plan_zone: document.querySelector("[data-plan-kanban]") !== null,
      }));
      note("with the Files tab open, the Team zones are", filesTabState);
      check("the team zone is unmounted on the Files tab", filesTabState.team_panel, false);
      check("the plan zone is unmounted on the Files tab", filesTabState.plan_zone, false);
      const filesTab = await watch(page, requests, "Files tab open");

      return { visible, collapsed, filesTab };
    },
    { recordHar: { path: HAR_PATH, content: "omit" } },
  );

  const { visible, collapsed, filesTab } = windows;

  const teamPerMin = visible.per_minute[TEAM_ENDPOINT] ?? 0;
  const planPerMin = visible.per_minute[PLAN_ENDPOINT] ?? 0;
  const zonePerMin = +(teamPerMin + planPerMin).toFixed(2);

  note("window 1 — panel visible", { total_per_minute: visible.total_per_minute, per_minute: visible.per_minute });
  note("window 2 — panel collapsed", { total_per_minute: collapsed.total_per_minute, per_minute: collapsed.per_minute });
  note("window 3 — Files tab", { total_per_minute: filesTab.total_per_minute, per_minute: filesTab.per_minute });
  note("the two zone polls", { team: teamPerMin, plan: planPerMin, sum: zonePerMin });

  check(`${TEAM_ENDPOINT} <= ${TEAM_CAP}/min (6s poll)`, teamPerMin <= TEAM_CAP, true);
  check(`${PLAN_ENDPOINT} <= ${PLAN_CAP}/min (30s poll)`, planPerMin <= PLAN_CAP, true);

  /* ── The claim: 16/min for the slot, against 25/min pre-v3 ──────────────── */
  const preV3 = loadBaseline(PRE_V3);
  check("the pre-v3 baseline file is readable", preV3.__error ?? null, null);
  const preV3Slot = preV3.__error
    ? null
    : +(((preV3.per_minute["/agents"] ?? 0) + (preV3.per_minute["/projects/board"] ?? 0)).toFixed(2));
  note("pre-v3 panel slot (/agents 4s + /projects/board 6s)", {
    file: PRE_V3,
    per_minute: preV3.__error ? null : { agents: preV3.per_minute["/agents"], board: preV3.per_minute["/projects/board"] },
    sum: preV3Slot,
  });
  check("the v3 panel slot costs less than the pre-v3 slot it replaced", zonePerMin < preV3Slot, true);

  /* ── The WHOLE-SURFACE total, asserted — round 704 finding #2 ───────────── */
  /* This block used to be three `note()`s. That is exactly how round 702 shipped
   * a 43 req/min surface over a 40 req/min ceiling and still printed PASS: the
   * per-endpoint caps above were satisfied, the panel-slot comparison below was
   * satisfied, and the one number that regressed was printed beside phase 500's
   * and never compared to it. A quantity a protocol prints but never checks is
   * decoration. So the total is a `check()` now, against phase 500's RECORDED
   * total read out of its own committed JSON — the same number
   * `phase600/nav-walk.cjs:310` (P3) gates on, so the two cannot drift apart
   * silently again. If this ceiling is ever to move, it moves here, in
   * nav-walk.cjs and in NFU3 together, with sign-off — never by one of them
   * quietly not looking. */
  const p500 = loadBaseline(PHASE500);
  check("the phase 500 baseline file is readable", p500.__error ?? null, null);
  const p500Total = p500.__error ? null : (p500.panel_visible?.total_per_minute ?? null);
  const p500Team = p500.__error ? null : (p500.panel_visible?.per_minute?.[TEAM_ENDPOINT] ?? null);
  note("phase 500 (one zone, same slot)", {
    file: PHASE500,
    team_per_minute: p500Team,
    total_per_minute: p500Total,
  });
  check("phase 500 recorded a whole-surface total to compare against", typeof p500Total, "number");
  note("whole-surface total, this build vs phase 500", {
    phase700: visible.total_per_minute,
    phase500_recorded: p500Total,
    delta: p500Total === null ? null : +(visible.total_per_minute - p500Total).toFixed(2),
  });
  check(
    `whole-surface total <= phase 500's recorded total (${p500Total}/min) — same ceiling as nav-walk.cjs P3`,
    p500Total !== null && visible.total_per_minute <= p500Total,
    true,
  );

  /* ── The two silence proofs ─────────────────────────────────────────────── */
  const zoneReqs = (w) =>
    w.requests.filter((r) => r.endpoint === TEAM_ENDPOINT || r.endpoint === PLAN_ENDPOINT);
  const collapsedZone = zoneReqs(collapsed);
  const filesZone = zoneReqs(filesTab);
  note("zone requests while collapsed", collapsedZone.map((r) => r.endpoint));
  note("zone requests on the Files tab", filesZone.map((r) => r.endpoint));
  check("ZERO zone polls while the panel is collapsed", collapsedZone.length, 0);
  check("ZERO zone polls while the Files tab is open", filesZone.length, 0);

  /* The HAR is written by `context.close()` in lib-703's `finally`. If it is
   * missing the artifact the brief asks to attach does not exist, so this is a
   * failure rather than a shrug. */
  const harOk = fs.existsSync(HAR_PATH);
  const harEntries = harOk ? JSON.parse(fs.readFileSync(HAR_PATH, "utf8")).log.entries.length : 0;
  note("HAR", { path: HAR_PATH, entries: harEntries, bytes: harOk ? fs.statSync(HAR_PATH).size : 0 });
  check("the HAR was written", harOk, true);
  check("the HAR has entries", harEntries > 0, true);

  console.log("\n── per-endpoint, panel visible vs the two recorded baselines ──");
  const allPaths = new Set([
    ...Object.keys(preV3.__error ? {} : preV3.per_minute),
    ...Object.keys(p500.__error ? {} : (p500.panel_visible?.per_minute ?? {})),
    ...Object.keys(visible.per_minute),
  ]);
  console.log(`  ${"endpoint".padEnd(24)} ${"pre-v3".padStart(9)} ${"phase500".padStart(9)} ${"phase700".padStart(9)}`);
  for (const p of [...allPaths].sort()) {
    const a = preV3.__error ? 0 : (preV3.per_minute[p] ?? 0);
    const b = p500.__error ? 0 : (p500.panel_visible?.per_minute?.[p] ?? 0);
    const c = visible.per_minute[p] ?? 0;
    console.log(`  ${p.padEnd(24)} ${a.toFixed(2).padStart(9)} ${b.toFixed(2).padStart(9)} ${c.toFixed(2).padStart(9)}`);
  }

  finish(
    "network-700.json",
    {
      base: BASE,
      chat: { id: chatRow.id, title: chatRow.title },
      sse: ABORT_SSE ? "aborted (detail query on its 3s fallback)" : "live",
      window_seconds: SECONDS,
      har: { path: path.basename(HAR_PATH), entries: harEntries },
      caps: { [TEAM_ENDPOINT]: TEAM_CAP, [PLAN_ENDPOINT]: PLAN_CAP },
      panel_visible: visible,
      panel_collapsed: collapsed,
      files_tab: filesTab,
      zone_slot: {
        phase700: { team: teamPerMin, plan: planPerMin, sum: zonePerMin },
        pre_v3: { file: path.basename(PRE_V3), sum: preV3Slot },
        phase500: {
          file: path.basename(PHASE500),
          team: p500.__error ? null : p500.panel_visible?.per_minute?.[TEAM_ENDPOINT],
        },
      },
      results,
      verdict: failed() === 0 ? "PASS" : "FAIL",
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
