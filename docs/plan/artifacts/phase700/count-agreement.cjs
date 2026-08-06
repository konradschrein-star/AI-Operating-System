/**
 * count-agreement.cjs — U25's central claim, measured: the rail badge, the
 * panel bar and the database agree on how much of this project is done.
 *
 * THREE LEGS, THREE DIFFERENT COMPUTATIONS ON THREE PROCESSES. That is the
 * whole point; a triangle whose corners share a code path proves nothing.
 *
 *   1. RAIL BADGE   `GET :7798/api/chat` → the row's `tasks_done`/`tasks_total`.
 *                   Computed by SQL in forge-control/src/routes/chat-linkage.ts
 *                   (`count(t.*) FILTER (WHERE t.status = 'done')`), on the
 *                   worktree API.
 *   2. PANEL BAR    the rendered DOM's `[data-plan-kanban][data-plan-progress]`.
 *                   Computed in the browser by `planProgress` over `PlanNode[]`
 *                   (forge-control-web/app/desktop/team/planStore.ts), from the
 *                   `/plan` response — a different endpoint, a different
 *                   language, a different machine word for "done".
 *   3. GROUND TRUTH `GET :7700/api/projects/:id` → `tasks[]`, counted here in
 *                   this file with `t.status === 'done'`. The LIVE forge-control,
 *                   deliberately NOT the harness the other two legs read, so a
 *                   bug confined to :7798 cannot make the triangle close.
 *
 * READ-ONLY, AND ONE GET. Leg 3 is the only thing in this round that touches
 * :7700 and it is a GET of a project it does not own. Nothing is written
 * anywhere by this script.
 *
 * ── Why every leg carries two timestamps ──────────────────────────────────
 * This project's own tasks change status while this round runs: 51/66 at round
 * 701, 54/66 at 702, 55/66 when this script was first executed. A STALE SAMPLE
 * IS NOT A DISAGREEMENT, and a reviewer cannot tell the two apart from three
 * bare numbers. So each leg records `started_at`, `finished_at` and its own
 * elapsed ms, the whole capture records its total span, and a mismatch is
 * reported together with that span rather than as a bare FAIL. The three reads
 * are issued as close to simultaneously as the harness allows — the DOM read is
 * taken first (it is the slow one, being a real page), with the two HTTP legs
 * fired in the same `Promise.all` immediately after, so the span is bounded by
 * one round trip rather than by three sequential ones.
 *
 * A mismatch still EXITS NON-ZERO. The span is context for the reviewer, not an
 * excuse the script grants itself: if the numbers differ, this fails, and the
 * span tells you whether to re-run or to open a bug.
 *
 * ── Second job: drift against round 701 ───────────────────────────────────
 * `ground-truth-701.json` recorded 51/66 at 01:08:50Z with a per-phase
 * breakdown. This script re-reads the same shapes and prints the delta per
 * phase block. Drift there is EXPECTED and is reported as a note, never as a
 * failure — round 701 measured a moving project and said so.
 *
 * Run (see README.md §2 for the harness + cookie recipe):
 *   PHASE700_BASE_URL=http://127.0.0.1:7809 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)" \
 *     node docs/plan/artifacts/phase700/count-agreement.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  API,
  BASE,
  GROUND,
  OUT_DIR,
  PROJECT_ID,
  finish,
  makeChecker,
  openChat,
  resolveChat,
  timedGet,
  watchErrors,
  withBrowser,
} = require("./lib-703.cjs");

const { results, check, note, failed } = makeChecker();

/** The panel bar, read straight off the rendered attribute — the same string a
 *  human reads, not a recomputation of it. `data-plan-state` comes with it so a
 *  "—" placeholder can never be mistaken for a count of zero. */
async function readPanel(page) {
  const started_at = new Date().toISOString();
  const dom = await page.evaluate(() => {
    const kanban = document.querySelector("[data-plan-kanban]");
    /* The rail badge has no data attribute of its own — it predates this
     * project's conventions and lives in another round's file — so it is read
     * as the `<span>` whose entire text is "<done>/<total> tasks", which is
     * exactly the string on screen. Same selector kanban-702.cjs used. */
    const railText = Array.from(document.querySelectorAll("span"))
      .map((s) => (s.textContent ?? "").trim())
      .find((t) => /^\d+\/\d+ tasks$/.test(t));
    return {
      plan_state: kanban?.getAttribute("data-plan-state") ?? null,
      plan_progress: kanban?.getAttribute("data-plan-progress") ?? null,
      rail_badge_rendered: railText ? railText.replace(" tasks", "") : null,
      phase_cards: Array.from(document.querySelectorAll("[data-plan-phase]")).map((c) => ({
        round_base: Number(c.getAttribute("data-plan-phase")),
        progress: c.getAttribute("data-plan-phase-progress"),
      })),
      task_chips: document.querySelectorAll("[data-plan-task]").length,
    };
  });
  return { ...dom, started_at, finished_at: new Date().toISOString() };
}

/** `x/y` → `{done, total}`, or null for the "—" placeholder. Never a silent 0:
 *  a zero would sail through the equality checks below and report agreement
 *  between a rendered dash and an empty project. */
function parseProgress(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d+)\/(\d+)$/.exec(text);
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

function countDone(tasks) {
  const breakdown = {};
  for (const t of tasks) breakdown[t.status] = (breakdown[t.status] ?? 0) + 1;
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length, breakdown };
}

async function main() {
  const chatRow = await resolveChat();
  note("chat", { id: chatRow.id, title: chatRow.title });

  const capture = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await openChat(page);

    /* THE SIMULTANEITY WINDOW OPENS HERE. The DOM read goes first because it is
     * the slowest leg; the two HTTP legs are fired together immediately after,
     * so the whole span is one page-evaluate plus one round trip rather than
     * three sequential fetches. */
    const span_started_at = new Date().toISOString();
    const t0 = Date.now();
    const panel = await readPanel(page);
    const [rail, ground, plan] = await Promise.all([
      timedGet(API, "/api/chat?limit=50"),
      timedGet(GROUND, `/api/projects/${PROJECT_ID}`),
      timedGet(API, `/api/chat/${chatRow.id}/plan`),
    ]);
    const span_ms = Date.now() - t0;
    const span_finished_at = new Date().toISOString();

    return { panel, rail, ground, plan, span_started_at, span_finished_at, span_ms, errs };
  });

  const { panel, rail, ground, plan, span_ms } = capture;

  /* ── Leg 1: the rail badge, server-computed ──────────────────────────────── */
  const railRow = (rail.body.runs ?? []).find((r) => r.id === chatRow.id);
  if (!railRow) throw new Error(`chat ${chatRow.id} vanished from GET /api/chat between reads`);
  const legRail = { done: railRow.tasks_done, total: railRow.tasks_total };

  /* ── Leg 2: the panel bar, client-computed, read off the screen ──────────── */
  const legPanel = parseProgress(panel.plan_progress);
  if (legPanel === null)
    throw new Error(
      `[data-plan-progress] is ${JSON.stringify(panel.plan_progress)}, not an x/y pair — ` +
        `the zone was in state "${panel.plan_state}" and never produced a count`,
    );

  /* ── Leg 3: ground truth, counted here from the live rows ────────────────── */
  const groundTasks = ground.body.tasks ?? [];
  const legGround = countDone(groundTasks);

  /* ── And the plan endpoint itself, for completeness: the input leg 2 read ── */
  const planTasks = plan.body.phases.flatMap((p) => p.tasks);
  const legPlan = countDone(planTasks);

  note("timing", {
    span_ms,
    span: [capture.span_started_at, capture.span_finished_at],
    legs: {
      panel_dom: [panel.started_at, panel.finished_at],
      rail_api: [rail.started_at, rail.finished_at, `${rail.elapsed_ms}ms`],
      ground_live: [ground.started_at, ground.finished_at, `${ground.elapsed_ms}ms`],
      plan_api: [plan.started_at, plan.finished_at, `${plan.elapsed_ms}ms`],
    },
  });
  note("leg 1 — rail badge (:7798 SQL)", legRail);
  note("leg 2 — panel bar (DOM, planStore)", { ...legPanel, rendered: panel.plan_progress });
  note("leg 3 — ground truth (:7700 live rows)", legGround);
  note("plan endpoint (leg 2's input)", legPlan);
  note("ground truth status breakdown", legGround.breakdown);

  check("project under test is the chat's own project", plan.body.project?.id, PROJECT_ID);
  check("plan zone reached ready", panel.plan_state, "ready");

  const asPair = (l) => `${l.done}/${l.total}`;
  check("leg2 panel bar == leg1 rail badge", asPair(legPanel), asPair(legRail));
  check("leg2 panel bar == leg3 ground truth", asPair(legPanel), asPair(legGround));
  check("leg1 rail badge == leg3 ground truth", asPair(legRail), asPair(legGround));
  check(
    "the rendered rail string == the rendered panel string",
    panel.rail_badge_rendered,
    panel.plan_progress,
  );
  check("plan endpoint agrees with ground truth", asPair(legPlan), asPair(legGround));
  check("task chips on screen == tasks in the plan", panel.task_chips, legPlan.total);

  /* ── Drift against round 701 ─────────────────────────────────────────────── */
  const prevPath = path.join(OUT_DIR, "ground-truth-701.json");
  let drift = null;
  try {
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    const nowByBase = new Map(
      plan.body.phases.map((p) => [
        p.round_base,
        { task_count: p.tasks.length, done_count: p.tasks.filter((t) => t.status === "done").length },
      ]),
    );
    const perPhase = [];
    for (const p of prev.plan_endpoint.phases) {
      const now = nowByBase.get(p.round_base);
      perPhase.push({
        round_base: p.round_base,
        then: `${p.done_count}/${p.task_count}`,
        now: now ? `${now.done_count}/${now.task_count}` : "(block gone)",
        moved: !now || now.done_count !== p.done_count || now.task_count !== p.task_count,
      });
    }
    const newBlocks = [...nowByBase.keys()].filter(
      (b) => !prev.plan_endpoint.phases.some((p) => p.round_base === b),
    );
    drift = {
      round_701_captured_at: prev.captured_at,
      round_701: { done: prev.projects_api.done, total: prev.projects_api.total },
      round_703: { done: legGround.done, total: legGround.total },
      delta_done: legGround.done - prev.projects_api.done,
      delta_total: legGround.total - prev.projects_api.total,
      new_phase_blocks: newBlocks,
      per_phase: perPhase,
      /* EXPECTED, and never a failure: round 701 measured a project that was
       * running at the time and recorded 2 running + 13 pending tasks. What
       * would be a real finding is drift in the OPPOSITE direction — tasks
       * un-doing themselves — so that is the only thing asserted. */
      verdict: "informational",
    };
    note("drift vs ground-truth-701.json", {
      then: drift.round_701,
      now: drift.round_703,
      delta_done: drift.delta_done,
      delta_total: drift.delta_total,
      phases_moved: perPhase.filter((p) => p.moved).map((p) => `${p.round_base}: ${p.then}→${p.now}`),
      new_phase_blocks: newBlocks,
    });
    check("no task un-did itself since round 701 (done count is monotonic)", drift.delta_done >= 0, true);
  } catch (e) {
    /* A missing or malformed baseline is a real gap in the evidence chain, not
     * something to shrug at — it is recorded and it fails. */
    check(`ground-truth-701.json readable at ${prevPath}`, e.message, null);
  }

  note("failed requests during the capture", capture.errs.failedRequests);
  note("ignored console lines (pre-existing — see lib-703.cjs:watchErrors)", capture.errs.ignored);
  check("console errors", capture.errs.consoleErrors, []);

  finish(
    "count-agreement.json",
    {
      base: BASE,
      api: API,
      ground: GROUND,
      chat: { id: chatRow.id, title: chatRow.title },
      project_id: PROJECT_ID,
      span: {
        started_at: capture.span_started_at,
        finished_at: capture.span_finished_at,
        span_ms,
        note:
          "all three legs were read inside this span; a disagreement is only a " +
          "real disagreement if it survives a span this short — this project's " +
          "task statuses move while the round runs",
      },
      legs: {
        rail_badge: { ...legRail, source: `GET ${API}/api/chat`, at: [rail.started_at, rail.finished_at] },
        panel_bar: {
          ...legPanel,
          source: "[data-plan-kanban][data-plan-progress] in the rendered DOM",
          rendered: panel.plan_progress,
          rail_rendered: panel.rail_badge_rendered,
          at: [panel.started_at, panel.finished_at],
        },
        ground_truth: {
          done: legGround.done,
          total: legGround.total,
          breakdown: legGround.breakdown,
          source: `GET ${GROUND}/api/projects/${PROJECT_ID} (live, read-only)`,
          at: [ground.started_at, ground.finished_at],
        },
        plan_endpoint: {
          done: legPlan.done,
          total: legPlan.total,
          breakdown: legPlan.breakdown,
          source: `GET ${API}/api/chat/${chatRow.id}/plan`,
          at: [plan.started_at, plan.finished_at],
        },
      },
      phase_cards: panel.phase_cards,
      drift_vs_701: drift,
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
