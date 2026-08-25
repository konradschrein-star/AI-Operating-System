/**
 * check-secret-scan.ts — repo-wide guard against a live Postgres credential
 * landing in a tracked file, again.
 *
 * Round 1352 found the live `content_forge` and `ai_os` database passwords
 * committed verbatim inside a phase600 fixture — a capture of a terminal
 * session where an earlier round's leak-prevention tooling had passed
 * DATABASE_URL through psql argv and the executor logged the whole line. A
 * human reading a planning brief found it. This is the script that should
 * find it next time.
 *
 * WHAT COUNTS AS SAFE: every legitimate DSN already committed in this repo —
 * ~20 source files' shared fallback-default constant, and every doc/fixture
 * example — carries an unmistakable placeholder marker (angle/guillemet
 * brackets, a template interpolation, or a word like PASSWORD/SYNTHETIC/FAKE/
 * REDACTED/PLACEHOLDER in the value itself). A password segment carrying NONE
 * of those markers is either a real secret or a new placeholder shape nobody
 * taught this script yet — either way it fails loud rather than silently
 * passing. This is deliberately a denylist-of-shape check, not a fixed list
 * of known-bad strings: rotating the leaked passwords does not defeat it.
 *
 * Scans two shapes, both seen in the actual leak:
 *   1. `postgres(ql)://user:PASSWORD@host` — any DSN, anywhere.
 *   2. `PGPASSWORD=PASSWORD` / `PGPASSWORD='PASSWORD'` — the psql argv form.
 *
 * vitest is not set up in either repo and NFU8 forbids adding one — plain
 * tsx, `process.exit(1)` on any match. Same shape as the other check-*.ts
 * scripts, deliberately.
 *
 * Run (from the repo root):
 *   forge-control/node_modules/.bin/tsx scripts/checks/check-secret-scan.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".lock",
]);

/** A password segment carrying any of these is a labelled placeholder, not a
 *  live credential — angle/guillemet brackets, a template interpolation or
 *  command substitution, the literal fallback default, or a word that only
 *  shows up in fake values.
 *
 *  `^\*+$` — A SEGMENT THAT IS NOTHING BUT ASTERISKS. Added in phase 4's fix
 *  cycle (R4-gate blocker 2), and scoped to the exact TOKEN rather than to a
 *  file or a directory, which is the distinction that matters:
 *  `postgresql://ai_os_app:***@host` in a determination document is the
 *  universal redaction, while a REAL credential written anywhere else in that
 *  same file still fails. It is ANCHORED on purpose — `abc***def` is not a
 *  redaction, it is a password with asterisks in it, and it must keep
 *  failing.
 *
 *  `^\$[A-Za-z_][A-Za-z0-9_]*$` — A BARE SHELL VARIABLE REFERENCE. Completes
 *  the intent of the `\$[{(]` alternative already here, which recognises
 *  `${VAR}` and `$(cmd)` and then flags the third spelling of the same thing.
 *  `PGPASSWORD="$DOCPW"` is a script READING a credential at run time, which
 *  is the opposite of committing one. Anchored, so `$VARsomething-else` and
 *  `pw$X` keep failing.
 *
 *  `^stub$` \u2014 THE UNIT-TEST STUB SHAPE. `project-tick-stuck.test.ts:55` pins
 *  `DATABASE_URL = "postgresql://stub:stub@127.0.0.1:1/stub_never_content_forge"`
 *  so the module under test cannot reach a real database \u2014 port 1, and a
 *  database name that says so. That is the header's "new placeholder shape
 *  nobody taught this script yet", and it was this check's ONLY false
 *  positive. It mattered more than one noisy line: a scan that cries wolf on a
 *  correct file is a scan nobody wires into a gate, and this one sat in zero
 *  gates while a live credential sat on main. Anchored like its neighbours \u2014
 *  `stubborn` and `stub123` are passwords, not placeholders, and keep failing. */
const SAFE_MARKERS =
  /^\*+$|^\$[A-Za-z_][A-Za-z0-9_]*$|[<>]|[\u2039\u203A]|\$[{(]|\u2026|PASSWORD|SYNTHETIC|REDACTED|FAKE|PLACEHOLDER|^PASS$|^USER$|^stub$|^content_forge_prod$/i;

// A DSN's password segment: postgres(ql)://user:PASSWORD@host
const DSN_RE = /postgres(?:ql)?:\/\/[^\s"'\\/]+:([^\s"'\\@]+)@/g;
// A shell PGPASSWORD assignment: PGPASSWORD=value or PGPASSWORD='value'.
// The value excludes backslash too — a real password is never written with
// one here, but a JSON-escaped shell script quoting `\"$VAR\"` is, and that
// is not a credential, just a script that reads one at runtime.
const PGPASSWORD_RE = /PGPASSWORD=(['"]?)([^\s'"\\]+)\1/g;

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP_EXTENSIONS.has(extname(f)));
}

let failures = 0;
let scanned = 0;

for (const file of trackedFiles()) {
  const abs = new URL(file, `file://${REPO_ROOT}`);
  if (fileURLToPath(abs) === SELF_PATH) continue; // this file quotes its own patterns

  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    continue; // not a regular readable text file (symlink, submodule, binary that slipped through)
  }
  scanned++;

  const suspects: string[] = [];
  for (const m of content.matchAll(DSN_RE)) {
    if (!SAFE_MARKERS.test(m[1])) suspects.push(`DSN password: ${m[0]}`);
  }
  for (const m of content.matchAll(PGPASSWORD_RE)) {
    if (!SAFE_MARKERS.test(m[2])) suspects.push(`PGPASSWORD=${m[2]}`);
  }

  if (suspects.length > 0) {
    failures++;
    console.log(`FAIL  ${file}`);
    for (const s of suspects) console.log(`        ${s}`);
  }
}

console.log(
  failures === 0
    ? `\nALL PASS — ${scanned} tracked files carry no unlabelled DB credential`
    : `\n${failures} FILE(S) FAILED — live-looking DB credential committed`,
);
process.exit(failures === 0 ? 0 : 1);
