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
 *  ── Why the confirm floor RESETS the window (round 505 finding #1) ───────
 *  The floor used to be a delay rather than a gate: a swallowed click left
 *  `armed.at` untouched, so a sustained stream of activations kept growing
 *  `sinceArm` until it crossed the floor on its own and fired. Twenty clicks
 *  30ms apart produced three terminates; one held Enter key produced four.
 *  An under-floor click now returns `rearm`, which RE-STAMPS `armed.at` to the
 *  click's own clock — so a continuous stream can never accumulate a floor's
 *  worth of separation, no matter how long it runs. The floor is only crossed
 *  by a genuine pause.
 *
 *  Two more halves live in the row, expressed as `isSpuriousActivation` below
 *  so they are values this file's check script can assert rather than inline
 *  lambdas nobody tests: the second half of a double-click (`detail > 1`) and
 *  every auto-repeat keydown (`repeat`) are dropped before they reach the
 *  machine at all.
 *
 *  ── What counts as destructive ────────────────────────────────────────────
 *  X on a RUNNING row is terminate: it would kill work in flight, and it gets
 *  the two-click confirm. X on a SETTLED row is a local dismissal — hidden,
 *  never deleted, reversible — so a dismissal that hides ONLY THE ROW YOU
 *  CLICKED fires on a single click, with an undo in the toast it raises. A
 *  confirm step in front of a one-row, reversible, undoable action trains
 *  people to click through confirms, which is how the irreversible one
 *  eventually gets clicked too.
 *
 *  ── The blast radius decides, not the verb (round 1873, finding 2) ────────
 *  That reasoning held for a leaf and was wrong at the top of the tree. A
 *  dismissal CASCADES: the server hides everything settled under the target,
 *  and for an operator chat its project's finished workers too
 *  (`resolveCascade`). Round 1872's tester clicked one ✕ on the manager row and
 *  hid 174 nodes — 165 of 166 rows on screen — with no confirm, no undo toast
 *  and only the fleet-wide "restore all" as a way back. Meanwhile that harmless
 *  direction took two clicks. The guard was on the wrong control.
 *
 *  So `decideXClick` now takes `hidesRows` — how many rows the panel will
 *  actually lose (`cascadeRowCount` in ./teamRows) — and the SIZE of the gesture
 *  decides whether it needs confirming:
 *
 *    hidesRows <= 1   one click. The cheap, common, single-row hide, undoable
 *                     from the toast it raises.
 *    hidesRows >  1   the same two-click machine terminate uses, on the same two
 *                     constants, with the count in the button label — "hide 165?"
 *                     is a sentence the operator can refuse.
 *
 *  Restore-all keeps ITS confirm (`decideRestoreAllClick`), and that is not the
 *  asymmetry the tester read it as. It is not the reverse of one dismissal; it
 *  deletes EVERY dismissal on the machine, across both panels and every project,
 *  and the set of forty individual decisions it destroys cannot be
 *  reconstructed. The reverse of one dismissal is the undo in its own toast, and
 *  that now costs one click. The guarded directions are the ones that lose
 *  something.
 *
 *  RESTORE ALL is the third destructive control, added to this file in round
 *  1355 — see `decideRestoreAllClick` at the bottom. It destroys no run, but it
 *  destroys STATE the operator cannot reconstruct: which forty rows they had
 *  hidden, across every project and both panels.
 */

/** How long an armed button stays armed before it disarms itself. U17: "first
 *  click arms the button …, auto-disarms after 3s". The component also runs a
 *  timer for the visual disarm; this constant is what makes the machine
 *  correct even if that timer never fires (backgrounded tab, throttled
 *  timers) — a stale arming re-arms rather than firing. */
export const ARM_WINDOW_MS = 3_000;

/** The floor between arming and firing.
 *
 *  It was 150ms, on the reasoning that this is "longer than any double-click
 *  interval a browser reports". That reasoning was wrong: platform multi-click
 *  intervals are ~500ms, which is why round 506's browser protocol could still
 *  land a terminate with four discrete clicks 350ms apart — each one reported
 *  `detail: 1`, so the double-click guard never saw them, and 350 > 150 read
 *  as a deliberate confirmation. Rage-clicking a button is not a decision.
 *
 *  500ms is the platform's own answer to "was that one gesture or two", and it
 *  is still only a fifth of the 3s arm window, so a person who reads "sure?"
 *  and clicks has 2.5 full seconds to do it. Nothing a hand does inside half a
 *  second is a considered second act. */
export const MIN_CONFIRM_MS = 500;

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
 *  Every outcome is a first-class value rather than a silent `return`: the
 *  component logs nothing, but the check script asserts which one came back,
 *  so "capability gate held" and "the click was too fast" cannot be confused
 *  with each other in a test the way two `undefined`s would be.
 *
 *  `arm` and `rearm` ask the component for the same state write —
 *  `{ id, at: nowMs }` — and are two actions rather than one because they mean
 *  different things: `arm` is a user starting a confirm, `rearm` is a
 *  too-fast click being swallowed AND pushing the window back so a stream
 *  cannot accumulate its way past the floor. */
export type XDecision =
  | { action: "dismiss"; id: string }
  | { action: "arm"; id: string }
  | { action: "rearm"; id: string }
  | { action: "terminate"; id: string }
  | { action: "blocked"; reason: "capability" };

export interface XClickInput {
  nodeId: string;
  /** From `TeamNode.settled` — settled means dismiss, running means terminate. */
  settled: boolean;
  /** `TeamRow.hidesRows` — how many rows this click takes off the panel, the
   *  clicked row included. 1 is a leaf; anything more is a cascade and gets the
   *  confirm step (see the header). Values below 1 are treated as 1: a
   *  dismissal always hides at least the row it was aimed at. */
  hidesRows: number;
  /** The panel's single armed slot, or null. */
  armed: ArmedState | null;
  /** `Date.now()` at the click. */
  nowMs: number;
  /** `capabilities.control_plane.terminate`. False everywhere today. */
  canTerminate: boolean;
}

/** What one ✕ is about to cost, as both surfaces describe it.
 *
 *  `widerReach` is the /live panel's honest caveat and is false everywhere in
 *  the team panel. That panel holds a whole org chart and can therefore COUNT
 *  what a cascade takes; `/api/agents` is a flat list that says which project a
 *  worker belongs to but not which chat STARTED that project, so dismissing an
 *  operator row there hides finished workers the panel cannot enumerate in
 *  advance. Naming the gap is the difference between an estimate and a lie. */
export interface DismissScope {
  settled: boolean;
  /** Rows this panel can SEE going, the clicked row included. Never below 1. */
  hidesRows: number;
  widerReach?: boolean;
}

/** Does this click fire straight away, or does it have to be confirmed?
 *
 *  Exported because four places must agree about it and only one of them is a
 *  click: the decision below, the button's LABEL (a row whose ✕ will ask for a
 *  confirm says so in its tooltip before it is touched), the /live panel's own
 *  ✕, and the check script. */
export function needsConfirm(i: DismissScope): boolean {
  if (!i.settled) return true; // terminate — always
  if (i.widerReach === true) return true; // hides rows it cannot count
  return i.hidesRows > 1; // a cascade of hides
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
  // 1. A settled row that hides ONLY ITSELF: dismiss. Reversible, undoable from
  //    the toast, one row — no confirm (see header). Everything else, dismissal
  //    or terminate, goes through the same two-click machine below.
  if (!needsConfirm(i)) return { action: "dismiss", id: i.nodeId };

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
  //
  //    It returns `rearm`, not a bare block: the window restarts at THIS
  //    click. That is what makes the floor a gate instead of a delay — a
  //    sustained stream of activations keeps resetting its own separation and
  //    can never reach MIN_CONFIRM_MS, so no amount of clicking fast is a
  //    substitute for clicking twice deliberately (round 505 finding #1).
  if (sinceArm < MIN_CONFIRM_MS) return { action: "rearm", id: i.nodeId };

  // 5. A CONFIRMED CASCADE. The row is settled, so nothing is killed — but 165
  //    rows are about to leave the panel, and the operator has now said so
  //    twice. There is no capability gate on this path: hiding rows is the
  //    client's own business and the engine has no verb in it.
  if (i.settled) return { action: "dismiss", id: i.nodeId };

  // 6. The capability gate — the guard the reviewer will try to walk around by
  //    deleting the `disabled` attribute. It lives in the decision, not in the
  //    markup, so deleting markup does not reach it.
  if (!i.canTerminate) return { action: "blocked", reason: "capability" };

  return { action: "terminate", id: i.nodeId };
}

/* ── What the ✕ says, at each of its three jobs ───────────────────────────
 *
 * The words are here rather than inline in the row for the same reason the
 * decisions are: the label and the behaviour must be two readings of one fact.
 * A row whose click will ask for a confirm says so in its tooltip BEFORE it is
 * touched — round 1872's tester clicked a ✕ that promised "reversible from N
 * dismissed · show" and lost 165 rows, which the tooltip was technically not
 * wrong about and practically useless for.
 */

/** The tooltip the ✕ wears on a settled row, given its blast radius. */
export function dismissTitle(i: DismissScope): string {
  const undo =
    "Reversible: the toast offers an undo of exactly this gesture, and every " +
    "hidden row stays listed under “N dismissed · show”.";
  if (i.widerReach === true) {
    return (
      `Hide this row, everything settled under it, and — if this chat started a ` +
      `project — that project's finished workers, which this panel cannot count ` +
      `in advance. Click twice to confirm. ${undo}`
    );
  }
  if (i.hidesRows > 1) {
    return (
      `Hide this row and the ${i.hidesRows - 1} settled row${i.hidesRows === 2 ? "" : "s"} ` +
      `under it — ${i.hidesRows} in total. Click twice to confirm. ${undo} The server ` +
      `may also hide finished runs of the same project that this tree is not listing.`
    );
  }
  return `Hide this row. Nothing else goes with it. ${undo}`;
}

/** What the armed ✕ prints.
 *
 *  FIVE CHARACTERS, both of them, and that is a constraint rather than a
 *  coincidence: `X_COL` in ./TeamRow reserves exactly the width of "sure?" so
 *  that arming a row changes no rectangle (round 1355, finding #4). "hide 165?"
 *  would have reflowed the row it is trying to warn about. The COUNT is where a
 *  count belongs — on a line with room for a sentence, `confirmStripText`. */
export function armedXLabel(i: DismissScope): string {
  return i.settled ? "hide?" : "sure?";
}

/** The line an armed row grows, naming what the second click will cost. It is
 *  the whole reason the confirm exists: "sure?" over 165 rows is not informed
 *  consent, and a tooltip you have to hover for is not either. */
export function confirmStripText(i: DismissScope): string {
  if (!i.settled) return "terminate this running agent? ✕ again to confirm";
  if (i.widerReach === true) {
    return (
      `hide ${i.hidesRows}+ rows — this one, everything settled under it, and any ` +
      `project this chat started? ✕ again to confirm`
    );
  }
  return (
    `hide ${i.hidesRows} rows — this one and the ${i.hidesRows - 1} settled ` +
    `under it? ✕ again to confirm`
  );
}

/** One raw activation of a button, reduced to the two fields that decide
 *  whether it is a human decision or a machine repeating itself. */
export interface Activation {
  /** `MouseEvent.detail`: 1 for a single click, 2 for the second click of a
   *  double-click, 3+ for the third and beyond, 0 for keyboard activation. */
  detail: number;
  /** `KeyboardEvent.repeat`: true for every keydown after the first while the
   *  key is held down. A held Enter on a focused button delivers one
   *  activation per repeat — up to 30 a second. */
  repeat: boolean;
}

/**
 * Whether an activation should be DROPPED before the machine ever sees it.
 *
 * The floor in `decideXClick` already refuses to fire on these, but dropping
 * them here means a double-click's trailing half and an auto-repeat storm do
 * not even churn the armed window — and, more importantly, it means the two
 * guards are values with a test rather than two inline lambdas in JSX that no
 * check script can reach. Round 505 mounted both attacks (15 real mouse clicks
 * 20ms apart; 25 trusted autorepeat keydowns at 33ms) and both got through the
 * old code.
 *
 * Keyboard activation reports `detail: 0`, so the `> 1` test never touches it.
 */
export function isSpuriousActivation(a: Activation): boolean {
  return a.detail > 1 || a.repeat;
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

/**
 * Why the ⏸ is disabled, or `null` when it is not.
 *
 * This is `decideStopClick` with the id dropped, and it is a separate export
 * rather than a second predicate BECAUSE it is the same predicate: the button's
 * `disabled` and the handler's decision are now two readings of one function,
 * so a row cannot look clickable and act settled.
 *
 * Round 1353 shipped `disabled={!canStop}` — capability only. While
 * `capabilities.stop` was false that was indistinguishable from the truth;
 * the moment the flag flipped, every COMPLETED row grew an enabled ⏸ with
 * `cursor: pointer` and the title "Stop this agent", whose click reached
 * `{action:"blocked", reason:"settled"}` and died there. Zero requests, zero
 * toasts — precisely the silent no-op NFU6 forbids.
 */
export function stopBlockReason(i: {
  settled: boolean;
  canStop: boolean;
}): "capability" | "settled" | null {
  const d = decideStopClick({ nodeId: "", settled: i.settled, canStop: i.canStop });
  return d.action === "blocked" ? d.reason : null;
}

/** The tooltip a ⏸ wears when the row has nothing left to stop. Says what is
 *  true rather than blaming the engine — the capability may well be present. */
export const SETTLED_STOP_TITLE = "Run has already settled — nothing to stop";

/** The exact tooltip a capability-gated control wears (NFU6: disabled with a
 *  reason, never hidden, never a silent no-op). The flag name is in the text
 *  on purpose — it is the string to grep for in
 *  `forge-control/src/routes/capabilities.ts` when wondering why a button is
 *  dead. */
export function capabilityTitle(flag: "stop" | "terminate"): string {
  return `engine support pending (control plane contract: ${flag})`;
}

export type RestoreAllDecision =
  | { action: "arm" }
  | { action: "rearm" }
  | { action: "restore-all" };

/**
 * The restore-all machine — round 1354's review, A4.
 *
 * `restoreAll` issues `DELETE /api/agents/dismissals`, which drops EVERY
 * dismissal on the machine: other projects' rows, the Live panel's rows, rows
 * hidden a week ago. Nothing is destroyed in the engine — `runs` is never
 * touched — but the *set* is gone, and the operator cannot reconstruct it: it
 * is forty individual decisions, not one. That is the definition of an
 * irreversible action, so it takes the same two-click confirm the terminate
 * path takes, on the same two constants, and for the same reason.
 *
 * Note what this function does NOT gate. It is not capability-gated (there is
 * no engine verb behind it), and it has no "settled" notion (a dismissal has no
 * status). The whole machine is the confirm — which is exactly the thing the
 * shipped control was missing, so it is expressed here as a value that
 * `check-team-confirm.ts` asserts rather than as a `useState` a reviewer would
 * have to reach through a browser.
 *
 * `armedAt` is `Date.now()` at the arming click, or null when nothing is armed.
 * Rules 2–4 of `decideXClick`, verbatim in intent: a stale arming re-arms
 * rather than firing, and a too-fast second click RE-STAMPS the window instead
 * of accumulating separation, so a click stream can never confirm itself.
 */
export function decideRestoreAllClick(i: {
  armedAt: number | null;
  nowMs: number;
}): RestoreAllDecision {
  if (i.armedAt === null) return { action: "arm" };
  const sinceArm = i.nowMs - i.armedAt;
  if (sinceArm > ARM_WINDOW_MS) return { action: "arm" };
  if (sinceArm < MIN_CONFIRM_MS) return { action: "rearm" };
  return { action: "restore-all" };
}
