"use client";

/**
 * AgentChatView — the middle surface when you have drilled into an agent
 * (U20, 13 §1). Round 601B built the shell, 602 made the transcript readable,
 * and this round (603) mounts the two blocks that sit above it:
 *
 *   <OrientationStrip>  U22 — who this is, on what model, which task, which
 *       round, what it is doing right now, and where that sits in the plan.
 *       Two lines, pinned, pure function of data already on the wire.
 *   <StorySoFar>        U24 — 601A's `deriveDigest` rendered, collapsed by
 *       default, only above `DIGEST_MIN_ENTRIES`.
 *
 * Neither adds a request. The strip observes the team panel's existing poll
 * through the react-query cache (see OrientationStrip.tsx); the digest is pure
 * derivation over the thread this file already holds.
 *
 * ── Where the identity line went ──────────────────────────────────────────
 * The header used to carry kind/role/model/description on its own line above
 * the crumbs. That is line 1 of the orientation strip now, `data-agent-role`
 * and `data-agent-model` included — the round-601B e2e harness reads those two
 * attributes document-wide, and there is still exactly one of each. The header
 * keeps what is genuinely navigation: the back button and the lineage trail.
 *
 * ── One fetch, no more than the manager was making (NFU3) ─────────────────
 * While this view is mounted, ChatSurface's manager `detailQ` is DISABLED —
 * `enabled` carries `navStack.length === 0`. The query below runs at the same
 * intervals the manager's did (`live ? 20000 : 3000`), so the surface's
 * request rate while drilled is identical to its request rate at rest: one
 * detail poll, plus the single SSE stream, which stays on `selId` and is not
 * touched by this file. Net requests per minute do not move.
 *
 * ── Descending into a sub-agent costs ZERO additional fetches ─────────────
 * A sub-agent is not a run. It is a Task call inside its parent's process,
 * and its transcript is already inline in the parent run's thread, stamped
 * with `meta.parent_tool_use_id` (verified on run 3853c154: 196 of 285
 * entries carry it). So descending slices the thread we already hold and
 * synthesises the `RunDetail` handed to `AssistantThread` — same query, same
 * cadence, one more level of depth.
 *
 * ── Failure is rendered, never inferred ───────────────────────────────────
 * A fetch that fails, a run that does not exist, a `subagentId` with no
 * matching `metadata.subagents_v2` entry: each gets its own explicit block
 * naming what went wrong, with the back button still working (13 §9). The one
 * thing this file will not do is render an empty transcript as if it were the
 * agent's — a sub-agent whose entries were never attributed inline says so.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchChat, type RunDetail, type RunStatus, type ThreadEntry } from "../../api";
import { AssistantThread } from "./AssistantThread";
import { OrientationStrip } from "./OrientationStrip";
import { StorySoFar } from "./StorySoFar";
import {
  parseSpawnInput,
  parseSubagentsV2,
  subagentEntries,
  subagentTranscript,
  type SubagentMeta,
} from "./subagent-slice";
import { crumbs, type NavFrame, type NavStack } from "./nav-stack";

/** Statuses that can never change again. Drives the strip's "currently:" vs
 *  "ended:" — a settled agent must never be described in the present tense
 *  (project Definition of Done #1). */
const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/* ── Metadata readers ─────────────────────────────────────────────────────
 *
 * `run.metadata` is untyped JSONB. Every read below is guarded and returns
 * `null` for "absent or not a string" — never a cast, never `any`. A number
 * or a stray `""` where a model id belongs must read as unknown, not as a
 * model called "0".
 */

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v ? v : null;
}

/** The model a run ACTUALLY ran on. Not a top-level field on `RunDetail` and
 *  not `metadata.model` (which is the request, i.e. possibly a bare alias) —
 *  `model_resolved` is what the executor recorded after the CLI resolved it
 *  (forge-control/src/lib/run-rollup.ts:331). */
function runModel(meta: Record<string, unknown>): string | null {
  return metaString(meta, "model_resolved") ?? metaString(meta, "model");
}

/** The declared sub-agent with this `tool_use_id`, or null.
 *
 *  Parsing goes through round 601A's `parseSubagentsV2` rather than a second
 *  reader of the same JSONB — one module owns the shape of `subagents_v2` on
 *  the client, and it drops entries with no usable id, which is precisely the
 *  case this lookup must not match. */
function findSubagentMeta(
  meta: Record<string, unknown>,
  toolUseIdValue: string,
): SubagentMeta | null {
  const all = parseSubagentsV2(meta.subagents_v2);
  return all.find((s) => s.tool_use_id === toolUseIdValue) ?? null;
}

/* ── The spawn call: the source the TEAM PANEL actually used ──────────────
 *
 * `subagents_v2` is a rollup the executor only started writing recently. The
 * team panel does not depend on it: `foldSubagents`
 * (forge-control/src/routes/agents-shared.ts:222) SEEDS a row from every
 * Agent/Task `tool_call` in the thread and enriches it from the rollup if one
 * exists. Measured against the live database on 2026-08-06, every operator
 * chat with sub-agent rows — 11dd264b (7 rows), ece63bdb (15) — carries an
 * EMPTY `subagents_v2` and zero `parent_tool_use_id` stamps. The rollup path
 * is the minority case today, not the normal one.
 *
 * So this view reads the same two sources the panel does, in the same order:
 * the rollup when it has an entry, the spawn call otherwise. A drill-in that
 * only understood the rollup would answer "no such sub-agent" on almost every
 * row Konrad can currently click, which is a failure dressed as honesty.
 */

interface SpawnFacts {
  /** The Agent/Task `tool_call` with this `tool_use_id` was found. When false
   *  and the rollup has nothing either, the row and the run truly disagree. */
  found: boolean;
  role: string | null;
  model: string | null;
  description: string | null;
  /** True once the matching `tool_result` has arrived — the sub-agent
   *  returned. Same completion test `foldSubagents` uses. */
  done: boolean;
}

/** Role and description live inside the spawn's `input`, which is a JSON
 *  STRING on the wire: `{"description":"…","subagent_type":"architect",…}`.
 *  The reader is `subagent-slice.parseSpawnInput` — round 606 moved it there so
 *  this header and the digest's roster read that field through the same
 *  function. They disagreed when they did not (README.md §6.1). */
function findSpawnFacts(thread: readonly ThreadEntry[], toolUseIdValue: string): SpawnFacts {
  const facts: SpawnFacts = {
    found: false,
    role: null,
    model: null,
    description: null,
    done: false,
  };
  for (const e of thread) {
    const meta = e.meta;
    if (!meta || meta.tool_use_id !== toolUseIdValue) continue;
    if (e.kind === "tool_call" && (meta.tool === "Agent" || meta.tool === "Task")) {
      const { role, description } = parseSpawnInput(meta.input);
      facts.found = true;
      facts.role =
        typeof meta.spawns_subagent_role === "string" && meta.spawns_subagent_role
          ? meta.spawns_subagent_role
          : role;
      facts.model = typeof meta.model === "string" && meta.model ? meta.model : null;
      facts.description = description;
    } else if (e.kind === "tool_result") {
      facts.done = true;
    }
  }
  return facts;
}

/* `subagentTranscript` — a sub-agent's own entries plus the spawn/result
 * envelope that framed it — lives in `subagent-slice.ts` as of round 606. It is
 * pure thread arithmetic, and `check-story-digest.ts` has to be able to feed
 * the REAL drilled-view input to `deriveDigest`: round 605's defect survived a
 * unit check that built a pure slice by hand, because a pure slice is not what
 * this view ever renders. */

/** `subagents_v2.status` is a two-word vocabulary (and may be absent);
 *  `RunStatus` is seven. Map it explicitly.
 *
 *  `AssistantThread` branches on `running`/`queued` to decide whether to hold
 *  up its "engine working" strip, so an absent or unrecognised status must not
 *  resolve to `running` on a sub-agent that has already returned: a finished
 *  sub-agent flying a live activity strip is the same "still counting when it's
 *  done" lie Konrad opened this project with.
 *
 *  So an unrecognised status defers to the spawn's own `tool_result`, which is
 *  the more reliable witness when the rollup is silent — and it IS silent on
 *  almost every run a reader can click. Note the honest consequence, stated
 *  because it is the one case this function cannot settle: a sub-agent with no
 *  rollup status and no result yet reads `running`. That is the correct reading
 *  of "spawned, nothing came back" while the parent is alive; on a parent that
 *  has itself settled it would be wrong, and nothing here can tell the two
 *  apart from the sub-agent's own evidence. Round 605's review measured the
 *  branch against the fleet: 0 of 58 settled runs reach it today. */
function subagentRunStatus(status: string | null, spawnDone: boolean): RunStatus {
  if (status === "done") return "completed";
  if (status === "running") return "running";
  return spawnDone ? "completed" : "running";
}

/**
 * The `RunDetail` a sub-agent view hands to `AssistantThread`: the parent run
 * with its thread narrowed to this sub-agent's transcript, and the few fields
 * `AssistantThread` reads re-pointed at the sub-agent.
 *
 * Everything else is inherited deliberately — timestamps, budget, heartbeat
 * belong to the parent PROCESS, which is the literal truth about an
 * in-process sub-agent.
 */
function synthesizeSubagentRun(
  parent: RunDetail,
  toolUseIdValue: string,
  identity: { description: string | null; status: string | null },
  spawnDone: boolean,
  entries: ThreadEntry[],
): RunDetail {
  return {
    ...parent,
    id: toolUseIdValue,
    title: identity.description ?? `sub-agent ${toolUseIdValue.slice(0, 8)}`,
    status: subagentRunStatus(identity.status, spawnDone),
    thread: entries,
    message_count: entries.length,
    parent_run_id: parent.id,
  };
}

/* ── Shared chrome ────────────────────────────────────────────────────────
 *
 * `BackButton` is exported from this file rather than getting one of its own:
 * round 601B owns a fixed file list, and a third new component file is not on
 * it. PlanDocView imports it from here. If a fourth drilled view ever appears,
 * that is the moment to give the button a module.
 *
 * The animation is entirely in app/globals.css (`.nav-back`), following the
 * `.chat-row` / `.team-row` idiom: no animation dependency (NFU8), no React
 * hover state (NFU2), transform and opacity only.
 */

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      data-nav-back
      type="button"
      onClick={onClick}
      title={`Back to ${label}`}
      className="mono nav-back"
      style={{
        flex: "none",
        fontSize: 10,
        letterSpacing: "0.06em",
        padding: "4px 9px",
        borderRadius: 6,
        cursor: "pointer",
        color: tokens.accent,
        background: tokens.primaryActionBg,
        border: `1px solid ${tokens.accent}`,
      }}
    >
      <span className="nav-back-arrow">←</span> {label}
    </button>
  );
}

/** The lineage trail. Native text, no tooltip component, no hover state — the
 *  last crumb is the view you are in and is the only one this component can
 *  honestly enrich (see `crumbs`' doc comment). */
function Crumbs({ stack, current }: { stack: NavStack; current: string }) {
  const trail = useMemo(() => crumbs(stack), [stack]);
  return (
    <div
      data-nav-crumbs
      className="mono"
      style={{
        fontSize: 9.5,
        color: tokens.textFaint,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        minWidth: 0,
      }}
    >
      {trail.map((c, i) => (
        <span key={`${c.depth}:${c.id ?? "root"}`}>
          {i > 0 && <span style={{ color: tokens.textGhost }}> › </span>}
          <span style={{ color: i === trail.length - 1 ? tokens.textMuted : undefined }}>
            {i === trail.length - 1 ? current : c.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/** One muted line, the panel vocabulary for "a fact that is not a transcript".
 *  Never a spinner: this surface is full-width, and a spinner in it reads as a
 *  hang (same reasoning as ChatTeamPanel's `Note`).
 *
 *  `tight` is for the notes that now sit UNDER the orientation strip and the
 *  digest: three stacked blocks at 20px/28px padding would push the transcript
 *  down the page, and U22's one hard layout rule is that the strip must not do
 *  that. The error/empty notes, which are the whole screen, keep the room. */
function Note({
  children,
  color,
  tight,
}: {
  children: React.ReactNode;
  color?: string;
  tight?: boolean;
}) {
  return (
    <div
      className="mono"
      style={{
        padding: tight ? "7px 14px" : "20px 28px",
        fontSize: 11,
        lineHeight: 1.6,
        color: color ?? tokens.textMuted,
      }}
    >
      {children}
    </div>
  );
}

/** Says what the transcript below actually IS, so a two-entry view is not
 *  mistaken for a two-entry session.
 *
 *  Round 603 kept it rather than folding it into the digest: the digest is
 *  collapsed by default and only appears above 50 entries, while the case this
 *  line exists for — a sub-agent whose inner steps were never stamped — is
 *  usually a TWO-entry view. The one thing that had to be said about those is
 *  said where it cannot be missed. */
function SliceNote({ total, inner }: { total: number; inner: number }) {
  if (total === 0) {
    return (
      <Note tight color={tokens.warn}>
        nothing in this run’s thread carries this sub-agent’s id — not its spawn call, not
        its result. Its work is recorded in the team rollup but none of it was written to
        the transcript. A gap in the recorded data, not an empty agent.
      </Note>
    );
  }
  if (inner === 0) {
    return (
      <Note tight>
        {total} {total === 1 ? "entry" : "entries"} — this sub-agent’s brief and its
        report. Its individual steps were never stamped with{" "}
        <span className="mono">meta.parent_tool_use_id</span> on this run, so the work
        between them was not recorded and cannot be shown.
      </Note>
    );
  }
  return (
    <Note tight>
      {total} entries — {inner} of this sub-agent’s own, plus the spawn call and result
      that framed it.
    </Note>
  );
}

export interface AgentChatViewProps {
  /** The frame on top of the stack. `runId` is what gets fetched; a present
   *  `subagentId` selects a slice of that run's thread. */
  frame: Extract<NavFrame, { kind: "agent" }>;
  /** The WHOLE stack, for the lineage crumb. The view renders where it sits,
   *  not just what it is. */
  stack: NavStack;
  /** ChatSurface's SSE liveness for the OPEN CHAT, used for one thing only:
   *  picking the same refetch interval the manager's detail query would have
   *  been using right now, so the poll budget is unchanged by drilling in
   *  (NFU3). It is not a claim about this run's stream. */
  live: boolean;
  /** Pops one level. At depth 1 that is the manager chat. */
  onBack: () => void;
  /** What the back button says it returns to — the caller knows the level
   *  below, this view does not. */
  backLabel: string;
}

export function AgentChatView({
  frame,
  stack,
  live,
  onBack,
  backLabel,
}: AgentChatViewProps) {
  /* The one query. Same key namespace as ChatSurface's manager query, so
   * drilling into a run you have already opened reads from the same cache
   * entry instead of opening a second one. */
  const detailQ = useQuery({
    queryKey: ["chat", "run", frame.runId],
    queryFn: () => fetchChat(frame.runId),
    refetchInterval: live ? 20000 : 3000,
  });

  const run = detailQ.data ?? null;
  const subagentId = frame.subagentId;

  /* Who this sub-agent is, from the two sources the team panel itself used:
   * the rollup first, the spawn call as the fallback that covers almost every
   * clickable row today. `known` is false only when NEITHER has it — the real
   * "the row and the run disagree" case. */
  const sub = useMemo(
    () => (run && subagentId !== undefined ? findSubagentMeta(run.metadata, subagentId) : null),
    [run, subagentId],
  );
  const spawn = useMemo(
    () => (run && subagentId !== undefined ? findSpawnFacts(run.thread, subagentId) : null),
    [run, subagentId],
  );
  const known = sub !== null || (spawn !== null && spawn.found);

  const entries = useMemo(
    () => (run && subagentId !== undefined ? subagentTranscript(run.thread, subagentId) : null),
    [run, subagentId],
  );

  const view = useMemo(() => {
    if (!run) return null;
    if (subagentId === undefined) return run;
    if (!known || !entries) return null;
    return synthesizeSubagentRun(
      run,
      subagentId,
      {
        description: sub?.description ?? spawn?.description ?? null,
        status: sub?.status ?? null,
      },
      spawn?.done ?? false,
      entries,
    );
  }, [run, subagentId, known, sub, spawn, entries]);

  /* Identity, resolved ONCE and here. A sub-agent's role/model/description come
   * from its rollup entry or, failing that, its spawn call; a session's come
   * from its own metadata. Neither kind is ever guessed from the other, and
   * OrientationStrip does not re-derive any of it — it is handed the answer. */
  const isSubagent = subagentId !== undefined;
  const identity = useMemo(
    () => ({
      role: isSubagent
        ? (sub?.role ?? spawn?.role ?? null)
        : run
          ? metaString(run.metadata, "role")
          : null,
      model: isSubagent
        ? (sub?.model ?? spawn?.model ?? null)
        : run
          ? runModel(run.metadata)
          : null,
      description: isSubagent
        ? (sub?.description ?? spawn?.description ?? null)
        : (run?.title ?? null),
    }),
    [isSubagent, sub, spawn, run],
  );

  const currentCrumb =
    subagentId !== undefined
      ? `sub-agent ${subagentId.slice(0, 8)}`
      : `session ${frame.runId.slice(0, 8)}`;

  return (
    <div
      data-agent-chat-view
      data-run-id={frame.runId}
      data-subagent-id={subagentId ?? ""}
      data-depth={stack.length}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        <BackButton label={backLabel} onClick={onBack} />
        {/* Navigation only. Identity moved down into the orientation strip —
            one place per fact, and the strip is the place. */}
        <Crumbs stack={stack} current={currentCrumb} />
      </div>

      {detailQ.isError ? (
        <Note color={tokens.bleed}>
          could not load this agent — {detailQ.error?.message ?? "unknown error"}
          <br />
          the run id was {frame.runId}. back still works.
        </Note>
      ) : !run ? (
        <Note>loading transcript…</Note>
      ) : isSubagent && !known ? (
        /* The parent loaded and NEITHER source knows this sub-agent: no
         * `subagents_v2` entry and no Agent/Task spawn carrying the id.
         * Rendering the parent's transcript here would silently show you a
         * DIFFERENT agent than the row you clicked, which is worse than an
         * error. */
        <Note color={tokens.warn}>
          this run knows nothing about <span className="mono">{subagentId}</span> — neither
          a <span className="mono">subagents_v2</span> entry nor an Agent/Task call with
          that <span className="mono">tool_use_id</span>. The team row and the run detail
          disagree; nothing is rendered rather than the parent’s transcript under a
          sub-agent’s name.
        </Note>
      ) : view === null ? (
        <Note color={tokens.warn}>transcript unavailable for this frame</Note>
      ) : (
        <>
          {/* U22. Pinned above everything, on every worker and sub-agent view.
              `settled` is computed from the VIEW's status, which for a
              sub-agent is `subagentRunStatus` — the rollup's word, or its
              spawn's tool_result when the rollup is silent. That is what makes
              the strip say "ended:" on a finished child of a still-running
              parent instead of describing it in the present tense. */}
          <OrientationStrip
            frame={frame}
            identity={identity}
            metadata={run.metadata}
            subagent={sub}
            settled={SETTLED.has(view.status)}
          />
          {/* U24. Collapsed, and absent entirely below 50 entries — which is
              most sub-agent slices, and all of the two-entry ones the note
              below explains. `view.thread` is the scope in both cases, and for
              a sub-agent the scope carries the id: the digest must be told
              WHOSE thread this is, because `view.thread` includes the spawn
              call and result, which are top-level entries and make the slice
              undetectable from its shape alone (round 605's defect). */}
          <StorySoFar
            run={view}
            thread={view.thread}
            scope={
              subagentId === undefined
                ? { kind: "session" }
                : { kind: "subagent", subagentId }
            }
          />
          {isSubagent && (
            /* How much of this transcript is the sub-agent's own work vs the
             * envelope its parent recorded. On a run the executor stamped,
             * `inner` is most of it; on an older run it is zero and what you
             * are reading is the brief and the report, which is stated here
             * rather than left to look like the whole session. */
            <SliceNote
              total={view.thread.length}
              inner={
                subagentId !== undefined && run
                  ? subagentEntries(run.thread, subagentId).length
                  : 0
              }
            />
          )}
          {/* Round 602 mounting (U23). Two things change for a drilled view
              and only for a drilled view:
                · mode="summary" — the collapsed tool line is 601A's derived
                  one-liner instead of a slice of raw JSON;
                · scope — a session shows its OWN entries and folds each
                  sub-agent into the Agent/Task call that spawned it; a
                  sub-agent view shows its slice plus the envelope.
              The MANAGER chat keeps today's rendering: it is Konrad's main
              surface and this phase's mandate is worker-chat legibility.
              `view.thread` is already narrowed for the sub-agent case, and the
              scope re-states that narrowing rather than assuming it — the
              mapper yields the same view either way, so the two cannot drift
              apart. */}
          <AssistantThread
            run={view}
            mode="summary"
            scope={
              subagentId === undefined
                ? { kind: "top-level" }
                : { kind: "subagent", subagentId }
            }
          />
        </>
      )}
    </div>
  );
}

export default AgentChatView;
