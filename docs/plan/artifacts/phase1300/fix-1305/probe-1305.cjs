/**
 * probe-1305.cjs — the gate for red-team finding F1.
 *
 * F1: `hover-1291.cjs`'s hover probe computed row membership and then did not
 * require it, so `hoverProbesAllPassed: true` was compatible with a sweep that
 * spent its crossings on a plan-Kanban card. The fix is only worth as much as a
 * test that FAILS ON THE OLD CODE AND PASSES ON THE NEW, so this file runs both
 * assertions over the same page, at the same coordinates, in the same browser.
 *
 * The page is synthetic on purpose. It reproduces the geometry that produced the
 * miss — a scrolling row list whose overflowing rows keep viewport-visible
 * rects, with a Kanban-like card painted directly below the panel — and it is
 * deterministic, so this gate does not need the app, a build, a cookie or a
 * server, and a reviewer can run it in ~5 seconds.
 *
 *   node docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs
 *
 * `HOVER_PROBE` and `CLIPPED_BOXES` are REQUIRED FROM `hover-1291.cjs` itself —
 * not copied — so this gate cannot pass against a stale duplicate of the logic
 * it certifies. Output: `probe-1305.json` beside this file (or `$PROBE_OUT`).
 *
 * Playwright by absolute path from /opt/hermes-workspace, chromium out of
 * /root/.cache/ms-playwright: neither repo gains a dependency (NFU8).
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

const { HOVER_PROBE, CLIPPED_BOXES } = require("../../phase1290/hover/hover-1291.cjs");

/** The pre-1305 assertion, verbatim from `hover-1291.cjs:234` at commit 3b2b3d8. */
const OLD_PROBE = (target) => {
  const hot = [...document.querySelectorAll(":hover")];
  const deepest = hot.length ? hot[hot.length - 1] : null;
  const atPoint = document.elementFromPoint(target.x, target.y);
  const sameNode = Boolean(
    deepest && atPoint && (atPoint === deepest || atPoint.contains(deepest) || deepest.contains(atPoint)),
  );
  const teamRow = deepest ? deepest.closest("[data-team-row]") : null;
  return {
    teamRowHovered: Boolean(teamRow),
    deepestTag: deepest ? deepest.tagName : null,
    pass: Boolean(sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML"),
  };
};

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
  if (!found) throw new Error(`no chromium under ${cache} — playwright browsers not installed`);
  return found;
}

/**
 * The fixture, drawn to scale of the real thing: a 300 px panel holding 40 rows
 * of 40 px inside `[data-team-scroll]` (so 32 of them overflow while keeping
 * viewport-visible rects), and a Kanban card immediately below the panel — the
 * element the sweep actually landed on in `hover-1291.json`.
 */
const PAGE = `<!doctype html><html><body style="margin:0;font:11px system-ui">
  <div id="panel" style="position:absolute;top:0;left:0;width:420px;height:300px;overflow:hidden">
    <div data-team-scroll style="height:300px;overflow-y:auto">
      ${Array.from({ length: 40 }, (_, i) => `<div class="team-row" data-team-row data-node-id="n${i}" style="height:40px;padding:0 8px">row ${i}</div>`).join("")}
    </div>
  </div>
  <div id="kanban" style="position:absolute;top:300px;left:0;width:420px;height:600px;background:#eee">
    <div class="kanban-card" style="height:120px">Phase 2 review — kind truth (R7-R11)</div>
  </div>
</body></html>`;

const results = [];
let failures = 0;
function check(id, label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  results.push({ id, label, ok, got, want });
  console.log(
    `${ok ? "PASS" : "FAIL"}  [${id}] ${label}` +
      (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`),
  );
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.setContent(PAGE);

  // Where round 1291's picker would have aimed: rows visible in the VIEWPORT,
  // centre of the raw rect. Rows 8+ are scrolled out of the panel's overflow box
  // but still inside the 1000 px viewport, so they were fair game.
  const naive = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 8;
      })
      .slice(0, 26)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }),
  );
  const clipped = await page.evaluate(CLIPPED_BOXES, { rowSelector: "[data-team-row]", limit: 26 });

  console.log(`fixture: ${naive.length} boxes by the viewport rule, ${clipped.length} by the clipped rule\n`);

  // --- 1. the bug is real, and this fixture reproduces it -------------------
  const offPanel = naive.filter((b) => b.y > 300);
  check("F1-a", "the viewport rule targets coordinates outside the panel", offPanel.length > 0, true);

  const bad = offPanel[0];
  await page.mouse.move(bad.x, bad.y, { steps: 2 });
  await page.waitForTimeout(50);
  const oldOnKanban = await page.evaluate(OLD_PROBE, bad);
  const newOnKanban = await page.evaluate(HOVER_PROBE, { target: bad, rowSelector: "[data-team-row]" });

  check("F1-b", "pointer is on the Kanban card, not on a row", oldOnKanban.teamRowHovered, false);
  check("F1-c", "OLD probe passes there — the finding, reproduced", oldOnKanban.pass, true);
  check("F1-d", "NEW probe fails there", newOnKanban.pass, false);
  check("F1-e", "NEW probe says why: no row under the pointer", newOnKanban.rowHovered, false);
  check("F1-f", "NEW probe records what it hit instead", typeof newOnKanban.missedOnto === "string", true);

  // --- 2. the new probe is not merely stricter: it still passes a real row --
  const good = clipped[0];
  await page.mouse.move(good.x, good.y, { steps: 2 });
  await page.waitForTimeout(50);
  const newOnRow = await page.evaluate(HOVER_PROBE, { target: good, rowSelector: "[data-team-row]" });
  check("F1-g", "NEW probe passes on a genuine row", newOnRow.pass, true);
  check("F1-h", "…and reports the row it hovered", newOnRow.rowHovered, true);
  check("F1-i", "…with the row's own text", newOnRow.hoveredRowText.startsWith("row "), true);

  // --- 3. the picker can no longer hand out a box that is off the list ------
  check("F1-j", "every clipped box lies inside the panel's scroll box", clipped.every((b) => b.y < 300), true);
  const probedAll = [];
  for (const b of clipped) {
    await page.mouse.move(b.x, b.y, { steps: 2 });
    await page.waitForTimeout(20);
    probedAll.push(await page.evaluate(HOVER_PROBE, { target: b, rowSelector: "[data-team-row]" }));
  }
  check(
    "F1-k",
    `all ${clipped.length} clipped boxes hover a row`,
    probedAll.filter((p) => p.pass).length,
    clipped.length,
  );

  // --- 4. the rail's selector works the same way ----------------------------
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div style="width:300px;height:200px;overflow-y:auto">
      ${Array.from({ length: 20 }, (_, i) => `<div class="chat-row" style="height:60px">chat ${i}</div>`).join("")}
    </div>
    <div style="height:400px">not a chat row</div>
  </body></html>`);
  const railBoxes = await page.evaluate(CLIPPED_BOXES, { rowSelector: ".chat-row", limit: 24 });
  check("F1-l", "rail picker returns only rows inside the rail's scroll box", railBoxes.every((b) => b.y < 200), true);
  await page.mouse.move(railBoxes[0].x, railBoxes[0].y, { steps: 2 });
  await page.waitForTimeout(50);
  const railProbe = await page.evaluate(HOVER_PROBE, { target: railBoxes[0], rowSelector: ".chat-row" });
  check("F1-m", "NEW probe passes on a rail row with the rail selector", railProbe.pass, true);
  check(
    "F1-n",
    "…and teamRowHovered is false there, which is why `pass` must not read it",
    railProbe.teamRowHovered,
    false,
  );

  await browser.close();

  const out = path.resolve(process.env.PROBE_OUT ?? __dirname);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "probe-1305.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        script: "docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs",
        round: 1305,
        finding: "F1 — hover probe's `pass` omitted row membership",
        probeSource: "docs/plan/artifacts/phase1290/hover/hover-1291.cjs (required, not copied)",
        finishedAt: new Date().toISOString(),
        naiveBoxes: naive,
        clippedBoxes: clipped,
        samples: { oldOnKanban, newOnKanban, newOnRow, railProbe },
        checks: results,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL(S)`} — ${file}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
