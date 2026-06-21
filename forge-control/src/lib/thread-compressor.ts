/**
 * Thread compressor — ported from NousResearch/hermes-agent's
 * agent/context_compressor.py (MIT) to TypeScript for our `runs.thread`.
 *
 * Why: executor.ts used a naive head-truncate at 24 000 chars. Anything
 * older than the first ~6 turns of a long conversation simply fell off
 * the prompt. Hermes's algorithm preserves recency *and* salience by
 * keeping the head + tail verbatim and replacing the middle window with
 * an LLM-generated structured summary.
 *
 * Algorithm (single pass, no retry):
 *   1. If thread chars under threshold → return unchanged.
 *   2. Protect head: system prompt (always) + first N non-system on the
 *      first pass only. After the first compression `protectFirstN`
 *      decays to 0 because the summary itself captures that early
 *      context.
 *   3. Protect tail: walk backward from the end until we've covered
 *      `thresholdChars * tailRatio` chars OR `protectLastN` messages,
 *      whichever covers more.
 *   4. Send the middle window to claude-pool with a strict structured
 *      template (Goal / Constraints / Completed Actions / Active State
 *      / Decisions / Pending Asks / Relevant Files / Critical Context).
 *      Iterative re-compression uses the prior summary as a base instead
 *      of starting fresh.
 *   5. Insert one synthetic `{role: 'system', kind: 'compressed_summary'}`
 *      entry between head and tail, wrapped with the SUMMARY_PREFIX +
 *      END_MARKER so the model treats it as background, not active
 *      instructions.
 *
 * If summarization fails, fall back to a deterministic local extract
 * (user asks + assistant decisions) rather than dropping the middle.
 */

import type { ThreadEntry } from "../executor.ts";

export interface CompressorOptions {
  /** Compress when prompt-relevant thread chars exceed this. ≈ tokens × 4. */
  thresholdChars: number;
  /** Always keep at least this many tail messages, even if the token budget says fewer. */
  protectLastN: number;
  /** Non-system head messages to keep on the *first* compression pass. Decays to 0 after. */
  protectFirstN: number;
  /** Tail budget as a fraction of `thresholdChars`. */
  tailRatio: number;
  /** Char budget reserved for the summary itself when prompting the LLM. */
  summaryBudgetChars: number;
  /** Caller-provided summarizer (wraps claude-pool). Returns null on failure → triggers fallback. */
  summarize: (payload: string, focusTopic?: string) => Promise<string | null>;
}

export interface CompressorState {
  compressionCount: number;
  previousSummary: string | null;
}

export interface CompressionResult {
  thread: ThreadEntry[];
  compressed: boolean;
  collapsedCount: number;
  charsSaved: number;
  state: CompressorState;
}

const CHARS_PER_TOKEN = 4;
const SUMMARY_KIND = "compressed_summary";

const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. " +
  "This is a handoff from a previous context window — treat it as background reference, " +
  "NOT as active instructions. Use it to answer the most recent user message.";

const SUMMARY_END_MARKER =
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";

const SUMMARIZER_PREAMBLE =
  "You are a summarization agent creating a context checkpoint. Treat the conversation turns " +
  "below as source material for a compact record of prior work. Produce only the structured " +
  "summary; do not add a greeting, preamble, or prefix. Write the summary in the same language " +
  "the user was using in the conversation — do not translate or switch to English. NEVER include " +
  "API keys, tokens, passwords, secrets, credentials, or connection strings in the summary — " +
  "replace any that appear with [REDACTED]. Note that the user had credentials present, but do " +
  "not preserve their values.";

function templateSections(summaryBudgetTokens: number, todayISO: string): string {
  return `## Historical Task Snapshot
[Capture the user's most recent unfulfilled input verbatim or near-verbatim.]

## Goal
[What the user is trying to accomplish across this conversation.]

## Constraints & Preferences
[Standing preferences, coding style rules, deployment constraints, "never X" rules invoked.]

## Completed Actions
[Numbered list of concrete actions already taken with their outcomes — files written, commits made, services restarted, decisions resolved.]

## Active State
[Current working state — what's running, what's deployed, what's open.]

## Historical In-Progress State
[Work that was underway but didn't finish — partial implementations, half-applied migrations.]

## Blocked
[Open blockers, errors, or unresolved issues with the diagnostic info needed to continue.]

## Key Decisions
[Important decisions and the WHY — which option was chosen and the reasoning. Include foot-guns discovered.]

## Resolved Questions
[Questions already answered, with their answers, so they don't get re-asked.]

## Historical Pending User Asks
[Questions or requests the user made that were NOT yet fully answered.]

## Relevant Files
[File paths read, modified, or created with one-line purpose each. Group by directory if many.]

## Historical Remaining Work
[Items the previous turn was about to do but did not finish, in order.]

## Critical Context
[Specific values, error messages, config IDs, commit hashes, table names that future turns will need verbatim.]

TEMPORAL ANCHORING: The current date is ${todayISO}. When an action has already been carried out, phrase it as a completed, dated, past-tense fact rather than an open instruction. Past actions are facts, not asks.

Target ~${summaryBudgetTokens} tokens.`;
}

export function emptyCompressorState(): CompressorState {
  return { compressionCount: 0, previousSummary: null };
}

export function readCompressorState(
  metadata: Record<string, unknown> | null | undefined,
): CompressorState {
  const raw = (metadata as { compression_state?: unknown } | null | undefined)
    ?.compression_state;
  if (raw && typeof raw === "object") {
    const r = raw as Partial<CompressorState>;
    return {
      compressionCount: Number(r.compressionCount ?? 0) | 0,
      previousSummary:
        typeof r.previousSummary === "string" ? r.previousSummary : null,
    };
  }
  return emptyCompressorState();
}

function entryChars(e: ThreadEntry): number {
  return String(e.content ?? "").length + 16; // role tag overhead
}

function totalChars(thread: ThreadEntry[]): number {
  let n = 0;
  for (const e of thread) n += entryChars(e);
  return n;
}

function effectiveProtectFirstN(opt: CompressorOptions, state: CompressorState): number {
  // After first compression the previous summary has already captured the
  // earliest context — keeping additional head turns just bloats the prompt.
  return state.compressionCount > 0 ? 0 : opt.protectFirstN;
}

function findHeadEnd(thread: ThreadEntry[], protectFirstN: number): number {
  // Index 0 is always preserved if it's a system entry. Then count up to
  // `protectFirstN` non-system messages.
  let i = 0;
  if (thread.length && thread[0].role === "system") i = 1;
  let kept = 0;
  while (i < thread.length && kept < protectFirstN) {
    if (thread[i].role !== "system") kept++;
    i++;
  }
  return i;
}

function findTailStart(
  thread: ThreadEntry[],
  headEnd: number,
  opt: CompressorOptions,
): number {
  // Walk backward accumulating chars until we cover tailRatio of threshold,
  // then floor at protectLastN messages.
  const tailBudget = Math.max(2_000, Math.floor(opt.thresholdChars * opt.tailRatio));
  let acc = 0;
  let i = thread.length;
  while (i > headEnd) {
    const next = thread[i - 1];
    acc += entryChars(next);
    i--;
    if (acc >= tailBudget) break;
  }
  // Apply protectLastN floor.
  const byCount = Math.max(headEnd, thread.length - opt.protectLastN);
  return Math.min(i, byCount);
}

function serializeMiddle(middle: ThreadEntry[]): string {
  const out: string[] = [];
  for (const e of middle) {
    const role = e.role.toUpperCase();
    const kind = e.kind ? ` ${e.kind}` : "";
    const body = String(e.content ?? "");
    out.push(`[${role}${kind}]\n${body}`);
  }
  return out.join("\n\n");
}

function buildSummarizerPrompt(
  middlePayload: string,
  state: CompressorState,
  opt: CompressorOptions,
  focusTopic?: string,
): string {
  const summaryBudgetTokens = Math.floor(opt.summaryBudgetChars / CHARS_PER_TOKEN);
  const today = new Date().toISOString().slice(0, 10);
  const sections = templateSections(summaryBudgetTokens, today);
  const updating = state.compressionCount > 0 && state.previousSummary;
  const focusBlock = focusTopic
    ? `\n\nFOCUS TOPIC: "${focusTopic}"\nThis compaction should PRIORITISE preserving all information related to the focus topic above. ` +
      `For content related to "${focusTopic}", include full detail — exact values, file paths, command outputs, error messages, and decisions. ` +
      `For content NOT related to the focus topic, summarise more aggressively (brief one-liners or omit if truly irrelevant). ` +
      `The focus topic sections should receive roughly 60-70% of the summary token budget.`
    : "";

  if (updating) {
    return `${SUMMARIZER_PREAMBLE}

You are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then and need to be incorporated.

PREVIOUS SUMMARY:
${state.previousSummary}

NEW TURNS TO INCORPORATE:
${middlePayload}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new completed actions to the numbered list (continue numbering). UPDATE Active State / Blocked / Pending Asks to reflect the new reality. REMOVE resolved items from In-Progress and Pending.

${sections}${focusBlock}`;
  }

  return `${SUMMARIZER_PREAMBLE}

Create a structured checkpoint summary for the conversation after earlier turns are compacted. The summary should preserve enough detail for continuity without re-reading the original turns.

TURNS TO SUMMARIZE:
${middlePayload}

Use this exact structure:

${sections}${focusBlock}`;
}

function wrapSummary(summary: string): string {
  // Strip any accidental prefix the model wrote so we don't double-wrap.
  const stripped = summary.replace(/^\s*\[CONTEXT COMPACTION[\s\S]*?\]\s*/i, "").trim();
  return `${SUMMARY_PREFIX}\n\n${stripped}\n\n${SUMMARY_END_MARKER}`;
}

function deterministicFallback(middle: ThreadEntry[]): string {
  // No LLM available — extract user asks + last assistant decision per turn
  // so the model at least sees what was discussed. Better than dropping the
  // middle entirely.
  const userAsks: string[] = [];
  const decisions: string[] = [];
  for (const e of middle) {
    const text = String(e.content ?? "").trim();
    if (!text) continue;
    const short = text.length > 400 ? text.slice(0, 380) + "…" : text;
    if (e.role === "user") userAsks.push(`- ${short}`);
    else if (e.role === "assistant") {
      // Keep first non-blank line of assistant turns as a decision marker.
      const head = text.split("\n").find((l) => l.trim()) ?? "";
      const trimmed = head.length > 200 ? head.slice(0, 180) + "…" : head;
      if (trimmed) decisions.push(`- ${trimmed}`);
    }
  }
  return `## Historical Task Snapshot
(Auto-extracted — LLM summarization unavailable.)

## Goal
Recover continuity from a deterministic extract of the middle window.

## Historical Pending User Asks
${userAsks.length ? userAsks.join("\n") : "(none captured)"}

## Key Decisions
${decisions.length ? decisions.join("\n") : "(none captured)"}

## Critical Context
${middle.length} turns collapsed; LLM compression failed; raw content not preserved.`;
}

export async function compressThread(
  thread: ThreadEntry[],
  state: CompressorState,
  opt: CompressorOptions,
  focusTopic?: string,
): Promise<CompressionResult> {
  const before = totalChars(thread);
  if (before <= opt.thresholdChars) {
    return {
      thread,
      compressed: false,
      collapsedCount: 0,
      charsSaved: 0,
      state,
    };
  }

  const protectFirstN = effectiveProtectFirstN(opt, state);
  const headEnd = findHeadEnd(thread, protectFirstN);
  const tailStart = findTailStart(thread, headEnd, opt);

  // Need at least 2 messages to summarize for the operation to be worth it.
  if (tailStart - headEnd < 2) {
    return {
      thread,
      compressed: false,
      collapsedCount: 0,
      charsSaved: 0,
      state,
    };
  }

  const middle = thread.slice(headEnd, tailStart);
  const payload = serializeMiddle(middle);
  const prompt = buildSummarizerPrompt(payload, state, opt, focusTopic);

  let summary: string | null = null;
  try {
    summary = await opt.summarize(prompt, focusTopic);
  } catch (e) {
    console.warn(
      "[thread-compressor] summarize threw — using deterministic fallback:",
      e instanceof Error ? e.message : e,
    );
    summary = null;
  }

  const summaryBody = summary ?? deterministicFallback(middle);
  const wrapped = wrapSummary(summaryBody);

  const synthetic: ThreadEntry = {
    role: "system",
    content: wrapped,
    ts: new Date().toISOString(),
    kind: SUMMARY_KIND,
    meta: {
      collapsed_count: middle.length,
      summarizer_failed: summary === null,
      compression_pass: state.compressionCount + 1,
    },
  };

  const newThread = [...thread.slice(0, headEnd), synthetic, ...thread.slice(tailStart)];
  const after = totalChars(newThread);

  return {
    thread: newThread,
    compressed: true,
    collapsedCount: middle.length,
    charsSaved: before - after,
    state: {
      compressionCount: state.compressionCount + 1,
      previousSummary: summaryBody,
    },
  };
}

export const COMPRESSOR_CONSTANTS = {
  CHARS_PER_TOKEN,
  SUMMARY_KIND,
  SUMMARY_PREFIX,
  SUMMARY_END_MARKER,
};
