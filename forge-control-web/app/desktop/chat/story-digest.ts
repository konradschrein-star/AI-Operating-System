/**
 * story-digest.ts — the "story so far" for a long session (U24).
 *
 * Konrad, watching a worker live: "I'm completely fucking confused by what
 * they are telling me and what's going on in the background." The digest is
 * the answer to "where do things stand" without scroll-reading 200 tool calls.
 *
 * PURE DERIVATION — NO EXCEPTIONS
 * `13-ui-v3-architecture.md §8` names it an explicit anti-goal: **no LLM call
 * in the render path**, ever. Nothing here fetches, no clock is read (the only
 * `Date` call in this file is parsing a wire timestamp), nothing is paraphrased. Every
 * string the digest shows is either a count, a wire field, or a *verbatim
 * substring* of something the agent actually wrote.
 *
 * TIME TRUTH (project Definition of Done #1)
 * A settled run's `elapsed_ms` is frozen — `completed_at − started_at`, the
 * same number at any clock. A RUNNING run's `elapsed_ms` is `null` and
 * `elapsed_frozen` is false: a pure function must not invent a live duration.
 * The renderer ticks a live run from `started_at` in one leaf component (the
 * phase-500 FrozenTime/useTick pattern); the digest never grows a clock.
 */

import type { RunDetail, RunStatus, ThreadEntry } from "../../api";
import {
  mergeSubagentMeta,
  parentToolUseId,
  sliceOwnerId,
  spawnRoles,
  subagentIndex,
  topLevelEntries,
} from "./subagent-slice";

/**
 * U24: "sessions with > ~50 thread entries show a collapsed digest at top".
 * 50 is spec law and it is deliberately conservative: the round-599 scout
 * measured real sessions at 150–438 entries (298, 285, 273, 272, 438 across
 * two projects), so in practice every session worth digesting clears this bar
 * several times over. Raising it later is a one-line change; lowering the bar
 * below the spec is not ours to do.
 */
export const DIGEST_MIN_ENTRIES = 50;

/** Verbatim clip budgets. The thread itself is never modified. */
const SNIPPET_MAX = 160;
const OUTCOME_MAX = 240;
/** How many closing prose turns the digest carries (U24: "last N snippets"). */
export const DIGEST_SNIPPETS = 3;

/** Statuses that can never change again — their duration is frozen. */
const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export interface DigestSnippet {
  /** The entry's `ts`, verbatim. */
  ts: string;
  /** A verbatim leading substring of what the agent wrote — never reworded. */
  text: string;
  /** True when `text` is a prefix rather than the whole message. */
  clipped: boolean;
}

export interface StoryDigest {
  /** Whether the caller should render it at all (U24's entry threshold). */
  show: boolean;

  task: string;
  /** Where `task` came from — derivation is visible, never implied. */
  task_source: "title" | "user_entry" | "none";

  started_at: string | null;
  /** Frozen duration for a settled run; null while it is still running. */
  elapsed_ms: number | null;
  elapsed_frozen: boolean;
  status: RunStatus;
  settled: boolean;
  model: string | null;

  /** Every entry handed to `deriveDigest`. */
  entry_count: number;
  /**
   * Entries belonging to the agent this digest is ABOUT.
   *
   * For a session that is "no `meta.parent_tool_use_id`". For a sub-agent view
   * it is that PLUS everything stamped with the owner's id — a scout's own 118
   * steps are its own work, not work it delegated. See `owner_tool_use_id`.
   */
  top_level_count: number;
  /** `entry_count − top_level_count` — work this agent delegated to in-process
   *  sub-agents of its own. Zero on a sub-agent view that spawned nothing. */
  subagent_entry_count: number;
  /** tool_call entries across the whole thread, sub-agents included. */
  tool_call_count: number;
  /** Entries flagged `meta.is_error`, plus `kind: "error"` entries. */
  error_count: number;

  subagent_count: number;
  /** Distinct sub-agent roles in spawn order; a role the executor has not
   *  stamped yet reads "unknown" rather than being dropped. */
  subagent_roles: string[];

  /** Which entries the prose layer was read from — see `deriveDigest`. */
  prose_scope: "top-level" | "slice";
  /** The sub-agent this digest is about, when it is about one. Null for a
   *  whole session. Reported so the own/delegated split is checkable against
   *  the input rather than inferred from it. */
  owner_tool_use_id: string | null;
  /** The last few prose turns, oldest first. */
  snippets: DigestSnippet[];
  outcome: string | null;
  outcome_source: "assistant_prose" | "current_activity" | "none";
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** A verbatim leading substring, marked when it is one. Never paraphrases. */
function clipVerbatim(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text: text.trim(), clipped: false };
  return { text: `${text.slice(0, max).trimEnd()}…`, clipped: true };
}

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function metaString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const v = metadata?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * A prose turn: the agent talking, not the machinery. `role: "agent"` counts —
 * the executor uses it for narration entries — while tool_call/tool_result and
 * empty texts do not.
 */
function isProse(entry: ThreadEntry): boolean {
  if (entry.role !== "assistant" && entry.role !== "agent") return false;
  if (entry.kind !== undefined && entry.kind !== "text") return false;
  return typeof entry.content === "string" && entry.content.trim() !== "";
}

function isError(entry: ThreadEntry): boolean {
  return entry.kind === "error" || entry.meta?.is_error === true;
}

/** First `**bolded**` phrase — the shape task briefs are written in. */
function boldedPhrase(text: string): string | null {
  const m = /\*\*([^*\n]{3,120})\*\*/.exec(text);
  return m === null ? null : m[1].trim();
}

function deriveTask(
  run: RunDetail,
  thread: readonly ThreadEntry[],
): { task: string; task_source: StoryDigest["task_source"] } {
  const title = typeof run.title === "string" ? run.title.trim() : "";
  if (title !== "") return { task: title, task_source: "title" };

  const firstUser = thread.find(
    (e) => e.role === "user" && e.kind !== "tool_result" && typeof e.content === "string",
  );
  const content = firstUser?.content ?? "";
  const bolded = boldedPhrase(content);
  if (bolded !== null) return { task: bolded, task_source: "user_entry" };

  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line !== undefined) {
    return { task: clipVerbatim(line, SNIPPET_MAX).text, task_source: "user_entry" };
  }
  return { task: "(no task recorded)", task_source: "none" };
}

/** `metadata.current_activity.text`, when the executor stamped one. */
function currentActivityText(metadata: Record<string, unknown> | undefined): string | null {
  const v = metadata?.current_activity;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const text = (v as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

/* ── the derivation ───────────────────────────────────────────────────────── */

/**
 * Derive the digest. Pure: same `(run, thread)` in, same digest out, forever.
 *
 * `thread` is passed separately from `run.thread` on purpose — that is what
 * lets a sub-agent view derive its OWN digest from
 * `subagentTranscript(run.thread, toolUseId)` without a second endpoint (there
 * is no sub-agent run row to fetch; see subagent-slice.ts).
 *
 * `ownerToolUseId` IS NOT OPTIONAL DECORATION. Pass it whenever the thread is
 * a sub-agent's, and the digest is then about that sub-agent: its own entries
 * are the ones stamped with the owner's id (plus the envelope the parent
 * recorded), it is excluded from its own roster, and "delegated" means what
 * IT delegated. Round 605's defect is what happens without it — a
 * `subagentTranscript` has top-level entries (the spawn call and its result),
 * so `sliceOwnerId` cannot recognise it as a slice, and a scout was listed as
 * its own sub-agent with "2 its own, 118 delegated" over 118 entries that were
 * all its own. Inference is the fallback for callers that genuinely cannot
 * know; every caller in this app knows.
 *
 * PROSE SCOPE, stated so it is never a surprise: the prose layer reads the
 * agent's OWN entries — a parent's story must not quote its sub-agents'
 * chatter as its own, and a sub-agent's must not quote a grandchild's.
 * `prose_scope` reports which of the two shapes was read.
 */
export function deriveDigest(
  run: RunDetail,
  thread: readonly ThreadEntry[],
  ownerToolUseId: string | null = null,
): StoryDigest {
  const entries: readonly ThreadEntry[] = Array.isArray(thread) ? thread : [];
  const metadata =
    run.metadata !== null && typeof run.metadata === "object"
      ? (run.metadata as Record<string, unknown>)
      : undefined;

  /* Who this digest is about. Told, or — for a caller that hands over a pure
   * slice and nothing else — inferred from the slice itself. */
  const owner =
    typeof ownerToolUseId === "string" && ownerToolUseId !== ""
      ? ownerToolUseId
      : sliceOwnerId(entries);

  /* This agent's own work vs work it handed to a sub-agent. With `owner ===
   * null` (a session) this is exactly `topLevelEntries`; with an owner it also
   * keeps the entries stamped to that owner, which are the sub-agent's own
   * steps, and the envelope, which is the only record of its brief and its
   * report. What is left over is delegated — a grandchild's, never its. */
  const own =
    owner === null
      ? topLevelEntries(entries)
      : entries.filter((e) => {
          const parent = parentToolUseId(e);
          return parent === null || parent === owner;
        });
  const proseScope: StoryDigest["prose_scope"] = owner === null ? "top-level" : "slice";

  const settled = SETTLED.has(run.status);
  const startedMs = parseMs(run.started_at);
  const completedMs = parseMs(run.completed_at);
  const elapsedMs =
    settled && startedMs !== null && completedMs !== null && completedMs >= startedMs
      ? completedMs - startedMs
      : null;

  /* Sub-agents OF THIS THREAD: the ones with entries here, plus the ones this
   * thread spawned that have not produced any yet. Both halves matter — a
   * sub-agent spawned one second ago belongs in the org chart, and a slice
   * must never inherit its parent's roster (hence `spawnRoles`, keyed on the
   * Agent/Task calls made here, not "every tool_use_id present"). */
  const index = subagentIndex(entries);
  /* Roles from the spawn calls IN this thread — `subagents_v2` is a rollup the
   * executor writes for some runs and not others (round 601B measured it empty
   * on both operator chats), while the spawn call carries
   * `input.subagent_type` on every run a reader can click. Reading only the
   * rollup is why round 604 caught the digest printing "unknown" one line
   * above a team panel printing "scout" for the same sub-agent
   * (`docs/plan/artifacts/phase600/README.md §6.1`). */
  const spawnedHere = spawnRoles(entries);
  // The owner's own id appears in its index AND, for a `subagentTranscript`,
  // in its spawn map — the envelope contains the very Agent call that started
  // it. It is this view's identity, not a child of it. Excluding it from both
  // is what keeps a scout from being its own scout.
  const merged = mergeSubagentMeta(metadata?.subagents_v2, index).filter(
    (s) =>
      s.tool_use_id !== owner &&
      (s.sliceCount > 0 || spawnedHere.has(s.tool_use_id)),
  );
  const known = new Set(merged.map((s) => s.tool_use_id));
  const roster: Array<{ id: string; role: string | null }> = merged.map((s) => ({
    id: s.tool_use_id,
    role: s.role ?? spawnedHere.get(s.tool_use_id) ?? null,
  }));
  for (const [id, role] of spawnedHere) {
    if (id === owner || known.has(id)) continue;
    roster.push({ id, role });
  }
  const roles: string[] = [];
  for (const s of roster) {
    // A role NEITHER the rollup nor the spawn call names reads "unknown" — the
    // sub-agent is real either way, and inventing a role would be worse than
    // saying so.
    const role = s.role ?? "unknown";
    if (!roles.includes(role)) roles.push(role);
  }

  /* The agent's own words: its own entries, never a child's. */
  const prose = own.filter(isProse);
  const snippets: DigestSnippet[] = prose
    .slice(-DIGEST_SNIPPETS)
    .map((e) => {
      const { text, clipped } = clipVerbatim(e.content, SNIPPET_MAX);
      return { ts: typeof e.ts === "string" ? e.ts : "", text, clipped };
    });

  const lastProse = prose.length > 0 ? prose[prose.length - 1] : null;
  const activity = currentActivityText(metadata);
  let outcome: string | null = null;
  let outcomeSource: StoryDigest["outcome_source"] = "none";
  if (lastProse !== null) {
    outcome = clipVerbatim(lastProse.content, OUTCOME_MAX).text;
    outcomeSource = "assistant_prose";
  } else if (activity !== null) {
    outcome = clipVerbatim(activity, OUTCOME_MAX).text;
    outcomeSource = "current_activity";
  }

  const { task, task_source } = deriveTask(run, entries);

  return {
    show: entries.length >= DIGEST_MIN_ENTRIES,

    task,
    task_source,

    started_at: typeof run.started_at === "string" ? run.started_at : null,
    elapsed_ms: elapsedMs,
    elapsed_frozen: elapsedMs !== null,
    status: run.status,
    settled,
    model: metaString(metadata, "model_resolved"),

    entry_count: entries.length,
    top_level_count: own.length,
    subagent_entry_count: entries.length - own.length,
    tool_call_count: entries.filter((e) => e.kind === "tool_call").length,
    error_count: entries.filter(isError).length,

    subagent_count: roster.length,
    subagent_roles: roles,

    prose_scope: proseScope,
    owner_tool_use_id: owner,
    snippets,
    outcome,
    outcome_source: outcomeSource,
  };
}
