/**
 * lib-604.cjs — the pieces every round-604 protocol shares.
 *
 * Phase 500's scripts each carried their own copy of the browser setup. Six
 * scripts is where that stops paying: the cookie handling, the chat opening and
 * the team-row injection all have to behave IDENTICALLY across protocols or a
 * reviewer cannot compare their JSON. One module, required by siblings in the
 * same directory, so every script is still runnable on its own with `node`.
 *
 * WHAT IS AND IS NOT REAL — read this before reading any verdict.
 *
 * `injectTeamRow` rewrites ONE response: `GET /api/proxy/chat/:id/team`, adding
 * a worker node so a run that no chat's team contains becomes clickable. It
 * exists because of a fact about this database, not because of a defect:
 *
 *   - the team panel's rows are the chat's own run plus every run carrying
 *     `metadata.project_id = <the chat's project>`;
 *   - a chat only HAS a project when `projects.metadata.origin_chat_id` names
 *     it, or the bounded thread scan recovers one;
 *   - the two projects with runs alive today (`8ea0cc08…`, `4120f785…`) carry
 *     neither, and the biggest thread reachable through a real chat's team is
 *     170 entries.
 *
 * So a LIVE worker (orientation-live) and a >=200-entry session (digest-honesty)
 * are not reachable by clicking. Round 504 hit the same wall and answered it the
 * same way (`phase500/README.md` §3.1, "injected-rail-row"); the alternative is
 * writing `origin_chat_id` into the production `projects` table from a build
 * task, which phase 400 round 403 already declined to do.
 *
 * The node injected is built FROM `GET /api/agents` — real id, real status, real
 * role, real model, real description — and its `task` is `null`, because this
 * chat's project did not give it one and inventing a task is exactly the class
 * of lie the phase exists to remove. Every value any protocol then ASSERTS on is
 * fetched fresh from the un-intercepted `/api/chat/:runId`. Each JSON verdict
 * that used injection says so in its `navigation` field.
 *
 * NFU8: playwright is loaded by ABSOLUTE PATH from /opt/hermes-workspace and is
 * not a dependency of either repo. `resolveChromium` is copied verbatim from
 * scripts/checks/frozen-dom.cjs:30-58.
 */

const fs = require("node:fs");
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
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

/** The isolated Next build of THIS worktree. Never :7700, never pm2. */
const BASE = process.env.PHASE600_BASE_URL ?? "http://127.0.0.1:7786";
/** The worktree API harness (scripts/checks/serve-v3-7798.ts). Never :7700. */
const API = process.env.PHASE600_API_URL ?? "http://127.0.0.1:7798";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";

/** 11dd264b — the only chat in this database whose team reaches depth 2 through
 *  a WORKER (58096061, architect, one scout). 20 rows: manager + 11 workers +
 *  8 sub-agents. Round 601B and phase 500 both used it, for the same reason. */
const CHAT_TEXT = process.env.PHASE600_CHAT ?? "Okay this session is very important";

const OUT_DIR = __dirname;

/* ── A tiny assertion harness, shared so every JSON has the same shape ────── */

function makeChecker() {
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
  return { results, check, note, failed: () => failures };
}

/* ── The harness API, straight from node (no browser, no proxy) ───────────── */

async function api(pathname) {
  const r = await fetch(`${API}${pathname}`);
  if (!r.ok) throw new Error(`GET ${API}${pathname} → ${r.status} ${r.statusText}`);
  return r.json();
}

/** `GET /api/chat/:id` unwrapped — the same value `fetchChat` hands the app. */
async function apiRun(runId) {
  const body = await api(`/api/chat/${runId}`);
  if (!body || typeof body !== "object" || body.run === undefined)
    throw new Error(`GET /api/chat/${runId} did not return { run } — got keys ${Object.keys(body ?? {})}`);
  return body.run;
}

/** Resolve the fixture chat's uuid from its title prefix, at run time. */
async function resolveChatId(titleFragment) {
  const list = await api("/api/chat?limit=50");
  const hit = (list.runs ?? []).find((r) => (r.title ?? "").includes(titleFragment));
  if (!hit) throw new Error(`no chat whose title contains ${JSON.stringify(titleFragment)}`);
  return hit.id;
}

/* ── Browser ──────────────────────────────────────────────────────────────── */

async function withBrowser(fn) {
  if (!COOKIE)
    throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (README.md §2 step C)");
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
    return await fn(ctx, browser);
  } finally {
    /* phase 500 round 501b's bug: close only on the success path hangs the
     * process forever when an assertion throws. Always in a finally.
     *
     * `unrouteAll` first, and it is not optional: a `ctx.route` handler that is
     * mid-`route.fetch()` when the browser goes away rejects with
     * TargetClosedError from OUTSIDE any await this file owns, which kills the
     * process before `finish()` can write its verdict — a green run reported as
     * a crash. Seen once, hence this line. */
    if (context !== null) await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await browser.close();
  }
}

/**
 * Splice one worker node into the fixture chat's team response.
 *
 * `agentRow` is a row of `GET /api/agents`, verbatim. Nothing is invented: the
 * fields below are copied, `task` is null, and `working_ms` comes from the row's
 * own `elapsed_ms` (the API's measurement, not a clock read here).
 */
async function injectTeamRow(ctx, agentRow) {
  /* Tokens come from the row's own `usage_total`, mapped into the panel's
   * `TeamTokens` names — the same arithmetic routes/chat.ts does. Zeros here
   * would be a small invented number on a row whose point is that its numbers
   * are real. */
  const u = agentRow.usage_total ?? {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const tokens = {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cache_read: n(u.cache_read_input_tokens),
    cache_creation: n(u.cache_creation_input_tokens),
    total:
      n(u.input_tokens) +
      n(u.output_tokens) +
      n(u.cache_read_input_tokens) +
      n(u.cache_creation_input_tokens),
  };
  const node = {
    id: agentRow.id,
    kind: "worker",
    role: agentRow.role ?? null,
    model: agentRow.model ?? null,
    status: agentRow.status,
    tokens,
    working_ms: typeof agentRow.elapsed_ms === "number" ? agentRow.elapsed_ms : null,
    working_ms_source: null,
    started_at: agentRow.started_at ?? null,
    settled: agentRow.settled === true,
    description: agentRow.title ?? null,
    parent_id: null,
    subagents: [],
    task: null,
  };
  await ctx.route("**/api/proxy/chat/*/team", async (route) => {
    const response = await route.fetch();
    let body;
    try {
      body = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    if (!Array.isArray(body?.workers)) return route.fulfill({ response });
    body.workers = [node, ...body.workers];
    return route.fulfill({ response, body: JSON.stringify(body) });
  });
  return node;
}

/** Open /desktop, switch to CHAT, click the fixture chat, wait for the tree. */
async function openChat(page, chatText = CHAT_TEXT) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(chatText, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page
    .waitForFunction(
      () =>
        document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 25_000 },
    )
    .catch(async () => {
      const state = await page.evaluate(
        () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? "<gone>",
      );
      throw new Error(`[data-team-panel] never reached data-team-state="ready" (got "${state}")`);
    });
  await page.waitForTimeout(1_500);
}

/** The facts that must not move when you drill in, plus the drilled identity. */
async function surfaceState(page) {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent ?? null;
    const rows = Array.from(document.querySelectorAll("[data-team-row]")).map((r) => ({
      id: r.getAttribute("data-node-id"),
      kind: r.getAttribute("data-kind"),
      depth: r.getAttribute("data-depth"),
    }));
    const drill = document.querySelector("[data-agent-chat-view]");
    return {
      teamRows: rows,
      teamState:
        document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? null,
      drilledRunId: drill?.getAttribute("data-run-id") ?? null,
      drilledSubagentId: drill?.getAttribute("data-subagent-id") || null,
      depth: drill ? Number(drill.getAttribute("data-depth")) : 0,
      crumbs: text("[data-nav-crumbs]"),
      kind: text("[data-orientation-kind]"),
      role: text("[data-agent-role]"),
      model: text("[data-agent-model]"),
      backLabel: document.querySelector("[data-nav-back]")?.textContent?.trim() ?? null,
      strip: document.querySelector("[data-orientation-strip]") !== null,
      degraded:
        document.querySelector("[data-orientation-strip]")?.getAttribute("data-orientation-degraded") ??
        null,
    };
  });
}

/** Write the verdict beside the script and exit with the right code. */
function finish(fileName, payload, failures) {
  const out = path.join(OUT_DIR, fileName);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} → ${out}`);
  process.exit(failures === 0 ? 0 : 1);
}

module.exports = {
  API,
  BASE,
  CHAT_TEXT,
  COOKIE,
  OUT_DIR,
  api,
  apiRun,
  finish,
  injectTeamRow,
  makeChecker,
  openChat,
  resolveChatId,
  resolveChromium,
  surfaceState,
  withBrowser,
};
