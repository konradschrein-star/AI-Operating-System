"use client";

/**
 * GOALS TAB — Strategic Life & Business Goals.
 *
 * Longer-horizon goals view:
 * - Horizons: Near-term (Quarterly), Mid-term (Yearly), Long-term (Multi-year), Personal Aspirations.
 * - Progress tracking: Status selector, visual progress bar %, started & target dates, notes.
 * - Pre-seeded with Konrad's 11 strategic goals from Obsidian vault (`Mentor/Profile/Goals & Aspirations.md`).
 * - Full CRUD: Add, inline progress updates, status updates, notes editing, deletion.
 * - Responsive 390px mobile to 1680px desktop layout.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  createLifeGoal,
  deleteLifeGoal,
  fetchLifeGoals,
  updateLifeGoal,
  type LifeGoal,
  type LifeGoalHorizon,
  type LifeGoalInput,
  type LifeGoalStatus,
} from "../../api";
import {
  CARD,
  EmptyState,
  TAP,
  areaColor,
  chipStyle,
  formatDay,
  ghostButton,
  inputStyle,
  primaryButton,
  textareaStyle,
} from "./ui";
import { toastError } from "../_ui/Toasts";

const HORIZONS: { key: string; label: string; description: string }[] = [
  { key: "all", label: "All Horizons", description: "Complete strategic portfolio" },
  { key: "quarterly", label: "Near-term (Quarterly)", description: "This quarter's direct priorities" },
  { key: "yearly", label: "Mid-term (3–12 Months)", description: "Core business and scaling milestones" },
  { key: "long_term", label: "Long-term (12+ Months)", description: "Studio expansion, tax residency, AI co-founder" },
  { key: "aspirations", label: "Personal Aspirations", description: "Operator mastery & focus discipline" },
];

const STATUS_OPTIONS: { key: LifeGoalStatus; label: string; color: string }[] = [
  { key: "planned", label: "Planned", color: tokens.textGhost },
  { key: "in_progress", label: "In Progress", color: tokens.accent },
  { key: "completed", label: "Completed", color: tokens.ok },
  { key: "paused", label: "Paused", color: tokens.warn },
  { key: "abandoned", label: "Abandoned", color: tokens.bleed },
];

/**
 * Fallback seed data matching Obsidian `/opt/obsidian-vault/Mentor/Profile/Goals & Aspirations.md`
 */
const SEED_GOALS: LifeGoal[] = [
  {
    id: "seed-1",
    title: "Break the shipping drought: publish video output again",
    status: "in_progress",
    horizon: "quarterly",
    area: "business",
    progress: 15,
    started_day: "2026-07-03",
    target_day: "2026-09-30",
    completed_at: null,
    notes: "Pipeline sat at zero across every phase; last publish was May 31. Committed to: queue 3+ ideas, ship 1 published video, and add an alert so it can't silently zero again.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-2",
    title: "Get the AI OS Console operational",
    status: "in_progress",
    horizon: "quarterly",
    area: "tech",
    progress: 45,
    started_day: "2026-06-14",
    target_day: "2026-09-15",
    completed_at: null,
    notes: "A single pane of glass over Hermes + Content Forge + the side apps. Phase 1 backend (forge-control :7700) is live; frontend shipping tonight.",
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-3",
    title: "Stabilise core infra",
    status: "planned",
    horizon: "quarterly",
    area: "tech",
    progress: 0,
    started_day: null,
    target_day: "2026-10-01",
    completed_at: null,
    notes: "Worker-orchestrator and hub-web crash-loop; the VEO image/video farm is half-broken.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-4",
    title: "Reach positive ROI on the YouTube venture within ~6 months",
    status: "planned",
    horizon: "yearly",
    area: "business",
    progress: 5,
    started_day: null,
    target_day: "2026-12-31",
    completed_at: null,
    notes: "Deemed 'pretty easy for an internet business.' Currently -$300/week.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-5",
    title: "Scale the VA operation from 5 toward 50",
    status: "planned",
    horizon: "yearly",
    area: "business",
    progress: 10,
    started_day: null,
    target_day: "2027-03-31",
    completed_at: null,
    notes: "Funded through Shane, gated on a CMS deal ($6k + 15% rev share) and the render pipeline.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-6",
    title: "Own search-based content real estate in German + Nordic markets",
    status: "planned",
    horizon: "yearly",
    area: "business",
    progress: 0,
    started_day: null,
    target_day: "2027-02-28",
    completed_at: null,
    notes: "Before English competitors can hire translators — a 6–18 month window.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-7",
    title: "Multi-language arbitrage",
    status: "planned",
    horizon: "yearly",
    area: "business",
    progress: 0,
    started_day: null,
    target_day: "2027-06-30",
    completed_at: null,
    notes: "Replicate proven English formats into German, Nordic, French, Spanish via AI dubbing.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-8",
    title: "Full-scale content studio",
    status: "planned",
    horizon: "long_term",
    area: "business",
    progress: 0,
    started_day: null,
    target_day: "2027-12-31",
    completed_at: null,
    notes: "12+ channels, multi-language ops, Tier 3/4 (~$28–32k/month burn at 50 VAs).",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-9",
    title: "Relocate to a low-tax jurisdiction (Cyprus)",
    status: "planned",
    horizon: "long_term",
    area: "personal",
    progress: 0,
    started_day: null,
    target_day: "2027-12-31",
    completed_at: null,
    notes: "Budgeted ~$2,500/mo; revenue routed US LLCs → Cyprus LLC → Jersey. Living standards won't be inflated to not loose focus.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-10",
    title: "Build a durable AI co-founder",
    status: "in_progress",
    horizon: "long_term",
    area: "tech",
    progress: 30,
    started_day: "2026-07-01",
    target_day: "2027-12-31",
    completed_at: null,
    notes: "An Obsidian-linked agent with business memory, without typical context-window-dementia.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
  {
    id: "seed-11",
    title: "Financial independence via automated compounding systems",
    status: "in_progress",
    horizon: "long_term",
    area: "financial",
    progress: 20,
    started_day: null,
    target_day: "2028-12-31",
    completed_at: null,
    notes: "Build machines that earn without linear labor, so he can operate from anywhere on his own terms.",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  },
];

export function GoalsTab({ narrow }: { narrow: boolean }) {
  const qc = useQueryClient();
  const [horizonFilter, setHorizonFilter] = useState<string>("all");
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<LifeGoal | null>(null);

  const goalsQ = useQuery({
    queryKey: ["life-goals"],
    queryFn: () => fetchLifeGoals(),
  });

  const rawGoals = goalsQ.data && goalsQ.data.length > 0 ? goalsQ.data : SEED_GOALS;

  const updateGoalM = useMutation({
    mutationFn: (v: { id: string; patch: Partial<LifeGoalInput> }) =>
      updateLifeGoal(v.id, v.patch),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["life-goals"] });
      const prev = qc.getQueryData<LifeGoal[]>(["life-goals"]);
      if (prev) {
        qc.setQueryData<LifeGoal[]>(
          ["life-goals"],
          prev.map((g) => (g.id === v.id ? { ...g, ...v.patch } : g)),
        );
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["life-goals"], ctx.prev);
      toastError("Failed to update goal.", e);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["life-goals"] });
    },
  });

  const deleteGoalM = useMutation({
    mutationFn: (id: string) => deleteLifeGoal(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["life-goals"] });
      const prev = qc.getQueryData<LifeGoal[]>(["life-goals"]);
      if (prev) {
        qc.setQueryData<LifeGoal[]>(
          ["life-goals"],
          prev.filter((g) => g.id !== id),
        );
      }
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["life-goals"], ctx.prev);
      toastError("Failed to delete goal.", e);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["life-goals"] });
    },
  });

  const createGoalM = useMutation({
    mutationFn: (input: LifeGoalInput) => createLifeGoal(input),
    onError: (e) => toastError("Failed to add goal.", e),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["life-goals"] });
      setAddModalOpen(false);
    },
  });

  const areas = useMemo(() => {
    return [...new Set(rawGoals.map((g) => g.area).filter((a): a is string => !!a))].sort();
  }, [rawGoals]);

  const filteredGoals = useMemo(() => {
    return rawGoals.filter((g) => {
      if (horizonFilter !== "all" && g.horizon !== horizonFilter) return false;
      if (areaFilter && g.area !== areaFilter) return false;
      if (statusFilter && g.status !== statusFilter) return false;
      return true;
    });
  }, [rawGoals, horizonFilter, areaFilter, statusFilter]);

  // Group filtered goals by horizon for structured rendering
  const horizonGroups = useMemo(() => {
    const horizonsToShow = horizonFilter === "all"
      ? ["quarterly", "yearly", "long_term", "aspirations"]
      : [horizonFilter];

    return horizonsToShow.map((hKey) => {
      const info = HORIZONS.find((h) => h.key === hKey);
      const items = filteredGoals.filter((g) => g.horizon === hKey);
      return {
        key: hKey,
        label: info?.label ?? hKey.toUpperCase(),
        description: info?.description ?? "",
        items,
      };
    }).filter((g) => g.items.length > 0 || horizonFilter !== "all");
  }, [filteredGoals, horizonFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Header & Action Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi }}>
            Life & Strategic Goals
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
            Directly mapped to your Obsidian profile ({rawGoals.length} strategic goals)
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAddModalOpen(true)}
          style={{
            ...primaryButton(),
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span className="ms" style={{ fontSize: 16 }}>add</span>
          New Goal
        </button>
      </div>

      {/* Filter Chips: Horizons */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {HORIZONS.map((h) => (
          <button
            key={h.key}
            type="button"
            style={{ ...chipStyle(horizonFilter === h.key), flex: narrow ? 1 : "none" }}
            onClick={() => setHorizonFilter(h.key)}
          >
            {h.label}
          </button>
        ))}
      </div>

      {/* Filter Chips: Status & Area */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            style={chipStyle(statusFilter === s.key, s.color)}
            onClick={() => setStatusFilter(statusFilter === s.key ? null : s.key)}
          >
            {s.label}
          </button>
        ))}

        {areas.length > 0 && (
          <>
            <span style={{ color: tokens.borderDivider, margin: "0 4px" }}>|</span>
            {areas.map((a) => (
              <button
                key={a}
                type="button"
                style={chipStyle(areaFilter === a, areaColor(a))}
                onClick={() => setAreaFilter(areaFilter === a ? null : a)}
              >
                #{a}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Goal Horizon Sections */}
      {filteredGoals.length === 0 ? (
        <EmptyState icon="flag">
          No goals match the selected filters.
        </EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {horizonGroups.map((group) => (
            <div key={group.key}>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: tokens.accent }}>
                    {group.label}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
                    ({group.items.length})
                  </span>
                </div>
                {group.description && (
                  <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
                    {group.description}
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fill, minmax(360px, 1fr))",
                  gap: 12,
                }}
              >
                {group.items.map((goal) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    onUpdateProgress={(progress) =>
                      updateGoalM.mutate({ id: goal.id, patch: { progress } })
                    }
                    onUpdateStatus={(status) =>
                      updateGoalM.mutate({ id: goal.id, patch: { status } })
                    }
                    onEdit={() => setEditingGoal(goal)}
                    onDelete={() => deleteGoalM.mutate(goal.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Goal Modal */}
      {addModalOpen && (
        <GoalEditorModal
          onClose={() => setAddModalOpen(false)}
          onSave={(input) => createGoalM.mutate(input)}
          saving={createGoalM.isPending}
        />
      )}

      {/* Edit Goal Modal */}
      {editingGoal && (
        <GoalEditorModal
          initial={editingGoal}
          onClose={() => setEditingGoal(null)}
          onSave={(input) => {
            updateGoalM.mutate({ id: editingGoal.id, patch: input });
            setEditingGoal(null);
          }}
          saving={updateGoalM.isPending}
        />
      )}
    </div>
  );
}

/**
 * Individual Goal Card with progress bar, status selector, area tag, and notes.
 */
function GoalCard({
  goal,
  onUpdateProgress,
  onUpdateStatus,
  onEdit,
  onDelete,
}: {
  goal: LifeGoal;
  onUpdateProgress: (progress: number) => void;
  onUpdateStatus: (status: LifeGoalStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [openNotes, setOpenNotes] = useState(false);
  const statusInfo = STATUS_OPTIONS.find((s) => s.key === goal.status) ?? STATUS_OPTIONS[0];

  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 12,
        border: `1px solid ${tokens.border}`,
        boxSizing: "border-box",
      }}
    >
      <div>
        {/* Top meta: Area & Status badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {goal.area && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: areaColor(goal.area),
                  border: `1px solid ${tokens.borderDivider}`,
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                #{goal.area}
              </span>
            )}
            <span
              className="mono"
              style={{
                fontSize: 9,
                color: statusInfo.color,
                background: tokens.toolBg,
                border: `1px solid ${statusInfo.color}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {statusInfo.label}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              onClick={onEdit}
              style={{ ...ghostButton(), padding: "2px 6px", minHeight: 24 }}
              title="Edit goal"
            >
              <span className="ms" style={{ fontSize: 13 }}>edit</span>
            </button>
            <button
              type="button"
              onClick={onDelete}
              style={{ ...ghostButton(), padding: "2px 6px", minHeight: 24, color: tokens.bleed }}
              title="Delete goal"
            >
              <span className="ms" style={{ fontSize: 13 }}>delete</span>
            </button>
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            lineHeight: 1.45,
            color: goal.status === "completed" ? tokens.textMuted : tokens.textHi,
            textDecoration: goal.status === "completed" ? "line-through" : "none",
            marginBottom: 8,
            wordBreak: "break-word",
          }}
        >
          {goal.title}
        </div>

        {/* Notes preview/toggle */}
        {goal.notes && (
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.45,
                color: tokens.textMuted,
                display: openNotes ? "block" : "-webkit-box",
                WebkitLineClamp: openNotes ? undefined : 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {goal.notes}
            </div>
            {goal.notes.length > 80 && (
              <button
                type="button"
                onClick={() => setOpenNotes((o) => !o)}
                style={{
                  ...ghostButton(),
                  fontSize: 9.5,
                  padding: 0,
                  marginTop: 3,
                  color: tokens.accent,
                }}
              >
                {openNotes ? "show less" : "show more"}
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        {/* Progress bar */}
        <div style={{ marginBottom: 10 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
              PROGRESS
            </span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.accent }}>
              {goal.progress}%
            </span>
          </div>

          <div
            style={{
              width: "100%",
              height: 6,
              borderRadius: 3,
              background: tokens.borderDivider,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, goal.progress))}%`,
                height: "100%",
                borderRadius: 3,
                background: goal.progress >= 100 ? tokens.ok : `linear-gradient(90deg, ${tokens.accent}, ${tokens.ok})`,
                transition: "width 0.25s ease",
              }}
            />
          </div>
        </div>

        {/* Quick progress increment & Status selector */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            flexWrap: "wrap",
            paddingTop: 8,
            borderTop: `1px solid ${tokens.borderDivider}`,
          }}
        >
          {/* Quick bump buttons */}
          <div style={{ display: "flex", gap: 4 }}>
            {[10, 25, 50, 100].map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => onUpdateProgress(val)}
                style={{
                  ...ghostButton(),
                  fontSize: 9.5,
                  padding: "2px 5px",
                  minHeight: 22,
                  color: goal.progress === val ? tokens.accent : tokens.textGhost,
                  border: `1px solid ${goal.progress === val ? tokens.accent : tokens.borderDivider}`,
                }}
              >
                {val}%
              </button>
            ))}
          </div>

          {/* Quick status selector */}
          <select
            value={goal.status}
            onChange={(e) => onUpdateStatus(e.target.value as LifeGoalStatus)}
            style={{
              ...inputStyle(),
              width: "auto",
              padding: "2px 6px",
              fontSize: 10.5,
              minHeight: 24,
              cursor: "pointer",
            }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {/* Target date indicator */}
        {goal.target_day && (
          <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, marginTop: 8, textAlign: "right" }}>
            Target: {formatDay(goal.target_day)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Goal Creation and Editing Modal Form
 */
function GoalEditorModal({
  initial,
  onClose,
  onSave,
  saving,
}: {
  initial?: LifeGoal;
  onClose: () => void;
  onSave: (input: LifeGoalInput) => void;
  saving?: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [horizon, setHorizon] = useState<LifeGoalHorizon>(initial?.horizon ?? "quarterly");
  const [status, setStatus] = useState<LifeGoalStatus>(initial?.status ?? "planned");
  const [area, setArea] = useState(initial?.area ?? "business");
  const [progress, setProgress] = useState(initial?.progress ?? 0);
  const [targetDay, setTargetDay] = useState(initial?.target_day ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const submit = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      horizon,
      status,
      area: area.trim() || null,
      progress: Number(progress) || 0,
      target_day: targetDay || null,
      notes: notes.trim() || null,
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          ...CARD,
          width: "100%",
          maxWidth: 540,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          padding: "20px 22px",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
            paddingBottom: 10,
            borderBottom: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 600, color: tokens.textHi }}>
            {initial ? "Edit Strategic Goal" : "New Strategic Goal"}
          </div>
          <button type="button" onClick={onClose} style={ghostButton()}>
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Title */}
          <div>
            <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
              GOAL TITLE *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Own search-based content in German + Nordic markets"
              style={inputStyle()}
              autoFocus
            />
          </div>

          {/* Horizon & Status */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                HORIZON
              </label>
              <select
                value={horizon}
                onChange={(e) => setHorizon(e.target.value as LifeGoalHorizon)}
                style={inputStyle()}
              >
                <option value="quarterly">Near-term (Quarterly)</option>
                <option value="yearly">Mid-term (Yearly)</option>
                <option value="long_term">Long-term (12+ mo)</option>
                <option value="aspirations">Personal Aspiration</option>
              </select>
            </div>

            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                STATUS
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as LifeGoalStatus)}
                style={inputStyle()}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Area & Target Date */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                AREA TAG
              </label>
              <input
                type="text"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="e.g. business, tech, personal"
                style={inputStyle()}
              />
            </div>

            <div>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
                TARGET DATE (YYYY-MM-DD)
              </label>
              <input
                type="date"
                value={targetDay}
                onChange={(e) => setTargetDay(e.target.value)}
                style={inputStyle()}
              />
            </div>
          </div>

          {/* Progress Slider */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <label className="mono" style={{ fontSize: 10, color: tokens.textSoft }}>
                PROGRESS: {progress}%
              </label>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              style={{ width: "100%", accentColor: tokens.accent }}
            />
          </div>

          {/* Notes / Evidence */}
          <div>
            <label className="mono" style={{ fontSize: 10, color: tokens.textSoft, display: "block", marginBottom: 5 }}>
              NOTES & EVIDENCE / CONTEXT
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Rationale, milestones, blockers from vault notes..."
              style={textareaStyle()}
            />
          </div>
        </div>

        {/* Modal Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
            paddingTop: 14,
            borderTop: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <button type="button" onClick={onClose} style={ghostButton()}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || saving}
            style={primaryButton()}
          >
            {saving ? "Saving…" : initial ? "Save Changes" : "Create Goal"}
          </button>
        </div>
      </div>
    </div>
  );
}
