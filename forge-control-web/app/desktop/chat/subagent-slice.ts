/**
 * subagent-slice.ts — cut a run's thread into the parent's story and its
 * sub-agents' stories (U23/U24, `13-ui-v3-architecture.md §8`).
 *
 * Pure, React-free, dependency-free. No fetch: there is nothing to fetch.
 *
 * THE WIRE FACT THIS FILE EXISTS FOR (verified round 600 against run
 * 3853c154-e07b-4378-9313-2b34f4a33342 — fixture under
 * docs/plan/artifacts/phase600/fixtures/):
 *
 *   Sub-agent entries are INLINE in the parent run's thread, tagged with
 *   `meta.parent_tool_use_id` = the `tool_use_id` of the Agent/Task tool_call
 *   that spawned them. There is NO separate run row for a sub-agent and NO
 *   endpoint that returns one. In that run, 196 of 285 entries belonged to
 *   sub-agents — read the thread naively and two thirds of what you show is
 *   somebody else's work attributed to the parent.
 *
 *   89 top-level + 118 + 78 = 285. That identity is the hard invariant below.
 *
 * HARD INVARIANT
 *   topLevelEntries(thread).length + Σ subagentEntries(thread, id).length
 *     === thread.length,   over every id in subagentIndex(thread).
 * No entry may be lost, and no entry may be counted twice. `partitionCheck`
 * states it executably; check-subagent-slice.ts runs it on real data.
 */

import type { ThreadEntry } from "../../api";

/** `meta.parent_tool_use_id` if present and non-empty, else null (top-level). */
export function parentToolUseId(entry: ThreadEntry): string | null {
  const v = entry.meta?.parent_tool_use_id;
  return typeof v === "string" && v !== "" ? v : null;
}

/** `meta.tool_use_id` if present and non-empty, else null. */
export function toolUseId(entry: ThreadEntry): string | null {
  const v = entry.meta?.tool_use_id;
  return typeof v === "string" && v !== "" ? v : null;
}

/** The parent run's own entries: everything NOT tagged to a sub-agent. */
export function topLevelEntries(
  thread: readonly ThreadEntry[],
): ThreadEntry[] {
  return thread.filter((e) => parentToolUseId(e) === null);
}

/** One sub-agent's slice, in thread order. Unknown id → empty array. */
export function subagentEntries(
  thread: readonly ThreadEntry[],
  toolUseIdValue: string,
): ThreadEntry[] {
  if (typeof toolUseIdValue !== "string" || toolUseIdValue === "") return [];
  return thread.filter((e) => parentToolUseId(e) === toolUseIdValue);
}

/** The tool names that spawn an in-process sub-agent. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** What a spawn call's own `input` declares about the sub-agent it starts. */
export interface SpawnInput {
  role: string | null;
  description: string | null;
}

/**
 * Read an Agent/Task `tool_call`'s `meta.input`, which is a JSON STRING on the
 * wire: `{"description":"…","subagent_type":"architect",…}`.
 *
 * This is THE reader for that field on the client — `AgentChatView` (the
 * drilled header) and `spawnRoles` (the digest roster) both call it, because
 * round 604 measured what happens when two surfaces read the same fact from
 * different places: the panel said `scout` and the digest said `unknown`
 * (`docs/plan/artifacts/phase600/README.md §6.1`). Server-side the same read
 * lives in `agents-shared.ts:243-256`.
 *
 * An unparsable input yields nulls rather than a guess. Note what is NOT done
 * here: `foldSubagents` falls back to the description and then to the literal
 * `"agent"` so a panel row always has a label. A digest roster is a list of
 * ROLES, and a one-sentence description or a filler word in it is worse than
 * saying the role is unknown, so that fallback stops at the server.
 */
export function parseSpawnInput(input: unknown): SpawnInput {
  if (typeof input !== "string" || input === "") return { role: null, description: null };
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { role: null, description: null };
    }
    const o = parsed as Record<string, unknown>;
    return {
      role: typeof o.subagent_type === "string" && o.subagent_type ? o.subagent_type : null,
      description: typeof o.description === "string" && o.description ? o.description : null,
    };
  } catch {
    return { role: null, description: null };
  }
}

/**
 * Every Agent/Task call made IN this thread, mapped to the role it declared —
 * `meta.spawns_subagent_role` when the executor stamped one, else the spawn's
 * own `input.subagent_type`, else null for "the spawn exists but named no
 * role". Same two sources in the same order as `foldSubagents` and the drilled
 * header, so the three surfaces cannot disagree about a fact all three have.
 */
export function spawnRoles(thread: readonly ThreadEntry[]): Map<string, string | null> {
  const roles = new Map<string, string | null>();
  for (const entry of thread) {
    if (entry.kind !== "tool_call") continue;
    const tool = entry.meta?.tool;
    if (typeof tool !== "string" || !SPAWN_TOOLS.has(tool)) continue;
    const id = toolUseId(entry);
    if (id === null) continue;
    const stamped = entry.meta?.spawns_subagent_role;
    const role =
      typeof stamped === "string" && stamped !== ""
        ? stamped
        : parseSpawnInput(entry.meta?.input).role;
    roles.set(id, role);
  }
  return roles;
}

/**
 * The `tool_use_id`s of the Agent/Task calls made IN this thread — i.e. the
 * sub-agents this thread is the parent of, whether or not they have produced
 * entries or metadata yet.
 *
 * Necessarily narrower than "every tool_use_id present": a sub-agent's slice
 * carries its own inner tool ids, and one of them can collide with the spawn
 * id, which would make a slice look like the parent of its own spawner.
 *
 * Derived from `spawnRoles` rather than walking the thread a second time: the
 * set of spawns and the roles of those spawns must never be able to drift.
 */
export function spawnToolUseIds(thread: readonly ThreadEntry[]): Set<string> {
  return new Set(spawnRoles(thread).keys());
}

/**
 * A sub-agent's transcript: its own entries PLUS the envelope that framed it.
 *
 * `subagentEntries` gives the inner steps — the entries stamped
 * `meta.parent_tool_use_id`. On runs the executor stamped, that is the whole
 * story and there are hundreds of them. On older runs there are ZERO, and the
 * only two entries attributable to the sub-agent with certainty are the spawn
 * `tool_call` (the brief it was given) and its `tool_result` (what it reported
 * back) — both carrying `meta.tool_use_id === id`.
 *
 * Those two are the envelope. Including them is derivation, not invention:
 * every entry here is one the executor wrote and tagged with THIS id. Order is
 * thread order, so the brief opens and the report closes, whatever lies
 * between.
 *
 * It lives here rather than in `AgentChatView` (round 603's home for it)
 * because it is pure thread arithmetic with no React in it, and because a
 * check script must be able to feed the REAL drilled-view input to
 * `deriveDigest` — round 605 caught a defect that a hand-built pure slice
 * could not have caught, precisely because it was not this function's output.
 */
export function subagentTranscript(
  thread: readonly ThreadEntry[],
  toolUseIdValue: string,
): ThreadEntry[] {
  const inner = new Set(subagentEntries(thread, toolUseIdValue));
  return thread.filter((e) => inner.has(e) || e.meta?.tool_use_id === toolUseIdValue);
}

/**
 * When `thread` is a PURE sub-agent slice rather than a whole run, this is the
 * `tool_use_id` that slice belongs to — its owner, not one of its children.
 *
 * A whole run has top-level entries and returns null. A pure slice has none,
 * and its first entry is the sub-agent's own opening move, so that entry's
 * `parent_tool_use_id` names the owner. Callers need this because a slice's
 * own id shows up in `subagentIndex(slice)`, where it would otherwise read as
 * a sub-agent of itself.
 *
 * LIMIT, and it is not a small one: it CANNOT see the owner of a
 * `subagentTranscript` — the envelope entries are top-level by construction,
 * so this returns null and the sub-agent reads as its own child. That is the
 * round-605 defect. Anything that knows the owner id must pass it explicitly
 * (`deriveDigest`'s third argument); this function is the last resort for a
 * caller that does not.
 */
export function sliceOwnerId(thread: readonly ThreadEntry[]): string | null {
  if (thread.length === 0) return null;
  for (const entry of thread) {
    if (parentToolUseId(entry) === null) return null; // a whole run, not a slice
  }
  return parentToolUseId(thread[0]);
}

export interface SubagentSliceStat {
  /** Entries in this slice. */
  count: number;
  /**
   * `ts` of the slice's first and last entry **in thread order**. The thread
   * is append-ordered by the executor, so this is chronological; it is NOT a
   * min/max over parsed dates, because an unparsable `ts` must not silently
   * reorder the story.
   */
  firstTs: string | null;
  lastTs: string | null;
}

/**
 * Every sub-agent that actually has entries in this thread, keyed by the
 * spawning tool_use_id, in order of first appearance. Built in one pass.
 */
export function subagentIndex(
  thread: readonly ThreadEntry[],
): Map<string, SubagentSliceStat> {
  const index = new Map<string, SubagentSliceStat>();
  for (const entry of thread) {
    const parent = parentToolUseId(entry);
    if (parent === null) continue;
    const ts = typeof entry.ts === "string" ? entry.ts : null;
    const existing = index.get(parent);
    if (existing === undefined) {
      index.set(parent, { count: 1, firstTs: ts, lastTs: ts });
    } else {
      existing.count += 1;
      existing.lastTs = ts;
    }
  }
  return index;
}

/**
 * Executable statement of the hard invariant. Returns the arithmetic instead
 * of throwing, so callers (and the check script) decide what to do with a
 * violation — but `ok === false` is never something to render past.
 */
export function partitionCheck(thread: readonly ThreadEntry[]): {
  ok: boolean;
  total: number;
  topLevel: number;
  sliced: number;
} {
  const total = thread.length;
  const topLevel = topLevelEntries(thread).length;
  let sliced = 0;
  for (const stat of subagentIndex(thread).values()) sliced += stat.count;
  return { ok: topLevel + sliced === total, total, topLevel, sliced };
}

/* ── metadata.subagents_v2 ────────────────────────────────────────────────── */

export interface SubagentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface SubagentActivity {
  kind: string | null;
  tool: string | null;
  text: string | null;
  ts: string | null;
}

/**
 * One entry of `run.metadata.subagents_v2`, normalized. Field names and the
 * `usage` key spelling (`input_tokens`, not `input`) are what the executor
 * actually writes — confirmed against the round-600 fixture.
 */
export interface SubagentMeta {
  tool_use_id: string;
  role: string | null;
  model: string | null;
  description: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
  event_count: number | null;
  usage: SubagentUsage | null;
  latest_activity: SubagentActivity | null;
}

function optString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function optNumber(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optUsage(o: Record<string, unknown>): SubagentUsage | null {
  const v = o.usage;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  const n = (key: string): number => (typeof u[key] === "number" ? (u[key] as number) : 0);
  return {
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_read_input_tokens: n("cache_read_input_tokens"),
    cache_creation_input_tokens: n("cache_creation_input_tokens"),
  };
}

function optActivity(o: Record<string, unknown>): SubagentActivity | null {
  const v = o.latest_activity;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  return {
    kind: optString(a, "kind"),
    tool: optString(a, "tool"),
    text: optString(a, "text"),
    ts: optString(a, "ts"),
  };
}

/**
 * Normalize `run.metadata.subagents_v2` (typed `unknown` because `metadata` is
 * `Record<string, unknown>` on the wire). Entries without a usable
 * `tool_use_id` are dropped — they cannot be joined to a slice, so keeping
 * them would put an unaddressable row in the org chart.
 */
export function parseSubagentsV2(value: unknown): SubagentMeta[] {
  if (!Array.isArray(value)) return [];
  const out: SubagentMeta[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const id = optString(o, "tool_use_id");
    if (id === null) continue;
    out.push({
      tool_use_id: id,
      role: optString(o, "role"),
      model: optString(o, "model"),
      description: optString(o, "description"),
      status: optString(o, "status"),
      started_at: optString(o, "started_at"),
      ended_at: optString(o, "ended_at"),
      updated_at: optString(o, "updated_at"),
      event_count: optNumber(o, "event_count"),
      usage: optUsage(o),
      latest_activity: optActivity(o),
    });
  }
  return out;
}

/**
 * A declared sub-agent joined to the slice it actually owns in the thread.
 * The three discrepancy flags exist because NFU6 forbids silent fallbacks:
 * when metadata and thread disagree, the UI shows that they disagree.
 */
export interface MergedSubagent extends SubagentMeta {
  /** Entries found in the thread for this tool_use_id. */
  sliceCount: number;
  firstTs: string | null;
  lastTs: string | null;
  /** Thread has entries for it, `subagents_v2` never declared it. */
  metaMissing: boolean;
  /** Declared, but the thread carries none of its entries (yet). */
  sliceMissing: boolean;
  /** Declared `event_count` disagrees with the entries actually present. */
  eventCountMismatch: boolean;
}

/**
 * Join `subagents_v2` to `subagentIndex`. Declared sub-agents come first in
 * declaration order, then any thread-only ids in first-appearance order — an
 * undeclared sub-agent is a real one whose metadata has not been flushed yet,
 * so it is listed (flagged `metaMissing`), never dropped.
 */
export function mergeSubagentMeta(
  subagentsV2: unknown,
  index: ReadonlyMap<string, SubagentSliceStat>,
): MergedSubagent[] {
  const declared = parseSubagentsV2(subagentsV2);
  const seen = new Set<string>();
  const merged: MergedSubagent[] = [];

  for (const meta of declared) {
    if (seen.has(meta.tool_use_id)) continue;
    seen.add(meta.tool_use_id);
    const stat = index.get(meta.tool_use_id);
    const sliceCount = stat?.count ?? 0;
    merged.push({
      ...meta,
      sliceCount,
      firstTs: stat?.firstTs ?? null,
      lastTs: stat?.lastTs ?? null,
      metaMissing: false,
      sliceMissing: stat === undefined,
      eventCountMismatch:
        meta.event_count !== null && meta.event_count !== sliceCount,
    });
  }

  for (const [id, stat] of index) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({
      tool_use_id: id,
      role: null,
      model: null,
      description: null,
      status: null,
      started_at: null,
      ended_at: null,
      updated_at: null,
      event_count: null,
      usage: null,
      latest_activity: null,
      sliceCount: stat.count,
      firstTs: stat.firstTs,
      lastTs: stat.lastTs,
      metaMissing: true,
      sliceMissing: false,
      eventCountMismatch: false,
    });
  }

  return merged;
}
