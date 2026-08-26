/**
 * check-vm-keys.ts — the pure half of the takeover text-to-VM feature
 * (aios-takeover-usable B1, PLAN.md §1.1/§1.3).
 *
 * Covers, with no browser and no DOM:
 *   1. vm-keys.ts       — text → RFB keysym events: CRLF/LF/CR → one Return,
 *                         Tab, Latin-1 identity, the noVNC table (€), the
 *                         Unicode fallback, code-point iteration (emoji is ONE
 *                         event), dropped C0 controls, the table's row count.
 *   2. novnc-bridge.ts  — stateFromClassList: the four noVNC classes, and the
 *                         fact that 'disconnected' is the ABSENCE of all four
 *                         once one has been seen (there is no noVNC_disconnected).
 *   3. useTakeoverSession.ts — formatRemaining and composeStatusLine: the
 *                         exact header strings the brief names, incl. the
 *                         'forge-control predates this build' wording and the
 *                         reconnect schedule constants.
 *   4. browser-shots.ts — takeoverSessionUrl / takeoverEndUrl stay behind
 *                         /api/proxy and refuse a malformed id.
 *
 * Every rule here was measured by R1 on the real stack
 * (docs/plan/aios-takeover-usable/research-keysym.md); this file pins the
 * pure functions to those measurements so a refactor cannot drift them.
 *
 * Run (the way gates-808.sh does):
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-vm-keys.ts
 */

import {
  BMP_TABLE_SIZE,
  KEY_DELAY_MS,
  REMAP_KEY_DELAY_MS,
  XK_RETURN,
  XK_TAB,
  countKeyEvents,
  isInBaseKeymap,
  keyGapMs,
  keysymForCodePoint,
  textToKeyEvents,
} from "../../forge-control-web/app/takeover/[runId]/vm-keys.ts";
import {
  NOVNC_HANDLE_TIMEOUT_MS,
  stateFromClassList,
} from "../../forge-control-web/app/takeover/[runId]/novnc-bridge.ts";
import { countOutsideLatin1 } from "../../forge-control-web/app/takeover/[runId]/TextToVM.tsx";
import {
  RECONNECT_DELAYS_MS,
  RECONNECT_MAX_ATTEMPTS,
  SESSION_POLL_MS,
  SESSION_WARN_UNDER_MS,
  capRemainingAtFetch,
  composeStatusLine,
  formatRemaining,
  idleRemainingAtFetch,
  msUntil,
} from "../../forge-control-web/app/takeover/[runId]/useTakeoverSession.ts";
import {
  takeoverEndUrl,
  takeoverSessionUrl,
} from "../../forge-control-web/app/desktop/chat/browser-shots.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}
const hex = (events: readonly { keysym: number }[]): string =>
  events.map((e) => e.keysym.toString(16)).join(" ");
function eq(label: string, actual: string, expected: string): void {
  check(label, actual === expected, `got "${actual}", want "${expected}"`);
}

/* ── 1. vm-keys ──────────────────────────────────────────────────────────── */
section("1. vm-keys · text → keysym events");

check("XK_RETURN is 0xff0d", XK_RETURN === 0xff0d);
check("XK_TAB is 0xff09", XK_TAB === 0xff09);
check(
  `KEY_DELAY_MS is a small non-negative integer (${KEY_DELAY_MS} ms; R1 §2.3: 0 ms passed 5/5, ≤8 ms is the plan's ceiling)`,
  Number.isInteger(KEY_DELAY_MS) && KEY_DELAY_MS >= 0 && KEY_DELAY_MS <= 8,
);
check(`noVNC 1.3.0 table carries 659 non-Latin-1 rows (loaded ${BMP_TABLE_SIZE})`, BMP_TABLE_SIZE === 659);

eq("ASCII is identity", hex(textToKeyEvents("aZ9 !@")), "61 5a 39 20 21 40");
eq("Latin-1 is identity (ä ö ü ß)", hex(textToKeyEvents("äöüß")), "e4 f6 fc df");
eq("€ U+20AC → table hit 0x20ac (XK_EuroSign)", hex(textToKeyEvents("€")), "20ac");
eq("ー U+30FC → table hit 0x4b0 (XK_prolongedsound)", hex(textToKeyEvents("ー")), "4b0");
eq("— U+2014 → table hit 0xaa9 (XK_emdash)", hex(textToKeyEvents("—")), "aa9");
eq("BMP char absent from the table → 0x01000000|cp", hex(textToKeyEvents("中")), "1004e2d");
eq("emoji 🙂 → ONE event, 0x0101f642 (not two surrogates)", hex(textToKeyEvents("🙂")), "101f642");
check("emoji counts as one key", countKeyEvents("a🙂b") === 3);

eq("\\r\\n → ONE Return", hex(textToKeyEvents("a\r\nb")), "61 ff0d 62");
eq("\\n → Return", hex(textToKeyEvents("a\nb")), "61 ff0d 62");
eq("lone \\r → Return (never the unicode CR keysym 0x0100000d)", hex(textToKeyEvents("a\rb")), "61 ff0d 62");
eq("\\r\\n\\r\\n → two Returns", hex(textToKeyEvents("\r\n\r\n")), "ff0d ff0d");
eq("\\n\\r → two Returns (LF then a lone CR)", hex(textToKeyEvents("\n\r")), "ff0d ff0d");
eq("\\t → XK_Tab", hex(textToKeyEvents("a\tb")), "61 ff09 62");
eq("C0 controls other than \\t \\n \\r are dropped (U+0001, U+001B)", hex(textToKeyEvents("ab")), "61 62");
eq("DEL U+007F is dropped", hex(textToKeyEvents("ab")), "61 62");
check("empty string → no events", textToKeyEvents("").length === 0);
check("a 300-char string yields 300 events", countKeyEvents("x".repeat(300)) === 300);

check("keysymForCodePoint(0x20) = 0x20", keysymForCodePoint(0x20) === 0x20);
check("keysymForCodePoint(0xff) = 0xff", keysymForCodePoint(0xff) === 0xff);
check("keysymForCodePoint(0x1f642) = 0x0101f642", keysymForCodePoint(0x1f642) === 0x0101f642);
let threw = false;
try {
  keysymForCodePoint(0x110000);
} catch {
  threw = true;
}
check("keysymForCodePoint refuses a non-code-point", threw);

/* ── 1b. TextToVM · the clipboard mode's Latin-1 guard ───────────────────── */
section("1b. TextToVM · countOutsideLatin1 (VNC clipboard is Latin-1 on x11vnc 0.9.16)");

check("Latin-1 text has 0 outside (Ä é ü ß, newline, tab)", countOutsideLatin1("Ä é ü ß\n\t") === 0);
check("€ counts as 1 outside", countOutsideLatin1("Preis €19") === 1);
check("emoji counts as ONE outside (code point, not two units)", countOutsideLatin1("🙂") === 1);
check("mixed: € + 🙂 + — = 3", countOutsideLatin1("a€b🙂c—d") === 3);
check("empty → 0", countOutsideLatin1("") === 0);

/* ── 2. novnc-bridge · state from the iframe's class list ────────────────── */
section("2. novnc-bridge · stateFromClassList");

eq("noVNC_connected → connected", stateFromClassList("noVNC_connected", true), "connected");
eq("noVNC_connecting → connecting", stateFromClassList("noVNC_connecting", false), "connecting");
eq("noVNC_disconnecting → disconnecting", stateFromClassList("noVNC_disconnecting", true), "disconnecting");
eq("noVNC_reconnecting → reconnecting", stateFromClassList("noVNC_reconnecting", true), "reconnecting");
eq("no class, nothing seen yet → init", stateFromClassList("", false), "init");
eq("no class after a class was seen → disconnected (there is no noVNC_disconnected)", stateFromClassList("", true), "disconnected");
eq("unrelated classes only → still init before first sighting", stateFromClassList("noVNC_loaded noVNC_touch", false), "init");
eq("unrelated classes only, after a sighting → disconnected", stateFromClassList("noVNC_loaded noVNC_touch", true), "disconnected");
eq("a literal 'noVNC_disconnected' class is NOT a state (it never exists)", stateFromClassList("noVNC_disconnected", true), "disconnected");
check("bridge attach deadline is 5 s (hard error after, never a silent fallback)", NOVNC_HANDLE_TIMEOUT_MS === 5_000);

/* ── 3. useTakeoverSession · clock strings and schedule ──────────────────── */
section("3. useTakeoverSession · formatRemaining, composeStatusLine, schedule");

eq("formatRemaining 1:52:10", formatRemaining((1 * 3600 + 52 * 60 + 10) * 1000), "1:52:10");
eq("formatRemaining 0:00:00 floor", formatRemaining(-5_000), "0:00:00");
eq("formatRemaining 0:09:59", formatRemaining(599_999), "0:09:59");

check(
  "reconnect schedule is 0 / 2 / 5 / 10 / 10 s — five fresh tickets",
  RECONNECT_DELAYS_MS.join(",") === "0,2000,5000,10000,10000" && RECONNECT_MAX_ATTEMPTS === 5,
);
check("session clock polled every 15 s", SESSION_POLL_MS === 15_000);
check("warn colour under 10 min", SESSION_WARN_UNDER_MS === 600_000);

const okClock = {
  kind: "ok" as const,
  body: {
    profile: "konrad-main",
    stack_up: true,
    supervisor_live: true,
    connected_sockets: 1,
    connects: 1,
    takeover_started_at: "2026-08-26T02:00:00Z",
    last_disconnect_at: null,
    idle_deadline: null,
    takeover_deadline: "2026-08-26T04:00:00Z",
    hard_deadline: null,
    remaining_ms: (1 * 3600 + 52 * 60 + 10) * 1000,
    now: "2026-08-26T02:07:50Z",
    ended: null,
  },
  remainingMs: (1 * 3600 + 52 * 60 + 10) * 1000,
  idleRemainingMs: null,
};

eq(
  "connected · ends in 1:52:10",
  composeStatusLine({ ticket: "ready", viewer: "connected", reconnect: null, clock: okClock, bridgeError: null }),
  "connected · ends in 1:52:10",
);
eq(
  "reconnecting 2/5 · dropped after 118 s (clock tail kept)",
  composeStatusLine({
    ticket: "loading",
    viewer: "disconnected",
    reconnect: { attempt: 2, max: 5, droppedAfterS: 118, exhausted: false },
    clock: okClock,
    bridgeError: null,
  }),
  "reconnecting 2/5 · dropped after 118 s · ends in 1:52:10",
);
eq(
  "exhausted → 'reconnect failed after 5 attempts'",
  composeStatusLine({
    ticket: "error",
    viewer: "disconnected",
    reconnect: { attempt: 5, max: 5, droppedAfterS: null, exhausted: true },
    clock: { kind: "loading" },
    bridgeError: null,
  }),
  "reconnect failed after 5 attempts",
);
eq(
  "ended → 'Session ended: <reason>' and nothing else",
  composeStatusLine({
    ticket: "ready",
    viewer: "disconnected",
    reconnect: { attempt: 1, max: 5, droppedAfterS: 10, exhausted: false },
    clock: { kind: "ended", reason: "takeover cap 2h", at: "2026-08-26T04:00:00Z" },
    bridgeError: null,
  }),
  "Session ended: takeover cap 2h",
);
eq(
  "404 from the session route → said in words",
  composeStatusLine({ ticket: "ready", viewer: "connected", reconnect: null, clock: { kind: "unavailable" }, bridgeError: null }),
  "connected · session clock unavailable — forge-control predates this build",
);
eq(
  "no clock armed yet → said in words",
  composeStatusLine({
    ticket: "ready",
    viewer: "connected",
    reconnect: null,
    clock: { ...okClock, remainingMs: null },
    bridgeError: null,
  }),
  "connected · no session clock armed",
);
eq(
  "bridge error → rendered, never silent",
  composeStatusLine({ ticket: "ready", viewer: "connected", reconnect: null, clock: okClock, bridgeError: "noVNC handle did not appear within 5000 ms" }),
  "viewer bridge failed: noVNC handle did not appear within 5000 ms",
);
eq(
  "minting → 'minting ticket'",
  composeStatusLine({ ticket: "loading", viewer: "init", reconnect: null, clock: { kind: "loading" }, bridgeError: null }),
  "minting ticket",
);

/* ── 3b. B8 · remap-aware key gaps; the cap is the clock, idle is separate ── */
section("3b. B8 · keyGapMs / isInBaseKeymap, capRemainingAtFetch / idleRemainingAtFetch, idle tail");

check(
  `REMAP_KEY_DELAY_MS (${REMAP_KEY_DELAY_MS}) is ≥ 10× KEY_DELAY_MS and ≤ 200 ms`,
  REMAP_KEY_DELAY_MS >= KEY_DELAY_MS * 10 && REMAP_KEY_DELAY_MS <= 200,
);
check(
  "printable ASCII, Return and Tab are in the VM's base keymap",
  isInBaseKeymap(0x20) && isInBaseKeymap(0x61) && isInBaseKeymap(0x7e) && isInBaseKeymap(XK_RETURN) && isInBaseKeymap(XK_TAB),
);
check(
  "ä ß € 🙂 and a table hit (ー) are NOT — x11vnc must -add_keysyms them",
  !isInBaseKeymap(0xe4) && !isInBaseKeymap(0xdf) && !isInBaseKeymap(0x20ac) && !isInBaseKeymap(0x0101f642) && !isInBaseKeymap(0x4b0),
);
check("ASCII → ASCII keeps KEY_DELAY_MS", keyGapMs(0x61, 0x62) === KEY_DELAY_MS);
check("after a remapped key → REMAP gap", keyGapMs(0xdf, 0x41) === REMAP_KEY_DELAY_MS);
check("before a remapped key → REMAP gap", keyGapMs(0x41, 0xdf) === REMAP_KEY_DELAY_MS);
check("last key: ASCII → KEY_DELAY_MS, remapped → REMAP", keyGapMs(0x61, null) === KEY_DELAY_MS && keyGapMs(0x20ac, null) === REMAP_KEY_DELAY_MS);
{
  // The string B5 lost ß in under load: every gap touching one of its seven
  // non-keymap keysyms is the slow one (11 of 15), the four ASCII-only gaps stay fast.
  const ev = textToKeyEvents("Pässwörd ßÄÖÜ €");
  const g = ev.map((e, i) => keyGapMs(e.keysym, i + 1 < ev.length ? ev[i + 1].keysym : null));
  const slow = g.filter((x) => x === REMAP_KEY_DELAY_MS).length;
  check(`"Pässwörd ßÄÖÜ €": ${slow}/${g.length} gaps are REMAP, ${g.length - slow} stay KEY_DELAY_MS`, slow === 11 && g.length === 15);
}

// The route body B5 measured: remaining_ms is the EARLIEST deadline, which
// while connected is the sliding 1 h idle clock — the header must not show it.
const capBody = {
  ...okClock.body,
  idle_deadline: "2026-08-26T03:07:50Z",
  takeover_deadline: "2026-08-26T04:00:00Z",
  hard_deadline: "2026-08-26T09:00:00Z",
  remaining_ms: 3_600_000,
  now: "2026-08-26T02:07:50Z",
};
check(
  "capRemainingAtFetch is the TAKEOVER cap (1:52:10), never remaining_ms (the idle hour)",
  capRemainingAtFetch(capBody) === (1 * 3600 + 52 * 60 + 10) * 1000,
  String(capRemainingAtFetch(capBody)),
);
check("idleRemainingAtFetch = idle_deadline − now = 1:00:00", idleRemainingAtFetch(capBody) === 3_600_000);
check(
  "no takeover cap armed yet → the hard cap (6:52:10)",
  capRemainingAtFetch({ ...capBody, takeover_deadline: null }) === (6 * 3600 + 52 * 60 + 10) * 1000,
);
check("no cap at all → null (rendered as 'no session clock armed')", capRemainingAtFetch({ ...capBody, takeover_deadline: null, hard_deadline: null }) === null);
check("no idle deadline → null", idleRemainingAtFetch({ ...capBody, idle_deadline: null }) === null);
let threwBad = false;
try {
  msUntil("not-a-timestamp", capBody.now, "takeover_deadline");
} catch (e) {
  threwBad = /takeover_deadline/.test((e as Error).message);
}
check("an unparseable deadline throws, naming the field (no NaN clock)", threwBad);
eq(
  "connected: the idle clock is NOT rendered (it slides while a socket is up)",
  composeStatusLine({
    ticket: "ready",
    viewer: "connected",
    reconnect: null,
    clock: { kind: "ok", body: capBody, remainingMs: 6_730_000, idleRemainingMs: 3_600_000 },
    bridgeError: null,
  }),
  "connected · ends in 1:52:10",
);
eq(
  "nobody connected: the cap first, then the idle deadline, labelled",
  composeStatusLine({
    ticket: "loading",
    viewer: "disconnected",
    reconnect: { attempt: 2, max: 5, droppedAfterS: 118, exhausted: false },
    clock: { kind: "ok", body: { ...capBody, connected_sockets: 0 }, remainingMs: 6_730_000, idleRemainingMs: 3_492_000 },
    bridgeError: null,
  }),
  "reconnecting 2/5 · dropped after 118 s · ends in 1:52:10 · idle: stack closes in 0:58:12 unless reconnected",
);

/* ── 4. browser-shots · the two new URLs ─────────────────────────────────── */
section("4. browser-shots · takeoverSessionUrl / takeoverEndUrl");

eq("session url stays behind /api/proxy", takeoverSessionUrl("7a0c6432cde4") ?? "null", "/api/proxy/uploads/7a0c6432cde4/takeover/session");
eq("end url stays behind /api/proxy", takeoverEndUrl("7a0c6432cde4") ?? "null", "/api/proxy/uploads/7a0c6432cde4/takeover/end");
check("malformed id → no session url", takeoverSessionUrl("../../etc") === null);
check("malformed id → no end url", takeoverEndUrl("nope") === null);
check("uppercase hex is not a run id", takeoverSessionUrl("7A0C6432CDE4") === null);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — vm-keys, novnc-bridge state, session clock strings`);
process.exit(failures === 0 ? 0 : 1);
