/**
 * stored-nav.ts — what survives F5 on the chat surface, and the guards on
 * reading it back.
 *
 * ── Why this is a module and not four helpers inside ChatSurface ──────────
 * Round 1871 put the restore in ChatSurface as a `useEffect` with a one-shot
 * ref. Round 1872's tester found it half-working: the surface and the open chat
 * came back, the DRILL-IN did not — `forge.chat.navStack` sat in localStorage
 * with the right `runId` and the right label, and the worker view was replaced
 * by the manager thread anyway, checked at +6s, +14s and +22s.
 *
 * The mechanism is an ordering one, and it is the reason this file exists.
 * `usePersistentState` hydrates in a LAYOUT EFFECT: render 1 always sees the
 * default (`null`), and the stored value arrives in a state update afterwards.
 * The restore effect ran on that first render, saw `selId === null`, burned its
 * one-shot ref and returned — so by the time the real chat id arrived, the
 * restore had already decided there was nothing to restore. Nothing about that
 * is visible in the effect's own code, which is exactly why it survived a
 * review and a fix cycle.
 *
 * So the decision is a PURE FUNCTION over the two raw strings, and ChatSurface
 * reads localStorage once, itself, in a layout effect that depends on no state
 * at all. There is no hydration order left to get wrong, and
 * `scripts/checks/check-stored-nav.ts` can assert the whole decision table —
 * including the cases that made round 1872's tester's reload land on the
 * manager thread — without a browser.
 *
 * ── Everything here is UNTRUSTED INPUT ────────────────────────────────────
 * A value written by an older build, a hand-edited key, a half-written JSON
 * blob. Every validator is total over `unknown` and REJECTS rather than
 * coerces: a chat id that is not a uuid must not reach `GET /api/chat/:id`, and
 * a nav frame with no `runId` must not reach the drill-in view, which would
 * render a fetch for `undefined`.
 */

import type { NavFrame, NavStack } from "./nav-stack";

/** The two localStorage keys, in one place so the reader below and the
 *  `usePersistentState` calls in ChatSurface cannot drift apart. */
export const CHAT_STORAGE_KEYS = {
  selected: "forge.chat.selected",
  navStack: "forge.chat.navStack",
} as const;

const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isChatId = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && CHAT_ID_RE.test(v));

/** The drill-in stack as stored: the frames PLUS the chat they belong to.
 *  Without the owner a stack restored under a different chat would claim that
 *  worker is this chat's, which is exactly the lie `openChat` resets to avoid. */
export interface StoredNav {
  chatId: string;
  frames: NavFrame[];
}

export const NO_STORED_NAV: StoredNav | null = null;

export function isNavFrame(v: unknown): v is NavFrame {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (f.kind === "plandoc") return typeof f.name === "string" && f.name !== "";
  if (f.kind !== "agent") return false;
  if (typeof f.runId !== "string" || !CHAT_ID_RE.test(f.runId)) return false;
  if (f.subagentId !== undefined && typeof f.subagentId !== "string") return false;
  if (f.label !== undefined && typeof f.label !== "string") return false;
  return true;
}

export const isStoredNav = (v: unknown): v is StoredNav | null => {
  if (v === null) return true;
  if (typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.chatId !== "string" || !CHAT_ID_RE.test(s.chatId)) return false;
  return Array.isArray(s.frames) && s.frames.every(isNavFrame);
};

/** `JSON.parse` that answers `null` instead of throwing. A malformed key is
 *  the same as an absent one HERE — unlike an API response, where silence
 *  about a bad payload is how a panel starts lying. This is a convenience the
 *  browser wrote and the user cannot see; the worst case is landing on the
 *  manager chat, which is where you land with no key at all. */
function parseRaw(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * The whole restore decision, as a value.
 *
 * `null` means "open the manager chat" — the same answer a cold start gives —
 * and it is returned for every one of these, deliberately:
 *
 *   · no stored stack, or a malformed one
 *   · no stored chat id, or a malformed one
 *   · a stack stored against a DIFFERENT chat than the one being restored
 *     (its worker does not belong to this chat, and saying it does is the lie
 *     `openChat`'s reset exists to prevent)
 *   · an empty stack, which is the manager chat expressed as a stack
 *
 * Anything else is the frames, in order, ready to become `navStack`.
 */
export function restoredNavStack(
  storedNavRaw: string | null,
  storedChatRaw: string | null,
): NavStack | null {
  const stored = parseRaw(storedNavRaw);
  const chat = parseRaw(storedChatRaw);
  if (!isStoredNav(stored) || stored === null) return null;
  if (!isChatId(chat) || chat === null) return null;
  if (stored.chatId !== chat) return null;
  if (stored.frames.length === 0) return null;
  return Object.freeze([...stored.frames]) as NavStack;
}

/** The same decision against the real `localStorage`. Separate from the pure
 *  function above so the check script never has to fake a browser global, and
 *  so a storage that throws (private mode, quota, a disabled origin) lands on
 *  the manager chat rather than taking the surface down with it. */
export function readRestoredNavStack(): NavStack | null {
  try {
    return restoredNavStack(
      localStorage.getItem(CHAT_STORAGE_KEYS.navStack),
      localStorage.getItem(CHAT_STORAGE_KEYS.selected),
    );
  } catch {
    return null;
  }
}
