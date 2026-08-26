/**
 * `scripts/checks/check-secret-scan.ts` must REPORT a committed credential
 * without REPRODUCING it.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * WHY THIS FILE EXISTS. Until 2026-08-25 the scanner printed the matched span
 * verbatim:
 *
 *     check-secret-scan.ts:112   for (const s of suspects) console.log(`        ${s}`);
 *
 * The scanner is meant to be wired into `scripts/checks/gates-808.sh`. Wiring
 * it in while it printed verbatim would have written the live `content_forge`
 * DSN password into the gate log of every project, on every run, for every
 * worker and every artefact directory — spreading the secret in the exact act
 * of policing it. So the print is masked and this file pins it.
 *
 * TWO HALVES, AND THE SECOND ONE IS THE POINT. The fleet note
 * `do-not-soften-check-secret-scan` forbids making this scanner find LESS —
 * three rounds in one day tried to widen `SAFE_MARKERS` so their own report
 * would pass. Masking the OUTPUT is a different act from widening the
 * DENYLIST, but only if that is measured rather than asserted, so every test
 * below checks BOTH:
 *
 *   1. the fixture still FAILS, with the same exit code and the same count;
 *   2. the password segment does not appear in what was printed.
 *
 * A test that only checked (2) would pass if somebody deleted the detector.
 *
 * THE FIXTURE CREDENTIALS ARE ASSEMBLED AT RUN TIME, NEVER WRITTEN AS
 * LITERALS. This file is a tracked file, so the scanner sweeps it. A DSN
 * written out here with an unlabelled password segment would fail the very
 * gate it tests — that happened on the first draft of this file, at two
 * comment lines, and the scanner caught both. The obvious workaround —
 * putting a `SAFE_MARKERS` word in the value — would
 * silently destroy the test, because a fixture carrying a safe marker never
 * fires the check in the first place. So the scheme lives in one variable and
 * the password in another, and neither the source nor any allowlist ever
 * contains a credential-shaped span. Same construction the fleet note
 * prescribes for re-runnable evidence recipes.
 *
 * THE FIXTURES LIVE OUTSIDE THE REPO (`os.tmpdir()`) and are removed after
 * each case. They must not be tracked: `git ls-files` is the gate's corpus,
 * and a fixture that landed in it would turn main red forever.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNER = fileURLToPath(new URL("../../../scripts/checks/check-secret-scan.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

/** Assembled, never a literal — see the header. Neither half is
 *  credential-shaped on its own, so this file does not fail the gate it tests. */
const SCHEME = "postgre" + "sql" + "://";
const FIXTURE_USER = "fixture_user";
const FIXTURE_HOST = "127.0.0.1:5432/fixture_db";
/** No `SAFE_MARKERS` word, no bracket, no `$`, no asterisk — so the scanner
 *  MUST treat it as a live credential. Invented here; it is not, and must
 *  never be, a copy of any real value. */
const FIXTURE_PW = "Qz7" + "mVr4" + "tKw9" + "bXn2";

interface ScanResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the scanner over exactly the named paths and capture everything it
 *  emitted. Fixture mode (`--file`) exists so a test can hand the scanner a
 *  file that is deliberately NOT tracked; the gate itself takes no arguments. */
function scan(...files: readonly string[]): ScanResult {
  const r = spawnSync(TSX, [SCANNER, ...files.flatMap((f) => ["--file", f])], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (typeof r.status !== "number") {
    throw new Error(`scanner did not exit normally (signal ${String(r.signal)})`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A scratch directory holding one fixture file, cleaned up by the caller. */
function withFixture(name: string, body: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-fixture-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a DSN credential still FAILS, and the password is not printed", () => {
  const body = [
    "// fixture — a DSN with an unlabelled password segment",
    "const url =",
    `  "${SCHEME}${FIXTURE_USER}:${FIXTURE_PW}@${FIXTURE_HOST}";`,
    "",
  ].join("\n");

  withFixture("dsn-fixture.ts", body, (path) => {
    const r = scan(path);

    // Half 1 — DETECTION IS UNCHANGED.
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stdout, /^FAIL {2}.*dsn-fixture\.ts$/m);
    assert.match(r.stdout, /^1 FILE\(S\) FAILED/m);
    assert.equal(r.stdout.match(/^FAIL {2}/gm)?.length, 1);

    // Half 2 — THE MATERIAL IS NOT IN THE OUTPUT. stderr too: a crash inside
    // the redaction path must not spill what the redaction was hiding.
    assert.ok(!r.stdout.includes(FIXTURE_PW), "stdout leaked the fixture password");
    assert.ok(!r.stderr.includes(FIXTURE_PW), "stderr leaked the fixture password");

    // …and the report is still USEFUL: file, line, rule, masked shape.
    assert.match(r.stdout, /^ +line 3 {2}DSN password {2}/m);
    assert.ok(
      r.stdout.includes(`${SCHEME}${FIXTURE_USER}:***@`),
      "the masked DSN shape is missing — a reader cannot find the match by hand",
    );
  });
});

test("a PGPASSWORD assignment still FAILS, and the password is not printed", () => {
  const body = ["#!/bin/sh", `PGPASSWORD=${FIXTURE_PW} psql -U fixture_user`, ""].join("\n");

  withFixture("pgpassword-fixture.sh", body, (path) => {
    const r = scan(path);

    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stdout, /^FAIL {2}.*pgpassword-fixture\.sh$/m);
    // Label is "password assignment", not "PGPASSWORD". The matcher was widened
    // from `PGPASSWORD=` to any `*PASSWORD=` because the live content_forge
    // credential is committed as `PG_PASSWORD="${PGPASSWORD:-…}"` — a line with
    // no `PGPASSWORD=` substring at all, which the old pattern could not see.
    // The contract THIS test guards is unchanged: the value is masked and the
    // line number is right.
    assert.match(r.stdout, /^ +line 2 {2}password assignment {2}PGPASSWORD=\*\*\*$/m);

    assert.ok(!r.stdout.includes(FIXTURE_PW), "stdout leaked the fixture password");
    assert.ok(!r.stderr.includes(FIXTURE_PW), "stderr leaked the fixture password");
  });
});

test("a labelled placeholder still PASSES — redaction did not blunt the denylist", () => {
  // The mirror image of the two cases above, and the reason they mean
  // anything: if the scanner had been reduced to "fail on every DSN", the
  // tests above would still be green. `PASSWORD` is a `SAFE_MARKERS` word.
  const body = `const example = "${SCHEME}${FIXTURE_USER}:PASSWORD@${FIXTURE_HOST}";\n`;

  withFixture("safe-fixture.ts", body, (path) => {
    const r = scan(path);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^ALL PASS — 1 named files/m);
  });
});

test("the mask is anchored on the password, not on the whole match", () => {
  // A DSN whose user and password are the IDENTICAL string. A naive `indexOf`
  // masks the user and prints the password intact, which is exactly the leak
  // this file exists to prevent, so the degenerate case gets its own control.
  const body = `const url = "${SCHEME}${FIXTURE_PW}:${FIXTURE_PW}@${FIXTURE_HOST}";\n`;

  withFixture("same-user-and-pw.ts", body, (path) => {
    const r = scan(path);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.ok(
      r.stdout.includes(`${SCHEME}${FIXTURE_PW}:***@`),
      "the password segment, not the user, must be the masked one",
    );
    assert.ok(!r.stdout.includes(`:${FIXTURE_PW}@`), "stdout leaked the password segment");
  });
});

test("THE INVARIANT: a full gate run's own output passes the scanner", () => {
  // The property that makes wiring this into `gates-808.sh` safe, stated over
  // the REAL repository rather than a fixture, and independent of how many
  // files happen to be failing today: whatever the gate prints, feeding that
  // text back to the gate is clean. Written to a scratch file outside the repo
  // and scanned in fixture mode — the scanner checking its own report.
  const r = spawnSync(TSX, [SCANNER], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.error) throw r.error;
  assert.ok(r.stdout.length > 0, "the gate printed nothing at all");

  withFixture("gate-output.txt", r.stdout + r.stderr, (path) => {
    const self = scan(path);
    assert.equal(
      self.status,
      0,
      "the gate's own output carries an unlabelled credential — the redaction is not holding",
    );
  });
});
