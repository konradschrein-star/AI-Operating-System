/**
 * Assemble one journal day out of eleven independent sources.
 *
 * ── The failure contract (PLAN.md §3.6), which is the whole point ────────
 * Every source runs concurrently under Promise.allSettled and fails ALONE:
 *
 *   fulfilled → the field carries the value
 *   rejected  → the field is `null` AND `errors[]` gains {source, message}
 *
 * Never `[]` for a failure. An empty array is a fact about the day ("nothing
 * was committed"); null plus an error is a fact about the reader ("Google
 * answered 502"). A surface that renders both as "nothing here" is the reason
 * the old journal page could be broken for a week without anyone noticing.
 *
 * Nothing is caught and ignored, and every rejection is logged once, with its
 * source name, before it is returned — so a failing source is findable in
 * `pm2 logs forge-control` and not only in a JSON body nobody kept.
 *
 * Sources are also not allowed to take the page down between them: a slow
 * Google call cannot block the SQL cards, because allSettled waits for all of
 * them in parallel rather than awaiting them in sequence.
 */

import { eventsOccurred, type EventEvidence } from "./calendar.ts";
import { commitsForDay, type CommitEvidence } from "./git.ts";
import { glucoseForDay, type GlucoseEvidence } from "./glucose.ts";
import { habitsTicked, scoreForDay, type HabitsEvidence, type ScoreEvidence } from "./habits.ts";
import { mentorRead, type MentorRead } from "./mentor.ts";
import { rendersForDay, type RenderEvidence } from "./renders.ts";
import { decisionsForDay, runsForDay, type DecisionEvidence, type RunsEvidence } from "./runs.ts";
import { tasksDone, type TaskDoneEvidence } from "./tasks.ts";
import { readJournalReply, type JournalReply } from "../../db/journal-day.ts";
import type { Day } from "../day-score.ts";

export interface EvidenceError {
  source: string;
  message: string;
}

export interface DayEvidence {
  tasks_done: TaskDoneEvidence[] | null;
  events: EventEvidence[] | null;
  commits: CommitEvidence[] | null;
  renders: RenderEvidence[] | null;
  runs: RunsEvidence | null;
  decisions: DecisionEvidence[] | null;
  habits: HabitsEvidence | null;
  glucose: GlucoseEvidence | null;
  score: ScoreEvidence | null;
}

export interface JournalDay {
  day: Day;
  mentor: MentorRead | null;
  evidence: DayEvidence;
  /** Null only when `day_plans` or the vault could not be read — the same
   *  failure contract as every other source, with its own errors[] entry. */
  reply: JournalReply | null;
  errors: EvidenceError[];
}

/**
 * Unwrap ONE settled result: the value, or null plus a logged error entry.
 *
 * The rejection is logged here — once, at the only place that knows both the
 * source name and the error — and returned as data. `errors` is appended to in
 * call order, which is the order the sources are listed below.
 *
 * Exported because it IS the failure contract: lib/journal-evidence.test.ts
 * drives it with a source that throws rather than asserting on a paraphrase of
 * it. A test of a copy of this mapping would pass while the real one regressed.
 */
export function take<T>(
  outcome: PromiseSettledResult<T>,
  source: string,
  day: Day,
  errors: EvidenceError[],
): T | null {
  if (outcome.status === "fulfilled") return outcome.value;

  const reason: unknown = outcome.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[journal/day] source "${source}" failed for ${day}: ${message}`);
  errors.push({ source, message });
  return null;
}

/**
 * The §4.1 body, minus `entries` — the paper timeline stays where it already is,
 * in routes/journal.ts, unchanged.
 */
export async function collectJournalDay(day: Day): Promise<JournalDay> {
  // One allSettled over every source. They are started together, so the slowest
  // source sets the latency, not the sum of them; and a rejection anywhere is a
  // settled result rather than an unhandled rejection killing the request.
  const [
    mentor,
    reply,
    tasksDoneResult,
    eventsResult,
    commitsResult,
    rendersResult,
    runsResult,
    decisionsResult,
    habitsResult,
    glucoseResult,
    scoreResult,
  ] = await Promise.allSettled([
    mentorRead(day),
    readJournalReply(day),
    tasksDone(day),
    eventsOccurred(day),
    commitsForDay(day),
    rendersForDay(day),
    runsForDay(day),
    decisionsForDay(day),
    habitsTicked(day),
    glucoseForDay(day),
    scoreForDay(day),
  ]);

  const errors: EvidenceError[] = [];
  return {
    day,
    mentor: take(mentor, "mentor", day, errors),
    evidence: {
      tasks_done: take(tasksDoneResult, "tasks_done", day, errors),
      events: take(eventsResult, "events", day, errors),
      commits: take(commitsResult, "commits", day, errors),
      renders: take(rendersResult, "renders", day, errors),
      runs: take(runsResult, "runs", day, errors),
      decisions: take(decisionsResult, "decisions", day, errors),
      habits: take(habitsResult, "habits", day, errors),
      glucose: take(glucoseResult, "glucose", day, errors),
      score: take(scoreResult, "score", day, errors),
    },
    reply: take(reply, "reply", day, errors),
    errors,
  };
}
