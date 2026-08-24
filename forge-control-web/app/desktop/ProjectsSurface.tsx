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
  fetchProjects,
  fetchChatDelta,
  createProject,
  setProjectStatus,
  sendChatMessage,
  PROJECT_REPO_OPTIONS,
  type Project,
  type ProjectRepo,
  type TaskStatus,
  type RunDetail,
} from "../api";
/* The board feed and the on-demand brief live in this lane's own client file
 * (02-architecture.md §0.3). `ProjectBoardTask` is `ProjectTaskWithProject`
 * WITHOUT `brief`, which is the whole phase-6 fix: the column was 88.2% of a
 * 1.8 MB response polled every 6 s and no card renders it. */
import {
  fetchProjectBoardCards,
  fetchTaskBrief,
  type ProjectBoardTask,
} from "../api-perf";
import { useRunEvents } from "./chat/useRunEvents";
import { AssistantThread } from "./chat/AssistantThread";
import {
  CHAT_DETAIL_FALLBACK_POLL_MS,
  CHAT_DETAIL_LIVE_POLL_MS,
} from "./chat/pollBudget";
/* Opening a card's chat on the CHAT surface goes through the shared helper
 * rather than a second copy of the same three localStorage writes — see the
 * note above `navigateToChat`. It arrived on main in the autonomy lane and
 * `scripts/checks/check-deep-link.ts` is its executable contract. */
import { jumpToRun } from "./deep-link";

export type TaskRole =
  | "architect"
  | "planner"
  | "scout"
  | "researcher"
  | "builder"
  | "reviewer"
  | "steward"
  | "tester";

const ROLES: TaskRole[] = [
  "architect",
  "planner",
  "scout",
  "researcher",
  "builder",
  "reviewer",
  "steward",
  "tester",
];

const ROLE_LABEL: Record<TaskRole, string> = {
  architect: "Architect",
  planner: "Planner",
  scout: "Scout",
  researcher: "Researcher",
  builder: "Builder",
  reviewer: "Reviewer",
  steward: "Steward",
  tester: "Tester",
};

const ROLE_COLOR: Record<TaskRole, string> = {
  architect: tokens.roleInkArchitect,
  planner: tokens.roleInkPlanner,
  scout: tokens.roleInkScout,
  researcher: tokens.roleInkResearcher,
  builder: tokens.roleInkBuilder,
  reviewer: tokens.roleInkReviewer,
  steward: tokens.roleInkSteward,
  tester: tokens.roleInkTester,
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: tokens.textFaint,
  ready: tokens.info,
  running: tokens.accent,
  done: tokens.ok,
  failed: tokens.bleed,
  blocked: tokens.warn,
  // Retired on purpose (0046_task_status_cancelled.sql). `textMuted2` rather
  // than `textFaint`: a cancelled row must not wear `pending`'s colour, because
  // the two say opposite things about whether the board still owes you that
  // work — and this map is exhaustive over TaskStatus, so it is the one place
  // that has to answer.
  cancelled: tokens.textMuted2,
};

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  blocked: 1,
  paused: 2,
  done: 3,
  cancelled: 4,
};

/**
 * A row of GET /projects/managers. The endpoint also returns a currency figure
 * per project; it is deliberately NOT declared here. Konrad runs on the
 * subscription, not API billing, so a rendered cost is noise he rejected —
 * scripts/checks/dollar-sweep.sh is the gate that keeps it out of every
 * surface except Money. Progress and recency are what this rail shows instead.
 */
export interface ManagerRollupRow {
  project_id: string;
  name: string;
  status: string;
  mode: string | null;
  tasks_done: number;
  tasks_total: number;
  tokens_in: number;
  tokens_out: number;
  last_activity_at: string | null;
}

/** Rail date filter — "touched within the last …". */
type DateFilter = "all" | "24h" | "7d" | "30d";

const DATE_FILTER_MS: Record<Exclude<DateFilter, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
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

export function ProjectsSurface({
  onNavigate,
}: {
  /* Required, not optional: without it a card click has nowhere to go, and a
   * silently-ignored jump is the defect `deep-link.ts` exists to remove.
   * `DesktopApp` is the only caller (DesktopApp.tsx:404) and always passes it. */
  onNavigate: (surface: string) => void;
}) {
  const qc = useQueryClient();
  const boardQ = useQuery({
    queryKey: ["projects", "board"],
    queryFn: fetchProjectBoardCards,
    refetchInterval: 6_000,
  });
  const projectsQ = useQuery({
    queryKey: ["projects", "list"],
    queryFn: fetchProjects,
    refetchInterval: 15_000,
  });
  const managersQ = useQuery({
    queryKey: ["projects", "managers"],
    queryFn: async () => {
      const res = await fetch("/api/proxy/projects/managers", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} on /projects/managers`);
      const data = (await res.json()) as { managers: ManagerRollupRow[] };
      return data.managers;
    },
    refetchInterval: 10_000,
  });

  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [selTaskId, setSelTaskId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [viewMode, setViewMode] = useState<"board" | "floor">("board");
  const [doneExpanded, setDoneExpanded] = useState(false);

  // Left rail search & filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "done" | "paused">("all");
  const [repoFilter, setRepoFilter] = useState<"all" | "ai-os" | "content-forge" | "scratch">("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");

  // Main board task search
  const [taskSearchQuery, setTaskSearchQuery] = useState("");

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

  /* Konrad's complaint: "if I click on one of the chats it shouldn't be
   * opening up in the project chat, it should open up in the chat section."
   * The first version of this wrote the two keys here by hand. Main has since
   * landed `deep-link.ts` for exactly this jump, and it is stricter in three
   * ways this copy was not: it rejects a value that is not a run uuid before
   * it can reach `forge.chat.selected`, it clears `forge.chat.navStack` so a
   * drill-in stored against a DIFFERENT chat cannot claim that worker belongs
   * to the run being opened, and on a storage failure it refuses to navigate
   * instead of warning to the console and landing on the manager thread while
   * claiming to have opened the run. `jumpToRun` is the click-handler wrapper:
   * the failure becomes a toast naming the run, not an exception that takes
   * the board down. `forge.desktop.surface` is not written here any more —
   * `DesktopApp`'s `setSurface` is a `usePersistentState` on that same key
   * (DesktopApp.tsx:196), so the shell persists it. */
  const navigateToChat = (runId: string) => {
    jumpToRun(runId, onNavigate);
  };

  const tasks = boardQ.data ?? [];
  const allProjects = projectsQ.data ?? [];

  const managerMap = useMemo(() => {
    const map = new Map<string, ManagerRollupRow>();
    for (const m of managersQ.data ?? []) {
      map.set(m.project_id, m);
    }
    return map;
  }, [managersQ.data]);

  // Compute fallback task counts from board tasks per project
  const taskCountsByProject = useMemo(() => {
    const map = new Map<string, { total: number; done: number; active: number }>();
    for (const t of tasks) {
      const cur = map.get(t.project_id) ?? { total: 0, done: 0, active: 0 };
      cur.total++;
      if (t.status === "done") cur.done++;
      if (t.status === "running" || t.status === "ready" || t.status === "pending" || t.status === "blocked") {
        cur.active++;
      }
      map.set(t.project_id, cur);
    }
    return map;
  }, [tasks]);

  // 1. Sort projects by active status first (active > blocked > paused > done > cancelled, then updated_at DESC)
  const sortedProjects = useMemo(() => {
    return [...allProjects].sort((a, b) => {
      const orderA = STATUS_ORDER[a.status] ?? 99;
      const orderB = STATUS_ORDER[b.status] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      const timeA = new Date(a.updated_at || a.created_at).getTime() || 0;
      const timeB = new Date(b.updated_at || b.created_at).getTime() || 0;
      return timeB - timeA;
    });
  }, [allProjects]);

  // 2. Filter projects by search query, status filter, repo filter
  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sortedProjects.filter((p) => {
      if (statusFilter === "active" && p.status !== "active" && p.status !== "blocked") {
        return false;
      }
      if (statusFilter === "done" && p.status !== "done") {
        return false;
      }
      if (statusFilter === "paused" && p.status !== "paused") {
        return false;
      }
      if (repoFilter !== "all" && p.repo !== repoFilter) {
        return false;
      }
      if (dateFilter !== "all") {
        const touched = new Date(p.updated_at || p.created_at).getTime();
        // An unparseable timestamp must not silently vanish from a filtered
        // list — keep the project and let the row show its own age.
        if (!Number.isNaN(touched) && Date.now() - touched > DATE_FILTER_MS[dateFilter]) {
          return false;
        }
      }
      if (q) {
        const matchName = p.name.toLowerCase().includes(q);
        const matchBrief = (p.brief || "").toLowerCase().includes(q);
        const matchRepo = p.repo.toLowerCase().includes(q);
        const matchBranch = (p.work_branch || "").toLowerCase().includes(q);
        if (!matchName && !matchBrief && !matchRepo && !matchBranch) {
          return false;
        }
      }
      return true;
    });
  }, [sortedProjects, searchQuery, statusFilter, repoFilter, dateFilter]);

  // Filter tasks for Kanban board / Floor
  const filteredTasks = useMemo(() => {
    let list = projectFilter
      ? tasks.filter((t) => t.project_id === projectFilter)
      : tasks;
    if (taskSearchQuery.trim()) {
      const q = taskSearchQuery.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.project_name && t.project_name.toLowerCase().includes(q)) ||
          (t.role && t.role.toLowerCase().includes(q)) ||
          (t.status && t.status.toLowerCase().includes(q)) ||
          `r${t.round}`.includes(q) ||
          t.id.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tasks, projectFilter, taskSearchQuery]);

  // Distribute tasks across all 8 roles plus Done
  const columns = useMemo(() => {
    const byRole = new Map<TaskRole, ProjectBoardTask[]>(
      ROLES.map((r) => [r, []]),
    );
    const done: ProjectBoardTask[] = [];
    for (const t of filteredTasks) {
      if (t.status === "done") {
        done.push(t);
      } else {
        const role = t.role as TaskRole;
        if (byRole.has(role)) {
          byRole.get(role)!.push(t);
        } else {
          // Never drop a task with an unexpected role
          byRole.get("builder")?.push(t);
        }
      }
    }
    return { byRole, done };
  }, [filteredTasks]);

  const runningTasks = useMemo(
    () => filteredTasks.filter((t) => t.status === "running" && t.run_id),
    [filteredTasks],
  );

  const activeTasksCount = useMemo(() => {
    return tasks.filter(
      (t) =>
        t.status === "running" ||
        t.status === "ready" ||
        t.status === "blocked" ||
        t.status === "pending",
    ).length;
  }, [tasks]);

  const selTask = tasks.find((t) => t.id === selTaskId) ?? null;

  const selectedProject = useMemo(() => {
    return allProjects.find((p) => p.id === projectFilter) ?? null;
  }, [allProjects, projectFilter]);

  const selectedProjectManager = useMemo(() => {
    return projectFilter ? managerMap.get(projectFilter) ?? null : null;
  }, [projectFilter, managerMap]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — projects search, filter, and list */}
      <div
        style={{
          width: 260,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: tokens.bgBody,
        }}
      >
        {/* Rail Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px 8px",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
            Projects
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textMuted,
              background: tokens.toolBg,
              padding: "1px 5px",
              borderRadius: 4,
              border: `1px solid ${tokens.borderSoft}`,
            }}
          >
            {allProjects.length}
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
              padding: "3px 8px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 3,
            }}
            title="Create new coding project"
          >
            + new
          </button>
        </div>

        {/* Search bar */}
        <div style={{ padding: "0 10px 8px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: tokens.inputBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "4px 8px",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 11, color: tokens.textFaint }}>🔍</span>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="search projects…"
              className="mono"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                fontSize: 11,
                color: tokens.text,
                width: "100%",
              }}
            />
            {searchQuery && (
              <span
                onClick={() => setSearchQuery("")}
                style={{
                  fontSize: 11,
                  color: tokens.textFaint,
                  cursor: "pointer",
                  padding: "0 2px",
                }}
              >
                ×
              </span>
            )}
          </div>
        </div>

        {/* Filter controls: Status and Repo */}
        <div
          style={{
            padding: "0 10px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          {/* Status filter pills */}
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginRight: 2 }}>
              status:
            </span>
            {(["all", "active", "done", "paused"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className="mono"
                style={{
                  fontSize: 9.5,
                  padding: "2px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: `1px solid ${statusFilter === st ? tokens.accent : tokens.borderSoft}`,
                  background: statusFilter === st ? tokens.primaryActionBg : "transparent",
                  color: statusFilter === st ? tokens.accent : tokens.textMuted,
                }}
              >
                {st}
              </button>
            ))}
          </div>

          {/* Repo filter pills */}
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginRight: 2 }}>
              repo:
            </span>
            {(["all", "ai-os", "content-forge", "scratch"] as const).map((rp) => (
              <button
                key={rp}
                onClick={() => setRepoFilter(rp)}
                className="mono"
                style={{
                  fontSize: 9.5,
                  padding: "2px 5px",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: `1px solid ${repoFilter === rp ? tokens.accent : tokens.borderSoft}`,
                  background: repoFilter === rp ? tokens.primaryActionBg : "transparent",
                  color: repoFilter === rp ? tokens.accent : tokens.textMuted,
                  whiteSpace: "nowrap",
                }}
              >
                {rp === "content-forge" ? "cf" : rp}
              </button>
            ))}
          </div>

          {/* Date filter pills — "touched within the last …" */}
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginRight: 2 }}>
              seen:
            </span>
            {(["all", "24h", "7d", "30d"] as const).map((df) => (
              <button
                key={df}
                onClick={() => setDateFilter(df)}
                className="mono"
                title={
                  df === "all"
                    ? "any date"
                    : `only projects updated in the last ${df}`
                }
                style={{
                  fontSize: 9.5,
                  padding: "2px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: `1px solid ${dateFilter === df ? tokens.accent : tokens.borderSoft}`,
                  background: dateFilter === df ? tokens.primaryActionBg : "transparent",
                  color: dateFilter === df ? tokens.accent : tokens.textMuted,
                }}
              >
                {df}
              </button>
            ))}
          </div>
        </div>

        {/* Project list in Rail */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* All active projects selector */}
          <div
            onClick={() => setProjectFilter(null)}
            style={{
              padding: "9px 12px",
              cursor: "pointer",
              borderLeft: `2px solid ${!projectFilter ? tokens.accent : "transparent"}`,
              background: !projectFilter ? tokens.selectedBg : "transparent",
              fontSize: 12,
              color: !projectFilter ? tokens.textHi : tokens.textMuted,
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderBottom: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <span style={{ fontWeight: !projectFilter ? 600 : 400 }}>All Projects</span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: tokens.accent }}>
              {activeTasksCount} active
            </span>
          </div>

          {filteredProjects.map((p) => (
            <ProjectListItem
              key={p.id}
              project={p}
              selected={p.id === projectFilter}
              managerStats={managerMap.get(p.id)}
              taskCountStats={taskCountsByProject.get(p.id)}
              onSelect={() => setProjectFilter(p.id)}
              onCancel={() => cancelM.mutate(p.id)}
            />
          ))}

          {filteredProjects.length === 0 && (
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
              {allProjects.length === 0 ? (
                <>
                  no projects yet.
                  <br />
                  hit “+ new” to start one.
                </>
              ) : (
                <>no matching projects found.</>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main — Kanban board, floor or task detail */}
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
          <TaskDetail
            task={selTask}
            onClose={() => setSelTaskId(null)}
            onNavigateToChat={navigateToChat}
          />
        ) : (
          <>
            {/* Main Header Strip */}
            <div
              style={{
                padding: "10px 18px",
                borderBottom: `1px solid ${tokens.borderSoft}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
                  {selectedProject ? selectedProject.name : "Projects"}
                </span>
                {selectedProject && (
                  <>
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: tokens.textMuted,
                        background: tokens.toolBg,
                        padding: "1px 6px",
                        borderRadius: 4,
                        border: `1px solid ${tokens.borderSoft}`,
                      }}
                    >
                      {selectedProject.repo}
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color:
                          selectedProject.status === "active"
                            ? tokens.ok
                            : selectedProject.status === "blocked"
                            ? tokens.warn
                            : tokens.textFaint,
                        border: `1px solid ${tokens.borderSoft}`,
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {selectedProject.status}
                    </span>
                  </>
                )}
              </div>

              {/* Progress & last-activity badge */}
              <div className="mono" style={{ fontSize: 11, color: tokens.textSecondary, display: "flex", gap: 8 }}>
                {selectedProjectManager ? (
                  <>
                    <span>
                      {selectedProjectManager.tasks_done}/{selectedProjectManager.tasks_total} done
                    </span>
                    {selectedProjectManager.last_activity_at && (
                      <span
                        style={{ color: tokens.textFaint }}
                        title={`last activity ${new Date(selectedProjectManager.last_activity_at).toLocaleString()}`}
                      >
                        {humanAge(selectedProjectManager.last_activity_at)} ago
                      </span>
                    )}
                  </>
                ) : (
                  <span>{filteredTasks.length} tasks</span>
                )}
                <span>·</span>
                <span style={{ color: runningTasks.length > 0 ? tokens.ok : tokens.textFaint }}>
                  {runningTasks.length} running
                </span>
              </div>

              <span style={{ flex: 1 }} />

              {/* Task search on the board */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: tokens.inputBg,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  padding: "3px 8px",
                  gap: 5,
                  width: 160,
                }}
              >
                <span style={{ fontSize: 10, color: tokens.textFaint }}>🔍</span>
                <input
                  value={taskSearchQuery}
                  onChange={(e) => setTaskSearchQuery(e.target.value)}
                  placeholder="filter cards…"
                  className="mono"
                  style={{
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    fontSize: 10.5,
                    color: tokens.text,
                    width: "100%",
                  }}
                />
                {taskSearchQuery && (
                  <span
                    onClick={() => setTaskSearchQuery("")}
                    style={{ fontSize: 10, color: tokens.textFaint, cursor: "pointer" }}
                  >
                    ×
                  </span>
                )}
              </div>

              {/* View switcher [board | floor] */}
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
                      padding: "4px 10px",
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

            {/* Content: Board or Floor */}
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
                    onNavigateToChat={navigateToChat}
                  />
                ))}
                <DoneColumn
                  tasks={columns.done}
                  expanded={doneExpanded}
                  onToggleExpand={() => setDoneExpanded((prev) => !prev)}
                  onSelect={setSelTaskId}
                  onNavigateToChat={navigateToChat}
                />
              </div>
            ) : (
              <FloorGrid
                tasks={runningTasks}
                onExpand={(id) => {
                  const task = tasks.find((t) => t.id === id);
                  if (task?.run_id) {
                    navigateToChat(task.run_id);
                  } else {
                    setSelTaskId(id);
                  }
                }}
              />
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
  managerStats,
  taskCountStats,
  onSelect,
  onCancel,
}: {
  project: Project;
  selected: boolean;
  managerStats?: ManagerRollupRow;
  taskCountStats?: { total: number; done: number; active: number };
  onSelect: () => void;
  onCancel: () => void;
}) {
  const statusColorMap: Record<string, string> = {
    active: tokens.ok,
    blocked: tokens.warn,
    paused: tokens.textFaint,
    done: tokens.textMuted,
    cancelled: tokens.bleed,
  };
  const color = statusColorMap[project.status] ?? tokens.textMuted;
  const isRunning = project.status === "active";

  const doneCount = managerStats?.tasks_done ?? taskCountStats?.done ?? 0;
  const totalCount = managerStats?.tasks_total ?? taskCountStats?.total ?? 0;
  const lastActivity = managerStats?.last_activity_at ?? project.updated_at ?? null;

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "9px 12px",
        cursor: "pointer",
        borderLeft: `2px solid ${selected ? tokens.accent : "transparent"}`,
        background: selected ? tokens.selectedBg : "transparent",
        transition: "background 0.15s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={dot(color, isRunning)} />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: selected ? 550 : 450,
            color: selected ? tokens.textHi : tokens.textLabel,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={project.name}
        >
          {project.name}
        </span>
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Cancel project "${project.name}"? This removes its git worktree.`)) {
              onCancel();
            }
          }}
          className="mono"
          style={{ fontSize: 11, color: tokens.textFaint, cursor: "pointer", padding: "0 2px" }}
          title="Cancel project"
        >
          ×
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 4,
          marginLeft: 14,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: tokens.textMuted,
            background: tokens.toolBg,
            padding: "1px 4px",
            borderRadius: 3,
            border: `1px solid ${tokens.borderSoft}`,
          }}
        >
          {project.repo}
        </span>
        <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
          {totalCount > 0 ? `${doneCount}/${totalCount} done` : project.status}
        </span>
        {lastActivity && (
          <span
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textGhost, marginLeft: "auto" }}
            title={`last activity ${new Date(lastActivity).toLocaleString()}`}
          >
            {humanAge(lastActivity)}
          </span>
        )}
      </div>
    </div>
  );
}

function RoleColumn({
  role,
  tasks,
  onSelect,
  onNavigateToChat,
}: {
  role: TaskRole;
  tasks: ProjectBoardTask[];
  onSelect: (id: string) => void;
  onNavigateToChat: (runId: string) => void;
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
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {tasks.length === 0 && (
          <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, textAlign: "center", padding: 14 }}>
            —
          </div>
        )}
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onSelect={() => onSelect(t.id)}
            onNavigateToChat={onNavigateToChat}
          />
        ))}
      </div>
    </div>
  );
}

function DoneColumn({
  tasks,
  expanded,
  onToggleExpand,
  onSelect,
  onNavigateToChat,
}: {
  tasks: ProjectBoardTask[];
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: (id: string) => void;
  onNavigateToChat: (runId: string) => void;
}) {
  if (!expanded) {
    return (
      <div
        onClick={onToggleExpand}
        title="Click to expand Done tasks"
        style={{
          width: 44,
          flex: "none",
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "12px 6px",
          cursor: "pointer",
          minHeight: 0,
          maxHeight: "100%",
          opacity: 0.85,
          userSelect: "none",
          transition: "background 0.15s ease, border-color 0.15s ease",
        }}
      >
        <span style={{ width: 4, height: 14, background: tokens.ok, borderRadius: 2 }} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.ok,
            fontWeight: 600,
            marginTop: 8,
            background: tokens.okActionBg,
            border: `1px solid ${tokens.okActionBorder}`,
            borderRadius: 4,
            padding: "2px 4px",
          }}
        >
          {tasks.length}
        </span>
        <div
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            transform: "rotate(180deg)",
            fontSize: 12,
            fontWeight: 500,
            color: tokens.textMuted,
            marginTop: 16,
            letterSpacing: "0.08em",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>DONE</span>
          <span style={{ fontSize: 10, color: tokens.textFaint }}>▶</span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: tokens.textFaint,
            writingMode: "vertical-rl",
            transform: "rotate(180deg)",
          }}
        >
          [expand]
        </span>
      </div>
    );
  }

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
        opacity: 0.9,
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
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.ok,
            background: tokens.okActionBg,
            border: `1px solid ${tokens.okActionBorder}`,
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          {tasks.length}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onToggleExpand}
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textMuted,
            background: "transparent",
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 4,
            padding: "2px 6px",
            cursor: "pointer",
          }}
          title="Collapse Done column"
        >
          ▼ collapse
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {tasks.length === 0 && (
          <div
            className="mono"
            style={{ fontSize: 10, color: tokens.textFaint, textAlign: "center", padding: 14 }}
          >
            —
          </div>
        )}
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onSelect={() => onSelect(t.id)}
            onNavigateToChat={onNavigateToChat}
          />
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onSelect,
  onNavigateToChat,
}: {
  task: ProjectBoardTask;
  onSelect: () => void;
  onNavigateToChat: (runId: string) => void;
}) {
  const color = STATUS_COLOR[task.status] ?? tokens.accent;
  const roleColor = ROLE_COLOR[task.role as TaskRole] ?? tokens.accent;
  const hasRun = Boolean(task.run_id);

  return (
    <div
      onClick={() => {
        if (hasRun && task.run_id) {
          onNavigateToChat(task.run_id);
        } else {
          onSelect();
        }
      }}
      style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${tokens.borderSoft}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: "9px 11px",
        cursor: "pointer",
        transition: "background 0.15s ease, border-color 0.15s ease",
      }}
      title={hasRun ? "Click to open in Chat surface" : "Click to view task brief"}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={dot(color, task.status === "running")} />
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: roleColor,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {ROLE_LABEL[task.role as TaskRole] ?? task.role}
        </span>
        <span style={{ fontSize: 9, color: tokens.textFaint }}>·</span>
        <span className="mono" style={{ fontSize: 9, color, letterSpacing: "0.02em" }}>
          {task.status}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
          r{task.round}
          {task.fix_cycle > 0 ? ` · f${task.fix_cycle}` : ""}
        </span>
      </div>

      <div
        style={{
          fontSize: 12,
          color: tokens.textLabel,
          marginTop: 6,
          lineHeight: 1.4,
          fontWeight: 450,
        }}
      >
        {task.title}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: 6,
          gap: 6,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.project_name} · {humanAge(task.updated_at)}
        </span>
        {hasRun && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (task.run_id) onNavigateToChat(task.run_id);
            }}
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 4,
              padding: "1px 6px",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              cursor: "pointer",
            }}
            title="Open in Chat surface"
          >
            💬 chat ↗
          </span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Floor — the "factory floor" view: every currently-running agent as a live
 * mini-terminal, all visible at once.
 * -------------------------------------------------------------------------- */
function FloorGrid({
  tasks,
  onExpand,
}: {
  tasks: ProjectBoardTask[];
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
  task: ProjectBoardTask;
  onExpand: () => void;
}) {
  const runId = task.run_id!;
  const qc = useQueryClient();
  const { live } = useRunEvents(runId, true);
  const runQ = useQuery({
    queryKey: ["chat", "run", runId],
    queryFn: () =>
      fetchChatDelta(runId, qc.getQueryData<RunDetail>(["chat", "run", runId])),
    // ./chat/pollBudget, same two periods every chat transcript in this
    // codebase polls at — see CHAT_DETAIL_FALLBACK_POLL_MS for why they
    // may not drift apart.
    refetchInterval: live
      ? CHAT_DETAIL_LIVE_POLL_MS
      : CHAT_DETAIL_FALLBACK_POLL_MS,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const thread = runQ.data?.thread ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length]);

  const color = ROLE_COLOR[task.role as TaskRole] ?? tokens.accent;
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
      title="Click to open in Chat surface"
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
          {(ROLE_LABEL[task.role as TaskRole] ?? task.role).toUpperCase()}
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
  onNavigateToChat,
}: {
  task: ProjectBoardTask;
  onClose: () => void;
  onNavigateToChat: (runId: string) => void;
}) {
  const qc = useQueryClient();
  const runId = task.run_id;
  const { live } = useRunEvents(runId, !!runId);
  const runQ = useQuery({
    queryKey: ["chat", "run", runId],
    queryFn: () =>
      fetchChatDelta(runId!, qc.getQueryData<RunDetail>(["chat", "run", runId])),
    enabled: !!runId,
    // ./chat/pollBudget, same two periods every chat transcript in this
    // codebase polls at — see CHAT_DETAIL_FALLBACK_POLL_MS for why they
    // may not drift apart.
    refetchInterval: live
      ? CHAT_DETAIL_LIVE_POLL_MS
      : CHAT_DETAIL_FALLBACK_POLL_MS,
  });
  /* The brief is fetched on demand for the selected task when it has no run yet. */
  const briefQ = useQuery({
    queryKey: ["projects", "task-brief", task.id],
    queryFn: () => fetchTaskBrief(task.id),
    enabled: !runId,
    staleTime: 60_000,
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
            {ROLE_LABEL[task.role as TaskRole] ?? task.role} · round {task.round} · {task.status}
            {runId && <span style={{ color: live ? tokens.ok : tokens.warn }}> · {live ? "live" : "polling"}</span>}
          </div>
        </div>
        {runId && (
          <button
            onClick={() => onNavigateToChat(runId)}
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            title="Open in the full CHAT surface"
          >
            💬 Open in Chat ↗
          </button>
        )}
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
            {briefQ.data}
          </div>
          {briefQ.isPending && (
            <div className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
              loading the brief…
            </div>
          )}
          {briefQ.isError && (
            <div className="mono" style={{ fontSize: 11, color: tokens.bleed, lineHeight: 1.6 }}>
              could not load this task&apos;s brief —{" "}
              {briefQ.error instanceof Error ? briefQ.error.message : String(briefQ.error)}
            </div>
          )}
          {briefQ.isSuccess && briefQ.data.length === 0 && (
            <div className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
              this task has an empty brief.
            </div>
          )}
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
