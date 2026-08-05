/**
 * kind-dom.cjs — the phase-2b visual + lineage check (R8–R11).
 *
 * Three things a reviewer must be able to reproduce, in one run:
 *   1. dark + light screenshots of the Live panel on REAL data;
 *   2. a row-by-row inventory printed to stdout — badge, detail, model,
 *      title, duration — which is the stranger test in text form;
 *   3. the native `title` (lineage) of one worker row and one sub-agent row,
 *      dumped verbatim, since R10's whole implementation IS that attribute.
 *
 * Three passes, because one view cannot show everything that exists:
 *
 *   live-global-{dark,light}.png — REAL, unscoped `/api/agents`. What the
 *     LIVE destination renders today. Two projects are churning, so the
 *     24h × LIMIT-60 feed is 60/60 workers and the panel's RECENT slice
 *     (12 rows) never reaches a run that carries sub-agents.
 *   live-{dark,light}.png — REAL, scoped to one project by rewriting the
 *     request to `?project_id=…`, which is exactly what ChatSurface's Live
 *     tab does natively (AgentActivity takes a `projectId` prop). Eight real
 *     rows: architect, planner, builder, reviewer, and two real done
 *     sub-agents under the architect run. Still live server data — only the
 *     scope changed.
 *   kinds-fixture-{dark,light}.png — SYNTHETIC. No cron and no unclassified
 *     run exists in the current window (72 workers + 5 operator chats in 24h,
 *     the operators ranked out of the LIMIT), so a fulfilled fixture payload
 *     is the only way to show those two badges. Labelled synthetic here and
 *     in the artifacts README; the other four files are real.
 *
 * It lives under docs/plan/artifacts/ rather than scripts/checks/ because the
 * phase-2b task scopes this builder to the two panel modules, an append-only
 * check-classify.ts, and this artifacts directory.
 *
 * Playwright is loaded by absolute path from an existing global install —
 * it must not become a dependency of either repo (NF4). Same chromium
 * resolution as scripts/checks/frozen-dom.cjs, for the same reason.
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     node docs/plan/artifacts/phase2/kind-dom.cjs
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
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const BASE = process.env.KIND_DOM_URL ?? "http://127.0.0.1:7799";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT_DIR = __dirname;
/** operator-visibility — this project. Its architect run carries two real
 *  done Explore sub-agents (the ground truth REPRODUCE.md pins). */
const SCOPE_PROJECT = process.env.KIND_DOM_PROJECT ?? "8ea0cc08-28d9-4301-9f28-c98e1c5d6838";

/** Runs in the page. One entry per row (top-level AND sub-agent), read the
 *  way a stranger reads it: left to right, then the hover text. */
const INVENTORY = () => {
  const rows = Array.from(document.querySelectorAll("div[data-agent-kind]"));
  return rows.map((row) => {
    const line1 = row.firstElementChild;
    const line2 = line1 ? line1.nextElementSibling : null;
    const cells = (el) =>
      el ? Array.from(el.children).map((c) => c.textContent.trim()).filter(Boolean) : [];
    const duration = row.querySelector(
      'span[title="total run time"], span[title="total subagent run time"], span[title="running for this long"]',
    );
    return {
      kind: row.getAttribute("data-agent-kind"),
      line1: cells(line1),
      line2: cells(line2),
      durationTitle: duration ? duration.getAttribute("title") : null,
      lineage: row.getAttribute("title"),
    };
  });
};

/** Four synthetic rows, one per kind, plus a sub-agent under the worker.
 *  Shapes copied from a real /api/agents response. */
function fixturePayload(now) {
  const usage = {
    input_tokens: 1200,
    output_tokens: 400,
    cache_read_input_tokens: 88_000,
    cache_creation_input_tokens: 0,
  };
  const base = {
    kind: "run",
    effort: "high",
    engine: "claude-code",
    last_heartbeat_at: now,
    settled: false,
    settled_at: null,
    usage_total: usage,
    current_activity: null,
    parent_run_id: null,
    subagents: [],
  };
  return {
    now,
    summary: {
      running: 2,
      queued: 0,
      stuck: 0,
      paused: 0,
      active_subagents: 1,
      spent_usd_last_hour: 12.5,
      tokens_in_last_hour: 0,
      tokens_out_last_hour: 0,
    },
    agents: [
      {
        ...base,
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        title: "Chat: rework the live panel",
        status: "running",
        worker: "forge-executor",
        model: "claude-fable-5",
        started_at: new Date(Date.parse(now) - 2_212_000).toISOString(),
        elapsed_ms: 2_212_000,
        spent_usd: 4.1,
        agent_kind: "operator",
        role: null,
        project_id: null,
        cron_name: null,
      },
      {
        ...base,
        id: "bbbbbbbb-1111-2222-3333-444444444444",
        title: "operator-visibility · Phase 2b — Live panel: kind badge",
        status: "running",
        worker: "project:builder",
        model: "claude-opus-5",
        started_at: new Date(Date.parse(now) - 252_000).toISOString(),
        elapsed_ms: 252_000,
        spent_usd: 1.02,
        agent_kind: "worker",
        role: "builder",
        project_id: "8ea0cc08-28d9-4301-9f28-c98e1c5d6838",
        cron_name: null,
        subagents: [
          {
            kind: "subagent",
            tool_use_id: "toolu_fixture_1",
            role: "Explore",
            model: "claude-opus-5",
            started_at: new Date(Date.parse(now) - 107_000).toISOString(),
            updated_at: new Date(Date.parse(now) - 1_000).toISOString(),
            ended_at: null,
            description: "Recon chat Bash block rendering",
            usage,
            event_count: 42,
            latest_activity: { kind: "tool_call", tool: "Grep", text: null, ts: now },
            status: "running",
          },
        ],
      },
      {
        ...base,
        id: "cccccccc-1111-2222-3333-444444444444",
        title: "weekly review digest",
        status: "completed",
        worker: "forge-executor",
        model: "claude-haiku-4-5-20251001",
        started_at: new Date(Date.parse(now) - 12_000).toISOString(),
        elapsed_ms: 12_000,
        settled: true,
        settled_at: now,
        spent_usd: 0.03,
        agent_kind: "cron",
        role: null,
        project_id: null,
        cron_name: "weekly-review",
      },
      {
        ...base,
        id: "dddddddd-1111-2222-3333-444444444444",
        title: "legacy run without engine metadata",
        status: "completed",
        worker: "skylab-producer",
        model: "haiku",
        started_at: new Date(Date.parse(now) - 430_000).toISOString(),
        elapsed_ms: 430_000,
        settled: true,
        settled_at: now,
        spent_usd: 0,
        agent_kind: "unknown",
        role: null,
        project_id: null,
        cron_name: null,
      },
    ],
  };
}

function printInventory(title, rows) {
  console.log(`\n── ${title} ─────────────────────────────────────────`);
  for (const r of rows) {
    console.log(`\n  [${r.kind}]  ${r.line1.join("   ")}`);
    if (r.line2.length) console.log(`            ${r.line2.join("   ")}`);
    console.log(`            duration title: ${JSON.stringify(r.durationTitle)}`);
    console.log(`            lineage: ${r.lineage}`);
  }
}

(async () => {
  const executablePath = resolveChromium();
  console.log(`chromium: ${executablePath}\n`);
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (COOKIE) {
    await context.addCookies([
      {
        name: "authjs.session-token",
        value: COOKIE,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("  [page error]", e.message));

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) {
    console.error("FAIL: redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
    await browser.close();
    process.exit(1);
  }
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector("div[data-agent-kind]", { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  /** Scroll a done sub-agent line into frame so the artifact shows what it
   *  claims to; the panel is a short scroller. */
  const scrollToSubagent = async () => {
    const ok = await page.evaluate(() => {
      const cell = document.querySelector('span[title="total subagent run time"]');
      if (!cell) return false;
      cell.scrollIntoView({ block: "center" });
      return true;
    });
    console.log(
      ok ? "scrolled a done sub-agent line into frame" : "NOTE: no done sub-agent line on screen",
    );
    await page.waitForTimeout(400);
  };

  const shoot = async (prefix) => {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(600);
      const file = path.join(OUT_DIR, `${prefix}-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`screenshot: ${file}`);
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
  };

  // ── Pass 1: real data, unscoped ────────────────────────────────────────
  await scrollToSubagent();
  const global = await page.evaluate(INVENTORY);
  printInventory(`REAL DATA, UNSCOPED — ${global.length} rows on screen`, global.slice(0, 6));
  console.log(`  … ${Math.max(0, global.length - 6)} further rows omitted from this listing`);
  await shoot("live-global");

  // ── Pass 2: real data, scoped to one project ───────────────────────────
  // The URL is rewritten, the response is not: this is the live server
  // answering the same question ChatSurface's Live tab asks.
  await page.route("**/api/proxy/agents*", async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("project_id", SCOPE_PROJECT);
    await route.continue({ url: url.toString() });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector('div[data-agent-kind="subagent"]', { timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await scrollToSubagent();

  const live = await page.evaluate(INVENTORY);
  printInventory(`REAL DATA, project ${SCOPE_PROJECT.slice(0, 8)} — ${live.length} rows`, live);

  // Phase-1 regression, re-proved here because scripts/checks/frozen-dom.cjs
  // samples the UNSCOPED panel, whose 12-row RECENT slice currently holds no
  // run that carries sub-agents — so its "no done sub-agent on screen" guard
  // fires and it fails vacuously rather than pass vacuously (by design; see
  // REPRODUCE.md). The scoped view has two real done sub-agents, so R5 is
  // testable here: their durations must not move across 3 poll cycles.
  console.log("\n── R5 re-check on the scoped panel (3 samples / 12s) ────────");
  const durations = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) await page.waitForTimeout(6_000);
    durations.push(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('span[title="total subagent run time"]')).map((s) =>
          s.textContent.trim(),
        ),
      ),
    );
  }
  if (!durations[0].length) {
    console.error("FAIL: no done sub-agent duration cell on the scoped panel either");
    process.exitCode = 1;
  }
  durations[0].forEach((_, i) => {
    const series = durations.map((d) => d[i] ?? "<gone>");
    const frozen = series.every((t) => t === series[0]);
    if (!frozen) process.exitCode = 1;
    console.log(`  ${frozen ? "PASS" : "FAIL"}  done sub-agent ${i}: ${series.join("  |  ")}`);
  });

  const worker = live.find((r) => r.kind === "worker");
  const sub = live.find((r) => r.kind === "subagent");
  console.log("\n── R10 title dump (real rows) ───────────────────────────────");
  console.log(`worker row   title = ${JSON.stringify(worker ? worker.lineage : null)}`);
  console.log(`sub-agent    title = ${JSON.stringify(sub ? sub.lineage : null)}`);
  if (!worker || !sub) {
    console.error("FAIL: needed one worker row AND one sub-agent row for the title dump");
    process.exitCode = 1;
  }
  await shoot("live");

  // ── Pass 3: fixture, all four kinds ────────────────────────────────────
  await page.unroute("**/api/proxy/agents*");
  await page.route("**/api/proxy/agents*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixturePayload(new Date().toISOString())),
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector('div[data-agent-kind="cron"]', { timeout: 30_000 });
  await page.waitForTimeout(1_000);

  const fixture = await page.evaluate(INVENTORY);
  printInventory("FIXTURE — one row per kind (SYNTHETIC)", fixture);

  const kinds = new Set(fixture.map((r) => r.kind));
  for (const k of ["operator", "worker", "cron", "unknown", "subagent"]) {
    console.log(`  ${kinds.has(k) ? "PASS" : "FAIL"}  ${k} row rendered`);
    if (!kinds.has(k)) process.exitCode = 1;
  }

  await shoot("kinds-fixture");

  await browser.close();
  console.log(process.exitCode ? "\nkind-dom: FAIL" : "\nkind-dom: PASS");
})().catch((err) => {
  console.error("kind-dom threw:", err);
  process.exit(1);
});
