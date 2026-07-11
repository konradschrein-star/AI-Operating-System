/**
 * Claude Code engine — spawns `claude -p` as the run executor's brain.
 *
 * This is the "executors are Claude Code instances" architecture from
 * CLAUDE-DESIGN-BRIEF.md §20 step 2: a headless CC process with real
 * tools (Bash, Read/Write/Edit, WebSearch, …) instead of a text-only
 * LLM call. Events stream back as JSONL (--output-format stream-json),
 * so the caller can persist tool calls / interim text into runs.thread
 * while the run is still going — that's what makes the chat UI feel
 * alive.
 *
 * Sessions: first turn creates a CC session (session_id in the init /
 * result events); follow-up turns pass --resume <id> so CC keeps its own
 * context server-side — no more re-sending the whole transcript.
 *
 * Auth: the VPS `claude` binary is OAuth-authenticated. ANTHROPIC_API_KEY
 * is explicitly stripped from the child env (see memory: OAuth only).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CC_BIN = process.env.CC_BIN ?? "claude";
const CC_WORKSPACE = process.env.CC_WORKSPACE ?? "/opt/ai-os/workspace";
// Default model for runs. "opus" = latest Opus (Opus 4.8) — the workhorse
// (v2.4: Sonnet 5 costs the same usage without being better, so it's not
// used as a default anywhere). Per-run override via runs.metadata.model
// ("haiku" for cheap/frequent heartbeats). Subagents (.claude/agents/*.md)
// carry their own model in frontmatter, independent of this default.
const CC_MODEL = process.env.CC_MODEL ?? "opus";
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
// Extra --add-dir entries, comma-separated.
const CC_ADD_DIRS = (process.env.CC_ADD_DIRS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Explicit tool allowlist instead of --dangerously-skip-permissions —
// the CLI refuses that flag under root (pm2 runs as root), and an
// allowlist is the better guardrail anyway. Comma-separated env override.
// "mcp__<server>" allows every tool of that MCP server; "Skill" unlocks
// the global skill library (/root/.claude/skills incl. hermes symlinks).
const CC_ALLOWED_TOOLS = (
  process.env.CC_ALLOWED_TOOLS ??
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Task",
    "TodoWrite",
    "NotebookEdit",
    "Skill",
    "SlashCommand",
    "mcp__context7",
    "mcp__github",
    "mcp__playwright",
    "mcp__postgres",
    "mcp__filesystem",
    "mcp__obsidian",
    "mcp__forge-memory",
    "mcp__chrome-devtools",
    "mcp__shadcn",
    "mcp__sequential-thinking",
    "mcp__memory",
    "mcp__fetch",
    "mcp__docker",
    "mcp__redis",
    "mcp__pexels",
    "mcp__auto-browser",
    "mcp__reelforge",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Models we let the UI/metadata select. Aliases resolve CLI-side. */
const MODEL_RE = /^[a-z0-9[\]().-]+$/i;
export function sanitizeModel(m: unknown): string | null {
  if (typeof m !== "string") return null;
  const v = m.trim();
  if (!v || v === "default" || !MODEL_RE.test(v) || v.length > 64) return null;
  return v;
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
export function sanitizeEffort(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const v = e.trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : null;
}

/** v2.5: the system prompt is built per-run instead of a single static
 *  const — most of it is unconditional, but the vault/knowledge block only
 *  applies when this run actually has vault access (--add-dir + Read/Grep
 *  scoped to it). Ticker-spawned roles that don't need Konrad's whole
 *  knowledge base (planner/scout/builder/reviewer today) skip it entirely —
 *  it was previously force-fed to every run regardless of relevance, pure
 *  wasted context for scoped roles. See docs/superpowers/specs/2026-07-11-
 *  manager-orchestration-model-tiering-design.md. */
function buildSystemPrompt(vaultAccess: boolean): string {
  return `You are the executor of Konrad's Personal AI OS (forge-control), running headless on his Hetzner VPS. You are not a chatbot — you are an operator with real tools. Do the work; don't describe hypothetical work.

Environment you control:
${vaultAccess ? `- Obsidian vault (Konrad's second brain): ${VAULT_DIR} — read AND write markdown. Daily notes: Daily/YYYY-MM-DD.md (sections: ## Tasks, ## Notes, ## Journal). Quick captures: Inbox/. Never delete or truncate notes; append or create.\n` : ""}- Content Forge (video automation monorepo): /opt/content-forge — PostgreSQL 'content_forge' (psql -U postgres), pm2-managed workers, Redis/BullMQ queues.
- forge-control API: http://127.0.0.1:7700/api/* (today, inbox, memory search, reminders, vault, spend, pipeline, projects — POST /api/projects to kick off a coding project, seeds an architect task automatically; optional "architect_tier": "fast"|"standard"|"flagship" picks its model).
- Reminders: POST http://127.0.0.1:7700/api/reminders {"text","when"} — when accepts "in 2h", "tomorrow 9:00", "daily 08:30".

Your arms and hands:
- Skills (Skill tool): a global library — hermes skills, taste/design skills, remotion motion graphics, playwright browser automation, ui-ux-pro-max, superpowers workflows, tuning skills. If a skill plausibly matches the task, invoke it before improvising.
- MCP servers: github (Konrad's account), context7 (library docs — use for ANY framework/API question instead of guessing), playwright + chrome-devtools (real browser), postgres, filesystem, obsidian, forge-memory (Konrad's knowledge graph), shadcn (UI registry), reelforge (video production factory — create_video/add_topics/list_topics/get_system_health/etc; prefer add_topics with a batch of briefs over one-off create_video calls, it self-promotes the backlog into jobs).
- Subagents (Task tool): architect (opus — system design), planner (sonnet — break down goals), builder (sonnet — implement), reviewer (sonnet — adversarial check), scout (haiku — fast recon). Delegate instead of doing everything in one context; pick the agent whose model tier matches the difficulty.
- Attachments: user messages may contain an [attached-files] block listing absolute paths on this machine (images included) — Read them; do not claim you cannot see attachments.
${vaultAccess ? `
Knowledge — search BEFORE you answer (v2.2):
- Any question touching Konrad's life, projects, decisions, notes, or preferences: search his knowledge base FIRST, answer SECOND. Never answer from training data what the vault can answer from his actual notes.
- Fast lane: GET "http://127.0.0.1:7700/api/memory/search?q=<query>" — vector + graph search over the indexed vault. Then Read the full note from ${VAULT_DIR} when a hit matters.
- Deep lane: Grep ${VAULT_DIR} directly for names, dates, exact phrases the embedding search might miss.
- A [MEMORY] block may be prepended to the prompt — that's prefetched context, treat it as a starting point, not the full picture.
- When you use his notes, say which ones — Konrad should see his second brain working.
- Konrad's personal profile lives at ${VAULT_DIR}/Mentor/Profile/ (goals, operating manual, principles, current chapter). READ IT before advising on priorities, life decisions, or anything where who-he-is changes the answer. If reality contradicts the profile, say so — and append the correction, never overwrite.
` : ""}
Google Workspace (konrad.schrein@gmail.com — durable OAuth, all major services):
- CLI: python3 "/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills/productivity/google-workspace/scripts/google_api.py" {gmail,calendar,drive,contacts,sheets,docs} — run with --help on a subcommand before first use.
- gmail search/read (e.g. gmail search 'is:unread' --max 10); SENDING email requires an explicit instruction in the CURRENT task.
- calendar list/create — day planning.
- drive search/get/upload/download — this is the OS's object storage for big files (videos, exports, reports). Konrad manages his VAs in Drive: Docs + Sheets there are living business documents — read freely, edit only when the task asks.
- sheets get/update/append — VA management sheets and finance sheets live here.
- If auth ever fails (invalid_grant): re-auth via /opt/ai-os/google-setup/setup.py (redirect localhost:8765) — do NOT loop retries.

Telegram turns (run source: telegram):
- Your final message lands on Konrad's PHONE. Hard cap ~1200 chars, no markdown tables, no headers — plain punchy text. Front-load the answer.

Rules:
- Be decisive. Research with your tools instead of asking; only escalate when truly blocked (POST /api/inbox is read by Konrad).
- Destructive operations (rm -rf, DROP/TRUNCATE, force-push, pm2 delete, mass file deletes) require an explicit instruction in the CURRENT task — otherwise refuse and propose the safe alternative.
- Keep final answers tight: what you did, what you found, what needs Konrad. No filler.
- When you learn something durable about Konrad's systems or preferences, append it to the vault note "AI OS/Operator Log.md" (create if missing).`;
}

export interface CcEvent {
  type: "init" | "assistant_text" | "tool_call" | "tool_result";
  sessionId?: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
}

export interface CcResult {
  text: string;
  sessionId: string | null;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  /** Count of assistant_text events emitted during the run. */
  assistantTextEvents: number;
}

export class CcResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcResumeError";
  }
}

interface StreamBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blockContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : typeof (c as StreamBlock).text === "string"
            ? (c as StreamBlock).text!
            : JSON.stringify(c),
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

export async function runClaudeCode(opts: {
  prompt: string;
  sessionId?: string | null;
  timeoutMs: number;
  /** Model alias/id for this run; falls back to CC_MODEL (sonnet). */
  model?: string | null;
  /** Reasoning effort for this run (low/medium/high/xhigh/max). Omitted
   *  entirely when unset — let the CLI's own default stand rather than
   *  forcing a level on every run. */
  effort?: string | null;
  /** Working directory override — e.g. a coding project's git worktree.
   *  Falls back to CC_WORKSPACE, the shared scratch dir every other run uses. */
  cwd?: string | null;
  /** Tool allowlist override — e.g. a coding-project role (reviewer gets no
   *  Write/Edit so it can only report findings, never silently fix them).
   *  Falls back to CC_ALLOWED_TOOLS, the full default list. */
  allowedTools?: string[] | null;
  /** Whether this run gets the Obsidian vault mounted (--add-dir) and the
   *  system prompt's knowledge-search instructions. Defaults to true —
   *  plain Chat/Manager runs keep today's behavior. Ticker-spawned roles
   *  that don't need Konrad's whole knowledge base pass false. */
  vaultAccess?: boolean;
  onEvent: (e: CcEvent) => void;
  /** Polled every ~5s; return true to kill the child (cancel/pause). */
  isCancelled?: () => Promise<boolean>;
}): Promise<CcResult> {
  const vaultAccess = opts.vaultAccess ?? true;
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  const allowedTools =
    opts.allowedTools && opts.allowedTools.length > 0
      ? opts.allowedTools
      : CC_ALLOWED_TOOLS;
  for (const t of allowedTools) args.push("--allowedTools", t);
  if (vaultAccess) args.push("--add-dir", VAULT_DIR);
  for (const d of CC_ADD_DIRS) args.push("--add-dir", d);
  const model = sanitizeModel(opts.model) ?? CC_MODEL;
  if (model) args.push("--model", model);
  const effort = sanitizeEffort(opts.effort);
  if (effort) args.push("--effort", effort);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  args.push("--append-system-prompt", buildSystemPrompt(vaultAccess));

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // OAuth only — never bill the API key.

  const t0 = Date.now();
  const child = spawn(CC_BIN, args, {
    cwd: opts.cwd || CC_WORKSPACE,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrTail: string[] = [];
  child.stderr.on("data", (d: Buffer) => {
    const s = d.toString();
    stderrTail.push(s);
    if (stderrTail.length > 40) stderrTail.shift();
  });

  child.stdin.write(opts.prompt);
  child.stdin.end();

  let sessionId: string | null = opts.sessionId ?? null;
  let resultText: string | null = null;
  let costUsd = 0;
  let numTurns = 0;
  let assistantTextEvents = 0;
  let settled = false;
  let killedBy: "timeout" | "cancelled" | null = null;

  const kill = (why: "timeout" | "cancelled") => {
    if (settled) return;
    killedBy = why;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 5_000).unref();
  };

  const timeoutTimer = setTimeout(() => kill("timeout"), opts.timeoutMs);
  const cancelTimer = setInterval(() => {
    void opts.isCancelled?.().then((c) => {
      if (c) kill("cancelled");
    });
  }, 5_000);

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      if (evt.type === "system" && evt.subtype === "init") {
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
        opts.onEvent({ type: "init", sessionId: sessionId ?? undefined });
      } else if (evt.type === "assistant") {
        const msg = evt.message as { content?: StreamBlock[] } | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "text" && block.text && block.text.trim()) {
            assistantTextEvents++;
            opts.onEvent({ type: "assistant_text", text: block.text });
          } else if (block.type === "tool_use") {
            opts.onEvent({
              type: "tool_call",
              toolUseId: block.id,
              toolName: block.name,
              toolInput: block.input,
            });
          }
        }
      } else if (evt.type === "user") {
        const msg = evt.message as { content?: StreamBlock[] } | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "tool_result") {
            opts.onEvent({
              type: "tool_result",
              toolUseId: block.tool_use_id,
              text: blockContentToText(block.content),
              isError: block.is_error === true,
            });
          }
        }
      } else if (evt.type === "result") {
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
        if (typeof evt.result === "string") resultText = evt.result;
        if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
        if (typeof evt.num_turns === "number") numTurns = evt.num_turns;
        if (evt.is_error === true && typeof evt.result === "string") {
          // surfaced below via exit handling — remember the error text
          resultText = evt.result;
        }
      }
    } catch (e) {
      console.error("[cc-runner] onEvent handler threw:", e);
    }
  });

  return new Promise<CcResult>((resolve, reject) => {
    child.on("error", (e) => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(cancelTimer);
      reject(new Error(`failed to spawn ${CC_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(cancelTimer);
      const stderr = stderrTail.join("").trim().slice(-2_000);

      if (killedBy === "timeout") {
        reject(new Error(`claude-code timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (killedBy === "cancelled") {
        reject(new Error("claude-code run cancelled"));
        return;
      }
      if (code !== 0 || resultText === null) {
        const detail = resultText ?? stderr ?? "no output";
        // Session resume misses show up as an immediate non-zero exit
        // mentioning the session — let the caller retry fresh explicitly.
        if (
          opts.sessionId &&
          /no conversation|session|resume/i.test(detail) &&
          Date.now() - t0 < 20_000
        ) {
          reject(new CcResumeError(`resume ${opts.sessionId} failed: ${detail}`));
          return;
        }
        reject(new Error(`claude-code exit ${code}: ${detail}`));
        return;
      }
      resolve({
        text: resultText,
        sessionId,
        costUsd,
        durationMs: Date.now() - t0,
        numTurns,
        assistantTextEvents,
      });
    });
  });
}
