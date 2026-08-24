/**
 * Which engine owns a run's session id.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────
 * `runs.metadata.cc_session_id` is ONE slot shared by both engines, and the
 * executor used to stamp `'engine': 'claude-code'` beside it unconditionally —
 * even when the id had come from agy. The resume path then read the slot back
 * without asking whose id it was.
 *
 * Konrad hit the visible half on 2026-08-23: switching a live chat to Gemini
 * killed the run with
 *   agy returned status ERROR ... conversation "6b1c2951-…" not found
 * because that is a *Claude* session id and agy keeps its own conversation
 * store. The mirror image is worse because it is silent — handing
 * `claude --resume` an agy conversation id.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 * These two functions are pure, and they live here rather than in executor.ts
 * so a test can import them. Importing `executor.ts` boots the executor: it
 * opens a pg pool and starts the tick loop, so a unit test that reaches into it
 * hangs forever instead of asserting. Pure logic in `lib/`, side effects in the
 * entrypoint, is the pattern the rest of this package already follows.
 */

import { isGeminiModel } from "./gemini-runner.ts";

/** The engine that will actually run this model. Defers to `isGeminiModel` so
 *  it cannot drift from the dispatcher in cc-runner that makes the real
 *  routing decision. An absent/unknown model is Claude — never silently
 *  Gemini. */
export function engineForModel(model: string | null | undefined): string {
  return isGeminiModel(model) ? "agy" : "claude-code";
}

/** The stored session id, but ONLY if the engine about to run is the one that
 *  minted it. Null otherwise, which starts a fresh conversation on the new
 *  engine — the honest outcome, since the two engines cannot share context.
 *
 *  ── THE KEY IS `session_engine`, NOT `engine` (2026-08-24) ─────────────────
 *  Provenance first shipped in `metadata.engine`, which the executor already
 *  used to pick its DISPATCH branch. Writing "agy" there rerouted every
 *  Gemini chat to the legacy HTTP pool from turn two onward — see the header
 *  on `saveCcSession`. Provenance now owns `session_engine` and dispatch keeps
 *  `engine`.
 *
 *  Two generations of rows are read back, and the fallback order is a fact
 *  about the data rather than a guess:
 *    1. `session_engine` — written since the split. Authoritative.
 *    2. `engine` — the collided generation. For those rows the value really
 *       IS the producing engine, because saveCcSession is what wrote it.
 *    3. neither — predates provenance entirely, and every writer of this slot
 *       back then was the Claude path.
 *
 *  Reading (2) still costs nothing once (1) exists: a row cannot carry a
 *  `session_engine` unless the current code minted its id. */
export function resumableSession(
  metadata: Record<string, unknown> | null | undefined,
  engineNow: string,
): string | null {
  const sid = metadata?.cc_session_id;
  if (typeof sid !== "string" || sid === "") return null;
  const stamped =
    typeof metadata?.session_engine === "string" && metadata.session_engine !== ""
      ? metadata.session_engine
      : typeof metadata?.engine === "string" && metadata.engine !== ""
        ? metadata.engine
        : "claude-code";
  // Dispatch names the pool path "claude-pool"; that engine never mints a
  // session id, so a row carrying it in the legacy slot is a pre-split row
  // whose id came from the Claude CLI.
  const owner = stamped === "claude-pool" ? "claude-code" : stamped;
  return owner === engineNow ? sid : null;
}
