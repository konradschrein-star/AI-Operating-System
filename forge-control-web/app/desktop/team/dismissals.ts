"use client";

/** Dismissal of agent rows — SERVER-BACKED, and GLOBAL rather than per chat.
 *
 *  ── What changed this round, and why the old header is gone ──────────────
 *  Until round 1350 this file was a localStorage store keyed PER CHAT, whose
 *  header promised that "round 1600" would swap it for a server call. Round
 *  1351 shipped that server half — `ui_dismissals` plus the four
 *  `/api/agents/dismissals` routes, documented in
 *  docs/plan/artifacts/phase1350/dismissal-api.md — so the note is obsolete
 *  and both of its premises are now wrong:
 *
 *    • A dismissal is GLOBAL. The same fleet appears in a chat's team panel
 *      and in the /live panel; hiding a finished builder in one while it
 *      still sits in the other is not two views of one truth, it is two
 *      truths. `chatId` survives ONLY so ChatTeamPanel keeps its call site —
 *      nothing in this file reads it, and nothing may start to.
 *    • There is NO localStorage path left, not even as a fallback. Two stores
 *      that can disagree is a worse failure than one that can fail loudly: a
 *      hide that survived in the browser while the server never heard of it
 *      is exactly the "the panel lies" class of bug this project exists to
 *      remove. The old code was deleted, not commented out.
 *
 *  ── One set, one cache, both surfaces ────────────────────────────────────
 *  The set lives in the react-query cache under `DISMISSALS_KEY`, so the team
 *  panel and the Live panel read literally one array: a dismissal in either
 *  lands in the other in the same frame with no second fetch, and the GET
 *  happens once per session. That also retires round 506's caveat that a
 *  second consumer would not see the first one's writes until a reload.
 *
 *  ── Optimistic, then reconciled, and never silent (NFU6) ─────────────────
 *  `dismiss` puts the id in the cache immediately — the row goes in the frame
 *  the click lands in — then POSTs with `cascade: true` and ADOPTS the id list
 *  the server returns. That list is how a manager's settled project workers
 *  and a run's sub-agents disappear together without waiting for the next
 *  poll. If the request fails the row comes back and a toast names the
 *  server's own reason. `restore` and `restoreAll` have the same shape.
 *
 *  Dismissal is still a HIDE, and still reversible: the server only ever
 *  inserts into `ui_dismissals`, `runs` is never touched, and "N hidden ·
 *  show" is one DELETE away.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  deleteAllDismissals,
  deleteDismissal,
  fetchDismissals,
  postDismissal,
} from "../live/agentsApi";
import { toastError } from "../_ui/Toasts";

/** The one cache key. Exported so a surface can invalidate it deliberately;
 *  no surface needs to today. */
export const DISMISSALS_KEY = ["ui-dismissals"] as const;

/** Stable empty set — returned while the GET is in flight so the consuming
 *  memos (flattenTeam's, the Live partition's) do not churn on identity. */
const NO_DISMISSALS: ReadonlySet<string> = new Set<string>();

/** Every write cascades. The server resolves what "everything under this row"
 *  means from live status (settled descendants only); the client keeps its own
 *  subtree hiding for instant feedback, and the two agree because the client's
 *  subtree is a subset of the server's answer. */
const CASCADE = true;

/** The last GET failure already reported. Module-level because the query is
 *  shared: two mounted consumers must produce one toast, not two. */
let reportedError: string | null = null;

function cached(qc: QueryClient): string[] {
  return qc.getQueryData<string[]>(DISMISSALS_KEY) ?? [];
}

function writeCache(qc: QueryClient, next: (prev: string[]) => string[]): void {
  qc.setQueryData<string[]>(DISMISSALS_KEY, (prev) => next(prev ?? []));
}

function withIds(prev: string[], ids: readonly string[]): string[] {
  const merged = new Set(prev);
  for (const id of ids) merged.add(id);
  return merged.size === prev.length ? prev : [...merged];
}

function withoutId(prev: string[], id: string): string[] {
  return prev.includes(id) ? prev.filter((x) => x !== id) : prev;
}

/** The shared query. Called by both hooks below; react-query dedupes it to one
 *  request. `staleTime: Infinity` is not laziness — nothing but this module
 *  writes `ui_dismissals`, so a refetch could only ever return what the cache
 *  already holds, and a background refetch racing an optimistic write is a
 *  row that flickers back for one frame. */
function useDismissalsQuery() {
  return useQuery<string[], Error>({
    queryKey: DISMISSALS_KEY,
    queryFn: fetchDismissals,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Has the server's set been read yet?
 *
 * Exported so a surface can seed its first frames from the `dismissed_at`
 * fields its OWN payload carries (see `seededDismissals`) instead of painting
 * rows the server already considers hidden and then yanking them. After the
 * GET lands, the set from the server is the only authority — which is what
 * makes a restore take effect immediately rather than being re-hidden by a
 * payload that is up to one poll stale.
 */
export function useDismissalsLoaded(): boolean {
  return useDismissalsQuery().isSuccess;
}

/**
 * The set a surface should actually hide by.
 *
 * Pure, and deliberately outside the hook so both surfaces apply the same
 * rule: before the GET has answered, union the ids the payload itself flagged;
 * afterwards, return the server set UNCHANGED — same object, so the memos
 * downstream keep bailing out.
 */
export function seededDismissals(
  loaded: boolean,
  dismissed: ReadonlySet<string>,
  payloadDismissed: readonly string[],
): ReadonlySet<string> {
  if (loaded || payloadDismissed.length === 0) return dismissed;
  const merged = new Set(dismissed);
  for (const id of payloadDismissed) merged.add(id);
  return merged;
}

export interface Dismissals {
  /** Node ids to filter out of the tree — feed straight to `flattenTeam`. */
  dismissed: ReadonlySet<string>;
  dismiss(id: string): void;
  restore(id: string): void;
  restoreAll(): void;
}

/* This hook deliberately exposes NO count. `dismissed.size` counts ids, and
 * the panels' "N hidden · show" labels need ROWS — two different numbers, in
 * both directions (round 505 finding #3): a dismissed worker takes its
 * sub-agents with it, so one id can hide three rows, while an id belonging to
 * another project's tree hides none at all in this one and would still have
 * been counted. Each surface counts what IT withheld — `flattenTeam` reports
 * `hiddenCount`, the Live panel counts its own partition. */

/**
 * The dismissal set, plus the three verbs that change it.
 *
 * `chatId` is VESTIGIAL. It is accepted so ChatTeamPanel's call site is
 * untouched by the move to the server, and it is not read: dismissals stopped
 * being per-chat this round (see the header). Do not reintroduce a use for it
 * — a per-chat dimension on a global table is how the two-truths bug comes
 * back.
 */
export function useDismissals(chatId: string | null): Dismissals {
  void chatId;
  const qc = useQueryClient();
  const q = useDismissalsQuery();

  /* A GET that failed leaves `dismissed` EMPTY, which un-hides every row —
   * loudly, and with the reason on screen. The alternative (keep hiding by a
   * set we could not verify) is a panel quietly withholding rows on the
   * strength of a request that never succeeded. */
  useEffect(() => {
    const err = q.error;
    if (!err) return;
    if (reportedError === err.message) return;
    reportedError = err.message;
    toastError("Dismissed rows unreadable", err);
  }, [q.error]);

  const dismissed = useMemo<ReadonlySet<string>>(
    () => (q.data && q.data.length > 0 ? new Set(q.data) : NO_DISMISSALS),
    [q.data],
  );

  const dismiss = useCallback(
    (id: string) => {
      const wasHidden = cached(qc).includes(id);
      writeCache(qc, (prev) => withIds(prev, [id]));
      void postDismissal(id, CASCADE)
        .then((ids) => {
          // Adopt the server's answer, unioned into whatever the cache holds
          // NOW rather than into the snapshot we took before the request — a
          // second dismissal may have landed while this one was in flight.
          writeCache(qc, (prev) => withIds(prev, ids));
        })
        .catch((e: unknown) => {
          // Roll back this id only, and only if we are the ones who added it.
          if (!wasHidden) writeCache(qc, (prev) => withoutId(prev, id));
          toastError(`Dismiss failed — ${id.slice(0, 8)}`, e);
        });
    },
    [qc],
  );

  const restore = useCallback(
    (id: string) => {
      const wasHidden = cached(qc).includes(id);
      writeCache(qc, (prev) => withoutId(prev, id));
      void deleteDismissal(id).catch((e: unknown) => {
        if (wasHidden) writeCache(qc, (prev) => withIds(prev, [id]));
        toastError(`Restore failed — ${id.slice(0, 8)}`, e);
      });
    },
    [qc],
  );

  const restoreAll = useCallback(() => {
    const before = cached(qc);
    writeCache(qc, () => []);
    void deleteAllDismissals().catch((e: unknown) => {
      // Put back exactly what was hidden before, plus anything dismissed
      // since — the failure undoes this gesture, not the ones after it.
      writeCache(qc, (prev) => withIds(prev, before));
      toastError("Restore all failed", e);
    });
  }, [qc]);

  return { dismissed, dismiss, restore, restoreAll };
}
