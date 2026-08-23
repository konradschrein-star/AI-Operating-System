/**
 * The context popover's hover intent — the one behaviour in Konrad's brief
 * that is stated as a FEELING ("slowly popping up", not "an instant jitter on
 * every mouse cross") and therefore has no natural assertion.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * ## Why this is a source assertion
 *
 * The policy lives in two event handlers inside a React component; exercising
 * it for real needs a DOM, a mounted tree and fake timers, none of which this
 * package has, and a screenshot cannot show the ABSENCE of a blink. What can
 * be pinned exactly is the shape of the state machine, and the round-5 defect
 * was a shape defect, not a timing-constant defect:
 *
 *   gauge and card are two elements with a 6px gap between them, so moving
 *   from one to the other fires leave-then-enter. Leave set isOpen(false)
 *   immediately and enter re-armed the FULL 450ms open delay, so the card
 *   faded out and came back half a second later — every single time you tried
 *   to read it.
 *
 * Both halves of the fix are pinned below, and both assertions fail against
 * the pre-fix file (verified by running this suite against `git show`'s copy
 * before committing): the early return on `isMounted`, and the close being
 * SCHEDULED rather than applied on the leave frame.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POPOVER_SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../../../forge-control-web/app/desktop/chat/ChatContextPopover.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** One handler's body, from its `const handleX = () => {` to the closing
 *  `};` at the same indentation — so "this happens on ENTER" is a real
 *  assertion rather than "this string is somewhere in a 400-line component". */
function handlerBody(name: string): string {
  const start = POPOVER_SRC.indexOf(`const ${name} = () => {`);
  assert.notEqual(start, -1, `ChatContextPopover.tsx no longer defines ${name}`);
  const rest = POPOVER_SRC.slice(start);
  const end = rest.indexOf("\n  };");
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return rest.slice(0, end);
}

describe("popover hover intent", () => {
  const enter = handlerBody("handleMouseEnter");
  const leave = handlerBody("handleMouseLeave");

  test("the open delay is deliberate, not instant", () => {
    // "slowly popping up" — the brief. An instant popover on a rail of 15
    // gauges is a strobe light when you scan down the list.
    assert.match(enter, /\}, 450\);/);
  });

  test("an enter on an ALREADY-OPEN popover does not re-arm the open delay", () => {
    // The round-5 blink. Without this early return, travelling gauge → card
    // costs another full 450ms with a fade-out in the middle.
    assert.match(enter, /if \(isMounted\) \{\s*\n\s*setIsOpen\(true\);\s*\n\s*return;/);
    const guard = enter.indexOf("if (isMounted)");
    const arm = enter.indexOf("}, 450);");
    assert.ok(guard > 0 && guard < arm, "the isMounted guard must precede the 450ms arm");
  });

  test("leaving schedules the close instead of applying it on the same frame", () => {
    // The pointer spends a frame or two over neither element while crossing
    // the gap. Closing on that frame IS the blink.
    // Positional, not indentation-anchored: the close must appear AFTER the
    // setTimeout that defers it, which stays true through any reformat and is
    // false the moment someone moves it back to the handler's top level.
    const scheduled = leave.indexOf("closeTimerRef.current = setTimeout(");
    const closes = leave.indexOf("setIsOpen(false)");
    assert.ok(scheduled > 0, "the leave handler no longer schedules a close");
    assert.ok(closes > 0, "the leave handler no longer closes at all");
    assert.ok(
      closes > scheduled,
      "setIsOpen(false) runs synchronously on leave — the grace period is gone",
    );
  });

  test("the close grace is short enough not to feel sticky", () => {
    const grace = /\}, (\d+)\);\s*$/.exec(leave.trimEnd());
    assert.ok(grace, "the leave handler no longer ends in a timeout");
    const ms = Number(grace[1]);
    assert.ok(
      ms >= 60 && ms <= 250,
      `close grace is ${ms}ms — under 60 cannot cross the gap, over 250 reads as a popover that will not go away`,
    );
  });

  test("enter cancels a pending close, and both timers have their own slot", () => {
    // One shared timer slot cannot tell "cancel the close" from "cancel the
    // open", which is how the two-element hover goes wrong in the first place.
    assert.match(enter, /clearTimeout\(closeTimerRef\.current\)/);
    assert.match(enter, /clearTimeout\(unmountTimerRef\.current\)/);
    assert.notEqual(
      POPOVER_SRC.indexOf("const closeTimerRef"),
      -1,
      "closeTimerRef is gone — the close shares the open's timer slot again",
    );
  });

  test("every timer is cleared on unmount", () => {
    // Three refs now; a setState after unmount on a rail that re-renders on
    // every SSE frame is a warning storm at best.
    const cleanup = POPOVER_SRC.slice(
      POPOVER_SRC.indexOf("useEffect(() => {\n    return () => {"),
    ).slice(0, 400);
    for (const ref of ["timerRef", "closeTimerRef", "unmountTimerRef"]) {
      assert.match(cleanup, new RegExp(`clearTimeout\\(${ref}\\.current\\)`));
    }
  });
});
