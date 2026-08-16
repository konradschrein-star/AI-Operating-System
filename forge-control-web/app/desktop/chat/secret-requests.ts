/**
 * secret-requests.ts — which credential requests the chat surface must show,
 * and which one it should open by itself (U30).
 *
 * Pure, React-free, dependency-free, and deliberately not a fetch layer: the
 * data is already on the wire. `GET /api/secrets` returns, per secret,
 * `{ name, bytes, updatedAt, note, pending, requestedByRunId }` — `pending` IS
 * the "for Konrad" flag an agent raised via
 * `POST /api/secrets/:name/mark-pending`, and `note` is that agent's request
 * text. No value is ever in that payload, and nothing here asks for one.
 *
 * TOTALITY IS A REQUIREMENT, NOT A STYLE CHOICE. This runs on the chat
 * surface's polling path. A malformed row (a null entry, a missing `note`, an
 * `updatedAt` that isn't a date) must produce a slightly poorer list, never a
 * thrown exception that blanks the composer — a credential request Konrad
 * cannot see is a request that never gets answered. Every function here is
 * total over `unknown`-shaped input and neither throws nor mutates its
 * argument.
 *
 * The one judgement call: a pending row with a broken `updatedAt` is KEPT
 * (with `updatedAt: ""`) and sorted last rather than dropped. Dropping it
 * would hide a real request behind a cosmetic defect.
 */

import type { SecretMeta } from "../../api";

/** A pending credential request, reduced to what the panel actually renders. */
export interface SecretRequest {
  /** Secret name — server-normalised, safe to prefill into the name field. */
  name: string;
  /** The requesting agent's text. ATTACKER-INFLUENCED: render as plain text,
   *  never as markdown/HTML. Null when the agent gave no reason. */
  note: string | null;
  /** The run that asked, if it named itself (server-validated uuid). */
  requestedByRunId: string | null;
  /** ISO timestamp from the store's mtime, or "" when unparseable. */
  updatedAt: string;
}

/** Longest note we render before cutting. A note is agent-written text with no
 *  server-side length cap; a megabyte of it would push the composer off the
 *  screen and make the answer buttons unreachable. */
export const RENDERED_NOTE_CAP = 2000;

/** Trim a request note to something a panel can hold. Total: null in, empty
 *  out, `truncated` says whether anything was cut. */
export function capNote(
  note: string | null | undefined,
  cap: number = RENDERED_NOTE_CAP,
): { text: string; truncated: boolean } {
  if (typeof note !== "string" || note === "") {
    return { text: "", truncated: false };
  }
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : RENDERED_NOTE_CAP;
  if (note.length <= limit) return { text: note, truncated: false };
  return { text: note.slice(0, limit), truncated: true };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Sort key: newer first. Anything unparseable sinks to the bottom (0) rather
 *  than producing NaN, which would make the comparator non-deterministic. */
function stamp(updatedAt: string): number {
  if (updatedAt === "") return 0;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The pending requests, most-recently-updated first.
 *
 * `pending` is checked with `=== true`: the flag is a boolean on the wire and a
 * truthy check would let a stray string in. Ties (same timestamp, or several
 * rows with unparseable timestamps) break on name ascending so the order is
 * stable across polls — a list that reshuffles under the cursor is its own bug.
 */
export function pendingRequests(list: readonly SecretMeta[]): SecretRequest[] {
  if (!Array.isArray(list)) return [];
  const out: SecretRequest[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as Partial<SecretMeta>;
    if (r.pending !== true) continue;
    const name = str(r.name);
    if (name === null) continue; // no name → nothing to store under
    out.push({
      name,
      note: str(r.note),
      requestedByRunId: str(r.requestedByRunId),
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    });
  }
  return out.sort((a, b) => {
    const d = stamp(b.updatedAt) - stamp(a.updatedAt);
    if (d !== 0) return d;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * The request the chat surface should auto-open for: the newest pending one
 * Konrad hasn't already waved away this session. Null when there is none —
 * which is the normal case, so the caller must treat null as "render nothing",
 * not as an error.
 *
 * Dismissal is by NAME, not by index: the list re-sorts as agents raise new
 * requests, and an index-based memory would re-open something already
 * dismissed the moment a newer request arrived.
 */
export function autoOpenTarget(
  list: readonly SecretMeta[],
  dismissedNames: readonly string[],
): SecretRequest | null {
  const dismissed = new Set(
    Array.isArray(dismissedNames)
      ? dismissedNames.filter((n): n is string => typeof n === "string")
      : [],
  );
  for (const req of pendingRequests(list)) {
    if (!dismissed.has(req.name)) return req;
  }
  return null;
}
