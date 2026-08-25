/**
 * check-instrument-execution.ts — THE EXECUTION REGISTRY.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS, AND WHY IT IS A COPY.
 *
 * This repo already has a COMPLETE, AUTOMATIC registry of one axis and had NO
 * registry of the other. `check-instrument-typecheck.sh` enumerates its
 * subjects by GLOB over the whole of `scripts/checks/` and COMPILES each one,
 * with `instrument-manifest.txt` as an open waiver ledger for anything
 * excused. Coverage there is automatic and cannot be forgotten. So all 56
 * instruments earn a green tick every run — FOR COMPILING. Nothing asked
 * which of them RUN.
 *
 * The answer, measured on 2026-08-25 by D1 of `aios-verification-that-bites`
 * (`docs/plan/artifacts/verification-that-bites/D1-execution-audit.md`,
 * `execution-audit.tsv`): 41 of 74 artefacts are executed by nothing, and
 * `check-secret-scan.ts` sat in that set over a live committed credential
 * while the suite reported `RED: 0`. A fix cycle drove it green in August and
 * left nothing executing it.
 *
 * This file is therefore DELIBERATELY BORING. It is the same design as the
 * compile registry, one axis over: GLOB + OPEN LEDGER + EVERY EXCLUSION
 * PRINTED. Read `scripts/checks/instrument-manifest.txt` lines 1-60 for the
 * argument; it is made once, there, and this file does not re-make it.
 *
 * ===========================================================================
 * 1. ENUMERATION IS BY GLOB, NEVER BY LIST.
 *
 * SUBJECTS = every `*.{ts,tsx,sh,cjs,mjs,py}` under `scripts/checks/` at any
 * depth, dotfiles included, PLUS every git-TRACKED `*.test.ts` / `*.test.tsx`
 * anywhere in the repo. A file written by someone who never read this check
 * is its subject the moment it exists. There is no way to "obtain coverage"
 * by writing something down.
 *
 * The COVERAGE SCAN closes the same hole `instrument-manifest.txt`'s header
 * closes for `.mts`/`.cts`: every file under `scripts/checks/` whose
 * extension is neither a SUBJECT extension nor a declared DATA extension is
 * NAMED and FAILS the run. A file this registry declines to read cannot also
 * be certified by it.
 *
 * ===========================================================================
 * 2. THE MATCHING RULE — COMMAND POSITION, NOT ANY OCCURRENCE.
 *
 * A source comment mentioning a check is NOT an invocation. Treating one as an
 * invocation is exactly how this hole opened: three workers in one night
 * reported `check-secret-scan.ts` as a gate blocker because the gate list
 * *looked* complete. So the rule is stated here, in full, and it is provable:
 *
 *   R1. Only the CLOSED RUNNER SET is read (§3). A reference anywhere else —
 *       a doc, an evidence report, another check's prose — is not an
 *       invocation and is not looked at.
 *   R2. Full-line comments are stripped from a shell runner before anything
 *       else. `\`-continuations are then joined into one LOGICAL LINE.
 *   R3. A logical line is tokenised. A quoted token is RECURSED INTO as a
 *       nested fragment, because that is how this repo writes its gates:
 *       `gate_sh "<label>" "<the actual command>"`.
 *   R4. Within a fragment, tokens are grouped into COMMANDS at shell
 *       operators (`| || && ; & ( ) { }` and `$(`). A command's HEAD is its
 *       first token — or, additionally, an INTERPRETER token whose immediately
 *       preceding token was a complete QUOTED string, which is the
 *       `gate "<label>" node <path>` wrapper idiom.
 *   R5. An invocation is recorded when either
 *         (a) the head itself resolves to a subject (`bash scripts/x.sh` run
 *             as `./scripts/x.sh`), or
 *         (b) the head is an INTERPRETER (bash/sh/node/tsx/python3/...) and
 *             some following token in the same command resolves to a subject.
 *       `npx`/`pnpm exec` are unwrapped to the program they actually run.
 *   R6. `tsc` IS NOT AN INTERPRETER. `npx tsc --noEmit <subject>` COMPILES a
 *       subject; it does not execute it, and this whole project exists
 *       because those two were conflated. Such a reference is recorded
 *       separately as NON-EXECUTING and reported, never counted as coverage.
 *   R7. Simple `VAR=<value>` assignments in a shell runner are resolved, so
 *       `GUARD="$REPO/scripts/checks/guard.sh"` … `bash "$GUARD"` counts.
 *       A leading `$VAR/` or `${VAR}/` and any number of leading `../`/`./`
 *       segments are stripped when resolving a token to a repo-relative path.
 *   R8. A token with no `/` in it NEVER resolves. That is what makes
 *       `gate_sh "check-composer-v3.ts" "<cmd>"`'s LABEL a label and the
 *       command a command.
 *   R9. A runner never invokes ITSELF: a self-match is discarded.
 *
 * PROOF THAT R4/R8 REJECT PROSE — three live cases in this repo, all
 * re-checkable, all of which a naive filename grep gets wrong:
 *   - `guard.sh:196` fix string: "see the full per-subject report: bash
 *     scripts/checks/check-instrument-typecheck.sh". `bash` is preceded by the
 *     bare word `report:`, not by a quoted string and not at a command start,
 *     so R4 does not make it a head and nothing is recorded. The real
 *     invocation is the NEXT line.
 *   - `gates-808.sh:122-129` gate 4 passes
 *     `scripts/checks/check-working-sql-agreement.ts` as an ARGUMENT to
 *     `grep -rnE`. The command head is `grep`, which is not an interpreter,
 *     so no invocation is recorded — correctly.
 *   - `preflight-deploy.sh:144` names
 *     `scripts/checks/fixtures/preflight-c1-fixture.sh` in a comment. R2
 *     removes the line entirely.
 * Control C4 in `docs/plan/artifacts/verification-that-bites/D6-execution-
 * registry.md` runs that experiment deliberately, both shapes.
 *
 * ===========================================================================
 * 3. THE CLOSED RUNNER SET.
 *
 * D1 proved it closed: no `.github/`, no Makefile, no other YAML, no pm2
 * process and no cron entry executes anything under `scripts/checks/`
 * (D1-execution-audit.md §Method). It is: the four shell runners named in
 * SHELL_RUNNERS below, plus every `test`/`test:*`/`guard`/`guard:*` script in
 * every tracked `package.json` — the package half is discovered BY GLOB, so a
 * fifth package added next year is read without editing this file.
 *
 * A declared shell runner that is missing from disk is a REFUSAL, not a skip:
 * a registry that silently stops reading a runner reclassifies every check
 * that runner invokes as an orphan, and would look like it was working.
 *
 * ===========================================================================
 * 4. TEST FILES RESOLVE AGAINST WHAT THE GLOB EXPANDS TO, NOT ITS TEXT.
 *
 * `package.json`'s `test` script is matched by EXPANDING its glob against the
 * files on disk (D4-test-glob.md §4 states this invariant and computes today's
 * answer in shell). D4's shell uses `find`, which is only correct because both
 * of today's patterns are rooted double-star patterns (the literal sequence is
 * not written here: inside a block comment it would close it). This does
 * real glob semantics instead — `*` does not cross `/`, `**` does — because
 * the day someone writes `src/lib/*.test.ts` again, a `find`-based resolver
 * would certify `src/lib/nested/x.test.ts` as covered when the runner never
 * runs it. That is the same false-green this registry exists to refuse.
 *
 * ===========================================================================
 * 5. THE VERDICT DISTINGUISHES TWO KINDS OF NON-COVERAGE, AND ONLY ONE OF
 *    THEM IS EXCUSED.
 *
 *   LEDGERED-EXCUSED — `scripts/checks/execution-manifest.txt` names it as
 *     SPENT, NOT-A-CHECK or PROCEDURE-INVOKED, with a reason and an owner.
 *     Printed in full on every run. Adding a path there does not obtain
 *     coverage; it excuses a failure.
 *   OPEN FINDING — a LIVE-ORPHAN: a check whose subject still ships and which
 *     nothing executes. THESE MAY NOT BE LEDGERED (`LIVE-ORPHAN` is not an
 *     accepted bucket value, so the ledger cannot express one). They are
 *     carried in KNOWN_OPEN_FINDINGS below: an INVENTORY THAT SHRINKS, never a
 *     waiver. Every one is printed by name on every run as a debt register.
 *     An entry that becomes invoked must be DELETED from the inventory — the
 *     run fails until it is, so the list cannot grow stale in the safe
 *     direction either.
 *
 * `check-secret-scan.ts` is in the inventory and is NOT ledgered, deliberately.
 * Wiring it in today would print a live credential into every project's gate
 * log (its line 112 prints the match verbatim); the fixed order is redact ->
 * Konrad rotates -> remove the literal -> wire in.
 *
 * This registry lands GREEN at main over today's 41 orphans on purpose. A gate
 * that lands RED turns main red for every lane at once and is disabled within
 * a day. It goes red on the NEXT orphan — see control C1.
 *
 * ===========================================================================
 * USAGE
 *   forge-control/node_modules/.bin/tsx scripts/checks/check-instrument-execution.ts
 *
 * EXIT CODES — no third outcome, no silent fallback.
 *   0  every subject is invoked, ledgered, or a declared open finding
 *   1  a subject is executed by nothing and is neither ledgered nor declared;
 *      or a ledger error; or a stale ledger/inventory entry; or an unhandled
 *      extension under scripts/checks/; or a runner/ledger that is not on disk
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── configuration, all of it visible in one screen ──────────────────────────

/** The one directory whose artefacts are instruments. */
const SUBJECT_ROOT = "scripts/checks";

/** Extensions this registry knows how to reason about as executables. */
const SUBJECT_EXTENSIONS = ["ts", "tsx", "sh", "cjs", "mjs", "py"] as const;

/**
 * Extensions under SUBJECT_ROOT that are DATA, declared here so the coverage
 * scan can tell "not an instrument" from "an instrument I cannot read". Only
 * these are exempt; anything else is named and fails.
 */
const DATA_EXTENSIONS = ["txt"] as const;

/** Programs that EXECUTE their file argument. `tsc` is deliberately absent. */
const INTERPRETERS = ["bash", "sh", "zsh", "node", "tsx", "python", "python3"] as const;

/** Wrappers that run some other program named in their own arguments. */
const PROGRAM_WRAPPERS = ["npx", "pnpm", "npm", "yarn"] as const;

/**
 * Programs that READ a subject without executing it. `npx tsc --noEmit <check>`
 * and `grep -rnE … <check>` are the two live shapes in this repo. Recorded and
 * printed, never counted as coverage (R6). A head that is in NEITHER this set
 * nor INTERPRETERS records nothing at all: `see`, `gate`, `run_check` and every
 * other English word or wrapper function that happens to precede a path is not
 * a program, and inventing a reference for it is the false-green this registry
 * refuses.
 */
const NON_EXECUTING_TOOLS = [
  "tsc", "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "sed", "awk",
  "wc", "md5sum", "sha1sum", "cmp", "diff", "cp", "mv",
] as const;

/** The shell half of the closed runner set (D1 §Method). */
const SHELL_RUNNERS = [
  "scripts/checks/gates-808.sh",
  "scripts/checks/guard.sh",
  "scripts/checks/preflight-deploy.sh",
  "scripts/checks/test-guard-discrimination.sh",
] as const;

/** package.json script NAMES that are runners. A rule, not a list of scripts. */
const RUNNER_SCRIPT_NAME = /^(test|test:.+|guard|guard:.+)$/;

const LEDGER_PATH = "scripts/checks/execution-manifest.txt";

const LEDGER_BUCKETS = ["SPENT", "NOT-A-CHECK", "PROCEDURE-INVOKED"] as const;
type LedgerBucket = (typeof LEDGER_BUCKETS)[number];

/**
 * THE OPEN-FINDINGS INVENTORY — every LIVE-ORPHAN D1 found that is still an
 * orphan today. NOT a waiver: each line is a debt Konrad can watch shrink, and
 * the run FAILS if one of them silently becomes invoked without being removed
 * from here. The count is declared separately from the list so that editing
 * one without the other is itself an error.
 *
 * Seeded 2026-08-25 from execution-audit.tsv's LIVE-ORPHAN bucket, then
 * re-derived mechanically against this file's own resolver. Two entries differ
 * from the TSV and both differences are the resolver being stricter than the
 * hand audit, not looser:
 *   - `check-working-sql-agreement.ts` — the TSV calls it LIVE-WIRED, citing
 *     gates-808.sh:180-183. That gate is `npx tsc --noEmit <it>`: it COMPILES
 *     the check, and `check-instrument-typecheck.sh` already compiles it too.
 *     Nothing executes its assertions. It is an orphan (R6), and its gate is a
 *     duplicate compile wearing an execution gate's costume.
 *   - `preflight-deploy.sh` — a runner in form (it has its own C1-C5 body) and
 *     an orphan in fact: nothing invokes it, so its own body never runs.
 * See D6-execution-registry.md for both, with the commands.
 */
const KNOWN_OPEN_FINDING_COUNT = 45;
const KNOWN_OPEN_FINDINGS: readonly string[] = [
  "scripts/checks/api-diff.sh",
  "scripts/checks/check-await-seed.sh",
  "scripts/checks/check-browser-shots.ts",
  "scripts/checks/check-browser-stream-viewer.ts",
  "scripts/checks/check-chat-delta.ts",
  "scripts/checks/check-chat-pagination-browser.ts",
  "scripts/checks/check-chat-rail-payload.ts",
  "scripts/checks/check-chat-rich.tsx",
  "scripts/checks/check-classify.ts",
  "scripts/checks/check-close-gate.ts",
  "scripts/checks/check-connection-states.ts",
  "scripts/checks/check-duration.ts",
  "scripts/checks/check-fix-chain-graph.ts",
  "scripts/checks/check-gemini-tally.ts",
  "scripts/checks/check-integrations.tsx",
  "scripts/checks/check-migration-0040.sh",
  "scripts/checks/check-nav-stack.ts",
  "scripts/checks/check-ops-scripts.sh",
  "scripts/checks/check-orientation.ts",
  "scripts/checks/check-phase3-placeholders.ts",
  "scripts/checks/check-plan-api.ts",
  "scripts/checks/check-plan-store.ts",
  "scripts/checks/check-project-metadata.ts",
  "scripts/checks/check-quota-row.ts",
  "scripts/checks/check-run-control-client.ts",
  "scripts/checks/check-scheduler-sql.sh",
  "scripts/checks/check-screenshot-render-shapes.ts",
  "scripts/checks/check-secret-events.ts",
  "scripts/checks/check-secret-scan.ts",
  "scripts/checks/check-settings-surface.tsx",
  "scripts/checks/check-story-digest.ts",
  "scripts/checks/check-subagent-slice.ts",
  "scripts/checks/check-task-api.ts",
  "scripts/checks/check-thread-mapping.ts",
  "scripts/checks/check-tool-summary.ts",
  "scripts/checks/check-typing-memo.ts",
  "scripts/checks/check-ui-prompt.ts",
  "scripts/checks/check-uploads-payload.ts",
  "scripts/checks/check-working-sql-agreement.ts",
  "scripts/checks/check-working-time.ts",
  "scripts/checks/check-workstream-e2e.sh",
  "scripts/checks/contrast-nav-rail.cjs",
  "scripts/checks/contrast-role-tints.cjs",
  "scripts/checks/frozen-dom.cjs",
  "scripts/checks/preflight-deploy.sh",
];

// ── failure accumulation ────────────────────────────────────────────────────

const FAILURES: string[] = [];

function fail(message: string): void {
  FAILURES.push(message);
}

function refuse(headline: string, detail: string[]): never {
  process.stderr.write(`REFUSING TO CERTIFY: ${headline}\n`);
  for (const line of detail) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

// ── filesystem helpers ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", ".turbo"]);

/** Every file under `rel`, at any depth, dotfiles included. Repo-relative. */
function walk(rel: string): string[] {
  const abs = join(REPO, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const stack: string[] = [rel];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(join(REPO, dir), { withFileTypes: true });
    } catch (err) {
      throw new Error(`cannot read directory ${dir}: ${(err as Error).message}`);
    }
    for (const entry of entries) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return out.sort();
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension: `.broken.ts` has one, `.env`
  // does not. Reporting `.env`'s extension as `env` would be harmless;
  // reporting a file named exactly `.ts` as having none would not.
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}

function trackedFiles(): string[] {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  return raw
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1 — ENUMERATE SUBJECTS BY GLOB, AND SCAN FOR EXTENSIONS WE CANNOT READ
// ═══════════════════════════════════════════════════════════════════════════

const allUnderRoot = walk(SUBJECT_ROOT);
if (allUnderRoot.length === 0) {
  refuse(`zero files under ${SUBJECT_ROOT}/ — a registry over nothing certifies nothing`, [
    `Expected the instrument directory at ${join(REPO, SUBJECT_ROOT)}.`,
    "Restore it from git; do not make this check pass by narrowing SUBJECT_ROOT.",
  ]);
}

const subjectExts = new Set<string>(SUBJECT_EXTENSIONS);
const dataExts = new Set<string>(DATA_EXTENSIONS);

const instrumentSubjects = allUnderRoot.filter((p) => subjectExts.has(extensionOf(p)));

const unhandled = allUnderRoot.filter(
  (p) => !subjectExts.has(extensionOf(p)) && !dataExts.has(extensionOf(p)),
);

const tracked = trackedFiles();
const testSubjects = tracked.filter((p) => /\.test\.tsx?$/.test(p)).sort();

const SUBJECTS = [...instrumentSubjects, ...testSubjects.filter((p) => !instrumentSubjects.includes(p))];

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2 — THE CLOSED RUNNER SET
// ═══════════════════════════════════════════════════════════════════════════

interface PackageRunner {
  readonly pkgPath: string; // repo-relative package.json
  readonly pkgDir: string; // repo-relative directory
  readonly scriptName: string;
  readonly body: string;
}

const missingRunners = SHELL_RUNNERS.filter((r) => !existsSync(join(REPO, r)));
if (missingRunners.length > 0) {
  refuse("a declared runner is not on disk", [
    ...missingRunners.map((r) => `missing: ${r}`),
    "Every check that runner invokes would be reclassified as an orphan by its",
    "absence, and this registry would look like it was still working. Restore the",
    "runner, or — if it was deliberately deleted — remove it from SHELL_RUNNERS in",
    "the same commit and re-triage every subject it used to invoke.",
  ]);
}

const packageRunners: PackageRunner[] = [];
for (const pkgPath of tracked.filter((p) => p === "package.json" || p.endsWith("/package.json"))) {
  if (pkgPath.includes("node_modules/")) continue;
  const text = readFileSync(join(REPO, pkgPath), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    refuse(`${pkgPath} is not valid JSON`, [
      (err as Error).message,
      "This registry reads every package.json's test/guard scripts to decide which",
      "test files are executed. It will not guess past a parse error.",
    ]);
  }
  if (typeof parsed !== "object" || parsed === null) continue;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) continue;
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (!RUNNER_SCRIPT_NAME.test(name)) continue;
    if (typeof body !== "string") {
      refuse(`${pkgPath}: scripts.${name} is not a string`, [
        `found ${typeof body}; a runner body this check cannot read is a coverage hole`,
      ]);
    }
    packageRunners.push({
      pkgPath,
      pkgDir: pkgPath === "package.json" ? "" : pkgPath.slice(0, -"/package.json".length),
      scriptName: name,
      body,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3 — THE SHELL RESOLVER (rules R2-R9 of the header)
// ═══════════════════════════════════════════════════════════════════════════

type TokenKind = "word" | "quoted" | "operator";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const OPERATOR_CHARS = new Set(["|", "&", ";", "(", ")", "{", "}", "\n"]);

/**
 * Tokenise one shell fragment. Quoted runs become a single `quoted` token
 * carrying their inner text, so the caller can recurse into them (R3).
 * `$(` … `)` is emitted as a quoted token too, for the same reason.
 */
function tokenise(fragment: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let word = "";
  const flushWord = (): void => {
    if (word.length > 0) {
      tokens.push({ kind: "word", text: word });
      word = "";
    }
  };
  while (i < fragment.length) {
    const ch = fragment[i];
    if (ch === "\\" && i + 1 < fragment.length) {
      // An escaped character is literal; keep it in the word so `\$(` does not
      // read as a command substitution.
      word += fragment[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let inner = "";
      i += 1;
      while (i < fragment.length && fragment[i] !== quote) {
        if (fragment[i] === "\\" && quote === '"' && i + 1 < fragment.length) {
          inner += fragment[i + 1];
          i += 2;
          continue;
        }
        inner += fragment[i];
        i += 1;
      }
      i += 1; // closing quote (or end of fragment — an unterminated quote is
      //         treated as running to the end rather than throwing: a runner
      //         that does not parse must not silently stop being read)
      flushWord();
      tokens.push({ kind: "quoted", text: inner });
      continue;
    }
    if (ch === "$" && fragment[i + 1] === "(") {
      let depth = 1;
      let inner = "";
      i += 2;
      while (i < fragment.length && depth > 0) {
        if (fragment[i] === "(") depth += 1;
        else if (fragment[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        inner += fragment[i];
        i += 1;
      }
      i += 1;
      flushWord();
      tokens.push({ kind: "quoted", text: inner });
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushWord();
      i += 1;
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) {
      flushWord();
      tokens.push({ kind: "operator", text: ch });
      i += 1;
      continue;
    }
    word += ch;
    i += 1;
  }
  flushWord();
  return tokens;
}

/**
 * Strip quotes, resolve a `$VAR`, drop a leading `$VAR/`/`${VAR}/` and any
 * number of leading `./` and `../` segments, and return the repo-relative
 * candidate forms of a token (R7).
 */
function candidatePaths(raw: string, vars: ReadonlyMap<string, string>): string[] {
  let text = raw.trim();
  if (text.length === 0) return [];

  // A whole-token variable reference: "$GUARD", "${GUARD}".
  const wholeVar = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(text);
  if (wholeVar !== null) {
    const value = vars.get(wholeVar[1]);
    if (value === undefined) return [];
    text = value.trim();
  }

  // A leading variable segment: "$REPO/scripts/checks/guard.sh".
  text = text.replace(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\//, "");

  if (!text.includes("/")) return []; // R8 — a bare name is a label, not a path
  const forms = new Set<string>();
  forms.add(text);
  let stripped = text;
  while (stripped.startsWith("./") || stripped.startsWith("../")) {
    stripped = stripped.startsWith("./") ? stripped.slice(2) : stripped.slice(3);
    forms.add(stripped);
  }
  return [...forms];
}

function programName(token: string): string {
  const base = token.slice(token.lastIndexOf("/") + 1);
  return base;
}

const interpreterSet = new Set<string>(INTERPRETERS);
const wrapperSet = new Set<string>(PROGRAM_WRAPPERS);
const nonExecutingSet = new Set<string>(NON_EXECUTING_TOOLS);

interface Reference {
  readonly subject: string;
  readonly runner: string;
  readonly line: number;
  readonly kind: "executed" | "non-executing";
  readonly via: string;
  readonly snippet: string;
}

const references: Reference[] = [];

function recordReference(ref: Reference): void {
  if (ref.subject === ref.runner) return; // R9
  references.push(ref);
}

const subjectSet = new Set(SUBJECTS);

function resolveSubject(token: Token, vars: ReadonlyMap<string, string>): string | null {
  for (const form of candidatePaths(token.text, vars)) {
    if (subjectSet.has(form)) return form;
  }
  return null;
}

/**
 * Walk one fragment, recursing into quoted tokens, and record every
 * invocation. `runner`/`line`/`snippet` are carried purely for the citation.
 */
function scanFragment(
  fragment: string,
  vars: Map<string, string>,
  runner: string,
  line: number,
  snippet: string,
  depth: number,
): void {
  if (depth > 4) return;
  const tokens = tokenise(fragment);

  // Learn simple assignments as we go (R7). `VAR=value` and `VAR="value"`
  // both arrive as a single word token or a word+quoted pair.
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind !== "word") continue;
    const eq = t.text.indexOf("=");
    if (eq <= 0) continue;
    const name = t.text.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const inlineValue = t.text.slice(eq + 1);
    if (inlineValue.length > 0) {
      vars.set(name, inlineValue);
    } else if (i + 1 < tokens.length && tokens[i + 1].kind === "quoted") {
      vars.set(name, tokens[i + 1].text);
    }
  }

  // Group into commands at operators (R4).
  const groups: Token[][] = [[]];
  for (const t of tokens) {
    if (t.kind === "operator") groups.push([]);
    else groups[groups.length - 1].push(t);
  }

  for (const group of groups) {
    if (group.length === 0) continue;

    // Recurse into every quoted token: this is where the gate bodies live.
    for (const t of group) {
      if (t.kind === "quoted") scanFragment(t.text, vars, runner, line, snippet, depth + 1);
    }

    // Head candidates: index 0, plus an interpreter preceded by a quoted token.
    const heads: number[] = [0];
    for (let i = 1; i < group.length; i += 1) {
      if (
        group[i].kind === "word" &&
        group[i - 1].kind === "quoted" &&
        interpreterSet.has(programName(group[i].text))
      ) {
        heads.push(i);
      }
    }

    for (const headIndex of heads) {
      const head = group[headIndex];
      if (head.kind !== "word") continue;

      // R5(a): the head is itself a subject — `./scripts/checks/x.sh`.
      const direct = resolveSubject(head, vars);
      if (direct !== null) {
        recordReference({
          subject: direct,
          runner,
          line,
          kind: "executed",
          via: "direct execution",
          snippet,
        });
        continue;
      }

      let program = programName(head.text);
      let argStart = headIndex + 1;

      // Unwrap `npx <prog>`, `pnpm exec <prog>`, `pnpm dlx <prog>` (R5).
      if (wrapperSet.has(program)) {
        let j = headIndex + 1;
        while (j < group.length && group[j].kind === "word" && group[j].text.startsWith("-")) j += 1;
        if (j < group.length && group[j].kind === "word" && ["exec", "dlx", "run"].includes(group[j].text)) {
          j += 1;
          while (j < group.length && group[j].kind === "word" && group[j].text.startsWith("-")) j += 1;
        }
        if (j >= group.length || group[j].kind !== "word") continue;
        program = programName(group[j].text);
        argStart = j + 1;
      }

      const executes = interpreterSet.has(program);
      // A head that is neither an interpreter nor a declared reading tool is not
      // a program at all — it is prose, a wrapper function, or an assignment.
      // Recording a reference for it is exactly how a fix-hint string becomes a
      // false invocation (guard.sh:196's "…report: bash <path>").
      if (!executes && !nonExecutingSet.has(program)) continue;

      // R5(b)/R6: first following token that resolves to a subject.
      for (let k = argStart; k < group.length; k += 1) {
        const hit = resolveSubject(group[k], vars);
        if (hit === null) continue;
        recordReference({
          subject: hit,
          runner,
          line,
          kind: executes ? "executed" : "non-executing",
          via: executes ? `${program} <subject>` : `${program} <subject> — compiles/reads, does not execute`,
          snippet,
        });
        break;
      }
    }
  }
}

/** Read a shell runner: strip comment lines (R2), join continuations, scan. */
function scanShellRunner(runner: string): void {
  const lines = readFileSync(join(REPO, runner), "utf8").split("\n");
  const vars = new Map<string, string>();
  let buffer = "";
  let bufferStart = 0;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    if (buffer.length === 0 && /^\s*#/.test(raw)) continue; // R2
    if (buffer.length === 0) bufferStart = idx + 1;
    if (raw.endsWith("\\")) {
      buffer += `${raw.slice(0, -1)} `;
      continue;
    }
    buffer += raw;
    const snippet = buffer.trim().slice(0, 120);
    scanFragment(buffer, vars, runner, bufferStart, snippet, 0);
    buffer = "";
  }
  if (buffer.length > 0) {
    scanFragment(buffer, vars, runner, bufferStart, buffer.trim().slice(0, 120), 0);
  }
}

for (const runner of SHELL_RUNNERS) scanShellRunner(runner);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4 — PACKAGE.JSON RUNNERS: COMMAND POSITION *AND* GLOB EXPANSION
// ═══════════════════════════════════════════════════════════════════════════

/** Glob -> RegExp with real semantics: `*` stays inside a segment, `**` does not. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — consume it and, when it is a whole segment, the following `/`.
        i += 2;
        if (pattern[i] === "/") {
          out += "(?:[^/]+/)*";
          i += 1;
        } else {
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

interface GlobRunner {
  readonly runner: string;
  readonly scriptName: string;
  readonly pattern: string;
}

const globRunners: GlobRunner[] = [];

for (const pkg of packageRunners) {
  const label = `${pkg.pkgPath}:scripts.${pkg.scriptName}`;
  const vars = new Map<string, string>();
  // Command-position scan, exactly as for a shell runner: a package script IS
  // a shell fragment. This is what catches `bash scripts/checks/guard.sh`.
  scanFragment(pkg.body, vars, pkg.pkgPath, 0, `${pkg.scriptName}: ${pkg.body.slice(0, 100)}`, 0);

  // Glob expansion (§4). Any token carrying a `*` is a pattern relative to the
  // package's own directory.
  for (const token of tokenise(pkg.body)) {
    if (token.kind === "operator") continue;
    const text = token.text.trim();
    if (!text.includes("*")) continue;
    if (!/\.tsx?$/.test(text)) continue;
    globRunners.push({ runner: label, scriptName: pkg.scriptName, pattern: text });

    const root = text.slice(0, text.indexOf("*")).replace(/\/[^/]*$/, "");
    const searchRoot = pkg.pkgDir === "" ? root : `${pkg.pkgDir}/${root}`;
    const re = globToRegExp(text);
    for (const file of walk(searchRoot)) {
      const relToPkg = pkg.pkgDir === "" ? file : file.slice(pkg.pkgDir.length + 1);
      if (!re.test(relToPkg)) continue;
      if (!subjectSet.has(file)) continue;
      recordReference({
        subject: file,
        runner: label,
        line: 0,
        kind: "executed",
        via: `glob '${text}' expands to it`,
        snippet: pkg.body.slice(0, 100),
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5 — READ THE LEDGER
// ═══════════════════════════════════════════════════════════════════════════

interface LedgerEntry {
  readonly path: string;
  readonly bucket: string;
  readonly reason: string;
  readonly owner: string;
  readonly lineNo: number;
  readonly valid: boolean;
}

if (!existsSync(join(REPO, LEDGER_PATH))) {
  refuse(`no execution ledger at ${LEDGER_PATH}`, [
    "The file is checked in and is expected to exist even when it is EMPTY.",
    "Its absence is not 'no exclusions': it is the first step towards the next",
    "exclusion being an --exclude flag nobody prints. Restore it from git.",
  ]);
}

const ledgerEntries: LedgerEntry[] = [];
const ledgerErrors: string[] = [];

{
  const lines = readFileSync(join(REPO, LEDGER_PATH), "utf8").split("\n");
  let pendPath = "";
  let pendBucket = "";
  let pendReason = "";
  let pendOwner = "";
  let pendStart = 0;
  let pendAny = false;

  const flushDangling = (): void => {
    if (pendAny) {
      ledgerErrors.push(
        `at line ${pendStart}: a field block with NO bare path after it. Fields present: ` +
          `${pendPath !== "" ? "path " : ""}${pendBucket !== "" ? "bucket " : ""}` +
          `${pendReason !== "" ? "reason " : ""}${pendOwner !== "" ? "owner " : ""}` +
          `— an entry is four field lines AND the bare path. A justification that ` +
          `excuses nothing is a note, and notes belong in prose.`,
      );
    }
    pendPath = "";
    pendBucket = "";
    pendReason = "";
    pendOwner = "";
    pendStart = 0;
    pendAny = false;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const line = lines[idx];

    if (line.trim() === "") {
      flushDangling();
      continue;
    }

    // A FIELD LINE: `# ` then the field name IMMEDIATELY — one space, no more.
    // That is why the header's example is indented by four extra spaces.
    const field = /^# (path|bucket|reason|owner)[ \t]*:(.*)$/.exec(line);
    if (field !== null) {
      if (!pendAny) pendStart = lineNo;
      pendAny = true;
      const value = field[2].trim();
      if (field[1] === "path") pendPath = value;
      else if (field[1] === "bucket") pendBucket = value;
      else if (field[1] === "reason") pendReason = value;
      else pendOwner = value;
      continue;
    }

    if (line.startsWith("#")) {
      flushDangling();
      continue;
    }

    // A BARE PATH.
    const entry = line.trim();
    const missing: string[] = [];
    if (pendPath === "") missing.push("path");
    if (pendBucket === "") missing.push("bucket");
    if (pendReason === "") missing.push("reason");
    if (pendOwner === "") missing.push("owner");

    let valid = true;
    if (missing.length > 0) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the entry '${entry}' is missing required field(s): ${missing.join(", ")}. ` +
          `All four of path/bucket/reason/owner are required, and an entry without them ` +
          `excuses NOTHING — this run still counts its subject as executed by nothing.`,
      );
    } else if (pendPath !== entry) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the entry's \`path\` field says '${pendPath}' but the bare path ` +
          `says '${entry}'. The two must agree; this registry matches on the bare path and ` +
          `will not guess which one was meant.`,
      );
    } else if (!(LEDGER_BUCKETS as readonly string[]).includes(pendBucket)) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the entry '${entry}' has bucket '${pendBucket}', which is not one of ` +
          `${LEDGER_BUCKETS.join(" | ")}. A LIVE-ORPHAN — a check whose subject still ships and ` +
          `which nothing runs — CANNOT be ledgered: that is a conversation with Konrad, not a ` +
          `line in a file. If it is genuinely still open, it belongs in KNOWN_OPEN_FINDINGS in ` +
          `scripts/checks/check-instrument-execution.ts, where it is printed as debt rather than ` +
          `excused as a waiver.`,
      );
    }

    const dup = ledgerEntries.find((e) => e.path === entry);
    if (dup !== undefined) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the path '${entry}' is ALREADY LEDGERED at line ${dup.lineNo}. ` +
          `One subject, one entry: a second entry for the same path excuses a failure it does ` +
          `not own. Delete one of the two (lines ${dup.lineNo} and ${lineNo}).`,
      );
    }

    if (!existsSync(join(REPO, entry))) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the ledgered path '${entry}' is NOT ON DISK. An exclusion for a ` +
          `file that is gone is stale by definition — delete the entry.`,
      );
    } else if (!subjectSet.has(entry)) {
      valid = false;
      ledgerErrors.push(
        `at line ${lineNo}: the ledgered path '${entry}' is not among the ${SUBJECTS.length} ` +
          `subject(s) this registry enumerates. An entry must name something this registry ` +
          `actually reads, or it excuses nothing and hides the fact that it does.`,
      );
    }

    ledgerEntries.push({
      path: entry,
      bucket: pendBucket,
      reason: pendReason,
      owner: pendOwner,
      lineNo,
      valid,
    });

    pendPath = "";
    pendBucket = "";
    pendReason = "";
    pendOwner = "";
    pendStart = 0;
    pendAny = false;
  }
  flushDangling();
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 6 — RECONCILE
// ═══════════════════════════════════════════════════════════════════════════

const executedBy = new Map<string, Reference[]>();
const nonExecutingBy = new Map<string, Reference[]>();
for (const ref of references) {
  const target = ref.kind === "executed" ? executedBy : nonExecutingBy;
  const list = target.get(ref.subject);
  if (list === undefined) target.set(ref.subject, [ref]);
  else list.push(ref);
}

const ledgeredValid = new Set(ledgerEntries.filter((e) => e.valid).map((e) => e.path));
const knownOpen = new Set(KNOWN_OPEN_FINDINGS);

const invoked = SUBJECTS.filter((s) => executedBy.has(s));
const orphans = SUBJECTS.filter((s) => !executedBy.has(s));

// ═══════════════════════════════════════════════════════════════════════════
// STEP 7 — PRINT. EVERY EXCLUSION, EVERY RUN, ABOVE THE VERDICT.
// ═══════════════════════════════════════════════════════════════════════════

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

out("");
out("================================================================================");
out(" EXECUTION REGISTRY — which instruments in this repo are executed by anything");
out("================================================================================");
out("");
out(`repo:      ${REPO}`);
out(`subjects:  ${SUBJECTS.length}  (${instrumentSubjects.length} under ${SUBJECT_ROOT}/ ` +
  `matching *.{${SUBJECT_EXTENSIONS.join(",")}}, ${testSubjects.length} tracked *.test.ts(x))`);
out(`runners:   ${SHELL_RUNNERS.length} shell + ${packageRunners.length} package.json script(s)`);
for (const r of SHELL_RUNNERS) out(`             ${r}`);
for (const r of packageRunners) out(`             ${r.pkgPath}:scripts.${r.scriptName}`);
for (const g of globRunners) out(`             glob '${g.pattern}' from ${g.runner}`);
out("");

// ── coverage scan ───────────────────────────────────────────────────────────
out(`COVERAGE — every file under ${SUBJECT_ROOT}/ is a subject or a declared data file`);
out(`  scanned: ${allUnderRoot.length} file(s); subjects: ${instrumentSubjects.length}; ` +
  `data (*.{${DATA_EXTENSIONS.join(",")}}): ${allUnderRoot.length - instrumentSubjects.length - unhandled.length}`);
if (unhandled.length === 0) {
  out("  ok: 0 unhandled — no extension under this root is unaccounted for");
} else {
  for (const p of unhandled) {
    out(`  FAIL ${p} — extension '${extensionOf(p) || "(none)"}' is neither a subject extension ` +
      `(${SUBJECT_EXTENSIONS.join(",")}) nor a declared data extension (${DATA_EXTENSIONS.join(",")})`);
    fail(
      `${p}: unhandled extension '${extensionOf(p) || "(none)"}' under ${SUBJECT_ROOT}/. ` +
        `Add it to SUBJECT_EXTENSIONS (and teach the resolver how it is invoked) or to ` +
        `DATA_EXTENSIONS if it is not an executable artefact. A file this registry declines ` +
        `to read cannot also be certified by it.`,
    );
  }
}
out("");

// ── the ledger, printed in full, always ─────────────────────────────────────
out(`LEDGER — ${LEDGER_PATH}, every entry printed on every run`);
if (ledgerEntries.length === 0) {
  out("  ok: 0 entries — the ledger is empty");
} else {
  for (const e of ledgerEntries) {
    out(`  EXCUSED ${e.path}`);
    out(`      bucket : ${e.bucket}`);
    out(`      reason : ${e.reason}`);
    out(`      owner  : ${e.owner}`);
    out(`      ledger : line ${e.lineNo}${e.valid ? "" : "  *** INVALID, see LEDGER ERRORS ***"}`);
    if (executedBy.has(e.path)) {
      const cite = (executedBy.get(e.path) as Reference[])[0];
      out(`      FAIL ledgered but INVOKED — ${cite.runner}:${cite.line} (${cite.via})`);
      fail(
        `${e.path}: ledgered at ${LEDGER_PATH}:${e.lineNo} as ${e.bucket}, but it IS invoked by ` +
          `${cite.runner}:${cite.line}. A stale exclusion is how a ledger outlives its reason — ` +
          `the next reader believes this artefact is dead. Delete the entry.`,
      );
    }
  }
}
if (ledgerErrors.length > 0) {
  out("");
  out("  LEDGER ERRORS");
  for (const msg of ledgerErrors) {
    out(`    FAIL ${msg}`);
    fail(`${LEDGER_PATH} ${msg}`);
  }
}
out("");

// ── the open-findings inventory, printed in full, always ────────────────────
out("OPEN FINDINGS — LIVE-ORPHANS: the check exists, its subject still ships, nothing runs it.");
out("  These are NOT excused. They are declared debt, printed by name so the list can be");
out("  watched shrinking. A new orphan is not in this list and FAILS the run.");
if (KNOWN_OPEN_FINDINGS.length !== KNOWN_OPEN_FINDING_COUNT) {
  const msg =
    `KNOWN_OPEN_FINDING_COUNT is ${KNOWN_OPEN_FINDING_COUNT} but KNOWN_OPEN_FINDINGS holds ` +
    `${KNOWN_OPEN_FINDINGS.length} path(s). The count is declared separately on purpose: ` +
    `editing one without the other is an error, not a rounding difference.`;
  out(`  FAIL ${msg}`);
  fail(msg);
}
out(`  declared: ${KNOWN_OPEN_FINDINGS.length}`);
for (const p of KNOWN_OPEN_FINDINGS) {
  const nonExec = nonExecutingBy.get(p);
  const note =
    nonExec !== undefined
      ? `  [read but not run by ${nonExec.map((r) => `${r.runner}:${r.line} (${r.via})`).join("; ")}]`
      : "";
  out(`  OPEN ${p}${note}`);
  if (executedBy.has(p)) {
    const cite = (executedBy.get(p) as Reference[])[0];
    const msg =
      `${p} is declared an OPEN FINDING but IS invoked by ${cite.runner}:${cite.line} ` +
      `(${cite.via}). The inventory only shrinks: delete this line from KNOWN_OPEN_FINDINGS ` +
      `and decrement KNOWN_OPEN_FINDING_COUNT.`;
    out(`  FAIL ${msg}`);
    fail(msg);
  }
  if (!existsSync(join(REPO, p))) {
    const msg = `${p} is declared an OPEN FINDING but is NOT ON DISK. Delete the line.`;
    out(`  FAIL ${msg}`);
    fail(msg);
  } else if (!subjectSet.has(p)) {
    const msg =
      `${p} is declared an OPEN FINDING but is not among this registry's ${SUBJECTS.length} ` +
      `subjects. An inventory entry must name something this registry reads.`;
    out(`  FAIL ${msg}`);
    fail(msg);
  }
  if (ledgeredValid.has(p)) {
    const msg =
      `${p} is BOTH ledgered and declared an OPEN FINDING. A LIVE-ORPHAN may not be ledgered; ` +
      `pick one, and if it is genuinely spent, say so in the ledger and remove it from the inventory.`;
    out(`  FAIL ${msg}`);
    fail(msg);
  }
}
out("");

// ── the census ──────────────────────────────────────────────────────────────
const unclassified = orphans.filter((s) => !ledgeredValid.has(s) && !knownOpen.has(s));

out("EXECUTED BY SOMETHING");
out(`  ${invoked.length} of ${SUBJECTS.length} subject(s)`);
for (const s of invoked) {
  const cite = (executedBy.get(s) as Reference[])[0];
  out(`  ok  ${s}  <- ${cite.runner}${cite.line > 0 ? `:${cite.line}` : ""} (${cite.via})`);
}
out("");

if (nonExecutingBy.size > 0) {
  out("REFERENCED BUT NOT EXECUTED — compiled or read by a runner, never run");
  out("  Compiling is not running. These count as coverage for NOTHING; they appear here so a");
  out("  reader cannot mistake a typecheck citation in a gate list for an executed gate.");
  for (const [s, refs] of [...nonExecutingBy.entries()].sort()) {
    out(`  ${executedBy.has(s) ? "also-run" : "NOT-RUN "} ${s}`);
    for (const r of refs) out(`             <- ${r.runner}:${r.line} (${r.via})`);
  }
  out("");
}

out("EXECUTED BY NOTHING");
out(`  ${orphans.length} of ${SUBJECTS.length} subject(s): ` +
  `${ledgeredValid.size} ledger-excused, ${KNOWN_OPEN_FINDINGS.length} declared open finding(s), ` +
  `${unclassified.length} unaccounted for`);
for (const s of unclassified) {
  out(`  FAIL ${s} — executed by nothing, and neither ledgered nor a declared open finding`);
  fail(
    `${s}: this artefact is executed by nothing. Wire it into a runner, or ledger it in ` +
      `${LEDGER_PATH} with a bucket (SPENT | NOT-A-CHECK | PROCEDURE-INVOKED), a reason and an ` +
      `owner. If it is a live gate nobody runs, that is an OPEN FINDING, not a waiver: add it to ` +
      `KNOWN_OPEN_FINDINGS and talk to Konrad.`,
  );
}
out("");

// ── verdict ─────────────────────────────────────────────────────────────────
out("================================================================================");
if (FAILURES.length === 0) {
  out(
    `PASSED — ${invoked.length} executed, ${ledgeredValid.size} ledger-excused, ` +
      `${KNOWN_OPEN_FINDINGS.length} open finding(s) declared, 0 unaccounted for.`,
  );
  out("  Every subject under this registry is accounted for. The open findings above are");
  out("  debt, not coverage: this run is green because they are DECLARED, not because they");
  out("  are fixed.");
  out("================================================================================");
  process.exit(0);
}
out(`FAILED — ${FAILURES.length} problem(s)`);
out("================================================================================");
for (const f of FAILURES) out(`  * ${f}`);
process.exit(1);
