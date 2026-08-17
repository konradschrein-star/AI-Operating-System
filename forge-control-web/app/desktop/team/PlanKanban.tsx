"use client";

/**
 * PlanKanban — the plan zone of the v3 right panel (U25/U26, 13 §1/§7).
 *
 * "The tasks in front of us", scoped to the open chat: one poll of
 * `GET /api/chat/:id/plan`, flattened through ./planStore into `PlanNode[]`,
 * and rendered as an always-visible x/y header over a scrollable stack of
 * hundreds-block cards. Every number on screen comes out of the store —
 * `planProgress` for the header, `PlanPhaseGroup.done/total` for the cards.
 * Nothing in this file counts anything, and that is what makes the header's
 * x/y byte-equal to the rail badge (planStore.ts quotes the SQL both sides
 * implement).
 *
 * ── The poll budget, stated up front (NFU3) ───────────────────────────────
 * This zone adds the panel's SECOND poll, at 30s. The plan is near-static —
 * a task changes status when a round lands, minutes apart — so 30s is a
 * deliberate choice, not a default: polling it faster buys nothing over the
 * team tree, which is the surface that actually moves. With the team zone's
 * 6s poll the panel costs 2 polls = 12 req/min, against the pre-v3 baseline
 * of 2 polls = 24.8 req/min (`/api/agents` every 4s + `/api/projects/board`
 * every 6s — ChatSurface.tsx's SidePanel comment records what was replaced).
 * Same count, less than half the rate. `enabled` is gated on `visible`, so a
 * collapsed panel or the Files tab costs zero requests and zero timers.
 *
 * ROUND 705, why these two numbers and not the ones round 702 shipped. 702
 * chose 5s/15s, which measured 43-44 req/min for the whole chat surface and
 * broke a gate this project had already committed: `phase600/nav-walk.cjs`'s
 * P3 asserts the drilled total stays inside phase 500's recorded 40/min, and
 * round 704 caught it failing. 6s + 30s puts the surface back on exactly 40
 * (28 for everything outside the panel + 10 + 2) and the panel's own slot
 * down from 16 to 12. The ceiling was not amended to fit the build; the build
 * was moved back under the ceiling. `phase700/network-700.cjs` now asserts
 * the total, not just the per-endpoint rates — that omission is what let 702
 * ship over its own gate.
 *
 * ── Hover is CSS, exactly as everywhere else in this directory (NFU2) ─────
 * No pointer-enter handler, no pointer-leave handler, no hover state. The
 * reviewer's grep comes back empty. Doc affordances underline via the
 * `.plan-doc-link` rules in app/globals.css, next to the `.team-row` ones
 * they are modelled on; every explanatory string is a native `title`, which
 * the browser draws without mounting anything. `onOpenDoc` is held in a ref
 * and re-exposed through an empty-deps `useCallback`, so a ChatSurface
 * re-render cannot change the callback identity that memoized cards hold —
 * the same discipline ChatTeamPanel.tsx documents for its row handlers.
 *
 * ── Why there is a flat `docs[]` list and not only phase links (U26) ──────
 * The server links a block to a document only when a digit run in the
 * filename equals the block's round number (routes/chat.ts:`matchPhaseDoc`,
 * which refuses to guess). THIS corpus is numbered by document position
 * (`00-`…`16-`), so not one of its 16 blocks carries `doc_path` — measured,
 * all 16, in docs/plan/artifacts/phase700/linkage-701.md §6. Two consequences
 * are designed in here: a card shows a doc affordance ONLY when `doc_path` is
 * actually present (a dead click that opens nothing is worse than no click),
 * and the corpus is ALSO exposed as a plain clickable list at the bottom of
 * the zone, so U26's click-through is reachable on the real data instead of
 * being hidden behind a match that this project can never make.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchChatPlan, type PlanResponse } from "./planApi";
import {
  groupPlanPhases,
  planProgress,
  statusTokenName,
  toPlanNodes,
  workstreamLabel,
  type PlanNode,
  type PlanPhaseGroup,
  type StatusTokenName,
} from "./planStore";

/** NFU3: one poll, 30s, paused whenever the zone is not visible. See the
 *  header comment for why this is slower than the team tree's 6s, and for why
 *  round 705 moved it out from 15s. */
const PLAN_POLL_MS = 30_000;

/** The "no response yet" projections. Module-level singletons so the memos
 *  below return stable identities while loading and nothing re-renders for it.
 *  Not `Object.freeze`d: that widens them to `readonly T[]`, which `planStore`'s
 *  mutable signatures reject, and nothing here writes to them anyway. */
const NO_NODES: PlanNode[] = [];
const NO_GROUPS: PlanPhaseGroup[] = [];

/**
 * Token NAME → token VALUE. The only place in the plan zone where a colour is
 * chosen, and it chooses none: `statusTokenName` in ./planStore decided which
 * name a status wears, this record turns that name into the CSS variable. The
 * same split ./TeamRow.tsx uses for `roleTokenName`, and the reason the store
 * can be unit-tested under tsx with no DOM.
 */
const STATUS_COLOR: Record<StatusTokenName, string> = {
  info: tokens.info,
  ok: tokens.ok,
  bleed: tokens.bleed,
  stuck: tokens.stuck,
  textMuted: tokens.textMuted,
  textFaint: tokens.textFaint,
};

/** The five states of the zone, on `data-plan-state`. Every one is a
 *  deliberate render; there is no sixth blank case (NFU6, U19). */
type PlanState = "loading" | "error" | "unlinked" | "empty" | "ready";

export interface PlanKanbanProps {
  chatId: string;
  /** Open a plan document in the middle surface (U26). Takes the file NAME,
   *  never a path: name→path resolution and its containment check are a server
   *  concern (13 §3), and the `plandoc` nav frame carries a name. The zone does
   *  not build the frame — where the middle surface goes is ChatSurface's
   *  business, and this callback's whole contract is "this document was
   *  clicked". */
  onOpenDoc: (name: string) => void;
  /** False when the Team tab is closed or the side panel is collapsed. Gates
   *  the poll. */
  visible: boolean;
}

/** One muted line — the zone's whole vocabulary for "a fact that is not a
 *  card". Same shape as ChatTeamPanel's `Note`, deliberately duplicated rather
 *  than exported across zone boundaries: it is four lines of style, and a
 *  shared primitive would couple two zones that are free to diverge. */
function Note({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      className="mono"
      style={{
        padding: "6px 10px",
        fontSize: 9.5,
        color: color ?? tokens.textMuted,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

/** done/total as a bar. Two divs and no text — the number is always rendered
 *  beside it, so the bar is redundancy for the eye, not the only statement. */
function ProgressBar({ done, total, height }: { done: number; total: number; height: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div
      style={{
        height,
        borderRadius: height,
        background: tokens.borderDivider,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: tokens.ok,
          borderRadius: height,
        }}
      />
    </div>
  );
}

/** The chip's native tooltip: the full (untruncated) title plus the facts the
 *  260px line had to drop. `tier` is `undefined` when the wire sent null, and
 *  null means "the engine picks" — a real fact, so it is said, not blanked
 *  (planApi.ts:`PlanTask.tier`).
 *
 *  R55 added `workstream` and `depth` here for every node, including the
 *  `main` ones the chip itself stays silent about: the same contract as the
 *  line above — the tooltip carries the facts the 260px row could not, and
 *  "this task runs in main at depth 3" is exactly such a fact. The visible
 *  chip is where noise is expensive; a tooltip nobody hovers costs nothing.
 *  `depth` is the DERIVED longest path, not the round, and is labelled so
 *  (planApi.ts:`PlanTask.depth`). */
function chipTitle(node: PlanNode): string {
  return [
    node.title,
    `round ${node.round}`,
    `role ${node.role}`,
    `status ${node.status}`,
    `tier ${node.meta.tier ?? "engine default"}`,
    `workstream ${node.workstream}`,
    `depth ${node.depth}`,
  ].join(" · ");
}

/* ── One hundreds-block ───────────────────────────────────────────────────── */

interface PhaseCardProps {
  group: PlanPhaseGroup;
  /** Stable identity, hoisted with `useCallback` in the zone — a fresh arrow
   *  here would defeat `memo` and re-render every card on every zone render. */
  onOpenDoc: (name: string) => void;
}

function PhaseCardImpl({ group, onOpenDoc }: PhaseCardProps) {
  const doc = group.doc_path;
  return (
    <div
      data-plan-phase={group.round_base}
      data-plan-phase-progress={`${group.done}/${group.total}`}
      style={{
        padding: "7px 10px",
        borderBottom: `1px solid ${tokens.borderDivider}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        {/* The block number carries the honesty note about its own membership
            rule (R42's round-221 amendment, handed to phase 6 by phase 4B).
            The alternative — regrouping a fix chain under the group that
            spawned it — is not available to this component and should not be:
            R55 fixes the grouping at `floor(round / 100) * 100`, the wire
            carries no `chain_key`, and a client re-deriving membership would
            eventually disagree with the server's own phase blocks. So the
            label is shown as DERIVED AND POSSIBLY CROSSING rather than
            silently misfiled. */}
        <span
          className="mono"
          title={
            "hundreds-block floor(round / 100) × 100 — a numbering convention, " +
            "not a dependency. Nothing is scheduled by it: promotion is by " +
            "depends_on. A fix chain created at a block boundary (round 99 → " +
            "100) is labelled by its own round and can therefore appear here " +
            "rather than under the group that spawned it."
          }
          style={{ fontSize: 10, color: tokens.accent, flex: "none" }}
        >
          {group.round_base}
        </span>
        {/* The server decided whether this block has a title; it only has one
            when a task sits exactly on the base round. No title is a fact, not
            a hole, so it says so rather than inventing a label from a
            neighbouring task (planApi.ts:`PlanPhase.title`). */}
        <span
          title={group.title ?? "no task sits on this block's base round, so the plan names no title for it"}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 10.5,
            color: group.title ? tokens.textLabel : tokens.textFaint,
          }}
        >
          {group.title ?? "(untitled block)"}
        </span>
        <span
          className="mono"
          style={{
            flex: "none",
            fontSize: 9.5,
            color: tokens.textMuted,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {group.done}/{group.total}
        </span>
      </div>

      <div style={{ marginTop: 4 }}>
        <ProgressBar done={group.done} total={group.total} height={2} />
      </div>

      {/* Only when the server actually matched a document to this block. On
          this corpus that is never (see the header comment) — and an affordance
          that renders anyway, opening nothing, is the failure this branch
          exists to avoid. */}
      {doc !== undefined && (
        <button
          type="button"
          data-plan-doc={doc}
          onClick={() => onOpenDoc(doc)}
          title={`Open ${doc} — this block's plan document`}
          className="mono plan-doc-link"
          style={{
            marginTop: 4,
            background: "transparent",
            border: "none",
            padding: 0,
            fontFamily: "inherit",
            fontSize: 9.5,
            color: tokens.accent,
            cursor: "pointer",
          }}
        >
          ↳ {doc}
        </button>
      )}

      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
        {group.nodes.map((node) => {
          /* The rule lives in ./planStore, not here, so R55's named instrument
             (scripts/checks/check-plan-store.ts, which cannot import React) can
             execute it. `undefined` means `main`, which means NOTHING is drawn
             — no chip, no placeholder, no dash. */
          const workstream = workstreamLabel(node);
          return (
          <div
            key={node.id}
            data-plan-task={node.id}
            data-status={node.status}
            /* Only when it is not `main`, and only ever the raw value — a
               future DOM probe finds the interesting rows with a single
               attribute selector instead of reading styles. Same convention as
               `data-plan-task` / `data-status` above. */
            {...(workstream !== undefined ? { "data-plan-workstream": workstream } : {})}
            title={chipTitle(node)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 5px",
              borderRadius: 4,
              background: tokens.toolBg,
            }}
          >
            <span
              className="mono"
              style={{
                flex: "none",
                fontSize: 9,
                color: tokens.textFaint,
                minWidth: 22,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {node.round}
            </span>
            <span
              className="mono"
              style={{ flex: "none", fontSize: 9, color: tokens.textMuted2, minWidth: 42 }}
            >
              {node.role}
            </span>
            {/* Hollow for anything not running, filled for running — the same
                glyph grammar the team tree and /live already use. `dot()` is
                not imported: it carries a pulse animation for live rows, and a
                60-chip list of pulsing dots is a different design decision than
                the one the team tree made for its handful of rows. */}
            <span
              style={{
                flex: "none",
                width: 6,
                height: 6,
                borderRadius: "50%",
                background:
                  node.status === "running"
                    ? STATUS_COLOR[statusTokenName(node.status)]
                    : "transparent",
                border: `1px solid ${STATUS_COLOR[statusTokenName(node.status)]}`,
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 10,
                color: tokens.textSecondary,
              }}
            >
              {node.title}
            </span>
            {/* The one row running somewhere other than `main` is the row this
                zone exists to make findable, so the badge is drawn only for it
                (planStore.ts:`workstreamLabel`). Every task today is `main`;
                sixty identical badges would bury the interesting one. */}
            {workstream !== undefined && (
              <span
                className="mono"
                style={{
                  flex: "none",
                  fontSize: 8.5,
                  color: tokens.accent,
                  border: `1px solid ${tokens.borderSoft}`,
                  borderRadius: 3,
                  padding: "0 3px",
                  maxWidth: 64,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {workstream}
              </span>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

/** Memoized on a shallow prop compare. Hover changes no prop — it is CSS — so
 *  a hover sweep across the zone commits nothing (NFU2). A poll replaces
 *  `group`, which is the only thing that should re-render a card. */
const PhaseCard = memo(PhaseCardImpl);

/* ── The zone ─────────────────────────────────────────────────────────────── */

export function PlanKanban({ chatId, onOpenDoc, visible }: PlanKanbanProps) {
  const enabled = visible && Boolean(chatId);

  const plan = useQuery<PlanResponse, Error>({
    queryKey: ["chat-plan", chatId],
    queryFn: () => fetchChatPlan(chatId),
    refetchInterval: PLAN_POLL_MS,
    enabled,
    refetchOnWindowFocus: false,
    // NFU6, same bargain the team query makes. The app-wide default is
    // `retry: 2` with exponential backoff (app/Providers.tsx) — on this query
    // that would keep the LAST GOOD PLAN on screen, unmarked, while react-query
    // retried a dead API behind it. One failure, one honest error state, next
    // poll in 30s.
    retry: 0,
  });

  const onOpenDocRef = useRef(onOpenDoc);
  /* Written in an effect, not during render: a ref mutated in the render body
   * is a side effect React is free to run twice (StrictMode is on — see
   * next.config.mjs). Same wiring as ChatTeamPanel's `openNodeRef`. */
  useEffect(() => {
    onOpenDocRef.current = onOpenDoc;
  }, [onOpenDoc]);
  /* Empty deps: the identity handed to every memoized card must survive a
   * ChatSurface re-render, or the cards re-render with it. The ref above is
   * what carries the current callback through. */
  const handleOpenDoc = useCallback((name: string) => {
    onOpenDocRef.current(name);
  }, []);

  const data = plan.data;

  const nodes = useMemo(() => (data ? toPlanNodes(data) : NO_NODES), [data]);
  const groups = useMemo(
    () => (data ? groupPlanPhases(nodes, data) : NO_GROUPS),
    [data, nodes],
  );
  /* The rail badge's number, computed from the same rule on the same rows —
   * never re-counted here. planStore.ts quotes the SQL both sides implement. */
  const progress = useMemo(() => planProgress(nodes), [nodes]);

  const state: PlanState = plan.isError
    ? "error"
    : !data
      ? "loading"
      : data.project === null
        ? "unlinked"
        : data.phases.length === 0
          ? "empty"
          : "ready";

  const hasCounts = state === "ready" || state === "empty";

  return (
    <div
      data-plan-kanban
      data-plan-state={state}
      data-plan-progress={hasCounts ? `${progress.done}/${progress.total}` : "—"}
      style={{
        flex: "0 1 auto",
        minHeight: 0,
        maxHeight: "40%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* U25's "always-visible" progress indicator, pinned STRUCTURALLY rather
          than with `position: sticky`: the header is a `flex: none` sibling of
          the scroller, so it is outside the scrolling box entirely and cannot
          scroll away under any content height, at any zoom, with no dependency
          on an opaque background painting over the cards beneath it. */}
      <div
        data-plan-header
        style={{
          flex: "none",
          padding: "6px 10px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span
            className="mono"
            style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.1em" }}
          >
            PLAN
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            title={
              hasCounts
                ? "tasks done / tasks total across every phase of this chat's " +
                  "project — the same rule the rail badge counts by: done is " +
                  "exactly status 'done', and every task is in the denominator"
                : "no plan counted yet"
            }
            style={{
              fontSize: 9.5,
              color: tokens.textMuted,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {hasCounts ? `${progress.done}/${progress.total}` : "—"}
          </span>
        </div>
        {hasCounts && (
          <div style={{ marginTop: 4 }}>
            <ProgressBar done={progress.done} total={progress.total} height={3} />
          </div>
        )}
      </div>

      {state === "error" ? (
        /* NFU6: the cached plan is NOT rendered next to this. Stale cards
         * beside an error read as fresh cards. */
        <Note color={tokens.bleed}>
          plan unavailable — {plan.error?.message ?? "unknown error"}
        </Note>
      ) : (
        <div data-plan-scroll style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {/* The docs listing failed while the phases came back fine — two
              independent facts on one response, so this is a warn line BESIDE
              the cards, not an error state instead of them (planApi.ts:
              `PlanResponse.error`). */}
          {data?.error !== undefined && (
            <Note color={tokens.warn}>plan docs unreadable — {data.error}</Note>
          )}

          {state === "loading" && <Note>{enabled ? "loading plan…" : "no chat open"}</Note>}
          {state === "unlinked" && <Note>no project linked to this chat</Note>}
          {state === "empty" && <Note>no plan yet — this project has no tasks</Note>}

          {groups.map((group) => (
            <PhaseCard key={group.round_base} group={group} onOpenDoc={handleOpenDoc} />
          ))}

          {/* U26's click-through, on the corpus itself. Every file the server
              listed, clickable — this is what makes the feature reachable on a
              plan whose blocks carry no `doc_path` (header comment). */}
          {data !== undefined && state !== "unlinked" && (
            <div data-plan-docs style={{ padding: "6px 10px 8px" }}>
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  color: tokens.textFaint,
                  letterSpacing: "0.1em",
                  marginBottom: 4,
                }}
              >
                PLAN DOCS
              </div>
              {data.docs.length === 0 ? (
                <Note>
                  {data.error !== undefined
                    ? "none listed — the corpus could not be read (above)"
                    : "no documents in this project's docs/plan/"}
                </Note>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {data.docs.map((name) => (
                    <button
                      key={name}
                      type="button"
                      data-plan-doc={name}
                      onClick={() => handleOpenDoc(name)}
                      title={`Open ${name}`}
                      className="mono plan-doc-link"
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: "1px 0",
                        fontFamily: "inherit",
                        fontSize: 9.5,
                        color: tokens.textSecondary,
                        cursor: "pointer",
                        textAlign: "left",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PlanKanban;
