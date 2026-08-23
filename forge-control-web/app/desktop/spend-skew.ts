/**
 * Deploy-skew guards for /api/spend/summary.
 *
 * forge-control-web and forge-control are separate processes. The web build
 * can go live minutes — or, if a restart is skipped, days — before the API
 * that serves it. Every field this UI added in the same commit as the route
 * that emits it is therefore ABSENT, not zero, against the older API:
 *
 *   $ curl -s "http://127.0.0.1:7700/api/spend/summary?days=7" | jq 'keys'
 *   ["by_area","d30","d7","daily","today"]          # 2026-08-23, no "filters"
 *   $ ... | jq '.daily[0]'
 *   {"day":"2026-08-22","total_eur":0,"calls":50}   # no shadow_eur either
 *
 * `getJson<T>` is an unchecked cast, so TypeScript, `next build` and all 25
 * gates stay green while `spendData.filters.providers` throws a TypeError and
 * `eur(day.shadow_eur)` throws on hover. The interfaces in `api-business.ts`
 * keep declaring those fields REQUIRED on purpose — they describe the API this
 * repo ships, and defaulting a missing one to 0 is the fabrication finding
 * from fix cycle 1. These helpers hold the other half of that rule: absent is
 * not zero, it is *unknown*, and it must be said out loud.
 *
 * Pure — no React, no fetch. Tested by `spend-skew.test.ts`.
 */

import type { SpendDailyItem, SpendSummaryResponse } from "../api-business";

/** A daily row as an OLDER deployed forge-control may actually put it on the
 *  wire: the compute split is missing rather than zero. */
export type WireSpendDailyItem = Omit<
  SpendDailyItem,
  "shadow_eur" | "total_compute_eur"
> &
  Partial<Pick<SpendDailyItem, "shadow_eur" | "total_compute_eur">>;

/** A summary as an older deployed forge-control may put it on the wire: no
 *  `filters` block, because the provider/category pick lists post-date it. */
export type WireSpendSummary = Omit<SpendSummaryResponse, "filters" | "daily"> & {
  daily: WireSpendDailyItem[];
} & Partial<Pick<SpendSummaryResponse, "filters">>;

/**
 * The provider/category pick lists, or empty ones when the API is too old to
 * send them. Empty means "this API cannot offer a filter", which the surface
 * renders as a picker with nothing but `all` in it — the filter is inert, the
 * rest of the Money surface works. That is the graceful half; the crash it
 * replaces took the whole surface into SurfaceErrorBoundary.
 */
export function spendPickLists(summary: WireSpendSummary | null): {
  providers: string[];
  kinds: string[];
} {
  return {
    providers: summary?.filters?.providers ?? [],
    kinds: summary?.filters?.kinds ?? [],
  };
}

/**
 * The first daily row that cannot answer the compute-split question, or null
 * when every row can. A row is incomplete when `shadow_eur` or
 * `total_compute_eur` is not a number — absent, null, or a string the server
 * forgot to cast. The caller must refuse to draw the series rather than plot
 * `undefined` (NaN bar heights, "€NaN" peak label, TypeError on hover).
 */
export function firstIncompleteDay(
  daily: WireSpendDailyItem[],
): WireSpendDailyItem | null {
  return (
    daily.find(
      (d) =>
        typeof d.shadow_eur !== "number" ||
        !Number.isFinite(d.shadow_eur) ||
        typeof d.total_compute_eur !== "number" ||
        !Number.isFinite(d.total_compute_eur),
    ) ?? null
  );
}

/** The diagnostic shown in place of the chart. Names the field and the day, so
 *  the reading is "restart forge-control", not "the chart is broken". */
export function incompleteDayMessage(day: WireSpendDailyItem): string {
  const missing: string[] = [];
  if (typeof day.shadow_eur !== "number" || !Number.isFinite(day.shadow_eur)) {
    missing.push("shadow_eur");
  }
  if (
    typeof day.total_compute_eur !== "number" ||
    !Number.isFinite(day.total_compute_eur)
  ) {
    missing.push("total_compute_eur");
  }
  return `Compute series unavailable: /api/spend/summary returned ${day.day} without ${missing.join(" and ")}. The deployed API is older than this surface — restart forge-control.`;
}
