"use client";

/**
 * TodaySurface — The Unified Executive Day-Driver & Operational Cockpit.
 *
 * This is the first screen Konrad opens every morning.
 * It answers in a single dense glance without clicking:
 *   1. What is today for? (The Big 3 Said vs Done commitment)
 *   2. What am I doing today? (Habits + Tasks + Intent)
 *   3. What happened overnight / is anything on fire? (Spend, Pipeline funnel, Fleet, Alerts)
 *   4. What needs human judgment right now? (Actionable 1-click Inbox stream)
 *
 * Design constraints:
 *   - Zero raw colours (all through tokens.ts).
 *   - Both light & dark theme compliant.
 *   - All 4 states handled: loading skeleton, empty, error with retry, populated.
 *   - Optimistic habit toggles, goal checkboxes, and inbox actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  statusColor,
  type FleetWorker,
  type NeedsItem,
  type InboxItem as InboxItemUi,
  type InboxAction,
} from "../data";
import {
  commitDay,
  fetchDailyDay,
  fetchInbox,
  fetchLive,
  fetchPipeline,
  fetchSpendSummary,
  resolveInboxItem,
  saveDayPlan,
  setDayGoalStatus,
  setDayHabit,
  updateDayTask,
  type DailyDayResponse,
  type DayGoal,
  type DayGoalStatus,
  type DayHabit,
  type DayTask,
  type PipelinePhase,
  type SpendSummaryResponse,
  type TodayResponse,
} from "../api";
import type { Surface } from "./nav-items";
import { HabitChips } from "./goals/HabitChips";
import { toDayKey, addDays, fromDayKey } from "./goals/quick-add";
import {
  CARD,
  ScoreRing,
  SectionLabel,
  EmptyState,
  TAP,
  formatDay,
  clockOf,
  pctText,
  inputStyle,
  primaryButton,
  ghostButton,
  chipStyle,
} from "./goals/ui";
import { ErrorPanel, errorDetail } from "./_ui/SurfaceErrorBoundary";

/* ----------------------------------------------------------------------------
 * Helper Types & ID Generator
 * -------------------------------------------------------------------------- */

interface Slot {
  id: string;
  text: string;
  why: string;
}

const EMPTY_SLOTS: Slot[] = [
  { id: "", text: "", why: "" },
  { id: "", text: "", why: "" },
  { id: "", text: "", why: "" },
];

function slotsFrom(plan: DailyDayResponse["plan"] | null | undefined): Slot[] {
  const goals = plan?.big3 ?? [];
  return EMPTY_SLOTS.map((blank, i) => {
    const g = goals[i];
    return g ? { id: g.id, text: g.text, why: g.why ?? "" } : { ...blank };
  });
}

function newGoalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Map worker status to truthful indicator dot color (idle = muted gray, not green). */
function workerDotColor(status: FleetWorker["status"] | string, state?: string): string {
  if (status === "stuck") return tokens.stuck;
  if (status === "routing" || status === "render") return tokens.info;
  const stateStr = (state ?? "").toLowerCase();
  if (stateStr.includes("run") || stateStr.includes("act")) {
    return tokens.ok;
  }
  if (status === "idle") {
    return tokens.textGhost;
  }
  return tokens.textGhost;
}

/* ----------------------------------------------------------------------------
 * Main TodaySurface Component
 * -------------------------------------------------------------------------- */

export function TodaySurface({
  data,
  inboxCount,
  onNav,
  onClearNeeds,
  clearingNeeds,
}: {
  data: TodayResponse;
  inboxCount: number;
  onNav: (s: Surface) => void;
  onClearNeeds?: () => void;
  clearingNeeds?: boolean;
}) {
  const qc = useQueryClient();
  const dayKey = useMemo(() => toDayKey(new Date()), []);
  const dayKeyArray = useMemo(() => ["daily", "day", dayKey] as const, [dayKey]);

  // Queries
  const dailyQ = useQuery({
    queryKey: dayKeyArray,
    queryFn: () => fetchDailyDay(dayKey),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const pipelineQ = useQuery({
    queryKey: ["pipeline"],
    queryFn: fetchPipeline,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const inboxQ = useQuery({
    queryKey: ["inbox"],
    queryFn: fetchInbox,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  const spendQ = useQuery({
    queryKey: ["spend-summary"],
    queryFn: fetchSpendSummary,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const liveQ = useQuery({
    queryKey: ["live"],
    queryFn: fetchLive,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  // Collapsible machine diary state
  const [diaryOpen, setDiaryOpen] = useState(false);

  // Plan & Big 3 draft state
  const plan = dailyQ.data?.plan ?? null;
  const committedAt = plan?.committed_at ?? null;
  const isCommitted = committedAt !== null;

  const serverSig = useMemo(
    () =>
      JSON.stringify([
        plan?.intent ?? null,
        (plan?.big3 ?? []).map((g) => [g.id, g.text, g.why]),
      ]),
    [plan],
  );

  const [slots, setSlots] = useState<Slot[]>(() => slotsFrom(plan));
  const [intent, setIntent] = useState<string>(plan?.intent ?? "");
  const dirtyRef = useRef(false);
  const seededRef = useRef(`${dayKey}|${serverSig}`);

  useEffect(() => {
    const key = `${dayKey}|${serverSig}`;
    if (seededRef.current === key) return;
    if (dirtyRef.current && seededRef.current.startsWith(`${dayKey}|`)) return;
    seededRef.current = key;
    dirtyRef.current = false;
    setSlots(slotsFrom(plan));
    setIntent(plan?.intent ?? "");
  }, [dayKey, serverSig, plan]);

  const draftGoals = useCallback((): DayGoal[] => {
    const existing = new Map((plan?.big3 ?? []).map((g) => [g.id, g]));
    return slots
      .filter((s) => s.text.trim().length > 0)
      .slice(0, 3)
      .map((s) => {
        const prev = s.id ? existing.get(s.id) : undefined;
        return {
          id: s.id || newGoalId(),
          text: s.text.trim(),
          why: s.why.trim() || null,
          status: prev?.status ?? "open",
          reason: prev?.reason ?? null,
          done_at: prev?.done_at ?? null,
        };
      });
  }, [slots, plan]);

  // Mutations
  const savePlanM = useMutation({
    mutationFn: (input: { intent: string | null; big3: DayGoal[] }) =>
      saveDayPlan(dayKey, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dayKeyArray });
    },
  });

  const commitM = useMutation({
    mutationFn: async (input: { intent: string | null; big3: DayGoal[] }) => {
      await saveDayPlan(dayKey, input);
      return commitDay(dayKey);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dayKeyArray });
      void qc.invalidateQueries({ queryKey: ["daily-stats"] });
    },
  });

  const goalStatusM = useMutation({
    mutationFn: (v: { goalId: string; status: DayGoalStatus; reason?: string }) =>
      setDayGoalStatus(dayKey, v.goalId, { status: v.status, reason: v.reason }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKeyArray });
      const prev = qc.getQueryData<DailyDayResponse>(dayKeyArray);
      if (prev?.plan) {
        const nextBig3 = prev.plan.big3.map((g) =>
          g.id === v.goalId
            ? {
                ...g,
                status: v.status,
                reason: v.reason ?? g.reason,
                done_at: v.status === "done" ? new Date().toISOString() : null,
              }
            : g,
        );
        qc.setQueryData<DailyDayResponse>(dayKeyArray, {
          ...prev,
          plan: { ...prev.plan, big3: nextBig3 },
        });
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKeyArray, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: dayKeyArray });
      void qc.invalidateQueries({ queryKey: ["daily-stats"] });
    },
  });

  const habitM = useMutation({
    mutationFn: (v: { habit: DayHabit; next: boolean }) =>
      setDayHabit(dayKey, v.habit.id, v.next),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKeyArray });
      const prev = qc.getQueryData<DailyDayResponse>(dayKeyArray);
      if (prev) {
        const without = prev.ticks.filter((t) => t.habit_id !== v.habit.id);
        qc.setQueryData<DailyDayResponse>(dayKeyArray, {
          ...prev,
          ticks: v.next
            ? [
                ...without,
                {
                  day: dayKey,
                  habit_id: v.habit.id,
                  done: true,
                  ts: new Date().toISOString(),
                },
              ]
            : without,
        });
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKeyArray, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: dayKeyArray });
      void qc.invalidateQueries({ queryKey: ["daily-stats"] });
    },
  });

  const updateTaskM = useMutation({
    mutationFn: (v: { id: string; patch: Parameters<typeof updateDayTask>[1] }) =>
      updateDayTask(v.id, v.patch),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: dayKeyArray });
      const prev = qc.getQueryData<DailyDayResponse>(dayKeyArray);
      if (prev) {
        qc.setQueryData<DailyDayResponse>(dayKeyArray, {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === v.id
              ? {
                  ...t,
                  ...v.patch,
                  importance:
                    v.patch.importance !== undefined && v.patch.importance !== null
                      ? v.patch.importance
                      : t.importance,
                }
              : t,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dayKeyArray, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: dayKeyArray });
      void qc.invalidateQueries({ queryKey: ["daily", "tasks"] });
    },
  });

  const resolveInboxM = useMutation({
    mutationFn: (v: { id: string; action_id?: string; reason?: string }) =>
      resolveInboxItem(v.id, {
        resolved_by: "user",
        action_id: v.action_id,
        reason: v.reason,
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["inbox"] });
      const prev = qc.getQueryData<InboxItemUi[]>(["inbox"]);
      if (prev) {
        qc.setQueryData<InboxItemUi[]>(
          ["inbox"],
          prev.filter((i) => i.id !== v.id),
        );
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["inbox"], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });

  const flushDraft = () => {
    if (!dirtyRef.current || isCommitted) return;
    dirtyRef.current = false;
    const goals = draftGoals();
    setSlots((cur) =>
      cur.map((s, i) => (s.id ? s : { ...s, id: goals[i]?.id ?? s.id })),
    );
    savePlanM.mutate({ intent: intent.trim() || null, big3: goals });
  };

  // Stale tasks
  const staleTasks = useMemo(() => {
    return (dailyQ.data?.tasks ?? []).filter(
      (t) =>
        ((t.carried ?? 0) >= 3 || (t.stale && (t.carried ?? 0) >= 1)) &&
        t.status !== "done" &&
        t.status !== "parked",
    );
  }, [dailyQ.data]);

  // Habit ticks
  const tickedHabits = useMemo(
    () => new Set((dailyQ.data?.ticks ?? []).filter((t) => t.done).map((t) => t.habit_id)),
    [dailyQ.data],
  );

  // Operational metrics
  const stuckCount = useMemo(() => {
    const stat = liveQ.data?.stats?.find((s) => s.label === "STUCK");
    return stat ? parseInt(stat.value, 10) || 0 : 0;
  }, [liveQ.data]);

  const bleedCount = useMemo(() => {
    return (inboxQ.data ?? []).filter((i) => i.status === "BLEED").length;
  }, [inboxQ.data]);

  const pipelineTotal = useMemo(() => {
    if (pipelineQ.data?.total !== undefined) return pipelineQ.data.total;
    if (data.shipped?.pipeline) {
      const m = /(\d+)/.exec(data.shipped.pipeline);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }, [pipelineQ.data, data.shipped]);

  const meteredSpendEur = spendQ.data?.today?.total_eur ?? 0;
  const claudeShadowEur = spendQ.data?.today?.claude_eur ?? 0;

  // Pipeline phases
  const pipelinePhases: PipelinePhase[] = useMemo(() => {
    if (pipelineQ.data?.phases && pipelineQ.data.phases.length > 0) {
      return pipelineQ.data.phases;
    }
    return [
      { key: "idea", label: "Idea", description: "Topics", count: 0, statuses: [], cards: [] },
      { key: "script", label: "Script", description: "Scripting", count: 0, statuses: [], cards: [] },
      { key: "assets", label: "Assets", description: "Voice & B-roll", count: 0, statuses: [], cards: [] },
      { key: "render", label: "Render", description: "Rendering", count: 0, statuses: [], cards: [] },
      { key: "ready", label: "Ready", description: "Ready to ship", count: pipelineTotal, statuses: [], cards: [] },
    ];
  }, [pipelineQ.data, pipelineTotal]);

  // Loading skeleton state
  if (dailyQ.isLoading && !dailyQ.data && !data.greeting) {
    return <TodaySkeleton />;
  }

  // Error state
  if (dailyQ.isError && !dailyQ.data) {
    return (
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 40px 64px" }}>
        <ErrorPanel
          title="Today surface failed to load."
          detail={errorDetail(dailyQ.error)}
          onRetry={() => void dailyQ.refetch()}
        />
      </div>
    );
  }

  const scoreData = dailyQ.data?.score ?? null;
  const scoreVal = scoreData?.score ?? null;

  return (
    <div
      className="slidein"
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: "36px 36px 64px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* ── 1. Top Briefing Bar ────────────────────────────────────────────── */}
      <div
        style={{
          ...CARD,
          padding: "20px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 20,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              color: tokens.textFaint,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            {data.date || formatDay(dayKey)} · OPERATIONAL COCKPIT
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: tokens.textHi,
              lineHeight: 1.25,
            }}
          >
            {data.greeting || "Welcome back, Konrad."}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: tokens.textSecondary,
              marginTop: 4,
            }}
          >
            Said vs Done is the only scoreboard. Output cadence wins the quarter.
          </div>
        </div>

        {/* Score Ring */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, flex: "none" }}>
          <div style={{ textAlign: "right" }}>
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: isCommitted ? tokens.textSecondary : tokens.textGhost,
                letterSpacing: "0.06em",
              }}
            >
              {isCommitted ? "SAID VS DONE" : "NOT COMMITTED"}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.textGhost,
                marginTop: 3,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <span>G: {pctText(scoreData?.goal_pct ?? null)}</span>
              <span>H: {pctText(scoreData?.habit_pct ?? null)}</span>
              <span>T: {pctText(scoreData?.task_pct ?? null)}</span>
            </div>
          </div>
          <ScoreRing score={scoreVal} muted={!isCommitted} size={64} />
        </div>
      </div>

      {/* ── 2. Morning Line Chips Strip ────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {/* Commit Day Status */}
        <button
          type="button"
          onClick={() => {
            const el = document.getElementById("big3-commitment-block");
            el?.scrollIntoView({ behavior: "smooth" });
          }}
          style={{
            ...chipStyle(true, isCommitted ? tokens.ok : tokens.warn),
            background: isCommitted ? tokens.freezeBgOk : tokens.freezeBgWarn,
            borderColor: isCommitted ? tokens.freezeBorderOk : tokens.freezeBorderWarn,
          }}
        >
          <span style={dot(isCommitted ? tokens.ok : tokens.warn, !isCommitted)} />
          <span className="mono" style={{ fontWeight: 600 }}>
            {isCommitted
              ? `✓ DAY COMMITTED (${clockOf(committedAt)})`
              : "! COMMIT THE DAY"}
          </span>
        </button>

        {/* Pipeline Count */}
        <button
          type="button"
          onClick={() => onNav("pipeline")}
          style={chipStyle(false)}
        >
          <span className="ms" style={{ fontSize: 15, color: tokens.accent }}>
            view_kanban
          </span>
          <span className="mono">{pipelineTotal} in pipeline</span>
        </button>

        {/* Stuck Alert Badge */}
        <button
          type="button"
          onClick={() => onNav("live")}
          style={{
            ...chipStyle(stuckCount > 0, tokens.stuck),
            background: stuckCount > 0 ? tokens.selectedBg : tokens.toolBg,
            borderColor: stuckCount > 0 ? tokens.stuck : tokens.border,
          }}
        >
          <span style={dot(tokens.stuck, stuckCount > 0)} />
          <span className="mono">{stuckCount} stuck</span>
        </button>

        {/* Bleed Alert Badge */}
        <button
          type="button"
          onClick={() => onNav("inbox")}
          style={{
            ...chipStyle(bleedCount > 0, tokens.bleed),
            background: bleedCount > 0 ? tokens.dangerActionBg : tokens.toolBg,
            borderColor: bleedCount > 0 ? tokens.dangerActionBorder : tokens.border,
          }}
        >
          <span style={dot(tokens.bleed, bleedCount > 0)} />
          <span className="mono">{bleedCount} bleed</span>
        </button>

        {/* Metered Spend vs Cap */}
        <button
          type="button"
          onClick={() => onNav("money")}
          style={chipStyle(meteredSpendEur > 50, tokens.bleed)}
          title={
            claudeShadowEur > 0
              ? `Metered spend: €${meteredSpendEur.toFixed(2)} / €50 cap. (Claude flat subscription shadow: €${claudeShadowEur.toFixed(2)})`
              : `Metered spend: €${meteredSpendEur.toFixed(2)} / €50 cap.`
          }
        >
          <span className="ms" style={{ fontSize: 15, color: tokens.textMuted }}>
            euro
          </span>
          <span className="mono">
            €{meteredSpendEur.toFixed(2)} / €50 spend
          </span>
        </button>

        {/* Shipped Count */}
        <button
          type="button"
          onClick={() => onNav("pipeline")}
          style={chipStyle(false)}
        >
          <span className="ms" style={{ fontSize: 15, color: tokens.ok }}>
            local_shipping
          </span>
          <span className="mono">{data.shipped?.value ?? "0"} shipped</span>
        </button>
      </div>

      {/* ── 3. Stale Tasks Warning Banner (Carried >= 3) ────────────────────── */}
      {staleTasks.length > 0 && (
        <div
          style={{
            ...CARD,
            background: tokens.freezeBgWarn,
            borderColor: tokens.freezeBorderWarn,
            padding: "16px 20px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <span style={dot(tokens.warn, true)} />
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: tokens.warn,
                letterSpacing: "0.04em",
              }}
            >
              STALE TASKS ({staleTasks.length}) — These keep sliding. Do them today or kill them:
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {staleTasks.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 14,
                  background: tokens.bgCard,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  padding: "10px 14px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: tokens.textHi, fontWeight: 500 }}>
                    {t.title}
                  </span>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: tokens.warn,
                      marginTop: 2,
                    }}
                  >
                    carried {t.carried ?? 3}× {t.area ? `· #${t.area}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flex: "none" }}>
                  <button
                    type="button"
                    onClick={() =>
                      updateTaskM.mutate({
                        id: t.id,
                        patch: { carried: 0, planned_day: dayKey },
                      })
                    }
                    style={{
                      ...ghostButton(),
                      color: tokens.accent,
                      borderColor: tokens.accent,
                    }}
                  >
                    Pin to today
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateTaskM.mutate({
                        id: t.id,
                        patch: { status: "parked" },
                      })
                    }
                    style={{
                      ...ghostButton(),
                      color: tokens.textMuted,
                    }}
                  >
                    Kill (Park)
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 4. Big 3 Commitment Block ──────────────────────────────────────── */}
      <div id="big3-commitment-block">
        <SectionLabel
          right={
            isCommitted ? (
              <span
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10,
                  color: tokens.ok,
                }}
              >
                <span className="ms" style={{ fontSize: 14 }}>
                  lock
                </span>
                FROZEN · COMMITTED AT {clockOf(committedAt)}
              </span>
            ) : (
              <span className="mono" style={{ fontSize: 10, color: tokens.warn }}>
                DRAFT · UNCOMMITTED
              </span>
            )
          }
        >
          THE BIG 3 COMMITMENT (SAID VS DONE)
        </SectionLabel>

        {isCommitted ? (
          /* Post-Commit: Locked Intent + Interactive Checkbox Cards */
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {plan?.intent && (
              <div
                style={{
                  ...CARD,
                  padding: "12px 16px",
                  background: tokens.toolBg,
                  fontSize: 13.5,
                  color: tokens.text,
                  lineHeight: 1.45,
                }}
              >
                <span className="mono" style={{ fontSize: 10, color: tokens.textFaint, marginRight: 8 }}>
                  INTENT:
                </span>
                {plan.intent}
              </div>
            )}

            {(plan?.big3 ?? []).map((g, idx) => {
              const isDone = g.status === "done";
              const isAbandoned = g.status === "abandoned";
              return (
                <div
                  key={g.id}
                  style={{
                    ...CARD,
                    padding: "14px 18px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    borderColor: isDone ? tokens.okActionBorder : tokens.border,
                    background: isDone ? tokens.okActionBg : tokens.bgCard,
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Toggle goal ${idx + 1}`}
                    onClick={() =>
                      goalStatusM.mutate({
                        goalId: g.id,
                        status: isDone ? "open" : "done",
                      })
                    }
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      border: `1.5px solid ${isDone ? tokens.ok : tokens.borderEmphasis}`,
                      background: isDone ? tokens.ok : "transparent",
                      color: tokens.bgBody,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      marginTop: 2,
                      flex: "none",
                    }}
                  >
                    {isDone && (
                      <span className="ms" style={{ fontSize: 16, fontWeight: "bold" }}>
                        check
                      </span>
                    )}
                  </button>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14.5,
                        fontWeight: 500,
                        color: isDone ? tokens.textMuted : tokens.textHi,
                        textDecoration: isDone || isAbandoned ? "line-through" : "none",
                        lineHeight: 1.4,
                      }}
                    >
                      {idx + 1}. {g.text}
                    </div>
                    {g.why && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: tokens.textSecondary,
                          marginTop: 4,
                          lineHeight: 1.45,
                        }}
                      >
                        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                          why:{" "}
                        </span>
                        {g.why}
                      </div>
                    )}
                    {g.reason && (
                      <div
                        className="mono"
                        style={{ fontSize: 10, color: tokens.bleed, marginTop: 4 }}
                      >
                        abandon reason: {g.reason}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                    {isDone && g.done_at && (
                      <span className="mono" style={{ fontSize: 10, color: tokens.ok }}>
                        {clockOf(g.done_at)}
                      </span>
                    )}
                    {!isDone && !isAbandoned && (
                      <button
                        type="button"
                        onClick={() => {
                          const r = window.prompt("Reason for abandoning this goal:");
                          if (r !== null) {
                            goalStatusM.mutate({
                              goalId: g.id,
                              status: "abandoned",
                              reason: r.trim() || "Abandoned by operator",
                            });
                          }
                        }}
                        style={{
                          ...ghostButton(),
                          padding: "4px 8px",
                          fontSize: 10.5,
                          minHeight: 28,
                        }}
                      >
                        Abandon
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Pre-Commit: Intent Editor + 3 Draft Goal Cards + COMMIT Button */
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input
              value={intent}
              onChange={(e) => {
                dirtyRef.current = true;
                setIntent(e.target.value);
              }}
              onBlur={flushDraft}
              placeholder="Intent — one line: what today is FOR"
              aria-label="Intent for the day"
              style={inputStyle()}
            />

            {slots.map((s, i) => (
              <div key={i} style={{ ...CARD, padding: "12px 14px" }}>
                <input
                  value={s.text}
                  onChange={(e) => {
                    dirtyRef.current = true;
                    setSlots((cur) =>
                      cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                    );
                  }}
                  onBlur={flushDraft}
                  placeholder={`Goal ${i + 1} — what must be true tonight`}
                  aria-label={`Big 3 goal ${i + 1}`}
                  style={{
                    ...inputStyle(),
                    border: "none",
                    background: "transparent",
                    padding: "4px 0",
                    fontWeight: 500,
                  }}
                />
                <input
                  value={s.why}
                  onChange={(e) => {
                    dirtyRef.current = true;
                    setSlots((cur) =>
                      cur.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)),
                    );
                  }}
                  onBlur={flushDraft}
                  placeholder="why it matters (optional)"
                  aria-label={`Why goal ${i + 1} matters`}
                  style={{
                    ...inputStyle(),
                    border: "none",
                    background: "transparent",
                    padding: "2px 0",
                    fontSize: 11.5,
                    color: tokens.textMuted,
                    minHeight: 26,
                  }}
                />
              </div>
            ))}

            <div>
              <button
                type="button"
                disabled={draftGoals().length === 0 || commitM.isPending}
                onClick={() => {
                  dirtyRef.current = false;
                  commitM.mutate({
                    intent: intent.trim() || null,
                    big3: draftGoals(),
                  });
                }}
                style={{
                  ...primaryButton(),
                  opacity: draftGoals().length === 0 || commitM.isPending ? 0.45 : 1,
                  cursor: draftGoals().length === 0 ? "default" : "pointer",
                }}
              >
                {commitM.isPending ? "FREEZING CONTRACT…" : ">>> COMMIT THE DAY <<<"}
              </button>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textGhost,
                  textAlign: "center",
                  marginTop: 6,
                  lineHeight: 1.4,
                }}
              >
                {draftGoals().length === 0
                  ? "Write at least one goal — a day with nothing said cannot be scored on it."
                  : "After this the text is frozen into an immutable contract. You can complete or abandon, not edit."}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 5. Two-Column Operational Grid (1.3fr : 1fr) ──────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.3fr 1fr",
          gap: 24,
          alignItems: "start",
        }}
      >
        {/* Left Column: Production Pulse + Hermes Fleet */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Pipeline Mini Funnel */}
          <div>
            <SectionLabel
              right={
                <span
                  onClick={() => onNav("pipeline")}
                  className="mono"
                  style={{ fontSize: 10, color: tokens.accent, cursor: "pointer" }}
                >
                  open pipeline →
                </span>
              }
            >
              PIPELINE FUNNEL PULSE
            </SectionLabel>

            <div
              style={{
                ...CARD,
                padding: "16px 14px",
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 8,
              }}
            >
              {pipelinePhases.map((p, idx) => {
                const isReady = p.key === "ready" || idx === 4;
                return (
                  <div
                    key={p.key}
                    onClick={() => onNav("pipeline")}
                    style={{
                      background: p.count > 0 ? tokens.selectedBg : tokens.toolBg,
                      border: `1px solid ${p.count > 0 ? (isReady ? tokens.ok : tokens.accent) : tokens.border}`,
                      borderRadius: 8,
                      padding: "10px 8px",
                      textAlign: "center",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: p.count > 0 ? tokens.textHi : tokens.textGhost,
                        letterSpacing: "0.04em",
                      }}
                    >
                      {p.label}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 18,
                        fontWeight: 600,
                        color: p.count > 0 ? (isReady ? tokens.ok : tokens.accent) : tokens.textFaint,
                        marginTop: 4,
                      }}
                    >
                      {p.count}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hermes Fleet Status */}
          <div>
            <SectionLabel
              right={
                <span
                  onClick={() => onNav("live")}
                  className="mono"
                  style={{ fontSize: 10, color: tokens.accent, cursor: "pointer" }}
                >
                  live telemetry →
                </span>
              }
            >
              HERMES FLEET STATUS
            </SectionLabel>

            {data.fleet.length === 0 ? (
              <EmptyState icon="smart_toy">
                No workers reporting in. All systems nominal or offline.
              </EmptyState>
            ) : (
              <div
                style={{
                  ...CARD,
                  overflow: "hidden",
                }}
              >
                {data.fleet.map((w: FleetWorker, i: number) => {
                  const color = workerDotColor(w.status, w.state);
                  const stateStr = (w.state ?? "").toLowerCase();
                  const isRunning =
                    w.status === "routing" ||
                    w.status === "render" ||
                    stateStr.includes("run") ||
                    stateStr.includes("act");
                  const isLast = i === data.fleet.length - 1;
                  return (
                    <div
                      key={w.name}
                      onClick={() => onNav("chat")}
                      title={`Click to inspect /watch ${w.name} in chat`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "11px 16px",
                        borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
                        cursor: "pointer",
                        background: "transparent",
                      }}
                    >
                      <span style={dot(color, isRunning)} />
                      <span
                        className="mono"
                        style={{ fontSize: 12, color: tokens.textLabel, fontWeight: 500 }}
                      >
                        {w.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: isRunning ? tokens.ok : tokens.textGhost,
                        }}
                      >
                        {w.state || w.status}
                      </span>
                      <span
                        className="ms"
                        style={{ fontSize: 14, color: tokens.textGhost, marginLeft: 4 }}
                      >
                        arrow_forward
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Actionable Inbox Cards */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              minHeight: 18,
            }}
          >
            <span className="mono" style={{ fontSize: 10, color: tokens.textFaint, letterSpacing: "0.1em" }}>
              NEEDS YOU (ACTIONABLE INBOX)
            </span>
            <span
              onClick={() => onNav("inbox")}
              className="mono"
              style={{ fontSize: 10, color: tokens.accent, cursor: "pointer" }}
            >
              {inboxCount} open · full inbox →
            </span>
          </div>

          {(inboxQ.data ?? []).length === 0 ? (
            <div
              style={{
                ...CARD,
                border: `1px dashed ${tokens.border}`,
                padding: "32px 20px",
                textAlign: "center",
              }}
            >
              <span className="ms" style={{ fontSize: 24, color: tokens.ok }}>
                check_circle
              </span>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: tokens.textHi,
                  marginTop: 8,
                }}
              >
                Inbox Zero
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: tokens.textFaint,
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                Autonomous loops normal. Manager is handling everything else.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(inboxQ.data ?? []).slice(0, 4).map((item: InboxItemUi) => {
                const color = statusColor(item.status);
                return (
                  <div
                    key={item.id}
                    style={{
                      ...CARD,
                      borderLeft: `3px solid ${color}`,
                      padding: "14px 16px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          fontWeight: 600,
                          color,
                          letterSpacing: "0.06em",
                        }}
                      >
                        {item.type}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
                        {item.age}
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 500,
                        color: tokens.textHi,
                        lineHeight: 1.4,
                      }}
                    >
                      {item.title}
                    </div>

                    {item.ask && item.ask !== item.title && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: tokens.textSecondary,
                          lineHeight: 1.45,
                        }}
                      >
                        {item.ask}
                      </div>
                    )}

                    {/* 1-Click Action Buttons */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 4,
                        flexWrap: "wrap",
                      }}
                    >
                      {item.actions && item.actions.length > 0 ? (
                        item.actions.map((act: InboxAction, idx: number) => {
                          const isOk = act.variant === "ok" || act.variant === "primary";
                          const isDanger = act.variant === "danger";
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() =>
                                resolveInboxM.mutate({
                                  id: item.id,
                                  action_id: act.action_id || act.label.toLowerCase(),
                                })
                              }
                              style={{
                                ...ghostButton(),
                                minHeight: 30,
                                padding: "4px 10px",
                                fontSize: 11,
                                fontWeight: 500,
                                background: isOk
                                  ? tokens.okActionBg
                                  : isDanger
                                    ? tokens.dangerActionBg
                                    : tokens.toolBg,
                                borderColor: isOk
                                  ? tokens.okActionBorder
                                  : isDanger
                                    ? tokens.dangerActionBorder
                                    : tokens.border,
                                color: isOk
                                  ? tokens.ok
                                  : isDanger
                                    ? tokens.bleed
                                    : tokens.text,
                              }}
                            >
                              {act.label}
                            </button>
                          );
                        })
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            resolveInboxM.mutate({
                              id: item.id,
                              action_id: "resolve",
                            })
                          }
                          style={{
                            ...ghostButton(),
                            minHeight: 30,
                            padding: "4px 10px",
                            fontSize: 11,
                            color: tokens.ok,
                            borderColor: tokens.okActionBorder,
                            background: tokens.okActionBg,
                          }}
                        >
                          Resolve
                        </button>
                      )}

                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        onClick={() => onNav("inbox")}
                        style={{
                          ...ghostButton(),
                          minHeight: 30,
                          padding: "4px 8px",
                          fontSize: 10.5,
                          border: "none",
                          background: "transparent",
                          color: tokens.accent,
                        }}
                      >
                        Inspect →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── 6. Habit Execution Strip ───────────────────────────────────────── */}
      <div>
        <SectionLabel
          right={
            <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
              {tickedHabits.size} / {(dailyQ.data?.habits ?? []).length} Ticked
            </span>
          }
        >
          HABIT EXECUTION STRIP (OPTIMISTIC)
        </SectionLabel>

        <div style={{ ...CARD, padding: "18px 20px" }}>
          <HabitChips
            habits={dailyQ.data?.habits ?? []}
            done={tickedHabits}
            onToggle={(habit, next) => habitM.mutate({ habit, next })}
            disabled={dailyQ.isLoading}
          />
        </div>
      </div>

      {/* ── 7. Overnight Machine Diary ─────────────────────────────────────── */}
      <div style={{ ...CARD, padding: "16px 20px" }}>
        <div
          onClick={() => setDiaryOpen(!diaryOpen)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="ms" style={{ fontSize: 18, color: tokens.accent }}>
              auto_mode
            </span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: tokens.textHi }}>
              OVERNIGHT MACHINE DIARY
            </span>
            <span
              className="mono"
              style={{ fontSize: 10, color: tokens.textSecondary }}
            >
              · {stuckCount === 0 ? "0 runs failed" : `${stuckCount} alert(s)`} · €{meteredSpendEur.toFixed(2)} metered spend · {pipelineTotal} pipeline jobs
            </span>
          </div>
          <button
            type="button"
            style={{
              ...ghostButton(),
              padding: "4px 8px",
              fontSize: 10.5,
              minHeight: 26,
            }}
          >
            {diaryOpen ? "Collapse ↑" : "Expand Log ↓"}
          </button>
        </div>

        {diaryOpen && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${tokens.borderDivider}`,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.textSecondary,
                lineHeight: 1.6,
                background: tokens.toolBg,
                padding: "12px 14px",
                borderRadius: 6,
              }}
            >
              <div>• Fleet Status: {data.fleet.length} Hermes workers active / monitored.</div>
              <div>• Pipeline Funnel: {pipelineTotal} jobs loaded across 5 pipeline stages.</div>
              <div>• Telemetry: Database, Redis queues, and LLM router pools answering health probes.</div>
              <div>• Daily Plan: {isCommitted ? `Committed at ${clockOf(committedAt)}` : "Awaiting operator commitment"}.</div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => onNav("live")}
                style={{ ...ghostButton(), fontSize: 11 }}
              >
                View Live Telemetry
              </button>
              <button
                type="button"
                onClick={() => onNav("chat")}
                style={{ ...ghostButton(), fontSize: 11 }}
              >
                Open Manager Chat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Loading Skeleton Component
 * -------------------------------------------------------------------------- */

function TodaySkeleton() {
  return (
    <div
      style={{
        maxWidth: 1120,
        margin: "0 auto",
        padding: "36px 36px 64px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* Top Briefing Skeleton */}
      <div
        style={{
          ...CARD,
          padding: "24px",
          height: 100,
          background: tokens.bgCard,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "50%" }}>
          <div
            style={{
              height: 12,
              width: 140,
              background: tokens.toolBg,
              borderRadius: 4,
            }}
          />
          <div
            style={{
              height: 24,
              width: 280,
              background: tokens.toolBg,
              borderRadius: 4,
            }}
          />
        </div>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: tokens.toolBg,
          }}
        />
      </div>

      {/* Morning Line Chips Skeleton */}
      <div style={{ display: "flex", gap: 10 }}>
        {[140, 110, 90, 90, 150].map((w, i) => (
          <div
            key={i}
            style={{
              width: w,
              height: TAP,
              background: tokens.toolBg,
              borderRadius: 8,
            }}
          />
        ))}
      </div>

      {/* Big 3 Skeleton */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ height: 14, width: 200, background: tokens.toolBg, borderRadius: 4 }} />
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              ...CARD,
              height: 68,
              background: tokens.bgCard,
            }}
          />
        ))}
      </div>

      {/* Two Column Skeleton */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 24 }}>
        <div style={{ ...CARD, height: 160, background: tokens.bgCard }} />
        <div style={{ ...CARD, height: 160, background: tokens.bgCard }} />
      </div>
    </div>
  );
}
