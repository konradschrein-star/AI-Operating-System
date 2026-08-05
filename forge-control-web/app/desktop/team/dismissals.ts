"use client";

/** Per-chat dismissal of team rows, persisted in localStorage.
 *
 *  ── Why this file exists at all ──────────────────────────────────────────
 *  13-ui-v3-architecture.md §2 lists dismissals as owned by "existing
 *  dismissal-persistence mechanism (in-flight phase)". There is NO such
 *  mechanism in this repo. `grep -rniE "dismiss" forge-control-web/app` finds
 *  exactly three things, none of them ours: the secrets page's "dismiss the
 *  for-Konrad flag" action, the reminders `dismissReminder` mutation, and one
 *  unrelated string in FileExplorerPanel. The architecture doc was describing
 *  something planned, not something shipped, and the SERVER-side dismissal
 *  phase is deferred to round 1600.
 *
 *  So this client store IS the wiring, for now. It does the one thing
 *  14-ui-v3-quality.md §500 asks the reviewer to verify — dismissals survive a
 *  reload — and it hides the implementation behind a hook, so round 1600 can
 *  swap localStorage for a server call inside `useDismissals` without the
 *  panel changing a line.
 *
 *  ── Dismissal is REVERSIBLE ──────────────────────────────────────────────
 *  `restore` and `restoreAll` exist so the panel can offer "N hidden · show".
 *  A dismissed row is hidden, never deleted: nothing here writes to the
 *  engine, and the run rows themselves are untouched. That matters because X
 *  on a running row reads as destructive (U17's confirm step) — the underlying
 *  state must be recoverable when the confirm was a misclick.
 *
 *  Storage idiom copied from ChatSurface.tsx:411-434 ("forge.canvasByRun"):
 *  lazy `useState` initializer, `typeof window` guard for SSR, try/catch
 *  around every parse and every write. Private-browsing mode makes writes
 *  throw; the dismissal then simply does not survive the reload, which is a
 *  better failure than a panel that cannot render.
 */

import { useCallback, useMemo, useState } from "react";

const STORAGE_KEY = "forge.teamDismissed";

/** chat run id → dismissed node ids (run uuids and sub-agent tool_use_ids). */
type DismissalStore = Record<string, string[]>;

/** Key used when no chat is open, so the hook is still callable and its
 *  writes land somewhere harmless instead of leaking into another chat. */
const NO_CHAT = "__none__";

function readStore(): DismissalStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Anything that is not an object of string arrays is treated as absent
    // rather than trusted — this key is user-writable in devtools.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: DismissalStore = {};
    for (const [chatId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) {
        out[chatId] = ids.filter((id): id is string => typeof id === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(next: DismissalStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode or quota — dismissals just won't survive a reload */
  }
}

export interface Dismissals {
  /** Node ids to filter out of the tree — feed straight to `flattenTeam`. */
  dismissed: ReadonlySet<string>;
  dismiss(id: string): void;
  restore(id: string): void;
  restoreAll(): void;
  /** How many rows this chat is hiding — the "N hidden · show" affordance. */
  count: number;
}

/**
 * Dismissals for one chat.
 *
 * The whole store lives in state (not just this chat's slice) so switching
 * chats needs no effect and no re-read: the derived set follows `chatId`.
 * State is per-hook-instance, which is correct while exactly one Team panel is
 * mounted; a second consumer would not see the first one's writes until a
 * reload. Round 1600's server-backed implementation removes that caveat — it
 * is called out here rather than solved with a module-level store, because a
 * shared store that is about to be replaced is scaffolding nobody will remove.
 */
export function useDismissals(chatId: string | null): Dismissals {
  const [store, setStore] = useState<DismissalStore>(readStore);
  const key = chatId ?? NO_CHAT;

  const dismissed = useMemo<ReadonlySet<string>>(
    () => new Set(store[key] ?? []),
    [store, key],
  );

  const update = useCallback(
    (mutate: (ids: string[]) => string[]) => {
      setStore((prev) => {
        const next: DismissalStore = { ...prev };
        const ids = mutate(prev[key] ?? []);
        if (ids.length === 0) delete next[key];
        else next[key] = ids;
        writeStore(next);
        return next;
      });
    },
    [key],
  );

  const dismiss = useCallback(
    (id: string) => update((ids) => (ids.includes(id) ? ids : [...ids, id])),
    [update],
  );

  const restore = useCallback(
    (id: string) => update((ids) => ids.filter((x) => x !== id)),
    [update],
  );

  const restoreAll = useCallback(() => update(() => []), [update]);

  return { dismissed, dismiss, restore, restoreAll, count: dismissed.size };
}
