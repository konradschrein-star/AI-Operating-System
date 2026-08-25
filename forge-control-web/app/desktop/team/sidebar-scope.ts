/**
 * sidebar-scope.ts — WHAT the right-hand sidebar is a picture of: this chat, or
 * every agent running on the box.
 *
 * Konrad's own words, recorded in the vault at `AI OS/Spec - Manager Chat UI
 * v3.md` (addendum, 2026-08-25):
 *
 *   "Add a toggle at the top of the right sidebar: 'this chat' vs 'everything
 *    running', defaulting to this chat."
 *
 * That addendum NARROWS — it does not delete — v3's "Explicitly rejected" entry
 * "right-sidebar content driven by anything other than the selected chat". The
 * rejection still governs the DEFAULT and it still governs SELECTION: a chat
 * opens scoped to itself, and which chat the panel shows is still decided on
 * the left rail and nowhere else. What this module models is one opt-in switch
 * of SCOPE, not a second chat selector.
 *
 * Only the numbers and the parsing live here, with no React and no DOM, so that
 * `scripts/checks/check-sidebar-scope.ts` can assert them under plain `tsx` —
 * the same reason `./plan-split.ts` and `../chat/pollBudget.ts` are separate
 * modules from the components that read them.
 *
 * ── SERIALISATION: JSON, not a bare string ────────────────────────────────
 * This app has both conventions live at once and they are not interchangeable
 * (fleet memory `theme-localstorage-is-bare-string-not-json`): `forge.theme` is
 * a BARE word, because layout.tsx's pre-paint script `===` it; every
 * `usePersistentState` key is `JSON.stringify`d, because that hook `JSON.parse`s
 * on read. This key is read by `usePersistentState` in `ChatSurface`, alongside
 * `forge.layout.chat.panelTab` and `forge.layout.chat.panelCollapsed`, so it is
 * JSON: the stored bytes for the default are `"this-chat"` WITH the quotes.
 * `readSidebarScope` therefore parses, and `writeSidebarScope` stringifies;
 * a caller that hand-writes the bare word gets the default back, not a crash.
 */

/** The two scopes, and there are deliberately only two — a third value here
 *  would be the independent selector v3 rejected. */
export type SidebarScope = "this-chat" | "everything-running";

/** localStorage key. Per browser (per operator), deliberately NOT per chat:
 *  the scope is a way of working, not a property of a conversation. Sits in the
 *  `forge.layout.chat.*` family with the panel's collapse and tab state. */
export const SIDEBAR_SCOPE_KEY = "forge.layout.chat.sidebarScope";

/** Konrad's stated default, and the one the v3 rejection still governs. */
export const SIDEBAR_SCOPE_DEFAULT: SidebarScope = "this-chat";

/** The order the segmented control renders in — scoped first, because that is
 *  the default and the cheap one. */
export const SIDEBAR_SCOPES: readonly SidebarScope[] = [
  "this-chat",
  "everything-running",
];

/** What each scope is called in the UI. His words, lowercased to match the
 *  rest of the panel's mono chrome. */
export const SIDEBAR_SCOPE_LABEL: Record<SidebarScope, string> = {
  "this-chat": "this chat",
  "everything-running": "everything running",
};

/** Hover text — says what the scope costs as well as what it shows, because
 *  "everything running" is the only one of the two that polls at all. */
export const SIDEBAR_SCOPE_TITLE: Record<SidebarScope, string> = {
  "this-chat": "The team, plan and live sessions of the open chat only",
  "everything-running":
    "Every run and sub-agent on the box, from every project — polls /api/agents",
};

/** The type guard `usePersistentState` takes. Exported so the component and the
 *  check assert membership through the same function. */
export const isSidebarScope = (v: unknown): v is SidebarScope =>
  v === "this-chat" || v === "everything-running";

/**
 * Parse what localStorage holds into a scope.
 *
 * A stored value this build does not recognise is NOT an error path: it is an
 * older build's key, or a hand-edit, or a future value read by an older tab.
 * Every one of those resolves to the default rather than crashing the surface
 * or — much worse — silently landing the operator in the polling scope he did
 * not choose. That asymmetry is the whole rule: unknown never means
 * "everything-running".
 */
export function readSidebarScope(raw: string | null): SidebarScope {
  if (raw === null) return SIDEBAR_SCOPE_DEFAULT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON at all — e.g. the bare word, written by hand or by a script
     * that assumed the `forge.theme` convention. Default, not a throw. */
    return SIDEBAR_SCOPE_DEFAULT;
  }
  return isSidebarScope(parsed) ? parsed : SIDEBAR_SCOPE_DEFAULT;
}

/** The bytes to store for a scope — the exact inverse of `readSidebarScope`,
 *  and the same encoding `usePersistentState` writes. */
export function writeSidebarScope(scope: SidebarScope): string {
  return JSON.stringify(scope);
}

/** Does this scope cost a request? Exactly one of the two does, and the panel
 *  gates the `/api/agents` query on this rather than on a `===` written out
 *  twice (once for the mount, once for `enabled`). */
export const scopePolls = (scope: SidebarScope): boolean =>
  scope === "everything-running";
