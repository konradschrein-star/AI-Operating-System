/**
 * throttled-tradeoff.cjs — is moving 144 KB of CSS off /desktop's critical path
 * a net win or a net loss?
 *
 * PHASE 800, round 806. Round 803's change makes a TRADE, and round 806's
 * loopback measurement could only see one side of it:
 *
 *   PAGE LOAD  gets 144,615 bytes of render-blocking CSS lighter, for every
 *              visitor, including the ones who never draw.
 *   OPEN       has to fetch and parse that stylesheet when the editor mounts,
 *              instead of having had it since page load.
 *
 * On loopback the saving is worth ~0 ms (FCP was 412/408 ms on BOTH trees,
 * identical to the millisecond) while the cost showed up as +78 to +198 ms of
 * wall clock on the open. That reading makes the change look strictly bad —
 * but it is an artefact of measuring a BYTES change on a link with no transfer
 * cost. Loopback is the one network where 144 KB is free.
 *
 * Konrad does not reach this console over loopback. So this file re-runs both
 * halves of the trade with CDP network emulation, and lets the numbers decide
 * instead of letting either of us argue from mechanism.
 *
 * ── WHAT IS EMULATED, AND WHY THOSE NUMBERS ───────────────────────────────
 *
 * Two profiles, both from Chrome DevTools' own presets so they are arguable
 * against a published definition rather than invented here:
 *
 *   loopback   no throttling — reproduces round 806's headline runs.
 *   4g         9 Mbps down, 170 ms RTT ("Fast 3G"-class in DevTools terms;
 *              a phone or a hotel wifi, which is where Konrad actually opens
 *              this thing).
 *
 * ── WHAT IS MEASURED ──────────────────────────────────────────────────────
 *
 *   A) PAGE LOAD, canvas never opened  → first-contentful-paint
 *   B) CANVAS OPEN, cold               → click → the frame showing the editor
 *
 * Same page, same session, same seeding as canvas-open.cjs, so (B) here is
 * comparable to (B) there in shape though not in absolute value — this file
 * uses fewer cycles and is a tie-breaker, not a replacement. Anyone quoting a
 * headline number should quote canvas-open.cjs; quote THIS file only for the
 * question it exists to answer, which is the SIGN of the trade off-loopback.
 *
 * MEDIAN of N samples per cell, fresh context each time (cold HTTP cache), and
 * the two trees are interleaved so a drift in machine load cannot land on one.
 *
 * ── ONE TREE PER PROCESS, DELIBERATELY ────────────────────────────────────
 *
 * `lib-703.cjs` captures `BASE` from `PHASE700_BASE_URL` at REQUIRE time and
 * `openChat` navigates to it, so reassigning the variable inside a loop would
 * silently measure the same tree twice. Rather than reach around the shared
 * helper, each invocation measures one tree and writes one file; the caller
 * alternates them so the two trees of a cell are still taken back to back.
 *
 * ── REPRODUCE ─────────────────────────────────────────────────────────────
 *
 * ```bash
 * export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-806.txt)"
 * for i in 1 2 3; do
 *   for t in before after; do
 *     case $t in before) p=7821 ;; after) p=7822 ;; esac
 *     PHASE700_BASE_URL=http://127.0.0.1:$p PHASE806_TREE=$t PHASE806_REP=$i \
 *       node docs/plan/artifacts/phase800/throttled-tradeoff.cjs
 *   done
 * done
 * node docs/plan/artifacts/phase800/throttled-tradeoff.cjs --merge --write
 * ```
 *
 * Ports are the two isolated builds round 806 served: :7821 BEFORE (7549b13),
 * :7822 AFTER (91ccfe0).
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

const MERGE = process.argv.includes("--merge");
const TREE = process.env.PHASE806_TREE ?? "before";
const REP = process.env.PHASE806_REP ?? "1";

/** DevTools' own preset shapes. `offline:false` is required by the CDP call. */
const PROFILES = {
  loopback: null,
  "4g": {
    offline: false,
    latency: 170,
    downloadThroughput: (9 * 1000 * 1000) / 8,
    uploadThroughput: (3 * 1000 * 1000) / 8,
  },
};

const SAMPLES = Number(process.env.PHASE806_SAMPLES ?? 3);

const SEED_PATH =
  process.env.PHASE800_CANVAS_PATH ??
  "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md";

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(1);
};

/**
 * One sample. `openCanvas` decides which half of the trade is measured — the
 * page-load cell must never click, or it pays for the very chunk it exists to
 * prove absent.
 */
async function sample({ profile, openCanvas, chatId }) {
  let result = null;
  await L.withBrowser(
    async (ctx) => {
      await ctx.addInitScript(
        ({ key, id, p }) => {
          try {
            localStorage.setItem(key, JSON.stringify({ [id]: { open: false, path: p } }));
          } catch {
            /* about:blank denies localStorage; the real origin does not. */
          }
        },
        { key: "forge.canvasByRun", id: chatId, p: SEED_PATH },
      );

      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      if (PROFILES[profile]) await cdp.send("Network.emulateNetworkConditions", PROFILES[profile]);

      await L.openChat(page);
      await page.getByRole("button", { name: "CANVAS", exact: true }).waitFor({ timeout: 120_000 });

      const fcp = await page.evaluate(() => {
        const p = performance.getEntriesByType("paint").find((x) => x.name === "first-contentful-paint");
        return p ? +p.startTime.toFixed(1) : null;
      });

      let openMs = null;
      if (openCanvas) {
        /* Stamp the click in the page's own clock, then wait for the frame that
         * actually SHOWED the editor — a double rAF after it enters the DOM,
         * the same definition canvas-open.cjs uses for `excpaint`. */
        await page.evaluate(() => {
          window.__t0 = performance.now();
        });
        await page.getByRole("button", { name: "CANVAS", exact: true }).click();
        await page.waitForSelector(".excalidraw", { timeout: 120_000 });
        openMs = await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => r(+(performance.now() - window.__t0).toFixed(1))),
              ),
            ),
        );
      }

      result = { fcp, openMs };
      await page.close();
    },
  );
  return result;
}

/** Fold the per-tree, per-rep files into one comparison. */
function merge() {
  const cells = {};
  for (const tree of ["before", "after"]) {
    for (const rep of [1, 2, 3, 4, 5]) {
      const p = path.join(OUT_DIR, `throttled-${tree}-rep${rep}.json`);
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const [key, vals] of Object.entries(j.cells)) {
        ((cells[key] ??= {})[tree] ??= []).push(...vals);
      }
    }
  }
  for (const [key, c] of Object.entries(cells)) {
    c.median_before = median(c.before ?? []);
    c.median_after = median(c.after ?? []);
    c.delta_ms =
      c.median_before !== null && c.median_after !== null
        ? +(c.median_after - c.median_before).toFixed(1)
        : null;
    c.delta_pct = c.median_before ? +((c.delta_ms / c.median_before) * 100).toFixed(1) : null;
    console.log(
      `${key.padEnd(20)} before ${String(c.median_before).padStart(8)} ms   ` +
        `after ${String(c.median_after).padStart(8)} ms   ` +
        `${c.delta_ms >= 0 ? "+" : ""}${c.delta_ms} ms (${c.delta_pct}%)   ` +
        `n=${(c.before ?? []).length}/${(c.after ?? []).length}`,
    );
  }
  const out = path.join(OUT_DIR, "throttled-tradeoff.json");
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "throttled-tradeoff.cjs --merge",
        requirement:
          "U31 — decide the SIGN of round 803's CSS trade off-loopback, where 144 KB is not free",
        profiles: PROFILES,
        viewport: L.VIEWPORT,
        seed_path: SEED_PATH,
        cells,
        page_load_saving_ms: {
          loopback: -(cells["loopback/pageload"]?.delta_ms ?? 0),
          "4g": -(cells["4g/pageload"]?.delta_ms ?? 0),
        },
        open_cost_ms: {
          loopback: cells["loopback/open"]?.delta_ms ?? null,
          "4g": cells["4g/open"]?.delta_ms ?? null,
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n→ ${out}`);
}

(async () => {
  if (MERGE) {
    merge();
    return;
  }

  const chat = await L.resolveChat();
  const cells = {};

  for (const profile of Object.keys(PROFILES)) {
    for (const openCanvas of [false, true]) {
      const key = `${profile}/${openCanvas ? "open" : "pageload"}`;
      cells[key] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const r = await sample({ profile, openCanvas, chatId: chat.id });
        cells[key].push(openCanvas ? r.openMs : r.fcp);
      }
      console.log(
        `${TREE.padEnd(6)} rep${REP}  ${key.padEnd(20)} ${cells[key].join(", ")}  ` +
          `median ${median(cells[key])} ms`,
      );
    }
  }

  const out = path.join(OUT_DIR, `throttled-${TREE}-rep${REP}.json`);
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        protocol: "throttled-tradeoff.cjs",
        tree: TREE,
        rep: REP,
        base_url: L.BASE,
        profiles: PROFILES,
        samples_per_cell: SAMPLES,
        viewport: L.VIEWPORT,
        seed_path: SEED_PATH,
        generated_at: new Date().toISOString(),
        cells,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`→ ${out}`);
})().catch((e) => {
  console.error(`\nthrottled-tradeoff.cjs FAILED: ${e.stack ?? e.message}`);
  process.exit(1);
});
