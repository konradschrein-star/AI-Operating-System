/**
 * Google Tasks wrapper — the other half of the phone.
 *
 * Konrad uses the Google apps directly on mobile, so the OS does not need a
 * great mobile task UI; it needs great sync. Calendar covers anything with an
 * hour ([[lib/calendar.ts]]); this covers everything else.
 *
 * ── The date-precision trap ───────────────────────────────────────────────
 * Google Tasks accepts an RFC3339 `due` and then stores only the DATE, silently
 * discarding the time of day — `2026-08-28T14:30:00Z` comes back as
 * `2026-08-28T00:00:00.000Z`. That is not a rounding bug to work around, it is
 * the shape of the product, and it is exactly why the board routes timed work to
 * the calendar instead. Never compare a `due` you sent against a `due` you get
 * back expecting equality.
 *
 * Invokes google_api.py for the same reason calendar.ts does: one place owns the
 * OAuth token and its refresh.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_GOOGLE_API_SCRIPT, type CalendarExecOptions } from "./calendar.ts";

const execFileAsync = promisify(execFileCb);

/** The default list ("@default" is Google's alias for the first one). */
export const DEFAULT_TASKLIST = "@default";

export interface GoogleTask {
  id: string;
  tasklist: string;
  title: string;
  notes: string;
  /** "needsAction" | "completed" */
  status: string;
  /** Date precision only — see the header note. */
  due: string;
  completed: string;
  updated: string;
  parent: string;
  position: string;
  deleted: boolean;
  hidden: boolean;
}

export interface GoogleTaskList {
  id: string;
  title: string;
  updated: string;
}

async function runTasksCli(
  subcommand: "lists" | "list" | "create" | "update" | "delete",
  args: string[],
  opts: CalendarExecOptions = {},
): Promise<string> {
  const scriptPath =
    opts.scriptPath ?? process.env.GOOGLE_WORKSPACE_SCRIPT_PATH ?? DEFAULT_GOOGLE_API_SCRIPT;
  const timeout = opts.timeoutMs ?? 20_000;

  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [scriptPath, "tasks", subcommand, ...args],
      { timeout, maxBuffer: 10 * 1024 * 1024 },
    );
    if (stderr && !stdout.trim()) {
      throw new Error(`google_api.py tasks ${subcommand} failed: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string };
    const errMsg = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`Google Tasks CLI error (${subcommand}): ${errMsg}`);
  }
}

function parseJson<T>(raw: string, what: string): T {
  if (!raw) throw new Error(`Empty response from google_api.py tasks ${what}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse tasks ${what} output as JSON: ${raw.slice(0, 400)}`);
  }
}

export async function listTaskLists(execOpts: CalendarExecOptions = {}): Promise<GoogleTaskList[]> {
  return parseJson<GoogleTaskList[]>(await runTasksCli("lists", [], execOpts), "lists");
}

export async function listGoogleTasks(
  options: { tasklist?: string; max?: number; showCompleted?: boolean } = {},
  execOpts: CalendarExecOptions = {},
): Promise<GoogleTask[]> {
  const args = ["--tasklist", options.tasklist ?? DEFAULT_TASKLIST];
  if (options.max !== undefined) args.push("--max", String(options.max));
  if (options.showCompleted) args.push("--show-completed");
  return parseJson<GoogleTask[]>(await runTasksCli("list", args, execOpts), "list");
}

export async function createGoogleTask(
  input: { title: string; notes?: string; due?: string; tasklist?: string },
  execOpts: CalendarExecOptions = {},
): Promise<GoogleTask> {
  if (!input.title?.trim()) {
    throw new Error("createGoogleTask: title is required and must be non-empty");
  }
  const args = ["--title", input.title.trim(), "--tasklist", input.tasklist ?? DEFAULT_TASKLIST];
  if (input.notes) args.push("--notes", input.notes);
  if (input.due) args.push("--due", input.due);
  return parseJson<GoogleTask>(await runTasksCli("create", args, execOpts), "create");
}

export async function updateGoogleTask(
  taskId: string,
  patch: {
    title?: string;
    notes?: string;
    due?: string;
    status?: "needsAction" | "completed";
    tasklist?: string;
  },
  execOpts: CalendarExecOptions = {},
): Promise<GoogleTask> {
  if (!taskId?.trim()) throw new Error("updateGoogleTask: taskId is required");
  const args = [taskId.trim(), "--tasklist", patch.tasklist ?? DEFAULT_TASKLIST];
  if (patch.title !== undefined) args.push("--title", patch.title);
  if (patch.notes !== undefined) args.push("--notes", patch.notes);
  if (patch.due !== undefined) args.push("--due", patch.due);
  if (patch.status !== undefined) args.push("--status", patch.status);
  if (args.length === 2) throw new Error("updateGoogleTask: at least one field must be given");
  return parseJson<GoogleTask>(await runTasksCli("update", args, execOpts), "update");
}

export async function deleteGoogleTask(
  taskId: string,
  tasklist?: string,
  execOpts: CalendarExecOptions = {},
): Promise<{ status: string; taskId: string }> {
  if (!taskId?.trim()) throw new Error("deleteGoogleTask: taskId is required");
  const args = [taskId.trim(), "--tasklist", tasklist ?? DEFAULT_TASKLIST];
  const raw = await runTasksCli("delete", args, execOpts);
  try {
    return JSON.parse(raw) as { status: string; taskId: string };
  } catch {
    return { status: "deleted", taskId: taskId.trim() };
  }
}
