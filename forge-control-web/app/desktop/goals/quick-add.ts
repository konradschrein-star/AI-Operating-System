/**
 * Quick-add parser — one line in, one task out.
 *
 * `Finish the stats route #uni !! ~90m tomorrow`
 *   → { title: "Finish the stats route", area: "uni", importance: 3,
 *       est_min: 90, planned_day: "2026-08-20" }
 *
 * This exists because of failure mode §0.1: a form with seven fields is a
 * form he does not fill in, and a task he does not write down is a task that
 * lives in his head all evening. One input, one Enter, done.
 *
 * Rules, all deliberately conservative — a marker only counts as a marker when
 * it stands alone as its own word, so "Ship it!" keeps its exclamation mark
 * and "read #1 chapter" keeps its title:
 *
 *   #area        first one wins, every one is stripped from the title
 *   !! / !       importance 3 (critical) / 2 (high)
 *   ~30m ~2h ~45 estimate in minutes (a bare number is minutes)
 *   today / tomorrow / mon…sun   planned_day, resolved against `now`
 *
 * Anything left over, whitespace-collapsed, is the title.
 *
 * `importance` is null when no marker was typed rather than defaulted to 2
 * here: §2 gives day_tasks.importance a server-side DEFAULT and §3's one-place
 * rule is worth honouring for constants too. Null means "don't send the field".
 *
 * No React, no tokens, no fetch — this file is pure so that quick-add.test.ts
 * can run under the repo's `tsx --test` runner without a DOM.
 */

export interface QuickAddResult {
  title: string;
  area: string | null;
  /** 3 critical / 2 high. Null = not stated; let the server default apply. */
  importance: number | null;
  est_min: number | null;
  /** `YYYY-MM-DD`, local calendar day. */
  planned_day: string | null;
}

/** `YYYY-MM-DD` in LOCAL calendar terms. `toISOString()` is wrong here: at
 *  01:00 in Berlin it names yesterday, which would file the task on the wrong
 *  day and quietly make it look carried. */
export function toDayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` back into a LOCAL midnight Date. `new Date("2026-08-19")`
 *  parses as UTC midnight, which is the previous evening west of Greenwich. */
export function fromDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) throw new Error(`not a YYYY-MM-DD day key: "${key}"`);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, delta: number): string {
  const d = fromDayKey(key);
  d.setDate(d.getDate() + delta);
  return toDayKey(d);
}

/** 0 = Sunday, matching `Date.prototype.getDay()`. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const AREA_RE = /^#([A-Za-z][A-Za-z0-9_-]*)$/;
const EST_RE = /^~(\d+(?:[.,]\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/i;

/** A day off in either direction is not a planning error, it is a lost task —
 *  so an estimate outside a plausible range is left in the title instead of
 *  being coerced into a number nobody typed. */
const MAX_EST_MIN = 24 * 60;

function parseEstimate(token: string): number | null {
  const m = EST_RE.exec(token);
  if (!m) return null;
  const value = Number.parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const minutes = unit.startsWith("h") ? value * 60 : value;
  const rounded = Math.round(minutes);
  if (rounded < 1 || rounded > MAX_EST_MIN) return null;
  return rounded;
}

/**
 * The next occurrence of `weekday`, strictly in the future.
 *
 * "mon" typed on a Monday means NEXT Monday, not today — nobody schedules the
 * day they are standing in by naming it; they type "today" for that.
 */
function nextWeekday(now: Date, weekday: number): string {
  const today = toDayKey(now);
  const delta = ((weekday - now.getDay() + 7) % 7) || 7;
  return addDays(today, delta);
}

export function parseQuickAdd(input: string, now: Date = new Date()): QuickAddResult {
  const out: QuickAddResult = {
    title: "",
    area: null,
    importance: null,
    est_min: null,
    planned_day: null,
  };
  const words: string[] = [];

  for (const raw of input.split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;

    const area = AREA_RE.exec(token);
    if (area) {
      if (out.area === null) out.area = area[1].toLowerCase();
      continue;
    }

    if (token === "!!") {
      out.importance = 3;
      continue;
    }
    if (token === "!") {
      // A lone "!" after "!!" must not demote the task it just promoted.
      if (out.importance === null) out.importance = 2;
      continue;
    }

    const est = parseEstimate(token);
    if (est !== null) {
      out.est_min = est;
      continue;
    }

    const lower = token.toLowerCase();
    if (lower === "today") {
      out.planned_day = toDayKey(now);
      continue;
    }
    if (lower === "tomorrow" || lower === "tmrw") {
      out.planned_day = addDays(toDayKey(now), 1);
      continue;
    }
    const weekday = WEEKDAYS[lower];
    if (weekday !== undefined) {
      out.planned_day = nextWeekday(now, weekday);
      continue;
    }

    words.push(token);
  }

  out.title = words.join(" ");
  return out;
}
