/**
 * Tests for the JOURNAL day assembler (lib/evidence/*.ts) and its reply
 * (db/journal-day.ts).
 *
 * ── Why this file is HERE and not next to its subjects ───────────────────
 * `forge-control/package.json`'s test script is `tsx --test src/lib/*.test.ts`
 * — a FLAT, non-recursive glob over one directory, and `scripts/checks/
 * gates-808.sh` runs exactly that. A test committed to `src/lib/evidence/` or
 * `src/db/` typechecks, passes when a human types its path, and is executed by
 * no gate ever again. B1's brief declared those two paths; the deviation is
 * disclosed in the task report rather than silently "fixed" by widening the
 * glob, because package.json is shared by every lane and is not in this
 * write-set. `src/lib/vault-routes.test.ts` sits here for the same reason.
 *
 * Nothing below touches Postgres, Google or the live vault: the DB-shaped
 * sources are proven against the live database by the probe in the task report,
 * and what is unit-testable here is the logic that has no business talking to
 * anything — the failure contract, the DST bound, the entry picker, the reply.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Read this before adding a static import ──────────────────────────────
// lib/vault.ts resolves OBSIDIAN_VAULT_DIR into a module-level const AT
// IMPORT. `import` declarations are hoisted and evaluated before ANY
// statement in this file, so a static `import … from "./evidence/index.ts"`
// (which reaches vault.ts through db/journal-day.ts) captures the real vault
// before a test can redirect it — and the reply tests below then write
// fabricated entries into /opt/obsidian-vault/Journal/. That is not
// hypothetical: it happened once while this file was being written, creating
// two notes that had to be quarantined out again.
//
// So the environment is set FIRST, at module scope, and every subject is
// pulled in with a dynamic import after it. Keep it that way.
const VAULT = mkdtempSync(path.join(os.tmpdir(), "journal-vault-"));
const SNAPSHOTS = mkdtempSync(path.join(os.tmpdir(), "journal-snapshots-"));
process.env.OBSIDIAN_VAULT_DIR = VAULT;
process.env.VAULT_SNAPSHOT_DIR = SNAPSHOTS;

const { take } = await import("./evidence/index.ts");
const { gitLogArgs, evidenceRepos } = await import("./evidence/git.ts");
const { parseMentorLog, pickMentorEntry } = await import("./evidence/mentor.ts");
const journalDay = await import("../db/journal-day.ts");
type EvidenceError = import("./evidence/index.ts").EvidenceError;

after(() => {
  rmSync(VAULT, { recursive: true, force: true });
  rmSync(SNAPSHOTS, { recursive: true, force: true });
});

test("harness: the vault under test is a scratch directory, never the real one", () => {
  assert.equal(process.env.OBSIDIAN_VAULT_DIR, VAULT);
  assert.ok(VAULT.startsWith(os.tmpdir()), `scratch vault escaped tmpdir: ${VAULT}`);
  assert.notEqual(VAULT, "/opt/obsidian-vault");
});

// ---------------------------------------------------------------------------
// The failure contract: a source that throws becomes null + errors[], never []
// ---------------------------------------------------------------------------

test("evidence: a fulfilled source yields its value and no error", async () => {
  const errors: EvidenceError[] = [];
  const [settled] = await Promise.allSettled([Promise.resolve([{ sha: "abc" }])]);
  const value = take(settled, "commits", "2026-08-25", errors);

  assert.deepEqual(value, [{ sha: "abc" }]);
  assert.deepEqual(errors, []);
});

test("evidence: a source that throws yields null AND an errors[] entry", async () => {
  const errors: EvidenceError[] = [];
  const source = async (): Promise<string[]> => {
    throw new Error("git log failed for 1 of 2 repos — /opt/content-forge: ENOENT");
  };

  const [settled] = await Promise.allSettled([source()]);
  const value = take(settled, "commits", "2026-08-25", errors);

  // null, NOT [] — an empty list is a fact about the day, null is a fact about
  // the reader, and the card renders them differently.
  assert.equal(value, null);
  assert.notDeepEqual(value, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, "commits");
  assert.match(errors[0].message, /\/opt\/content-forge: ENOENT/);
});

test("evidence: one failing source does not disturb the others", async () => {
  const errors: EvidenceError[] = [];
  const [ok, bad] = await Promise.allSettled([
    Promise.resolve({ readings: 0 }),
    Promise.reject(new Error("Google Calendar CLI error (list): invalid_grant")),
  ]);

  assert.deepEqual(take(ok, "glucose", "2026-08-25", errors), { readings: 0 });
  assert.equal(take(bad, "events", "2026-08-25", errors), null);
  assert.deepEqual(
    errors.map((e) => e.source),
    ["events"],
  );
});

test("evidence: a non-Error rejection still produces a readable message", async () => {
  const errors: EvidenceError[] = [];
  const [settled] = await Promise.allSettled([Promise.reject("plain string")]);

  assert.equal(take(settled, "runs", "2026-08-25", errors), null);
  assert.equal(errors[0].message, "plain string");
});

// ---------------------------------------------------------------------------
// The git window across a DST boundary
// ---------------------------------------------------------------------------

function bounds(day: string): { since: string; until: string; hours: number } {
  const args = gitLogArgs("/opt/forge-ai-os", day);
  const since = args.find((a) => a.startsWith("--since="))?.slice("--since=".length);
  const until = args.find((a) => a.startsWith("--until="))?.slice("--until=".length);
  assert.ok(since && until, `gitLogArgs(${day}) produced no bounds: ${JSON.stringify(args)}`);
  return {
    since,
    until,
    hours: (Date.parse(until) - Date.parse(since)) / 3_600_000,
  };
}

test("git: a summer Berlin day is 00:00+02:00 → 22:00Z the day before, 24h long", () => {
  const { since, until, hours } = bounds("2026-08-25");
  assert.equal(since, "2026-08-24T22:00:00.000Z");
  assert.equal(until, "2026-08-25T22:00:00.000Z");
  assert.equal(hours, 24);
});

test("git: a winter Berlin day is 00:00+01:00 → 23:00Z the day before, 24h long", () => {
  const { since, until, hours } = bounds("2026-01-25");
  assert.equal(since, "2026-01-24T23:00:00.000Z");
  assert.equal(until, "2026-01-25T23:00:00.000Z");
  assert.equal(hours, 24);
});

test("git: 2026-10-25, the CEST→CET transition, is 25 hours long and starts at 22:00Z", () => {
  // The DST trap in one assertion. A hardcoded `+0200` would put --since at
  // 22:00Z (right, by luck — the day BEGINS in CEST) and --until at 22:00Z on
  // the 25th, an hour SHORT: every commit made between 22:00Z and 23:00Z that
  // Sunday would silently vanish from the journal. A hardcoded `+0100` loses
  // the first hour instead.
  const { since, until, hours } = bounds("2026-10-25");
  assert.equal(since, "2026-10-24T22:00:00.000Z");
  assert.equal(until, "2026-10-25T23:00:00.000Z");
  assert.equal(hours, 25);
});

test("git: 2026-03-29, the CET→CEST transition, is 23 hours long", () => {
  const { since, until, hours } = bounds("2026-03-29");
  assert.equal(since, "2026-03-28T23:00:00.000Z");
  assert.equal(until, "2026-03-29T22:00:00.000Z");
  assert.equal(hours, 23);
});

test("git: the log arguments are an execFile array with no shell string", () => {
  const args = gitLogArgs("/opt/content-forge", "2026-08-25");
  assert.deepEqual(args.slice(0, 4), ["-C", "/opt/content-forge", "log", "--since=2026-08-24T22:00:00.000Z"]);
  assert.ok(args.some((a) => a.startsWith("--format=")));
  assert.ok(!args.some((a) => a.includes("&&") || a.includes(";")));
});

test("git: the default repo pair is the one PLAN.md §4.1 names", () => {
  const before = process.env.JOURNAL_EVIDENCE_REPOS;
  delete process.env.JOURNAL_EVIDENCE_REPOS;
  try {
    assert.deepEqual(evidenceRepos(), ["/opt/forge-ai-os", "/opt/content-forge"]);
  } finally {
    if (before !== undefined) process.env.JOURNAL_EVIDENCE_REPOS = before;
  }
});

// ---------------------------------------------------------------------------
// Mentor entry picking
// ---------------------------------------------------------------------------

const LOG = [
  "# Mentor log",
  "",
  "## 2026-08-19",
  "Shipped the sidebar. Stop starting new lanes.",
  "",
  "## 2026-08-21",
  "Two lanes finished, one abandoned.",
  "",
  "## 2026-08-16 (weekly review — Sunday)",
  "Week of noise.",
  "",
  "## 2026-08-22",
  "Last entry before the cron was switched off.",
  "",
].join("\n");

test("mentor: the log parses into entries, suffix kept, body bounded by the next heading", () => {
  const entries = parseMentorLog(LOG);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-08-19", "2026-08-21", "2026-08-16", "2026-08-22"],
  );
  assert.equal(entries[2].suffix, " (weekly review — Sunday)");
  assert.equal(entries[0].body, "Shipped the sidebar. Stop starting new lanes.");
  assert.equal(entries[3].body, "Last entry before the cron was switched off.");
});

test("mentor: an exact day wins even when a later entry exists", () => {
  const picked = pickMentorEntry(parseMentorLog(LOG), "2026-08-21");
  assert.equal(picked?.day, "2026-08-21");
  assert.equal(picked?.body, "Two lanes finished, one abandoned.");
});

test("mentor: with no entry for the day, the latest EARLIER entry is picked", () => {
  // 2026-08-25: the log stops at 08-22 (the evening cron is disabled). The
  // picker must not reach forward and must not pick 08-19 just because it comes
  // first in file order — the file is NOT sorted, on purpose.
  const picked = pickMentorEntry(parseMentorLog(LOG), "2026-08-25");
  assert.equal(picked?.day, "2026-08-22");
});

test("mentor: a day before every entry picks nothing", () => {
  assert.equal(pickMentorEntry(parseMentorLog(LOG), "2026-08-01"), null);
});

test("mentor: an empty log picks nothing rather than throwing", () => {
  assert.deepEqual(parseMentorLog(""), []);
  assert.equal(pickMentorEntry([], "2026-08-25"), null);
});

test("mentor: text before the first heading is not mistaken for an entry body", () => {
  const entries = parseMentorLog("preamble\nmore preamble\n\n## 2026-08-22\nbody\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "body");
});

// ---------------------------------------------------------------------------
// The reply: line shape and the vault mirror (scratch vault, no live writes)
// ---------------------------------------------------------------------------

const { replyLine, appendReplyToNote, journalNotePath } = journalDay;

test("reply: the line carries the Berlin wall clock, the rating and the text", () => {
  // 2026-08-25T17:05Z is 19:05 in Berlin (CEST). A line stamped 17:05 would
  // mean the mirror disagrees with every other timestamp on the surface.
  const at = new Date("2026-08-25T17:05:00Z");
  assert.equal(
    replyLine({ subjective: 7, reflection: "shipped the journal endpoint" }, at),
    "- 19:05 reply (felt 7/10): shipped the journal endpoint",
  );
});

test("reply: the stamp follows DST — the same UTC instant reads an hour earlier in winter", () => {
  assert.equal(replyLine({ subjective: 3 }, new Date("2026-01-25T08:30:00Z")), "- 09:30 reply (felt 3/10):");
  assert.equal(replyLine({ subjective: 3 }, new Date("2026-08-25T08:30:00Z")), "- 10:30 reply (felt 3/10):");
});

test("reply: a rating with no text, and text with no rating, both render", () => {
  const at = new Date("2026-01-25T08:30:00Z"); // 09:30 Berlin, CET
  assert.equal(replyLine({ subjective: 3 }, at), "- 09:30 reply (felt 3/10):");
  // No "(felt /10)" with an absent rating — an empty rating is not a rating.
  assert.equal(replyLine({ reflection: "quiet day" }, at), "- 09:30 reply: quiet day");
});

test("reply: newlines in the reflection are folded — one line stays one line", () => {
  const at = new Date("2026-08-25T17:05:00Z");
  assert.equal(
    replyLine({ subjective: 5, reflection: "first\n\nsecond\nthird" }, at),
    "- 19:05 reply (felt 5/10): first second third",
  );
});

test("reply: the note path is Journal/<day>.md under the legacy layout", () => {
  assert.equal(journalNotePath("2026-08-25"), "Journal/2026-08-25.md");
});

test("reply: with no note yet, the mirror creates Journal/<day>.md holding the line", async () => {
  const line = replyLine({ subjective: 8, reflection: "created" }, new Date("2026-08-25T17:05:00Z"));
  const rel = await appendReplyToNote("2026-08-25", line);

  assert.equal(rel, "Journal/2026-08-25.md");
  const written = await fs.readFile(path.join(VAULT, rel), "utf8");
  assert.ok(written.includes(line), `note does not carry the line:\n${written}`);
});

test("reply: an existing note is APPENDED to, never replaced", async () => {
  const rel = "Journal/2026-08-24.md";
  const existing = "# 2026-08-24\n\nSomething Konrad typed in Obsidian.\n";
  await fs.mkdir(path.join(VAULT, "Journal"), { recursive: true });
  await fs.writeFile(path.join(VAULT, rel), existing, "utf8");

  const first = replyLine({ subjective: 6, reflection: "one" }, new Date("2026-08-24T10:00:00Z"));
  const second = replyLine({ subjective: 9, reflection: "two" }, new Date("2026-08-24T20:00:00Z"));
  assert.equal(await appendReplyToNote("2026-08-24", first), rel);
  assert.equal(await appendReplyToNote("2026-08-24", second), rel);

  const written = await fs.readFile(path.join(VAULT, rel), "utf8");
  assert.ok(written.startsWith("# 2026-08-24"), `his text was destroyed:\n${written}`);
  assert.ok(written.includes("Something Konrad typed in Obsidian."));
  assert.ok(written.indexOf(first) < written.indexOf(second), "replies are out of order");
});

test("reply: the mirror refuses a path that escapes the vault", async () => {
  // journalNotePath() interpolates the day, and the route validates it — but the
  // refusal has to exist one layer down too, or the validation is the only thing
  // between a crafted day and an arbitrary write.
  await assert.rejects(
    () => appendReplyToNote("../../etc/passwd" as never, "- 00:00 reply: nope"),
    /vault/i,
  );
});
