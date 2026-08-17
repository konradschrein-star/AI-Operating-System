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
  DISMISSED_GROUP_LABEL,
  HIDDEN_WITH_PARENT_MARK,
  HIDDEN_WITH_PARENT_TITLE,
  PEEK_OPACITY,
  RESTORE_ALL_LABEL,
  RESTORE_ROW_TITLE,
  dismissedToggleLabel,
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
    working_ms_source: "run",
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
  return { node: n, depth: 1, parentDescription: "operator chat", displayWorkingMs: n.working_ms };
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
  check("the armed label names the global count", restoreAllArmedLabel(11), "restore all 11?");
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

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — dismissal peek affordance`,
);
process.exit(failures === 0 ? 0 : 1);
