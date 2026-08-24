/**
 * check-deep-link.ts — executable unit check for cross-surface navigation:
 * `openChatRun` / `openSettings` in
 * forge-control-web/app/desktop/deep-link.ts.
 *
 * ── What defect this exists to keep out ───────────────────────────────────
 * The autonomy and automation surfaces shipped five "View Run in Chat" /
 * "Settings → Connections" affordances written as
 * `<a href="/desktop?surface=chat&chat=…">`. The desktop console is ONE route
 * whose surface is React state persisted to localStorage, and nothing in the
 * app reads `location.search` — so all five reloaded `/desktop` and left you
 * exactly where you already were. It typechecked, it built, it looked right in
 * a screenshot, and it did nothing. Round 4's review found it by grepping for
 * `useSearchParams`, which is the kind of proof that should not have to be
 * re-derived; this file is that proof, executable.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails. Same shape as check-nav-stack.ts,
 * deliberately.
 *
 * `deep-link.ts` reaches `localStorage`, which node does not have, and imports
 * `toastError` from a React module. Both are handled below: a small in-memory
 * `localStorage` stub, and `--tsconfig ../tsconfig.checks.json` for the JSX
 * transform (see that file's header for why it lives at the root).
 *
 * The imports are STATIC and the stub is installed in the module body. That
 * ordering is safe — `deep-link.ts` touches `localStorage` only inside its
 * functions, never at import time — and it is the only ordering available:
 * scripts/checks/ has no package.json, so tsx transforms these files as CJS
 * and a top-level `await import(...)` fails outright with "Top-level await is
 * currently not supported with the cjs output format".
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-deep-link.ts
 */

import { readFileSync } from "node:fs";

import { openChatRun, openSettings } from "../../forge-control-web/app/desktop/deep-link.ts";
import type { Surface } from "../../forge-control-web/app/desktop/nav-items.ts";
import {
  CHAT_STORAGE_KEYS,
  restoredNavStack,
} from "../../forge-control-web/app/desktop/chat/stored-nav.ts";

/* ── localStorage, in memory, installed BEFORE the module under test ──────
 * `deep-link.ts` only touches it inside its functions, but installing the stub
 * at import time keeps this file honest if that ever changes. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
const store = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = store;


let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

/** Records what the shell was asked to switch to. */
function spy(): { calls: string[]; nav: (s: Surface) => void } {
  const calls: string[] = [];
  return { calls, nav: (s: Surface) => void calls.push(String(s)) };
}

const RUN = "2ef126b7-d6d9-4a55-a8e7-d9acf0508645";
const OTHER = "b2b8c576-9fb6-4d74-a1e1-26a441225ea1";

console.log("── openChatRun: the chat surface's own storage key is written ──");
{
  store.clear();
  const s = spy();
  openChatRun(RUN, s.nav);
  check(
    "forge.chat.selected holds the run id, JSON-encoded as usePersistentState reads it",
    store.getItem(CHAT_STORAGE_KEYS.selected),
    JSON.stringify(RUN),
  );
  check("the surface is switched to chat", s.calls.join(","), "chat");
  check("exactly one navigation", s.calls.length, 1);
}

console.log("\n── the stored drill-in is cleared, for openChat's own reason ──");
{
  store.clear();
  // A stack left standing from a DIFFERENT chat would claim its worker belongs
  // to the run being opened — the lie ChatSurface's `openChat` resets to avoid.
  store.setItem(
    CHAT_STORAGE_KEYS.navStack,
    JSON.stringify({
      chatId: OTHER,
      frames: [{ kind: "agent", runId: OTHER, label: "someone else's worker" }],
    }),
  );
  const s = spy();
  openChatRun(RUN, s.nav);
  check(
    "forge.chat.navStack is gone",
    store.getItem(CHAT_STORAGE_KEYS.navStack),
    null,
  );
  // And prove it through the reader the chat surface actually uses, not just
  // through the raw key — an assertion about a key nobody reads is inert.
  check(
    "restoredNavStack() therefore answers `open the manager thread`",
    restoredNavStack(
      store.getItem(CHAT_STORAGE_KEYS.navStack),
      store.getItem(CHAT_STORAGE_KEYS.selected),
    ),
    null,
  );
}

console.log("\n── a value that is not a run uuid never reaches the key ──────");
for (const bad of ["", "not-a-uuid", "/desktop?surface=chat", `${RUN} `]) {
  store.clear();
  const s = spy();
  let threw = false;
  try {
    openChatRun(bad, s.nav);
  } catch {
    threw = true;
  }
  check(`${JSON.stringify(bad)} throws`, threw, true);
  check(
    `${JSON.stringify(bad)} leaves forge.chat.selected unwritten`,
    store.getItem(CHAT_STORAGE_KEYS.selected),
    null,
  );
  check(`${JSON.stringify(bad)} does not navigate`, s.calls.length, 0);
}

console.log("\n── a storage failure is not swallowed ────────────────────────");
{
  store.clear();
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = broken;
  const s = spy();
  let message = "";
  try {
    openChatRun(RUN, s.nav);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  check("it throws", message.length > 0, true);
  check(
    "the diagnostic names the key it could not write",
    message.includes(CHAT_STORAGE_KEYS.selected),
    true,
  );
  check(
    "and it does NOT navigate — landing on the manager chat while claiming to have opened a run is the defect",
    s.calls.length,
    0,
  );
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = store;
}

console.log("\n── openSettings: surface only, no invented tab ───────────────");
{
  store.clear();
  const s = spy();
  openSettings(s.nav);
  check("navigates to settings", s.calls.join(","), "settings");
  check("writes nothing to storage", store.getItem("forge.chat.selected"), null);
}

console.log("\n── no surface may reintroduce an href deep link ──────────────");
{
  const root = new URL("../../", import.meta.url);
  for (const rel of [
    "forge-control-web/app/desktop/AutonomySurface.tsx",
    "forge-control-web/app/desktop/AutomationSurface.tsx",
  ]) {
    const src = readFileSync(new URL(rel, root), "utf8");
    // The pattern is the ATTRIBUTE — `href="` or `href={` immediately before
    // `/desktop` — not the bare word, so prose about surfaces does not trip
    // it. It does still match a QUOTE of the dead form, which is why both
    // surfaces describe it in words instead of reproducing it; see
    // AutomationSurface's header comment.
    const hits = src.match(/href=[{"]`?\/desktop/g) ?? [];
    check(`${rel.split("/").pop()} has no href="/desktop…"`, hits.length, 0);
  }
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — cross-surface deep links`,
);
process.exit(failures === 0 ? 0 : 1);
