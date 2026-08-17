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
 *   • dismissals, via ./dismissals — server-backed and GLOBAL since round 1350
 *     (`ui_dismissals`); the panel still hides the dismissed node's whole
 *     subtree locally so the gesture lands in one frame
 *   • `peek` — one boolean for the whole panel, not a flag per row, so
 *     revealing the DISMISSED group costs one render of the list and nothing
 *     on hover
 *
 * ── The way back, and why it is three controls (round 1354 review, A4) ────
 * Until round 1355 the footer held ONE control, labelled "N hidden · show",
 * whose onClick was `restoreAll` — `DELETE /api/agents/dismissals`, every
 * dismissal on the machine. Round 1350 had just widened dismissals from a
 * per-chat localStorage key to a global table, so a label promising to reveal
 * this panel's hidden rows now wiped the Live panel's too. The reviewer clicked
 * it and lost eleven unrelated dismissals.
 *
 * The affordance is now the /live one (AgentActivity.tsx), sharing its words
 * through ./peek:
 *   1. "N dismissed · show" TOGGLES a peek. It writes nothing.
 *   2. Each peeked row carries its own ↺ — the way back is per row, because
 *      the way out was.
 *   3. "restore all" is a separate control, visible only while peeking, which
 *      names the global count it will delete and takes two clicks
 *      (`decideRestoreAllClick` in ./confirm).
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  ARM_WINDOW_MS,
  SETTLED_STOP_TITLE,
  capabilityTitle,
  decideRestoreAllClick,
  decideStopClick,
  decideXClick,
  isSpuriousActivation,
  type ArmedState,
} from "./confirm";
import { seededDismissals, useDismissals, useDismissalsLoaded } from "./dismissals";
import {
  DISMISSED_GROUP_LABEL,
  DISMISSED_TOGGLE_TITLE,
  RESTORE_ALL_LABEL,
  dismissedToggleLabel,
  restoreAllArmedLabel,
  restoreAllTitle,
} from "./peek";
import {
  fetchCapabilities,
  fetchChatTeam,
  postRunStop,
  postRunTerminate,
  type CapabilitiesResponse,
  type TeamNode,
  type TeamResponse,
} from "./teamApi";
import { toast, toastError } from "../_ui/Toasts";
import {
  createTeamRowCache,
  flattenTeam,
  responseNowMs,
  type FlatTeam,
} from "./teamRows";
import { ResponseNowContext, TeamRowView } from "./TeamRow";
import { PlanKanban } from "./PlanKanban";

/** NFU3: one poll, 6s, paused whenever the panel is not visible.
 *
 *  ROUND 705 moved this out from 5s. Not because 5s was wrong on its own —
 *  phase 500 measured and committed it — but because the plan zone added a
 *  second poll to the same slot and the chat surface's TOTAL went 40 → 43-44
 *  req/min, breaking `phase600/nav-walk.cjs`'s P3 (≤ 40/min). 6s here plus 30s
 *  in ./PlanKanban.tsx puts the total back on exactly 40 while the panel's own
 *  slot drops from 16 to 12 req/min. A team tree that refreshes every 6s
 *  instead of every 5s is not a legibility loss; a surface that quietly
 *  outgrows its own committed poll ceiling is. */
const TEAM_POLL_MS = 6_000;

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
const NO_TEAM: FlatTeam = { rows: [], hiddenCount: 0, hiddenRows: [] };

/** Nothing flagged — one frozen array, so the seed memo below keeps its
 *  identity on every poll of a tree with no dismissals in it. */
const NO_PAYLOAD_DISMISSALS: readonly string[] = [];

/** The node ids this RESPONSE says are hidden (`dismissed_at`), sub-agents
 *  included.
 *
 *  It is a SEED, not the authority: `GET /api/agents/dismissals` is, because
 *  it is the only source that also knows about ids outside this tree and that
 *  a restore just happened. Reading the payload after that GET has landed
 *  would re-hide a row for up to one 6s poll after "show" un-hid it — see
 *  `seededDismissals`, which is where the switch-over lives. */
function payloadDismissedIds(res: TeamResponse | undefined): readonly string[] {
  if (!res) return NO_PAYLOAD_DISMISSALS;
  const ids: string[] = [];
  const walk = (node: TeamNode): void => {
    if (node.dismissed_at !== null) ids.push(node.id);
    for (const sub of node.subagents) walk(sub);
  };
  walk(res.manager);
  for (const worker of res.workers) walk(worker);
  return ids.length > 0 ? ids : NO_PAYLOAD_DISMISSALS;
}

/** The footer controls — the peek toggle and, beside it, restore-all. Shared so
 *  the two read as one row of quiet text rather than as a button and a link,
 *  and so `color` is the only thing either of them varies. `nowrap` because
 *  restore-all's armed label is longer than its idle one and a 260px panel
 *  would otherwise wrap it mid-gesture. */
const FOOTER_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: 9.5,
  fontFamily: "inherit",
  color: tokens.textMuted,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

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
    // project exists to remove, and 8s is longer than the 6s poll it is
    // covering for. One failure, one honest error state, next poll in 6s.
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
   * needs (see FlatTeam.hiddenCount).
   *
   * `chatId` is passed for the call site's sake only — dismissals are global
   * since round 1350 and the hook does not read it. */
  const { dismissed, dismiss, restore, restoreAll } = useDismissals(chatId || null);
  const dismissalsLoaded = useDismissalsLoaded();

  /** Is the DISMISSED group open? Panel state, one boolean — see the header. */
  const [peek, setPeek] = useState(false);

  /** `Date.now()` at the first click on "restore all", or null. A value rather
   *  than a boolean because `decideRestoreAllClick` needs the clock to refuse a
   *  stream of fast clicks; the render only reads whether it is null. */
  const [restoreAllArmedAt, setRestoreAllArmedAt] = useState<number | null>(null);

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
  const restoreRef = useRef(restore);
  useEffect(() => {
    capsRef.current = caps;
  }, [caps]);
  useEffect(() => {
    openNodeRef.current = onOpenNode;
  }, [onOpenNode]);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);
  useEffect(() => {
    restoreRef.current = restore;
  }, [restore]);

  /* The team query's own refetch, reachable from the two dependency-free
   * handlers below. Same ref discipline as `capsRef`/`openNodeRef` above and
   * for the same reason: a `team` (or a queryClient) in those dep arrays gives
   * `handleStop`/`handleX` a new identity on every poll, every memo(TeamRowView)
   * bails out no longer, and NFU2's zero-re-render hover claim dies with it. */
  const refetchTeamRef = useRef(team.refetch);
  useEffect(() => {
    refetchTeamRef.current = team.refetch;
  }, [team.refetch]);

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

  /** The restore-all confirm's own auto-disarm, the twin of `armedId`'s above
   *  and for the same reason: `decideRestoreAllClick` treats a stale arming as
   *  expired on its own, so this timer is only the VISUAL disarm. */
  useEffect(() => {
    if (restoreAllArmedAt === null) return;
    const t = setTimeout(() => setRestoreAllArmedAt(null), ARM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [restoreAllArmedAt]);

  /* Closing the peek disarms it. An armed "sure?" left behind a collapsed group
   * would be a loaded control the operator can no longer see the consequences
   * of — and the whole point of putting restore-all inside the peek is that it
   * is only reachable while what it destroys is on screen. */
  useEffect(() => {
    if (!peek) setRestoreAllArmedAt(null);
  }, [peek]);

  /* Ref-stable, empty deps — the identity handed to every memoized row must
   * not change when ChatSurface re-renders with a fresh arrow, or every row
   * re-renders and NFU2's zero-re-render hover claim dies with it. The ref
   * above is what carries the current callback through. */
  const handleOpenNode = useCallback((node: TeamNode) => {
    openNodeRef.current(node);
  }, []);

  /** One row back. Same ref discipline as the rest — peeked rows are memoized
   *  `TeamRowView`s too. */
  const handleRestore = useCallback((nodeId: string) => {
    restoreRef.current(nodeId);
  }, []);

  const handleStop = useCallback((nodeId: string, settled: boolean) => {
    const decision = decideStopClick({
      nodeId,
      settled,
      canStop: capsRef.current.stop,
    });
    if (decision.action !== "stop") {
      /* The button is disabled for both blocked reasons (`stopBlockReason` in
       * confirm.ts drives `disabled` off this very decision), so a pointer
       * cannot get here. A reviewer who strips `disabled` in devtools CAN —
       * and dropping their click on the floor is the silent no-op NFU6
       * forbids, at one remove. It says why instead. */
      toast(
        decision.reason === "settled"
          ? SETTLED_STOP_TITLE
          : capabilityTitle("stop"),
        "info",
      );
      return;
    }
    // GUARD (redundant with the decision above, and deliberately so — the
    // reviewer strips `disabled` in devtools and clicks).
    if (!capsRef.current.stop) return;
    /* The 202 is reflected as AN IMMEDIATE REFETCH of the team query, not as a
     * per-row pending ghost. That is a DECISION, not an omission: a pending
     * flag would have to reach the row as a new prop, and a changing prop is
     * exactly what stops `memo(TeamRowView)` from bailing out — the bail-out
     * round 1302 measured is what makes hovering 108 rows cost zero renders.
     * The engine moves the row to `paused` within one 6s poll anyway; this
     * refetch just fetches that poll now. Do not "improve" it into row state.
     *
     * The catch is the only place the operator learns the verb was refused:
     * `postRunStop` throws the engine's own reason string (409 "run is already
     * cancelled", 404 "unknown run") and the toast prints it verbatim. */
    void postRunStop(nodeId)
      .then(() => {
        toast(`stop sent — ${nodeId.slice(0, 8)}`, "ok");
        void refetchTeamRef.current();
      })
      .catch((e: unknown) => toastError("Stop failed", e));
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
        /* Refetch, not a per-row pending flag — the same decision as
         * `handleStop` above, taken for the same memo-bail-out reason; the
         * long form is written out there.
         *
         * LIVE since round 1353 (8ec83cc flipped `terminate` in
         * capabilities.ts): this path is reached whenever the engine answers
         * `terminate:true`, and it was driven end to end in a browser —
         * armed ✕, confirmed, 202 `{"terminating":true}`. It stays
         * capability-gated on that flag, so an engine that withdraws it puts
         * the row straight back to a disabled button with a stated reason. */
        void postRunTerminate(decision.id)
          .then(() => {
            toast(`terminate sent — ${decision.id.slice(0, 8)}`, "ok");
            void refetchTeamRef.current();
          })
          .catch((e: unknown) => toastError("Terminate failed", e));
        return;
    }
  }, []);

  const data = team.data;

  /* The wrapper cache that makes `memo(TeamRowView)` able to bail out (round
   * 1302, L1). One per mounted panel, in a ref rather than in module scope so
   * two panels — or a remount — never share or inherit each other's rows.
   *
   * `useMemo` may legitimately re-run for reasons other than a new response
   * (a changed `dismissed` set, a Strict Mode double-invoke). Feeding the same
   * cache is correct in every one of those cases: an unchanged node yields the
   * previous wrapper, so re-running the memo is idempotent rather than a
   * silent 108-row re-render. */
  const rowCache = useRef(createTeamRowCache());

  /* The set the tree is actually hidden by: the server's, seeded from this
   * response's own `dismissed_at` flags until the GET has answered. Once it
   * has, `seededDismissals` returns `dismissed` UNCHANGED — same object — so
   * this memo stops producing new sets and `flattenTeam` keeps handing back
   * the cached row wrappers that let `memo(TeamRowView)` bail out. */
  const payloadDismissed = useMemo(() => payloadDismissedIds(data), [data]);
  const hiddenBy = useMemo(
    () => seededDismissals(dismissalsLoaded, dismissed, payloadDismissed),
    [dismissalsLoaded, dismissed, payloadDismissed],
  );

  const { rows, hiddenCount, hiddenRows } = useMemo(
    () => (data ? flattenTeam(data, hiddenBy, rowCache.current) : NO_TEAM),
    [data, hiddenBy],
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
              {/* The response clock reaches the live rows' time cells THROUGH
                  this provider, never as a row prop (round 1302, L1). It is a
                  new number every poll; as a prop it re-rendered all 108 rows
                  to move the two that are running. React delivers a context
                  change to its consumers even where `memo` bailed the row out,
                  so the routing is exact: `LiveTime` re-renders, its row does
                  not. */}
              <ResponseNowContext.Provider value={responseNow}>
                {rows.map((row) => (
                  <TeamRowView
                    key={row.node.id}
                    row={row}
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

              {/* The peek. Below everything, behind its own heading, visibly
                  quieter: these rows ARE hidden and the panel says so rather
                  than mixing them back into the tree. `hiddenRows` comes out of
                  the same walk that produced `hiddenCount`, so the list and the
                  label cannot disagree — and each row carries its own way back
                  (or, for a row hidden with its parent, says so). */}
              {peek && hiddenRows.length > 0 && (
                <>
                  <div
                    data-team-dismissed-group
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: tokens.textGhost,
                      letterSpacing: "0.08em",
                      padding: "10px 8px 4px",
                    }}
                  >
                    {DISMISSED_GROUP_LABEL}
                  </div>
                  {hiddenRows.map((hidden) => (
                    <TeamRowView
                      key={hidden.row.node.id}
                      row={hidden.row}
                      armed={false}
                      canStop={caps.stop}
                      canTerminate={caps.terminate}
                      degradedTime={degradedTime}
                      degradedTasks={degradedTasks}
                      onOpenNode={handleOpenNode}
                      onStop={handleStop}
                      onX={handleX}
                      peeked
                      restorable={hidden.restorable}
                      onRestore={handleRestore}
                    />
                  ))}
                </>
              )}
              </ResponseNowContext.Provider>
            </div>

            {/* Driven by rows actually withheld from THIS tree, so the label
                cannot claim hidden rows that do not exist (the dismissal set
                is global and holds ids from every project) nor undercount a
                dismissed parent's sub-agents. */}
            {hiddenCount > 0 && (
              <div
                style={{
                  padding: "4px 10px",
                  borderTop: `1px solid ${tokens.borderDivider}`,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                }}
              >
                <button
                  data-team-dismissed-toggle
                  type="button"
                  onClick={() => setPeek((v) => !v)}
                  title={DISMISSED_TOGGLE_TITLE}
                  className="mono"
                  style={FOOTER_BTN_STYLE}
                >
                  {dismissedToggleLabel(hiddenCount, peek)}
                </button>
                {/* Only while peeking, so it cannot be reached without the
                    rows it affects being on screen — and only when the server
                    set has actually been read, because the count it names comes
                    from that set. Two clicks: `decideRestoreAllClick`. */}
                {peek && dismissed.size > 0 && (
                  <button
                    data-team-restore-all
                    data-confirm={restoreAllArmedAt === null ? "idle" : "armed"}
                    type="button"
                    onClick={() => {
                      const nowMs = Date.now();
                      const decision = decideRestoreAllClick({
                        armedAt: restoreAllArmedAt,
                        nowMs,
                      });
                      switch (decision.action) {
                        case "arm":
                        case "rearm":
                          // One write for both, exactly as the ✕ machine does
                          // it: a `rearm` pushes the window back to THIS click
                          // so a click stream can never confirm itself.
                          setRestoreAllArmedAt(nowMs);
                          return;
                        case "restore-all":
                          setRestoreAllArmedAt(null);
                          restoreAll();
                          return;
                      }
                    }}
                    onKeyDown={(e) => {
                      if (isSpuriousActivation({ detail: 0, repeat: e.repeat })) {
                        e.preventDefault();
                      }
                    }}
                    title={restoreAllTitle(dismissed.size)}
                    className="mono"
                    style={{
                      ...FOOTER_BTN_STYLE,
                      color: restoreAllArmedAt === null ? tokens.textGhost : tokens.bleed,
                    }}
                  >
                    {restoreAllArmedAt === null
                      ? RESTORE_ALL_LABEL
                      : restoreAllArmedLabel(dismissed.size)}
                  </button>
                )}
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
