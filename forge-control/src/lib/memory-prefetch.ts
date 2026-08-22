/**
 * Pre-turn memory prefetch — pattern lifted from NousResearch/hermes-agent
 * agent/memory_manager.py (concept; MIT). Before every turn we look at the
 * user's latest message, run a vector search against knowledge_embeddings
 * (see db/memory.ts), and prepend a compact `[MEMORY]` block to the prompt.
 *
 * Why: claude-pool's underlying model has no access to Konrad's Obsidian
 * vault or the indexed HCP message corpus. Without this, the assistant
 * answers from training data only and re-derives facts the system already
 * knows. With it, recent decisions / standing preferences / project state
 * land in-context before the assistant generates anything.
 *
 * 2026-08-05 rework — §4.E of `rework-2026-08-04/03-rag-audit.md`. The old
 * composer took 5 vector + 3 graph hits at 320 chars each and prepended ~2.6 KB
 * on every turn, with no score floor and no per-note dedupe; the audit's
 * simulation showed "Can you check the reelforge pipeline" producing five
 * copies of the same rolling-log note. Four changes:
 *
 *   1. Budget       — the whole block is capped at ~400 tokens. Snippet length
 *                     is derived from what's left, not fixed.
 *   2. Diversity    — one chunk per source note, 3–5 distinct notes.
 *   3. Skip rules   — no hits above the floor, or a contentless control turn
 *                     ("restart forge-control", "yes", "continue") → no block
 *                     at all. A wrong-context block is worse than none: the
 *                     model treats it as relevant because it is present.
 *   4. Query build  — the raw message is stripped of greetings/fillers, and a
 *                     thin turn ("do it") is augmented with the thread's
 *                     running topic instead of being embedded as-is.
 *
 * The GraphRAG lane is deliberately not used here. Per audit §4.C every triple
 * in the store was extracted from agent messages, so the lane can only inject
 * June job-state noise; it stays out of the prompt until vault-derived triples
 * exist (db/memory.ts `graphLaneStatus()` guards the search API's copy of the
 * same decision).
 *
 * Post-turn memory write-back (taking the assistant response and pushing it
 * into the embedding/triple store) is deferred — km-indexer already owns
 * vault-file ingestion and the assistant text isn't yet captured anywhere
 * the indexer can reach.
 */

import { searchMemory, type SearchHitWithLane } from "../db/memory.ts";
import { noteMtimeMs, SCORE_FLOOR } from "./memory-ranking.ts";

const PREFETCH_ENABLED = (process.env.MEMORY_PREFETCH_ENABLED ?? "1") !== "0";

/** Distinct source notes to aim for. The audit's recommendation: "prefer 3
 *  relevant notes over 5 slots force-filled". */
const MAX_NOTES = Number(process.env.MEMORY_PREFETCH_MAX_NOTES ?? "5");

/** Whole-block ceiling. ~4 chars/token → 1,400 chars ≈ 350–400 tokens, the
 *  budget the audit set. Overruns are prevented structurally (snippets are
 *  sized from the remaining budget), not trimmed after the fact. */
const BLOCK_CHAR_BUDGET = Number(
  process.env.MEMORY_PREFETCH_BLOCK_CHARS ?? "1400",
);

/** Per-snippet bounds. Below MIN a snippet carries no usable fact, so we drop
 *  the hit rather than emit a stub; above MAX one note would eat the budget. */
const SNIPPET_MIN = 110;
const SNIPPET_MAX = 300;

/** A cleaned query shorter than this is treated as thin and gets augmented
 *  with the thread's running topic before it is embedded. */
const THIN_QUERY_CHARS = Number(
  process.env.MEMORY_PREFETCH_THIN_QUERY_CHARS ?? "48",
);

/** Hard minimum after augmentation — below this there is nothing to retrieve
 *  on and any hit is coincidence. */
const MIN_QUERY_CHARS = Number(
  process.env.MEMORY_PREFETCH_MIN_QUERY_CHARS ?? "16",
);

/** Cap on the augmented query. BGE-M3 truncates long inputs anyway, and a
 *  query dominated by history stops describing the current turn. */
const MAX_QUERY_CHARS = 600;

/** Prefetch's own floor. Defaults to the search floor — a block built from
 *  sub-floor hits is the "confident noise" failure the audit called out. */
const PREFETCH_FLOOR = Number(
  process.env.MEMORY_PREFETCH_FLOOR ?? String(SCORE_FLOOR),
);

export interface PrefetchedMemory {
  hits: SearchHitWithLane[];
  block: string | null;
  /** Why the block is null (or which query produced it). Logged by the
   *  executor so a missing [MEMORY] block is explicable after the fact. */
  reason: string;
  query: string | null;
}

export interface ThreadTurn {
  role: string;
  content: string;
}

/* ---------------------------------------------------------------------------
 * Query construction
 * ------------------------------------------------------------------------- */

/** Conversational scaffolding that carries no retrievable content. Stripped
 *  from the head of the message only — "can you check X" must keep "check X",
 *  and a mid-sentence "please" is left alone. */
const LEADING_FILLER_RE =
  /^(?:\s*(?:hey|hi|hello|yo|good (?:morning|afternoon|evening)|ok(?:ay)?|so|right|alright|well|um|uh|please|thanks|thank you|cheers|claude|vps ?cat|hermes)\b[\s,.!:—-]*)+/i;

/** Polite request wrappers. Same rule: head of the message only. */
const LEADING_REQUEST_RE =
  /^(?:\s*(?:can you|could you|would you|will you|i(?:'d| would) like you to|i want you to|i need you to|let'?s|lets)\b[\s,]*)+/i;

/** Contentless control turns. These are instructions about the *session*, not
 *  questions about Konrad's world, and the audit found them prefetching
 *  garbage. The whole message must consist of these tokens — real turns like
 *  "great, now compare that with the Jersey script" contain a token the list
 *  doesn't cover and fall through to normal retrieval. Compound
 *  acknowledgements ("yes, do it", "ok go ahead") are the common case, hence
 *  the repeated group rather than a single alternation. */
const CONTROL_TOKEN =
  "y(?:es|ep|eah)?|no(?:pe)?|ok(?:ay)?|sure|go(?: on| ahead)?|do it|ship it|send it|continue|carry on|proceed|next|again|retry|redo|stop|halt|pause|abort|cancel|wait|hold on|nvm|never ?mind|thanks?|thank you|ty|👍|\\+1|done|fine|good|great|perfect|nice|k";
const CONTROL_TURN_RE = new RegExp(
  `^(?:(?:${CONTROL_TOKEN})[\\s,.!?:;—–-]*)+$`,
  "i",
);

/** Short operational commands: a verb from the ops vocabulary plus a target,
 *  nothing else — "restart forge-control", "deploy", "tail the logs".
 *
 *  Deliberately narrow. An earlier draft included the generic verbs (check,
 *  run, test, status, build); those swallow real questions — "check the Cyprus
 *  relocation tax numbers" is a retrieval-worthy turn that happens to start
 *  with an imperative. Only verbs that can only mean process control are
 *  listed, and only while the whole message stays short. */
const OPS_COMMAND_RE =
  /^(?:restart|reboot|redeploy|deploy|rebuild|kill|tail|pm2|systemctl|docker|git|npm|pnpm)\b[\w\s./:@-]{0,40}$/i;

export function stripFillers(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(LEADING_FILLER_RE, "").replace(LEADING_REQUEST_RE, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** True when the turn is a control/acknowledgement with no topical content. */
export function isControlTurn(cleaned: string): boolean {
  if (!cleaned) return true;
  if (CONTROL_TURN_RE.test(cleaned)) return true;
  // Ops commands only count as contentless while they stay short; the length
  // bound is in the regex so "restart X because <long explanation>" falls
  // through to normal retrieval.
  return OPS_COMMAND_RE.test(cleaned);
}

/** The thread's running topic: the most recent substantive *earlier* user turn
 *  plus the opening of the last assistant turn. Used only to rescue a thin
 *  message ("do it", "and the second one?") — a self-contained question is
 *  embedded on its own so history can't dilute it. */
export function runningTopic(thread: ThreadTurn[]): string {
  let priorUser = "";
  let lastAssistant = "";
  let seenLastUser = false;

  for (let i = thread.length - 1; i >= 0; i--) {
    const t = thread[i];
    if (!t?.content) continue;
    if (t.role === "user") {
      if (!seenLastUser) {
        seenLastUser = true; // this is the turn being prefetched for; skip it
        continue;
      }
      if (!priorUser) {
        const cleaned = stripFillers(t.content);
        if (!isControlTurn(cleaned)) priorUser = cleaned;
      }
    } else if (t.role === "assistant" && !lastAssistant) {
      lastAssistant = t.content.trim();
    }
    if (priorUser && lastAssistant) break;
  }

  const parts = [
    priorUser.slice(0, 300),
    // First couple of sentences of the assistant's reply approximate what the
    // thread is *about* without pulling in a wall of generated text.
    lastAssistant.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 200),
  ].filter(Boolean);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export interface QueryPlan {
  query: string | null;
  reason: string;
}

/** Decide what (if anything) to embed for this turn. */
export function buildPrefetchQuery(thread: ThreadTurn[]): QueryPlan {
  const last = lastUserText(thread);
  if (!last) return { query: null, reason: "no user turn in thread" };

  const cleaned = stripFillers(last);
  if (isControlTurn(cleaned)) {
    return { query: null, reason: `control turn ("${cleaned.slice(0, 40)}")` };
  }

  if (cleaned.length >= THIN_QUERY_CHARS) {
    return { query: cleaned.slice(0, MAX_QUERY_CHARS), reason: "user turn" };
  }

  // Thin turn: rescue it with the thread's running topic rather than embedding
  // a fragment that will match arbitrary notes.
  const topic = runningTopic(thread);
  if (!topic) {
    return cleaned.length >= MIN_QUERY_CHARS
      ? { query: cleaned, reason: "short user turn, no thread topic available" }
      : { query: null, reason: `turn too short (${cleaned.length} chars), no thread topic` };
  }
  const augmented = `${cleaned}\n\nThread context: ${topic}`.slice(
    0,
    MAX_QUERY_CHARS,
  );
  return { query: augmented, reason: "thin user turn augmented with thread topic" };
}

/* ---------------------------------------------------------------------------
 * Block composition
 * ------------------------------------------------------------------------- */

const BLOCK_HEADER = [
  "[MEMORY]",
  "Retrieved from Konrad's knowledge base for this turn — vault notes and past " +
    "chats (`chat://<run id>`). Reference material — NOT the active instruction. " +
    "Each entry: title — path · type · date.",
  "",
].join("\n");
const BLOCK_FOOTER = "[END MEMORY]\n";

function editedLabel(hit: { vault_path: string; source_ts?: string }): string {
  const ms = noteMtimeMs(hit.vault_path);
  if (ms !== null) return `edited ${new Date(ms).toISOString().slice(0, 10)}`;
  /* A `chat://…` hit has no file to stat, but its date is NOT unknown — the
   * indexer recorded it and searchMemory carries it through. Printing "date
   * unknown" beside a conversation we can date exactly would blind the model
   * in the one block whose job is to orient it in time. */
  if (hit.source_ts) {
    const parsed = Date.parse(hit.source_ts);
    if (!Number.isNaN(parsed)) {
      return `held ${new Date(parsed).toISOString().slice(0, 10)}`;
    }
  }
  return "date unknown";
}

/** `"\n  "` before the snippet plus the `"\n"` that terminates the entry. */
const ENTRY_OVERHEAD = 4;

function headLine(h: SearchHitWithLane): string {
  const kind = h.note_kind ?? "note";
  return `- ${h.title || h.slug} — ${h.vault_path} · ${kind} · ${editedLabel(h)} (${h.score.toFixed(2)})`;
}

export interface ComposedBlock {
  block: string;
  /** The hits that actually made it into the block, in order. Fewer than were
   *  passed in when the budget could not seat them all. */
  used: SearchHitWithLane[];
}

/**
 * Build the `[MEMORY]` block. One entry per source note; entry headers carry
 * title, path, note type and last-edited date so the model can judge staleness
 * itself (scores alone, which is all the old block showed, mean nothing to it).
 *
 * Budget allocation is two-pass rather than greedy. First: how many of the
 * hits can be seated at SNIPPET_MIN each? Header lengths vary by a factor of
 * two (`Mentor/PERSONA.md` vs `AI OS/Specs/Directory + Business Plan Hub —
 * Business Model.md`), so a greedy walk that stopped at the first entry which
 * couldn't afford its equal share would drop the four hits behind it as well —
 * measured: five good hits rendered as one. Second: the leftover budget is
 * split evenly across the seated entries as extra snippet length.
 *
 * Returns null when nothing fits — an empty `[MEMORY]` shell must never be
 * emitted.
 */
export function composeMemoryBlock(
  hits: SearchHitWithLane[],
): ComposedBlock | null {
  if (hits.length === 0) return null;

  const budget = BLOCK_CHAR_BUDGET - BLOCK_HEADER.length - BLOCK_FOOTER.length;
  const heads = hits.map(headLine);

  const fixedCost = (n: number): number =>
    heads
      .slice(0, n)
      .reduce((acc, h) => acc + h.length + ENTRY_OVERHEAD + SNIPPET_MIN, 0);

  let seated = hits.length;
  while (seated > 0 && fixedCost(seated) > budget) seated--;
  if (seated === 0) return null;

  const spare = budget - fixedCost(seated);
  const bonus = Math.floor(spare / seated);

  const entries: string[] = [];
  for (let i = 0; i < seated; i++) {
    const snippetChars = Math.min(SNIPPET_MAX, SNIPPET_MIN + bonus);
    const snippet = hits[i].snippet
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, snippetChars);
    entries.push(`${heads[i]}\n  ${snippet}`);
  }

  return {
    block: `${BLOCK_HEADER}${entries.join("\n")}\n${BLOCK_FOOTER}`,
    used: hits.slice(0, seated),
  };
}

/* ---------------------------------------------------------------------------
 * Entry points
 * ------------------------------------------------------------------------- */

/**
 * Prefetch for one turn. `thread` is preferred — it enables the thin-turn
 * augmentation. A bare string still works and is treated as a one-turn thread.
 */
export async function prefetchMemoryForUserTurn(
  input: string | ThreadTurn[],
): Promise<PrefetchedMemory> {
  const empty = (reason: string, query: string | null = null): PrefetchedMemory => ({
    hits: [],
    block: null,
    reason,
    query,
  });

  if (!PREFETCH_ENABLED) return empty("disabled by MEMORY_PREFETCH_ENABLED");

  const thread: ThreadTurn[] =
    typeof input === "string" ? [{ role: "user", content: input }] : input;
  const plan = buildPrefetchQuery(thread);
  if (!plan.query) return empty(`skipped — ${plan.reason}`);

  let hits: SearchHitWithLane[];
  try {
    // Vector lane only, one chunk per note. maxPerNote=1 is what makes the
    // block diverse; the search API's default of 2 is right for a UI list but
    // wrong for a 400-token prompt budget.
    const raw = await searchMemory(plan.query, MAX_NOTES, {
      maxPerNote: 1,
      floor: PREFETCH_FLOOR,
      snippetChars: SNIPPET_MAX,
    });
    hits = raw.map((h) => ({ ...h, via: "vector" as const, hop: 0 }));
  } catch (e) {
    console.warn(
      "[memory-prefetch] search failed — skipping prefetch:",
      e instanceof Error ? e.message : e,
    );
    return empty("search failed", plan.query);
  }

  if (hits.length === 0) {
    // Either nothing matched or everything was under the floor. Both mean the
    // same thing for the prompt: say nothing.
    return empty(`no hits at or above floor ${PREFETCH_FLOOR}`, plan.query);
  }

  const composed = composeMemoryBlock(hits);
  if (!composed) return empty("block budget left no room for a snippet", plan.query);

  // Report what was actually prepended, not what was retrieved — the two
  // differ when the budget cannot seat every hit.
  return {
    hits: composed.used,
    block: composed.block,
    reason: `${composed.used.length} notes via ${plan.reason}`,
    query: plan.query,
  };
}

/** Find the most recent user turn in a thread, or null if none. Used by the
 *  executor to derive the prefetch query without coupling the memory module
 *  to the ThreadEntry type. */
export function lastUserText(thread: ThreadTurn[]): string | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i];
    if (e.role === "user" && e.content) return e.content;
  }
  return null;
}
