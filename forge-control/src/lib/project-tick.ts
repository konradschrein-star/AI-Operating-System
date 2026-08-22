/**
 * Coding-project orchestrator tick — the "manager" from the multi-agent
 * design, implemented as deterministic code rather than another LLM layer
 * (cheaper, no telephone-game context loss, matches "DB owns state, queues
 * dispatch work"). Called from executor.ts's existing managerLoop() every
 * ~10s, same as managerTick()/reminderTick() — this is NOT a separate
 * process.
 *
 * Per tick:
 *   1. promote 'pending' tasks whose earlier rounds are all 'done' -> 'ready'
 *   2. claim 'ready' tasks with no run yet, spawn a `runs` row for each
 *      (role mission comes straight from agents/<role>.md — single source
 *      of truth shared with the Task-tool subagent definitions)
 *   3. reconcile 'running' tasks whose run has settled: done/failed, and
 *      for reviewer verdicts, spin up the next fix/re-review round or close
 *      the project out
 *
 * Global concurrency is NOT enforced here — every ready task eagerly gets a
 * `runs` row (status='queued'); the executor's own claim loop enforces the
 * agent.spawn_cap ceiling, so there's exactly one place that cap lives.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  promoteReadyTasks,
  claimReadyTasks,
  listSettledRunningTasks,
  roundIsComplete,
  createRunForTask,
  attachRun,
  setTaskStatus,
  markVerdictTaskDone,
  unsettledVerdictTasks,
  listVerdictRound,
  createFixChain,
  setProjectStatus,
  setProjectWorkspace,
  closeFinishedProjects,
  listTasksForProject,
  getProject,
  managerChatRunId,
  type ProjectTask,
  type Project,
  type SettledRunningTask,
  type TaskRole,
  type TaskStatus,
  type TaskTier,
} from "../db/projects.ts";
import {
  patchProjectMetadata,
  listGoalProgress,
} from "../db/projects.ts";
import {
  projectAcceptsWork,
  consolidateVerdictRound,
  verdictMemberSettled,
  isVerdictRole,
  noteGroupFailure,
  clearGroupFailures,
  VERDICT_ROLES,
  FIX_TASK_TITLE,
  RECHECK_TASK_TITLE,
  recheckBrief,
  groupKey,
  groupLabel,
  groupCompleteNotification,
  fixChainGraphFields,
  MAIN_WORKSTREAM,
  type VerdictInput,
  type VerdictRole,
} from "./project-reconcile.ts";
import {
  classifyUsageWall,
  parseResetAt,
  planUsageWallRetry,
  shouldAnnounceOutage,
  outageMessage,
  formatDelay,
  USAGE_WALL_NOTIFICATION_SOURCE,
} from "./usage-wall.ts";
import { projectSlug } from "./run-control-rules.ts";
import { provisionWorkstream, liveCheckoutPath } from "./workspace.ts";
import { getFleetState } from "../db/ai_os.ts";
import { sanitizeModel, sanitizeEffort } from "./cc-runner.ts";
import { requeueRunAfterUsageWall } from "../db/runs.ts";
import { queueNotification, lastNotificationAt } from "../db/notifications.ts";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "/root/.claude/agents";

/** The `agents/` directory committed in THIS checkout — resolved from the
 *  module's own URL (src/lib → src → forge-control → repo root), so it points
 *  at the deployed checkout the executor is running from, never at a project
 *  worktree. Second candidate after AGENTS_DIR, see roleFilePaths(). */
export const REPO_AGENTS_DIR = fileURLToPath(new URL("../../../agents", import.meta.url));

const MAX_FIX_CYCLES = 3;
let lastPauseLogAt = 0;

/** Consecutive consolidation failures per `${project_id}:${groupKey(task)}` —
 *  project, round AND workstream since R40 — and the count at which a stuck
 *  group is pushed to Konrad instead of spinning in the log. The workstream
 *  term is load-bearing here too: keyed without it, one wedged workstream's
 *  failures would accumulate on another workstream's behalf and escalate a
 *  group that is working fine.
 *
 *  Process-local on purpose: it is a retry heuristic, not state the DB
 *  should own, and a restart legitimately re-starts the count. Entries are
 *  deleted on the first success, so the map holds at most one key per
 *  currently-failing group. */
const groupFailures = new Map<string, number>();
const MAX_GROUP_FAILURES = 3;

/** Model/effort per tier — only architect and builder tasks are ever
 *  assigned one (see docs/superpowers/specs/2026-07-11-manager-orchestration-
 *  model-tiering-design.md). Overrides the role file's static model:/effort:
 *  when a task carries a tier. */
/** Re-pinned 2026-08-05 (Konrad): "standard should be Opus 5; Sonnet stays
 *  for junior-engineer work like tests and boilerplate." Both fable-5 and
 *  sonnet-5 verified live via `claude --model X -p` before pinning. */
const TIER_MODELS: Record<TaskTier, { model: string; effort: string }> = {
  fast: { model: "claude-haiku-4-5-20251001", effort: "medium" },
  junior: { model: "claude-sonnet-5", effort: "high" },
  standard: { model: "claude-opus-5", effort: "high" },
  flagship: { model: "claude-fable-5", effort: "high" },
  /* A different engine, not a cheaper Claude. `effort` is carried for shape
   * only — agy takes no --effort flag, and gemini-runner never passes one; the
   * "-high" suffix in the model id IS the thinking level. */
  gemini: { model: "gemini-3.7-flash-high", effort: "high" },
};

export interface RoleConfig {
  mission: string;
  tools: string[] | null;
  model: string | null;
  effort: string | null;
}

const roleConfigCache = new Map<TaskRole, RoleConfig>();

/** A role file whose frontmatter is present but unparseable. Its own class so
 *  the caller can distinguish "misconfigured definition" from a genuine I/O
 *  failure, and so tests can assert on it rather than on message text. */
export class RoleFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleFileParseError";
  }
}

/** A role file's frontmatter delimiters, CRLF-tolerant. A UTF-8 BOM is
 *  stripped before this runs rather than matched here, so it cannot leak into
 *  the mission body of a file that has no frontmatter at all. Both a BOM and
 *  CRLF endings are things an editor introduces with no visible change to the
 *  file, which is precisely why they must not change behaviour. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
/** Does this file even CLAIM to have frontmatter? Answered separately from
 *  FRONTMATTER_RE so "no frontmatter at all" (legitimate — a plain mission
 *  file) can be told apart from "opens a frontmatter block and never closes
 *  it" (a truncated or corrupted definition). */
const CLAIMS_FRONTMATTER_RE = /^---\r?\n/;

/** Parse an agents/<role>.md file's raw text into mission body (frontmatter
 *  stripped) and the `tools:`/`model:`/`effort:` fields from the frontmatter.
 *  Pure — no I/O, no cache — so it can be tested directly against the real
 *  agent definition files instead of a hand-copied fixture string.
 *
 *  THROWS on a file that opens a frontmatter block it never closes, because
 *  the silent alternative escalates privileges. `tools: null` means "no
 *  allowlist in the definition", and cc-runner.ts reads that as "fall back to
 *  CC_ALLOWED_TOOLS" — the full set, Write and Edit and Task and Skill
 *  included. agents/reviewer.md deliberately omits Write/Edit so a reviewer
 *  can only report findings, never silently fix them; degrading its
 *  unparseable header to `tools: null` would hand it write access to the
 *  diff it is judging, with the raw frontmatter pasted into its mission, no
 *  warning, and cached for the rest of the process's life. An unparseable
 *  header is a misconfiguration, exactly like the unreadable file
 *  readRoleFile() already throws on. */
export function parseRoleFile(raw: string): RoleConfig {
  // "\uFEFF" spelled as an escape on purpose: a literal BOM here would be an
  // invisible character in the source, and the next editor to touch this file
  // could delete it without anyone seeing the diff.
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const fmMatch = FRONTMATTER_RE.exec(text);
  if (!fmMatch && CLAIMS_FRONTMATTER_RE.test(text)) {
    throw new RoleFileParseError(
      `role file opens a '---' frontmatter block that is never closed by a '---' line — ` +
        `refusing to fall back to the default tool allowlist (first 80 chars: ` +
        `${JSON.stringify(text.slice(0, 80))})`,
    );
  }
  const frontmatter = fmMatch?.[1] ?? "";
  const mission = (fmMatch?.[2] ?? text).trim();
  // \r?$ on every field: with CRLF endings `.+` would otherwise swallow the
  // carriage return into the value, producing tools like "WebFetch\r" and a
  // model string sanitizeModel() would reject.
  const toolsLine = /^tools:\s*(.+?)\r?$/m.exec(frontmatter)?.[1];
  const tools = toolsLine
    ? toolsLine.split(",").map((t) => t.trim()).filter(Boolean)
    : null;
  const model = sanitizeModel(/^model:\s*(.+?)\r?$/m.exec(frontmatter)?.[1]);
  const effort = sanitizeEffort(/^effort:\s*(.+?)\r?$/m.exec(frontmatter)?.[1]);
  return { mission, tools, model, effort };
}

/** Ordered candidate paths for a role's definition file.
 *
 *  1. `${AGENTS_DIR}/<role>.md` — the shared fleet directory, also read by the
 *     Task-tool subagent system. Wins when present, so a hand-installed or
 *     hot-patched definition still overrides the committed one.
 *  2. `${REPO_AGENTS_DIR}/<role>.md` — the copy committed in this repo.
 *
 *  Candidate 2 exists because AGENTS_DIR lives under /root/.claude, which the
 *  agent harness guards as a sensitive path: the engine's own agents
 *  structurally cannot install a new role file there, so before this fallback
 *  every new role needed a human `cp` (see docs/plan/evidence/p3-smoke.md —
 *  three rounds spent proving exactly that). A role file committed to
 *  `agents/` is now self-installing: it resolves on the next executor restart
 *  with no human in the loop. */
export function roleFilePaths(role: TaskRole): string[] {
  return [`${AGENTS_DIR}/${role}.md`, `${REPO_AGENTS_DIR}/${role}.md`];
}

/** First readable candidate for `role`, or null when the role has no
 *  definition anywhere. Only "not found" is swallowed — a file that exists but
 *  cannot be read (permissions, a directory in its place) is a
 *  misconfiguration that must not degrade silently into the bare fallback
 *  mission, so it throws with the offending path and errno. */
export function readRoleFile(role: TaskRole): { path: string; raw: string } | null {
  for (const path of roleFilePaths(role)) {
    try {
      return { path, raw: readFileSync(path, "utf8") };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new Error(
        `[project-tick] role file ${path} exists but is unreadable (${code ?? "unknown errno"})`,
        { cause: err },
      );
    }
  }
  return null;
}

/** Roles already warned about, so the bare-fallback warning is logged once per
 *  role rather than once per spawn (the fallback is deliberately not cached). */
const warnedMissingRoles = new Set<TaskRole>();

/** Read an agents/<role>.md file — the SAME file the Task-tool subagent
 *  system reads — and split it into the mission body (frontmatter stripped)
 *  and the `tools:` allowlist from the frontmatter. Single source of truth:
 *  editing agents/reviewer.md's tools line (e.g. dropping Write/Edit so it
 *  can only report findings, never silently fix them) changes both what the
 *  Task-tool subagent can do AND what a top-level project-run for that role
 *  can do. Resolved definitions are cached — restart forge-executor after
 *  editing one of these files.
 *
 *  The bare fallback is deliberately NOT cached: caching it would pin a role to
 *  a mission-less prompt for the rest of the process's life just because one
 *  task happened to run before its definition was installed, and recovering
 *  from that needs an executor restart — the exact restart this project is
 *  forbidden to perform. Re-reading two paths on a cache miss costs two failed
 *  stats per run spawn, which is nothing next to spawning a `claude` child. */
function roleConfig(role: TaskRole): RoleConfig {
  const cached = roleConfigCache.get(role);
  if (cached) return cached;
  const found = readRoleFile(role);
  if (!found) {
    if (!warnedMissingRoles.has(role)) {
      warnedMissingRoles.add(role);
      console.warn(
        `[project-tick] no agent definition for role ${role} in any of ` +
          `[${roleFilePaths(role).join(", ")}], using a bare fallback`,
      );
    }
    return {
      mission: `You are the ${role} for this coding project.`,
      tools: null,
      model: null,
      effort: null,
    };
  }
  const cfg = parseRoleFile(found.raw);
  roleConfigCache.set(role, cfg);
  return cfg;
}

function isGoalMode(project: Project): boolean {
  return (project.metadata as { mode?: string } | null)?.mode === "goal";
}

/** R53 — the shipped fan-out example, in the graph vocabulary.
 *
 *  It OMITS `round`. The route computes one from `depends_on` when the field is
 *  absent, and a template that renders an unset shell variable into
 *  `"round": ""` is refused outright (round 214 finding 1's type clause in
 *  `routes/projects.ts`'s round guard) — which is the safe end of the failure
 *  the old example invited, a task landing at round 0 with its dependencies at
 *  300. The architect branch is the one caller that adds the field back, for
 *  R51's phase label.
 *
 *  It CAPTURES THE ID, because a fan-out is unusable without it: the created
 *  task's id is at `.task.id` on the 201 and on the 409 a repeat answers alike,
 *  so this one line is correct whether the curl is the first attempt or a retry
 *  (R50). `jq` is present at /usr/bin/jq on every host this fleet spawns on —
 *  verified round 239 with `command -v jq`; a python3 fallback would cost the
 *  prompt budget (NF7) a line that no host here needs. */
function taskCurl(projectId: string): string {
  return (
    `ID=$(curl -sX POST http://127.0.0.1:7700/api/projects/${projectId}/tasks -H 'content-type: application/json' ` +
    `-d '{"role":"builder","title":"...","brief":"...","tier":"standard","depends_on":["<id a curl returned>"],` +
    `"workstream":"main","write_set":["src/lib/thing.ts","src/lib/thing.test.ts"]}' | jq -r .task.id)`
  );
}

const TIER_GUIDE =
  `Each task's "tier" picks its model. SET ONE ON EVERY TASK — omitting it means Opus, and 510 of this ` +
  `fleet's last 574 sessions ran Opus. "fast" (Haiku): trivial mechanical work. "junior" (Sonnet) is THE ` +
  `DEFAULT — tests, boilerplate, docs, evidence, and ALL re-checks. "standard" (Opus): implementation needing ` +
  `judgement, and the one gating review of a phase touching product code. "flagship" (Fable): genuinely hard ` +
  `design only. If you cannot say why a task needs Opus, it does not.`;

/** Konrad, 2026-08-19, after a 5-hour usage window went to 82% on work he
 *  described as "simple stuff": "we shouldn't instruct the reviewers to have to
 *  find issues because if there are no issues then there are no issues", and
 *  "review only code, never docs or evidence".
 *
 *  This is a real correction to how this engine was built, not a cost dodge. A
 *  reviewer told to attack WILL return findings — that is what the instruction
 *  asks for — and each one costs a fix cycle plus a re-check, which measured at
 *  25% and 6% of all token spend respectively. Reviews that find real defects
 *  have paid for themselves here repeatedly (a panel that lied about a
 *  connection, a write path that destroyed notes, three false module-wide
 *  claims). Reviews that manufacture findings to look diligent cost two extra
 *  sessions and teach the fleet that PASS is a failure state. */
const REVIEW_ECONOMY =
  `REVIEW ONLY WHAT CAN BREAK — product code, schemas, live endpoints, security paths. Never seed a reviewer ` +
  `for documentation, evidence, plans or reports. PASS IS THE EXPECTED OUTCOME OF GOOD WORK: never brief a ` +
  `reviewer to "attack" or "find problems" — one told to find issues will find them, and each buys a fix ` +
  `cycle plus a re-check (31% of all tokens). Brief it to check the stated claims and report what it finds. ` +
  `A RE-CHECK IS NOT A REVIEW: give it the numbered blockers and the tip sha, tier "junior", and say it must ` +
  `not re-derive the phase or rebuild what is already proven.`;

/** R50 — the idempotency contract, restated for a computed round.
 *
 *  Identity is STILL `(project, round, role, title)` (migration 0035's unique
 *  index), and the round in that tuple is now the one `computeRound()` derives.
 *  Stating both halves is the point: a planner that believed a computed round
 *  might come out differently on the second attempt would stop retrying and
 *  either lose a task or create a duplicate under a new title. It cannot —
 *  `depends_on` is immutable after insert (R29), so the same body computes the
 *  same round and hits the same unique index.
 *
 *  Exported, like `GRAPH_GUIDE` below, so R50's gate asserts the PROMPT contains
 *  the constant's own output instead of a hand-copied substring that could
 *  silently desync from it — this file's header states that convention. */
export const IDEMPOTENCY_NOTE =
  `A task's identity is (project, round, role, title), so titles must be distinct within one round and role. ` +
  `Round is now COMPUTED from depends_on, and the same depends_on always computes the same round, so an ` +
  `identical repeated curl still answers 409 with the task that already exists instead of creating a second ` +
  `one — re-issuing a call you are not sure landed is safe, the 409 body carries the original task at ` +
  `.task.id, and it can never fan out duplicate agents into the same worktree.`;

/** R47/R48/R38 — the scheduling vocabulary, and the replacement for the round
 *  guide retired here in the commit that names R49.
 *
 *  Its predecessor told a planner to put anything that might collide into later
 *  rounds one after another, which under the graph is not merely stale but
 *  actively wrong: ordering is `depends_on`, contention is `write_set`, and a
 *  round is a derived label that neither of them reads. A planner following the
 *  old text would serialise by hand the very tasks this engine exists to run at
 *  once. Neither the retired identifier nor its wording survives anywhere in
 *  this file — INCLUDING IN THIS COMMENT, which is why the sentence above
 *  paraphrases rather than quotes it. R49's gate greps the source, and a
 *  doc-comment is source; it caught this comment quoting the retired phrase on
 *  the first run (`project-tick.test.ts`, "R49 the retired round guide").
 *
 *  ROUND 242 (fix cycle 1, finding 3) names the two research role literals in
 *  the fan-out sentence. Every other construct the guide asks for could be
 *  written from the guide alone — `builder` is in the curl, `reviewer` is in the
 *  join sentence — but the research fan-out, the cheapest parallelism the guide
 *  sells hardest, was the one that required inventing a role string and
 *  recovering from the 400 that enumerates `ROLES`. It costs 26 characters —
 *  MEASURED through the maximal planner path, 12095 -> 12121, not counted off
 *  the literal — and it is carried as its own row in NF7's round ledger.
 *
 *  Those two numbers were written 12061 -> 12087 when round 242 added this
 *  paragraph, which is the same 26 measured in the frame NF7 has since left: the
 *  fixture's project id was "p1" then and is a uuid now, and `taskCurl()`
 *  renders it once, so every NF7 pin moved +34 while every delta stayed put.
 *  Restated at round 244 in the frame the ledger and the cap are actually
 *  written in, so the two cannot be compared across a change of units.
 *
 *  Interpolated by the goal-mode architect branch, the NON-goal architect branch
 *  (round 242 finding 1) and the planner branch — the three roles that create
 *  tasks. It is as dense as it is because NF7 budgets the planner prompt: the
 *  reasoning lives in doc-comments, which cost the prompt nothing, and only the
 *  rules a planner must act on are in the string.
 *
 *  ROUND 900 adds one sentence to the "write_set" bullet — round 244's own
 *  follow-up finding, re-routed here because round 242 already had a
 *  concurrent writer to this file. Round 244's root cause, verbatim: round
 *  242's write_set was two code files, the two documents quoting its moved
 *  constants were owned by nobody, so the constants moved and the corpus did
 *  not — and three consecutive reviews read the stale numbers as fresh,
 *  because a stale pin looks exactly like a live one. Round 244's own
 *  follow-up diagnosed WHY: the prompt asks for "every file it will write",
 *  and a planner reads that as source files. The fix therefore belongs at the
 *  definition of "write_set" itself, where a planner writing one meets it —
 *  not buried in the COMPANION FILES prose three paragraphs later, which is
 *  a record a planner may never open (the same failure round 244 diagnosed in
 *  its own evidence file). MEASURED at 106 characters through the maximal
 *  planner path against the round-244 baseline (12121, headroom 150) — see
 *  NF7's LEDGER below, row "round 900". */
export const GRAPH_GUIDE =
  `SCHEDULING IS A GRAPH, NOT A ROUND NUMBER. Every task you create declares three fields and never a round:\n` +
  `- "depends_on": ids of the tasks it waits for, as your earlier curls returned them ([] = starts at once). ` +
  `A task is ready when every id in it is done: that is the ONLY ordering. Its round is computed as 1 + the ` +
  `highest dependency round.\n` +
  `- "workstream": a name like "ui", matching /^[a-z0-9][a-z0-9-]{0,39}$/, default "main". One workstream is ` +
  `one git worktree whose tasks run one at a time; two are isolated directories that may write the SAME file ` +
  `at once. A project may hold at most PROJECT_MAX_WORKSTREAMS distinct ones (6 unless the host overrides ` +
  `it) and a task opening a new one past that is refused with a 400 naming the count — so open a second only ` +
  `when two teams truly need one file concurrently.\n` +
  `- "write_set": every repo-relative path the task writes (max 200) — the contention input. No two builders ` +
  `in ONE workstream may declare the same file; where a split is impossible, one builder writes that file ` +
  `twice rather than two builders serialising on it. If a round moves a constant the corpus quotes, the ` +
  `documents quoting it belong in that round's write_set.\n` +
  `FAN-OUT: RESEARCH wide and early — independent questions share no files and have no ordering, the ` +
  `cheapest parallelism there is — one "researcher" (or "scout") task each, depends_on []. ` +
  `BUILDERS by FILE OWNERSHIP, one write_set ` +
  `each. REVIEWERS are a genuine join: one reviewer depending on EVERY builder of its group.\n` +
  `INTEGRATION, NEVER AUTO-MERGE: every workstream but "main" ends in an integration task (role builder, ` +
  `workstream "main") depending on every task of that workstream, carrying the union of their write_sets, ` +
  `that merges its branch back and on conflict STOPS and reports the conflicting files verbatim, unresolved ` +
  `— plus a reviewer depending on it. Auto-merge resolves in favour of whoever finishes last: silent ` +
  `clobbering in a new costume.`;

/** R12 — the worktree-only rule, appended to EVERY role prompt on a
 *  repo-backed project. Bug 3 of the first night: fleet agents edited the live
 *  checkout during build phases so reviewers could curl real endpoints, which
 *  hot-applied half-finished code into the running services. The policy is
 *  generated here rather than written into agents/<role>.md because those role
 *  files are shared with the interactive Task-tool subagents, which legitimately
 *  work on live checkouts when Konrad asks. */
export function WORKTREE_POLICY(liveCheckout: string): string {
  return (
    `WORKTREE-ONLY POLICY (non-negotiable):\n` +
    `- The live checkout for this repo is ${liveCheckout}. During build phases you work ONLY in this ` +
    `worktree — the directory you are already in. ${liveCheckout} must NEVER be edited, patched, or ` +
    `"just quickly fixed" during a build phase, no matter how convenient it would be for testing.\n` +
    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
    `Restarting the executor is the deploy phase's job and it has a detached procedure for it.\n` +
    `- Verification against LIVE endpoints, live services, or the live database happens ONLY inside an ` +
    `explicitly-briefed deploy/verify task — never ad hoc from a build task. If your brief does not say ` +
    `"deploy" or "verify against live", you have no business touching ${liveCheckout}.\n` +
    `- Need to prove something works? Run it out of the worktree (tsx, unit tests, a throwaway port). ` +
    `If that is genuinely impossible, say so in your final message and let the deploy/verify task do it.`
  );
}

/** B1 (round 101's incident, delivered round 240) — the dep-install trap, in the
 *  funnel rather than in a brief.
 *
 *  THE INCIDENT. `cc-runner` exports NODE_ENV=production into every run, so
 *  `pnpm install --frozen-lockfile` skips devDependencies, prints
 *  "devDependencies: skipped because NODE_ENV is set to production" and EXITS 0.
 *  `tsx` and `typescript` are devDependencies of forge-control, so the universal
 *  typecheck gate then dies with `tsc: not found` while the install that caused
 *  it looks like a success. A silent-success install that leaves the gate
 *  unrunnable is the exact failure class 00-vision.md §7 exists to catch. Round
 *  101 verified the correct form; a worse variant of the same root cause once
 *  had `pnpm add` prune `tsx` out of forge-control and brick the executor, which
 *  needs it to boot — hence "pnpm, never npm" is part of the rule, not a style
 *  note.
 *
 *  WHY THE FUNNEL. The operator's round-240 instruction is explicit that pasting
 *  this into individual briefs is how it got missed: it is a property of how the
 *  executor runs EVERY task of EVERY project, not of any one phase, and a role
 *  branch added at 3am must not be able to lose it — the same argument
 *  `withPolicy()`'s own comment makes for WORKTREE_POLICY.
 *
 *  WHY GATED ON `live`. One line, and it is the whole reason: a scratch project
 *  has no repo checkout to install into, so the instruction would name a package
 *  directory that does not exist.
 *
 *  BUDGET 500 characters, asserted on the constant in project-tick.test.ts. It
 *  rides in every prompt of every spawn on a repo-backed project and lands
 *  inside NF7's planner-prompt measurement, so it is priced, not free. */
export const DEP_INSTALL_NOTE =
  `DEPENDENCIES, BEFORE ANY GATE. Your runtime exports NODE_ENV=production, so ` +
  `\`pnpm install --frozen-lockfile\` SKIPS devDependencies — it says so quietly and EXITS 0, and your ` +
  `typecheck then dies with \`tsc: not found\` while the install looked clean. tsx and typescript ARE ` +
  `devDependencies. Always:\n` +
  `    cd <the package holding the lockfile> && pnpm install --frozen-lockfile --prod=false\n` +
  `pnpm, never npm — \`pnpm add\` under that pruning has removed tsx and bricked the executor.`;

/** R13 — reviewer-side enforcement of the above. A policy nobody checks is a
 *  suggestion; the reviewer is the only role that reliably looks at the whole
 *  round, so it owns the cleanliness gate. */
export function REVIEWER_LIVE_CHECK(liveCheckout: string): string {
  return (
    `LIVE-CHECKOUT CLEANLINESS CHECK (mandatory, run it before you write your verdict):\n` +
    `  git -C ${liveCheckout} status --porcelain\n` +
    `ANY output at all means someone hot-applied work into the live checkout instead of keeping it in the ` +
    `worktree. That is by itself a NEEDS_FIXES finding: name the dirty files verbatim in your numbered list ` +
    `and require them to be reverted there and redone in the worktree. Empty output is the only pass. ` +
    `Paste the command's output (or its emptiness) into your review — an unexecuted check is not a check.`
  );
}

/** B2 (round 1357's incident, delivered round 240) — the reviewer states the tip
 *  it reviewed, and re-reads HEAD before it blocks.
 *
 *  THE INCIDENT, and why neither half alone is enough. On operator-visibility a
 *  reviewer forked a CLEAN CHECKOUT at 8c5fcd0 — correct discipline: a sibling
 *  task had uncommitted work in the shared worktree and the reviewer refused to
 *  misattribute it — and wrote a blocker. Commit 1c0c23e landed while it read and
 *  had already fixed the thing it blocked on. Its verdict was true of the tree it
 *  read and false of the tree that existed. Note the trap: the CAREFUL act is
 *  what created the staleness, and the naive reviewer reading the live worktree
 *  would have been contaminated but current. So the prompt requires BOTH halves —
 *  state the tip, and re-confirm the expensive claim against HEAD.
 *
 *  ONLY THE BLOCKER IS RE-CHECKED, deliberately. Re-reviewing everything at
 *  HEAD would make a review unfinishable on a moving branch; a blocker is the
 *  claim that costs a whole round, so it is the one worth re-confirming.
 *
 *  THE GENERAL RULE IS IN THE PROMPT because this was the fourth artifact in one
 *  night that was true when produced and silently stopped describing the tree: a
 *  stale VERDICT.md that blocked a deploy, rotted line pins, a gate run
 *  invalidated by a later commit in its own round, and this review of a
 *  superseded tip. None of them read as stale; they read as authoritative.
 *
 *  Reviewer-scoped, not withPolicy(): the tester's claims are about a running
 *  product, not about a tree, and a builder states its tip by committing to it.
 *  BUDGET 1300 characters, asserted in project-tick.test.ts. */
export const REVIEWER_TIP_DISCIPLINE =
  `THE TIP YOU REVIEWED — state it, and re-read HEAD before you block:\n` +
  `- STATE THE EXACT SHA YOU REVIEWED in your verdict, always: run \`git rev-parse HEAD\` in the tree you ` +
  `actually read and quote it. A verdict without a tip is unfalsifiable — no later reader can tell whether ` +
  `it still applies.\n` +
  `- RE-READ HEAD IMMEDIATELY BEFORE WRITING A BLOCKER. If HEAD has moved past the tip you reviewed, say so ` +
  `and re-check THAT SPECIFIC blocker against HEAD — not the whole review, just the thing you are about to ` +
  `block on. A blocker is the expensive claim; it is the one worth re-confirming. This is not hypothetical: ` +
  `a reviewer forked a clean checkout (right call — a sibling's uncommitted work was in the shared ` +
  `worktree), and the commit that fixed its blocker landed while it read.\n` +
  `- THE GENERAL RULE: ANY CLAIM ABOUT THE TREE CARRIES THE TREE-STATE IT WAS MADE AGAINST — a sha, a ` +
  `timestamp, something a later reader can check. Verdicts, line pins and gate runs all stop describing the ` +
  `tree without changing a character, and none of them read as stale afterwards. They read as authoritative.`;

/** B3 (adopted by the operator after round 1875) — the gate suite runs before
 *  any PASS, not when someone remembers.
 *
 *  THE EVIDENCE, and why the prompt carries the why. The suite only ran when
 *  someone thought to run it, and that gap was hit twice on one project in one
 *  day: round 1356 found gate 8 already red at HEAD because a commit landed
 *  after its reviewer's gate run and nobody re-ran it, and round 1875 found the
 *  suite RED:2 at HEAD, introduced by two rounds that did not author the gate and
 *  unnoticed across three intervening rounds. A gate suite executed at the
 *  author's discretion measures DILIGENCE, NOT THE TREE.
 *
 *  THE TWO CONSTRAINTS learned there are in the prompt for a reason each. The
 *  EXECUTED count, because a gate that silently stops running is worse than one
 *  that fails and only a count exposes it — the same argument the corpus's own
 *  checkers make with their positive controls. The allowlist-scoping rule,
 *  because the cheapest way to turn a suite green is to widen it, and a gate
 *  loosened until it passes proves nothing while reading as safety.
 *
 *  SATISFIABILITY (00-vision.md §7 rule 2). This is the clause most likely to
 *  become an unsatisfiable gate: not every project ships a gate-suite script, and
 *  a reviewer left holding a gate it cannot discharge learns that
 *  disclose-and-proceed is normal — the habit 03-quality.md §4 records three
 *  rounds in a row practising. (Phrased that way deliberately: the obvious
 *  wording here is R49's retired text, G1 greps this file's source for it, and a
 *  doc-comment is source. G1 caught this comment on its first run at round 240,
 *  as it caught 5A's on its first run at round 239.) The rule carries both arms:
 *  run the suite if one ships, and if none ships SAY SO and run the quality
 *  document's own command block. There is no state in which it cannot be
 *  honoured, and the prompt says that out loud rather than leaving it inferable.
 *
 *  The `--strict` clause carries the same hedge, and it was found by READING THE
 *  BUILT PROMPT rather than by any assertion: `scripts/checks/gates-808.sh` in
 *  this repo takes `--strict`, but this constant ships to every project's
 *  reviewer, and one whose suite takes no such flag would be told to pass an
 *  argument its script rejects — leaving the reviewer to invent a step, which is
 *  the same seam by another route.
 *
 *  BUDGET 1250 characters, asserted in project-tick.test.ts. */
export const REVIEWER_GATE_SUITE =
  `THE GATE SUITE RUNS BEFORE ANY PASS, not when someone remembers. Before you emit VERDICT: PASS:\n` +
  `- IF THIS PROJECT SHIPS A GATE SUITE — look under scripts/checks/ for a gates-*.sh, or the suite named ` +
  `in its quality document — run it with \`--strict\`, or with its documented invocation if it takes no ` +
  `such flag, and say which you used. Paste its table into your review and report ` +
  `EXECUTED / RED / SKIPPED-by-design. A nonzero exit BLOCKS the PASS.\n` +
  `- IF IT SHIPS NONE, say exactly that in your verdict and run the quality document's own command block ` +
  `instead. Those are the only two options; neither is a disclose-and-proceed.\n` +
  `- REPORT THE NUMBER OF GATES EXECUTED, not just the red count. A gate that silently stops running is ` +
  `worse than one that fails.\n` +
  `- NEVER MAKE A GATE PASS BY WIDENING IT. Scope any allowlist entry to the exact offending SENTENCE — not ` +
  `the file, not a bare token — so a real violation elsewhere in the same file still fails.\n` +
  `A suite run at the author's discretion measures DILIGENCE, NOT THE TREE: one project was found red at ` +
  `HEAD twice in one day, once because a commit landed after its reviewer's gate run and nobody re-ran it.`;

/** R14 + R17 — deploy guidance for the goal-mode architect's plan. Bug 4 of the
 *  first night: this engine deploys itself, so a naive `pm2 restart
 *  forge-executor` during deploy kills the very fleet that is deploying. */
export const DEPLOY_GUIDE =
  `DEPLOY GUIDANCE (put this verbatim into the final deploy phase's brief):\n` +
  `- EXECUTOR-LOADED CODE. If the diff touches \`src/lib/project-tick.ts\`, \`src/lib/cc-runner.ts\`, ` +
  `\`src/executor.ts\`, \`src/db/*\` or the \`agents/*.md\` role files, the executor is holding the old ` +
  `code in memory and a plain restart would kill every run in flight — including the deploy task itself.\n` +
  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
  `- Instead, after merging, run exactly:\n` +
  `    setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &\n` +
  `  launch it DETACHED and END the task — never wait for it, never poll it, never tail the log until it ` +
  `finishes. The script waits for the fleet to go idle and restarts then; your task must return immediately.\n` +
  `- \`pm2 restart forge-control\` (the API side) remains allowed and is the right way to pick up route/API ` +
  `changes, since nothing long-running lives in that process.\n` +
  `- MERGE vs PR (R17): if the project brief says to open a PR instead of merging, run ` +
  `\`scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"\` and do NOT merge to main — the PR is the ` +
  `deliverable. Otherwise merge per the brief (merge main into the work branch first if main moved, re-run ` +
  `typecheck + tests in the worktree, then merge to main; on conflicts STOP and report the files).`;

/** R16 — push-on-PASS guidance. Deliberately prompt guidance rather than engine
 *  code: the engine has no opinion about which phases are worth publishing, and
 *  a deterministic push would fire on rounds that are mid-fix-cycle. */
export const GITHUB_PUSH_GUIDE =
  `GITHUB PUSH (phase completion):\n` +
  `- When a phase's gating reviewer issues VERDICT: PASS and the repo has an origin remote, run ` +
  `\`scripts/git-sync-branch.sh <worktree-dir>\` to push the work branch so the progress is visible on ` +
  `GitHub.\n` +
  `- Plain push only. NEVER force-push, never \`--force\`, never \`--force-with-lease\` — this branch is ` +
  `shared with whatever else is watching it.\n` +
  `- If the push fails (no origin, gh not authenticated, rejected), report the failure verbatim in your ` +
  `final message and move on. A push failure NEVER changes the verdict.`;

/** R703 — the browser research lane, named concretely for the researcher.
 *
 *  This text is prepended to EVERY researcher run, so it stays terse: three
 *  invocations that actually exist (quoted from the shipped `--help` of
 *  scripts/research-browser.mjs, perplexity.mjs and gemini-qa.mjs), the
 *  research-doc citation rule, and the one rule that keeps the lane safe — a
 *  login wall is Konrad's job, never the agent's. The old branch said only
 *  "use every research surface you have", which in practice meant WebFetch and
 *  nothing else: an agent does not discover a 78k-line CLI by hoping.
 *
 *  ROUND 900 — the on-disk screenshot DIRECTORY moved out of this block and
 *  into SCREENSHOT_CONVENTION below, delivered through `withPolicy()` to every
 *  role that can drive a browser, not hand-pasted into this one. Only the
 *  researcher-specific half stays here: citing the shot in the committed
 *  research doc, which no other role produces. See SCREENSHOT_CONVENTION's own
 *  comment for the incident this closes.
 *
 *  Lives here rather than in agents/researcher.md for the same reason as
 *  WORKTREE_POLICY: that file is shared with the interactive Task-tool
 *  researcher, whose invocation paths differ per repo. */
export const RESEARCH_INSTRUMENTS =
  `RESEARCH INSTRUMENTS — three shipped CLIs in this repo's scripts/ (outside an ai-os worktree: ` +
  `/opt/forge-ai-os/scripts/). Run one with --help before first use; research-browser and gemini-qa need ` +
  `no key on their default path, perplexity does:\n` +
  `- scripts/research-browser.mjs — a real Chrome with persistent logged-in profiles. ` +
  `\`open <profile> [--url URL] [--label L]\`, \`status <profile> --probe\`, \`close <profile>\`. ` +
  `Use the SHARED profile for a service (e.g. \`perplexity\`), never a per-run one — the login lives in it.\n` +
  `- scripts/perplexity.mjs — both \`ask "<question>"\` and \`search "<query>"\` default to the API backend ` +
  `and need PERPLEXITY_API_KEY (R776). \`ask --backend browser\` runs through the authenticated profile ` +
  `instead and returns the answer WITH its citations — that is the documented fallback and the only path ` +
  `for logged-in work, but perplexity.ai answers this host with HTTP 403 (Cloudflare edge block on our ` +
  `egress IP), so it cannot currently complete unattended. Exit 2 from either means the key is missing: ` +
  `say so and move on.\n` +
  `- scripts/gemini-qa.mjs — video QA: \`gemini-qa.mjs <local-video.mp4>\` on the local Gemini Pool ` +
  `(default backend, free, no key); \`--backend api\` is billed and needs GEMINI_API_KEY.\n` +
  `SCREENSHOTS: the tools above write theirs to your uploads directory themselves (see the screenshot ` +
  `convention elsewhere in this prompt) — cite each one in your research doc as its URL, ` +
  `/api/uploads/$FORGE_RUN_ID/<name>, so the Console renders it there too. An uncited browser session is an ` +
  `unverifiable claim.\n` +
  `LOGIN WALL = STOP. Exit 4 from research-browser or perplexity means a login is required: the tool has ` +
  `already screenshotted the wall, queued Konrad a reminder and left the browser up for him to log in ONCE ` +
  `by hand over noVNC. Report it, carry on with the sources you can reach, and NEVER attempt credentials — ` +
  `no passwords, no signup, no "try the free tier".`;

/** R870 — the browser as first resort, for the two roles that hit unknowns but
 *  do NOT get the full RESEARCH_INSTRUMENTS block (which belongs to the
 *  researcher alone, per T16). The escalation policy states the rule; this
 *  states the reflex at the point of work, because "drive a browser" reads as
 *  an abstract permission until a role is told what its own unknowns look like.
 *  Deliberately shorter than RESEARCH_INSTRUMENTS: scout is a Haiku role and
 *  builder's prompt is already long. */
export const BROWSER_FIRST =
  `BROWSER FIRST FOR UNKNOWNS. When a doc is missing, an API's behaviour is unclear, a page needs JS or a ` +
  `login, or a service exists only as a web app: open a real browser before you guess or ask. ` +
  `\`scripts/research-browser.mjs open scratch --url <URL> --label <what-you-are-checking>\` (read its ` +
  `\`--help\` first; from another repo's worktree: /opt/forge-ai-os/scripts/) drives real Chrome with ` +
  `persistent logged-in profiles, and the \`playwright-skill\` covers a one-off page needing scripted ` +
  `interaction if you hold the Skill tool. A login wall is the one thing you do NOT solve yourself — the ` +
  `tool screenshots it and queues Konrad; never attempt credentials. An unverified guess costs more than ` +
  `the five minutes of browsing you skipped.`;

/** Round 900 (operator-visibility phase 6's OPEN ITEM, docs/plan/artifacts/
 *  phase1350/browser-visibility.md §3, re-routed to this project because
 *  closing it means editing project-tick.ts/cc-runner.ts — engine internals
 *  this project owns this cycle) — the screenshot DIRECTORY convention,
 *  delivered to every role that can drive a browser instead of hand-pasted
 *  into one more branch.
 *
 *  THE GAP. operator-visibility phase 6 shipped the UI that renders a
 *  screenshot inline the moment it lands under
 *  `/opt/ai-os/uploads/$FORGE_RUN_ID/` — matched off the actual Bash
 *  tool_result / Read tool_call in the transcript, nothing markdown, nothing
 *  new to serve. But until this round ONLY `scripts/research-browser.mjs`
 *  (reached from the researcher's RESEARCH_INSTRUMENTS block) wrote there.
 *  Every other population — a builder or reviewer driving the
 *  `playwright-skill`, which writes its scripts and screenshots to `/tmp` by
 *  design, and the operator's own ad-hoc browser sessions — took shots nobody
 *  could ever see: `/tmp` is unreachable from the Console and
 *  garbage-collected before Konrad can look. The UI was not the missing
 *  half; the instruction was.
 *
 *  WHY THE FUNNEL, NOT ONE MORE BRANCH. Rides the SAME `drivesBrowser`
 *  predicate `withPolicy()` already computes for BROWSER_CONTROL_SAFETY (B4)
 *  — a role's prompt carries this constant iff its body already carries
 *  BROWSER_FIRST or RESEARCH_INSTRUMENTS. No second hand-written role list:
 *  the day a role gains a browser it gains this with it, which is the exact
 *  argument B4's own comment makes, applied to a second block riding the same
 *  gate. `project-tick.test.ts` asserts the two blocks reach the identical
 *  role set for that reason — a divergence there would mean one of them
 *  stopped being derived.
 *
 *  THE DIRECTORY IS NOT A NEW API. `/opt/ai-os/uploads/$FORGE_RUN_ID/` and
 *  `/api/uploads/$FORGE_RUN_ID/<name>` already exist (R703, `routes/uploads.ts`);
 *  this constant only tells more roles to use them. Scope holds the line
 *  operator-visibility drew: no change to how uploads are served, no change to
 *  `rehype-forge-allowlist.ts` (markdown images stay inert — a closed beacon
 *  hole).
 *
 *  ROUND 902 (fix cycle 1, review findings 1 and 3) — TWO CORRECTIONS, both
 *  about the promise this text makes rather than the directory it names.
 *
 *  (1) "The desktop chat renders every shot under that directory inline" was
 *  FALSE for exactly the populations this constant exists to serve.
 *  `extractBrowserShots` (forge-control-web/app/desktop/chat/browser-shots.ts)
 *  renders two payload shapes and no others: a `Read` tool_call whose
 *  `file_path` is under the directory, and a `Bash` tool_result carrying a JSON
 *  `"url": "/api/uploads/<12hex>/<name>"` MEMBER — which only
 *  `scripts/research-browser.mjs` prints, i.e. the one population already
 *  covered before round 900. A builder obeying the old text — the
 *  playwright-skill through Bash, or `mcp__playwright__browser_take_screenshot`
 *  — produced NO inline ref at all; its shot reached Konrad only through
 *  `RunShotsIndicator`'s camera on a Team/Live row, a click away on another
 *  surface. EXECUTED at round 902, six payload shapes against the shipped
 *  extractor imported by ABSOLUTE worktree path (an import from a stale tree
 *  throws rather than answering): Read of the saved path → 1 ref; a JSON
 *  `"url"` member → 1 ref; a BARE `/api/uploads/...` line echoed in a Bash
 *  result → 0 refs; the playwright MCP call → 0 refs; a `cp` into the directory
 *  printing nothing → 0 refs. Transcript in
 *  `docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md`.
 *  The text now names the ACTION that makes the promise true — read the file
 *  back — and states the fallback surface honestly. NOTE the bare-URL case:
 *  round 901's review offered "print its URL" as an equal alternative and,
 *  measured, it does not render; only the quoted `"url"` member does.
 *  Prescribing it would have rebuilt this very defect one round later.
 *
 *  (2) `<stamp>` was never defined. Until round 900 the only writers were tools
 *  that stamp themselves; this constant now tells builders, scouts and testers
 *  to save BY HAND. `parseShotName` — both copies, `uploads-index.ts` and
 *  `browser-shots.ts`, each keyed on `\d{8}T\d{6}Z` — yields `ts: null` for a
 *  name like `settings-dark.png`, which then sorts last in `newestFirst` and
 *  shows no clock in `shotClock` (case F of the same executed run). The format
 *  is stated here, matching what `agents/researcher.md` already documents.
 *
 *  MEASURED at 1056 characters (was 555 at round 900). Reaches only {builder,
 *  researcher, scout, tester} — the roles `drivesBrowser` already selects — so
 *  it costs the NF7 planner-prompt budget nothing: the planner branch carries
 *  neither BROWSER_FIRST nor RESEARCH_INSTRUMENTS, exactly as B4 costs it
 *  nothing today, and NF7's ledger assertion is EXACT rather than a bound, so
 *  that claim is checked rather than asserted. Own budget RAISED 650 → 1100 in
 *  this same commit, at the line that enforces it (`B5_BUDGETS` in
 *  project-tick.test.ts), with the reasoning written there: 650 cannot hold a
 *  TRUE statement of this rule, and a budget the correct text cannot satisfy is
 *  the unsatisfiable gate of standing rule 2 — not a licence to bloat. */
export const SCREENSHOT_CONVENTION =
  `SCREENSHOTS LAND WHERE KONRAD CAN SEE THEM. Whatever tool takes one — research-browser.mjs (does this ` +
  `itself), the playwright-skill, or an MCP browser — save it at ` +
  `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png, never /tmp. FORGE_RUN_ID is already in your ` +
  `environment; <stamp> is compact UTC ISO-8601 (e.g. 20260818T093000Z) and <label> is lowercase ` +
  `[a-z0-9-] — an unstamped name still serves, but it carries no clock and sorts last. THEN READ THE FILE ` +
  `BACK with the Read tool: the desktop chat renders a shot INLINE when the transcript shows a Read of its ` +
  `path, or a printed JSON "url": "/api/uploads/<id>/<name>" member (research-browser.mjs emits that ` +
  `itself and needs no Read). A shot only written is NOT inline — it reaches Konrad through the run's ` +
  `camera indicator in the Team and Live panels, one click away on another surface. One saved anywhere ` +
  `else (the playwright-skill's own default) is invisible to Konrad and gone at the next reboot — every ` +
  `Playwright verification screenshot this fleet took before this rule existed went exactly there.`;

/** B4 (round 1873's incident, 2026-08-17 14:08:58 UTC, delivered round 240) —
 *  the row under your cursor changes state between runs.
 *
 *  THE INCIDENT. A fleet builder's verification script drove the team panel's
 *  confirm control on the MANAGER row and CANCELLED THE OPERATOR'S OWN RUN.
 *  Between the script's two executions that chat went from settled to running, so
 *  the second click was no longer a dismissal but a TERMINATE
 *  (`capabilities.terminate` has been true since round 1353). The script had
 *  stubbed the dismissal endpoints but not the run-control ones. No lasting
 *  damage; the builder disclosed it at once and hardened its own script — which
 *  is exactly right, and exactly the problem: the guard then lived in one
 *  worker's script, and the next agent to write a browser test would not have it.
 *  That is what "put it in the funnel" means here.
 *
 *  THE GENERAL RULE, and why it is worth prompt budget: this is the THIRD variant
 *  of one failure. A capability flag flipped (terminate:true turned an X into a
 *  kill); a store widened scope (per-chat localStorage became a global DELETE);
 *  and now TIME. A control's meaning is a function of (code, capability flags,
 *  store scope, live row state) and ONLY THE FIRST APPEARS IN A DIFF, so a
 *  reviewer reading the diff cannot catch the other three.
 *
 *  ── THE ROLE SET, AND WHY IT CANNOT DRIFT ────────────────────────────────
 *  Delivered by `withPolicy()` to every role whose body already carries
 *  BROWSER_FIRST or RESEARCH_INSTRUMENTS — today {builder, scout} and
 *  {researcher} respectively, per T16 and the round-239 scope test. The set is
 *  COMPUTED FROM THE BODY, not from a hand-written role list, because a
 *  hand-written list is precisely how a new role silently loses a policy block
 *  (the argument `withPolicy()`'s own comment makes, applied to a conditional
 *  block). A role branch that gains a browser tomorrow gains this with it; one
 *  that loses its browser stops paying for it. The membership test in
 *  project-tick.test.ts asserts the resulting set explicitly so the derivation
 *  cannot quietly start including roles that drive no browser.
 *
 *  NOT the tester, and the exclusion is a judgement, not an oversight: its branch
 *  carries neither constant today. Its prompt does name the browser as a testing
 *  surface, which makes it the one role this derivation would arguably under-serve
 *  — reported to the manager chat at round 240 rather than fixed by widening a
 *  block into a branch this task was told not to touch.
 *
 *  BUDGET 900 characters, asserted in project-tick.test.ts. Terse and imperative
 *  on purpose: the narrative above costs the prompt nothing, and the four spawns
 *  a day that carry this text should not pay for it. */
export const BROWSER_CONTROL_SAFETY =
  `DRIVING A LIVE CONTROL SURFACE (any script that clicks a row in a team, Live or run panel):\n` +
  `- STUB THE RUN-CONTROL ENDPOINTS TOO — POST /runs/:id/stop and POST /runs/:id/terminate — not just the ` +
  `dismissal ones. The same control reaches DIFFERENT endpoints depending on the row's state, so stubbing ` +
  `"the endpoints I mean to exercise" is not the set you will hit.\n` +
  `- NEVER drive a confirm or an X on a row that is not settled. Assert \`settled\` IMMEDIATELY BEFORE the ` +
  `click, never once at script start.\n` +
  `- RE-ASSERT ROW STATE BETWEEN RUNS of the same script. This is the part that bit: a settled row was ` +
  `running by the next execution, and the identical click terminated the operator's own run.\n` +
  `- BLAST RADIUS CHANGES WHERE THE CODE DOES NOT. A control's meaning is a function of (code, capability ` +
  `flags, store scope, live row state) — only the first appears in a diff.`;

/** R870 — the fleet-wide autonomy rule Konrad set on 2026-08-05, condensed from
 *  the vault note "AI OS/Policy - Agent Autonomy and Escalation.md". The full
 *  text is committed verbatim at docs/plan/10-policy-agent-autonomy-and-escalation.md
 *  so an agent without vault access can still read the original.
 *
 *  Applied through withPolicy() for the same reason WORKTREE_POLICY is — a new
 *  role branch that forgets to paste it is exactly the omission this shape
 *  prevents. Unlike the worktree rule it is NOT gated on a live checkout: a
 *  scratch project can still spend real money, mail someone as Konrad, or burn
 *  Konrad's attention on a question a browser would have answered.
 *
 *  On the browser: the vault note names "playwright / auto-browser". The
 *  auto-browser skill's controller is not installed on this host
 *  (docs/tools/research-browser.md §2.1), so naming it as a working path would
 *  send agents at a dead end — scripts/research-browser.mjs is the shipped
 *  equivalent and, being a CLI, is reachable from every role that has Bash,
 *  including scout, which holds no Skill tool. */
export const ESCALATION_POLICY =
  `AUTONOMY AND ESCALATION (fleet-wide, non-negotiable — full policy in ` +
  `docs/plan/10-policy-agent-autonomy-and-escalation.md):\n` +
  `1) AUTONOMY IS THE DEFAULT. Blocked on a login wall, a missing doc, an unclear API, a service that only ` +
  `exists inside a browser? Go and find out: drive a real browser with \`scripts/research-browser.mjs\` ` +
  `(shipped in this repo — real Chrome, persistent logged-in profiles, runnable from Bash by every role; ` +
  `from another repo's worktree: /opt/forge-ai-os/scripts/), or the \`playwright-skill\` if you hold the ` +
  `Skill tool. Read the real docs, call the real endpoint. NEVER ask Konrad something research would have ` +
  `answered — that is a failure of the agent, not a service to him.\n` +
  `2) ESCALATE BEFORE an irreversible or boundary-crossing action — ask first, act after his answer: ` +
  `changing SSH keys, deleting accounts, destroying credentials or unbacked data, force-pushing over shared ` +
  `history, sending outbound communication as Konrad, spending real money, touching a business system in ` +
  `production, anything that affects a third party.\n` +
  `3) ESCALATE ON PREFERENCE/DESIGN DECISIONS in build-once-use-many work when the brief does not actually ` +
  `say what Konrad wants — UI interaction models, schemas, naming conventions, workflow shapes, defaults ` +
  `everything downstream inherits. Do not guess plausibly; a plausible guess at an interaction model has ` +
  `already cost a full build-review-deploy cycle. Restate the model in 2-3 sentences, ask the specific open ` +
  `questions, and state the default you will take if he does not answer.\n` +
  `4) HOW TO ASK — one curl, then carry on:\n` +
  `    curl -sX POST http://127.0.0.1:7700/api/reminders -H 'content-type: application/json' ` +
  `-d '{"text":"<which project/task you are, what you need, what you will do by default>","when":"in 1m"}'\n` +
  `  Max 500 chars per reminder — a longer ask is rejected with 400, so split it into several. Then KEEP ` +
  `WORKING on everything that does not depend on the answer. Never idle waiting for a reply, and never ` +
  `end a task early because you asked a question.`;

/** C17 — the MANAGER COMMS block, appended to every worker prompt of a project
 *  that came out of a manager chat. Three things a worker cannot derive on its
 *  own: which run is the manager, the exact curl that reaches it, and what is
 *  worth sending.
 *
 *  Field names (`text`, `from`, `sender_run_id`) are the ones
 *  `routes/run-control.ts`'s POST /:id/message actually validates — a prompt
 *  that taught `content` or `message` would produce a 400 the agent would have
 *  to debug mid-task. `$FORGE_RUN_UUID` stays a literal shell variable: it is
 *  exported into every run's environment by cc-runner (T17), so the agent
 *  passes it through rather than pasting an id it would have to look up.
 *
 *  r950 folds the `forge:ui` control format in HERE rather than into
 *  withPolicy(), and the reason is which surface actually renders one. Traced on
 *  the deployed tree: a report arrives as a `user` message carrying `meta.comms`
 *  and renders CommsMessage -> CommsText -> RichMessage, and ManagerThread is
 *  the one caller that supplies RichActions ({insertDraft, openSecret}), so the
 *  control is LIVE there. The drilled worker view (AgentChatView) hands
 *  AssistantThread no actions, so the same block renders disabled; a reminder
 *  has no `meta.comms` at all and falls to UserText, which is literally
 *  `<>{text}</>` — raw fenced JSON in Konrad's face. withPolicy() also wraps
 *  scratch projects that have NO manager chat, where a control block has no live
 *  surface whatsoever. Gating the format on the same linkage that gates the
 *  channel it renders in is therefore the only placement that cannot teach a
 *  worker to emit a block nobody can click.
 *
 *  The verdict-role paragraph closes F3 of docs/plan/evidence/cp2-c9-reconciler.md
 *  at prompt level. It is gated on `isVerdictRole` — the same predicate the
 *  reconciler gates on — rather than a second hand-written role list, so the
 *  set of roles that gets the instruction cannot drift from the set of roles
 *  whose verdict is parsed. */
export function MANAGER_COMMS(managerRunId: string, role: TaskRole): string {
  const base =
    `MANAGER COMMS. This project was started from a manager chat, and that chat is run ` +
    `${managerRunId}. It is the one place your findings reach Konrad while you are still working.\n` +
    `- To report, one curl:\n` +
    `    curl -sX POST http://127.0.0.1:7700/api/runs/${managerRunId}/message ` +
    `-H 'content-type: application/json' ` +
    `-d '{"text":"<what you found>","from":"worker","sender_run_id":"'"$FORGE_RUN_UUID"'"}'\n` +
    `  \`$FORGE_RUN_UUID\` is your OWN run id, already exported into your environment — pass the shell ` +
    `variable through exactly as written above; never paste an id you looked up by hand.\n` +
    `- Report FINDINGS, BLOCKERS and DECISIONS the manager must know: something that changes what the ` +
    `next task should do, something you are stuck on, a call you had to make that the brief did not ` +
    `cover. Not chatter, not progress narration, not "starting now" or "still working". One report ` +
    `that matters beats five status pings.\n` +
    `- A REPORT MAY CARRY ONE INTERACTIVE BLOCK — and this is the ONLY channel where one renders. The ` +
    `text you send with the curl above goes through the manager chat's rich renderer, so it may include ` +
    `one fenced \`forge:ui\` control block. A reminder (POST /api/reminders) is shown as PLAIN TEXT and ` +
    `your own transcript renders the control DISABLED, so a block in either place is noise — put it in a ` +
    `report or write the ask as prose. Use it for escalation rule 3) above: when you must ask Konrad to ` +
    `pick between concrete options, attach the options instead of listing them in prose. Clicking writes ` +
    `the value into his composer and sends nothing. For a credential use the secret variant; never ask ` +
    `for one in prose. Keep the fence at the start of its line — indenting it four spaces stops it being ` +
    `a block at all.\n` +
    `\`\`\`forge:ui\n` +
    `{"kind":"choice","prompt":"Which store should the migration write to?","options":[\n` +
    `  {"value":"postgres","label":"PostgreSQL","hint":"the existing content_forge database"},\n` +
    `  {"value":"sqlite","label":"SQLite","hint":"a new file, no server to run"}]}\n` +
    `\`\`\`\n` +
    `\`\`\`forge:ui\n` +
    `{"kind":"secret","name":"STRIPE_API_KEY","why":"the billing probe cannot run without it"}\n` +
    `\`\`\`\n` +
    `  Exact shape, validated against a closed schema — a block that fails renders in Konrad's chat as a ` +
    `visible "unreadable control block", so do not improvise fields. \`kind\` is "choice" or "secret" and ` +
    `nothing else. A choice needs \`options\`: 1–12 entries, each a bare string or an object whose ` +
    `\`value\` (required, max 400 chars) is what lands in the composer, with optional \`label\` (max 80) ` +
    `and \`hint\` (max 160); optional \`prompt\` (max 400) and \`"multiple":true\` to pick several. A ` +
    `secret needs \`name\` (max 64, characters [A-Za-z0-9._-] only) and optional \`why\` (max 400).`;

  if (!isVerdictRole(role)) return base;

  return (
    base +
    `\n- YOUR VERDICT IS READ FROM YOUR LAST MESSAGE. Any reply you send AFTER you have already ` +
    `declared your verdict MUST end with a \`VERDICT:\` line again — restate the unchanged verdict ` +
    `verbatim if nothing has changed. The parser reads only the LAST assistant message, by design ` +
    `(first-match parsing used to read reviewers' rehearsals instead of their verdicts), so a verdict ` +
    `role that is messaged, answers in prose and stops leaves its round with NO parseable verdict — ` +
    `and the round then blocks the whole project with \`no_verdict\`.`
  );
}

/** The worktree a task actually runs in (R36/R37) — the workstream it was
 *  declared in and the branch checked out in that workstream's directory.
 *  `provisionWorkstream()` produced both; nothing here recomputes them, so the
 *  prompt can never name a branch the run is not standing on.
 *
 *  For `main` this is `{ 'main', project.work_branch }` and every prompt is
 *  byte-identical to the one built before phase 4 — the property the deploy
 *  rests on, asserted in project-tick.test.ts rather than asserted here. */
export interface TaskWorkspace {
  workstream: string;
  /** `null` only for a `main` workstream on a project whose worktree has not
   *  been provisioned yet — `Project.work_branch` is nullable and the header
   *  has always interpolated it raw. Kept nullable so that case renders the
   *  bytes it rendered before phase 4 rather than a tidier empty string. */
  work_branch: string | null;
}

/** The workspace a caller that did not resolve one meant (test call sites, and
 *  only those — `spawnTaskRuns()` always passes the real one).
 *
 *  It REFUSES for a non-`main` workstream instead of defaulting. The default
 *  would have to be `project.work_branch`, which for a workstream row is the
 *  wrong branch: the prompt would tell a builder in `project/<id8>-ui` that it
 *  is standing on `project/<id8>`, and its `git-sync-branch.sh` would push the
 *  wrong ref. NF1 — a fallback-for-invalid is the shape this fleet forbids;
 *  a default-for-omitted is only legitimate while the omitted value is
 *  recoverable, and here it is not. */
function promptWorkspace(
  task: ProjectTask,
  project: Project,
  given: TaskWorkspace | undefined,
): TaskWorkspace {
  if (given) return given;
  if (task.workstream !== MAIN_WORKSTREAM) {
    throw new Error(
      `buildPrompt: task ${task.id} is in workstream "${task.workstream}" but no ` +
        "resolved TaskWorkspace was passed — the branch cannot be derived from " +
        "the project row (R37). The spawn path passes the result of " +
        "provisionWorkstream(); a caller that has not provisioned one must.",
    );
  }
  return { workstream: MAIN_WORKSTREAM, work_branch: project.work_branch };
}

/** The project's own branch — the merge base a workstream reviewer diffs
 *  against (R37). It cannot be null on this path: a workstream worktree is
 *  branched off `project/<id8>` and `provisionWorkstream()` throws before
 *  returning if that branch does not exist. Asserting it anyway keeps the
 *  refusal a named error here instead of the string "null" reaching a
 *  reviewer's shell as a git revision. */
function requireProjectBranch(project: Project, task: ProjectTask): string {
  if (!project.work_branch) {
    throw new Error(
      `buildPrompt: task ${task.id} is in workstream "${task.workstream}" but project ` +
        `${project.id} has no work_branch — the workstream's fork point is undefined (R37).`,
    );
  }
  return project.work_branch;
}

export function buildPrompt(
  task: ProjectTask,
  project: Project,
  workspace?: TaskWorkspace,
): string {
  const mission = roleConfig(task.role).mission;
  const ws = promptWorkspace(task, project, workspace);
  const isMainWorkstream = ws.workstream === MAIN_WORKSTREAM;
  // null for scratch projects: no live checkout exists, so none of the
  // live-checkout policy blocks apply (and interpolating "null" into a path
  // would be worse than saying nothing).
  const live = liveCheckoutPath(project.repo);
  // C17. null when the project has no manager-chat linkage, which is the whole
  // gate: no linkage -> no block, and an unlinked project's prompt still ends
  // exactly where it ended before CP3, at ESCALATION_POLICY (08 §4 acceptance).
  // Not "byte-identical": C18 below changes the goal-mode corpus paths
  // independently of linkage. The key name
  // itself lives in db/projects.ts and is deliberately never spelled here —
  // 08 §4.3's boundary grep must keep matching only cc-runner.ts and
  // db/projects.ts, so this file asks the accessor instead.
  const managerRun = managerChatRunId(project);
  // C18. One slug per prompt build, so a FUTURE project's planning corpus is
  // born under its own directory instead of colliding in the flat docs/plan/
  // this repo still uses.
  //
  // CREATING vs READING — the distinction that round 1105 caught. Where a
  // prompt CREATES or seeds a corpus (the goal-mode architect's five paths, the
  // "Plan phase k per …/04-phases.md" brief template, "commit nothing outside
  // …"), the slugged path is the only path: it decides where the corpus lands.
  // Where a prompt READS an existing corpus (planner, reviewer), the slug must
  // NOT be the only path offered. buildPrompt runs at EVERY task spawn, not at
  // project creation, so a project already in flight — planned into the flat
  // docs/plan/ and forbidden by boundary D6 from moving until the merge recipe
  // runs — gets the new prompt text for its very next task. Pointing such a
  // reviewer at ${corpus}/03-quality.md alone would send it to a directory that
  // does not exist and cannot be created, and the old "if it exists" hedge let
  // it fall through and review with no quality gate at all: exactly the silent
  // degradation this project exists to remove. The reading branches therefore
  // name both paths and require the role to say which one it used.
  const slug = projectSlug(project.name, project.id);
  const corpus = `docs/plan/${slug}`;
  // Wrap EVERY return through this rather than pasting the block into eight
  // branches — a new role branch that forgets the policy is exactly the kind
  // of omission bug 3 was. R870 rides the same wrapper for the same reason,
  // but unconditionally: WORKTREE_POLICY is meaningless without a live
  // checkout, whereas the escalation rule binds a scratch project just as hard.
  // C17's MANAGER COMMS block is folded into the SAME funnel (the `withComms`
  // of 09 CP3) for the third time over the same argument: nine `return
  // withPolicy(...)` branches, and a tenth one added at 3am must not be able to
  // silently lose the only channel a worker has back to its manager.
  //
  // ROUND 240 adds two more riders on the same argument, and each is placed
  // where its own gate can still see it:
  //
  //  - DEP_INSTALL_NOTE (B1) rides the `live` arm beside WORKTREE_POLICY. It is
  //    a property of how the executor runs EVERY task, so no role branch may
  //    lose it; it is meaningless on a scratch project, which has no checkout
  //    to install into. It goes BEFORE ESCALATION_POLICY, never after: two
  //    suites (cp3-linkage.test.ts, "an unlinked project's prompt ends exactly
  //    with ESCALATION_POLICY") assert that ending, and an unlinked prompt's
  //    last block is load-bearing evidence for the comms gate.
  //
  //  - BROWSER_CONTROL_SAFETY (B4) is DERIVED FROM THE BODY, not from a role
  //    list: it attaches wherever BROWSER_FIRST or RESEARCH_INSTRUMENTS already
  //    is. A hand-written list of browser-driving roles is exactly how a role
  //    added later loses the block — the same failure this wrapper was built to
  //    prevent, one level in. Matched against the constants' whole text, not a
  //    generic substring, so nothing else can accidentally satisfy it.
  //
  //  - SCREENSHOT_CONVENTION (round 900) rides the SAME `drivesBrowser` test as
  //    B4, for the same reason: the researcher's own instructions used to be
  //    the only place a screenshot's on-disk destination was taught, so every
  //    other browser-driving role wrote theirs to /tmp, where the Console
  //    shipped by operator-visibility phase 6 cannot see them. Deriving it from
  //    the same predicate B4 already computes means a role added tomorrow that
  //    gains a browser gains this too, with nothing to remember.
  const withPolicy = (body: string): string => {
    const drivesBrowser = body.includes(BROWSER_FIRST) || body.includes(RESEARCH_INSTRUMENTS);
    const briefed = drivesBrowser
      ? `${body}\n\n${BROWSER_CONTROL_SAFETY}\n\n${SCREENSHOT_CONVENTION}`
      : body;
    const policed = live
      ? `${briefed}\n\n${WORKTREE_POLICY(live)}\n\n${DEP_INSTALL_NOTE}\n\n${ESCALATION_POLICY}`
      : `${briefed}\n\n${ESCALATION_POLICY}`;
    return managerRun
      ? `${policed}\n\n${MANAGER_COMMS(managerRun, task.role)}`
      : policed;
  };
  // R36/R37. For `main` — every live project today — this is the string it has
  // always been, character for character: `ws.work_branch` IS
  // `project.work_branch` and the workstream line is absent. For a workstream
  // the branch named is the one actually checked out in that worktree, because
  // a worker told the wrong branch pushes the wrong ref, and the one added line
  // says the two things a worker in an isolated worktree cannot infer from its
  // surroundings: its neighbours are elsewhere, and it does not merge itself
  // (R38 — integration is a task with a reviewer, and there is no auto-merge
  // path anywhere in the tree).
  const worktreeLine = isMainWorkstream
    ? `Repo: ${project.repo} — you are already inside its worktree (branch ${ws.work_branch}, off ${project.base_branch}).\n`
    : `Repo: ${project.repo} — you are already inside its worktree (branch ${ws.work_branch}, off ${project.work_branch}).\n` +
      `Workstream: ${ws.workstream} — an isolated worktree of this project. Other workstreams are working in ` +
      `other directories on the same files; you never see their commits and you NEVER merge this branch ` +
      `yourself. A separate integration task, with its own reviewer, merges it back.\n`;
  const header =
    `${mission}\n\n---\n\n` +
    `Project: ${project.name}\n` +
    worktreeLine +
    `Project brief: ${project.brief}\n\n` +
    `Your task (round ${task.round}): ${task.title}\n${task.brief}\n`;

  if (task.role === "architect") {
    if (isGoalMode(project)) {
      return withPolicy(
        header +
        `\nThis is a GOAL-MODE project: a long-horizon goal that may take many hours or days of autonomous ` +
        `multi-agent work. You are the architect; your job tonight is the waterfall plan, done so thoroughly ` +
        `that implementation never has to loop back to re-litigate scope.\n\n` +
        // C18. Every path in this branch is slugged: this is where a corpus is
        // CREATED, so it is the one place that decides where future corpora
        // live. Deliberately NOT slugged, here or anywhere else in this file:
        // ESCALATION_POLICY's pointer to
        // docs/plan/10-policy-agent-autonomy-and-escalation.md and every
        // docs/plan/... path inside a code comment. Those name files that
        // really exist at those flat paths in THIS repo, and boundary 05 D6
        // forbids relocating this project's own corpus now — D6's merge recipe
        // is what eventually moves existing corpora under their slugs.
        `1) PLANNING CORPUS. Write an exhaustive set of planning documents under ${corpus}/ in the worktree ` +
        `and commit them:\n` +
        `   - ${corpus}/00-vision.md — the goal restated precisely, definition of done, measurable success criteria, explicit non-goals.\n` +
        `   - ${corpus}/01-requirements.md — every functional and non-functional requirement, numbered (R1, R2, ...), each testable.\n` +
        `   - ${corpus}/02-architecture.md — system design: components, data models, interfaces, technology choices with one-line rationale, failure modes, how progress/state is observable.\n` +
        `   - ${corpus}/03-quality.md — test strategy (unit, integration, end-to-end), QA gates per phase, what the reviewer must run and check.\n` +
        `   - ${corpus}/04-phases.md — the waterfall itself: numbered phases, each with scope, deliverables, acceptance criteria, and which requirement IDs it covers. Every requirement maps to exactly one phase.\n` +
        `   Depth beats brevity here — thousands of lines across the corpus is normal for a real goal. ` +
        `Research with your tools (codebase, vault, web) before deciding; never plan from guesswork.\n\n` +
        `2) SEED THE PIPELINE. Create ONE planner task per phase via the API:\n${taskCurl(project.id)}\n` +
        // R51 — the one legitimate hand-written round left in the system, and the
        // reason this branch has to spell out a field taskCurl() no longer
        // carries. Every other caller lets the route compute the round; the
        // architect's phase blocks are a LABEL humans and the Kanban group by,
        // and no dependency edge could produce them because a phase-k planner
        // has no dependency on phase k-1 (the phases are planned up front and
        // gated by their reviewers, not by planner edges). If this branch stayed
        // silent about the field, the architect would faithfully omit it and
        // every planner would compute to round 0.
        `   YOU are the one role that adds a round to that body — "round": 100 for phase 1's planner, 200 for ` +
        `phase 2, and so on. That number is a PHASE LABEL, not a schedule: it is what lets a human and the ` +
        `Kanban say "phase 4", and the gaps leave room for fix cycles. Your planners inherit nothing else ` +
        `about rounds — they declare dependencies and let the engine compute every round below yours. Each ` +
        `planner brief: "Plan phase k per ${corpus}/04-phases.md" ` +
        `plus anything phase-specific the corpus doesn't capture. If a phase needs research first, add a scout ` +
        `task at round k*100 - 1. A red-team reviewer briefed to attack rather than check is reserved for ` +
        `paths where a silent failure is EXPENSIVE — credentials, data loss, anything a user's work depends ` +
        `on. It is not the default posture for a phase, and it is never right for documentation.\n` +
        `   ${GRAPH_GUIDE}\n   ${TIER_GUIDE}\n   ${REVIEW_ECONOMY}\n   ${IDEMPOTENCY_NOTE}\n\n` +
        // R14/R16/R17. Gated on `live` like every other policy block: a scratch
        // project has no live checkout to deploy to and no executor to restart,
        // so this guidance would be noise at best and a wrong instruction at worst.
        (live
          ? `3) GIT/GITHUB + DEPLOY. Plan the final deploy phase around the two blocks below, and copy them ` +
            `into the briefs of the tasks they govern — the deploy task and each phase's gating reviewer:\n\n` +
            `${DEPLOY_GUIDE}\n\n` +
            `${GITHUB_PUSH_GUIDE}\n\n`
          : "") +
        `Do not write implementation code or commit anything outside ${corpus}/ — that's the builders' job.`
      );
    }
    // THE NON-GOAL ARCHITECT — a task-creating role, and R53 falsified its
    // ordering sentence without updating it (round 241 finding 1, fixed here).
    //
    // Every project created without `"mode":"goal"` reaches this branch, and
    // `mode` is optional on POST /api/projects, so it is not a rare path. When
    // taskCurl() stopped sending `round` and started sending depends_on /
    // workstream / write_set, this branch kept telling the architect to put its
    // reviewer "in the round right after your last builder round" while handing
    // it three unexplained fields — an instruction that is no longer executable
    // (there is no round field to write) attached to a vocabulary it was never
    // taught. An architect resolving that contradiction the obvious way drops
    // depends_on: round absent computes to 0, depends_on absent stores the NULL
    // legacy sentinel, and `legacyRoundReady` then promotes the reviewer in the
    // same tick as the builders it must join — it reviews an empty diff. So this
    // branch gets GRAPH_GUIDE, exactly as the goal branch has it, and the round
    // sentence becomes the dependency join the planner branch already states.
    // It does NOT get R51's phase label: this architect seeds no per-phase
    // planners, and "G4 negative" asserts the label stays out.
    return withPolicy(
      header +
      `\nWhen you're done: write a short plan to PLAN.md in the repo root. Then create the work that ` +
      `follows by calling forge-control directly, e.g.:\n` +
      `${taskCurl(project.id)}\n` +
      `${GRAPH_GUIDE}\n` +
      `Split implementation into focused, independently-completable builder tasks. Always end with exactly one ` +
      `"reviewer" task DEPENDING ON every builder you created — the join, not a round number — briefed to ` +
      `review the whole diff. ` +
      `Do not write implementation code or commit anything yourself — that's the builder's job.\n` +
      `${TIER_GUIDE}\n${REVIEW_ECONOMY}\n${IDEMPOTENCY_NOTE}`
    );
  }
  if (task.role === "planner") {
    return withPolicy(
      header +
      `\nRead the planning corpus — at ${corpus}/ for a project planned under the per-project layout, or at ` +
      `the flat docs/plan/ for a project whose corpus predates it. Both paths are real in this fleet; look at ` +
      `both and read whichever exists. Then, with the current state of the worktree, ` +
      `break YOUR assigned scope into concrete builder tasks by calling forge-control:\n` +
      `${taskCurl(project.id)}\n` +
      // ORDER MATTERS, and it was wrong until it was read aloud. GRAPH_GUIDE
      // DEFINES write_set; the two clauses below both constrain it. Printed the
      // other way round — as this branch first shipped in draft — the prompt told
      // a planner what belongs in a write_set two paragraphs before saying what a
      // write_set is. `.includes()` gates cannot see that, and a planner cannot
      // miss it.
      `${GRAPH_GUIDE}\n` +
      `ALWAYS finish with exactly one reviewer task DEPENDING ON every builder you created — the join, not ` +
      `"the round after the last builder" — briefed with the phase's acceptance criteria and exactly which ` +
      `tests/commands to run. Each builder brief is self-contained: the files it will write, the approach, ` +
      `and how it verifies its own work (tests to write/run).\n` +
      `COMPANION FILES: a write_set names every file that must change for the task's requirement to be ` +
      `satisfied AND its gate to be honest — implementation, test and gate clause alike, even across another ` +
      `phase's nominal ownership, and then the brief says why. A task changing a shared type, an exported ` +
      `signature or a fixture shape includes the TEST FACTORIES AND CALL SITES that change with it, not ` +
      `merely the file whose behaviour is the point. A write_set is an input to a scheduling decision, not a ` +
      `summary of intent: phase 2 of this very project widened a shared type and forced edits to two test ` +
      `files' object factories no write_set named — a finding then, a clobber under workstreams, where two ` +
      `sets omitting the same forced companion are scheduled in parallel over it.\n` +
      `${TIER_GUIDE}\n${REVIEW_ECONOMY}\n${IDEMPOTENCY_NOTE}\n` +
      `Do not write implementation code yourself — plan, then fan out.` +
      // R16: the planner writes the reviewer briefs, so it needs the push rule
      // in hand to put it into them.
      (live ? `\n\n${GITHUB_PUSH_GUIDE}` : "")
    );
  }
  if (task.role === "researcher") {
    return withPolicy(
      header +
      `\nDeep research only — no implementation, no task creation. Use every research surface you have: ` +
      `web search/fetch, the instruments below, and anything else your brief names. When a source will not ` +
      `yield to WebFetch — a JS app, a login wall, a console-only service, a doc that 403s — a real browser ` +
      `(scripts/research-browser.mjs below, or the \`playwright-skill\`) is the FIRST resort, not the last. ` +
      `Write your ` +
      `findings to docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that ` +
      `one file. Findings must be concrete enough that a planner can act on them without repeating the research.\n\n` +
      `${RESEARCH_INSTRUMENTS}`
    );
  }
  if (task.role === "scout") {
    return withPolicy(
      header +
      `\nResearch only — no implementation, no task creation. Write your findings to ` +
      `docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that one file. ` +
      `Findings must be concrete enough that a planner can act on them without repeating the research.\n\n` +
      `${BROWSER_FIRST}`
    );
  }
  if (task.role === "reviewer") {
    // R37 — THE DIFF BASE. `main` keeps `${project.base_branch}...HEAD`, byte
    // for byte: that is what makes this change invisible to every live project,
    // and project-tick.test.ts asserts the whole prompt against a string built
    // from `project.base_branch` rather than from this expression.
    //
    // A workstream worktree branches off the PROJECT branch, and the project
    // branch collects every other workstream's integration merges. Diffed
    // against `base_branch` a workstream reviewer would be shown every other
    // team's merged work as though this task had written it — it would either
    // review work it did not commission or drown. The fork point is the only
    // base that answers "what did THIS workstream do": `git merge-base` is
    // resolved by the agent's shell at review time, so the base moves with the
    // project branch instead of being frozen into the prompt.
    const diffBase = isMainWorkstream
      ? project.base_branch
      : `$(git merge-base ${requireProjectBranch(project, task)} HEAD)`;
    return withPolicy(
      header +
      `\nReview the actual diff (git diff ${diffBase}...HEAD) and the code itself, not just the ` +
      `plan or commit messages. Run the tests and checks named in your brief, plus the project's quality gates ` +
      `— at ${corpus}/03-quality.md for a project planned under the per-project layout, or at ` +
      `docs/plan/03-quality.md for a project whose corpus predates it. Look at BOTH paths, read whichever ` +
      `exists, and name in your review which one you used; if neither exists, say so explicitly rather than ` +
      `reviewing without gates and staying quiet about it. ` +
      `A review without executed checks is not a review.\n` +
      // R57 — the write-set audit, the enforcement point for R52. The "why it is
      // satisfiable" sentence is not decoration: 03-quality.md §4 records three
      // consecutive reviewers disclosing-and-proceeding against a gate that could
      // not be passed, and a reviewer who assumes THIS gate needs archaeology
      // (grepping briefs for prose file lists) would do the same. Write-sets are
      // declared, stored on the row, and rendered into the builder's own prompt.
      `WRITE-SET AUDIT (one gate, mandatory): for every builder task in this group, compare the paths its ` +
      `commits actually touched (git log --name-only over that task's commits) against the write_set it ` +
      `declared and restated in its report. An undeclared write is a FINDING, not a footnote. This gate is ` +
      `satisfiable by construction — write-sets are DECLARED on the task row, never archaeologically ` +
      `reconstructed by grepping briefs — so there is nothing here to disclose and proceed past.\n` +
      // B2 + B3 (round 240). Both are reviewer-scoped, and both are printed
      // BEFORE the VERDICT sentence on purpose: they are preconditions OF a
      // verdict, and a rule stated after the instruction it constrains reads as
      // an afterthought. That ordering defect is the one round 239 caught only
      // by reading its own built prompt end to end — no `.includes()` gate can
      // see the order of two clauses it both finds.
      `${REVIEWER_TIP_DISCIPLINE}\n` +
      `${REVIEWER_GATE_SUITE}\n` +
      `End your final message with a line starting ` +
      `exactly with "VERDICT: PASS" if it's genuinely ready, or "VERDICT: NEEDS_FIXES" followed by a concrete ` +
      `numbered list (file:line, the problem, the fix) if not. Never skip the VERDICT line.` +
      // R13 + R16: the reviewer is the round's gate, so both the cleanliness
      // check and the push-on-PASS rule land here.
      (live ? `\n\n${REVIEWER_LIVE_CHECK(live)}\n\n${GITHUB_PUSH_GUIDE}` : "")
    );
  }
  // R850. The tester gates a round exactly like the reviewer does — its verdict
  // is parsed, consolidated and capped by the same code — so the contract has to
  // be stated by the engine and not left to agents/tester.md alone: a tester
  // that ends without a VERDICT line now BLOCKS the project (`no_verdict`),
  // which is a far more expensive silence than it was when testers were
  // reconciled per task. No live-checkout cleanliness check here on purpose:
  // that gate belongs to the reviewer, who reads the diff — the tester never
  // judges code and would only duplicate the finding.
  if (task.role === "tester") {
    return withPolicy(
      header +
      `\nTest the product, not the diff — walk the real user journeys named in your brief with the ` +
      `real surface (browser, CLI, API) and report what a customer would actually experience, with ` +
      `evidence for every finding. If your brief does not name a running surface you may use, test ` +
      `what you can reach from this worktree and say plainly in your report what you could not ` +
      `exercise; never start, patch or restart a live service to make a journey testable.\n` +
      `End your final message with a line starting exactly with "VERDICT: PASS" if a real customer ` +
      `would be satisfied, or "VERDICT: NEEDS_FIXES" followed by a concrete numbered list (the ` +
      `journey step, what you did, what happened, what a customer expects, severity, evidence). ` +
      `Never skip the VERDICT line: the orchestrator parses it, a NEEDS_FIXES opens a fix cycle that ` +
      `re-tests against your findings, and a missing verdict blocks the whole project.\n\n` +
      // F-E, round 242. The tester was the one browser-driving role outside
      // withPolicy()'s derived set: the branch above sends it at "the real
      // surface (browser, CLI, API)" while carrying neither BROWSER_FIRST nor
      // RESEARCH_INSTRUMENTS, so it received the run-control rules (B4) only if
      // a brief happened to paste them. That is the hand-written-list failure
      // the derivation exists to prevent, reached from the other side — and the
      // tester is the role most likely to repeat round 1873's incident, because
      // clicking what a user would click is its job. Adding the constant here
      // fixes it WITHOUT touching the derivation: the set stays computed from
      // the body, and this branch simply joins it.
      `${BROWSER_FIRST}`
    );
  }
  if (task.role === "builder") {
    return withPolicy(
      header +
      `\nImplement this directly in the worktree (branch ${ws.work_branch} is already checked out). ` +
      `Commit your changes with a clear message when done. Verify your own work before reporting done — run ` +
      `the tests your brief names, and write the tests it asks for.\n` +
      // R52 — the declared write_set is only a scheduling input if somebody
      // checks it, and the reviewer's R57 gate is that somebody. Naming the gate
      // here is deliberate: a builder that knows its writes will be compared
      // against its declaration discloses the overflow itself, which is what
      // rounds 213 and 222 did and what §10 of 04-phases.md records. The list is
      // rendered from `task.write_set`, so a builder cannot restate a set the
      // scheduler did not actually store.
      `YOUR DECLARED WRITE-SET is ${task.write_set.length > 0 ? task.write_set.join(", ") : "(empty — nothing was declared)"}. ` +
      `Restate it in your final report, and if you wrote ANY file outside it, say so LOUDLY: name each ` +
      `undeclared file and why it had to change. Your reviewer compares the paths your commits touched ` +
      `against this list and reports an undeclared write as a finding — disclose it first.\n\n` +
      `${BROWSER_FIRST}`
    );
  }
  return withPolicy(header);
}

/** The serialisation unit: one workstream of one project. Two projects that
 *  both have a workstream called `ui` hold two different worktrees and must not
 *  serialise against each other, so the project id is part of the key — the
 *  same partition-by-project the contention belt makes in `claimReadyTasks()`.
 *  NUL as the separator because a uuid cannot contain one and a workstream name
 *  cannot either (R28's validator). */
export function workstreamKey(projectId: string, workstream: string): string {
  return `${projectId}\u0000${workstream}`;
}

/**
 * Which workstreams already have a task in flight — the input to the
 * serialisation belt below.
 *
 * `claimedIds` IS LOAD-BEARING AND IS THE TRAP IN THIS FUNCTION.
 * `claimReadyTasks()` flips its winners to 'running' INSIDE its own
 * transaction, so by the time the spawn path reads the project's tasks back,
 * every task it is about to spawn is already 'running'. Counted naively, each
 * task would find its own workstream busy and defer itself, and the engine would
 * spawn nothing, ever. Excluding this pass's own ids is what makes the set mean
 * "runners that PREDATE this pass".
 */
export function busyWorkstreams(
  tasks: readonly { id: string; project_id: string; workstream: string; status: TaskStatus }[],
  claimedIds: ReadonlySet<string>,
): Set<string> {
  const busy = new Set<string>();
  for (const t of tasks) {
    if (t.status !== "running") continue;
    if (claimedIds.has(t.id)) continue;
    busy.add(workstreamKey(t.project_id, t.workstream));
  }
  return busy;
}

/**
 * AT MOST ONE RUNNING TASK PER (project, workstream) — the operator's ruling of
 * round 222, closing the edge phase 4A reported and did not choose on.
 *
 * The workstream IS the unit of parallelism. Two tasks placed in one workstream
 * were placed there BECAUSE they contend — that is what the name means — and the
 * write-set belt cannot see the whole of that contention: declared write-sets
 * cover SOURCE files, and nobody declares their compiler's scratch space. Two
 * tasks of one workstream with entirely disjoint source write-sets still share
 * one `.next`, which is how `next build` died with ENOENT twice on this box on
 * 2026-08-17 (operator-visibility r1353 and r1357). Isolating workstreams while
 * leaving that configuration reachable would have fixed the observed instance
 * and left the mechanism intact. The spec settles it in as many words —
 * "tasks in the same workstream share a worktree and serialize among
 * themselves" (`AI OS/Spec - Task Graph and Workstream Worktrees` §3) — so this
 * is the implementation catching up with the design, not a new trade-off.
 *
 * ORDER-STABLE, and by the same argument as `selectClaimable()`: `claimed`
 * arrives in `ORDER BY pt.round ASC, pt.created_at ASC`, so the shallower and
 * older task of a workstream wins the pass and the loser is handed back to
 * 'ready' and claimed on a later tick. Nothing fails, nothing is dropped.
 *
 * IT IS A BELT, NOT THE GATE, and says so rather than pretending otherwise: it
 * runs outside `claimReadyTasks()`'s transaction, because the durable gate
 * would be one term in `selectClaimable()` (lib/task-graph.ts) and that file
 * belongs to phase 3 in the ownership table — reported to the manager chat
 * rather than taken here. The belt is sufficient in practice because a single
 * executor runs `projectTick()`, and it is strictly safe: it can only WITHHOLD a
 * spawn, never create one.
 */
export function partitionByWorkstream<
  T extends { id: string; project_id: string; workstream: string },
>(
  claimed: readonly T[],
  busy: ReadonlySet<string>,
): { spawn: T[]; deferred: T[] } {
  const taken = new Set(busy);
  const spawn: T[] = [];
  const deferred: T[] = [];
  for (const task of claimed) {
    const key = workstreamKey(task.project_id, task.workstream);
    if (taken.has(key)) {
      deferred.push(task);
      continue;
    }
    taken.add(key);
    spawn.push(task);
  }
  return { spawn, deferred };
}

/** The one spawn log line's TEXT (R58), pulled out so project-tick.test.ts can
 *  assert on it without importing anything that opens a pg Pool — `spawnTaskRuns()`
 *  below is the only caller. Workstream is printed ALWAYS, including 'main': a
 *  line meant to be grepped by `workstream=` must not silently drop the common
 *  case. `depends_on`'s NULL sentinel (doc-comment on `ProjectTask.depends_on`,
 *  db/projects.ts) is never collapsed into 0 — that is exactly the kind of lie
 *  NF1 forbids — so a legacy row reads `deps=legacy` and a graph row reads
 *  `deps=<n>`, tested with one `=== null`, never `?? []`, never truthiness. */
export function formatSpawnLog(
  task: Pick<ProjectTask, "id" | "role" | "round" | "tier" | "workstream" | "depends_on" | "title">,
  runId: string,
  projectName: string,
): string {
  const deps = task.depends_on === null ? "legacy" : String(task.depends_on.length);
  return (
    `[project-tick] spawned ${task.role} run ${runId} for task ${task.id} ` +
    `(round ${task.round}, tier ${task.tier ?? "role-default"}, workstream=${task.workstream}, deps=${deps}) — ` +
    `${projectName} · ${task.title}`
  );
}

/**
 * R17's WARN CLAUSE — the message a spawn owes an undeclared builder, or `null`
 * when it owes none. Relocated to phase 4 by 01-requirements R17 and 04-phases
 * Phase 4 deliverable 10, because it lives in the spawn path in this file, which
 * §10 assigns to phases 4 and 5 and which phase 2 does not write.
 *
 * WHY IT IS NOT COSMETIC. An empty `write_set` says "this task writes nothing",
 * and under the contention model that makes it intersect NOBODY: `conflicts()`
 * returns false the moment either side is empty (R17's other clause), so the
 * task is always claimable and runs alongside anything. A builder that simply
 * FORGOT to declare its writes therefore receives MAXIMUM parallelism and
 * MAXIMUM chance of clobbering — exactly backwards. Nothing else in the engine
 * can tell that omission from a task that genuinely writes nothing, so this line
 * is the only thing that surfaces it.
 *
 * `builder` ONLY. A reviewer, planner, researcher, scout or tester legitimately
 * writes nothing, and warning about them would make the warning noise, which is
 * the same as deleting it.
 *
 * A FUNCTION AND NOT AN INLINE `if`, so that R17's stated proof — "the warning
 * fires for `builder` and not for `scout`" — is a unit test over the rule and
 * its text rather than a regex over this file's source.
 */
export function emptyWriteSetWarning(
  task: Pick<ProjectTask, "id" | "role" | "title" | "workstream" | "write_set">,
  projectName: string,
): string | null {
  if (task.role !== "builder") return null;
  if (task.write_set.length > 0) return null;
  return (
    `[project-tick] builder task ${task.id} ("${task.title}", project ${projectName}, ` +
    `workstream ${task.workstream}) has an EMPTY write_set — it contends with nothing ` +
    "and will run alongside anything (R17). Declare the files it writes."
  );
}

/**
 * The worktree ONE TASK's run gets as its cwd (R36).
 *
 * Before phase 4 this resolved one directory per PROJECT, off
 * `task.project.workspace_dir`. It now resolves one per TASK, off
 * `task.workstream`, and three properties of the old code survive deliberately:
 *
 *  1. `executor.ts` IS NOT TOUCHED. It already uses `run.metadata.workspace_dir`
 *     as the child's cwd, and 04-phases.md §10 lists it as written by no phase.
 *     Handing `createRunForTask()` a different directory is the whole change.
 *  2. `setProjectWorkspace()` KEEPS RECEIVING THE 'main' WORKTREE AND ONLY THAT.
 *     It writes `projects.workspace_dir`, which the Kanban links, the deploy's
 *     pre-merge check and every later task read. Writing a workstream's
 *     directory into the project row would silently repoint all of them at a
 *     branch that is not the project's. It is called in the `main` branch below
 *     and nowhere else in this file.
 *  3. THE `wsMissing` RECOVERY WORKS FOR A WORKSTREAM TOO. Both 2026-07-30
 *     worktrees were deleted from disk while the DB kept the paths (E8) and a
 *     resumed task spawned `claude` with a cwd that was not there. For `main`
 *     the stored path is probed and re-provisioned exactly as before; for a
 *     workstream there is no stored path to go stale — `provisionWorkstream()`
 *     is called every time and its `lookupWorktree()` runs `git worktree prune`
 *     FIRST, so a directory deleted from disk is deregistered and re-added on
 *     the same call. The `existsSync` gate at the end is what makes that
 *     CHECKED rather than assumed, for both workstreams: a directory that is
 *     still missing after provisioning is a named spawn failure that blocks the
 *     project, not an obscure ENOENT inside a child process.
 *
 * For `task.workstream === 'main'` the returned directory and branch are
 * byte-identical to what this code returned before phase 4 —
 * `provisionWorkstream(p, 'main')` DELEGATES to `provisionWorkspace(p)` (R33/R34)
 * rather than recomputing anything, so no live project can change directory
 * when this ships.
 */
async function resolveTaskWorkspace(
  task: ProjectTask & { project: Project },
): Promise<{ workspace_dir: string; work_branch: string }> {
  let resolved: { workspace_dir: string; work_branch: string };

  if (task.workstream === MAIN_WORKSTREAM) {
    // A stored workspace_dir is not evidence the directory still exists (E8).
    const wsMissing =
      !!task.project.workspace_dir && !existsSync(task.project.workspace_dir);
    if (wsMissing) {
      console.warn(
        `[project-tick] workspace ${task.project.workspace_dir} for project ` +
          `${task.project_id} is gone from disk — re-provisioning`,
      );
    }
    if (!task.project.workspace_dir || !task.project.work_branch || wsMissing) {
      // Normally the API route provisions synchronously at project creation,
      // but this tick can claim the round-0 architect task inside that
      // window, so the fallback is a real path — and it must write the
      // result back, or every later tick re-provisions from scratch.
      const ws = await provisionWorkstream(task.project, MAIN_WORKSTREAM);
      task.project.workspace_dir = ws.workspace_dir;
      task.project.work_branch = ws.work_branch;
      await setProjectWorkspace(task.project_id, ws).catch(() => {});
    }
    resolved = {
      workspace_dir: task.project.workspace_dir,
      work_branch: task.project.work_branch,
    };
  } else {
    // NO WRITE-BACK, deliberately — see property 2 above. The workstream's
    // directory is derived from the project id and the workstream name every
    // time, so there is no cached path that could point at a directory the
    // project no longer owns.
    resolved = await provisionWorkstream(task.project, task.workstream);
  }

  if (!existsSync(resolved.workspace_dir)) {
    throw new Error(
      `[project-tick] workspace ${resolved.workspace_dir} for task ${task.id} ` +
        `(project ${task.project_id}, workstream ${task.workstream}) does not exist ` +
        "after provisioning — refusing to spawn a run whose cwd is missing",
    );
  }
  return resolved;
}

async function spawnTaskRuns(): Promise<void> {
  const claimed = await claimReadyTasks();
  if (claimed.length === 0) return;

  // The serialisation belt's input. `projectAcceptsWork` is consulted here as
  // well as in the loop below — it is pure and free — so that a task whose
  // project stopped accepting work cannot consume its workstream's one slot and
  // defer a healthy sibling for a tick.
  const eligible = claimed.filter((t) => projectAcceptsWork(t.project.status));
  const claimedIds = new Set(claimed.map((t) => t.id));
  const busy = new Set<string>();
  for (const projectId of new Set(eligible.map((t) => t.project_id))) {
    const rows = await listTasksForProject(projectId);
    for (const key of busyWorkstreams(
      rows.map((t) => ({ ...t, project_id: projectId })),
      claimedIds,
    )) {
      busy.add(key);
    }
  }
  const deferred = new Set(
    partitionByWorkstream(eligible, busy).deferred.map((t) => t.id),
  );

  for (const task of claimed) {
    try {
      // Belt to the SQL gate's braces (R10). claimReadyTasks() already joins on
      // `projects.status = 'active'` and THAT is the real gate; this catches the
      // race where the project is paused/blocked between the claim transaction
      // and this loop. The claim already flipped the task to 'running', so hand
      // it back to 'ready' rather than dropping it — the row must stay
      // re-claimable, or pausing a project would silently strand its tasks.
      // No run is spawned and the project is NOT blocked: this is not an error.
      if (!projectAcceptsWork(task.project.status)) {
        await setTaskStatus(task.id, "ready");
        console.log(
          `[project-tick] skipping ${task.role} task ${task.id} — project status ${task.project.status}`,
        );
        continue;
      }
      // The operator's ruling of round 222, enforced. The task keeps its place
      // in the queue: it is handed back to 'ready' exactly as the belt above
      // hands back a paused project's task, and the next tick claims it once
      // its workstream is free. Logged, because a tick that withholds work must
      // not look like a tick that had none (E4's argument, applied to the
      // opposite outcome).
      if (deferred.has(task.id)) {
        await setTaskStatus(task.id, "ready");
        console.log(
          `[project-tick] holding ${task.role} task ${task.id} — workstream ` +
            `"${task.workstream}" of project ${task.project_id} already has a task running ` +
            "(one running task per workstream)",
        );
        continue;
      }
      // R36 — the run's cwd is its TASK's workstream worktree, not the
      // project's one directory. `main` resolves to exactly what this line
      // resolved to before phase 4.
      const ws = await resolveTaskWorkspace(task);
      const prompt = buildPrompt(task, task.project, {
        workstream: task.workstream,
        work_branch: ws.work_branch,
      });
      const cfg = roleConfig(task.role);
      const tierCfg = task.tier ? TIER_MODELS[task.tier] : null;
      const run = await createRunForTask({
        title: `${task.project.name} · ${task.title}`,
        prompt,
        role: task.role,
        project_id: task.project_id,
        task_id: task.id,
        // R36. `createRunForTask` puts this in `runs.metadata.workspace_dir`
        // and executor.ts uses it verbatim as the child's cwd — which is why
        // executor.ts needs no change at all for a workstream to get its own
        // directory.
        workspace_dir: ws.workspace_dir,
        // C16: the run inherits the project's manager-chat linkage, if any.
        // createRunForTask owns the key and the presence check.
        project_metadata: task.project.metadata,
        ...(cfg.tools ? { allowed_tools: cfg.tools } : {}),
        ...(tierCfg?.model ?? cfg.model ? { model: tierCfg?.model ?? cfg.model! } : {}),
        ...(tierCfg?.effort ?? cfg.effort ? { effort: tierCfg?.effort ?? cfg.effort! } : {}),
        // Only architect gets Konrad's vault — the other four roles don't
        // need his whole knowledge base to implement/review/research a task.
        vault_access: task.role === "architect",
      });
      await attachRun(task.id, run.id);
      // E4: spawning used to be silent, so a tick that did real work looked
      // exactly like a tick that did nothing. Every spawn is on the record now.
      // R58: the line also names the workstream and the dependency count, so
      // it says WHY a task started when it did, not just that it did.
      console.log(formatSpawnLog(task, run.id, task.project.name));
      // R17's warn clause. ONE PER SPAWN, not one per tick — which is why it
      // sits beside the spawn line above rather than in the tick body.
      const undeclared = emptyWriteSetWarning(task, task.project.name);
      if (undeclared) console.warn(undeclared);
    } catch (e) {
      console.error(
        `[project-tick] failed to spawn run for task ${task.id} (${task.role}):`,
        e instanceof Error ? e.message : e,
      );
      await setTaskStatus(task.id, "failed").catch(() => {});
      await setProjectStatus(task.project_id, "blocked").catch(() => {});
      // A spawn failure used to be log-only. The first goal-mode run died two
      // seconds after being seeded and Konrad had no signal until he asked.
      // Every path that blocks a project now tells him.
      await queueNotification(
        `🚫 Project "${task.project.name}" blocked — could not start ${task.role} task ` +
          `"${task.title}": ${e instanceof Error ? e.message : String(e)}`,
        "project",
      ).catch(() => {});
    }
  }
}

/** Narrow a DB row's role to a verdict role, or throw naming the row. The query
 *  filters on VERDICT_ROLES, so anything else means the filter and this mapping
 *  have drifted apart — and guessing would pick the wrong re-check role and the
 *  wrong chain key, which is how a round silently grows a second chain. */
function assertVerdictRole(
  role: TaskRole,
  taskId: string,
  projectId: string,
  label: string,
): VerdictRole {
  if (!isVerdictRole(role)) {
    throw new Error(
      `[project-tick] listVerdictRound returned task ${taskId} with non-verdict role ` +
        `'${role}' for project ${projectId} ${label} — the query filter and ` +
        `VERDICT_ROLES have drifted apart`,
    );
  }
  return role;
}

/**
 * Decide ONE gating round of ONE project, and act on that decision.
 *
 * The unit of decision is the round, never the task: a gating round is only
 * ready to be judged when every one of its verdict tasks has landed, and it
 * then yields at most one fix chain. Deciding per task is what produced two
 * "Fix cycle 1" builders, two re-reviewers, and later two deploy builders on
 * the engine's first night (docs/plan/02-architecture.md §1.1).
 *
 * "Verdict task" means reviewer OR tester (R850): both role files close with
 * the same VERDICT contract, and a tester's round-mates are its reviewers, so
 * they are consolidated as ONE group. Splitting them per role would put two
 * fix builders into the same round and the same worktree — bug 1 again, wearing
 * a different hat.
 *
 * R40 (phase 4) restates the GROUP and nothing else: `(project, round,
 * workstream)`. Two reviewers at the same computed depth in DIFFERENT
 * workstreams are two groups and get two chains, because one merged fix builder
 * can only be spawned into one worktree and the other workstream's findings
 * would be delivered nowhere. Every decision below — NEEDS_FIXES beats PASS,
 * one chain per group, one re-check per dissenting role, the (a)–(e) order, the
 * mark-done preconditions — is untouched (R44).
 */
async function consolidateVerdictGroup(
  projectId: string,
  round: number,
  workstream: string,
): Promise<void> {
  // The group's human name: "round 7" for `main`, "round 7 · workstream ui"
  // otherwise, so a single-workstream project's log reads exactly as it did.
  const label = groupLabel(round, workstream);
  const rows = await listVerdictRound(projectId, round, workstream, VERDICT_ROLES);
  const inputs: VerdictInput[] = rows.map((r) => ({
    taskId: r.id,
    // Narrowed rather than cast: the query filters on VERDICT_ROLES, so a row
    // with any other role means the filter and this mapping have drifted apart,
    // and guessing a role would pick the wrong re-check and the wrong chain key.
    role: assertVerdictRole(r.role, r.id, projectId, label),
    title: r.title,
    fixCycle: r.fix_cycle,
    // The rule itself lives in project-reconcile.ts (verdictMemberSettled) so
    // it can be tested exhaustively and so db/projects.ts's mark-done and
    // pre-check predicates have one definition to mirror. Read it there: a
    // 'done' member is settled by bookkeeping whatever its run does later
    // (R1005 finding 2), a `completed` run still carrying pending_input is NOT
    // settled because it owes an undelivered turn (finding 1), and everything
    // else — no run, running, failed/cancelled/stuck/paused — waits.
    settled: verdictMemberSettled({
      taskStatus: r.status,
      runStatus: r.run_status,
      pendingInput: r.pending_input,
    }),
    lastText: r.last_text,
  }));

  const decision = consolidateVerdictRound(round, inputs, MAX_FIX_CYCLES, workstream);
  // "1 reviewer + 1 tester" — the log line has to say WHICH roles gated the
  // round, or a tester's NEEDS_FIXES reads exactly like a reviewer's in the
  // one place Konrad follows a project from. Absent roles are omitted rather
  // than printed as "0 tester", which would read as a missing task.
  const roster =
    VERDICT_ROLES.map((role) => ({ role, n: inputs.filter((r) => r.role === role).length }))
      .filter((c) => c.n > 0)
      .map((c) => `${c.n} ${c.role}`)
      .join(" + ") || "empty";

  switch (decision.action) {
    case "wait": {
      // Nothing is marked done — THE invariant. The gating tasks stay 'running'
      // with a settled run, so listSettledRunningTasks() re-surfaces them and
      // the group is re-evaluated on the next tick.
      const settledCount = inputs.filter((r) => r.settled).length;
      console.log(
        `[project-tick] ${label} verdicts → wait (${settledCount}/${inputs.length} settled, ${roster})`,
      );
      return;
    }

    case "pass": {
      // Mark-done FIRST, and abort the whole branch if any member refuses.
      // A PASS is the one decision with no undo: it releases the next phase.
      // If a message requeued a reviewer between the read and here, its next
      // turn may say NEEDS_FIXES, and closing the round now would bury that
      // verdict in a task nothing ever looks at again. Nothing below this line
      // has run yet, so aborting is free and the next tick re-decides.
      const refused = await markGroupDone(inputs);
      if (refused.length > 0) {
        logGroupNotReleased(projectId, label, "pass", refused);
        return;
      }
      console.log(`[project-tick] ${label} verdicts → pass (${roster})`);
      // E4's two pushes, moved from the per-task path to here. Both halves:
      // the per-task ✅ (non-goal projects only — a goal project can carry
      // hundreds of tasks and has goalHeartbeats() instead) and the 🏁 group
      // boundary. The completion check has to run AFTER markGroupDone or
      // it always answers false, and it is checked rather than assumed because
      // a gating round can share its number with other roles.
      //
      // R45: the check and the push are per GROUP, so workstream A draining
      // does not announce a round workstream B is still working inside — and
      // B's own completion still fires, which it could not if A had already
      // spent the round's one announcement. `groupCompleteNotification` keeps
      // the text byte-identical for `main`.
      const project = await getProject(projectId).catch(() => null);
      const name = project?.name ?? projectId;
      if (project && !isGoalMode(project)) {
        for (const r of inputs) {
          await queueNotification(
            `✅ ${name} · ${r.role} task "${r.title}" done (round ${round}).`,
            "project",
          ).catch(() => {});
        }
      }
      if (await roundIsComplete(projectId, round, workstream).catch(() => false)) {
        await queueNotification(
          groupCompleteNotification(name, round, workstream),
          "project",
        ).catch(() => {});
      }
      // Nothing is created here: closeFinishedProjects() owns completion.
      return;
    }

    case "block": {
      // ORDER IS LOAD-BEARING, same argument as the `fix` branch below: the
      // state that STOPS work is written FIRST, the bookkeeping that RELEASES
      // the round second. Marking the gating tasks 'done' first opens a window in
      // which round R is fully settled and the project is still 'active' — a
      // crash there (this project's own deploy restarts the executor; the
      // stuck-run watchdog and OOM are other routes) leaves promoteReadyTasks()
      // free to promote the next phase past a review that never produced a
      // verdict, with no notification ever sent.
      //
      // Reversed, a crash is harmless: the gating tasks stay 'running' with
      // settled runs, listSettledRunningTasks() has NO project-status filter
      // (see listSettledRunningTasks in db/projects.ts — reconciliation is
      // bookkeeping and must run
      // for paused/blocked projects too), so it re-surfaces them next tick,
      // consolidation re-decides `block` identically (the inputs did not move),
      // and meanwhile the already-blocked project promotes and claims nothing.
      //
      // The notification is sent before mark-done for the same reason: a crash
      // after mark-done would leave a blocked project nobody was told about,
      // whereas a replay at worst pushes the same message twice.
      //
      // Pre-check, immediately before the first irreversible step. Blocking a
      // project and pushing to Konrad's phone cannot be taken back by a later
      // mark-done refusal, so the S4 window is closed from the front here and
      // the conditional mark-done below catches the remaining milliseconds.
      const moved = await unsettledVerdictTasks(inputs.map((r) => r.taskId));
      if (moved.length > 0) {
        logGroupNotReleased(
          projectId,
          label,
          "block",
          inputs.filter((r) => moved.includes(r.taskId)),
        );
        return;
      }
      await setProjectStatus(projectId, "blocked");
      console.warn(
        `[project-tick] ${label} verdicts → block (${decision.reason}, ${roster}): ${decision.detail}`,
      );
      const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
      await queueNotification(
        `🚫 Project "${name}" blocked — ${label} verdicts (${decision.reason}): ` +
          `${decision.detail}. Check the run threads.`,
        "project",
      ).catch(() => {});
      // A refusal here is already too late to undo the block, but it must not
      // pass unrecorded — and leaving the member 'running' is the right state:
      // the next tick re-consolidates it against the already-blocked project,
      // which promotes and claims nothing meanwhile.
      const refused = await markGroupDone(inputs);
      if (refused.length > 0) logGroupNotReleased(projectId, label, "block", refused);
      return;
    }

    case "fix": {
      // ORDER IS LOAD-BEARING: create the chain FIRST, mark the gating tasks
      // done SECOND. A crash between the two re-runs consolidation next tick —
      // they are still 'running' with settled runs, the same (round,
      // cycle) yields the same chain keys, createFixChain's bare ON CONFLICT
      // DO NOTHING absorbs the duplicate insert on EITHER unique index, and
      // mark-done proceeds. The reverse order would leave
      // a window where round R is fully 'done' with no fix round in the table,
      // and promoteReadyTasks() would promote the next phase's planner straight
      // past an unfinished fix cycle.
      //
      // Same pre-check as `block`, same reason: the chain INSERT is the
      // irreversible step here. A reviewer requeued by a message between
      // listVerdictRound() and this point may be about to withdraw the very
      // NEEDS_FIXES this chain would be built from, and a stray fix chain at
      // round+1 promotes builders nobody asked for. The conditional mark-done
      // after createFixChain covers the milliseconds this cannot.
      const moved = await unsettledVerdictTasks(inputs.map((r) => r.taskId));
      if (moved.length > 0) {
        logGroupNotReleased(
          projectId,
          label,
          `fix cycle ${decision.cycle}`,
          inputs.filter((r) => moved.includes(r.taskId)),
        );
        return;
      }

      // R42 — the chain joins the graph instead of being born a root. The
      // write-sets come from the REVIEWED tasks' rows (the gating reviewers and
      // testers declare what their group touched), and the gating ids are what
      // the fix builder must wait for. Computed once, by the pure helper, so
      // the rounds, the edges and the union have one definition — and so the
      // notification below names the same round the row was written at.
      const graph = fixChainGraphFields({
        round,
        workstream,
        members: rows.map((r) => ({ taskId: r.id, writeSet: r.write_set })),
      });
      const chain = await createFixChain({
        project_id: projectId,
        round,
        cycle: decision.cycle,
        builderTitle: FIX_TASK_TITLE(decision.cycle, workstream),
        builderBrief: decision.mergedBrief,
        builderChainKey: decision.builderChainKey,
        // One re-check per DISSENTING role, in the decision's order — a
        // reviewer's concerns are settled by reading the new diff, a tester's
        // by walking the journey again, and neither can stand in for the other.
        checkers: decision.checkers.map((c) => ({
          role: c.role,
          title: RECHECK_TASK_TITLE(c.role, decision.cycle, workstream),
          brief: recheckBrief(c.role, decision.mergedBrief),
          chainKey: c.chainKey,
        })),
        graph,
      });
      const chainRows = [chain.builder, ...chain.checkers];

      // A STRANGER holds one of our chain's identity tuples. Its brief is not
      // the brief this consolidation just merged, so the round's feedback would
      // reach nobody. Treating that as an absorbed replay — which the flags
      // did until R308 — marks the gating tasks done, sends no push, and loses
      // the verdict in silence. The reachable case is the deploy window: the
      // LIVE pre-0039 engine reconciles per task, so reviewer A settling before
      // the restart writes ("Fix cycle 1", round R+1, chain_key NULL), and
      // reviewer B settling after it lands here. B's findings are the ones that
      // vanish.
      //
      // So: block, and say which row is in the way. The verdicts are not lost —
      // they are in the runs, and the message names the round. Marking the
      // group done anyway is deliberate: a blocked project promotes and
      // claims nothing, and leaving the tasks 'running' would re-decide and
      // re-notify this same round every 10s.
      const occupied = chainRows.filter(
        (o): o is Extract<typeof o, { kind: "occupied" }> => o.kind === "occupied",
      );
      if (occupied.length > 0) {
        const detail = occupied
          .map((o) => `task ${o.id} ("${o.title}", chain_key ${o.chain_key ?? "NULL"})`)
          .join(" and ");
        await setProjectStatus(projectId, "blocked");
        console.error(
          `[project-tick] ${label} verdicts → fix cycle ${decision.cycle} COLLIDED: ` +
            `${detail} already holds this chain's identity — merged feedback NOT delivered`,
        );
        const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
        await queueNotification(
          `🚫 Project "${name}" blocked — round ${round}'s fix cycle ${decision.cycle} could not be ` +
            `created: ${detail} already occupies it, written by an earlier engine. The reviewers'/` +
            `testers' findings are in their run threads. Re-title or delete that task, then ` +
            `POST /api/projects/${projectId}/unwedge.`,
          "project",
        ).catch(() => {});
        const refusedOnCollision = await markGroupDone(inputs);
        if (refusedOnCollision.length > 0) {
          logGroupNotReleased(projectId, label, "fix/collision", refusedOnCollision);
        }
        return;
      }

      // The chain exists at this point, so a refusal cannot un-create it — but
      // it MUST stop the round from closing and must not announce a fix cycle
      // whose premise a message may have just withdrawn. The next tick waits
      // for the requeued run, re-decides, and — if the verdict is unchanged —
      // recomputes the same (round, cycle) chain keys, which createFixChain's
      // guard absorbs as a replay.
      const refused = await markGroupDone(inputs);
      if (refused.length > 0) {
        logGroupNotReleased(projectId, label, `fix cycle ${decision.cycle}`, refused);
        return;
      }
      const dissenters = decision.checkers.map((c) => c.role).join(" + ");
      const line =
        `[project-tick] ${label} verdicts → fix cycle ${decision.cycle} ` +
        `(builder ${chain.builder.kind} ${chain.builder.id}, ` +
        `${chain.checkers.map((c) => `re-${c.role} ${c.kind} ${c.id}`).join(", ")})`;
      if (chainRows.every((o) => o.kind === "created")) {
        console.log(line);
      } else {
        // Not an error: this is the replay guard doing exactly its job.
        console.log(`${line} — replay absorbed by the chain_key guard, no duplicate chain`);
      }
      // E4's fix-cycle push. Sent only for a chain this tick actually created:
      // announcing a replay would tell Konrad the same fix cycle opened twice,
      // which is the exact confusion bug 1 produced in the first place.
      //
      // The workstream is named only when it is not `main`, for R45's reason
      // applied to this push: two workstreams opening a fix cycle at the same
      // depth would otherwise send two identical messages, and a
      // single-workstream project's text does not move at all.
      if (chain.builder.kind === "created") {
        const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
        const where =
          workstream === MAIN_WORKSTREAM ? "" : ` · workstream ${workstream}`;
        await queueNotification(
          `🔁 ${name} · ${dissenters} want fixes — fix cycle ${decision.cycle} opened at round ` +
            `${graph.builder.round}${where}.`,
          "project",
        ).catch(() => {});
      }
      return;
    }
  }
}

/** Mark every gating task of a decided group 'done', each write preconditioned
 *  on that member still being SETTLED by the same three-term rule the decision
 *  was computed from (`verdictMemberSettled`): 'done' already, or a `completed`
 *  run owing no undelivered turn. NOT "its run is still `completed`" — that
 *  qualifier was R1005 finding 2, and re-adding it to the done branch
 *  reinstates the wedge it removed.
 *
 *  Idempotent by construction — re-marking an already-'done' row is a no-op
 *  UPDATE independent of what its run has done since (that row was settled by
 *  BOOKKEEPING, and its run is free to be resumed, stopped or to fail
 *  afterwards) — which is what makes the crash-replay path above safe to
 *  re-run.
 *
 *  Returns the tasks that REFUSED to move. A non-empty list means a member left
 *  the settled set while this consolidation was deciding (red-team S4): the
 *  control plane requeued its run, or the run never left `completed` but now
 *  carries an undelivered message. Either way the round is not decided after
 *  all, and the caller must stop rather than close it. See markVerdictTaskDone
 *  in db/projects.ts for the SQL mirror of the rule, term for term. */
async function markGroupDone(inputs: VerdictInput[]): Promise<VerdictInput[]> {
  const refused: VerdictInput[] = [];
  for (const r of inputs) {
    if (!(await markVerdictTaskDone(r.taskId))) refused.push(r);
  }
  return refused;
}

/** The log line every mark-done refusal shares. Loud on purpose: the round is
 *  left mid-decision on purpose, and the next tick's `wait` would otherwise be
 *  the only trace of a message that changed a verdict. */
function logGroupNotReleased(
  projectId: string,
  label: string,
  branch: string,
  refused: VerdictInput[],
): void {
  console.warn(
    `[project-tick] ${label} verdicts → ${branch} NOT released for project ${projectId}: ` +
      `${refused.map((r) => `${r.role} "${r.title}"`).join(", ")} is no longer settled ` +
      `(a message requeued the run, or it is 'completed' still owing an undelivered turn) — ` +
      `re-consolidating next tick`,
  );
}

/** Per-task and per-round progress pushes (E4) — where "round" now means the
 *  GROUP `(project, round, workstream)` (R45).
 *
 *  Goal-mode projects deliberately do NOT get a ping per task — they can carry
 *  hundreds, and they already have the time-gated heartbeat in goalHeartbeats().
 *  Group boundaries are notified for every project: in goal mode a round IS a
 *  waterfall phase, which is exactly the granularity worth a push.
 *
 *  R45: the boundary is the GROUP `(project, round, workstream)`, so the last
 *  task of workstream A does not announce a round workstream B is still inside
 *  — and B's own last task still fires, which it could not once A had spent the
 *  round's single announcement. `groupCompleteNotification` keeps the text
 *  byte-identical for `main`. */
async function notifyTaskProgress(
  task: ProjectTask,
  project: Project | null,
): Promise<void> {
  const name = project?.name ?? task.project_id;
  if (project && !isGoalMode(project)) {
    await queueNotification(
      `✅ ${name} · ${task.role} task "${task.title}" done (round ${task.round}).`,
      "project",
    ).catch(() => {});
  }
  if (await roundIsComplete(task.project_id, task.round, task.workstream).catch(() => false)) {
    await queueNotification(
      groupCompleteNotification(name, task.round, task.workstream),
      "project",
    ).catch(() => {});
  }
}

/** Konrad's clock, same convention as the reminder and telegram paths. */
const DISPLAY_TZ = process.env.REMINDER_TZ ?? "Europe/Berlin";

function localLabel(at: Date): string {
  return at.toLocaleString("de-DE", {
    timeZone: DISPLAY_TZ,
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * Tell Konrad about a usage-wall outage AT MOST ONCE, however many tasks it
 * felled (R860, requirement 3).
 *
 * The window lives in lib/usage-wall.ts; the only thing decided here is what an
 * unreadable notification history means. It means "announce": the whole point
 * of the push is that the fleet has gone quiet on its own, and a swallowed
 * message reproduces the five hours of silence this round exists to end. A
 * duplicate costs one line on his phone.
 */
async function announceUsageWallOutage(
  sig: { kind: "session" | "weekly" | "unspecified"; resetHint: string | null },
  plan: { delayMs: number; wakeAtMs: number },
): Promise<void> {
  const now = Date.now();
  const lastAt = await lastNotificationAt(USAGE_WALL_NOTIFICATION_SOURCE).catch((e) => {
    console.warn(
      `[project-tick] could not read the last usage-wall push (${
        e instanceof Error ? e.message : e
      }) — announcing rather than risking silence`,
    );
    return null;
  });
  if (!shouldAnnounceOutage(lastAt, now)) return;
  await queueNotification(
    outageMessage({
      kind: sig.kind,
      resetHint: sig.resetHint,
      delayMs: plan.delayMs,
      wakeAtLabel: localLabel(new Date(plan.wakeAtMs)),
    }),
    USAGE_WALL_NOTIFICATION_SOURCE,
  );
}

/**
 * R860 — survive the Claude subscription's usage wall without a human.
 *
 * Incident 2026-08-05: the 5-hour window filled at ~10:00 Berlin. Eleven runs
 * across both active projects died with `claude-code exit 1: You've hit your
 * session limit · resets 1:10pm`, the loop below marked every one of their
 * tasks `failed` and blocked both projects, and the fleet stayed dead until
 * Konrad ran /unwedge at ~15:00. Nothing was broken; the engine simply had no
 * way to tell "this task is wrong" from "the account is full".
 *
 * So: classify first, and on the wall's signature park the RUN instead of
 * killing the TASK. Returns true when the caller must skip its failure path.
 *
 * Returning false is always safe — every false lands on the old behaviour
 * (task failed, project blocked, Konrad told), which is the right destination
 * for a real failure and an acceptable one for a wall we could not park.
 *
 * The four refusals, in order, each for its own reason:
 *  - not 'failed' — a cancellation is Konrad's decision and a timeout ('stuck')
 *    has its own resume path; neither is ours to reopen.
 *  - no run row — nothing to re-queue.
 *  - not the wall's signature — the overwhelmingly common case: a real failure.
 *  - project not active — a queued run is invisible to project status (the
 *    executor's claim loop knows about runs, not projects), so parking one on a
 *    blocked or paused project would smuggle billable work past the gate that
 *    bug 2 exists to enforce. Fail it visibly instead.
 */
export async function deferForUsageWall(
  task: SettledRunningTask,
  project: Project | null,
): Promise<boolean> {
  if (task.run_status !== "failed" || !task.run_id) return false;
  const sig = classifyUsageWall(task.last_error);
  if (!sig) return false;
  if (!project || !projectAcceptsWork(project.status)) {
    console.warn(
      `[project-tick] task ${task.id} hit the ${sig.kind} usage wall but its project is ` +
        `${project?.status ?? "unreadable"} — failing it rather than parking work on a ` +
        `project that is not accepting any`,
    );
    return false;
  }

  const now = Date.now();
  const plan = planUsageWallRetry({
    priorAttempts: task.usage_wall_attempts,
    nowMs: now,
    resetAtMs: parseResetAt(sig.resetHint, now),
  });
  if (plan.action === "give_up") {
    console.warn(
      `[project-tick] task ${task.id} (${task.role} · ${task.title}) hit the ${sig.kind} ` +
        `usage wall again — ${plan.reason}; falling back to the normal failure path`,
    );
    return false;
  }

  const wakeAt = new Date(plan.wakeAtMs);
  const parked = await requeueRunAfterUsageWall({
    runId: task.run_id,
    wakeAt,
    attempt: plan.attempt,
    note:
      `[Fleet notice] This run was interrupted by the Claude subscription's ${sig.kind} usage ` +
      `limit${sig.resetHint ? ` (resets ${sig.resetHint})` : ""}, not by anything you did. It was ` +
      `parked automatically and resumed at ${localLabel(wakeAt)}. Nothing has changed in the ` +
      `worktree since. Pick your task up where you left off and finish it.`,
  });
  if (!parked) {
    // The row was not 'failed' any more — Konrad cancelled it, or another path
    // moved it, between listSettledRunningTasks() and here. Do NOT pretend the
    // park happened: that would leave the task 'running' forever behind a run
    // that is never coming back.
    console.warn(
      `[project-tick] task ${task.id}: run ${task.run_id} was no longer 'failed' when the ` +
        `usage-wall park went to write — falling back to the normal failure path`,
    );
    return false;
  }

  console.warn(
    `[project-tick] ${sig.kind} usage wall — parked ${task.role} task ${task.id} ` +
      `(round ${task.round}) for ${formatDelay(plan.delayMs)} until ${localLabel(wakeAt)} ` +
      `(attempt ${plan.attempt}, basis ${plan.basis}) — task NOT failed, project NOT blocked`,
  );
  await announceUsageWallOutage(sig, plan);
  return true;
}

async function reconcileSettledTasks(): Promise<void> {
  const settled = await listSettledRunningTasks();
  /** Gating GROUPS touched this tick, keyed `${project_id}:${groupKey(task)}`
   *  — project, round and workstream (R40) — so a group is consolidated AT MOST
   *  ONCE per tick even when several of its verdict tasks settle together.
   *  Looping over tasks instead would reintroduce
   *  bug 1 in miniature: two settled siblings, two consolidations, two fix
   *  chains (the second one saved only by the chain_key guard — defense in depth
   *  is not a licence to fire twice). A reviewer and a tester of the same group
   *  collapse onto the SAME key, which is what makes them one decision — and two
   *  reviewers of the same depth in DIFFERENT workstreams no longer do, which is
   *  what stops one merged fix builder swallowing both their findings.
   *
   *  `groupKey` formats the tuple; the project id is prefixed here because this
   *  map spans projects and that function deliberately does not know about
   *  them. The same string is the `groupFailures` key, so an escalation counts
   *  the group it is actually about. */
  const verdictRounds = new Map<
    string,
    { projectId: string; round: number; workstream: string }
  >();

  for (const task of settled) {
    try {
      const project = await getProject(task.project_id).catch(() => null);
      const name = project?.name ?? task.project_id;
      if (task.run_status !== "completed") {
        // R860: a run killed by the subscription's usage wall is parked behind
        // runs.wake_after and retried on its own — the task stays 'running' and
        // the project stays 'active'. Everything else falls through unchanged.
        if (await deferForUsageWall(task, project)) continue;
        await setTaskStatus(task.id, "failed");
        await setProjectStatus(task.project_id, "blocked");
        console.warn(
          `[project-tick] task ${task.id} (${task.role} · ${task.title}) failed — ` +
            `run ${task.run_id} ${task.run_status}; project ${task.project_id} blocked`,
        );
        await queueNotification(
          `🚫 Project "${name}" blocked — ${task.role} task "${task.title}" ${task.run_status}. ` +
            `Retry it: POST /api/tasks/${task.id}/retry (or /api/projects/${task.project_id}/unwedge).`,
          "project",
        ).catch(() => {});
        continue;
      }
      if (isVerdictRole(task.role)) {
        // NOT marked done here, and deliberately not logged as done either: a
        // verdict task's fate belongs to its whole round. consolidateVerdictGroup
        // may well return `wait` for this group, leaving the task 'running' for
        // another tick — main's per-task "→ done" line would have claimed
        // otherwise every time, in the log Konrad reads to follow a project.
        //
        // R850: this gate used to read `task.role === "reviewer"`, so a settled
        // tester fell into the else-branch and was marked 'done' with its
        // verdict never parsed — a customer-facing NEEDS_FIXES silently became
        // an approval, which is exactly the failure mode `no_verdict` exists to
        // prevent for reviewers.
        console.log(
          `[project-tick] ${task.role} task ${task.id} (${groupLabel(task.round, task.workstream)}) ` +
            `settled — deferring to group consolidation — ${name} · ${task.title}`,
        );
        verdictRounds.set(`${task.project_id}:${groupKey(task)}`, {
          projectId: task.project_id,
          round: task.round,
          workstream: task.workstream,
        });
      } else {
        console.log(
          `[project-tick] reconciled ${task.role} task ${task.id} (round ${task.round}) ` +
            `→ done — ${name} · ${task.title}`,
        );
        await setTaskStatus(task.id, "done");
        await notifyTaskProgress(task, project);
      }
    } catch (e) {
      console.error(
        `[project-tick] failed to reconcile task ${task.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  for (const [key, { projectId, round, workstream }] of verdictRounds) {
    // Per-group isolation: one unreadable round must not abort the reconcile
    // pass for every other project's rounds. But isolation without escalation
    // is a silent stall — a permanently failing group (e.g. `column
    // "chain_key" does not exist` if forge-control is restarted on this branch
    // before migration 0039 lands) would retry every 10s forever while the
    // project sits frozen and nobody is told. So: count consecutive failures
    // and surface the group once it is clearly stuck.
    try {
      await consolidateVerdictGroup(projectId, round, workstream);
      clearGroupFailures(groupFailures, key);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Counted per GROUP: `key` carries the workstream, so a workstream wedged
      // on a schema drift cannot escalate on a healthy neighbour's behalf.
      const { count, notify } = noteGroupFailure(groupFailures, key, MAX_GROUP_FAILURES);
      console.error(
        `[project-tick] failed to consolidate verdict ${groupLabel(round, workstream)} of ` +
          `project ${projectId} (consecutive failure ${count}):`,
        message,
      );
      if (notify) {
        const name = (await getProject(projectId).catch(() => null))?.name ?? projectId;
        await queueNotification(
          `🚫 Project "${name}" — verdict ${groupLabel(round, workstream)} has failed to ` +
            `consolidate ${count} times in a row and is frozen: ${message}`,
          "project",
        ).catch(() => {});
      }
    }
  }
}

const DEFAULT_CHECKIN_HOURS = 3;

/** Periodic progress push for goal-mode projects — Konrad wakes up to a
 *  trail of "where the overnight run is" messages instead of silence.
 *  Time-gated per project via metadata.last_checkin_at; deterministic code,
 *  no LLM in the loop. */
async function goalHeartbeats(): Promise<void> {
  const goals = await listGoalProgress();
  const now = Date.now();
  for (const g of goals) {
    const meta = g.metadata as { checkin_hours?: number; last_checkin_at?: string };
    const hours = Number(meta.checkin_hours) > 0 ? Number(meta.checkin_hours) : DEFAULT_CHECKIN_HOURS;
    const last = Date.parse(meta.last_checkin_at ?? g.created_at);
    if (Number.isFinite(last) && now - last < hours * 3_600_000) continue;
    const active = g.running_titles.slice(0, 3).join("; ") || "none (between rounds)";
    await queueNotification(
      `📊 Goal "${g.name}": ${g.done}/${g.total} tasks done` +
        (g.failed ? `, ${g.failed} failed` : "") +
        `. Running: ${active}.` +
        (g.last_done_title ? ` Last finished: ${g.last_done_title}.` : ""),
      "goal",
    ).catch(() => {});
    await patchProjectMetadata(g.id, {
      last_checkin_at: new Date(now).toISOString(),
    }).catch(() => {});
  }
}

/** The three columns R70 decides over, and nothing else — the same narrowing
 *  `GraphTask` makes for the scheduler, for the same reason: a completion
 *  decision must not be able to start depending on a title, a status or a
 *  round. */
export interface CloseGateTask {
  id: string;
  workstream: string;
  depends_on: string[] | null;
}

/**
 * R70 — which workstreams of this project have NO integration task, and are
 * therefore holding it open. Empty means the project may close.
 *
 * The readable definition; `closeFinishedProjects()` in db/projects.ts carries
 * its set-based SQL mirror, and if the two disagree THIS ONE IS RIGHT.
 *
 * R38 defines the integration task structurally — a `main` task that DEPENDS ON
 * EVERY TASK OF THE WORKSTREAM — so nothing here matches a title, reads a
 * naming convention or needs a column `project_tasks` does not have (there is no
 * `metadata` column on it; `TASK_COLS` in db/projects.ts is the whole list).
 *
 * MEMBERSHIP: the integration task and its reviewer live in `main` (R38,
 * 02-architecture.md §4.4) because that is where the merge lands and where a
 * conflict must be visible. They are NOT members of W, so they are never
 * required to depend on themselves — get that wrong and no project with a
 * workstream could ever close, which is a worse bug than the one R70 fixes.
 *
 * LEGACY ROWS: `depends_on` is nullable and that IS the migration strategy
 * (02-architecture.md §2.2). A NULL names nothing, so a legacy `main` task can
 * never be an integrator; and a pre-graph project, every row of which is in
 * `main`, has no W at all and comes back empty. Every live project today is
 * such a project.
 *
 * COVERAGE IS ⊇, NOT =. The integration task may depend on more than W — R38's
 * reviewer chain and the planner's own ordering routinely add edges — so the
 * test is that W's ids are a SUBSET of what it names. Requiring equality would
 * make a correct integration task fail the moment anyone added an edge to it.
 */
export function unintegratedWorkstreams(tasks: readonly CloseGateTask[]): string[] {
  const members = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.workstream === MAIN_WORKSTREAM) continue;
    const ids = members.get(t.workstream);
    if (ids) ids.push(t.id);
    else members.set(t.workstream, [t.id]);
  }
  if (members.size === 0) return [];

  const integrators = tasks
    .filter((t) => t.workstream === MAIN_WORKSTREAM && t.depends_on !== null)
    .map((t) => new Set(t.depends_on as string[]));

  const open: string[] = [];
  for (const [workstream, ids] of members) {
    const integrated = integrators.some((deps) => ids.every((id) => deps.has(id)));
    if (!integrated) open.push(workstream);
  }
  return open.sort();
}

/** Projects already escalated for R70, so a refusal that persists — and it
 *  persists until a human creates the missing task — pushes ONCE rather than
 *  every ten seconds. `noteGroupFailure`'s shape: escalate on the crossing,
 *  re-arm when the condition clears. Process-local for the same reason: it is
 *  notification hygiene, not state the DB should own, and a restart legitimately
 *  re-announces a project that is still stuck. */
const r70Escalated = new Set<string>();

/**
 * NF1's loud half of R70. `closeFinishedProjects()` REFUSED to close these
 * projects; a refusal nobody is told about is the silent variant NF1 forbids,
 * and it would present as a project that simply sits at 100% done forever.
 */
async function reportUnintegratedWorkstreams(
  held: Array<{ id: string; name: string }>,
): Promise<void> {
  const heldIds = new Set(held.map((p) => p.id));
  for (const id of r70Escalated) if (!heldIds.has(id)) r70Escalated.delete(id);

  for (const p of held) {
    const open = unintegratedWorkstreams(await listTasksForProject(p.id));
    if (open.length === 0) {
      // The pure side and the SQL mirror disagree — OR a task was created
      // between the UPDATE and the SELECT, which is benign and the common case.
      // Either way it is not something to push to Konrad's phone, and it is not
      // something to swallow: the log names both sides so the disagreement can
      // be told from the race by looking at the row count.
      console.warn(
        `[project-tick] project ${p.id} ("${p.name}") did not close and ` +
          "unintegratedWorkstreams() names no workstream — either a task was created " +
          "between the close attempt and this read, or the R70 SQL term in " +
          "closeFinishedProjects() and this predicate have drifted apart",
      );
      continue;
    }
    if (r70Escalated.has(p.id)) continue;
    r70Escalated.add(p.id);
    console.warn(
      `[project-tick] project ${p.id} held open by unintegrated workstream(s): ${open.join(", ")}`,
    );
    await queueNotification(
      `⛔ Project "${p.name}" cannot close — every task is done, but workstream(s) ` +
        `${open.join(", ")} have no integration task. Their branches are unmerged and ` +
        "their work would be stranded (R38/R70). Create a builder task in workstream " +
        "'main' that depends on every task of each workstream and merges its branch, " +
        "plus a reviewer for it, and the project will close.",
      "project",
    ).catch(() => {});
  }
}

export async function projectTick(): Promise<void> {
  try {
    // promote/reconcile/close are pure bookkeeping (no new `runs` rows, no
    // spend) so they always run. spawnTaskRuns() is the one step that
    // creates work — that's the step that must respect the FREEZE switch,
    // exactly like cron-tick.ts gates its fire step but not its next_run_at
    // advancement. See feedback-ai-os-pause-mechanism: "off is off" means
    // EVERY path that can create billable work checks fleet_state, not just
    // the executor's claim loop.
    await promoteReadyTasks();
    const fleet = await getFleetState().catch(
      () => ({ status: "running" }) as { status: string },
    );
    if (fleet.status === "paused") {
      const now = Date.now();
      if (now - lastPauseLogAt > 5 * 60 * 1000) {
        console.log("[project-tick] fleet paused — holding new task runs");
        lastPauseLogAt = now;
      }
    } else {
      await spawnTaskRuns();
    }
    await reconcileSettledTasks();
    const finished = await closeFinishedProjects();
    for (const p of finished.closed) {
      await queueNotification(
        `✅ Project "${p.name}" is done — every task completed and the reviewer passed it.`,
        "project",
      ).catch(() => {});
    }
    // R70/NF1. `held` is what the close refused; saying so is the requirement's
    // second half, and it is done here rather than in db/projects.ts because
    // naming the workstreams runs the pure predicate, which lives in this file.
    await reportUnintegratedWorkstreams(finished.held);
    await goalHeartbeats();
  } catch (e) {
    console.error("[project-tick] tick failed:", e instanceof Error ? e.message : e);
  }
}
