/**
 * check-dismiss-peek.tsx — the way back out of a dismissal, on both surfaces.
 *
 * ── The defect this pins ──────────────────────────────────────────────────
 * Round 1354's review, A4. `ChatTeamPanel.tsx` rendered ONE control in its
 * footer, labelled `{hiddenCount} hidden · show`, whose `onClick` was
 * `restoreAll` — `DELETE /api/agents/dismissals`, every dismissal on the
 * machine. Round 1350 had just moved dismissals from a per-chat localStorage
 * key to a global table, so a control promising to reveal THIS panel's hidden
 * rows now wiped the Live panel's too. The reviewer clicked it and lost eleven
 * unrelated dismissals: rows 15 → 16, and `GET /api/agents/dismissals` came
 * back `{"count":0}`.
 *
 * Nothing about that is visible in a predicate test. The predicate layer was
 * fine; the WIRING lied — a label that said "show" bound to a verb that
 * destroyed. So this script checks the two halves that could each be right
 * while the pair is wrong:
 *
 *   1. THE MARKUP. `TeamRowView` is rendered with `renderToStaticMarkup` in all
 *      three states and the emitted attributes are read out of the HTML — the
 *      same markup a browser would receive, with no browser and no engine.
 *      Same method as check-stop-affordance.tsx, and for the same reason.
 *
 *   2. THE WIRING, as source shape. Which handler sits behind which label is
 *      not in the markup (React serialises no `onClick`), and driving a click
 *      needs a DOM neither repo has (NFU8 forbids adding one). So each control
 *      is located by its `data-` attribute, its JSX element text is sliced out,
 *      and the assertions are about what that element may and may not call.
 *      Narrow and deliberately literal: the peek toggle may not mention
 *      `restoreAll`, and `restoreAll()` may be called only from the control
 *      that names itself "restore all" and only through the confirm machine.
 *      A structural check is the honest tool for a structural defect.
 *
 *   3. THE SHARED VOCABULARY. Both surfaces must render the SAME strings from
 *      ./peek rather than two copies that drift, which is how /live ended up
 *      with a correct affordance and the team panel with a destructive one.
 *      With ONE deliberate exception, asserted separately: the toggle's
 *      tooltip names the OTHER panel, so it must read differently on each.
 *      Round 1356 shared that sentence too and /live began telling the
 *      operator his dismissals are shared with the Live panel.
 *
 * Run (from forge-control-web, whose node_modules holds react/react-dom):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-dismiss-peek.tsx
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { Providers } from "../../forge-control-web/app/Providers.tsx";
import { TeamRowView } from "../../forge-control-web/app/desktop/team/TeamRow.tsx";
import {
  DISMISSAL_SURFACES,
  DISMISSED_GROUP_LABEL,
  HIDDEN_WITH_PARENT_MARK,
  HIDDEN_WITH_PARENT_TITLE,
  PEEK_OPACITY,
  RESTORE_ALL_LABEL,
  RESTORE_ROW_TITLE,
  dismissedToggleLabel,
  dismissedToggleTitle,
  restoreAllArmedLabel,
  restoreAllTitle,
} from "../../forge-control-web/app/desktop/team/peek.ts";
import type { TeamNode } from "../../forge-control-web/app/desktop/team/teamApi.ts";
import type { TeamRow } from "../../forge-control-web/app/desktop/team/teamRows.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PANEL = "forge-control-web/app/desktop/team/ChatTeamPanel.tsx";
const LIVE = "forge-control-web/app/desktop/live/AgentActivity.tsx";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok
        ? ""
        : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/* ── 1. The row, as it actually renders ───────────────────────────────────── */

function node(): TeamNode {
  return {
    id: "56c23edf-1111-4222-8333-444455556666",
    kind: "worker",
    role: "builder",
    model: "claude-opus-5",
    status: "completed",
    tokens: { input: 100, output: 20, cache_read: 0, cache_creation: 0, total: 120 },
    working_ms: 252_000,
    /* "thread", because this fixture is a RUN node and a run node cannot carry
     * anything else. `teamNodeFromRun` in forge-control/src/routes/chat.ts:555
     * ships `working_ms_source: timing ? "thread" : null` for every run;
     * "rollup" is reachable only from `subagentWorkingTime` (same file, :481),
     * the fallback for a SUB-AGENT with no thread slice of its own. A worker
     * with `subagents: []` and a non-null `working_ms` therefore has exactly
     * one permitted source, and "run" was never a member of the union at all
     * (`WorkingMsSource` = "thread" | "rollup", teamApi.ts:37). */
    working_ms_source: "thread",
    started_at: "2026-08-17T09:00:00.000Z",
    settled: true,
    description: "a row somebody dismissed",
    parent_id: "bfd1283a-b71b-4f35-b577-7d09aad803f2",
    dismissed_at: "2026-08-17T09:30:00.000Z",
    subagents: [],
    task: null,
  };
}

function row(): TeamRow {
  const n = node();
  /* `hidesRows: 1` is the only value `cascadeRowCount` can produce for this
   * node — a childless worker (`subagents: []`) — so the number is right, and
   * that is the whole of what can be claimed for it. It is NOT load-bearing
   * here: this file is INERT in `hidesRows`. Measured at 0, 1, 2, 5 and 165 —
   * ALL PASS at every one of them, in both directions across the
   * `needsConfirm` boundary at team/confirm.ts:173. The method is not blind:
   * the identical flip on a fixture that IS load-bearing,
   * check-team-confirm.ts:87 from 1 to 2, prints 2 FAILURE(S).
   *
   * The mechanism, because an unexplained inertness is one the next reader
   * "fixes": the only assertion below that could see the boundary is line 205,
   * `.includes("dismissed · show")` — and `dismissTitle`
   * (team/confirm.ts:244-263) builds that phrase once, as `undo`, then appends
   * it to ALL THREE of its return branches. A substring shared by every branch
   * is true at every value. Break the boundary for real — `> 1` → `>= 1` at
   * team/confirm.ts:173, which puts a confirm in front of every one-row
   * reversible dismissal — and this file still prints ALL PASS. What catches
   * it, measured: check-team-confirm.ts:378-396 (3 failures) and
   * check-r1873-fixes.ts:168/189 (2). The one-click/two-click rule is asserted
   * there, not here. */
  return {
    node: n,
    depth: 1,
    parentDescription: "operator chat",
    hidesRows: 1,
    displayWorkingMs: n.working_ms,
  };
}

const noop = (): void => {};

type State = "normal" | "peeked-restorable" | "peeked-with-parent";

function render(state: State): string {
  const common = {
    row: row(),
    armed: false,
    canStop: true,
    canTerminate: true,
    degradedTime: false,
    degradedTasks: false,
    onOpenNode: noop,
    onStop: noop,
    onX: noop,
  };
  return renderToStaticMarkup(
    <Providers>
      {state === "normal" ? (
        <TeamRowView {...common} />
      ) : (
        <TeamRowView
          {...common}
          peeked
          restorable={state === "peeked-restorable"}
          onRestore={noop}
        />
      )}
    </Providers>,
  );
}

/** One element's opening tag, verbatim, or null. */
function tag(html: string, attrName: string): string | null {
  const m = new RegExp(`<[a-z]+[^>]*\\b${attrName}\\b[^>]*>`).exec(html);
  return m ? m[0] : null;
}

function attr(t: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(t);
  return m ? (m[1] ?? null) : null;
}

console.log("── the row, normal ──────────────────────────────────────────");
{
  const html = render("normal");
  check("carries the ⏸", tag(html, "data-team-stop") !== null, true);
  check("carries the ✕", tag(html, "data-team-x") !== null, true);
  check("carries NO restore control", tag(html, "data-team-restore") === null, true);
  check("is not marked peeked", /data-team-peeked/.test(html), false);
  check("its controls are hover-gated by CSS", html.includes('class="team-row-controls"'), true);
  check(
    "the ✕ names the affordance that brings the row back",
    (attr(tag(html, "data-team-x") ?? "", "title") ?? "").includes("dismissed · show"),
    true,
  );
}

console.log("\n── the row, peeked and restorable ───────────────────────────");
{
  const html = render("peeked-restorable");
  const rowTag = tag(html, "data-team-row");
  const restore = tag(html, "data-team-restore");
  check("is marked peeked", attr(rowTag ?? "", "data-team-peeked"), "true");
  check(
    "…and faded by opacity, not by a colour",
    (attr(rowTag ?? "", "style") ?? "").includes(`opacity:${PEEK_OPACITY}`),
    true,
  );
  check("carries a restore control", restore !== null, true);
  check(
    "…keyed by the node id the handler will be given",
    attr(restore ?? "", "data-team-restore"),
    node().id,
  );
  check("…with the shared title", attr(restore ?? "", "title"), RESTORE_ROW_TITLE);
  check("…and it is a real button", (restore ?? "").startsWith("<button"), true);
  check("carries NO ⏸ — a hidden row's only verb is the way back", tag(html, "data-team-stop"), null);
  check("carries NO ✕", tag(html, "data-team-x"), null);
  check(
    "its restore is NOT hover-gated — the list was summoned on purpose",
    html.includes('class="team-row-controls"'),
    false,
  );
}

console.log("\n── the row, hidden together with its parent ─────────────────");
{
  const html = render("peeked-with-parent");
  const mark = tag(html, "data-team-hidden-with-parent");
  check("is marked peeked", /data-team-peeked="true"/.test(html), true);
  check("carries NO restore control", tag(html, "data-team-restore"), null);
  check("…because restoring it alone would change nothing on screen", mark !== null, true);
  check("…and says so instead of offering a dead button", attr(mark ?? "", "title"), HIDDEN_WITH_PARENT_TITLE);
  check("…as a span, not a disabled button", (mark ?? "").startsWith("<span"), true);
  check("…wearing the shared mark", html.includes(HIDDEN_WITH_PARENT_MARK), true);
  check("carries no ⏸ or ✕ either", tag(html, "data-team-stop") === null && tag(html, "data-team-x") === null, true);
}

console.log("\n── tokens only, all three states (NFU1: both themes) ────────");
for (const state of ["normal", "peeked-restorable", "peeked-with-parent"] as State[]) {
  const literals = render(state).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
  check(`${state}: no colour literal in the markup`, literals.length, 0);
}

/* ── 2. The wiring: which verb sits behind which label ────────────────────── */

/** The full JSX element that carries `attrName`, from its `<` to the matching
 *  `/>` or `</tag>`. Brace-aware enough for the two controls under test: it
 *  scans forward counting `{}` so an `onClick` body containing `>` or `/>` does
 *  not end the slice early. Throws rather than returning a short slice — a
 *  silently truncated element would make every assertion below vacuous. */
function element(source: string, attrName: string): string {
  const at = source.indexOf(attrName);
  if (at < 0) throw new Error(`${attrName} is not in the source at all`);
  const open = source.lastIndexOf("<", at);
  if (open < 0) throw new Error(`no opening tag before ${attrName}`);
  const tagName = /^<\s*([A-Za-z][\w.]*)/.exec(source.slice(open))?.[1];
  if (!tagName) throw new Error(`cannot read the tag name for ${attrName}`);
  const close = `</${tagName}>`;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && source.startsWith(close, i)) return source.slice(open, i + close.length);
    else if (depth === 0 && source.startsWith("/>", i)) return source.slice(open, i + 2);
  }
  throw new Error(`unterminated element for ${attrName}`);
}

console.log("\n── the panel's footer: label ↔ verb ─────────────────────────");
{
  const panel = src(PANEL);
  /* Presence first, and as an assertion rather than a crash: run this script
   * against round 1354's panel and there IS no peek toggle, which is the
   * headline finding and deserves a FAIL line, not a stack trace. */
  const hasToggle = panel.includes("data-team-dismissed-toggle");
  const hasRestoreAll = panel.includes("data-team-restore-all");
  check("the footer renders a peek toggle", hasToggle, true);
  check("…and a separately-labelled restore-all", hasRestoreAll, true);
}
if (src(PANEL).includes("data-team-dismissed-toggle") && src(PANEL).includes("data-team-restore-all")) {
  const panel = src(PANEL);
  const toggle = element(panel, "data-team-dismissed-toggle");
  const restoreAll = element(panel, "data-team-restore-all");

  check("the peek toggle only toggles", toggle.includes("setPeek("), true);
  check(
    "…and cannot reach restoreAll — THE round-1354 regression",
    /restoreAll/.test(toggle),
    false,
  );
  check("…and its label comes from ./peek", toggle.includes("dismissedToggleLabel("), true);
  check("…which never says 'restore'", /restore/i.test(dismissedToggleLabel(3, false)), false);

  check("restore-all names itself", restoreAll.includes("RESTORE_ALL_LABEL"), true);
  check("…goes through the confirm machine", restoreAll.includes("decideRestoreAllClick("), true);
  check("…and is the only caller of restoreAll in the file", panel.split("restoreAll()").length - 1, 1);
  check(
    "…it is rendered only while peeking",
    /\{peek && dismissed\.size > 0 && \(/.test(panel),
    true,
  );
  check("the label says the verb out loud", RESTORE_ALL_LABEL, "restore all");
  /* ROUND 1871, finding 12. The count alone was not enough: the customer test
   * saw "restore all 2?" beside a panel showing exactly two hidden rows and
   * read it as a two-row action being made harder than a one-click dismissal.
   * The scope now travels in the LABEL, not only in the tooltip. */
  check(
    "the armed label names the global count",
    restoreAllArmedLabel(11),
    "restore all 11 everywhere?",
  );
  check(
    "…and says the count is not just this panel's",
    restoreAllArmedLabel(2).includes("everywhere"),
    true,
  );
  check(
    "…and the tooltip warns it crosses panels",
    restoreAllTitle(11).includes("Live panel") && restoreAllTitle(11).includes("all 11"),
    true,
  );

  check("the peeked rows are rendered with their own restore", panel.includes("onRestore={handleRestore}"), true);
  check("…and handleRestore is the per-id verb, not the global one", panel.includes("restoreRef.current(nodeId)"), true);
  check("…under the shared heading", panel.includes("DISMISSED_GROUP_LABEL"), true);
}

console.log("\n── both surfaces, one vocabulary ────────────────────────────");
{
  const panel = src(PANEL);
  const live = src(LIVE);
  for (const [name, text] of [["team panel", panel], ["/live", live]] as const) {
    check(`${name} imports the shared peek vocabulary`, /from "(\.\.\/team\/peek|\.\/peek)"/.test(text), true);
    check(
      `${name} renders no hand-written "N dismissed · " label`,
      /\{[^}]*\} dismissed ·/.test(text),
      false,
    );
    check(`${name} uses dismissedToggleLabel`, text.includes("dismissedToggleLabel("), true);
    check(`${name} renders the shared group heading`, text.includes("DISMISSED_GROUP_LABEL"), true);
  }
  check("the toggle label reads the same on both", dismissedToggleLabel(4, false), "4 dismissed · show");
  check("…and flips to hide when open", dismissedToggleLabel(4, true), "4 dismissed · hide");
  check("the group heading is one constant", DISMISSED_GROUP_LABEL, "DISMISSED");
}

/* ── 3. …but the tooltip names the OTHER surface ──────────────────────────────
 *
 * The one string in ./peek that may NOT read identically on both panels. Its
 * whole job is to answer "where else does this dismissal apply?", so a panel
 * that names itself answers nothing — which is exactly what round 1356 shipped
 * when it hoisted the chat panel's wording into a bare constant and /live
 * started promising the operator that /live shares with /live.
 *
 * Asserted at the render site, not on the constant: the defect was in which
 * argument each panel passes, and only the JSX carries that. */
console.log("\n── the tooltip names the OTHER panel ────────────────────────");
{
  const surfaces = [
    { name: "/live", text: src(LIVE), attr: "data-live-dismissed-toggle", self: DISMISSAL_SURFACES.live, other: DISMISSAL_SURFACES.team },
    { name: "team panel", text: src(PANEL), attr: "data-team-dismissed-toggle", self: DISMISSAL_SURFACES.team, other: DISMISSAL_SURFACES.live },
  ] as const;

  for (const s of surfaces) {
    const toggle = element(s.text, s.attr);
    check(
      `${s.name}: its toggle's title comes from dismissedToggleTitle()`,
      /title=\{\s*dismissedToggleTitle\(/.test(toggle),
      true,
    );
    /* The argument, read out of the element rather than trusted: the key it
     * passes must be the key of the OTHER panel. */
    const arg = /dismissedToggleTitle\(\s*DISMISSAL_SURFACES\.(\w+)\s*\)/.exec(toggle)?.[1] ?? null;
    check(`${s.name}: …passing the other surface`, arg === null ? null : DISMISSAL_SURFACES[arg as keyof typeof DISMISSAL_SURFACES], s.other);
    check(`${s.name}: …and never naming itself — THE round-1356 regression`, arg === null ? null : DISMISSAL_SURFACES[arg as keyof typeof DISMISSAL_SURFACES] === s.self, false);
    /* And no panel may go back to a hand-written copy of the sentence. Anchored
     * on the tooltip's own distinctive clause, not on the word "shared" — both
     * files legitimately say in PROSE that the dismissal store is shared with
     * the other panel, and a check that forbade that would be forbidding the
     * truth. */
    check(`${s.name}: hand-writes no copy of the sentence`, /the set is shared with/.test(s.text), false);
  }

  check(
    "the sentence still says dismissing never deletes",
    dismissedToggleTitle(DISMISSAL_SURFACES.team).includes("it never deletes anything"),
    true,
  );
  check(
    "…and the two readings differ",
    dismissedToggleTitle(DISMISSAL_SURFACES.live) === dismissedToggleTitle(DISMISSAL_SURFACES.team),
    false,
  );
  /* ROUND 1875 — the sentence grew a third clause. Round 1874's finding 2 was
   * this label saying "21 dismissed" beside a toast saying "180 rows hidden",
   * with nothing on screen to reconcile them; the toast now leads with the
   * local number (`hideToastText`) and this says what the local number MEANS.
   * The two properties these assertions exist for are unchanged and asserted
   * above: each panel names the OTHER surface, and the two readings differ. */
  check(
    "the /live reading names the chat team panel",
    dismissedToggleTitle(DISMISSAL_SURFACES.team),
    "Show the rows dismissed from this panel. Dismissing hides a row; it never " +
      "deletes anything, and the set is shared with the chat team panel. This count is " +
      "the rows THIS panel is withholding — one dismissal can hide runs that were " +
      "never listed here, which is why a cascade's toast can name a larger number.",
  );
  check(
    "the team panel's reading names the Live panel",
    dismissedToggleTitle(DISMISSAL_SURFACES.live),
    "Show the rows dismissed from this panel. Dismissing hides a row; it never " +
      "deletes anything, and the set is shared with the Live panel. This count is " +
      "the rows THIS panel is withholding — one dismissal can hide runs that were " +
      "never listed here, which is why a cascade's toast can name a larger number.",
  );
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — dismissal peek affordance`,
);
process.exit(failures === 0 ? 0 : 1);
