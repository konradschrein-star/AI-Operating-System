/**
 * capture-700.cjs — phase 700's both-theme evidence, at 1440x900.
 *
 * Five views × dark and light = ten PNGs beside this file. Committed together
 * with the script, so a reviewer re-runs one command rather than trusting a
 * picture:
 *
 *   1. `surface`   the whole chat surface with BOTH zones populated
 *   2. `kanban`    the plan zone close-up
 *   3. `card`      the zone scrolled deep into the corpus, so a phase card that
 *                  is not the first one is on screen with its chips
 *   4. `plandoc`   the plan-doc reader with markdown rendered
 *   5. `docerror`  the plan-doc error state
 *
 * ── On "a phase card expanded/scrolled" ──────────────────────────────────
 * There is no expand affordance on a phase card and this round did not add
 * one: `PhaseCard` renders every chip in its block, always (PlanKanban.tsx).
 * So view 3 is the SCROLLED half of that phrase, and it is labelled `card` and
 * described honestly rather than dressed up as an interaction that does not
 * exist. The JSON records which block ended up on screen.
 *
 * ── Both themes for real ─────────────────────────────────────────────────
 * `document.documentElement.dataset.theme` is the actual switch — dark lives on
 * `:root` and light is opt-in via `html[data-theme="light"]` (app/theme.css:85,
 * set by `setThemeMode` in app/tokens.ts:103). Each shot samples the computed
 * background colour afterwards and the JSON carries it, so "the light shots are
 * really light" is a recorded measurement, not an assurance. The two sampled
 * values must differ, or the capture fails.
 *
 * Run:
 *   PHASE700_BASE_URL=http://127.0.0.1:7809 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)" \
 *     node docs/plan/artifacts/phase700/capture-700.cjs
 */

const path = require("node:path");
const {
  BASE,
  OUT_DIR,
  VIEWPORT,
  api,
  finish,
  makeChecker,
  openChat,
  resolveChat,
  waitForAttr,
  watchErrors,
  withBrowser,
} = require("./lib-703.cjs");

const { results, check, note, failed } = makeChecker();

/** Same bogus name nav-walk-700.cjs uses, for the same reason and by the same
 *  single interception of `/plan`. The two artifacts are then talking about
 *  the same error. */
const BOGUS_DOC = "zz-no-such-plan-doc-703.md";

const shots = [];

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(500);
}

/** One PNG plus the fact that proves the theme took. `locator` null = full page. */
async function shoot(page, name, theme, locator) {
  const file = `phase700-703-${name}-${theme}.png`;
  const bg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor,
  );
  const target = locator ?? page;
  await target.screenshot({ path: path.join(OUT_DIR, file) });
  shots.push({ name, theme, file, sampled_background: bg });
  console.log(`      shot ${file}  bg=${bg}`);
  return bg;
}

/** Both themes of one view, restoring dark afterwards so the next view starts
 *  from the app's default. */
async function bothThemes(page, name, locator) {
  const dark = await shoot(page, name, "dark", locator);
  await setTheme(page, "light");
  const light = await shoot(page, name, "light", locator);
  await setTheme(page, "dark");
  check(`${name}: the two themes render different backgrounds`, dark !== light, true);
}

async function main() {
  const chatRow = await resolveChat();
  const plan = await api(`/api/chat/${chatRow.id}/plan`);
  note("chat", { id: chatRow.id, title: chatRow.title });
  note("viewport", VIEWPORT);

  await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await openChat(page);

    /* ── 1: the whole surface, both zones populated ──────────────────────── */
    const populated = await page.evaluate(() => ({
      plan_state: document.querySelector("[data-plan-kanban]")?.getAttribute("data-plan-state"),
      progress: document.querySelector("[data-plan-kanban]")?.getAttribute("data-plan-progress"),
      cards: document.querySelectorAll("[data-plan-phase]").length,
      chips: document.querySelectorAll("[data-plan-task]").length,
      team_rows: document.querySelectorAll("[data-team-row]").length,
    }));
    note("both zones at capture time", populated);
    check("the plan zone is populated for the shot", populated.cards > 0 && populated.chips > 0, true);
    check("the team zone is populated for the shot", populated.team_rows > 0, true);
    await bothThemes(page, "surface", null);

    /* ── 2: the plan zone close-up ───────────────────────────────────────── */
    await bothThemes(page, "kanban", page.locator("[data-plan-kanban]"));

    /* ── 3: scrolled deep into the corpus ────────────────────────────────── */
    const onScreen = await page.evaluate(() => {
      const s = document.querySelector("[data-plan-scroll]");
      s.scrollTop = Math.round(s.scrollHeight * 0.45);
      return null;
    });
    void onScreen;
    await page.waitForTimeout(600);
    const visibleCards = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-plan-phase]"))
        .filter((c) => {
          const r = c.getBoundingClientRect();
          const s = document.querySelector("[data-plan-scroll]").getBoundingClientRect();
          return r.bottom > s.top && r.top < s.bottom;
        })
        .map((c) => `${c.getAttribute("data-plan-phase")} (${c.getAttribute("data-plan-phase-progress")})`),
    );
    note("blocks on screen in the scrolled shot", visibleCards);
    check("the scrolled shot is not still showing the first block", visibleCards[0]?.startsWith("0 ") ?? false, false);
    await bothThemes(page, "card", page.locator("[data-plan-kanban]"));
    await page.evaluate(() => {
      document.querySelector("[data-plan-scroll]").scrollTop = 0;
    });
    await page.waitForTimeout(400);

    /* ── 4: the plan-doc reader ──────────────────────────────────────────── */
    const target = plan.docs[plan.docs.length - 1];
    await page.click(`[data-plan-docs] [data-plan-doc="${target}"]`);
    await page.waitForSelector("[data-plan-doc-view]", { timeout: 15_000 });
    await waitForAttr(page, "[data-plan-doc-view] [data-doc-state]", "data-doc-state", "ready", 20_000);
    const docFacts = await page.evaluate(() => ({
      name: document.querySelector("[data-plan-doc-view]")?.getAttribute("data-doc-name"),
      headings: document.querySelectorAll("[data-plan-doc-view] [data-doc-state] h1, [data-plan-doc-view] [data-doc-state] h2").length,
    }));
    note("plan doc shot", docFacts);
    check("the doc shot has rendered markdown headings in it", docFacts.headings > 0, true);
    await bothThemes(page, "plandoc", null);
    await page.click("[data-plan-doc-view] [data-nav-back]");
    await page.waitForTimeout(1_200);

    /* ── 5: the error state ──────────────────────────────────────────────── */
    /* The one interception, declared exactly as nav-walk-700.cjs declares it:
     * `/plan`'s docs[] gains a name the server will refuse, so the reader can
     * be sent somewhere that 404s. `/plan/doc` is NOT intercepted — the
     * sentence in the screenshot is the real server's. */
    await ctx.route("**/api/proxy/chat/*/plan", async (route) => {
      const response = await route.fetch();
      let body;
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      if (!Array.isArray(body?.docs)) return route.fulfill({ response });
      body.docs = [...body.docs, BOGUS_DOC];
      return route.fulfill({ response, body: JSON.stringify(body) });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(`[data-plan-docs] [data-plan-doc="${BOGUS_DOC}"]`, { timeout: 30_000 });
    await page.click(`[data-plan-docs] [data-plan-doc="${BOGUS_DOC}"]`);
    await page.waitForSelector("[data-plan-doc-view]", { timeout: 15_000 });
    await waitForAttr(page, "[data-plan-doc-view] [data-doc-state]", "data-doc-state", "error", 20_000);
    const errText = await page.evaluate(
      () => document.querySelector("[data-plan-doc-view] [data-doc-state]")?.textContent?.trim() ?? "",
    );
    note("error state text in the shot", errText);
    check("the shot shows the server's own sentence", errText, `no such plan document: ${BOGUS_DOC}`);
    await bothThemes(page, "docerror", null);
    await ctx.unroute("**/api/proxy/chat/*/plan");

    note("failed requests", errs.failedRequests);
    const unexpected = errs.consoleErrors.filter((l) => !l.includes(BOGUS_DOC));
    check("console errors other than the deliberate 404", unexpected, []);
  });

  check("ten PNGs were written (5 views x 2 themes)", shots.length, 10);

  finish(
    "capture-700.json",
    {
      base: BASE,
      viewport: VIEWPORT,
      chat: { id: chatRow.id, title: chatRow.title },
      bogus_doc: BOGUS_DOC,
      shots,
      results,
      verdict: failed() === 0 ? "PASS" : "FAIL",
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
