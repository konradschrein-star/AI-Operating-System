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
  ReminderTextTooLongError,
  assertReminderTextFits,
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
});

/** db/ and routes/ modules open a pg Pool on import, so the enforcement
 *  points are asserted against their source rather than exercised. */
function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
