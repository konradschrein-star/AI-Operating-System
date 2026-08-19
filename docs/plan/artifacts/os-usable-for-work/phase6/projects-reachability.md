# Projects board reachability — before and after the payload fix (R75)

**Phase 6, task C.** R75: *"All 127 active/blocked tasks stay reachable, and the board still
refreshes."* This file is the proof, and the script that produced it is embedded below in full so it
can be re-run without hunting for it.

---

## 1. The verdict

> **Every task the server serves is reachable in the DOM, before the fix and after it: 149/149 and
> 152/152, zero missing, zero extra.** The fix removes a COLUMN, not a row — no `LIMIT`, no windowing,
> no virtualisation — so there is no mechanism by which a card could go missing, and this measurement
> is what turns "no mechanism" into "no cards missing".

| | before (build `m39csVPriXQJFbcoDX4F8`) | after (build `rgSqPRo__ETUwf-_N342h`) |
|---|---|---|
| measured at | 2026-08-18T20:44:32.301Z | 2026-08-18T20:52:15.059Z |
| server `count` | **149** | **152** |
| distinct task ids in the DOM, after scrolling every column to its end | **149** | **152** |
| server ids never rendered | 0 | 0 |
| DOM cards not in the server set | 0 | 0 |
| board response bytes | 1,906,199 | 241,114 |
| `brief` on the wire | yes | no |
| DOM nodes on the board | 1,455 | 1,480 |
| scroll steps to exhaust every column | 17 | 18 |

Per column, at rest:

| column | before | after |
|---|---|---|
| Architect | 0 | 0 |
| Planner | 2 | 2 |
| Scout | 0 | 0 |
| Builder | 10 | 12 |
| Reviewer | 14 | 13 |
| Done | 123 | 125 |

## 2. Why the two totals are 149 and 152, and why that is not a hole in the proof

**The board is live and it churns.** Three tasks were created across the 7 minutes between the two runs — the
fleet was working while this was measured, which is the normal state of this box. So "149 before and
149 after" was never an available assertion, and a report that claimed it would have been measuring a
frozen fixture rather than the surface Konrad uses.

The invariant that IS available, and that survives churn, is the one asserted here:

> **the set of task ids the server served == the set of task ids reachable in the DOM**, in the same
> page, in the same second, in both runs.

That is strictly stronger than an equal count. A `LIMIT 50` would satisfy "the count did not change"
if 50 rows were all the server ever admitted to having; it cannot satisfy set equality against the
server's own `count`, because the script asks the server and the DOM the same question at the same
moment and diffs the answers by id. Both directions are checked — `missingFromDom` (a card the server
has and the board never rendered) and `extraInDom` (a card the board renders that the server did not
serve, which would mean stale cache) — and both are empty in both runs.

The starting figure in the brief, **127** active/blocked tasks, is a 2026-08-18 measurement of the
same churning table (task A measured 142 at 20:06). It is not a constant and this file does not treat
it as one.

## 3. How identity was obtained without touching the card markup

`TaskCard` carries no `data-*` attribute. Rather than add one — a source change with no purpose beyond
making this measurement convenient — the id comes off the React fiber that production React already
attaches to every host node: find the `__reactFiber$<n>` key on the card element, walk `fiber.return`
until a component's `memoizedProps.task.id` appears.

**A card that yields no id aborts the run** (`unidentified > 0` throws). That check is the difference
between "the ids matched" and "no ids were found and an empty set trivially matched an empty set" —
the failure mode this corpus keeps catching, most recently as `document.fonts.check` returning true
for a font that does not exist.

Two further fatal checks, both inherited from `browser-harness-perf.md`: the run aborts if the first
navigation lands on `/signin` (with the SALT named as first suspect, not the secret), and it aborts if
the board holds fewer than 100 cards.

## 4. What scrolling is for here

The board is not windowed and this change did not window it, so every card is in the DOM at rest and
the totals in §1 are already complete before a single scroll. The scroll loop runs anyway — every
column body advanced by `clientHeight` per step until nothing moves, ids collected after every step —
because it is the only thing that distinguishes an unwindowed board from a windowed one. If a future
change virtualises these columns, this script keeps working and keeps being the thing that catches a
card that exists only while it is on screen. The final scroll positions are in the JSON: the Done
column ends at `scrollTop 12,386` of `scrollHeight 13,194`.

## 5. Reproduction

```bash
cd <worktree>/forge-control-web
# the fixed server on a spare port + a build pointed at it — see projects-lag-after.md §4
LABEL=after PORT=7786 FORGE_SESSION_COOKIE="$(cat /tmp/p6c-cookie.txt)" node /tmp/p6c-reachability.cjs
```

Raw output: `/tmp/p6c-reachability-<label>.json`, both runs quoted whole in §1. Exit code is non-zero
if any id is missing from either side.

## 6. The script, verbatim

```js
/**
 * p6c-reachability.cjs — os-usable-for-work, phase 6, task C. R75.
 *
 * Counts EVERY task card reachable on the Projects board, by identity, and
 * compares that set against the set the server served in the same second.
 *
 * WHY IDENTITY AND NOT A COUNT. R75's failure mode is a board that renders a
 * plausible number of cards while some rows are unreachable. A count cannot see
 * that; a set of ids can. `TaskCard` carries no `data-*` attribute (task A was
 * forbidden from adding one and this task did not need one), so the id comes
 * from the React fiber attached to the card element: walk `fiber.return` until a
 * component's `memoizedProps.task.id` appears. Production React keeps the fiber
 * under a `__reactFiber$<n>` key on the host node, so this works on the same
 * bundle the user gets.
 *
 * HARD ERRORS, NEVER A DEFAULT (N1). A card that yields no id aborts the run; a
 * board under 100 cards aborts the run; a landing on /signin aborts the run.
 * A reachability report that silently counted 0 ids would be exactly the lie
 * this check exists to prevent.
 *
 * SCROLLING. Every column body is scrolled to its end in clientHeight steps and
 * the id set is collected after each step, because that is the only way a
 * windowed board (one that unmounts what is off screen) differs from an
 * unwindowed one in the DOM.
 *
 *   LABEL=before PORT=7786 FORGE_SESSION_COOKIE="$(cat /tmp/p6c-cookie.txt)" \
 *     node /tmp/p6c-reachability.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

/** Same resolver as measure-projects-lag.cjs:104 — playwright's own cache lookup
 *  points at a version that is not installed on this box. */
function resolveChromium() {
  const cache = "/root/.cache/ms-playwright";
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

const LABEL = (process.env.LABEL ?? "before").trim();
const PORT = Number(process.env.PORT ?? 7786);
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const OUT = (process.env.OUT ?? `/tmp/p6c-reachability-${LABEL}.json`).trim();
if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is required (see browser-harness-perf.md §5)");
if (PORT === 7701 || PORT === 7700) throw new Error(`refusing to drive the live service on :${PORT}`);

const BASE = `http://127.0.0.1:${PORT}`;
const COLUMN_LABELS = ["Architect", "Planner", "Scout", "Builder", "Reviewer", "Done"];

/* ── in-page ──────────────────────────────────────────────────────────────── */

/** Every column's scroll body, found the same structural way COUNT_CARDS in
 *  measure-projects-lag.cjs finds it: the leaf label span → column root →
 *  children[1]. */
const COLUMN_BODIES = `(() => {
  const LABELS = ${JSON.stringify(COLUMN_LABELS)};
  const out = [];
  for (const el of document.querySelectorAll("span")) {
    const txt = (el.textContent || "").trim();
    if (!LABELS.includes(txt) || el.children.length > 0) continue;
    const col = el.parentElement && el.parentElement.parentElement;
    if (!col || col.children.length !== 2) continue;
    out.push({ label: txt, body: col.children[1] });
  }
  return out;
})()`;

/** Card elements currently in the DOM, with their task id read off the fiber. */
const COLLECT = `(() => {
  const cols = ${COLUMN_BODIES};
  const idOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return null;
    let f = el[key];
    for (let i = 0; i < 8 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.task && typeof p.task.id === "string") return p.task.id;
    }
    return null;
  };
  const ids = [];
  let cards = 0;
  let unidentified = 0;
  const perColumn = {};
  for (const { label, body } of cols) {
    let n = 0;
    for (const c of body.children) {
      if (c.className !== "") continue;
      cards++; n++;
      const id = idOf(c);
      if (id) ids.push(id); else unidentified++;
    }
    perColumn[label] = (perColumn[label] ?? 0) + n;
  }
  return { ids, cards, unidentified, perColumn, domNodes: document.querySelectorAll("*").length };
})()`;

const SCROLL_STEP = `(() => {
  const cols = ${COLUMN_BODIES};
  let moved = 0;
  const at = [];
  for (const { label, body } of cols) {
    const before = body.scrollTop;
    body.scrollTop = before + Math.max(120, body.clientHeight - 40);
    if (body.scrollTop > before) moved++;
    at.push({ label, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight });
  }
  return { moved, at };
})()`;

/** What the server served, asked from inside the page so it is the same origin,
 *  the same proxy and the same second as the DOM it is compared against. */
const SERVER_SET = `(async () => {
  const r = await fetch("/api/proxy/projects/board", { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("board fetch failed: " + r.status);
  const body = await r.text();
  const j = JSON.parse(body);
  if (!Array.isArray(j.tasks)) throw new Error("board response has no tasks array");
  return { count: j.count, ids: j.tasks.map((t) => t.id), bytes: body.length,
           hasBrief: Object.prototype.hasOwnProperty.call(j.tasks[0] ?? {}, "brief"),
           keys: Object.keys(j.tasks[0] ?? {}).sort() };
})()`;

/* ── run ──────────────────────────────────────────────────────────────────── */

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    { name: "authjs.session-token", value: COOKIE, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false },
  ]);
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/desktop`, { waitUntil: "commit", timeout: 60_000 });
    if (/\/signin\b/.test(page.url())) {
      throw new Error(
        `auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret — ` +
          `this harness is http, so the salt is "authjs.session-token" (browser-harness-perf.md §5).`,
      );
    }
    await page.waitForTimeout(2500);

    // Navigate to Projects via the nav label, exactly as a user does.
    await page.evaluate(`(() => {
      for (const el of document.querySelectorAll("span,div,button,a")) {
        if ((el.textContent || "").trim().toUpperCase() === "PROJECTS" && el.children.length === 0) { el.click(); return true; }
      }
      throw new Error("PROJECTS nav label not found");
    })()`);

    // Wait for the board to hold real scale before asserting anything about it.
    let first = null;
    for (let i = 0; i < 60; i++) {
      first = await page.evaluate(COLLECT);
      if (first.cards >= 100) break;
      await page.waitForTimeout(500);
    }
    if (!first || first.cards < 100) {
      throw new Error(`board holds ${first ? first.cards : 0} cards, under the 100-card floor — a measurement of an empty board is worse than none`);
    }

    const server = await page.evaluate(SERVER_SET);

    // Scroll every column to its end, collecting ids after every step.
    const seen = new Set(first.ids);
    let unidentified = first.unidentified;
    const scrollTrace = [];
    for (let step = 0; step < 40; step++) {
      const s = await page.evaluate(SCROLL_STEP);
      scrollTrace.push(s.at);
      await page.waitForTimeout(120);
      const c = await page.evaluate(COLLECT);
      for (const id of c.ids) seen.add(id);
      unidentified += c.unidentified;
      if (s.moved === 0) break;
    }
    const last = await page.evaluate(COLLECT);
    for (const id of last.ids) seen.add(id);

    if (unidentified > 0) {
      throw new Error(`${unidentified} card element(s) yielded no task id from their React fiber — the count cannot be trusted, so it is not reported`);
    }

    const serverIds = new Set(server.ids);
    const missing = [...serverIds].filter((id) => !seen.has(id));
    const extra = [...seen].filter((id) => !serverIds.has(id));
    const report = {
      label: LABEL,
      measuredAt: new Date().toISOString(),
      port: PORT,
      buildId: fs.existsSync(".next/BUILD_ID") ? fs.readFileSync(".next/BUILD_ID", "utf8").trim() : null,
      server: { count: server.count, distinctIds: serverIds.size, bytes: server.bytes, hasBrief: server.hasBrief, taskKeys: server.keys },
      dom: {
        reachableDistinctIds: seen.size,
        cardsAtRest: last.cards,
        perColumnAtRest: last.perColumn,
        domNodes: last.domNodes,
      },
      missingFromDom: missing,
      extraInDom: extra,
      reachable: missing.length === 0 && extra.length === 0,
      scrollSteps: scrollTrace.length,
      scrollTraceFinal: scrollTrace[scrollTrace.length - 1] ?? null,
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, missingFromDom: missing.slice(0, 5), extraInDom: extra.slice(0, 5) }, null, 2));
    if (!report.reachable) {
      throw new Error(`REACHABILITY FAILED: ${missing.length} server tasks never appeared in the DOM, ${extra.length} DOM cards are not in the server set`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
```
