#!/usr/bin/env bash
#
# check-instrument-typecheck.sh — UNIVERSAL GATE ITEM 9 (`03-quality.md` §3.1).
# Compiles EVERY instrument under `scripts/checks/`, one file per invocation,
# through the checked-in profile `tsconfig.checks-instruments.json`.
#
# ---------------------------------------------------------------------------
# WHY. `scripts/checks/*.ts` is compiled by NOTHING. `tsx` strips types without
# checking them, and the directory sits outside both projects' tsconfig
# `include` lists (`forge-control/tsconfig.json` reads `"include":
# ["src/**/*.ts"]`). Item 1 of §3.1 — the only typecheck any phase runs — never
# examines a single check script. So the code the fleet uses to VERIFY itself is
# the least-verified code in the repo, and that has now been found three times:
# phase 7's `measure-schedule.ts` (§3.2 "Added round 212"), phase 6's
# `forge-control-web/` half ("Added round 223"), and phase 6B's whole-directory
# measurement. Found three times, fixed zero. This is the fix.
#
# ---------------------------------------------------------------------------
# WHAT CHANGED AT ROUND 200, AND WHY (project `scripts-checks-typecheck-gate`,
# `02-architecture.md` §4.4 and §4.5).
#
# The round-800 gate read an INCLUSION LIST — `scripts/checks/instrument-
# manifest.txt` — and compiled the seven paths named in it, with a "manifest
# guard" that failed the run when a `scripts/checks/*.ts` file the branch had
# touched was absent from the list. Both are GONE:
#
#   * ENUMERATION IS NOW A GLOB over the whole directory (R8, R9). A derived
#     list cannot go stale, so it cannot silently omit a file. Coverage is of
#     the DIRECTORY, not of the diff: all four repetitions of this hole were
#     found by someone compiling a file nobody had touched in months, and a
#     diff-scoped gate would not have found any of them.
#   * THE MANIFEST IS NOT READ BY THIS SCRIPT AT ALL, and the manifest guard
#     (`git diff --diff-filter=ACMR main..HEAD`) is deleted. The guard was a
#     good answer to the wrong question — "did the author remember to add their
#     file to the list" is a question that exists only because there is a list.
#     With glob enumeration there is nothing to forget: a new instrument is
#     covered the moment it is written, including by someone who never read the
#     plan.
#   * COMPILATION GOES THROUGH THE PROFILE (`tsconfig.checks-instruments.json`)
#     via a generated per-file config, not through a hand-rolled flag list. The
#     old flag list was an approximation of the app's tsconfig that drifted from
#     it silently — which is why 13 files were red for `--lib`/`--jsx` alone.
#
# STANDING RULE 2 IS SATISFIED BY PHASE 5, NOT HERE: the manifest's header, its
# repurposing into a waiver ledger, `03-quality.md` §3.1 item 9 and
# `phase8-tooling.md` §5.1 are amended by phase 5 in ONE commit — the documents
# were not forgotten, they are owned by a round that also owns this file.
#
# ---------------------------------------------------------------------------
# WHAT CHANGED AT ROUND 2, FIX CYCLE 1 — the red team got in six times
# (`evidence/phase2-redteam.md`). Every one of those six, and the three
# findings beside them, was a hole in WHAT THE GLOB AND THE PROFILE WERE
# POINTED AT, not in the shell craft. In the order of the reviewer's verdict:
#
#   1. B1 — `*.ts` MATCHES `*.d.ts`, and the inherited `skipLibCheck: true`
#      means "do not typecheck declaration files". A `.d.ts` carrying TS2717
#      was enumerated, counted as COMPILED, and never read: `PASSED — 37/37`.
#      Closed in the PROFILE (`"skipLibCheck": false`, with the measurement in
#      its own comment) and asserted here every run by canary 2 below, because
#      a profile edit that silently undoes it must not be silently survivable.
#   2. B4 — `@ts-nocheck` turns any instrument green in one line, and neither
#      R28 nor the P-A grep named it. R28 and P-A now do; and since this gate
#      is the only thing that reads every subject every run, THE GATE now
#      refuses a subject carrying a suppression directive (step 10b). P-A is
#      diff-scoped by construction and cannot see a suppression already on
#      `main`; this scan is directory-scoped and can (finding F2).
#   3. B2 — a file in `scripts/checks/<subdir>/` was uncompiled AND unnamed;
#      the UNCOVERED block printed `none`. Subject enumeration now RECURSES.
#   4. B3 — `nullglob` without `dotglob`: `.broken.ts`, and a file named
#      exactly `.ts`, were skipped in silence. `dotglob` is now set.
#   5. F1 — the enumeration-failure guard was structurally dead: a `for` over
#      an empty glob returns 0, so the subshell exited 0 with every `printf`
#      failing, and a full disk silently truncated the subject list 31 -> 24.
#      There is now NO WRITE TO FAIL: enumeration happens in this shell, into
#      an array. What remains is checked against a SECOND, INDEPENDENT count
#      taken with `find` — a different tool walking the same tree (step 5b).
#   6. F7 — R10's "either cover it or name it" permitted `PASSED` + exit 0
#      with a type-broken `.cts` on disk, which is the exact sentence brief A2
#      calls a breach. R10 is amended; an uncovered TypeScript-family file is
#      now a FAILURE that is also named. Naming was the right message; exit 0
#      was the wrong verdict.
#   7. B5 — `tsc` was pinned absolutely, but its pnpm shim ends in `exec node`,
#      resolved from PATH. A fake `node` made every subject PASS while the
#      gate's own provenance printed `node : ` EMPTY and went green anyway.
#      Both versions are now RESOLVED, ASSERTED WELL-FORMED, and — the part
#      that cannot be faked by an empty binary — the compiler must produce
#      three exact diagnostics on demand before any verdict is issued.
#   8. B6 — the profile was checked for EXISTENCE only. Redirecting `extends`
#      to an empty base yielded a clean `PASSED` over a strict-null error and
#      took `noEmit` with it, writing eight `.js` files into the tree. The
#      profile's IDENTITY is now asserted BEHAVIOURALLY by the three canaries
#      and the emit check of step 9b: a sha256 pin was rejected because it
#      makes every legitimate profile edit a two-file change and asserts a
#      number rather than a property (see step 9b).
#   9. F3/F4 — a filename containing a newline or a backslash produced a
#      spurious fidelity violation and printed the "THE PROFILE IS WRONG, NOT
#      THE APP" essay about a FILENAME. Failed closed, but sent the maintainer
#      to edit the wrong file. Step 12 now folds the subject's own name before
#      parsing and says so when a name is the cause.
#
# ---------------------------------------------------------------------------
# WHAT CHANGED AT ROUND 3 — the re-review of fix cycle 1 got in once more and
# named three further defects, and the round-2 gate review's finding 8 was
# still open (`evidence/phase2-fixcycle1-round3.md`).
#
#   1. THE SUPPRESSION SCAN WAS AN APPROXIMATION OF tsc's OWN REGEXES, AND THE
#      APPROXIMATION LEAKED. `SUPPRESSION_RE` required `//` or `/*` followed by
#      whitespace, so `/** @ts-ignore */` — the JSDoc form — matched nothing.
#      Measured on this tree, tsc 5.7.2: ELEVEN comment shapes suppress a
#      diagnostic and the grep saw seven of them. A planted subject carrying
#      `/** @ts-ignore */` compiled clean, the census said `suppressions 0`, the
#      SUPPRESSIONS block printed its all-clear, and the run said `PASSED`,
#      exit 0 — the breach sentence, produced by the control written to close
#      B4. The grep also fired on the LITERAL TEXT anywhere in a file, so an
#      instrument that legitimately greps app source for `@ts-ignore` was
#      failed by its own search term. BOTH directions are now closed the only
#      way an approximation cannot be: THE COMPILER'S OWN PARSER decides.
#      `ts.createSourceFile` is asked for `commentDirectives` (what tsc honours
#      as `@ts-ignore`/`@ts-expect-error`, in comment position only) and
#      `checkJsDirective` (`@ts-nocheck`). Step 9b's fourth canary makes that
#      parser prove itself on all five shapes plus a string-literal decoy
#      before any subject is scanned, because a scanner that silently returns
#      nothing is exactly the failure this replaced.
#   2. THE SECOND OPINION DOUBLE-COUNTED OVERLAPPING ROOTS, which wedged the
#      documented extension path into a permanent refusal: adding
#      `scripts/*.ts` to SUBJECT_GLOBS — the fifteen-line change §7 promises —
#      made `find` walk `scripts/checks` twice (44 vs 86) and no subject
#      compiled. Roots and name patterns were deduplicated INDEPENDENTLY and
#      then multiplied together. The second opinion is now a SET of resolved
#      paths, one `find` per glob with the glob's own root, name and depth, and
#      it is the resolved PATHS that are deduplicated.
#   3. A SYMLINKED SUBDIRECTORY TOOK THE WHOLE GATE OFFLINE, and the refusal —
#      "one of them is wrong and this gate does not know which" — told the
#      operator nothing. bash's `**` matches a symlinked directory as one path
#      component and resolves through it; `find` without `-L` never enters it,
#      so a benign tree shape produced 46 vs 45 and zero subjects compiled,
#      a regression against round 200. `find -L` now matches bash at that
#      depth, and — because the two still part company DEEPER inside a symlink
#      (bash's `**` will not recurse through one, `-L` will) — a disagreement
#      is now reported as a NAMED SET DIFFERENCE with the symlinked ancestor
#      identified, not as two integers.
#   4. FIDELITY INLINED `scripts/checks/`, so §7's "a successor edits the two
#      named variables and nothing else" was false: a successor extending
#      SUBJECT_GLOBS to `scripts/*.ts` would have had every diagnostic in the
#      new root reported as a profile violation. The accepted prefixes are now
#      DERIVED from SUBJECT_GLOBS, and so is COVERAGE_GLOBS — which had the
#      same defect one level down, its roots being hardcoded while its job is
#      to be the safety net UNDER the subject globs. `TS_EXTENSIONS` replaces
#      it as the thing a successor may need to widen, and only when a new
#      TypeScript extension is invented.
#
# ---------------------------------------------------------------------------
# EXTENDING COVERAGE — READ THIS BEFORE EDITING ANYTHING ELSE.
# `02-architecture.md` §7 names three directories carrying the identical hole
# and out of scope here: `scripts/*.ts`, `forge-control/scripts/*.ts`,
# `forge-control-mcp/scripts/*.ts`. The successor project extends this gate by
# editing the TWO NAMED VARIABLES below — `SUBJECT_GLOBS` and `PROFILE` — and
# nothing else. They are deliberately not inlined at their point of use. Those
# directories are node-side and will most likely want a second profile
# extending `forge-control/tsconfig.json`, which turns `PROFILE` into a mapping
# from path prefix to profile; that is the fifteen-line change §7 describes.
#
# THAT CONTRACT IS NOW TRUE, WHICH IT WAS NOT AT ROUND 2. Three things were
# derived from `scripts/checks/` by hand and would each have had to be edited
# as well — silently, since none of them fails loudly when forgotten:
#
#   * the coverage globs (the safety net that names what the subject globs
#     miss) carried their own hardcoded ROOTS, so a new subject root would have
#     had no safety net under it at all;
#   * the fidelity check compared every diagnostic's path against the literal
#     prefix `scripts/checks/`, so every diagnostic in a new root would have
#     been reported as "the profile is wrong";
#   * the second opinion's `find` derived one root list and one name list and
#     multiplied them, so two roots where one contains the other double-counted
#     and refused (round-3 re-review, blocker 2).
#
# All three are now computed from `SUBJECT_GLOBS` by `decompose_glob` below.
# `TS_EXTENSIONS` is the one remaining list, and it is not a knob for reaching
# new directories: it is the set of extensions TypeScript HAS. It exists so
# that a file the subject globs do not match — a `.mts` arriving next year — is
# named AND fails rather than passing unread (R10).
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) A GREEN RUN OVER AN EMPTY SUBJECT LIST. A glob that matches nothing, a
#       moved directory, an enumeration whose error was swallowed. Guarded four
#       ways: enumeration performs no I/O that could partially fail (step 5);
#       its result is reconciled against an independent `find` count (5b); zero
#       subjects is a refusal, not a pass ("a gate over nothing certifies
#       nothing", R13); and the closing census compares subjects FOUND against
#       subjects COMPILED in both directions.
#   (b) A SUBJECT PRESENT ON DISK BUT NEVER COMPILED — now STRUCTURAL rather
#       than a per-entry existence test. The loop cannot skip: a subject that
#       vanishes between enumeration and compilation is recorded MISSING, by
#       name, does NOT increment the compiled counter, and therefore also trips
#       the census (R19). There is no branch in which a subject is passed over
#       quietly. A subject that is OPENED BUT NOT CHECKED — the `.d.ts` shape
#       of breach B1 — is a different animal and is closed in the profile.
#   (c) A NEW INSTRUMENT THAT NEVER JOINED THE LIST — SUPERSEDED. There is no
#       list. `scripts/checks/check-whatever.ts` is compiled the moment it
#       exists, by construction, at any depth, dotfile or not. This is the
#       failure mode the round-800 gate needed its manifest guard to catch and
#       this one catches structurally.
#   (d) `tsc: not found`, disclosed and ignored. A gate whose first response is
#       an error is a gate reviewers learn to skip (the precedent is §3.2's
#       phase-6 precondition block). Guarded by refusing, non-zero, with the
#       exact install line printed — and that line carries `--prod=false`,
#       because under this environment's exported `NODE_ENV=production` a plain
#       `pnpm install --frozen-lockfile` says "skipping devDependencies"
#       quietly, EXITS 0, and REMOVES the compiler. A refusal that printed the
#       plain line would teach the trap instead of the fix (R17, R18, C3).
#   (e) A PASS THAT WAS NEVER OBSERVED FAILING. Guarded INSIDE this file since
#       round 2 by the three canaries of step 9b — every run watches the
#       compiler fail twice and succeed once before it is allowed to certify
#       anything — and outside it by the four negative controls of phase 4
#       (`evidence/negative-controls.md`).
#   (f) THE PROFILE IS WRONG AND THE GATE BLAMES THE APP (new at round 200,
#       `02-architecture.md` §4.1 step 12, success criterion S5). If a
#       diagnostic's path does not start with `scripts/checks/`, this run FAILS
#       and says the profile is wrong, not the app. `forge-control-web/app` is
#       green under its own `pnpm typecheck`; a gate that disagrees with the
#       app's own compiler about the app's own files is the thing that is
#       broken. A diagnostic carrying no parseable path at all — a config-level
#       error such as TS5083 or TS6053, which is what a corrupt generated
#       config produces — is a failure too, never silently ignored.
#   (g) A STALE WAIVER — a file excused from the gate whose excuse has expired.
#       NOT IMPLEMENTED HERE. The waiver ledger (R14/R15) is phase 5's, and the
#       two hooks below mark exactly where its two steps belong. Until phase 5
#       lands there are no waivers, so nothing can be waived wrongly; the gate
#       compiles every subject it finds and excuses none.
#   (h) A SUBJECT THAT COMPILES BECAUSE IT ASKED NOT TO BE COMPILED — one
#       `// @ts-nocheck` line. Refused by step 10b, on every subject, every
#       run, whether or not this branch introduced it.
#
# Usage:  bash scripts/checks/check-instrument-typecheck.sh
# Exit:   0 = every subject found on disk compiled clean, with zero profile
#             fidelity violations, zero uncovered TypeScript-family files, zero
#             suppression directives, zero missing subjects and a reconciled
#             census. Any other outcome is non-zero and says which counter.
#
# `-E` (errtrace) is new at round 2 and is not decoration: an ERR trap is NOT
# inherited by shell functions, command substitutions or subshells without it.
# Round 200 had no functions, so it never noticed; round 2 moved enumeration and
# compilation into functions, and the first version of that change aborted with
# an EMPTY transcript and exit 1 — the trap's whole job, undone by scoping.
# A gate that dies silently is indistinguishable from a gate that found nothing.
set -euEo pipefail
trap 'rc=$?; printf "check-instrument-typecheck.sh: ABORTED at line %s (exit %s) — this run is NOT a pass.\n" "$LINENO" "$rc" >&2' ERR

# LC_ALL is pinned for the WHOLE run, not per subshell as it was at round 200.
# It fixes glob collation and `sort` collation so that the subject order does
# not depend on the reviewer's locale (NF2/S10, `diff` of two transcripts is
# the test), and it pins the compiler's message locale for the same reason.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# ═══════════════════════════════════════════════════════════════════════════
# THE TWO VARIABLES A SUCCESSOR PROJECT EDITS (02-architecture.md §7).
# Do not inline either of these at its point of use.
# ═══════════════════════════════════════════════════════════════════════════
SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" )   # repo-relative
PROFILE="$REPO_ROOT/tsconfig.checks-instruments.json"
# ═══════════════════════════════════════════════════════════════════════════

# EVERY TypeScript extension that can exist under the subject roots, compiled
# or not. R10: a future instrument arriving as .mts or .cts must be NAMED, and
# — amended at round 2 after red-team finding F7 — must FAIL the run, because
# "named but exit 0" is the exact sentence brief A2 defines as a breach. The
# coverage globs are built from these extensions crossed with the SUBJECT_GLOBS
# ROOTS (step 7), and the uncovered set is a set difference against the
# enumerated subjects — so widening SUBJECT_GLOBS, in extension or in root,
# shrinks the uncovered set automatically rather than double-reporting.
TS_EXTENSIONS=( ts tsx mts cts )

WEB="$REPO_ROOT/forge-control-web"
TSC="$WEB/node_modules/.bin/tsc"
# The compiler's own parser, used by the suppression scan of step 10b. It is
# the same installation `$TSC` runs out of, so the scan and the compile cannot
# disagree about what a directive is.
TS_LIB="$WEB/node_modules/typescript"

# ---------------------------------------------------------------------------
# GLOB DECOMPOSITION — the one place that reads the shape of a subject glob.
# Everything derived from SUBJECT_GLOBS goes through here: the coverage globs,
# the fidelity prefixes and the `find` second opinion. A successor editing
# SUBJECT_GLOBS therefore moves all three at once, which is what §7 promises
# and what round 3 found to be false (three hand-derived copies of
# `scripts/checks/`, none of which fails loudly when forgotten).
#
# TWO SHAPES ARE SUPPORTED, and anything else is REFUSED rather than guessed:
#
#     <root>/**/<name>   recursive   e.g. scripts/checks/**/*.ts
#     <root>/<name>      depth 1     e.g. scripts/*.ts
#
# `<root>` must be literal — a glob metacharacter in the root would make the
# root itself a pattern, and `find`'s starting point cannot be a pattern, so
# the second opinion would silently stop corroborating the thing it is there to
# corroborate. `<name>` must not contain `/`: a middle segment like
# `scripts/*/checks/*.ts` expands in bash but has no faithful `find` equivalent
# in one expression, and a second opinion that is not faithful is worse than
# none. Refusing is not a limitation to work around — it is the guard that
# keeps the derivation honest, and the message says which shape to use.
# ---------------------------------------------------------------------------
GLOB_ROOT=""
GLOB_NAME=""
GLOB_RECURSIVE=0
decompose_glob() {  # $1 = repo-relative glob -> GLOB_ROOT, GLOB_NAME, GLOB_RECURSIVE
  local g="$1" middle
  GLOB_ROOT=""; GLOB_NAME=""; GLOB_RECURSIVE=0

  GLOB_NAME="${g##*/}"
  if [ "$GLOB_NAME" = "$g" ]; then
    echo "REFUSING TO RUN: the glob '$g' has no directory part." >&2
    echo "  Supported: <root>/**/<name> (any depth) or <root>/<name> (depth 1)." >&2
    exit 1
  fi
  middle="${g%/*}"                       # everything before the basename
  if [ "${middle##*/}" = "**" ]; then
    GLOB_RECURSIVE=1
    GLOB_ROOT="${middle%/*}"
    if [ "$GLOB_ROOT" = "$middle" ]; then GLOB_ROOT="."; fi
  else
    GLOB_ROOT="$middle"
  fi

  case "$GLOB_ROOT" in
    *[*?[]*|"")
      echo "REFUSING TO RUN: the glob '$g' has a pattern in its ROOT ('$GLOB_ROOT')." >&2
      echo "  \`find\` cannot start from a pattern, so the independent second opinion" >&2
      echo "  of step 5b could not corroborate this enumeration — and an enumeration" >&2
      echo "  nothing corroborates is what red-team finding F1 was about." >&2
      echo "  Supported: <root>/**/<name> (any depth) or <root>/<name> (depth 1)." >&2
      exit 1
      ;;
  esac
  return 0
}

# The roots of the subject globs, deduplicated, each with its trailing slash.
# A diagnostic located under one of these is the EXPECTED shape (step 12); a
# diagnostic anywhere else means the profile is reaching into the app.
ACCEPTED_PREFIXES=()
SUBJECT_ROOTS=()
for _g in "${SUBJECT_GLOBS[@]}"; do
  decompose_glob "$_g"
  _seen=0
  for _r in ${SUBJECT_ROOTS[@]+"${SUBJECT_ROOTS[@]}"}; do
    if [ "$_r" = "$GLOB_ROOT" ]; then _seen=1; fi
  done
  if [ "$_seen" -eq 0 ]; then
    SUBJECT_ROOTS+=( "$GLOB_ROOT" )
    ACCEPTED_PREFIXES+=( "$GLOB_ROOT/" )
  fi
done
unset _g _r _seen

# The safety net (R10), built from the subject roots crossed with every
# TypeScript extension there is. Recursive regardless of the subject globs'
# depth: a file two directories down is exactly the file R10 exists to name.
COVERAGE_GLOBS=()
for _root in "${SUBJECT_ROOTS[@]}"; do
  for _ext in "${TS_EXTENSIONS[@]}"; do
    COVERAGE_GLOBS+=( "$_root/**/*.$_ext" )
  done
done
unset _root _ext

# A located diagnostic, in `--pretty false` shape:
#   scripts/checks/check-orientation.ts(129,38): error TS2322: …
# `.+` is greedy so a path containing parentheses resolves to the LAST
# `(line,col):` on the line, which is the one tsc emitted.
DIAG_RE='^(.+)\(([0-9]+),([0-9]+)\): error TS[0-9]+'

TMP=""
cleanup() {
  # Idempotent, and `return 0` so the trap can never rewrite the script's own
  # exit status — the verdict word and the exit code must always agree (R22).
  if [ -n "${TMP:-}" ] && [ -d "${TMP:-}" ]; then rm -rf "$TMP"; fi
  return 0
}

# ---------------------------------------------------------------------------
# THE JSON ESCAPER. A subject's basename is attacker-controlled in the only
# sense that matters here: anyone may add a file to scripts/checks/. A name
# carrying `"` or `\` would otherwise produce a CORRUPT config, and a corrupt
# config must produce a FAILURE, never a skip — tsc answers a broken config
# with an unlocated `error TS…`, which step 12 below counts as a violation.
# The three control characters are escaped as well so that even a newline in a
# filename yields valid JSON rather than relying on that fallback.
# ---------------------------------------------------------------------------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# One generated per-file config, and one compile through it. Factored out at
# round 2 so that the canaries of step 9b travel EXACTLY the path a subject
# travels — a self-test compiled by a different code path tests a different
# thing. `COMPILE_OUT`/`COMPILE_RC` are the two results.
write_config() {   # $1 = config path, $2 = absolute subject path
  printf '{ "extends": "%s",\n  "files":   ["%s"] }\n' \
    "$(json_escape "$PROFILE")" "$(json_escape "$2")" > "$1"
}

COMPILE_OUT=""
COMPILE_RC=0
compile_config() {  # $1 = config path
  # tsc exits non-zero on diagnostics, which is the expected case for six of
  # the 42 today. Its status is captured through `if`, never through `set +e`,
  # and never discarded. The subshell of the command substitution is where the
  # cwd is pinned to REPO_ROOT (step 12 explains why that matters).
  if COMPILE_OUT="$( cd "$REPO_ROOT" && "$TSC" -p "$1" --pretty false 2>&1 )"; then
    COMPILE_RC=0
  else
    COMPILE_RC=$?
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 2/3. REFUSALS. A missing input is refused, never worked around: a gate run
#      with a substitute profile or a substitute compiler is not this gate.
# ---------------------------------------------------------------------------
if [ ! -f "$PROFILE" ]; then
  echo "REFUSING TO RUN: no compile profile at $PROFILE" >&2
  echo "  Without it every subject would be compiled under tsc's defaults, which" >&2
  echo "  is a different instrument answering a different question." >&2
  exit 1
fi

if [ ! -x "$TSC" ]; then
  cat >&2 <<EOF
REFUSING TO RUN: no executable tsc at $TSC

This worktree ships WITHOUT forge-control-web/node_modules — it is gitignored —
so a fresh worktree has no compiler and this gate would otherwise answer
"tsc: not found", which is how a gate gets disclosed and ignored. Fix it with
exactly this line, then re-run:

  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false

--prod=false IS LOAD-BEARING and so is pnpm. This environment exports
NODE_ENV=production; under it a plain \`pnpm install --frozen-lockfile\` prints
one quiet "skipping devDependencies" line, EXITS 0, and REMOVES tsc and tsx —
they are devDependencies. The install looks clean and the compiler is gone.
Never npm: \`npm\` here has resolved differently from the lockfile and bricked
the executor. Keep --frozen-lockfile: it is what holds NF8's
\`git diff main -- forge-control-web/package.json\` empty.
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# 3b. THE TOOLCHAIN MUST IDENTIFY ITSELF (round 2, red-team breach B5).
#
#     `$TSC` is an absolute path, so a fake `tsc` earlier on PATH is already
#     ignored. But that file is a pnpm shim whose last line is
#     `exec node "$basedir/../typescript/bin/tsc" "$@"` — and THAT `node` comes
#     from PATH. A `node` that does nothing and exits 0 made every subject
#     report `PASS … exit 0, 0 diagnostics`, and the gate printed its own
#     evidence of the failure — the provenance line `node : ` came back EMPTY —
#     and went green anyway. The realistic version of this is not an attacker;
#     it is a half-broken nvm/volta/asdf shim.
#
#     So: resolve `node` absolutely for the record, and REFUSE unless both
#     version strings are well-formed. This is necessary and not sufficient —
#     a fake that prints a plausible version string defeats it — which is why
#     step 9b makes the compiler prove it can still fail.
# ---------------------------------------------------------------------------
if ! NODE_BIN="$(command -v node)"; then
  echo "REFUSING TO RUN: no node on PATH." >&2
  echo "  $TSC is a pnpm shim that ends in \`exec node …\`; without node there is" >&2
  echo "  no compiler, and a gate with no compiler must say so, not pass." >&2
  exit 1
fi

if ! TSC_VERSION="$("$TSC" --version)"; then
  echo "REFUSING TO RUN: \`$TSC --version\` exited non-zero." >&2
  exit 1
fi
if ! NODE_VERSION="$("$NODE_BIN" --version)"; then
  echo "REFUSING TO RUN: \`$NODE_BIN --version\` exited non-zero." >&2
  exit 1
fi

if [[ ! "$TSC_VERSION" =~ ^Version[[:space:]][0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "REFUSING TO RUN: the compiler did not identify itself." >&2
  echo "  \`$TSC --version\` printed: '$TSC_VERSION'" >&2
  echo "  Expected 'Version X.Y.Z'. An empty or malformed answer means the shim" >&2
  echo "  resolved something that is not tsc — most often a broken \`node\` on" >&2
  echo "  PATH, which makes EVERY subject report a clean compile (red-team B5)." >&2
  exit 1
fi
if [[ ! "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "REFUSING TO RUN: node did not identify itself." >&2
  echo "  \`$NODE_BIN --version\` printed: '$NODE_VERSION'" >&2
  echo "  Expected 'vX.Y.Z'. See the note above: this is the shape of the fake" >&2
  echo "  that turned a broken directory green." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. THE RUN'S TEMP DIRECTORY. Never a generated file inside the repo: it
#    dirties the tree (NF3 and universal gate item 3 want `git status
#    --porcelain` empty), it collides between concurrent runs (NF4), and a
#    crashed run leaves a file the next `git add -A` publishes.
#
#    Three traps, not one. Bash resumes execution after a trapped signal
#    handler returns, so an INT handler that only removes the directory would
#    let the loop run on with its configs deleted; these exit, and the EXIT
#    trap then runs `cleanup` a second time harmlessly.
# ---------------------------------------------------------------------------
TMP="$(mktemp -d)"
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

START_SECONDS=$SECONDS

# ---------------------------------------------------------------------------
# 5. ENUMERATION — IN THIS SHELL, INTO AN ARRAY. NO FILE, NO SUBSHELL, NO PIPE.
#
#    Round 200 enumerated in a subshell that wrote NUL-separated names to a
#    file, guarded by the subshell's exit status. Red-team finding F1 proved
#    that guard structurally dead: a `for` loop over an EMPTY glob returns 0,
#    and the last SUBJECT_GLOB matched nothing in the trimmed tree, so the
#    subshell exited 0 even when every single `printf` had failed. On a full
#    tmpfs the subject list truncated 31 -> 24 in silence, and the census
#    reconciled 24/24 happily. The comment above it promised "a failure to
#    enumerate is a refusal, not an empty subject list"; the code did not
#    provide it.
#
#    The fix is not a better guard on the write. It is that THERE IS NO WRITE.
#    Globs expand in this shell directly into an array, so there is no partial
#    failure to detect: no file, no pipe, no command substitution (which would
#    drop the NUL bytes that make a newline in a filename survivable).
#
#    * `nullglob`  — an unmatched glob VANISHES instead of passing through
#                    literally and being handed to tsc as a filename.
#    * `dotglob`   — `.broken.ts`, and a file named exactly `.ts`, are subjects.
#                    Without it they were skipped in silence (red-team B3).
#    * `globstar`  — `**/` matches zero or more directories, so an instrument
#                    in scripts/checks/<subdir>/ is compiled rather than being
#                    invisible AND unnamed (red-team B2).
#
#    The glob is anchored with "$REPO_ROOT"/$g — the quoted half is literal, so
#    a repo path containing a glob metacharacter cannot re-expand, and the
#    unquoted half is the pattern. No `cd` in this shell, so I6 (identical
#    verdict from any cwd) needs no cwd juggling to restore.
#
#    Shell options are saved and restored, because leaving `dotglob` and
#    `globstar` set would silently change every later glob in this script.
# ---------------------------------------------------------------------------
ENUM=()
enumerate_globs() {  # $@ = repo-relative globs; result in ENUM, repo-relative, unique
  local saved_opts g f matches shopt_rc=0
  # Two globs may match the same file — `scripts/**/*.ts` contains
  # `scripts/checks/**/*.ts`, which is the shape §7's extension path produces.
  # ENUM is therefore a SET: first occurrence wins, so the per-glob order below
  # survives, and a file is neither compiled twice nor counted twice.
  # Round 3 measured the unfiltered version: with `scripts/*.ts` added, the
  # coverage scan reported "86 file(s)" for 44 files on disk. It reached the
  # right verdict — the reconciliation and the uncovered scan are both
  # membership tests, not counts — but a census nobody can add up is a census
  # nobody checks.
  local -A seen_paths=()
  # `shopt -p` EXITS 1 when any of the options it is asked to print is unset,
  # which is the normal case here — that is a report, not a failure, and it is
  # the reason for the explicit status capture rather than a bare assignment
  # (a bare one aborts the whole run under `set -e`). A status ABOVE 1 is a
  # real failure — an unknown option name — and is refused.
  saved_opts="$(shopt -p nullglob dotglob globstar)" || shopt_rc=$?
  if [ "$shopt_rc" -gt 1 ]; then
    echo "REFUSING TO RUN: \`shopt -p nullglob dotglob globstar\` failed (exit $shopt_rc)." >&2
    echo "  This shell cannot report its own glob options, so the enumeration" >&2
    echo "  below cannot be trusted to see dotfiles or subdirectories." >&2
    exit 1
  fi
  shopt -s nullglob dotglob globstar
  ENUM=()
  for g in "$@"; do
    matches=()
    # shellcheck disable=SC2231  # $g IS the pattern; quoting it defeats the glob
    for f in "$REPO_ROOT"/$g; do
      matches+=( "${f#"$REPO_ROOT/"}" )
    done
    # Sorted per glob, so the transcript reads "every .ts, then every .tsx",
    # each in C order, exactly as census-G groups them. `sort -z` keeps the
    # NUL separation that makes a newline in a filename survive.
    if [ ${#matches[@]} -gt 0 ]; then
      while IFS= read -r -d '' f; do
        if [ -z "${seen_paths[$f]+set}" ]; then
          seen_paths[$f]=1
          ENUM+=( "$f" )
        fi
      done < <(printf '%s\0' "${matches[@]}" | sort -z)
    fi
  done
  eval "$saved_opts"
  return 0
}

# 5b. THE SECOND OPINION (round 2, red-team finding F1; rewritten round 3).
#
#     The same set, taken by a DIFFERENT TOOL walking the same tree. If bash's
#     globbing and `find` disagree about which TypeScript-family files exist,
#     this gate does not know what it is looking at and says so instead of
#     certifying.
#
#     ROUND 2 TOOK A COUNT, AND FROM ONE `find` OVER DEDUPLICATED ROOTS CROSSED
#     WITH DEDUPLICATED NAMES. Two defects, both found by the round-3
#     re-review:
#
#       * ROOTS AND NAMES WERE DEDUPLICATED INDEPENDENTLY AND THEN MULTIPLIED.
#         With `scripts/checks/**/*.ts` and `scripts/*.ts` — the documented
#         extension path of §7 — the roots became {scripts/checks, scripts} and
#         the names {*.ts, *.tsx}, and `find` walked `scripts/checks` twice:
#         44 subjects globbed, 86 "found", permanent refusal. The fix is one
#         `find` PER GLOB, with that glob's own root, name and depth, and
#         deduplication of the RESOLVED PATHS afterwards.
#       * A COUNT CANNOT BE DIAGNOSED. "bash found 46, find found 45" told the
#         operator nothing about which file, and the honest sentence that
#         followed — "one of them is wrong and this gate does not know which" —
#         was the whole message. It is now a SET: any disagreement is printed
#         file by file, with the side that saw it.
#
#     `-L` IS LOAD-BEARING. bash's `**` matches a symlinked directory as a
#     single path component and resolves through it, so a `.ts` one level
#     inside `scripts/checks/link-to-elsewhere/` IS a subject; `find` without
#     `-L` never enters it, and that benign tree shape took the entire gate
#     offline at round 2 (a regression against round 200, which compiled it).
#     `-L` matches bash at that depth. DEEPER, the two still part company —
#     bash's `**` will not recurse THROUGH a symlink, `-L` will — so the
#     difference is reported with the symlinked ancestor named, which is a
#     defect an operator can act on rather than two integers.
#
#     NO `-type` FILTER, deliberately. A glob matches by NAME, whatever the
#     entry turns out to be — a symlink, a dangling symlink, even a DIRECTORY
#     called `x.ts`. The second opinion must match by name too, or the two
#     would disagree over shapes that are not the disagreement this guard is
#     looking for, and the run would refuse with the wrong diagnosis instead of
#     reaching the MISSING path, which names the offending entry (R19).
SECOND_OPINION=()
independent_set() {  # $@ = repo-relative globs -> SECOND_OPINION, repo-relative, sorted, unique
  local g p sentinel
  local -a args=() chunk=() raw=()
  SECOND_OPINION=()
  for g in "$@"; do
    decompose_glob "$g"
    args=( -L "$REPO_ROOT/$GLOB_ROOT" -mindepth 1 )
    if [ "$GLOB_RECURSIVE" -eq 0 ]; then args+=( -maxdepth 1 ); fi
    args+=( -name "$GLOB_NAME" -print0 )
    # THE SENTINEL IS THE EXIT-STATUS CHANNEL. A process substitution's status
    # is not available to the reader, and this enumeration is the one that
    # round 200 got wrong by trusting an unavailable status (F1). `find`
    # therefore APPENDS its own exit code as a final NUL-terminated record; a
    # truncated stream, a symlink loop, an unreadable directory — anything that
    # stops `find` early — loses or changes that record and is refused below.
    chunk=()
    mapfile -d '' -t chunk < <(find "${args[@]}"; printf 'FIND-EXIT-%s\0' "$?")
    if [ ${#chunk[@]} -eq 0 ]; then
      echo "REFUSING TO RUN: \`find\` produced no sentinel for glob '$g'." >&2
      echo "  The second opinion's own exit-status channel is missing, so its" >&2
      echo "  result cannot be trusted and this gate certifies nothing." >&2
      exit 1
    fi
    sentinel="${chunk[$(( ${#chunk[@]} - 1 ))]}"
    if [ "$sentinel" != "FIND-EXIT-0" ]; then
      echo "REFUSING TO RUN: the independent \`find\` enumeration failed for glob '$g'." >&2
      echo "  sentinel: $sentinel  (expected FIND-EXIT-0)" >&2
      echo "  find $(printf '%q ' "${args[@]}")" >&2
      echo "  An enumeration that cannot be corroborated is not an empty directory," >&2
      echo "  and this gate will not report one as the other. A symlink loop under" >&2
      echo "  a subject root is the common cause; \`-L\` follows symlinks on purpose" >&2
      echo "  (see the note above) and a loop makes that unbounded." >&2
      exit 1
    fi
    unset "chunk[$(( ${#chunk[@]} - 1 ))]"
    for p in ${chunk[@]+"${chunk[@]}"}; do
      raw+=( "${p#"$REPO_ROOT/"}" )
    done
  done
  # Deduplicate the RESOLVED PATHS — not the roots, not the name patterns.
  # Overlapping globs (two extensions in one root, or a root nested inside
  # another root) are now free: the same file found twice is one entry.
  if [ ${#raw[@]} -gt 0 ]; then
    while IFS= read -r -d '' p; do
      SECOND_OPINION+=( "$p" )
    done < <(printf '%s\0' "${raw[@]}" | sort -zu)
  fi
  return 0
}

# The first ancestor directory of a path that is a symlink, or nothing. Used
# only to DIAGNOSE a disagreement — never to decide one. Written with parameter
# expansion rather than `dirname` so that a filename ending in a newline
# survives (command substitution eats trailing newlines).
symlink_ancestor() {  # $1 = repo-relative path -> prints the ancestor, or returns 1
  local dir="$1"
  while [ "$dir" != "${dir%/*}" ]; do
    dir="${dir%/*}"
    if [ -L "$REPO_ROOT/$dir" ]; then printf '%s' "$dir"; return 0; fi
  done
  return 1
}

# Enumerate with bash, corroborate with find, and refuse — naming every file
# the two disagree about — if they differ. ENUM holds the reconciled set.
enumerate_and_reconcile() {  # $1 = label, $2.. = repo-relative globs
  local label="$1"; shift
  local entry other seen anc disagreements=0
  local -a globbed=()

  enumerate_globs "$@"
  globbed=( ${ENUM[@]+"${ENUM[@]}"} )
  independent_set "$@"

  for entry in ${globbed[@]+"${globbed[@]}"}; do
    seen=0
    for other in ${SECOND_OPINION[@]+"${SECOND_OPINION[@]}"}; do
      if [ "$other" = "$entry" ]; then seen=1; break; fi
    done
    if [ "$seen" -eq 0 ]; then
      if [ "$disagreements" -eq 0 ]; then
        echo "REFUSING TO RUN: the two enumerations of the $label set disagree." >&2
        echo "  globs: $*" >&2
      fi
      disagreements=$((disagreements + 1))
      echo "  ONLY bash globs saw: $entry" >&2
    fi
  done
  for entry in ${SECOND_OPINION[@]+"${SECOND_OPINION[@]}"}; do
    seen=0
    for other in ${globbed[@]+"${globbed[@]}"}; do
      if [ "$other" = "$entry" ]; then seen=1; break; fi
    done
    if [ "$seen" -eq 0 ]; then
      if [ "$disagreements" -eq 0 ]; then
        echo "REFUSING TO RUN: the two enumerations of the $label set disagree." >&2
        echo "  globs: $*" >&2
      fi
      disagreements=$((disagreements + 1))
      if anc="$(symlink_ancestor "$entry")"; then
        echo "  ONLY find saw:      $entry" >&2
        echo "     reachable through the SYMLINKED directory $anc — bash's \`**\` does" >&2
        echo "     not recurse through a symlink, so this file can never be a subject" >&2
        echo "     while it lives there. Replace $anc with a real directory, or move" >&2
        echo "     the file: it is a TypeScript instrument this gate cannot reach." >&2
      else
        echo "  ONLY find saw:      $entry" >&2
      fi
    fi
  done

  if [ "$disagreements" -ne 0 ]; then
    echo "  $disagreements file(s) above. bash globbed ${#globbed[@]}; find resolved ${#SECOND_OPINION[@]}." >&2
    echo "  This gate certifies nothing while it cannot agree with a second tool" >&2
    echo "  about what is on disk. This is the guard round 200's dead enumeration" >&2
    echo "  check was supposed to be (evidence/phase2-redteam.md, finding F1)." >&2
    exit 1
  fi

  ENUM=( ${globbed[@]+"${globbed[@]}"} )
  return 0
}

enumerate_and_reconcile "subject" "${SUBJECT_GLOBS[@]}"
SUBJECTS=( ${ENUM[@]+"${ENUM[@]}"} )
FOUND=${#SUBJECTS[@]}

# ---------------------------------------------------------------------------
# 6. ZERO SUBJECTS IS A REFUSAL, NOT A PASS (R13).
# ---------------------------------------------------------------------------
if [ "$FOUND" -eq 0 ]; then
  echo "REFUSING TO RUN: zero subjects matched ${SUBJECT_GLOBS[*]} under $REPO_ROOT." >&2
  echo "  A gate over nothing certifies nothing. This is not a clean run; it is a" >&2
  echo "  run that never looked at anything." >&2
  exit 1
fi

echo "check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)"
echo "coverage: every file matching ${SUBJECT_GLOBS[*]}, enumerated at run time"
echo

# ---------------------------------------------------------------------------
# 7. COVERAGE SCAN (R10, amended at round 2).
#
#    Round 200 scanned for two EXTENSIONS at one DEPTH, so a type-broken file
#    in scripts/checks/sub/ was uncompiled and the block printed `none` — the
#    silence R10 exists against, produced by the very block written to prevent
#    it (red-team B2). The scan now enumerates every TypeScript-family file
#    under the subject roots, at any depth, dotfile or not, and subtracts the
#    subjects. Whatever is left is NAMED — and, since finding F7, FAILS the
#    run: R10's old "either cover it or name it" permitted `PASSED` with a
#    type-broken `.cts` on disk, which is precisely what brief A2 calls a
#    breach. Naming is the right message; exit 0 was the wrong verdict.
# ---------------------------------------------------------------------------
enumerate_and_reconcile "coverage" "${COVERAGE_GLOBS[@]}"
COVERAGE=( ${ENUM[@]+"${ENUM[@]}"} )

UNCOVERED=()
for candidate in ${COVERAGE[@]+"${COVERAGE[@]}"}; do
  enumerated=0
  for subject in "${SUBJECTS[@]}"; do
    if [ "$subject" = "$candidate" ]; then enumerated=1; break; fi
  done
  if [ "$enumerated" -eq 0 ]; then UNCOVERED+=("$candidate"); fi
done
UNCOVERED_COUNT=${#UNCOVERED[@]}

echo "COVERAGE — every TypeScript-family file under the subject roots must be compiled"
printf '  scanned %s: %d file(s); enumerated as subjects: %d\n' \
  "${COVERAGE_GLOBS[*]}" "${#COVERAGE[@]}" "$FOUND"
if [ "$UNCOVERED_COUNT" -eq 0 ]; then
  echo "  ok: 0 uncovered — every TypeScript-family file on disk is a subject below"
else
  for candidate in "${UNCOVERED[@]}"; do
    printf '  UNCOVERED %s — matched by %s, not by %s\n' \
      "$candidate" "${COVERAGE_GLOBS[*]}" "${SUBJECT_GLOBS[*]}"
  done
  echo "  These are NOT compiled and NOT counted below, and this run FAILS because"
  echo "  of them (R10 as amended at round 2). A file this gate declines to read"
  echo "  cannot also be certified by it. Widen SUBJECT_GLOBS at the top of this"
  echo "  script — in extension, or in depth if the file sits below a glob that"
  echo "  does not recurse — or remove the file. SUBJECT_GLOBS is the only edit"
  echo "  required: the coverage globs above are derived from its roots."
fi
echo

# ---------------------------------------------------------------------------
# 8. PHASE 5 HOOK — READ THE WAIVER LEDGER (R14).
#
#    `scripts/checks/instrument-manifest.txt` is repurposed by phase 5 from an
#    inclusion list into a waiver ledger, and this is where reading it belongs:
#    parse its four required fields per entry (path, diagnostic, reason,
#    owner), fail on an entry missing a field, and print EVERY waiver here,
#    above the verdict, because a waiver that is not printed is an exclusion
#    nobody sees.
#
#    NOT IMPLEMENTED AT ROUND 200, DELIBERATELY. Today that file still holds
#    seven bare paths in round-800 inclusion-list form. A ledger reader pointed
#    at it now would read all seven as waivers, find all seven compile clean,
#    and report seven "waived but clean" violations — destroying acceptance
#    criterion A2.2's "exactly 6 failures" with noise from a file this phase
#    does not own. Phase 5 rewrites the file and implements this hook in the
#    same commit. Until then this gate reads that file NOWHERE and waives
#    NOTHING, which is the safe direction: every subject is compiled.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 9. PROVENANCE — before any verdict. A harness that does not expose its own
#    build identity is not evidence (standing rule 3, R20).
#
#    The temp directory and the wall-clock are printed on their OWN lines, and
#    are the only lines that may differ between two runs of an unchanged tree
#    (NF2, NF6, S10) — `diff` of two transcripts is the test.
# ---------------------------------------------------------------------------
echo "PROVENANCE"
echo "  worktree path    : $REPO_ROOT"
echo "  git HEAD         : $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo no-git)"
echo "  git branch       : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo no-git)"
echo "  this check       : $SELF"
echo "  this check sha256: $(sha256sum "$SELF" | cut -d' ' -f1)"
echo "  profile          : $PROFILE"
echo "  profile sha256   : $(sha256sum "$PROFILE" | cut -d' ' -f1)"
echo "  tsc              : $TSC_VERSION  ($TSC)"
echo "  node             : $NODE_VERSION  ($NODE_BIN)"
echo "  subjects found   : $FOUND"
echo "  invocation       : (cd \$REPO_ROOT && \$TSC -p \$TMP/NNNN.json --pretty false)  # one file per invocation"
echo "  temp dir         : $TMP"
echo

# ---------------------------------------------------------------------------
# 9b. SELF-TEST — MAKE THE COMPILER FAIL BEFORE BELIEVING IT PASSES.
#
#     Red-team breaches B5 and B6 both had the same shape: the gate's inputs
#     were checked for EXISTENCE and never for BEHAVIOUR. A `node` that exits 0
#     silently, and a profile whose `extends` was redirected at an empty `{}`,
#     each produced `PASSED` over genuinely broken files — and the second one
#     also lost `noEmit` and wrote eight `.js` files into the worktree.
#
#     Three canaries, written into the run's own temp directory and compiled
#     through the SAME generated-config path a subject travels. Each asserts a
#     property of the profile that a subject's silence would otherwise hide:
#
#       1. strict-null    `const s: string = null` MUST produce TS2322.
#                         Proves the compiler runs at all, and that `strict`
#                         survived whatever `extends` resolved to (B5, B6).
#       2. declaration    two conflicting members of one interface in a .d.ts
#                         MUST produce TS2717. Proves `skipLibCheck` is OFF —
#                         the profile's override of the app's `true` — which is
#                         the only reason a `.d.ts` SUBJECT is read at all (B1).
#       3. clean          a .tsx using `process.env` and JSX MUST compile
#                         CLEAN. Proves `typeRoots`, the four `@types` `paths`
#                         and the `react-jsx` transform still resolve, so that
#                         canaries 1 and 2 failed for the reason claimed and
#                         not because everything fails.
#
#     Then: NOT ONE FILE may have been emitted beside them. That is `noEmit`,
#     measured rather than read (B6's aggravating half, NF3).
#
#     WHY NOT PIN THE PROFILE'S sha256, which is the other fix the red team
#     offered: a hash asserts a NUMBER, and every legitimate profile edit then
#     becomes a two-file change whose second half is a mechanical re-paste —
#     the exact ritual that teaches a maintainer to update a checksum without
#     reading what it covers. These three assert the PROPERTIES the profile
#     exists to provide, and they keep asserting them across edits that keep
#     those properties true. The sha256 is still printed in the provenance
#     block above, where a number is worth something: it identifies the file.
# ---------------------------------------------------------------------------
CANARY_DIR="$TMP/canary"
mkdir -p "$CANARY_DIR"

cat > "$CANARY_DIR/canary-strict.ts" <<'EOF'
// Written and compiled by check-instrument-typecheck.sh on every run.
// It MUST fail with TS2322. If it stops failing, `strict` is gone.
export const s: string = null;
EOF

cat > "$CANARY_DIR/canary-declaration.d.ts" <<'EOF'
// It MUST fail with TS2717. If it stops failing, skipLibCheck is back on and
// every .d.ts under scripts/checks/ is being counted without being read.
export interface CanaryShape { field: string; }
export interface CanaryShape { field: number; }
EOF

cat > "$CANARY_DIR/canary-clean.tsx" <<'EOF'
// It MUST compile clean: typeRoots, the @types paths and the react-jsx
// transform all resolve. If it starts failing, the other two canaries prove
// nothing, because everything fails.
import type { ReactElement } from 'react';
export const home: string = process.env.HOME ?? '';
export function Canary({ label }: { label: string }): ReactElement {
  return <span data-home={home}>{label}</span>;
}
EOF

canary_refuse() {  # $1 = what was expected, $2 = the canary's own filename
  echo "REFUSING TO RUN: the compiler self-test failed — $1 ($2)." >&2
  echo "  This gate will not certify anything with a compiler or a profile it" >&2
  echo "  has just watched behave wrongly. What the canary produced:" >&2
  printf '%s\n' "$COMPILE_OUT" | sed 's/^/    /' >&2
  echo "    exit $COMPILE_RC" >&2
  echo "  Read $PROFILE first: its \`extends\`, its \`strict\`, its" >&2
  echo "  \`skipLibCheck\`, its \`typeRoots\`. Then check that \`node\` on PATH is" >&2
  echo "  a real node ($NODE_BIN). Both have produced this exact symptom" >&2
  echo "  (evidence/phase2-redteam.md, breaches B5 and B6)." >&2
  exit 1
}

echo "SELF-TEST — the compiler and the profile must prove themselves first"

write_config "$TMP/canary-strict.json" "$CANARY_DIR/canary-strict.ts"
compile_config "$TMP/canary-strict.json"
if [[ "$COMPILE_OUT" != *"error TS2322"* ]]; then
  canary_refuse "a strict-null violation was NOT reported (expected TS2322)" "canary-strict.ts"
fi
echo "  ok: strict null checking is live          — the canary produced TS2322"

write_config "$TMP/canary-declaration.json" "$CANARY_DIR/canary-declaration.d.ts"
compile_config "$TMP/canary-declaration.json"
if [[ "$COMPILE_OUT" != *"error TS2717"* ]]; then
  canary_refuse "a declaration file was NOT typechecked (expected TS2717; skipLibCheck must be false)" "canary-declaration.d.ts"
fi
echo "  ok: declaration files are typechecked     — the canary produced TS2717"

write_config "$TMP/canary-clean.json" "$CANARY_DIR/canary-clean.tsx"
compile_config "$TMP/canary-clean.json"
if [ "$COMPILE_RC" -ne 0 ] || [ -n "$COMPILE_OUT" ]; then
  canary_refuse "a file that must compile clean did not (typeRoots, @types paths or jsx)" "canary-clean.tsx"
fi
echo "  ok: typeRoots, @types paths and jsx work  — the canary compiled clean"

EMITTED=()
for f in "$CANARY_DIR"/*.js "$CANARY_DIR"/*.jsx "$CANARY_DIR"/*.d.ts.map "$CANARY_DIR"/*.js.map; do
  if [ -e "$f" ]; then EMITTED+=("$(basename "$f")"); fi
done
if [ ${#EMITTED[@]} -ne 0 ]; then
  echo "REFUSING TO RUN: the self-test EMITTED files — \`noEmit\` is not in effect." >&2
  printf '  emitted: %s\n' "${EMITTED[*]}" >&2
  echo "  A gate that emits writes JavaScript beside every subject it compiles," >&2
  echo "  dirtying the worktree (NF3). This is what a degraded \`extends\` did to" >&2
  echo "  eight files at round 2 (evidence/phase2-redteam.md, breach B6)." >&2
  exit 1
fi
echo "  ok: noEmit is in effect                   — 0 files emitted beside the canaries"

# ---------------------------------------------------------------------------
# 9c. THE FOURTH CANARY — THE SUPPRESSION SCANNER MUST PROVE ITSELF.
#
#     Round 2 scanned for suppression directives with a grep that APPROXIMATED
#     tsc's two directive regexes, and the approximation leaked in both
#     directions: `/** @ts-ignore */` (the JSDoc form) suppressed a diagnostic
#     and was not matched, while the literal text `@ts-ignore` inside a STRING
#     was matched though it suppresses nothing. The first direction produced a
#     `PASSED`, exit 0 over a broken subject — the breach sentence.
#
#     The scanner below does not approximate: it asks the compiler's own parser
#     (the same installation `$TSC` runs from) for `commentDirectives` — what
#     tsc honours as `@ts-ignore`/`@ts-expect-error`, in comment position only
#     — and for `checkJsDirective`, which carries `@ts-nocheck` and whose
#     `enabled: false` IS the suppression (`enabled: true` is `@ts-check`).
#
#     Both are internal fields of the SourceFile, absent from the public
#     typings, and a future TypeScript may rename them. A scanner that quietly
#     returns nothing is EXACTLY the failure it replaced, so it is not trusted
#     until it has found, in one canary, all five comment shapes measured to
#     suppress on this tree — and not found the string-literal decoy sitting
#     beside them.
#
#     Measured 2026-08-18, tsc 5.7.2, on this profile: `// @ts-ignore`,
#     `//@ts-ignore`, `/// @ts-ignore`, `/* @ts-ignore */`, `/** @ts-ignore */`,
#     `/**@ts-ignore*/`, the four `@ts-expect-error` equivalents, and
#     `// @ts-nocheck` all suppress. `/** @ts-nocheck */` and a `@ts-ignore` on
#     the second line of a JSDoc block do NOT — tsc ignores them, so this gate
#     does too: a scan that fails a subject over an inert comment teaches the
#     next maintainer to distrust it.
# ---------------------------------------------------------------------------
cat > "$TMP/suppression-scan.js" <<'EOF'
// Written and run by check-instrument-typecheck.sh. argv: <typescript-dir>
// then one or more subject paths. One record per subject on stdout:
//     <index>\t<hit>[,<hit>…]      hits are line:directive
//     <index>\t-                   no directive
//     <index>\tABSENT              vanished between enumeration and scan
//     <index>\tERROR:<message>     anything else — the caller refuses
// The index, never the path, is the key: a filename may contain a tab or a
// newline, and this record is line-oriented.
'use strict';
const ts = require(process.argv[2]);
const fs = require('fs');
const files = process.argv.slice(3);
for (let i = 0; i < files.length; i++) {
  const record = (payload) => process.stdout.write(`${i + 1}\t${payload}\n`);
  let text;
  try {
    text = fs.readFileSync(files[i], 'utf8');
  } catch (err) {
    record(err && err.code === 'ENOENT' ? 'ABSENT' : `ERROR:${err && err.message}`);
    continue;
  }
  try {
    const sf = ts.createSourceFile(files[i], text, ts.ScriptTarget.Latest, false);
    const at = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const hits = [];
    for (const d of sf.commentDirectives || []) {
      // CommentDirectiveType: 0 = ExpectError, 1 = Ignore.
      hits.push(`${at(d.range.pos)}:@ts-${d.type === 0 ? 'expect-error' : 'ignore'}`);
    }
    // `enabled` is the state of CHECKING, not of the directive: false is
    // @ts-nocheck, true is @ts-check, undefined is neither.
    if (sf.checkJsDirective && sf.checkJsDirective.enabled === false) {
      hits.push(`${at(sf.checkJsDirective.pos)}:@ts-nocheck`);
    }
    record(hits.length ? hits.join(',') : '-');
  } catch (err) {
    record(`ERROR:${err && err.message}`);
  }
}
EOF

if [ ! -d "$TS_LIB" ]; then
  echo "REFUSING TO RUN: no TypeScript library at $TS_LIB." >&2
  echo "  The suppression scan of step 10b parses every subject with the compiler's" >&2
  echo "  own parser rather than approximating its directive regexes with a grep." >&2
  echo "  Install as step 3 says: cd forge-control-web && pnpm install --frozen-lockfile --prod=false" >&2
  exit 1
fi

cat > "$CANARY_DIR/canary-suppression.ts" <<'EOF'
// @ts-ignore
//@ts-ignore
/// @ts-ignore
/** @ts-ignore */
/** @ts-expect-error */
export const decoy = 'this line writes // @ts-nocheck and /** @ts-ignore */ as TEXT';
EOF
cat > "$CANARY_DIR/canary-nocheck.ts" <<'EOF'
// @ts-nocheck
export const whatever: string = 'the directive above is the point';
EOF

SUPPRESSION_CANARY_EXPECTED="1	1:@ts-ignore,2:@ts-ignore,3:@ts-ignore,4:@ts-ignore,5:@ts-expect-error
2	1:@ts-nocheck"
scan_rc=0
SUPPRESSION_CANARY_OUT="$("$NODE_BIN" "$TMP/suppression-scan.js" "$TS_LIB" \
  "$CANARY_DIR/canary-suppression.ts" "$CANARY_DIR/canary-nocheck.ts" 2>&1)" || scan_rc=$?
if [ "$scan_rc" -ne 0 ] || [ "$SUPPRESSION_CANARY_OUT" != "$SUPPRESSION_CANARY_EXPECTED" ]; then
  echo "REFUSING TO RUN: the suppression scanner failed its own canary (exit $scan_rc)." >&2
  echo "  expected:" >&2
  printf '%s\n' "$SUPPRESSION_CANARY_EXPECTED" | sed 's/^/    /' >&2
  echo "  got:" >&2
  printf '%s\n' "$SUPPRESSION_CANARY_OUT" | sed 's/^/    /' >&2
  echo "  The scanner reads two INTERNAL fields of TypeScript's SourceFile —" >&2
  echo "  \`commentDirectives\` and \`checkJsDirective\` — which are absent from the" >&2
  echo "  public typings and may be renamed by a compiler upgrade. Line 6 of the" >&2
  echo "  canary carries the directive text inside a STRING and must NOT be" >&2
  echo "  reported; lines 1-5 are the five comment shapes measured to suppress." >&2
  echo "  A scanner that has stopped seeing them would report \`suppressions 0\` over" >&2
  echo "  a subject that asked not to be checked, which is red-team breach B4" >&2
  echo "  reopened. Read $TS_LIB/lib/typescript.js for the new field names." >&2
  exit 1
fi
echo "  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored"
echo

# ---------------------------------------------------------------------------
# 12. PROFILE FIDELITY (S5), applied to every subject's output as it arrives.
#
#     `forge-control-web/app` and `forge-control/src` are GREEN under their own
#     `pnpm typecheck`. If this gate reports a diagnostic located in either of
#     them, this gate is wrong — the profile is. That is the whole point of the
#     message below: it is what stops the next maintainer from editing the app
#     to satisfy the gate, which would be a real regression bought with a green
#     tick.
#
#     Paths are compared against the SUBJECT ROOTS — `ACCEPTED_PREFIXES`,
#     derived from SUBJECT_GLOBS at the top of this file, `scripts/checks/`
#     today. Round 2 inlined that prefix here, which made §7's "a successor
#     edits two named variables and nothing else" false: a successor adding
#     `scripts/*.ts` would have had EVERY diagnostic in the new root reported
#     as a profile violation, with the "THE PROFILE IS WRONG" essay attached
#     (round-2 gate review, finding 8). The comparison is only meaningful at
#     all because tsc prints diagnostic paths relative to ITS OWN cwd
#     and the compile below pins that cwd to REPO_ROOT. Measured at round 200,
#     tsc 5.7.2, same generated config, same subject:
#       from the repo root : scripts/checks/check-orientation.ts(129,38): error TS2322: …
#       from /tmp          : ../opt/ai-os/workspace/…/scripts/checks/check-orientation.ts(129,38): …
#     An inherited cwd would therefore make every diagnostic look like a
#     fidelity violation for the reviewer who ran the gate from somewhere else,
#     and I6/A2.6 demands an identical verdict from any cwd.
#
#     THREE THINGS CHANGED AT ROUND 2 (red-team F3/F4, and the profile's new
#     `skipLibCheck: false`):
#
#     * A SUBJECT WHOSE NAME CONTAINS A NEWLINE splits its own diagnostic
#       across two physical lines, and the tail — `b.ts(1,14): error TS2322` —
#       parsed as a path outside scripts/checks/. The gate then printed the
#       "THE PROFILE IS WRONG, NOT THE APP" essay about a FILENAME and sent the
#       maintainer to edit an innocent file. The subject's own name is now
#       folded back onto one line before parsing.
#     * A HOSTILE NAME that still produces violations is called out as such, so
#       the closing essay cannot be read as a verdict on the profile.
#     * A DIAGNOSTIC INSIDE node_modules/ is now reported separately. It became
#       reachable when the profile turned `skipLibCheck` off: the remedy is to
#       upgrade or pin the dependency whose declarations are broken, and it is
#       emphatically NOT to turn skipLibCheck back on, which would restore
#       breach B1.
# ---------------------------------------------------------------------------
FIDELITY=0
FIDELITY_LOG=""
HOSTILE_NAMES=0

# True when a diagnostic's path lies under one of the subject roots — the
# expected shape. Derived, never inlined: see ACCEPTED_PREFIXES at the top.
diag_is_expected() {  # $1 = the path tsc printed
  local prefix
  for prefix in "${ACCEPTED_PREFIXES[@]}"; do
    case "$1" in
      "$prefix"*) return 0 ;;
    esac
  done
  return 1
}

scan_fidelity() {
  local subject="$1" out="$2" line diag_path scan hostile=0
  if [ -z "$out" ]; then return 0; fi

  case "$subject" in
    *$'\n'*|*\\*) hostile=1 ;;
  esac

  scan="$out"
  if [ "$hostile" -eq 1 ]; then
    # Fold this subject's own path — newlines and all — into a single-line
    # token before parsing. The replacement is placed under the subject's own
    # root so that the fold cannot manufacture the very violation it exists to
    # prevent. Only the COPY used for parsing is folded; the FAIL block printed
    # above is the compiler's full unfiltered output (R21).
    scan="${scan//"$subject"/${ACCEPTED_PREFIXES[0]}<subject whose filename is hostile>}"
  fi

  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    if [[ "$line" =~ $DIAG_RE ]]; then
      diag_path="${BASH_REMATCH[1]}"
      if diag_is_expected "$diag_path"; then
        : # located inside a subject root — the expected shape
      else
        case "$diag_path" in
          *node_modules/*)
            FIDELITY=$((FIDELITY + 1))
            FIDELITY_LOG+="  while compiling $subject: diagnostic inside node_modules/ — a DEPENDENCY's declarations"$'\n'
            FIDELITY_LOG+="    $line"$'\n'
            if [ "$hostile" -eq 1 ]; then HOSTILE_NAMES=$((HOSTILE_NAMES + 1)); fi
            ;;
          *)
            FIDELITY=$((FIDELITY + 1))
            FIDELITY_LOG+="  while compiling $subject: diagnostic located OUTSIDE ${ACCEPTED_PREFIXES[*]}"$'\n'
            FIDELITY_LOG+="    $line"$'\n'
            if [ "$hostile" -eq 1 ]; then HOSTILE_NAMES=$((HOSTILE_NAMES + 1)); fi
            ;;
        esac
      fi
    elif [[ "$line" == *"error TS"* ]]; then
      FIDELITY=$((FIDELITY + 1))
      FIDELITY_LOG+="  while compiling $subject: diagnostic with NO parseable path — a config-level error"$'\n'
      FIDELITY_LOG+="    $line"$'\n'
      if [ "$hostile" -eq 1 ]; then HOSTILE_NAMES=$((HOSTILE_NAMES + 1)); fi
    fi
  done <<< "$scan"
  return 0
}

COMPILED=0
FAILED=0
MISSING=0
SUPPRESSED=0

# ---------------------------------------------------------------------------
# 10. COMPILE — one file per invocation (R11). Compiling them together merges
#     42 unrelated entry points into one program, which is how round 800's
#     whole-directory attempt pulled app modules into scope and produced
#     cross-file noise nobody could attribute.
#
#     `--pretty false` is REQUIRED, not cosmetic. Measured at round 200: under
#     a TTY — which is where a reviewer runs this — tsc pretty-prints, with
#     ANSI colour, the path split as `file:line:col`, a source excerpt, a
#     squiggle, AND a related-information block citing app files. The fidelity
#     parser above would see a different shape than it sees when piped, and two
#     runs would stop being identical (NF2). `--pretty false` composes with
#     `-p` (measured; it is only source FILES that may not be mixed with `-p`).
#
#     The generated config is named by INDEX, never by the subject's basename:
#     a basename can carry a leading dash, a space, a quote or a `$`. The
#     subject itself reaches tsc only inside the JSON, never on a command line.
#
# 10b. SUPPRESSION SCAN (R28 as amended at round 2; red-team B4 and F2).
#
#     `// @ts-nocheck` is one line, it turns any instrument green, and until
#     round 2 neither R28 nor the P-A grep named it. It is also the obvious
#     move for a phase-3 builder facing six reds. P-A greps the DIFF, so it
#     cannot see a suppression that is already on `main` — and R9's own
#     argument ("all four repetitions were found by someone compiling a file
#     nobody had touched in months") applies verbatim to suppressions. This
#     gate already opens every subject on every run, so it is the right place
#     for the directory-scoped version of that check.
#
#     A suppressed subject is still COMPILED and still counted, so the census
#     reconciles; what changes is that the run fails and the line is named.
#
#     THE SCAN IS ONE PASS OF THE COMPILER'S OWN PARSER over every subject,
#     replacing round 2's per-subject grep, which approximated tsc's directive
#     regexes and missed the JSDoc form (round-3 re-review, blocker 1). It runs
#     BEFORE the compile loop, in a single node process rather than 42, and is
#     keyed by INDEX because a filename may contain a tab or a newline and the
#     scanner's records are lines. A subject that vanishes between enumeration
#     and scan reports ABSENT and is left to the loop's MISSING path, which is
#     the one place that decides what a vanished subject means (R19).
# ---------------------------------------------------------------------------
SUPPRESSION_HITS=()
scan_rc=0
SUPPRESSION_RAW="$( "$NODE_BIN" "$TMP/suppression-scan.js" "$TS_LIB" \
  "${SUBJECTS[@]/#/$REPO_ROOT/}" 2>&1 )" || scan_rc=$?
if [ "$scan_rc" -ne 0 ]; then
  echo "REFUSING TO RUN: the suppression scan failed (node exit $scan_rc)." >&2
  printf '%s\n' "$SUPPRESSION_RAW" | sed 's/^/    /' >&2
  echo "  It passed its canary moments ago, so this is about the SUBJECTS, not" >&2
  echo "  the scanner. Every subject must be parseable for R28 to mean anything." >&2
  exit 1
fi
while IFS= read -r scan_line; do
  if [ -z "$scan_line" ]; then continue; fi
  scan_index="${scan_line%%$'\t'*}"
  scan_payload="${scan_line#*$'\t'}"
  case "$scan_payload" in
    ERROR:*)
      echo "REFUSING TO RUN: the suppression scanner could not read a subject." >&2
      echo "  subject: ${SUBJECTS[$(( scan_index - 1 ))]}" >&2
      echo "  $scan_payload" >&2
      echo "  A subject this gate cannot parse is a subject whose suppressions it" >&2
      echo "  cannot see, and R28 is not satisfiable by assumption." >&2
      exit 1
      ;;
  esac
  SUPPRESSION_HITS[scan_index]="$scan_payload"
done <<< "$SUPPRESSION_RAW"
if [ "${#SUPPRESSION_HITS[@]}" -ne "$FOUND" ]; then
  echo "REFUSING TO RUN: the suppression scanner answered for ${#SUPPRESSION_HITS[@]} of $FOUND subjects." >&2
  echo "  One record per subject is the contract; a short answer means some subject" >&2
  echo "  was never examined, and this gate does not certify what it did not read." >&2
  exit 1
fi

echo "TYPECHECK — one tsc invocation per subject, through the profile"
index=0
for subject in "${SUBJECTS[@]}"; do
  index=$((index + 1))
  abs="$REPO_ROOT/$subject"

  # 9 (R19). A subject that disappears between enumeration and compilation is a
  # FAILURE naming it, never a skip: MISSING is incremented, COMPILED is NOT,
  # so the census below fires as well and both are printed.
  if [ ! -f "$abs" ]; then
    printf '  MISSING %-45s %s\n' "$subject" "enumerated but ABSENT at compile time — NOT compiled"
    MISSING=$((MISSING + 1))
    continue
  fi

  # The directives this subject carries, decided by the compiler's own parser
  # above. `-` is the clean case; ABSENT cannot reach here (the MISSING branch
  # took it); ERROR was refused before the loop began.
  hits="${SUPPRESSION_HITS[$index]}"
  if [ "$hits" != "-" ] && [ "$hits" != "ABSENT" ]; then
    # `printf '%s\n'` — the TRAILING NEWLINE IS LOAD-BEARING. `read` returns
    # non-zero at an unterminated final line, so a `%s` here made the while
    # loop drop the last (usually the only) directive on the floor: measured,
    # a planted `// @ts-nocheck` was correctly detected by the scanner, read
    # into `hits`, and then never printed or counted — `suppressions 0` over a
    # subject the gate had already identified as suppressed.
    while IFS= read -r hit; do
      if [ -z "$hit" ]; then continue; fi
      printf '  SUPPRESSED %-42s %s\n' "$subject" "$hit"
      SUPPRESSED=$((SUPPRESSED + 1))
    done < <(printf '%s\n' "$hits" | tr ',' '\n')
  fi

  cfg="$(printf '%s/%04d.json' "$TMP" "$index")"
  write_config "$cfg" "$abs"
  compile_config "$cfg"
  rc="$COMPILE_RC"
  OUT="$COMPILE_OUT"
  COMPILED=$((COMPILED + 1))

  scan_fidelity "$subject" "$OUT"

  if [ "$rc" -eq 0 ] && [ -z "$OUT" ]; then
    printf '  PASS %-48s %s\n' "$subject" "exit 0, 0 diagnostics"
  else
    printf '  FAIL %-48s %s\n' "$subject" "exit $rc"
    # R21: the compiler's FULL, UNFILTERED output for this subject. No head, no
    # truncation, no summarising — the indent is the only thing added.
    printf '%s\n' "$OUT" | sed 's/^/         /'
    FAILED=$((FAILED + 1))
  fi
done
echo

# ---------------------------------------------------------------------------
# 11. PHASE 5 HOOK — WAIVER RECONCILIATION (R14).
#
#     When phase 5 lands the ledger, this is where "waived but clean" belongs:
#     any subject listed in the ledger that compiled clean above FAILS the run.
#     Stale waivers are the mechanism by which an exclusion list outlives its
#     reason, and that check is what closes it.
#
#     NOT IMPLEMENTED AT ROUND 200 — see the hook at step 8 for why. There are
#     no waivers to reconcile, so no waiver can be stale, and every subject
#     above was compiled rather than excused.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 10b (report). SUPPRESSION DIRECTIVES — gathered during the loop.
# ---------------------------------------------------------------------------
echo "SUPPRESSIONS — no subject may ask the compiler to look away (R28)"
if [ "$SUPPRESSED" -eq 0 ]; then
  echo "  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error"
else
  echo "  $SUPPRESSED directive(s) found, named above, and this run FAILS because of"
  echo "  them. A suppressed instrument compiles clean and checks nothing, which is"
  echo "  the cheapest way to turn this gate green and the one R29's rationale"
  echo "  names outright. Fix the type, or — if it genuinely cannot be fixed now —"
  echo "  phase 5's waiver ledger is where an exclusion is allowed to live, in the"
  echo "  open, with an owner."
fi
echo

# ---------------------------------------------------------------------------
# 12 (report). PROFILE FIDELITY — the violations gathered during the loop.
# ---------------------------------------------------------------------------
echo "PROFILE FIDELITY — every diagnostic must be located under ${ACCEPTED_PREFIXES[*]}"
if [ "$FIDELITY" -eq 0 ]; then
  echo "  ok: 0 diagnostics outside ${ACCEPTED_PREFIXES[*]}, 0 unlocated diagnostics"
else
  printf '%s' "$FIDELITY_LOG"
  if [ "$HOSTILE_NAMES" -gt 0 ]; then
    cat <<EOF

  READ THIS FIRST: $HOSTILE_NAMES violation(s) above came from compiling a subject
  whose FILENAME contains a newline or a backslash. tsc prints the filename
  inside the diagnostic, so such a name splits or corrupts the diagnostic
  itself, and the location reported may be an artifact of the NAME rather than
  evidence about the profile. (Measured: a backslash makes tsc normalise the
  name into a directory separator and answer TS6053 "File … not found".)
  Rename that file and re-run before reading a single word of the paragraph
  below.
EOF
  fi
  cat <<EOF

  THE PROFILE IS WRONG, NOT THE APP. Do not edit forge-control-web/app or
  forge-control/src to make these go away. Both trees are green under
  \`cd forge-control-web && pnpm typecheck\`; if this gate disagrees with the
  app's own compiler about the app's own files, this gate is the broken one.
  Fix $PROFILE — start with its \`paths\` and its \`typeRoots\`, and re-run
  docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh, which
  must still reproduce census-G byte-for-byte afterwards.
  An unlocated diagnostic (no path, e.g. TS5083/TS6053) means the generated
  per-file config itself is bad — read $TMP/NNNN.json for the subject named.
  A diagnostic inside node_modules/ is a DEPENDENCY's declarations, reachable
  because the profile sets \`skipLibCheck: false\` on purpose (that is what
  makes a .d.ts SUBJECT get read at all). Upgrade or pin that dependency. Do
  NOT turn skipLibCheck back on: it restores red-team breach B1, in which a
  declaration file counted as compiled and was never read.
EOF
fi
echo

# ---------------------------------------------------------------------------
# 13. CENSUS — found vs compiled, compared in BOTH directions, each direction
#     with its own message (R12).
# ---------------------------------------------------------------------------
echo "CENSUS"
printf '  subjects found %d   subjects compiled %d   type failures %d   fidelity violations %d   missing %d   uncovered %d   suppressions %d\n' \
  "$FOUND" "$COMPILED" "$FAILED" "$FIDELITY" "$MISSING" "$UNCOVERED_COUNT" "$SUPPRESSED"

CENSUS_MISMATCH=0
if [ "$COMPILED" -lt "$FOUND" ]; then
  CENSUS_MISMATCH=1
  printf '  MISMATCH: compiled %d of %d subjects found — a subject was SKIPPED and this run certifies nothing.\n' \
    "$COMPILED" "$FOUND" >&2
elif [ "$COMPILED" -gt "$FOUND" ]; then
  CENSUS_MISMATCH=1
  printf '  MISMATCH: compiled %d but found only %d — the loop ran something the enumeration did not produce.\n' \
    "$COMPILED" "$FOUND" >&2
fi
echo "  wall clock       : $(( SECONDS - START_SECONDS ))s"
echo

# ---------------------------------------------------------------------------
# 14. VERDICT (R22). The word and the exit code agree. Exit 0 only if every
#     counter is zero.
# ---------------------------------------------------------------------------
if [ "$FAILED" -eq 0 ] && [ "$FIDELITY" -eq 0 ] && [ "$MISSING" -eq 0 ] \
   && [ "$CENSUS_MISMATCH" -eq 0 ] && [ "$UNCOVERED_COUNT" -eq 0 ] && [ "$SUPPRESSED" -eq 0 ]; then
  printf 'check-instrument-typecheck.sh PASSED — %d/%d subjects compiled clean.\n' \
    "$COMPILED" "$FOUND"
  exit 0
fi

printf 'check-instrument-typecheck.sh FAILED — %d type failure(s), %d fidelity violation(s), %d missing subject(s), %d uncovered file(s), %d suppression(s), census mismatch %d.\n' \
  "$FAILED" "$FIDELITY" "$MISSING" "$UNCOVERED_COUNT" "$SUPPRESSED" "$CENSUS_MISMATCH" >&2
exit 1
