/**
 * Tests for the reminder text limit.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The test that matters here is "text one char over the limit throws rather
 * than coming back shortened". The round-604 defect was not the limit — it
 * was that `createReminder` enforced it with `slice(0, 500)` and returned
 * 201, so two watcher reminders were stored at exactly 500 characters, cut
 * mid-word, having reported success. One of them lost the re-arm command it
 * existed to deliver. A guard that silently trims is not a guard; these
 * tests pin the *loudness*, not just the number.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REMINDER_TEXT_MAX,
  REMINDER_TITLE_MAX,
  ReminderTextTooLongError,
  assertReminderTextFits,
  reminderCardTitle,
  reminderCardAsk,
} from "./reminder-text.ts";

const atLimit = "x".repeat(REMINDER_TEXT_MAX);
const overLimit = "x".repeat(REMINDER_TEXT_MAX + 1);

describe("assertReminderTextFits", () => {
  test("accepts text at exactly the limit", () => {
    assert.doesNotThrow(() => assertReminderTextFits(atLimit));
  });

  test("accepts ordinary short text and empty text", () => {
    assert.doesNotThrow(() => assertReminderTextFits("check the deploy"));
    assert.doesNotThrow(() => assertReminderTextFits(""));
  });

  test("one char over the limit throws — it does not return a shortened string", () => {
    assert.throws(() => assertReminderTextFits(overLimit), ReminderTextTooLongError);
    // The signature is `void`: there is no shortened value to accidentally use.
    assert.equal(assertReminderTextFits(atLimit), undefined);
  });

  test("the error carries the numbers a caller needs to split on", () => {
    try {
      assertReminderTextFits("y".repeat(1234));
      assert.fail("expected ReminderTextTooLongError");
    } catch (e) {
      assert.ok(e instanceof ReminderTextTooLongError);
      assert.equal(e.length, 1234);
      assert.equal(e.max, REMINDER_TEXT_MAX);
      assert.match(e.message, /1234 chars, max 500/);
      assert.match(e.message, /split it/, "the message must say what to do instead");
      assert.equal(e.name, "ReminderTextTooLongError");
    }
  });
});

describe("the storage path never truncates", () => {
  test("createReminder passes text through unsliced", () => {
    // db/reminders.ts cannot be imported here without opening a pg Pool, so
    // this is asserted against its source. The exact defect was
    // `input.text.slice(0, 500)` sitting in the INSERT parameter list.
    const src = readSource("../db/reminders.ts");
    assert.doesNotMatch(
      src,
      /input\.text\.slice\(/,
      "the round-604 defect, by name: a silent slice inside createReminder",
    );
    assert.match(src, /assertReminderTextFits\(input\.text\)/);
  });

  test("the HTTP route answers 400 instead of a truncated 201", () => {
    const src = readSource("../routes/reminders.ts");
    assert.match(src, /ReminderTextTooLongError/);
    assert.match(
      src,
      /\{ error: e\.message, length: e\.length, max: e\.max \}, 400/,
      "over-length text must surface as a client error with the numbers",
    );
  });

  test("the telegram /remind path answers with the split instruction", () => {
    const src = readSource("./telegram-bridge.ts");
    assert.match(src, /parsed\.rest\.length > REMINDER_TEXT_MAX/);
  });

  test("the inbox delivery path carries the whole text, not a 120-char lede", () => {
    // Round 605: storage stopped truncating but `reminderTick` still wrote
    // `rem.text.slice(0, 120)` into the card title with no field holding the
    // rest, so the 485–491 char R20 watchers surfaced as fragments.
    const src = readSource("../executor.ts");
    assert.doesNotMatch(
      src,
      /rem\.text\.slice\(/,
      "the round-605 defect, by name: a silent slice on the way to the inbox",
    );
    assert.match(src, /reminderCardAsk\(rem\.text, dueLocal, rem\.recur\)/);
  });
});

describe("the inbox card", () => {
  // A real R20 watcher, 485 chars in the DB — the length that exposed the bug.
  const watcher =
    "R20 watcher: at 22:00 check that the detached safe-restart landed. " +
    "x".repeat(REMINDER_TEXT_MAX - 67);

  test("ask carries the reminder verbatim, prefix-exact", () => {
    const ask = reminderCardAsk(watcher, "5. Aug. 2026, 17:26", null);
    assert.ok(
      ask.startsWith(watcher),
      "the reminder must survive delivery byte-for-byte",
    );
    assert.match(ask, /\n\n— due 5\. Aug\. 2026, 17:26$/);
  });

  test("ask appends the recurrence when there is one", () => {
    assert.match(
      reminderCardAsk("water the plants", "6. Aug. 2026, 08:30", "daily"),
      /^water the plants\n\n— due 6\. Aug\. 2026, 08:30 \(repeats daily\)$/,
    );
  });

  test("short text passes through as its own title, untouched", () => {
    assert.equal(reminderCardTitle("check the deploy"), "check the deploy");
    assert.equal(reminderCardTitle("x".repeat(REMINDER_TITLE_MAX)), "x".repeat(REMINDER_TITLE_MAX));
  });

  test("a long title is elided — and the elision is visible", () => {
    const title = reminderCardTitle(watcher);
    assert.ok(title.length <= REMINDER_TITLE_MAX, `title was ${title.length} chars`);
    assert.ok(title.endsWith("…"), "a shortened title must announce that it is shortened");
    assert.ok(
      watcher.startsWith(title.slice(0, -1)),
      "the lede must be a real prefix of the reminder",
    );
  });

  test("elision cuts at a word boundary when there is a plausible one", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliett ".repeat(4);
    const title = reminderCardTitle(words);
    assert.ok(title.endsWith("…"));
    assert.doesNotMatch(title, / …$/, "no dangling space before the ellipsis");
    assert.ok(
      words.startsWith(title.slice(0, -1)),
      "word-boundary cut must still be a prefix",
    );
  });

  test("a single unbroken token is cut hard rather than emptied", () => {
    // lastIndexOf(" ") === -1: no boundary to fall back on.
    const title = reminderCardTitle("y".repeat(400));
    assert.equal(title, `${"y".repeat(REMINDER_TITLE_MAX - 1)}…`);
  });

  test("the title is the first line, and newlines never leak into it", () => {
    assert.equal(
      reminderCardTitle("Deploy check\n\nssh in and tail the log"),
      "Deploy check",
    );
    assert.doesNotMatch(reminderCardTitle(`${"z".repeat(200)}\nsecond`), /\n/);
  });

  test("a leading blank line falls back to the body rather than an empty title", () => {
    assert.equal(reminderCardTitle("\n\n  actually here  "), "actually here");
  });
});

/** db/ and routes/ modules open a pg Pool on import, so the enforcement
 *  points are asserted against their source rather than exercised. */
function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
