/**
 * nav-stack.ts — the ONE navigation source of truth for the chat surface
 * (U20/U21, 13 §2).
 *
 * ── What it replaces ──────────────────────────────────────────────────────
 * Until this round ChatSurface navigated by MOVING `selId`: clicking a worker
 * in the team panel stashed the current chat in a one-slot backtrack state and
 * pointed `selId` at the worker's run (git 275b9d4:ChatSurface.tsx:265). That
 * had three consequences, all of them wrong:
 *
 *   1. The right sidebar re-scoped itself to the worker, because the panel is
 *      keyed on `selId`. The spec's rule is the opposite — "the right sidebar
 *      is always a view of the currently open chat" (10 §"Right sidebar") —
 *      so reading a worker silently replaced the org chart you were reading it
 *      FROM with the org chart of the worker itself (usually empty).
 *   2. "am I in an agent view" was DERIVED as "selId is not in the chat rail",
 *      which made the rail's pagination a navigation input: load-more could
 *      change whether the app thought you had drilled in.
 *   3. One level only. There was nowhere to put "worker → its sub-agent".
 *
 * The stack fixes all three by not touching `selId` at all. `selId` is the
 * open CHAT; the stack is what you are LOOKING AT inside it. Empty stack =
 * the manager chat itself.
 *
 * ── Deliberately memory-only ──────────────────────────────────────────────
 * No localStorage, no query param, no server state (13 §2). A refresh lands
 * you back on the manager chat. That is accepted and documented rather than
 * papered over: a persisted stack would have to be validated against a tree
 * that may have changed under it (runs settle, sub-agents disappear from a
 * rollup), and an invalid restored frame is a worse lie than a reset.
 *
 * ── Pure on purpose ───────────────────────────────────────────────────────
 * No React, no JSX, no imports. Every function is total and returns a new
 * (or the same) frozen array; `scripts/checks/check-nav-stack.ts` exercises
 * the invariants with plain tsx, which only works because this file has no
 * component in it.
 */

/** One level of drill-in.
 *
 *  `agent` — a full Claude Code session (`runId`), or one of its in-process
 *  sub-agents when `subagentId` is present. A sub-agent is NOT a run: its id
 *  is the `tool_use_id` of the Task call that spawned it, and its transcript
 *  lives inline in the parent run's thread. That is why both ids travel in
 *  one frame — the fetch is always the RUN, the slice is the sub-agent.
 *
 *  `plandoc` — a phase plan document by file name (U26). The frame shipped in
 *  phase 600 with no caller, so the stack's shape was settled before there
 *  were two callers to migrate; phase 700's plan zone is that second caller —
 *  `ChatSurface.openPlanDoc` pushes it from a click in `PlanKanban`, on either
 *  a phase card's `doc_path` or the flat `docs[]` list. The U6 doc endpoint it
 *  reads (`GET /api/chat/:id/plan/doc?name=`) shipped in phase 300. */
export type NavFrame =
  | {
      kind: "agent";
      runId: string;
      subagentId?: string;
      /** What to CALL this frame in the crumb trail, when the caller knows.
       *
       *  Round 1871: the breadcrumb read `manager chat › sub-agent toolu_01`,
       *  which names nothing — every Anthropic tool_use_id begins `toolu_01`,
       *  so eight characters of one is a constant. The team row that opens a
       *  node already holds its description ("Recon: what timing data the runs
       *  take"), so it passes it here instead of leaving the trail to guess
       *  from an id.
       *
       *  IDENTITY DOES NOT INCLUDE IT. `sameFrame` and `frameKey` ignore this
       *  field on purpose: two frames for the same sub-agent are the same
       *  place whether or not one of them was opened from a surface that knew
       *  its name, and letting a label split them would break the idempotent
       *  re-click and replay the drill-in animation for nothing. */
      label?: string;
    }
  | {
      kind: "plandoc";
      name: string;
      /** Which of the chat's projects this document belongs to (round 1871).
       *  Absent = the server's ranked default, which is every case except a
       *  chat that started more than one project and had its team panel
       *  switched. Without it, switching to project B and clicking B's
       *  document would read A's corpus — a silent wrong answer, which is
       *  the class of bug this whole surface exists to remove.
       *
       *  Part of identity, unlike `label`: the same file NAME can exist in two
       *  corpora, and those are two different documents. */
      projectId?: string;
    };

/** Immutable by contract — every function here returns a fresh array and the
 *  caller stores it in React state. Nothing mutates a stack in place. */
export type NavStack = readonly NavFrame[];

/** The manager chat. One shared identity so `reset()` on an already-empty
 *  stack is a React state bail-out instead of a re-render. */
export const EMPTY_STACK: NavStack = Object.freeze([]) as NavStack;

/** True when the two frames name the same thing. Used by `push` to make a
 *  repeated click on the same team row idempotent — otherwise a double-click
 *  on a worker row buries you two levels deep in the identical view and back
 *  has to be pressed twice to undo one gesture. */
export function sameFrame(a: NavFrame, b: NavFrame): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") {
    return a.runId === b.runId && (a.subagentId ?? null) === (b.subagentId ?? null);
  }
  if (a.kind === "plandoc" && b.kind === "plandoc") {
    return (
      a.name === b.name && (a.projectId ?? null) === (b.projectId ?? null)
    );
  }
  return false;
}

/** The frame being displayed, or `null` for the manager chat. */
export function top(stack: NavStack): NavFrame | null {
  return stack.length === 0 ? null : stack[stack.length - 1];
}

/** Descend one level.
 *
 *  Pushing the frame that is already on top returns the SAME stack (identity
 *  included), so React bails out and the drill-in animation does not replay
 *  for a click that changed nothing. */
export function push(stack: NavStack, frame: NavFrame): NavStack {
  const cur = top(stack);
  if (cur !== null && sameFrame(cur, frame)) return stack;
  return Object.freeze([...stack, frame]) as NavStack;
}

/** Climb one level. At depth 1 this yields the empty stack — i.e. the manager
 *  chat, which is the only "back" a depth-1 view can mean. Popping an already
 *  empty stack returns `EMPTY_STACK` unchanged rather than throwing: back is a
 *  button the user can hold, and a navigation primitive that can crash on an
 *  extra press is not one. */
export function pop(stack: NavStack): NavStack {
  if (stack.length === 0) return EMPTY_STACK;
  if (stack.length === 1) return EMPTY_STACK;
  return Object.freeze(stack.slice(0, -1)) as NavStack;
}

/** Back to the manager chat.
 *
 *  Called on every chat switch. A worker view left standing under a newly
 *  opened chat claims that worker belongs to that chat, which is the exact
 *  class of lie this project exists to remove. */
export function reset(): NavStack {
  return EMPTY_STACK;
}

/** One step of the lineage trail rendered in a drilled view's header. */
export interface NavCrumb {
  /** 0 = the manager chat, 1 = first drill-in, and so on. */
  depth: number;
  kind: "manager" | "agent" | "subagent" | "plandoc";
  /** A run id, a `tool_use_id`, a doc name — or `null` for the manager, whose
   *  id is `selId` and therefore not this module's to know. */
  id: string | null;
  /** A label derivable from the STACK ALONE: a short id or the doc name. The
   *  view enriches the last crumb with role/model once its fetch lands; it
   *  cannot enrich the ones above it without fetching them, and inventing
   *  labels for runs we have not loaded is how a crumb trail starts lying. */
  label: string;
}

/** First 8 chars of a uuid — long enough to grep the database with, short
 *  enough to sit in a 260-wide header. Same convention as TeamRow's `short`. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** The discriminating part of a Task `tool_use_id`.
 *
 *  `toolu_01AeuQskZPyHpsYrHayvrqrT` → `AeuQskZP`. `shortId` gave `toolu_01`
 *  for every sub-agent that has ever run, because that prefix is a constant of
 *  the Anthropic API — the crumb was literally the same eight characters on
 *  every descent. This drops the prefix and the two-byte version before
 *  taking its eight, so two sub-agents of one run are told apart. */
function shortSubagentId(id: string): string {
  const stripped = /^toolu_\d*/.exec(id) ? id.replace(/^toolu_\d*/, "") : id;
  const body = stripped !== "" ? stripped : id;
  return body.length > 8 ? body.slice(0, 8) : body;
}

/** A caller-supplied label, cleaned up for a 260px header, or null. */
function tidyLabel(label: string | undefined): string | null {
  if (typeof label !== "string") return null;
  const flat = label.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > 42 ? `${flat.slice(0, 41)}…` : flat;
}

/** The whole stack as a readable trail, manager first. Always at least one
 *  crumb: the manager chat is a place, not the absence of one. */
export function crumbs(stack: NavStack): NavCrumb[] {
  const out: NavCrumb[] = [
    { depth: 0, kind: "manager", id: null, label: "manager chat" },
  ];
  stack.forEach((frame, i) => {
    if (frame.kind === "plandoc") {
      out.push({ depth: i + 1, kind: "plandoc", id: frame.name, label: frame.name });
      return;
    }
    const given = tidyLabel(frame.label);
    if (frame.subagentId !== undefined) {
      out.push({
        depth: i + 1,
        kind: "subagent",
        id: frame.subagentId,
        label: given ?? `sub-agent ${shortSubagentId(frame.subagentId)}`,
      });
      return;
    }
    out.push({
      depth: i + 1,
      kind: "agent",
      id: frame.runId,
      label: given ?? `session ${shortId(frame.runId)}`,
    });
  });
  return out;
}

/** A stable React key for the frame on top. Drives the drill-in animation:
 *  remounting on a changed key is what replays it, and a key that changed for
 *  a frame that did not would replay it for nothing. */
export function frameKey(stack: NavStack): string {
  const t = top(stack);
  if (t === null) return "manager";
  if (t.kind === "plandoc") return `plandoc:${t.name}`;
  return `agent:${t.runId}:${t.subagentId ?? ""}:${stack.length}`;
}
