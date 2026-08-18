"use client";

/**
 * TODAY — the said-vs-done loop for one calendar day (§1, §6 TODAY).
 *
 *   evening (operator)  the plan is drafted FOR him — never a blank page
 *   morning (COMMIT)    the Big 3 freeze. This is "said".
 *   all day             tick tasks and habits. This is "done".
 *   night               the score, and a one-tap subjective rating.
 *
 * The commit lock is the product, so it is real behaviour here and not a
 * comment: before `committed_at` the Big 3 are three inputs; after it they are
 * three lines of text with a tick, a lock, and an ABANDON affordance that
 * demands a reason. There is no path through this component that rewrites a
 * committed goal — that is the exact move Notion allowed and the reason his
 * old stats meant nothing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { toDayKey } from "./quick-add";
import {
  CARD,
  EmptyState,
  ScoreRing,
  SectionLabel,
  TAP,
  chipStyle,
  clockOf,
  formatDay,
  ghostButton,
  inputStyle,
  pctText,
  primaryButton,
} from "./ui";

export interface TodayActions {
  onSavePlan: (input: { intent: string | null; big3: DayGoal[] }) => void;
  onCommit: (input: { intent: string | null; big3: DayGoal[] }) => void;
  onGoalStatus: (goalId: string, status: DayGoalStatus, reason?: string) => void;
  onHabit: (habit: DayHabit, next: boolean) => void;
  onReflect: (input: { subjective?: number; reflection?: string }) => void;
  /** §5's "Do it today": pin onto the viewed day and reset the carry. */
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

/** Ids belong to the jsonb entry, so one is minted the first time a line is
 *  saved and then travels with it. Not generated during render — a random
 *  value in the server pass and a different one on the client is how a
 *  hydration bug is born. */
function newGoalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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

  /* ── the draft, and why it does not get clobbered ──────────────────────
     The day refetches every 30s and after every mutation. Re-seeding these
     inputs from each response would delete whatever half-typed goal was in
     the box. So the draft re-seeds only when the day changes, when the commit
     stamp changes, or when the server's copy changes while nothing local is
     dirty. */
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
    // Ids minted on save are written back so the next keystroke edits the
    // same entry instead of creating a second one.
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

  const left = (
    <div>
      <DayHeader
        day={day}
        score={data?.score.score ?? null}
        detail={data?.score ?? null}
        provisional={data?.score.provisional ?? isToday}
        committedAt={committedAt}
        /* `|| null` and not `?? null`: an empty draft box is "no intent set",
           and the header must say so rather than render a blank line. */
        intent={committed ? (plan?.intent ?? null) : (intent.trim() || null)}
        isToday={isToday}
        generatedBy={plan?.generated_by ?? null}
      />

      {!committed && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            style={{
              ...primaryButton(),
              opacity: draftGoals().length === 0 ? 0.45 : 1,
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
            COMMIT THE DAY
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
              ? "write at least one goal — a day with nothing said cannot be scored on it"
              : "after this the text is frozen. You can complete or abandon a goal, not rewrite it."}
          </div>
        </div>
      )}

      <SectionLabel
        right={
          committed ? (
            <span
              className="mono"
              title={`committed at ${clockOf(committedAt)} — abandon instead of editing`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 9.5,
                color: tokens.textGhost,
              }}
            >
              <span className="ms" style={{ fontSize: 13 }}>
                lock
              </span>
              committed {clockOf(committedAt)}
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
              draft · editable
            </span>
          )
        }
      >
        THE BIG 3
      </SectionLabel>

      {committed ? (
        goals.length === 0 ? (
          <EmptyState icon="flag">
            This day was committed with no goals. Nothing to measure — the score
            falls back to habits and tasks alone.
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
            <EmptyState icon="hourglass_empty">Loading the day…</EmptyState>
          )}
          {!loading && !plan && (
            <EmptyState icon="edit_calendar">
              No plan yet — the evening job writes tomorrow&apos;s Big 3 at
              20:30 from your open tasks, calendar and daily note. Or write them
              yourself, right here.
            </EmptyState>
          )}
          <input
            value={intent}
            onChange={(e) => {
              dirtyRef.current = true;
              setIntent(e.target.value);
            }}
            onBlur={flush}
            placeholder="Intent — one line: what today is FOR"
            aria-label="Intent for the day"
            style={inputStyle()}
          />
          {slots.map((s, i) => (
            <div key={i} style={{ ...CARD, padding: 10 }}>
              <input
                value={s.text}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setSlots((cur) =>
                    cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                  );
                }}
                onBlur={flush}
                placeholder={`Goal ${i + 1} — what must be true tonight`}
                aria-label={`Big 3 goal ${i + 1}`}
                style={{ ...inputStyle(), border: "none", background: "transparent", padding: "6px 4px" }}
              />
              <input
                value={s.why}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setSlots((cur) =>
                    cur.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)),
                  );
                }}
                onBlur={flush}
                placeholder="why it matters (optional)"
                aria-label={`Why goal ${i + 1} matters`}
                style={{
                  ...inputStyle(),
                  border: "none",
                  background: "transparent",
                  padding: "2px 4px",
                  fontSize: 11.5,
                  color: tokens.textMuted,
                  minHeight: 28,
                }}
              />
            </div>
          ))}
        </div>
      )}

      <SectionLabel>HABITS</SectionLabel>
      <HabitChips
        habits={data?.habits ?? []}
        done={ticked}
        onToggle={actions.onHabit}
        disabled={!data}
      />

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

  const right = (
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
        TODAY&apos;S TASKS
      </SectionLabel>

      {tasks.length === 0 ? (
        <EmptyState icon="task_alt">
          Nothing planned for {formatDay(day)} — add a task below, or let the
          evening job schedule them onto the day at 20:30.
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
  );

  if (narrow) {
    return (
      <div>
        {left}
        <div style={{ marginTop: 4 }}>{right}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
        gap: 22,
        alignItems: "start",
      }}
    >
      {left}
      {right}
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
    <div style={{ ...CARD, padding: "14px 15px", display: "flex", gap: 14 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 500, color: tokens.textHi }}>
          {formatDay(day)}
          {isToday && (
            <span className="mono" style={{ fontSize: 10, color: tokens.accent, marginLeft: 8 }}>
              TODAY
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: intent ? tokens.textSecondary : tokens.textGhost,
            marginTop: 5,
            lineHeight: 1.5,
          }}
        >
          {intent ?? "no intent set — one line on what today is FOR"}
        </div>
        <div
          className="mono"
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            fontSize: 9.5,
            color: tokens.textGhost,
            marginTop: 8,
          }}
        >
          <span title="of the Big 3 committed, how many are done">
            goals {pctText(detail?.goal_pct ?? null)}
          </span>
          <span title="weighted share of active habits ticked">
            habits {pctText(detail?.habit_pct ?? null)}
          </span>
          <span title="tasks completed of tasks planned for the day">
            tasks {pctText(detail?.task_pct ?? null)}
          </span>
          {generatedBy && <span>plan by {generatedBy}</span>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
        <ScoreRing score={score} muted={!committed} />
        <span
          className="mono"
          style={{ fontSize: 8.5, color: tokens.textGhost, textAlign: "center" }}
        >
          {!committed ? "not committed" : provisional ? "provisional" : "final"}
        </span>
      </div>
    </div>
  );
}

/** A committed goal. Text, not an input — the tick and ABANDON are the only
 *  two things that may happen to it now (§1). */
function CommittedGoal({
  goal,
  onStatus,
}: {
  goal: DayGoal;
  onStatus: (goalId: string, status: DayGoalStatus, reason?: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const done = goal.status === "done";
  const abandoned = goal.status === "abandoned";
  const tone = done ? tokens.accent : abandoned ? tokens.textGhost : tokens.textSoft;

  return (
    <div
      style={{
        ...CARD,
        borderColor: done ? tokens.accent : tokens.border,
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
              border: `2px solid ${done ? tokens.accent : tokens.borderEmphasis}`,
              background: done ? tokens.accent : "transparent",
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
        <div style={{ flex: 1, minWidth: 0, paddingTop: 8 }}>
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.4,
              color: tone,
              textDecoration: done || abandoned ? "line-through" : "none",
              wordBreak: "break-word",
            }}
          >
            {goal.text}
          </div>
          {goal.why && (
            <div style={{ fontSize: 11.5, color: tokens.textMuted, marginTop: 4, lineHeight: 1.5 }}>
              {goal.why}
            </div>
          )}
          {abandoned && (
            <div className="mono" style={{ fontSize: 10, color: tokens.warn, marginTop: 5 }}>
              abandoned{goal.reason ? ` — ${goal.reason}` : ""}
            </div>
          )}
          {done && goal.done_at && (
            <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, marginTop: 5 }}>
              done {clockOf(goal.done_at)}
            </div>
          )}
        </div>
        {!abandoned && (
          <button
            type="button"
            aria-label="Goal options"
            title="committed — abandon instead of editing"
            onClick={() => setAsking((a) => !a)}
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

      {asking && (
        <div style={{ padding: "8px 6px 2px 50px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.5 }}>
            The text is frozen. You can abandon it — with a reason, on the
            record.
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why are you dropping this?"
            aria-label="Reason for abandoning"
            style={inputStyle()}
          />
          <div style={{ display: "flex", gap: 7 }}>
            <button
              type="button"
              style={{
                ...ghostButton(),
                color: reason.trim() ? tokens.bleed : tokens.textGhost,
                borderColor: reason.trim() ? tokens.dangerActionBorder : tokens.border,
                background: reason.trim() ? tokens.dangerActionBg : tokens.toolBg,
                cursor: reason.trim() ? "pointer" : "default",
              }}
              disabled={!reason.trim()}
              onClick={() => {
                onStatus(goal.id, "abandoned", reason.trim());
                setAsking(false);
                setReason("");
              }}
            >
              ABANDON
            </button>
            <button type="button" style={ghostButton()} onClick={() => setAsking(false)}>
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * §5, and the answer to `Age 121 / Time until due -41`. Two buttons, no third
 * option: do it today, or kill it. A task that has slid three times has
 * already told you which one it is.
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
        border: `1.5px solid ${tokens.freezeBorderWarn}`,
        background: tokens.freezeBgWarn,
        padding: "12px 13px",
        marginBottom: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="ms" style={{ fontSize: 18, color: tokens.warn }}>
          running_with_errors
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.warn }}>
          This keeps sliding — do it or kill it
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        {tasks.map((t) => (
          <div key={t.id}>
            <div style={{ fontSize: 12.5, color: tokens.textSoft, lineHeight: 1.4 }}>
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
                Do it today
              </button>
              <button
                type="button"
                style={{ ...chipStyle(false, tokens.bleed), color: tokens.bleed, flex: 1 }}
                onClick={() => onKill(t)}
              >
                Kill it
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** NIGHT (§6 TODAY 6). Appears after 20:00, and always on a past day. */
function NightPanel({
  score,
  fulfilled,
  subjective,
  reflection,
  provisional,
  onReflect,
}: {
  score: number | null;
  /** From the server's score object — §3 owns the 80 threshold, not this
   *  component. */
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
    <div style={{ marginTop: 4 }}>
      <SectionLabel>NIGHT</SectionLabel>
      <div style={{ ...CARD, padding: "13px 14px" }}>
        <div
          style={{
            fontSize: fulfilled ? 14.5 : 13.5,
            fontWeight: fulfilled ? 600 : 500,
            color: fulfilled ? tokens.ok : tokens.textSoft,
            lineHeight: 1.45,
          }}
        >
          {fulfilled
            ? "Day fulfilled — rest guilt-free."
            : score === null
              ? "Nothing to score yet."
              : `Day score ${Math.round(score)}.`}
        </div>
        <div className="mono" style={{ fontSize: 10, color: tokens.textGhost, marginTop: 4 }}>
          {score === null
            ? "no goals, no habits, no tasks — there is no denominator to divide by"
            : provisional
              ? "provisional — the day isn't over"
              : fulfilled
                ? "80 or more. Earned."
                : "the honest number. Tomorrow gets another one."}
        </div>

        <div className="mono" style={{ fontSize: 9.5, color: tokens.textGhost, margin: "13px 0 6px" }}>
          HOW DID IT ACTUALLY FEEL?
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
                ...chipStyle(subjective === n, tokens.decide),
                flex: 1,
                padding: 0,
                fontSize: 14,
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
          placeholder="one line, if you want one"
          aria-label="Reflection"
          style={{ ...inputStyle(), marginTop: 9 }}
        />
      </div>
    </div>
  );
}
