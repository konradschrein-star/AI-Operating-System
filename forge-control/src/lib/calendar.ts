/**
 * Google Calendar integration wrapper.
 *
 * Invokes the Google Workspace CLI tool (google_api.py) for calendar operations:
 * - list:   list events within an optional time window
 * - create: insert a new event
 * - update: patch an existing event (partial — unspecified fields survive)
 * - delete: remove an event
 *
 * Uses execFile with argument arrays to avoid shell injection and quoting issues.
 *
 * ── Why the window helpers live here ──────────────────────────────────────
 * Google's `timeMin`/`timeMax` are RFC3339 INSTANTS. A bare `2026-08-25` is not
 * one, and the API answers 400 — which this wrapper surfaced as a 502 that read
 * exactly like an expired token (measured 2026-08-25; the OAuth was healthy the
 * whole time). Worse, the previous caller worked around it by appending a
 * literal `Z`, which asserts UTC — but the person using this calendar lives in
 * Europe/Berlin, so every "day" was shifted one or two hours: events before
 * 02:00 local fell out of their own day and two hours of tomorrow leaked in.
 *
 * So a day boundary is resolved through the zone, not through string surgery.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { BERLIN_TZ, isDay, shiftDay, type Day } from "./day-score.ts";

const execFileAsync = promisify(execFileCb);

/** Minutes Europe/Berlin is AHEAD of UTC at the given instant (+60 CET, +120 CEST). */
function zoneOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BERLIN_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0; // bare "GMT" — the zone is at +00:00 right now
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * The exact UTC instant of a Berlin wall-clock time, DST-correct.
 *
 * Two passes, deliberately. The offset can only be read from an instant, but the
 * instant is what we are solving for — so guess with the naive reading, take the
 * offset there, correct, and re-read. On the two DST-transition days the first
 * offset can be the wrong side of the jump; the second pass catches it.
 */
export function berlinInstant(day: Day, hhmm = "00:00"): Date {
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const first = zoneOffsetMinutes(guess);
  const corrected = new Date(guess.getTime() - first * 60_000);
  const second = zoneOffsetMinutes(corrected);
  return second === first ? corrected : new Date(guess.getTime() - second * 60_000);
}

/**
 * Normalise one edge of a query window to an RFC3339 instant.
 *
 * A bare `YYYY-MM-DD` becomes the Berlin start of that day; on the `end` edge it
 * becomes the start of the NEXT day, because a human who writes
 * `start=Mon&end=Sun` means the whole of Sunday, and Google's timeMax is
 * exclusive. Anything already carrying a time is passed through untouched —
 * callers that know what they want are not second-guessed.
 */
export function normaliseWindowEdge(
  value: string | undefined,
  edge: "start" | "end",
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isDay(value)) return value;
  return edge === "start"
    ? berlinInstant(value).toISOString()
    : berlinInstant(shiftDay(value, 1)).toISOString();
}

/** The [start, end) instants covering one whole Berlin day. */
export function dayWindow(day: Day): { start: string; end: string } {
  return {
    start: berlinInstant(day).toISOString(),
    end: berlinInstant(shiftDay(day, 1)).toISOString(),
  };
}

/** The Monday of the ISO week containing `day`. */
export function weekStart(day: Day): Day {
  // getUTCDay on the Berlin-midnight instant would drift; read the weekday in-zone.
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: BERLIN_TZ,
    weekday: "short",
  }).format(berlinInstant(day, "12:00"));
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const idx = order.indexOf(weekday);
  return idx <= 0 ? day : shiftDay(day, -idx);
}

/** The [start, end) instants covering the Mon–Sun week containing `day`. */
export function weekWindow(day: Day): { start: string; end: string; from: Day; to: Day } {
  const from = weekStart(day);
  const to = shiftDay(from, 6);
  return {
    start: berlinInstant(from).toISOString(),
    end: berlinInstant(shiftDay(to, 1)).toISOString(),
    from,
    to,
  };
}

export const DEFAULT_GOOGLE_API_SCRIPT =
  "/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills/productivity/google-workspace/scripts/google_api.py";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** True when the event carries a `date` and no `dateTime` — a 24-hour block,
   *  not something to lay out at midnight. */
  all_day?: boolean;
  location?: string;
  description?: string;
  status?: string;
  /** Google's last-modified stamp; what a two-way sync reconciles on. */
  updated?: string;
  /** Set on one instance of a recurring series. */
  recurring_event_id?: string;
  htmlLink?: string;
}

export interface UpdateCalendarEventOptions {
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  calendar?: string;
}

export interface ListCalendarEventsOptions {
  start?: string;
  end?: string;
  max?: number;
  calendar?: string;
}

export interface CreateCalendarEventOptions {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  calendar?: string;
}

export interface CreatedCalendarEventResult {
  status: string;
  id: string;
  summary: string;
  htmlLink?: string;
}

export interface CalendarExecOptions {
  scriptPath?: string;
  timeoutMs?: number;
}

/**
 * Execute a calendar command via the google_api.py python script.
 */
async function runCalendarCli(
  subcommand: "list" | "create" | "update" | "delete",
  args: string[],
  opts: CalendarExecOptions = {},
): Promise<string> {
  const scriptPath = opts.scriptPath ?? process.env.GOOGLE_WORKSPACE_SCRIPT_PATH ?? DEFAULT_GOOGLE_API_SCRIPT;
  const timeout = opts.timeoutMs ?? 20_000;

  try {
    const { stdout, stderr } = await execFileAsync("python3", [scriptPath, "calendar", subcommand, ...args], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr && !stdout.trim()) {
      throw new Error(`google_api.py calendar ${subcommand} failed: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string; code?: number };
    const errMsg = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`Google Calendar CLI error (${subcommand}): ${errMsg}`);
  }
}

/**
 * List events from Google Calendar.
 */
export async function listCalendarEvents(
  options: ListCalendarEventsOptions = {},
  execOpts: CalendarExecOptions = {},
): Promise<CalendarEvent[]> {
  const args: string[] = [];

  if (options.start) {
    args.push("--start", options.start);
  }
  if (options.end) {
    args.push("--end", options.end);
  }
  if (options.max !== undefined) {
    if (!Number.isInteger(options.max) || options.max < 1) {
      throw new Error(`listCalendarEvents: max must be a positive integer, got ${options.max}`);
    }
    args.push("--max", String(options.max));
  }
  if (options.calendar) {
    args.push("--calendar", options.calendar);
  }

  const raw = await runCalendarCli("list", args, execOpts);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array from calendar list, got ${typeof parsed}`);
    }
    return parsed as CalendarEvent[];
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse Google Calendar output as JSON: ${raw}`);
    }
    throw e;
  }
}

/**
 * Create a new event in Google Calendar.
 */
export async function createCalendarEvent(
  options: CreateCalendarEventOptions,
  execOpts: CalendarExecOptions = {},
): Promise<CreatedCalendarEventResult> {
  if (!options.summary || typeof options.summary !== "string" || !options.summary.trim()) {
    throw new Error("createCalendarEvent: summary is required and must be non-empty");
  }
  if (!options.start || typeof options.start !== "string") {
    throw new Error("createCalendarEvent: start is required (ISO-8601 datetime with timezone)");
  }
  if (!options.end || typeof options.end !== "string") {
    throw new Error("createCalendarEvent: end is required (ISO-8601 datetime with timezone)");
  }

  const args: string[] = [
    "--summary",
    options.summary.trim(),
    "--start",
    options.start,
    "--end",
    options.end,
  ];

  if (options.location) {
    args.push("--location", options.location.trim());
  }
  if (options.description) {
    args.push("--description", options.description.trim());
  }
  if (options.calendar) {
    args.push("--calendar", options.calendar);
  }

  const raw = await runCalendarCli("create", args, execOpts);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Expected JSON object from calendar create, got ${typeof parsed}`);
    }
    return parsed as CreatedCalendarEventResult;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse Google Calendar create output as JSON: ${raw}`);
    }
    throw e;
  }
}

/**
 * Patch an existing event. Only the fields you pass are sent.
 *
 * Partial by design — see `calendar_update` in google_api.py. Dragging an event
 * to a new hour must not cost it its attendees.
 */
export async function updateCalendarEvent(
  eventId: string,
  options: UpdateCalendarEventOptions,
  execOpts: CalendarExecOptions = {},
): Promise<CalendarEvent> {
  if (!eventId || typeof eventId !== "string" || !eventId.trim()) {
    throw new Error("updateCalendarEvent: eventId is required and must be non-empty");
  }

  const args: string[] = [eventId.trim()];
  if (options.summary !== undefined) args.push("--summary", options.summary.trim());
  if (options.start !== undefined) args.push("--start", options.start);
  if (options.end !== undefined) args.push("--end", options.end);
  if (options.location !== undefined) args.push("--location", options.location.trim());
  if (options.description !== undefined) args.push("--description", options.description.trim());
  if (options.calendar) args.push("--calendar", options.calendar);

  if (args.length === 1) {
    throw new Error("updateCalendarEvent: at least one field must be given");
  }

  const raw = await runCalendarCli("update", args, execOpts);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Expected JSON object from calendar update, got ${typeof parsed}`);
    }
    return parsed as CalendarEvent;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse Google Calendar update output as JSON: ${raw}`);
    }
    throw e;
  }
}

/** Remove an event. Idempotent from the caller's side only in that a second
 *  delete of the same id raises — callers that may race should catch. */
export async function deleteCalendarEvent(
  eventId: string,
  calendar?: string,
  execOpts: CalendarExecOptions = {},
): Promise<{ status: string; eventId: string }> {
  if (!eventId || typeof eventId !== "string" || !eventId.trim()) {
    throw new Error("deleteCalendarEvent: eventId is required and must be non-empty");
  }
  const args = [eventId.trim()];
  if (calendar) args.push("--calendar", calendar);

  const raw = await runCalendarCli("delete", args, execOpts);
  try {
    return JSON.parse(raw) as { status: string; eventId: string };
  } catch {
    // delete answers with a one-line JSON object; anything else is still a success
    // if the CLI exited 0, so do not fail the caller on a parse.
    return { status: "deleted", eventId: eventId.trim() };
  }
}
