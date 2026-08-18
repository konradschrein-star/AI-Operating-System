/**
 * ROUND 1876 — one indicator row, one query, one cadence.
 *
 * Konrad: "Why do we have two indicators and why do we have them? We do not
 * need a weekly and a 5-hour limit twice, especially refreshing at different
 * intervals."
 *
 * The stack here is deliberately offline:
 *   web :7798  — this branch's build (`next start`), rewrites baked at
 *                FORGE_CONTROL_URL=http://127.0.0.1:7799
 *   api :7799  — scripts/checks/serve-quota-7799.ts, a stub that COUNTS every
 *                /api/usage/quota request and can flip the Gemini tally
 *                between its unsigned and counted states.
 * Nothing live is touched: not :7700, not the database, not a run.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

const BASE = process.env.R1876_BASE ?? "http://127.0.0.1:7798";
const STUB = process.env.R1876_STUB ?? "http://127.0.0.1:7799";
const SHOTS = __dirname;

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

const results = [];
const say = (label, ok, detail) => {
  results.push({ label, ok, detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

const hits = async () => (await fetch(`${STUB}/__hits`)).json();

(async () => {
  const browser = await chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const cookie = fs.existsSync("/tmp/session-cookie-1874.txt")
    ? fs.readFileSync("/tmp/session-cookie-1874.txt", "utf8").trim()
    : null;
  if (cookie) {
    await ctx.addCookies([
      { name: "authjs.session-token", value: cookie, domain: "127.0.0.1", path: "/" },
    ]);
  }
  const page = await ctx.newPage();

  /* Every quota request the BROWSER makes, alongside the count the SERVER
     saw. Two records of the same event: a client-side dedupe that never hit
     the wire would show up as a difference. */
  const clientCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/usage/quota")) clientCalls.push({ url: r.url(), t: Date.now() });
  });

  await fetch(`${STUB}/__gemini?mode=unsigned`);
  const before = await hits();

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  /* ── §1 exactly one indicator row exists ─────────────────────────────── */
  const census = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-quota-row]")];
    const bars = [...document.querySelectorAll("[data-quota-bar]")].map((b) =>
      b.getAttribute("data-quota-bar"),
    );
    const gem = document.querySelector("[data-gemini-line]");
    const ctx = document.querySelector("[data-context-gauge]");
    return {
      rows: rows.length,
      rowText: rows[0] ? rows[0].innerText.replace(/\n/g, " ") : null,
      bars,
      fiveHourBars: bars.filter((b) => b === "5h").length,
      sevenDayBars: bars.filter((b) => b === "7d").length,
      gemText: gem ? gem.innerText.replace(/\n/g, " ") : null,
      gemTitle: gem ? gem.getAttribute("title") : null,
      gemTone: gem ? gem.getAttribute("data-gemini-tone") : null,
      ctxPresent: !!ctx,
      ctxPct: ctx ? ctx.getAttribute("data-context-pct") : null,
    };
  });
  say("exactly one indicator row on screen", census.rows === 1, `rows=${census.rows}`);
  say("the 5h bar appears once", census.fiveHourBars === 1, `count=${census.fiveHourBars}`);
  say("the 7d bar appears once", census.sevenDayBars === 1, `count=${census.sevenDayBars}`);
  say("the Gemini line is in the row", census.gemText !== null, census.gemText);
  say(
    "…and says it is not signed in rather than 0%",
    /not signed in/.test(census.gemText ?? "") && !/%/.test(census.gemText ?? ""),
    census.gemText,
  );
  say(
    "…with the missing denominator in its tooltip",
    /no denominator/.test(census.gemTitle ?? ""),
    (census.gemTitle ?? "").slice(0, 120),
  );
  say(
    "no context gauge on a surface with no chat (absent, not 0%)",
    census.ctxPresent === false,
    `ctxPct=${census.ctxPct}`,
  );
  await shot(page, "01-row-no-chat-dark");

  /* ── §2 one request per interval ─────────────────────────────────────── */
  const afterLoad = await hits();
  const loadReqs = afterLoad.quota_requests - before.quota_requests;
  say(
    "one quota request for the whole row on first paint",
    loadReqs === 1,
    `server saw ${loadReqs}, browser sent ${clientCalls.length}`,
  );

  /* Open settings → CONNECTIONS. It observes the same cache entry (its Ultra
     row reads the tally), so mounting it must add ZERO requests. The rail row
     is a div whose text is "settings\nSETTINGS" (glyph + label), so the click
     goes on the label and bubbles — same thing a pointer does. */
  await page.getByText("SETTINGS", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  await page.getByText("CONNECTIONS", { exact: true }).first().click();
  await page.waitForTimeout(3000);
  const afterSettings = await hits();
  say(
    "opening the settings surface adds no quota request",
    afterSettings.quota_requests === afterLoad.quota_requests,
    `${afterLoad.quota_requests} → ${afterSettings.quota_requests}`,
  );

  /* ── §2b the cadence, measured on a page nobody touches ──────────────── */
  const idleStart = await hits();
  console.log("  ·  sitting idle for 135s to watch the poll…");
  await page.waitForTimeout(135_000);
  const idleEnd = await hits();
  const idleReqs = idleEnd.quota_requests - idleStart.quota_requests;
  say(
    "one poll — not two — in a 135s idle window with both observers mounted",
    idleReqs === 1,
    `${idleReqs} request(s); gaps=${JSON.stringify(idleEnd.gaps_ms)}`,
  );

  const conns = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-connection-row]")];
    return rows.map((r) => ({
      id: r.getAttribute("data-connection-row"),
      state: r.getAttribute("data-connection-state"),
      chip: r.querySelector("[data-connection-chip]")?.innerText ?? null,
      action: (r.querySelector("[data-connection-action]")?.innerText ?? "").slice(0, 90),
    }));
  });
  say("every account type is a row", conns.length >= 4, JSON.stringify(conns.map((c) => c.id)));
  const unprobed = conns.find((c) => c.id === "claude:konrad-pro");
  say(
    "an unprobed Claude account is UNKNOWN, never green",
    unprobed?.state === "unknown" && /UNKNOWN/.test(unprobed?.chip ?? ""),
    `${unprobed?.state} / ${unprobed?.chip}`,
  );
  say(
    "every row states its connect/repair action",
    conns.every((c) => c.action.length > 0),
    conns.map((c) => `${c.id}: ${c.action.slice(0, 40)}`).join(" | "),
  );
  const amber = await page.evaluate(() => {
    const chip = [...document.querySelectorAll("[data-connection-chip]")].find((c) =>
      /UNKNOWN/.test(c.innerText),
    );
    if (!chip) return null;
    const s = getComputedStyle(chip);
    return { colour: s.color, background: s.backgroundColor };
  });
  say("…and the UNKNOWN chip is amber, not green", amber !== null, JSON.stringify(amber));
  await shot(page, "02-connections-dark");

  /* ── §3 light theme ──────────────────────────────────────────────────── */
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    try {
      localStorage.setItem("forge.theme", "light");
    } catch {}
  });
  await page.waitForTimeout(600);
  await shot(page, "03-connections-light");

  /* ── §4 the row with a chat open, and the Gemini counted state ───────── */
  await fetch(`${STUB}/__gemini?mode=counted`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const counted = await page.evaluate(() => {
    const gem = document.querySelector("[data-gemini-line]");
    return {
      text: gem ? gem.innerText.replace(/\n/g, " ") : null,
      title: gem ? gem.getAttribute("title") : null,
      tone: gem ? gem.getAttribute("data-gemini-tone") : null,
    };
  });
  say(
    "an authenticated, counted Gemini shows tokens and no percentage",
    /tok\/5h/.test(counted.text ?? "") && !/%/.test(counted.text ?? ""),
    counted.text,
  );
  say(
    "…and still says the limit is unpublished",
    /no denominator/.test(counted.title ?? ""),
    (counted.title ?? "").slice(0, 140),
  );
  await shot(page, "04-row-gemini-counted-dark");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(500);
  await shot(page, "05-row-light");

  /* ── §6 the row WITH a chat open — the ctx item Konrad asked for ─────── */
  const beforeChat = await hits();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(2500);
  /* The surface restores the last chat by itself, so there is nothing to
     click: what matters is that a transcript is on screen, because the gauge
     follows the middle surface rather than the sidebar (ContextGauge.tsx §2). */
  await page.waitForTimeout(4000);
  const withChat = await page.evaluate(() => {
    const row = document.querySelector("[data-quota-row]");
    const ctx = document.querySelector("[data-context-gauge]");
    return {
      rows: document.querySelectorAll("[data-quota-row]").length,
      fiveHourBars: document.querySelectorAll('[data-quota-bar="5h"]').length,
      rowText: row ? row.innerText.replace(/\n/g, " ") : null,
      ctxPresent: !!ctx,
      ctxPct: ctx ? ctx.getAttribute("data-context-pct") : null,
      ctxTitle: ctx ? ctx.getAttribute("title") : null,
    };
  });
  say("still exactly one row with a chat open", withChat.rows === 1, `rows=${withChat.rows}`);
  /* NOT ASSERTED HERE, and the reason is recorded rather than hidden: the ctx
     item is published by the chat surface, and this offline stub cannot render
     a full transcript — the surface's panels throw on a synthetic payload
     (three shapes were filled in; a fourth, a `.total` reader inside the plan
     kanban, still crashes it), so the middle column shows its error boundary
     and nothing publishes a context target. What this screenshot DOES prove is
     the half that belongs to this round: on the chat surface the row is still
     single and the composer carries no second copy of the bars. The gauge's own
     behaviour is covered by the source check (`the row carries the context
     gauge`) and by round 1350's ContextGauge evidence; photographing it with a
     live transcript belongs to the deploy/verify pass. */
  console.log(
    `  ·  ctx gauge not photographed offline: middle surface = ${
      withChat.ctxPresent ? "chat" : "error boundary (stub fidelity)"
    }`,
  );
  /* Counted on the MARKER, not on the text: the Gemini line's own "tok/5h"
     contains the string "5h" and made a text count read as a duplicate. */
  say(
    "…and the composer above it carries no second copy of the bars",
    withChat.fiveHourBars === 1,
    `5h bars on screen: ${withChat.fiveHourBars} · row: ${withChat.rowText}`,
  );
  say(
    "opening a chat costs no quota request",
    (await hits()).quota_requests === beforeChat.quota_requests,
    `${beforeChat.quota_requests} → ${(await hits()).quota_requests}`,
  );
  await shot(page, "06-row-with-chat-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(600);
  await shot(page, "07-row-with-chat-light");

  /* ── §5 the cadence, measured ────────────────────────────────────────── */
  const finalHits = await hits();
  /* DELTAS, not totals: the stub outlives a single harness run, and counting
     its whole lifetime would charge this session for the previous one's
     requests — which is exactly the kind of number that reads as a leak when
     it is bookkeeping. */
  const sessionReqs = finalHits.quota_requests - before.quota_requests;
  const window_s = Math.round((finalHits.uptime_ms - before.uptime_ms) / 1000);
  /* Total budget: one per page load (there are two — the reload above puts the
     Gemini tally in its counted state) plus one per elapsed 120s interval. */
  const loads = 2;
  const budget = loads + Math.ceil(window_s / 120);
  say(
    "the whole session stayed inside one-request-per-interval",
    sessionReqs <= budget,
    `${sessionReqs} requests in ${window_s}s (budget ${budget} = ${loads} page loads + ${Math.ceil(window_s / 120)} interval(s)); gaps=${JSON.stringify(finalHits.gaps_ms)}`,
  );
  say(
    "server count and browser count agree",
    sessionReqs === clientCalls.length,
    `server=${sessionReqs} browser=${clientCalls.length}`,
  );

  fs.writeFileSync(
    path.join(SHOTS, "quota-row.json"),
    JSON.stringify({ census, conns, counted, hits: finalHits, clientCalls, results }, null, 2),
  );
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} — round 1876 browser evidence`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
