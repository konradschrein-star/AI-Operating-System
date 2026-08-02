"use client";

/**
 * Coding projects — the Kanban board for "manage more coding agents at
 * once" (2026-07-08 design). Columns are the 5 agent roles (architect,
 * planner, scout, builder, reviewer) plus Done; every card is a
 * project_task, and every task with a run_id is — under the hood — a
 * completely ordinary `runs` row. Clicking a card reuses the exact same
 * AssistantThread/useRunEvents machinery ChatSurface uses for live-
 * streaming chat, because that's literally what it is.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchProjectBoard,
  fetchProjects,
  fetchChat,
  createProject,
  setProjectStatus,
  sendChatMessage,
  PROJECT_REPO_OPTIONS,
  type Project,
  type ProjectRepo,
  type ProjectTaskWithProject,
  type TaskRole,
  type TaskStatus,
  type RunDetail,
} from "../api";
import { useRunEvents } from "./chat/useRunEvents";
import { AssistantThread } from "./chat/AssistantThread";

const ROLES: TaskRole[] = ["architect", "planner", "scout", "builder", "reviewer"];

const ROLE_LABEL: Record<TaskRole, string> = {
  architect: "Architect",
  planner: "Planner",
  scout: "Scout",
  builder: "Builder",
  reviewer: "Reviewer",
};

const ROLE_COLOR: Record<TaskRole, string> = {
  architect: tokens.decide,
  planner: tokens.info,
  scout: tokens.textMuted,
  builder: tokens.accent,
  reviewer: tokens.warn,
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: tokens.textFaint,
  ready: tokens.info,
  running: tokens.accent,
  done: tokens.ok,
  failed: tokens.bleed,
  blocked: tokens.warn,
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

export function ProjectsSurface() {
  const qc = useQueryClient();
  const boardQ = useQuery({
    queryKey: ["projects", "board"],
    queryFn: fetchProjectBoard,
    refetchInterval: 6_000,
  });
  const projectsQ = useQuery({
    queryKey: ["projects", "list"],
    queryFn: fetchProjects,
    refetchInterval: 15_000,
  });

  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [selTaskId, setSelTaskId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [viewMode, setViewMode] = useState<"board" | "floor">("board");

  const createM = useMutation({
    mutationFn: (input: { name: string; brief: string; repo: ProjectRepo }) =>
      createProject(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setComposing(false);
    },
  });

  const cancelM = useMutation({
    mutationFn: (id: string) => setProjectStatus(id, "cancelled"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const tasks = boardQ.data ?? [];
  const filtered = useMemo(
    () =>
      projectFilter
        ? tasks.filter((t) => t.project_id === projectFilter)
        : tasks,
    [tasks, projectFilter],
  );
  const columns = useMemo(() => {
    const byRole = new Map<TaskRole, ProjectTaskWithProject[]>(
      ROLES.map((r) => [r, []]),
    );
    const done: ProjectTaskWithProject[] = [];
    for (const t of filtered) {
      if (t.status === "done") done.push(t);
      else byRole.get(t.role)?.push(t);
    }
    return { byRole, done };
  }, [filtered]);

  const runningTasks = useMemo(
    () => filtered.filter((t) => t.status === "running" && t.run_id),
    [filtered],
  );

  const selTask = tasks.find((t) => t.id === selTaskId) ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — projects */}
      <div
        style={{
          width: 240,
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
            Projects
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setComposing(true)}
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
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div
            onClick={() => setProjectFilter(null)}
            style={{
              padding: "10px 14px",
              cursor: "pointer",
              borderLeft: `2px solid ${!projectFilter ? tokens.accent : "transparent"}`,
              background: !projectFilter ? tokens.selectedBg : "transparent",
              fontSize: 12,
              color: !projectFilter ? tokens.text : tokens.textMuted,
            }}
          >
            all active · {tasks.length} tasks
          </div>
          {(projectsQ.data ?? [])
            .filter((p) => p.status !== "done" && p.status !== "cancelled")
            .map((p) => (
              <ProjectListItem
                key={p.id}
                project={p}
                selected={p.id === projectFilter}
                onSelect={() => setProjectFilter(p.id)}
                onCancel={() => cancelM.mutate(p.id)}
              />
            ))}
          {(projectsQ.data ?? []).length === 0 && (
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
              no projects yet.
              <br />
              hit “+ new” to start one.
            </div>
          )}
        </div>
      </div>

      {/* Main — Kanban or task detail */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {composing ? (
          <NewProject
            isCreating={createM.isPending}
            error={createM.error instanceof Error ? createM.error.message : null}
            onCancel={() => setComposing(false)}
            onCreate={(name, brief, repo) => createM.mutate({ name, brief, repo })}
          />
        ) : selTask ? (
          <TaskDetail task={selTask} onClose={() => setSelTaskId(null)} />
        ) : (
          <>
            <div
              style={{
                padding: "12px 22px",
                borderBottom: `1px solid ${tokens.borderSoft}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
                Projects
              </span>
              <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
                {viewMode === "board"
                  ? `architect → builder(s) → reviewer, fix cycles loop back through review · ${filtered.length} tasks`
                  : `${runningTasks.length} agent(s) working right now`}
              </span>
              <span style={{ flex: 1 }} />
              <div
                style={{
                  display: "flex",
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 7,
                  overflow: "hidden",
                }}
              >
                {(["board", "floor"] as const).map((m) => (
                  <span
                    key={m}
                    onClick={() => setViewMode(m)}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: "5px 12px",
                      cursor: "pointer",
                      color: viewMode === m ? tokens.accent : tokens.textMuted,
                      background: viewMode === m ? tokens.primaryActionBg : "transparent",
                    }}
                  >
                    {m === "board" ? "board" : "floor"}
                  </span>
                ))}
              </div>
            </div>
            {viewMode === "board" ? (
              <div
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "stretch",
                }}
              >
                {boardQ.isLoading && (
                  <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, padding: 16 }}>
                    loading board…
                  </div>
                )}
                {ROLES.map((role) => (
                  <RoleColumn
                    key={role}
                    role={role}
                    tasks={columns.byRole.get(role) ?? []}
                    onSelect={setSelTaskId}
                  />
                ))}
                <DoneColumn tasks={columns.done} onSelect={setSelTaskId} />
              </div>
            ) : (
              <FloorGrid tasks={runningTasks} onExpand={setSelTaskId} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProjectListItem({
  project,
  selected,
  onSelect,
  onCancel,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
  onCancel: () => void;
}) {
  const color =
    project.status === "blocked" ? tokens.warn : project.status === "paused" ? tokens.textFaint : tokens.ok;
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "10px 14px",
        cursor: "pointer",
        borderLeft: `2px solid ${selected ? tokens.accent : "transparent"}`,
        background: selected ? tokens.selectedBg : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={dot(color, project.status === "active")} />
        <span
          style={{
            fontSize: 12.5,
            color: selected ? tokens.text : tokens.textLabel,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {project.name}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Cancel project "${project.name}"? This removes its git worktree.`)) onCancel();
          }}
          className="mono"
          style={{ fontSize: 10, color: tokens.textFaint, cursor: "pointer" }}
        >
          ×
        </span>
      </div>
      <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 3, marginLeft: 13 }}>
        {project.repo} · {project.status}
      </div>
    </div>
  );
}

function RoleColumn({
  role,
  tasks,
  onSelect,
}: {
  role: TaskRole;
  tasks: ProjectTaskWithProject[];
  onSelect: (id: string) => void;
}) {
  const color = ROLE_COLOR[role];
  return (
    <div
      style={{
        width: 240,
        flex: "none",
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: "100%",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 4, height: 14, background: color, borderRadius: 2 }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: tokens.textHi }}>
          {ROLE_LABEL[role]}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {tasks.length}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
        {tasks.length === 0 && (
          <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, textAlign: "center", padding: 14 }}>
            —
          </div>
        )}
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onSelect={() => onSelect(t.id)} />
        ))}
      </div>
    </div>
  );
}

function DoneColumn({
  tasks,
  onSelect,
}: {
  tasks: ProjectTaskWithProject[];
  onSelect: (id: string) => void;
}) {
  return (
    <div
      style={{
        width: 220,
        flex: "none",
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: "100%",
        opacity: 0.85,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 4, height: 14, background: tokens.ok, borderRadius: 2 }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: tokens.textHi }}>Done</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {tasks.length}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 7 }}>
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onSelect={() => onSelect(t.id)} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onSelect,
}: {
  task: ProjectTaskWithProject;
  onSelect: () => void;
}) {
  const color = STATUS_COLOR[task.status];
  return (
    <div
      onClick={onSelect}
      style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${tokens.borderSoft}`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 8,
        padding: "9px 11px",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={dot(color, task.status === "running")} />
        <span className="mono" style={{ fontSize: 9, color, letterSpacing: "0.05em" }}>
          {task.status}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
          r{task.round}{task.fix_cycle > 0 ? ` · fix ${task.fix_cycle}` : ""}
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          color: tokens.textLabel,
          marginTop: 5,
          lineHeight: 1.4,
        }}
      >
        {task.title}
      </div>
      <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 4 }}>
        {task.project_name} · {humanAge(task.updated_at)}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Floor — the "factory floor" view: every currently-running agent as a live
 * mini-terminal, all visible at once. Each tile is its own SSE subscription
 * (same mechanism as the chat thread, just N of them) so you watch the
 * whole swarm churn instead of clicking into one agent at a time.
 * -------------------------------------------------------------------------- */
function FloorGrid({
  tasks,
  onExpand,
}: {
  tasks: ProjectTaskWithProject[];
  onExpand: (id: string) => void;
}) {
  if (tasks.length === 0) {
    return (
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
        nobody's working right now — the floor is quiet.
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        padding: 14,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: 12,
        alignContent: "start",
      }}
    >
      {tasks.map((t) => (
        <FloorTile key={t.id} task={t} onExpand={() => onExpand(t.id)} />
      ))}
    </div>
  );
}

function floorLine(e: RunDetail["thread"][number]): {
  prefix: string;
  color: string;
  text: string;
} {
  const text = String(e.content ?? "").replace(/\s+/g, " ").trim();
  if (e.kind === "tool_call") return { prefix: "$", color: tokens.textMuted, text };
  if (e.kind === "tool_result") return { prefix: " ", color: tokens.textFaint, text };
  if (e.role === "assistant") return { prefix: "»", color: tokens.textLabel, text };
  if (e.role === "user") return { prefix: ">", color: tokens.accent, text };
  return { prefix: "·", color: tokens.textFaint, text };
}

function FloorTile({
  task,
  onExpand,
}: {
  task: ProjectTaskWithProject;
  onExpand: () => void;
}) {
  const runId = task.run_id!;
  const { live } = useRunEvents(runId, true);
  const runQ = useQuery({
    queryKey: ["chat", "run", runId],
    queryFn: () => fetchChat(runId),
    refetchInterval: live ? 20_000 : 3_000,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const thread = runQ.data?.thread ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length]);

  const color = ROLE_COLOR[task.role];
  const tail = thread.slice(-9);

  return (
    <div
      onClick={onExpand}
      style={{
        background: "#0b0b0d",
        border: `1px solid ${tokens.border}`,
        borderTop: `2px solid ${color}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        height: 210,
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          alignItems: "center",
          gap: 7,
          flex: "none",
        }}
      >
        <span style={dot(live ? tokens.ok : tokens.warn, live)} />
        <span className="mono" style={{ fontSize: 9.5, color, letterSpacing: "0.05em" }}>
          {ROLE_LABEL[task.role].toUpperCase()}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: tokens.textLabel,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.project_name} · {task.title}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="mono"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 10px",
          fontSize: 10.5,
          lineHeight: 1.55,
        }}
      >
        {tail.length === 0 && (
          <div style={{ color: tokens.textFaint }}>waiting for first output…</div>
        )}
        {tail.map((e, i) => {
          const l = floorLine(e);
          return (
            <div
              key={i}
              style={{
                color: l.color,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              <span style={{ opacity: 0.6, marginRight: 5 }}>{l.prefix}</span>
              {l.text.slice(0, 140)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  onClose,
}: {
  task: ProjectTaskWithProject;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const runId = task.run_id;
  const { live } = useRunEvents(runId, !!runId);
  const runQ = useQuery({
    queryKey: ["chat", "run", runId],
    queryFn: () => fetchChat(runId!),
    enabled: !!runId,
    refetchInterval: live ? 20_000 : 3_000,
  });
  const [draft, setDraft] = useState("");
  const sendM = useMutation({
    mutationFn: (content: string) => sendChatMessage(runId!, content),
    onSuccess: (run) => qc.setQueryData(["chat", "run", run.id], run),
  });

  const send = () => {
    const v = draft.trim();
    if (!v || !runId) return;
    sendM.mutate(v);
    setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          padding: "12px 18px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          onClick={onClose}
          className="mono"
          style={{ fontSize: 12, color: tokens.textMuted, cursor: "pointer" }}
        >
          ← board
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: tokens.textHi }}>
            {task.project_name} · {task.title}
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}>
            {ROLE_LABEL[task.role]} · round {task.round} · {task.status}
            {runId && <span style={{ color: live ? tokens.ok : tokens.warn }}> · {live ? "live" : "polling"}</span>}
          </div>
        </div>
      </div>
      {runQ.data ? (
        <>
          <AssistantThread run={runQ.data} />
          <div
            style={{
              borderTop: `1px solid ${tokens.borderSoft}`,
              padding: "8px 18px 12px",
              display: "flex",
              gap: 10,
              alignItems: "flex-end",
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="nudge this agent · Enter to send · Shift+Enter newline"
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
            <button
              disabled={sendM.isPending || draft.trim().length === 0}
              onClick={send}
              className="mono"
              style={{
                fontSize: 11.5,
                color: draft.trim().length === 0 ? tokens.textFaint : tokens.accent,
                border: `1px solid ${draft.trim().length === 0 ? tokens.border : tokens.accent}`,
                background: draft.trim().length === 0 ? "transparent" : tokens.primaryActionBg,
                borderRadius: 6,
                padding: "10px 14px",
                cursor: sendM.isPending || draft.trim().length === 0 ? "not-allowed" : "pointer",
              }}
            >
              {sendM.isPending ? "…" : "send"}
            </button>
          </div>
        </>
      ) : (
        <div style={{ padding: "24px 28px" }}>
          <div className="mono" style={{ fontSize: 11, color: tokens.textFaint, marginBottom: 12 }}>
            {runId ? "loading run…" : "not started yet — waiting on an earlier round to finish"}
          </div>
          <div style={{ fontSize: 13, color: tokens.textSecondary, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {task.brief}
          </div>
        </div>
      )}
    </div>
  );
}

function NewProject({
  onCancel,
  onCreate,
  isCreating,
  error,
}: {
  onCancel: () => void;
  onCreate: (name: string, brief: string, repo: ProjectRepo) => void;
  isCreating: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [repo, setRepo] = useState<ProjectRepo>(PROJECT_REPO_OPTIONS[0]);
  const canCreate = name.trim().length > 0 && brief.trim().length > 0;

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="mono" style={{ fontSize: 10, color: tokens.accent, letterSpacing: "0.12em" }}>
          NEW PROJECT
        </span>
        <span style={{ flex: 1 }} />
        {PROJECT_REPO_OPTIONS.map((r) => {
          const on = r === repo;
          return (
            <button
              key={r}
              onClick={() => setRepo(r)}
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
              {r}
            </button>
          );
        })}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="project name"
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
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="what should the architect build? be specific — this is the whole brief."
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
      {error && (
        <div className="mono" style={{ fontSize: 11, color: tokens.bleed }}>
          {error}
        </div>
      )}
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
          onClick={() => onCreate(name.trim(), brief.trim(), repo)}
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
          {isCreating ? "creating…" : "spin up architect"}
        </button>
        <span className="mono" style={{ fontSize: 10.5, color: tokens.textFaint, marginLeft: "auto" }}>
          provisions a git worktree, then the architect starts planning
        </span>
      </div>
    </div>
  );
}
