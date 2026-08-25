/**
 * chat-etag.ts — Strong ETag computation and conditional If-None-Match validation
 * for GET /api/chat.
 *
 * Implements:
 * 1. Strong ETag computation (SHA-1 hex digest over response payload, enclosed in double quotes).
 * 2. If-None-Match header matching supporting:
 *    - Strong validators: e.g. "82eeaa62..."
 *    - Weak validators: e.g. W/"82eeaa62..." (needed when nginx gzip rewrites strong to weak in transit)
 *    - Wildcard validator: *
 *    - Comma-separated list of validators
 *
 * RFC 7232 §2.3.2 / RFC 9110 §8.8.3.2 weak comparison is used for If-None-Match,
 * allowing weak and strong representations with the same opaque tag to match.
 */

import crypto from "node:crypto";

/**
 * Computes a strong ETag for a given response payload using SHA-1.
 * Returns the 40-char hex digest enclosed in double quotes, e.g. `"82eeaa62..."`.
 *
 * Accepts string, Buffer, or any JSON-serializable object.
 */
export function computeChatEtag(payload: unknown): string {
  const data =
    typeof payload === "string"
      ? payload
      : Buffer.isBuffer(payload)
        ? payload
        : JSON.stringify(payload);
  const hash = crypto.createHash("sha1").update(data).digest("hex");
  return `"${hash}"`;
}

/**
 * Alias for computeChatEtag.
 */
export const computeEtag = computeChatEtag;

/**
 * Normalizes an ETag by stripping any leading weak indicator (`W/` or `w/`),
 * optional surrounding whitespace, and enclosing double quotes.
 *
 * Examples:
 *   `"82eeaa62"` -> `82eeaa62`
 *   `W/"82eeaa62"` -> `82eeaa62`
 *   `82eeaa62` -> `82eeaa62`
 */
export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
}

/**
 * Validates an incoming `If-None-Match` header value against the current server ETag.
 * Supports:
 * - exact strong tag matches (`"tag"`)
 * - weak tag matches (`W/"tag"`)
 * - wildcard matches (`*`)
 * - comma-separated list of tags (`"tag1", W/"tag2"`)
 *
 * Returns `true` if any tag in `ifNoneMatchHeader` matches `currentEtag`.
 * Returns `false` if `ifNoneMatchHeader` is null/undefined/empty or no tags match.
 */
export function matchesIfNoneMatch(
  ifNoneMatchHeader: string | null | undefined,
  currentEtag: string,
): boolean {
  if (!ifNoneMatchHeader || !currentEtag) {
    return false;
  }

  const cleanServerTag = normalizeEtag(currentEtag);
  if (!cleanServerTag) {
    return false;
  }

  const parts = ifNoneMatchHeader.split(",").map((p) => p.trim());
  return parts.some((part) => {
    if (!part) return false;
    if (part === "*") return true;
    if (part === currentEtag) return true;
    const cleanClientTag = normalizeEtag(part);
    return cleanClientTag === cleanServerTag;
  });
}

/**
 * Alias for matchesIfNoneMatch.
 */
export const isEtagMatch = matchesIfNoneMatch;
