/**
 * verify-1873.cjs — round 1873's six fixes, driven in a real browser against
 * the WORKTREE build. No pm2 service is touched and nothing is written to the
 * live database: every dismissal write is intercepted at the network layer (see
 * `stubDismissalWrites`) and answered with the server's own shape, so the
 * confirm/undo machine is exercised end to end without hiding one real row.
 *
 *   web :7823  — worktree `next start`, FORGE_CONTROL_URL → :7822
 *   api :7822  — worktree routers via scripts/checks/serve-v3-7798.ts
 *   db         — the real content_forge, READ only
 *
 * Run:
 *   node docs/plan/artifacts/phase1873/verify-1873.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function chrome() {
  const cache = "/root/.cache/ms-playwright";
  return fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
}

const BASE = "http://127.0.0.1:7823";
const COOKIE = fs.readFileSync("/tmp/session-cookie-1873.txt", "utf8").trim();
const CHAT = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const OUT = "/tmp/verify-1873";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const say = (label, ok, detail) => {
  results.push({ label, ok, detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

/** Every write to `/api/proxy/agents/dismissals*` is answered locally.
 *
 *  This is the one thing this script must not do for real: the panel's ✕ hides
 *  rows on a GLOBAL, server-backed set, and round 1872's tester hid 174 real
 *  nodes proving the same point. The stub answers with the route's own contract
 *  — `{dismissed: [...]}` for the POST, `{restored: [...]}` for the undo — and
 *  RECORDS the bodies, which is what lets the undo assertion below check that
 *  the client sent back exactly the ids it was given. */
function stubDismissalWrites(page, log) {
  return page.route("**/api/proxy/agents/dismissals**", async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") return route.fallback();
    const url = req.url();
    let body = {};
    try {
      body = req.postDataJSON() ?? {};
    } catch {
      body = {};
    }
    if (method === "POST" && url.endsWith("/restore")) {
      log.push({ kind: "restore", ids: body.ids ?? [] });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ restored: body.ids ?? [] }),
      });
    }
    if (method === "POST") {
      /* The cascade the real server would resolve, faked at the same shape: the
         target plus two invented companions, so "the undo restores the whole
         gesture" has something to restore. */
      const dismissed = [body.id, `${body.id}-cascade-1`, `${body.id}-cascade-2`];
      log.push({ kind: "dismiss", id: body.id, dismissed });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dismissed }),
      });
    }
    log.push({ kind: method.toLowerCase(), url });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ restored: [] }),
    });
  });
}

/** The run-control verbs, answered locally and NEVER forwarded.
 *
 *  THIS BLOCK EXISTS BECAUSE THE SCRIPT DID THE DAMAGE ONCE. On its second run
 *  the manager row had gone from settled to RUNNING (this chat is alive while
 *  the project works), so the ✕ the confirm test drives was no longer a
 *  dismissal but a terminate — and `capabilities.terminate` has been true since
 *  round 1353. The two clicks cancelled Konrad's operator chat at 14:08:58,
 *  which had to be repaired with `POST /runs/:id/resume-chat`. Stubbing the
 *  dismissal endpoints was not enough: a test that drives a destructive control
 *  must intercept EVERY verb that control can reach, not the one it expects. */
function stubRunControlWrites(page, log) {
  return page.route("**/api/proxy/runs/**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    log.push({ kind: "run-control-blocked", method: req.method(), url: req.url() });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ blocked_by_test_harness: true }),
    });
  });
}

async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForSelector(".chat-row", { timeout: 30000 });
  await page.evaluate((id) => document.querySelector(`[data-chat-id="${id}"]`)?.click(), CHAT);
  await page.waitForSelector("textarea", { timeout: 30000 });
  await page.waitForSelector('[data-team-panel][data-team-state="ready"]', { timeout: 40000 });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: chrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const writes = [];
  await stubDismissalWrites(page, writes);
  await stubRunControlWrites(page, writes);
  await openChat(page);

  /* ══ FINDING 1 — the project switcher answers immediately ═══════════════
   *
   * "For 6,828ms nothing changed: the chip's `aria-pressed` did not flip, the
   * rows did not change, and `data-team-state` stayed `ready` the whole time."
   * The two claims measured here are the two halves of the fix: acknowledgement
   * inside one frame, and the ROWS arriving on the click's own fetch rather than
   * on the next 6s poll. */
  {
    const before = await page.evaluate(() => {
      const chips = [...document.querySelectorAll("[data-project-choice]")];
      return {
        chips: chips.map((c) => ({
          id: c.getAttribute("data-project-choice"),
          pressed: c.getAttribute("aria-pressed"),
          text: c.innerText.replace(/\s+/g, " ").trim(),
        })),
        rows: document.querySelectorAll("[data-team-row]").length,
        state: document.querySelector("[data-team-panel]")?.getAttribute("data-team-state"),
      };
    });
    say("F1 the switcher offers both projects", before.chips.length === 2, JSON.stringify(before.chips));

    const target = before.chips.find((c) => c.pressed !== "true");
    const t0 = Date.now();
    await page.evaluate(
      (id) => document.querySelector(`[data-project-choice="${id}"]`)?.click(),
      target.id,
    );
    /* No waiting: read the DOM on the very next animation frame. */
    const ack = await page.evaluate(async (id) => {
      await new Promise((r) => requestAnimationFrame(() => r()));
      const chip = document.querySelector(`[data-project-choice="${id}"]`);
      const panel = document.querySelector("[data-team-panel]");
      const scroll = document.querySelector("[data-team-scroll]");
      return {
        pressed: chip?.getAttribute("aria-pressed"),
        pending: chip?.getAttribute("data-project-pending"),
        chipText: chip?.innerText.replace(/\s+/g, " ").trim(),
        state: panel?.getAttribute("data-team-state"),
        busy: scroll?.getAttribute("aria-busy"),
        dimmed: scroll ? getComputedStyle(scroll).opacity : null,
        note: panel?.innerText.includes("switching to") ?? false,
      };
    }, target.id);
    const ackMs = Date.now() - t0;
    say(
      `F1 the chip acknowledges in one frame (${ackMs}ms)`,
      ack.pressed === "true" && ack.pending === "true" && ackMs < 150,
      JSON.stringify(ack),
    );
    say('F1 the panel says "switching"', ack.state === "switching", ack.state);
    say("F1 the rows dim while the previous project is still on screen", ack.dimmed === "0.45" && ack.busy === "true", `opacity ${ack.dimmed}, aria-busy ${ack.busy}`);
    say("F1 …and it says so in words", ack.note === true, `note rendered: ${ack.note}`);
    await shot(page, "01-f1-switching");

    await page.waitForFunction(
      () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 20000 },
    );
    const landedMs = Date.now() - t0;
    const after = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-team-row]").length,
      pressedId: document
        .querySelector('[data-project-choice][aria-pressed="true"]')
        ?.getAttribute("data-project-choice"),
      pending: document.querySelectorAll("[data-project-pending]").length,
    }));
    say(
      `F1 the new team lands on the click's own fetch (${landedMs}ms, was 6828ms)`,
      landedMs < 3000,
      `${before.rows} rows → ${after.rows} rows`,
    );
    say("F1 the pressed chip is the one clicked", after.pressedId === target.id, `${after.pressedId}`);
    say("F1 the pending marker is gone once it landed", after.pending === 0, `${after.pending}`);
    await shot(page, "02-f1-switched");

    /* The rest of the run stays on the project we just switched TO: it is this
       project's own tree (operator-visibility), which is the one with sub-agent
       rows in it — findings 4 and 5 need a sub-agent to click. Staying also
       proves the switch is durable rather than a flash. */
  }

  /* ══ FINDING 2 — the destructive direction is the guarded one ═══════════ */
  {
    const scopes = await page.evaluate(() =>
      [...document.querySelectorAll("[data-team-x]")].map((b) => {
        const row = b.closest("[data-team-row]");
        return {
          node: row?.getAttribute("data-node-id"),
          kind: row?.getAttribute("data-kind"),
          settled: row?.getAttribute("data-settled"),
          hides: b.getAttribute("data-x-hides"),
          confirms: b.getAttribute("data-x-confirms"),
          wider: b.getAttribute("data-x-wider-reach"),
          title: b.getAttribute("title"),
        };
      }),
    );
    say("F2 every ✕ declares its blast radius", scopes.length > 0 && scopes.every((s) => s.hides !== null), `${scopes.length} controls`);
    const operator = scopes.find((s) => s.kind === "operator");
    say(
      "F2 the manager's ✕ — the one that hid 165 rows — requires a confirm",
      operator && operator.confirms === "true" && operator.wider === "true",
      JSON.stringify(operator),
    );
    /* The manager row's TOOLTIP depends on whether it is settled: on a running
       manager the ✕ is terminate and says so. Assert whichever is true rather
       than the one that happened to be true on the first run — this chat starts
       and stops while the project works. */
    const managerTitleOk =
      operator?.settled === "true"
        ? (operator?.title ?? "").includes("cannot count")
        : (operator?.title ?? "").includes("Terminate this agent");
    say(
      `F2 …and its tooltip matches its actual job (settled=${operator?.settled})`,
      managerTitleOk,
      (operator?.title ?? "").slice(0, 90),
    );
    const leaves = scopes.filter((s) => s.hides === "1" && s.wider === null && s.settled === "true");
    say(
      "F2 a settled leaf still goes in one click (the cheap gesture is not taxed)",
      leaves.length > 0 && leaves.every((s) => s.confirms === "false"),
      `${leaves.length} leaves, all one-click`,
    );

    /* WHICH ROW THE CONFIRM IS DRIVEN ON. A settled row that hides more than
       itself, and never a running one: on a running row this control is
       terminate, and driving it for a screenshot is how this script cancelled
       Konrad'''s chat once already. `stubRunControlWrites` is the belt; this is the
       braces. */
    const target =
      scopes.find((s) => s.settled === "true" && Number(s.hides) > 1) ??
      scopes.find((s) => s.settled === "true" && s.wider === "true");
    if (!target) {
      say("F2 a settled cascading row was available to drive", false, "none in this tree");
    } else {
    say(`F2 driving the confirm on a settled row (${target.kind}, hides ${target.hides})`, true, target.node);

    /* The confirm, driven. First click on that row must NOT dismiss.
       The ✕'s own rectangle is recorded before and while armed: round 1355's
       finding #4 was an armed ✕ that GREW and slid out from under the pointer,
       so the trailing click drilled into a run instead. The confirm strip added
       this round sits BELOW the row's last line, which must leave line 1 — and
       therefore the button — exactly where it was. */
    const rowsBefore = await page.evaluate(() => document.querySelectorAll("[data-team-row]").length);
    const btnBefore = await page.evaluate((id) => {
      const b = document
        .querySelector(`[data-team-row][data-node-id="${id}"]`)
        ?.querySelector("[data-team-x]");
      const r = b.getBoundingClientRect();
      return `${Math.round(r.x)}x${Math.round(r.y)}x${Math.round(r.width)}x${Math.round(r.height)}`;
    }, target.node);
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-team-row][data-node-id="${id}"]`);
      row?.querySelector("[data-team-x]")?.click();
    }, target.node);
    await page.waitForTimeout(250);
    const armed = await page.evaluate(() => {
      const btn = document.querySelector('[data-team-x][data-confirm="armed"]');
      const strip = document.querySelector("[data-team-confirm-strip]");
      return {
        armedLabel: btn?.innerText.trim() ?? null,
        strip: strip?.innerText.replace(/\s+/g, " ").trim() ?? null,
        rows: document.querySelectorAll("[data-team-row]").length,
      };
    });
    say("F2 the first click arms instead of hiding", armed.rows === rowsBefore, `${rowsBefore} → ${armed.rows} rows`);
    say("F2 the armed ✕ asks a question", armed.armedLabel === "hide?", `“${armed.armedLabel}”`);
    say("F2 …and a strip states the cost in words", (armed.strip ?? "").includes("✕ again to confirm"), `“${armed.strip}”`);
    say("F2 no write left the browser on the first click", writes.length === 0, `${writes.length} writes`);
    const btnArmed = await page.evaluate((id) => {
      const b = document
        .querySelector(`[data-team-row][data-node-id="${id}"]`)
        ?.querySelector("[data-team-x]");
      const r = b.getBoundingClientRect();
      return `${Math.round(r.x)}x${Math.round(r.y)}x${Math.round(r.width)}x${Math.round(r.height)}`;
    }, target.node);
    say(
      "F2 arming does not move the ✕ out from under the pointer (round 1355 #4)",
      btnBefore === btnArmed,
      `${btnBefore} → ${btnArmed}`,
    );
    await shot(page, "03-f2-armed");

    /* Second click, after the 500ms floor: it dismisses, and the toast carries
       an undo of the whole gesture. */
    await page.waitForTimeout(650);
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-team-row][data-node-id="${id}"]`);
      row?.querySelector("[data-team-x]")?.click();
    }, target.node);
    await page.waitForTimeout(900);
    const afterDismiss = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-team-row]").length,
      toast: [...document.querySelectorAll("[data-toast-action]")].map((b) =>
        (b.parentElement?.innerText ?? "").replace(/\s+/g, " ").trim(),
      ),
      undoLabel: document.querySelector("[data-toast-action]")?.innerText.trim() ?? null,
    }));
    say("F2 the confirmed click hides the row", afterDismiss.rows < rowsBefore, `${rowsBefore} → ${afterDismiss.rows} rows`);
    say("F2 the toast offers an undo", afterDismiss.undoLabel === "undo", JSON.stringify(afterDismiss.toast));
    say(
      "F2 the dismiss POST cascaded (server's answer adopted)",
      writes.some((w) => w.kind === "dismiss" && w.dismissed.length === 3),
      JSON.stringify(writes),
    );
    await shot(page, "04-f2-dismissed-with-undo");

    await page.evaluate(() => document.querySelector("[data-toast-action]")?.click());
    await page.waitForTimeout(900);
    const afterUndo = await page.evaluate(() => ({
      rows: document.querySelectorAll("[data-team-row]").length,
    }));
    const restore = writes.find((w) => w.kind === "restore");
    say("F2 undo brings the rows back", afterUndo.rows === rowsBefore, `${afterDismiss.rows} → ${afterUndo.rows} rows`);
    say(
      "F2 …by restoring exactly the ids the gesture hid, not everything",
      restore && restore.ids.length === 3,
      JSON.stringify(restore),
    );
    await shot(page, "05-f2-undone");
    }
  }

  /* ══ FINDING 6 — the transcript says which half of the traffic it holds ══ */
  {
    const ledger = await page.evaluate(() => {
      const el = document.querySelector("[data-comms-ledger]");
      return el
        ? {
            text: el.innerText.replace(/\s+/g, " ").trim(),
            in: el.getAttribute("data-comms-in"),
            out: el.getAttribute("data-comms-out"),
            title: el.getAttribute("title"),
          }
        : null;
    });
    const cards = await page.evaluate(() => ({
      total: document.querySelectorAll("[data-comms-direction]").length,
      inbound: document.querySelectorAll('[data-comms-direction="in"]').length,
      outbound: document.querySelectorAll('[data-comms-direction="out"]').length,
    }));
    say("F6 the ledger line is rendered", ledger !== null, JSON.stringify(ledger?.text));
    say(
      "F6 its count matches the cards exactly",
      ledger && Number(ledger.in) === cards.inbound && Number(ledger.out) === cards.outbound,
      `ledger ${ledger?.in}/${ledger?.out} vs cards ${cards.inbound}/${cards.outbound}`,
    );
    say(
      "F6 the absent direction is named, not silently zero",
      (ledger?.text ?? "").includes("no outbound records"),
      ledger?.text,
    );
    say(
      "F6 the tooltip says WHERE those records live",
      (ledger?.title ?? "").includes("own thread") && (ledger?.title ?? "").includes("run-control-rules.ts"),
      (ledger?.title ?? "").slice(0, 120),
    );
    await shot(page, "06-f6-comms-ledger");
  }

  /* ══ FINDING 5 — the sub-agent breadcrumb says the name that was clicked ══ */
  {
    const sub = await page.evaluate(() => {
      const row = document.querySelector('[data-team-row][data-kind="subagent"]');
      if (!row) return null;
      const text = row.innerText.replace(/\s+/g, " ").trim();
      row.click();
      return { text, id: row.getAttribute("data-node-id") };
    });
    if (sub === null) {
      say("F5 a sub-agent row was available to click", false, "none in this tree");
    } else {
      await page.waitForSelector("[data-agent-chat-view]", { timeout: 20000 });
      await page.waitForTimeout(1500);
      const crumbs = await page.evaluate(() => {
        const el = document.querySelector("[data-nav-crumbs]");
        return {
          text: el?.innerText.replace(/\s+/g, " ").trim() ?? null,
          title: el?.getAttribute("title") ?? null,
          back: document.querySelector("[data-nav-back]")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        };
      });
      say("F5 the crumb no longer reads `sub-agent toolu_01`", !(crumbs.text ?? "").includes("toolu_01"), crumbs.text);
      say(
        "F5 it reads the name the row showed",
        (crumbs.text ?? "").length > 0 && sub.text.includes((crumbs.text ?? "").split("›").pop().trim().slice(0, 12)),
        `row “${sub.text.slice(0, 60)}” → crumb “${crumbs.text}”`,
      );
      say("F5 the id is still reachable, in the tooltip", (crumbs.title ?? "").includes(sub.id), (crumbs.title ?? "").slice(0, 120));
      await shot(page, "07-f5-subagent-crumb");

      /* ══ FINDING 4 — reload keeps the drill-in ═══════════════════════════ */
      const stored = await page.evaluate(() => ({
        nav: localStorage.getItem("forge.chat.navStack"),
        chat: localStorage.getItem("forge.chat.selected"),
      }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
      const afterReload = await page.evaluate(() => ({
        drilled: document.querySelector("[data-agent-chat-view]") !== null,
        subagent: document.querySelector("[data-agent-chat-view]")?.getAttribute("data-subagent-id") ?? null,
        depth: document.querySelector("[data-agent-chat-view]")?.getAttribute("data-depth") ?? null,
        back: document.querySelector("[data-nav-back]")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        crumbs: document.querySelector("[data-nav-crumbs]")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      }));
      say("F4 the drill-in survives F5", afterReload.drilled === true, JSON.stringify(afterReload));
      say("F4 …on the same sub-agent", afterReload.subagent === sub.id, `${afterReload.subagent}`);
      say("F4 …with the way back still there", (afterReload.back ?? "").includes("manager chat"), afterReload.back);
      say(
        "F4 the stored stack is what it was restored from",
        (stored.nav ?? "").includes(sub.id),
        (stored.nav ?? "").slice(0, 120),
      );
      await shot(page, "08-f4-after-reload");

      /* And +14s later it is still there — round 1872 found the view replaced by
         the manager thread at +6s, +14s and +22s. */
      await page.waitForTimeout(9000);
      const stillThere = await page.evaluate(
        () => document.querySelector("[data-agent-chat-view]") !== null,
      );
      say("F4 …still there 15s after the reload", stillThere === true, `drilled: ${stillThere}`);
    }
  }

  /* ══ FINDING 3 — every destination is reachable at 390×844 ══════════════ */
  {
    const phone = await ctx.newPage();
    await stubDismissalWrites(phone, writes);
    await stubRunControlWrites(phone, writes);
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
    await phone.waitForTimeout(3000);
    const strip = await phone.evaluate(() => {
      const menu = document.querySelector("[data-nav-menu]");
      const doc = document.documentElement;
      return {
        menu: menu !== null,
        menuLabel: menu?.getAttribute("aria-label") ?? null,
        current: document.querySelector("[data-nav-current]")?.innerText.trim() ?? null,
        overflowX: doc.scrollWidth - doc.clientWidth,
      };
    });
    say("F3 a menu button exists on the phone", strip.menu === true, `aria-label “${strip.menuLabel}”`);
    say("F3 the bar says where you are", (strip.current ?? "").length > 0, strip.current);
    say("F3 no horizontal page overflow", strip.overflowX <= 0, `${strip.overflowX}px`);
    await shot(phone, "09-f3-phone-bar");

    await phone.click("[data-nav-menu]");
    await phone.waitForSelector("[data-nav-menu-panel]", { timeout: 5000 });
    const sheet = await phone.evaluate(() => {
      const items = [...document.querySelectorAll("[data-nav-menu-item]")];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inside = items.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= vw && r.width > 0 && r.height >= 40;
      });
      return {
        count: items.length,
        keys: items.map((el) => el.getAttribute("data-nav-menu-item")),
        insideViewportWidth: inside.length,
        tallEnough: items.filter((el) => el.getBoundingClientRect().height >= 44).length,
        scrollable: document.querySelector("[data-nav-menu-backdrop]").scrollHeight >= vh - 1,
      };
    });
    say("F3 the sheet lists 18 destinations", sheet.count === 18, `${sheet.count}: ${sheet.keys.join(",")}`);
    say("F3 every one fits the 390px viewport", sheet.insideViewportWidth === sheet.count, `${sheet.insideViewportWidth}/${sheet.count}`);
    say("F3 every one is a 44px thumb target", sheet.tallEnough === sheet.count, `${sheet.tallEnough}/${sheet.count}`);
    say("F3 LIVE is in the list", sheet.keys.includes("live"), "");
    await shot(phone, "10-f3-phone-menu");

    /* The journey the tester could not complete: reach LIVE on a phone. */
    await phone.click('[data-nav-menu-item="live"]');
    await phone.waitForTimeout(3500);
    const live = await phone.evaluate(() => ({
      sheetClosed: document.querySelector("[data-nav-menu-panel]") === null,
      current: document.querySelector("[data-nav-current]")?.innerText.trim() ?? null,
      liveRows: document.querySelectorAll(".live-row").length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    say("F3 tapping LIVE closes the sheet and opens the panel", live.sheetClosed && live.current === "LIVE", JSON.stringify(live));
    say("F3 the LIVE panel actually renders rows on the phone", live.liveRows > 0, `${live.liveRows} rows`);
    say("F3 …with no horizontal overflow", live.overflowX <= 0, `${live.overflowX}px`);
    await shot(phone, "11-f3-phone-live");

    /* The /live ✕ carries the same guard as the team panel's. */
    const liveX = await phone.evaluate(() => {
      const all = [...document.querySelectorAll("[data-live-x]")].map((b) => ({
        hides: Number(b.getAttribute("data-x-hides")),
        confirms: b.getAttribute("data-x-confirms"),
        wider: b.getAttribute("data-x-wider-reach"),
        title: b.getAttribute("title") ?? "",
      }));
      return {
        count: all.length,
        first: all[0] ?? null,
        cascades: all.filter((x) => x.hides > 1 || x.wider === "true"),
        leaves: all.filter((x) => x.hides === 1 && x.wider !== "true"),
      };
    });
    say(
      "F2 the /live ✕ declares the same scope",
      liveX.count > 0 && liveX.first.hides >= 1 && liveX.first.title.includes("undo"),
      JSON.stringify(liveX.first),
    );
    say(
      "F2 …and guards the cascading ones there too",
      liveX.cascades.every((x) => x.confirms === "true"),
      `${liveX.cascades.length} cascading rows, ${liveX.cascades.filter((x) => x.confirms === "true").length} guarded`,
    );
    say(
      "F2 …while a /live leaf still goes in one click",
      liveX.leaves.every((x) => x.confirms === "false"),
      `${liveX.leaves.length} leaves`,
    );
    await phone.close();
  }

  /* Both themes (NFU1), on the manager chat, with a row ARMED — so one frame
     carries every surface this round touched: the switcher, the comms ledger,
     the armed ✕ and its confirm strip. Back out of the drilled view first, or
     the shot would show a sub-agent slice with none of them in it. */
  {
    await page.evaluate(() => document.querySelector("[data-nav-back]")?.click());
    await page.waitForTimeout(2500);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
        localStorage.setItem("forge.theme", t);
      }, theme);
      await page.waitForTimeout(500);
      const armedRow = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("[data-team-x]")].find(
          (b) =>
            b.getAttribute("data-x-confirms") === "true" &&
            b.closest("[data-team-row]")?.getAttribute("data-settled") === "true",
        );
        btn?.click();
        return btn?.closest("[data-team-row]")?.getAttribute("data-node-id") ?? null;
      });
      await page.waitForTimeout(500);
      const strip = await page.evaluate(
        () =>
          document.querySelector("[data-team-confirm-strip]")?.innerText.replace(/\s+/g, " ").trim() ??
          null,
      );
      say(
        `NFU1 ${theme}: the armed row and its strip render`,
        armedRow !== null && (strip ?? "").includes("confirm"),
        `${armedRow} — “${strip}”`,
      );
      await shot(page, `12-theme-${theme}`);
      // Let the 3s arm window lapse so the next theme starts from idle.
      await page.waitForTimeout(3200);
    }
  }

  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ base: BASE, chat: CHAT, writes, results }, null, 2),
  );
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURE(S)`} — ${results.length} checks, screenshots in ${OUT}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
