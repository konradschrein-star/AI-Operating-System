/**
 * check-stop-affordance.tsx — the ⏸ button's rendered affordance must agree
 * with what a click actually does. Round 1353's review, finding 1.
 *
 * The defect this pins, in full: `TeamRow.tsx` shipped
 * `disabled={!canStop}` — a CAPABILITY-only gate. While
 * `GET /api/capabilities` answered `stop:false` that was indistinguishable
 * from correct, because every button was dead anyway. Round 1353 flipped the
 * flag to `true`, and from that commit onward every COMPLETED row rendered an
 * ENABLED ⏸: `cursor: pointer`, colour `tokens.warn`, title "Stop this agent".
 * Clicking it reached `decideStopClick` → `{action:"blocked",
 * reason:"settled"}` and the panel discarded it with a bare `return`. Zero
 * network requests, zero toasts. NFU6 forbids a silent no-op; a capability
 * flip turned an honestly-disabled button into one.
 *
 * A predicate test alone would not have caught it — `decideStopClick` was
 * already right about settled rows (check-team-confirm.ts asserted exactly
 * that, and passed). What was wrong was the BUTTON, so this script asserts the
 * button: it renders `TeamRowView` with `renderToStaticMarkup` and reads the
 * emitted `<button data-team-stop …>` attributes out of the HTML. The same
 * markup a browser would receive, with no browser and no engine.
 *
 * Covered — the full 2×2 of (capability on/off) × (row settled/running):
 *
 *   canStop  settled | disabled | title                       | cursor
 *   ---------+-------+----------+-----------------------------+-----------
 *   true     false   | no       | Stop this agent             | pointer
 *   true     TRUE    | YES      | SETTLED_STOP_TITLE          | not-allowed
 *   false    false   | YES      | capabilityTitle("stop")     | not-allowed
 *   false    TRUE    | YES      | capabilityTitle("stop")     | not-allowed
 *
 * Row 2 is the regression — the one production is in today, with `stop:true`
 * and a completed row on screen. Row 4 pins the PRECEDENCE rather than leaving
 * it to be discovered: `decideStopClick` tests the capability first, so when
 * both reasons apply the button reports the capability. Asserted, not assumed
 * — if someone reorders those two lines this check goes red and they have to
 * mean it.
 *
 * Also asserted:
 *   • the two reasons agree with `decideStopClick`'s own verdict for the same
 *     inputs, which is what makes `stopBlockReason` a re-reading of that
 *     function rather than a second, driftable predicate;
 *   • no colour literal reaches the markup (NFU1 — both themes).
 *
 * Run (from forge-control-web, whose node_modules holds react/react-dom):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-stop-affordance.tsx
 */

import { renderToStaticMarkup } from "react-dom/server";

import {
  SETTLED_STOP_TITLE,
  capabilityTitle,
  decideStopClick,
  stopBlockReason,
} from "../../forge-control-web/app/desktop/team/confirm.ts";
import { TeamRowView } from "../../forge-control-web/app/desktop/team/TeamRow.tsx";
/* The row mounts `RunShotsIndicator`, which calls `useQuery` — without a real
 * provider above it the render THROWS and every assertion below would be
 * skipped rather than failed. Reusing the app's own `Providers` (as
 * check-settings-surface.tsx does, and for the same reason) mints a fresh
 * client per render and proves the row against the provider tree it actually
 * runs under. No fetch fires: query-core gates eager-fetch-in-render behind
 * `!isServer`, and `typeof window === "undefined"` here. */
import { Providers } from "../../forge-control-web/app/Providers.tsx";
import type { TeamNode } from "../../forge-control-web/app/desktop/team/teamApi.ts";
import type { TeamRow } from "../../forge-control-web/app/desktop/team/teamRows.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

/* ── Fixture ──────────────────────────────────────────────────────────────
 *
 * A worker row, because a worker is the row a stop is FOR. Everything not
 * under test is filled with the shape the API actually sends (see
 * forge-control/src/routes/team.ts) rather than with zeroes — a fixture that
 * cannot render is a check that never runs.
 */

function node(settled: boolean): TeamNode {
  return {
    id: "56c23edf-1111-4222-8333-444455556666",
    kind: "worker",
    role: "builder",
    model: "claude-opus-5",
    status: settled ? "completed" : "running",
    tokens: { input: 100, output: 20, cache_read: 0, cache_creation: 0, total: 120 },
    working_ms: 252_000,
    /* "thread" — the only source a RUN node can carry. `teamNodeFromRun`
     * (forge-control/src/routes/chat.ts:555) ships `timing ? "thread" : null`
     * for runs; "rollup" belongs to `subagentWorkingTime` (:481), the sub-agent
     * fallback when there is no thread slice. This fixture is a worker run with
     * `subagents: []` and a measured 252s, so "thread" is what the wire would
     * actually say. "run" was never a member of `WorkingMsSource`. */
    working_ms_source: "thread",
    started_at: "2026-08-17T09:00:00.000Z",
    settled,
    description: "fix the stop button's affordance",
    parent_id: "bfd1283a-b71b-4f35-b577-7d09aad803f2",
    dismissed_at: null,
    subagents: [],
    task: null,
  };
}

function row(settled: boolean): TeamRow {
  const n = node(settled);
  /* 1 — the leaf. Two reasons, and they agree: `cascadeRowCount` cannot return
   * anything else for a node with `subagents: []`, and 1 is the value that
   * keeps the row rendering the affordance these assertions describe. The ⏸
   * under test does not read `hidesRows`, but the ✕ beside it does
   * (`data-x-confirms={needsConfirm(scope)}` in TeamRow.tsx): at 1 a settled
   * row's ✕ is the one-click dismissal and a running row's ✕ is the
   * capability-gated terminate — the two states the CASES table walks. A value
   * above 1 would put the settled row's ✕ into the two-click cascade machine,
   * i.e. a control this fixture's node has nothing to cascade over. */
  return {
    node: n,
    depth: 1,
    parentDescription: "operator chat",
    hidesRows: 1,
    displayWorkingMs: n.working_ms,
  };
}

const noop = (): void => {};

/** The `<button data-team-stop …>` tag, verbatim, out of the rendered HTML. */
function stopTag(canStop: boolean, settled: boolean): string {
  const html = renderToStaticMarkup(
    <Providers>
      <TeamRowView
        row={row(settled)}
        armed={false}
        canStop={canStop}
        canTerminate={false}
        degradedTime={false}
        degradedTasks={false}
        onOpenNode={noop}
        onStop={noop}
        onX={noop}
      />
    </Providers>,
  );
  const m = /<button[^>]*\bdata-team-stop\b[^>]*>/.exec(html);
  if (!m) {
    // Not a soft failure: if the button stopped rendering, every assertion
    // below would vacuously "pass" against an empty string.
    throw new Error(
      "no <button data-team-stop> in the rendered row — the control moved or " +
        "was removed, and this check can no longer see what it exists to see.",
    );
  }
  return m[0];
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? (m[1] ?? null) : null;
}

/** React emits a boolean `disabled` with no value; absent means enabled. */
function isDisabled(tag: string): boolean {
  return /\bdisabled\b(?!=)/.test(tag) || attr(tag, "disabled") === "";
}

/** `cursor:pointer` inside the inline style — the visual half of the promise. */
function cursor(tag: string): string {
  const style = attr(tag, "style") ?? "";
  const m = /cursor:\s*([a-z-]+)/.exec(style);
  return m?.[1] ?? "<none>";
}

interface Case {
  canStop: boolean;
  settled: boolean;
  disabled: boolean;
  title: string;
  cursor: string;
  /** What `decideStopClick` says for the same inputs. */
  decision: string;
}

const CASES: Case[] = [
  {
    canStop: true,
    settled: false,
    disabled: false,
    title: "Stop this agent",
    cursor: "pointer",
    decision: "stop",
  },
  {
    canStop: true,
    settled: true,
    disabled: true,
    title: SETTLED_STOP_TITLE,
    cursor: "not-allowed",
    decision: "blocked:settled",
  },
  {
    canStop: false,
    settled: false,
    disabled: true,
    title: capabilityTitle("stop"),
    cursor: "not-allowed",
    decision: "blocked:capability",
  },
  {
    canStop: false,
    settled: true,
    disabled: true,
    // Precedence: capability is checked first by `decideStopClick`, so BOTH
    // the decision and the title say "capability" here. That is deliberate and
    // asserted rather than assumed — an engine with no stop verb is the more
    // actionable sentence when the row is also settled.
    title: capabilityTitle("stop"),
    cursor: "not-allowed",
    decision: "blocked:capability",
  },
];

console.log("── the ⏸ button, as it actually renders ─────────────────────");
for (const c of CASES) {
  const label = `canStop=${c.canStop} settled=${c.settled}`;
  const tag = stopTag(c.canStop, c.settled);
  check(`${label} → disabled`, isDisabled(tag), c.disabled);
  check(`${label} → title`, attr(tag, "title"), c.title);
  check(`${label} → cursor`, cursor(tag), c.cursor);
  check(
    `${label} → data-stop-blocked`,
    attr(tag, "data-stop-blocked"),
    stopBlockReason({ settled: c.settled, canStop: c.canStop }) ?? "none",
  );

  const d = decideStopClick({ nodeId: "x", settled: c.settled, canStop: c.canStop });
  check(
    `${label} → the click decision agrees with the affordance`,
    d.action === "blocked" ? `blocked:${d.reason}` : d.action,
    c.decision,
  );
}

console.log("\n── the regression, stated on its own ────────────────────────");
{
  // The exact configuration production is in after 8ec83cc: stop:true, and a
  // completed row on screen. Before this fix the tag below carried neither
  // `disabled` nor a "nothing to stop" title.
  const tag = stopTag(true, true);
  check(
    "a COMPLETED row with stop:true renders a DISABLED ⏸",
    isDisabled(tag),
    true,
  );
  check(
    "…and says why, without blaming the engine",
    (attr(tag, "title") ?? "").includes("engine support pending"),
    false,
  );
}

console.log("\n── tokens only (NFU1: both themes) ──────────────────────────");
{
  const html = renderToStaticMarkup(
    <Providers>
      <TeamRowView
        row={row(true)}
        armed={false}
        canStop={true}
        canTerminate={true}
        degradedTime={false}
        degradedTasks={false}
        onOpenNode={noop}
        onStop={noop}
        onX={noop}
      />
    </Providers>,
  );
  const literals = html.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [];
  check("no colour literal in the rendered row", literals.length, 0);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — stop affordance`,
);
process.exit(failures === 0 ? 0 : 1);
