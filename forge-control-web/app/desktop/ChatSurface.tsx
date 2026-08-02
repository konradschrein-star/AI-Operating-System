"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchChatList,
  fetchChat,
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
  attachmentsBlock,
  fetchProjectBoard,
  type ProjectTaskWithProject,
  type TaskRole,
  type RunDetail,
  type RunStatus,
  type RunSummary,
} from "../api";
import { useAttachments, AttachmentChips, HiddenFileInput } from "./chat/useAttachments";
import { FileExplorerPanel } from "./chat/FileExplorerPanel";
import { SlashPopover, type SlashPopoverHandle } from "./chat/SlashPopover";
import {
  findSlash,
  parseSlash,
  type SlashContext,
  type SlashDirective,
  type SurfaceKey,
} from "./chat/slash-registry";
import { AgentActivity } from "./live/AgentActivity";
import { AssistantThread } from "./chat/AssistantThread";
import { CanvasPane } from "./CanvasPane";
import { useRunEvents } from "./chat/useRunEvents";

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

const ROLE_LABEL: Record<TaskRole, string> = {
  architect: "architect",
  planner: "planner",
  scout: "scout",
  builder: "builder",
  reviewer: "reviewer",
};

const ROLE_COLOR: Record<TaskRole, string> = {
  architect: tokens.decide,
  planner: tokens.info,
  scout: tokens.textMuted,
  builder: tokens.accent,
  reviewer: tokens.warn,
};

const TASK_STATUS_COLOR: Record<string, string> = {
  pending: tokens.textFaint,
  ready: tokens.info,
  running: tokens.accent,
  done: tokens.ok,
  failed: tokens.bleed,
  blocked: tokens.warn,
};

/** Live "what's the plan, what's it doing right now" sidebar — every active
 *  project's tasks, shares the same query cache as ProjectsSurface's board
 *  so opening both doesn't double-poll. Clicking a task with a run just
 *  opens that run in the same chat pane (a project task IS an ordinary
 *  `runs` row) — that's the "interact with them directly" part, reusing
 *  the exact send/thread machinery already built for regular chats. */
/** Just the task-list body — SidePanel owns the collapse/tab chrome around it. */
function LiveProjectsBody({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const boardQ = useQuery({
    queryKey: ["projects", "board"],
    queryFn: fetchProjectBoard,
    refetchInterval: 6_000,
  });
  const tasks = boardQ.data ?? [];

  const byProject = new Map<string, { name: string; tasks: ProjectTaskWithProject[] }>();
  for (const t of tasks) {
    if (!byProject.has(t.project_id)) {
      byProject.set(t.project_id, { name: t.project_name, tasks: [] });
    }
    byProject.get(t.project_id)!.tasks.push(t);
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
        }}
      >
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {tasks.filter((t) => t.status === "running").length} running
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 8px" }}>
        {byProject.size === 0 && (
          <div
            className="mono"
            style={{
              padding: "24px 8px",
              fontSize: 10.5,
              color: tokens.textFaint,
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            no active projects — the manager hasn't kicked one off yet
          </div>
        )}
        {[...byProject.entries()].map(([projectId, p]) => (
          <div key={projectId} style={{ marginBottom: 14 }}>
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
                marginBottom: 6,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={p.name}
            >
              {p.name}
            </div>
            {p.tasks
              .sort((a, b) => a.round - b.round)
              .map((t) => {
                const clickable = !!t.run_id;
                return (
                  <div
                    key={t.id}
                    onClick={() => clickable && onOpenRun(t.run_id!)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 6px",
                      borderRadius: 6,
                      cursor: clickable ? "pointer" : "default",
                      opacity: clickable ? 1 : 0.55,
                    }}
                    onMouseEnter={(e) => {
                      if (clickable) e.currentTarget.style.background = tokens.bgCard;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={dot(TASK_STATUS_COLOR[t.status] ?? tokens.textFaint)} />
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: ROLE_COLOR[t.role], flex: "none" }}
                    >
                      {ROLE_LABEL[t.role]}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: tokens.textMuted,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                      title={t.title}
                    >
                      {t.title}
                    </span>
                    {t.tier && (
                      <span
                        className="mono"
                        style={{ fontSize: 9, color: tokens.textFaint, flex: "none" }}
                      >
                        {t.tier}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </>
  );
}

/** Collapsible right-hand panel with two tabs: Live (project/task board) and
 *  Files (VPS explorer). Owns collapse state; each tab's body is a plain
 *  component with no chrome of its own. */
function SidePanel({
  collapsed,
  onToggle,
  tab,
  onTab,
  onOpenRun,
  fileAtt,
}: {
  collapsed: boolean;
  onToggle: () => void;
  tab: "live" | "files";
  onTab: (t: "live" | "files") => void;
  onOpenRun: (runId: string) => void;
  fileAtt: ReturnType<typeof useAttachments> | null;
}) {
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
            onTab("live");
            onToggle();
          }}
          title="Show live projects panel"
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
          ● LIVE
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
    <div
      style={{
        width: tab === "files" ? 420 : 260,
        flex: "none",
        borderLeft: `1px solid ${tokens.borderSoft}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
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
        {(["live", "files"] as const).map((t) => (
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
            {t === "live" ? "Live" : "Files"}
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
        {tab === "live" ? (
          // Agent activity on top (who is working, for how long, tokens/cost,
          // with in-process subagents nested under their parent run), the
          // project/task board underneath. The board alone never showed
          // subagents, which is why running work looked like nothing at all.
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                flex: "1 1 55%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                borderBottom: `1px solid ${tokens.border}`,
              }}
            >
              <AgentActivity />
            </div>
            <div style={{ flex: "1 1 45%", minHeight: 0, display: "flex", flexDirection: "column" }}>
              <LiveProjectsBody onOpenRun={onOpenRun} />
            </div>
          </div>
        ) : (
          <FileExplorerPanel onAttach={fileAtt ? fileAtt.addExisting : null} />
        )}
      </div>
    </div>
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
    refetchInterval: 8000,
  });
  const [selId, setSelId] = useState<string | null>(null);
  /** Chat we were on before drilling into an agent run from the Live panel. */
  const [agentViewFrom, setAgentViewFrom] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
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

  // An "agent view" is any run that isn't in the chat rail — i.e. a project
  // task or sub-run. Derived rather than stored so it stays true even after a
  // reload or if the rail list changes underneath us.
  const isAgentView =
    !!selId && !(listQ.data?.runs ?? []).some((r) => r.id === selId);

  const [panelTab, setPanelTab] = useState<"live" | "files">("live");
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
      setSelId(listQ.data!.runs[0].id);
    }
  }, [listQ.data, selId]);

  // v2.0: SSE stream is the primary sync path; the query interval is only
  // a safety net (tight when the stream is down, lazy when it's live).
  const { live } = useRunEvents(selId, !composing);
  const detailQ = useQuery({
    queryKey: ["chat", "run", selId],
    queryFn: () => fetchChat(selId!),
    enabled: !!selId && !composing,
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
      setSelId(run.id);
      setComposing(false);
    },
  });

  const sendM = useMutation({
    mutationFn: (input: { id: string; content: string }) =>
      sendChatMessage(input.id, input.content),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  const statusM = useMutation({
    mutationFn: (input: { id: string; status: RunStatus }) =>
      setChatStatus(input.id, input.status),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  const resumeM = useMutation({
    mutationFn: (id: string) => resumeChat(id),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  // Close = archive. Stops the underlying agent first (if it's still
  // queued/running/paused/stuck — same mechanism as the Cancel button, so
  // the executor kills the claude-code process within ~5s) then hides the
  // chat from the rail. Logs stay in the DB and stay searchable.
  const archiveM = useMutation({
    mutationFn: (id: string) => archiveChat(id),
    onSuccess: (_run, id) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      if (selId === id) setSelId(null);
    },
  });
  const archiveAllM = useMutation({
    mutationFn: () => archiveAllChats(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      setSelId(null);
    },
  });

  const counts = listQ.data?.counts ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — chat list */}
      <div
        style={{
          width: 300,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
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
              setSelId(null);
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
              {!searchQ.isLoading && (searchQ.data?.length ?? 0) === 0 && (
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
                    setSelId(r.id);
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
              {!listQ.isLoading && (listQ.data?.runs.length ?? 0) === 0 && (
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
                    setSelId(r.id);
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

      {/* Right pane — thread/composer, optionally split with the canvas */}
      <div
        style={{
          flex: canvasOpen ? "1 1 55%" : 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          position: "relative",
        }}
      >
        {/* Escape hatch from an agent run. Agent/task runs never appear in the
            chat rail, so once you drill into one there's no selected row to
            click back to — this is the only way out. */}
        {isAgentView && (
          <button
            onClick={() => {
              setSelId(agentViewFrom);
              setAgentViewFrom(null);
            }}
            className="mono"
            title="Back to your chats"
            style={{
              position: "absolute",
              top: 8,
              left: 10,
              zIndex: 3,
              fontSize: 10,
              letterSpacing: "0.06em",
              padding: "4px 9px",
              borderRadius: 6,
              cursor: "pointer",
              color: tokens.accent,
              background: tokens.bgCard,
              border: `1px solid ${tokens.accent}`,
            }}
          >
            ← agent view · back
          </button>
        )}
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
        ) : detailQ.data ? (
          <ChatThread
            key={detailQ.data.id}
            run={detailQ.data}
            live={live}
            onSend={(content) =>
              sendM.mutate({ id: detailQ.data!.id, content })
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
        <div style={{ flex: "1 1 45%", minWidth: 320, display: "flex", minHeight: 0 }}>
          <CanvasPane
            path={canvasPath}
            onPathChange={setCanvasPath}
            onClose={() => setCanvasOpen(false)}
          />
        </div>
      )}

      <SidePanel
        collapsed={panelCollapsed}
        onToggle={() => setPanelCollapsed((c) => !c)}
        tab={panelTab}
        onTab={setPanelTab}
        onOpenRun={(runId) => {
          setComposing(false);
          // Remember where we came from. An agent/task run is NOT in the chat
          // rail (the rail is conversations only), so without this there is
          // literally nothing to click to get back out of it.
          setAgentViewFrom(selId);
          setSelId(runId);
        }}
        fileAtt={composing ? null : threadAtt}
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
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        <span style={{ flex: 1 }} />
        {hover ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (!closing) onClose();
            }}
            title="Close this chat — stops the agent if it's still working, and hides it from the list. Nothing is deleted; it stays searchable."
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.bleed,
              cursor: closing ? "wait" : "pointer",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            ✕
          </span>
        ) : (
          <span
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textFaint }}
          >
            {humanAge(run.updated_at)}
          </span>
        )}
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
        {modelLabel} · {effort} ▾
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
              {ENGINE_EFFORT_CHOICES.map((e) => {
                const on = e === effort;
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
                      color: on ? tokens.accent : tokens.textMuted,
                      border: `1px solid ${on ? tokens.accent : tokens.border}`,
                      background: on ? tokens.primaryActionBg : "transparent",
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
}) {
  const [draft, setDraft] = useState("");
  const [localSys, setLocalSys] = useState<
    Array<{ text: string; ts: string }>
  >([]);
  const popoverRef = useRef<SlashPopoverHandle | null>(null);

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
  const engine = String(run.metadata?.engine ?? "claude-code");
  const model = String(run.metadata?.model ?? DEFAULT_ENGINE_MODEL);

  return (
    <>
      <div
        style={{
          padding: "12px 18px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={dot(color, run.status === "running")} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: tokens.textHi,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {run.title}
          </div>
          <div
            className="mono"
            style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}
          >
            {run.status} · {engine} · {model} · spent ${run.spent_usd} / cap $
            {run.budget_usd} ·{" "}
            <span style={{ color: live ? tokens.ok : tokens.warn }}>
              {live ? "live" : "polling"}
            </span>
          </div>
        </div>
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
                background: "rgba(79, 176, 196, 0.06)",
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
            rows={2}
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
              outline: "none",
            }}
          />
          <EngineControls run={run} />
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
