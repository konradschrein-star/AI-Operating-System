/**
 * control-inert.cjs — the destructive-control inertness proof (14 §500
 * "RED-TEAM (destructive controls)"). Round 505's red team re-runs THIS file.
 *
 * The claim under attack: with `GET /api/capabilities` answering all-false,
 * `[data-team-stop]` and `[data-team-x]` on a RUNNING row are visibly disabled
 * AND incapable of issuing a request — including after a reviewer strips the
 * `disabled` attribute in devtools, and including under a rapid double-click
 * aimed at the confirm step.
 *
 * Capabilities are REAL here. Nothing is intercepted, nothing is faked; the
 * only client-side rewrite is the rail-row injection that lets the panel be
 * pointed at a run which is running right now (the rail lists conversations,
 * and a project worker is excluded from it by design — see team-frozen.cjs's
 * header for the full argument). The `/team` response, the capabilities
 * response and every number on screen are the server's own.
 *
 * ── Six attacks ──────────────────────────────────────────────────────────
 *   1. baseline        — a control window with NO clicking, to establish what
 *                        the panel's own polls cost. Every later window is
 *                        judged against the same classifier, not against zero,
 *                        because "zero requests" is not a thing a polling
 *                        panel can do; "zero requests THAT ARE NOT the poll"
 *                        is, and it is the honest gate.
 *   2. stop-click      — click [data-team-stop] (force: it is disabled)
 *   3. x-click         — click [data-team-x] (force)
 *   4. stop-stripped   — removeAttribute("disabled"), then click
 *   5. x-stripped      — removeAttribute("disabled"), then click, then a
 *                        SECOND click 40ms later (the confirm-bypass attempt:
 *                        under MIN_CONFIRM_MS the machine must refuse)
 *   6. x-raw-dom       — element.click() dispatched from page script, bypassing
 *                        Playwright's actionability entirely
 *
 * GATE (all six): zero requests whose method is not GET, zero requests to any
 * path outside the panel's documented read-only poll set, and
 * `[data-team-x]` never leaves data-confirm="idle".
 *
 * ── What this script discovered (round 504) ──────────────────────────────
 * `confirm.ts` documents three defences: the decision function, the redundant
 * guard clause, and the absence of any fetch. There is a FOURTH, and it is the
 * one that actually stops attacks 4-6: **react-dom does not dispatch mouse
 * events to a form element whose PROPS say `disabled`, whatever the DOM
 * attribute says.** Stripping the attribute changes `button.disabled` to false
 * and the browser then delivers a real click event — a capture-phase listener
 * installed by this script sees it, `defaultPrevented: false` — and React's
 * onClick still never runs. Recorded per attack as `dom_click_observed` (the
 * click really happened) beside `confirm_state` (the machine did not move).
 *
 * Consequence, stated because it contradicts a comment in the shipped panel:
 * ChatTeamPanel.tsx's header tells round 504 to reach the armed screenshot by
 * stripping `disabled` and clicking. That is impossible. `capture-team.cjs`'s
 * `armed` case flips the capability flag instead and says so.
 *
 * Run:
 *   export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase500.txt)"
 *   TEAM_BASE_URL=http://127.0.0.1:7787 \
 *     node docs/plan/artifacts/phase500/control-inert.cjs
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
const API = process.env.TEAM_API_URL ?? "http://127.0.0.1:7798";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT = __dirname;
const LIVE_ROW_TITLE = "ROUND504 CONTROL-INERT PROBE (injected rail row)";
/** How long each attack window watches the network after its click. Longer
 *  than any plausible request-on-click latency, short enough that at most one
 *  5s team poll can land inside it. */
const WINDOW_MS = Number(process.env.TEAM_INERT_WINDOW_MS ?? "4000");

/**
 * The panel's documented read-only poll set. Anything outside this, and
 * anything that is not a GET, is a request that "left the page" in the sense
 * the gate cares about.
 *
 * Deliberately a whitelist of PATHS, not a blacklist of scary words: a
 * blacklist would pass a terminate implemented as `POST /api/x`.
 */
const ALLOWED_GET_PATHS = new Set([
  "/chat",
  "/chat/:id",
  "/chat/:id/team",
  "/chat/:id/linkage",
  "/chat/:id/events",
  "/capabilities",
  "/usage/quota",
  "/agents",
  "/health",
]);

function endpointOf(pathWithQuery) {
  return pathWithQuery
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

/** Whatever is running at THIS moment. Never hardcoded. */
async function discoverLiveRun() {
  const res = await fetch(`${API}/api/agents`);
  if (!res.ok) throw new Error(`GET ${API}/api/agents → HTTP ${res.status}`);
  const body = await res.json();
  const live = (Array.isArray(body.agents) ? body.agents : []).filter(
    (a) => a.status === "running" && typeof a.id === "string",
  );
  if (!live.length)
    throw new Error(
      `no running run in the fleet right now (${API}/api/agents) — this protocol attacks the controls of a RUNNING row and needs one in flight; re-run later`,
    );
  return live[0].id;
}

/** The real, unfaked capability flags this run is judged against. */
async function realCapabilities() {
  const res = await fetch(`${API}/api/capabilities`);
  if (!res.ok) throw new Error(`GET ${API}/api/capabilities → HTTP ${res.status}`);
  return (await res.json()).control_plane;
}

const INSTALL_CLICK_SPY = () => {
  window.__domClicks = [];
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target;
      window.__domClicks.push({
        tag: el.tagName,
        stop: el.closest?.("[data-team-stop]") !== null,
        x: el.closest?.("[data-team-x]") !== null,
        defaultPrevented: e.defaultPrevented,
      });
    },
    true,
  );
};

async function main() {
  const liveRunId = await discoverLiveRun();
  const caps = await realCapabilities();
  console.log(`live run: ${liveRunId}`);
  console.log(`real capabilities: ${JSON.stringify(caps)}`);
  if (caps.stop !== false || caps.terminate !== false)
    throw new Error(
      `this protocol asserts inertness UNDER all-false capabilities, but the server reports stop=${caps.stop} terminate=${caps.terminate}. Re-read the gate before trusting any verdict below.`,
    );

  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let result;
  try {
    result = await run(browser, liveRunId, caps);
  } finally {
    await browser.close();
  }

  const out = path.join(OUT, "control-inert.json");
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const a of result.attacks)
    console.log(
      `  ${a.attack.padEnd(14)} verdict=${a.verdict.padEnd(4)} ` +
        `dom_clicks=${a.dom_click_observed} confirm=${a.confirm_state} ` +
        `disallowed=${a.disallowed_requests.length} non_get=${a.non_get_requests.length} ` +
        `polls=${JSON.stringify(a.allowed_requests)}`,
    );
  result.failures.forEach((f) => console.log(`  FAIL: ${f}`));
  console.log(`→ ${out}`);
  console.log(`CONTROL-INERT: ${result.verdict}`);
  if (result.verdict !== "PASS") process.exitCode = 1;
}

async function run(browser, liveRunId, caps) {
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
  const page = await ctx.newPage();
  await page.addInitScript(INSTALL_CLICK_SPY);

  // NAVIGATION ONLY — /chat/:id/team, /capabilities and everything else go
  // straight to the real server.
  await page.route("**/api/proxy/chat*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/api/proxy/chat")) return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    const template = body.runs?.[0];
    if (!template) return route.fulfill({ response: res });
    const injected = { ...template, id: liveRunId, title: LIVE_ROW_TITLE, status: "running" };
    delete injected.project_id;
    delete injected.project_status;
    delete injected.tasks_done;
    delete injected.tasks_total;
    body.runs = [injected, ...body.runs];
    body.count = body.runs.length;
    await route.fulfill({ response: res, contentType: "application/json", body: JSON.stringify(body) });
  });

  const requests = [];
  page.on("request", (r) => {
    const url = r.url();
    if (!url.includes("/api/proxy/")) return;
    const rest = url.split("/api/proxy")[1];
    requests.push({ at: Date.now(), method: r.method(), url: rest, endpoint: endpointOf(rest) });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(LIVE_ROW_TITLE, { exact: false }).first().click();
  await page.waitForTimeout(3_000);

  const nodeId = await page
    .waitForFunction(
      () =>
        document
          .querySelector("[data-team-scroll] [data-team-row][data-settled='false']")
          ?.getAttribute("data-node-id") ?? false,
      { timeout: 20_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => {
      throw new Error(
        'no [data-team-row][data-settled="false"] rendered within 20s — the run settled between discovery and render',
      );
    });

  const rowSel = `[data-team-row][data-node-id="${nodeId}"]`;
  const stopSel = `${rowSel} [data-team-stop]`;
  const xSel = `${rowSel} [data-team-x]`;

  // ── The visible half of NFU6: disabled, with a reason, never hidden ───────
  const affordance = await page.evaluate(
    ([r, s, x]) => {
      const row = document.querySelector(r);
      const stop = document.querySelector(s);
      const xb = document.querySelector(x);
      const cs = (el) => getComputedStyle(el);
      return {
        row_present: !!row,
        stop: {
          present: !!stop,
          disabled: stop.disabled,
          title: stop.title,
          cursor: cs(stop).cursor,
          // mounted and rendered, not display:none — "visibly disabled"
          rendered: stop.getBoundingClientRect().width > 0,
        },
        x: {
          present: !!xb,
          disabled: xb.disabled,
          title: xb.title,
          cursor: cs(xb).cursor,
          rendered: xb.getBoundingClientRect().width > 0,
          confirm: xb.getAttribute("data-confirm"),
        },
      };
    },
    [rowSel, stopSel, xSel],
  );

  const failures = [];
  if (!affordance.stop.disabled) failures.push("[data-team-stop] on a running row is NOT disabled");
  if (!affordance.x.disabled)
    failures.push("[data-team-x] on a running row is NOT disabled (terminate is capability-gated)");
  if (!affordance.stop.rendered || !affordance.x.rendered)
    failures.push("a capability-gated control is not rendered — NFU6 says disabled, never hidden");
  for (const [name, btn] of [["stop", affordance.stop], ["x", affordance.x]]) {
    if (!/control plane contract/.test(btn.title))
      failures.push(`${name} button's title does not name the missing capability: "${btn.title}"`);
    if (btn.cursor !== "not-allowed")
      failures.push(`${name} button's cursor is "${btn.cursor}", expected "not-allowed"`);
  }

  /** One attack window: reset the spies, do the thing, watch, classify. */
  const window_ = async (name, action) => {
    await page.evaluate(() => {
      window.__domClicks = [];
    });
    const startIdx = requests.length;
    const t0 = Date.now();
    let actionError = null;
    try {
      await action();
    } catch (e) {
      // A refused click is itself a result, not a crash: Playwright refuses to
      // click a disabled element without force, and that refusal is evidence.
      actionError = e.message.split("\n")[0];
    }
    await page.waitForTimeout(WINDOW_MS);
    const seen = requests.slice(startIdx);
    const domClicks = await page.evaluate(() => window.__domClicks);
    const confirm = await page.evaluate((s) => {
      const b = document.querySelector(s);
      return b ? b.getAttribute("data-confirm") : "<row gone>";
    }, xSel);

    const nonGet = seen.filter((r) => r.method !== "GET");
    const disallowed = seen.filter((r) => r.method === "GET" && !ALLOWED_GET_PATHS.has(r.endpoint));
    const allowed = {};
    for (const r of seen) if (!nonGet.includes(r) && !disallowed.includes(r))
      allowed[r.endpoint] = (allowed[r.endpoint] ?? 0) + 1;

    const attackFailures = [];
    if (nonGet.length)
      attackFailures.push(
        `${name}: ${nonGet.length} non-GET request(s) left the page: ${JSON.stringify(nonGet)}`,
      );
    if (disallowed.length)
      attackFailures.push(
        `${name}: ${disallowed.length} request(s) outside the panel's poll set: ${JSON.stringify(disallowed)}`,
      );
    if (name !== "baseline" && confirm !== "idle")
      attackFailures.push(
        `${name}: [data-team-x] reached data-confirm="${confirm}" under all-false capabilities`,
      );
    failures.push(...attackFailures);

    return {
      attack: name,
      window_ms: Date.now() - t0,
      action_error: actionError,
      dom_click_observed: domClicks.filter((c) => c.stop || c.x).length,
      dom_clicks: domClicks,
      confirm_state: confirm,
      allowed_requests: allowed,
      disallowed_requests: disallowed,
      non_get_requests: nonGet,
      raw: seen,
      verdict: attackFailures.length ? "FAIL" : "PASS",
    };
  };

  const strip = (sel) =>
    page.evaluate((s) => {
      const b = document.querySelector(s);
      if (!b) return false;
      b.removeAttribute("disabled");
      return !b.disabled;
    }, sel);

  const attacks = [];
  // 1. control window — what the panel costs when nobody touches it
  attacks.push(await window_("baseline", async () => {}));
  // 2/3. click the disabled controls (force — Playwright refuses otherwise)
  attacks.push(await window_("stop-click", () => page.locator(stopSel).click({ force: true })));
  attacks.push(await window_("x-click", () => page.locator(xSel).click({ force: true })));
  // 4. the devtools move: strip the attribute, then click for real
  attacks.push(
    await window_("stop-stripped", async () => {
      if (!(await strip(stopSel))) throw new Error("could not strip disabled from stop");
      await page.locator(stopSel).click();
    }),
  );
  // 5. same on X, plus the confirm-bypass double click (delta << MIN_CONFIRM_MS)
  attacks.push(
    await window_("x-stripped", async () => {
      if (!(await strip(xSel))) throw new Error("could not strip disabled from x");
      await page.locator(xSel).click();
      await page.waitForTimeout(40);
      await strip(xSel);
      await page.locator(xSel).click();
    }),
  );
  // 6. bypass Playwright entirely — dispatch from page script
  attacks.push(
    await window_("x-raw-dom", () =>
      page.evaluate((s) => {
        const b = document.querySelector(s);
        b.removeAttribute("disabled");
        b.click();
        b.click();
      }, xSel),
    ),
  );

  const domClickedSomewhere = attacks.some((a) => a.dom_click_observed > 0);
  if (!domClickedSomewhere)
    failures.push(
      "no click ever reached the buttons in the DOM — the attacks did not actually run, so their PASS means nothing",
    );

  await ctx.close();

  return {
    protocol: "14 §500 RED-TEAM (destructive controls) — inertness under all-false capabilities",
    base: BASE,
    api: API,
    live_run_id: liveRunId,
    capabilities: caps,
    capabilities_source: "real GET /api/capabilities — nothing intercepted",
    navigation: "injected-rail-row (list response only; /team and /capabilities untouched)",
    allowed_get_paths: [...ALLOWED_GET_PATHS],
    affordance,
    attacks,
    react_props_disabled_gate: {
      claim:
        "react-dom does not dispatch mouse events to a form element whose props say disabled, " +
        "regardless of the DOM attribute — stripping `disabled` does not reach the onClick handler",
      evidence:
        "attacks 4-6 show dom_click_observed > 0 (the browser really delivered the click, " +
        "defaultPrevented false) while confirm_state stayed idle and no request left the page",
    },
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
  };
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
