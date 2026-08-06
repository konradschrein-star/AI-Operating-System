"use client";

/**
 * ChatTeamPanel — the v3 right panel (U14–U19), in two zones.
 *
 * Since phase 700 this component is the PANEL, not one zone of it: the team
 * tree below plus `./PlanKanban` under it (13 §1 — ChatTeamPanel = TeamTree +
 * PlanKanban). Everything this file says about queries, hover and state is
 * about the TEAM zone; the plan zone owns its own poll, its own states and its
 * own error line, and this file's only involvement with it is threading
 * `chatId`/`onOpenDoc`/`visible` through.
 *
 * One panel, scoped to the open chat, with no selector of its own: the chat
 * decides which project it is looking at, and `GET /api/chat/:id/team` answers
 * with the whole org chart in one response. That single poll REPLACES the
 * panel's two old ones (`/agents` every 4s and `/projects/board` every 6s) —
 * NFU3's poll budget is met by subtraction, not by adding a third source.
 * Nothing else in this file polls.
 *
 * This round builds the component; round 503 mounts it in ChatSurface. Until
 * then it compiles, typechecks and ships in the bundle unreferenced, so the
 * app stays deployable at every commit.
 *
 * ── What the panel owns ───────────────────────────────────────────────────
 *   • two queries (team, capabilities) and nothing else that talks to the net
 *   • `armedId` — WHICH row's destructive X is armed, as one string; rows get
 *     a boolean, so arming re-renders two rows instead of the list
 *   • dismissals, via ./dismissals (localStorage today, server-backed in 1600)
 *
 * It does NOT own hover. There is no pointer-enter handler, no pointer-leave
 * handler and no hover state anywhere in this directory; the controls are mounted in every
 * row at all times and revealed by the `.team-row` rules in app/globals.css.
 * That is the whole NFU2 story: hovering a row changes no React state, so it
 * commits nothing and lays out nothing.
 *
 * ── The control plane does not exist yet, on purpose ──────────────────────
 * `GET /api/capabilities` answers all-false today (U8). Stop and terminate are
 * therefore rendered DISABLED WITH A REASON — visible, tooltipped with the
 * exact flag name, never hidden and never a silent no-op (NFU6). The gate is
 * enforced three times over: in `decideXClick`/`decideStopClick` as a value,
 * again as a literal guard clause in the handlers below, and structurally —
 * THERE IS NO FETCH CALL for either action in this file. When
 * engine-v2-research-lane ships the contract, the endpoints go where the
 * `CONTRACT:` comments are, and the flags flip on their side first.
 *
 * ── One deviation from the round-501b evidence harness, stated here ───────
 * `docs/plan/artifacts/phase500/capture-team.cjs` shoots its "armed" case by
 * clicking the FIRST `[data-team-x]` once and waiting for
 * `data-confirm="armed"`. Under the rules this round implements, that click
 * arms only on a RUNNING row, and a running row's X is `disabled` today
 * (terminate is capability-gated). On a settled row the same click dismisses
 * in one go, because a dismissal is reversible and a confirm step in front of
 * a reversible action is how people learn to click through confirms. So round
 * 504 must reach the armed screenshot the way the reviewer reaches it: strip
 * the `disabled` attribute in the page, then click a running row's X. The
 * second click is what dead-ends in the guard — which is exactly the property
 * worth photographing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  ARM_WINDOW_MS,
  decideStopClick,
  decideXClick,
  type ArmedState,
} from "./confirm";
import { useDismissals } from "./dismissals";
import {
  fetchCapabilities,
  fetchChatTeam,
  type CapabilitiesResponse,
  type TeamNode,
  type TeamResponse,
} from "./teamApi";
import { flattenTeam, responseNowMs, type FlatTeam } from "./teamRows";
import { TeamRowView } from "./TeamRow";
import { PlanKanban } from "./PlanKanban";

/** NFU3: one poll, 5s, paused whenever the panel is not visible. */
const TEAM_POLL_MS = 5_000;

/** Capabilities are a session-lifetime constant — the flags only move when the
 *  engine lane deploys, which reloads the page anyway. */
const CAPABILITIES_STALE_MS = Number.POSITIVE_INFINITY;

/** The safe default. A capabilities fetch that FAILS must leave every control
 *  disabled, never optimistically enabled — an "unknown" capability and an
 *  absent one are the same thing to a control that could kill a run. */
const ALL_FALSE: CapabilitiesResponse["control_plane"] = {
  message_into_session: false,
  resume_finished: false,
  stop: false,
  terminate: false,
};

/** The "no response yet" tree. One frozen object so the `rows` memo returns a
 *  stable identity while loading and the row list never re-renders for it. */
const NO_TEAM: FlatTeam = { rows: [], hiddenCount: 0 };

/** The five states of the panel, on `data-team-state` at the root. Every one
 *  of them is a deliberate render — there is no sixth "blank" case where the
 *  panel shows nothing and leaves you guessing which of the five you are in
 *  (NFU6, U19). */
type TeamState = "loading" | "error" | "empty" | "unlinked" | "ready";

export interface ChatTeamPanelProps {
  chatId: string;
  /** Drill into a row (U20). Takes the NODE, not an id: a sub-agent's `id` is
   *  a `tool_use_id` and the nav frame ChatSurface builds needs its `kind` and
   *  `parent_id` as well. The panel does not build the frame itself — where
   *  the middle surface goes is ChatSurface's business, and the panel's whole
   *  contract is "this row was clicked". */
  onOpenNode: (node: TeamNode) => void;
  /** Open a plan document in the middle surface (U26). Threaded straight
   *  through to the plan zone — the team zone never calls it. */
  onOpenDoc: (name: string) => void;
  /** False when the Team tab is closed or the side panel is collapsed. Gates
   *  the poll — a hidden panel costs zero requests and zero timers. */
  visible: boolean;
}

/** One muted line. The panel's whole vocabulary for "here is a fact about this
 *  zone that is not a row": loading, empty, unlinked, degraded. Never a
 *  spinner (U19 asks for an intentional line, and a spinner in a 260px panel
 *  reads as a hang). */
function Note({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      className="mono"
      style={{
        padding: "8px 10px",
        fontSize: 10,
        color: color ?? tokens.textMuted,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

export function ChatTeamPanel({
  chatId,
  onOpenNode,
  onOpenDoc,
  visible,
}: ChatTeamPanelProps) {
  const enabled = visible && Boolean(chatId);

  const team = useQuery<TeamResponse, Error>({
    queryKey: ["chat-team", chatId],
    queryFn: () => fetchChatTeam(chatId),
    refetchInterval: TEAM_POLL_MS,
    enabled,
    refetchOnWindowFocus: false,
    // NFU6, and round 505 finding #2. The app-wide default is `retry: 2` with
    // exponential backoff (app/Providers.tsx) — on this query that means a
    // dead API keeps the LAST GOOD TREE on screen, unmarked, for ~8s while
    // react-query retries behind it, with a running row interpolating through
    // the whole window as if the data were current. A tree presented as fresh
    // when the server has stopped answering is precisely the failure this
    // project exists to remove, and 8s is longer than the 5s poll it is
    // covering for. One failure, one honest error state, next poll in 5s.
    retry: 0,
  });

  const capabilities = useQuery<CapabilitiesResponse, Error>({
    queryKey: ["capabilities"],
    queryFn: fetchCapabilities,
    staleTime: CAPABILITIES_STALE_MS,
    gcTime: CAPABILITIES_STALE_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const caps = capabilities.data?.control_plane ?? ALL_FALSE;

  /* No count comes out of this hook on purpose: the number of dismissed IDS is
   * not the number of hidden ROWS. `flattenTeam` reports the one the label
   * needs (see FlatTeam.hiddenCount). */
  const { dismissed, dismiss, restoreAll } = useDismissals(chatId || null);

  /* ── Armed state ───────────────────────────────────────────────────────
   * `armedId` renders (as a boolean prop per row); `armedRef` is what the
   * handlers read, so they can stay dependency-free and keep one identity for
   * the life of the panel. Both are written together — the ref is not a cache
   * of the state, it is the same fact reachable from a callback that must not
   * be re-created. */
  const [armedId, setArmedId] = useState<string | null>(null);
  const armedRef = useRef<ArmedState | null>(null);

  const capsRef = useRef(caps);
  const openNodeRef = useRef(onOpenNode);
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    capsRef.current = caps;
  }, [caps]);
  useEffect(() => {
    openNodeRef.current = onOpenNode;
  }, [onOpenNode]);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  /** U17's auto-disarm. `decideXClick` treats a stale arming as expired on its
   *  own, so this timer is the VISUAL disarm — the machine stays correct in a
   *  backgrounded tab where the timer never fires. */
  useEffect(() => {
    if (armedId === null) return;
    const t = setTimeout(() => {
      armedRef.current = null;
      setArmedId(null);
    }, ARM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [armedId]);

  /* Ref-stable, empty deps — the identity handed to every memoized row must
   * not change when ChatSurface re-renders with a fresh arrow, or every row
   * re-renders and NFU2's zero-re-render hover claim dies with it. The ref
   * above is what carries the current callback through. */
  const handleOpenNode = useCallback((node: TeamNode) => {
    openNodeRef.current(node);
  }, []);

  const handleStop = useCallback((nodeId: string, settled: boolean) => {
    const decision = decideStopClick({
      nodeId,
      settled,
      canStop: capsRef.current.stop,
    });
    if (decision.action !== "stop") return;
    // GUARD (redundant with the decision above, and deliberately so — the
    // reviewer strips `disabled` in devtools and clicks).
    if (!capsRef.current.stop) return;
    // CONTRACT: engine-v2-research-lane ships POST /api/runs/:id/stop and
    // flips capabilities.control_plane.stop. Until then there is nothing to
    // call, and this file contains no fetch that could be made to fire.
  }, []);

  const handleX = useCallback((nodeId: string, settled: boolean) => {
    const nowMs = Date.now();
    const decision = decideXClick({
      nodeId,
      settled,
      armed: armedRef.current,
      nowMs,
      canTerminate: capsRef.current.terminate,
    });
    switch (decision.action) {
      case "dismiss":
        armedRef.current = null;
        setArmedId(null);
        dismissRef.current(decision.id);
        return;
      case "arm":
      case "rearm":
        // Same write for both. `rearm` is a too-fast click PUSHING THE WINDOW
        // BACK to its own clock, which is what stops a click stream from
        // accumulating 150ms of separation and firing on its own (round 505
        // finding #1). `setArmedId` with an unchanged id is a React bail-out,
        // so the visual disarm timer keeps running from the FIRST arm — it
        // disarms earlier than the ref would, which is the safe direction.
        armedRef.current = { id: decision.id, at: nowMs };
        setArmedId(decision.id);
        return;
      case "blocked":
        // The capability dead end. Says nothing to the network, and leaves the
        // arming alone — the user may still be mid-confirm.
        return;
      case "terminate":
        // GUARD (redundant, deliberate — see handleStop).
        if (!capsRef.current.terminate) return;
        armedRef.current = null;
        setArmedId(null);
        // CONTRACT: engine-v2-research-lane ships POST /api/runs/:id/terminate
        // and flips capabilities.control_plane.terminate. Unreachable today:
        // with an all-false capabilities response `decideXClick` never returns
        // this action, and no request exists to issue if it did.
        return;
    }
  }, []);

  const data = team.data;

  const { rows, hiddenCount } = useMemo(
    () => (data ? flattenTeam(data, dismissed) : NO_TEAM),
    [data, dismissed],
  );
  const responseNow = useMemo(() => (data ? responseNowMs(data) : Number.NaN), [data]);

  /* Which enrichment steps failed. Passed to rows as booleans so a degraded
   * response shows "—" (never 0) in the cells it actually touched, instead of
   * a blanket "everything is broken". */
  const degradedTime = useMemo(
    () => Boolean(data && !data.complete && data.errors.some((e) => e.scope === "working_time")),
    [data],
  );
  const degradedTasks = useMemo(
    () => Boolean(data && !data.complete && data.errors.some((e) => e.scope === "tasks")),
    [data],
  );

  const state: TeamState = team.isError
    ? "error"
    : !data
      ? "loading"
      : data.project === null
        ? "unlinked"
        : data.workers.length === 0
          ? "empty"
          : "ready";

  /* Two zones, one panel (13 §1: ChatTeamPanel = TeamTree + PlanKanban).
   * The team tree keeps `flex: 1, minHeight: 0` and therefore keeps every
   * pixel the plan zone does not claim; PlanKanban caps itself at 40% and
   * scrolls its own cards. Nothing inside the team zone moved — the row
   * list, the armed-state machine and the dismissal wiring are byte-identical
   * to round 506's reviewed version, which is the point: this is a wrapper,
   * not a restructure. */
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        data-team-panel
        data-team-state={state}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        {state === "error" ? (
          /* NFU6: the cached tree is NOT rendered next to this. Stale rows beside
           * an error read as fresh rows, which is the exact failure the whole
           * project exists to remove. */
          <div
            className="mono"
            style={{
              padding: "8px 10px",
              fontSize: 10,
              color: tokens.bleed,
              lineHeight: 1.5,
            }}
          >
            team unavailable — {team.error?.message ?? "unknown error"}
          </div>
        ) : (
          <>
            {data?.link_source === "thread_scan" && (
              <div style={{ padding: "6px 10px 0" }}>
                <span
                  data-link-marker="thread_scan"
                  className="mono"
                  title={
                    "This chat has no recorded project link; the project was " +
                    "inferred by scanning the thread for a project id (U2). " +
                    "Accurate in practice, but it is a guess, and it says so."
                  }
                  style={{ fontSize: 9, color: tokens.textMuted2, letterSpacing: "0.04em" }}
                >
                  linked heuristically
                </span>
              </div>
            )}
            {data?.link_ambiguous && (
              <div style={{ padding: "6px 10px 0" }}>
                <span
                  data-link-marker="ambiguous"
                  className="mono"
                  title={
                    "The thread scan found more than one project id — the tree " +
                    "below may belong to a different one."
                  }
                  style={{ fontSize: 9, color: tokens.warn, letterSpacing: "0.04em" }}
                >
                  linkage ambiguous
                </span>
              </div>
            )}
            {data && !data.complete && (
              <Note color={tokens.warn}>
                partial data — {data.errors.map((e) => e.scope).join(", ") || "unnamed step"}{" "}
                failed; affected cells show “—”, not 0
              </Note>
            )}
            {capabilities.isError && (
              <Note color={tokens.warn}>
                capabilities unreadable — every control stays disabled
              </Note>
            )}

            <div data-team-scroll style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {rows.map((row) => (
                <TeamRowView
                  key={row.node.id}
                  row={row}
                  responseNow={responseNow}
                  armed={armedId === row.node.id}
                  canStop={caps.stop}
                  canTerminate={caps.terminate}
                  degradedTime={degradedTime}
                  degradedTasks={degradedTasks}
                  onOpenNode={handleOpenNode}
                  onStop={handleStop}
                  onX={handleX}
                />
              ))}

              {state === "loading" && (
                <Note>{enabled ? "loading team…" : "no chat open"}</Note>
              )}
              {state === "unlinked" && <Note>no project linked to this chat</Note>}
              {state === "empty" && <Note>no agents yet</Note>}
            </div>

            {/* Driven by rows actually withheld from THIS tree, so the label
                cannot claim hidden rows that do not exist (junk in localStorage)
                nor undercount a dismissed parent's sub-agents. */}
            {hiddenCount > 0 && (
              <div style={{ padding: "4px 10px", borderTop: `1px solid ${tokens.borderDivider}` }}>
                <button
                  data-team-restore
                  type="button"
                  onClick={restoreAll}
                  title="Bring every hidden row back. Dismissing hides rows; it never deletes anything."
                  className="mono"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    fontSize: 9.5,
                    fontFamily: "inherit",
                    color: tokens.textMuted,
                    cursor: "pointer",
                  }}
                >
                  {hiddenCount} hidden · show
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <PlanKanban chatId={chatId} onOpenDoc={onOpenDoc} visible={visible} />
    </div>
  );
}

export default ChatTeamPanel;
