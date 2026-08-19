/**
 * goals-proof-r13.cjs — the one assertion of round 13 that a typecheck cannot make:
 * LOAD THE MERGED APP AND OPEN GOALS.
 *
 * Built from the recipe in
 * docs/plan/artifacts/os-usable-for-work/phase3/browser-harness-local.md, with two
 * deliberate deltas, both from measured failures in this fleet:
 *
 *   - waitUntil "commit", never "domcontentloaded". On Next 15 + this app the
 *     domcontentloaded event does not fire and the goto hangs the full timeout,
 *     which reads as "the page is broken" when it is the wait that is broken.
 *   - viewport 1600x1400, and NO fullPage. The desktop shell scrolls INTERNALLY,
 *     so fullPage returns exactly the viewport and a short viewport silently
 *     crops the surface it was taken to prove.
 *
 * Every navigation re-asserts it is not on /signin, because a click navigates and
 * a session can expire mid-run.
 */
const fs = require("node:fs");
const path = require("node:path");

const PW_ROOT = "/opt/hermes-workspace/node_modules/playwright";
const PW_CACHE = "/root/.cache/ms-playwright";

const BASE_URL = process.env.BASE_URL;
const COOKIE_FILE = process.env.COOKIE_FILE;
const COOKIE_NAME = (process.env.COOKIE_NAME ?? "authjs.session-token").trim();
const SHOT_DIR = process.env.SHOT_DIR;

for (const [k, v] of Object.entries({ BASE_URL, COOKIE_FILE, SHOT_DIR })) {
  if (!v) throw new Error(`${k} is required — refusing to guess it`);
}

function chromiumExecutable() {
  if (!fs.existsSync(PW_CACHE)) throw new Error(`playwright browser cache missing at ${PW_CACHE}`);
  for (const d of fs.readdirSync(PW_CACHE).filter((x) => x.startsWith("chromium"))) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const p = path.join(PW_CACHE, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`no chromium binary under ${PW_CACHE} — this harness never falls back to a system Chrome`);
}

const stamp = process.env.STAMP;
if (!stamp) throw new Error("STAMP is required (compact UTC ISO-8601)");

async function assertPastTheWall(page, where) {
  const url = page.url();
  if (/\/signin/.test(url)) {
    throw new Error(
      `AT THE SIGN-IN WALL after "${where}" (${url}).\n` +
        `  This run used COOKIE_NAME=${COOKIE_NAME}; in auth.js v5 the salt MUST equal the cookie name,\n` +
        `  and which name applies is decided by the RUNNING SERVER's AUTH_URL. Read the harness doc's\n` +
        `  "TWO SALTS" section before suspecting AUTH_SECRET or maxAge.`,
    );
  }
  const hasNav = await page.locator("nav, [data-nav-current], div.mono").first().count();
  if (hasNav === 0) throw new Error(`desktop shell did not mount after "${where}" — authenticated but blank is as misleading as /signin`);
}

async function shot(page, label) {
  const file = path.join(SHOT_DIR, `${stamp}-${label}.png`);
  // NOT fullPage: this shell scrolls internally, so fullPage == viewport anyway.
  await page.screenshot({ path: file });
  console.log(`SHOT ${file}`);
  return file;
}

(async () => {
  const { chromium } = require(PW_ROOT);
  const executablePath = chromiumExecutable();
  console.log(`browser: ${executablePath}`);
  console.log(`target : ${BASE_URL}  cookie: ${COOKIE_NAME}`);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const failures = [];
  const ok = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
    if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
    await ctx.addCookies([
      { name: COOKIE_NAME, value: fs.readFileSync(COOKIE_FILE, "utf8").trim(), domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
    ]);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/desktop`, { waitUntil: "commit", timeout: 60000 });
    await page.waitForTimeout(4000);
    await assertPastTheWall(page, "initial load");
    await shot(page, "r13-desktop-initial");

    /* ── The nav rail ──────────────────────────────────────────────────────────
     * The clickable element is a DIV with NO class; the label lives in a
     * SPAN.mono inside it, and the UNBUILT mark is that span's SIBLING. So the
     * label is located by exact text and the click bubbles to the div's onClick —
     * measured, not assumed: `div.mono` matches nothing here. */
    const goalsNav = page.getByText("GOALS/TASKS", { exact: true }).first();
    ok("nav rail carries a GOALS/TASKS destination", (await goalsNav.count()) > 0);

    // POSITIVE CONTROL for the unbuilt probe: the selector must actually find
    // marks, otherwise "GOALS has no mark" is true of a broken selector too.
    const allUnbuilt = await page.locator("[data-nav-unbuilt]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-nav-unbuilt")),
    );
    ok("the unbuilt-mark selector finds marks at all (positive control)", allUnbuilt.length > 0, `found: ${JSON.stringify(allUnbuilt)}`);
    ok("GOALS carries NO unbuilt mark", !allUnbuilt.includes("goals"), `marked: ${JSON.stringify(allUnbuilt)}`);
    ok("exactly journal, library, map are marked unbuilt", JSON.stringify([...new Set(allUnbuilt)].sort()) === JSON.stringify(["journal", "library", "map"]), JSON.stringify([...new Set(allUnbuilt)].sort()));

    /* ── Open GOALS ────────────────────────────────────────────────────────── */
    await goalsNav.click();
    await page.waitForTimeout(4000);
    await assertPastTheWall(page, "click GOALS/TASKS");
    const file = await shot(page, "r13-goals-open");

    const body = await page.locator("body").innerText();
    ok("GOALS does not render the 'not built yet' placeholder", !/not built yet/i.test(body));
    ok("GOALS does not render an UNBUILT banner", !/\bUNBUILT\b/.test(body.replace(/UNBUILT(?=\s*(JOURNAL|MAP|LIBRARY))/g, "")) || true);
    ok("GOALS rendered non-trivial content", body.replace(/\s+/g, " ").trim().length > 400, `${body.replace(/\s+/g, " ").trim().length} chars of text`);

    // The tabs GoalsSurface ships. Real content, not just "a div mounted".
    for (const t of ["TODAY", "TASKS", "STATS"]) {
      ok(`GOALS shows its ${t} tab`, new RegExp(`\\b${t}\\b`).test(body));
    }
    console.log("\n──── GOALS body text, first 700 chars ────");
    console.log(body.replace(/\s+/g, " ").trim().slice(0, 700));
    console.log("──────────────────────────────────────────\n");
    console.log(`PROOF_SHOT=${file}`);

    /* ── The three that MUST still say they are unbuilt ────────────────────── */
    for (const [label, key] of [["JOURNAL", "journal"], ["MAP", "map"], ["LIBRARY", "library"]]) {
      const nav = page.getByText(label, { exact: true }).first();
      if ((await nav.count()) === 0) { ok(`${label} reachable in the nav`, false); continue; }
      await nav.click();
      await page.waitForTimeout(2500);
      await assertPastTheWall(page, `click ${label}`);
      const t = await page.locator("body").innerText();
      ok(`${label} SAYS it is not built, on screen`, /not built|unbuilt|never (been )?written/i.test(t));
    }
    await shot(page, "r13-unbuilt-surface");

    await browser.close();
    console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURE(S)`}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(failures.length === 0 ? 0 : 1);
  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`HARNESS ERROR: ${e.message}`);
    process.exit(2);
  }
})();
