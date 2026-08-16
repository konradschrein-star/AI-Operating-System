/**
 * capture-800.cjs — PROTOCOL 4, round 804: the state matrix, in both themes.
 *
 * Seven views × two themes = 14 PNGs at 1440×900, named
 * `phase800-<view>-<theme>.png`, each one recorded with the background colour
 * sampled off `document.body` at the moment of the shot. Modelled on
 * phase700's `capture-700.cjs`, including its theme mechanism: the app's own
 * `document.documentElement.dataset.theme` (`app/theme.css:85`,
 * `app/tokens.ts:103`), never a stylesheet override — a screenshot taken under
 * a fake theme proves nothing about the real one.
 *
 *   composer-min      the composer at its 2-row resting height
 *   composer-cap      the composer at the 10-row cap, scrolling internally
 *   engine-ramp       EngineControls open, all four effort levels visible
 *   secret-badge      the secret button carrying its pending badge
 *   secret-answer     SecretField in ANSWER mode, showing the agent's note
 *   secret-freeform   SecretField in FREE-FORM mode
 *   canvas            the canvas open beside the thread
 *
 * ── WHY THE RAMP IS ASSERTED AND NOT JUST PHOTOGRAPHED ────────────────────
 *
 * U29's claim is that a reader can tell the expensive end of the effort row
 * from the cheap end WITHOUT a legend — and Konrad's standing complaint about
 * this console is that things "still don't work in light mode". A screenshot
 * cannot fail. So this protocol reads the four chips' computed colours in each
 * theme and asserts that all four are DISTINCT in both, and that the ramp
 * actually changes between themes rather than being one hardcoded palette
 * wearing two labels. The PNGs are the illustration; these checks are the
 * evidence.
 *
 * Run (README.md §2):
 *   FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7817 \
 *   PHASE700_API_URL=http://127.0.0.1:7814 node capture-800.cjs [--write]
 */

const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib-804.cjs");

const THEMES = ["dark", "light"];

/**
 * The drawing the canvas shot opens.
 *
 * The pane remembers `{open, path}` per run in `localStorage` under
 * `forge.canvasByRun` (ChatSurface.tsx:492-510). A fresh browser context
 * remembers nothing, so clicking CANVAS gives a pane with no drawing selected
 * and `<Excalidraw>` never mounts — which is exactly how this protocol's first
 * run failed, on a 45 s wait for `.excalidraw`. Seeding the same key that the
 * app itself writes is what makes "the canvas open" mean the editor is up.
 *
 * Same drawing round 801 chose, and for the same reason: at 531 bytes it is
 * the smallest real canvas in the vault, so the shot shows the editor rather
 * than somebody's 500 KB scene.
 */
const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ?? "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";
const SECRET_NAME = "p800-804-capture-key";
const REQUEST_NOTE =
  "the vps2 rsync leg needs the deploy key for ubuntu-16gb-nbg1-3-SK — paste the private key issued on 2026-08-02.";

async function apiJson(method, pathname, body) {
  const r = await fetch(`${L.API}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${pathname} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const { check, note, results, failed } = L.makeChecker();
  const started_at = new Date().toISOString();
  const chat = await L.resolveChat();
  const shots = [];
  const ramps = {};

  /** Take the shot, sample the background, record both. */
  const shoot = async (page, view, theme) => {
    const file = `phase800-${view}-${theme}.png`;
    const out = path.join(L.OUT_DIR, file);
    await page.screenshot({ path: out });
    const bg = await L.sampleBackground(page);
    const bytes = fs.statSync(out).size;
    shots.push({ view, theme, file, background: bg.body, theme_attr: bg.theme, bytes });
    check(`${view}/${theme} — the PNG was written and is non-trivial`, bytes > 10_000, true);
    check(`${view}/${theme} — the app's own theme attribute is set`, bg.theme, theme);
    return bg.body;
  };

  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = L.watchErrors(page);

    /* Seed the canvas memory — see SEED_PATH. `open: false` so the toggle
     * click below is genuinely an OPEN, the same convention canvas-open.cjs
     * uses. Re-applied on every navigation, which keeps each theme's canvas
     * shot starting from the identical state. */
    await page.addInitScript(
      ({ key, id, p }) => {
        try {
          localStorage.setItem(key, JSON.stringify({ [id]: { open: false, path: p } }));
        } catch {
          /* about:blank may deny localStorage; the real origin does not */
        }
      },
      { key: "forge.canvasByRun", id: chat.id, p: SEED_PATH },
    );

    for (const theme of THEMES) {
      /* ── A. the pending-request states ──────────────────────────────── */
      await apiJson("DELETE", `/api/secrets/${SECRET_NAME}`);
      await apiJson("POST", "/api/secrets", {
        name: SECRET_NAME,
        value: "unanswered-placeholder-804",
        note: REQUEST_NOTE,
      });
      await apiJson("POST", `/api/secrets/${SECRET_NAME}/mark-pending`, {
        requested_by_run_id: chat.id,
      });

      await L.openChat(page);
      await L.setTheme(page, theme);

      /* answer mode — the panel auto-opened, no click was issued */
      const submit = await L.resolveOne(page, "secret-submit");
      check(`secret-answer/${theme} — the panel is in ANSWER mode`, await submit.handle.evaluate((el) => el.textContent), "answer request");
      check(
        `secret-answer/${theme} — the agent's note is on screen`,
        await page.evaluate((n) => document.body.innerText.includes(n), REQUEST_NOTE),
        true,
      );
      await shoot(page, "secret-answer", theme);

      /* badge only — close the panel; the server flag is still pending */
      const secretBtn = await L.resolveOne(page, "secret-button");
      await secretBtn.handle.click();
      await page.waitForTimeout(600);
      const badgeText = await secretBtn.handle.evaluate((el) => el.textContent);
      check(`secret-badge/${theme} — the badge survives closing the panel`, badgeText, "secret1");
      await shoot(page, "secret-badge", theme);

      /* ── B. the no-request states ───────────────────────────────────── */
      await apiJson("DELETE", `/api/secrets/${SECRET_NAME}`);
      await L.openChat(page);
      await L.setTheme(page, theme);

      const composer = await L.resolveOne(page, "composer-input");
      await L.clearComposer(page, composer.handle);
      const minBox = await L.readBox(composer.handle);
      check(`composer-min/${theme} — the composer is at its resting height`, minBox.offsetHeight, 61);
      await shoot(page, "composer-min", theme);

      await L.typeLines(page, composer.handle, 25, "the quick brown fox");
      const capBox = await L.readBox(composer.handle);
      check(`composer-cap/${theme} — the composer is at the 10-row cap`, capBox.offsetHeight, 217);
      check(`composer-cap/${theme} — and it is scrolling internally`, capBox.scrollbarPresent, true);
      await shoot(page, "composer-cap", theme);
      await L.clearComposer(page, composer.handle);

      /* the effort ramp, opened and MEASURED */
      const engine = await L.resolveOne(page, "engine-controls");
      await engine.handle.click();
      await page.waitForTimeout(500);
      const ramp = await page.evaluate(() => {
        const levels = ["low", "medium", "high", "xhigh"];
        const out = {};
        for (const el of Array.from(document.querySelectorAll("button"))) {
          const t = (el.textContent || "").trim();
          if (!levels.includes(t)) continue;
          const cs = getComputedStyle(el);
          out[t] = { color: cs.color, borderColor: cs.borderTopColor, background: cs.backgroundColor };
        }
        return out;
      });
      ramps[theme] = ramp;
      check(`engine-ramp/${theme} — all four effort levels are on screen`, Object.keys(ramp).sort(), ["high", "low", "medium", "xhigh"]);

      /* THE RAMP LIVES ON THE BORDER, AND THE FIRST VERSION OF THIS CHECK
       * LOOKED AT THE WRONG PROPERTY. It asserted four distinct TEXT colours
       * and measured two, which reads like a U29 defect and is not one:
       * `ChatSurface.tsx:1426` sets `color: on ? ramp.fg : tokens.textMuted`,
       * so exactly one chip — the selected one — wears the ramp in its text,
       * and the other three are deliberately muted. The ramp is carried on
       * `border: 1px solid ${ramp.border}`, unconditionally, for all four.
       * That is what the source comment at :1409-1412 says it does, and it is
       * what the ramp's own file says it does (effort-ramp.ts:30-33).
       *
       * So the distinctness assertion belongs on the BORDER, and the text
       * colours are recorded rather than gated. */
      const borders = Object.values(ramp).map((r) => r.borderColor);
      check(`engine-ramp/${theme} — all four ramp BORDER colours are DISTINCT`, new Set(borders).size, 4);
      const fgs = Object.values(ramp).map((r) => r.color);
      note(`engine-ramp/${theme} — chip text colours (one ramped, three muted by design)`, fgs);
      check(
        `engine-ramp/${theme} — exactly one chip wears the ramp in its text (the selected one)`,
        new Set(fgs).size,
        2,
      );
      await shoot(page, "engine-ramp", theme);
      await page.keyboard.press("Escape");
      await page.mouse.click(700, 400);
      await page.waitForTimeout(400);

      /* free-form mode — nothing pending, so clicking gives the plain panel */
      const secretBtn2 = await L.resolveOne(page, "secret-button");
      check(
        `secret-freeform/${theme} — no badge is showing`,
        await secretBtn2.handle.evaluate((el) => el.textContent),
        "secret",
      );
      await secretBtn2.handle.click();
      await page.waitForTimeout(700);
      const submit2 = await L.resolveOne(page, "secret-submit");
      check(`secret-freeform/${theme} — the panel is in FREE-FORM mode`, await submit2.handle.evaluate((el) => el.textContent), "store secret");
      await shoot(page, "secret-freeform", theme);
      await secretBtn2.handle.click();
      await page.waitForTimeout(400);

      /* the canvas */
      const toggle = await L.resolveOne(page, "canvas-toggle");
      await toggle.handle.click();
      await page.waitForSelector(".excalidraw", { timeout: 45_000 });
      await page.waitForTimeout(2_500);
      const paneCount = await page.locator(".excalidraw").count();
      check(`canvas/${theme} — the Excalidraw editor is mounted`, paneCount >= 1, true);
      await shoot(page, "canvas", theme);
      await toggle.handle.click();
      await page.waitForTimeout(600);
    }

    note("console errors", errs.consoleErrors);
    check("no console error across the whole capture", errs.consoleErrors.length, 0);
  });

  /* ── the two themes must actually differ ─────────────────────────────── */
  const byView = {};
  for (const s of shots) (byView[s.view] ??= {})[s.theme] = s.background;
  for (const [view, bgs] of Object.entries(byView)) {
    check(`${view} — dark and light sample DIFFERENT backgrounds`, bgs.dark !== bgs.light, true);
  }
  check(
    "the effort ramp is not one hardcoded palette in both themes",
    JSON.stringify(ramps.dark) !== JSON.stringify(ramps.light),
    true,
  );
  note("effort ramp, measured per theme", ramps);
  check("14 PNGs were written", shots.length, 14);

  L.finish800(
    "capture-800.json",
    {
      protocol: "PROTOCOL 4 — both themes + the state matrix",
      started_at,
      finished_at: new Date().toISOString(),
      base_url: L.BASE,
      api_url: L.API,
      viewport: L.VIEWPORT,
      theme_mechanism: "document.documentElement.dataset.theme — the app's own (app/theme.css:85)",
      shots,
      effort_ramp_by_theme: ramps,
      checks: results,
      failures: failed(),
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(`\nFATAL  ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
