"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchChatList,
  fetchChat,
  fetchChatLinkage,
  createChat,
  sendChatMessage,
  setChatStatus,
  resumeChat,
  archiveChat,
  archiveAllChats,
  searchChats,
  freezeFleet,
  resumeFleet,
  vaultAppend,
  vaultCreateNote,
  createReminder,
  setChatModel,
  setChatEffort,
  ENGINE_MODEL_CHOICES,
  ENGINE_EFFORT_CHOICES,
  DEFAULT_ENGINE_MODEL,
  fetchAutonomy,
  updateRule,
  fetchSecrets,
  attachmentsBlock,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type ChatLinkage,
  type SecretMeta,
} from "../api";
import { useAttachments, AttachmentChips, HiddenFileInput } from "./chat/useAttachments";
import { useAutogrow } from "./chat/useAutogrow";
import { effortRamp } from "./chat/effort-ramp";
import { FileExplorerPanel } from "./chat/FileExplorerPanel";
import { SlashPopover, type SlashPopoverHandle } from "./chat/SlashPopover";
import {
  findSlash,
  parseSlash,
  type SlashContext,
  type SlashDirective,
  type SurfaceKey,
} from "./chat/slash-registry";
import { ChatTeamPanel } from "./team/ChatTeamPanel";
import type { TeamNode } from "./team/teamApi";
import { AssistantThread } from "./chat/AssistantThread";
import { AgentChatView } from "./chat/AgentChatView";
import { PlanDocView } from "./chat/PlanDocView";
import {
  crumbs,
  frameKey,
  push,
  pop,
  reset,
  top,
  type NavFrame,
  type NavStack,
} from "./chat/nav-stack";
import { CanvasPane } from "./CanvasPane";
import { SecretField } from "./chat/SecretField";
import {
  autoOpenTarget,
  pendingRequests,
  type SecretRequest,
} from "./chat/secret-requests";
import { secretsPollInterval, subscribeSecretRequests } from "./chat/secretLive";
import { useRunEvents } from "./chat/useRunEvents";
import {
  ResizeHandle,
  useResizablePanel,
  usePersistentState,
  isBool,
} from "./_ui/ResizableSplit";
import { toastError } from "./_ui/Toasts";
import { ErrorPanel, errorDetail } from "./_ui/SurfaceErrorBoundary";

/* ---------------------------------------------------------------------------
 * U30 — the two-way secret sharer's composer-side wiring.
 *
 * ROUND 808: THE POLL IS GONE. Phase 800 spent 1 req/min on a 60s poll of
 * `GET /api/secrets` and had to buy it back by slowing the chat-list poll,
 * because the surface sits at 39/min against phase 600's ≤40 ceiling
 * (`nav-walk.cjs:310`). It also made Konrad wait up to a minute for a panel he
 * asked to open the moment an agent asks. Both are fixed by the same move
 * `canvas.ts` already made for the drawing pane: the server pushes.
 *
 * What is left of the poll is a FALLBACK that runs only while the stream is
 * down (`secretsPollInterval`, in secretLive.ts). Live cost: one connection,
 * zero requests per minute. Do not reintroduce an unconditional interval here
 * without re-running phase 600's nav-walk and phase 700's network gate.
 * -------------------------------------------------------------------------*/

/** How many pending names the secret button's tooltip spells out before it
 *  summarises. Six is already more than has ever been pending at once; the cap
 *  exists so a stuck agent raising requests in a loop can't grow a tooltip
 *  without bound. */
const PENDING_NAMES_IN_TITLE = 6;

/** Stable empty list so `pendingRequests`/`autoOpenTarget` see the same
 *  reference across renders and the memo below doesn't recompute for nothing. */
const NO_SECRETS: readonly SecretMeta[] = [];

/**
 * Names Konrad has waved away this SESSION.
 *
 * Module-level on purpose. `ChatThread` is keyed by run id so it remounts on
 * every chat switch, and DesktopApp unmounts the whole surface on every nav
 * click — component state would therefore forget the dismissal and re-open the
 * same panel the moment he came back, which is the "hostile auto-open" this
 * requirement exists to prevent.
 *
 * LIFETIME: until the page reloads. Nothing is persisted, deliberately — a
 * dismissal is a "not right now", not a decision worth surviving a reload, and
 * the request itself stays pending on the server either way. After a reload the
 * panel offers it again, which is correct: the agent is still waiting.
 *
 * It holds NAMES ONLY. No note, no value, nothing an agent wrote.
 */
const dismissedSecretRequests = new Set<string>();

const STATUS_COLOR: Record<RunStatus, string> = {
  queued: tokens.textMuted,
  running: tokens.accent,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

function humanAge(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Collapsible right-hand panel with two tabs: Team (this chat's org chart) and
 *  Files (VPS explorer). Owns collapse state; each tab's body is a plain
 *  component with no chrome of its own.
 *
 *  U14 — the Team tab is ONE panel. Until round 503 it was a 55/45 split of
 *  the fleet-activity list over the project board (see git 8e6b243^): two
 *  components, two polls (`/api/agents` every 4s, `/api/projects/board` every
 *  6s), two half-answers to the same question — the board showed tasks with no
 *  agents, the list showed agents with no tasks. `ChatTeamPanel` answers it
 *  once, from one request, scoped to the open chat. The fleet list itself is
 *  NOT deleted: it is still the whole-fleet surface on /live (13 §1) and only
 *  loses this slot. The board query still belongs to ProjectsSurface. */
function SidePanel({
  collapsed,
  onToggle,
  tab,
  onTab,
  onOpenNode,
  onOpenDoc,
  fileAtt,
  chatId,
}: {
  collapsed: boolean;
  onToggle: () => void;
  tab: "team" | "files";
  onTab: (t: "team" | "files") => void;
  onOpenNode: (node: TeamNode) => void;
  onOpenDoc: (name: string) => void;
  fileAtt: ReturnType<typeof useAttachments> | null;
  /** The OPEN chat (U14: no selector of the panel's own — the chat decides what
   *  the panel shows). `null` = nothing open, so there is no team to fetch. */
  chatId: string | null;
}) {
  // Per-tab width: Files needs the room for a path column, Live doesn't.
  // Both remembered separately, both draggable, double-click restores the
  // designed default.
  const panel = useResizablePanel({
    storageKey: `forge.layout.chat.sidePanel.${tab}`,
    initial: tab === "files" ? 420 : 260,
    min: 200,
    max: 760,
    // Handle sits on the panel's left edge: dragging left must widen it.
    invert: true,
  });
  // main's `liveSplit` (forge.layout.chat.agentsBoard) divided the old two-zone
  // Live panel — AgentActivity over LiveProjectsBody. Phase 700 replaced both
  // zones with the single full-height ChatTeamPanel, so there is no longer a
  // divider to drag and the hook is gone with it. The stale localStorage key is
  // simply never read again; nothing migrates it.

  if (collapsed) {
    return (
      <div
        style={{
          width: 34,
          flex: "none",
          borderLeft: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          paddingTop: 12,
        }}
      >
        <button
          onClick={() => {
            onTab("team");
            onToggle();
          }}
          title="Show the team for this chat"
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            writingMode: "vertical-rl",
          }}
        >
          ● TEAM
        </button>
        <button
          onClick={() => {
            onTab("files");
            onToggle();
          }}
          title="Show file explorer"
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            writingMode: "vertical-rl",
          }}
        >
          FILES
        </button>
      </div>
    );
  }

  return (
    <>
      <ResizeHandle
        {...panel.handleProps}
        title="Resize panel · double-click to reset"
      />
    <div
      style={{
        width: panel.size,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        {(["team", "files"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tab === t ? tokens.accent : tokens.textMuted,
              background: tab === t ? tokens.primaryActionBg : "transparent",
              border: `1px solid ${tab === t ? tokens.accent : tokens.border}`,
              borderRadius: 6,
              padding: "3px 9px",
              cursor: "pointer",
            }}
          >
            {t === "team" ? "Team" : "Files"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          onClick={onToggle}
          title="Collapse"
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "team" ? (
          chatId ? (
            // One panel, full height, scoped to THIS chat — two zones since
            // phase 700 (team tree over plan Kanban) and therefore two polls,
            // 5s and 15s, against the two the pre-v3 panel ran at 4s and 6s.
            // `visible` gates both queries' `enabled`; the mount is conditional
            // on the same facts, so a collapsed panel or the Files tab stops
            // both polls twice over — by `enabled: false` and by there being no
            // observer at all (NFU3).
            <ChatTeamPanel
              chatId={chatId}
              onOpenNode={onOpenNode}
              onOpenDoc={onOpenDoc}
              visible={!collapsed && tab === "team"}
            />
          ) : (
            // No chat open: there is no id to scope to, and mounting the panel
            // with "" would key a query cache entry on a chat that doesn't
            // exist. Say the true thing instead.
            <div
              className="mono"
              style={{
                padding: "24px 12px",
                fontSize: 10.5,
                color: tokens.textFaint,
                lineHeight: 1.6,
                textAlign: "center",
              }}
            >
              no chat open — pick one on the left to see its team
            </div>
          )
        ) : (
          <FileExplorerPanel onAttach={fileAtt ? fileAtt.addExisting : null} />
        )}
      </div>
    </div>
    </>
  );
}

export function ChatSurface({
  onNavigate,
}: {
  onNavigate?: (s: SurfaceKey) => void;
} = {}) {
  const qc = useQueryClient();
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const listQ = useQuery({
    queryKey: ["chat", "list", visibleCount],
    queryFn: () => fetchChatList({ limit: visibleCount }),
    // 8s → 10s, ROUND 802: this is where U30's secrets poll is PAID FOR.
    //
    // The arithmetic, because rounding hid it. Steady state was 20 (chat
    // detail, 3s) + 10 (team, 6s) + 7.5 (this list, 8s) + 2 (plan, 30s) =
    // 39.5/min; SECRETS_POLL_MS adds 1, which is 40.5 — OVER phase 600
    // `nav-walk.cjs:310`'s ≤40 ceiling, even though both instruments printed
    // exactly 40. They print 40 because they count whole requests in a window
    // and 7.5 lands on 7 or 8 by luck of phase, which is a coin flip to hand a
    // reviewer, not a pass. At 10s this list costs 6/min and the surface sits
    // at 39 with a real request of headroom.
    //
    // Why here and not PlanKanban's PLAN_POLL_MS, which the brief nominated:
    // 30s → 60s was tried and measured, and it FAILS P1 ("drilling to depth 1
    // does not raise the request total"). nav-walk samples 30s windows and
    // doubles them, so any period ≥ 30s lands 0 or 2 requests depending on
    // phase and the three windows stop agreeing — at_rest 38 vs depth_1 40.
    // Only a poll faster than that window stays uniform, so the buy-back had
    // to come from a sub-30s poll, and this is the cheapest one: the rail is a
    // list of chat titles that changes when a chat is created, renamed or
    // archived, and every one of those already invalidates ["chat","list"]
    // directly. The ceiling was not raised and no gate was deleted.
    //
    // ROUND 808 — THE DEBT THIS PAID IS RETIRED, AND 10s STAYS ANYWAY. The
    // secrets poll it was bought for is gone (server push, see the U30 block
    // at the top of this file), so the surface now sits at 20 + 10 + 6 + 2 =
    // 38/min by arithmetic. Reverting to 8s would put it back to 39.5 —
    // sideways, not down, and back to the 7.5 that prints as 7 or 8 and made
    // the last two rounds argue about a rounded integer. A poll nobody needs
    // faster is not worth 1.5 req/min of the ceiling.
    refetchInterval: 10_000,
  });
  /* ── selId and navStack: two different questions (U21, 13 §2) ───────────
   *
   * `selId` is WHICH CHAT IS OPEN. `navStack` is WHAT YOU ARE LOOKING AT
   * inside it — empty means the manager chat itself, one frame means a worker
   * or a plan doc, two means a worker's sub-agent.
   *
   * `selId` DOES NOT MOVE WHEN YOU DRILL IN. That is the whole point of this
   * round. Until now, clicking a worker set `selId` to the worker's run, which
   * silently re-scoped the right sidebar to that worker — and the spec's rule
   * is that "the right sidebar is always a view of the currently open chat"
   * (10 §"Right sidebar"). With the stack, SidePanel keeps `chatId={selId}`,
   * the team tree stays exactly where it was, and you can read a worker while
   * still looking at the org chart it belongs to.
   *
   * The raw setter is deliberately private to `openChat` below: every chat
   * switch must reset the stack, and the way to guarantee that is to leave no
   * other way to switch. */
  const [selId, setSelIdRaw] = useState<string | null>(null);
  const [navStack, setNavStack] = useState<NavStack>(reset());

  /** Open a chat. Resets the drill-in stack — a worker view left standing
   *  under a newly opened chat asserts that worker belongs to the new chat,
   *  which is false. `reset()` returns one shared frozen array, so resetting
   *  an already-empty stack is a React bail-out and costs nothing. */
  const openChat = useCallback((id: string | null) => {
    setSelIdRaw(id);
    setNavStack(reset());
  }, []);

  /** Descend one level from a clicked team row.
   *
   *  A sub-agent is not a run: its `id` is the `tool_use_id` of the Task call
   *  that spawned it, and its transcript lives inline in its PARENT run's
   *  thread — so the frame fetches `parent_id` and slices by `id`. A session
   *  row fetches itself.
   *
   *  The architecture doc's sketch was `node.parent_id ?? node.id`; that is
   *  wrong for sessions, because a worker run's `parent_id` is its
   *  `parent_run_id` (forge-control/src/routes/chat.ts:495) and is NOT always
   *  null — a worker with a parent run would have drilled into its parent.
   *  Discriminating on `kind` says the intended thing exactly.
   *
   *  Stable identity (empty deps): ChatTeamPanel holds this in a ref so that
   *  every memoized row keeps the same callback prop, which is what keeps a
   *  hover sweep at zero re-renders (NFU2). A fresh arrow per render here
   *  would leak straight through that ref's effect. */
  const openNode = useCallback((node: TeamNode) => {
    setComposing(false);
    const frame: NavFrame =
      node.kind === "subagent"
        ? { kind: "agent", runId: node.parent_id ?? node.id, subagentId: node.id }
        : { kind: "agent", runId: node.id };
    setNavStack((s) => push(s, frame));
  }, []);

  /** Open a plan document from the panel's plan zone (U26).
   *
   *  The same three lines as `openNode` above, onto the other frame kind:
   *  `plandoc` already has its `crumbs` entry, its `frameKey` and its `pop`
   *  behaviour in nav-stack.ts, and PlanDocView is already wired below. This
   *  callback is the caller those pieces were built for — nothing new is added
   *  to the stack to support it.
   *
   *  Stable identity (empty deps) for the same NFU2 reason as `openNode`:
   *  PlanKanban holds it in a ref so that every memoized phase card keeps the
   *  same callback prop, and a fresh arrow per render here would leak straight
   *  through that ref's effect. */
  const openPlanDoc = useCallback((name: string) => {
    setComposing(false);
    setNavStack((s) => push(s, { kind: "plandoc", name }));
  }, []);

  /** Climb one level. At depth 1 that is the manager chat (`pop` says so). */
  const goBack = useCallback(() => setNavStack((s) => pop(s)), []);

  const drilled = top(navStack);
  /* What the back button says it returns to: the crumb one level BELOW the
   * top. `crumbs[0]` is the manager chat and `crumbs[i]` is `navStack[i-1]`,
   * so the level below the top sits at `navStack.length - 1`. */
  const backLabel = crumbs(navStack)[Math.max(0, navStack.length - 1)].label;
  const [composing, setComposing] = useState(false);
  // Collapse + tab persist: DesktopApp unmounts this surface on every nav
  // click, so `useState` meant the panel sprang back open (on the Live tab)
  // every time you came back to chat.
  const [panelCollapsed, setPanelCollapsed] = usePersistentState(
    "forge.layout.chat.panelCollapsed",
    false,
    isBool,
  );

  // Chat rail — 300 was the magic number; 220 still fits a title + preview.
  const rail = useResizablePanel({
    storageKey: "forge.layout.chat.rail",
    initial: 300,
    min: 220,
    max: 560,
  });
  // Chat ↔ canvas: a proportion, not pixels, so the split survives a window
  // resize. Grow factors (not basis percentages) so the ratio is exact.
  const canvasSplit = useResizablePanel({
    storageKey: "forge.layout.chat.canvasSplit",
    initial: 0.55,
    min: 0.25,
    max: 0.8,
    unit: "fraction",
  });
  // Split-screen canvas, remembered PER CHAT and across reloads. A brainstorm
  // lives in a specific chat + a specific drawing, so switching away and back
  // must restore the same split instead of silently closing it.
  const [canvasByRun, setCanvasByRun] = useState<
    Record<string, { open: boolean; path: string | null }>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("forge.canvasByRun") ?? "{}");
    } catch {
      return {};
    }
  });
  const canvasKey = selId ?? "__new__";
  const canvasOpen = canvasByRun[canvasKey]?.open ?? false;
  const canvasPath = canvasByRun[canvasKey]?.path ?? null;
  const patchCanvas = (patch: Partial<{ open: boolean; path: string | null }>) =>
    setCanvasByRun((prev) => {
      const cur = prev[canvasKey] ?? { open: false, path: null };
      const next = { ...prev, [canvasKey]: { ...cur, ...patch } };
      try {
        localStorage.setItem("forge.canvasByRun", JSON.stringify(next));
      } catch {
        /* private mode — the split just won't survive a reload */
      }
      return next;
    });
  const setCanvasOpen = (v: boolean) => patchCanvas({ open: v });
  const setCanvasPath = (p: string) => patchCanvas({ path: p, open: true });

  /* The derived "am I in an agent view" flag — `selId` is not in the chat
   * rail — is gone along with the one-slot backtrack state it partnered (U21;
   * both are at ChatSurface.tsx:265/301 in git 275b9d4). It inferred
   * navigation from the RAIL's contents, which made pagination a navigation
   * input: a `load more` that pulled the run into the list would have flipped
   * the app out of the drilled view underneath the user. `navStack` states the
   * same fact directly instead of inferring it. */

  // Persisted (main: DesktopApp unmounts this surface on every nav click, so
  // plain useState sprang the tab back to its default every time you returned
  // to chat). Same storage key as before the "live" → "team" rename, which is
  // the whole migration: the type guard rejects a stored "live", so a reader
  // who was on the old Live tab lands on "team" and one who was on "files"
  // keeps "files". No mapper, no stale value presented as valid.
  const [panelTab, setPanelTab] = usePersistentState<"team" | "files">(
    "forge.layout.chat.panelTab",
    "team",
    (v): v is "team" | "files" => v === "team" || v === "files",
  );
  const [search, setSearch] = useState("");
  // Lifted out of ChatThread (rather than created per-mount) so the file
  // explorer's "attach to chat" action can reach the active thread's
  // composer state directly.
  const threadAtt = useAttachments();
  useEffect(() => {
    threadAtt.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);
  const searching = search.trim().length >= 2;
  const searchQ = useQuery({
    queryKey: ["chat", "search", search],
    queryFn: () => searchChats(search.trim()),
    enabled: searching,
  });

  useEffect(() => {
    if (!selId && (listQ.data?.runs.length ?? 0) > 0) {
      openChat(listQ.data!.runs[0].id);
    }
  }, [listQ.data, selId, openChat]);

  // v2.0: SSE stream is the primary sync path; the query interval is only
  // a safety net (tight when the stream is down, lazy when it's live).
  //
  // The stream stays on `selId` and is NOT re-pointed when you drill in: one
  // stream, for the chat that is open, exactly as before (NFU3).
  const { live } = useRunEvents(selId, !composing);
  const detailQ = useQuery({
    queryKey: ["chat", "run", selId],
    queryFn: () => fetchChat(selId!),
    // `navStack.length === 0` is the poll-budget half of the drill-in (NFU3).
    // A drilled view runs its own detail query at the same intervals; leaving
    // this one enabled underneath it would DOUBLE the surface's request rate
    // for a thread nobody is currently reading. The cache entry survives, so
    // coming back renders instantly and then refreshes.
    enabled: !!selId && !composing && navStack.length === 0,
    refetchInterval: live ? 20000 : 3000,
  });

  const createM = useMutation({
    mutationFn: (input: {
      prompt: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }) => createChat(input),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      openChat(run.id);
      setComposing(false);
    },
    onError: (e) => toastError("Couldn't start that chat.", e),
  });

  // Every mutation below carries onError. Without it a failed send cleared
  // the composer and did nothing else — the message was simply gone, with
  // no way to tell that from a message the engine hadn't answered yet.
  const sendM = useMutation({
    mutationFn: (input: {
      id: string;
      content: string;
      canvasPath?: string | null;
    }) => sendChatMessage(input.id, input.content, input.canvasPath),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
    onError: (e, input) =>
      toastError(
        `Message not sent — “${input.content.slice(0, 60)}${input.content.length > 60 ? "…" : ""}”`,
        e,
      ),
  });

  const statusM = useMutation({
    mutationFn: (input: { id: string; status: RunStatus }) =>
      setChatStatus(input.id, input.status),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
    onError: (e, input) =>
      toastError(`Couldn't set this chat to ${input.status}.`, e),
  });

  const resumeM = useMutation({
    mutationFn: (id: string) => resumeChat(id),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
    onError: (e) => toastError("Resume failed — the run is still stopped.", e),
  });

  // Close = archive. Stops the underlying agent first (if it's still
  // queued/running/paused/stuck — same mechanism as the Cancel button, so
  // the executor kills the claude-code process within ~5s) then hides the
  // chat from the rail. Logs stay in the DB and stay searchable.
  const archiveM = useMutation({
    mutationFn: (id: string) => archiveChat(id),
    onSuccess: (_run, id) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      if (selId === id) openChat(null);
    },
    onError: (e) =>
      toastError("Close failed — the chat and its agent are still running.", e),
  });
  const archiveAllM = useMutation({
    mutationFn: () => archiveAllChats(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      openChat(null);
    },
    onError: (e) => toastError("Close-all failed — nothing was archived.", e),
  });

  const counts = listQ.data?.counts ?? null;

  // phase 400 (U9): the right panel has no selector of its own any more — it
  // is scoped to whatever chat is open, via the project that chat started.
  // ONE request per chat opened, deliberately no refetchInterval: linkage does
  // not change while a chat is open, and the poll budget must not grow (NFU3).
  const linkQ = useQuery({
    queryKey: ["chat", "linkage", selId],
    queryFn: () => fetchChatLinkage(selId!),
    enabled: !!selId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // Phase 500 (U14): the right panel no longer reads `project_id` from here —
  // ChatTeamPanel resolves the chat→project link server-side and renders its
  // own error row on failure (NFU6). What survives of this query is the
  // header's linkage-honesty markers below; on error they simply don't render,
  // which is honest: an unresolved link makes no claim about how it was made.
  const linkage: ChatLinkage | undefined = linkQ.data;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — chat list */}
      <div
        style={{
          width: rail.size,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 14px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}>
            Chats
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.accent,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "2px 7px",
            }}
          >
            {listQ.data?.count ?? 0}
          </span>
          <span style={{ flex: 1 }} />
          <CloseAllButton
            disabled={(listQ.data?.count ?? 0) === 0}
            pending={archiveAllM.isPending}
            onConfirm={() => archiveAllM.mutate()}
          />
          <button
            onClick={() => {
              openChat(null);
              setComposing(true);
            }}
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            + new
          </button>
        </div>
        <div
          style={{
            flex: "none",
            padding: "9px 12px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 14, color: tokens.textFaint }}>
              search
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search past chats — titles + what was said…"
              className="mono"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: tokens.text,
                fontSize: 11.5,
              }}
            />
            {search && (
              <span
                onClick={() => setSearch("")}
                className="mono"
                style={{ fontSize: 10, color: tokens.textFaint, cursor: "pointer" }}
              >
                ✕
              </span>
            )}
          </div>
        </div>
        {!searching && counts && (
          <div
            className="mono"
            style={{
              padding: "8px 14px",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              borderBottom: `1px solid ${tokens.borderDivider}`,
              fontSize: 10,
            }}
          >
            {(["running", "queued", "stuck", "completed"] as RunStatus[]).map(
              (s) => (
                <span key={s} style={{ color: STATUS_COLOR[s] }}>
                  {s} {counts[s]}
                </span>
              ),
            )}
          </div>
        )}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {searching ? (
            <>
              {searchQ.isLoading && (
                <div
                  className="mono"
                  style={{ padding: 24, fontSize: 11, color: tokens.textFaint, textAlign: "center" }}
                >
                  searching…
                </div>
              )}
              {searchQ.isError && (
                <ErrorPanel
                  compact
                  title="Search failed."
                  detail={errorDetail(searchQ.error)}
                  onRetry={() => void searchQ.refetch()}
                />
              )}
              {!searchQ.isLoading &&
                !searchQ.isError &&
                (searchQ.data?.length ?? 0) === 0 && (
                <div
                  className="mono"
                  style={{
                    padding: "32px 16px",
                    fontSize: 11,
                    color: tokens.textFaint,
                    textAlign: "center",
                    lineHeight: 1.6,
                  }}
                >
                  no chats match “{search.trim()}”.
                </div>
              )}
              {searchQ.data?.map((r) => (
                <ChatListItem
                  key={r.id}
                  run={r}
                  selected={r.id === selId && !composing}
                  onSelect={() => {
                    openChat(r.id);
                    setComposing(false);
                    setSearch("");
                  }}
                  onClose={() => archiveM.mutate(r.id)}
                  closing={archiveM.isPending && archiveM.variables === r.id}
                />
              ))}
            </>
          ) : (
            <>
              {listQ.isLoading && (
                <div
                  className="mono"
                  style={{
                    padding: 24,
                    fontSize: 11,
                    color: tokens.textFaint,
                    textAlign: "center",
                  }}
                >
                  loading…
                </div>
              )}
              {listQ.isError && (
                <ErrorPanel
                  compact
                  title="Couldn't load your chats."
                  detail={errorDetail(listQ.error)}
                  onRetry={() => void listQ.refetch()}
                />
              )}
              {!listQ.isLoading &&
                !listQ.isError &&
                (listQ.data?.runs.length ?? 0) === 0 && (
                <div
                  className="mono"
                  style={{
                    padding: "32px 16px",
                    fontSize: 11,
                    color: tokens.textFaint,
                    textAlign: "center",
                    lineHeight: 1.6,
                  }}
                >
                  no chats yet.
                  <br />
                  hit “+ new” to start one.
                </div>
              )}
              {listQ.data?.runs.map((r) => (
                <ChatListItem
                  key={r.id}
                  run={r}
                  selected={r.id === selId && !composing}
                  onSelect={() => {
                    openChat(r.id);
                    setComposing(false);
                  }}
                  onClose={() => archiveM.mutate(r.id)}
                  closing={archiveM.isPending && archiveM.variables === r.id}
                />
              ))}
              {listQ.data?.hasMore && (
                <div
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  className="mono"
                  style={{
                    padding: "12px 14px",
                    fontSize: 11,
                    color: tokens.accent,
                    textAlign: "center",
                    cursor: "pointer",
                    borderTop: `1px solid ${tokens.borderDivider}`,
                  }}
                >
                  load more
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ResizeHandle
        {...rail.handleProps}
        title="Resize chat list · double-click to reset"
      />

      {/* Thread + canvas share one flex region so the split handle measures
          exactly the space it divides. */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", minHeight: 0 }}>
      {/* Right pane — thread/composer, optionally split with the canvas */}
      <div
        style={{
          flex: canvasOpen ? `${canvasSplit.size} 1 0%` : 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          position: "relative",
        }}
      >
        {/* The floating "← agent view · back" escape hatch used to live here,
            absolutely positioned over the transcript. It is gone with the
            backtrack state it read (U21): back is now a real, animated control
            in the drilled view's own header (AgentChatView / PlanDocView),
            which is where U20 asks for it, and it pops ONE level instead of
            teleporting to the chat you started from. */}
        {composing ? (
          <NewChat
            isCreating={createM.isPending}
            onCancel={() => setComposing(false)}
            onCreate={(prompt, title, model, effort) =>
              createM.mutate({
                prompt,
                title: title || undefined,
                metadata: {
                  // Always send the exact model id. This used to strip a bare
                  // "opus" sentinel and fall through to the executor's env
                  // default — which meant the picker's own default silently
                  // never applied. Every choice in ENGINE_MODEL_CHOICES is a
                  // concrete id, so there's nothing to strip.
                  model,
                  effort,
                },
              })
            }
          />
        ) : drilled !== null ? (
          /* U20: the drill-in replaces the MIDDLE surface only. `selId` is
           * untouched, so SidePanel below still shows this chat's team and the
           * tree you clicked from does not move under you.
           *
           * The key is the frame, not the render: `.nav-drill` replays its
           * entry animation when you descend or climb, and not when the
           * transcript polls. */
          <div
            key={frameKey(navStack)}
            className="nav-drill"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
            {drilled.kind === "agent" ? (
              <AgentChatView
                frame={drilled}
                stack={navStack}
                live={live}
                onBack={goBack}
                backLabel={backLabel}
              />
            ) : (
              <PlanDocView
                name={drilled.name}
                stack={navStack}
                onBack={goBack}
                backLabel={backLabel}
              />
            )}
          </div>
        ) : detailQ.data ? (
          <ChatThread
            key={detailQ.data.id}
            run={detailQ.data}
            live={live}
            onSend={(content) =>
              sendM.mutate({
                id: detailQ.data!.id,
                content,
                // Only when the canvas pane is actually open — a drawing the
                // user closed is not what they're looking at.
                canvasPath: canvasOpen ? canvasPath : null,
              })
            }
            onStatus={(status) =>
              statusM.mutate({ id: detailQ.data!.id, status })
            }
            onResume={() => resumeM.mutate(detailQ.data!.id)}
            onNavigate={onNavigate}
            headerExtra={
              <button
                onClick={() => setCanvasOpen(!canvasOpen)}
                className="mono"
                title={
                  canvasOpen
                    ? "Close the canvas"
                    : "Open Excalidraw beside the chat"
                }
                style={{
                  flex: "none",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  padding: "5px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  color: canvasOpen ? tokens.accent : tokens.textMuted,
                  background: canvasOpen ? tokens.primaryActionBg : "transparent",
                  border: `1px solid ${canvasOpen ? tokens.accent : tokens.border}`,
                }}
              >
                CANVAS
              </button>
            }
            isSending={sendM.isPending}
            isResuming={resumeM.isPending}
            att={threadAtt}
            linkSource={linkage?.link_source ?? undefined}
            linkAmbiguous={linkage?.link_ambiguous}
          />
        ) : (
          <div
            className="mono"
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: tokens.textFaint,
            }}
          >
            select a chat or create a new one
          </div>
        )}
      </div>

      {canvasOpen && (
        <>
          <ResizeHandle
            {...canvasSplit.handleProps}
            title="Resize chat / canvas · double-click to reset"
          />
          <div
            style={{
              flex: `${1 - canvasSplit.size} 1 0%`,
              minWidth: 320,
              display: "flex",
              minHeight: 0,
            }}
          >
            <CanvasPane
              path={canvasPath}
              onPathChange={setCanvasPath}
              onClose={() => setCanvasOpen(false)}
            />
          </div>
        </>
      )}
      </div>

      <SidePanel
        collapsed={panelCollapsed}
        onToggle={() => setPanelCollapsed(!panelCollapsed)}
        tab={panelTab}
        onTab={setPanelTab}
        onOpenNode={openNode}
        onOpenDoc={openPlanDoc}
        fileAtt={composing ? null : threadAtt}
        // The SAME id the detail query and the header run on — one open chat,
        // one scope, no third source of "which chat is this".
        chatId={composing ? null : selId}
      />
    </div>
  );
}

function ChatListItem({
  run,
  selected,
  onSelect,
  onClose,
  closing,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  closing: boolean;
}) {
  const color = STATUS_COLOR[run.status];
  // U10: present, not truthy. A linked project with no tasks yet is a real
  // `0/0`; a chat that never started a project has no counter at all, because
  // the server omits these fields rather than zeroing them.
  const hasProgress = typeof run.tasks_total === "number";
  const allDone =
    hasProgress && run.tasks_done === run.tasks_total && run.tasks_total! > 0;
  // NFU2: the ✕/age swap is CSS-only (`.chat-row` in globals.css). It used to
  // be `useState(hover)`, which re-rendered every row the pointer crossed —
  // the sidebar lag Konrad reported. Both children are always mounted and
  // stacked in one slot, so revealing one costs an opacity change, not a
  // re-render and not a reflow.
  return (
    <div
      onClick={onSelect}
      className="chat-row"
      style={{
        padding: "12px 14px",
        cursor: "pointer",
        borderBottom: `1px solid ${tokens.borderDivider}`,
        borderLeft: `2px solid ${selected ? color : "transparent"}`,
        background: selected ? tokens.selectedBg : "transparent",
        opacity: closing ? 0.5 : 1,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={dot(color, run.status === "running")} />
        <span
          className="mono"
          style={{ fontSize: 10, color, letterSpacing: "0.06em" }}
        >
          {run.status}
        </span>
        {run.archived && (
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 4,
              padding: "0 4px",
              letterSpacing: "0.06em",
            }}
          >
            closed
          </span>
        )}
        {hasProgress && (
          <span
            className="mono"
            title={
              run.project_status
                ? `project ${run.project_id?.slice(0, 8)} — ${run.project_status}`
                : undefined
            }
            style={{
              fontSize: 9.5,
              color: allDone ? tokens.ok : tokens.textMuted,
              letterSpacing: "0.04em",
            }}
          >
            {run.tasks_done}/{run.tasks_total} tasks
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* One slot, two children: the age sits in flow and sizes the slot, the
            ✕ is absolutely positioned over it. Hover swaps their opacity — no
            state, no reflow. */}
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <span
            className="mono chat-row-age"
            style={{ fontSize: 9.5, color: tokens.textFaint }}
          >
            {humanAge(run.updated_at)}
          </span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (!closing) onClose();
            }}
            title="Close this chat — stops the agent if it's still working, and hides it from the list. Nothing is deleted; it stays searchable."
            className="mono chat-row-x"
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 11,
              color: tokens.bleed,
              cursor: closing ? "wait" : "pointer",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            ✕
          </span>
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: selected ? tokens.text : tokens.textLabel,
          marginTop: 6,
          lineHeight: 1.42,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {run.title}
      </div>
      {run.last_message_preview && (
        <div
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            marginTop: 4,
            lineHeight: 1.4,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          <span style={{ color: tokens.textFaint, marginRight: 6 }}>
            {run.last_role}
          </span>
          {run.last_message_preview}
        </div>
      )}
    </div>
  );
}

/** Two-click confirm so "close all" can't fire from a stray click — closes
 *  every open chat (stops any still-active agents, archives the rest). */
function CloseAllButton({
  disabled,
  pending,
  onConfirm,
}: {
  disabled: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      disabled={disabled || pending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timerRef.current = setTimeout(() => setArmed(false), 4000);
          return;
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        setArmed(false);
        onConfirm();
      }}
      title="Closes every chat — stops any that are still working and hides them from the list. Logs are kept."
      className="mono"
      style={{
        fontSize: 11,
        color: armed ? tokens.bleed : tokens.textMuted,
        background: armed ? tokens.dangerActionBg : "transparent",
        border: `1px solid ${armed ? tokens.dangerActionBorder : tokens.border}`,
        borderRadius: 6,
        padding: "4px 10px",
        cursor: disabled || pending ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {pending ? "closing…" : armed ? "confirm close all?" : "close all"}
    </button>
  );
}

/** Tiny expandable model+effort picker next to Send — sets the engine for
 *  subsequent turns of this run (POST /:id/model and /:id/effort). Local
 *  state is optimistic; it re-syncs from run.metadata whenever the run
 *  object updates (e.g. after a page refresh or SSE-driven refetch). */
function EngineControls({ run }: { run: RunDetail }) {
  const [open, setOpen] = useState(false);
  const currentModel = String(run.metadata?.model ?? DEFAULT_ENGINE_MODEL);
  const currentEffort = String(run.metadata?.effort ?? "high");
  const [model, setModelLocal] = useState(currentModel);
  const [effort, setEffortLocal] = useState(currentEffort);
  useEffect(() => {
    setModelLocal(currentModel);
    setEffortLocal(currentEffort);
  }, [currentModel, currentEffort]);

  const modelLabel =
    ENGINE_MODEL_CHOICES.find((m) => m.value === model)?.label ?? model;

  return (
    <div
      style={{ position: "relative" }}
      tabIndex={-1}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="mono"
        title="Engine model + effort for this run"
        style={{
          fontSize: 10.5,
          color: tokens.textMuted,
          border: `1px solid ${tokens.border}`,
          background: "transparent",
          borderRadius: 6,
          padding: "10px 10px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {modelLabel} ·{" "}
        {/* U29: the effort word carries its ramp colour even when collapsed,
            so the cost setting is readable without opening the picker. */}
        <span style={{ color: effortRamp(effort).fg }}>{effort}</span> ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            right: 0,
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            zIndex: 20,
            minWidth: 190,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="mono"
              style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.1em" }}
            >
              MODEL
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {ENGINE_MODEL_CHOICES.map((m) => {
                const on = m.value === model;
                return (
                  <button
                    key={m.value}
                    onClick={() => {
                      setModelLocal(m.value);
                      void setChatModel(run.id, m.value);
                    }}
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: on ? tokens.accent : tokens.textMuted,
                      border: `1px solid ${on ? tokens.accent : tokens.border}`,
                      background: on ? tokens.primaryActionBg : "transparent",
                      borderRadius: 6,
                      padding: "3px 8px",
                      cursor: "pointer",
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              className="mono"
              style={{ fontSize: 9, color: tokens.textFaint, letterSpacing: "0.1em" }}
            >
              EFFORT
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {/* U29: cheapest → hottest, coloured by the ramp. Unselected
                  chips show the ramp in the border only, dimmed; the selected
                  one fills, doubles its outline and takes the ramp text
                  colour, which reads as "on" in both palettes. */}
              {ENGINE_EFFORT_CHOICES.map((e) => {
                const on = e === effort;
                const ramp = effortRamp(e);
                return (
                  <button
                    key={e}
                    onClick={() => {
                      setEffortLocal(e);
                      void setChatEffort(run.id, e);
                    }}
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: on ? ramp.fg : tokens.textMuted,
                      border: `1px solid ${ramp.border}`,
                      background: on ? ramp.bg : "transparent",
                      boxShadow: on ? `inset 0 0 0 1px ${ramp.border}` : "none",
                      opacity: on ? 1 : 0.55,
                      fontWeight: on ? 600 : 400,
                      borderRadius: 6,
                      padding: "3px 8px",
                      cursor: "pointer",
                    }}
                  >
                    {e}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** U28 composer bounds. `COMPOSER_LINE_HEIGHT` is pinned in the textarea's
 *  style because a textarea with no explicit line-height computes to `normal`,
 *  which useAutogrow cannot convert into rows. Module-level so the hook's
 *  effect deps stay referentially stable across renders. */
const COMPOSER_LINE_HEIGHT = 1.5;
const COMPOSER_ROWS = { minRows: 2, maxRows: 10 } as const;

function ChatThread({
  run,
  live,
  onSend,
  onStatus,
  onResume,
  onNavigate,
  isSending,
  isResuming,
  att,
  headerExtra,
  linkSource,
  linkAmbiguous,
}: {
  run: RunDetail;
  live: boolean;
  onSend: (content: string) => void;
  onStatus: (status: RunStatus) => void;
  onResume: () => void;
  onNavigate?: (s: SurfaceKey) => void;
  isSending: boolean;
  isResuming: boolean;
  /** Lifted to ChatSurface so the file-explorer panel can attach into the
   *  currently open thread's composer without prop-drilling through state. */
  att: ReturnType<typeof useAttachments>;
  /** Rendered in the header's action row. The canvas toggle lives here rather
   *  than floating absolutely over the pane, where it sat on top of the
   *  status/resume controls. */
  headerExtra?: React.ReactNode;
  /** How this chat's project link was established (U2). `"thread_scan"` means
   *  it was inferred from the transcript — round 402 renders the "linked
   *  heuristically" marker in the header from these two props (NFU6).
   *  `undefined` = linkage not resolved yet, or the chat owns no project. */
  linkSource?: ChatLinkage["link_source"];
  linkAmbiguous?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [localSys, setLocalSys] = useState<
    Array<{ text: string; ts: string }>
  >([]);
  const popoverRef = useRef<SlashPopoverHandle | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  /** Non-null → the panel is in ANSWER mode for this agent request. Null with
   *  `secretOpen` true → free-form mode, exactly as before U30. */
  const [answering, setAnswering] = useState<SecretRequest | null>(null);
  const qc = useQueryClient();
  // U28: the composer sizes itself to `draft`. No height state — see useAutogrow.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useAutogrow(composerRef, draft, COMPOSER_ROWS);

  /* ----- U30: pending credential requests ---------------------------------
   * `enabled` is the MOUNT. This hook lives inside ChatThread, which exists
   * only while a manager chat's composer is on screen; no observer means
   * react-query does not poll at all, which is a harder gate than
   * `enabled: false` and the same one ChatTeamPanel argues for (NFU3).
   * `refetchIntervalInBackground` is left at its default (false), so a
   * backgrounded tab costs nothing either.
   *
   * NOTHING FROM THIS QUERY IS EVER SENT ANYWHERE. `GET /api/secrets` returns
   * metadata only — no value is on the wire — and the only field this file
   * reads out of it is `name`. The agent's `note` is passed straight to
   * SecretField for display and is never put into a message, a system line, a
   * title attribute, or a log.
   *
   * ROUND 808: the interval is now the FALLBACK, not the mechanism. While the
   * event stream below is connected this query does not poll at all (`false`);
   * it refetches when the stream says the pending set moved. The interval only
   * comes back if the stream drops, so a dead stream degrades to phase 800's
   * behaviour instead of to silence. */
  const [secretsLive, setSecretsLive] = useState(false);
  const secretsQ = useQuery({
    queryKey: ["secrets", "list"],
    queryFn: fetchSecrets,
    refetchInterval: secretsPollInterval(secretsLive),
    refetchOnWindowFocus: true,
  });

  /* The stream itself. Mounted with the composer, exactly like the query above:
   * ChatThread exists only while a manager chat is on screen, so a backgrounded
   * surface holds no connection.
   *
   * `qc.invalidateQueries` rather than writing the frame into the cache: the
   * list endpoint stays the single source of truth (see secretLive.ts), so the
   * panel can never open on a request the server would not confirm. The frame's
   * own note is deliberately NOT rendered from here — it arrives with the
   * refetch, through the same `pendingRequests` reducer every other path uses,
   * with its caps and its ordering intact.
   *
   * Empty deps: one connection per mounted composer, never re-opened on a
   * re-render. `qc` is stable for the app's lifetime (QueryClientProvider). */
  useEffect(() => {
    const refetch = () => {
      void qc.invalidateQueries({ queryKey: ["secrets", "list"] });
    };
    // The query above fetches once on mount by itself, and the first `hello`
    // lands at about that moment — refetching on it would buy the same list
    // twice. Every LATER hello is a RECONNECT, and that one must refetch: it
    // is how a request filed while the stream was down gets picked up.
    let helloes = 0;
    const sub = subscribeSecretRequests({
      onLive: setSecretsLive,
      onHello: () => {
        helloes += 1;
        if (helloes > 1) refetch();
      },
      onMoved: refetch,
    });
    return () => {
      sub.close();
      // The stream is gone with the component; say so, so nothing reads a
      // stale "live" if this instance is somehow observed during teardown.
      setSecretsLive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* NFU6 — a failed fetch must not leave a stale badge standing there looking
   * fresh. react-query keeps the last good `data` through an error, which is
   * exactly the lie to avoid here: "an agent is waiting" is a claim about the
   * server RIGHT NOW. On error we claim nothing and say so inline instead. */
  const secretRows: readonly SecretMeta[] = secretsQ.isError
    ? NO_SECRETS
    : (secretsQ.data ?? NO_SECRETS);
  const pending = useMemo(() => pendingRequests(secretRows), [secretRows]);

  /** Identity of the pending SET, not of the array. This is what "a request
   *  arrived" means, and it is the only thing the auto-open effect reacts to —
   *  a poll that returns the same names must not re-decide anything.
   *  `JSON.stringify` rather than a `join`: no separator can collide with a
   *  name, and the result stays printable in a devtools watch. */
  const pendingKey = JSON.stringify(pending.map((r) => r.name));

  const closeSecret = () => {
    // Closing IS the dismissal. Without this the next refetch would re-open the
    // panel Konrad just closed, which is the precise failure mode the
    // requirement calls out — and round 808 made that refetch arrive in
    // milliseconds rather than up to a minute, so the session memory below
    // matters MORE now, not less. "not now" also lands here (SecretField's
    // decline clears the server flag and then calls onClose), so both exits
    // agree.
    if (answering) dismissedSecretRequests.add(answering.name);
    setAnswering(null);
    setSecretOpen(false);
    // Refresh now, without waiting for the server's own `cleared` frame to come
    // back around: a "not now" already cleared the pending flag server-side and
    // the badge must follow immediately. The frame lands too, and finds nothing
    // to change — invalidating twice is one wasted request at worst.
    void qc.invalidateQueries({ queryKey: ["secrets", "list"] });
  };

  /* AUTO-OPEN, AND THE THREE WAYS IT MUST NOT BE HOSTILE.
   *
   * Fires on exactly two events: this chat opening with something already
   * pending (the effect's first run — ChatThread is keyed by run id, so mount
   * IS "chat opened"), and the pending set changing while it is open. Deps are
   * `pendingKey` alone, which is what makes that true; `draft` and `secretOpen`
   * are read at that instant rather than tracked, on purpose.
   *
   *   1. mid-typing wins. A non-empty draft means Konrad is composing; the
   *      badge is enough and focus stays where he put it. He is not asked
   *      again for this same pending set — the effect has already decided.
   *   2. a closed panel stays closed, because `closeSecret` remembers the name
   *      for the session (see `dismissedSecretRequests`).
   *   3. it never interrupts a panel that is already open. */
  useEffect(() => {
    if (pending.length === 0) return;
    if (secretOpen) return;
    if (draft.trim() !== "") return;
    const target = autoOpenTarget(secretRows, [...dismissedSecretRequests]);
    if (!target) return;
    setAnswering(target);
    setSecretOpen(true);
    // Intentionally keyed on the pending SET only. Adding `draft` would pop the
    // panel open the moment he cleared or sent a message; adding `secretOpen`
    // would re-run the decision every time he closed it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const pushSys = (text: string) =>
    setLocalSys((prev) => [...prev, { text, ts: new Date().toISOString() }]);

  const sendWithAttachments = (text: string) => {
    onSend(`${text}${attachmentsBlock(att.attachments)}`);
    att.clear();
  };

  // Slash context — handlers reach back into the chat surface for the
  // mutations they need (cancel, resume, freeze, etc.). Built per-render
  // because runId/runStatus can change; cheap.
  const slashCtx: SlashContext = {
    runId: run.id,
    runStatus: run.status,
    sys: pushSys,
    nav: (s) => {
      if (onNavigate) onNavigate(s);
      else pushSys(`(no navigate handler — would open ${s})`);
    },
    freezeFleet: () => freezeFleet("chat-slash"),
    resumeFleet: () => resumeFleet("chat-slash"),
    resumeRun: (id) => resumeChat(id),
    setRunStatus: (id, status) => setChatStatus(id, status),
    vaultAppend: (input) => vaultAppend(input),
    vaultCreateNote: (input) => vaultCreateNote(input),
    createReminder: (input) => createReminder(input),
    setModel: (id, model) => setChatModel(id, model),
    fetchRules: async () => (await fetchAutonomy()).rules,
    updateRuleConfig: (id, config) => updateRule(id, { config }),
  };

  const dispatchSlash = async (raw: string) => {
    const { name } = parseSlash(raw);
    if (!name) return false;
    const cmd = findSlash(name);
    if (!cmd) {
      // Unknown slash — treat as a normal message so user can still send
      // literal text starting with "/" if they want.
      return false;
    }
    try {
      const result: SlashDirective = await Promise.resolve(
        cmd.handler(slashCtx, parseSlash(raw).args),
      );
      if (result.kind === "navigate") slashCtx.nav(result.surface);
      else if (result.kind === "send-message") {
        onSend(result.message);
      }
    } catch (e) {
      pushSys(
        `slash /${name} error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return true;
  };
  const color = STATUS_COLOR[run.status];
  const model = String(run.metadata?.model ?? DEFAULT_ENGINE_MODEL);

  return (
    <>
      {/* U12 — slim header. Gone: run.title (the rail already names the chat),
       *  the status word (the dot IS the status), engine, and the cost/cap
       *  line (U11 — the last rendered dollar in the chat surface). Remaining:
       *  the status dot with its live/polling indicator docked underneath it as
       *  ONE unit, the model, the linkage-honesty markers (NFU6), and the
       *  unchanged actions (canvas via headerExtra, resume, cancel). */}
      <div
        style={{
          padding: "7px 18px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
          }}
        >
          <span style={dot(color, run.status === "running")} />
          <span
            className="mono"
            style={{
              fontSize: 9,
              lineHeight: 1,
              color: live ? tokens.ok : tokens.warn,
            }}
          >
            {live ? "live" : "polling"}
          </span>
        </div>
        <div
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10.5,
            color: tokens.textFaint,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {model}
        </div>
        {/* NFU6 — say how the project link was established when it was guessed.
         *  A link read from stored metadata is silent; a scanned or contested
         *  one says so, because a guess presented as truth is the failure mode
         *  this phase is trying to kill. Props come from ChatSurface's single
         *  ["chat","linkage",id] query — no second fetch here. */}
        {linkSource === "thread_scan" && (
          <span
            className="mono"
            title="this chat's project link was derived by scanning the thread, not from stored metadata"
            style={{ flex: "none", fontSize: 9, color: tokens.textMuted }}
          >
            linked heuristically
          </span>
        )}
        {linkAmbiguous === true && (
          <span
            className="mono"
            title="more than one project claims this chat — showing the newest"
            style={{ flex: "none", fontSize: 9, color: tokens.warn }}
          >
            ambiguous link
          </span>
        )}
        {headerExtra}
        {run.status === "stuck" && (
          <button
            onClick={onResume}
            disabled={isResuming}
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: isResuming ? "not-allowed" : "pointer",
            }}
          >
            {isResuming ? "resuming…" : "resume"}
          </button>
        )}
        {run.status !== "completed" &&
          run.status !== "cancelled" &&
          run.status !== "failed" && (
            <button
              onClick={() => onStatus("cancelled")}
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.bleed,
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              cancel
            </button>
          )}
      </div>
      <AssistantThread run={run} />
      {localSys.length > 0 && (
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            padding: "8px 28px 0",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {localSys.map((m, i) => (
            <div
              key={`localsys-${i}`}
              style={{
                padding: "8px 12px",
                borderLeft: `2px solid ${tokens.info}`,
                // Was a hardcoded translucent literal of the DARK theme's info
                // hue, so it stayed a cyan wash in light mode (NFU1). The
                // recessed-panel token flips with the theme; the left border
                // keeps the hue.
                background: tokens.toolBg,
                borderRadius: 6,
                fontSize: 12,
                color: tokens.textSecondary,
                whiteSpace: "pre-wrap",
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: tokens.info,
                  letterSpacing: "0.08em",
                  marginBottom: 3,
                }}
              >
                SLASH · {humanAge(m.ts)}
              </div>
              {m.text}
            </div>
          ))}
        </div>
      )}
      <div
        {...att.dropHandlers}
        style={{
          position: "relative",
          borderTop: `1px solid ${tokens.borderSoft}`,
          padding: "8px 18px 12px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {secretOpen && secretsQ.isError && (
          // NFU6. The panel is open but the list behind the badge could not be
          // read, so say that rather than render an empty "nothing pending".
          // `errorDetail` is the transport error; it can never carry a secret
          // value, because no value is on this endpoint at all.
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.bleed,
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            couldn&apos;t read pending credential requests — {errorDetail(secretsQ.error)}
          </div>
        )}
        {secretOpen && (
          <SecretField
            // Remount when the request changes so no field survives the switch.
            key={answering ? `req:${answering.name}` : "freeform"}
            request={answering ?? undefined}
            onClose={closeSecret}
            onStored={(name) => {
              // Only the NAME enters the conversation. The value is on disk.
              pushSys(`secret stored: ${name} (value not in this thread)`);
              setDraft((d) => (d ? `${d} ` : "") + `[secret: ${name}]`);
            }}
          />
        )}
        <AttachmentChips
          attachments={att.attachments}
          uploading={att.uploading}
          uploadError={att.uploadError}
          onRemove={att.remove}
        />
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 8 }}>
          <SlashPopover
            ref={popoverRef}
            input={draft}
            onApply={(cmd) => {
              // Tab/click on popover: replace input with "/name " ready for args.
              setDraft(`/${cmd.name} `);
            }}
          />
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={att.onPaste}
            onKeyDown={(e) => {
              // Popover gets first crack at the key — arrows, Tab, Esc.
              if (popoverRef.current?.handleKey(e)) return;
              // v1.6 phase 1: Enter sends; Shift+Enter newline; IME-safe.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                const v = draft.trim();
                if (!v && att.attachments.length === 0) return;
                // v1.6 phase 4: if the input is a slash command, dispatch it
                // locally and DO NOT send to the run executor.
                if (v.startsWith("/")) {
                  // If the popover is open and a command is highlighted, accept
                  // that instead of relying on the typed name. Otherwise parse
                  // the typed string directly.
                  const accepted = popoverRef.current?.acceptSelected() ?? null;
                  const target = accepted ? `/${accepted.name}` : v;
                  void dispatchSlash(target);
                  setDraft("");
                  return;
                }
                sendWithAttachments(v || "See attached files.");
                setDraft("");
              }
            }}
            placeholder={
              run.status === "running"
                ? "engine working… Enter to queue a message · / for commands"
                : "message · Enter to send · drop/paste files · /note /todo /remind · Shift+Enter newline"
            }
            rows={COMPOSER_ROWS.minRows}
            style={{
              flex: 1,
              resize: "none",
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "10px 12px",
              color: tokens.text,
              fontSize: 13,
              fontFamily: "Inter, system-ui",
              // Pinned for useAutogrow: `normal` is unmeasurable (U28).
              lineHeight: COMPOSER_LINE_HEIGHT,
              outline: "none",
            }}
          />
          <EngineControls run={run} />
          <button
            // NAMES ONLY in the title. The agent's `note` is display-only and
            // must not reach a DOM attribute — a tooltip is copyable, ends up
            // in screenshots, and is attacker-written text besides.
            title={
              pending.length === 0
                ? "Store a credential without putting it in the chat"
                : `waiting for ${pending
                    .slice(0, PENDING_NAMES_IN_TITLE)
                    .map((r) => r.name)
                    .join(", ")}${
                    pending.length > PENDING_NAMES_IN_TITLE
                      ? ` +${pending.length - PENDING_NAMES_IN_TITLE} more`
                      : ""
                  } — click to answer`
            }
            onClick={() => {
              if (secretOpen) {
                closeSecret();
                return;
              }
              // An explicit click ignores this session's dismissals: the badge
              // is what he is clicking, so give him the request behind it.
              // Null → free-form mode, the pre-U30 behaviour.
              setAnswering(autoOpenTarget(secretRows, []));
              setSecretOpen(true);
            }}
            className="mono"
            style={{
              position: "relative",
              background: "transparent",
              border: `1px solid ${pending.length > 0 ? tokens.warn : tokens.border}`,
              borderRadius: 6,
              color: secretOpen
                ? tokens.accent
                : pending.length > 0
                  ? tokens.warn
                  : tokens.textMuted,
              fontSize: 11,
              padding: "6px 9px",
              cursor: "pointer",
              flex: "none",
            }}
          >
            secret
            {pending.length > 0 && (
              // Derived from the query, not from hover or any other event —
              // there is no state here to get stale (NFU3: the row costs no
              // re-render of its own).
              <span
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  minWidth: 14,
                  height: 14,
                  padding: "0 3px",
                  borderRadius: 7,
                  background: tokens.warn,
                  color: tokens.bgBody,
                  fontSize: 9,
                  lineHeight: "14px",
                  textAlign: "center",
                  fontWeight: 600,
                }}
              >
                {pending.length}
              </span>
            )}
          </button>
          <button
            disabled={
              isSending ||
              (draft.trim().length === 0 && att.attachments.length === 0)
            }
            onClick={() => {
              const v = draft.trim();
              if (!v && att.attachments.length === 0) return;
              if (v.startsWith("/")) {
                const accepted = popoverRef.current?.acceptSelected() ?? null;
                const target = accepted ? `/${accepted.name}` : v;
                void dispatchSlash(target);
                setDraft("");
                return;
              }
              sendWithAttachments(v || "See attached files.");
              setDraft("");
            }}
            className="mono"
            style={{
              fontSize: 11.5,
              color:
                draft.trim().length === 0 && att.attachments.length === 0
                  ? tokens.textFaint
                  : tokens.accent,
              border: `1px solid ${
                draft.trim().length === 0 && att.attachments.length === 0
                  ? tokens.border
                  : tokens.accent
              }`,
              background:
                draft.trim().length === 0 && att.attachments.length === 0
                  ? "transparent"
                  : tokens.primaryActionBg,
              borderRadius: 6,
              padding: "10px 14px",
              cursor:
                isSending ||
                (draft.trim().length === 0 && att.attachments.length === 0)
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {isSending ? "…" : "send"}
          </button>
        </div>
      </div>
    </>
  );
}

function NewChat({
  onCancel,
  onCreate,
  isCreating,
}: {
  onCancel: () => void;
  onCreate: (prompt: string, title: string, model: string, effort: string) => void;
  isCreating: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_ENGINE_MODEL);
  const [effort, setEffort] = useState<string>("high");
  const att = useAttachments();
  const canCreate = prompt.trim().length > 0 || att.attachments.length > 0;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const create = () => {
    const text = prompt.trim() || "See attached files.";
    onCreate(`${text}${attachmentsBlock(att.attachments)}`, title.trim(), model, effort);
  };
  return (
    <div
      {...att.dropHandlers}
      style={{
        padding: "24px 28px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.accent,
            letterSpacing: "0.12em",
          }}
        >
          NEW CHAT
        </span>
        <span style={{ flex: 1 }} />
        {ENGINE_MODEL_CHOICES.map((m) => {
          const on = m.value === model;
          return (
            <button
              key={m.value}
              onClick={() => setModel(m.value)}
              className="mono"
              style={{
                fontSize: 10.5,
                color: on ? tokens.accent : tokens.textMuted,
                border: `1px solid ${on ? tokens.accent : tokens.border}`,
                background: on ? tokens.primaryActionBg : "transparent",
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              {m.label}
            </button>
          );
        })}
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          className="mono"
          title="Reasoning effort"
          style={{
            fontSize: 10.5,
            color: tokens.textMuted,
            border: `1px solid ${tokens.border}`,
            background: tokens.bgCard,
            borderRadius: 6,
            padding: "4px 8px",
            cursor: "pointer",
          }}
        >
          {ENGINE_EFFORT_CHOICES.map((e) => (
            <option key={e} value={e}>
              {e} effort
            </option>
          ))}
        </select>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="optional title (auto from first line if blank)"
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 12px",
          color: tokens.text,
          fontSize: 13,
          outline: "none",
        }}
      />
      <AttachmentChips
        attachments={att.attachments}
        uploading={att.uploading}
        uploadError={att.uploadError}
        onRemove={att.remove}
      />
      <div style={{ position: "relative", flex: 1, display: "flex" }}>
        <HiddenFileInput fileInputRef={att.fileInputRef} addFiles={att.addFiles} />
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            // v1.6: Enter dispatches, Shift+Enter newline. Skip during IME composition.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              canCreate
            ) {
              e.preventDefault();
              create();
            }
          }}
          placeholder="what's the task?  Enter to dispatch · drop/paste files · Shift+Enter newline"
          rows={10}
          style={{
            flex: 1,
            resize: "none",
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: "12px 14px",
            color: tokens.text,
            fontSize: 13,
            fontFamily: "Inter, system-ui",
            lineHeight: 1.55,
            outline: "none",
          }}
        />
        {prompt.trim().length === 0 && att.attachments.length === 0 && (
          <button
            onClick={att.openPicker}
            title="Attach files or images"
            className="mono"
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 56,
              height: 56,
              borderRadius: "50%",
              border: `1px solid ${tokens.border}`,
              background: tokens.bgCard,
              color: tokens.textMuted,
              fontSize: 26,
              lineHeight: 1,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            +
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={onCancel}
          className="mono"
          style={{
            fontSize: 11.5,
            color: tokens.textMuted,
            background: "transparent",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            padding: "9px 14px",
            cursor: "pointer",
          }}
        >
          cancel
        </button>
        <button
          disabled={!canCreate || isCreating}
          onClick={create}
          className="mono"
          style={{
            fontSize: 11.5,
            color: canCreate ? tokens.accent : tokens.textFaint,
            background: canCreate ? tokens.primaryActionBg : "transparent",
            border: `1px solid ${canCreate ? tokens.accent : tokens.border}`,
            borderRadius: 6,
            padding: "9px 14px",
            cursor: canCreate ? "pointer" : "not-allowed",
          }}
        >
          {isCreating ? "creating…" : "dispatch"}
        </button>
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.textFaint,
            marginLeft: "auto",
          }}
        >
          queued · executor will pick this up
        </span>
      </div>
    </div>
  );
}
