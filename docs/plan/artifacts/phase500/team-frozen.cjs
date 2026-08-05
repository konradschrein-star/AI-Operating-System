/**
 * team-frozen.cjs — U16, protocol 14 §"Frozen-time truth".
 *
 * Samples the Team panel DOM at t and t+12s with >=3 settled rows present.
 * PASS iff:
 *   1. every settled row's [data-working-cell] and [data-tokens-cell]
 *      textContent is byte-identical across the two samples, AND
 *   2. every settled row's [data-working-cell] carries data-frozen="true"
 *      in BOTH samples, AND
 *   3. at least one RUNNING row's working cell DID change (anti-vacuous-pass
 *      guard: three static samples of a panel that renders nothing at all
 *      would trivially "pass" #1 and #2 for the wrong reason).
 *
 * If no running row is on screen, #3 cannot be exercised — the script reports
 * SKIPPED-NO-RUNNING, a third verdict distinct from PASS/FAIL, rather than
 * pretending the guard ran.
 *
 * Selectors are the DOM contract shared with the panel builder (round 502) —
 * do not "improve" them here; a mismatch breaks both sides silently.
 *
 * Playwright is loaded by absolute path from the global install, chromium
 * resolved from the shared cache — copied verbatim from
 * scripts/checks/frozen-dom.cjs:30-58. Not a dependency of either repo (NFU8).
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     TEAM_CHAT_TEXT="Okay this session is very important" \
 *     node docs/plan/artifacts/phase500/team-frozen.cjs
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

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7789";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
// Default: chat 11dd264b — linked, 11 workers, verified via curl 2026-08-05.
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "Okay this session is very important";
const OUT = __dirname;
const GAP_MS = 12_000; // U16: sample at t and t+12s
const READY_TIMEOUT_MS = Number(process.env.TEAM_READY_TIMEOUT_MS ?? "20000");

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale (re-mint, 60min)");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
}

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
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe} — last seen: ${JSON.stringify(last)}`);
}

const CHECK_READY_WITH_SETTLED = () => {
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

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
}

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
  await openChat(page);

  // Anti-stack-trace guard: waitForSelector's own timeout message is generic;
  // this makes the "panel does not exist yet" case unmistakable.
  const panelPresent = await page
    .waitForSelector("[data-team-panel]", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!panelPresent)
    throw new Error(
      `no [data-team-panel] found in the DOM within 15000ms at ${BASE} (chat "${CHAT_TEXT}") — ` +
        `the Team panel does not exist yet, or the chat text did not match a rail row`,
    );

  const readyState = await pollUntil(page, CHECK_READY_WITH_SETTLED, {
    timeoutMs: READY_TIMEOUT_MS,
    describe: 'data-team-state="ready" with >=3 settled rows',
  });
  console.log(`ready: ${JSON.stringify(readyState)}`);

  const sample1 = await page.evaluate(SNAPSHOT);
  await page.waitForTimeout(GAP_MS);
  const sample2 = await page.evaluate(SNAPSHOT);

  const byId1 = Object.fromEntries(sample1.map((r) => [r.nodeId, r]));
  const byId2 = Object.fromEntries(sample2.map((r) => [r.nodeId, r]));

  const failures = [];
  let settledChecked = 0;
  for (const row of sample1) {
    if (!row.settled) continue;
    settledChecked++;
    const row2 = byId2[row.nodeId];
    if (!row2) {
      failures.push(`settled row ${row.nodeId} present at t but gone at t+${GAP_MS / 1000}s`);
      continue;
    }
    if (!row.hasWorkingCell || !row2.hasWorkingCell) {
      failures.push(`settled row ${row.nodeId} missing [data-working-cell]`);
      continue;
    }
    if (row.workingFrozen !== "true" || row2.workingFrozen !== "true") {
      failures.push(
        `settled row ${row.nodeId} working-cell data-frozen was "${row.workingFrozen}" / "${row2.workingFrozen}" — expected "true" in both samples`,
      );
    }
    if (row.workingText !== row2.workingText) {
      failures.push(
        `settled row ${row.nodeId} working-cell drifted: "${row.workingText}" → "${row2.workingText}"`,
      );
    }
    if (row.tokensText !== row2.tokensText) {
      failures.push(
        `settled row ${row.nodeId} tokens-cell drifted: "${row.tokensText}" → "${row2.tokensText}"`,
      );
    }
  }

  const runningRows = sample1.filter((r) => !r.settled);
  let verdict;
  if (runningRows.length === 0) {
    verdict = "SKIPPED-NO-RUNNING";
    console.log(
      "SKIPPED-NO-RUNNING: no running row present in this fixture — the anti-vacuous-pass guard cannot be exercised. Pick a fixture chat with an in-flight run and re-run.",
    );
  } else {
    const anyChanged = runningRows.some((r) => {
      const r2 = byId2[r.nodeId];
      return r2 && r2.workingText !== r.workingText;
    });
    if (!anyChanged) {
      failures.push(
        `anti-vacuous-pass guard: ${runningRows.length} running row(s) present but NONE changed working-cell text across ${GAP_MS / 1000}s — cannot prove the panel actually ticks`,
      );
    }
    verdict = failures.length ? "FAIL" : "PASS";
  }
  if (verdict !== "SKIPPED-NO-RUNNING" && failures.length) verdict = "FAIL";

  const result = {
    base: BASE,
    chat: CHAT_TEXT,
    gap_ms: GAP_MS,
    settled_rows_checked: settledChecked,
    running_rows: runningRows.length,
    sample1,
    sample2,
    failures,
    verdict,
  };
  const out = path.join(OUT, "team-frozen.json");
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`→ ${out}`);
  failures.forEach((f) => console.log(`  FAIL: ${f}`));
  console.log(`TEAM-FROZEN: ${verdict}`);

  if (verdict === "FAIL") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
