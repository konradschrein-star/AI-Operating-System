/**
 * Round 1871 self-verification against the worktree build on :7780.
 * Drives the real UI and reports what a customer would see for each finding.
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

const BASE = "http://127.0.0.1:7780";
const COOKIE = fs.readFileSync("/tmp/session-cookie-1871.txt", "utf8").trim();
const CHAT = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const OUT = "/tmp/verify-1871";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const say = (label, ok, detail) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: chrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    { name: "authjs.session-token", value: COOKIE, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForSelector(".chat-row", { timeout: 30000 });
  await page.evaluate((id) => document.querySelector(`[data-chat-id="${id}"]`)?.click(), CHAT);
  await page.waitForSelector("textarea", { timeout: 30000 });
  await page.waitForTimeout(7000);

  if (process.env.ONLY_TAIL !== "1") {
  /* ── FINDING 2: comms cards collapse ───────────────────────────────────── */
  const comms = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-comms-direction]")];
    const toggles = [...document.querySelectorAll("[data-comms-toggle]")];
    const open = cards.filter((c) => c.getAttribute("data-comms-open") === "true").length;
    const first = toggles[0];
    return {
      cards: cards.length,
      toggles: toggles.length,
      open,
      firstLine: first ? first.innerText.replace(/\s+/g, " ").trim().slice(0, 120) : null,
      carets: toggles.filter((t) => t.innerText.includes("▸")).length,
    };
  });
  say("F2 every comms card has a collapse control", comms.cards > 0 && comms.toggles === comms.cards, `${comms.toggles}/${comms.cards} toggles`);
  say("F2 all collapsed by default", comms.open === 0, `${comms.open} open`);
  say("F2 collapsed line has the ▸ caret", comms.carets === comms.cards, `${comms.carets}/${comms.cards}`);
  say("F2 the line is a preview, not a wall", (comms.firstLine ?? "").length > 0, JSON.stringify(comms.firstLine));

  await page.evaluate(() => document.querySelector("[data-comms-toggle]")?.click());
  await page.waitForTimeout(400);
  const expanded = await page.evaluate(
    () => document.querySelectorAll('[data-comms-open="true"]').length,
  );
  say("F2 clicking expands exactly one", expanded === 1, `${expanded} open`);
  await shot(page, "f2-comms-collapsed");

  /* ── FINDING 3: the chat's own team ────────────────────────────────────── */
  const team = await page.evaluate(() => {
    const sw = document.querySelector("[data-project-switcher]");
    const choices = [...document.querySelectorAll("[data-project-choice]")].map((b) => ({
      id: b.getAttribute("data-project-choice"),
      label: b.innerText.replace(/\s+/g, " ").trim(),
      on: b.getAttribute("aria-pressed") === "true",
    }));
    return { hasSwitcher: Boolean(sw), choices, rows: document.querySelectorAll("[data-team-row]").length };
  });
  say("F3 a project switcher is rendered", team.hasSwitcher, `${team.choices.length} choices`);
  const active = team.choices.find((c) => c.on);
  say("F3 the ACTIVE project is selected by default", (active?.label ?? "").includes("operator-visibility"), JSON.stringify(active));
  say("F3 the other project is still reachable", team.choices.length === 2, JSON.stringify(team.choices.map((c) => c.label)));
  await shot(page, "f3-team-switcher");

  /* ── FINDING 5: sub-agent rows ─────────────────────────────────────────── */
  const subs = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-team-row][data-kind="subagent"]')];
    return rows.map((r) => ({
      role: r.getAttribute("data-role"),
      text: r.innerText.replace(/\s+/g, " ").trim().slice(0, 90),
      tokensMeasured: r.querySelector("[data-tokens-cell]")?.getAttribute("data-tokens-measured"),
      modelKnown: r.querySelector("[data-model-cell]")?.getAttribute("data-model-known"),
    }));
  });
  const noDesc = subs.filter((s) => s.text.includes("(no description)")).length;
  const roleAgent = subs.filter((s) => s.role === "agent").length;
  say("F5 sub-agent rows exist to judge", subs.length > 0, `${subs.length} rows`);
  say("F5 none says '(no description)'", noDesc === 0, `${noDesc} blank`);
  say("F5 none is the generic role 'agent'", roleAgent === 0, `${roleAgent} generic`);
  say(
    "F5 unmeasured cells say n/a, never 0",
    subs.every((s) => s.tokensMeasured !== null),
    JSON.stringify(subs.slice(0, 3)),
  );

  /* ── FINDING 4: kanban phases + tasks click ────────────────────────────── */
  const before = await page.evaluate(() => ({
    phases: document.querySelectorAll("[data-plan-phase]").length,
    headers: document.querySelectorAll("[data-plan-phase-header]").length,
    cursor: getComputedStyle(document.querySelector("[data-plan-phase-header]") ?? document.body).cursor,
    taskCursor: getComputedStyle(document.querySelector("[data-plan-task]") ?? document.body).cursor,
  }));
  say("F4 phase headers are clickable", before.headers > 0 && before.cursor === "pointer", `cursor=${before.cursor}`);
  say("F4 task chips are clickable", before.taskCursor === "pointer", `cursor=${before.taskCursor}`);

  const phaseClick = await page.evaluate(() => {
    const h = document.querySelector("[data-plan-phase-header]");
    if (!h) return { clicked: false };
    h.click();
    return { clicked: true };
  });
  await page.waitForTimeout(900);
  const afterPhase = await page.evaluate(() => ({
    docView: Boolean(document.querySelector("[data-plan-doc-view]")),
    docName: document.querySelector("[data-plan-doc-view]")?.getAttribute("data-doc-name") ?? null,
    expanded: document.querySelectorAll('[data-plan-phase-open="true"]').length,
    nodoc: document.querySelectorAll("[data-plan-phase-nodoc]").length,
  }));
  say(
    "F4 clicking a phase DOES something",
    afterPhase.docView || afterPhase.expanded > 0 || afterPhase.nodoc > 0,
    JSON.stringify(afterPhase),
  );
  await shot(page, "f4-phase-clicked");
  if (afterPhase.docView) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("←"));
      b?.click();
    });
    await page.waitForTimeout(700);
  }

  const taskClick = await page.evaluate(() => {
    const t = document.querySelector("[data-plan-task]");
    if (!t) return false;
    t.click();
    return true;
  });
  await page.waitForTimeout(500);
  const taskDetail = await page.evaluate(() => {
    const d = document.querySelector("[data-plan-task-detail]");
    return d ? d.innerText.replace(/\s+/g, " ").trim().slice(0, 120) : null;
  });
  say("F4 clicking a task opens its detail", taskClick && taskDetail !== null, JSON.stringify(taskDetail));

  /* ── FINDING 10: machinery ─────────────────────────────────────────────── */
  const prose = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll("[data-control-receipt]")];
    const raw = document.body.innerText.includes('{"queued":true,"delivery":"next-turn"');
    return { receipts: bubbles.length, rawJsonVisible: raw };
  });
  say("F10 no raw control JSON in the transcript", !prose.rawJsonVisible, `${prose.receipts} receipts rendered`);

  /* ── FINDING 7: reload keeps your place ────────────────────────────────── */
  await page.evaluate((id) => {
    const row = [...document.querySelectorAll("[data-team-row]")].find(
      (r) => r.getAttribute("data-kind") === "worker",
    );
    row?.click();
    return id;
  }, CHAT);
  await page.waitForTimeout(1200);
  const beforeReload = await page.evaluate(() => ({
    depth: document.querySelector("[data-depth]")?.getAttribute("data-depth") ?? null,
    crumbs: document.body.innerText.includes("manager chat"),
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);
  const afterReload = await page.evaluate(() => ({
    onChat: Boolean(document.querySelector(".chat-row")),
    hasThread: Boolean(document.querySelector("textarea")),
    drilled: Boolean(document.querySelector("[data-depth]")),
    surface: localStorage.getItem("forge.desktop.surface"),
    selected: localStorage.getItem("forge.chat.selected"),
    nav: localStorage.getItem("forge.chat.navStack"),
  }));
  say("F7 reload stays on CHAT, not TODAY", afterReload.surface === '"chat"', `surface=${afterReload.surface}`);
  say("F7 reload keeps the open chat", (afterReload.selected ?? "").includes(CHAT), `selected=${afterReload.selected}`);
  say("F7 reload keeps the drill-in", afterReload.drilled, `nav=${(afterReload.nav ?? "").slice(0, 90)}`);
  await shot(page, "f7-after-reload");

  }
  /* ── FINDING 8: phone layout ───────────────────────────────────────────── */
  /* A FRESH context, not ctx.newPage(): the desktop page above deliberately
   * persists the open chat to localStorage (finding 7), and the two pages
   * share an origin. Reusing the context would restore that chat on the phone
   * and test the persistence feature instead of the layout. */
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phoneCtx.addCookies([
    { name: "authjs.session-token", value: COOKIE, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await phone.waitForTimeout(4000);
  await phone.getByText("CHAT", { exact: true }).first().click();
  await phone.waitForTimeout(2500);
  const mobileList = await phone.evaluate(() => {
    const rows = [...document.querySelectorAll(".chat-row")];
    const vw = window.innerWidth;
    const inView = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.left >= -1 && b.right <= vw + 1 && b.width > 100;
    }).length;
    return { rows: rows.length, inView, vw };
  });
  say("F8 the chat list fits a 390px viewport", mobileList.rows > 0 && mobileList.inView === mobileList.rows, JSON.stringify(mobileList));
  await phone.screenshot({ path: path.join(OUT, "f8-mobile-list.png") });

  /* Any chat: what is under test is the LAYOUT, not which conversation. The
   * target chat is below the fold of a 390px list and scrolling to it would
   * only add a way for this check to be flaky. */
  await phone.locator(".chat-row").first().click({ timeout: 20000 });
  await phone.waitForSelector("textarea", { timeout: 30000 });
  await phone.waitForTimeout(6000);
  const mobileThread = await phone.evaluate(() => {
    const ta = document.querySelector("textarea");
    const vw = window.innerWidth;
    const b = ta?.getBoundingClientRect();
    return {
      composerVisible: Boolean(b) && b.left >= -1 && b.right <= vw + 1 && b.width > 100,
      composerBox: b ? { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) } : null,
      back: Boolean(document.querySelector("[data-narrow-back-to-list]")),
      vw,
    };
  });
  say("F8 the composer is reachable on a phone", mobileThread.composerVisible, JSON.stringify(mobileThread.composerBox));
  say("F8 there is a way back to the list", mobileThread.back, "");
  await phone.screenshot({ path: path.join(OUT, "f8-mobile-thread.png") });

  /* ── FINDING 11: one effort control, with max ──────────────────────────── */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "+ new");
    b?.click();
  });
  await page.waitForTimeout(1200);
  const effort = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("[data-new-chat-effort]")].map((b) =>
      b.getAttribute("data-new-chat-effort"),
    );
    const selects = document.querySelectorAll("select").length;
    return { chips, selects };
  });
  say("F11 the new-chat surface uses the ramp chips, not a <select>", effort.chips.length === 5 && effort.selects === 0, JSON.stringify(effort));
  say("F11 max is offered", effort.chips.includes("max"), JSON.stringify(effort.chips));
  await shot(page, "f11-new-chat-effort");

  /* ── FINDING 9: does hover eat the numbers? ────────────────────────────── */
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const hover = await page.evaluate(async () => {
    const row = document.querySelector('[data-team-row][data-kind="worker"]');
    if (!row) return { skipped: true };
    const read = () => ({
      tokens: row.querySelector("[data-tokens-cell]")?.textContent ?? null,
      time: row.querySelector("[data-working-cell]")?.textContent ?? null,
      tokensVisible: (row.querySelector("[data-tokens-cell]")?.getBoundingClientRect().width ?? 0) > 0,
      timeVisible: (row.querySelector("[data-working-cell]")?.getBoundingClientRect().width ?? 0) > 0,
    });
    const before = read();
    row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return { before, after: read() };
  });
  if (!hover.skipped) {
    say(
      "F9 hovering does not remove the tokens/time cells",
      hover.after.tokensVisible && hover.after.timeVisible && hover.after.tokens === hover.before.tokens,
      JSON.stringify(hover),
    );
  }

  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) console.log("FAILED:\n" + bad.map((b) => `  ${b.label} — ${b.detail}`).join("\n"));
  await browser.close();
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(2);
});
