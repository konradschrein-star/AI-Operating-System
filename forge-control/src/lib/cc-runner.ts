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
 *
 * Accounts (2026-08-02): the caller passes `configDir`, which becomes
 * CLAUDE_CONFIG_DIR on the child — the ONLY mechanism that selects which
 * Claude identity a run uses. One directory holds exactly one identity.
 * Previously this was omitted entirely and every run silently inherited
 * whatever /root/.claude happened to contain; when that credential was zeroed
 * on 2026-08-02 the whole OS stopped with no diagnosis of which account had
 * failed or why. See docs/superpowers/specs/2026-08-02-claude-account-health-
 * failover-design.md.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CC_BIN = process.env.CC_BIN ?? "claude";
const CC_WORKSPACE = process.env.CC_WORKSPACE ?? "/opt/ai-os/workspace";
// Default model for runs: Opus 5, the workhorse (v2.6). Always an exact id,
// never the 'opus' alias — the alias drifts with CLI releases. Opus 4.8 stays
// selectable per-run. Per-run override via runs.metadata.model
// ("haiku" for cheap/frequent heartbeats). Subagents (.claude/agents/*.md)
// carry their own model in frontmatter, independent of this default.
const CC_MODEL = process.env.CC_MODEL ?? "claude-opus-5";
/** The ONLY true wall-clock stop for a single engine run. `timeoutMs` is an
 *  idle budget (see runClaudeCode), so this is what finally ends a genuinely
 *  runaway loop — sized for long autonomous builds, not chat turns.
 *  4h default; override with RUN_MAX_WALL_MS. */
const MAX_WALL_MS = Number(
  process.env.RUN_MAX_WALL_MS ?? String(4 * 60 * 60_000),
);
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

/** The shape `GET /api/uploads/:id/:name` accepts — `src/routes/uploads.ts`
 *  gates the id on exactly this and 400s anything else. */
export const UPLOADS_RUN_ID_RE = /^[a-f0-9]{12}$/;

/** The run id a child process gets as `FORGE_RUN_ID`, and with it the whole
 *  screenshot convention (`/opt/ai-os/uploads/<run_id>/<stamp>-<label>.png`,
 *  served at `/api/uploads/<run_id>/<name>`).
 *
 *  It is the run UUID's first 12 hex characters, NOT the UUID itself, and that
 *  is deliberate: the uploads route accepts `/^[a-f0-9]{12}$/` and nothing
 *  else, so handing a child its raw UUID would produce screenshots on disk
 *  whose URLs 400 forever — `docs/tools/research-browser.md` §5.1 calls a
 *  UUID-shaped run id "the realistic case" and reports `url_servable: false`
 *  for it. The tools refuse to mangle an id they were given; deciding the
 *  servable form is the producer's job, and this is the producer. The prefix
 *  is also what every executor log line already prints (`run ece63bdb…`), so
 *  a screenshot directory stays greppable back to its run. The full UUID is
 *  still exported alongside it as `FORGE_RUN_UUID` for anything that talks to
 *  the API about the run itself.
 *
 *  Throws rather than degrading: a run id too short to yield 12 hex characters
 *  is not a run id this system produces (`runs.id` is a `uuid` primary key),
 *  and silently substituting a sentinel would scatter screenshots into a
 *  directory that belongs to no run. */
export function uploadsRunId(runId: string): string {
  const hex = runId.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (hex.length < 12) {
    throw new Error(
      `[cc-runner] cannot derive an uploads-servable run id from ${JSON.stringify(runId)}: ` +
        `it yields only ${hex.length} hex characters, and /api/uploads requires 12 ` +
        `(expected a runs.id UUID)`,
    );
  }
  return hex.slice(0, 12);
}

/** v2.5: the system prompt is built per-run instead of a single static
 *  const — most of it is unconditional, but the vault/knowledge block only
 *  applies when this run actually has vault access (--add-dir + Read/Grep
 *  scoped to it). Ticker-spawned roles that don't need Konrad's whole
 *  knowledge base (planner/scout/builder/reviewer today) skip it entirely —
 *  it was previously force-fed to every run regardless of relevance, pure
 *  wasted context for scoped roles. See docs/superpowers/specs/2026-07-11-
 *  manager-orchestration-model-tiering-design.md.
 *
 *  r950: the `forge:ui` section. Round 808 shipped the renderer and validator
 *  (forge-control-web/app/desktop/chat/rich-blocks.ts) but put the format in no
 *  prompt, so the feature was unreachable — nothing emitted a control. The caps
 *  and character classes documented below are transcribed FIELD FOR FIELD from
 *  that validator's LIMITS/SECRET_NAME/BLOCK_ID, because a prompt that teaches a
 *  slightly-wrong shape does not fail quietly: the block renders in Konrad's
 *  chat as a visible "unreadable control block". If those caps ever move, this
 *  text moves with them.
 *
 *  ROUND 900 — the Screenshots bullet, closing operator-visibility phase 6's
 *  OPEN ITEM (docs/plan/artifacts/phase1350/browser-visibility.md §3) for the
 *  ONE population `project-tick.ts`'s SCREENSHOT_CONVENTION cannot reach: THIS
 *  function is the system prompt of every run spawned through runClaudeCode —
 *  manager/chat turns, the operator's own — not only project tasks, so it is
 *  where "the operator itself" (the doc's second uncovered population) gets
 *  the same instruction. `project-tick.ts` builds the USER prompt for a
 *  project task; this function is `--append-system-prompt` on EVERY spawn
 *  regardless (see runClaudeCode below), so a project task run receives BOTH —
 *  no conflict, since both name the identical directory. Unconditional, not
 *  gated on `vaultAccess`: a manager chat with no vault mounted can still open
 *  a real browser via the playwright MCP or research-browser.mjs.
 *
 *  ROUND 902 (fix cycle 1, review finding 1) — the bullet said "this chat
 *  renders every shot under that directory inline", which is not what
 *  `extractBrowserShots` does: it matches a `Read` of the path or a printed
 *  JSON `"url"` member, and nothing else, so the operator's own hand-saved shot
 *  rendered nowhere inline. The bullet now names the action (Read it back) and
 *  the honest fallback surface, verbatim in substance with
 *  `project-tick.ts`'s SCREENSHOT_CONVENTION — `cc-runner.test.ts` cross-checks
 *  the two prompts against each other so they cannot drift. MEASURED cost: the
 *  bullet 425 → 818 characters on EVERY spawn (this is
 *  `--append-system-prompt`, unconditional, so architect/planner/reviewer runs
 *  pay it too), taking `buildSystemPrompt(true)` from 8287 to 8680. +393
 *  characters ≈ +100 tokens, and it buys the one thing the round
 *  exists for: a manager-chat run has no role branching to condition on, so
 *  either every spawn carries a TRUE instruction or the operator's screenshots
 *  keep landing where nobody sees them. It does not touch the NF7 planner
 *  measurement, which reads `buildPrompt`'s user prompt only. */
export function buildSystemPrompt(vaultAccess: boolean): string {
  return `You are the executor of Konrad's Personal AI OS (forge-control), running headless on his Hetzner VPS. You are not a chatbot — you are an operator with real tools. Do the work; don't describe hypothetical work.

Environment you control:
${vaultAccess ? `- Obsidian vault (Konrad's second brain): ${VAULT_DIR} — read AND write markdown. Daily notes: Daily/YYYY-MM-DD.md (sections: ## Tasks, ## Notes, ## Journal). Quick captures: Inbox/. Never delete or truncate notes; append or create.\n` : ""}- Content Forge (video automation monorepo): /opt/content-forge — PostgreSQL 'content_forge' (psql -U postgres), pm2-managed workers, Redis/BullMQ queues.
- VPS2 (167.233.145.218, Hetzner, hostname ubuntu-16gb-nbg1-3-SK): second server Konrad is migrating projects onto — reach it via \`ssh -i /root/.ssh/vps2_mgmt root@167.233.145.218\`. Dedicated key, added 2026-08-02; not the content-forge-key or any VPS1 identity.
- forge-control API: http://127.0.0.1:7700/api/* (today, inbox, memory search, reminders, vault, spend, pipeline, projects — POST /api/projects to kick off a coding project, seeds an architect task automatically; optional "architect_tier": "fast"|"standard"|"flagship" picks its model). When the project comes out of a chat you are having with Konrad, pass your own run id — the \`$FORGE_RUN_UUID\` environment variable, exported into every run — as "origin_chat_id" in the POST body, so the project's workers can report findings back into that chat.
- Reminders: POST http://127.0.0.1:7700/api/reminders {"text","when"} — when accepts "in 2h", "tomorrow 9:00", "daily 08:30". Max 500 chars; longer text is rejected with 400, split it into several reminders.

What earlier workers already learned — READ THIS BEFORE YOU START:
- /root/.claude/projects/-opt-forge-ai-os/memory/ holds short notes written by previous runs on THIS repo: gate gotchas, install traps, harnesses that lie, endpoints that 404. Read MEMORY.md there (a one-line index per note), then read the two or three notes that touch your task. Measured: 73% of runs never open it and re-derive what is already written down, and orientation is half of all builder shell work.
- When YOU learn something durable — a command that silently does the wrong thing, a check that cannot fail, a path that moved — add a note there and a one-line pointer to MEMORY.md. One file, one fact, kebab-case name. This is how the next worker starts where you finished instead of where you began.

Your arms and hands:
- Skills (Skill tool): a global library — hermes skills, taste/design skills, remotion motion graphics, playwright browser automation, ui-ux-pro-max, superpowers workflows, tuning skills. If a skill plausibly matches the task, invoke it before improvising.
- MCP servers: github (Konrad's account), context7 (library docs — use for ANY framework/API question instead of guessing), playwright + chrome-devtools (real browser), postgres, filesystem, obsidian, forge-memory (Konrad's knowledge graph), shadcn (UI registry), reelforge (video production factory — create_video/add_topics/list_topics/get_system_health/etc; prefer add_topics with a batch of briefs over one-off create_video calls, it self-promotes the backlog into jobs).
- Subagents (Task tool): architect (opus — system design), planner (sonnet — break down goals), builder (sonnet — implement), reviewer (sonnet — adversarial check), scout (haiku — fast recon). Delegate instead of doing everything in one context; pick the agent whose model tier matches the difficulty.
- Attachments: user messages may contain an [attached-files] block listing absolute paths on this machine (images included) — Read them; do not claim you cannot see attachments.
- Screenshots: whatever you use to drive a browser — the playwright/chrome-devtools MCP, the playwright-skill, or scripts/research-browser.mjs (does this itself) — save the shot to /opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png, never /tmp. FORGE_RUN_ID is already in your environment; <stamp> is compact UTC ISO-8601 (e.g. 20260818T093000Z) and <label> is lowercase [a-z0-9-]. Then READ THE FILE BACK with the Read tool: this chat renders a shot inline when the transcript shows a Read of its path, or a printed JSON "url": "/api/uploads/<id>/<name>" member (research-browser.mjs emits that itself and needs no Read). A shot only written is not inline — it reaches Konrad through the run's camera indicator in the Team and Live panels. One saved anywhere else is invisible to Konrad and gone at the next reboot.
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

Interactive controls in the desktop chat (\`forge:ui\`):
- Konrad's desktop chat renders a fenced \`forge:ui\` block as REAL controls. Clicking an option WRITES INTO HIS COMPOSER and sends nothing — he still reads it and presses Enter. Emit the fence at the top level of your answer; a \`forge:ui\` fence nested inside another code fence is treated as prose (that is how this documentation quotes itself).
- WHEN to use one. A choice: when Konrad faces a decision with a small set of concrete options — exactly what you would otherwise write as a prose list ending in "say the word". A secret: instead of EVER asking for a credential, token or password in prose. Do not decorate ordinary answers with controls, never put more than a handful of options in one block, and do not emit a block on a Telegram turn — that surface has no renderer.
- The shape below is exact and validated against a closed schema. Anything that fails — a stray field is fine, but bad JSON, an unknown kind, an oversize string — renders in his chat as a visible "unreadable control block" with the reason, which is worse than the prose you replaced. Only two kinds exist: \`choice\` and \`secret\`.

Choice — \`kind\` and \`options\` required; \`id\`, \`prompt\`, \`multiple\` optional:
\`\`\`forge:ui
{"kind":"choice","prompt":"Which host should take the migration?","options":[
  {"value":"vps1","label":"VPS1","hint":"65.108.6.149 — current"},
  {"value":"vps2","label":"VPS2","hint":"167.233.145.218 — 16 GB, idle"}]}
\`\`\`
  \`options\`: 1–12 entries, each a bare string or an object. \`value\` (required) is what lands in the composer, max 400 chars; \`label\` max 80, defaults to \`value\`; \`hint\` max 160, one line of context. \`prompt\` max 400. \`"multiple":true\` lets him pick several, appending each. \`id\` max 64, characters [A-Za-z0-9._:-] only.

Secret — \`name\` required, \`why\` optional:
\`\`\`forge:ui
{"kind":"secret","name":"OPENAI_API_KEY","why":"needed to run the batch re-tag"}
\`\`\`
  \`name\` max 64, characters [A-Za-z0-9._-] only. \`why\` max 400. The button opens the secure panel; the value travels through POST /api/secrets and NEVER enters the chat. So never ask him to paste a credential into the thread, and never echo one back.

Rules:
- Be decisive. Research with your tools instead of asking; only escalate when truly blocked (POST /api/inbox is read by Konrad).
- Destructive operations (rm -rf, DROP/TRUNCATE, force-push, pm2 delete, mass file deletes) require an explicit instruction in the CURRENT task — otherwise refuse and propose the safe alternative.
- Keep final answers tight: what you did, what you found, what needs Konrad. No filler.
- When you learn something durable about Konrad's systems or preferences, append it to the vault note "AI OS/Operator Log.md" (create if missing).`;
}

export interface CcTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CcEvent {
  type: "init" | "assistant_text" | "tool_call" | "tool_result";
  sessionId?: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
  /** Present on any event coming from a Task subagent — the parent
   *  Task tool_use_id that identifies the subagent. `null`/absent on
   *  the parent run's own events. */
  parentToolUseId?: string | null;
  /** On assistant events: the token usage the CLI attached to that
   *  message. Absent on tool_call/tool_result. */
  usage?: CcTokenUsage;
  /** On assistant events: the model that produced the message
   *  (subagent messages may differ from the run's declared model). */
  model?: string | null;
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

function numOr0(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

/** Extract the four token fields from a raw Anthropic usage object.
 *  Returned even when `src` is empty so callers can unconditionally sum. */
function pickUsage(src: unknown): CcTokenUsage {
  const s =
    src && typeof src === "object" ? (src as Record<string, unknown>) : {};
  return {
    input_tokens: numOr0(s.input_tokens),
    output_tokens: numOr0(s.output_tokens),
    cache_read_input_tokens: numOr0(s.cache_read_input_tokens),
    cache_creation_input_tokens: numOr0(s.cache_creation_input_tokens),
  };
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
  /** Claude account config dir → CLAUDE_CONFIG_DIR on the child. Selects the
   *  identity this run authenticates as. When omitted the child inherits the
   *  ambient config, which is the pre-2026-08-02 behaviour and should only
   *  happen for callers that genuinely have no registry (e.g. one-off scripts). */
  configDir?: string | null;
  /** The `runs.id` this turn belongs to. Exported to the child as
   *  FORGE_RUN_ID (uploads-servable 12-hex form, see uploadsRunId) and
   *  FORGE_RUN_UUID (verbatim). The research lane's screenshot convention
   *  hangs off the first one: scripts/research-browser.mjs, perplexity.mjs and
   *  gemini-qa.mjs all resolve their upload directory as `--run-id`, else
   *  $FORGE_RUN_ID, else an ad-hoc sentinel — without it every screenshot a
   *  run takes lands in the shared `deadbeefcafe` bucket and cannot be traced
   *  back to the run that took it. Omitted only by callers that genuinely have
   *  no run (one-off scripts). */
  runId?: string | null;
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
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  // Run identity for the child's own tools. Cleared when this call has no run
  // rather than inherited: a stale FORGE_RUN_ID from the parent environment
  // would file this run's screenshots under a different run's id, which is
  // worse than the tools' honest ad-hoc sentinel.
  if (opts.runId) {
    env.FORGE_RUN_ID = uploadsRunId(opts.runId);
    env.FORGE_RUN_UUID = opts.runId;
  } else {
    delete env.FORGE_RUN_ID;
    delete env.FORGE_RUN_UUID;
  }

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
  let killedBy: "timeout" | "cancelled" | "wall" | null = null;

  const kill = (why: "timeout" | "cancelled" | "wall") => {
    if (settled) return;
    killedBy = why;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 5_000).unref();
  };

  // `timeoutMs` is an IDLE budget, NOT a wall-clock guillotine.
  //
  // It used to be one fixed timer: a turn that had been streaming tool calls
  // for 599s was SIGTERM'd at 600s exactly like a hung one, and the user got
  // "Timed out after 600s. Use Resume." Long productive turns are the normal
  // case for an operator agent, so killing on total duration punished exactly
  // the work we want. Now ANY stream event resets the clock (see bumpIdle in
  // the line handler) and we only kill when the engine has genuinely gone
  // silent for the full window — which is what "stuck" actually means.
  // MAX_WALL_MS remains the one true wall-clock stop for a runaway loop.
  let timeoutTimer = setTimeout(() => kill("timeout"), opts.timeoutMs);
  const bumpIdle = () => {
    if (settled || killedBy) return;
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => kill("timeout"), opts.timeoutMs);
  };
  const wallTimer = setTimeout(() => kill("wall"), MAX_WALL_MS);
  const cancelTimer = setInterval(() => {
    void opts.isCancelled?.().then((c) => {
      if (c) kill("cancelled");
    });
  }, 5_000);

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    // Proof of life: the engine is working, so the idle clock restarts.
    bumpIdle();
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      // Task subagent events are stamped by the CLI with a top-level
      // parent_tool_use_id equal to the spawning Task tool_use_id. This
      // is the ONLY reliable way to attribute a stream event back to the
      // subagent that produced it (assistant blocks don't self-identify).
      const parentToolUseId =
        typeof evt.parent_tool_use_id === "string"
          ? evt.parent_tool_use_id
          : null;
      if (evt.type === "system" && evt.subtype === "init") {
        if (typeof evt.session_id === "string") sessionId = evt.session_id;
        opts.onEvent({ type: "init", sessionId: sessionId ?? undefined });
      } else if (evt.type === "assistant") {
        const msg = evt.message as
          | {
              content?: StreamBlock[];
              usage?: Record<string, unknown>;
              model?: string;
            }
          | undefined;
        const usage = pickUsage(msg?.usage);
        const model =
          typeof msg?.model === "string" && msg.model.trim() ? msg.model : null;
        for (const block of msg?.content ?? []) {
          if (block.type === "text" && block.text && block.text.trim()) {
            assistantTextEvents++;
            opts.onEvent({
              type: "assistant_text",
              text: block.text,
              parentToolUseId,
              usage,
              model,
            });
          } else if (block.type === "tool_use") {
            opts.onEvent({
              type: "tool_call",
              toolUseId: block.id,
              toolName: block.name,
              toolInput: block.input,
              parentToolUseId,
              usage,
              model,
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
              parentToolUseId,
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
      clearTimeout(wallTimer);
      clearInterval(cancelTimer);
      reject(new Error(`failed to spawn ${CC_BIN}: ${e.message}`));
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(wallTimer);
      clearInterval(cancelTimer);
      const stderr = stderrTail.join("").trim().slice(-2_000);

      if (killedBy === "timeout") {
        reject(
          new Error(
            `claude-code went idle for ${Math.round(opts.timeoutMs / 1000)}s ` +
              `(no output at all) after ${Math.round((Date.now() - t0) / 1000)}s of work`,
          ),
        );
        return;
      }
      if (killedBy === "wall") {
        reject(
          new Error(
            `claude-code hit the ${Math.round(MAX_WALL_MS / 60_000)}min absolute ceiling — raise RUN_MAX_WALL_MS if legitimate`,
          ),
        );
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
