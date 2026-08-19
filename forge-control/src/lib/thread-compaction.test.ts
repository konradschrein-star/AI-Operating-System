/**
 * thread-compaction.test.ts — the HERMETIC half of round 972 fix cycle 1.
 *
 * Run: pnpm test   (node:test via tsx, no database, no filesystem)
 *
 * This file covers round 971's findings 2 (the NaN clamp), 3 (the marker naming
 * a vault note that does not exist) and 4 (retention). It deliberately does NOT
 * cover finding 1, the lost-update race: a race cannot be proved by a
 * single-threaded assertion, and a test that claimed to would be exactly the
 * self-certifying instrument the standing rules put first. That proof lives in
 * `src/db/compact-race.test.ts`, which drives a real Postgres with a real
 * concurrent appender and is RED against the pre-fix code path.
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY:
 *
 *  1. THRESHOLDS IMPORTED FROM THE SUBJECT. A policy built from
 *     `DEFAULT_RETENTION` would move with the code and assert nothing. Every
 *     policy below is a literal written here, and the two cases that pin the
 *     shipped defaults compare them against literals too — so changing a
 *     default is a test change, which is the point of a default.
 *  2. A FIXTURE THAT PASSES AT EVERY VALUE. The retention cases each name which
 *     files must die AND which must survive; a prune that deleted everything
 *     and a prune that deleted nothing both fail. The NaN table asserts the
 *     RESULTING keep for each input rather than "did not throw".
 *  3. AN ASSERTION ON A SHARED SUBSTRING. The marker case pins the absence of
 *     the exact string `"AI OS/Session State"` INCLUDING BOTH QUOTES, because
 *     the corrected text contains that phrase as a prefix of
 *     `"AI OS/Session State - YYYY-MM-DD"`. A quote-less check would pass on
 *     the broken text and the fixed text alike.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_DIR,
  DEFAULT_RETENTION,
  KEEP_DEFAULT,
  KEEP_MAX,
  KEEP_MIN,
  archivePath,
  buildMarker,
  parseArchiveName,
  resolveKeep,
  selectArchivesToPrune,
  type ArchiveFile,
  type RetentionPolicy,
} from "./thread-compaction.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-19T12:00:00.000Z");

describe("round 971 finding 2 — the keep clamp is NaN-safe", () => {
  /* The shipped clamp was `Math.min(400, Math.max(10, Number(body.keep ?? 60)))`.
   * Every row marked PRE-FIX NaN below produced NaN there, and NaN defeats the
   * clamp silently: the `keep + 1` guard never fired, `dropped` was reported as
   * NaN, and `slice(-NaN)` is `slice(0)` — the whole thread kept while the
   * response said "compacted". The expectations are the CORRECTED values. */
  const CASES: ReadonlyArray<{ input: unknown; expect: number; why: string }> = [
    { input: undefined, expect: 60, why: "absent — the documented default" },
    { input: 60, expect: 60, why: "in range, unchanged" },
    { input: 10, expect: 10, why: "lower bound is inclusive" },
    { input: 400, expect: 400, why: "upper bound is inclusive" },
    { input: 5, expect: 10, why: "below the floor clamps up" },
    { input: 4000, expect: 400, why: "above the ceiling clamps down" },
    { input: 0, expect: 10, why: "zero is not a bypass" },
    { input: -1, expect: 10, why: "negative would slice from the FRONT" },
    { input: "abc", expect: 60, why: "PRE-FIX NaN — a non-numeric string" },
    { input: "60", expect: 60, why: "a numeric string still parses" },
    { input: {}, expect: 60, why: "PRE-FIX NaN — an object" },
    { input: [], expect: 10, why: "Number([]) is 0, which clamps to the floor" },
    { input: [1, 2], expect: 60, why: "PRE-FIX NaN — a multi-element array" },
    { input: null, expect: 60, why: "null hits the ?? default, not Number(null)=0" },
    { input: true, expect: 10, why: "Number(true) is 1, clamped to the floor" },
    { input: Number.NaN, expect: 60, why: "PRE-FIX NaN — literal NaN" },
    { input: Number.POSITIVE_INFINITY, expect: 60, why: "PRE-FIX — Infinity is not finite" },
    { input: Number.NEGATIVE_INFINITY, expect: 60, why: "PRE-FIX — -Infinity is not finite" },
    { input: 60.7, expect: 60, why: "fractions are truncated: entries are whole" },
    { input: 9.99, expect: 10, why: "truncates to 9, then clamps to the floor" },
  ];

  for (const { input, expect, why } of CASES) {
    test(`keep=${JSON.stringify(input) ?? String(input)} -> ${expect} (${why})`, () => {
      assert.equal(resolveKeep(input), expect);
    });
  }

  test("every case resolves to a finite integer inside [10, 400]", () => {
    for (const { input } of CASES) {
      const k = resolveKeep(input);
      assert.ok(Number.isInteger(k), `resolveKeep(${String(input)}) is not an integer: ${k}`);
      assert.ok(k >= 10 && k <= 400, `resolveKeep(${String(input)}) escaped the clamp: ${k}`);
    }
  });

  test("the shipped bounds are the documented ones", () => {
    // Literals, not a re-export comparison — the numbers are the contract.
    assert.equal(KEEP_MIN, 10);
    assert.equal(KEEP_MAX, 400);
    assert.equal(KEEP_DEFAULT, 60);
  });

  test("the PRE-FIX expression really did produce NaN for these inputs", () => {
    /* The control that stops this whole block from being a test of nothing. If
     * `Number(x ?? 60)` were already finite for these, the fix would be
     * addressing a defect that never existed and the cases above would pass on
     * both trees. This re-states the OLD expression verbatim and asserts it is
     * broken exactly where the rows claim. */
    for (const raw of ["abc", {}, [1, 2], Number.NaN] as const) {
      const old = Math.min(400, Math.max(10, Number(raw ?? 60)));
      assert.ok(Number.isNaN(old), `expected the pre-fix clamp to yield NaN for ${String(raw)}`);
      assert.ok(!Number.isNaN(resolveKeep(raw)), "the fixed clamp must not");
    }
  });
});

describe("round 971 finding 3 — the marker names a vault note that resolves", () => {
  const marker = buildMarker({
    stamp: "2026-08-19T10-00-00-000Z",
    dropped: 140,
    keep: 60,
    archive: "/opt/ai-os/backups/threads/abc-2026-08-19T10-00-00-000Z.json",
    ts: "2026-08-19T10:00:00.000Z",
  });

  test('the unresolvable "AI OS/Session State" claim is gone', () => {
    /* BOTH QUOTES ARE LOAD-BEARING. The corrected text contains the phrase
     * `AI OS/Session State - YYYY-MM-DD` inside quotes, so an unquoted needle
     * matches the fix as well as the defect and would assert nothing. Verified
     * against the vault on 2026-08-19: `/opt/obsidian-vault/AI OS/` holds
     * `Session State - 2026-08-18.md` and `Session State - 2026-08-19.md`, and
     * no undated `Session State.md`. */
    assert.ok(
      !marker.content.includes('"AI OS/Session State"'),
      "the marker still points an agent at a note that does not exist",
    );
  });

  test("it names the dated pattern instead, and says the undated note is absent", () => {
    assert.ok(marker.content.includes('"AI OS/Session State - YYYY-MM-DD"'));
    assert.ok(marker.content.includes("NEWEST dated note"));
    assert.ok(marker.content.includes('there is no undated'));
  });

  test('"AI OS/Operator Decisions" is kept — that half of the claim was true', () => {
    assert.ok(marker.content.includes('"AI OS/Operator Decisions"'));
  });

  test("the marker still carries the archive path and the counts it promises", () => {
    assert.ok(marker.content.includes("/opt/ai-os/backups/threads/abc-"));
    assert.ok(marker.content.includes("140 earlier entries"));
    assert.ok(marker.content.includes("The 60 most recent entries follow verbatim."));
    assert.deepEqual(marker.meta?.compaction, {
      dropped: 140,
      kept: 60,
      archive: "/opt/ai-os/backups/threads/abc-2026-08-19T10-00-00-000Z.json",
    });
    assert.equal(marker.role, "system");
    assert.equal(marker.kind, "text");
  });
});

describe("the archive format is unchanged — existing archives stay readable", () => {
  /* The brief forbids rewriting the archive format. These two names are REAL,
   * copied from `ls /opt/ai-os/backups/threads` on 2026-08-19, and the parser
   * that retention depends on must read them. */
  const REAL = [
    "2a509ed3-2535-435a-8c49-ff0972edb514-2026-08-18T22-05-29-591Z.json",
    "bfd1283a-b71b-4f35-b577-7d09aad803f2-2026-08-18T23-51-39-289Z.json",
  ] as const;

  test("archivePath still produces <runId>-<stamp>.json under the shipped directory", () => {
    assert.equal(ARCHIVE_DIR, "/opt/ai-os/backups/threads");
    assert.equal(
      archivePath("2a509ed3-2535-435a-8c49-ff0972edb514", "2026-08-18T22-05-29-591Z"),
      `/opt/ai-os/backups/threads/${REAL[0]}`,
    );
  });

  test("parseArchiveName reads the real on-disk names, uuid and stamp intact", () => {
    /* The uuid contains hyphens and so does the stamp, so a naive split on "-"
     * gets both wrong. These assert the split lands in the right place. */
    assert.deepEqual(parseArchiveName(REAL[0]), {
      runId: "2a509ed3-2535-435a-8c49-ff0972edb514",
      stamp: "2026-08-18T22-05-29-591Z",
    });
    assert.deepEqual(parseArchiveName(REAL[1]), {
      runId: "bfd1283a-b71b-4f35-b577-7d09aad803f2",
      stamp: "2026-08-18T23-51-39-289Z",
    });
  });

  test("a file we cannot name is not ours, and is never a deletion candidate", () => {
    for (const n of ["notes.json", "README.md", "abc.json", "2a509ed3.json", REAL[0] + ".bak"]) {
      assert.equal(parseArchiveName(n), null, `${n} must not parse as an archive`);
    }
  });
});

describe("round 971 finding 4 — retention, and the floor no threshold can break", () => {
  const f = (name: string, runId: string, ageDays: number, bytes: number): ArchiveFile => ({
    name,
    runId,
    mtimeMs: NOW - ageDays * DAY,
    bytes,
  });

  /* Literal policies. NOT built from DEFAULT_RETENTION — a threshold imported
   * from the subject makes every assertion below inert. */
  const AGE_ONLY: RetentionPolicy = {
    keepNewestPerRun: 3,
    maxAgeDays: 30,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  };
  const SIZE_ONLY: RetentionPolicy = {
    keepNewestPerRun: 1,
    maxAgeDays: 36500,
    maxTotalBytes: 1000,
  };

  test("a run with only its floor of archives loses none, however ancient", () => {
    const files = [
      f("a-1.json", "A", 900, 10),
      f("a-2.json", "A", 800, 10),
      f("a-3.json", "A", 700, 10),
    ];
    assert.deepEqual(selectArchivesToPrune(files, AGE_ONLY, NOW), []);
  });

  test("a run with ONE archive keeps it forever — the recovery guarantee", () => {
    const files = [f("solo-1.json", "SOLO", 3650, 5_000_000)];
    assert.deepEqual(selectArchivesToPrune(files, AGE_ONLY, NOW), []);
    assert.deepEqual(selectArchivesToPrune(files, SIZE_ONLY, NOW), []);
  });

  test("beyond the floor, only the aged die — and the young survive beside them", () => {
    const files = [
      f("b-old1.json", "B", 90, 10), // eligible, aged   -> dies
      f("b-old2.json", "B", 60, 10), // eligible, aged   -> dies
      f("b-mid.json", "B", 20, 10), //  eligible, young  -> survives
      f("b-new1.json", "B", 3, 10), //  floor
      f("b-new2.json", "B", 2, 10), //  floor
      f("b-new3.json", "B", 1, 10), //  floor
    ];
    const doomed = selectArchivesToPrune(files, AGE_ONLY, NOW);
    assert.deepEqual(doomed, ["b-old1.json", "b-old2.json"], "oldest first, and only those two");
    for (const survivor of ["b-mid.json", "b-new1.json", "b-new2.json", "b-new3.json"]) {
      assert.ok(!doomed.includes(survivor), `${survivor} must survive`);
    }
  });

  test("the floor is per run, not global — one busy chat cannot evict a quiet one", () => {
    const files = [
      f("q-1.json", "QUIET", 400, 10), // QUIET's only archive: exempt
      f("busy-1.json", "BUSY", 400, 10),
      f("busy-2.json", "BUSY", 399, 10),
      f("busy-3.json", "BUSY", 398, 10),
      f("busy-4.json", "BUSY", 397, 10), // floor
      f("busy-5.json", "BUSY", 396, 10), // floor
      f("busy-6.json", "BUSY", 395, 10), // floor
    ];
    const doomed = selectArchivesToPrune(files, AGE_ONLY, NOW);
    assert.deepEqual(doomed, ["busy-1.json", "busy-2.json", "busy-3.json"]);
    assert.ok(!doomed.includes("q-1.json"), "the quiet run's only backup must survive");
  });

  test("the size cap bites when everything is young — the age rule alone cannot", () => {
    /* Forty compactions in one night are all inside maxAgeDays. This is the
     * case that says why there are two rules and not one. */
    const files = [
      f("c-1.json", "C", 4, 400),
      f("c-2.json", "C", 3, 400),
      f("c-3.json", "C", 2, 400),
      f("c-4.json", "C", 1, 400), // floor (keepNewestPerRun 1)
    ];
    assert.deepEqual(
      selectArchivesToPrune(files, { ...AGE_ONLY, maxAgeDays: 30 }, NOW),
      [],
      "control: the age rule alone deletes nothing here",
    );
    const doomed = selectArchivesToPrune(files, SIZE_ONLY, NOW);
    // 1600 bytes total, cap 1000: drop the two oldest eligible to reach 800.
    assert.deepEqual(doomed, ["c-1.json", "c-2.json"]);
  });

  test("a directory made only of exempt archives is left alone, over cap or not", () => {
    /* The floor wins over the size cap. An over-cap directory of untouchable
     * files is a fact to report, never a licence to break the guarantee. */
    const files = [f("d-1.json", "D", 1, 5000), f("e-1.json", "E", 1, 5000)];
    assert.deepEqual(selectArchivesToPrune(files, SIZE_ONLY, NOW), []);
  });

  test("an empty directory is not an error and deletes nothing", () => {
    assert.deepEqual(selectArchivesToPrune([], AGE_ONLY, NOW), []);
    assert.deepEqual(selectArchivesToPrune([], SIZE_ONLY, NOW), []);
  });

  test("the shipped defaults are the ones documented and escalated", () => {
    /* Pinned against literals so a silent retune is a test change. These are
     * the values reported to Konrad in round 972's manager-chat escalation. */
    assert.equal(DEFAULT_RETENTION.keepNewestPerRun, 3);
    assert.equal(DEFAULT_RETENTION.maxAgeDays, 30);
    assert.equal(DEFAULT_RETENTION.maxTotalBytes, 2 * 1024 * 1024 * 1024);
  });

  test("under the shipped defaults, tonight's real directory loses nothing", () => {
    /* The five archives measured on 2026-08-19, with their real sizes. The
     * point is not that prune is inert — it is that switching it on does not
     * retroactively delete the evidence round 971 reviewed. */
    const tonight = [
      f("2a509ed3-2535-435a-8c49-ff0972edb514-x1.json", "2a509ed3", 0, 311_742),
      f("2a509ed3-2535-435a-8c49-ff0972edb514-x2.json", "2a509ed3", 0, 87_996),
      f("bfd1283a-b71b-4f35-b577-7d09aad803f2-y1.json", "bfd1283a", 0, 3_551_898),
      f("bfd1283a-b71b-4f35-b577-7d09aad803f2-y2.json", "bfd1283a", 0, 109_968),
      f("bfd1283a-b71b-4f35-b577-7d09aad803f2-y3.json", "bfd1283a", 0, 604_670),
    ];
    assert.deepEqual(selectArchivesToPrune(tonight, DEFAULT_RETENTION, NOW), []);
  });
});
