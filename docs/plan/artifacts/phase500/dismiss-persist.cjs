/**
 * dismiss-persist.cjs — dismissal persistence across a reload, and the restore
 * affordance (14 §500: "dismissal persistence across reloads").
 *
 * Five assertions, in order, all against a REAL chat and its real settled tree
 * (no interception of any kind in this script — the rail row is clicked the
 * way a person clicks it):
 *
 *   1. a settled row's X dismisses it in ONE click (team/confirm.ts rule 1:
 *      dismissal is reversible, so no confirm step) and issues NO request;
 *   2. the row disappears and the panel grows an "N hidden · show" affordance
 *      ([data-team-restore]) carrying the right count;
 *   3. after a FULL PAGE RELOAD the row is still hidden — the point of the
 *      protocol, and the one thing a purely in-memory implementation would
 *      fail;
 *   4. clicking [data-team-restore] brings it back, with the same node id it
 *      had before (nothing was destroyed, only hidden);
 *   5. the affordance disappears once nothing is hidden.
 *
 * localStorage key `forge.teamDismissed` is cleared at the start so a previous
 * run cannot make this one pass, and cleared again at the end so this script
 * leaves the browser profile as it found it. It writes to a throwaway
 * Playwright context; nothing on the server and nothing in Konrad's browser is
 * touched.
 *
 * Run:
 *   export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase500.txt)"
 *   TEAM_BASE_URL=http://127.0.0.1:7787 \
 *     node docs/plan/artifacts/phase500/dismiss-persist.cjs
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

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7787";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
// 11dd264b — 20 settled rows (manager + 11 workers + 8 sub-agents).
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "Okay this session is very important";
const STORAGE_KEY = "forge.teamDismissed";
/** Marks that this context already did its one-time clear (see run()). */
const CLEAR_GUARD_KEY = "forge.round504.dismissCleared";
const OUT = __dirname;

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

const ROW_IDS = () =>
  Array.from(document.querySelectorAll("[data-team-scroll] [data-team-row]")).map((r) =>
    r.getAttribute("data-node-id"),
  );

async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
  await page
    .waitForFunction(
      () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 20_000 },
    )
    .catch(async () => {
      const state = await page
        .evaluate(() => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state"))
        .catch(() => undefined);
      throw new Error(
        `[data-team-panel] never reached data-team-state="ready" (got "${state}") for chat "${CHAT_TEXT}"`,
      );
    });
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let result;
  try {
    result = await run(browser);
  } finally {
    await browser.close();
  }

  const out = path.join(OUT, "dismiss-persist.json");
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const s of result.steps) console.log(`  ${s.step.padEnd(22)} ${s.ok ? "ok" : "FAIL"} — ${s.detail}`);
  result.failures.forEach((f) => console.log(`  FAIL: ${f}`));
  console.log(`→ ${out}`);
  console.log(`DISMISS-PERSIST: ${result.verdict}`);
  if (result.verdict !== "PASS") process.exitCode = 1;
}

async function run(browser) {
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
  /* A previous run must not be able to make this one pass — but the clear has
   * to happen EXACTLY ONCE, on the first navigation. An init script runs on
   * every navigation including the reload this protocol depends on, and a
   * `window`-scoped guard is reset by that reload (round 504 wrote it that way
   * first and watched the reload wipe the very dismissal it was there to
   * check). The guard therefore lives in localStorage, which is the thing that
   * survives — and both keys are removed at the end. */
  await ctx.addInitScript(
    ([key, guard]) => {
      if (window.localStorage.getItem(guard) !== "1") {
        window.localStorage.removeItem(key);
        window.localStorage.setItem(guard, "1");
      }
    },
    [STORAGE_KEY, CLEAR_GUARD_KEY],
  );

  const page = await ctx.newPage();
  const requests = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/proxy/")) requests.push({ method: r.method(), url: r.url().split("/api/proxy")[1] });
  });

  const steps = [];
  const failures = [];
  const note = (step, ok, detail, extra = {}) => {
    steps.push({ step, ok, detail, ...extra });
    if (!ok) failures.push(`${step}: ${detail}`);
  };

  await openChat(page);

  const before = await page.evaluate(ROW_IDS);
  if (before.length < 3) throw new Error(`only ${before.length} rows in "${CHAT_TEXT}" — need >=3`);

  // Target a SETTLED row that is NOT the manager: the manager row is the chat
  // itself, and hiding it would be a different (and stranger) assertion.
  const targetId = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("[data-team-scroll] [data-team-row][data-settled='true']"),
    );
    const row = rows[1] ?? rows[0];
    return row ? row.getAttribute("data-node-id") : null;
  });
  if (!targetId) throw new Error("no settled row to dismiss");

  // ── 1. one click dismisses, and costs nothing on the wire ────────────────
  const reqBefore = requests.length;
  const xSel = `[data-team-row][data-node-id="${targetId}"] [data-team-x]`;
  const xState = await page.evaluate((s) => {
    const b = document.querySelector(s);
    return b ? { disabled: b.disabled, confirm: b.getAttribute("data-confirm"), title: b.title } : null;
  }, xSel);
  if (!xState) throw new Error(`no ${xSel}`);
  note(
    "settled-x-enabled",
    xState.disabled === false,
    `settled row's X disabled=${xState.disabled} (a dismissal is reversible, so it is never capability-gated)`,
    { x_state: xState },
  );

  await page.locator(xSel).click();
  await page.waitForTimeout(1_500);

  const afterDismiss = await page.evaluate(ROW_IDS);
  note(
    "dismissed-in-one-click",
    !afterDismiss.includes(targetId) && afterDismiss.length === before.length - 1,
    `rows ${before.length} → ${afterDismiss.length}, target ${targetId.slice(0, 12)} ${afterDismiss.includes(targetId) ? "STILL PRESENT" : "gone"}`,
  );

  const dismissRequests = requests.slice(reqBefore).filter((r) => r.method !== "GET");
  note(
    "dismiss-issues-no-write",
    dismissRequests.length === 0,
    `${dismissRequests.length} non-GET request(s) during the dismissal — a dismissal is local (round 1600 makes it server-backed)`,
    { non_get: dismissRequests },
  );

  // ── 2. the restore affordance appears, with the right count ──────────────
  const restore1 = await page.evaluate(() => {
    const b = document.querySelector("[data-team-restore]");
    return b ? b.textContent : null;
  });
  note("restore-affordance-shown", restore1 === "1 hidden · show", `[data-team-restore] reads ${JSON.stringify(restore1)}`);

  const stored = await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY);
  note(
    "persisted-to-storage",
    typeof stored === "string" && stored.includes(targetId),
    `localStorage["${STORAGE_KEY}"] = ${stored}`,
  );

  // ── 3. survive a full reload ─────────────────────────────────────────────
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(4_000);
  await page
    .waitForFunction(
      () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 20_000 },
    )
    .catch(() => {
      throw new Error("panel did not return to ready after the reload");
    });

  const afterReload = await page.evaluate(ROW_IDS);
  note(
    "hidden-after-reload",
    !afterReload.includes(targetId),
    `after reload: ${afterReload.length} rows, target ${afterReload.includes(targetId) ? "CAME BACK" : "still hidden"}`,
  );
  const restore2 = await page.evaluate(() => {
    const b = document.querySelector("[data-team-restore]");
    return b ? b.textContent : null;
  });
  note("restore-affordance-after-reload", restore2 === "1 hidden · show", `[data-team-restore] reads ${JSON.stringify(restore2)}`);

  // ── 4. restore brings it back, same id ───────────────────────────────────
  // Guarded: if step 3 already failed there is nothing to click, and a
  // 30s Playwright timeout would bury the real finding under a stack trace.
  const restorePresent = (await page.locator("[data-team-restore]").count()) > 0;
  if (restorePresent) {
    await page.locator("[data-team-restore]").click();
    await page.waitForTimeout(1_500);
  } else {
    note("restore-clickable", false, "[data-team-restore] is not in the DOM after the reload — cannot exercise restore");
  }
  const afterRestore = await page.evaluate(ROW_IDS);
  note(
    "restored",
    afterRestore.includes(targetId) && afterRestore.length === before.length,
    `rows ${afterReload.length} → ${afterRestore.length}, target ${afterRestore.includes(targetId) ? "back" : "STILL MISSING"}`,
  );

  // ── 5. and the affordance goes away ──────────────────────────────────────
  const restore3 = await page.evaluate(() => document.querySelector("[data-team-restore]") !== null);
  note("affordance-gone-when-empty", restore3 === false, `[data-team-restore] present=${restore3}`);

  // Leave the profile as we found it.
  await page.evaluate(
    ([k, g]) => {
      window.localStorage.removeItem(k);
      window.localStorage.removeItem(g);
    },
    [STORAGE_KEY, CLEAR_GUARD_KEY],
  );
  await ctx.close();

  return {
    protocol: "14 §500 — dismissal persistence across reloads + restore",
    base: BASE,
    chat: CHAT_TEXT,
    storage_key: STORAGE_KEY,
    interception: "none — every response in this run is the real server's",
    target_node_id: targetId,
    rows_before: before.length,
    rows_after_dismiss: afterDismiss.length,
    rows_after_reload: afterReload.length,
    rows_after_restore: afterRestore.length,
    steps,
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
  };
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
