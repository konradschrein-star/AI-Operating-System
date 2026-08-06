/**
 * capture-600.cjs — both-theme evidence for every surface phase 600 touched.
 *
 * Six cases, dark AND light, twelve PNGs:
 *
 *   manager   the operator chat, undrilled — the surface that must NOT change
 *   worker    a drilled worker: orientation strip + story-so-far + the
 *             summarized transcript, the three things round 602/603 added
 *   expanded  one tool row open, showing ARGS and RESULT
 *   subagent  depth 2 — a sub-agent's slice with its envelope note
 *   degraded  the strip with nothing polling the team tree
 *   plandoc   the plan-doc shell
 *
 * Five are shot in the real app against a build of this worktree. `plandoc` is
 * not, and cannot be: nothing pushes a `plandoc` frame in this round (phase 700
 * owns the Kanban that will) and the nav stack has no handle a script can reach.
 * That case is delegated to `capture-plandoc.ts`, which renders the shipped
 * component to static HTML against the real theme files — round 603's method for
 * exactly this problem. The JSON records `render: "offline-static"` on it and on
 * nothing else.
 *
 * The theme is flipped by `document.documentElement.dataset.theme` alone
 * (app/tokens.ts:101-109), with the page in the SAME state for both shots — so
 * dark and light are the same pixels under two palettes, and a difference is a
 * token bug rather than two different screens.
 *
 * Run: see README.md §2.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { BASE, API, CHAT_TEXT, finish, makeChecker, openChat, withBrowser } = require("./lib-604.cjs");

const REPO = path.join(__dirname, "..", "..", "..", "..");
const THEMES = ["dark", "light"];

/**
 * The painted colour under four points of the layout — nav rail, top bar, the
 * drilled surface, the team panel. Recorded per theme so "both themes work" is a
 * number in the JSON rather than a claim about a PNG somebody has to open. It
 * walks up to the first ancestor that actually paints, because most of these
 * elements are transparent over a parent.
 */
const probeColors = () => {
  /* The first OPAQUE ancestor, not merely the first painted one. A translucent
   * accent tint — a code block's `rgba(…, 0.08)` — is a foreground, and light
   * mode DARKENS foreground blues on purpose (theme.css: "the dark palette's
   * saturated status colours wash out on light backgrounds"). Comparing those
   * would fail a correct theme. What must get lighter is the SURFACE. */
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (el === null) return null;
    for (let e = el; e !== null; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg);
      if (m === null) continue;
      if (m[4] === undefined || Number(m[4]) === 1) return bg;
    }
    return null;
  };
  return { topbar: at(700, 22), rail: at(90, 400), centre: at(800, 600), panel: at(1450, 400) };
};

/** Mean channel value of an `rgb(...)`/`rgba(...)` string, or null. */
function luma(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? "");
  return m === null ? null : (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
}

async function shoot(page, name, cases, check) {
  const colors = {};
  for (const theme of THEMES) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(400);
    colors[theme] = await page.evaluate(probeColors);
    const file = path.join(__dirname, `phase600-604-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    cases.push({ case: name, theme, file: path.basename(file), painted: colors[theme] });
    console.log(`  shot phase600-604-${name}-${theme}.png`);
  }
  /* The gate: every probed region must actually repaint, and light must be
   * light. A surface that stays dark under [data-theme="light"] is the exact
   * failure this evidence exists to catch, and eyeballing a PNG is how it gets
   * missed. */
  for (const region of ["topbar", "rail", "centre", "panel"]) {
    const d = luma(colors.dark[region]);
    const l = luma(colors.light[region]);
    check(`${name}: ${region} repaints between themes and light is lighter`, d !== null && l !== null && l > d, true);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
}

async function main() {
  const { results, check, note, failed } = makeChecker();
  const shots = [];

  const payload = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await openChat(page);

    /* ── 1. manager ──────────────────────────────────────────────────────── */
    const managerRows = await page.evaluate(() => document.querySelectorAll("[data-team-row]").length);
    check("manager: the chat is open with its team beside it", managerRows >= 12, true);
    check("manager: no drilled view", await page.locator("[data-agent-chat-view]").count(), 0);
    await shoot(page, "manager", shots, check);

    /* The fold worker — the only one in this tree with a sub-agent, so cases
     * 2-4 are all the same lineage and read as one story. */
    const target = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("[data-team-row]"));
      for (let i = 0; i < all.length; i++) {
        if (all[i].getAttribute("data-kind") !== "subagent" || all[i].getAttribute("data-depth") !== "2") continue;
        for (let j = i - 1; j >= 0; j--)
          if (all[j].getAttribute("data-kind") === "worker")
            return { worker: all[j].getAttribute("data-node-id"), sub: all[i].getAttribute("data-node-id") };
      }
      return null;
    });
    if (target === null) throw new Error("NO-DEPTH-2-SUBAGENT — this tree has no worker with a sub-agent to photograph");
    note("lineage photographed", target);

    /* ── 2. worker ───────────────────────────────────────────────────────── */
    await page.locator(`[data-team-row][data-node-id="${target.worker}"]`).click();
    await page.waitForSelector("[data-orientation-strip]", { timeout: 30_000 });
    await page.waitForSelector("[data-story-so-far]", { timeout: 30_000 });
    await page.waitForTimeout(2_500);
    check("worker: the orientation strip is mounted", await page.locator("[data-orientation-strip]").count(), 1);
    check("worker: the story-so-far digest is mounted", await page.locator("[data-story-so-far]").count(), 1);
    check(
      "worker: the transcript renders in summary mode",
      await page.locator('[data-tool-row="summary"]').count() > 0,
      true,
    );
    /* Open the digest so the shot shows what it contains, not just its lid. */
    await page.locator("[data-story-toggle]").click();
    await page.waitForTimeout(600);
    await shoot(page, "worker", shots, check);
    await page.locator("[data-story-toggle]").click();
    await page.waitForTimeout(400);

    /* ── 3. expanded tool row ────────────────────────────────────────────── */
    const expandedIndex = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-tool-row]"));
      /* Pick a row with BOTH args and a result worth looking at — the point of
       * the picture is that expanding shows the payload, not that it opens. */
      let best = 0;
      let bestLen = -1;
      rows.forEach((r, i) => {
        const len = (r.textContent ?? "").length;
        if (len > bestLen) {
          bestLen = len;
          best = i;
        }
      });
      rows[best].firstElementChild.scrollIntoView({ block: "center" });
      rows[best].firstElementChild.click();
      return best;
    });
    await page.waitForTimeout(700);
    const panes = await page.evaluate(
      (i) => document.querySelectorAll("[data-tool-row]")[i].querySelectorAll("pre").length,
      expandedIndex,
    );
    check("expanded: the row opened to ARGS + RESULT", panes, 2);
    await shoot(page, "expanded", shots, check);
    await page.evaluate((i) => {
      document.querySelectorAll("[data-tool-row]")[i].firstElementChild.click();
    }, expandedIndex);
    await page.waitForTimeout(400);

    /* ── 4. sub-agent ────────────────────────────────────────────────────── */
    await page.locator(`[data-team-row][data-node-id="${target.sub}"]`).click();
    await page.waitForTimeout(3_000);
    check(
      "subagent: the view is at depth 2 on the clicked sub-agent",
      await page.evaluate(() => document.querySelector("[data-agent-chat-view]")?.getAttribute("data-subagent-id")),
      target.sub,
    );
    check(
      "subagent: it is labelled a sub-agent, not a session",
      await page.evaluate(() => document.querySelector("[data-orientation-kind]")?.textContent),
      "sub-agent",
    );
    await shoot(page, "subagent", shots, check);

    /* ── 5. degraded strip ───────────────────────────────────────────────
     * Collapsing the side panel disables the team query; react-query marks it
     * inactive and the strip stops claiming a task it can no longer refresh
     * (`team-not-polling`). This is the real degraded path, reached the way a
     * person reaches it — no interception. */
    await page.locator('button[title="Collapse"]').click();
    await page.waitForTimeout(2_000);
    const degraded = await page.evaluate(
      () => document.querySelector("[data-orientation-strip]")?.getAttribute("data-orientation-degraded") ?? null,
    );
    check("degraded: collapsing the panel degrades the strip, with a reason", degraded, "team-not-polling");
    await shoot(page, "degraded", shots, check);
    await page.locator("button").filter({ hasText: "TEAM" }).first().click().catch(() => {});
    await page.waitForTimeout(1_000);

    return { base: BASE, api: API, chat: CHAT_TEXT, lineage: target, expanded_row_index: expandedIndex };
  });

  /* ── 6. plandoc, offline ───────────────────────────────────────────────── */
  console.log("  plandoc: offline static render (see the header for why)");
  execFileSync(
    path.join(REPO, "forge-control", "node_modules", ".bin", "tsx"),
    [path.join(__dirname, "capture-plandoc.ts")],
    { cwd: path.join(REPO, "forge-control-web"), encoding: "utf8", stdio: "inherit" },
  );
  for (const theme of THEMES)
    shots.push({ case: "plandoc", theme, file: `phase600-plandoc-${theme}.png`, render: "offline-static" });

  check("twelve PNGs, six cases x two themes", shots.length, 12);

  finish(
    "capture-600.json",
    {
      ...payload,
      cases: shots,
      render_note:
        "every case is a real chat rendered by the app EXCEPT plandoc, which no navigation can reach this round — see capture-plandoc.ts",
      failures: failed(),
      results,
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
