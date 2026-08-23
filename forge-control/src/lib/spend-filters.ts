/**
 * Query-parameter parsing for GET /api/spend/summary.
 *
 * Pulled out of the route so it can be tested without a database: the whole
 * point of the filter is that a bad value is REJECTED rather than quietly
 * dropped. A `?provider=gemni` typo that silently returns the unfiltered
 * series is worse than a 400 — the caller reads it as "gemini spent
 * everything", which is what the filter was added to disprove.
 *
 * Three rules, all enforced here:
 *  - `days` clamps to 1..365 and REJECTS a non-numeric string. The route used
 *    to write `Number(q) || 30`, which turns `?days=banana` into a silent
 *    30-day window.
 *  - `provider` / `kind` are opaque strings (a new gateway must not need an AI
 *    OS code change to appear — the ingest endpoint's own rule), so they are
 *    validated on SHAPE, not against an enum: non-empty, <= 64 chars, and
 *    drawn from the character set provider names actually use.
 *  - The literal `all` and the empty string both mean "no filter" and produce
 *    `null`, so a UI can bind a select straight to the query string.
 */

export interface SpendFilterSelection {
  /** 1..365. */
  days: number;
  /** null = every provider. */
  provider: string | null;
  /** null = every kind. */
  kind: string | null;
}

export type SpendFilterParse =
  | { ok: true; value: SpendFilterSelection }
  | { ok: false; error: string };

export const SPEND_DEFAULT_DAYS = 30;
export const SPEND_MIN_DAYS = 1;
export const SPEND_MAX_DAYS = 365;

/** Provider and kind names as they exist in `spend_log`: lowercase words with
 *  `-` or `_` between them (`claude-code`, `llm_output`). Deliberately not an
 *  allow-list of known values. */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_MAX = 64;

/** `all` and `""` are the two ways a UI says "no filter". */
function parseName(
  raw: string | undefined,
  field: "provider" | "kind",
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "all") {
    return { ok: true, value: null };
  }
  if (trimmed.length > NAME_MAX) {
    return {
      ok: false,
      error: `${field} must be at most ${NAME_MAX} characters, got ${trimmed.length}`,
    };
  }
  if (!NAME_SHAPE.test(trimmed)) {
    return {
      ok: false,
      error:
        `${field} must match ${NAME_SHAPE.source} (letters, digits, dot, dash, ` +
        `underscore), got ${JSON.stringify(trimmed)}`,
    };
  }
  return { ok: true, value: trimmed };
}

export function parseSpendFilters(query: {
  days?: string;
  provider?: string;
  kind?: string;
}): SpendFilterParse {
  let days = SPEND_DEFAULT_DAYS;
  if (query.days !== undefined && query.days.trim() !== "") {
    const n = Number(query.days);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        error: `days must be a number, got ${JSON.stringify(query.days)}`,
      };
    }
    days = Math.min(SPEND_MAX_DAYS, Math.max(SPEND_MIN_DAYS, Math.trunc(n)));
  }

  const provider = parseName(query.provider, "provider");
  if (!provider.ok) return { ok: false, error: provider.error };

  const kind = parseName(query.kind, "kind");
  if (!kind.ok) return { ok: false, error: kind.error };

  return { ok: true, value: { days, provider: provider.value, kind: kind.value } };
}
