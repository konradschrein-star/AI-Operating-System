/** Context-window occupancy for the chat the middle surface is showing —
 *  "how full is this conversation", the number that tells Konrad when to type
 *  /compact (round 1350).
 *
 *  React-free and DOM-free on purpose, exactly like `live/agentsApi.ts`'s
 *  duration helpers: a check script can import it under tsx with no bundler,
 *  and the model→window map has one home instead of being sprinkled through
 *  components.
 *
 *  TWO RULES THIS MODULE EXISTS TO ENFORCE
 *
 *  1. ONE ACCOUNTING PATH. The occupancy is the LAST assistant turn's
 *     `input_tokens + cache_read_input_tokens` — the same arithmetic the Live
 *     panel's ↓ figure uses (`AgentActivity.downloadedTokens`), read off the
 *     same two metadata fields the server shapes into `usage_running` /
 *     `usage_last_turn` (forge-control/src/routes/agents-shared.ts:557-558;
 *     the executor writes `usage_running` as "the LAST assistant message we
 *     saw", run-rollup.ts:324). No second counter, no summing across turns —
 *     `usage_total` is an AGGREGATE and would climb past the window on a long
 *     chat while the real context sat at 30%.
 *
 *  2. UNKNOWN IS A VALUE. Every reader here returns `null` rather than a
 *     plausible zero. A gauge that renders 0% on a chat whose usage hasn't
 *     landed yet is a lie that says "plenty of room"; the caller renders a
 *     muted placeholder instead.
 */

/** A model's context window, and whether we actually know it.
 *
 *  `assumed` is the honest half: an id this build has never seen still gets a
 *  number so the gauge can draw, but the tooltip says the window is assumed.
 *  Silently presenting a guess as a measurement is the thing this flag
 *  refuses to do. */
export interface ContextWindow {
  tokens: number;
  assumed: boolean;
}

/** Trailing snapshot date: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
const SNAPSHOT_DATE = /-\d{8}$/;
/** The vendor prefix every Claude model id carries. */
const CLAUDE_PREFIX = /^claude-/;

/** THE MAP. Keys are normalised ids (lower-cased, snapshot date stripped,
 *  `claude-` prefix stripped) so `claude-haiku-4-5-20251001`, `haiku-4-5` and
 *  `Claude-Haiku-4-5` all land on one entry.
 *
 *  Windows are per Anthropic's own model table (claude-api skill, models.md,
 *  cached 2026-06-24), not from memory: the whole Opus/Sonnet/Fable 5 line is
 *  1M, and Haiku 4.5 is the one current model still at 200K. Getting this
 *  wrong in the "everything is 200k" direction is exactly the bug the brief
 *  named — it would show a 300k conversation on a 1M model as 150% full. */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Claude — current
  ["fable-5", 1_000_000],
  ["mythos-5", 1_000_000],
  /* Gemini, via the Antigravity engine. 1M input context — and unlike every
   * entry below it, this one is MEASURED rather than taken from a spec sheet:
   * agy's own /context screen prints "Gemini 3.7 Flash (High) · 0/1.0M tokens".
   * Keys keep the DOT: `normalizeModel` lower-cases and strips the snapshot
   * date and the `claude-` prefix, and does nothing to punctuation — so
   * `gemini-3.7-flash-high` arrives here dotted. A hyphenated key would miss
   * every time and silently fall through to the assumed fallback, which is the
   * quiet kind of wrong: a plausible bar drawn from a guessed denominator. */
  ["gemini-3.7-flash-high", 1_000_000],
  ["gemini-3.7-flash-medium", 1_000_000],
  ["gemini-3.7-flash-low", 1_000_000],
  ["gemini-3.7-flash", 1_000_000],
  ["gemini-3.6-flash", 1_000_000],
  ["opus-5", 1_000_000],
  ["opus-4-8", 1_000_000],
  ["opus-4-7", 1_000_000],
  ["opus-4-6", 1_000_000],
  ["sonnet-5", 1_000_000],
  ["sonnet-4-6", 1_000_000],
  ["haiku-4-5", 200_000],
  // Claude — legacy ids still present on old runs in this DB
  ["opus-4-5", 200_000],
  ["opus-4-1", 200_000],
  ["opus-4-0", 200_000],
  ["sonnet-4-5", 200_000],
  ["sonnet-4-0", 200_000],
  // Non-Claude engines this box can route a run to.
  ["gemini-3.7-flash", 1_000_000],
]);

/** Bare family aliases. `opus` names whatever the alias resolved to that day,
 *  so the window is a family guess, not a fact — hence `assumed: true` even
 *  though the family is known. Same distinction `isModelAlias` draws in the
 *  Live panel. */
const ALIAS_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["opus", 1_000_000],
  ["sonnet", 1_000_000],
  ["fable", 1_000_000],
  ["haiku", 200_000],
]);

/** What we assume for a model id this build has never heard of. 200k is the
 *  smallest window any current Claude model has, so an unknown model's gauge
 *  errs toward "fuller than it may be" — the safe direction for a warning. */
const FALLBACK_WINDOW_TOKENS = 200_000;

/** Normalise a model id to a map key. */
function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(SNAPSHOT_DATE, "")
    .replace(CLAUDE_PREFIX, "");
}

/** The context window for a model id.
 *
 *  Null ONLY when there is no id at all — with an id we always produce a
 *  number, flagged `assumed` when it came from the alias table or the
 *  fallback rather than an exact match. */
export function contextWindowFor(
  model: string | null | undefined,
): ContextWindow | null {
  if (model == null) return null;
  const key = normalizeModel(model);
  if (!key) return null;
  const exact = MODEL_CONTEXT_WINDOWS.get(key);
  if (exact !== undefined) return { tokens: exact, assumed: false };
  const alias = ALIAS_CONTEXT_WINDOWS.get(key);
  if (alias !== undefined) return { tokens: alias, assumed: true };
  return { tokens: FALLBACK_WINDOW_TOKENS, assumed: true };
}

/** A finite, non-negative number, or null. `runs.metadata` is untyped JSONB;
 *  a string, a null or a NaN where a token count belongs must read as absent,
 *  never as 0. */
function tokenCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/** input + cache_read for one usage object, or null when the object carries
 *  neither field as a usable number.
 *
 *  A total of exactly 0 also reads as null: it means the turn's usage row
 *  exists but hasn't been filled in yet (a run between turns), and "0 tokens
 *  of context" is never true of a live conversation. */
function downloadedTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = tokenCount(u.input_tokens);
  const cacheRead = tokenCount(u.cache_read_input_tokens);
  if (input === null && cacheRead === null) return null;
  const total = (input ?? 0) + (cacheRead ?? 0);
  return total > 0 ? total : null;
}

/** The tokens the NEXT turn of this run would carry in, or null if unknown.
 *
 *  `usage_running` first (the rollup's live counter, rewritten from every
 *  assistant message), `usage_last_turn` second (stamped by the executor when
 *  a turn completes). Both describe ONE turn, which is what a context window
 *  measures; neither accumulates. */
export function readContextTokens(
  meta: Record<string, unknown> | null | undefined,
): number | null {
  if (!meta) return null;
  return downloadedTokens(meta.usage_running) ?? downloadedTokens(meta.usage_last_turn);
}

/** The model a run ACTUALLY ran on — `model_resolved` (what the CLI resolved
 *  after the alias) before `model` (what was requested). Same order and same
 *  guard as `AgentChatView.runModel`. */
export function readRunModel(
  meta: Record<string, unknown> | null | undefined,
): string | null {
  if (!meta) return null;
  const resolved = meta.model_resolved;
  if (typeof resolved === "string" && resolved) return resolved;
  const requested = meta.model;
  if (typeof requested === "string" && requested) return requested;
  return null;
}

export interface ContextOccupancy {
  /** Tokens the next turn carries: last assistant turn's input + cache_read. */
  usedTokens: number;
  windowTokens: number;
  /** True when `windowTokens` came from the alias table or the fallback. */
  assumedWindow: boolean;
  /** Resolved model id, or null when the run never recorded one. */
  model: string | null;
  /** `usedTokens / windowTokens`, unclamped — a value over 1 is a real state
   *  (a run past its window is a run that is about to fail) and the renderer,
   *  not the arithmetic, decides how to draw it. */
  fraction: number;
}

/** Occupancy for one run's metadata, or null when the tokens are unknown.
 *
 *  An unknown MODEL is survivable (fallback window, `assumedWindow: true`);
 *  unknown TOKENS are not, because there is nothing to divide. */
export function contextOccupancy(
  meta: Record<string, unknown> | null | undefined,
): ContextOccupancy | null {
  const usedTokens = readContextTokens(meta);
  if (usedTokens === null) return null;
  const model = readRunModel(meta);
  const window = contextWindowFor(model) ?? {
    tokens: FALLBACK_WINDOW_TOKENS,
    assumed: true,
  };
  return {
    usedTokens,
    windowTokens: window.tokens,
    assumedWindow: window.assumed,
    model,
    fraction: usedTokens / window.tokens,
  };
}

/* ── Pressure bands ───────────────────────────────────────────────────────
 *
 * Konrad's brief: "calm below ~60%, warn ~75%+, danger ~90%+". Four bands,
 * because three thresholds imply four states — 60-75% is neither calm nor a
 * warning, it is "noticeable", and the middle band is what makes the gauge
 * readable at a glance instead of binary.
 *
 * Returned as token NAMES, not token values, for the same reason the Live
 * panel's kind grammar does it: this module stays React- and CSS-free, and
 * the component maps a name to `tokens.*` in one place.
 */
export type ContextBand = "calm" | "noticed" | "warn" | "danger";

export function contextBand(fraction: number): ContextBand {
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.75) return "warn";
  if (fraction >= 0.6) return "noticed";
  return "calm";
}

/** Short token figure for the tooltip: 132.1k, 1.05M, 940. Mirrors
 *  `AgentActivity.humanTokens` — same shapes, kept here so this module has no
 *  imports. */
export function humanTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}M`;
}
