/*
 * Slash command registry for the v1.6 phase 4 chat composer.
 *
 * Inspired by NousResearch/hermes-agent's slashExec.ts contract but
 * runs entirely client-side against the existing forge-control HTTP
 * routes (no remote slash.exec or command.dispatch endpoints). Each
 * command's handler receives a SlashContext with the API helpers it
 * needs.
 *
 * Add a new command by appending an entry to SLASH_COMMANDS. The
 * SlashPopover renders {name, help} and dispatches handler() on
 * Tab / Enter / click.
 */

import type { RunStatus } from "../../api";

export type SlashDirective =
  | { kind: "noop" }
  | { kind: "send-message"; message: string }
  | { kind: "navigate"; surface: SurfaceKey };

export type SurfaceKey =
  | "today"
  | "inbox"
  | "chat"
  | "live"
  | "control"
  | "pipeline"
  | "skills"
  | "memory"
  | "autonomy";

export interface SlashContext {
  runId: string | null;
  runStatus: RunStatus | null;
  /** Push a synthetic system bubble into the local rendered thread.
   *  Pure UI — doesn't write to the runs table. */
  sys(text: string): void;
  /** Change the active desktop surface. */
  nav(s: SurfaceKey): void;
  freezeFleet(): Promise<unknown>;
  resumeFleet(): Promise<unknown>;
  /** POST /api/chat/:id/resume. Only valid when runStatus === 'stuck'. */
  resumeRun(id: string): Promise<unknown>;
  /** POST /api/chat/:id/status with the new status. */
  setRunStatus(id: string, status: RunStatus): Promise<unknown>;
}

export interface SlashCommand {
  name: string;
  help: string;
  /** Returns a directive telling the composer what to do next. Most
   *  handlers return `{ kind: 'noop' }`; navigation returns `navigate`. */
  handler(
    ctx: SlashContext,
    args: string,
  ): Promise<SlashDirective> | SlashDirective;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    help: "list every slash command",
    handler: (ctx) => {
      const lines = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.help}`).join(
        "\n",
      );
      ctx.sys(`available slash commands:\n${lines}`);
      return { kind: "noop" };
    },
  },
  {
    name: "freeze",
    help: "freeze the fleet (FREEZE button equivalent)",
    handler: async (ctx) => {
      await ctx.freezeFleet();
      ctx.sys("fleet frozen — dispatcher + executor will hold work.");
      return { kind: "noop" };
    },
  },
  {
    name: "resume",
    help: "resume the fleet from freeze",
    handler: async (ctx) => {
      await ctx.resumeFleet();
      ctx.sys("fleet resumed.");
      return { kind: "noop" };
    },
  },
  {
    name: "skills",
    help: "open the Skills surface",
    handler: () => ({ kind: "navigate", surface: "skills" }),
  },
  {
    name: "memory",
    help: "open the Memory surface",
    handler: () => ({ kind: "navigate", surface: "memory" }),
  },
  {
    name: "pipeline",
    help: "open the Pipeline surface",
    handler: () => ({ kind: "navigate", surface: "pipeline" }),
  },
  {
    name: "live",
    help: "open the Live surface (fleet stats)",
    handler: () => ({ kind: "navigate", surface: "live" }),
  },
  {
    name: "control",
    help: "open the Control surface (loops + decision log)",
    handler: () => ({ kind: "navigate", surface: "control" }),
  },
  {
    name: "autonomy",
    help: "open the Autonomy surface (guardrail rules + trips)",
    handler: () => ({ kind: "navigate", surface: "autonomy" }),
  },
  {
    name: "inbox",
    help: "open the Inbox surface",
    handler: () => ({ kind: "navigate", surface: "inbox" }),
  },
  {
    name: "today",
    help: "open the Today dashboard",
    handler: () => ({ kind: "navigate", surface: "today" }),
  },
  {
    name: "resume-run",
    help: "resume the currently selected stuck run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      if (ctx.runStatus !== "stuck") {
        ctx.sys(
          `current run is '${ctx.runStatus}', not 'stuck' — resume only valid on stuck.`,
        );
        return { kind: "noop" };
      }
      await ctx.resumeRun(ctx.runId);
      ctx.sys("run re-queued. executor will reclaim with continue marker.");
      return { kind: "noop" };
    },
  },
  {
    name: "cancel",
    help: "cancel the currently selected run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      await ctx.setRunStatus(ctx.runId, "cancelled");
      ctx.sys("run cancelled.");
      return { kind: "noop" };
    },
  },
  {
    name: "pause",
    help: "pause the currently selected running run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      if (ctx.runStatus !== "running") {
        ctx.sys(
          `current run is '${ctx.runStatus}', not 'running' — nothing to pause.`,
        );
        return { kind: "noop" };
      }
      await ctx.setRunStatus(ctx.runId, "paused");
      ctx.sys("run paused.");
      return { kind: "noop" };
    },
  },
  {
    name: "clear",
    help: "clear the local UI bubbles (does NOT touch runs.thread)",
    handler: (ctx) => {
      ctx.sys("[local clear marker — refresh the page to see the real thread]");
      return { kind: "noop" };
    },
  },
];

export function parseSlash(input: string): { name: string; args: string } {
  const m = input.replace(/^\/+/, "").match(/^(\S+)\s*(.*)$/);
  return m ? { name: m[1], args: m[2].trim() } : { name: "", args: "" };
}

export function findSlash(name: string): SlashCommand | null {
  return SLASH_COMMANDS.find((c) => c.name === name) ?? null;
}
