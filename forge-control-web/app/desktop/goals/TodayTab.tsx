"use client";

/**
 * TODAY — the executive daily command center and execution loop.
 *
 * Integrated with:
 * - Interactive 24-Hour Schedule Timeline (Google Calendar & scheduled time-blocks)
 * - Daily Intent & Focus Goals (The Big 3) with auto-wrapping text areas
 * - Actionable Tasks Queue with quick-add parser
 * - Habit Tracking with streak momentum
 * - Motivating, professional executive framing
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { tokens } from "../../tokens";
import type {
  DailyDayResponse,
  DayGoal,
  DayGoalStatus,
  DayHabit,
  DayTask,
} from "../../api";
import { HabitChips } from "./HabitChips";
import { QuickAddBox, TaskRow, sortTasks, type TaskActions } from "./TasksTab";
import { Timeline } from "./Timeline";
import { toDayKey } from "./quick-add";
import {
  CARD,
  EmptyState,
  ScoreRing,
  SectionLabel,
  TAP,
  borderlessTextareaStyle,
  chipStyle,
  clockOf,
  formatDay,
  ghostButton,
  inputStyle,
  pctText,
  primaryButton,
  textareaStyle,
} from "./ui";

export interface TodayActions {
  onSavePlan: (input: { intent: string | null; big3: DayGoal[] }) => void;
  onCommit: (input: { intent: string | null; big3: DayGoal[] }) => void;
  onGoalStatus: (goalId: string, status: DayGoalStatus, reason?: string) => void;
  onHabit: (habit: DayHabit, next: boolean) => void;
  onReflect: (input: { subjective?: number; reflection?: string }) => void;
  onPinTask: (task: DayTask) => void;
  tasks: TaskActions;
}

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

function slotsFrom(plan: DailyDayResponse["plan"]): Slot[] {
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

/**
 * Auto-expanding multi-line textarea to prevent any text clipping (Defect 2 fix).
 */
function AutoTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  ariaLabel,
  style,
  rows = 1,
}: {
  value: string;
  onChange: (val: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.max(28, ref.current.scrollHeight)}px`;
    }
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={rows}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        e.target.style.height = "auto";
        e.target.style.height = `${Math.max(28, e.target.scrollHeight)}px`;
      }}
      onBlur={onBlur}
      placeholder={placeholder}
      aria-label={ariaLabel}
      style={{
        ...style,
        overflow: "hidden",
      }}
    />
  );
}

export function TodayTab({
  day,
  data,
  loading,
  actions,
  narrow,
}: {
  day: string;
  data: DailyDayResponse | undefined;
  loading: boolean;
  actions: TodayActions;
  narrow: boolean;
}) {
  const plan = data?.plan ?? null;
  const committedAt = plan?.committed_at ?? null;
  const committed = committedAt !== null;
  const today = toDayKey(new Date());
  const isToday = day === today;
  const isPast = day < today;

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
  const seededRef = useRef(`${day}|${serverSig}`);

  useEffect(() => {
    const key = `${day}|${serverSig}`;
    if (seededRef.current === key) return;
    if (dirtyRef.current && seededRef.current.startsWith(`${day}|`)) return;
    seededRef.current = key;
    dirtyRef.current = false;
    setSlots(slotsFrom(plan));
    setIntent(plan?.intent ?? "");
  }, [day, serverSig, plan]);

  const draftGoals = (): DayGoal[] => {
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
  };

  const flush = () => {
    if (!dirtyRef.current || committed) return;
    dirtyRef.current = false;
    const goals = draftGoals();
    setSlots((cur) =>
      cur.map((s, i) => (s.id ? s : { ...s, id: goals[i]?.id ?? s.id })),
    );
    actions.onSavePlan({ intent: intent.trim() || null, big3: goals });
  };

  const goals = plan?.big3 ?? [];
  const tasks = useMemo(() => sortTasks(data?.tasks ?? []), [data]);
  const staleTasks = tasks.filter((t) => t.stale && t.status !== "done");
  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "parked");
  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const loadMin = openTasks.reduce((n, t) => n + (t.est_min ?? 0), 0);
  const ticked = useMemo(
    () => new Set((data?.ticks ?? []).filter((t) => t.done).map((t) => t.habit_id)),
    [data],
  );
  const showNight = isPast || (isToday && new Date().getHours() >= 20);

  // Left Column: 24-Hour Interactive Timeline
  const timelinePane = (
    <Timeline
      day={day}
      tasks={tasks}
      taskActions={actions.tasks}
      narrow={narrow}
    />
  );

  // Right Column: Intent, The Big 3, Tasks Queue, Habits, Night Review
  const focusPane = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Day Overview & Intent Card (Defect 1 Fix: Cleanly separated) */}
      <DayHeader
        day={day}
        score={data?.score.score ?? null}
        detail={data?.score ?? null}
        provisional={data?.score.provisional ?? isToday}
        committedAt={committedAt}
        intent={committed ? (plan?.intent ?? null) : (intent.trim() || null)}
        isToday={isToday}
        generatedBy={plan?.generated_by ?? null}
      />

      {/* Daily Strategic Intent Input Card */}
      <div style={{ ...CARD, padding: "12px 14px" }}>
        <div className="mono" style={{ fontSize: 10, color: tokens.accent, letterSpacing: "0.08em", marginBottom: 6 }}>
          TODAY&apos;S INTENT & FOCUS
        </div>
        <AutoTextarea
          value={intent}
          onChange={(val) => {
            dirtyRef.current = true;
            setIntent(val);
          }}
          onBlur={flush}
          placeholder="What is today for? (e.g. Deploy Phase 8 engine and finalize video renders)"
          ariaLabel="Day Intent"
          rows={2}
          style={{
            ...textareaStyle(),
            minHeight: 48,
            fontSize: 13.5,
            color: tokens.textHi,
          }}
        />
      </div>

      {/* Focus Goals: THE BIG 3 */}
      <div>
        <SectionLabel
          right={
            committed ? (
              <span
                className="mono"
                title={`Target set at ${clockOf(committedAt)}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 9.5,
                  color: tokens.accent,
                }}
              >
                <span className="ms" style={{ fontSize: 13 }}>
                  verified
                </span>
                focused · {clockOf(committedAt)}
              </span>
            ) : (
              <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
                draft · 1–3 primary outcomes
              </span>
            )
          }
        >
          THE BIG 3 (Core Outcomes)
        </SectionLabel>

        {committed ? (
          goals.length === 0 ? (
            <EmptyState icon="flag">
              No core focus goals were set for this day. Measuring daily progress via habits and tasks queue.
            </EmptyState>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {goals.map((g) => (
                <CommittedGoal
                  key={g.id}
                  goal={g}
                  onStatus={actions.onGoalStatus}
                />
              ))}
            </div>
          )
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {loading && !plan && (
              <EmptyState icon="hourglass_empty">Loading daily focus targets…</EmptyState>
            )}
            {!loading && !plan && (
              <EmptyState icon="edit_calendar">
                Draft your 1–3 primary outcomes below. The evening mentor job also drafts suggested outcomes at 20:30.
              </EmptyState>
            )}

            {/* Goal 1, 2, 3 cards with auto-expanding textareas */}
            {slots.map((s, i) => (
              <div key={i} style={{ ...CARD, padding: "10px 12px", borderLeft: `3px solid ${tokens.accent}` }}>
                <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, marginBottom: 4 }}>
                  GOAL #{i + 1}
                </div>
                <AutoTextarea
                  value={s.text}
                  onChange={(val) => {
                    dirtyRef.current = true;
                    setSlots((cur) =>
                      cur.map((x, j) => (j === i ? { ...x, text: val } : x)),
                    );
                  }}
                  onBlur={flush}
                  placeholder={`Outcome ${i + 1} — what must be accomplished today`}
                  ariaLabel={`Focus goal ${i + 1}`}
                  rows={1}
                  style={{
                    ...borderlessTextareaStyle(),
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                />
                <AutoTextarea
                  value={s.why}
                  onChange={(val) => {
                    dirtyRef.current = true;
                    setSlots((cur) =>
                      cur.map((x, j) => (j === i ? { ...x, why: val } : x)),
                    );
                  }}
                  onBlur={flush}
                  placeholder="Strategic rationale / why it moves the needle (optional)"
                  ariaLabel={`Why goal ${i + 1} matters`}
                  rows={1}
                  style={{
                    ...borderlessTextareaStyle(),
                    fontSize: 11.5,
                    color: tokens.textMuted,
                    marginTop: 2,
                  }}
                />
              </div>
            ))}

            {/* Commit Focus Goals Button */}
            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                style={{
                  ...primaryButton(),
                  opacity: draftGoals().length === 0 ? 0.5 : 1,
                  cursor: draftGoals().length === 0 ? "default" : "pointer",
                }}
                disabled={draftGoals().length === 0}
                onClick={() => {
                  dirtyRef.current = false;
                  actions.onCommit({
                    intent: intent.trim() || null,
                    big3: draftGoals(),
                  });
                }}
              >
                COMMIT FOCUS TARGETS
              </button>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textGhost,
                  textAlign: "center",
                  marginTop: 6,
                  lineHeight: 1.5,
                }}
              >
                {draftGoals().length === 0
                  ? "Set at least one primary outcome to establish your daily focus target"
                  : "Lock in your core outcomes. You can track progress and adapt outcomes as needed."}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Today Tasks Queue Section */}
      <div>
        {staleTasks.length > 0 && (
          <StaleStrip
            tasks={staleTasks}
            onPin={actions.onPinTask}
            onKill={(t) => actions.tasks.onSetStatus(t, "parked")}
          />
        )}

        <SectionLabel
          right={
            <span className="mono" style={{ fontSize: 9.5, color: loadMin > 480 ? tokens.warn : tokens.textGhost }}>
              {doneTasks}/{tasks.length} done
              {loadMin > 0
                ? ` · ${Math.floor(loadMin / 60)}h ${loadMin % 60}m planned`
                : ""}
            </span>
          }
        >
          ACTIONABLE TASKS
        </SectionLabel>

        {tasks.length === 0 ? (
          <EmptyState icon="task_alt">
            No tasks queued for {formatDay(day)} — add an action item below or schedule from the backlog.
          </EmptyState>
        ) : (
          <div style={{ ...CARD, overflow: "hidden" }}>
            {tasks.map((t, i) => (
              <TaskRow
                key={t.id}
                task={t}
                actions={actions.tasks}
                isLast={i === tasks.length - 1}
              />
            ))}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <QuickAddBox day={day} onAdd={actions.tasks.onAdd} />
        </div>
      </div>

      {/* Daily Habits Tracker */}
      <div>
        <SectionLabel>DAILY HABITS & RHYTHMS</SectionLabel>
        <HabitChips
          habits={data?.habits ?? []}
          done={ticked}
          onToggle={actions.onHabit}
          disabled={!data}
        />
      </div>

      {/* Evening Reflection & Day Score */}
      {showNight && (
        <NightPanel
          score={data?.score.score ?? null}
          fulfilled={data?.score.fulfilled ?? false}
          subjective={plan?.subjective ?? null}
          reflection={plan?.reflection ?? null}
          provisional={data?.score.provisional ?? isToday}
          onReflect={actions.onReflect}
        />
      )}
    </div>
  );

  if (narrow) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {focusPane}
        <div style={{ marginTop: 8 }}>
          <SectionLabel>SCHEDULE & CALENDAR</SectionLabel>
          {timelinePane}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)",
        gap: 20,
        alignItems: "start",
      }}
    >
      {timelinePane}
      {focusPane}
    </div>
  );
}

function DayHeader({
  day,
  score,
  detail,
  provisional,
  committedAt,
  intent,
  isToday,
  generatedBy,
}: {
  day: string;
  score: number | null;
  detail: DailyDayResponse["score"] | null;
  provisional: boolean;
  committedAt: string | null;
  intent: string | null;
  isToday: boolean;
  generatedBy: string | null;
}) {
  const committed = committedAt !== null;
  return (
    <div style={{ ...CARD, padding: "14px 16px", display: "flex", gap: 14, alignItems: "center" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: tokens.textHi }}>
            {formatDay(day)}
          </span>
          {isToday && (
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.accent,
                background: tokens.selectedBg,
                padding: "1px 6px",
                borderRadius: 4,
                border: `1px solid ${tokens.accent}`,
              }}
            >
              TODAY
            </span>
          )}
        </div>

        <div
          className="mono"
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 10,
            color: tokens.textMuted,
            marginTop: 8,
          }}
        >
          <span title="Primary focus outcomes completed">
            goals: <b style={{ color: tokens.textHi }}>{pctText(detail?.goal_pct ?? null)}</b>
          </span>
          <span title="Habits completed today">
            habits: <b style={{ color: tokens.textHi }}>{pctText(detail?.habit_pct ?? null)}</b>
          </span>
          <span title="Tasks completed of scheduled total">
            tasks: <b style={{ color: tokens.textHi }}>{pctText(detail?.task_pct ?? null)}</b>
          </span>
          {generatedBy && <span style={{ color: tokens.textGhost }}>planned with {generatedBy}</span>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <ScoreRing score={score} muted={!committed} />
        <span
          className="mono"
          style={{ fontSize: 8.5, color: tokens.textGhost, textAlign: "center" }}
        >
          {!committed ? "in planning" : provisional ? "provisional" : "final"}
        </span>
      </div>
    </div>
  );
}

/**
 * Committed / Active Goal display with status toggle and rationale.
 */
function CommittedGoal({
  goal,
  onStatus,
}: {
  goal: DayGoal;
  onStatus: (goalId: string, status: DayGoalStatus, reason?: string) => void;
}) {
  const [showOptions, setShowOptions] = useState(false);
  const [reason, setReason] = useState("");
  const done = goal.status === "done";
  const abandoned = goal.status === "abandoned";
  const tone = done ? tokens.accent : abandoned ? tokens.textGhost : tokens.textHi;

  return (
    <div
      style={{
        ...CARD,
        borderColor: done ? tokens.ok : tokens.border,
        padding: "10px 12px 10px 6px",
        opacity: abandoned ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <button
          type="button"
          aria-pressed={done}
          aria-label={done ? `Re-open "${goal.text}"` : `Complete "${goal.text}"`}
          disabled={abandoned}
          onClick={() => onStatus(goal.id, done ? "open" : "done")}
          style={{
            width: TAP + 4,
            height: TAP + 4,
            flex: "none",
            background: "transparent",
            border: "none",
            cursor: abandoned ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              border: `2px solid ${done ? tokens.ok : tokens.borderEmphasis}`,
              background: done ? tokens.ok : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {done && (
              <span className="ms" style={{ fontSize: 18, color: tokens.bgCard }}>
                check
              </span>
            )}
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              lineHeight: 1.4,
              color: tone,
              textDecoration: done || abandoned ? "line-through" : "none",
              wordBreak: "break-word",
            }}
          >
            {goal.text}
          </div>
          {goal.why && (
            <div style={{ fontSize: 11.5, color: tokens.textMuted, marginTop: 4, lineHeight: 1.45 }}>
              {goal.why}
            </div>
          )}
          {abandoned && (
            <div className="mono" style={{ fontSize: 10, color: tokens.warn, marginTop: 5 }}>
              deferred / archived{goal.reason ? ` — ${goal.reason}` : ""}
            </div>
          )}
          {done && goal.done_at && (
            <div className="mono" style={{ fontSize: 9.5, color: tokens.ok, marginTop: 5 }}>
              accomplished {clockOf(goal.done_at)}
            </div>
          )}
        </div>
        {!abandoned && (
          <button
            type="button"
            aria-label="Goal options"
            title="Options"
            onClick={() => setShowOptions((a) => !a)}
            style={{
              width: TAP,
              height: TAP,
              flex: "none",
              background: "transparent",
              border: "none",
              color: tokens.textGhost,
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>
              more_horiz
            </span>
          </button>
        )}
      </div>

      {showOptions && (
        <div style={{ padding: "8px 6px 2px 50px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.5 }}>
            Adjust outcome status or defer to backlog with optional context:
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason / context for deferring (optional)"
            aria-label="Reason for deferring"
            style={inputStyle()}
          />
          <div style={{ display: "flex", gap: 7 }}>
            <button
              type="button"
              style={{
                ...ghostButton(),
                color: tokens.warn,
                borderColor: tokens.border,
                cursor: "pointer",
              }}
              onClick={() => {
                onStatus(goal.id, "abandoned", reason.trim() || undefined);
                setShowOptions(false);
                setReason("");
              }}
            >
              Defer / Archive
            </button>
            <button type="button" style={ghostButton()} onClick={() => setShowOptions(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Carried tasks strip with motivating executive action framing.
 */
function StaleStrip({
  tasks,
  onPin,
  onKill,
}: {
  tasks: DayTask[];
  onPin: (t: DayTask) => void;
  onKill: (t: DayTask) => void;
}) {
  return (
    <div
      style={{
        ...CARD,
        border: `1.5px solid ${tokens.borderEmphasis}`,
        background: tokens.toolBg,
        padding: "12px 14px",
        marginBottom: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ms" style={{ fontSize: 18, color: tokens.warn }}>
          update
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
          Carried Tasks — Priority Review
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        {tasks.map((t) => (
          <div key={t.id}>
            <div style={{ fontSize: 12.5, color: tokens.textHi, lineHeight: 1.4, fontWeight: 500 }}>
              {t.title}
            </div>
            <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, margin: "3px 0 7px" }}>
              carried {t.carried}× {t.area ? `· #${t.area}` : ""}
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              <button
                type="button"
                style={{ ...chipStyle(true, tokens.accent), flex: 1 }}
                onClick={() => onPin(t)}
              >
                Focus Today
              </button>
              <button
                type="button"
                style={{ ...chipStyle(false), color: tokens.textMuted, flex: 1 }}
                onClick={() => onKill(t)}
              >
                Park to Backlog
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Evening reflection & score review.
 */
function NightPanel({
  score,
  fulfilled,
  subjective,
  reflection,
  provisional,
  onReflect,
}: {
  score: number | null;
  fulfilled: boolean;
  subjective: number | null;
  reflection: string | null;
  provisional: boolean;
  onReflect: (input: { subjective?: number; reflection?: string }) => void;
}) {
  const [text, setText] = useState(reflection ?? "");

  useEffect(() => {
    setText(reflection ?? "");
  }, [reflection]);

  return (
    <div style={{ marginTop: 6 }}>
      <SectionLabel>EVENING REVIEW & MOMENTUM</SectionLabel>
      <div style={{ ...CARD, padding: "14px 16px" }}>
        <div
          style={{
            fontSize: fulfilled ? 14.5 : 13.5,
            fontWeight: 600,
            color: fulfilled ? tokens.ok : tokens.textHi,
            lineHeight: 1.45,
          }}
        >
          {fulfilled
            ? "Day fulfilled — great momentum!"
            : score === null
              ? "Day in progress."
              : `Day Score: ${Math.round(score)}%`}
        </div>
        <div className="mono" style={{ fontSize: 10, color: tokens.textGhost, marginTop: 4 }}>
          {score === null
            ? "Track outcomes, tasks, and habits to build momentum"
            : provisional
              ? "Provisional — day in active progress"
              : fulfilled
                ? "Core targets and habits accomplished"
                : "Solid progress. Rest up for tomorrow."}
        </div>

        <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, margin: "14px 0 6px" }}>
          HOW DID TODAY FEEL? (1–5)
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={subjective === n}
              onClick={() => onReflect({ subjective: n })}
              className="mono"
              style={{
                ...chipStyle(subjective === n, tokens.accent),
                flex: 1,
                padding: 0,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {n}
            </button>
          ))}
        </div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if ((reflection ?? "") !== text) onReflect({ reflection: text });
          }}
          placeholder="Evening reflection or notes for tomorrow"
          aria-label="Reflection"
          style={{ ...inputStyle(), marginTop: 10 }}
        />
      </div>
    </div>
  );
}
