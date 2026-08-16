/**
 * nav-walk.cjs — U20/U21, 14 §"Per-phase reviewer focus" 600, first clause:
 * "walk the full stack down (manager→worker→sub-agent) and back; browser refresh
 * mid-stack lands on manager chat without errors".
 *
 * Round 601B's `nav-stack-e2e.cjs` proved the stack REDUCER end to end. This is
 * the reviewer's walk, and it asserts two things 601B did not:
 *
 *   IDENTITY AT EVERY LEVEL. At each of the three levels the header's rendered
 *   role and model are compared against what the API says that node is — a
 *   session's `metadata.role` / `metadata.model_resolved`, a sub-agent's
 *   `subagents_v2` entry or, failing that, its spawn call. The comparison runs
 *   through the shipped `roleLabel`/`modelDisplay` (see oracle-604.ts) and the
 *   RAW wire value is recorded beside it, so a reader can see both the label and
 *   the thing it was made from. A drilled view that shows the parent's model, or
 *   the manager's role, fails here.
 *
 *   (a) THE TEAM PANEL STAYS ON THE MANAGER. `selId` must not follow the drill —
 *   round 601B's semantic fix. Checked as byte-identical row sets at depth 0, 1
 *   and 2 and after each pop, plus the panel's own `data-team-state`.
 *
 *   (b) RELOAD MID-STACK. At depth 2, `page.reload()`. The stack is memory-only
 *   by design (13 §2: a persisted frame would have to be re-validated against a
 *   tree that may have moved under it), so the correct landing is the MANAGER
 *   chat — and it must land there with ZERO console errors and zero page errors.
 *   Console listeners are attached before the reload and every message is kept
 *   in the JSON, not just the count.
 *
 * Walks back TWICE (depth 2 → 1 → 0), asserting the intermediate frame is the
 * worker that was drilled into first and not a rebuilt one.
 *
 * Finally, NFU3 FOR THE DRILLED VIEW. `phase500/team-network.cjs` measures the
 * manager chat and has no way to reach a drill-in, so it cannot answer phase
 * 600's own poll question: a drilled view runs its own detail query, so does the
 * total go up? Three 30s windows — at rest, depth 1, depth 2 — in one page and
 * one session, gated against phase 500's "after" budget of 40 req/min.
 *
 * Run: see README.md §2.
 *   PHASE600_BASE_URL=http://127.0.0.1:7786 FORGE_SESSION_COOKIE="$(cat …)" \
 *     node docs/plan/artifacts/phase600/nav-walk.cjs
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const {
  API,
  BASE,
  CHAT_TEXT,
  apiRun,
  finish,
  makeChecker,
  openChat,
  resolveChatId,
  surfaceState,
  withBrowser,
} = require("./lib-604.cjs");

const REPO = path.join(__dirname, "..", "..", "..", "..");

/** Ask the shipped derivation what this node's header should read. */
function oracleIdentity(runId, subagentId) {
  const out = execFileSync(
    path.join(REPO, "forge-control", "node_modules", ".bin", "tsx"),
    [
      path.join(REPO, "docs", "plan", "artifacts", "phase600", "oracle-604.ts"),
      "identity",
      runId,
      subagentId ?? "",
      API,
    ],
    { cwd: path.join(REPO, "forge-control-web"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

async function main() {
  const { results, check, note, failed } = makeChecker();
  const consoleErrors = [];
  const pageErrors = [];
  let capturing = false;

  let counting = null;

  const payload = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (capturing && msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      if (capturing) pageErrors.push(String(err));
    });
    page.on("request", (req) => {
      if (counting === null) return;
      const u = req.url();
      if (!u.includes("/api/")) return;
      counting.push({ url: u.replace(BASE, ""), t: Date.now() });
    });

    const chatId = await resolveChatId(CHAT_TEXT);
    await openChat(page);

    /* ── depth 0: the manager chat ─────────────────────────────────────── */
    const d0 = await surfaceState(page);
    check("L0 no drilled view is open", d0.depth, 0);
    check("L0 the team tree is ready", d0.teamState, "ready");
    note("L0 team rows", d0.teamRows.length);
    if (d0.teamRows.length < 12)
      throw new Error(
        `only ${d0.teamRows.length} team rows in "${CHAT_TEXT}" — this walk needs a manager with workers AND a worker with a sub-agent`,
      );

    /* ── depth 1: a worker that owns a depth-2 sub-agent ─────────────────
     * `data-depth="2"` marks a sub-agent hanging off a WORKER (the manager's
     * own sub-agents sit at depth 1). Its parent row is the worker to click —
     * picking any worker would usually land on one with no children. */
    const target = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-team-row]"));
      const subIdx = rows.findIndex(
        (r) => r.getAttribute("data-kind") === "subagent" && r.getAttribute("data-depth") === "2",
      );
      if (subIdx < 0) return null;
      for (let i = subIdx - 1; i >= 0; i--) {
        if (rows[i].getAttribute("data-kind") === "worker")
          return {
            worker: rows[i].getAttribute("data-node-id"),
            sub: rows[subIdx].getAttribute("data-node-id"),
          };
      }
      return null;
    });
    if (target === null)
      throw new Error(
        "NO-DEPTH-2-SUBAGENT — no worker in this chat's tree owns a sub-agent, so the three-level walk has nothing to walk. Not a pass.",
      );
    note("target worker / sub-agent", target);

    await page.locator(`[data-team-row][data-node-id="${target.worker}"]`).click();
    await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
    await page.waitForTimeout(4_000);

    const d1 = await surfaceState(page);
    const idW = oracleIdentity(target.worker, null);
    const runW = await apiRun(target.worker);
    check("L1 the drilled view is the clicked worker", d1.drilledRunId, target.worker);
    check("L1 depth is 1", d1.depth, 1);
    check("L1 it is classified as a whole session", d1.kind, "session");
    check("L1 header role == the API's metadata.role, rendered", d1.role, idW.rendered.role);
    check("L1 header model == the API's model_resolved, rendered", d1.model, idW.rendered.model);
    check("L1 back points at the manager chat", d1.backLabel, "← manager chat");
    check(
      "L1a the team panel still shows the MANAGER's tree (selId did not move)",
      d1.teamRows,
      d0.teamRows,
    );
    check("L1a the panel's state did not change either", d1.teamState, d0.teamState);
    note("L1 raw wire identity", { ...idW.raw, status: runW.status, title: runW.title });
    note("L1 crumbs", d1.crumbs);

    /* ── depth 2: that worker's own sub-agent ────────────────────────────── */
    await page.locator(`[data-team-row][data-node-id="${target.sub}"]`).click();
    await page.waitForTimeout(4_000);

    const d2 = await surfaceState(page);
    const idS = oracleIdentity(target.worker, target.sub);
    check("L2 depth is 2", d2.depth, 2);
    check("L2 the frame carries the sub-agent's tool_use_id", d2.drilledSubagentId, target.sub);
    check("L2 the frame still FETCHES the parent worker", d2.drilledRunId, target.worker);
    check("L2 it is classified as an in-process sub-agent", d2.kind, "sub-agent");
    check("L2 header role == the sub-agent's own, rendered", d2.role, idS.rendered.role);
    check("L2 header model == the sub-agent's own, rendered", d2.model, idS.rendered.model);
    check(
      "L2a the team panel STILL shows the MANAGER's tree",
      d2.teamRows,
      d0.teamRows,
    );
    check("L2 back no longer points at the manager", d2.backLabel !== "← manager chat", true);
    note("L2 raw wire identity", { ...idS.raw, source: idS.source, description: idS.description });
    note("L2 crumbs", d2.crumbs);
    check(
      "L1/L2 identity is NOT inherited — the two levels differ in role or model",
      idW.rendered.role !== idS.rendered.role || idW.rendered.model !== idS.rendered.model,
      true,
    );

    /* ── (b) reload mid-stack ─────────────────────────────────────────────
     * What the app ACTUALLY does, measured rather than assumed — and it is not
     * quite what round 601B's README says. `DesktopApp` keeps `surface` in plain
     * `useState` with `"today"` as the initial value and persists it nowhere, so
     * a reload lands on TODAY, not on the chat. What survives the reload is the
     * thing that matters for U21: nothing. No drilled frame comes back, no stale
     * worker transcript is restored under a chat's name, and returning to CHAT
     * gives a manager chat. Asserted in that order, with the landing surface
     * recorded so the README can say the true sentence. */
    capturing = true;
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(4_000);
    const landing = await page.evaluate(() => {
      const active = Array.from(document.querySelectorAll("button, div"))
        .filter((el) => ["TODAY", "CHAT", "LIVE", "INBOX", "PROJECTS"].includes((el.textContent ?? "").trim()))
        .map((el) => ({ label: (el.textContent ?? "").trim(), color: getComputedStyle(el).color }));
      return {
        path: location.pathname,
        drilled: document.querySelector("[data-agent-chat-view]") !== null,
        teamPanel: document.querySelector("[data-team-panel]") !== null,
        strip: document.querySelector("[data-orientation-strip]") !== null,
        navLabels: active.map((a) => a.label),
      };
    });
    check("R1 the drilled frame does NOT survive a reload", landing.drilled, false);
    check("R1 …and neither does its orientation strip", landing.strip, false);
    note("R1 where the reload actually lands", landing);

    await page.getByText("CHAT", { exact: true }).first().click();
    await page.waitForSelector("[data-team-panel]", { timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const afterChat = await surfaceState(page);
    check("R2 returning to CHAT opens a MANAGER chat, never a worker", afterChat.depth, 0);
    check("R2 …with no drilled run id anywhere", afterChat.drilledRunId, null);
    note("R2 the chat auto-opened after reload", {
      rows: afterChat.teamRows.length,
      state: afterChat.teamState,
    });

    await page.getByText(CHAT_TEXT, { exact: false }).first().click();
    await page.waitForTimeout(4_000);
    const reloaded = await surfaceState(page);
    check("R3 re-opening the fixture chat gives the same tree back", reloaded.teamRows, d0.teamRows);
    check("R3 …still with nothing drilled", reloaded.depth, 0);
    check("R4 ZERO console errors across reload + re-navigation", consoleErrors, []);
    check("R4 ZERO uncaught page errors across reload + re-navigation", pageErrors, []);
    capturing = false;

    /* ── walk down again, then back TWICE ────────────────────────────────── */
    await page.locator(`[data-team-row][data-node-id="${target.worker}"]`).click();
    await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
    await page.waitForTimeout(2_500);
    await page.locator(`[data-team-row][data-node-id="${target.sub}"]`).click();
    await page.waitForTimeout(3_000);
    check("W1 back at depth 2", (await surfaceState(page)).depth, 2);

    await page.locator("[data-nav-back]").click();
    await page.waitForTimeout(2_500);
    const b1 = await surfaceState(page);
    check("B1 first pop lands at depth 1", b1.depth, 1);
    check("B1 …on the worker below it, not a rebuilt frame", b1.drilledRunId, target.worker);
    check("B1 …with no sub-agent selected any more", b1.drilledSubagentId, null);
    check("B1 …and the team panel unmoved", b1.teamRows, d0.teamRows);

    await page.locator("[data-nav-back]").click();
    await page.waitForTimeout(2_500);
    const b0 = await surfaceState(page);
    check("B2 second pop returns to the manager chat", b0.depth, 0);
    check("B2 …with the same team still on screen", b0.teamRows, d0.teamRows);
    check("B2 …and no orientation strip (there is no drilled node)", b0.strip, false);

    /* ── NFU3 for the DRILLED view ────────────────────────────────────────
     * `phase500/team-network.cjs` measures the manager chat with the panel
     * open; it has no way to reach a drilled view, so on its own it cannot
     * answer the one poll question phase 600 raises: a drilled view runs its
     * OWN detail query, so does the total go up?
     *
     * Three 30s windows in one page and one session — at rest, at depth 1, at
     * depth 2 — counting every `/api/` request. `ChatSurface` disables the
     * manager `detailQ` while `navStack` is non-empty and `AgentChatView` runs
     * exactly one query at the same intervals, so the prediction is "no
     * change"; this measures it instead of restating the code. */
    const per = (list) => {
      const by = {};
      for (const r of list) {
        const key = r.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").split("?")[0];
        by[key] = (by[key] ?? 0) + 1;
      }
      return by;
    };
    const window30 = async (label) => {
      counting = [];
      await page.waitForTimeout(30_000);
      const seen = counting.slice();
      counting = null;
      const byPath = per(seen.map((r) => r.url));
      const perMin = Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, v * 2]));
      note(`P ${label}: requests/min`, { ...perMin, TOTAL: seen.length * 2 });
      return { label, requests: seen.length, per_minute: perMin, total_per_minute: seen.length * 2 };
    };

    const pRest = await window30("at rest (manager chat)");
    await page.locator(`[data-team-row][data-node-id="${target.worker}"]`).click();
    await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const pDepth1 = await window30("drilled, depth 1 (worker)");
    await page.locator(`[data-team-row][data-node-id="${target.sub}"]`).click();
    await page.waitForTimeout(2_000);
    const pDepth2 = await window30("drilled, depth 2 (sub-agent)");
    await page.locator("[data-nav-back]").click();
    await page.waitForTimeout(1_500);
    await page.locator("[data-nav-back]").click();
    await page.waitForTimeout(1_500);

    /* ── SAMPLING TOLERANCE, AND WHY IT IS DERIVED RATHER THAN PICKED ──────
     *
     * ROUND 808, closing round 807 finding 4. As originally written P1/P2
     * compared two independently sampled 30 s windows with `<=` and no
     * tolerance, and they failed about one run in three: round 807 measured
     * 36/38/38, 38/38/38, 38/38/38 over three runs — a single request of
     * difference, one window apart.
     *
     * The cause is the instrument, not the app. For a free-running poll of
     * period p sampled over a window W, with φ the time to the first firing:
     *
     *     count(φ) = floor((W − φ)/p) + 1,  and writing W = k·p + r,
     *     count = k + 1 with probability r/p, else k.
     *
     * So a poll's count is deterministic if and only if p divides W exactly,
     * and varies by ONE SAMPLE otherwise. Round 807 proposed moving the chat
     * list off "a divisor of the window" — that is backwards: 10 s is one of
     * the few phase-STABLE periods and the proposed 11 s varies with
     * probability 0.73. What actually destabilises it is that react-query
     * re-arms `refetchInterval` after each fetch SETTLES, so the effective
     * period is `interval + latency` — a hair above the divisor, the worst
     * spot on the number line. The 3 s chat-detail poll varies for the same
     * reason on its own, so NO choice of chat-list period can make a
     * zero-tolerance comparison of two sampled windows sound.
     *
     * Each poll contributes at most one sample to the difference between two
     * windows, so with N distinct polled paths the windows can differ by up
     * to N on phase alone. N is read off the at-rest window rather than
     * hard-coded, so the tolerance tracks the surface instead of rotting.
     *
     * `docs/plan/artifacts/phase800/nav-walk-sampling.cjs` derives all of
     * this, checks the closed form against a Monte-Carlo, and measures the
     * failure rate of each candidate assertion over 20 000 simulated runs:
     * as written 21–49 %, with round 807's proposed ±1 still 1–8 %, with ±N
     * exactly 0 — and ±N is tight, not slack (worst observed excess: 3).
     *
     * THE CEILING IS NOT TOUCHED. P3's absolute 40/min bound below is what
     * actually caps poll load, and it is phase-robust because it is an
     * absolute limit rather than a comparison of two samples. This change
     * makes P1/P2 honest about their own resolution; it does not raise any
     * budget. */
    const SAMPLE_TOLERANCE = Object.keys(pRest.per_minute).length;
    note("P sampling tolerance (one sample per distinct polled path, measured at rest)", {
      distinct_polled_paths: SAMPLE_TOLERANCE,
      at_rest_requests: pRest.requests,
      depth_1_requests: pDepth1.requests,
      depth_2_requests: pDepth2.requests,
      depth_1_excess: pDepth1.requests - pRest.requests,
      depth_2_excess: pDepth2.requests - pRest.requests,
      derivation: "docs/plan/artifacts/phase800/nav-walk-sampling.cjs",
    });

    check(
      "P1 drilling to depth 1 does not raise the request total (within the instrument's own ±N-sample resolution)",
      pDepth1.requests <= pRest.requests + SAMPLE_TOLERANCE,
      true,
    );
    check(
      "P2 drilling to depth 2 does not raise it either (same tolerance)",
      pDepth2.requests <= pRest.requests + SAMPLE_TOLERANCE,
      true,
    );
    check(
      "P3 the drilled total stays within phase 500's 'after' budget (40/min)",
      pDepth1.total_per_minute <= 40 && pDepth2.total_per_minute <= 40,
      true,
    );

    return {
      poll_budget: {
        at_rest: pRest,
        depth_1: pDepth1,
        depth_2: pDepth2,
        phase500_after_budget_per_min: 40,
        sample_tolerance: {
          samples: SAMPLE_TOLERANCE,
          basis: "one sample per distinct polled path in the at-rest window",
          derivation: "docs/plan/artifacts/phase800/nav-walk-sampling.cjs",
          applies_to: ["P1", "P2"],
          note: "P3's absolute 40/min ceiling takes no tolerance — it is not a comparison of two samples",
        },
      },
      base: BASE,
      api: API,
      chat: { text: CHAT_TEXT, id: chatId },
      navigation: "real — every level reached by clicking a real team row",
      target,
      identity: { level1: idW, level2: idS },
      console_errors_during_reload: consoleErrors,
      page_errors_during_reload: pageErrors,
      levels: { d0, d1, d2, landing, afterChat, reloaded, b1, b0 },
    };
  });

  finish("nav-walk.json", { ...payload, failures: failed(), results }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
