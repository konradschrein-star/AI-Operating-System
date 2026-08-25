/** The LIVE SESSIONS block's data layer — who is working, on which engine, on
 *  what, and for how long.
 *
 *  Pure, exactly as ./teamRows is pure: no React, no DOM, and NO CLOCK OF ITS
 *  OWN — every `now` arrives as an argument. That is what lets
 *  `scripts/checks/check-live-sessions.ts` assert it directly under tsx, and it
 *  is why the block's rules (what "live" means, what an activity cell says,
 *  which gap a missing field is) are decidable without rendering anything.
 *
 *  It reads the SAME `TeamResponse` the panel already polls. There is no fetch
 *  in this file and no new query anywhere behind it: the chat surface has a
 *  committed 40 req/min ceiling (../chat/pollBudget.ts) and this block costs
 *  nothing against it.
 */

import type { TeamActivity, TeamNode, TeamResponse } from "./teamApi";
import { interpolatedWorkingMs, responseNowMs, type TeamRow } from "./teamRows";
import { parseTs } from "../live/agentsApi";

/**
 * ── WHAT "LIVE" MEANS, DECIDED AND WRITTEN DOWN ──────────────────────────────
 *
 * A node is live when it is **not settled**, and nothing else. `settled` is the
 * server's own word for "nothing about this node can change any more"
 * (`SETTLED_STATUSES = {completed, failed, cancelled}` in
 * forge-control/src/routes/agents-shared.ts:157); a sub-agent additionally
 * settles when its parent process exits.
 *
 * The alternative — `status === "running"` — was rejected, and the two edge
 * cases the brief names are exactly why:
 *
 *   • a QUEUED run is claimed work that has not started. An operator who
 *     seeded a task and cannot find it anywhere is the reason this panel
 *     exists; dropping it because it has not drawn its first token yet would
 *     answer "who is working" by hiding the thing that is about to.
 *   • a STUCK run is the single most important row on the panel. It is not
 *     settled, it is not progressing, and a block that filtered on `running`
 *     would silently drop it at the exact moment it needs looking at.
 *
 * Both are therefore SHOWN, and both are RANKED BELOW running so the top of
 * the block still reads as "what is actually working right now". The status
 * dot and its token carry the difference — `stuck` never wears the same colour
 * as `running` (the same grammar ./TeamRow.tsx uses).
 *
 * PAUSED sits between them: stopped on purpose, resumable, worth seeing.
 */
export function isLiveNode(node: TeamNode): boolean {
  return !node.settled;
}

/** Reading order inside the block. Lower sorts first.
 *
 *  Not a `Record<Status, number>` with an exhaustive union: the engine's status
 *  vocabulary is data, not a closed set this client gets to define (the same
 *  call ../live/agentsApi's ROLE_LABEL makes), so an unseen non-settled status
 *  lands in the trailing bucket and renders as itself rather than crashing or
 *  being folded into "running". */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  stuck: 1,
  paused: 2,
  queued: 3,
  planned: 3,
};

/** The rank a status sorts at. Anything the engine invents later sorts last —
 *  visible, at the bottom, wearing its own name. */
export function liveStatusRank(status: string): number {
  return STATUS_RANK[status] ?? 4;
}

/** Why a cell has no value. The distinction is the whole point of shipping
 *  `engine`/`activity` as OPTIONAL fields:
 *
 *   • `"not-served"` — the field was ABSENT from the response. This client is
 *     newer than the API it is talking to. Nobody measured anything and
 *     nobody claimed to.
 *   • `"unknown"` — the server shipped `null`. It looked, and it cannot say.
 *
 *  Both render the em dash. They differ in the tooltip, because "your server is
 *  older than your console" and "this run's model was never recorded" are two
 *  different things to go and fix. */
export type FieldGap = "not-served" | "unknown";

/** One row of the LIVE SESSIONS block. Every field is already reduced to what
 *  the cell renders, so the component holds no policy of its own. */
export interface LiveSessionRow {
  /** The node this row speaks for. Carried whole so the row can open it (the
   *  drill-in needs `kind` and `parent_id`, not just an id) and title itself. */
  node: TeamNode;
  /** The engine string to badge, or null when there is nothing honest to
   *  print. NEVER defaulted to "claude-code": see ./engineBadge. */
  engine: string | null;
  /** Set exactly when `engine` is null. */
  engineGap: FieldGap | null;
  /** What this node is doing right now, or null. */
  activity: TeamActivity | null;
  /** Set exactly when `activity` is null. */
  activityGap: FieldGap | null;
  /** How long ago the activity was stamped, in ms — `null` when the activity
   *  carries no parsable `ts`, which is a real state and must not print as 0.
   *
   *  It is rendered BESIDE the activity, always. `current_activity.ts` freezes
   *  when a run stops emitting events, and the rollup's own flush throttle
   *  leaves the stored value up to seconds behind. Measured: stale on 108 of
   *  158 comparable poll samples (68.4%); fleet note
   *  `rollup-serves-stale-activity-68-percent`. A bare label re-reads as
   *  "now" forever; a label with its age cannot. */
  activityAgeMs: number | null;
  /** Attributed working time, interpolated by ./teamRows' policy — the one
   *  place client-side time policy lives. `null` means NOT MEASURABLE and
   *  prints the em dash, never "0s". */
  elapsedMs: number | null;
  /** The one-liner: the project task's title when this run is executing one,
   *  else the node's own description. Null when neither exists. */
  title: string | null;
  /** `liveStatusRank(node.status)`, carried so the component can group without
   *  re-deriving the order this module already decided. */
  rank: number;
}

/**
 * The activity to render for a node.
 *
 * Two rules, and the first is the one that keeps this column honest:
 *
 *  1. **A settled node has no current activity.** Its last one is what it DID,
 *     not what it is doing, and printing it under a "right now" heading is the
 *     stale-value lie the whole panel exists to remove. The server already
 *     refuses to ship it (`projectActivity` in
 *     forge-control/src/lib/team-live.ts); this is the client half of the same
 *     rule, so a future server that ships it anyway still cannot land it here.
 *  2. `undefined` (an older API) and `null` (nothing recorded) both yield no
 *     activity — but they yield DIFFERENT gaps, see `FieldGap`.
 */
export function activityFor(node: TeamNode): {
  activity: TeamActivity | null;
  gap: FieldGap | null;
} {
  if (node.activity === undefined) return { activity: null, gap: "not-served" };
  if (node.settled || node.activity === null) {
    return { activity: null, gap: "unknown" };
  }
  return { activity: node.activity, gap: null };
}

/** The engine to badge, and why it is missing when it is. `undefined` is an
 *  older API; `null` is the server saying "this row's model was never
 *  recorded". Neither one is allowed to become "claude-code" on the way to the
 *  screen — that default is correct for DISPATCH and a lie on a badge. */
export function engineFor(node: TeamNode): {
  engine: string | null;
  gap: FieldGap | null;
} {
  if (node.engine === undefined) return { engine: null, gap: "not-served" };
  if (node.engine === null || node.engine === "") return { engine: null, gap: "unknown" };
  return { engine: node.engine, gap: null };
}

/**
 * WHAT THE ACTIVITY CELL SAYS, per kind. Never "" — a blank cell in a column
 * headed "what it is doing right now" reads as *idle*, and that is the one
 * thing this column must never say by accident.
 *
 * `/live`'s `activityLabel` (live/AgentActivity.tsx:165) returns the empty
 * string for `tool_result` outright, and the rollup replay measured the parent
 * sitting in that state for 58.8-75.3% of live wall-clock depending on the
 * idle-gap cap that defines "live" (68.3% at a 120 s cap, 338 runs) — a cell
 * that is blank most of the time it is looked at. Method and raw counts:
 * `evidence/aios-sidebar-live-sessions/activity-truth.md` §3-§4. So:
 *
 *   tool_call     → the tool's name.
 *   tool_result   → the tool's name, TOO. Since commit 3e63a45 the rollup
 *                   carries the answering tool through, so the fresh state and
 *                   the throttle-stale state print the SAME string and the
 *                   2s write throttle stops being visible as a flicker.
 *                   Deliberately NOT marked up differently for that reason.
 *   assistant_text → the text the model wrote (already clipped server-side).
 *
 * Anything without a name of its own falls back to a phrase for its KIND, and
 * a kind this client has never seen renders its own raw string. Data-driven,
 * same discipline as the engine badge.
 */
const KIND_PHRASE: Record<string, string> = {
  tool_call: "calling a tool",
  tool_result: "reading a tool result",
  assistant_text: "writing",
};

export function activityText(activity: TeamActivity): string {
  if (activity.tool !== null && activity.tool !== "") return activity.tool;
  if (activity.text !== null && activity.text !== "") return activity.text;
  return KIND_PHRASE[activity.kind] ?? activity.kind;
}

/** Age of an activity in ms, or null when it cannot be measured: no stamp, an
 *  unparsable one, or an unusable clock. Clamped at 0 — a stamp a second in
 *  the future (two machines, two clocks) is "just now", never a negative age. */
export function activityAgeMs(
  activity: TeamActivity | null,
  nowMs: number,
): number | null {
  if (activity === null || activity.ts === null) return null;
  const ts = parseTs(activity.ts);
  if (!Number.isFinite(ts) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - ts);
}

/** The task title if this run is executing one, else its own description.
 *
 *  The task title is preferred because it is the answer to "ON WHAT": a
 *  worker's description is often the same sentence, but a manager's is the
 *  chat's title and a sub-agent's is its spawn prompt. Empty strings collapse
 *  to null so the cell takes its stated fallback rather than rendering a hole. */
export function liveTitle(node: TeamNode): string | null {
  const fromTask = node.task?.title;
  if (typeof fromTask === "string" && fromTask.trim() !== "") return fromTask;
  if (typeof node.description === "string" && node.description.trim() !== "") {
    return node.description;
  }
  return null;
}

/** The minimal `TeamRow` `interpolatedWorkingMs` needs, so that not one line of
 *  the clamp/settled/null policy is re-derived here. ./teamRows is explicit
 *  that it is the single site of client-side time policy; this block honours
 *  that rather than growing a second copy that drifts. */
function timeRow(node: TeamNode): TeamRow {
  return {
    node,
    depth: 0,
    parentDescription: null,
    hidesRows: 1,
    displayWorkingMs: node.working_ms,
  };
}

/**
 * How many live sessions this response holds.
 *
 * Clock-free on purpose. It is what the block's header counts, and it is what
 * lets the component answer "is there anything to show" WITHOUT subscribing to
 * the 1s tick: a chat whose tree has fully settled mounts no ticking subtree at
 * all, the same discipline the panel's poll follows when `isTreeSettled`. It is
 * therefore deliberately not `selectLiveSessions(res, now).length`, which needs
 * a clock to answer a question that does not depend on one — though the two are
 * always equal, which is a property worth asserting.
 */
export function countLiveSessions(res: TeamResponse): number {
  let n = 0;
  const visit = (node: TeamNode): void => {
    if (isLiveNode(node)) n += 1;
    for (const sub of node.subagents ?? []) visit(sub);
  };
  visit(res.manager);
  for (const worker of res.workers ?? []) visit(worker);
  return n;
}

/**
 * Every live session in this response, in reading order.
 *
 * The walk is the tree's own: manager, the manager's sub-agents, then each
 * worker and its sub-agents — so a sub-agent that is doing the work appears in
 * its own right, which is precisely the "sessions doing work" Konrad asked to
 * see. The `rank` sort then floats the running ones to the top; `Array#sort` is
 * stable, so within a rank the tree order survives and a row does not jump
 * around the block as its clock ticks.
 *
 * DISMISSALS ARE DELIBERATELY NOT APPLIED. The tree hides dismissed rows
 * because dismissal is a tidy-up gesture for finished work; a LIVE block that
 * could be silenced by an old ✕ would answer "is anything running?" with a
 * confident, wrong "no". This function therefore takes the response and a
 * clock, and nothing else — which is also what makes it assertable.
 */
export function selectLiveSessions(
  res: TeamResponse,
  nowMs: number,
): LiveSessionRow[] {
  const responseNow = responseNowMs(res);
  const rows: LiveSessionRow[] = [];

  const visit = (node: TeamNode): void => {
    if (isLiveNode(node)) {
      const { engine, gap: engineGap } = engineFor(node);
      const { activity, gap: activityGap } = activityFor(node);
      rows.push({
        node,
        engine,
        engineGap,
        activity,
        activityGap,
        activityAgeMs: activityAgeMs(activity, nowMs),
        elapsedMs: interpolatedWorkingMs(timeRow(node), responseNow, nowMs),
        title: liveTitle(node),
        rank: liveStatusRank(node.status),
      });
    }
    for (const sub of node.subagents ?? []) visit(sub);
  };

  visit(res.manager);
  for (const worker of res.workers ?? []) visit(worker);

  return rows.sort((a, b) => a.rank - b.rank);
}
