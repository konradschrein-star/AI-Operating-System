"use client";

/**
 * LIFE GOALS drawer — the right-side overlay on the week board (PLAN.md §3.3).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * When the four-tab Goals surface was replaced by the week board, Life Goals
 * lost its visual home. The data model (`life_goals` table, quarterly / yearly
 * / long_term horizons) is now reachable via this drawer.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Opens full: goals grouped by horizon with title, area, status, progress,
 * and the server-derived line answering whether recent work actually moved it
 * ("moved N tasks · M min in 30 d · last <date>" or "not moved in 30 d").
 * Status updates happen inline.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  createLifeGoal,
  deleteLifeGoal,
  fetchLifeGoals,
  updateLifeGoal,
  type LifeGoal,
  type LifeGoalHorizon,
  type LifeGoalStatus,
} from "../../api";
import { Meter, areaColor } from "./ui";

const HORIZON_GROUPS: readonly {
  key: string;
  label: string;
  match: (h: string) => boolean;
}[] = [
  {
    key: "quarterly",
    label: "Quarterly",
    match: (h) => h === "quarterly",
  },
  {
    key: "yearly",
    label: "Yearly",
    match: (h) => h === "yearly",
  },
  {
    key: "long_term",
    label: "Long Term",
    match: (h) => h === "long_term" || h === "aspirational" || h === "active",
  },
];

const STATUS_OPTIONS: readonly {
  value: LifeGoalStatus;
  label: string;
}[] = [
  { value: "in_progress", label: "in progress" },
  { value: "planned", label: "planned" },
  { value: "done", label: "done" },
  { value: "parked", label: "parked" },
  { value: "abandoned", label: "abandoned" },
];

const AREA_CHOICES = [
  "business",
  "youtube",
  "tech",
  "health",
  "relationships",
  "buying-selling",
  "household",
  "admin",
  "other",
];

export interface LifeGoalsDrawerProps {
  onClose: () => void;
}

export function LifeGoalsDrawer({ onClose }: LifeGoalsDrawerProps) {
  const qc = useQueryClient();
  const [newTitle, setNewTitle] = useState("");
  const [newHorizon, setNewHorizon] = useState<LifeGoalHorizon>("quarterly");
  const [newArea, setNewArea] = useState("");
  const [adding, setAdding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goalsQ = useQuery({
    queryKey: ["life-goals"],
    queryFn: () => fetchLifeGoals(),
    refetchInterval: 120_000,
  });

  const goals: LifeGoal[] = goalsQ.data ?? [];

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["life-goals"] });
    void qc.invalidateQueries({ queryKey: ["daily"] });
    void qc.invalidateQueries({ queryKey: ["daily-stats"] });
  };

  const updateM = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<LifeGoal> }) =>
      updateLifeGoal(id, patch),
    onSuccess: invalidate,
    onError: (e: unknown) =>
      setErrorMsg(`could not update: ${e instanceof Error ? e.message : String(e)}`),
  });

  const createM = useMutation({
    mutationFn: (input: { title: string; horizon: LifeGoalHorizon; area?: string | null }) =>
      createLifeGoal({
        title: input.title,
        horizon: input.horizon,
        area: input.area || null,
        status: "planned",
        progress: 0,
      }),
    onSuccess: () => {
      setNewTitle("");
      setAdding(false);
      invalidate();
    },
    onError: (e: unknown) =>
      setErrorMsg(`could not create goal: ${e instanceof Error ? e.message : String(e)}`),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => deleteLifeGoal(id),
    onSuccess: invalidate,
    onError: (e: unknown) =>
      setErrorMsg(`could not delete goal: ${e instanceof Error ? e.message : String(e)}`),
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setErrorMsg(null);
    createM.mutate({ title, horizon: newHorizon, area: newArea || null });
  };

  const inProgressCount = useMemo(
    () => goals.filter((g) => g.status === "in_progress").length,
    [goals],
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.overlay,
        backdropFilter: "blur(2px)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 400,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          height: "100%",
          background: tokens.bgCard,
          borderLeft: `1px solid ${tokens.border}`,
          boxShadow: tokens.shadowPopover,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: tokens.bgBody,
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: tokens.textHi }}>
                LIFE GOALS
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: tokens.toolBg,
                  color: tokens.textSoft,
                  border: `1px solid ${tokens.borderSoft}`,
                }}
              >
                {goals.length}
              </span>
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textGhost, marginTop: 2 }}>
              {inProgressCount} in progress · grouped by horizon
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${tokens.borderSoft}`,
              color: tokens.textSoft,
              borderRadius: 6,
              padding: "4px 9px",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
            title="Close Drawer (Esc)"
          >
            ✕
          </button>
        </div>

        {errorMsg && (
          <div
            className="mono"
            style={{
              padding: "8px 16px",
              background: tokens.dangerActionBg,
              borderBottom: `1px solid ${tokens.dangerActionBorder}`,
              color: tokens.bleed,
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Scrollable Goal List */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {goalsQ.isPending && (
            <div className="mono" style={{ fontSize: 12, color: tokens.textGhost, padding: 20 }}>
              Loading life goals…
            </div>
          )}

          {goalsQ.isError && (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                color: tokens.bleed,
                fontSize: 12,
              }}
            >
              Failed to load life goals:{" "}
              {goalsQ.error instanceof Error ? goalsQ.error.message : String(goalsQ.error)}
            </div>
          )}

          {!goalsQ.isPending &&
            !goalsQ.isError &&
            HORIZON_GROUPS.map((group) => {
              const matched = goals.filter((g) => group.match(g.horizon));
              return (
                <div key={group.key}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                      borderBottom: `1px solid ${tokens.borderSoft}`,
                      paddingBottom: 4,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        color: tokens.accent,
                        textTransform: "uppercase",
                        fontWeight: 600,
                      }}
                    >
                      {group.label}
                    </span>
                    <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
                      ({matched.length})
                    </span>
                  </div>

                  {matched.length === 0 ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: tokens.textGhost,
                        padding: "8px 4px",
                        fontStyle: "italic",
                      }}
                    >
                      no {group.label.toLowerCase()} goals set
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {matched.map((goal) => (
                        <GoalCard
                          key={goal.id}
                          goal={goal}
                          onUpdateStatus={(status) => updateM.mutate({ id: goal.id, patch: { status } })}
                          onUpdateProgress={(progress) =>
                            updateM.mutate({ id: goal.id, patch: { progress } })
                          }
                          onDelete={() => {
                            if (window.confirm(`Delete goal "${goal.title}"?`)) {
                              deleteM.mutate(goal.id);
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {/* Add-Goal Bottom Strip */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgBody,
            flexShrink: 0,
          }}
        >
          {adding ? (
            <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Life goal title…"
                style={{
                  width: "100%",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.inputBg,
                  color: tokens.textHi,
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={newHorizon}
                  onChange={(e) => setNewHorizon(e.target.value as LifeGoalHorizon)}
                  style={selectStyle()}
                >
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                  <option value="long_term">Long Term</option>
                </select>

                <select
                  value={newArea}
                  onChange={(e) => setNewArea(e.target.value)}
                  style={selectStyle()}
                >
                  <option value="">area (optional)</option>
                  {AREA_CHOICES.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={createM.isPending || !newTitle.trim()}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: "none",
                    background: tokens.accent,
                    color: tokens.onAccent,
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {createM.isPending ? "Adding…" : "Add Goal"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewTitle("");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: `1px solid ${tokens.borderSoft}`,
                    background: "transparent",
                    color: tokens.textSoft,
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: 6,
                border: `1px dashed ${tokens.border}`,
                background: "transparent",
                color: tokens.accent,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span>+</span>
              <span>Add Life Goal</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GoalCard({
  goal,
  onUpdateStatus,
  onUpdateProgress,
  onDelete,
}: {
  goal: LifeGoal;
  onUpdateStatus: (status: LifeGoalStatus) => void;
  onUpdateProgress: (progress: number) => void;
  onDelete: () => void;
}) {
  const [editingProgress, setEditingProgress] = useState(false);
  const [progVal, setProgVal] = useState(goal.progress);

  useEffect(() => {
    setProgVal(goal.progress);
  }, [goal.progress]);

  const tasksDone = goal.tasks_done_30d ?? 0;
  const minutes30d = goal.minutes_30d ?? 0;
  const lastMoved = goal.last_moved_at;

  const derivedLine = useMemo(() => {
    if (tasksDone > 0 || lastMoved) {
      const dateStr = lastMoved
        ? new Date(lastMoved).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : "recently";
      return `moved ${tasksDone} ${tasksDone === 1 ? "task" : "tasks"} · ${minutes30d} min in 30 d · last ${dateStr}`;
    }
    return "not moved in 30 d";
  }, [tasksDone, minutes30d, lastMoved]);

  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${goal.status === "in_progress" ? tokens.borderEmphasis : tokens.borderSoft}`,
        background: goal.status === "in_progress" ? `${tokens.accent}08` : tokens.bgGutter,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Title + Area + Delete */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, justifyContent: "space-between" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tokens.textHi,
              lineHeight: 1.35,
            }}
          >
            {goal.title}
          </div>
          {goal.area && (
            <span
              className="mono"
              style={{
                display: "inline-block",
                marginTop: 3,
                fontSize: 9.5,
                padding: "1px 6px",
                borderRadius: 4,
                border: `1px solid ${areaColor(goal.area)}66`,
                color: areaColor(goal.area),
                textTransform: "uppercase",
              }}
            >
              @{goal.area}
            </span>
          )}
        </div>

        <button
          onClick={onDelete}
          title="Delete goal"
          style={{
            background: "transparent",
            border: "none",
            color: tokens.textGhost,
            cursor: "pointer",
            fontSize: 12,
            padding: "2px 4px",
          }}
        >
          ✕
        </button>
      </div>

      {/* Status selector & Progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2, flexWrap: "wrap" }}>
        <select
          value={goal.status}
          onChange={(e) => onUpdateStatus(e.target.value as LifeGoalStatus)}
          style={{
            ...selectStyle(),
            fontSize: 10.5,
            fontWeight: 500,
            color:
              goal.status === "in_progress"
                ? tokens.ok
                : goal.status === "done"
                  ? tokens.info
                  : goal.status === "abandoned"
                    ? tokens.bleed
                    : tokens.textSoft,
            borderColor: goal.status === "in_progress" ? `${tokens.ok}66` : tokens.borderSoft,
          }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Progress Bar & percentage */}
        <div
          style={{
            flex: 1,
            minWidth: 100,
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          {editingProgress ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="number"
                min={0}
                max={100}
                value={progVal}
                onChange={(e) => setProgVal(Number(e.target.value))}
                style={{
                  width: 50,
                  padding: "2px 4px",
                  fontSize: 10.5,
                  borderRadius: 4,
                  border: `1px solid ${tokens.accent}`,
                  background: tokens.inputBg,
                  color: tokens.textHi,
                }}
              />
              <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
                %
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditingProgress(false);
                  onUpdateProgress(Math.max(0, Math.min(100, progVal)));
                }}
                style={{
                  padding: "2px 6px",
                  fontSize: 10,
                  borderRadius: 4,
                  border: "none",
                  background: tokens.accent,
                  color: tokens.onAccent,
                  cursor: "pointer",
                }}
              >
                ✓
              </button>
            </div>
          ) : (
            <div
              onClick={() => setEditingProgress(true)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 7,
                cursor: "pointer",
              }}
              title="Click to edit progress"
            >
              <Meter value={goal.progress / 100} color={tokens.accent} height={5} />
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textSoft,
                  flex: "none",
                  width: 32,
                  textAlign: "right",
                }}
              >
                {goal.progress}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Derived Line */}
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: tasksDone > 0 ? tokens.textMuted : tokens.textGhost,
          marginTop: 2,
        }}
      >
        {derivedLine}
      </div>
    </div>
  );
}

function selectStyle(): React.CSSProperties {
  return {
    padding: "4px 8px",
    borderRadius: 6,
    border: `1px solid ${tokens.border}`,
    background: tokens.inputBg,
    color: tokens.textHi,
    fontSize: 11,
    outline: "none",
    cursor: "pointer",
  };
}
