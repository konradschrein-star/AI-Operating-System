/**
 * canvas-theme.cjs — does the canvas actually work in light mode now?
 *
 * PHASE 800, round 806. Round 804 reported two light-mode defects in
 * CanvasPane and shot `phase800-canvas-light.png` as evidence of one of them:
 * a black Excalidraw editor filling the right-hand half of a light console,
 * because `theme="dark"` was passed as a literal. Round 806 fixed it. This
 * file is what proves the fix, and it is written to be able to FAIL.
 *
 * ── THE FOUR CLAIMS, EACH FALSIFIABLE ─────────────────────────────────────
 *
 *  1. In dark mode the editor renders dark.          (control — must still hold)
 *  2. In light mode the editor renders LIGHT.        (the fix)
 *  3. A theme flip while the canvas is OPEN retheme the editor.
 *  4. …WITHOUT REMOUNTING it.
 *
 * (4) is the one worth being careful about, because a remount would make (3)
 * pass for the wrong reason — a fresh <Excalidraw> reading the new theme on
 * first render is not the same thing as a live editor following it, and only
 * the second one preserves an in-progress drawing across a theme switch. So
 * before flipping, this file stamps a `data-probe806` attribute onto the live
 * `.excalidraw` node. React does not preserve unknown DOM attributes across a
 * remount — a new node comes back without it. If the attribute is still there
 * after the flip, it is the same node, and (3) happened to an editor that was
 * already on screen.
 *
 * WHAT "RENDERS LIGHT" IS MEASURED AS, rather than eyeballed: Excalidraw puts
 * `theme--dark` on its own root in dark mode and omits it in light, and drives
 * its whole palette off custom properties on that root. Three independent
 * readings are recorded per theme and all three must move:
 *
 *   --default-bg-color   the drawing surface   #121212 dark / #fff  light
 *   --island-bg-color    the toolbar panels    #232329 dark / #fff  light
 *   .Island background   the same, but COMPUTED off a real painted element
 *                        rather than read from a variable
 *
 * NOT the `<canvas>` elements' `backgroundColor`: both of Excalidraw's canvases
 * are transparent (`rgba(0,0,0,0)`) in BOTH themes — the surface colour is
 * painted by the wrapper behind them, not by the canvas box. An earlier draft
 * of this file checked exactly that and reported a false FAIL against a fix
 * that was working; the correction is recorded here rather than quietly
 * dropped, because "the check I wrote was wrong" is the single most likely
 * reason for a green run to be worthless.
 *
 * A screenshot alone would prove nothing a reviewer could re-run, so the PNGs
 * are the illustration and these numbers are the evidence.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * ```bash
 * cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-806.txt)"
 * PHASE700_BASE_URL=http://127.0.0.1:7822 \
 *   node docs/plan/artifacts/phase800/canvas-theme.cjs --write
 * ```
 *
 * Non-destructive by default (phase 700 round 705 convention): writes to
 * /tmp/phase800-out unless `--write` puts the artifact and its PNGs in place.
 *
 * NFU8: playwright via lib-703.cjs by absolute path. No new dependency.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const L = require("../phase700/lib-703.cjs");

const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";

/** Excalidraw's own root class. Present in dark, absent in light. */
const DARK_CLASS = "theme--dark";

/** Read everything that says what theme the editor is currently painting. */
const sampleEditor = () => {
  const root = document.querySelector(".excalidraw");
  if (!root) return null;
  const cs = getComputedStyle(root);
  const island = root.querySelector(".Island");
  return {
    classes: [...root.classList].sort().join(" "),
    has_dark_class: root.classList.contains("theme--dark"),
    /* Excalidraw's own palette variables — what it actually paints with. */
    default_bg_color: cs.getPropertyValue("--default-bg-color").trim(),
    island_bg_color: cs.getPropertyValue("--island-bg-color").trim(),
    text_primary_color: cs.getPropertyValue("--text-primary-color").trim(),
    /* The same claim, computed off a real element instead of a variable. */
    island_computed_background: island ? getComputedStyle(island).backgroundColor : null,
    /* Survives a re-render, does NOT survive a remount. */
    probe_stamp: root.getAttribute("data-probe806"),
    html_theme: document.documentElement.dataset.theme ?? "(unset)",
  };
};

(async () => {
  const chk = L.makeChecker();
  const chat = await L.resolveChat();
  const shots = {};

  await L.withBrowser(async (ctx) => {
    /* The app's OWN persistence key, exactly as ChatSurface writes it, so the
     * first CANVAS click is an open onto a drawing that already exists —
     * the same seeding canvas-open.cjs uses. `open:false` so the click opens. */
    await ctx.addInitScript(
      ({ key, id, p }) => {
        try {
          localStorage.setItem(key, JSON.stringify({ [id]: { open: false, path: p } }));
          localStorage.setItem("forge.theme", "dark");
        } catch {
          /* about:blank denies localStorage; the real origin does not. */
        }
      },
      { key: "forge.canvasByRun", id: chat.id, p: SEED_PATH },
    );

    const page = await ctx.newPage();
    await L.openChat(page);

    /* Start in dark — the control. */
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });

    await page.getByRole("button", { name: "CANVAS", exact: true }).click();
    await page.waitForSelector(".excalidraw", { timeout: 30_000 });
    /* The editor mounts before it has finished painting its first frame; a
     * double rAF is the frame that showed it, which is what we want to read. */
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    const dark = await page.evaluate(sampleEditor);
    shots.dark = path.join(OUT_DIR, "phase800-canvas-theme-dark.png");
    await page.screenshot({ path: shots.dark });

    /* Stamp the LIVE node, then flip the theme the way the app's own toggle
     * does — `applyTheme` writes exactly this attribute. */
    await page.evaluate(() => {
      document.querySelector(".excalidraw").setAttribute("data-probe806", "same-node");
    });
    const stamped = await page.evaluate(sampleEditor);

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );

    const light = await page.evaluate(sampleEditor);
    shots.light = path.join(OUT_DIR, "phase800-canvas-theme-light.png");
    await page.screenshot({ path: shots.light });

    chk.note("dark", dark);
    chk.note("stamped", stamped);
    chk.note("light", light);

    chk.check("the editor mounted at all", dark !== null && light !== null, true);
    chk.check("the stamp landed on the live node", stamped.probe_stamp, "same-node");

    /* 1 — control */
    chk.check(`dark mode: editor carries .${DARK_CLASS}`, dark.has_dark_class, true);
    /* 2 — the fix */
    chk.check(`light mode: editor does NOT carry .${DARK_CLASS}`, light.has_dark_class, false);
    /* 3 — it actually repainted, not just swapped a class. Three independent
     *     readings, each asserted on its own so a partial failure names itself
     *     instead of hiding inside an OR. */
    chk.check(
      "the drawing surface colour changed",
      `${dark.default_bg_color} -> ${light.default_bg_color}`,
      "#121212 -> #fff",
    );
    chk.check(
      "the toolbar panel colour changed",
      `${dark.island_bg_color} -> ${light.island_bg_color}`,
      "#232329 -> #fff",
    );
    chk.check(
      "a real painted element followed it (.Island computed background)",
      `${dark.island_computed_background} -> ${light.island_computed_background}`,
      "rgb(35, 35, 41) -> rgb(255, 255, 255)",
    );
    chk.check(
      "the editor's text colour inverted",
      `${dark.text_primary_color} -> ${light.text_primary_color}`,
      "#e3e3e8 -> #1b1b1f",
    );
    /* 4 — and it did so without being torn down */
    chk.check(
      "no remount: the same DOM node followed the theme",
      light.probe_stamp,
      "same-node",
    );
    /* The app itself flipped too, or the test flipped nothing. */
    chk.check("the console followed the flip", [dark.html_theme, light.html_theme].join("->"), "dark->light");

    await page.close();
  });

  const out = path.join(OUT_DIR, "canvas-theme.json");
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "canvas-theme.cjs",
        requirement:
          "phase 800 round 804 §5.5 — <Excalidraw theme> was the literal \"dark\"; the editor must follow the app theme, live",
        base_url: L.BASE,
        viewport: L.VIEWPORT,
        chat: { id: chat.id },
        seed_path: SEED_PATH,
        screenshots: shots,
        generated_at: new Date().toISOString(),
        results: chk.results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${chk.failed() === 0 ? "ALL PASS" : `${chk.failed()} FAILURE(S)`} → ${out}`);
  console.log(`  dark  : ${shots.dark}`);
  console.log(`  light : ${shots.light}`);
  process.exit(chk.failed() === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\ncanvas-theme.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
