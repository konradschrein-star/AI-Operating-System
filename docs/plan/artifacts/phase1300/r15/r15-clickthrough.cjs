/**
 * r15-clickthrough.cjs — round 1303. The four R15 assertions round 1292 could
 * not evidence, driven in a real browser against the POST-fix build.
 *
 * R15 (`docs/plan/operator-visibility/01-requirements.md`, requirement **R15**):
 * "Chat rail still: selects on click, shows ✕ close affordance on hover, marks
 * selected row, updates status dots live. Side-panel task list still opens runs."
 * The ✕ half is already evidenced (phase400/rail-hover-dark.png); this script
 * drives the other four:
 *
 *   A1  row click SELECTS          → a1-select.json      + a1-select-{light,dark}.png
 *   A2  the selected row is MARKED → a2-marked.json      + a2-marked-{light,dark}.png
 *   A3  status dots are LIVE       → a3-dots.json        + a3-dots-{light,dark}.png
 *   A4  side panel OPENS the run   → a4-open-worker.json + a4-open-worker-{light,dark}.png
 *                                    a4-open-subagent.json + a4-open-subagent-{light,dark}.png
 *
 * Must be pointed at a web build whose proxy target is the WORKTREE api
 * (:7798) — production :7700 runs main. Recipe: phase1290/hover/README.md §7
 * steps A–E, with the copy at /tmp/phase1303-web and the port moved to 7793.
 *
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1303.txt)" \
 *     R15_BASE_URL=http://127.0.0.1:7793 R15_API_URL=http://127.0.0.1:7798 \
 *     node docs/plan/artifacts/phase1300/r15/r15-clickthrough.cjs
 *
 * Writes into /tmp/r15-out by default — the committed artifacts are NOT
 * overwritten by a reproduce. `--commit-artifact` (or R15_OUT=<dir>) writes
 * here. Same guard as hover-1291.cjs after round 1301.
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

const BASE = process.env.R15_BASE_URL ?? "http://127.0.0.1:7793";
const API = process.env.R15_API_URL ?? "http://127.0.0.1:7798";
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const OUT = process.env.R15_OUT
  ? process.env.R15_OUT
  : process.argv.includes("--commit-artifact")
    ? __dirname
    : "/tmp/r15-out";
/** Two rail polls at `refetchInterval: 10_000` (ChatSurface.tsx) plus slack. */
const DOT_WINDOW_MS = Number(process.env.R15_DOT_WINDOW_MS ?? 23_000);

fs.mkdirSync(OUT, { recursive: true });

const meta = {
  round: 1303,
  requirement: "R15",
  build_sha: process.env.R15_BUILD_SHA ?? "unset",
  base_url: BASE,
  api_url: API,
  viewport: "1440x900",
  generated_at: new Date().toISOString(),
};

function write(name, body) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify({ meta, ...body }, null, 2) + "\n");
  console.log(`wrote ${p}${body.verdict ? `  ${body.verdict}` : ""}`);
}

/* ── page-side readers ───────────────────────────────────────────────────
 *
 * Every assertion reads COMPUTED styles, never the JSX. `borderLeft: 2px
 * solid <status colour>` + `background: tokens.selectedBg` is what
 * ChatSurface.tsx's ChatListItem writes for a selected row; a computed read is
 * the only way to prove the browser applied it. */

const RAIL_SNAPSHOT = () =>
  [...document.querySelectorAll(".chat-row")].map((row, i) => {
    const cs = getComputedStyle(row);
    const statusEl = row.querySelector("span.mono");
    const dotEl = row.querySelector("span:not(.mono)");
    const dotCs = dotEl ? getComputedStyle(dotEl) : null;
    // The title line is the first direct child div after the status header row.
    const titleEl = row.children[1];
    return {
      index: i,
      status_text: statusEl ? statusEl.textContent.trim() : null,
      status_text_color: statusEl ? getComputedStyle(statusEl).color : null,
      dot_background: dotCs ? dotCs.backgroundColor : null,
      dot_animation_name: dotCs ? dotCs.animationName : null,
      dot_width: dotCs ? dotCs.width : null,
      border_left_width: cs.borderLeftWidth,
      border_left_style: cs.borderLeftStyle,
      border_left_color: cs.borderLeftColor,
      background_color: cs.backgroundColor,
      title_text: titleEl ? titleEl.textContent.trim().slice(0, 48) : null,
      title_color: titleEl ? getComputedStyle(titleEl).color : null,
    };
  });

/** A row is MARKED when the 2px left border is actually painted — a
 *  `transparent` border is still 2px wide, so width alone proves nothing. */
const MARKED = (r) =>
  r.border_left_width === "2px" &&
  r.border_left_style === "solid" &&
  r.border_left_color !== "rgba(0, 0, 0, 0)" &&
  r.border_left_color !== "transparent";

const TEAM_SNAPSHOT = () =>
  [...document.querySelectorAll("[data-team-row]")].map((row) => {
    const dotEl = row.querySelector("span");
    const dotCs = dotEl ? getComputedStyle(dotEl) : null;
    return {
      node_id: row.dataset.nodeId,
      kind: row.dataset.kind,
      status: row.dataset.status,
      settled: row.dataset.settled,
      role: row.dataset.role,
      dot_background: dotCs ? dotCs.backgroundColor : null,
      dot_border: dotCs ? dotCs.borderTopWidth + " " + dotCs.borderTopColor : null,
      dot_animation_name: dotCs ? dotCs.animationName : null,
    };
  });

async function shoot(page, stem) {
  const shots = {};
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(400);
    const file = `${stem}-${theme}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    shots[theme] = file;
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(200);
  return shots;
}

/** Fail loudly with the DOM fact that was missing — never a silent skip. */
function assert(cond, msg, detail) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}\n${JSON.stringify(detail, null, 2)}`);
  }
}

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");

  const health = await (await fetch(`${API}/api/health`)).json();
  if (!health.ok) throw new Error(`worktree API not healthy: ${JSON.stringify(health)}`);

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  /* The network log IS the A1 observable: which chat the app considers open is
   * observable as the id in the requests SidePanel/ChatSurface fire for it. */
  const proxied = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/proxy/")) proxied.push({ t: Date.now(), url: u.replace(BASE, "") });
  });
  const teamReqs = () =>
    proxied
      .map((r) => /\/api\/proxy\/chat\/([0-9a-f-]{36})\/team/.exec(r.url))
      .filter(Boolean)
      .map((m) => m[1]);
  const detailReqs = () =>
    proxied
      .map((r) => /\/api\/proxy\/chat\/([0-9a-f-]{36})$/.exec(r.url))
      .filter(Boolean)
      .map((m) => m[1]);

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForSelector(".chat-row", { timeout: 30_000 });
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForTimeout(1500);

  /* ── A3 watch mode ───────────────────────────────────────────────────────
   *
   * A rail row only goes `running` when a chat is actually working, and no
   * chat was working during the main pass. This mode parks on the rail and
   * samples every 2 s while an OPERATOR MESSAGE is posted to the manager chat
   * through the app's own path (`POST /api/runs/:id/message` — the same curl
   * every worker uses to report). The transition is produced by using the
   * product, never by writing to the runs table. The poster is deliberately
   * NOT this script: a reproduce must not spam the manager chat. */
  if (process.env.R15_MODE === "a3watch") {
    const WATCH_MS = Number(process.env.R15_WATCH_MS ?? 240_000);
    const samples = [];
    const t0 = Date.now();
    let sawRunning = false;
    let sawSettleAfterRunning = false;
    let runningShots = null;
    console.log("WATCH START — post the operator message now");
    while (Date.now() - t0 < WATCH_MS) {
      const snap = await page.evaluate(RAIL_SNAPSHOT);
      const running = snap.filter((r) => r.status_text === "running");
      const prev = samples.length ? samples[samples.length - 1].rows : null;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(snap)) {
        samples.push({ ms: Date.now() - t0, rows: snap });
      }
      if (running.length && !sawRunning) {
        sawRunning = true;
        console.log(`RUNNING at +${Date.now() - t0}ms — rows ${running.map((r) => r.index)}`);
        runningShots = await shoot(page, "a3-live-running");
      } else if (sawRunning && !running.length) {
        sawSettleAfterRunning = true;
        console.log(`SETTLED again at +${Date.now() - t0}ms`);
        break;
      }
      await page.waitForTimeout(2000);
    }
    const withRunning = samples.filter((s) => s.rows.some((r) => r.status_text === "running"));
    const runningRows = withRunning.flatMap((s) =>
      s.rows.filter((r) => r.status_text === "running"),
    );
    const settledRows = samples.flatMap((s) => s.rows.filter((r) => r.status_text !== "running"));
    const pulseOnRunning = runningRows.every((r) => r.dot_animation_name === "pulse");
    const noPulseOnSettled = settledRows.every((r) => r.dot_animation_name === "none");
    const colourOk = samples
      .flatMap((s) => s.rows)
      .every((r) => r.dot_background === r.status_text_color);
    const transitions = [];
    for (let i = 1; i < samples.length; i++) {
      for (let j = 0; j < samples[i].rows.length; j++) {
        const from = samples[i - 1].rows[j];
        const to = samples[i].rows[j];
        if (from && to && from.status_text !== to.status_text) {
          transitions.push({
            ms: samples[i].ms,
            row_index: j,
            title: to.title_text,
            from: from.status_text,
            from_dot: { color: from.dot_background, animation: from.dot_animation_name },
            to: to.status_text,
            to_dot: { color: to.dot_background, animation: to.dot_animation_name },
          });
        }
      }
    }
    write("a3-live-transition.json", {
      assertion:
        "A3/live — a rail row's status dot follows a REAL status transition: the " +
        "running row carries the pulse treatment, the settled row does not, and the " +
        "dot colour tracks the status text across the change",
      how_the_transition_was_produced:
        "round 1303's required manager report was posted to the manager chat " +
        "(POST /api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/message — the app's own " +
        "endpoint, the same call every worker makes). The chat run went running and " +
        "settled again on its own. NOTHING was written to the runs table by hand and " +
        "no transition was simulated.",
      watch_window_ms: Date.now() - t0,
      sample_interval_ms: 2000,
      distinct_states_captured: samples.length,
      transitions,
      running_observed: sawRunning,
      settled_after_running_observed: sawSettleAfterRunning,
      pulse_on_every_running_row: pulseOnRunning,
      no_pulse_on_any_settled_row: noPulseOnSettled,
      dot_colour_tracks_status_text_in_every_sample: colourOk,
      running_screenshots: runningShots,
      samples,
      verdict:
        sawRunning && pulseOnRunning && noPulseOnSettled && colourOk && transitions.length > 0
          ? "PASS — " +
            transitions.length +
            " real rail transition(s) observed; the running row's dot carried " +
            "`animation: pulse`, settled rows carried none, colour tracked status throughout"
          : "FAIL / NOT OBSERVED — running_observed=" + sawRunning,
    });
    await browser.close();
    return;
  }

  /* Rail order == `listQ.data.runs` order (ChatSurface.tsx renders one flat
   * `.map` over it), so index i in the DOM is runs[i] from the same endpoint. */
  const list = await (await fetch(`${API}/api/chat?limit=30`)).json();
  const railIds = list.runs.map((r) => r.id);

  /* ── A1 + A2 ─────────────────────────────────────────────────────────── */
  const before = await page.evaluate(RAIL_SNAPSHOT);
  const teamBefore = teamReqs();
  const detailBefore = detailReqs();
  const openBefore = teamBefore[teamBefore.length - 1] ?? null;
  const middleBefore = await page.evaluate(
    () => document.querySelector("[data-chat-thread], main")?.innerText.slice(0, 160) ?? null,
  );

  const targetIndex = 1;
  const targetId = railIds[targetIndex];
  assert(targetId && targetId !== openBefore, "target row must not already be the open chat", {
    targetId,
    openBefore,
  });

  await page.locator(".chat-row").nth(targetIndex).click();
  await page.waitForFunction(
    (id) =>
      performance
        .getEntriesByType("resource")
        .some((e) => e.name.includes(`/api/proxy/chat/${id}/team`)),
    targetId,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);

  const after = await page.evaluate(RAIL_SNAPSHOT);
  const teamAfter = teamReqs();
  const detailAfter = detailReqs();
  const openAfter = teamAfter[teamAfter.length - 1] ?? null;
  const middleAfter = await page.evaluate(
    () => document.querySelector("[data-chat-thread], main")?.innerText.slice(0, 160) ?? null,
  );

  assert(openAfter === targetId, "the /team request must follow the clicked row", {
    openBefore,
    openAfter,
    targetId,
  });
  assert(openAfter !== openBefore, "the open chat must have CHANGED", { openBefore, openAfter });
  assert(detailAfter.includes(targetId), "the chat detail fetch must follow the clicked row", {
    detailBefore,
    detailAfter,
    targetId,
  });

  const a1Shots = await shoot(page, "a1-select");
  write("a1-select.json", {
    assertion: "A1 — clicking a .chat-row changes which chat the app has open",
    observable:
      "the id in the requests the app fires for the open chat: SidePanel's " +
      "GET /api/proxy/chat/:id/team (chatId={selId}) and ChatSurface's " +
      "GET /api/proxy/chat/:id detail fetch (queryKey ['chat','run',selId]). " +
      "Both are keyed on selId, so a change in the id proves selId moved.",
    rail_order_source: `${API}/api/chat?limit=30 — runs[].id, same query the rail renders`,
    rail_ids: railIds,
    clicked_row_index: targetIndex,
    clicked_row_expected_id: targetId,
    clicked_row_title: after[targetIndex].title_text,
    open_chat_before: openBefore,
    open_chat_after: openAfter,
    team_requests_seen: teamAfter,
    detail_requests_seen: detailAfter,
    middle_surface_text_before: middleBefore,
    middle_surface_text_after: middleAfter,
    screenshots: a1Shots,
    verdict:
      openAfter === targetId && openAfter !== openBefore
        ? "PASS — open chat moved from " + openBefore + " to " + openAfter
        : "FAIL",
  });

  const markedBefore = before.filter(MARKED).map((r) => r.index);
  const markedAfter = after.filter(MARKED).map((r) => r.index);
  assert(markedAfter.length === 1, "exactly one row must carry the selection marking", {
    markedBefore,
    markedAfter,
  });
  assert(markedAfter[0] === targetIndex, "the marked row must be the clicked row", {
    markedAfter,
    targetIndex,
  });
  const rowChanged =
    before[targetIndex].border_left_color !== after[targetIndex].border_left_color &&
    before[targetIndex].background_color !== after[targetIndex].background_color &&
    before[targetIndex].title_color !== after[targetIndex].title_color;
  assert(rowChanged, "the clicked row's computed marking must have changed", {
    before: before[targetIndex],
    after: after[targetIndex],
  });

  const a2Shots = await shoot(page, "a2-marked");
  write("a2-marked.json", {
    assertion:
      "A2 — the clicked row gains the selection marking, and exactly one row in the rail carries it",
    marking_under_test:
      "ChatSurface.tsx ChatListItem: borderLeft `2px solid <status colour>` when " +
      "selected (transparent otherwise), background tokens.selectedBg, title colour " +
      "tokens.text when selected vs tokens.textLabel when not. Read as COMPUTED styles.",
    marked_row_indexes_before: markedBefore,
    marked_row_indexes_after: markedAfter,
    clicked_row_index: targetIndex,
    clicked_row_before: before[targetIndex],
    clicked_row_after: after[targetIndex],
    previously_marked_row_before: markedBefore.length ? before[markedBefore[0]] : null,
    previously_marked_row_after: markedBefore.length ? after[markedBefore[0]] : null,
    all_rows_after: after,
    screenshots: a2Shots,
    verdict:
      markedAfter.length === 1 && markedAfter[0] === targetIndex && rowChanged
        ? "PASS — marking moved to the clicked row and exactly one row carries it"
        : "FAIL",
  });

  /* ── A3 ──────────────────────────────────────────────────────────────────
   *
   * Back to the project chat first: it is the one with a populated team, and
   * A4 needs it. `openChat(id)` also resets the nav stack, so this doubles as
   * the reset between A4's two paths. */
  await page.locator(".chat-row").nth(0).click();
  await page.waitForTimeout(2500);

  const dotsT0 = await page.evaluate(RAIL_SNAPSHOT);
  const teamDots = await page.evaluate(TEAM_SNAPSHOT);
  const pollsBefore = proxied.filter((r) => /\/api\/proxy\/chat\?/.test(r.url)).length;
  await page.waitForTimeout(DOT_WINDOW_MS);
  const dotsT1 = await page.evaluate(RAIL_SNAPSHOT);
  const pollsAfter = proxied.filter((r) => /\/api\/proxy\/chat\?/.test(r.url)).length;

  /* colour-tracks-status: `dot(color, …)` and the status label are handed the
   * SAME `STATUS_COLOR[run.status]`, so the dot's background must equal the
   * label's colour, row by row. Any drift is a real defect. */
  const colourMismatch = dotsT1.filter((r) => r.dot_background !== r.status_text_color);
  const pulsing = dotsT1.filter((r) => r.dot_animation_name === "pulse").map((r) => r.index);
  const runningRows = dotsT1.filter((r) => r.status_text === "running").map((r) => r.index);
  const transitions = dotsT0
    .map((r, i) => ({ index: i, from: r.status_text, to: dotsT1[i]?.status_text }))
    .filter((t) => t.from !== t.to);

  assert(colourMismatch.length === 0, "every rail dot's colour must match its status text", {
    colourMismatch,
  });
  assert(
    JSON.stringify(pulsing) === JSON.stringify(runningRows),
    "the live (pulse) treatment must be carried by exactly the running rows",
    { pulsing, runningRows },
  );
  assert(pollsAfter > pollsBefore, "the rail list must have re-polled inside the window", {
    pollsBefore,
    pollsAfter,
  });

  const teamRunning = teamDots.filter((r) => r.status === "running");
  const teamSettled = teamDots.filter((r) => r.settled === "true");
  const teamSplitOk =
    teamRunning.length > 0 &&
    teamRunning.every((r) => r.dot_animation_name === "pulse") &&
    teamSettled.every((r) => r.dot_animation_name === "none");

  const a3Shots = await shoot(page, "a3-dots");
  write("a3-dots.json", {
    assertion:
      "A3 — status dots track status, and the live (pulse) treatment is carried by " +
      "running rows only",
    treatment_under_test:
      "tokens.ts dot(color, animate) → `animation: pulse 2s infinite` when animate. " +
      "The rail calls dot(color, run.status === 'running'); TeamRow calls " +
      "dot(statusColor(n.status), n.status === 'running') and overrides a settled " +
      "row's fill to transparent + 1px border.",
    observation_window_ms: DOT_WINDOW_MS,
    rail_list_polls_in_window: pollsAfter - pollsBefore,
    rail_poll_interval_ms: 10000,
    rail_rows_t0: dotsT0,
    rail_rows_t1: dotsT1,
    rail_status_transitions_observed: transitions,
    rail_colour_mismatches: colourMismatch,
    rail_rows_with_pulse: pulsing,
    rail_rows_running: runningRows,
    team_panel_corroboration: {
      note:
        "the rail held no running chat in this window (see rail_rows_running). The " +
        "running-vs-settled treatment split is therefore shown on the OTHER caller of " +
        "the same dot() helper — the side panel's team rows, which did hold running " +
        "nodes. This is corroboration of the treatment, NOT the rail assertion.",
      rows_total: teamDots.length,
      running: teamRunning,
      settled_count: teamSettled.length,
      settled_with_pulse: teamSettled.filter((r) => r.dot_animation_name !== "none"),
      split_ok: teamSplitOk,
    },
    screenshots: a3Shots,
    verdict:
      colourMismatch.length === 0 && JSON.stringify(pulsing) === JSON.stringify(runningRows)
        ? transitions.length > 0
          ? "PASS — colour tracks status, pulse tracks running, and a transition was observed"
          : "PARTIAL IN THIS PASS — colour tracks status and pulse tracks running on " +
            "every rail row, and the rail re-polled " +
            (pollsAfter - pollsBefore) +
            "× inside the window; but NO status transition occurred in the observation " +
            "window and no rail row was running, so neither an observed transition nor " +
            "the running-dot treatment was captured IN THE RAIL. No transition was " +
            "fabricated. See team_panel_corroboration — and see " +
            "`a3-live-transition.json`, the R15_MODE=a3watch pass, which DID capture a " +
            "real rail transition (completed → running → completed, pulse on and off) " +
            "after an operator message put the manager chat back to work. A3 is closed " +
            "there, not here."
        : "FAIL",
  });

  /* ── A4 ─────────────────────────────────────────────────────────────────
   *
   * Both paths through `onOpenNode`: a worker resolves to its own run, a
   * sub-agent resolves to `{runId: parent_id, subagentId: its tool_use_id}`. */
  const team = await (await fetch(`${API}/api/chat/${railIds[0]}/team`)).json();
  const parentOf = new Map();
  for (const w of team.workers) {
    for (const s of w.subagents ?? []) parentOf.set(s.id, w.id);
  }

  const a4 = {};
  for (const kind of ["worker", "subagent"]) {
    await page.locator(".chat-row").nth(0).click(); // resets navStack
    await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
    await page.waitForTimeout(1500);

    const row = page.locator(`[data-team-row][data-kind="${kind}"]`).first();
    await row.scrollIntoViewIfNeeded();
    const nodeId = await row.getAttribute("data-node-id");
    const rowKind = await row.getAttribute("data-kind");
    const rowRole = await row.getAttribute("data-role");
    const totalRows = await page.locator("[data-team-row]").count();
    const rowIndex = await page.evaluate(
      (id) => [...document.querySelectorAll("[data-team-row]")].findIndex((e) => e.dataset.nodeId === id),
      nodeId,
    );
    await row.click();
    await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
    await page.waitForTimeout(1200);

    const view = await page.evaluate(() => {
      const el = document.querySelector("[data-agent-chat-view]");
      return {
        run_id: el.dataset.runId,
        subagent_id: el.dataset.subagentId,
        depth: el.dataset.depth,
        header_text: el.innerText.slice(0, 200),
      };
    });
    const expectedRunId = kind === "subagent" ? parentOf.get(nodeId) : nodeId;
    assert(!!expectedRunId, `no parent known for sub-agent ${nodeId}`, { nodeId });
    assert(view.run_id === expectedRunId, `${kind} row must open its run`, { view, expectedRunId });
    if (kind === "subagent") {
      assert(view.subagent_id === nodeId, "sub-agent frame must carry the tool_use_id", {
        view,
        nodeId,
      });
    } else {
      assert(view.subagent_id === "", "worker frame must carry no sub-agent id", { view });
    }

    const shots = await shoot(page, `a4-open-${kind}`);
    a4[kind] = { nodeId, rowKind, rowRole, rowIndex, totalRows, view, expectedRunId, shots };
    write(`a4-open-${kind}.json`, {
      assertion: `A4/${kind} — clicking a [data-team-row] navigates the middle surface to that node`,
      observable:
        "AgentChatView renders `data-agent-chat-view` with `data-run-id={frame.runId}` " +
        "and `data-subagent-id`. ChatSurface.openNode builds the frame: a worker → " +
        "{runId: node.id}; a sub-agent → {runId: node.parent_id, subagentId: node.id}.",
      row_clicked: { node_id: nodeId, kind: rowKind, role: rowRole, dom_index: rowIndex },
      team_rows_in_dom: totalRows,
      windowing_note:
        "round 1302 did NOT ship windowing (L3, commit 92aeb0f: it would have removed the " +
        "keyboard-reachable ✕ from rows outside the slice, which R15 protects). All " +
        `${totalRows} rows are in the DOM; the row was reached by scrollIntoViewIfNeeded.`,
      expected_run_id: expectedRunId,
      opened_view: view,
      screenshots: shots,
      verdict: "PASS — opened run " + view.run_id + (view.subagent_id ? ` sliced to sub-agent ${view.subagent_id}` : ""),
    });
  }

  await browser.close();
  console.log("\nA1 PASS  A2 PASS  A3 see verdict  A4 PASS (worker + sub-agent)");
  console.log(JSON.stringify({ a4_summary: Object.keys(a4) }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
