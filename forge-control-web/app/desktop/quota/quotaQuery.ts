"use client";

/**
 * The ONE subscription to /usage/quota. Round 1876.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Konrad, 2026-08-17: "Why do we have two indicators and why do we have them?
 * We do not need a weekly and a 5-hour limit twice, especially refreshing at
 * different intervals."
 *
 * He was looking at a regression. The 5h/7d bars lived in the status bar
 * (`QuotaBars`, DesktopApp) AND above the composer (`QuotaStrip`,
 * ChatSurface), and settings polled the endpoint through a THIRD fetcher
 * (`fetchUsageQuota` in settings/usageApi.ts). Three components, two client
 * fetchers, three `useQuery` call sites each restating the key and the
 * intervals from memory. Nothing forced them to agree, so eventually they did
 * not — two bars on one screen, refreshing on their own beats, disagreeing.
 *
 * The fix is structural, not cosmetic: the key, the intervals and the fetcher
 * exist EXACTLY ONCE, here, and every consumer subscribes through
 * `useQuotaSnapshot()`. React Query then does what it was built for — many
 * observers, one cache entry, one poll — and there is no second timer to drift
 * against. `scripts/checks/check-quota-row.ts` fails the build if any other
 * module names the endpoint, the key or the intervals again.
 *
 * ── Why `gemini` rides this response ─────────────────────────────────────
 * The indicator row shows Claude's two windows, the open chat's context, and
 * Konrad's Google subscription. Giving the Gemini line its own endpoint would
 * put a second timer behind one row — the very shape being deleted — so
 * routes/usage.ts attaches the tally to the quota payload and the row stays
 * one request per interval.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

/* ── Wire shapes (mirror forge-control/src/routes/usage.ts) ──────────────── */

export interface QuotaWindow {
  utilization: number | null;
  resets_at: string | null;
}

/** What WE counted for Gemini in a window. See `GeminiTally` in routes/usage.ts:
 *  Google publishes no denominator, so there is no percentage to render. */
export interface GeminiWindowTally {
  calls: number;
  /** Null means "rows exist, none carried a unit count" — not zero tokens. */
  tokens: number | null;
}

export interface GeminiTally {
  /** `access(/root/.local/bin/agy, X_OK)` on the server — never a PATH walk,
   *  which pm2 makes lie. Null means the check itself failed: we do not know,
   *  which is not the same sentence as "not installed". */
  cli_installed: boolean | null;
  /** The persisted probe's verdict. Null whenever `cli_installed` is not
   *  `true` — there is nothing to have probed. */
  probe_state: "connected" | "unknown" | "broken" | null;
  /** When that probe ran. Null ⇒ nobody has ever asked (R57). */
  probe_checked_at: string | null;
  /** A probe, inside its shelf life, came back ok. REPLACES `cli_profile`,
   *  which reported a settings FILE on disk and was read as a session. */
  session_probed_ok: boolean;
  auth_note: string;
  connect_command: string | null;
  five_hour: GeminiWindowTally | null;
  seven_day: GeminiWindowTally | null;
  error?: string;
  no_limit_note: string;
}

export interface QuotaSnapshot {
  five_hour: QuotaWindow;
  seven_day: QuotaWindow;
  seven_day_opus: QuotaWindow | null;
  fetched_at: string;
  cached?: boolean;
  error?: string;
  /** Present while the upstream 429 cooldown is running. */
  retry_in_ms?: number;
  /** Absent only against a forge-control older than round 1876. */
  gemini?: GeminiTally;
}

/* ── The single subscription ─────────────────────────────────────────────── */

/** The cache entry every consumer shares. A literal spelled anywhere else is
 *  a second entry that merely looks like this one. */
export const QUOTA_QUERY_KEY = ["usage", "quota"] as const;

/** One cadence for the whole row. 120s is the poll; 60s is how long a reading
 *  counts as fresh, so a surface mounting mid-interval reuses the last answer
 *  instead of firing its own request. */
export const QUOTA_REFETCH_MS = 120_000;
export const QUOTA_STALE_MS = 60_000;

const QUOTA_PATH = "/api/proxy/usage/quota";

/** Pull the server's own message out of an error body instead of reporting a
 *  bare status code — routes/usage.ts answers `{error: string}` on every
 *  failure path it owns, and that string is the diagnosis. */
async function failure(res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = ` — ${body.error}`;
  } catch {
    /* not JSON: the status line is all there is */
  }
  return new Error(
    `GET /usage/quota failed: ${res.status} ${res.statusText}${detail}`,
  );
}

/** `fresh` bypasses the server's 60s cache — wired to the row's refresh
 *  control and to the settings panel's. */
export async function fetchQuotaSnapshot(fresh = false): Promise<QuotaSnapshot> {
  const res = await fetch(`${QUOTA_PATH}${fresh ? "?fresh=1" : ""}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as QuotaSnapshot;
}

/** Subscribe to the shared reading. Every consumer calls THIS — never
 *  `useQuery` with a hand-written quota key. */
export function useQuotaSnapshot() {
  return useQuery<QuotaSnapshot>({
    queryKey: QUOTA_QUERY_KEY,
    queryFn: () => fetchQuotaSnapshot(false),
    refetchInterval: QUOTA_REFETCH_MS,
    staleTime: QUOTA_STALE_MS,
  });
}

/** Force a fresh reading into the shared cache. Every observer re-renders with
 *  it, which is the point: the row and the settings panel cannot show two
 *  different "last refreshed" stamps. */
export async function refreshQuotaSnapshot(qc: QueryClient): Promise<void> {
  const fresh = await fetchQuotaSnapshot(true);
  qc.setQueryData(QUOTA_QUERY_KEY, fresh);
}

/** The hook form, for components that own a refresh button. */
export function useQuotaRefresh(): () => Promise<void> {
  const qc = useQueryClient();
  return () => refreshQuotaSnapshot(qc);
}

/* ── Shared vocabulary for the reading's age ─────────────────────────────── */

/** "just now" / "3m ago" / "2h ago". One implementation, because the row and
 *  the settings card printing the same reading two different ways is how the
 *  duplication read as disagreement in the first place. */
export function readingAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

/** "resets 42m" / "resets 3h" / "resetting". Empty string for no reset stamp:
 *  it is appended to a title, and "resets —" says nothing. */
export function resetsIn(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "resetting";
  const m = Math.round(ms / 60000);
  return m < 60 ? `resets ${m}m` : `resets ${Math.round(m / 60)}h`;
}

/** Re-render on a fixed beat so "3m ago" stays truthful between polls. Costs
 *  no request — it is a `setState`, deliberately not a refetch. */
export function useMinuteTick(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}
