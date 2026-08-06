/**
 * team-frozen.cjs — U16, protocol 14 §"Frozen-time truth".
 *
 * Samples the Team panel DOM at t and t+12s. PASS iff:
 *   1. every settled row's [data-working-cell] and [data-tokens-cell]
 *      textContent is byte-identical across the two samples, AND
 *   2. every settled row's [data-working-cell] carries data-frozen="true"
 *      in BOTH samples, AND
 *   3. at least one RUNNING row's working cell DID change, and carries
 *      data-frozen="false" (anti-vacuous-pass guard: two static samples of a
 *      panel that renders nothing would trivially "pass" #1 and #2 for the
 *      wrong reason).
 *
 * ── Why this script visits TWO chats (round 504) ──────────────────────────
 * Round 501b wrote this as one sweep over one fixture and reported
 * SKIPPED-NO-RUNNING when no live row was on screen. Round 504 ran it and hit
 * exactly that, and the reason is structural, not a bad fixture pick:
 *
 *   • the panel's rows are `GET /api/chat/:id/team` = the chat's own run
 *     (manager) + every run carrying `metadata.project_id = <the chat's
 *     project>`;
 *   • a chat only HAS a project when `projects.metadata.origin_chat_id` names
 *     it, or when the bounded thread scan recovers one (chat-linkage.ts);
 *   • the only runs alive in this database at any moment are project workers,
 *     and the two projects that own them today have NO chat linkage at all.
 *
 * So no single chat in this database can show a settled tree AND a live row.
 * The honest answer is to prove both halves against real data instead of
 * faking one of them:
 *
 *   PART A — settled truth. The real fixture chat, opened through the rail
 *            like a user opens it. Every row real, every number the server's.
 *   PART B — live truth. A run that is RUNNING right now, discovered from
 *            `GET /api/agents` at run time (never hardcoded — whatever is live
 *            when the reviewer re-runs is what gets measured). The panel is
 *            pointed at it by INJECTING ONE RAIL ROW client-side, because the
 *            rail lists conversations only and a project worker is excluded
 *            from it by design (db/runs.ts's listRuns drops rows carrying
 *            metadata.project_id). The injection is NAVIGATION ONLY: the
 *            /team response the panel then measures is fetched from the real
 *            server, unmodified, and every number in Part B's samples is the
 *            server's own. Recorded as `navigation: "injected-rail-row"` in
 *            the output so no reviewer has to take that on trust.
 *
 * Combined verdict: PASS needs BOTH halves. If the fleet has no running run at
 * all, the verdict is NO-LIVE-RUN with a non-zero exit — never a pass.
 *
 * Selectors are the DOM contract shared with the panel (round 502) — do not
 * "improve" them here; a mismatch breaks both sides silently.
 *
 * Playwright is loaded by absolute path from the global install, chromium
 * resolved from the shared cache — copied verbatim from
 * scripts/checks/frozen-dom.cjs:30-58. Not a dependency of either repo (NFU8).
 *
 * Run:
 *   export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase500.txt)"
 *   TEAM_BASE_URL=http://127.0.0.1:7787 \
 *     node docs/plan/artifacts/phase500/team-frozen.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
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
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7787";
/** The API the LIVE RUN is discovered from — the same worktree API the web
 *  build proxies to. Node-side, so the discovery is visible in the output
 *  before a browser is even launched. */
const API = process.env.TEAM_API_URL ?? "http://127.0.0.1:7798";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
// Part A default: chat 11dd264b — thread_scan-linked, 20 rows (manager + 11
// workers + 8 sub-agents), all settled. Verified via curl 2026-08-05.
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "Okay this session is very important";
/** Round 704 finding #4: a rerun must not overwrite the committed evidence a
 *  reviewer is reading. README §2 names this script among the ones to re-run,
 *  and it used to write `team-frozen.json` straight back into
 *  `docs/plan/artifacts/phase500/` — so following the documented procedure
 *  dirtied git and destroyed the record. Reruns now land in
 *  `/tmp/phase500-out`; `--write` (or `PHASE500_WRITE=1`) re-records in place. */
const WRITE_IN_PLACE = process.argv.includes("--write") || process.env.PHASE500_WRITE === "1";
const OUT =
  process.env.PHASE500_OUT_DIR ?? (WRITE_IN_PLACE ? __dirname : path.join(os.tmpdir(), "phase500-out"));
if (OUT !== __dirname) fs.mkdirSync(OUT, { recursive: true });
const GAP_MS = Number(process.env.TEAM_FROZEN_GAP_MS ?? "12000"); // U16: t and t+12s
const READY_TIMEOUT_MS = Number(process.env.TEAM_READY_TIMEOUT_MS ?? "20000");
/** The injected rail row's title. Unique enough to click by text, and loud
 *  enough that anyone reading a screenshot knows what they are looking at. */
const LIVE_ROW_TITLE = "ROUND504 LIVE-RUN PROBE (injected rail row)";

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

/* ── DOM contract ────────────────────────────────────────────────────────── */

const SNAPSHOT = () => {
  const rows = Array.from(document.querySelectorAll("[data-team-row]"));
  return rows.map((r) => {
    const workingCell = r.querySelector("[data-working-cell]");
    const tokensCell = r.querySelector("[data-tokens-cell]");
    return {
      nodeId: r.getAttribute("data-node-id"),
      kind: r.getAttribute("data-kind"),
      settled: r.getAttribute("data-settled") === "true",
      status: r.getAttribute("data-status"),
      workingText: workingCell ? workingCell.textContent : null,
      workingFrozen: workingCell ? workingCell.getAttribute("data-frozen") : null,
      tokensText: tokensCell ? tokensCell.textContent : null,
      hasWorkingCell: !!workingCell,
    };
  });
};

/** Polls a serializable predicate run in the page. Throws with the last
 *  observed state on timeout instead of Playwright's generic timeout text —
 *  the point of this harness is to name exactly what is missing. */
async function pollUntil(page, evaluateFn, { timeoutMs, intervalMs = 500, describe }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(evaluateFn);
    if (last && last.ok) return last;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${describe} — last seen: ${JSON.stringify(last)}`,
  );
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
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

async function gotoChatSurface(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error(
      "redirected to /signin — FORGE_SESSION_COOKIE missing or stale (re-mint, see README §2 step C)",
    );
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
}

async function requirePanel(page, what) {
  const present = await page
    .waitForSelector("[data-team-panel]", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!present)
    throw new Error(
      `no [data-team-panel] found in the DOM within 15000ms at ${BASE} (${what}) — ` +
        `the Team panel is not mounted, or the chat row did not match`,
    );
}

/* ── Part A — settled truth, real chat, real rail ─────────────────────────── */

const READY_WITH_SETTLED = () => {
  const panel = document.querySelector("[data-team-panel]");
  if (!panel) return { ok: false, reason: "no [data-team-panel] in the DOM" };
  const state = panel.getAttribute("data-team-state");
  const rows = Array.from(document.querySelectorAll("[data-team-row]"));
  const settled = rows.filter((r) => r.getAttribute("data-settled") === "true");
  return {
    ok: state === "ready" && settled.length >= 3,
    state,
    rowCount: rows.length,
    settledCount: settled.length,
  };
};

async function partSettled(browser) {
  const page = await newPage(browser);
  await gotoChatSurface(page);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
  await requirePanel(page, `chat "${CHAT_TEXT}"`);

  const ready = await pollUntil(page, READY_WITH_SETTLED, {
    timeoutMs: READY_TIMEOUT_MS,
    describe: 'data-team-state="ready" with >=3 settled rows',
  });

  const sample1 = await page.evaluate(SNAPSHOT);
  await page.waitForTimeout(GAP_MS);
  const sample2 = await page.evaluate(SNAPSHOT);
  await page.context().close();

  const byId2 = Object.fromEntries(sample2.map((r) => [r.nodeId, r]));
  const failures = [];
  let checked = 0;
  for (const row of sample1) {
    if (!row.settled) continue;
    checked++;
    const row2 = byId2[row.nodeId];
    if (!row2) {
      failures.push(`settled row ${row.nodeId} present at t but gone at t+${GAP_MS / 1000}s`);
      continue;
    }
    if (!row.hasWorkingCell || !row2.hasWorkingCell) {
      failures.push(`settled row ${row.nodeId} missing [data-working-cell]`);
      continue;
    }
    if (row.workingFrozen !== "true" || row2.workingFrozen !== "true")
      failures.push(
        `settled row ${row.nodeId} working-cell data-frozen was "${row.workingFrozen}" / "${row2.workingFrozen}" — expected "true" in both samples`,
      );
    if (row.workingText !== row2.workingText)
      failures.push(
        `settled row ${row.nodeId} working-cell drifted: "${row.workingText}" → "${row2.workingText}"`,
      );
    if (row.tokensText !== row2.tokensText)
      failures.push(
        `settled row ${row.nodeId} tokens-cell drifted: "${row.tokensText}" → "${row2.tokensText}"`,
      );
  }
  if (checked < 3)
    failures.push(`only ${checked} settled rows sampled — the protocol requires >=3`);

  return {
    part: "A-settled",
    navigation: "real rail row (clicked by text)",
    chat: CHAT_TEXT,
    ready,
    settled_rows_checked: checked,
    running_rows_seen: sample1.filter((r) => !r.settled).length,
    sample1,
    sample2,
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
  };
}

/* ── Part B — live truth, a run that is running right now ─────────────────── */

/** Whatever is running at THIS moment, straight from the fleet endpoint. */
async function discoverLiveRun() {
  const res = await fetch(`${API}/api/agents`);
  if (!res.ok) throw new Error(`GET ${API}/api/agents → HTTP ${res.status}`);
  const body = await res.json();
  const agents = Array.isArray(body.agents) ? body.agents : [];
  const live = agents.filter((a) => a.status === "running" && typeof a.id === "string");
  return live.map((a) => ({ id: a.id, model: a.model ?? null, status: a.status }));
}

const READY_WITH_RUNNING = () => {
  const panel = document.querySelector("[data-team-panel]");
  if (!panel) return { ok: false, reason: "no [data-team-panel] in the DOM" };
  const rows = Array.from(document.querySelectorAll("[data-team-row]"));
  const running = rows.filter((r) => r.getAttribute("data-settled") === "false");
  return {
    ok: running.length >= 1,
    state: panel.getAttribute("data-team-state"),
    rowCount: rows.length,
    runningCount: running.length,
  };
};

async function partLive(browser, liveRunId) {
  const page = await newPage(browser);

  // NAVIGATION ONLY. The rail is conversations; a project worker never appears
  // in it (listRuns drops rows carrying metadata.project_id). One extra row is
  // spliced into the LIST response so the run can be clicked. Nothing else is
  // intercepted — /api/proxy/chat/<id>/team goes straight to the real server.
  await page.route("**/api/proxy/chat*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/api/proxy/chat")) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    const template = body.runs?.[0];
    if (!template) return route.fulfill({ response: res });
    const injected = { ...template, id: liveRunId, title: LIVE_ROW_TITLE, status: "running" };
    // No fake progress badge: the injected row must not claim a project.
    delete injected.project_id;
    delete injected.project_status;
    delete injected.tasks_done;
    delete injected.tasks_total;
    body.runs = [injected, ...body.runs];
    body.count = body.runs.length;
    await route.fulfill({
      response: res,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await gotoChatSurface(page);
  await page.getByText(LIVE_ROW_TITLE, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
  await requirePanel(page, `live run ${liveRunId.slice(0, 8)} (injected rail row)`);

  const ready = await pollUntil(page, READY_WITH_RUNNING, {
    timeoutMs: READY_TIMEOUT_MS,
    describe: ">=1 running row in the team panel",
  });

  const sample1 = await page.evaluate(SNAPSHOT);
  await page.waitForTimeout(GAP_MS);
  const sample2 = await page.evaluate(SNAPSHOT);
  await page.context().close();

  const byId2 = Object.fromEntries(sample2.map((r) => [r.nodeId, r]));
  const failures = [];
  const running1 = sample1.filter((r) => !r.settled);
  const changed = running1.filter((r) => {
    const r2 = byId2[r.nodeId];
    return r2 && r2.workingText !== r.workingText;
  });
  if (running1.length === 0)
    failures.push("no running row rendered for a run the fleet reports as running");
  else {
    for (const r of running1) {
      if (r.workingFrozen !== "false")
        failures.push(
          `running row ${r.nodeId} working-cell data-frozen="${r.workingFrozen}" — expected "false"`,
        );
    }
    if (changed.length === 0)
      failures.push(
        `anti-vacuous-pass guard: ${running1.length} running row(s) present but NONE changed working-cell text across ${GAP_MS / 1000}s — cannot prove the panel actually ticks`,
      );
  }
  // A settled row inside THIS tree must freeze too — same rule, no exceptions.
  for (const row of sample1) {
    if (!row.settled) continue;
    const row2 = byId2[row.nodeId];
    if (row2 && row.workingText !== row2.workingText)
      failures.push(
        `settled row ${row.nodeId} in the live tree drifted: "${row.workingText}" → "${row2.workingText}"`,
      );
  }

  return {
    part: "B-live",
    navigation: "injected-rail-row",
    navigation_note:
      "one row spliced into GET /api/proxy/chat (the rail LIST) so a project " +
      "worker can be clicked; the /team response measured below is the real " +
      "server's, unmodified",
    live_run_id: liveRunId,
    ready,
    running_rows: running1.length,
    running_rows_that_changed: changed.length,
    changes: changed.map((r) => ({
      nodeId: r.nodeId,
      from: r.workingText,
      to: byId2[r.nodeId].workingText,
    })),
    sample1,
    sample2,
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
  };
}

/* ── Driver ──────────────────────────────────────────────────────────────── */

async function main() {
  const liveRuns = await discoverLiveRun();
  console.log(
    `live runs from ${API}/api/agents: ${liveRuns.length ? liveRuns.map((r) => r.id.slice(0, 8)).join(", ") : "(none)"}`,
  );

  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let parts = [];
  let verdict;
  try {
    const a = await partSettled(browser);
    console.log(`part A (settled): ${a.verdict} — ${a.settled_rows_checked} settled rows checked`);
    parts.push(a);

    if (liveRuns.length === 0) {
      verdict = "NO-LIVE-RUN";
      console.log(
        "NO-LIVE-RUN: the fleet reports zero running runs right now, so the anti-vacuous-pass " +
          "guard cannot be exercised. This is NOT a pass — re-run while a run is in flight.",
      );
    } else {
      const b = await partLive(browser, liveRuns[0].id);
      console.log(
        `part B (live): ${b.verdict} — ${b.running_rows_that_changed}/${b.running_rows} running row(s) ticked`,
      );
      parts.push(b);
      verdict = parts.every((p) => p.verdict === "PASS") ? "PASS" : "FAIL";
    }
  } finally {
    await browser.close();
  }

  const result = {
    protocol: "U16 frozen-time truth (14 §Frozen-time truth)",
    base: BASE,
    api: API,
    gap_ms: GAP_MS,
    live_runs_at_start: liveRuns,
    why_two_parts:
      "no single chat in this database owns both a settled tree and a live " +
      "row: the rail's chats link only to finished/paused projects, and the " +
      "projects that own today's live runs have no chat linkage at all",
    parts,
    verdict,
  };
  const out = path.join(OUT, "team-frozen.json");
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const p of parts) p.failures.forEach((f) => console.log(`  FAIL [${p.part}]: ${f}`));
  console.log(`→ ${out}`);
  if (OUT !== __dirname) {
    console.log(`  committed evidence left untouched (${path.join(__dirname, "team-frozen.json")})`);
    console.log(`  re-record in place with:  node ${process.argv[1]} --write`);
  }
  console.log(`TEAM-FROZEN: ${verdict}`);
  if (verdict !== "PASS") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
