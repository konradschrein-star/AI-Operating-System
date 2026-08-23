/**
 * R870 — when the ENGINE drops the work, move the task to another engine
 * instead of failing it.
 *
 * The incident this is written against, 2026-08-22/23. The overnight AI-OS
 * build put every task of eleven projects on tier `gemini` (a flat Google AI
 * Pro subscription reached through `agy`, so the marginal cost is zero and the
 * Claude spend cap stops being the binding constraint). Of the runs that
 * settled between 22:00 and 00:00, 29 completed and 32 failed — and 28 of
 * those 32 died on one of three `agy` envelope signatures, not on anything to
 * do with the task:
 *
 *     Executor failed: agy returned status ERROR with no response text.   (26)
 *     Executor failed: agy exceeded 600000ms                              (2)
 *
 * Each one marked its task 'failed', blocked its project, and pushed a 🚫 to
 * Konrad's phone. He woke up to a wall of them — which is how this module got
 * commissioned — and every one of those projects then sat wedged until a
 * human or the manager loop retried it BACK ONTO THE SAME ENGINE.
 *
 * The root cause is documented and is not ours to fix: `agy`'s `write_to_file`
 * refuses any path that does not already exist, and a builder told to create a
 * file gives up at the first one, returning `status:"ERROR"` with an empty
 * response. (`lib/gemini-runner.ts` explains at length why an empty response
 * is the only reliable failure reading — the status alone is flaky in BOTH
 * directions and must not be trusted.) project-tick pre-creates a gemini
 * task's declared write-set to take the common case away; this module handles
 * what is left.
 *
 * Everything here is pure — the predicate and the tier choice — so it can be
 * tested without opening a pg pool (NF3). The I/O lives in
 * db/projects.ts (`demoteTaskTier`) and lib/project-tick.ts
 * (`demoteAfterEngineFailure`).
 */

import type { TaskTier } from "../db/projects.ts";

/**
 * The three ways `agy` hands back nothing usable, all raised by
 * lib/gemini-runner.ts and reaching us with the executor's
 * `Executor failed: ` prefix in front.
 *
 * DELIBERATELY NARROW. This must match ONLY the envelope failing, never the
 * work failing: a gemini run that reports "the typecheck does not pass" is a
 * real failure whose task deserves the 🚫 and the operator's eyes. Anchoring
 * on the literal strings gemini-runner throws — rather than, say, any error
 * mentioning `agy` — is what keeps that line where it belongs. If those
 * strings are ever reworded, this stops matching and the system degrades to
 * the OLD behaviour (fail the task, block the project, tell Konrad), which is
 * loud and safe rather than quiet and wrong.
 */
const AGY_ENGINE_FAILURE_RE =
  /agy (?:returned status \w+ with no response text|produced no parseable JSON|exceeded \d+ms)/i;

/** True when this error is the engine dropping the work, not the work failing. */
export function isEngineDropout(text: string | null | undefined): boolean {
  if (!text) return false;
  return AGY_ENGINE_FAILURE_RE.test(text);
}

/**
 * Where a dropped task goes.
 *
 * SONNET, NOT OPUS, and the reason is the reason the fleet was on gemini in
 * the first place: the Claude daily spend cap was already blown (EUR 124 of a
 * EUR 100 cap on the night this was written, with three runs refused outright
 * by the guardrail). A fallback to `standard` would take fifty queued tasks
 * off a free subscription and put them on the most expensive model in the
 * ladder — turning a noise problem into a billing one, and one that ends with
 * the guardrail blocking the very runs this path just rescued.
 *
 * `junior` is the cheap Claude that still writes code, and it only ever picks
 * up the fraction of tasks the free engine could not carry.
 */
export const ENGINE_FALLBACK_TIER: TaskTier = "junior";

/** Which tiers run on an engine that can drop work this way. Only `gemini`
 *  routes to `agy`; every other tier is claude-code, whose failures are real
 *  failures (or usage walls, which R860 already parks).
 *
 *  A type predicate, not a bare boolean: it is the only thing that proves a
 *  task's `tier` is non-null before `demoteTaskTier` is handed it as the
 *  once-only guard, and re-asserting that with a `!` would be an assertion
 *  where a proof already exists. */
export function tierCanDropOut(tier: TaskTier | null): tier is "gemini" {
  return tier === "gemini";
}
