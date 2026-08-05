/**
 * fixes-506.cjs — browser evidence for round 505's findings #1 through #5,
 * re-mounting the reviewer's own attacks against the fixed build.
 *
 * Five sections, each named for the finding it answers:
 *
 *   A. #4 — arming must not move a pixel. The ✕'s bounding box, the row's box
 *      and the NEXT row's y are measured idle, then armed, then idle again.
 *      Round 505 measured row 259x41 → 259x43 and ✕ 14x16 → 32x18, i.e. every
 *      row below jumped 2px mid-gesture; expected now: identical rectangles.
 *   B. #1 — the click-stream bypass, in a real browser. 15 real mouse clicks
 *      20ms apart and 15 raw clicks 25ms apart on an ARMED running row, with a
 *      MutationObserver watching `data-confirm` for the armed→idle transition
 *      that can only come from the terminate branch. Round 505 got 2 and 2.
 *      B3/B4 are this round's own finding: discrete clicks 350ms and 450ms
 *      apart, each reporting `detail: 1`, which cleared the old 150ms floor
 *      without ever looking like a double-click. That is why MIN_CONFIRM_MS is
 *      now 500ms rather than 150 — the platform's own multi-click window.
 *      B5 is the positive control: two clicks 1.2s apart must still fire
 *      EXACTLY once, because a confirm step that can never be confirmed is a
 *      dead button, not a safe one.
 *   C. #1 (keyboard) — 25 trusted autorepeat keydowns at 33ms on the focused
 *      ✕, dispatched through CDP with `autoRepeat: true`. Round 505 got 4
 *      terminates from one held Enter key.
 *   D. #3 — the "N hidden · show" count. Phantom (junk ids in localStorage
 *      must claim nothing) and undercount (a dismissed parent must count its
 *      sub-agents). Round 505 saw "2 hidden" with 20/20 rows rendered, and
 *      "1 hidden" for a 2-row dismissal.
 *   E. #2 — a dead team API must not read as fresh. Every
 *      /api/proxy/chat/:id/team request is aborted; the panel is sampled once
 *      a second for 14s. Round 505 measured ready/20 rows at +2s, +4s, +6s and
 *      only reached `error` at +8s, with a running row interpolating through
 *      the whole window.
 *
 * ── DECLARED INTERCEPTION (sections A, B, C) ──────────────────────────────
 * Two responses are rewritten, loudly, and only for those three sections:
 *
 *   • `capabilities.control_plane.terminate` → **true**. This is the state the
 *     engine lane will ship and the state round 505 had to flip to reach the
 *     bug. With today's real all-false response the whole destructive path is
 *     unreachable and there is nothing to attack — `control-inert.cjs` is the
 *     protocol that proves THAT, against the real response, and it is
 *     unchanged.
 *   • one settled worker node → `status:"running", settled:false`, so the
 *     armed state exists without depending on whether the fleet happens to
 *     have a run in flight at this moment. Nothing else in the payload is
 *     touched; every other row is the server's own answer.
 *
 * Sections D and E use the REAL responses (E aborts them, which is the point).
 * `interception` in the JSON output names which section got what.
 *
 * Even with the flag flipped, a terminate cannot leave the browser: no fetch
 * for it exists in the panel. Every request the page makes is recorded and the
 * non-GET count is asserted to be zero, exactly as in round 505.
 *
 * Run:
 *   export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-506.txt)"
 *   TEAM_BASE_URL=http://127.0.0.1:7785 \
 *     node docs/plan/artifacts/phase500/fixes-506.cjs
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

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7785";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "Okay this session is very important";
const STORAGE_KEY = "forge.teamDismissed";
const OUT = __dirname;

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

const steps = [];
const failures = [];
const note = (step, ok, detail, extra = {}) => {
  steps.push({ step, ok, detail, ...extra });
  if (!ok) failures.push(`${step}: ${detail}`);
};

const ROW_IDS = () =>
  Array.from(document.querySelectorAll("[data-team-scroll] [data-team-row]")).map((r) =>
    r.getAttribute("data-node-id"),
  );

async function newPage(browser, { fakeRunning }) {
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
  await ctx.addInitScript((k) => window.localStorage.removeItem(k), STORAGE_KEY);
  const page = await ctx.newPage();

  const requests = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/proxy/"))
      requests.push({ method: r.method(), url: r.url().split("/api/proxy")[1] });
  });

  if (fakeRunning) {
    // DECLARED: the engine lane's future capability state.
    await page.route("**/api/proxy/capabilities", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.control_plane = { ...json.control_plane, terminate: true };
      await route.fulfill({ response: res, body: JSON.stringify(json) });
    });
    // DECLARED: one settled worker becomes running, so an armed state exists
    // regardless of what the fleet is doing right now.
    await page.route("**/api/proxy/chat/*/team", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      const target = (json.workers ?? []).find((w) => w.settled === true);
      if (target) {
        target.settled = false;
        target.status = "running";
      }
      await route.fulfill({ response: res, body: JSON.stringify(json) });
    });
  }
  return { ctx, page, requests };
}

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
      () =>
        document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 20_000 },
    )
    .catch(async () => {
      const state = await page
        .evaluate(() =>
          document.querySelector("[data-team-panel]")?.getAttribute("data-team-state"),
        )
        .catch(() => undefined);
      throw new Error(
        `[data-team-panel] never reached data-team-state="ready" (got "${state}") for "${CHAT_TEXT}"`,
      );
    });
}

/** Geometry of the ✕, its row, and the row after it — the three things that
 *  moved in round 505's measurement. */
const MEASURE = (id) => {
  const row = document.querySelector(`[data-team-row][data-node-id="${id}"]`);
  const x = row?.querySelector("[data-team-x]");
  const rows = Array.from(document.querySelectorAll("[data-team-scroll] [data-team-row]"));
  const next = rows[rows.indexOf(row) + 1];
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      y: Math.round(r.y * 100) / 100,
    };
  };
  return {
    x: box(x),
    row: box(row),
    next_row_y: next ? Math.round(next.getBoundingClientRect().y * 100) / 100 : null,
    confirm: x?.getAttribute("data-confirm") ?? null,
    label: x?.textContent ?? null,
  };
};

/* ── A + B + C: the destructive path, with terminate flipped on ────────────── */

async function sectionsABC(browser, result) {
  const { ctx, page, requests } = await newPage(browser, { fakeRunning: true });
  await openChat(page);

  const runningId = await page.evaluate(() => {
    const r = document.querySelector(
      "[data-team-scroll] [data-team-row][data-settled='false'][data-status='running']",
    );
    return r ? r.getAttribute("data-node-id") : null;
  });
  if (!runningId) throw new Error("no running row after the declared rewrite — cannot arm");
  result.running_node_id = runningId;

  const xSel = `[data-team-row][data-node-id="${runningId}"] [data-team-x]`;
  const enabled = await page.evaluate((s) => {
    const b = document.querySelector(s);
    return b ? !b.disabled : null;
  }, xSel);
  note(
    "A0-terminate-enabled",
    enabled === true,
    `with the declared terminate:true the running row's ✕ is enabled=${enabled} (today's real response leaves it disabled — see control-inert.cjs)`,
  );

  // ── A. geometry, idle → armed → idle ─────────────────────────────────────
  const idle1 = await page.evaluate(MEASURE, runningId);
  await page.locator(xSel).click();
  await page.waitForTimeout(250);
  const armed = await page.evaluate(MEASURE, runningId);

  note(
    "A1-armed-state-reached",
    armed.confirm === "armed" && armed.label === "sure?",
    `data-confirm=${armed.confirm} label=${JSON.stringify(armed.label)}`,
  );
  const same = (a, b) => a && b && a.w === b.w && a.h === b.h;
  note(
    "A2-x-box-identical",
    same(idle1.x, armed.x),
    `✕ idle ${idle1.x?.w}x${idle1.x?.h} → armed ${armed.x?.w}x${armed.x?.h} ` +
      `(round 505: 14x16 → 32x18)`,
    { idle: idle1.x, armed: armed.x },
  );
  note(
    "A3-row-box-identical",
    same(idle1.row, armed.row),
    `row idle ${idle1.row?.w}x${idle1.row?.h} → armed ${armed.row?.w}x${armed.row?.h} ` +
      `(round 505: 259x41 → 259x43)`,
    { idle: idle1.row, armed: armed.row },
  );
  note(
    "A4-rows-below-do-not-move",
    idle1.next_row_y !== null && idle1.next_row_y === armed.next_row_y,
    `next row y ${idle1.next_row_y} → ${armed.next_row_y} (round 505: every row below jumped 2px)`,
  );

  // Wait out the 3s auto-disarm and re-measure: back to exactly where we were.
  await page.waitForTimeout(3_400);
  const idle2 = await page.evaluate(MEASURE, runningId);
  note(
    "A5-disarms-back-to-identical-box",
    idle2.confirm === "idle" && same(idle1.x, idle2.x) && same(idle1.row, idle2.row),
    `after auto-disarm: confirm=${idle2.confirm}, ✕ ${idle2.x?.w}x${idle2.x?.h}, row ${idle2.row?.w}x${idle2.row?.h}`,
  );

  // ── B. click streams ─────────────────────────────────────────────────────
  /** Counts armed→idle transitions on the target ✕ inside a window shorter
   *  than the 3s auto-disarm, so the only thing that can produce one is the
   *  terminate branch clearing `armedId` (round 505's own detector). */
  const startObserver = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      window.__transitions = [];
      window.__t0 = performance.now();
      let last = el.getAttribute("data-confirm");
      window.__obs = new MutationObserver(() => {
        const now = el.getAttribute("data-confirm");
        if (now !== last) {
          window.__transitions.push({ from: last, to: now, at: Math.round(performance.now() - window.__t0) });
          last = now;
        }
      });
      window.__obs.observe(el, { attributes: true, attributeFilter: ["data-confirm"] });
    }, sel);

  const stopObserver = () =>
    page.evaluate(() => {
      window.__obs.disconnect();
      return window.__transitions;
    });

  const burst = async (label, n, gapMs, mode) => {
    const reqBefore = requests.length;
    await page.locator(xSel).scrollIntoViewIfNeeded();
    await startObserver(xSel);
    if (mode === "real") {
      const box = await page.locator(xSel).boundingBox();
      for (let k = 0; k < n; k++) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 0 });
        await page.waitForTimeout(gapMs);
      }
    } else {
      await page.evaluate(
        async ([s, count, gap]) => {
          const el = document.querySelector(s);
          for (let k = 0; k < count; k++) {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
            await new Promise((r) => setTimeout(r, gap));
          }
        },
        [xSel, n, gapMs],
      );
    }
    const transitions = await stopObserver();
    const armedToIdle = transitions.filter((t) => t.from === "armed" && t.to === "idle");
    const nonGet = requests.slice(reqBefore).filter((r) => r.method !== "GET");
    note(
      label,
      armedToIdle.length === 0 && nonGet.length === 0,
      `${n} clicks ${gapMs}ms apart (${mode}) → ${armedToIdle.length} terminate-shaped transitions, ` +
        `${nonGet.length} non-GET requests`,
      { transitions, non_get: nonGet },
    );
    // Leave the row disarmed before the next case.
    await page.waitForTimeout(3_400);
  };

  await burst("B1-15-real-mouse-clicks-20ms", 15, 20, "real");
  await burst("B2-15-raw-clicks-25ms", 15, 25, "raw");
  // NOT a double-click: Playwright's mouse.click sets clickCount 1 every time,
  // so all four report `detail: 1` and walk straight past the double-click
  // guard onto the floor. That makes this the STRONGER form of round 505's
  // "two double-clicks 350ms apart → 1 terminate", and it is the case that
  // found the floor itself to be too small — 350 > the old 150ms read as a
  // deliberate confirmation. MIN_CONFIRM_MS is now 500ms, the platform's own
  // multi-click window.
  await burst("B3-4-discrete-clicks-350ms-rage", 4, 350, "real");
  // 450ms requested; page.mouse.click adds a few ms of its own, so the
  // delivered gaps sit just under the 500ms floor. A gap ABOVE the floor is
  // supposed to fire — that is the confirm gesture, not a bypass — which is
  // what B5 asserts. Asking for 499 here fired 3 times for exactly that
  // reason: the overhead pushed every gap past 500.
  await burst("B4-6-discrete-clicks-450ms", 6, 450, "real");

  // POSITIVE CONTROL. Everything above proves the gate stays shut; this proves
  // it still opens. A gate that never opens is not a fix — it is a dead button
  // the engine lane would inherit and have to debug.
  {
    const reqBefore = requests.length;
    await startObserver(xSel);
    const box = await page.locator(xSel).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1_200);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const transitions = await stopObserver();
    const armedToIdle = transitions.filter((t) => t.from === "armed" && t.to === "idle");
    note(
      "B5-positive-control-two-clicks-1.2s",
      armedToIdle.length === 1,
      `two deliberate clicks 1.2s apart → ${armedToIdle.length} terminate-shaped transition ` +
        `(must be exactly 1: the confirm step has to still work)`,
      { transitions, non_get: requests.slice(reqBefore).filter((r) => r.method !== "GET") },
    );
    await page.waitForTimeout(3_400);
  }

  // ── C. held Enter, trusted autorepeat via CDP ────────────────────────────
  {
    const reqBefore = requests.length;
    await page.locator(xSel).focus();
    await startObserver(xSel);
    const cdp = await ctx.newCDPSession(page);
    // First press arms; the following 24 are autoRepeat, which is the attack.
    for (let k = 0; k < 25; k++) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        autoRepeat: k > 0,
      });
      await page.waitForTimeout(33);
    }
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const transitions = await stopObserver();
    const armedToIdle = transitions.filter((t) => t.from === "armed" && t.to === "idle");
    const nonGet = requests.slice(reqBefore).filter((r) => r.method !== "GET");
    note(
      "C1-held-enter-25-autorepeats-33ms",
      armedToIdle.length === 0 && nonGet.length === 0,
      `one held Enter (25 keydowns, 24 with autoRepeat) → ${armedToIdle.length} terminate-shaped ` +
        `transitions, ${nonGet.length} non-GET requests (round 505: 4 terminates)`,
      { transitions, non_get: nonGet },
    );
  }

  result.non_get_total_abc = requests.filter((r) => r.method !== "GET").length;
  note(
    "ABC-nothing-left-the-page",
    result.non_get_total_abc === 0,
    `${result.non_get_total_abc} non-GET requests across every attack in sections A–C`,
  );

  await ctx.close();
}

/* ── D: the hidden count ───────────────────────────────────────────────────── */

async function sectionD(browser, result) {
  const { ctx, page } = await newPage(browser, { fakeRunning: false });

  // D1 — phantom. Seed junk for THIS chat before the panel ever renders.
  await page.addInitScript(
    ([key]) => {
      // The chat id is not known here, so poison every key the panel might use
      // by writing under a wildcard set after load — done in-page below
      // instead; this hook only guarantees a clean slate.
      window.localStorage.removeItem(key);
    },
    [STORAGE_KEY],
  );
  await openChat(page);

  const chatId = await page.evaluate(() => {
    const m = window.location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    return m ? m[0] : null;
  });

  const rowsAll = await page.evaluate(ROW_IDS);
  result.rows_total = rowsAll.length;

  // Poison with ids that match nothing, keyed by the chat the panel is on. The
  // key is discovered from the panel's own behaviour: dismiss one row, read
  // the key back, restore, then reuse that key for the junk.
  const settledId = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("[data-team-scroll] [data-team-row][data-settled='true']"),
    );
    return rows.length ? rows[rows.length - 1].getAttribute("data-node-id") : null;
  });
  if (!settledId) throw new Error("no settled row in this chat — cannot exercise dismissal");
  await page.locator(`[data-team-row][data-node-id="${settledId}"] [data-team-x]`).click();
  await page.waitForTimeout(800);
  const storeKey = await page.evaluate((k) => {
    const raw = window.localStorage.getItem(k);
    const parsed = raw ? JSON.parse(raw) : {};
    return Object.keys(parsed)[0] ?? null;
  }, STORAGE_KEY);
  await page.locator("[data-team-restore]").click();
  await page.waitForTimeout(800);
  result.storage_chat_key = storeKey;
  result.chat_id_in_url = chatId;

  await page.evaluate(
    ([k, chat]) => {
      window.localStorage.setItem(
        k,
        JSON.stringify({ [chat]: ["nonexistent-a", "nonexistent-b"] }),
      );
    },
    [STORAGE_KEY, storeKey],
  );
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(4_000);
  await page.waitForFunction(
    () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
    { timeout: 20_000 },
  );

  const phantom = await page.evaluate(() => {
    const b = document.querySelector("[data-team-restore]");
    return {
      label: b ? b.textContent : null,
      rows: document.querySelectorAll("[data-team-scroll] [data-team-row]").length,
    };
  });
  note(
    "D1-phantom-ids-claim-nothing",
    phantom.label === null && phantom.rows === rowsAll.length,
    `2 junk ids in localStorage → label ${JSON.stringify(phantom.label)}, ${phantom.rows}/${rowsAll.length} rows ` +
      `(round 505: "2 hidden · show" with every row rendered)`,
  );

  // D2 — undercount. Dismiss a settled worker (depth 1) that owns sub-agents.
  await page.evaluate((k) => window.localStorage.removeItem(k), STORAGE_KEY);
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(4_000);
  await page.waitForFunction(
    () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
    { timeout: 20_000 },
  );

  const parent = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-team-scroll] [data-team-row]"));
    for (let i = 0; i < rows.length; i++) {
      if (
        rows[i].getAttribute("data-depth") === "1" &&
        rows[i].getAttribute("data-settled") === "true" &&
        rows[i + 1]?.getAttribute("data-depth") === "2"
      ) {
        let kids = 0;
        for (let j = i + 1; j < rows.length && rows[j].getAttribute("data-depth") === "2"; j++) kids++;
        return { id: rows[i].getAttribute("data-node-id"), kids };
      }
    }
    return null;
  });
  if (!parent) {
    note("D2-parent-with-subagents-found", false, "no settled worker with sub-agents in this chat");
  } else {
    const before = (await page.evaluate(ROW_IDS)).length;
    await page.locator(`[data-team-row][data-node-id="${parent.id}"] [data-team-x]`).click();
    await page.waitForTimeout(1_000);
    const after = (await page.evaluate(ROW_IDS)).length;
    const label = await page.evaluate(() => {
      const b = document.querySelector("[data-team-restore]");
      return b ? b.textContent : null;
    });
    const removed = before - after;
    note(
      "D2-count-equals-rows-removed",
      label === `${removed} hidden · show` && removed === parent.kids + 1,
      `dismissing a worker with ${parent.kids} sub-agent(s): rows ${before} → ${after} (${removed} gone), ` +
        `label ${JSON.stringify(label)} (round 505: "1 hidden" for a 2-row dismissal)`,
      { parent_id: parent.id, subagents: parent.kids, rows_before: before, rows_after: after },
    );
    await page.locator("[data-team-restore]").click();
    await page.waitForTimeout(800);
  }

  await page.evaluate((k) => window.localStorage.removeItem(k), STORAGE_KEY);
  await ctx.close();
}

/* ── E: a dead API must not read as fresh ──────────────────────────────────── */

async function sectionE(browser, result) {
  const { ctx, page } = await newPage(browser, { fakeRunning: false });
  await openChat(page);

  const rowsBefore = (await page.evaluate(ROW_IDS)).length;
  await page.route("**/api/proxy/chat/*/team", (route) => route.abort("failed"));

  const samples = [];
  for (let s = 1; s <= 14; s++) {
    await page.waitForTimeout(1_000);
    samples.push(
      await page.evaluate((sec) => {
        const p = document.querySelector("[data-team-panel]");
        return {
          t: `+${sec}s`,
          state: p?.getAttribute("data-team-state") ?? null,
          rows: document.querySelectorAll("[data-team-scroll] [data-team-row]").length,
        };
      }, s),
    );
  }

  const firstError = samples.find((s) => s.state === "error");
  const freshAfterError = samples.filter((s) => s.state === "error" && s.rows > 0);
  const staleWindow = samples.filter((s) => s.state === "ready" && s.rows > 0);
  note(
    "E1-error-within-one-poll",
    Boolean(firstError) && Number(firstError.t.replace(/[+s]/g, "")) <= 7,
    `panel reached "error" at ${firstError ? firstError.t : "NEVER"} after the API went dead ` +
      `(round 505: ready/20 rows at +2s, +4s, +6s; error only at +8s)`,
    { samples },
  );
  note(
    "E2-no-rows-beside-an-error",
    freshAfterError.length === 0,
    `${freshAfterError.length} sample(s) showed rows while in the error state`,
  );
  result.stale_seconds = staleWindow.length;
  result.rows_before_abort = rowsBefore;

  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  const result = {
    protocol: "round 506 — browser evidence for round 505 findings #1..#5",
    base: BASE,
    chat: CHAT_TEXT,
    interception: {
      "A,B,C": "DECLARED: capabilities.terminate → true; one settled worker → running. Nothing else.",
      D: "none — real responses",
      E: "every /api/proxy/chat/:id/team request aborted, on purpose",
    },
  };
  try {
    await sectionsABC(browser, result);
    await sectionD(browser, result);
    await sectionE(browser, result);
  } finally {
    await browser.close();
  }

  result.steps = steps;
  result.failures = failures;
  result.verdict = failures.length ? "FAIL" : "PASS";

  const out = path.join(OUT, "fixes-506.json");
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const s of steps) console.log(`  ${s.step.padEnd(34)} ${s.ok ? "ok  " : "FAIL"} — ${s.detail}`);
  console.log(`→ ${out}`);
  console.log(`FIXES-506: ${result.verdict}`);
  if (result.verdict !== "PASS") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
