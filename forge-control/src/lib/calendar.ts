/**
 * Google Calendar integration wrapper.
 *
 * Invokes the Google Workspace CLI tool (google_api.py) for calendar operations:
 * - list: list events within an optional time window
 * - create: insert a new event
 *
 * Uses execFile with argument arrays to avoid shell injection and quoting issues.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const DEFAULT_GOOGLE_API_SCRIPT =
  "/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills/productivity/google-workspace/scripts/google_api.py";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
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
  subcommand: "list" | "create" | "delete",
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
