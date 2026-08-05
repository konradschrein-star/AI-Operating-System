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
