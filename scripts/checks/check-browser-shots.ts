/**
 * check-browser-shots.ts — executable unit check for the screenshot extractor
 * (`app/desktop/chat/browser-shots.ts`, round 1350).
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-tool-summary.ts, deliberately.
 *
 * WHAT IS REAL HERE, AND WHY IT MATTERS
 *   docs/plan/artifacts/phase1350/fixtures/run-7a0c6432-browser.json is the
 *   FULL 172-entry thread of run 7a0c6432-cde4-4ca1-8f17-ff340c236c0a, taken
 *   verbatim from `runs.thread`. That run photographed the settings surface in
 *   both themes, and `/opt/ai-os/uploads/7a0c6432cde4/` holds exactly those two
 *   files today — so "2 shots" is checked against the disk, not against the
 *   author's expectation. One of its two payloads was piped through
 *   `grep -A3 '"path"'` before it was written to the thread: three lines of a
 *   JSON object with the braces gone. It is the reason this extractor matches
 *   the record SHAPE rather than parsing JSON, and it is the reason that entry
 *   is asserted by hand below.
 *
 *   read-uploads-entries.json holds two real `Read` tool_calls, also verbatim:
 *   a research shot and a chat attachment (`image.png`), which is the pair that
 *   forces the provenance distinction `shotsNoun` makes.
 *
 * Run:
 *   cd forge-control-web && npx tsx ../scripts/checks/check-browser-shots.ts
 */

import { readFileSync } from "node:fs";

import type { ThreadEntry } from "../../forge-control-web/app/api.ts";
import {
  mapThreadToMessages,
  type ToolCallPart,
} from "../../forge-control-web/app/desktop/chat/thread-mapping.ts";
import {
  extractBrowserShots,
  isLoginWallName,
  newestFirst,
  parseShotName,
  resolveStreamMode,
  resolveStreamWarning,
  shotSrc,
  shotsNoun,
  shotClock,
  stampToIso,
  uploadsDirId,
  vncProxyUrl,
  type BrowserShotRef,
  type ToolCallLike,
} from "../../forge-control-web/app/desktop/chat/browser-shots.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

function checkRef(name: string, actual: BrowserShotRef | undefined, expected: BrowserShotRef): void {
  if (actual === undefined) {
    failures++;
    console.log(`FAIL  ${name} — no ref at this position`);
    return;
  }
  check(`${name} · dirId`, actual.dirId, expected.dirId);
  check(`${name} · name`, actual.name, expected.name);
  check(`${name} · url`, actual.url, expected.url);
  check(`${name} · label`, actual.label, expected.label);
  check(`${name} · ts`, actual.ts, expected.ts);
  check(`${name} · source`, actual.source, expected.source);
}

const bash = (result: unknown): ToolCallLike => ({ toolName: "Bash", argsText: "{}", result });
const read = (argsText: string): ToolCallLike => ({ toolName: "Read", argsText });

/* ── 1. The run-id → directory convention ────────────────────────────────── */

console.log("── uploadsDirId — pinned to cc-runner.ts:138 ────────────────");
/* Copied from forge-control/src/lib/cc-runner.test.ts:80. If this line ever
 * fails, the ENGINE's convention moved and this renderer is the thing that is
 * wrong. */
check(
  "a runs.id UUID becomes its first 12 hex characters",
  uploadsDirId("ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f"),
  "ece63bdb1f2a",
);
check(
  "uppercase is lowered, dashes dropped (same test's second case)",
  uploadsDirId("ECE63BDB-1F2A-4C3D-9E8F-0A1B2C3D4E5F"),
  "ece63bdb1f2a",
);
check(
  "a real run of this fleet — the fixture's own id",
  uploadsDirId("7a0c6432-cde4-4ca1-8f17-ff340c236c0a"),
  "7a0c6432cde4",
);
check("an already-servable 12-hex id survives", uploadsDirId("abcdefabcdef"), "abcdefabcdef");
check("too few hex characters → null, not a guess", uploadsDirId("zz-zz-1"), null);
check("null id → null (the renderer never throws)", uploadsDirId(null), null);
check("undefined id → null", uploadsDirId(undefined), null);
/* A sub-agent's node id is a `tool_use_id`, and this is why the panels gate on
 * kind before calling: the hex filter alone would happily produce a directory. */
check(
  "a tool_use_id yields fewer than 12 hex chars here — but callers still gate on kind",
  uploadsDirId("toolu_01MaHAmBw6xEeRspqLSevWXA"),
  null,
);

/* ── 2. The URL boundary ─────────────────────────────────────────────────── */

console.log("\n── shotSrc — the only place a screenshot URL is built ───────");
check(
  "a validated pair becomes a proxied path",
  shotSrc("7a0c6432cde4", "20260817T032357Z-settings-surface-dark.png"),
  "/api/proxy/uploads/7a0c6432cde4/20260817T032357Z-settings-surface-dark.png",
);
check("a space in the name is percent-encoded, not passed raw", shotSrc("7a0c6432cde4", "a b.png"), "/api/proxy/uploads/7a0c6432cde4/a%20b.png");
check("path traversal in the name → null", shotSrc("7a0c6432cde4", "../../../etc/passwd.png"), null);
check("a slash anywhere in the name → null", shotSrc("7a0c6432cde4", "sub/dir.png"), null);
check("a non-image extension → null", shotSrc("7a0c6432cde4", "notes.md"), null);
check("no extension → null", shotSrc("7a0c6432cde4", "screenshot"), null);
check("a 13-hex dir id → null (the route's gate is exact)", shotSrc("7a0c6432cde4a", "x.png"), null);
check("an uppercase dir id → null", shotSrc("7A0C6432CDE4", "x.png"), null);
check("a scheme smuggled through the dir id → null", shotSrc("https://evil", "x.png"), null);
check("a quote in the name → null", shotSrc("7a0c6432cde4", 'x".png'), null);

/* ── 3. Name parsing ─────────────────────────────────────────────────────── */

console.log("\n── parseShotName / stampToIso / shotClock ───────────────────");
check("stamped name → label", parseShotName("20260817T032357Z-settings-surface-dark.png").label, "settings-surface-dark");
check("stamped name → ISO ts", parseShotName("20260817T032357Z-settings-surface-dark.png").ts, "2026-08-17T03:23:57Z");
check("unstamped attachment → stem as label", parseShotName("image.png").label, "image");
check("unstamped attachment → null ts (nothing to invent)", parseShotName("image.png").ts, null);
check("a bad stamp is not an ISO date", stampToIso("2026-08-17"), null);
check("clock is UTC and locale-free", shotClock("2026-08-17T03:23:57Z"), "03:23:57");
check("clock of a null ts is empty", shotClock(null), "");

/* ── 4. The real captured run ────────────────────────────────────────────── */

console.log("\n── real thread: run 7a0c6432 (172 entries, 2 shots on disk) ──");

const thread = JSON.parse(
  readFileSync(
    new URL("../../docs/plan/artifacts/phase1350/fixtures/run-7a0c6432-browser.json", import.meta.url),
    "utf8",
  ),
) as ThreadEntry[];
check("fixture loaded whole", thread.length, 172);

/** Every tool-call part of the mapped thread — the exact objects the renderer
 *  hands `ToolCallRow`, not a hand-built approximation of them. */
const parts: ToolCallPart[] = [];
for (const m of mapThreadToMessages(thread)) {
  if (!Array.isArray(m.content)) continue;
  for (const p of m.content) {
    if ((p as { type?: string }).type === "tool-call") parts.push(p as ToolCallPart);
  }
}
check("the mapper produced this run's tool-call parts", parts.length, 82);

let threw = 0;
const fromRun: BrowserShotRef[] = [];
for (const p of parts) {
  try {
    fromRun.push(...extractBrowserShots(p));
  } catch {
    threw++;
  }
}
check("no part in a real 172-entry thread made the extractor throw", threw, 0);
/* Four refs over two files, and that is the whole point of reading BOTH
 * shapes: this run took a screenshot with research-browser (Bash) and then
 * Read it back to look at it. Each ref hangs under its own tool row, so
 * de-duplication is per row and not across the run — the reader sees "I
 * photographed this" and "I looked at this" as the two separate acts they
 * were. */
check("refs found across the run", fromRun.length, 4);
check("…over two distinct files", new Set(fromRun.map((r) => `${r.dirId}/${r.name}`)).size, 2);
check("…in the order they happened: shoot, look, shoot, look", fromRun.map((r) => r.source).join(","), "bash,read,bash,read");
const bashRefs = fromRun.filter((r) => r.source === "bash");
checkRef("shot 1 (clean JSON payload)", bashRefs[0], {
  dirId: "7a0c6432cde4",
  name: "20260817T032357Z-settings-surface-dark.png",
  url: "/api/uploads/7a0c6432cde4/20260817T032357Z-settings-surface-dark.png",
  label: "settings-surface-dark",
  ts: "2026-08-17T03:23:57Z",
  source: "bash",
});
/* THE CASE THAT DECIDED THE DESIGN: this payload reached the thread as the
 * output of `… | grep -A3 '"path"'`, i.e. four lines out of the middle of a
 * JSON object. JSON.parse cannot read it; the record shape is still there. */
checkRef("shot 2 (payload clipped by grep — unparseable as JSON)", bashRefs[1], {
  dirId: "7a0c6432cde4",
  name: "20260817T032405Z-settings-surface-light.png",
  url: "/api/uploads/7a0c6432cde4/20260817T032405Z-settings-surface-light.png",
  label: "settings-surface-light",
  ts: "2026-08-17T03:24:05Z",
  source: "bash",
});
const clipped = thread[121];
check("…and that entry really is unparseable JSON", (() => {
  try {
    JSON.parse(String(clipped.content));
    return "parsed";
  } catch {
    return "unparseable";
  }
})(), "unparseable");

/* ── 5. Real Read entries ────────────────────────────────────────────────── */

console.log("\n── real Read tool_calls under /opt/ai-os/uploads ────────────");
const readEntries = JSON.parse(
  readFileSync(
    new URL("../../docs/plan/artifacts/phase1350/fixtures/read-uploads-entries.json", import.meta.url),
    "utf8",
  ),
) as ThreadEntry[];
check("two real Read entries in the fixture", readEntries.length, 2);

const readRefs = readEntries.flatMap((e) =>
  extractBrowserShots({
    toolName: String((e.meta ?? {}).tool ?? ""),
    argsText: String((e.meta ?? {}).input ?? ""),
  }),
);
check("both produced a ref", readRefs.length, 2);
checkRef("chat attachment the operator opened", readRefs[0], {
  dirId: "bbce5c18b613",
  name: "image.png",
  url: "/api/uploads/bbce5c18b613/image.png",
  label: "image",
  ts: null,
  source: "read",
});
checkRef("research shot the operator analysed", readRefs[1], {
  dirId: "148ae1fd8f65",
  name: "20260805T165301Z-smoke-r701.png",
  url: "/api/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png",
  label: "smoke-r701",
  ts: "2026-08-05T16:53:01Z",
  source: "read",
});

/* ── 6. Negatives — what must produce NOTHING ────────────────────────────── */

console.log("\n── negatives ───────────────────────────────────────────────");
/* THE ONE THE BRIEF NAMES: prose about the endpoint is not a screenshot. */
check(
  "a Bash result that only MENTIONS /api/uploads in prose yields nothing",
  extractBrowserShots(
    bash(
      "I checked the browser index: GET /api/uploads/index returned 37 runs, and " +
        "/api/uploads/7a0c6432cde4/20260817T032357Z-settings-surface-dark.png is servable. " +
        "See docs/plan/artifacts/phase1350/browser-index.md.",
    ),
  ).length,
  0,
);
check(
  "…even when the prose quotes a path in JSON-ish backticks",
  extractBrowserShots(bash('the record read `"path": "/opt/ai-os/uploads/7a0c6432cde4/x.png"` — no url member'))
    .length,
  0,
);
check("a Bash result with no payload at all", extractBrowserShots(bash("")).length, 0);
check("a Bash call still running (result undefined)", extractBrowserShots({ toolName: "Bash" }).length, 0);
check("a non-string result is not coerced into a match", extractBrowserShots(bash({ url: "/api/uploads/7a0c6432cde4/x.png" })).length, 0);
check("truncated JSON with nothing recoverable", extractBrowserShots(bash('{"screenshots":[{"lab')).length, 0);
check("a url member with a traversal name is refused", extractBrowserShots(bash('"url": "/api/uploads/7a0c6432cde4/..%2fetc%2fpasswd.png"')).length, 0);
check("a url member with a non-image name is refused", extractBrowserShots(bash('"url": "/api/uploads/7a0c6432cde4/secrets.env"')).length, 0);
check("a url member with a 11-hex dir is refused", extractBrowserShots(bash('"url": "/api/uploads/7a0c6432cde/x.png"')).length, 0);
check("a Read outside the uploads tree", extractBrowserShots(read('{"file_path":"/opt/ai-os/.secrets/forge-control.env"}')).length, 0);
check("a Read of an uploads path one level too deep", extractBrowserShots(read('{"file_path":"/opt/ai-os/uploads/7a0c6432cde4/nested/x.png"}')).length, 0);
check("a Read with malformed JSON args yields [] rather than throwing", extractBrowserShots(read('{"file_path":')).length, 0);
check("a Read with no args", extractBrowserShots({ toolName: "Read" }).length, 0);
check("an unrelated tool carrying a matching url in its result", extractBrowserShots({ toolName: "WebFetch", result: '"url": "/api/uploads/7a0c6432cde4/x.png"' }).length, 0);

/* Salvage: a Read whose args JSON was clipped but whose member survives. */
check(
  "a clipped Read payload is salvaged through the member shape",
  extractBrowserShots(read('{"file_path":"/opt/ai-os/uploads/148ae1fd8f65/20260805T165301Z-smoke-r701.png","off'))[0]?.name,
  "20260805T165301Z-smoke-r701.png",
);

/* ── 7. Never throws, on anything ────────────────────────────────────────── */

console.log("\n── hostile / degenerate input ──────────────────────────────");
const garbage: ToolCallLike[] = [
  { toolName: "" },
  { toolName: "Bash", result: null },
  { toolName: "Bash", result: 42 },
  { toolName: "Bash", result: '"url": "/api/uploads/7a0c6432cde4/' + "x".repeat(500) + '.png"' },
  { toolName: "Read", argsText: '{"file_path":"' + "/a".repeat(400) + '"}' },
  { toolName: "Read", argsText: "[]" },
  { toolName: "Read", argsText: "null" },
  { toolName: "Bash", result: '"url":"/api/uploads/7a0c6432cde4/a.png"'.repeat(200) },
];
let garbageThrew = 0;
let garbageRefs = 0;
for (const g of garbage) {
  try {
    garbageRefs += extractBrowserShots(g).length;
  } catch {
    garbageThrew++;
  }
}
check("nothing in the garbage table threw", garbageThrew, 0);
check("…and the 200 repeats deduplicated to one ref", garbageRefs, 1);

/* Repeated scans of the same payload must agree — a module-level /g regex
 * carries `lastIndex` between calls, and forgetting to reset it makes the
 * second render of a row show fewer thumbnails than the first. */
const twice = bash('"url": "/api/uploads/7a0c6432cde4/20260817T032357Z-a.png"');
check("scan 1", extractBrowserShots(twice).length, 1);
check("scan 2 is identical (regex lastIndex reset)", extractBrowserShots(twice).length, 1);
check("scan 3 is identical", extractBrowserShots(twice).length, 1);

/* ── 8. Presentation helpers ─────────────────────────────────────────────── */

console.log("\n── shotsNoun / newestFirst ─────────────────────────────────");
check("one browser shot", shotsNoun([bashRefs[0]]), "screenshot");
check("two browser shots", shotsNoun(bashRefs), "screenshots");
check("a Read-sourced ref is an image, not a claim about the browser", shotsNoun(readRefs), "images");
check("mixed provenance takes the weaker word", shotsNoun([...bashRefs, ...readRefs]), "images");
check("an empty set", shotsNoun([]), "images");
const sorted = newestFirst([...bashRefs, ...readRefs]);
check("newest first", sorted[0].name, "20260817T032405Z-settings-surface-light.png");
check("…then the older browser shot", sorted[1].name, "20260817T032357Z-settings-surface-dark.png");
check("…unstamped refs sink to the end", sorted[3].name, "image.png");
check("newestFirst does not mutate its input", bashRefs[0].name, "20260817T032357Z-settings-surface-dark.png");

/* ── 9. Login-wall detection ──────────────────────────────────────────────── */

console.log("\n── isLoginWallName ─────────────────────────────────────────");
check("perplexity login wall pattern", isLoginWallName("20260805T101530Z-perplexity-login-wall.png"), true);
check("bot wall pattern", isLoginWallName("20260805T101530Z-bot-wall.png"), true);
check("captcha pattern", isLoginWallName("20260805T101530Z-recaptcha-challenge.png"), true);
check("auth wall pattern", isLoginWallName("20260805T101530Z-auth-wall.png"), true);
check("sign-in pattern", isLoginWallName("20260805T101530Z-sign-in.png"), true);
check("standard dark settings is not a wall", isLoginWallName("20260817T032357Z-settings-surface-dark.png"), false);
check("plain image is not a wall", isLoginWallName("image.png"), false);
check("null name does not throw", isLoginWallName(null), false);
check("empty string does not throw", isLoginWallName(""), false);

/* ── 10. resolveStreamMode (Red Mode vs Live Mode vs Idle) ────────────────── */

console.log("\n── resolveStreamMode ───────────────────────────────────────");
check("needs_human: true → needs_human (Red Mode)", resolveStreamMode({ needs_human: true }), "needs_human");
check("needs_login: true → needs_human (Red Mode)", resolveStreamMode({ needs_login: true }), "needs_human");
check("signal: login_required → needs_human (Red Mode)", resolveStreamMode({ signal: "login_required" }), "needs_human");
check("stuck_signal: heartbeat_stale → needs_human (Red Mode)", resolveStreamMode({ stuck_signal: "heartbeat_stale" }), "needs_human");
check("ref with login-wall label → needs_human (Red Mode)", resolveStreamMode(null, [
  {
    dirId: "148ae1fd8f65",
    name: "20260805T101530Z-perplexity-login-wall.png",
    url: "/api/uploads/148ae1fd8f65/20260805T101530Z-perplexity-login-wall.png",
    label: "perplexity-login-wall",
    ts: "2026-08-05T10:15:30Z",
    source: "bash",
  },
]), "needs_human");

check("is_live: true → live (Blue Flowing Mode)", resolveStreamMode({ is_live: true }), "live");
check("takeover_up: true → live (Blue Flowing Mode)", resolveStreamMode({ takeover_up: true }), "live");
check("idle state → idle", resolveStreamMode({ is_live: false, needs_human: false }), "idle");
check("empty / null state → idle", resolveStreamMode(null, []), "idle");

/* ── 11. resolveStreamWarning (Diagnostic action info for Konrad) ─────────── */

console.log("\n── resolveStreamWarning ────────────────────────────────────");
const loginWarning = resolveStreamWarning({
  needs_login: true,
  service: "perplexity",
  reason: "Perplexity login required — human verification needed",
});
check("login warning title", loginWarning?.title, "Login Required");
check("login warning service", loginWarning?.service, "perplexity");
check("login warning signal", loginWarning?.signal, "login_required");
check("login warning action", loginWarning?.action, "Take control in manual mode or solve login to resume");

const staleWarning = resolveStreamWarning({
  stuck_signal: "heartbeat_stale",
});
check("stale warning title", staleWarning?.title, "Process Heartbeat Stale");
check("stale warning signal", staleWarning?.signal, "heartbeat_stale");

const idleWarning = resolveStreamWarning({ is_live: true });
check("live / idle stream produces no warning", idleWarning, null);

/* ── 12. vncProxyUrl (Loopback proxy URL boundary) ────────────────────────── */

console.log("\n── vncProxyUrl ─────────────────────────────────────────────");
check(
  "valid 12-hex dirId builds authenticated vnc proxy URL",
  vncProxyUrl("7a0c6432cde4"),
  "/api/proxy/uploads/7a0c6432cde4/vnc/vnc.html?autoconnect=1&resize=scale",
);
check(
  "custom subpath is routed correctly",
  vncProxyUrl("7a0c6432cde4", "vnc_lite.html"),
  "/api/proxy/uploads/7a0c6432cde4/vnc/vnc_lite.html",
);
check("invalid dirId yields null (security gate)", vncProxyUrl("invalid-id"), null);
check("traversal in dirId yields null", vncProxyUrl("../../../etc/passwd"), null);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — browser-shot extraction and stream modes`,
);
process.exit(failures === 0 ? 0 : 1);

