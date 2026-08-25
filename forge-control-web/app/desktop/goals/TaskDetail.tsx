"use client";

/**
 * Task detail — the panel behind a click on any task.
 *
 * Konrad's ask: "one could just easily click on them, like literally in Notion
 * click on them, and this would open a whole page … add notes, add links, to
 * Google Drive or to whatever YouTube videos, or phone numbers."
 *
 * Deliberately NOT a vault note per task. Materialising a markdown file for
 * every task would put hundreds of near-empty notes into the vault — which is
 * the exact spam he is already complaining about, at ten times the volume. The
 * notes field is markdown and lives on the row; a real vault page is something
 * a task should EARN, on demand, when it turns out to need one.
 *
 * Links are recognised, not managed: any URL in the notes is rendered as a
 * clickable chip, so pasting a Drive link is the whole workflow.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { IMPORTANCE_SCALE, areaColor } from "./ui";
import { deleteDayTask, fetchLifeGoals, updateDayTask, type DayTask, type LifeGoal } from "../../api";

const AREAS = [
  "business",
  "youtube",
  "buying-selling",
  "household",
  "relationships",
  "health",
  "admin",
  "other",
];

const URL_RE = /https?:\/\/[^\s)]+/g;

export interface TaskDetailProps {
  task: DayTask;
  onClose: () => void;
  onSaved: () => void;
}

export function TaskDetail({ task, onClose, onSaved }: TaskDetailProps) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [area, setArea] = useState(task.area ?? "");
  const [importance, setImportance] = useState(task.importance);
  const [due, setDue] = useState(task.due_day ?? "");
  const [goalId, setGoalId] = useState(task.goal_id ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const lifeGoalsQ = useQuery({
    queryKey: ["life-goals"],
    queryFn: () => fetchLifeGoals(),
  });

  const sortedGoals = useMemo(() => {
    const goals: LifeGoal[] = lifeGoalsQ.data ?? [];
    return [...goals].sort((a, b) => {
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (b.status === "in_progress" && a.status !== "in_progress") return 1;
      return a.title.localeCompare(b.title);
    });
  }, [lifeGoalsQ.data]);

  const suggestedGoal = useMemo(() => {
    if (!task.suggested_goal_id) return null;
    const goals: LifeGoal[] = lifeGoalsQ.data ?? [];
    return goals.find((g) => g.id === task.suggested_goal_id) ?? null;
  }, [task.suggested_goal_id, lifeGoalsQ.data]);

  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setArea(task.area ?? "");
    setImportance(task.importance);
    setDue(task.due_day ?? "");
    setGoalId(task.goal_id ?? "");
  }, [task]);

  const links = useMemo(() => Array.from(new Set(notes.match(URL_RE) ?? [])), [notes]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setErr(null);
    try {
      await updateDayTask(task.id, {
        title: title.trim() || task.title,
        notes: notes.trim() || null,
        area: area || null,
        importance,
        due_day: due || null,
        goal_id: goalId || null,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    setSaving(true);
    try {
      await deleteDayTask(task.id);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 400,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(620px, 100%)",
          maxHeight: "86vh",
          overflowY: "auto",
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderEmphasis}`,
          borderRadius: 12,
          boxShadow: tokens.shadowPopover,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: tokens.textHi,
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            padding: "2px 0 8px",
            outline: "none",
          }}
        />

        {/* Facts the system already knows — shown, not asked for. */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Fact label="age" value={`${task.age_days}d`} />
          <Fact
            label="carried"
            value={`${task.carried}×`}
            tone={task.carried >= 3 ? tokens.bleed : undefined}
          />
          <Fact label="status" value={task.status} />
          {task.start_time && (
            <Fact
              label="scheduled"
              value={new Date(task.start_time).toLocaleString("en-GB", {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            />
          )}
          <Fact label="google" value={task.gcal_event_id ? "calendar" : task.gtask_id ? "tasks" : "—"} />
        </div>

        <Field label="Importance">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {IMPORTANCE_SCALE.map((l) => (
              <button
                key={l.value}
                onClick={() => setImportance(l.value)}
                title={l.label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 10px",
                  borderRadius: 6,
                  border: `1px solid ${importance === l.value ? l.color : tokens.borderSoft}`,
                  background: importance === l.value ? `${l.color}26` : "transparent",
                  color: importance === l.value ? l.color : tokens.textSoft,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{ width: 8, height: 8, borderRadius: 2, background: l.color, flexShrink: 0 }}
                />
                {l.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Area">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {AREAS.map((a) => (
              <button
                key={a}
                onClick={() => setArea(area === a ? "" : a)}
                style={{
                  padding: "4px 9px",
                  borderRadius: 6,
                  border: `1px solid ${area === a ? areaColor(a) : tokens.borderSoft}`,
                  background: area === a ? `${areaColor(a)}22` : "transparent",
                  color: area === a ? areaColor(a) : tokens.textSoft,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {a}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Due">
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            style={{
              padding: "6px 9px",
              borderRadius: 6,
              border: `1px solid ${tokens.border}`,
              background: tokens.inputBg,
              color: tokens.textHi,
              fontSize: 12,
              outline: "none",
            }}
          />
        </Field>

        <Field label="Life Goal">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                value={goalId}
                onChange={(e) => setGoalId(e.target.value)}
                style={{
                  flex: 1,
                  padding: "6px 9px",
                  borderRadius: 6,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.inputBg,
                  color: tokens.textHi,
                  fontSize: 12,
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="">None (unlinked)</option>
                {sortedGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.status === "in_progress" ? "in progress" : g.status})
                  </option>
                ))}
              </select>
              {goalId && (
                <button
                  type="button"
                  onClick={() => setGoalId("")}
                  style={{
                    padding: "5px 9px",
                    borderRadius: 6,
                    border: `1px solid ${tokens.borderSoft}`,
                    background: "transparent",
                    color: tokens.textSoft,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                  title="Unlink from goal"
                >
                  Clear
                </button>
              )}
            </div>

            {suggestedGoal && !goalId && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setGoalId(suggestedGoal.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 9px",
                    borderRadius: 5,
                    border: `1px solid ${tokens.accent}`,
                    background: `${tokens.accent}18`,
                    color: tokens.accent,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                  title={`Link to suggested goal "${suggestedGoal.title}"`}
                >
                  <span>suggested: {suggestedGoal.title} — link</span>
                </button>
              </div>
            )}
          </div>
        </Field>

        <Field label="Notes · markdown, paste links freely">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={7}
            placeholder={"Anything this task needs.\n\nDrive links, phone numbers, a checklist, why it matters."}
            style={{
              width: "100%",
              padding: "9px 11px",
              borderRadius: 7,
              border: `1px solid ${tokens.border}`,
              background: tokens.inputBg,
              color: tokens.textHi,
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </Field>

        {links.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {links.map((l) => (
              <a
                key={l}
                href={l}
                target="_blank"
                rel="noreferrer"
                className="mono"
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  borderRadius: 5,
                  border: `1px solid ${tokens.info}55`,
                  color: tokens.info,
                  textDecoration: "none",
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {l.replace(/^https?:\/\//, "")}
              </a>
            ))}
          </div>
        )}

        {err && (
          <div className="mono" style={{ fontSize: 11, color: tokens.bleed }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => void save()}
            disabled={saving}
            style={{
              padding: "8px 18px",
              borderRadius: 7,
              border: "none",
              background: tokens.accent,
              color: tokens.onAccent,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {saving ? "saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: "8px 14px",
              borderRadius: 7,
              border: `1px solid ${tokens.border}`,
              background: "transparent",
              color: tokens.textSoft,
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void remove()}
            disabled={saving}
            style={{
              marginLeft: "auto",
              padding: "8px 14px",
              borderRadius: 7,
              border: `1px solid ${tokens.dangerActionBorder}`,
              background: tokens.dangerActionBg,
              color: tokens.bleed,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: "0.12em",
          color: tokens.textGhost,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span className="mono" style={{ fontSize: 8.5, color: tokens.textGhost, letterSpacing: "0.1em" }}>
        {label.toUpperCase()}
      </span>
      <span className="mono" style={{ fontSize: 11.5, color: tone ?? tokens.textSoft }}>
        {value}
      </span>
    </div>
  );
}
