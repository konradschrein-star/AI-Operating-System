"use client";

/**
 * The week grid — Mon–Sun, 06:00–24:00, calendar events and scheduled tasks in
 * the same columns.
 *
 * Replaces the old single-day timeline, which rendered all 24 hours at equal
 * height so that half the visible surface was empty night, and showed one day
 * at a time so a week with two events looked like an empty system.
 *
 * Drag a task in from the rail and drop it on an hour: that one gesture sets the
 * time AND writes the Google Calendar event, so the phone is correct without
 * opening the OS again.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { tokens } from "../../tokens";
import {
  GRID_START_HOUR,
  GRID_END_HOUR,
  itemsForDay,
  layoutLanes,
  localDayKey,
  weekDays,
  type GridItem,
} from "./pressure";
import type { CalendarEvent, DayTask } from "../../api";

const HOUR_H = 46;
const SNAP_MIN = 15;

/**
 * Block colours, deliberately NOT theme tokens.
 *
 * Konrad's note, with a Google Calendar screenshot attached: "I want to see the
 * borders of the tasks better, just like in Google Calendar." Google draws a
 * SOLID saturated card with light text on it. The first version drew a dark
 * tint of a theme token behind a hairline border, which on this theme reads as
 * floating text with a coloured edge — the events were there and correctly
 * placed and the week still looked empty.
 *
 * The theme's semantic tokens (`ok`, `info`, `warn`) are CSS variables tuned for
 * text and status dots, so their contrast against white is not something this
 * file can compute. These are fixed hexes chosen for exactly this job — the
 * Google event palette, whose luminance is already known to carry white text.
 */
const BLOCK_COLORS: readonly { bg: string; fg: string }[] = [
  { bg: "#3f51b5", fg: "#ffffff" }, // blueberry
  { bg: "#0b8043", fg: "#ffffff" }, // basil
  { bg: "#8e24aa", fg: "#ffffff" }, // grape
  { bg: "#e67c73", fg: "#2a0f0d" }, // flamingo
  { bg: "#f4511e", fg: "#ffffff" }, // tangerine
  { bg: "#009688", fg: "#ffffff" }, // teal
  { bg: "#7986cb", fg: "#11142b" }, // lavender
  { bg: "#f6bf26", fg: "#3b2f00" }, // banana
];

/** Google Calendar events get one stable colour — they are one "calendar". */
const EVENT_COLOR = { bg: "#039be5", fg: "#ffffff" }; // peacock

/** Stable per-area colour, same hashing idea as areaColor() but over the
 *  block palette so the fill is always something white text sits on. */
function blockColor(area: string | null): { bg: string; fg: string } {
  const key = area || "other";
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return BLOCK_COLORS[h % BLOCK_COLORS.length];
}

export interface WeekGridProps {
  day: string;
  tasks: DayTask[];
  events: CalendarEvent[];
  /** Schedule a task at an instant. The parent owns the write. */
  onSchedule: (taskId: string, startIso: string) => void | Promise<void>;
  onToggleTask: (taskId: string, done: boolean) => void | Promise<void>;
  onOpenTask: (taskId: string) => void;
  /** Quick-create at a slot the user clicked with nothing dragged. */
  onEmptySlot: (startIso: string) => void;
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/** Build a local-time ISO with offset, so the server stores the real instant. */
function isoAt(day: string, minutes: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setMinutes(minutes);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return (
    `${localDayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function WeekGrid({
  day,
  tasks,
  events,
  onSchedule,
  onToggleTask,
  onOpenTask,
  onEmptySlot,
}: WeekGridProps) {
  const days = useMemo(() => weekDays(day), [day]);
  const [now, setNow] = useState(() => new Date());
  const [hover, setHover] = useState<{ day: string; min: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Open on the working day, not on midnight.
  useEffect(() => {
    if (!scrollRef.current) return;
    const target = Math.max(GRID_START_HOUR, now.getHours() - 2);
    scrollRef.current.scrollTop = (target - GRID_START_HOUR) * HOUR_H;
    // Only on mount / week change — re-running per minute would yank the
    // scroll position out from under someone reading Thursday.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const todayKey = localDayKey(now);
  const hours = Array.from(
    { length: GRID_END_HOUR - GRID_START_HOUR },
    (_, i) => GRID_START_HOUR + i,
  );

  const perDay = useMemo(
    () => days.map((d) => ({ day: d, items: itemsForDay(d, tasks, events) })),
    [days, tasks, events],
  );

  const minuteToY = (min: number): number =>
    ((min - GRID_START_HOUR * 60) / 60) * HOUR_H;

  const yToMinute = (y: number): number => {
    const raw = GRID_START_HOUR * 60 + (y / HOUR_H) * 60;
    return Math.max(
      GRID_START_HOUR * 60,
      Math.min(GRID_END_HOUR * 60 - SNAP_MIN, Math.round(raw / SNAP_MIN) * SNAP_MIN),
    );
  };

  const allDay = useMemo(
    () =>
      days.map((d) =>
        events.filter(
          (e) => e.all_day && new Date(e.start) && localDayKey(new Date(e.start)) === d,
        ),
      ),
    [days, events],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {/* Day headers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `52px repeat(7, 1fr)`,
          borderBottom: `1px solid ${tokens.border}`,
          background: tokens.toolBg,
          flexShrink: 0,
        }}
      >
        <div />
        {days.map((d) => {
          const date = new Date(`${d}T12:00:00`);
          const isToday = d === todayKey;
          return (
            <div
              key={d}
              style={{
                padding: "8px 6px",
                textAlign: "center",
                borderLeft: `1px solid ${tokens.borderSoft}`,
                background: isToday ? tokens.selectedBg : "transparent",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color: isToday ? tokens.accent : tokens.textGhost,
                  textTransform: "uppercase",
                }}
              >
                {date.toLocaleDateString("en-GB", { weekday: "short" })}
              </div>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: isToday ? 700 : 500,
                  color: isToday ? tokens.textHi : tokens.textSoft,
                  lineHeight: 1.25,
                }}
              >
                {date.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day band — only when something is in it, so it costs no height
          on a normal week. */}
      {allDay.some((l) => l.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `52px repeat(7, 1fr)`,
            borderBottom: `1px solid ${tokens.border}`,
            flexShrink: 0,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 9, color: tokens.textGhost, padding: "5px 6px", textAlign: "right" }}
          >
            all-day
          </div>
          {allDay.map((list, i) => (
            <div
              key={days[i]}
              style={{ borderLeft: `1px solid ${tokens.borderSoft}`, padding: 3, minHeight: 22 }}
            >
              {list.map((e) => (
                <div
                  key={e.id}
                  title={e.summary}
                  style={{
                    fontSize: 10,
                    padding: "2px 5px",
                    borderRadius: 4,
                    marginBottom: 2,
                    background: tokens.info,
                    color: tokens.onAccent,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.summary}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Scrollable hour grid */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `52px repeat(7, 1fr)`,
            position: "relative",
          }}
        >
          {/* Hour gutter */}
          <div>
            {hours.map((h) => (
              <div
                key={h}
                className="mono"
                style={{
                  height: HOUR_H,
                  fontSize: 9,
                  color: tokens.textGhost,
                  textAlign: "right",
                  paddingRight: 6,
                  transform: "translateY(-6px)",
                }}
              >
                {hourLabel(h)}
              </div>
            ))}
          </div>

          {perDay.map(({ day: d, items }) => {
            const lanes = layoutLanes(items);
            const isToday = d === todayKey;
            return (
              <div
                key={d}
                onDragOver={(ev) => {
                  ev.preventDefault();
                  const rect = ev.currentTarget.getBoundingClientRect();
                  setHover({ day: d, min: yToMinute(ev.clientY - rect.top) });
                }}
                onDragLeave={() => setHover(null)}
                onDrop={(ev) => {
                  ev.preventDefault();
                  const taskId = ev.dataTransfer.getData("text/forge-task");
                  const rect = ev.currentTarget.getBoundingClientRect();
                  const min = yToMinute(ev.clientY - rect.top);
                  setHover(null);
                  if (taskId) void onSchedule(taskId, isoAt(d, min));
                }}
                onClick={(ev) => {
                  // Only a click on the empty column background, never on a card.
                  if (ev.target !== ev.currentTarget) return;
                  const rect = ev.currentTarget.getBoundingClientRect();
                  onEmptySlot(isoAt(d, yToMinute(ev.clientY - rect.top)));
                }}
                style={{
                  position: "relative",
                  borderLeft: `1px solid ${tokens.borderSoft}`,
                  background: isToday ? tokens.selectedBg : "transparent",
                  cursor: "copy",
                }}
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{
                      height: HOUR_H,
                      borderTop: `1px solid ${tokens.borderDivider}`,
                      pointerEvents: "none",
                    }}
                  />
                ))}

                {/* Drop preview */}
                {hover && hover.day === d && (
                  <div
                    style={{
                      position: "absolute",
                      left: 2,
                      right: 2,
                      top: minuteToY(hover.min),
                      height: (30 / 60) * HOUR_H,
                      border: `1px dashed ${tokens.accent}`,
                      borderRadius: 5,
                      background: `${tokens.accent}22`,
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: tokens.accent,
                    }}
                    className="mono"
                  >
                    {String(Math.floor(hover.min / 60)).padStart(2, "0")}:
                    {String(hover.min % 60).padStart(2, "0")}
                  </div>
                )}

                {items.map((it) => (
                  <Block
                    key={it.key}
                    item={it}
                    top={minuteToY(it.startMin)}
                    height={Math.max(18, (it.durationMin / 60) * HOUR_H - 2)}
                    lane={lanes.get(it.key) ?? { lane: 0, lanes: 1 }}
                    onToggle={onToggleTask}
                    onOpen={onOpenTask}
                  />
                ))}

                {/* Live time line, today only */}
                {isToday && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: minuteToY(now.getHours() * 60 + now.getMinutes()),
                      height: 0,
                      borderTop: `2px solid ${tokens.bleed}`,
                      pointerEvents: "none",
                      zIndex: 5,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Block({
  item,
  top,
  height,
  lane,
  onToggle,
  onOpen,
}: {
  item: GridItem;
  top: number;
  height: number;
  lane: { lane: number; lanes: number };
  onToggle: (taskId: string, done: boolean) => void | Promise<void>;
  onOpen: (taskId: string) => void;
}) {
  const isEvent = item.kind === "event";
  const c = isEvent ? EVENT_COLOR : blockColor(item.area);
  const widthPct = 100 / lane.lanes;
  const clock = `${String(Math.floor(item.startMin / 60)).padStart(2, "0")}:${String(
    item.startMin % 60,
  ).padStart(2, "0")}`;

  // Under ~34px there is no room for two lines, so title and time share one —
  // the same thing Google does to a 15-minute event.
  const tight = height < 34;

  return (
    <div
      draggable={Boolean(item.taskId)}
      onDragStart={(e) => {
        if (!item.taskId) return;
        // Same payload key the rail uses, so the column's existing drop handler
        // moves an already-scheduled task without a second code path.
        e.dataTransfer.setData("text/forge-task", item.taskId);
        e.dataTransfer.effectAllowed = "move";
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (item.taskId) onOpen(item.taskId);
      }}
      title={
        item.location
          ? `${item.title} · ${clock} · ${item.location}`
          : `${item.title} · ${clock}`
      }
      style={{
        position: "absolute",
        top,
        left: `calc(${lane.lane * widthPct}% + 2px)`,
        width: `calc(${widthPct}% - 5px)`,
        height,
        borderRadius: 4,
        // Solid fill, like Google. The block IS the colour; there is no border
        // doing the work, so it cannot disappear into the column behind it.
        background: c.bg,
        color: c.fg,
        padding: tight ? "1px 5px" : "3px 6px",
        overflow: "hidden",
        cursor: item.taskId ? "grab" : "default",
        opacity: item.done ? 0.5 : 1,
        boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
        zIndex: 2,
        display: "flex",
        flexDirection: tight ? "row" : "column",
        alignItems: tight ? "center" : "stretch",
        gap: tight ? 5 : 0,
        lineHeight: 1.25,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {item.taskId && (
          <span
            role="checkbox"
            aria-checked={item.done}
            onClick={(e) => {
              e.stopPropagation();
              void onToggle(item.taskId as string, !item.done);
            }}
            title={item.done ? "mark not done" : "mark done"}
            style={{
              width: 12,
              height: 12,
              flexShrink: 0,
              borderRadius: 3,
              border: `1.5px solid ${c.fg}`,
              background: item.done ? c.fg : "transparent",
              color: c.bg,
              fontSize: 9,
              lineHeight: "9px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {item.done ? "\u2713" : ""}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            whiteSpace: tight ? "nowrap" : "normal",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textDecoration: item.done ? "line-through" : "none",
            display: tight ? "block" : "-webkit-box",
            WebkitLineClamp: height > 60 ? 3 : 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {item.title}
        </span>
      </div>
      <span
        className="mono"
        style={{
          fontSize: 9.5,
          opacity: 0.85,
          flexShrink: 0,
          marginTop: tight ? 0 : 1,
        }}
      >
        {clock}
      </span>
    </div>
  );
}
