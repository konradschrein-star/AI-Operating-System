"use client";

/**
 * OrientationStrip — two pinned lines that answer "what am I looking at, and
 * what is it doing right now" for every drilled agent view (U22, 13 §8).
 *
 * Konrad's complaint this phase was not that the data was missing. It was that
 * reading a worker's transcript told you nothing about WHO was talking, what
 * they had been asked to do, where that sits in the plan, or whether the thing
 * was still moving. Every one of those facts is already on the wire. The strip
 * is the join.
 *
 * ── "Pure function of data already on the wire. No new endpoint." (13 §8) ──
 * Three sources, all of them already being fetched by somebody else:
 *
 *   role / model / description  ─ the run's own `metadata` (`role`,
 *       `model_resolved`) or, for a sub-agent, its `metadata.subagents_v2[]`
 *       entry. AgentChatView has already resolved these against the spawn
 *       call; they arrive here as `identity` and are NOT re-derived.
 *   current activity            ─ `metadata.current_activity` for a session,
 *       `subagents_v2[].latest_activity` for a sub-agent.
 *   task title / round / status ─ `GET /api/chat/:id/team`, READ OUT OF THE
 *       REACT-QUERY CACHE. See the next section — this is the part that could
 *       easily have become a second poll and did not.
 *
 * ── Why the team tree is read from the cache instead of with useQuery ──────
 * NFU3 is measured in requests per minute (round 604), so the strip must add
 * ZERO. The obvious implementation — `useQuery(["chat-team", chatId], …)` with
 * ChatTeamPanel's options — dedupes into the panel's existing poll and would
 * be correct. It is not available: the query key is scoped by CHAT id, and
 * this component's whole file list for the round excludes ChatSurface.tsx, so
 * there is no way to get `chatId` down here as a prop.
 *
 * So the strip OBSERVES instead of asking. `queryCache.findAll({ queryKey:
 * ["chat-team"], type: "active" })` returns the panel's live query object —
 * `type: "active"` is react-query's own predicate for "at least one mounted
 * observer has this enabled", i.e. exactly "the team panel is open and
 * polling". The strip reads `state.data` off it, subscribes to the cache for
 * updates, and issues no request of its own. There is no fetcher in this file.
 *
 * That has a second, better property: the tree is not TRUSTED, it is MATCHED.
 * The strip only uses a tree that actually contains this run (or this
 * sub-agent under this parent). A tree for some other chat, a tree fetched
 * before the worker existed, a chat with no project link — none of them can
 * put a task title on a row they do not describe. When no active tree
 * contains the node, the plan line is omitted and the strip says why.
 *
 * ── NFU6, restated as code ────────────────────────────────────────────────
 * `DegradeReason` is a closed union and every member has a rendered, muted,
 * explaining line. There is no branch in this file that shows a stale value as
 * fresh, no branch that guesses a round, and no branch that computes a phase
 * from anything but `task.round`. A node without a task gets NO plan line at
 * all — U22's "never invent a phase" is enforced by there being nowhere for an
 * invented one to come from.
 *
 * ── Time truth (project Definition of Done #1) ────────────────────────────
 * The strip carries no duration and reads no clock. `current_activity` is
 * stamped by the executor on every thread event and frozen when the run
 * settles; a settled run therefore reads "ended:" and not "currently:", with
 * the frozen timestamp beside it. A live run's line changes when the detail
 * query refetches, because that is when new metadata arrives — nothing here
 * animates it forward on its own.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  modelDisplay,
  roleLabel,
  roleTokenName,
  type RoleTokenName,
} from "../live/agentsApi";
import type { TeamNode, TeamResponse } from "../team/teamApi";
import type { SubagentMeta } from "./subagent-slice";
import type { NavFrame } from "./nav-stack";

/** Rendered wherever there is no honest value — the panel-wide glyph. */
const EM_DASH = "—";

/** The first element of ChatTeamPanel's query key. Not re-declared as the
 *  whole key: this file matches the PREFIX so it finds whichever chat's tree
 *  is currently being polled, then proves the tree describes this node. */
const TEAM_QUERY_ROOT = "chat-team";

/** One line of activity text, collapsed and clipped for a strip that must stay
 *  two lines tall. The full text goes in the `title` attribute — a native
 *  tooltip, so hovering the strip mounts nothing and sets no state (NFU2). */
const ACTIVITY_MAX = 130;

const ROLE_COLOR: Record<RoleTokenName, string> = {
  decide: tokens.decide,
  info: tokens.info,
  accent: tokens.accent,
  warn: tokens.warn,
  textMuted2: tokens.textMuted2,
  ok: tokens.ok,
  textMuted: tokens.textMuted,
};

/* ── Pure derivation ──────────────────────────────────────────────────────
 *
 * Everything from here to the component is exported and React-free so
 * `scripts/checks/check-orientation.ts` can exercise it under plain tsx. The
 * round's file list has three names on it and none of them is a new pure
 * module, so the derivation lives in the component's own file — the same
 * decision round 601B made for `BackButton`.
 */

/** `metadata.current_activity` / `subagents_v2[].latest_activity` — the same
 *  four fields under two names. */
export interface OrientationActivity {
  kind: string | null;
  tool: string | null;
  text: string | null;
  ts: string | null;
}

/** Parse `metadata.current_activity`. Untyped JSONB in, guarded fields out;
 *  a non-object, or an object with nothing usable in it, is `null` rather
 *  than an activity with four blanks. */
export function parseActivity(value: unknown): OrientationActivity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = o[key];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const a: OrientationActivity = {
    kind: str("kind"),
    tool: str("tool"),
    text: str("text"),
    ts: str("ts"),
  };
  if (a.kind === null && a.tool === null && a.text === null) return null;
  return a;
}

/** The rendered form of one activity. `known` is false when the executor
 *  stamped a `kind` this taxonomy has never seen — the kind is then shown
 *  verbatim and marked, never mapped onto the nearest familiar verb. */
export interface ActivityLine {
  verb: string;
  detail: string | null;
  known: boolean;
}

/**
 * The taxonomy is `docs/research/round-599-4d8679b2.md` §"Current Activity
 * Taxonomy", verbatim:
 *
 *   assistant_text  kind's text is the agent's prose (50–200B)
 *   tool_call       `tool` names the tool; `text` is null OR the tool name
 *   tool_result     `text` is an outcome snippet
 *   thinking        no tool, no text
 *
 * The `tool_call` branch is the one with a trap in it: when the executor puts
 * the tool name in `text` as well, repeating it would render "calling Bash —
 * Bash". The equality check below is why that does not happen.
 */
export function activityLine(a: OrientationActivity): ActivityLine {
  const text = a.text;
  switch (a.kind) {
    case "assistant_text":
      return { verb: "writing", detail: text, known: true };
    case "thinking":
      return { verb: "thinking", detail: text, known: true };
    case "tool_call":
      return {
        verb: a.tool === null ? "calling a tool" : `calling ${a.tool}`,
        detail: text !== null && text === a.tool ? null : text,
        known: true,
      };
    case "tool_result":
      return {
        verb: a.tool === null ? "a tool returned" : `${a.tool} returned`,
        detail: text,
        known: true,
      };
    default:
      return { verb: a.kind ?? "unrecorded", detail: text, known: false };
  }
}

/** Collapse whitespace and clip to a leading VERBATIM substring. The clip is
 *  marked; nothing is reworded. The untouched original is what goes in the
 *  tooltip, so the clip is never the only copy on screen. */
export function clipLine(text: string, max: number): { text: string; clipped: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, clipped: false };
  return { text: `${flat.slice(0, max).trimEnd()}…`, clipped: true };
}

/** Where a round sits in the waterfall corpus. */
export interface PlanPosition {
  /** The hundred-block the round belongs to: round 601 → 600. */
  phase: number;
  /** The next block. Arithmetic, not a lookup — the plan endpoint is phase
   *  700's and this round must not call it. */
  next: number;
}

/**
 * Phase block from a round number, and nothing else.
 *
 * The corpus numbers rounds inside hundred-blocks (phase 500 holds rounds
 * 500–599; 601 and 603 are phase 600), so the block is `floor(round / 100) *
 * 100` and the next one is that plus 100. A round that is not a non-negative
 * integer yields `null` and the plan line disappears — a phase computed from
 * a malformed round would be a fabricated one, which U22 forbids outright.
 */
export function planPosition(round: number): PlanPosition | null {
  if (!Number.isInteger(round) || round < 0) return null;
  const phase = Math.floor(round / 100) * 100;
  return { phase, next: phase + 100 };
}

/**
 * Find this view's node in a team tree.
 *
 * Two different identities, deliberately not unified: a session IS a run and
 * is matched by run id; a sub-agent is not a run at all and is matched by its
 * spawn's `tool_use_id` UNDER THE PARENT IT WAS SPAWNED FROM. Matching a
 * sub-agent on id alone would let a `tool_use_id` collision across two runs
 * attach one worker's task to another's row, which is precisely the class of
 * quiet mis-attribution this project exists to remove.
 */
export function findTeamNode(
  tree: TeamResponse,
  runId: string,
  subagentId?: string,
): TeamNode | null {
  const roots: TeamNode[] = [tree.manager, ...tree.workers];
  for (const node of roots) {
    if (node === null || node === undefined) continue;
    if (subagentId === undefined) {
      if (node.kind !== "subagent" && node.id === runId) return node;
    }
    for (const sub of node.subagents ?? []) {
      if (
        subagentId !== undefined &&
        sub.kind === "subagent" &&
        sub.id === subagentId &&
        sub.parent_id === runId
      ) {
        return sub;
      }
      if (subagentId === undefined && sub.kind !== "subagent" && sub.id === runId) {
        return sub;
      }
    }
  }
  return null;
}

/** Shape guard for a cached team payload. The cache is typed `unknown` and a
 *  cast would be a promise this file cannot keep; this is the promise, checked. */
export function isTeamResponse(value: unknown): value is TeamResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.chat_id !== "string") return false;
  if (o.manager === null || typeof o.manager !== "object") return false;
  if (!Array.isArray(o.workers)) return false;
  return true;
}

/** Why the plan half of the strip has nothing to say. Closed union: every
 *  member is rendered, muted, with the reason spelled out (NFU6). */
export type DegradeReason =
  /** The team panel is closed or collapsed, so nothing is polling the tree.
   *  The strip refuses to read the last response it happens to remember. */
  | "team-not-polling"
  /** The panel is polling and the request failed. */
  | "team-error"
  /** The panel is polling and the first response has not landed. */
  | "team-loading"
  /** A live tree exists and does not contain this node — an unlinked chat, a
   *  different project, or a run the tree has not picked up yet. */
  | "node-absent"
  /** The node is there and carries no project task (an operator chat, a
   *  sub-agent, a worker spawned outside the task pipeline). */
  | "no-task";

export const DEGRADE_TEXT: Record<DegradeReason, string> = {
  "team-not-polling": "team panel closed — no task or plan position",
  "team-error": "team unavailable — no task or plan position",
  "team-loading": "team loading…",
  "node-absent": "not in the team tree — no task or plan position",
  "no-task": "no project task on this node",
};

/** What the strip knows about where this node sits in the plan. */
export interface PlanFacts {
  task: { title: string; round: number; status: string; role: string } | null;
  plan: PlanPosition | null;
  degraded: DegradeReason | null;
}

/** The one place the two halves are joined. Pure, total, and exported so the
 *  check script can drive every `DegradeReason` without a browser. */
export function derivePlanFacts(reading: TeamReading): PlanFacts {
  if (reading.status !== "ready" || reading.node === null) {
    const degraded: DegradeReason =
      reading.status === "no-query"
        ? "team-not-polling"
        : reading.status === "error"
          ? "team-error"
          : reading.status === "loading"
            ? "team-loading"
            : "node-absent";
    return { task: null, plan: null, degraded };
  }
  const task = reading.node.task;
  if (task === null) return { task: null, plan: null, degraded: "no-task" };
  return {
    task: {
      title: task.title,
      round: task.round,
      status: task.status,
      role: task.role,
    },
    // `null` when the round is malformed — the line then simply is not there.
    plan: planPosition(task.round),
    degraded: null,
  };
}

/* ── The zero-fetch read of the team tree ─────────────────────────────────── */

export interface TeamReading {
  node: TeamNode | null;
  /** `"ready"` means an ACTIVE query answered and its tree contains this node.
   *  `"absent"` means it answered and does not. */
  status: "ready" | "absent" | "loading" | "error" | "no-query";
  error: string | null;
}

/** A minimal view of what this file needs off the query cache, so `readTeam`
 *  stays testable without constructing a QueryClient. */
export interface CachedTeamQuery {
  status: "pending" | "error" | "success";
  data: unknown;
  error: unknown;
}

/**
 * Turn the active `["chat-team", …]` cache entries into a reading for THIS
 * node. Pure — the react-query plumbing is in the hook below.
 *
 * More than one entry can be active for a moment while the surface switches
 * chats, so every one of them is examined and the FIRST that contains this
 * node wins. A node that appears in none of them is `"absent"` rather than
 * being attached to whichever tree happened to be first.
 */
export function readTeam(
  queries: readonly CachedTeamQuery[],
  runId: string,
  subagentId?: string,
): TeamReading {
  if (queries.length === 0) return { node: null, status: "no-query", error: null };

  let sawSuccess = false;
  let firstError: string | null = null;

  for (const q of queries) {
    if (q.status === "error") {
      if (firstError === null) {
        firstError = q.error instanceof Error ? q.error.message : "unknown error";
      }
      continue;
    }
    if (!isTeamResponse(q.data)) continue;
    sawSuccess = true;
    const node = findTeamNode(q.data, runId, subagentId);
    if (node !== null) return { node, status: "ready", error: null };
  }

  if (sawSuccess) return { node: null, status: "absent", error: null };
  if (firstError !== null) return { node: null, status: "error", error: firstError };
  return { node: null, status: "loading", error: null };
}

/**
 * Subscribe to the team query WITHOUT owning it.
 *
 * `findAll({ type: "active" })` is react-query's own definition of "some
 * mounted observer wants this query enabled" — when the team panel is closed
 * its `enabled` is false, the query goes inactive, and this hook reports
 * `"no-query"` instead of handing back the tree it fetched ten minutes ago.
 * That is the NFU6 line: a value that nobody is refreshing is not a value.
 *
 * The subscription re-renders the strip at the panel's own cadence (one team
 * response every 5s) and never more often — the filter below drops every
 * event for every other query in the app.
 */
function useTeamReading(runId: string, subagentId?: string): TeamReading {
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      const key = event.query.queryKey;
      if (Array.isArray(key) && key[0] === TEAM_QUERY_ROOT) {
        setRevision((n) => n + 1);
      }
    });
  }, [queryClient]);

  /* Read on every render rather than memoising on `revision`: the read is a
   * walk over a tree of tens of nodes, the strip re-renders once per detail
   * poll, and a memo keyed on a counter it does not use is the kind of thing
   * that silently goes stale. `revision` exists to CAUSE the render. */
  void revision;
  const active = queryClient
    .getQueryCache()
    .findAll({ queryKey: [TEAM_QUERY_ROOT], type: "active" })
    .map((q): CachedTeamQuery => ({
      status: q.state.status,
      data: q.state.data,
      error: q.state.error,
    }));

  return readTeam(active, runId, subagentId);
}

/* ── Render ───────────────────────────────────────────────────────────────── */

/** A muted, explicitly-marked absence. Never blank, never a plausible-looking
 *  placeholder — the reason is the content. */
function Missing({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      data-orientation-missing
      className="mono"
      title={title}
      style={{ color: tokens.textGhost, fontStyle: "italic" }}
    >
      {children}
    </span>
  );
}

function Sep() {
  return <span style={{ flex: "none", color: tokens.textGhost }}>·</span>;
}

export interface OrientationStripViewProps {
  /** True when this is a sub-agent rather than a whole session. */
  isSubagent: boolean;
  /** Already resolved by AgentChatView against the rollup, the spawn call and
   *  the run's own metadata, in that order. Not re-derived here — one resolver
   *  per fact, and it is not this file. */
  identity: {
    role: string | null;
    model: string | null;
    description: string | null;
  };
  /** The RUN's metadata — the source of `current_activity` for a session view.
   *  Null while the detail query is still in flight. */
  metadata: Record<string, unknown> | null;
  /** The sub-agent's `subagents_v2` entry, when there is one. Its
   *  `latest_activity` is the sub-agent's equivalent of `current_activity`;
   *  the parent's belongs to the parent and is never shown under a child's
   *  name. */
  subagent: SubagentMeta | null;
  /** True when nothing about this node can change any more. Decides "currently"
   *  vs "ended" — a settled run must never claim to be doing something. */
  settled: boolean;
  /** Where this node sits in the plan, already read off the team tree. */
  facts: PlanFacts;
}

/**
 * The strip, as a pure function of props.
 *
 * Split from the component below for one reason that pays for itself: this half
 * has no hook in it, so `docs/plan/artifacts/phase600/capture-orientation.tsx`
 * can render every state — ready, degraded five ways, sub-agent, settled — to
 * static HTML and photograph them in both palettes, offline, against the real
 * `theme.css`. Both-theme evidence for a strip that only appears when a live
 * team panel is polling would otherwise be one screenshot of the happy path and
 * a promise about the rest.
 */
export function OrientationStripView({
  isSubagent,
  identity,
  metadata,
  subagent,
  settled,
  facts,
}: OrientationStripViewProps) {
  /* A sub-agent's activity comes from its own rollup entry and NOWHERE else.
   * Falling back to the parent's `current_activity` would put the parent's
   * live work on a finished child's line — the exact "still counting when it's
   * done" lie this project opened with. */
  const activity = isSubagent
    ? (subagent === null ? null : parseActivity(subagent.latest_activity))
    : parseActivity(metadata?.current_activity);
  const line = activity === null ? null : activityLine(activity);
  const detail =
    line === null || line.detail === null ? null : clipLine(line.detail, ACTIVITY_MAX);

  const roleColor = ROLE_COLOR[roleTokenName(identity.role)];
  const activityVerb = settled ? "ended:" : "currently:";

  return (
    <div
      data-orientation-strip
      data-orientation-degraded={facts.degraded ?? ""}
      style={{
        flex: "none",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "7px 14px",
        background: tokens.bgGutter,
        borderBottom: `1px solid ${tokens.borderSoft}`,
      }}
    >
      {/* ── Line 1: who, on what model, doing which task ─────────────────── */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          minWidth: 0,
          fontSize: 10.5,
        }}
      >
        <span
          data-orientation-kind
          style={{
            flex: "none",
            fontSize: 9.5,
            letterSpacing: "0.04em",
            color: isSubagent ? tokens.textMuted2 : tokens.info,
          }}
        >
          {isSubagent ? "sub-agent" : "session"}
        </span>
        <span data-agent-role style={{ flex: "none", color: roleColor }}>
          {roleLabel(identity.role)}
        </span>
        <Sep />
        <span
          data-agent-model
          title={identity.model ?? "the executor did not record a resolved model"}
          style={{ flex: "none", color: tokens.textFaint }}
        >
          {modelDisplay(identity.model)}
        </span>
        <Sep />
        {/* The task title is the TEAM's, and only the team's. When the tree is
            unavailable the run's own description stands in — and says so, so a
            spawn description is never read as a project task. */}
        {facts.task !== null ? (
          <span
            data-orientation-task
            title={facts.task.title}
            style={{
              flex: 1,
              minWidth: 0,
              color: tokens.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {facts.task.title}
          </span>
        ) : identity.description !== null ? (
          <span
            data-orientation-task="fallback"
            title={`${identity.description}\n\n(this is the run's own description — ${
              facts.degraded === null ? "no task" : DEGRADE_TEXT[facts.degraded]
            })`}
            style={{
              flex: 1,
              minWidth: 0,
              color: tokens.textLabel,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {identity.description}
          </span>
        ) : (
          <span style={{ flex: 1, minWidth: 0 }}>
            <Missing title="neither a project task nor a run description was recorded">
              no title
            </Missing>
          </span>
        )}
        {facts.task !== null ? (
          <span
            data-orientation-round
            title={`task ${facts.task.role} · round ${facts.task.round} · ${facts.task.status}`}
            style={{ flex: "none", color: tokens.textMuted2 }}
          >
            round {facts.task.round}
          </span>
        ) : (
          <Missing
            title={
              facts.degraded === null
                ? undefined
                : `${DEGRADE_TEXT[facts.degraded]} — a round is never guessed`
            }
          >
            round {EM_DASH}
          </Missing>
        )}
      </div>

      {/* ── Line 2: what it is doing now, and where that sits in the plan ── */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          minWidth: 0,
          fontSize: 10,
        }}
      >
        <span style={{ flex: "none", color: tokens.textFaint }}>{activityVerb}</span>
        {line === null ? (
          <span style={{ flex: 1, minWidth: 0 }}>
            <Missing title="the executor recorded no current_activity for this node">
              not recorded
            </Missing>
          </span>
        ) : (
          <span
            data-orientation-activity={activity?.kind ?? "unknown"}
            title={
              (line.known
                ? ""
                : `unrecognised activity kind "${activity?.kind ?? ""}" — shown verbatim\n\n`) +
              (line.detail ?? line.verb) +
              (activity?.ts ? `\n\n${activity.ts}` : "")
            }
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                flex: "none",
                color: line.known ? tokens.accent : tokens.warn,
                fontStyle: line.known ? undefined : "italic",
              }}
            >
              {line.verb}
            </span>
            {detail !== null && (
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: tokens.textMuted2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {detail.text}
              </span>
            )}
          </span>
        )}

        {/* The plan line exists only when a round exists to derive it from.
            `phase 600 → 700` is `floor(round/100)*100` and nothing else; there
            is no lookup, no endpoint and no default. */}
        {facts.plan !== null ? (
          <span
            data-orientation-plan={String(facts.plan.phase)}
            title={`derived from round ${facts.task?.round ?? EM_DASH}: rounds ${
              facts.plan.phase
            }–${facts.plan.next - 1} are phase ${facts.plan.phase}`}
            style={{ flex: "none", color: tokens.textMuted }}
          >
            phase {facts.plan.phase} → {facts.plan.next}
          </span>
        ) : facts.degraded !== null ? (
          <Missing title={`${DEGRADE_TEXT[facts.degraded]} — no phase is inferred`}>
            {DEGRADE_TEXT[facts.degraded]}
          </Missing>
        ) : (
          <Missing title="the task's round is not a usable number, so no phase can be derived">
            phase {EM_DASH}
          </Missing>
        )}
      </div>
    </div>
  );
}

export interface OrientationStripProps
  extends Omit<OrientationStripViewProps, "isSubagent" | "facts"> {
  /** Identifies the node. `runId` is the run that was fetched; `subagentId`,
   *  when present, is the spawn's `tool_use_id`. */
  frame: Extract<NavFrame, { kind: "agent" }>;
}

/**
 * The mounted strip: the cache observation, plus the view.
 *
 * Everything network-shaped in this component is in `useTeamReading`, and that
 * hook only ever READS. There is no fetcher in this file and no query of its
 * own — see the header. NFU3's requests-per-minute is unchanged by mounting it.
 */
export function OrientationStrip({ frame, ...rest }: OrientationStripProps) {
  const reading = useTeamReading(frame.runId, frame.subagentId);
  return (
    <OrientationStripView
      {...rest}
      isSubagent={frame.subagentId !== undefined}
      facts={derivePlanFacts(reading)}
    />
  );
}

export default OrientationStrip;
