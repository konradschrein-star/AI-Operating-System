/**
 * check-secret-events.ts — executable unit check for round 808's credential
 * change stream, client side: `parseRequestFrame`, `parseClearedFrame` and
 * `secretsPollInterval` in forge-control-web/app/desktop/chat/secretLive.ts.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-secret-requests.ts, deliberately — this is that file's other half.
 *
 * The claims this file holds down:
 *   1. THE POLL IS ACTUALLY GONE. `secretsPollInterval(true) === false` is the
 *      whole point of the round: react-query's "do not poll". If a later change
 *      turns it back into a number, the surface silently re-acquires the
 *      req/min this round removed and the phase-600 ceiling gets tighter with
 *      nobody noticing. This assertion is the tripwire.
 *   2. …AND THE FALLBACK IS STILL THERE. Stream down → phase 800's 60s period,
 *      not silence. An agent blocked on a credential is the one thing this
 *      surface may not lose.
 *   3. TOTALITY. Frames arrive over the network carrying AGENT-WRITTEN text,
 *      and they are parsed inside an EventSource listener where nothing catches
 *      a throw — a throw there takes the composer's panel down. Garbage in
 *      (bad JSON, null, an array, a number, a missing name) must produce null,
 *      never an exception.
 *   4. NO COERCION OF THE FIELDS THAT MATTER. `note` and `requestedByRunId`
 *      are string-or-null; a number or an object in either must land as null
 *      rather than be rendered as "[object Object]" in Konrad's panel.
 *
 * No fixture here contains a secret VALUE, because no endpoint this module
 * touches returns one — that is the point of the module.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-secret-events.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  SECRETS_FALLBACK_POLL_MS,
  parseClearedFrame,
  parseRequestFrame,
  secretsPollInterval,
} from "../../forge-control-web/app/desktop/chat/secretLive.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

function checkDeep(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${b}\n        got      ${a}`),
  );
}

const RUN = "3853c154-e07b-4378-9313-2b34f4a33342";

/* 1 ── the request budget claim ────────────────────────────────────────── */

check(
  "stream live → the query does NOT poll (this is the round's whole point)",
  secretsPollInterval(true),
  false,
);
check(
  "stream down → the fallback period comes back",
  secretsPollInterval(false),
  SECRETS_FALLBACK_POLL_MS,
);
check(
  "…and that period is phase 800's measured 60s, not something new",
  SECRETS_FALLBACK_POLL_MS,
  60_000,
);

/* 2 ── a well-formed request frame ─────────────────────────────────────── */

checkDeep(
  "a full request frame maps every field",
  parseRequestFrame(
    JSON.stringify({
      rev: 7,
      name: "vps2-root-ssh-key",
      note: "need it to reach VPS2",
      requestedByRunId: RUN,
      ts: 1_755_000_000_000,
    }),
  ),
  {
    rev: 7,
    name: "vps2-root-ssh-key",
    note: "need it to reach VPS2",
    requestedByRunId: RUN,
    ts: 1_755_000_000_000,
  },
);

checkDeep(
  "a frame with no note and no run id is still a request",
  parseRequestFrame(
    JSON.stringify({ rev: 1, name: "twenty-api-key", note: null, requestedByRunId: null, ts: 1 }),
  ),
  { rev: 1, name: "twenty-api-key", note: null, requestedByRunId: null, ts: 1 },
);

checkDeep(
  "missing rev/ts degrade to 0 rather than NaN — they are diagnostics, not state",
  parseRequestFrame(JSON.stringify({ name: "deploy-key" })),
  { rev: 0, name: "deploy-key", note: null, requestedByRunId: null, ts: 0 },
);

/* 3 ── totality: garbage must not throw ────────────────────────────────── */

const garbage: [string, string][] = [
  ["not JSON at all", "}{"],
  ["an empty string", ""],
  ["JSON null", "null"],
  ["a JSON array", "[1,2,3]"],
  ["a bare number", "42"],
  ["a bare string", '"vps2-root-ssh-key"'],
  ["an object with no name", '{"rev":3,"ts":9}'],
  ["an object with an empty name", '{"name":""}'],
  ["an object with a non-string name", '{"name":{"toString":"nope"}}'],
];
for (const [label, raw] of garbage) {
  let threw = false;
  let out: unknown = "unset";
  try {
    out = parseRequestFrame(raw);
  } catch {
    threw = true;
  }
  check(`request frame — ${label} → null, no throw`, threw ? "THREW" : out, null);
}
for (const [label, raw] of garbage) {
  let threw = false;
  let out: unknown = "unset";
  try {
    out = parseClearedFrame(raw);
  } catch {
    threw = true;
  }
  check(`cleared frame — ${label} → null, no throw`, threw ? "THREW" : out, null);
}

/* 4 ── no coercion of agent-influenced fields ──────────────────────────── */

const coerced = parseRequestFrame(
  JSON.stringify({ rev: 2, name: "github-pat-konrad", note: { evil: 1 }, requestedByRunId: 5, ts: 3 }),
);
check("a non-string note lands as null, never \"[object Object]\"", coerced?.note, null);
check("a non-string run id lands as null", coerced?.requestedByRunId, null);
check("…and the frame is still usable", coerced?.name, "github-pat-konrad");

const nonFinite = parseRequestFrame('{"name":"x","rev":null,"ts":"soon"}');
check("a null rev is 0, not null", nonFinite?.rev, 0);
check("a string ts is 0, not NaN", nonFinite?.ts, 0);

/* 5 ── the note is passed through verbatim, markup and all ─────────────── */

const hostile = parseRequestFrame(
  JSON.stringify({
    name: "hostile",
    note: "[click](http://evil.example) <img src=x onerror=alert(1)>",
  }),
);
check(
  "the note is returned raw — escaping is the renderer's job, not the parser's",
  hostile?.note,
  "[click](http://evil.example) <img src=x onerror=alert(1)>",
);

/* 6 ── cleared frames ──────────────────────────────────────────────────── */

checkDeep(
  "a cleared frame maps its three fields",
  parseClearedFrame(JSON.stringify({ rev: 9, name: "vps2-root-ssh-key", ts: 12 })),
  { rev: 9, name: "vps2-root-ssh-key", ts: 12 },
);
checkDeep(
  "a cleared frame ignores anything extra the server may add later",
  parseClearedFrame(JSON.stringify({ rev: 9, name: "x", ts: 12, value: "leaked?" })),
  { rev: 9, name: "x", ts: 12 },
);

/* ── Verdict ───────────────────────────────────────────────────────────── */

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
