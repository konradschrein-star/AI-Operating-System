/**
 * The reminder text limit, and the refusal to enforce it quietly.
 *
 * Reminders are the human backstop for everything the engine cannot verify
 * itself, which makes a half-written reminder worse than no reminder at all:
 * it still looks armed. `createReminder` used to enforce the limit with a
 * silent `input.text.slice(0, 500)` and return 201, and in round 604 that
 * amputated two R20 watchers mid-word — one lost the "expect TWO tasks"
 * assertion, the other lost its entire re-arm command, stopping at the words
 * "then tail ". Both were stored at exactly 500 characters and both reported
 * success.
 *
 * The limit stays (reminders land on a phone; a 4KB reminder is not a
 * reminder). The silence does not: over-length text is now an error the
 * caller sees, and the caller's job is to split it into several reminders.
 *
 * Lives in lib/ rather than db/ so it is testable without opening a pg Pool.
 */

/** Maximum stored reminder text, in characters. A product limit — the
 *  `reminders.text` column is unbounded `text` (db/migrations/0027). */
export const REMINDER_TEXT_MAX = 500;

export class ReminderTextTooLongError extends Error {
  readonly length: number;
  readonly max: number;

  constructor(length: number) {
    super(
      `reminder text is ${length} chars, max ${REMINDER_TEXT_MAX} — split it ` +
        `into several reminders; the overflow is not stored`,
    );
    this.name = "ReminderTextTooLongError";
    this.length = length;
    this.max = REMINDER_TEXT_MAX;
  }
}

/** Throws {@link ReminderTextTooLongError} if `text` would not survive
 *  storage intact. Never truncates, never returns a shortened string. */
export function assertReminderTextFits(text: string): void {
  if (text.length > REMINDER_TEXT_MAX) {
    throw new ReminderTextTooLongError(text.length);
  }
}

// ---------------------------------------------------------------------------
// Delivery. Storing the text intact is half the job; the round-605 defect was
// the other half — `reminderTick` wrote `rem.text.slice(0, 120)` into the
// inbox card's `title` and nothing carried the remainder, so the four 485–491
// char R20 watchers would have surfaced in the Console as fragments ending
// mid-path. `inbox_items.ask` is unbounded `text` (db/migrations/0021) and
// both Console surfaces render it unclamped, so the payload goes there and
// the title goes back to being what a title is: a label.
// ---------------------------------------------------------------------------

/** Max characters in an inbox card's `title`. A layout budget, not a content
 *  limit — the full text always ships in `ask`. */
export const REMINDER_TITLE_MAX = 120;

/** A glanceable label for the inbox card: the reminder's first line, cut at a
 *  word boundary with an ellipsis when it overruns the layout budget. The
 *  ellipsis is load-bearing — it is what tells a reader the title is a lede
 *  and the body below is the reminder. */
export function reminderCardTitle(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const source = (firstLine.trim() || text.trim()).replace(/\s+/g, " ");
  if (source.length <= REMINDER_TITLE_MAX) return source;

  const cut = source.slice(0, REMINDER_TITLE_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > REMINDER_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/** The inbox card's body: the reminder verbatim, then the due line. Nothing
 *  that reached storage is dropped on the way to the surface it is tracked
 *  on. */
export function reminderCardAsk(
  text: string,
  dueLabel: string,
  recur: string | null,
): string {
  return `${text}\n\n— due ${dueLabel}${recur ? ` (repeats ${recur})` : ""}`;
}
