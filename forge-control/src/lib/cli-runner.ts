/**
 * Personal AI OS (aios) CLI runner.
 *
 * Wraps the live forge-control (:7700) API and local guard/harness tools.
 * Provides typed subcommands, ANSI tabular formatting, --json output, and actionable error messages.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const DEFAULT_API_BASE = process.env.FORGE_CONTROL_URL || "http://127.0.0.1:7700";

// This file lives at <repo>/forge-control/src/lib/cli-runner.ts. Resolving
// repo-relative paths (guard.sh) against process.cwd() would break the
// moment `aios` is invoked from anywhere but the repo root — resolve them
// against this file's location instead, since the CLI must be runnable from
// any directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// --- Types ---

export interface SearchHit {
  title: string;
  score?: number;
  snippet?: string;
  slug?: string;
}

export interface SearchGroupRow {
  title: string;
  meta: string;
  snippet?: string;
}

export interface SearchGroup {
  key: string;
  label: string;
  rows: SearchGroupRow[];
}

export interface SearchResult {
  q: string;
  count: number;
  hits?: SearchHit[];
  groups?: SearchGroup[];
}

// --- ANSI Color & Table Formatting ---

export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

export function isColorEnabled(): boolean {
  if (process.env.NO_COLOR || process.argv.includes("--no-color")) return false;
  return Boolean(process.stdout.isTTY);
}

export function c(text: string, colorCode: string): string {
  if (!isColorEnabled()) return text;
  return `${colorCode}${text}${colors.reset}`;
}

export function statusBadge(status: string | null | undefined): string {
  const s = (status ?? "unknown").toLowerCase();
  switch (s) {
    case "active":
    case "running":
    case "ready":
    case "done":
    case "completed":
    case "ok":
    case "true":
      return c(` ${s.toUpperCase()} `, colors.bgGreen + colors.white);
    case "paused":
    case "queued":
    case "pending":
    case "wait":
      return c(` ${s.toUpperCase()} `, colors.yellow);
    case "stuck":
    case "blocked":
    case "failed":
    case "cancelled":
    case "dead":
    case "false":
      return c(` ${s.toUpperCase()} `, colors.bgRed + colors.white);
    default:
      return c(s, colors.gray);
  }
}

export function truncate(str: string | null | undefined, maxLen = 40): string {
  if (!str) return "";
  const single = str.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 1) + "…";
}

export interface Column<T> {
  header: string;
  width?: number;
  align?: "left" | "right";
  get: (item: T) => string;
}

export function formatTable<T>(items: T[], columns: Column<T>[]): string {
  if (items.length === 0) return c("No entries found.", colors.dim);

  const widths = columns.map((col) => {
    let max = col.header.length;
    for (const item of items) {
      const val = col.get(item);
      const rawLen = val.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (rawLen > max) max = rawLen;
    }
    if (col.width && col.width > max) return col.width;
    return Math.min(max, col.width ?? 60);
  });

  const headerRow = columns
    .map((col, i) => {
      const pad = widths[i] - col.header.length;
      return col.align === "right"
        ? " ".repeat(Math.max(0, pad)) + c(col.header, colors.bold)
        : c(col.header, colors.bold) + " ".repeat(Math.max(0, pad));
    })
    .join("  ");

  const divider = widths.map((w) => "─".repeat(w)).join("  ");

  const rows = items.map((item) => {
    return columns
      .map((col, i) => {
        const raw = col.get(item);
        const visibleLen = raw.replace(/\x1b\[[0-9;]*m/g, "").length;
        const pad = widths[i] - visibleLen;
        return col.align === "right"
          ? " ".repeat(Math.max(0, pad)) + raw
          : raw + " ".repeat(Math.max(0, pad));
      })
      .join("  ");
  });

  return [headerRow, c(divider, colors.dim), ...rows].join("\n");
}

// --- Error Reporting ---

export class CliError extends Error {
  action?: string;
  statusCode?: number;

  constructor(message: string, action?: string, statusCode?: number) {
    super(message);
    this.name = "CliError";
    this.action = action;
    this.statusCode = statusCode;
  }
}

export function printError(err: unknown): void {
  const isJson = process.argv.includes("--json");
  if (isJson) {
    const errorObj = {
      error: err instanceof Error ? err.message : String(err),
      action: err instanceof CliError ? err.action : undefined,
      status: err instanceof CliError ? err.statusCode : undefined,
    };
    console.error(JSON.stringify(errorObj, null, 2));
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n${c("✖ ERROR:", colors.red + colors.bold)} ${msg}`);
  if (err instanceof CliError && err.action) {
    console.error(`${c("→ ACTION:", colors.cyan + colors.bold)} ${err.action}\n`);
  } else {
    console.error("");
  }
}

// --- API Client ---

export class AiosClient {
  baseUrl: string;

  constructor(baseUrl = DEFAULT_API_BASE) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    let url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    if (options.params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      const qs = q.toString();
      if (qs) url += `?${qs}`;
    }

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      throw new CliError(
        `Failed to reach forge-control API at ${this.baseUrl} (${err})`,
        "Verify forge-control is running via: pm2 status forge-control or check network configuration.",
      );
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
      const errorMsg =
        typeof record.error === "string"
          ? record.error
          : typeof record.message === "string"
            ? record.message
            : `API responded with status ${res.status}`;
      throw new CliError(errorMsg, undefined, res.status);
    }

    return data as T;
  }
}

// --- Argument Parser Helper ---

export interface ParsedArgs {
  subcommand: string;
  action: string;
  args: string[];
  flags: Record<string, string | boolean | string[]>;
  json: boolean;
  help: boolean;
}

/** Value-less switches. Listed explicitly because the generic branch below
 *  consumes the following token as the flag's value, which would silently
 *  eat a positional argument (`--new "git status"`). */
export const BOOLEAN_FLAGS = new Set(["new", "force"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k] = v;
      } else if (BOOLEAN_FLAGS.has(key)) {
        // A switch never eats the next token: `--new "git status"` must leave
        // the command as a positional, not swallow it as the flag's value.
        flags[key] = true;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  const subcommand = positional[0] || "";
  const action = positional[1] || "";
  const args = positional.slice(2);

  return { subcommand, action, args, flags, json, help };
}

// --- Subcommand Handlers ---

export async function handleProjects(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios projects", colors.bold + colors.cyan)} — Manage AI OS multi-agent coding projects

${c("USAGE", colors.bold)}
  aios projects list
  aios projects show <id>
  aios projects create <title> --brief <text|file> [--tier <tier>] [--repo <repo>] [--base-branch <branch>]
  aios projects pause <id>
  aios projects resume <id>
  aios projects unwedge <id> [--force]

${c("OPTIONS", colors.bold)}
  --brief <text|path>   Project brief description string or path to markdown file
  --tier <tier>         Architect tier: fast | junior | standard | flagship | gemini (default: standard)
  --repo <repo>         Target repo: ai-os | content-forge | scratch (default: ai-os)
  --base-branch <name>  Base git branch (default: main)
  --mode <mode>         Project mode: goal | standard
  --json                Output raw JSON
`);
    return;
  }

  switch (action) {
    case "list": {
      const res = await client.request<{ count: number; projects: Array<Record<string, unknown>> }>("/api/projects");
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(c(`\nProjects (${res.count}):`, colors.bold));
      console.log(
        formatTable(res.projects, [
          { header: "ID", get: (p) => c(String(p.id).slice(0, 8), colors.cyan) },
          { header: "Name", get: (p) => truncate(String(p.name || p.title || ""), 30) },
          { header: "Repo", get: (p) => String(p.repo || "ai-os") },
          { header: "Status", get: (p) => statusBadge(String(p.status)) },
          { header: "Created", get: (p) => c(truncate(String(p.created_at || ""), 19), colors.dim) },
        ]),
      );
      console.log("");
      break;
    }
    case "show": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Project ID required.", "Usage: aios projects show <id>");
      const res = await client.request<{ project: Record<string, unknown>; tasks: Array<Record<string, unknown>> }>(`/api/projects/${id}`);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const p = res.project;
      console.log(`\n${c("Project:", colors.bold)} ${p.name} (${c(String(p.id), colors.cyan)})`);
      console.log(`  ${c("Repo:", colors.dim)} ${p.repo} | ${c("Status:", colors.dim)} ${statusBadge(String(p.status))} | ${c("Workspace:", colors.dim)} ${p.workspace_dir || "none"}`);
      console.log(`  ${c("Created:", colors.dim)} ${p.created_at}\n`);
      if (res.tasks && res.tasks.length > 0) {
        console.log(c(`Tasks (${res.tasks.length}):`, colors.bold));
        console.log(
          formatTable(res.tasks, [
            { header: "ID", get: (t) => c(String(t.id).slice(0, 8), colors.cyan) },
            { header: "Rnd", align: "right", get: (t) => String(t.round ?? 0) },
            { header: "Role", get: (t) => String(t.role) },
            { header: "Tier", get: (t) => c(String(t.tier || "default"), colors.magenta) },
            { header: "Status", get: (t) => statusBadge(String(t.status)) },
            { header: "Title", get: (t) => truncate(String(t.title), 36) },
            { header: "Deps", get: (t) => Array.isArray(t.depends_on) && t.depends_on.length > 0 ? `${t.depends_on.length} dep(s)` : "-" },
          ]),
        );
      } else {
        console.log(c("No tasks found for this project.", colors.dim));
      }
      console.log("");
      break;
    }
    case "create": {
      const title = args[0] || (flags.title as string) || (flags.name as string);
      if (!title) throw new CliError("Project title required.", "Usage: aios projects create <title> --brief <text|file>");
      let brief = (flags.brief as string) || "";
      if (!brief && args[1]) brief = args.slice(1).join(" ");
      if (!brief) throw new CliError("Project brief required (--brief).", "Provide a brief description text or path to a file.");
      if (existsSync(brief)) {
        brief = readFileSync(brief, "utf8");
      }
      const repo = (flags.repo as string) || "ai-os";
      const tier = flags.tier as string | undefined;
      const baseBranch = flags["base-branch"] as string | undefined;
      const mode = flags.mode as string | undefined;
      const originChatId = process.env.FORGE_RUN_UUID;

      const body: Record<string, unknown> = {
        name: title,
        brief,
        repo,
        architect_tier: tier,
        base_branch: baseBranch,
        mode,
        origin_chat_id: originChatId,
      };

      const res = await client.request<{ project: Record<string, unknown>; architectTask?: Record<string, unknown>; warning?: string }>("/api/projects", {
        method: "POST",
        body,
      });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(`\n${c("✔ Project created successfully!", colors.green + colors.bold)}`);
      console.log(`  ${c("Project ID:", colors.bold)} ${c(String(res.project.id), colors.cyan)}`);
      console.log(`  ${c("Name:", colors.bold)} ${res.project.name}`);
      console.log(`  ${c("Repo:", colors.bold)} ${res.project.repo}`);
      if (res.architectTask) {
        console.log(`  ${c("Architect Task:", colors.bold)} ${c(String(res.architectTask.id), colors.magenta)} (tier: ${res.architectTask.tier || "default"})`);
      }
      if (res.warning) {
        console.log(`  ${c("Warning:", colors.yellow)} ${res.warning}`);
      }
      console.log(`\nView status: ${c(`aios projects show ${res.project.id}`, colors.cyan)}\n`);
      break;
    }
    case "pause": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Project ID required.", "Usage: aios projects pause <id>");
      const res = await client.request<{ project: Record<string, unknown> }>(`/api/projects/${id}/status`, {
        method: "POST",
        body: { status: "paused" },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Project paused:", colors.green)} ${res.project.name} (${c(String(res.project.id), colors.cyan)})\n`);
      break;
    }
    case "resume": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Project ID required.", "Usage: aios projects resume <id>");
      const res = await client.request<{ project: Record<string, unknown> }>(`/api/projects/${id}/status`, {
        method: "POST",
        body: { status: "active" },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Project resumed:", colors.green)} ${res.project.name} (${c(String(res.project.id), colors.cyan)})\n`);
      break;
    }
    case "unwedge": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Project ID required.", "Usage: aios projects unwedge <id> [--force]");
      const force = Boolean(flags.force);
      const res = await client.request<{ project: Record<string, unknown>; retried: string[]; skipped: string[]; warning?: string }>(`/api/projects/${id}/unwedge`, {
        method: "POST",
        body: { force },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Unwedge complete:", colors.green)} ${res.retried.length} retried, ${res.skipped.length} skipped`);
      if (res.warning) console.log(`  ${c("Warning:", colors.yellow)} ${res.warning}`);
      console.log("");
      break;
    }
    default:
      throw new CliError(`Unknown projects action '${action}'.`, "Run 'aios projects --help' for available actions.");
  }
}

/**
 * One entry of `GET /api/runs/:id/comms` — built by `listComms()` in
 * `forge-control/src/db/runs.ts`, which projects exactly these five keys.
 * The message body is `content` (NOT `text`), and the sender rides in
 * `meta.comms.from` (NOT a top-level `from`), alongside the direction and the
 * peer's run id as written by `commsEntries()` in `lib/run-control-rules.ts`.
 */
export interface CommsLine {
  role?: string;
  content?: string;
  ts?: string;
  kind?: string;
  meta?: {
    comms?: {
      from?: string;
      direction?: string;
      peer_run_id?: string | null;
      peer_role?: string;
    };
  } | null;
}

export function commsLabel(entry: CommsLine): string {
  const meta = entry.meta?.comms;
  const from = meta?.from ?? entry.role ?? "?";
  const arrow = meta?.direction === "out" ? "→" : "←";
  const peer = meta?.peer_role ? `/${meta.peer_role}` : "";
  return c(`[${arrow} ${from}${peer}]`, colors.yellow);
}

/** An entry with no `content` is a shape change, not an empty message — say so
 *  by name instead of rendering a blank line that reads like silence. */
export function commsText(entry: CommsLine): string {
  if (typeof entry.content !== "string" || entry.content.length === 0) {
    return c(`<no 'content' on this comms entry — keys: ${Object.keys(entry).join(",") || "none"}>`, colors.red);
  }
  return truncate(entry.content, 100);
}

export async function handleRuns(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios runs", colors.bold + colors.cyan)} — Inspect and interact with agent execution runs

${c("USAGE", colors.bold)}
  aios runs list [--project <id>] [--limit <n>]
  aios runs show <id>
  aios runs message <id> <text> [--from worker|konrad|manager]
  aios runs stop <id>

${c("OPTIONS", colors.bold)}
  --project <id>   Filter runs belonging to a specific project
  --limit <n>      Number of runs to return (default: 30)
  --from <role>    Message sender role (default: worker)
  --json           Output raw JSON
`);
    return;
  }

  switch (action) {
    case "list": {
      const limit = Number(flags.limit || 30);
      const projectId = flags.project as string | undefined;

      if (projectId) {
        const projectRes = await client.request<{ project: Record<string, unknown>; tasks: Array<Record<string, unknown>> }>(`/api/projects/${projectId}`);
        const taskRuns = (projectRes.tasks || []).filter((t) => t.run_id);
        if (json) {
          console.log(JSON.stringify({ project: projectRes.project, runs: taskRuns }, null, 2));
          return;
        }
        console.log(c(`\nRuns for Project ${projectRes.project.name} (${taskRuns.length}):`, colors.bold));
        console.log(
          formatTable(taskRuns, [
            { header: "Run ID", get: (t) => c(String(t.run_id).slice(0, 8), colors.cyan) },
            { header: "Task ID", get: (t) => c(String(t.id).slice(0, 8), colors.dim) },
            { header: "Role", get: (t) => String(t.role) },
            { header: "Tier", get: (t) => c(String(t.tier || "-"), colors.magenta) },
            { header: "Status", get: (t) => statusBadge(String(t.status)) },
            { header: "Title", get: (t) => truncate(String(t.title), 36) },
          ]),
        );
        console.log("");
        return;
      }

      const res = await client.request<{ count: number; runs: Array<Record<string, unknown>> }>("/api/chat", {
        params: { limit },
      });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(c(`\nRecent Runs (${res.runs.length}):`, colors.bold));
      console.log(
        formatTable(res.runs, [
          { header: "ID", get: (r) => c(String(r.id).slice(0, 8), colors.cyan) },
          { header: "Status", get: (r) => statusBadge(String(r.status)) },
          { header: "Model", get: (r) => c(String(r.model || "default"), colors.magenta) },
          { header: "Title", get: (r) => truncate(String(r.title || r.prompt || ""), 40) },
          { header: "Tasks", get: (r) => r.tasks_total ? `${r.tasks_done ?? 0}/${r.tasks_total}` : "-" },
          { header: "Created", get: (r) => c(truncate(String(r.created_at || ""), 19), colors.dim) },
        ]),
      );
      console.log("");
      break;
    }
    case "show": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Run ID required.", "Usage: aios runs show <id>");
      const res = await client.request<{ run: Record<string, unknown>; thread?: Array<Record<string, unknown>> }>(`/api/chat/${id}`);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const r = res.run || (res as Record<string, unknown>);
      console.log(`\n${c("Run:", colors.bold)} ${c(String(r.id), colors.cyan)}`);
      console.log(`  ${c("Title:", colors.bold)} ${r.title || r.prompt || "untitled"}`);
      console.log(`  ${c("Status:", colors.dim)} ${statusBadge(String(r.status))} | ${c("Model:", colors.dim)} ${r.model || "default"} | ${c("Effort:", colors.dim)} ${r.effort || "default"}`);
      console.log(`  ${c("Created:", colors.dim)} ${r.created_at} | ${c("Completed:", colors.dim)} ${r.completed_at || "in progress"}\n`);

      const comms = await client.request<{ comms: CommsLine[] }>(`/api/runs/${id}/comms`).catch(() => null);
      if (comms && comms.comms && comms.comms.length > 0) {
        console.log(c(`Comms (${comms.comms.length}):`, colors.bold));
        for (const entry of comms.comms.slice(-10)) {
          console.log(`  ${commsLabel(entry)} ${commsText(entry)}`);
        }
        console.log("");
      }
      break;
    }
    case "message": {
      const id = args[0] || (flags.id as string);
      let text = args.slice(1).join(" ");
      if (!text && flags.text) text = String(flags.text);
      if (!id || !text) throw new CliError("Run ID and message text required.", "Usage: aios runs message <id> <text>");
      const fromRole = (flags.from as string) || "worker";
      const senderRunId = process.env.FORGE_RUN_UUID;

      const body = {
        text,
        from: fromRole,
        sender_run_id: senderRunId,
      };

      const res = await client.request<{ ok: boolean; action?: string }>(`/api/runs/${id}/message`, {
        method: "POST",
        body,
      });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(`\n${c("✔ Message sent to run:", colors.green)} ${c(id, colors.cyan)}\n`);
      break;
    }
    case "stop": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Run ID required.", "Usage: aios runs stop <id>");
      const res = await client.request<{ ok: boolean; status?: string }>(`/api/runs/${id}/stop`, {
        method: "POST",
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Run stopped:", colors.green)} ${c(id, colors.cyan)}\n`);
      break;
    }
    default:
      throw new CliError(`Unknown runs action '${action}'.`, "Run 'aios runs --help' for available actions.");
  }
}

export async function handleTasks(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios tasks", colors.bold + colors.cyan)} — Manage and inspect project tasks

${c("USAGE", colors.bold)}
  aios tasks list [--project <id>]
  aios tasks show <id>
  aios tasks create --project <id> --role <role> --title <title> --brief <brief> [--tier <tier>]
  aios tasks retry <id> [--force]
  aios tasks cancel <id>

${c("OPTIONS", colors.bold)}
  --project <id>   Project UUID
  --role <role>    Task role: architect | planner | scout | researcher | builder | reviewer | steward | tester
  --tier <tier>    Model tier: fast | junior | standard | flagship | gemini
  --title <title>  Task summary title
  --brief <text>   Task briefing content or path to file
  --depends <ids>  Comma-separated list of dependency task UUIDs
  --workstream <w> Workstream name (default: main)
  --write-set <ps> Comma-separated list of repository-relative file paths
  --force          Override retry cap
  --json           Output raw JSON
`);
    return;
  }

  switch (action) {
    case "list": {
      const projectId = (flags.project as string) || args[0];
      if (projectId) {
        const res = await client.request<{ project: Record<string, unknown>; tasks: Array<Record<string, unknown>> }>(`/api/projects/${projectId}`);
        if (json) {
          console.log(JSON.stringify(res.tasks || [], null, 2));
          return;
        }
        console.log(c(`\nTasks for Project ${res.project.name} (${res.tasks.length}):`, colors.bold));
        console.log(
          formatTable(res.tasks, [
            { header: "ID", get: (t) => c(String(t.id).slice(0, 8), colors.cyan) },
            { header: "Rnd", align: "right", get: (t) => String(t.round ?? 0) },
            { header: "Role", get: (t) => String(t.role) },
            { header: "Tier", get: (t) => c(String(t.tier || "-"), colors.magenta) },
            { header: "Status", get: (t) => statusBadge(String(t.status)) },
            { header: "Title", get: (t) => truncate(String(t.title), 36) },
            { header: "Workstream", get: (t) => String(t.workstream || "main") },
            { header: "Deps", get: (t) => Array.isArray(t.depends_on) && t.depends_on.length > 0 ? `${t.depends_on.length}` : "-" },
          ]),
        );
        console.log("");
        return;
      }

      const res = await client.request<{ count: number; tasks: Array<Record<string, unknown>> }>("/api/projects/board");
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(c(`\nActive Tasks Across Projects (${res.count}):`, colors.bold));
      console.log(
        formatTable(res.tasks, [
          { header: "Task ID", get: (t) => c(String(t.id).slice(0, 8), colors.cyan) },
          { header: "Project ID", get: (t) => c(String(t.project_id).slice(0, 8), colors.dim) },
          { header: "Role", get: (t) => String(t.role) },
          { header: "Status", get: (t) => statusBadge(String(t.status)) },
          { header: "Title", get: (t) => truncate(String(t.title), 38) },
        ]),
      );
      console.log("");
      break;
    }
    case "show": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Task ID required.", "Usage: aios tasks show <id>");
      const res = await client.request<{ task: Record<string, unknown> }>(`/api/tasks/${id}`);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const t = res.task;
      console.log(`\n${c("Task:", colors.bold)} ${t.title} (${c(String(t.id), colors.cyan)})`);
      console.log(`  ${c("Project ID:", colors.dim)} ${t.project_id} | ${c("Round:", colors.dim)} ${t.round} | ${c("Workstream:", colors.dim)} ${t.workstream || "main"}`);
      console.log(`  ${c("Role:", colors.dim)} ${t.role} | ${c("Tier:", colors.dim)} ${t.tier || "default"} | ${c("Status:", colors.dim)} ${statusBadge(String(t.status))}`);
      if (t.run_id) console.log(`  ${c("Run ID:", colors.dim)} ${c(String(t.run_id), colors.cyan)}`);
      if (Array.isArray(t.depends_on) && t.depends_on.length > 0) {
        console.log(`  ${c("Depends On:", colors.dim)} ${t.depends_on.join(", ")}`);
      }
      if (Array.isArray(t.write_set) && t.write_set.length > 0) {
        console.log(`  ${c("Write Set:", colors.dim)} ${t.write_set.join(", ")}`);
      }
      console.log(`\n${c("Brief:", colors.bold)}\n${t.brief}\n`);
      break;
    }
    case "create": {
      const projectId = (flags.project as string) || (flags["project-id"] as string);
      if (!projectId) throw new CliError("Project ID required (--project).", "Usage: aios tasks create --project <id> --role <role> --title <title> --brief <brief>");
      const role = (flags.role as string);
      if (!role) throw new CliError("Role required (--role).", "Valid roles: architect, planner, scout, researcher, builder, reviewer, steward, tester");
      const title = (flags.title as string) || args[0];
      if (!title) throw new CliError("Title required (--title).", "Provide a short task title.");
      let brief = (flags.brief as string) || args.slice(1).join(" ");
      if (!brief) throw new CliError("Brief required (--brief).", "Provide brief text or a filepath.");
      if (existsSync(brief)) {
        brief = readFileSync(brief, "utf8");
      }

      const tier = flags.tier as string | undefined;
      const round = flags.round !== undefined ? Number(flags.round) : undefined;
      const workstream = flags.workstream as string | undefined;
      const dependsOn = flags.depends ? String(flags.depends).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const writeSet = flags["write-set"] ? String(flags["write-set"]).split(",").map((s) => s.trim()).filter(Boolean) : undefined;

      const body: Record<string, unknown> = {
        role,
        title,
        brief,
        tier,
        round,
        workstream,
        depends_on: dependsOn,
        write_set: writeSet,
      };

      const res = await client.request<{ task: Record<string, unknown> }>(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        body,
      });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(`\n${c("✔ Task created successfully!", colors.green + colors.bold)}`);
      console.log(`  ${c("Task ID:", colors.bold)} ${c(String(res.task.id), colors.cyan)}`);
      console.log(`  ${c("Title:", colors.bold)} ${res.task.title}`);
      console.log(`  ${c("Role:", colors.bold)} ${res.task.role} | ${c("Round:", colors.bold)} ${res.task.round}`);
      console.log("");
      break;
    }
    case "retry": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Task ID required.", "Usage: aios tasks retry <id> [--force]");
      const force = Boolean(flags.force);
      const res = await client.request<{ task: Record<string, unknown>; project_resumed?: boolean }>(`/api/tasks/${id}/retry`, {
        method: "POST",
        body: { force },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Task retry scheduled:", colors.green)} ${c(String(res.task.id), colors.cyan)} → ${statusBadge(String(res.task.status))}`);
      if (res.project_resumed) console.log(`  ${c("Project un-blocked and resumed.", colors.cyan)}`);
      console.log("");
      break;
    }
    case "cancel": {
      const id = args[0] || (flags.id as string);
      if (!id) throw new CliError("Task ID required.", "Usage: aios tasks cancel <id>");
      const taskRes = await client.request<{ task: Record<string, unknown> }>(`/api/tasks/${id}`);
      if (taskRes.task.run_id) {
        await client.request(`/api/runs/${taskRes.task.run_id}/stop`, { method: "POST" }).catch(() => null);
      }
      if (json) {
        console.log(JSON.stringify({ ok: true, task: taskRes.task }, null, 2));
        return;
      }
      console.log(`\n${c("✔ Task cancelled / run stopped:", colors.green)} ${c(id, colors.cyan)}\n`);
      break;
    }
    default:
      throw new CliError(`Unknown tasks action '${action}'.`, "Run 'aios tasks --help' for available actions.");
  }
}

export async function handleVault(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios vault", colors.bold + colors.cyan)} — Search and manage Obsidian knowledge vault notes

${c("USAGE", colors.bold)}
  aios vault search <query>
  aios vault today
  aios vault read <path>
  aios vault append <path|section> <text>

${c("OPTIONS", colors.bold)}
  --json    Output raw JSON
`);
    return;
  }

  switch (action) {
    case "search": {
      const query = args.join(" ") || (flags.query as string) || (flags.q as string);
      if (!query) throw new CliError("Search query required.", "Usage: aios vault search <query>");
      const res = await client.request<SearchResult>("/api/search", {
        params: { q: query },
      }).catch(async () => {
        return await client.request<SearchResult>("/api/memory/search", {
          params: { q: query },
        });
      });

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(c(`\nSearch results for "${query}":`, colors.bold));
      if (res.groups && Array.isArray(res.groups) && res.groups.length > 0) {
        for (const g of res.groups) {
          console.log(`\n  ${c(g.label, colors.cyan + colors.bold)} (${g.rows.length} hits)`);
          for (const row of g.rows.slice(0, 5)) {
            console.log(`    • ${c(row.title, colors.bold)} ${c(`[${row.meta}]`, colors.dim)}`);
            if (row.snippet) console.log(`      ${c(truncate(row.snippet, 90), colors.gray)}`);
          }
        }
      } else if (res.hits && Array.isArray(res.hits) && res.hits.length > 0) {
        for (const hit of res.hits) {
          console.log(`  • ${c(hit.title || hit.slug || "hit", colors.bold)} ${hit.score !== undefined ? c(`(score: ${hit.score.toFixed(2)})`, colors.magenta) : ""}`);
          if (hit.snippet) console.log(`    ${c(truncate(hit.snippet, 90), colors.gray)}`);
        }
      } else {
        console.log(c("  No results found.", colors.dim));
      }
      console.log("");
      break;
    }
    case "today": {
      const [dailyRes, todayRes] = await Promise.all([
        client.request<{ path: string; date: string; content: string | null }>("/api/vault/daily").catch(() => null),
        client.request<{ date?: string; greeting?: string; chips?: Array<{ label: string }>; needs?: Array<{ title: string; age?: string }> }>("/api/today").catch(() => null),
      ]);

      if (json) {
        console.log(JSON.stringify({ daily: dailyRes, today: todayRes }, null, 2));
        return;
      }

      console.log(c(`\nAI OS — Today (${dailyRes?.date || todayRes?.date || "Current Day"}):`, colors.bold));
      if (todayRes?.greeting) {
        console.log(`  ${c(todayRes.greeting, colors.cyan)}`);
      }
      if (todayRes?.needs && todayRes.needs.length > 0) {
        console.log(`\n  ${c("Attention Required / Reminders:", colors.bold)}`);
        for (const need of todayRes.needs) {
          console.log(`    • ${need.title} ${need.age ? c(`(${need.age})`, colors.dim) : ""}`);
        }
      }
      if (dailyRes?.content) {
        console.log(`\n  ${c(`Daily Note (${dailyRes.path}):`, colors.bold + colors.yellow)}`);
        const preview = dailyRes.content.split("\n").slice(0, 15).join("\n");
        console.log(preview.replace(/^/gm, "    "));
      }
      console.log("");
      break;
    }
    case "read": {
      const notePath = args[0] || (flags.path as string);
      if (!notePath) throw new CliError("Path required.", "Usage: aios vault read <path>");
      const res = await client.request<{ path: string; content: string; sha256: string; bytes: number }>("/api/vault/file", {
        params: { path: notePath },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c(`Note: ${res.path}`, colors.bold + colors.cyan)} ${c(`(${res.bytes} bytes, sha256: ${res.sha256.slice(0, 8)})`, colors.dim)}\n`);
      console.log(res.content);
      console.log("");
      break;
    }
    case "append": {
      const target = args[0];
      const text = args.slice(1).join(" ");
      if (!target || !text) throw new CliError("Target and text required.", "Usage: aios vault append <section|path> <text>");

      if (["Tasks", "Notes", "Journal"].includes(target)) {
        const res = await client.request<{ ok: boolean; path?: string }>("/api/vault/append", {
          method: "POST",
          body: { section: target, text },
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(`\n${c("✔ Appended to Daily Note section:", colors.green)} ${target}\n`);
      } else {
        const fileRes = await client.request<{ path: string; content: string; sha256: string }>("/api/vault/file", {
          params: { path: target },
        }).catch(() => null);

        if (fileRes) {
          const updated = `${fileRes.content}\n\n${text}`;
          const res = await client.request<{ ok: boolean; path: string }>("/api/vault/file", {
            method: "PUT",
            body: { path: target, content: updated, base_sha256: fileRes.sha256 },
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          console.log(`\n${c("✔ Appended to note:", colors.green)} ${target}\n`);
        } else {
          const res = await client.request<{ ok: boolean; path?: string }>("/api/vault/note", {
            method: "POST",
            body: { title: target, content: text },
          });
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          console.log(`\n${c("✔ Created note with content:", colors.green)} ${target}\n`);
        }
      }
      break;
    }
    default:
      throw new CliError(`Unknown vault action '${action}'.`, "Run 'aios vault --help' for available actions.");
  }
}

export async function handlePipeline(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios pipeline", colors.bold + colors.cyan)} — Monitor Content Forge video generation pipeline and queues

${c("USAGE", colors.bold)}
  aios pipeline status
  aios pipeline topics list
  aios pipeline topics add <brief> [--title <title>]

${c("OPTIONS", colors.bold)}
  --json    Output raw JSON
`);
    return;
  }

  switch (action) {
    case "status": {
      const res = await client.request<{
        phases?: Array<{ key: string; label: string; count: number; stalled_count: number; state: string }>;
        workers?: { count: number; running: number; stopped: number };
        queues?: { ok: boolean; queues?: Array<{ queue: string; sets: Array<{ set: string; depth: number | null }> }> };
      }>("/api/pipeline");

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(c("\nContent Forge Pipeline Status:", colors.bold));
      if (res.phases && res.phases.length > 0) {
        console.log(`\n  ${c("Phases:", colors.bold)}`);
        console.log(
          formatTable(res.phases, [
            { header: "Phase", get: (p) => p.label },
            { header: "Active", align: "right", get: (p) => String(p.count) },
            { header: "Stalled", align: "right", get: (p) => p.stalled_count > 0 ? c(String(p.stalled_count), colors.red) : "0" },
            { header: "State", get: (p) => statusBadge(p.state) },
          ]),
        );
      }

      if (res.queues?.queues) {
        console.log(`\n  ${c("Queue Depths:", colors.bold)}`);
        const rows = res.queues.queues.map((q) => {
          const wait = q.sets.find((s) => s.set === "wait")?.depth ?? 0;
          const active = q.sets.find((s) => s.set === "active")?.depth ?? 0;
          const failed = q.sets.find((s) => s.set === "failed")?.depth ?? 0;
          return { name: q.queue.replace("queue-", ""), wait, active, failed };
        });
        console.log(
          formatTable(rows, [
            { header: "Queue", get: (r) => r.name },
            { header: "Wait", align: "right", get: (r) => String(r.wait) },
            { header: "Active", align: "right", get: (r) => String(r.active) },
            { header: "Failed", align: "right", get: (r) => r.failed > 0 ? c(String(r.failed), colors.red) : "0" },
          ]),
        );
      }
      console.log("");
      break;
    }
    case "topics": {
      const sub = args[0] || "list";
      if (sub === "list") {
        const res = await client.request<{ count: number; jobs: Array<Record<string, unknown>> }>("/api/forge/jobs", {
          params: { scope: "all", limit: 30 },
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(c(`\nTopics / Content Jobs (${res.count}):`, colors.bold));
        console.log(
          formatTable(res.jobs, [
            { header: "Job ID", get: (j) => c(String(j.id).slice(0, 8), colors.cyan) },
            { header: "Status", get: (j) => statusBadge(String(j.status)) },
            { header: "Format", get: (j) => String(j.format || "standard") },
            { header: "Title", get: (j) => truncate(String(j.title), 40) },
            { header: "Updated", get: (j) => c(truncate(String(j.updated_at || ""), 19), colors.dim) },
          ]),
        );
        console.log("");
      } else if (sub === "add") {
        const brief = args.slice(1).join(" ") || (flags.brief as string);
        if (!brief) throw new CliError("Topic brief required.", "Usage: aios pipeline topics add <brief>");
        // forge-control (:7700) exposes no write endpoint for content_jobs —
        // GET /api/forge/jobs and GET /api/pipeline are the only routes.
        // Faking a "queued" confirmation here would tell Konrad a topic
        // entered the pipeline when nothing was written anywhere.
        throw new CliError(
          "'aios pipeline topics add' is not wired up yet — forge-control has no API to create a content job.",
          "Add topics via the reelforge MCP tool (add_topics) or the 'rf' CLI on this host instead.",
        );
      } else {
        throw new CliError(`Unknown topics action '${sub}'.`, "Valid actions: list, add <brief>");
      }
      break;
    }
    default:
      throw new CliError(`Unknown pipeline action '${action}'.`, "Run 'aios pipeline --help' for available actions.");
  }
}

/**
 * `GET /api/spend/summary` — the shape `spendSummary()` in
 * `forge-control/src/db/spend.ts` actually returns: three fixed windows
 * (`today`, `d7`, `d30`), a `by_area` ARRAY of provider×kind rows, and a
 * `daily` series. There is no `days_30` and no `by_provider` map.
 *
 * `total_eur` is METERED spend — claude-code is excluded from it on purpose,
 * so the €50/day cap never trips on a subscription's notional cost. That
 * notional figure rides in a separate key: `claude_eur` on the API as it runs
 * today, `shadow_eur` after the newer db/spend.ts split lands. Both are read;
 * if neither is present the column prints "—" rather than an invented 0.00.
 */
export interface SpendWindowResponse {
  total_eur?: number;
  calls?: number;
  claude_eur?: number;
  shadow_eur?: number;
  claude_calls?: number;
}

export interface SpendAreaRow {
  provider?: string;
  kind?: string;
  total_eur?: number;
  calls?: number;
  units?: number;
}

export interface SpendSummaryResponse {
  today?: SpendWindowResponse;
  d7?: SpendWindowResponse;
  d30?: SpendWindowResponse;
  by_area?: SpendAreaRow[];
  daily?: Array<{ day?: string; total_eur?: number; calls?: number }>;
}

export function isSpendWindow(w: SpendWindowResponse | undefined): boolean {
  return Boolean(w) && typeof w?.total_eur === "number";
}

export function meteredEur(w: SpendWindowResponse | undefined): number {
  return Number(w?.total_eur ?? 0);
}

/** "—" when the API reports no subscription figure at all — never a fake 0.00. */
export function formatShadowEur(w: SpendWindowResponse | undefined): string {
  if (typeof w?.claude_eur === "number") return `€${w.claude_eur.toFixed(2)}`;
  if (typeof w?.shadow_eur === "number") return `€${w.shadow_eur.toFixed(2)}`;
  return "—";
}

export async function handleSpend(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios spend", colors.bold + colors.cyan)} — Inspect AI model API spend and subscription usage

${c("USAGE", colors.bold)}
  aios spend summary
  aios spend breakdown [--since 24h]

${c("OPTIONS", colors.bold)}
  --since <window>   Time window (default: 24h)
  --json             Output raw JSON
`);
    return;
  }

  switch (action) {
    case "summary": {
      const res = await client.request<SpendSummaryResponse>("/api/spend/summary");

      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      // The windows and the breakdown are REQUIRED, not optional. Printing
      // €0.00 because a key was renamed is exactly the "fake number is worse
      // than a blank one" failure — so a shape mismatch is a hard error
      // naming the keys that were actually returned.
      const windows: Array<[label: string, key: "today" | "d7" | "d30"]> = [
        ["Today", "today"],
        ["7-day", "d7"],
        ["30-day", "d30"],
      ];
      const missing = windows.filter(([, key]) => !isSpendWindow(res[key])).map(([, key]) => key);
      if (missing.length > 0) {
        throw new CliError(
          `/api/spend/summary returned no usable window object for: ${missing.join(", ")} ` +
            `(keys present: ${Object.keys(res).join(", ") || "none"}).`,
          "The API response shape changed. Run 'aios spend summary --json' to see it, then update handleSpend() in forge-control/src/lib/cli-runner.ts.",
        );
      }

      console.log(c("\nAI OS Spend Summary:", colors.bold));
      console.log(
        formatTable(windows, [
          { header: "Window", get: ([label]) => c(label, colors.bold) },
          { header: "Metered", align: "right", get: ([, key]) => `€${meteredEur(res[key]).toFixed(2)}` },
          { header: "Calls", align: "right", get: ([, key]) => String(res[key]?.calls ?? 0) },
          { header: "Claude Code", align: "right", get: ([, key]) => formatShadowEur(res[key]) },
          { header: "Calls", align: "right", get: ([, key]) => String(res[key]?.claude_calls ?? 0) },
        ]),
      );
      console.log(
        c(
          "  Metered = billed API spend. Claude Code = notional subscription cost, not a bill.",
          colors.dim,
        ),
      );

      if (!Array.isArray(res.by_area)) {
        throw new CliError(
          `/api/spend/summary returned no 'by_area' array (got ${typeof res.by_area}).`,
          "The API response shape changed. Run 'aios spend summary --json' to see it, then update handleSpend() in forge-control/src/lib/cli-runner.ts.",
        );
      }
      if (res.by_area.length === 0) {
        console.log(c("\n  By Area (30d): nothing recorded — no spend_log rows in the window.", colors.dim));
      } else {
        console.log(`\n  ${c("By Area (30d):", colors.bold)}`);
        console.log(
          formatTable(res.by_area, [
            { header: "Provider", get: (r) => c(String(r.provider), colors.magenta) },
            { header: "Kind", get: (r) => String(r.kind) },
            { header: "Spend", align: "right", get: (r) => `€${Number(r.total_eur ?? 0).toFixed(2)}` },
            { header: "Calls", align: "right", get: (r) => String(r.calls ?? 0) },
            { header: "Units", align: "right", get: (r) => String(r.units ?? 0) },
          ]),
        );
      }
      console.log("");
      break;
    }
    case "breakdown": {
      const res = await client.request<Record<string, unknown>>("/api/spend/today");
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(c("\nToday's Detailed Spend Breakdown:", colors.bold));
      console.log(JSON.stringify(res, null, 2));
      console.log("");
      break;
    }
    default:
      throw new CliError(`Unknown spend action '${action}'.`, "Run 'aios spend --help' for available actions.");
  }
}

export async function handleScreenshots(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios screenshots", colors.bold + colors.cyan)} — Capture and manage UI verification screenshots

${c("USAGE", colors.bold)}
  aios screenshots list [--run <id>]
  aios screenshots take <surface> [--out <dir>] [--stamp <label>]
  aios screenshots view <path>

${c("OPTIONS", colors.bold)}
  --run <id>    Filter by run ID
  --out <dir>   Output directory (default: /opt/ai-os/uploads/$FORGE_RUN_ID)
  --stamp <lbl> Stamp label (default: current ISO stamp)
  --json        Output raw JSON
`);
    return;
  }

  switch (action) {
    case "list": {
      const runId = (flags.run as string) || args[0];
      if (runId) {
        const res = await client.request<{ id: string; shots: Array<{ name: string; path: string; url: string; size: number; mtime: string }> }>(`/api/uploads/${runId}/shots`);
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(c(`\nScreenshots for Run ${runId} (${res.shots.length}):`, colors.bold));
        console.log(
          formatTable(res.shots, [
            { header: "Name", get: (s) => s.name },
            { header: "Size", align: "right", get: (s) => `${Math.round(s.size / 1024)} KB` },
            { header: "URL", get: (s) => c(s.url, colors.cyan) },
            { header: "Modified", get: (s) => c(truncate(s.mtime, 19), colors.dim) },
          ]),
        );
        console.log("");
        return;
      }

      const res = await client.request<{ runs: Array<{ id: string; count: number; latest_mtime: string }> }>("/api/uploads/index");
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(c(`\nScreenshot Runs (${res.runs.length}):`, colors.bold));
      console.log(
        formatTable(res.runs, [
          { header: "Run ID", get: (r) => c(r.id, colors.cyan) },
          { header: "Shots", align: "right", get: (r) => String(r.count) },
          { header: "Latest", get: (r) => c(truncate(r.latest_mtime, 19), colors.dim) },
        ]),
      );
      console.log("");
      break;
    }
    case "take": {
      const surface = args[0] || (flags.surface as string);
      if (!surface) throw new CliError("Surface name required.", "Usage: aios screenshots take <surface>");
      const outDir = (flags.out as string) || (process.env.FORGE_RUN_ID ? `/opt/ai-os/uploads/${process.env.FORGE_RUN_ID}` : "/opt/ai-os/uploads/cli");
      const stamp = (flags.stamp as string) || new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15) + "Z";
      const shotScript = "/opt/ai-os/workspace/shots-aios.mjs";

      console.log(c(`\nCapturing screenshot of surface '${surface}'...`, colors.cyan));
      await new Promise<void>((resolvePromise, reject) => {
        const proc = spawn("node", [shotScript], {
          env: {
            ...process.env,
            SHOT_SURFACES: surface,
            SHOT_STAMP: stamp,
            SHOT_OUT: outDir,
          },
          stdio: "inherit",
        });
        proc.on("close", (code) => {
          if (code === 0) resolvePromise();
          else reject(new CliError(`Screenshot harness exited with code ${code}`));
        });
      });

      console.log(`\n${c("✔ Screenshot captured:", colors.green)} ${outDir}/${stamp}-${surface}.png\n`);
      break;
    }
    case "view": {
      const filePath = args[0] || (flags.path as string);
      if (!filePath) throw new CliError("File path required.", "Usage: aios screenshots view <path>");
      if (!existsSync(filePath)) throw new CliError(`File not found: ${filePath}`);
      const st = statSync(filePath);
      if (json) {
        console.log(JSON.stringify({ path: filePath, size: st.size, mtime: st.mtime }, null, 2));
        return;
      }
      console.log(`\n${c("Screenshot:", colors.bold)} ${filePath}`);
      console.log(`  ${c("Size:", colors.dim)} ${Math.round(st.size / 1024)} KB | ${c("Modified:", colors.dim)} ${st.mtime.toISOString()}\n`);
      break;
    }
    default:
      throw new CliError(`Unknown screenshots action '${action}'.`, "Run 'aios screenshots --help' for available actions.");
  }
}

export async function handleTerminal(client: AiosClient, parsed: ParsedArgs): Promise<void> {
  const { action, args, flags, json, help } = parsed;

  if (help || !action) {
    console.log(`
${c("aios terminal", colors.bold + colors.cyan)} — Manage persistent terminal shell sessions

${c("USAGE", colors.bold)}
  aios terminal list
  aios terminal create [--title <title>] [--cwd <path>]
  aios terminal run <command> --session <id>
  aios terminal run <command> --new [--title <t>] [--cwd <p>]

${c("OPTIONS", colors.bold)}
  --title <name>  Session title (default: shell)
  --cwd <path>    Working directory (default: /opt/forge-ai-os)
  --session <id>  Target session ID — REQUIRED for 'run' unless --new is given
  --new           Create a fresh session for this command instead of reusing one
  --json          Output raw JSON

${c("WHY --session IS REQUIRED", colors.bold)}
  These sessions are the same pool the desktop Terminal pane drives. Picking
  "the first alive session" would type this command straight into whatever
  shell Konrad has open. Name the session, or make your own with --new.
`);
    return;
  }

  switch (action) {
    case "list": {
      const res = await client.request<{ sessions: Array<{ id: string; title: string; created_at: string; alive: boolean }> }>("/api/terminal/sessions");
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(c(`\nActive Terminal Sessions (${res.sessions.length}):`, colors.bold));
      console.log(
        formatTable(res.sessions, [
          { header: "Session ID", get: (s) => c(s.id, colors.cyan) },
          { header: "Title", get: (s) => s.title },
          { header: "Alive", get: (s) => statusBadge(s.alive ? "active" : "dead") },
          { header: "Created", get: (s) => c(truncate(s.created_at, 19), colors.dim) },
        ]),
      );
      console.log("");
      break;
    }
    case "create": {
      const title = (flags.title as string) || "shell";
      const cwd = (flags.cwd as string) || "/opt/forge-ai-os";
      const res = await client.request<{ id: string; title: string; cwd: string; alive: boolean }>("/api/terminal/sessions", {
        method: "POST",
        body: { title, cwd },
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`\n${c("✔ Terminal session created:", colors.green + colors.bold)}`);
      console.log(`  ${c("ID:", colors.bold)} ${c(res.id, colors.cyan)}`);
      console.log(`  ${c("Title:", colors.bold)} ${res.title} | ${c("CWD:", colors.dim)} ${res.cwd}\n`);
      break;
    }
    case "run": {
      const cmd = args.join(" ") || (flags.cmd as string) || (flags.command as string);
      if (!cmd) throw new CliError("Command required.", "Usage: aios terminal run <command>");

      // A terminal session is SOMEONE'S SHELL. The desktop Terminal pane drives
      // this exact pool, so "reuse the first alive session" meant an agent's
      // `aios terminal run` could submit into the shell Konrad is typing in.
      // There is no ownership field on a session to check, so the CLI refuses
      // to guess: name the session, or create one that is yours (--new).
      const explicitSession = flags.session as string | undefined;
      const wantsNew = Boolean(flags.new);
      if (explicitSession && wantsNew) {
        throw new CliError(
          "--session and --new are mutually exclusive.",
          "Pass --session <id> to target an existing shell, or --new to create one for this command.",
        );
      }

      let sessionId: string;
      if (explicitSession) {
        sessionId = explicitSession;
      } else if (wantsNew) {
        const createRes = await client.request<{ id: string }>("/api/terminal/sessions", {
          method: "POST",
          body: { title: (flags.title as string) || "aios-cli-run", cwd: (flags.cwd as string) || "/opt/forge-ai-os" },
        });
        sessionId = createRes.id;
        console.log(c(`Created session ${sessionId} for this command.`, colors.dim));
      } else {
        const listRes = await client
          .request<{ sessions: Array<{ id: string; title?: string; alive: boolean }> }>("/api/terminal/sessions")
          .catch(() => null);
        const alive = (listRes?.sessions ?? []).filter((s) => s.alive);
        const known = alive.length > 0
          ? ` Alive sessions: ${alive.map((s) => `${s.id}${s.title ? ` (${s.title})` : ""}`).join(", ")}.`
          : " No alive sessions right now.";
        throw new CliError(
          "'aios terminal run' needs an explicit target session — these are live interactive shells, including the one the desktop Terminal pane is attached to.",
          `Pass --session <id> to type into a specific shell, or --new to run in a fresh session of your own.${known}`,
        );
      }

      await client.request(`/api/terminal/sessions/${sessionId}/input`, {
        method: "POST",
        body: { text: cmd, submit: true },
      });

      // Brief delay to allow execution, then read output
      await new Promise((r) => setTimeout(r, 600));

      const outputRes = await client.request<{ content: string; alive: boolean }>(`/api/terminal/sessions/${sessionId}`);
      if (json) {
        console.log(JSON.stringify({ sessionId, content: outputRes.content }, null, 2));
        return;
      }

      console.log(`\n${c(`[terminal ${sessionId.slice(0, 8)}]`, colors.dim)}\n${outputRes.content}\n`);
      break;
    }
    default:
      throw new CliError(`Unknown terminal action '${action}'.`, "Run 'aios terminal --help' for available actions.");
  }
}

export async function handleGuard(parsed: ParsedArgs): Promise<void> {
  const { action, flags, json, help } = parsed;

  if (help) {
    console.log(`
${c("aios guard", colors.bold + colors.cyan)} — Execute high-speed pre-merge code guard and discrimination suite

${c("USAGE", colors.bold)}
  aios guard fast      # Phases 0-2 (tokens, static rules, cached parallel typecheck) [<30s]
  aios guard full      # Phases 0-4 (full suite, web build, unit tests)
  aios guard strict    # Strict mode (reject any skipped phases)

${c("OPTIONS", colors.bold)}
  --json    Output raw JSON summary
`);
    return;
  }

  const mode = action === "full" ? "--full" : action === "strict" ? "--strict" : "--fast";
  const guardPath = resolve(REPO_ROOT, "scripts/checks/guard.sh");

  if (!existsSync(guardPath)) {
    throw new CliError(`Guard script not found at ${guardPath}`, "Ensure scripts/checks/guard.sh exists in repository root.");
  }

  const guardArgs = [guardPath, mode];
  if (json) guardArgs.push("--json");

  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn("bash", guardArgs, {
      stdio: "inherit",
      env: process.env,
    });
    proc.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new CliError(`Guard checks failed with exit code ${code}`));
    });
  });
}

// --- Root CLI Runner ---

export async function runAiosCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const client = new AiosClient();

  if (parsed.help && !parsed.subcommand) {
    console.log(`
${c("Personal AI OS CLI (aios)", colors.bold + colors.cyan)} — Unified command-line interface for Konrad's AI OS

${c("USAGE", colors.bold)}
  aios <subcommand> [action] [options]

${c("SUBCOMMANDS", colors.bold)}
  ${c("projects", colors.bold)}     List, inspect, create, pause, and resume multi-agent coding projects
  ${c("runs", colors.bold)}         Inspect active/recent agent execution runs and send comms messages
  ${c("tasks", colors.bold)}        List, show, create, retry, and manage project tasks
  ${c("vault", colors.bold)}        Search Obsidian notes, read daily notes, and append quick captures
  ${c("pipeline", colors.bold)}     Monitor Content Forge video generation queues and add topics
  ${c("spend", colors.bold)}        View today's and 30-day model spending and provider breakdowns
  ${c("screenshots", colors.bold)}  Capture, list, and verify UI surface screenshots
  ${c("terminal", colors.bold)}     List, create, and send commands to persistent tmux shells
  ${c("guard", colors.bold)}        Run pre-merge fast/full/strict validation and discrimination gates

${c("GLOBAL OPTIONS", colors.bold)}
  --json        Format output as machine-readable JSON
  --help, -h    Display command-specific help and examples
  --no-color    Disable colored ANSI output

${c("EXAMPLES", colors.bold)}
  aios projects list
  aios projects create "Feature X" --brief "Implement feature X in forge-control"
  aios vault today
  aios guard fast
`);
    return;
  }

  switch (parsed.subcommand) {
    case "projects":
      await handleProjects(client, parsed);
      break;
    case "runs":
      await handleRuns(client, parsed);
      break;
    case "tasks":
      await handleTasks(client, parsed);
      break;
    case "vault":
      await handleVault(client, parsed);
      break;
    case "pipeline":
      await handlePipeline(client, parsed);
      break;
    case "spend":
      await handleSpend(client, parsed);
      break;
    case "screenshots":
      await handleScreenshots(client, parsed);
      break;
    case "terminal":
      await handleTerminal(client, parsed);
      break;
    case "guard":
      await handleGuard(parsed);
      break;
    default:
      if (!parsed.subcommand) {
        await runAiosCli(["--help"]);
        return;
      }
      throw new CliError(
        `Unknown subcommand '${parsed.subcommand}'.`,
        "Run 'aios --help' to see all available subcommands.",
      );
  }
}

// Executed only when this module is run directly (via `tsx cli-runner.ts ...`,
// which is how bin/aios.mjs invokes it) — never when imported as a library.
if (import.meta.url === `file://${process.argv[1]}`) {
  runAiosCli(process.argv.slice(2)).catch((err) => {
    printError(err);
    process.exit(1);
  });
}
