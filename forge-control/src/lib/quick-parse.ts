/**
 * One-line capture grammar for /todo and /appointment.
 *
 * The point is speed: the fastest task manager is the one where capturing
 * costs a sentence. Konrad's stated goal is "never not know what to do next",
 * and that only holds if getting something ONTO the list is cheaper than
 * keeping it in his head.
 *
 * Lives on the backend, not in the slash registry, because the same grammar has
 * to serve three callers that would otherwise drift: the desktop composer, the
 * Telegram bridge, and the manager agent turning a sentence into a task.
 *
 * Grammar — every part optional except the text itself:
 *
 *   /todo buy proxies @business !high ~90m due:friday
 *   /todo call the tax office tomorrow
 *   /appointment dentist tomorrow 14:00 90m
 *
 *   @word        area (free text — the column is text, so nothing is rejected)
 *   !word|!0..!5 importance
 *   ~90m ~2h     estimate
 *   due:<when>   deadline, parsed by the same parser reminders use
 *   <when>       a bare leading/trailing time expression sets the planned day
 */

import { parseWhen, type ParsedWhen } from "./when-parser.ts";
import { berlinDay, type Day } from "./day-score.ts";

/**
 * Importance words → Konrad's six levels, the scale his Notion used and the one
 * migration 0049 widened storage to.
 *
 *   5 ultra important · 4 really important · 3 important
 *   2 normal · 1 secondary · 0 insignificant
 *
 * Synonyms are generous on purpose: this is typed at speed in a chat box, and a
 * modifier that fails to match is silently left in the title.
 */
export const IMPORTANCE_LEVELS: readonly { value: number; label: string; words: string[] }[] = [
  { value: 5, label: "ultra important", words: ["ultra", "critical", "urgent", "max"] },
  { value: 4, label: "really important", words: ["really", "high", "veryimportant"] },
  { value: 3, label: "important", words: ["important", "med", "medium"] },
  { value: 2, label: "normal", words: ["normal", "default"] },
  { value: 1, label: "secondary", words: ["secondary", "low", "later"] },
  { value: 0, label: "insignificant", words: ["insignificant", "trivial", "whenever"] },
];

const IMPORTANCE_WORDS: Record<string, number> = Object.fromEntries(
  IMPORTANCE_LEVELS.flatMap((l) => l.words.map((w) => [w, l.value])),
);

export interface ParsedTodo {
  title: string;
  area: string | null;
  importance: number | null;
  est_min: number | null;
  due_day: Day | null;
  planned_day: Day;
  /** Which modifiers were actually recognised — echoed back so a typo'd
   *  `@buisness` is visible as "not applied" instead of silently swallowed. */
  applied: string[];
}

/** `90m`, `2h`, `1h30`, `45` → minutes. Null when it isn't a duration. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  let m = /^(\d+)h(\d+)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)h$/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+)\s*(?:m|min|mins|minutes)$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 5 && n <= 1440 ? n : null;
  }
  return null;
}

/** The Berlin day an instant falls on. */
function dayOf(d: Date): Day {
  return berlinDay(d);
}

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 0, sun: 0,
};

/**
 * Resolve a DATE expression — a superset of what `parseWhen` handles.
 *
 * `parseWhen` exists for reminders, where every expression carries a time of
 * day, so it has no notion of "friday". A deadline usually does not have an
 * hour, and "due:friday" is how a person actually types one. Handled here
 * rather than by widening the reminder parser, because changing that would
 * change the behaviour of every existing reminder expression.
 *
 * A bare weekday always means the NEXT one, never today: if it is Friday and
 * you type "friday", you mean a week from now — today would have been "today".
 */
export function resolveDay(expr: string, now = new Date()): Day | null {
  const s = expr.trim().toLowerCase();
  if (!s) return null;
  // A plain regex, not `isDay()`. `Day` is an alias for `string`, so the type
  // guard narrows the FALSE branch to `never` and every later use of `s` stops
  // compiling — a real trap in this file, since the whole function is the else.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === "today") return berlinDay(now);

  const weekdayMatch = /^(?:next\s+)?([a-z]+)$/.exec(s);
  if (weekdayMatch && weekdayMatch[1] in WEEKDAYS) {
    const target = WEEKDAYS[weekdayMatch[1]];
    // Read the current weekday in Berlin, not from the UTC Date.
    const nowName = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      weekday: "long",
    })
      .format(now)
      .toLowerCase();
    const current = WEEKDAYS[nowName] ?? 0;
    let delta = (target - current + 7) % 7;
    if (delta === 0) delta = 7;
    if (s.startsWith("next") && delta < 7) delta += 7;
    const d = new Date(now.getTime() + delta * 86_400_000);
    return dayOf(d);
  }

  const p = parseWhen(s, now);
  return p ? dayOf(p.dueAt) : null;
}

export function parseTodo(input: string, now = new Date()): ParsedTodo | null {
  let text = input.trim();
  if (!text) return null;

  const applied: string[] = [];
  let area: string | null = null;
  let importance: number | null = null;
  let est: number | null = null;
  let due: Day | null = null;

  // due:<expr> first — it may itself contain a space ("due:tomorrow 9:00" is
  // pointless for a date, so only the first token is consumed).
  text = text.replace(/(?:^|\s)due:(\S+)/i, (_m, expr: string) => {
    const d = resolveDay(expr, now);
    if (d) {
      due = d;
      applied.push(`due ${d}`);
      return " ";
    }
    return _m; // unrecognised — leave it in the title rather than eat it
  });

  text = text.replace(/(?:^|\s)@([\w-]+)/g, (_m, w: string) => {
    area = w.toLowerCase();
    applied.push(`area ${area}`);
    return " ";
  });

  text = text.replace(/(?:^|\s)!([\w]+)/g, (_m, w: string) => {
    const word = w.toLowerCase();
    if (word in IMPORTANCE_WORDS) {
      importance = IMPORTANCE_WORDS[word];
      applied.push(`importance ${word}`);
      return " ";
    }
    const n = Number(word);
    if (Number.isInteger(n) && n >= 0 && n <= 5) {
      importance = n;
      applied.push(`importance ${n}`);
      return " ";
    }
    return _m;
  });

  text = text.replace(/(?:^|\s)~(\S+)/g, (_m, w: string) => {
    const mins = parseDuration(w);
    if (mins !== null) {
      est = mins;
      applied.push(`est ${mins}m`);
      return " ";
    }
    return _m;
  });

  // A bare time expression sets the planned day, whether it leads
  // ("tomorrow call the bank") or trails ("call the bank tomorrow"). Trailing is
  // how people actually type, and the first version only handled leading, so
  // "call the tax office tomorrow" filed itself under today with the word
  // "tomorrow" stranded in the title.
  //
  // Trailing is matched from the LONGEST suffix down and must leave a non-empty
  // remainder, so "meet Tom at 5" still yields a title of "meet Tom".
  let planned: Day = berlinDay(now);
  const lead = parseWhen(text, now);
  if (lead && lead.rest.trim() && lead.rest.trim() !== text.trim()) {
    planned = dayOf(lead.dueAt);
    text = lead.rest;
    applied.push(`planned ${planned}`);
  } else {
    const words = text.split(/\s+/);
    for (let i = Math.max(1, words.length - 3); i < words.length; i += 1) {
      const suffix = words.slice(i).join(" ");
      const d = resolveDay(suffix, now);
      if (d) {
        planned = d;
        text = words.slice(0, i).join(" ");
        applied.push(`planned ${planned}`);
        break;
      }
    }
  }

  const title = text.replace(/\s+/g, " ").trim();
  if (!title) return null;

  return { title, area, importance, est_min: est, due_day: due, planned_day: planned, applied };
}

export interface ParsedAppointment {
  summary: string;
  /** RFC3339 with offset — Google requires a real instant. */
  start: string;
  end: string;
  durationMin: number;
  recur: "daily" | "weekly" | null;
}

/**
 * `/appointment dentist tomorrow 14:00 90m`
 *
 * The time expression may lead or trail; a trailing duration token is pulled off
 * first so `parseWhen` never sees it. Without a time this returns null rather
 * than defaulting to "now" — an appointment silently booked for the current
 * minute is worse than an error message.
 */
/**
 * Rewrite standalone weekday words to concrete `YYYY-MM-DD`.
 *
 * `parseWhen` understands dates, "today" and "tomorrow", but not "friday" — so
 * "gym friday 7:00" parsed only the `7:00` and booked TODAY at seven, with
 * "friday" stranded in the summary. Normalising first means the existing parser
 * handles weekday+time for free, instead of growing a second date grammar here.
 */
export function expandWeekdays(text: string, now = new Date()): string {
  return text.replace(/\b(next\s+)?([a-z]+)\b/gi, (m, next: string | undefined, word: string) => {
    if (!(word.toLowerCase() in WEEKDAYS)) return m;
    const d = resolveDay(`${next ? "next " : ""}${word}`, now);
    return d ?? m;
  });
}

export function parseAppointment(input: string, now = new Date()): ParsedAppointment | null {
  const text = expandWeekdays(input.trim(), now);
  if (!text) return null;

  /** Find the time expression and the summary, with the duration already off. */
  const split = (s: string): { when: ParsedWhen; summary: string } | null => {
    // Whole string first — handles "tomorrow 14:00 dentist".
    const lead = parseWhen(s, now);
    if (lead && lead.rest.trim()) return { when: lead, summary: lead.rest.trim() };

    // Then progressively later starting points, so "dentist tomorrow 14:00"
    // resolves too. The tail must consume ENTIRELY, or "meet at 5 people"
    // would book a meeting.
    const words = s.split(/\s+/);
    for (let i = 1; i < words.length; i += 1) {
      const p = parseWhen(words.slice(i).join(" "), now);
      if (p && !p.rest.trim()) {
        return { when: p, summary: words.slice(0, i).join(" ") };
      }
    }
    return null;
  };

  // Parse UNSTRIPPED first.
  //
  // The first version pulled a trailing duration off before anything else, which
  // ate the time in "call Sem in 2h" — leaving "call Sem in", no time, and a
  // refusal. That string was the example in this endpoint's own error message.
  // So: only strip a trailing duration if the sentence does not already parse
  // with it left in place.
  let durationMin = 60;
  let found = split(text);

  if (!found) {
    const tail = /(?:^|\s)(\d+h\d+|\d+(?:\.\d+)?h|\d+\s*(?:m|min|mins|minutes))\s*$/i.exec(text);
    if (tail) {
      const mins = parseDuration(tail[1]);
      if (mins !== null) {
        const stripped = text.slice(0, tail.index).trim();
        const retry = split(stripped);
        if (retry) {
          durationMin = mins;
          found = retry;
        }
      }
    }
  }

  if (!found || !found.summary.trim()) return null;

  const parsed = found.when;
  const summary = found.summary;
  const start = parsed.dueAt;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return {
    summary: summary.replace(/\s+/g, " ").trim(),
    start: start.toISOString(),
    end: end.toISOString(),
    durationMin,
    recur: parsed.recur,
  };
}
