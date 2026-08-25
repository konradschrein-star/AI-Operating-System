"use client";

/**
 * Interactive 24-hour Schedule Timeline component.
 *
 * Provides a visual daily schedule (06:00–23:00 focus with 24h scrollable grid):
 * - Real Google Calendar events (colored accent borders, summary, location, Meet links).
 * - Scheduled task time-blocks (duration, area tags, 1-click completion checkbox).
 * - Current real-time red/accent indicator line.
 * - 1-click slot scheduling: slot selection popover to schedule existing or new tasks/events.
 * - Non-blocking Google Calendar sync status indicator.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  fetchCalendarView,
  createCalendarEvent,
  createDayTask,
  updateDayTask,
  type CalendarEvent,
  type DayTask,
} from "../../api";
import {
  CARD,
  areaColor,
  chipStyle,
  formatDay,
  ghostButton,
  inputStyle,
  primaryButton,
} from "./ui";
import type { TaskActions } from "./TasksTab";

const HOUR_HEIGHT = 58;
const START_HOUR = 0;
const END_HOUR = 24;
const DEFAULT_SCROLL_HOUR = 7;

interface TimelineProps {
  day: string;
  tasks: DayTask[];
  taskActions: TaskActions;
  narrow?: boolean;
}

/**
 * Helper to extract video call / meeting links from description or location.
 */
function extractVideoLink(event: CalendarEvent): string | null {
  const text = `${event.location ?? ""} ${event.description ?? ""} ${event.htmlLink ?? ""}`;
  const match = text.match(
    /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w-]+\.zoom\.us\/j\/\d+|teams\.microsoft\.com\/[^\s]+)/i,
  );
  return match ? match[0] : null;
}

/**
 * Format hour number into HH:00 display.
 */
function formatHourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * Parse an ISO date or datetime string to local Date object safely.
 */
function parseLocalTime(isoStr: string): Date | null {
  try {
    const d = new Date(isoStr);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Compute local day key YYYY-MM-DD from a Date object.
 */
function toLocalDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

export function Timeline({ day, tasks, taskActions, narrow }: TimelineProps) {
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  const [scheduleModalSlot, setScheduleModalSlot] = useState<number | null>(null);

  // Update real-time clock every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const todayKey = toLocalDateKey(now);
  const isToday = day === todayKey;

  // Auto-scroll to current hour or default 07:00 on day change
  useEffect(() => {
    if (!scrollRef.current) return;
    const targetHour = isToday ? Math.max(0, now.getHours() - 1) : DEFAULT_SCROLL_HOUR;
    scrollRef.current.scrollTop = targetHour * HOUR_HEIGHT;
  }, [day, isToday, now]);

  // Google Calendar events for this day.
  //
  // The window is resolved server-side in Europe/Berlin. It used to be built
  // here as `${day}T00:00:00Z`..`${day}T23:59:59Z`, which asks for a UTC day:
  // in summer that starts at 02:00 local and ends at 01:59 the NEXT morning, so
  // an early event vanished from its own day and two hours of tomorrow appeared
  // at the bottom of this one.
  const calendarQ = useQuery({
    queryKey: ["calendar-events", "day", day],
    queryFn: () => fetchCalendarView("day", day),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  const calendarEvents = calendarQ.data ?? [];

  // Filter tasks for this day that have a start_time set
  const scheduledTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (!t.start_time) return false;
      const d = parseLocalTime(t.start_time);
      if (!d) return false;
      return toLocalDateKey(d) === day;
    });
  }, [tasks, day]);

  // Unscheduled tasks for today (candidates for quick slotting)
  const unscheduledTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (t.status === "done" || t.status === "parked") return false;
      if (!t.start_time) return true;
      const d = parseLocalTime(t.start_time);
      return !d || toLocalDateKey(d) !== day;
    });
  }, [tasks, day]);

  // Current time position in pixels from top
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTimeTop = (currentMinutes / 60) * HOUR_HEIGHT;

  return (
    <div
      style={{
        ...CARD,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        height: "100%",
        minHeight: narrow ? 520 : 640,
      }}
    >
      {/* Timeline Header Bar */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: `1px solid ${tokens.border}`,
          background: tokens.toolBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="ms" style={{ fontSize: 18, color: tokens.accent }}>
            schedule
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
            Day Timeline
          </span>
          <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
            {formatDay(day)}
          </span>
        </div>

        {/* Sync Status Badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {calendarQ.isLoading ? (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.warn,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.warn,
                }}
              />
              Syncing GCal...
            </span>
          ) : calendarQ.isError ? (
            <span
              className="mono"
              title="Google Calendar unreachable. Re-auth via google-setup if needed."
              style={{
                fontSize: 10,
                color: tokens.textGhost,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.textGhost,
                }}
              />
              GCal Offline
            </span>
          ) : (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.ok,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.ok,
                }}
              />
              GCal Synced ({calendarEvents.length} events)
            </span>
          )}

          <button
            type="button"
            title="Refresh schedule & calendar events"
            aria-label="Refresh calendar"
            onClick={() => {
              void calendarQ.refetch();
              void qc.invalidateQueries({ queryKey: ["daily"] });
            }}
            style={{
              ...ghostButton(),
              minHeight: 28,
              padding: "0 8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              refresh
            </span>
          </button>
        </div>
      </div>

      {/* Timeline Scrollable Grid Container */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          position: "relative",
          background: tokens.bgBody,
          minHeight: 480,
          maxHeight: narrow ? 520 : "calc(100vh - 280px)",
        }}
      >
        <div
          style={{
            position: "relative",
            height: END_HOUR * HOUR_HEIGHT,
            width: "100%",
          }}
        >
          {/* Hour grid lines & click-to-schedule slots */}
          {Array.from({ length: END_HOUR - START_HOUR }).map((_, idx) => {
            const h = START_HOUR + idx;
            const top = h * HOUR_HEIGHT;
            const isNight = h < 6 || h >= 22;

            return (
              <div
                key={h}
                onClick={() => setScheduleModalSlot(h)}
                style={{
                  position: "absolute",
                  top,
                  left: 0,
                  right: 0,
                  height: HOUR_HEIGHT,
                  borderTop: `1px solid ${tokens.borderDivider}`,
                  background: isNight ? tokens.toolBg : "transparent",
                  display: "flex",
                  cursor: "pointer",
                  transition: "background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.rowHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isNight ? tokens.toolBg : "transparent";
                }}
              >
                {/* Hour Label */}
                <div
                  className="mono"
                  style={{
                    width: 50,
                    padding: "4px 6px 0",
                    fontSize: 10,
                    color: isNight ? tokens.textGhost : tokens.textMuted,
                    textAlign: "right",
                    userSelect: "none",
                    flexShrink: 0,
                  }}
                >
                  {formatHourLabel(h)}
                </div>

                {/* Slot Area */}
                <div
                  style={{
                    flex: 1,
                    position: "relative",
                    borderLeft: `1px solid ${tokens.borderDivider}`,
                  }}
                >
                  {/* Subtle hover prompt */}
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      right: 12,
                      top: 4,
                      fontSize: 9,
                      color: tokens.textGhost,
                      opacity: 0.35,
                      pointerEvents: "none",
                    }}
                  >
                    + block
                  </span>
                </div>
              </div>
            );
          })}

          {/* Render Google Calendar Event Blocks */}
          {calendarEvents.map((evt) => {
            const startDate = parseLocalTime(evt.start);
            const endDate = parseLocalTime(evt.end);
            if (!startDate) return null;

            const startHour = startDate.getHours() + startDate.getMinutes() / 60;
            const endHour = endDate
              ? endDate.getHours() + endDate.getMinutes() / 60
              : startHour + 0.75;
            const durationHours = Math.max(0.4, endHour - startHour);

            const top = startHour * HOUR_HEIGHT;
            const height = Math.max(durationHours * HOUR_HEIGHT - 2, 28);
            const meetLink = extractVideoLink(evt);

            return (
              <div
                key={evt.id}
                style={{
                  position: "absolute",
                  top: top + 1,
                  left: 54,
                  right: 10,
                  height,
                  borderRadius: 6,
                  border: `1.5px solid ${tokens.accent}`,
                  background: tokens.selectedBg,
                  padding: "4px 8px",
                  overflow: "hidden",
                  zIndex: 2,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 6,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: tokens.textHi,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: height < 44 ? "nowrap" : "normal",
                        lineHeight: 1.3,
                      }}
                    >
                      {evt.summary || "Untitled Event"}
                    </div>
                    {evt.location && height >= 44 && (
                      <div
                        style={{
                          fontSize: 9.5,
                          color: tokens.textMuted,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 1,
                        }}
                      >
                        📍 {evt.location}
                      </div>
                    )}
                  </div>

                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: tokens.accent,
                      background: tokens.toolBg,
                      padding: "1px 4px",
                      borderRadius: 4,
                      flexShrink: 0,
                    }}
                  >
                    GCal
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                    marginTop: 2,
                  }}
                >
                  <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
                    {startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {endDate &&
                      ` – ${endDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                  </span>

                  {meetLink && (
                    <a
                      href={meetLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: 10,
                        color: tokens.accent,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        textDecoration: "none",
                        fontWeight: 500,
                        background: tokens.toolBg,
                        padding: "2px 6px",
                        borderRadius: 4,
                        border: `1px solid ${tokens.border}`,
                      }}
                    >
                      <span className="ms" style={{ fontSize: 13 }}>
                        videocam
                      </span>
                      Join
                    </a>
                  )}
                </div>
              </div>
            );
          })}

          {/* Render Scheduled Task Time-Blocks */}
          {scheduledTasks.map((t) => {
            const startDate = parseLocalTime(t.start_time!);
            if (!startDate) return null;

            const startHour = startDate.getHours() + startDate.getMinutes() / 60;
            const durationMin = t.duration_min ?? t.est_min ?? 30;
            const durationHours = Math.max(0.35, durationMin / 60);

            const top = startHour * HOUR_HEIGHT;
            const height = Math.max(durationHours * HOUR_HEIGHT - 2, 28);
            const isDone = t.status === "done";
            const tagColor = t.area ? areaColor(t.area) : tokens.info;

            return (
              <div
                key={t.id}
                style={{
                  position: "absolute",
                  top: top + 1,
                  left: 54,
                  right: 10,
                  height,
                  borderRadius: 6,
                  border: `1.5px solid ${isDone ? tokens.ok : tagColor}`,
                  background: isDone ? tokens.selectedBg : tokens.bgCard,
                  padding: "4px 8px",
                  overflow: "hidden",
                  zIndex: 3,
                  boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {/* 1-Click Complete Checkbox */}
                <button
                  type="button"
                  aria-label={isDone ? `Mark "${t.title}" todo` : `Complete "${t.title}"`}
                  onClick={(e) => {
                    e.stopPropagation();
                    taskActions.onSetStatus(t, isDone ? "todo" : "done");
                  }}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    border: `1.5px solid ${isDone ? tokens.ok : tokens.borderEmphasis}`,
                    background: isDone ? tokens.ok : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  {isDone && (
                    <span className="ms" style={{ fontSize: 15, color: tokens.bgCard }}>
                      check
                    </span>
                  )}
                </button>

                {/* Task Details */}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: isDone ? tokens.textMuted : tokens.textHi,
                      textDecoration: isDone ? "line-through" : "none",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: height < 44 ? "nowrap" : "normal",
                      lineHeight: 1.25,
                    }}
                  >
                    {t.title}
                  </div>

                  {height >= 44 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 2,
                      }}
                    >
                      {t.area && (
                        <span
                          className="mono"
                          style={{
                            fontSize: 9,
                            color: tagColor,
                            background: tokens.toolBg,
                            padding: "1px 4px",
                            borderRadius: 3,
                          }}
                        >
                          #{t.area}
                        </span>
                      )}
                      <span className="mono" style={{ fontSize: 9, color: tokens.textGhost }}>
                        ~{durationMin}m
                      </span>
                    </div>
                  )}
                </div>

                {/* Time range label */}
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.textGhost,
                    flexShrink: 0,
                  }}
                >
                  {startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          })}

          {/* Current Real-Time Indicator Line */}
          {isToday && (
            <div
              style={{
                position: "absolute",
                top: currentTimeTop,
                left: 0,
                right: 0,
                display: "flex",
                alignItems: "center",
                zIndex: 10,
                pointerEvents: "none",
              }}
            >
              <div
                className="mono"
                style={{
                  background: tokens.bleed,
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 600,
                  padding: "1px 4px",
                  borderRadius: 3,
                  marginLeft: 4,
                  lineHeight: 1.2,
                }}
              >
                {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div
                style={{
                  flex: 1,
                  height: 2,
                  background: tokens.bleed,
                  boxShadow: `0 0 4px ${tokens.bleed}`,
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Quick Schedule Slot Modal / Popover */}
      {scheduleModalSlot !== null && (
        <ScheduleSlotModal
          slotHour={scheduleModalSlot}
          day={day}
          unscheduledTasks={unscheduledTasks}
          onClose={() => setScheduleModalSlot(null)}
          onScheduleExisting={async (taskId, durationMin) => {
            const timeIso = `${day}T${String(scheduleModalSlot).padStart(2, "0")}:00:00`;
            await updateDayTask(taskId, {
              start_time: timeIso,
              duration_min: durationMin,
              planned_day: day,
            });
            void qc.invalidateQueries({ queryKey: ["daily"] });
            setScheduleModalSlot(null);
          }}
          onCreateTask={async (title, area, durationMin) => {
            const timeIso = `${day}T${String(scheduleModalSlot).padStart(2, "0")}:00:00`;
            await createDayTask({
              title,
              area: area || null,
              planned_day: day,
              start_time: timeIso,
              duration_min: durationMin,
            });
            void qc.invalidateQueries({ queryKey: ["daily"] });
            setScheduleModalSlot(null);
          }}
          onCreateCalendarEvent={async (summary, durationMin, location) => {
            const startStr = `${day}T${String(scheduleModalSlot).padStart(2, "0")}:00:00Z`;
            const endHour = scheduleModalSlot + Math.ceil(durationMin / 60);
            const endStr = `${day}T${String(Math.min(23, endHour)).padStart(2, "0")}:${String(durationMin % 60).padStart(2, "0")}:00Z`;

            await createCalendarEvent({
              summary,
              start: startStr,
              end: endStr,
              location: location || undefined,
            });
            void qc.invalidateQueries({ queryKey: ["calendar-events"] });
            setScheduleModalSlot(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Quick Schedule Popover Dialog for 1-click slot scheduling.
 */
function ScheduleSlotModal({
  slotHour,
  day,
  unscheduledTasks,
  onClose,
  onScheduleExisting,
  onCreateTask,
  onCreateCalendarEvent,
}: {
  slotHour: number;
  day: string;
  unscheduledTasks: DayTask[];
  onClose: () => void;
  onScheduleExisting: (taskId: string, durationMin: number) => Promise<void>;
  onCreateTask: (title: string, area: string, durationMin: number) => Promise<void>;
  onCreateCalendarEvent: (summary: string, durationMin: number, location?: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"existing" | "new_task" | "new_event">(
    unscheduledTasks.length > 0 ? "existing" : "new_task",
  );
  const [selectedDuration, setSelectedDuration] = useState<number>(30);
  const [title, setTitle] = useState("");
  const [area, setArea] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const hourFormatted = formatHourLabel(slotHour);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          ...CARD,
          width: "100%",
          maxWidth: 460,
          background: tokens.bgCard,
          padding: 18,
          boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi }}>
              Schedule at {hourFormatted}
            </div>
            <div className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
              {formatDay(day)}
            </div>
          </div>

          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>
              close
            </span>
          </button>
        </div>

        {/* Tab Selection */}
        <div style={{ display: "flex", gap: 6 }}>
          {unscheduledTasks.length > 0 && (
            <button
              type="button"
              style={chipStyle(tab === "existing")}
              onClick={() => setTab("existing")}
            >
              Slot Task ({unscheduledTasks.length})
            </button>
          )}
          <button
            type="button"
            style={chipStyle(tab === "new_task")}
            onClick={() => setTab("new_task")}
          >
            New Task
          </button>
          <button
            type="button"
            style={chipStyle(tab === "new_event")}
            onClick={() => setTab("new_event")}
          >
            Google Event
          </button>
        </div>

        {/* Duration Pills */}
        <div>
          <div className="mono" style={{ fontSize: 10, color: tokens.textGhost, marginBottom: 6 }}>
            DURATION
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[15, 30, 45, 60, 90, 120].map((dur) => (
              <button
                key={dur}
                type="button"
                className="mono"
                style={{
                  ...chipStyle(selectedDuration === dur),
                  minHeight: 28,
                  padding: "0 8px",
                  fontSize: 11,
                }}
                onClick={() => setSelectedDuration(dur)}
              >
                {dur}m
              </button>
            ))}
          </div>
        </div>

        {/* Tab 1: Slot existing task */}
        {tab === "existing" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            <div className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
              PICK AN UNSCHEDULED TASK:
            </div>
            {unscheduledTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={submitting}
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    await onScheduleExisting(t.id, selectedDuration);
                  } finally {
                    setSubmitting(false);
                  }
                }}
                style={{
                  ...CARD,
                  padding: "8px 10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  textAlign: "left",
                  cursor: "pointer",
                  background: tokens.toolBg,
                  gap: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: tokens.textHi,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.title}
                  </div>
                  {t.area && (
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: areaColor(t.area), marginTop: 2 }}
                    >
                      #{t.area}
                    </span>
                  )}
                </div>
                <span className="ms" style={{ fontSize: 16, color: tokens.accent }}>
                  arrow_forward
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Tab 2: Create new task */}
        {tab === "new_task" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task name (e.g. Deploy engine to live)"
              autoFocus
              style={inputStyle()}
            />
            <input
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="Area tag (e.g. ai-os, content, admin)"
              style={inputStyle()}
            />
            <button
              type="button"
              disabled={!title.trim() || submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await onCreateTask(title.trim(), area.trim(), selectedDuration);
                } finally {
                  setSubmitting(false);
                }
              }}
              style={{
                ...primaryButton(),
                opacity: !title.trim() || submitting ? 0.5 : 1,
              }}
            >
              {submitting ? "Adding..." : `Schedule Task at ${hourFormatted}`}
            </button>
          </div>
        )}

        {/* Tab 3: Create Google Calendar Event */}
        {tab === "new_event" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Event title (e.g. Standup Meeting)"
              autoFocus
              style={inputStyle()}
            />
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Location or Meet link (optional)"
              style={inputStyle()}
            />
            <button
              type="button"
              disabled={!title.trim() || submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await onCreateCalendarEvent(title.trim(), selectedDuration, location.trim());
                } finally {
                  setSubmitting(false);
                }
              }}
              style={{
                ...primaryButton(),
                opacity: !title.trim() || submitting ? 0.5 : 1,
              }}
            >
              {submitting ? "Creating..." : `Create Event at ${hourFormatted}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
