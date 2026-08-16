/**
 * check-secret-requests.ts — executable unit check for the U30 request reducer:
 * `pendingRequests`, `autoOpenTarget` and `capNote` in
 * forge-control-web/app/desktop/chat/secret-requests.ts.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-plan-store.ts and check-team-rows.ts, deliberately.
 *
 * The claims this file holds down — all four are security-adjacent, which is
 * why they are executable rather than asserted in a comment:
 *   1. TOTALITY. Nulls, missing fields, wrong types and a non-array argument
 *      produce a list, never a throw. The composer must not blank because one
 *      row in `GET /api/secrets` is malformed.
 *   2. `pending` is matched with `=== true`. A truthy string must NOT raise a
 *      credential prompt.
 *   3. ORDER IS DETERMINISTIC. Newest first, name-ascending on ties, so the
 *      auto-open target does not flip between two polls of identical data.
 *   4. DISMISSAL IS BY NAME. Once waved away, a request stays away even as
 *      newer requests arrive and re-sort the list.
 *
 * No fixture here contains a secret VALUE, because no endpoint this module
 * touches returns one — that is the point of the module.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-secret-requests.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import type { SecretMeta } from "../../forge-control-web/app/api.ts";
import {
  RENDERED_NOTE_CAP,
  autoOpenTarget,
  capNote,
  pendingRequests,
} from "../../forge-control-web/app/desktop/chat/secret-requests.ts";

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

/* ── Fixtures ───────────────────────────────────────────────────────────────
 * Shapes copied from the real wire response recorded in
 * docs/plan/artifacts/phase300/u7-secrets-7798.md:
 *   {"name","bytes","updatedAt","note","pending","requestedByRunId"}
 * ------------------------------------------------------------------------ */

const row = (
  name: string,
  updatedAt: string,
  pending: boolean,
  note: string | null = null,
  requestedByRunId: string | null = null,
): SecretMeta => ({
  name,
  bytes: 42,
  updatedAt,
  note,
  pending,
  requestedByRunId,
});

const RUN = "3853c154-e07b-4378-9313-2b34f4a33342";

/* 1 ── empty and near-empty inputs ─────────────────────────────────────── */

checkDeep("empty list → no requests", pendingRequests([]), []);
check("empty list → no auto-open", autoOpenTarget([], []), null);
checkDeep(
  "no pending rows → no requests",
  pendingRequests([row("github-pat-konrad", "2026-08-16T09:00:00.000Z", false)]),
  [],
);
check(
  "no pending rows → no auto-open",
  autoOpenTarget([row("twenty-api-key", "2026-08-16T09:00:00.000Z", false)], []),
  null,
);

/* 2 ── one pending row maps every field ────────────────────────────────── */

const one = [
  row("vps2-root-ssh-key", "2026-08-16T10:00:00.000Z", true, "need it to reach VPS2", RUN),
  row("github-pat-konrad", "2026-08-16T11:00:00.000Z", false, "already collected", null),
];
checkDeep("one pending → mapped shape (bytes dropped, no value anywhere)", pendingRequests(one), [
  {
    name: "vps2-root-ssh-key",
    note: "need it to reach VPS2",
    requestedByRunId: RUN,
    updatedAt: "2026-08-16T10:00:00.000Z",
  },
]);
check(
  "one pending → auto-open is that one",
  autoOpenTarget(one, [])?.name,
  "vps2-root-ssh-key",
);

/* 3 ── several pending: newest first, name-ascending on ties ───────────── */

const many = [
  row("alpha-key", "2026-08-14T08:00:00.000Z", true, "oldest"),
  row("charlie-key", "2026-08-16T08:00:00.000Z", true, "newest"),
  row("bravo-key", "2026-08-15T08:00:00.000Z", true, "middle"),
  row("delta-key", "2026-08-15T08:00:00.000Z", false, "not pending"),
];
checkDeep(
  "several pending → most-recently-updated first",
  pendingRequests(many).map((r) => r.name),
  ["charlie-key", "bravo-key", "alpha-key"],
);
checkDeep(
  "identical timestamps → deterministic name-ascending tie-break",
  pendingRequests([
    row("zulu-key", "2026-08-16T08:00:00.000Z", true),
    row("mike-key", "2026-08-16T08:00:00.000Z", true),
    row("alpha-key", "2026-08-16T08:00:00.000Z", true),
  ]).map((r) => r.name),
  ["alpha-key", "mike-key", "zulu-key"],
);
check("several pending → auto-open is the newest", autoOpenTarget(many, [])?.name, "charlie-key");
checkDeep("input list is not mutated by sorting", many.map((r) => r.name), [
  "alpha-key",
  "charlie-key",
  "bravo-key",
  "delta-key",
]);

/* 4 ── pending with a null / missing note ──────────────────────────────── */

checkDeep(
  "pending with null note → note stays null",
  pendingRequests([row("no-note-key", "2026-08-16T08:00:00.000Z", true, null)]),
  [
    {
      name: "no-note-key",
      note: null,
      requestedByRunId: null,
      updatedAt: "2026-08-16T08:00:00.000Z",
    },
  ],
);
checkDeep(
  "pending with the note key absent entirely → note null, no crash",
  pendingRequests([
    { name: "absent-note", bytes: 1, updatedAt: "2026-08-16T08:00:00.000Z", pending: true } as unknown as SecretMeta,
  ]),
  [
    {
      name: "absent-note",
      note: null,
      requestedByRunId: null,
      updatedAt: "2026-08-16T08:00:00.000Z",
    },
  ],
);
checkDeep(
  'empty-string note → null, not ""',
  pendingRequests([row("blank-note", "2026-08-16T08:00:00.000Z", true, "")]).map((r) => r.note),
  [null],
);

/* 5 ── dismissal ───────────────────────────────────────────────────────── */

check(
  "newest dismissed → auto-open falls through to the next",
  autoOpenTarget(many, ["charlie-key"])?.name,
  "bravo-key",
);
check(
  "all dismissed → null",
  autoOpenTarget(many, ["alpha-key", "bravo-key", "charlie-key"]),
  null,
);
check(
  "a dismissed name stays dismissed when a NEWER request arrives",
  autoOpenTarget(
    [...many, row("echo-key", "2026-08-17T08:00:00.000Z", true, "brand new")],
    ["echo-key", "charlie-key"],
  )?.name,
  "bravo-key",
);
check(
  "dismissal of a name that isn't pending changes nothing",
  autoOpenTarget(many, ["delta-key"])?.name,
  "charlie-key",
);
check(
  "malformed dismissed list (nulls, numbers) is tolerated",
  autoOpenTarget(many, [null, 7, "charlie-key"] as unknown as string[])?.name,
  "bravo-key",
);
check(
  "non-array dismissed list is tolerated",
  autoOpenTarget(many, null as unknown as string[])?.name,
  "charlie-key",
);

/* 6 ── malformed rows: total, never throwing ───────────────────────────── */

const malformed = [
  null,
  undefined,
  "a string, not a row",
  42,
  {},
  { pending: true },                                   // no name → unanswerable
  { name: "", pending: true, updatedAt: "2026-08-16T08:00:00.000Z" }, // ditto
  { name: "truthy-string-pending", pending: "yes", updatedAt: "2026-08-16T08:00:00.000Z" },
  { name: "pending-one", pending: 1, updatedAt: "2026-08-16T08:00:00.000Z" },
  { name: "broken-stamp", pending: true, updatedAt: "not-a-date", note: 12345, requestedByRunId: 99 },
  { name: "no-stamp", pending: true },
  row("good-key", "2026-08-16T08:00:00.000Z", true, "the only well-formed pending row"),
] as unknown as SecretMeta[];

checkDeep(
  "malformed rows: only well-formed pending survive, broken stamps sink last",
  pendingRequests(malformed).map((r) => r.name),
  ["good-key", "broken-stamp", "no-stamp"],
);
checkDeep(
  "malformed row fields coerce to null, never undefined",
  pendingRequests(malformed).find((r) => r.name === "broken-stamp"),
  {
    name: "broken-stamp",
    note: null,
    requestedByRunId: null,
    updatedAt: "not-a-date",
  },
);
check(
  "a missing updatedAt becomes \"\", not undefined",
  pendingRequests(malformed).find((r) => r.name === "no-stamp")?.updatedAt,
  "",
);
check(
  'pending: "yes" does NOT raise a credential prompt',
  pendingRequests(malformed).some((r) => r.name === "truthy-string-pending"),
  false,
);
check(
  "pending: 1 does NOT raise a credential prompt",
  pendingRequests(malformed).some((r) => r.name === "pending-one"),
  false,
);
checkDeep(
  "a non-array argument returns [] rather than throwing",
  pendingRequests(null as unknown as SecretMeta[]),
  [],
);
check(
  "autoOpenTarget on a non-array returns null",
  autoOpenTarget(undefined as unknown as SecretMeta[], []),
  null,
);
check(
  "malformed list still auto-opens the one good row",
  autoOpenTarget(malformed, [])?.name,
  "good-key",
);

/* 7 ── capNote: the untrusted-text guard rail ──────────────────────────── */

checkDeep("capNote(null) → empty, untruncated", capNote(null), { text: "", truncated: false });
checkDeep("capNote(undefined) → empty, untruncated", capNote(undefined), {
  text: "",
  truncated: false,
});
checkDeep("capNote of a non-string → empty, untruncated", capNote(7 as unknown as string), {
  text: "",
  truncated: false,
});
checkDeep("capNote of a short note → verbatim", capNote("please paste the deploy key"), {
  text: "please paste the deploy key",
  truncated: false,
});
const huge = "x".repeat(RENDERED_NOTE_CAP + 500);
check("capNote of a huge note → cut to the cap", capNote(huge).text.length, RENDERED_NOTE_CAP);
check("capNote of a huge note → flags the cut", capNote(huge).truncated, true);
check(
  "capNote exactly at the cap → not flagged",
  capNote("y".repeat(RENDERED_NOTE_CAP)).truncated,
  false,
);
check("capNote honours an explicit smaller cap", capNote("abcdef", 3).text, "abc");
check("capNote with a nonsense cap falls back to the default", capNote(huge, 0).text.length, RENDERED_NOTE_CAP);
check(
  "capNote does not interpret markup — it returns the raw characters",
  capNote("[click](http://evil.example) <img src=x onerror=alert(1)>").text,
  "[click](http://evil.example) <img src=x onerror=alert(1)>",
);

/* ── Verdict ───────────────────────────────────────────────────────────── */

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
