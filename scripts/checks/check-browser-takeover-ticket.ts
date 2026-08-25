/**
 * check-browser-takeover-ticket.ts — the gate on the ONE route in this repo
 * that is reachable from the public internet without a NextAuth session.
 *
 * WHAT IS BEING GUARDED, AND WHY IT IS WORTH A GATE
 *   `location /api/browser-takeover/ws/` in the os.schreinercontentsystems.com
 *   vhost proxy_passes straight to forge-control on 127.0.0.1:7700, bypassing
 *   the Next process and therefore bypassing middleware.ts entirely. It has to:
 *   a Next Route Handler cannot host a WebSocket (no socket access, `Response`
 *   rejects 101), which is why proxy-handler.ts answers every
 *   `Connection: Upgrade` with 502 + `x-proxy-bailout: upgrade`.
 *
 *   The thing on the far end of that socket is a real Chrome holding Konrad's
 *   logged-in Google and Perplexity sessions. If the ticket check ever softens
 *   — an upgrade arm that takes a bare run id, a port allowlist deleted as
 *   "unreachable", a second handler mounted under the same nginx prefix — the
 *   failure is silent and it is account takeover. None of that shows up in a
 *   typecheck. It shows up here.
 *
 * HOW IT CHECKS
 *   Behaviour first, source text only where behaviour cannot reach. Sections
 *   1-3 and 5 execute the real modules: they mint and forge real HMAC tickets,
 *   push them through the real `verifyTakeoverTicket` /
 *   `resolveTakeoverUpgradeTarget`, and read the real `vncProxyUrl` output. A
 *   grep can be satisfied by a comment; a forged ticket cannot.
 *
 *   Where a text scan IS the only instrument (a stale doc claim, an nginx
 *   directive, "no second mount anywhere in the tree"), the scanner is written
 *   as a pure function and then run TWICE: once against the real subject, which
 *   must come back clean, and once against a synthetic subject carrying exactly
 *   the defect it exists to catch, which must come back dirty. A scanner that
 *   has never been shown to fire is not evidence that the tree is clean.
 *
 * THE TRAP THIS FILE IS BUILT AROUND
 *   A grep-based ban fires on the checker's own prose the moment the checker
 *   names the strings it forbids — this repo has been bitten by it repeatedly
 *   (fleet notes: checker-names-its-own-forbidden-strings, verdict-grep-matches-
 *   the-brief). This file names every forbidden literal, on purpose, because it
 *   has to describe them. So the corpus in §6 excludes:
 *     - THIS FILE, by absolute path;
 *     - `docs/`, which exists to discuss the offence;
 *     - every extension where the token has no force — a route cannot be
 *       mounted from a .md, so markdown is not scanned at all.
 *   §6.0 proves the exclusion is load-bearing rather than decorative: it asserts
 *   that this file's own source WOULD have matched the forbidden literals, so
 *   deleting the exclusion turns the gate red and nobody can mistake it for a
 *   no-op. (§7's committed-secret scan uses a DIFFERENT policy on purpose: it
 *   scans docs too, because a real key pasted into a runbook is still a leak.)
 *
 * DELIBERATELY NOT CHECKED HERE
 *   The live nginx tree (/etc/nginx/...). This gate is hermetic: it reads only
 *   tracked files, so it gives the same verdict in a worktree, on another host,
 *   and before the deploy has run. Whether the live vhost matches
 *   deploy/nginx/os.schreinercontentsystems.com.conf is the deploy task's job,
 *   and its runbook (docs/plan/aios-browser-takeover-live/deploy.md) checks it
 *   with `nginx -t` before any reload.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so this is a
 * plain tsx script: one PASS/FAIL line per case, `process.exit(1)` if anything
 * fails. Same shape as check-browser-shots.ts, deliberately.
 *
 * Run (from forge-control-web, per the sibling checks' convention):
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-browser-takeover-ticket.ts
 */

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mintTakeoverTicket,
  verifyTakeoverTicket,
  isTakeoverTicketError,
  MIN_SECRET_LENGTH,
  TICKET_VERSION,
  type TakeoverTicketPayload,
} from "../../forge-control/src/lib/takeover-ticket.ts";
import {
  matchTakeoverUpgradePath,
  resolveTakeoverUpgradeTarget,
  isTakeoverUpgradeRejection,
  clearSpentTakeoverTicketJtis,
  handleBrowserTakeoverUpgrade,
  NOVNC_PORT_BASE,
  DISPLAY_SPAN,
} from "../../forge-control/src/lib/browser-takeover.ts";
import {
  vncProxyUrl,
  takeoverTicketUrl,
} from "../../forge-control-web/app/desktop/chat/browser-shots.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_REL = relative(REPO_ROOT, SELF_PATH);

let failures = 0;

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

function ok(name: string, condition: boolean, detail = ""): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}` + (condition || !detail ? "" : `\n        ${detail}`));
}

function readRepoFile(rel: string): string {
  return readFileSync(new URL(rel, `file://${REPO_ROOT}`), "utf8");
}

/** The verify-side error string, or a sentinel naming what came back instead. */
function verifyError(ticket: unknown): string {
  const result = verifyTakeoverTicket(ticket);
  return isTakeoverTicketError(result) ? result.error : "ACCEPTED(no error)";
}

/** Whatever `fn` threw, as a message — or a sentinel if it did not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
    return "DID NOT THROW";
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 1: the ticket module — the whole credential
 * ══════════════════════════════════════════════════════════════════════════ */

section("1. takeover-ticket.ts — mint & verify");

/* Not a real key and never was one: 52 chars of self-describing filler, long
 * enough to clear MIN_SECRET_LENGTH. The real key lives only in
 * /opt/ai-os/.secrets/forge-control.env and is never committed anywhere. */
const TEST_SECRET = "test-only-takeover-key-not-a-real-secret-0123456789";
const OTHER_SECRET = "test-only-takeover-key-ROTATED-not-a-real-secret-01";

const ORIGINAL_SECRET = process.env.TAKEOVER_TICKET_SECRET;
function withSecret(secret: string | undefined): void {
  if (secret === undefined) delete process.env.TAKEOVER_TICKET_SECRET;
  else process.env.TAKEOVER_TICKET_SECRET = secret;
}

const GOOD_RUN = "7a0c6432-cde4-4ca1-8f17-ff340c236c0a";
const GOOD_PROFILE = "r704-loginwall";
const GOOD_PORT = NOVNC_PORT_BASE + 41; // 6941 — inside the allowlist, by construction

ok(
  "the module's own floor is at least 32 chars",
  MIN_SECRET_LENGTH >= 32,
  `MIN_SECRET_LENGTH = ${MIN_SECRET_LENGTH}`,
);

/* 1a. Absent secret — the case that decides whether an unconfigured box fails
 * open or closed. Both directions must throw, and the message must name the
 * variable, or the operator gets a mystery instead of a fix. */
withSecret(undefined);
const mintNoSecret = thrownMessage(() =>
  mintTakeoverTicket({ runId: GOOD_RUN, profile: GOOD_PROFILE, port: GOOD_PORT }),
);
ok(
  "absent secret · mint throws and names TAKEOVER_TICKET_SECRET",
  mintNoSecret.includes("TAKEOVER_TICKET_SECRET"),
  mintNoSecret,
);
const verifyNoSecret = thrownMessage(() => verifyTakeoverTicket("anything.atall"));
ok(
  "absent secret · verify throws and names TAKEOVER_TICKET_SECRET",
  verifyNoSecret.includes("TAKEOVER_TICKET_SECRET"),
  verifyNoSecret,
);
ok(
  "absent secret · verify does NOT return a claims object",
  verifyNoSecret !== "DID NOT THROW",
  "an unconfigured box must refuse, not accept",
);

/* 1b. Too-short secret. A 31-char key is not a key. */
withSecret("x".repeat(MIN_SECRET_LENGTH - 1));
const shortMsg = thrownMessage(() =>
  mintTakeoverTicket({ runId: GOOD_RUN, profile: GOOD_PROFILE, port: GOOD_PORT }),
);
ok("short secret · mint refuses", shortMsg.includes("too short"), shortMsg);
ok(
  "short secret · verify refuses too",
  thrownMessage(() => verifyTakeoverTicket("a.b")).includes("too short"),
  "verify must apply the same floor as mint",
);

/* 1c. The happy path, so every rejection below means something. */
withSecret(TEST_SECRET);
const ticket = mintTakeoverTicket({ runId: GOOD_RUN, profile: GOOD_PROFILE, port: GOOD_PORT });
const [payloadB64, signatureB64] = ticket.split(".");
check("valid ticket · two dot-separated segments", ticket.split(".").length, 2);
ok(
  "valid ticket · both segments are base64url (URL-path safe)",
  /^[A-Za-z0-9_-]+$/.test(payloadB64) && /^[A-Za-z0-9_-]+$/.test(signatureB64),
  ticket.slice(0, 24),
);
const claims = verifyTakeoverTicket(ticket);
ok("valid ticket · verifies", !isTakeoverTicketError(claims), JSON.stringify(claims));
if (!isTakeoverTicketError(claims)) {
  check("valid ticket · run id round-trips", claims.runId, GOOD_RUN);
  check("valid ticket · profile round-trips", claims.profile, GOOD_PROFILE);
  check("valid ticket · port round-trips", claims.port, GOOD_PORT);
  ok("valid ticket · carries a jti", claims.jti.length > 0, claims.jti);
}

/* 1d. Tampering. Two shapes: flip the signature, and swap the payload for one
 * the holder wrote themselves while keeping a signature that was real. */
const flipped = signatureB64[0] === "A" ? `B${signatureB64.slice(1)}` : `A${signatureB64.slice(1)}`;
check("tampered signature · rejected", verifyError(`${payloadB64}.${flipped}`), "ticket_bad_signature");
check("truncated signature · rejected", verifyError(`${payloadB64}.${signatureB64.slice(0, -4)}`), "ticket_bad_signature");

const hostilePayload = Buffer.from(
  JSON.stringify({
    v: TICKET_VERSION,
    rid: GOOD_RUN,
    prof: GOOD_PROFILE,
    port: 7700, // forge-control itself — the port an attacker would want
    exp: Date.now() + 60_000,
    jti: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  "utf8",
).toString("base64url");
check(
  "tampered payload with the original signature · rejected",
  verifyError(`${hostilePayload}.${signatureB64}`),
  "ticket_bad_signature",
);

/* 1e. A signature the holder of the KEY could make. This is the layer that
 * would matter if the mint endpoint were ever fooled into signing junk — every
 * claim is re-checked at verify time, not trusted because it is signed. */
function forge(payload: Partial<TakeoverTicketPayload>, secret = TEST_SECRET): string {
  const body: TakeoverTicketPayload = {
    v: TICKET_VERSION,
    rid: GOOD_RUN,
    prof: GOOD_PROFILE,
    port: GOOD_PORT,
    exp: Date.now() + 60_000,
    jti: Math.abs(Date.now() % 1e9).toString(16).padStart(32, "f"),
    ...payload,
  };
  const b64 = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${b64}.${createHmac("sha256", secret).update(b64).digest("base64url")}`;
}

check("signed but expired · rejected", verifyError(forge({ exp: Date.now() - 1 })), "ticket_expired");
check(
  "signed but port below the allowlist · rejected",
  verifyError(forge({ port: NOVNC_PORT_BASE - 1 })),
  "ticket_port_out_of_range",
);
check(
  "signed but port above the allowlist · rejected",
  verifyError(forge({ port: NOVNC_PORT_BASE + DISPLAY_SPAN })),
  "ticket_port_out_of_range",
);
check(
  "signed but aimed at forge-control itself (7700) · rejected",
  verifyError(forge({ port: 7700 })),
  "ticket_port_out_of_range",
);
check(
  "signed but traversal profile · rejected",
  verifyError(forge({ prof: "../../etc/passwd" })),
  "ticket_bad_profile",
);
check("signed but wrong version · rejected", verifyError(forge({ v: TICKET_VERSION + 1 })), "ticket_bad_version");
check("signed but empty run id · rejected", verifyError(forge({ rid: "" })), "ticket_bad_run_id");
check("signed but empty jti · rejected", verifyError(forge({ jti: "" })), "ticket_bad_jti");

/* 1f. A real expiry, produced by the real mint path rather than a hand-set
 * timestamp — this is what proves the TTL is actually applied. */
const shortLived = mintTakeoverTicket({
  runId: GOOD_RUN,
  profile: GOOD_PROFILE,
  port: GOOD_PORT,
  ttlMs: 1,
});
/* A SYNCHRONOUS sleep, deliberately. tsx transforms this file to CJS (the repo
 * root has no `"type": "module"`), and top-level `await` is a hard transform
 * error under that output format — `await` here does not fail at runtime, it
 * fails to compile. Atomics.wait on a throwaway SharedArrayBuffer blocks the
 * thread for exactly the interval without spinning a CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
sleepSync(12);
check("minted with a 1 ms TTL, read 12 ms later · expired", verifyError(shortLived), "ticket_expired");

/* 1g. Shape rejections — hostile input must never throw inside the server's
 * 'upgrade' listener, only return an error string. */
check("empty string · rejected", verifyError(""), "ticket_missing");
check("non-string · rejected", verifyError(null), "ticket_missing");
check("no separator · rejected", verifyError("justonesegment"), "ticket_malformed");
check("three segments · rejected", verifyError("a.b.c"), "ticket_malformed");
check("non-base64url characters · rejected", verifyError("a!b.c@d"), "ticket_malformed");

/* 1h. The secret is read at CALL time, not captured at module scope. A ticket
 * signed under the old key must die the moment the key rotates — if this fails,
 * the module froze the value at import and a rotation is cosmetic. */
withSecret(OTHER_SECRET);
check("ticket signed under the previous key · rejected after rotation", verifyError(ticket), "ticket_bad_signature");
withSecret(TEST_SECRET);
ok(
  "and verifies again once the original key is restored",
  !isTakeoverTicketError(verifyTakeoverTicket(ticket)),
  "the rejection above must be the key, not a side effect",
);

/* 1i. Mint refuses to sign what verify would reject. */
check(
  "mint · out-of-range port refused at signing time",
  thrownMessage(() => mintTakeoverTicket({ runId: GOOD_RUN, profile: GOOD_PROFILE, port: 7700 })).includes(
    "outside the allowed loopback range",
  ),
  true,
);
check(
  "mint · bad profile refused at signing time",
  thrownMessage(() =>
    mintTakeoverTicket({ runId: GOOD_RUN, profile: "../etc", port: GOOD_PORT }),
  ).includes("does not match"),
  true,
);
check(
  "mint · empty run id refused at signing time",
  thrownMessage(() => mintTakeoverTicket({ runId: "", profile: GOOD_PROFILE, port: GOOD_PORT })).includes(
    "non-empty string",
  ),
  true,
);

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 2: the upgrade handler accepts a ticket and NOTHING else
 * ══════════════════════════════════════════════════════════════════════════ */

section("2. handleBrowserTakeoverUpgrade — one authentication rule");

/* The two arms that used to exist took a run id or a profile straight out of
 * the URL. Guessing a 12-hex run id would have opened a live Chrome. Both are
 * asserted dead by BEHAVIOUR — the matcher must return null — because a
 * deleted arm can be reintroduced without any of its old comments coming back. */
check(
  "bare run id in the URL · not an upgrade route",
  matchTakeoverUpgradePath("/api/uploads/7a0c6432cde4/vnc/websockify"),
  null,
);
check(
  "bare profile in the URL · not an upgrade route",
  matchTakeoverUpgradePath("/api/uploads/browser/r704-loginwall/vnc/websockify"),
  null,
);
check(
  "bare run id under the takeover prefix itself · not an upgrade route",
  matchTakeoverUpgradePath("/api/browser-takeover/ws/7a0c6432cde4/websockify"),
  null,
);
check("the prefix with no ticket at all · not an upgrade route", matchTakeoverUpgradePath("/api/browser-takeover/ws/"), null);
check("an unrelated websocket path · not an upgrade route", matchTakeoverUpgradePath("/api/chat/stream"), null);

const matched = matchTakeoverUpgradePath(`/api/browser-takeover/ws/${ticket}`);
ok("a ticket URL matches", matched !== null, "the one route must still work");
check("…and its only kind is \"ticket\"", matched?.kind, "ticket");
check("…carrying the ticket verbatim", matched?.ticket, ticket);

/* No caller-supplied port. An `options` parameter would be a second way to
 * choose where the socket points, and the ticket must be the only one. */
check("handleBrowserTakeoverUpgrade takes (req, socket, head) and nothing more", handleBrowserTakeoverUpgrade.length, 3);

/* End-to-end through the resolver, which is what actually decides whether a
 * byte moves. */
clearSpentTakeoverTicketJtis();
const liveTicket = mintTakeoverTicket({ runId: GOOD_RUN, profile: GOOD_PROFILE, port: GOOD_PORT });
const resolved = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: liveTicket });
ok("valid ticket · resolves to a loopback target", !isTakeoverUpgradeRejection(resolved), JSON.stringify(resolved));
if (!isTakeoverUpgradeRejection(resolved)) {
  check("…on the port from the signed payload", resolved.targetPort, GOOD_PORT);
  check("…for the profile from the signed payload", resolved.profile, GOOD_PROFILE);
}

const replay = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: liveTicket });
ok("the same ticket a second time · refused", isTakeoverUpgradeRejection(replay), JSON.stringify(replay));
if (isTakeoverUpgradeRejection(replay)) {
  check("…with status 401", replay.status, 401);
  check("…reason ticket_replayed", replay.reason, "ticket_replayed");
}

const garbage = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: "not-a-ticket" });
ok("garbage ticket · refused", isTakeoverUpgradeRejection(garbage), JSON.stringify(garbage));
if (isTakeoverUpgradeRejection(garbage)) {
  check("…with status 401", garbage.status, 401);
  ok("…and the body says nothing but Unauthorized", garbage.error === "Unauthorized", garbage.error);
}

const expiredResolved = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: forge({ exp: Date.now() - 1 }) });
ok("expired ticket · refused at the resolver", isTakeoverUpgradeRejection(expiredResolved), JSON.stringify(expiredResolved));
if (isTakeoverUpgradeRejection(expiredResolved)) {
  check("…reason ticket_expired", expiredResolved.reason, "ticket_expired");
}

/* An unconfigured box must refuse the socket, not crash the listener and not
 * open it. 503 rather than 401: this is an operator error, not an intruder. */
withSecret(undefined);
const unconfigured = resolveTakeoverUpgradeTarget({ kind: "ticket", ticket: liveTicket });
ok("no signing secret on the box · socket refused, listener survives", isTakeoverUpgradeRejection(unconfigured), JSON.stringify(unconfigured));
if (isTakeoverUpgradeRejection(unconfigured)) {
  check("…with status 503", unconfigured.status, 503);
  check("…reason ticket_secret_unavailable", unconfigured.reason, "ticket_secret_unavailable");
}
withSecret(TEST_SECRET);

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 3: both port-allowlist range checks are still there
 * ══════════════════════════════════════════════════════════════════════════ */

section("3. the loopback port allowlist, in both places");

const takeoverSrc = readRepoFile("forge-control/src/lib/browser-takeover.ts");

check("NOVNC_PORT_BASE is 6900", NOVNC_PORT_BASE, 6900);
check("DISPLAY_SPAN is 60 (so the range is 6900-6959)", DISPLAY_SPAN, 60);

/* Source text, not behaviour, and the comment in browser-takeover.ts explains
 * why: the second check sits BEHIND verify, which already applies the same two
 * constants, so as the code stands no signed ticket can reach it. It is the
 * layer that survives verify being relaxed. Being unreachable is exactly why
 * it needs its own control — nothing else would notice it going missing.
 * (fleet note: unreachable-guard-needs-its-own-control) */
const lowerBoundHits = takeoverSrc.match(/<\s*NOVNC_PORT_BASE\b/g) ?? [];
const upperBoundHits = takeoverSrc.match(/>=\s*NOVNC_PORT_BASE\s*\+\s*DISPLAY_SPAN\b/g) ?? [];
ok(
  "two lower-bound checks (HTTP proxy + upgrade resolver)",
  lowerBoundHits.length >= 2,
  `found ${lowerBoundHits.length}`,
);
ok(
  "two upper-bound checks (HTTP proxy + upgrade resolver)",
  upperBoundHits.length >= 2,
  `found ${upperBoundHits.length}`,
);
ok(
  "the range is never widened by a literal port constant",
  !/\b(0\.0\.0\.0|127\.0\.0\.1):(?!69[0-5][0-9]\b)\d+\s*(?:websockify|vnc)/i.test(takeoverSrc),
  "no non-allowlisted host:port pairs into websockify",
);
ok(
  "the socket is only ever aimed at loopback",
  !/host:\s*["'](?!127\.0\.0\.1)/.test(takeoverSrc),
  "proxyTakeoverUpgrade must dial 127.0.0.1 and nothing else",
);

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 4: no surviving claim that next.config.mjs proxies the upgrade
 * ══════════════════════════════════════════════════════════════════════════ */

section("4. the false next.config.mjs claim stays dead");

/* The comment that used to sit above proxyTakeoverUpgrade said Next.js carried
 * the upgrade to this process via next.config.mjs. It never did, and believing
 * it is a large part of why the gap survived several rounds. But the CORRECTED
 * comment necessarily names the same file, so "grep for next.config.mjs" would
 * fire on the fix. The rule that survives both: every mention of that file in
 * browser-takeover.ts must sit inside a window that also refutes it. */
const NEGATION_RE = /(does not|never did|no `?rewrites\(\)`?|cannot host|has no rewrites|is not)/i;
const WINDOW = 400;

function unrefutedNextConfigClaims(source: string): string[] {
  const problems: string[] = [];
  const needle = "next.config.mjs";
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    const window = source.slice(Math.max(0, i - WINDOW), i + WINDOW);
    if (!NEGATION_RE.test(window)) problems.push(source.slice(Math.max(0, i - 80), i + 80).replace(/\s+/g, " "));
  }
  return problems;
}

const mentions = (takeoverSrc.match(/next\.config\.mjs/g) ?? []).length;
const unrefuted = unrefutedNextConfigClaims(takeoverSrc);
ok(
  `every next.config.mjs mention in browser-takeover.ts is refuted (${mentions} mention(s) scanned)`,
  unrefuted.length === 0,
  unrefuted.join("\n        "),
);

/* Negative control: the scanner must actually fire on the original false claim.
 * Without this, a scanner that always returns [] would report a clean tree
 * forever. (fleet note: verifier-asserted-on-fixture-not-invariant) */
const SYNTHETIC_FALSE_CLAIM =
  "/** The socket arrives here because Next.js proxies these upgrades to this process via next.config.mjs rewrites. */";
ok(
  "negative control · the scanner flags the original false claim",
  unrefutedNextConfigClaims(SYNTHETIC_FALSE_CLAIM).length === 1,
  "a scanner that cannot fire proves nothing",
);

/* Ground truth, so the refutation is not merely self-consistent prose. */
const nextConfig = readRepoFile("forge-control-web/next.config.mjs");
ok("next.config.mjs really has no rewrites()", !/\brewrites\s*\(/.test(nextConfig), nextConfig.slice(0, 120));
ok("…and no redirects() either", !/\bredirects\s*\(/.test(nextConfig), "");

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 5: the client can only build a ticketed URL
 * ══════════════════════════════════════════════════════════════════════════ */

section("5. vncProxyUrl — ticket in the path, reconnect off");

const DIR_ID = "7a0c6432cde4";
const url = vncProxyUrl(DIR_ID, ticket);
ok("a ticketed URL is produced", url !== null, String(url));
if (url !== null) {
  ok(
    "…carrying path=api/browser-takeover/ws/<ticket>",
    url.includes(`path=api/browser-takeover/ws/${ticket}`),
    url,
  );
  ok("…and reconnect=0", /[?&]reconnect=0\b/.test(url), url);
  ok(
    "…and NOT the old unauthenticated websockify path",
    !url.includes("/vnc/websockify"),
    url,
  );
}

/* noVNC rebuilds its socket URL from the `path` setting frozen at page load, so
 * an auto-reconnect replays an EXPIRED ticket and shows Konrad an opaque
 * failure. reconnect=0 is load-bearing, not cosmetic. */
check("no ticket · no URL at all", vncProxyUrl(DIR_ID), null);
check("empty ticket · no URL at all", vncProxyUrl(DIR_ID, ""), null);
check("null ticket · no URL at all", vncProxyUrl(DIR_ID, null), null);
check("malformed dir id · no URL at all", vncProxyUrl("../../etc", ticket), null);
check("the mint path stays behind /api/proxy (and therefore NextAuth)", takeoverTicketUrl(DIR_ID), "/api/proxy/uploads/7a0c6432cde4/vnc/ticket");
check("malformed dir id · no mint URL", takeoverTicketUrl("nope"), null);

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 6: the nginx location, and nothing else under that prefix
 * ══════════════════════════════════════════════════════════════════════════ */

section("6. deploy/nginx — the location block and its blast radius");

const NGINX_REL = "deploy/nginx/os.schreinercontentsystems.com.conf";
const nginxSrc = readRepoFile(NGINX_REL);

/** The body of `location /api/browser-takeover/ws/ { … }`, or null. */
function takeoverLocationBody(conf: string): string | null {
  const start = conf.indexOf("location /api/browser-takeover/ws/");
  if (start === -1) return null;
  const open = conf.indexOf("{", start);
  if (open === -1) return null;
  const close = conf.indexOf("}", open);
  if (close === -1) return null;
  return conf.slice(open + 1, close);
}

const body = takeoverLocationBody(nginxSrc);
ok("the location block exists", body !== null, NGINX_REL);
if (body !== null) {
  ok("proxy_pass → 127.0.0.1:7700 (forge-control, not Next)", /proxy_pass\s+http:\/\/127\.0\.0\.1:7700\s*;/.test(body), body);
  ok("proxy_http_version 1.1 (an upgrade cannot ride HTTP/1.0)", /proxy_http_version\s+1\.1\s*;/.test(body), body);
  ok("Upgrade header forwarded", /proxy_set_header\s+Upgrade\s+\$http_upgrade\s*;/.test(body), body);
  ok("Connection header from the global $connection_upgrade map", /proxy_set_header\s+Connection\s+\$connection_upgrade\s*;/.test(body), body);
  ok("access_log off — the ticket is a bearer credential in the URI", /access_log\s+off\s*;/.test(body), body);
  ok("long read/send timeouts (Konrad types a password by hand)", /proxy_read_timeout\s+\d+s\s*;/.test(body) && /proxy_send_timeout\s+\d+s\s*;/.test(body), body);
}

/* Ordering: nginx picks the longest matching prefix regardless of order, so
 * this is about the file being readable by the next human, not about routing.
 * It is still worth pinning — the runbook tells the deploy to insert the block
 * before `location /`, and a copy that drifted from the runbook is a copy the
 * deploy cannot follow literally. */
ok(
  "the block sits before `location /` in the file",
  nginxSrc.indexOf("location /api/browser-takeover/ws/") < nginxSrc.indexOf("location / {"),
  "",
);
ok(
  "$connection_upgrade is NOT redefined here (it is mapped globally in conf.d)",
  !/^\s*map\s+\$http_upgrade/m.test(nginxSrc),
  "a duplicate map at http scope is a hard nginx config error",
);
/* Prose assertions run against a REFLOW-PROOF view: comment markers stripped
 * and whitespace collapsed, so a warning that gets re-wrapped across two `#`
 * lines still reads as the same sentence. A line-anchored phrase check goes
 * red on a cosmetic edit and then gets deleted as noise — which is how the
 * warning it was protecting quietly disappears.
 * (fleet note: notification-gap-pin-rules-anchored) */
const nginxProse = nginxSrc.replace(/^[ \t]*#[ \t]?/gm, " ").replace(/\s+/g, " ").toUpperCase();
ok(
  "the bypass is documented as a bypass, loudly",
  nginxProse.includes("BYPASSES NEXTAUTH") && nginxProse.includes("NOTHING ELSE MAY EVER BE MOUNTED"),
  "the next person to edit this file has to be told what it is",
);
ok(
  "the `access_log off` line is explained rather than left looking like a tidy-up",
  nginxProse.includes("ACCESS_LOG OFF` IS DELIBERATE") || nginxProse.includes("ACCESS_LOG OFF IS DELIBERATE"),
  "",
);

/* Negative control for the directive scanner: a block missing `access_log off`
 * must come back dirty. */
const SYNTHETIC_LEAKY_BLOCK = `
    location /api/browser-takeover/ws/ {
        proxy_pass http://127.0.0.1:7700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
`;
const leakyBody = takeoverLocationBody(SYNTHETIC_LEAKY_BLOCK);
ok(
  "negative control · a block without access_log off is detected",
  leakyBody !== null && !/access_log\s+off\s*;/.test(leakyBody),
  "the directive scanner must be able to fail",
);

/* ── 6.0 the corpus, and the exclusion that makes it honest ─────────────── */

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".conf"]);

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
}

/**
 * Files where a route can actually be mounted.
 *
 * Three exclusions, each for its own reason:
 *  - extension: prose cannot mount a route, so .md/.json/.sql are not scanned
 *    at all. This is the scoping fix from the fleet note
 *    checker-names-its-own-forbidden-strings — narrow the corpus to the file
 *    types where the token has force, rather than special-casing files.
 *  - `docs/`: the runbook and the plan quote these literals by necessity.
 *  - this file: it names every forbidden literal in order to forbid it.
 *
 * `CHECK_DISCRIMINATION=no-self-exclusion` puts this file BACK into the corpus.
 * That is the reproducible proof that the exclusion is doing work rather than
 * hiding a hole: with it set, §6.0/§6.1/§6.2 all go red on this very file.
 * Measured 2026-08-25 — 3 FAILs set, 0 unset. The switch can only ever make the
 * gate stricter, never laxer, so it cannot be used to sneak past a real finding.
 */
function mountCorpus(): string[] {
  return trackedFiles()
    .filter((f) => CODE_EXTENSIONS.has(extname(f)))
    .filter((f) => !f.startsWith("docs/"))
    .filter((f) => f !== SELF_REL || process.env.CHECK_DISCRIMINATION === "no-self-exclusion");
}

const corpus = mountCorpus();
ok(`the corpus is non-empty (${corpus.length} code/config files)`, corpus.length > 100, "");
ok("…and this file is not in it", !corpus.includes(SELF_REL), SELF_REL);
ok("…and no docs/ file is in it", corpus.every((f) => !f.startsWith("docs/")), "");

/* THE EXCLUSION PROOF. This file's own source contains both forbidden literals
 * — `api/browser-takeover/ws/` in §5's expected value, and the pipe function's
 * call form named right here: proxyTakeoverUpgrade( — so if the SELF_REL filter
 * above were ever deleted, §6.1 and §6.2 would fail on this file and the gate
 * would go red. That is the point: the exclusion is load-bearing, not
 * decorative, and this assertion goes red if it ever stops being so. */
const selfSrc = readFileSync(SELF_PATH, "utf8");
ok(
  "exclusion is load-bearing · this file itself carries the forbidden literals",
  selfSrc.includes("api/browser-takeover/ws/") && selfSrc.includes("proxyTakeoverUpgrade("),
  "if this goes false the self-exclusion has stopped being exercised and proves nothing",
);
const excludedButMatching = trackedFiles().filter(
  (f) =>
    (f === SELF_REL || f.startsWith("docs/") || !CODE_EXTENSIONS.has(extname(f))) &&
    (() => {
      try {
        return readRepoFile(f).includes("api/browser-takeover/ws/");
      } catch {
        return false;
      }
    })(),
);
console.log(`      excluded-but-matching files (would have failed without the exclusion): ${excludedButMatching.join(", ") || "none"}`);
ok("…and there is at least one, so the exclusion is exercised on every run", excludedButMatching.length >= 1, "");

/* ── 6.1 nothing else is mounted under the nginx prefix ─────────────────── */

/* Every code file that names the public upgrade prefix. The nginx location is a
 * PREFIX match, so anything forge-control serves under it is public. This is
 * the allowlist of files permitted to know that path exists; a new name here is
 * a new public route until proven otherwise. */
const WS_PREFIX_ALLOWED = new Set([
  "forge-control/src/lib/browser-takeover.ts", // the one handler
  "forge-control/src/lib/browser-takeover.test.ts", // its tests
  "forge-control/src/routes/uploads.ts", // the authenticated mint, which returns the path
  "forge-control-web/app/desktop/chat/browser-shots.ts", // vncProxyUrl builds it
  "scripts/checks/check-browser-shots.ts", // asserts vncProxyUrl's output
  "scripts/checks/check-browser-stream-viewer.ts", // asserts the viewer's iframe src
  NGINX_REL, // the location block itself
  // The request logger names the prefix in order to REDACT it (186c73a).
  // forge-control's catch-all middleware printed c.req.path for every request,
  // so a non-upgrade GET wrote the whole bearer ticket — payload and signature
  // — into forge-control-out.log, which rotates and is retained. Found
  // 2026-08-25 by the takeover deploy, which had leaked one of its own live
  // tickets that way. A real noVNC connection is an UPGRADE and never reaches
  // Hono middleware, so only link previews, crawlers, address-bar pastes and
  // probes trigger it — and a non-upgrade GET does NOT burn the jti, so a
  // ticket logged this way stays live for the rest of its TTL.
  //
  // This entry is why the rule is an allowlist of PATHS rather than a ban on
  // the string: closing the third door required naming it.
  "forge-control/src/index.ts",
]);

const wsPrefixHits = corpus.filter((f) => {
  try {
    return readRepoFile(f).includes("api/browser-takeover/ws/");
  } catch {
    return false;
  }
});
const unexpectedWs = wsPrefixHits.filter((f) => !WS_PREFIX_ALLOWED.has(f));
ok(
  `only known files name the public upgrade prefix (${wsPrefixHits.length} hit(s))`,
  unexpectedWs.length === 0,
  `unexpected: ${unexpectedWs.join(", ")}`,
);
ok(
  "…and the nginx conf is one of them, so the allowlist is not stale",
  wsPrefixHits.includes(NGINX_REL),
  wsPrefixHits.join(", "),
);

/* ── 6.2 nothing else pipes a takeover socket ───────────────────────────── */

/* proxyTakeoverUpgrade is the function that moves bytes onto the loopback VNC
 * port. Exactly one module may call it, and that module is the one that
 * verifies the ticket first. A second call site anywhere is a second, unaudited
 * way to open the socket. */
const PIPE_ALLOWED = new Set(["forge-control/src/lib/browser-takeover.ts"]);
const pipeCallers = corpus.filter((f) => {
  try {
    return /proxyTakeoverUpgrade\s*\(/.test(readRepoFile(f));
  } catch {
    return false;
  }
});
const unexpectedPipe = pipeCallers.filter((f) => !PIPE_ALLOWED.has(f));
ok(
  `only browser-takeover.ts pipes a takeover socket (${pipeCallers.length} caller file(s))`,
  unexpectedPipe.length === 0,
  `unexpected: ${unexpectedPipe.join(", ")}`,
);

/* ══════════════════════════════════════════════════════════════════════════
 * SECTION 7: the signing key is never committed
 * ══════════════════════════════════════════════════════════════════════════ */

section("7. TAKEOVER_TICKET_SECRET — name only, never a value");

/* A DIFFERENT corpus policy from §6 on purpose: this one scans docs and
 * markdown too, because a real key pasted into a runbook is exactly as leaked
 * as one pasted into a module. Only this file is excluded, and only because it
 * carries the test placeholders. */
const SECRET_ASSIGNMENT_RE = /TAKEOVER_TICKET_SECRET\s*[=:]\s*(['"]?)([^\s'"`,;)}]+)\1/g;
/* A value carrying any of these is labelled, not live: shell substitution, a
 * bracketed placeholder, an ellipsis, or a word that only appears in fakes. */
const PLACEHOLDER_RE = /[<>${}]|…|\.\.\.|PLACEHOLDER|EXAMPLE|REDACTED|FAKE|SYNTHETIC|TEST|process\.env|^["']{2}$/i;
const SKIP_BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".lock"]);

const leaks: string[] = [];
let secretScanned = 0;
for (const file of trackedFiles()) {
  if (file === SELF_REL) continue; // carries the test placeholders above
  if (SKIP_BINARY.has(extname(file))) continue;
  let content: string;
  try {
    content = readRepoFile(file);
  } catch {
    continue;
  }
  secretScanned++;
  for (const m of content.matchAll(SECRET_ASSIGNMENT_RE)) {
    const value = m[2];
    if (value.length >= 16 && !PLACEHOLDER_RE.test(value)) leaks.push(`${file}: ${m[0].slice(0, 60)}`);
  }
}
ok(
  `no tracked file assigns a literal signing key (${secretScanned} files scanned, docs included)`,
  leaks.length === 0,
  leaks.join("\n        "),
);

/* Negative control: the scanner fires on a real-shaped 64-hex key. */
const SYNTHETIC_LEAK = `TAKEOVER_TICKET_SECRET=${"9f3c".repeat(16)}`;
const syntheticHits = [...SYNTHETIC_LEAK.matchAll(SECRET_ASSIGNMENT_RE)].filter(
  (m) => m[2].length >= 16 && !PLACEHOLDER_RE.test(m[2]),
);
ok("negative control · a committed 64-hex key would be caught", syntheticHits.length === 1, "");

/* And the runbook must talk about the secret without being able to leak it. */
const runbook = readRepoFile("docs/plan/aios-browser-takeover-live/deploy.md");
ok("the deploy runbook exists and names the variable", runbook.includes("TAKEOVER_TICKET_SECRET"), "");
ok(
  "…and generates it rather than shipping one",
  /openssl\s+rand\s+-hex\s+32/.test(runbook),
  "",
);
ok(
  "…and wires it as a pass-through, never through required()",
  /process\.env\.TAKEOVER_TICKET_SECRET\s*\|\|\s*(''|"")/.test(runbook) && /required\(/.test(runbook),
  "required() throws and refuses to boot — a restart ahead of the secret file takes the OS down",
);
ok(
  "…and restarts only via safe-restart.sh",
  runbook.includes("safe-restart.sh"),
  "",
);
ok("…and runs nginx -t before any reload", /nginx\s+-t/.test(runbook), "");
ok("…and carries a rollback", /rollback/i.test(runbook), "");

/* ══════════════════════════════════════════════════════════════════════════ */

withSecret(ORIGINAL_SECRET);

console.log(
  failures === 0
    ? "\nALL PASS — the takeover socket has exactly one authentication rule, and it is the ticket"
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
