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
 * THE FAILURE REPORT IS REDACTED, AND THAT IS NOT A SOFTENING. Until
 * 2026-08-25 a failure printed the matched span verbatim, so the act of
 * reporting a committed credential COPIED it — into a terminal, a gate log, an
 * artefact directory, a report. The scanner is meant to be wired into
 * `gates-808.sh`, which would have written the live password into every
 * project's gate log on every run. So a failure now names the FILE, the LINE,
 * the RULE that fired, and the match with its password segment replaced by
 * `***` — enough to find the string by hand, nothing anybody can use.
 *
 * DETECTION IS BYTE-FOR-BYTE UNCHANGED by that edit: the same regexes over the
 * same corpus with the same `SAFE_MARKERS`, the same per-file failure, the same
 * exit code, the same count. `do-not-soften-check-secret-scan` forbids making
 * this script find LESS. This makes it SAY less while finding exactly the same,
 * and the two are not the same act. `secret-scan-redaction.test.ts` pins both
 * halves.
 *
 * Note the mask is `***`, which `SAFE_MARKERS` already recognises (`^\*+$`) as
 * the universal redaction — so this script's own output passes this script.
 * That is a property the test asserts, not a coincidence.
 *
 * Run (from the repo root):
 *   forge-control/node_modules/.bin/tsx scripts/checks/check-secret-scan.ts
 *
 * FIXTURE MODE, for the test suite only:
 *   … check-secret-scan.ts --file /tmp/fixture.ts [--file …]
 * scans exactly the named paths instead of the tracked corpus. The gate
 * invocation takes NO arguments and always sweeps every tracked file; anything
 * that runs this script with `--file` is testing it, not gating with it.
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
/** A shell password assignment. Was `PGPASSWORD=` exactly; widened to any
 *  `*PASSWORD=` variable because `preflight-deploy.sh:41` spells it
 *  `PG_PASSWORD="${PGPASSWORD:-<live credential>}"` — no `PGPASSWORD=`
 *  substring anywhere on the line, so the old pattern matched NOTHING and the
 *  file scanned clean while carrying the production password. */
const PASSWORD_ASSIGN_RE = /\b[A-Z][A-Z0-9_]*PASSWORD[ \t]*=(?![=~])[ \t]*(['"]?)([^\s'"\\]+)\1/g;

/** Shortest value this check will call a credential.
 *
 *  Widening `PGPASSWORD=` to `*PASSWORD=` caught the real miss
 *  (`PG_PASSWORD="${PGPASSWORD:-<live>}"`) and also lit up
 *  `test-guard-autonomy.py:787`, a destructive-command TEST FIXTURE whose
 *  string is `PGPASSWORD=x bash`. `x` is not a credential and never will be.
 *
 *  This is a deliberate, bounded trade: a committed password of 7 characters
 *  or fewer passes this scan. Every real credential in this repo's history is
 *  18-30 chars (`content_forge_prod`, the leaked 30-char `content_forge`
 *  password), and Postgres deployments here do not issue short ones. The cost
 *  of the alternative is concrete and already measured: a scan with five false
 *  positives is one nobody wires into a gate, which is how a live credential
 *  sat unflagged on main for three days. */
const MIN_CREDENTIAL_LENGTH = 8;

/** Reduce `${VAR:-default}` to `default` before judging it, repeatedly.
 *
 *  THIS IS THE HOLE THAT LET THE LIVE PASSWORD THROUGH, and it is worth being
 *  explicit about because the check looked correct. `SAFE_MARKERS` whitelists
 *  `${` — a script READING a credential at runtime is the opposite of
 *  committing one — and it separately whitelists any value containing the
 *  substring `PASSWORD`. `${PGPASSWORD:-90d4…}` trips BOTH. So the exact shape
 *  that commits a credential, a parameter expansion whose DEFAULT is the
 *  secret, was doubly exempt. `fixtures/preflight-c1-fixture.sh:37` carried the
 *  production `content_forge` password past this scan for that reason.
 *
 *  A bare `${VAR}` / `$(cmd)` / `$VAR` stays safe — there is no default to
 *  unwrap, so those return unchanged and hit SAFE_MARKERS as before. Nested
 *  defaults (`${A:-${B:-literal}}`) unwrap until a literal or a bare reference
 *  is left, which is why this loops rather than testing once. */
function unwrapShellDefault(value: string): string {
  let v = value;
  for (let i = 0; i < 8; i++) {
    const m = /^\$\{[A-Za-z_][A-Za-z0-9_]*:[-=?+]([\s\S]*)\}$/.exec(v);
    if (!m) return v;
    v = m[1];
  }
  return v;
}

/** Is this captured segment worth judging at all?
 *
 *  An EMPTY default is the single most common shape in this repo's ops
 *  scripts: `export PGPASSWORD="${PGPASSWORD:-${DB_PASSWORD:-}}"` in
 *  `safe-restart.sh:36`, `recover-stuck-task.sh:67` and the p6-deploy
 *  transcript that quotes them. It unwraps to `""` — which no SAFE_MARKER
 *  matches, so without this it reads as an unlabelled secret. It is the
 *  opposite: a script declaring it has NO baked-in password and will take one
 *  from the environment or go without. */
function isCredentialCandidate(raw: string, minLength: number): boolean {
  const v = unwrapShellDefault(raw).trim();
  if (v.length === 0) return false;
  if (v.length < minLength) return false;
  return !SAFE_MARKERS.test(v);
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP_EXTENSIONS.has(extname(f)));
}

/** Fixture mode: `--file <path>` (repeatable). No arguments means the gate —
 *  the whole tracked corpus. An argument this script does not understand is a
 *  hard error, never a silently-ignored token: a typo'd flag must not be able
 *  to turn a gate run into a no-op run that exits 0. */
function selectedFiles(argv: readonly string[]): string[] {
  if (argv.length === 0) return trackedFiles();

  const picked: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--file") {
      throw new Error(
        `check-secret-scan: unknown argument ${JSON.stringify(argv[i])} at position ${i}. ` +
          `Usage: check-secret-scan.ts [--file <path> …] — no arguments scans every tracked file.`,
      );
    }
    const path = argv[++i];
    if (path === undefined) throw new Error("check-secret-scan: --file needs a path after it");
    picked.push(path);
  }
  return picked;
}

/** The mask that replaces a matched password segment. `SAFE_MARKERS`'s
 *  `^\*+$` alternative already treats it as the universal redaction, so a gate
 *  log carrying this script's own output does not fail this script. Fixed
 *  width on purpose — a mask as long as the secret would leak its length. */
const MASK = "***";

/** Replace `secret` inside `match` with `MASK`, so a report can show the shape
 *  of what fired without reproducing the credential.
 *
 *  `lastIndexOf` rather than `indexOf`: in both regexes the captured segment
 *  is the LAST thing in the match (`…:PASSWORD@`, `PGPASSWORD=PASSWORD`), and
 *  a DSN whose user and password happen to be the same string
 *  (`postgres://x:x@`) must mask the password, not the user.
 *
 *  Throws rather than falling back to printing the raw match: the capture is a
 *  substring of the match by construction, so a miss means the regexes were
 *  edited into a shape this function no longer understands, and the correct
 *  response to that is a loud crash — NOT quietly reverting to the verbatim
 *  print this whole change exists to remove. The diagnostic carries lengths
 *  only; it must never carry the material. */
function mask(match: string, secret: string): string {
  const at = match.lastIndexOf(secret);
  if (at < 0) {
    throw new Error(
      `check-secret-scan: cannot redact — the captured segment (${secret.length} chars) is not a ` +
        `substring of its own match (${match.length} chars). A pattern was edited; fix the ` +
        `redaction before this script prints anything.`,
    );
  }
  return match.slice(0, at) + MASK + match.slice(at + secret.length);
}

/** 1-based line of a byte offset, so a failure says WHERE without quoting. */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** `matchAll` types `index` as optional on some lib targets; a match without
 *  an offset is not something to paper over with a 0. */
function offsetOf(m: RegExpMatchArray): number {
  if (typeof m.index !== "number") {
    throw new Error("check-secret-scan: match carries no index — cannot report a line number");
  }
  return m.index;
}

const ARGV = process.argv.slice(2);
const CORPUS = ARGV.length === 0 ? "tracked" : "named";

let failures = 0;
let scanned = 0;

for (const file of selectedFiles(ARGV)) {
  const abs = new URL(file, `file://${REPO_ROOT}`);
  if (fileURLToPath(abs) === SELF_PATH) continue; // this file quotes its own patterns

  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    continue; // not a regular readable text file (symlink, submodule, binary that slipped through)
  }
  scanned++;

  // WHAT FIRES IS DECIDED HERE; WHAT IS PRINTED IS DECIDED BY `mask()`. Keep
  // those two apart — every `SAFE_MARKERS.test` below reads the RAW captured
  // segment, never a masked one, so redaction cannot change the verdict.
  // `unwrapShellDefault` runs BEFORE the verdict, so `${VAR:-secret}` is judged
  // on `secret` rather than on the expansion that wraps it. It never runs
  // before `mask()` — what is printed still redacts the raw matched text.
  const suspects: string[] = [];
  // A DSN password gets NO length floor — `postgres://u:abc@host` is a
  // credential at any length, and the surrounding `://…@` is unambiguous.
  // Only the far looser `*PASSWORD=` shape, which also matches prose and test
  // fixtures, needs one.
  for (const m of content.matchAll(DSN_RE)) {
    if (isCredentialCandidate(m[1], 1)) {
      suspects.push(`line ${lineOf(content, offsetOf(m))}  DSN password  ${mask(m[0], m[1])}`);
    }
  }
  for (const m of content.matchAll(PASSWORD_ASSIGN_RE)) {
    if (isCredentialCandidate(m[2], MIN_CREDENTIAL_LENGTH)) {
      suspects.push(`line ${lineOf(content, offsetOf(m))}  password assignment  ${mask(m[0], m[2])}`);
    }
  }

  if (suspects.length > 0) {
    failures++;
    console.log(`FAIL  ${file}`);
    for (const s of suspects) console.log(`        ${s}`);
  }
}

console.log(
  failures === 0
    ? `\nALL PASS — ${scanned} ${CORPUS} files carry no unlabelled DB credential`
    : `\n${failures} FILE(S) FAILED — live-looking DB credential committed`,
);
process.exit(failures === 0 ? 0 : 1);
