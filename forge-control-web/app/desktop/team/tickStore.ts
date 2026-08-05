"use client";

/** ONE 1-second clock for the whole app, as a `useSyncExternalStore` source.
 *
 *  Why a store instead of a `setInterval` per component: 13-ui-v3-architecture
 *  §6 and NFU2. The team panel can hold dozens of rows; a running row's time
 *  has to move once a second, and nothing else does. Subscribing at the ROW
 *  level would re-render every row (and its hover controls, and its native
 *  `title`) every second — the re-render storm the hover work exists to
 *  remove. `useTick` is therefore consumed ONLY by the leaf time component
 *  (round 502): the tick re-renders a `<span>`, not a row.
 *
 *  One interval for the whole app, started on the first subscriber and cleared
 *  on the last, so a panel that is closed or hidden costs nothing.
 */

import { useSyncExternalStore } from "react";

const TICK_MS = 1_000;

/** Snapshots are quantized to whole seconds so `getSnapshot` returns the SAME
 *  number for every call within a tick. `useSyncExternalStore` compares
 *  snapshots by identity and will loop forever if the value changes on every
 *  read — a raw `Date.now()` here would be that bug. */
function quantize(ms: number): number {
  return Math.floor(ms / TICK_MS) * TICK_MS;
}

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = 0;

function onTick(): void {
  const next = quantize(Date.now());
  if (next === snapshot) return;
  snapshot = next;
  for (const cb of listeners) cb();
}

/** Subscribe to the tick. Returns the unsubscribe function
 *  `useSyncExternalStore` expects.
 *
 *  The first subscriber refreshes the snapshot before the interval starts:
 *  between the last unsubscribe and now, `snapshot` is stale by an arbitrary
 *  amount. React re-reads `getTickSnapshot` right after `subscribe` returns
 *  precisely to catch a store that moved between render and subscription, so
 *  mutating here is the documented pattern, not a race. */
export function subscribeTick(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    snapshot = quantize(Date.now());
    timer = setInterval(onTick, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current 1s-quantized clock. Stable within a tick. */
export function getTickSnapshot(): number {
  return snapshot;
}

/** SSR snapshot: a stable constant, never `Date.now()`.
 *
 *  Server and client must agree during hydration, and a real clock cannot —
 *  the two reads happen at different instants on different machines. 0 is
 *  honest here: on the server there is no tick. The first client tick after
 *  hydration replaces it, and since running rows re-render from a poll
 *  response anyway, nothing user-visible depends on the server's value. */
export function getServerTickSnapshot(): number {
  return 0;
}

/** The 1s-quantized clock, as a hook. Leaf components only. */
export function useTick(): number {
  return useSyncExternalStore(
    subscribeTick,
    getTickSnapshot,
    getServerTickSnapshot,
  );
}
