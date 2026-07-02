/**
 * Natural-ish time expression parser for reminders.
 *
 * Parses a leading time expression off a string, returning the resolved
 * due date (UTC Date) plus the remaining text. All wall-clock expressions
 * are interpreted in REMINDER_TZ (default Europe/Berlin) — the VPS runs
 * UTC but Konrad lives in Berlin time.
 *
 * Grammar (leading, case-insensitive):
 *   in 20m | in 2h | in 3d | in 90 minutes
 *   at 18:30 | 18:30            (today, or tomorrow if already past)
 *   today 18:30
 *   tomorrow | tomorrow 9:00    (default 09:00)
 *   2026-07-04 | 2026-07-04 14:00
 *   daily 08:30 | every day 08:30      → recur 'daily'
 *   weekly 08:30 | every week 08:30    → recur 'weekly'
 */

const TZ = process.env.REMINDER_TZ ?? "Europe/Berlin";

export interface ParsedWhen {
  dueAt: Date;
  recur: "daily" | "weekly" | null;
  /** Remainder of the input after the time expression. */
  rest: string;
}

/** Offset of `tz` from UTC in ms at the given instant. */
function tzOffsetMs(atUtc: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(atUtc)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour === 24 ? 0 : p.hour,
    p.minute,
    p.second,
  );
  return asUtc - atUtc.getTime();
}

/** Wall-clock parts (y/m/d h:min) in TZ → UTC Date. Handles DST via
 *  one-step offset correction (offset re-evaluated at the guess). */
function wallToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(new Date(), TZ));
  const corrected = Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(guess, TZ);
  return new Date(corrected);
}

/** Today's date parts in TZ. */
function todayParts(now: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  return { y, m, d };
}

function addDays(parts: { y: number; m: number; d: number }, n: number) {
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n));
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

const RE_IN = /^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/i;
const RE_TIME = /^(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/;
const RE_TODAY = /^today\s+([01]?\d|2[0-3]):([0-5]\d)\b/i;
const RE_TOMORROW = /^tomorrow(?:\s+([01]?\d|2[0-3]):([0-5]\d))?\b/i;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:\s+([01]?\d|2[0-3]):([0-5]\d))?\b/;
const RE_DAILY = /^(?:daily|every\s+day)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i;
const RE_WEEKLY = /^(?:weekly|every\s+week)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i;

export function parseWhen(input: string, now = new Date()): ParsedWhen | null {
  const s = input.trim();

  let m = s.match(RE_IN);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0].toLowerCase();
    const ms =
      unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return {
      dueAt: new Date(now.getTime() + ms),
      recur: null,
      rest: s.slice(m[0].length).trim(),
    };
  }

  m = s.match(RE_DAILY);
  if (m) {
    const t = todayParts(now);
    let due = wallToUtc(t.y, t.m, t.d, Number(m[1]), Number(m[2]));
    if (due.getTime() <= now.getTime()) {
      const n = addDays(t, 1);
      due = wallToUtc(n.y, n.m, n.d, Number(m[1]), Number(m[2]));
    }
    return { dueAt: due, recur: "daily", rest: s.slice(m[0].length).trim() };
  }

  m = s.match(RE_WEEKLY);
  if (m) {
    const t = todayParts(now);
    let due = wallToUtc(t.y, t.m, t.d, Number(m[1]), Number(m[2]));
    if (due.getTime() <= now.getTime()) {
      const n = addDays(t, 7);
      due = wallToUtc(n.y, n.m, n.d, Number(m[1]), Number(m[2]));
    }
    return { dueAt: due, recur: "weekly", rest: s.slice(m[0].length).trim() };
  }

  m = s.match(RE_TOMORROW);
  if (m) {
    const t = addDays(todayParts(now), 1);
    const hh = m[1] ? Number(m[1]) : 9;
    const mm = m[2] ? Number(m[2]) : 0;
    return {
      dueAt: wallToUtc(t.y, t.m, t.d, hh, mm),
      recur: null,
      rest: s.slice(m[0].length).trim(),
    };
  }

  m = s.match(RE_TODAY);
  if (m) {
    const t = todayParts(now);
    return {
      dueAt: wallToUtc(t.y, t.m, t.d, Number(m[1]), Number(m[2])),
      recur: null,
      rest: s.slice(m[0].length).trim(),
    };
  }

  m = s.match(RE_DATE);
  if (m) {
    const hh = m[4] ? Number(m[4]) : 9;
    const mm = m[5] ? Number(m[5]) : 0;
    return {
      dueAt: wallToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm),
      recur: null,
      rest: s.slice(m[0].length).trim(),
    };
  }

  m = s.match(RE_TIME);
  if (m) {
    const t = todayParts(now);
    let due = wallToUtc(t.y, t.m, t.d, Number(m[1]), Number(m[2]));
    if (due.getTime() <= now.getTime()) {
      const n = addDays(t, 1);
      due = wallToUtc(n.y, n.m, n.d, Number(m[1]), Number(m[2]));
    }
    return { dueAt: due, recur: null, rest: s.slice(m[0].length).trim() };
  }

  return null;
}

/** Next occurrence for a recurring reminder after it fired. */
export function nextRecurrence(dueAt: Date, recur: "daily" | "weekly"): Date {
  const days = recur === "daily" ? 1 : 7;
  return new Date(dueAt.getTime() + days * 86_400_000);
}
