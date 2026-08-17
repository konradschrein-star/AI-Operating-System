/**
 * check-typing-memo.ts — the structural half of round 1871's typing fix.
 *
 * THE MEASUREMENT IS IN `docs/plan/artifacts/phase1871/`. This file is the
 * thing that stops it silently rotting, and it exists because the fix is one
 * `memo()` plus two `useCallback`s — an edit any future round could undo in
 * four keystrokes without a single test going red, because the cost only shows
 * up in a browser with a 449-row transcript open.
 *
 * WHAT WAS MEASURED (worktree build, chat bfd1283a, 117 comms cards):
 *
 *   before   composer 79.12 ms/key · search 68.95 ms/key · control 1.05 ms/key
 *
 * The mechanism: `ChatThread` owns the composer's `draft` state and renders
 * `<ManagerThread>`, so every keystroke re-rendered the entire transcript to
 * change one textarea's value. Three things have to hold for the fix to work,
 * and ALL THREE are asserted below against the source text — because two of
 * them are load-bearing in a way no type or unit test can see:
 *
 *   1. `ManagerThread` is exported wrapped in `memo`.
 *   2. `ChatSurface` passes `onInsertDraft`/`onOpenSecret` as HOISTED
 *      callbacks, not inline arrows. An inline arrow is a new identity per
 *      render, which defeats (1) completely and silently.
 *   3. Those callbacks have empty dependency arrays. A dependency on `pending`
 *      or on `draft` puts the identity back on a clock and undoes (1) again.
 *
 * Source-text assertions, not behaviour: the failure mode is a REFACTOR, and
 * what a refactor breaks here is the shape of the call site. A render test
 * would pass just as happily with an inline arrow.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-typing-memo.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../forge-control-web");

const read = (rel: string): string => readFileSync(path.join(WEB, rel), "utf8");

const MANAGER_THREAD = read("app/desktop/chat/ManagerThread.tsx");
const CHAT_SURFACE = read("app/desktop/ChatSurface.tsx");
const ASSISTANT_THREAD = read("app/desktop/chat/AssistantThread.tsx");

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

console.log("\n── 1. the memo boundary itself ──────────────────────────────");

check(
  "ManagerThread imports memo",
  /import\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*"react"/.test(MANAGER_THREAD),
  true,
);
check(
  "ManagerThread is EXPORTED wrapped in memo",
  /export const ManagerThread\s*=\s*memo\(/.test(MANAGER_THREAD),
  true,
);
check(
  "…and the unwrapped implementation is not also exported",
  /export function ManagerThreadImpl/.test(MANAGER_THREAD),
  false,
);

console.log("\n── 2. the call site keeps the props stable ──────────────────");

/** The `<ManagerThread …/>` element, as written.
 *
 *  Anchored on the newline after the tag name so it cannot match the prose
 *  `<ManagerThread>` inside the comment two hundred lines above it — which is
 *  exactly what the first draft of this check did, reporting four failures
 *  against correct code. */
const element = /<ManagerThread\s*\n[\s\S]*?\/>/.exec(CHAT_SURFACE)?.[0] ?? "";
check("the element was found at all", element.length > 0, true);
check(
  "onInsertDraft is a hoisted identifier, not an inline arrow",
  /onInsertDraft=\{[A-Za-z_$][\w$]*\}/.test(element),
  true,
);
check(
  "onOpenSecret is a hoisted identifier, not an inline arrow",
  /onOpenSecret=\{[A-Za-z_$][\w$]*\}/.test(element),
  true,
);
check(
  "THE REGRESSION: no arrow function anywhere in the element's props",
  /=>/.test(element),
  false,
);
check(
  "…and no object literal either (same identity problem)",
  /=\{\{/.test(element),
  false,
);

console.log("\n── 3. the callbacks have nothing to change their identity ───");

/** A `useCallback(…, [deps])` body by the name it is assigned to. */
function callbackDeps(src: string, name: string): string | null {
  const re = new RegExp(
    `const ${name}\\s*=\\s*useCallback\\([\\s\\S]*?\\n\\s*\\}, (\\[[^\\]]*\\])\\);`,
  );
  return re.exec(src)?.[1] ?? null;
}

check("insertDraft is a useCallback", callbackDeps(CHAT_SURFACE, "insertDraft") !== null, true);
check("insertDraft has NO dependencies", callbackDeps(CHAT_SURFACE, "insertDraft"), "[]");
check(
  "openSecretByName is a useCallback",
  callbackDeps(CHAT_SURFACE, "openSecretByName") !== null,
  true,
);
check("openSecretByName has NO dependencies", callbackDeps(CHAT_SURFACE, "openSecretByName"), "[]");
check(
  "…which it can only manage by reading `pending` through a ref",
  /pendingRef\.current/.test(CHAT_SURFACE),
  true,
);

console.log("\n── 4. the collapsed comms card, which is the other half ─────");

/* A collapsed card renders no markdown at all, so the transcript's per-render
 * cost fell with it. If the default flips back to open, the measurement in
 * docs/plan/artifacts/phase1871/ stops describing this build. */
check(
  "comms cards default to COLLAPSED",
  /const \[open, setOpen\] = useState\(false\);/.test(ASSISTANT_THREAD),
  true,
);
check(
  "…and the collapsed line carries the caret the Bash rows use",
  /\{open \? "▾" : "▸"\}/.test(ASSISTANT_THREAD),
  true,
);
check(
  "…and exposes its state to a test harness",
  /data-comms-open=\{open \? "true" : "false"\}/.test(ASSISTANT_THREAD),
  true,
);
check(
  "…and a toggle a customer test can find and click",
  /data-comms-toggle/.test(ASSISTANT_THREAD),
  true,
);
check(
  "the body is only mounted when open",
  /\{open && \([\s\S]*?MessagePrimitive\.Parts components=\{\{ Text: CommsText \}\}/.test(
    ASSISTANT_THREAD,
  ),
  true,
);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — typing fix structure (r1871 finding 1+2)`,
);
process.exit(failures === 0 ? 0 : 1);
