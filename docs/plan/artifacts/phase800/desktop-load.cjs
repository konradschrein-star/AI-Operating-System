/**
 * desktop-load.cjs — U31 metric family B: what does /desktop cost when the
 * canvas is NEVER opened?
 *
 * PHASE 800, round 803. This is deliberately a SECOND instrument, because the
 * round optimises two different things and the operator was explicit that one
 * must not be allowed to hide the other:
 *
 *   A) canvas open cost   — `canvas-open.cjs`, cold + warm, scripting + wall.
 *   B) desktop page load  — THIS FILE. The canvas is never opened. What is
 *      being measured is the tax `CanvasPane` levies on every visit to the app
 *      by importing `@excalidraw/excalidraw/index.css` at module scope while
 *      `ChatSurface` imported it statically: 144,615 bytes of render-blocking
 *      stylesheet, shipped to people who never draw.
 *
 * Round 801 found the bytes (its `page_load_chunks.excalidraw_bearing` is
 * non-empty in ALL FOUR scenarios, including the one where the editor never
 * mounts) but never timed the consequence. A byte count is not a user-visible
 * number, so this file reports both and lets the timing decide:
 *
 *   - render-blocking stylesheets in <head>, with bytes read off the build
 *   - whether any of them contains "excalidraw"          ← the claim, falsifiable
 *   - first paint / first contentful paint               ← what Konrad sees
 *   - DOMContentLoaded, load, and transferred bytes
 *
 * The operator's standing instruction on this metric, honoured here: "If the
 * CSS split turns out NOT to move (B) measurably, say so plainly and drop it
 * back down the list — I promoted it on reasoning, and your measurement
 * outranks my reasoning." So this file is written to be capable of returning a
 * null result, and the artifact reports whatever it returns.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────
 *
 * Each sample is a FRESH browser context (cold HTTP cache, cold module graph)
 * navigating to /desktop and waiting for the chat surface to actually be
 * there — `networkidle` is unreachable on this surface (the pollers never
 * stop; round 801 §5 measured `longest_quiet_ms` = 0), so the wait is on a
 * real DOM landmark, the CANVAS button itself.
 *
 * The canvas is never clicked and never hovered. That is the entire point: a
 * run that opened the pane would pull in the very chunk this file exists to
 * prove is absent, and would report the fix as having done nothing. Playwright
 * does not move the pointer or click unless told to, and the check
 * `the editor never mounted — the canvas really was not opened` fails loudly
 * if that ever stops being true.
 *
 * CORRECTED IN ROUND 806: this paragraph used to justify itself by naming a
 * `prefetchCanvasPane` in ChatSurface that fires on `pointerenter`, and to cite
 * a check called `no excalidraw-bearing chunk was requested`. NEITHER EXISTS.
 * `grep -rn prefetchCanvasPane forge-control-web/app` is empty on this tree,
 * and the only two `chk.check` calls in this file are the two at the bottom.
 * The hazard the paragraph describes is real, so the guard is now written
 * rather than merely claimed — and it is written as "the editor never mounted"
 * rather than "no excalidraw asset was requested", because the second one
 * cannot be asserted at all: BEFORE the fix an excalidraw-bearing stylesheet
 * IS requested on every load, which is precisely the finding this instrument
 * exists to quantify. An assertion that only passes on one of the two trees
 * would make the instrument unable to measure its own baseline.
 *
 * MEDIAN, not mean: page-load timings have a long right tail on a shared box,
 * and one scheduler hiccup would move a mean by more than this change does.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * ```bash
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-803.txt)"
 * export PHASE800_OUT_DIR=/tmp/phase803-out
 *
 * PHASE700_BASE_URL=http://127.0.0.1:7815 \
 *   PHASE800_BUILD_DIR=/tmp/phase803-before/forge-control-web/.next \
 *   PHASE800_OUT_FILE=desktop-load-before.json \
 *   node docs/plan/artifacts/phase800/desktop-load.cjs
 *
 * PHASE700_BASE_URL=http://127.0.0.1:7816 \
 *   PHASE800_BUILD_DIR=/tmp/phase803-after/forge-control-web/.next \
 *   PHASE800_OUT_FILE=desktop-load-after.json \
 *   node docs/plan/artifacts/phase800/desktop-load.cjs
 * ```
 *
 * NFU8: playwright via `lib-703.cjs` by absolute path. No new dependency.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
process.env.PHASE700_OUT_DIR = OUT_DIR;

const L = require("../phase700/lib-703.cjs");

const OUT_FILE = process.env.PHASE800_OUT_FILE ?? "desktop-load.json";
const SAMPLES = Number(process.env.PHASE800_SAMPLES ?? 5);
const BUILD_DIR = process.env.PHASE800_BUILD_DIR;

/** Read the build so "this stylesheet is 144 KB and is Excalidraw's" is a fact
 *  off disk rather than a guess from a hashed filename. A missing build dir is
 *  a hard error for the same reason it is in canvas-open.cjs: reporting
 *  `null` for every asset would make the central claim unfalsifiable. */
function indexBuild(buildDir) {
  if (!buildDir) throw new Error("PHASE800_BUILD_DIR is required — it is what turns a hashed filename into a claim");
  const index = {};
  for (const sub of [["static", "chunks"], ["static", "css"]]) {
    const dir = path.join(buildDir, ...sub);
    if (!fs.existsSync(dir))
      throw new Error(`PHASE800_BUILD_DIR looks wrong — ${dir} does not exist`);
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(js|css)$/.test(entry.name)) continue;
        const body = fs.readFileSync(p, "utf8");
        index[entry.name] = {
          bytes: fs.statSync(p).size,
          has_excalidraw: body.includes("excalidraw"),
        };
      }
    };
    walk(dir);
  }
  return index;
}

const median = (xs) => {
  const s = [...xs].filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(2);
};

(async () => {
  const chk = L.makeChecker();
  const build = indexBuild(BUILD_DIR);
  chk.note("build", { dir: BUILD_DIR, base_url: L.BASE });

  const samples = [];

  for (let i = 1; i <= SAMPLES; i++) {
    /* A fresh CONTEXT per sample, not just a fresh page: a reused context keeps
     * the HTTP cache, and every sample after the first would then measure a
     * warm load and report a page-load win this change did not make. */
    await L.withBrowser(async (ctx) => {
      const page = await ctx.newPage();
      const requested = [];
      page.on("response", (r) => {
        const u = r.url();
        if (/\/_next\/static\/(chunks|css)\//.test(u))
          requested.push(u.split("/").pop().split("?")[0]);
      });

      await L.openChat(page);
      /* The landmark: the surface is genuinely up once its own controls are.
       * Never hovered, never clicked. */
      await page.getByRole("button", { name: "CANVAS", exact: true }).waitFor({ timeout: 30_000 });

      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paints = Object.fromEntries(
          performance.getEntriesByType("paint").map((p) => [p.name, +p.startTime.toFixed(2)]),
        );
        /* Render-blocking stylesheets, in document order, as the browser sees
         * them — not as the build manifest claims them. */
        const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
          l.getAttribute("href"),
        );
        const res = performance.getEntriesByType("resource");
        const cssBytes = res
          .filter((r) => r.initiatorType === "link" && r.name.endsWith(".css"))
          .reduce((a, r) => a + (r.transferSize || 0), 0);
        return {
          first_paint: paints["first-paint"] ?? null,
          first_contentful_paint: paints["first-contentful-paint"] ?? null,
          dom_content_loaded: nav ? +nav.domContentLoadedEventEnd.toFixed(2) : null,
          load_event: nav ? +nav.loadEventEnd.toFixed(2) : null,
          dom_interactive: nav ? +nav.domInteractive.toFixed(2) : null,
          transfer_bytes: nav ? nav.transferSize : null,
          stylesheet_hrefs: sheets,
          stylesheet_transfer_bytes: cssBytes,
          /* The load-bearing assumption of this whole metric family, sampled
           * rather than assumed: `.excalidraw` is the editor's own root class.
           * If it is present, the canvas got opened and the sample is void. */
          editor_mounted: !!document.querySelector(".excalidraw"),
        };
      });

      const sheetFiles = timing.stylesheet_hrefs
        .map((h) => (h ?? "").split("/").pop().split("?")[0])
        .filter(Boolean);
      const sheetInfo = sheetFiles.map((f) => ({ file: f, ...(build[f] ?? {}) }));

      samples.push({
        n: i,
        ...timing,
        stylesheets: sheetInfo,
        stylesheet_disk_bytes: sheetInfo.reduce((a, s) => a + (s.bytes ?? 0), 0),
        excalidraw_stylesheets: sheetInfo.filter((s) => s.has_excalidraw),
        excalidraw_assets_requested: [...new Set(requested)]
          .filter((f) => build[f]?.has_excalidraw)
          .map((f) => ({ file: f, ...build[f] })),
      });

      await page.close();
    });
  }

  const excalidrawSheetBytes = median(samples.map((s) =>
    s.excalidraw_stylesheets.reduce((a, x) => a + (x.bytes ?? 0), 0),
  ));
  const anyExcalidrawAsset = samples.flatMap((s) => s.excalidraw_assets_requested);

  const summary = {
    samples: samples.length,
    first_contentful_paint_ms_median: median(samples.map((s) => s.first_contentful_paint)),
    first_paint_ms_median: median(samples.map((s) => s.first_paint)),
    dom_interactive_ms_median: median(samples.map((s) => s.dom_interactive)),
    dom_content_loaded_ms_median: median(samples.map((s) => s.dom_content_loaded)),
    load_event_ms_median: median(samples.map((s) => s.load_event)),
    render_blocking_css_disk_bytes_median: median(samples.map((s) => s.stylesheet_disk_bytes)),
    render_blocking_css_transfer_bytes_median: median(
      samples.map((s) => s.stylesheet_transfer_bytes),
    ),
    excalidraw_css_on_critical_path_bytes_median: excalidrawSheetBytes,
    excalidraw_assets_requested_without_opening_the_canvas: [
      ...new Map(anyExcalidrawAsset.map((a) => [a.file, a])).values(),
    ],
  };

  chk.check("every sample produced a first-contentful-paint", samples.filter((s) => s.first_contentful_paint === null).length, 0);
  chk.check("every sample loaded at least one stylesheet", samples.filter((s) => !s.stylesheets.length).length, 0);
  chk.check(
    "the editor never mounted — the canvas really was not opened",
    samples.filter((s) => s.editor_mounted).length,
    0,
  );
  chk.note("summary", summary);

  const out = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "desktop-load.cjs",
        requirement: "U31 metric family B — /desktop page load with the canvas never opened",
        base_url: L.BASE,
        build_dir: BUILD_DIR,
        viewport: L.VIEWPORT,
        generated_at: new Date().toISOString(),
        summary,
        samples,
        results: chk.results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${chk.failed() === 0 ? "ALL PASS" : `${chk.failed()} FAILURE(S)`} → ${out}`);
  console.log(`  FCP median            ${summary.first_contentful_paint_ms_median} ms`);
  console.log(`  render-blocking CSS   ${summary.render_blocking_css_disk_bytes_median} B on disk`);
  console.log(`  of which excalidraw   ${summary.excalidraw_css_on_critical_path_bytes_median} B`);
  console.log(
    `  excalidraw assets requested without opening the canvas: ${summary.excalidraw_assets_requested_without_opening_the_canvas.length}`,
  );
  process.exit(chk.failed() === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`\ndesktop-load.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
