/**
 * The two facts a LIVE team row is missing: which engine is running it, and
 * what it is doing right now.
 *
 * ── WHY THE BADGE IS NOT `metadata.engine` ───────────────────────────────────
 * `runs.metadata.engine` answers "which dispatch branch did the executor
 * take", and for one generation of rows it also answered "which engine minted
 * the session id" — see `engine-session.ts` and the fleet note
 * `engine-key-carried-two-vocabularies`. Measured over the seven days to
 * 2026-08-25, 46 rows carry `engine = 'claude-code'` beside a Gemini model.
 * A badge fed from that column is simply wrong on those rows.
 *
 * The MODEL is authoritative, so the badge is derived from it through
 * `engineForModel`, which defers to `isGeminiModel` — the dispatcher's own
 * predicate. The badge therefore cannot drift from the routing it claims to
 * describe.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 * Same reason `engine-session.ts` is: these functions are pure and a test can
 * import them. Importing `routes/chat.ts` (or the executor) opens a pg pool
 * and a unit test that reaches into it hangs instead of asserting. Pure logic
 * in `lib/`, side effects in the route.
 */

import { engineForModel } from "./engine-session.ts";

/**
 * Longest `activity.text` the team endpoint will ship, INCLUDING the ellipsis
 * that marks a clip. The rollup already slices assistant text at 160 chars on
 * the write side; this is the read-side bound, and it is the one that governs
 * the payload.
 *
 * The bound is structural rather than hopeful: `activity` ships only on
 * non-settled nodes, so the worst case is (live sessions × this cap), not
 * (tree size × this cap). Measured trees reach 165 nodes; live nodes are
 * typically under ten, which caps the addition at roughly 1.2 kB.
 */
export const ACTIVITY_TEXT_CAP = 120;

/** What a live row is doing right now, projected for the wire. `ts` is
 *  nullable so a client can age the value: an activity with no stamp cannot
 *  be shown as fresh. */
export interface LiveActivity {
  kind: string;
  tool: string | null;
  text: string | null;
  ts: string | null;
}

/**
 * The engine to BADGE a node with, or null when nothing was measured.
 *
 * ── THE DELIBERATE DEPARTURE FROM `engineForModel` ───────────────────────────
 * `engineForModel(null)` returns `"claude-code"`, and for DISPATCH that is
 * exactly right: an unknown model must never silently become Gemini. A badge
 * is a different question. Printing `claude-code` for a row whose model nobody
 * recorded asserts a fact that was never measured, and it is indistinguishable
 * from a row that really is Claude.
 *
 * So the derivation runs only on a non-empty model string, and every other
 * input yields `null` — which the client renders as "—". Do not "simplify"
 * this into a bare `engineForModel(model)` call; the guard IS the feature.
 */
export function badgeEngineForModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (trimmed === "") return null;
  return engineForModel(trimmed);
}

/** Clip to `ACTIVITY_TEXT_CAP`, ellipsis included in the budget, so the
 *  returned string is never longer than the cap it is named for. */
export function capActivityText(text: string | null): string | null {
  if (text === null) return null;
  if (text.length <= ACTIVITY_TEXT_CAP) return text;
  return `${text.slice(0, ACTIVITY_TEXT_CAP - 1)}…`;
}

/**
 * Project a rollup activity record onto the wire shape, or null.
 *
 * Two things are guaranteed to the client:
 *
 * 1. **Nothing ships on a settled node.** A finished run's last activity is
 *    not what it is doing right now — it is what it did last — and shipping it
 *    for every node in a 165-row tree is how a bounded payload becomes an
 *    unbounded one.
 * 2. **The result is never an empty object.** `kind` is always a non-empty
 *    string, so there is always something to render. A `tool_result` whose
 *    `tool` and `text` are both null still projects `{kind: "tool_result", …}`
 *    — the client can say "waiting on a tool result" and stamp it with its
 *    age. `{}` would render as a blank cell that reads as "idle", which is the
 *    one thing this column must never say by accident.
 */
export function projectActivity(
  src: unknown,
  opts: { settled: boolean },
): LiveActivity | null {
  if (opts.settled) return null;
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  // `kind` is the only load-bearing field: without it there is nothing a
  // client could render, and a row of three nulls is worse than no row.
  if (typeof s.kind !== "string" || s.kind === "") return null;
  return {
    kind: s.kind,
    tool: typeof s.tool === "string" && s.tool !== "" ? s.tool : null,
    text: capActivityText(
      typeof s.text === "string" && s.text !== "" ? s.text : null,
    ),
    ts: typeof s.ts === "string" && s.ts !== "" ? s.ts : null,
  };
}
