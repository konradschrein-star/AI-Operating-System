"use client";

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import { CARD, SectionLabel, EmptyState, areaColor } from "../goals/ui";
import type {
  JournalEvidence,
  JournalError,
  JournalEvidenceTaskDone,
  JournalEvidenceEvent,
  JournalEvidenceCommit,
  JournalEvidenceRender,
  JournalEvidenceRuns,
  JournalEvidenceDecision,
  JournalEvidenceHabits,
  JournalEvidenceGlucose,
} from "../../api";
import { decisionKindColor } from "../../data";

export interface DayEvidenceProps {
  day: string;
  evidence: JournalEvidence | null | undefined;
  errors?: JournalError[];
  isLoading?: boolean;
}

function formatClock(isoOrTs: string): string {
  try {
    const d = new Date(isoOrTs);
    if (Number.isNaN(d.getTime())) return isoOrTs;
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return isoOrTs;
  }
}

function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatClock(startIso)}–${formatClock(endIso)}`;
}

const MODELLED_DECISION_KINDS = [
  "dispatch",
  "breaker",
  "degrade",
  "escalate",
  "unstick",
  "resolve",
  "freeze",
  "resume",
  "guardrail",
  "manager",
  "user",
] as const;

type ModelledDecisionKind = (typeof MODELLED_DECISION_KINDS)[number];

function kindColorFor(kind: string): string {
  const known = MODELLED_DECISION_KINDS.find(
    (k): k is ModelledDecisionKind => k === kind,
  );
  return known ? decisionKindColor(known) : tokens.textMuted;
}

function EvidenceErrorBanner({ message, source }: { message: string; source: string }) {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: 8,
        border: `1px solid ${tokens.bleed}`,
        background: tokens.bgCard,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <span className="ms" style={{ fontSize: 16, color: tokens.bleed, marginTop: 1 }}>
        error_outline
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: tokens.bleed }}>
          Source &apos;{source}&apos; failed
        </div>
        <div className="mono" style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
          {message}
        </div>
      </div>
    </div>
  );
}

export function DayEvidence({
  day,
  evidence,
  errors = [],
  isLoading = false,
}: DayEvidenceProps) {
  if (isLoading) {
    return (
      <div>
        <SectionLabel>WHAT HAPPENED</SectionLabel>
        <EmptyState icon="hourglass_empty">Loading daily evidence…</EmptyState>
      </div>
    );
  }

  if (!evidence) {
    return (
      <div>
        <SectionLabel>WHAT HAPPENED</SectionLabel>
        <EmptyState icon="info">No evidence assembled for {day}.</EmptyState>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionLabel>WHAT HAPPENED · DAY EVIDENCE</SectionLabel>

      {/* Grid of Evidence Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 12,
        }}
      >
        {/* 1. Tasks Closed Card */}
        <TasksClosedCard
          tasks={evidence.tasks_done}
          error={errors.find((e) => e.source === "tasks_done" || e.source === "tasks")}
        />

        {/* 2. Calendar Events Card */}
        <CalendarEventsCard
          events={evidence.events}
          error={errors.find((e) => e.source === "events" || e.source === "calendar")}
        />

        {/* 3. Git Commits Card */}
        <CommitsCard
          commits={evidence.commits}
          error={errors.find((e) => e.source === "commits" || e.source === "git")}
        />

        {/* 4. ReelForge Renders Card */}
        <RendersCard
          renders={evidence.renders}
          error={errors.find((e) => e.source === "renders" || e.source === "content_jobs")}
        />

        {/* 5. Agent Runs Card */}
        <RunsCard
          runs={evidence.runs}
          error={errors.find((e) => e.source === "runs")}
        />

        {/* 6. Decisions Card */}
        <DecisionsCard
          decisions={evidence.decisions}
          error={errors.find((e) => e.source === "decisions")}
        />

        {/* 7. Habits Ticked Card */}
        <HabitsCard
          habits={evidence.habits}
          error={errors.find((e) => e.source === "habits")}
        />

        {/* 8. Glucose Card */}
        <GlucoseCard
          glucose={evidence.glucose}
          error={errors.find((e) => e.source === "glucose")}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. TASKS CLOSED CARD
 * ────────────────────────────────────────────────────────────────────────── */
function TasksClosedCard({
  tasks,
  error,
}: {
  tasks: JournalEvidenceTaskDone[] | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.ok }}>
            check_circle
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            TASKS CLOSED
          </span>
        </div>
        {tasks && (
          <span className="mono" style={{ fontSize: 11, color: tasks.length > 0 ? tokens.ok : tokens.textGhost }}>
            {tasks.length} closed
          </span>
        )}
      </div>

      {tasks === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="tasks_done" />
      ) : tasks.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 tasks completed on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 12, color: tokens.textHi, wordBreak: "break-word" }}>
                  {t.title}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {t.area && (
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 600,
                        color: areaColor(t.area),
                        background: tokens.bgCard,
                        padding: "1px 5px",
                        borderRadius: 3,
                        border: `1px solid ${tokens.borderDivider}`,
                      }}
                    >
                      {t.area}
                    </span>
                  )}
                  {t.goal_title && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: tokens.accent,
                        background: tokens.primaryActionBg,
                        padding: "1px 5px",
                        borderRadius: 3,
                        border: `1px solid ${tokens.borderDivider}`,
                      }}
                    >
                      🎯 {t.goal_title}
                    </span>
                  )}
                </div>
              </div>
              {t.done_at && (
                <span className="mono" style={{ fontSize: 10, color: tokens.textGhost, flexShrink: 0 }}>
                  {formatClock(t.done_at)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. CALENDAR EVENTS CARD
 * ────────────────────────────────────────────────────────────────────────── */
function CalendarEventsCard({
  events,
  error,
}: {
  events: JournalEvidenceEvent[] | null;
  error?: JournalError;
}) {
  const totalMin = useMemo(() => {
    if (!events) return 0;
    return events.reduce((acc, ev) => acc + (ev.minutes || 0), 0);
  }, [events]);

  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.info }}>
            event
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            CALENDAR EVENTS
          </span>
        </div>
        {events && (
          <span className="mono" style={{ fontSize: 11, color: events.length > 0 ? tokens.info : tokens.textGhost }}>
            {events.length} events · {totalMin}m
          </span>
        )}
      </div>

      {events === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="events" />
      ) : events.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 calendar events ended on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {events.map((ev) => (
            <div
              key={ev.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 12, color: tokens.textHi, wordBreak: "break-word" }}>
                  {ev.summary}
                </span>
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  {formatTimeRange(ev.start, ev.end)} ({ev.minutes}m)
                </span>
              </div>
              {ev.task_id && (
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.accent,
                    background: tokens.bgCard,
                    padding: "1px 4px",
                    borderRadius: 3,
                    border: `1px solid ${tokens.borderDivider}`,
                    flexShrink: 0,
                  }}
                >
                  task linked
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. GIT COMMITS CARD
 * ────────────────────────────────────────────────────────────────────────── */
function CommitsCard({
  commits,
  error,
}: {
  commits: JournalEvidenceCommit[] | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.accent }}>
            commit
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            GIT COMMITS
          </span>
        </div>
        {commits && (
          <span className="mono" style={{ fontSize: 11, color: commits.length > 0 ? tokens.accent : tokens.textGhost }}>
            {commits.length} commits
          </span>
        )}
      </div>

      {commits === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="commits" />
      ) : commits.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 git commits on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {commits.map((c, i) => (
            <div
              key={`${c.sha}-${i}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: tokens.accent,
                      background: tokens.bgCard,
                      padding: "1px 4px",
                      borderRadius: 3,
                      border: `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    {c.repo}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: tokens.textSecondary, fontWeight: 600 }}>
                    {c.sha.slice(0, 7)}
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: tokens.textHi, wordBreak: "break-word" }}>
                  {c.subject}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: tokens.textGhost, flexShrink: 0 }}>
                {formatClock(c.at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. REELFORGE RENDERS CARD
 * ────────────────────────────────────────────────────────────────────────── */
function RendersCard({
  renders,
  error,
}: {
  renders: JournalEvidenceRender[] | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.warn }}>
            movie
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            REELFORGE RENDERS
          </span>
        </div>
        {renders && (
          <span className="mono" style={{ fontSize: 11, color: renders.length > 0 ? tokens.warn : tokens.textGhost }}>
            {renders.length} rendered
          </span>
        )}
      </div>

      {renders === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="renders" />
      ) : renders.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 ReelForge renders completed on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {renders.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 600,
                    color: r.status === "completed" || r.status === "rendered" ? tokens.ok : tokens.warn,
                    background: tokens.bgCard,
                    padding: "1px 5px",
                    borderRadius: 3,
                    border: `1px solid ${tokens.borderDivider}`,
                  }}
                >
                  {r.status}
                </span>
                <span style={{ fontSize: 12, color: tokens.textHi, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.title}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: tokens.textGhost, flexShrink: 0 }}>
                {formatClock(r.completed_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 5. AGENT RUNS CARD
 * ────────────────────────────────────────────────────────────────────────── */
function RunsCard({
  runs,
  error,
}: {
  runs: JournalEvidenceRuns | null;
  error?: JournalError;
}) {
  const [showAll, setShowAll] = useState(false);

  const displayedItems = useMemo(() => {
    if (!runs?.items) return [];
    return showAll ? runs.items : runs.items.slice(0, 10);
  }, [runs, showAll]);

  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.decide }}>
            smart_toy
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            AGENT RUNS
          </span>
        </div>
        {runs && (
          <div className="mono" style={{ fontSize: 10.5, color: tokens.textSecondary, display: "flex", gap: 6 }}>
            <span>chat: <b style={{ color: tokens.info }}>{runs.chat}</b></span>
            <span style={{ color: tokens.textGhost }}>·</span>
            <span>worker: <b style={{ color: tokens.ok }}>{runs.worker}</b></span>
            <span style={{ color: tokens.textGhost }}>·</span>
            <span>cron: <b style={{ color: tokens.accent }}>{runs.cron}</b></span>
          </div>
        )}
      </div>

      {runs === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="runs" />
      ) : !runs.items || runs.items.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 agent runs on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
            {displayedItems.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "5px 8px",
                  borderRadius: 6,
                  background: tokens.toolBg,
                  border: `1px solid ${tokens.borderDivider}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      color:
                        item.kind === "chat"
                          ? tokens.info
                          : item.kind === "worker"
                            ? tokens.ok
                            : item.kind === "cron"
                              ? tokens.accent
                              : tokens.textMuted,
                      background: tokens.bgCard,
                      padding: "1px 5px",
                      borderRadius: 3,
                      border: `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    {item.kind}
                  </span>
                  <span style={{ fontSize: 11.5, color: tokens.textHi, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.title}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: item.status === "settled" || item.status === "done" ? tokens.ok : tokens.textMuted,
                    }}
                  >
                    {item.status}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
                    {formatClock(item.started_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {runs.items.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAll((p) => !p)}
              className="mono"
              style={{
                background: "none",
                border: "none",
                color: tokens.accent,
                fontSize: 10,
                cursor: "pointer",
                padding: "2px 0",
                textAlign: "left",
              }}
            >
              {showAll ? "Show top 10 only" : `Show all ${runs.items.length} items`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 6. DECISIONS CARD
 * ────────────────────────────────────────────────────────────────────────── */
function DecisionsCard({
  decisions,
  error,
}: {
  decisions: JournalEvidenceDecision[] | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.decide }}>
            gavel
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            DECISIONS
          </span>
        </div>
        {decisions && (
          <span className="mono" style={{ fontSize: 11, color: decisions.length > 0 ? tokens.decide : tokens.textGhost }}>
            {decisions.length} decisions
          </span>
        )}
      </div>

      {decisions === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="decisions" />
      ) : decisions.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 decisions logged on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {decisions.map((d, idx) => (
            <div
              key={`${d.ts}-${idx}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: kindColorFor(d.kind),
                      background: tokens.bgCard,
                      padding: "1px 5px",
                      borderRadius: 3,
                      border: `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    {d.kind}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                    {d.actor}
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: tokens.textHi, wordBreak: "break-word" }}>
                  {d.action}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: tokens.textGhost, flexShrink: 0 }}>
                {formatClock(d.ts)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 7. HABITS TICKED CARD
 * ────────────────────────────────────────────────────────────────────────── */
function HabitsCard({
  habits,
  error,
}: {
  habits: JournalEvidenceHabits | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.ok }}>
            task_alt
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            HABITS TICKED
          </span>
        </div>
        {habits && (
          <span className="mono" style={{ fontSize: 11, color: habits.ticked.length > 0 ? tokens.ok : tokens.textGhost }}>
            {habits.ticked.length}/{habits.total_active} ticked
          </span>
        )}
      </div>

      {habits === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="habits" />
      ) : habits.ticked.length === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          0 of {habits.total_active} habits ticked on this day.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
          {habits.ticked.map((h) => (
            <div
              key={h.key}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 8px",
                borderRadius: 6,
                background: tokens.okActionBg,
                border: `1px solid ${tokens.okActionBorder}`,
                fontSize: 11.5,
                color: tokens.textHi,
              }}
            >
              <span>{h.icon}</span>
              <span>{h.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 8. GLUCOSE CARD
 * ────────────────────────────────────────────────────────────────────────── */
function GlucoseCard({
  glucose,
  error,
}: {
  glucose: JournalEvidenceGlucose | null;
  error?: JournalError;
}) {
  return (
    <div
      style={{
        ...CARD,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ms" style={{ fontSize: 16, color: tokens.info }}>
            monitor_heart
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: tokens.textHi }}>
            GLUCOSE
          </span>
        </div>
        {glucose && glucose.readings > 0 && (
          <span className="mono" style={{ fontSize: 11, color: tokens.info }}>
            {glucose.readings} readings
          </span>
        )}
      </div>

      {glucose === null ? (
        <EvidenceErrorBanner message={error?.message ?? "Query rejected"} source="glucose" />
      ) : glucose.readings === 0 ? (
        <div style={{ fontSize: 12, color: tokens.textGhost, fontStyle: "italic", padding: "6px 0" }}>
          No continuous glucose readings for this day.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "4px 0" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
              MEAN
            </span>
            <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: tokens.textHi }}>
              {glucose.mean_mgdl ?? "—"} <span style={{ fontSize: 10, fontWeight: 400 }}>mg/dL</span>
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
              IN RANGE (70-140)
            </span>
            <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: tokens.ok }}>
              {glucose.in_range_pct !== null ? `${Math.round(glucose.in_range_pct)}%` : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
