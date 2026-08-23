/**
 * deep-link.ts — jumping from one surface to a specific thing on another.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * The desktop console is ONE route (`/desktop`). Which surface you are on is
 * React state persisted to `localStorage` under `forge.desktop.surface`; the
 * URL never changes and nothing in the app reads `location.search` (grep for
 * `useSearchParams` — the only hit outside `signin` is none). So an
 * `<a href="/desktop?surface=chat&chat=…">` is not a deep link at all: the
 * browser reloads `/desktop`, the query string is dropped on the floor, and
 * you land on whatever surface you were on before. Round 4's review found five
 * of those shipped in the autonomy and automation surfaces — every "View Run
 * in Chat" and "Settings → Connections" affordance the two surfaces offer.
 *
 * The mechanism that DOES work is the one the app already uses to survive F5:
 * write the destination into the same `localStorage` keys the target surface
 * reads on mount, then flip the surface through the nav callback the shell
 * hands down. No reload, no lost state, and `?surface=` support does not have
 * to be invented in `DesktopApp.tsx` (which this project does not own).
 *
 * ── Why writing `forge.chat.selected` is safe ─────────────────────────────
 * `ChatSurface` is rendered conditionally (`surface === "chat" && …`), so it
 * MOUNTS when you arrive. On mount `usePersistentState` reads
 * `forge.chat.selected` in a layout effect and its "open the newest chat on
 * arrival" effect is guarded by `if (!selId …)` (ChatSurface.tsx:729) — so a
 * pre-written id is honoured, not clobbered. The drill-in stack is cleared for
 * the same reason `openChat` clears it: a stack stored against a different
 * chat would assert that its worker belongs to the run we are opening.
 *
 * Both keys and both validators are imported from `chat/stored-nav.ts` rather
 * than restated here, so this file cannot drift from the reader.
 */

import { CHAT_STORAGE_KEYS, isChatId } from "./chat/stored-nav";
import type { Surface } from "./nav-items";
import { toastError } from "./_ui/Toasts";

/** The shell's surface switcher, as handed to a surface. Matches
 *  `DesktopApp`'s `onNav` prop type (DesktopApp.tsx:624). */
export type NavigateTo = (s: Surface) => void;

/**
 * Point the chat surface at `runId` and go there.
 *
 * Throws rather than degrading quietly: a non-uuid reaching
 * `forge.chat.selected` would be rejected by `isChatId` on the next read and
 * silently drop you on the manager thread, which reads as "the link is wrong"
 * with nothing to debug. `jumpToRun` below is the call-site-friendly wrapper.
 */
export function openChatRun(runId: string, navigate: NavigateTo): void {
  // `isChatId` also admits `null` (the "no chat open" value) — irrelevant
  // here, because the parameter is a `string`, so a pass means "a uuid".
  if (!isChatId(runId)) {
    throw new Error(
      `openChatRun: ${JSON.stringify(runId)} is not a run uuid — refusing to point the chat surface at it`,
    );
  }
  try {
    localStorage.setItem(CHAT_STORAGE_KEYS.selected, JSON.stringify(runId));
    localStorage.removeItem(CHAT_STORAGE_KEYS.navStack);
  } catch (e) {
    throw new Error(
      `openChatRun: could not write ${CHAT_STORAGE_KEYS.selected} (${String(e)}) — the chat surface would open on the wrong run`,
    );
  }
  navigate("chat");
}

/**
 * `openChatRun` for a click handler: the failure becomes a toast naming the
 * run, not an unhandled exception that takes the surface down with it. The
 * navigation is deliberately NOT attempted after a failure — landing on the
 * manager chat while claiming to have opened run X is the lie this whole file
 * exists to remove.
 */
export function jumpToRun(runId: string, navigate: NavigateTo): void {
  try {
    openChatRun(runId, navigate);
  } catch (e) {
    toastError(`Couldn't open run ${runId.slice(0, 8)} in chat.`, e);
  }
}

/**
 * Go to SETTINGS, where CONNECTIONS lives.
 *
 * Deliberately does NOT claim to open the CONNECTIONS section itself:
 * `SettingsSurface` holds its section in a plain `useState` with no storage
 * key (SettingsSurface.tsx:142), so there is nothing to pre-write, and that
 * file belongs to another lane tonight. The button's label says "Settings"
 * and lands you on the settings index with CONNECTIONS one row away — an
 * honest one-click-short beats a link that pretends to a tab this app has
 * never had.
 */
export function openSettings(navigate: NavigateTo): void {
  navigate("settings");
}
