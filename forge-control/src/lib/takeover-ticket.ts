/**
 * takeover-ticket.ts — the only credential guarding a live Chrome that holds
 * Konrad's logged-in sessions.
 *
 * The websockify upgrade for a browser takeover is carried by a dedicated nginx
 * `location` that proxy_passes straight to forge-control on 127.0.0.1:7700.
 * That location sits OUTSIDE NextAuth's middleware, so the socket has to
 * authenticate itself: an authenticated endpoint mints a short-lived, signed
 * ticket bound to run id + profile + port, and the upgrade listener verifies it
 * before a single byte is proxied. A bare run id is never accepted anywhere.
 *
 * Wire format:
 *   base64url(JSON.stringify({v, rid, prof, port, exp, jti}))
 *     + "." + base64url(HMAC-SHA256(secret, payloadB64))
 *
 * Policy, deliberately unforgiving:
 * - The signing secret is read from the environment INSIDE each call, never at
 *   module scope. A module-level capture freezes the value at import time and
 *   makes a test's `before()` hook a no-op — that is exactly how an earlier
 *   round's proxy tests ended up running against production.
 * - Missing or too-short secret THROWS, on mint and on verify. There is no
 *   fallback secret, no dev default and no unsigned path.
 * - `verify` never throws on hostile input: it returns a distinct error string
 *   per failure, because it runs inside the server's `'upgrade'` listener where
 *   an exception would take the process down.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { PROFILE_RE, NOVNC_PORT_BASE, DISPLAY_SPAN } from "./browser-takeover.ts";

/** Payload schema version. Bumped only when the claim set changes. */
export const TICKET_VERSION = 1;

/** A click-to-connect is seconds; two minutes makes a leaked URL near-worthless. */
export const DEFAULT_TICKET_TTL_MS = 120_000;

/** Anything shorter is not a key, it is a password someone will guess. */
export const MIN_SECRET_LENGTH = 32;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The signed claim set, as it appears on the wire (short keys — this rides in a URL). */
export interface TakeoverTicketPayload {
  v: number;
  rid: string;
  prof: string;
  port: number;
  exp: number;
  jti: string;
}

export interface MintTakeoverTicketOptions {
  runId: string;
  profile: string;
  port: number;
  ttlMs?: number;
}

/** A verified ticket, expanded into the names the rest of the codebase uses. */
export interface TakeoverTicketClaims {
  runId: string;
  profile: string;
  port: number;
  /** Kept for the takeover log line — never log the ticket itself. */
  exp: number;
  jti: string;
}

export interface TakeoverTicketError {
  error: string;
}

export type VerifyTakeoverTicketResult = TakeoverTicketClaims | TakeoverTicketError;

export function isTakeoverTicketError(
  result: VerifyTakeoverTicketResult,
): result is TakeoverTicketError {
  return "error" in result;
}

/**
 * Reads the signing secret at call time. Throws with diagnostics when it is
 * absent or too short — the feature dies loudly rather than signing with a
 * guessable key.
 */
function ticketSecret(): string {
  const secret = process.env.TAKEOVER_TICKET_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "TAKEOVER_TICKET_SECRET is not set — browser takeover tickets cannot be signed or verified. " +
        "Set it in /opt/ai-os/.secrets/forge-control.env (>= " +
        `${MIN_SECRET_LENGTH} chars) and restart forge-control.`,
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `TAKEOVER_TICKET_SECRET is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH}) — refusing to sign browser takeover tickets with a weak key.`,
    );
  }
  return secret;
}

function encodeSegment(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** The inclusive loopback port range a takeover socket may ever target. */
const MIN_TICKET_PORT = NOVNC_PORT_BASE;
const MAX_TICKET_PORT = NOVNC_PORT_BASE + DISPLAY_SPAN - 1;

/**
 * Mints a signed, expiring ticket for one takeover socket.
 *
 * Refuses to sign anything it would later reject: a bad profile name or a port
 * outside the loopback allowlist is a bug at the call site, not a ticket.
 */
export function mintTakeoverTicket(options: MintTakeoverTicketOptions): string {
  const secret = ticketSecret();
  const { runId, profile, port } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS;

  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("mintTakeoverTicket: runId must be a non-empty string");
  }
  if (typeof profile !== "string" || !PROFILE_RE.test(profile)) {
    throw new Error(
      `mintTakeoverTicket: profile ${JSON.stringify(profile)} does not match ${PROFILE_RE}`,
    );
  }
  if (!Number.isInteger(port) || port < MIN_TICKET_PORT || port > MAX_TICKET_PORT) {
    throw new Error(
      `mintTakeoverTicket: port ${port} is outside the allowed loopback range ${MIN_TICKET_PORT}-${MAX_TICKET_PORT}`,
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`mintTakeoverTicket: ttlMs must be a positive finite number, got ${ttlMs}`);
  }

  const payload: TakeoverTicketPayload = {
    v: TICKET_VERSION,
    rid: runId,
    prof: profile,
    port,
    exp: Date.now() + ttlMs,
    jti: randomBytes(16).toString("hex"),
  };

  const payloadB64 = encodeSegment(JSON.stringify(payload));
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

/**
 * Verifies a ticket. Returns the claims, or `{ error }` with a distinct string
 * per failure mode. Only a missing/weak secret throws — never the input.
 *
 * Checks run in this order: shape, signature, expiry, profile, port. The
 * signature is checked before anything is read out of the payload, so an
 * attacker cannot steer later branches with unsigned data.
 */
export function verifyTakeoverTicket(ticket: unknown): VerifyTakeoverTicketResult {
  // Deliberately first: a missing secret is an operator error, not hostile
  // input, and must be impossible to paper over by sending a malformed ticket.
  const secret = ticketSecret();

  if (typeof ticket !== "string" || ticket.length === 0) {
    return { error: "ticket_missing" };
  }

  const segments = ticket.split(".");
  if (segments.length !== 2) {
    return { error: "ticket_malformed" };
  }
  const [payloadB64, signatureB64] = segments;
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(signatureB64)) {
    return { error: "ticket_malformed" };
  }

  const expected = Buffer.from(signPayload(payloadB64, secret), "utf8");
  const provided = Buffer.from(signatureB64, "utf8");
  // timingSafeEqual THROWS on a length mismatch — guard before calling it.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { error: "ticket_bad_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { error: "ticket_unreadable_payload" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { error: "ticket_unreadable_payload" };
  }

  const { v, rid, prof, port, exp, jti } = payload as Record<string, unknown>;

  if (v !== TICKET_VERSION) {
    return { error: "ticket_bad_version" };
  }

  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { error: "ticket_bad_expiry" };
  }
  if (exp <= Date.now()) {
    return { error: "ticket_expired" };
  }

  if (typeof prof !== "string" || !PROFILE_RE.test(prof)) {
    return { error: "ticket_bad_profile" };
  }

  if (typeof port !== "number" || !Number.isInteger(port) || port < MIN_TICKET_PORT || port > MAX_TICKET_PORT) {
    return { error: "ticket_port_out_of_range" };
  }

  if (typeof rid !== "string" || rid.length === 0) {
    return { error: "ticket_bad_run_id" };
  }
  if (typeof jti !== "string" || jti.length === 0) {
    return { error: "ticket_bad_jti" };
  }

  return { runId: rid, profile: prof, port, exp, jti };
}
