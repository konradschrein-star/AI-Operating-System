/** The destructive-control state machine of the team panel — extracted here,
 *  away from the component, for one reason: the reviewer is going to attack it
 *  (14-ui-v3-quality.md §500, "RED-TEAM (destructive controls) … confirm-step
 *  bypass by rapid clicks"), and an attack you can only mount through a
 *  browser is an attack nobody re-runs. This module has no React, no DOM and
 *  no clock of its own — every `now` arrives as an argument — so
 *  `scripts/checks/check-team-confirm.ts` asserts the whole machine under tsx
 *  in milliseconds. Same reason `teamRows.ts` is React-free.
 *
 *  Three separate defences protect the destructive path, and they are meant to
 *  be redundant:
 *
 *    1. `decideXClick` never returns `terminate` unless `canTerminate` is
 *       true — the capability gate, expressed as a value, not as a disabled
 *       attribute the reviewer can strip in devtools.
 *    2. The component re-checks the same flag as a literal guard clause
 *       before acting on the decision.
 *    3. There is NO fetch call for stop/terminate anywhere in this directory.
 *       With today's all-false capabilities the panel is not merely forbidden
 *       from issuing a control-plane request — it is incapable of it, because
 *       the request does not exist. The engine lane (engine-v2-research-lane)
 *       ships the contract; see the endpoint note in ChatTeamPanel.tsx.
 *
 *  ── What counts as destructive ────────────────────────────────────────────
 *  X on a RUNNING row is terminate: it would kill work in flight, and it gets
 *  the two-click confirm. X on a SETTLED row is a local dismissal — hidden,
 *  never deleted, reversible from the panel's own "N hidden · show"
 *  affordance (see ./dismissals) — so it fires on a single click. A confirm
 *  step in front of a reversible action trains people to click through
 *  confirms, which is how the irreversible one eventually gets clicked too.
 */

/** How long an armed button stays armed before it disarms itself. U17: "first
 *  click arms the button …, auto-disarms after 3s". The component also runs a
 *  timer for the visual disarm; this constant is what makes the machine
 *  correct even if that timer never fires (backgrounded tab, throttled
 *  timers) — a stale arming re-arms rather than firing. */
export const ARM_WINDOW_MS = 3_000;

/** The floor between arming and firing. A physical double-click, a synthetic
 *  `dblclick`, and two `click` events dispatched in the same tick all deliver
 *  their second click with a delta far under this; none of them may fire a
 *  terminate. 150ms is longer than any double-click interval a browser
 *  reports and far shorter than a deliberate second click. */
export const MIN_CONFIRM_MS = 150;

/** Which row is armed, and when it was armed. One instance for the whole
 *  panel — arming a second row replaces this, which is what disarms the
 *  first (U17). */
export interface ArmedState {
  id: string;
  /** `Date.now()` at the arming click. */
  at: number;
}

/** What the panel should do about one click on `[data-team-x]`.
 *
 *  `blocked` is a first-class outcome rather than a silent `return`: the
 *  component logs nothing, but the check script asserts the REASON, so
 *  "capability gate held" and "double-click was swallowed" cannot be confused
 *  with each other in a test the way two `undefined`s would be. */
export type XDecision =
  | { action: "dismiss"; id: string }
  | { action: "arm"; id: string }
  | { action: "terminate"; id: string }
  | { action: "blocked"; reason: "capability" | "too-fast" };

export interface XClickInput {
  nodeId: string;
  /** From `TeamNode.settled` — settled means dismiss, running means terminate. */
  settled: boolean;
  /** The panel's single armed slot, or null. */
  armed: ArmedState | null;
  /** `Date.now()` at the click. */
  nowMs: number;
  /** `capabilities.control_plane.terminate`. False everywhere today. */
  canTerminate: boolean;
}

/**
 * The whole X-button machine, in evaluation order.
 *
 * Arming deliberately happens BEFORE the capability check. Arming issues no
 * request and changes nothing outside this panel — it is a label swap. Putting
 * the capability gate in front of it would make the armed state unreachable
 * even to a reviewer who strips the `disabled` attribute, and then nobody
 * could ever see the confirm step actually hold. Instead the armed path
 * dead-ends one step later, at rule 5, which is precisely the behaviour the
 * brief asks to be proven: with `canTerminate: false` you can arm, and the
 * fire is refused.
 */
export function decideXClick(i: XClickInput): XDecision {
  // 1. Settled row: dismiss. Reversible, so no confirm (see header).
  if (i.settled) return { action: "dismiss", id: i.nodeId };

  // 2. Nothing armed, or a different row is armed → this click arms this row.
  //    Arming a different row is what disarms the previous one: there is one
  //    slot, and this returns the id that should occupy it.
  if (i.armed === null || i.armed.id !== i.nodeId) {
    return { action: "arm", id: i.nodeId };
  }

  const sinceArm = i.nowMs - i.armed.at;

  // 3. The arming has gone stale (timer throttled, tab backgrounded). Treat it
  //    as expired and start over rather than honouring a three-minute-old
  //    "sure?" the user has long since forgotten.
  if (sinceArm > ARM_WINDOW_MS) return { action: "arm", id: i.nodeId };

  // 4. Too fast to be a decision. Covers double-click, synthetic dblclick, and
  //    two clicks dispatched in one tick (sinceArm === 0). A clock that ran
  //    backwards lands here too, which is the safe side.
  if (sinceArm < MIN_CONFIRM_MS) return { action: "blocked", reason: "too-fast" };

  // 5. The capability gate — the guard the reviewer will try to walk around by
  //    deleting the `disabled` attribute. It lives in the decision, not in the
  //    markup, so deleting markup does not reach it.
  if (!i.canTerminate) return { action: "blocked", reason: "capability" };

  return { action: "terminate", id: i.nodeId };
}

/** Whether `[data-team-x]` on this row should render `data-confirm="armed"`.
 *
 *  The component drives the attribute off its own `armedId` state (one
 *  boolean prop per row, so exactly two rows re-render when arming moves);
 *  this function is the same predicate with the clock made explicit, used by
 *  the check script to assert that a stale arming reads as disarmed even when
 *  no timer ever ran. */
export function isArmed(
  armed: ArmedState | null,
  nodeId: string,
  nowMs: number,
): boolean {
  if (armed === null || armed.id !== nodeId) return false;
  const sinceArm = nowMs - armed.at;
  return sinceArm >= 0 && sinceArm <= ARM_WINDOW_MS;
}

export type StopDecision =
  | { action: "stop"; id: string }
  | { action: "blocked"; reason: "capability" | "settled" };

/** Stop is not destructive (the run keeps its transcript and can be resumed),
 *  so it has no confirm step — but it carries the same capability gate and
 *  the same "expressed as a value" property. It is also meaningless on a row
 *  that has already settled, and says so rather than pretending to work. */
export function decideStopClick(i: {
  nodeId: string;
  settled: boolean;
  canStop: boolean;
}): StopDecision {
  if (!i.canStop) return { action: "blocked", reason: "capability" };
  if (i.settled) return { action: "blocked", reason: "settled" };
  return { action: "stop", id: i.nodeId };
}

/** The exact tooltip a capability-gated control wears (NFU6: disabled with a
 *  reason, never hidden, never a silent no-op). The flag name is in the text
 *  on purpose — it is the string to grep for in
 *  `forge-control/src/routes/capabilities.ts` when wondering why a button is
 *  dead. */
export function capabilityTitle(flag: "stop" | "terminate"): string {
  return `engine support pending (control plane contract: ${flag})`;
}
