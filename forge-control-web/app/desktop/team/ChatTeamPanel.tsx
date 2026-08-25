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
 * `data-confirm="armed"`. Under the rules this file implements, that click arms
 * on a running row (whose X is `disabled` today — terminate is
 * capability-gated) and, since round 1873, on any row whose ✕ would take other
 * rows with it. It still dismisses in one go on a SETTLED LEAF, which is the
 * cheap reversible gesture the confirm is deliberately kept out of. So the
 * armed screenshot is reachable two ways now: strip `disabled` and click a
 * running row's X, or click the ✕ of a row that owns sub-agents and read the
 * count in `[data-team-confirm-strip]`.
 *
 * ── What ✕ costs, and where that is decided (round 1873, finding 2) ───────
 * Round 1872's tester clicked one ✕ on the manager row and hid 174 nodes — 165
 * of the 166 rows on screen — with no confirm, no undo toast, and only the
 * fleet-wide "restore all" as a way back. Three changes, none of them a dialog:
 *   1. the guard is PROPORTIONAL. `needsConfirm` in ./confirm arms any click
 *      that hides more than the row it was aimed at; a leaf still goes in one.
 *   2. the row SAYS THE NUMBER before the second click
 *      (`[data-team-confirm-strip]`, `dismissTitle`).
 *   3. the toast carries a real UNDO of exactly that gesture — `restoreMany`
 *      over the id list the server cascaded, not `restore` on the row, which
 *      would have left its 173 companions hidden.
 * The manager row is the one case the tree cannot count (its cascade reaches
 * finished runs of its project that this response never listed), so it declares
 * `widerReach`: always confirmed, and described in words instead of a number.
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
  hideToastText,
  isSpuriousActivation,
  type ArmedState,
} from "./confirm";
import { seededDismissals, useDismissals, useDismissalsLoaded } from "./dismissals";
import {
  DISMISSAL_SURFACES,
  DISMISSED_GROUP_LABEL,
  RESTORE_ALL_LABEL,
  dismissedToggleLabel,
  dismissedToggleTitle,
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
  rowsHiddenBy,
  type FlatTeam,
} from "./teamRows";
import { ResponseNowContext, TeamRowView } from "./TeamRow";
import { LiveSessionsStrip } from "./LiveSessionsStrip";
import { PlanKanban } from "./PlanKanban";
import { ResizeHandle, useResizablePanel } from "../_ui/ResizableSplit";
import {
  PLAN_FRACTION_DEFAULT,
  PLAN_FRACTION_KEY,
  PLAN_FRACTION_MAX,
  PLAN_FRACTION_MIN,
} from "./plan-split";
/** NFU3: one poll, 6s, paused whenever the panel is not visible.
 *
 *  ROUND 705 moved this out from 5s. Not because 5s was wrong on its own —
 *  phase 500 measured and committed it — but because the plan zone added a
 *  second poll to the same slot and the chat surface's TOTAL went 40 → 43-44
 *  req/min, breaking `phase600/nav-walk.cjs`'s P3 (≤ 40/min). 6s here plus 30s
 *  in ./PlanKanban.tsx puts the total back on exactly 40 while the panel's own
 *  slot drops from 16 to 12 req/min. A team tree that refreshes every 6s
 *  instead of every 5s is not a legibility loss; a surface that quietly
 *  outgrows its own committed poll ceiling is.
 *
 *  The number itself moved to `../chat/pollBudget` in round 4 of
 *  aios-console-responsiveness — unchanged, but somewhere the poll-budget
 *  check can import instead of hand-copying. */
import { TEAM_POLL_MS } from "../chat/pollBudget";

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

/**
 * True when every node in the tree is settled (nothing left running or queued).
 * Settled nodes never tick or change state (U16), so polling can back off.
 */
export function isTreeSettled(res: TeamResponse | undefined): boolean {
  if (!res || !res.manager) return false;
  const walk = (node: TeamNode): boolean => {
    if (!node.settled) return false;
    for (const sub of node.subagents ?? []) {
      if (!walk(sub)) return false;
    }
    return true;
  };
  if (!walk(res.manager)) return false;
  for (const worker of res.workers ?? []) {
    if (!walk(worker)) return false;
  }
  return true;
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
type TeamState =
  | "loading"
  | "error"
  | "empty"
  | "unlinked"
  | "ready"
  /** A project switch is in flight: the rows are the PREVIOUS project's and are
   *  dimmed, the chip the operator clicked is pressed, and the panel says so on
   *  this attribute (round 1873, finding 1). Transient by construction — the
   *  response clears it, and it is only reachable on a chat that started more
   *  than one project. */
  | "switching";

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

/* ── The draggable divider between the two zones ──────────────────────────────
 *
 * Konrad asked for this twice. The line between the team tree and the PLAN
 * board was a `borderBottom` and the board hard-capped itself at `maxHeight:
 * 40%`, so the split was a constant no gesture could reach: with a long team
 * tree the board was a four-card slit, and with two workers the board wasted
 * half the rail.
 *
 * The arithmetic lives in ./plan-split so it can be tested without a DOM.
 */

export function ChatTeamPanel({
  chatId,
  onOpenNode,
  onOpenDoc,
  visible,
}: ChatTeamPanelProps) {
  const enabled = visible && Boolean(chatId);

  /* The divider between the two zones, on the app's own splitter primitive
   * (`_ui/ResizableSplit`) rather than a second implementation of it. That
   * hook already owns pointer capture, the body cursor during a drag,
   * persist-on-release and double-click-to-reset — writing those again here
   * would have been a parallel splitter that drifts from the ones in the
   * shell. `invert` because the sized zone (PLAN) is BELOW the handle: dragging
   * up must grow it. */
  const {
    size: planFraction,
    handleProps: planHandleProps,
  } = useResizablePanel({
    storageKey: PLAN_FRACTION_KEY,
    initial: PLAN_FRACTION_DEFAULT,
    min: PLAN_FRACTION_MIN,
    max: PLAN_FRACTION_MAX,
    axis: "y",
    unit: "fraction",
    invert: true,
  });

  /* ── Which project's team, when the chat started more than one ────────────
   *
   * Round 1871, finding 3: chat `bfd1283a` owns operator-visibility (active)
   * and engine-task-graph (paused), and the panel showed the paused one's
   * seventeen workers with a nine-pixel "linkage ambiguous" as the only
   * disclosure. The server now RANKS (live before dormant, newest as the
   * tie-break) and ships every candidate; this is the other half — the
   * operator can pick.
   *
   * THE QUERY KEY DELIBERATELY DOES NOT CHANGE. `["chat-team", chatId]` is a
   * contract: `ManagerThread` subscribes to that exact entry with
   * `enabled: false` to name the transcript's comms peers without issuing a
   * request of its own. Adding the project to the key would leave that
   * subscription reading an entry nobody fills. So the override travels in a
   * ref and the switch forces a refetch — the cache entry keeps its name and
   * always holds "the team currently on screen", which is precisely what the
   * transcript wants for peer names.
   *
   * Reset on chat change: a project id from the previous chat is not one of
   * this chat's candidates and the server would 400 it. */
  const [projectOverride, setProjectOverride] = useState<string | null>(null);
  const projectOverrideRef = useRef<string | null>(null);
  projectOverrideRef.current = projectOverride;

  /* ── The switch has to ANSWER IN THE SAME FRAME (round 1873, finding 1) ────
   *
   * Round 1872's tester clicked `engine-task-graph` and waited 6,828ms — no
   * pressed state, no dimming, `data-team-state` still "ready" — then all 17
   * rows appeared at once. Two separate defects, both here:
   *
   *   1. THE REFETCH FETCHED THE OLD PROJECT. `projectOverrideRef` was assigned
   *      DURING RENDER, and `team.refetch()` was called from the click handler —
   *      i.e. before that render happened. So the queryFn read the previous
   *      value, the response was identical to what was on screen, and the switch
   *      only landed on the next 6s poll. The handler now writes the ref itself;
   *      the render-time assignment stays as the backstop for a poll that fires
   *      in between.
   *   2. NOTHING SAID IT WAS WORKING. `aria-pressed` was derived from the
   *      RESPONSE, which by definition had not arrived yet. `switchingTo` is the
   *      operator's own answer to "which one did I ask for", available in the
   *      same tick as the click, and it is what the chips and the panel state
   *      render from until the server agrees.
   *
   * It clears when the response names the project we asked for, or on an error —
   * never on a timer. A pending marker that expires while the request is still
   * in flight is the "looks dead" bug again, one layer down. */
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  useEffect(() => {
    setProjectOverride(null);
    setSwitchingTo(null);
  }, [chatId]);

  const team = useQuery<TeamResponse, Error>({
    queryKey: ["chat-team", chatId],
    queryFn: () => fetchChatTeam(chatId, projectOverrideRef.current),
    refetchInterval: (query) => (isTreeSettled(query.state.data) ? false : TEAM_POLL_MS),
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

  /* The switch is over when the server says which project it answered with — or
   * when it fails, which is not a pending state either. Both readings come from
   * the query itself; nothing here guesses. */
  useEffect(() => {
    if (switchingTo === null) return;
    if (team.isError) {
      setSwitchingTo(null);
      return;
    }
    if (team.data?.project?.id === switchingTo) setSwitchingTo(null);
  }, [switchingTo, team.data, team.isError]);

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
  const { dismissed, dismiss, restore, restoreMany, restoreAll } = useDismissals(
    chatId || null,
  );
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

  /* The tree the dismiss toast counts against — written in an EFFECT below,
   * never during render (round 1873, finding 1 was a ref assigned during render
   * and read by a handler that ran first). Effects commit before any click can
   * arrive, so the toast callback always sees the tree that was on screen when
   * the ✕ was pressed. Null until the first response: no tree, nothing to
   * count, and the toast falls back to the server's own number. */
  const treeRef = useRef<{
    data: TeamResponse;
    hiddenBy: ReadonlySet<string>;
  } | null>(null);

  const capsRef = useRef(caps);
  const openNodeRef = useRef(onOpenNode);
  const dismissRef = useRef(dismiss);
  const restoreRef = useRef(restore);
  /** The undo verb, behind the same ref discipline as the rest — the toast's
   *  button outlives the render that created it, and a stale closure over a
   *  react-query mutation is how an undo silently stops working. */
  const restoreManyRef = useRef(restoreMany);
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
  useEffect(() => {
    restoreManyRef.current = restoreMany;
  }, [restoreMany]);

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

  /* ── Changing your mind (round 1874, finding 3) ───────────────────────────
   *
   * "Pressed Escape — still `armed`. Clicked in the transcript — still `armed`.
   * Only a 3.09s timer disarms it. The gesture is safe … but a customer who
   * wants out has no way to say so."
   *
   * Escape, and a pointer landing anywhere that is not a ✕. Both listeners
   * exist ONLY while something is armed — this is not a permanent document
   * listener on a surface whose hover cost is the project's DoD 3 — and both
   * are capture-phase so nothing can stop them on the way down.
   *
   * A pointerdown ON a ✕ is left alone deliberately: that click is a decision
   * the machine already reads correctly. The same ✕ confirms; a different row's
   * ✕ moves the arming (`decideXClick` rule 2), which is the disarm anyway.
   * Disarming here first would make the second case take three clicks.
   *
   * `CANCEL_HINT` in ./confirm is the sentence the armed strip prints, so the
   * affordance is stated rather than left to be discovered. */
  useEffect(() => {
    if (armedId === null) return;
    const disarm = () => {
      armedRef.current = null;
      setArmedId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarm();
    };
    const onPointer = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-team-x]")) return;
      disarm();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [armedId]);

  /** The restore-all confirm's own auto-disarm, the twin of `armedId`'s above
   *  and for the same reason: `decideRestoreAllClick` treats a stale arming as
   *  expired on its own, so this timer is only the VISUAL disarm. */
  useEffect(() => {
    if (restoreAllArmedAt === null) return;
    const t = setTimeout(() => setRestoreAllArmedAt(null), ARM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [restoreAllArmedAt]);

  /** …and the same way out. An armed control the operator cannot call off is
   *  the same finding whichever control it is (round 1874, finding 3), and
   *  restore-all is the one that destroys state nothing can rebuild. */
  useEffect(() => {
    if (restoreAllArmedAt === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRestoreAllArmedAt(null);
    };
    const onPointer = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-team-restore-all]")) return;
      setRestoreAllArmedAt(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
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

  const handleX = useCallback(
    (nodeId: string, settled: boolean, hidesRows: number, widerReach: boolean) => {
      const nowMs = Date.now();
      const decision = decideXClick({
        nodeId,
        settled,
        /* An operator row's cascade reaches its whole project, including finished
         * runs this tree never listed, so the count it carries is a floor. Passing
         * the floor here would let a 1-row operator chat dismiss on a single click;
         * `MAX_SAFE_INTEGER` says "more than one, and unknown", which is the truth
         * and lands on the confirm. The WORDS come from `widerReach` (TeamRow's
         * `scope`), which is why both travel. */
        hidesRows: widerReach ? Number.MAX_SAFE_INTEGER : hidesRows,
        armed: armedRef.current,
        nowMs,
        canTerminate: capsRef.current.terminate,
      });
      switch (decision.action) {
        case "dismiss":
          armedRef.current = null;
          setArmedId(null);
          /* Round 1873, finding 2 — THE UNDO.
           *
           * Round 1871 answered "one click, no confirm" with a toast naming the
           * footer control. Round 1872's tester then lost 165 of 166 rows to one
           * click and found that footer control could only give them back by
           * wiping every dismissal on the machine. Two things changed:
           *
           *   · a click that hides more than its own row now has to be confirmed
           *     (`decideXClick`, and the strip in TeamRow says how many);
           *   · the toast carries a REAL undo of exactly this gesture, built from
           *     the id list the server cascaded — `restoreMany`, not `restore`,
           *     because restoring the clicked row alone would leave its
           *     descendants hidden.
           *
           * The toast is raised from the callback rather than here, so it names
           * the count the SERVER hid rather than the count we predicted, and so
           * the undo button cannot exist before the ids it would restore do. */
          /* TWO NUMBERS, BOTH TRUE (round 1874, finding 2). `ids` is the
           * server's cascade — fleet-wide, and exactly what "undo" restores.
           * `rowsHiddenBy` is what THIS tree lost, computed by the same walk
           * the "N dismissed · show" tray counts with, so the toast and the
           * tray can no longer report one gesture as two numbers with nothing
           * to reconcile them.
           *
           * SNAPSHOTTED HERE, not read in the callback. `useDismissals` hides
           * the row OPTIMISTICALLY, so by the time the server answers the ref
           * already holds a tree with this id hidden and the difference is
           * zero — measured: the toast said "180 rows hidden — all of them
           * elsewhere in the fleet" beside a tray that had just grown by one.
           * The click handler runs before that optimistic write; this is the
           * tree the operator was looking at when they pressed ✕. */
          const before = treeRef.current;
          dismissRef.current(decision.id, (ids) => {
            const here =
              before === null
                ? ids.length
                : rowsHiddenBy(before.data, before.hiddenBy, ids);
            toast(
              hideToastText({ hidden: ids.length, here }),
              "info",
              undefined,
              {
                action: { label: "undo", onClick: () => restoreManyRef.current(ids) },
                /* Long enough to notice 165 rows leaving and reach for the undo;
                   the peek below is the durable way back after that. */
                ttlMs: 12_000,
              },
            );
          });
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
    },
    [],
  );

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

  useEffect(() => {
    treeRef.current = data ? { data, hiddenBy } : null;
  }, [data, hiddenBy]);

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

  /** What the tree ON SCREEN is. Drives the notes below — a switch must not
   *  turn "no project linked" into a spinner. */
  const dataState: TeamState = team.isError
    ? "error"
    : !data
      ? "loading"
      : data.project === null
        ? "unlinked"
        : data.workers.length === 0
          ? "empty"
          : "ready";

  /** What the PANEL is doing, which is what `data-team-state` reports. A switch
   *  in flight is its own state: the rows below still belong to the previous
   *  project and saying "ready" over them was finding 1's silence. */
  const state: TeamState = switchingTo !== null && !team.isError ? "switching" : dataState;

  /* Two zones, one panel (13 §1: ChatTeamPanel = TeamTree + PlanKanban).
   * The team tree keeps `flex: 1, minHeight: 0` and therefore keeps every
   * pixel the plan zone does not claim; PlanKanban caps itself at 40% and
   * scrolls its own cards. Nothing inside the team zone moved — the row
   * list, the armed-state machine and the dismissal wiring are byte-identical
   * to round 506's reviewed version, which is the point: this is a wrapper,
   * not a restructure. */
  return (
    /* This element is the handle's parent, which is what `useResizablePanel`
       measures at grab time to turn pointer pixels into a fraction. */
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        data-team-panel
        data-team-state={state}
        style={{
          display: "flex",
          flexDirection: "column",
          // `1 1 0` not `1`: the tree takes whatever the PLAN zone's
          // flex-basis leaves, and shrinks below its content instead of
          // pushing the splitter off the bottom on a long org chart.
          flex: "1 1 0",
          minHeight: 0,
          // The dividing line now belongs to the splitter below, which is the
          // thing you can actually grab.
        }}
      >
        {dataState === "error" ? (
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
            {/* ROUND 1871, finding 3. This used to be a nine-pixel
                "linkage ambiguous" and nothing else — a confession with no
                remedy, beside seventeen workers belonging to a project the
                reader had not asked for. A chat that started two projects
                gets a real choice instead. One project: nothing renders, as
                before. */}
            {(data?.candidates?.length ?? 0) > 1 && (
              /* DENSITY (round 1875). The manager chat had 29 candidates when
                 this was measured, and a wrapped row of that many chips is
                 about ten lines — some 200px of a 260px panel given to a
                 control nobody uses twice a day, with the tree pushed under
                 the fold. It now caps at roughly three rows and scrolls, which
                 changes nothing about what it offers and returns the panel to
                 the rows. */
              <div
                data-project-switcher
                style={{
                  padding: "6px 10px",
                  borderBottom: `1px solid ${tokens.borderDivider}`,
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 4,
                  maxHeight: 62,
                  overflowY: "auto",
                }}
              >
                <span
                  className="mono"
                  title={
                    "This chat started more than one project. The panel opens on " +
                    "the liveliest one; pick another to see its team and its board."
                  }
                  style={{
                    /* One type scale for every zone label in this panel:
                       PROJECT · LIVE SESSIONS · TEAM · PLAN all read at 9px /
                       0.1em / textFaint. This one was 0.08em. */
                    fontSize: 9,
                    color: tokens.textFaint,
                    letterSpacing: "0.1em",
                    marginRight: 2,
                  }}
                >
                  PROJECT
                </span>
                {data?.candidates?.map((p) => {
                  /* WHAT THE OPERATOR ASKED FOR, not what has arrived: the chip
                     goes pressed in the tick of the click and stays pressed while
                     the fetch runs. `switchingTo` is cleared by the response, so
                     a server that ranks differently than we asked still has the
                     last word — it just does not get to leave the button looking
                     unclicked for six seconds first. */
                  const on = p.id === (switchingTo ?? data.project?.id);
                  const pending = switchingTo === p.id;
                  return (
                    <button
                      key={p.id}
                      data-project-choice={p.id}
                      data-project-pending={pending ? "true" : undefined}
                      aria-pressed={on}
                      aria-busy={pending || undefined}
                      title={`${p.name ?? p.id} — ${p.status} · ${p.id}`}
                      onClick={() => {
                        if (on) return;
                        /* THE REF FIRST, and from the handler rather than from
                           the next render: `queryFn` reads it, and `refetch()`
                           below reads it before React has re-rendered. This one
                           line is finding 1's actual bug — without it the switch
                           refetched the project already on screen and the new one
                           arrived on the next 6s poll. */
                        projectOverrideRef.current = p.id;
                        setProjectOverride(p.id);
                        setSwitchingTo(p.id);
                        /* The key is unchanged by design (see the query
                           above), so the switch has to ask for the refetch
                           itself. Awaiting is pointless — `switchingTo` is the
                           pending state and the response clears it. */
                        void team.refetch();
                      }}
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        maxWidth: 150,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: on ? tokens.accent : tokens.textMuted,
                        background: on ? tokens.primaryActionBg : "transparent",
                        border: `1px solid ${on ? tokens.accent : tokens.border}`,
                        borderRadius: 5,
                        padding: "2px 7px",
                        cursor: on ? "default" : "pointer",
                      }}
                    >
                      {p.name ?? p.id.slice(0, 8)}
                      <span style={{ color: tokens.textFaint }}>
                        {" "}
                        · {pending ? "loading…" : p.status}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {/* Kept for the case the switcher cannot serve: a scan that found
                several ids of which only one survived validation still says
                the link was contested. */}
            {data?.link_ambiguous && (data.candidates?.length ?? 0) <= 1 && (
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

            {/* The rows below this line belong to the project we are LEAVING.
                Saying so costs one muted line and is the difference between a
                switch that is working and a button that looks broken. */}
            {switchingTo !== null && (
              <Note>
                switching to{" "}
                {data?.candidates?.find((p) => p.id === switchingTo)?.name ??
                  switchingTo.slice(0, 8)}
                … — the rows below are still the previous project’s
              </Note>
            )}

            {/* ── LIVE SESSIONS, pinned above the tree ─────────────────────
                Konrad: "I need to see the claude/agy/codex sessions doing
                work." One row per non-settled node — engine, model, task,
                what it is doing right now, elapsed — out of the SAME response
                the tree below renders from. It issues no request of its own;
                the surface's 40 req/min ceiling (../chat/pollBudget) is
                untouched.

                Outside `data-team-scroll` on purpose: it is the answer to
                "what is happening", and an answer you have to scroll back up
                to find is not pinned. It bounds its own height and scrolls
                internally past five rows, so a busy project cannot push the
                tree off the panel.

                It renders for an UNLINKED chat too — the manager row is a
                live Claude session whether or not a project claims the chat,
                and that is exactly the row Konrad is looking for there. */}
            <LiveSessionsStrip data={data} onOpenNode={handleOpenNode} />

            {/* The tree keeps its own name now that something sits above it.
                Three labelled zones — LIVE SESSIONS · TEAM · PLAN — in one
                type scale and one padding, so the panel reads as a stack of
                answers rather than as a wall of rows. */}
            <div
              data-team-header
              style={{
                flex: "none",
                padding: "6px 10px 4px",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
              }}
            >
              <span
                className="mono"
                title={
                  "Every agent this chat's project has run, settled ones " +
                  "included, as an org chart. The live ones are also listed " +
                  "above."
                }
                style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.1em" }}
              >
                TEAM
              </span>
              <span style={{ flex: 1 }} />
              <span
                data-team-row-count={rows.length}
                className="mono"
                title="rows on this tree, dismissed ones excluded"
                style={{
                  fontSize: 9.5,
                  color: rows.length > 0 ? tokens.textMuted : tokens.textGhost,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {rows.length}
              </span>
            </div>

            <div
              data-team-scroll
              aria-busy={switchingTo !== null || undefined}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                /* Dimmed, not emptied: the previous tree is still true until the
                   response lands, and blanking it would trade one silence for
                   another. Pointer events stay ON — a click that opens a worker
                   of the project you are leaving still opens that worker. */
                ...(switchingTo !== null ? { opacity: 0.45 } : {}),
              }}
            >
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

              {dataState === "loading" && (
                <Note>{enabled ? "loading team…" : "no chat open"}</Note>
              )}
              {dataState === "unlinked" && <Note>no project linked to this chat</Note>}
              {dataState === "empty" && <Note>no agents yet</Note>}

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
                  /* The OTHER surface: this IS the chat team panel, so the
                     sentence names /live. */
                  title={dismissedToggleTitle(DISMISSAL_SURFACES.live)}
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
      {/* The board follows the switcher above. `data.project.id` rather than
          `projectOverride`: the server had the last word on which project this
          is (it validates the override and ranks the default), and the two
          zones must agree with the SERVER, not with each other. */}
      <ResizeHandle {...planHandleProps} title="Drag to resize the plan panel · double-click to reset" />
      <div
        style={{
          // flex-basis as a percentage of the shell resolves against a definite
          // main size here (the shell is `flex: 1` in a column with
          // `minHeight: 0`), so this is the zone's real height. `0 0` pins it:
          // only the splitter changes it.
          flex: `0 0 ${(planFraction * 100).toFixed(3)}%`,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <PlanKanban
          chatId={chatId}
          onOpenDoc={onOpenDoc}
          visible={visible}
          fill
          projectId={data?.project?.id ?? null}
        />
      </div>
    </div>
  );
}

export default ChatTeamPanel;
