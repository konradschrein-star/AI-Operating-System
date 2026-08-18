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
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) A GREEN RUN OVER AN EMPTY SUBJECT LIST. A glob that matches nothing, a
#       moved directory, a `cd` that failed, an enumeration whose error was
#       swallowed. Guarded three ways: the enumeration subshell's failure is a
#       refusal rather than an empty list (no `2>/dev/null`, no `ls`); zero
#       subjects is a refusal, not a pass ("a gate over nothing certifies
#       nothing", R13); and the closing census compares subjects FOUND against
#       subjects COMPILED in both directions.
#   (b) A SUBJECT PRESENT ON DISK BUT NEVER COMPILED — now STRUCTURAL rather
#       than a per-entry existence test. The loop cannot skip: a subject that
#       vanishes between enumeration and compilation is recorded MISSING, by
#       name, does NOT increment the compiled counter, and therefore also trips
#       the census (R19). There is no branch in which a subject is passed over
#       quietly.
#   (c) A NEW INSTRUMENT THAT NEVER JOINED THE LIST — SUPERSEDED. There is no
#       list. `scripts/checks/check-whatever.ts` is compiled the moment it
#       exists, by construction. This is the failure mode the round-800 gate
#       needed its manifest guard to catch and this one catches structurally.
#   (d) `tsc: not found`, disclosed and ignored. A gate whose first response is
#       an error is a gate reviewers learn to skip (the precedent is §3.2's
#       phase-6 precondition block). Guarded by refusing, non-zero, with the
#       exact install line printed — and that line carries `--prod=false`,
#       because under this environment's exported `NODE_ENV=production` a plain
#       `pnpm install --frozen-lockfile` says "skipping devDependencies"
#       quietly, EXITS 0, and REMOVES the compiler. A refusal that printed the
#       plain line would teach the trap instead of the fix (R17, R18, C3).
#   (e) A PASS THAT WAS NEVER OBSERVED FAILING. Guarded outside this file: the
#       four negative controls — a broken type in a covered instrument, a NEW
#       type-broken file added to the directory and listed nowhere, a tree with
#       no `forge-control-web/node_modules`, and `typeRoots` removed from the
#       profile — are phase 4's deliverable in
#       `docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`.
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
#
# Usage:  bash scripts/checks/check-instrument-typecheck.sh
# Exit:   0 = every subject found on disk compiled clean, with zero profile
#             fidelity violations, zero missing subjects and a reconciled
#             census. Any other outcome is non-zero and says which counter.
#
set -euo pipefail
trap 'rc=$?; printf "check-instrument-typecheck.sh: ABORTED at line %s (exit %s) — this run is NOT a pass.\n" "$LINENO" "$rc" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# ═══════════════════════════════════════════════════════════════════════════
# THE TWO VARIABLES A SUCCESSOR PROJECT EDITS (02-architecture.md §7).
# Do not inline either of these at its point of use.
# ═══════════════════════════════════════════════════════════════════════════
SUBJECT_GLOBS=( "scripts/checks/*.ts" "scripts/checks/*.tsx" )   # repo-relative
PROFILE="$REPO_ROOT/tsconfig.checks-instruments.json"
# ═══════════════════════════════════════════════════════════════════════════

# The TS-family extensions this gate does NOT compile. R10: a future instrument
# arriving as .mts or .cts must be NAMED as uncovered, never omitted silently.
# Computed as a set difference against SUBJECT_GLOBS, so extending the globs
# above automatically shrinks this list rather than double-reporting.
UNCOVERED_GLOBS=( "scripts/checks/*.mts" "scripts/checks/*.cts" )

WEB="$REPO_ROOT/forge-control-web"
TSC="$WEB/node_modules/.bin/tsc"

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
# 5. ENUMERATION — the glob, expanded from REPO_ROOT, LC_ALL=C so the order
#    does not depend on the reviewer's locale, `nullglob` so an unmatched glob
#    VANISHES instead of passing through literally and being handed to tsc as a
#    filename. This is phase 1's proven enumeration
#    (`evidence/reproduce-census.sh`), widened to take its patterns from
#    SUBJECT_GLOBS.
#
#    NUL-separated, through a file rather than a command substitution, because
#    command substitution drops NUL bytes: a filename containing a newline
#    would otherwise arrive as two subjects. No `ls`. No `2>/dev/null`. A
#    failure to enumerate is a refusal, not an empty subject list.
# ---------------------------------------------------------------------------
if ! LC_ALL=C bash -c '
      cd "$1" || exit 1
      shift
      shopt -s nullglob
      for g in "$@"; do
        for f in $g; do printf "%s\0" "$f"; done
      done
    ' _ "$REPO_ROOT" "${SUBJECT_GLOBS[@]}" > "$TMP/subjects.nul"; then
  echo "REFUSING TO RUN: could not enumerate subjects under $REPO_ROOT" >&2
  echo "  globs: ${SUBJECT_GLOBS[*]}" >&2
  echo "  An enumeration that failed is not an empty directory, and this gate" >&2
  echo "  will not report one as the other." >&2
  exit 1
fi

SUBJECTS=()
while IFS= read -r -d '' subject; do
  SUBJECTS+=("$subject")
done < "$TMP/subjects.nul"

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
# 7. UNCOVERED-EXTENSION SCAN (R10). Presence alone does not fail the run —
#    naming it is what R10 requires, because the defect R10 exists against is
#    SILENCE, not the file. A .mts instrument is a legitimate thing to write;
#    an uncompiled instrument nobody was told about is not. Printed here,
#    above the verdict, so a PASS is never issued with uncovered files
#    off-screen.
# ---------------------------------------------------------------------------
UNCOVERED=()
if ! LC_ALL=C bash -c '
      cd "$1" || exit 1
      shift
      shopt -s nullglob
      for g in "$@"; do
        for f in $g; do printf "%s\0" "$f"; done
      done
    ' _ "$REPO_ROOT" "${UNCOVERED_GLOBS[@]}" > "$TMP/uncovered.nul"; then
  echo "REFUSING TO RUN: could not scan for uncovered extensions under $REPO_ROOT" >&2
  echo "  globs: ${UNCOVERED_GLOBS[*]}" >&2
  exit 1
fi

while IFS= read -r -d '' candidate; do
  enumerated=0
  for subject in "${SUBJECTS[@]}"; do
    if [ "$subject" = "$candidate" ]; then enumerated=1; break; fi
  done
  if [ "$enumerated" -eq 0 ]; then UNCOVERED+=("$candidate"); fi
done < "$TMP/uncovered.nul"

echo "UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile"
if [ ${#UNCOVERED[@]} -eq 0 ]; then
  echo "  none: no file matches ${UNCOVERED_GLOBS[*]}"
else
  for candidate in "${UNCOVERED[@]}"; do
    printf '  UNCOVERED %s — matched by %s, not by %s\n' \
      "$candidate" "${UNCOVERED_GLOBS[*]}" "${SUBJECT_GLOBS[*]}"
  done
  echo "  These are NOT compiled and NOT counted below. Naming them is R10; if one"
  echo "  is a real instrument, add its extension to SUBJECT_GLOBS at the top of"
  echo "  this script — that is the only edit required."
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
echo "  tsc              : $("$TSC" --version)  ($TSC)"
echo "  node             : $(node --version)"
echo "  subjects found   : $FOUND"
echo "  invocation       : (cd \$REPO_ROOT && \$TSC -p \$TMP/NNNN.json --pretty false)  # one file per invocation"
echo "  temp dir         : $TMP"
echo

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

COMPILED=0
FAILED=0
MISSING=0
FIDELITY=0
FIDELITY_LOG=""

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
#     Paths are compared against the `scripts/checks/` PREFIX, which is only
#     meaningful because tsc prints diagnostic paths relative to ITS OWN cwd
#     and the compile below pins that cwd to REPO_ROOT. Measured at round 200,
#     tsc 5.7.2, same generated config, same subject:
#       from the repo root : scripts/checks/check-orientation.ts(129,38): error TS2322: …
#       from /tmp          : ../opt/ai-os/workspace/…/scripts/checks/check-orientation.ts(129,38): …
#     An inherited cwd would therefore make every diagnostic look like a
#     fidelity violation for the reviewer who ran the gate from somewhere else,
#     and I6/A2.6 demands an identical verdict from any cwd.
# ---------------------------------------------------------------------------
scan_fidelity() {
  local subject="$1" out="$2" line diag_path
  if [ -z "$out" ]; then return 0; fi
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    if [[ "$line" =~ $DIAG_RE ]]; then
      diag_path="${BASH_REMATCH[1]}"
      case "$diag_path" in
        scripts/checks/*)
          : # located inside the subject directory — the expected shape
          ;;
        *)
          FIDELITY=$((FIDELITY + 1))
          FIDELITY_LOG+="  while compiling $subject: diagnostic located OUTSIDE scripts/checks/"$'\n'
          FIDELITY_LOG+="    $line"$'\n'
          ;;
      esac
    elif [[ "$line" == *"error TS"* ]]; then
      FIDELITY=$((FIDELITY + 1))
      FIDELITY_LOG+="  while compiling $subject: diagnostic with NO parseable path — a config-level error"$'\n'
      FIDELITY_LOG+="    $line"$'\n'
    fi
  done <<< "$out"
  return 0
}

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
# ---------------------------------------------------------------------------
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

  cfg="$(printf '%s/%04d.json' "$TMP" "$index")"
  printf '{ "extends": "%s",\n  "files":   ["%s"] }\n' \
    "$(json_escape "$PROFILE")" "$(json_escape "$abs")" > "$cfg"

  # tsc exits non-zero on diagnostics, which is the expected case for six of
  # the 42 today. Its status is captured through `if`, never through `set +e`,
  # and never discarded. The subshell of the command substitution is where the
  # cwd is pinned to REPO_ROOT.
  if OUT="$( cd "$REPO_ROOT" && "$TSC" -p "$cfg" --pretty false 2>&1 )"; then
    rc=0
  else
    rc=$?
  fi
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
# 12 (report). PROFILE FIDELITY — the violations gathered during the loop.
# ---------------------------------------------------------------------------
echo "PROFILE FIDELITY — every diagnostic must be located under scripts/checks/"
if [ "$FIDELITY" -eq 0 ]; then
  echo "  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics"
else
  printf '%s' "$FIDELITY_LOG"
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
EOF
fi
echo

# ---------------------------------------------------------------------------
# 13. CENSUS — found vs compiled, compared in BOTH directions, each direction
#     with its own message (R12).
# ---------------------------------------------------------------------------
echo "CENSUS"
printf '  subjects found %d   subjects compiled %d   type failures %d   fidelity violations %d   missing %d\n' \
  "$FOUND" "$COMPILED" "$FAILED" "$FIDELITY" "$MISSING"

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
if [ "$FAILED" -eq 0 ] && [ "$FIDELITY" -eq 0 ] && [ "$MISSING" -eq 0 ] && [ "$CENSUS_MISMATCH" -eq 0 ]; then
  printf 'check-instrument-typecheck.sh PASSED — %d/%d subjects compiled clean.\n' \
    "$COMPILED" "$FOUND"
  exit 0
fi

printf 'check-instrument-typecheck.sh FAILED — %d type failure(s), %d fidelity violation(s), %d missing subject(s), census mismatch %d.\n' \
  "$FAILED" "$FIDELITY" "$MISSING" "$CENSUS_MISMATCH" >&2
exit 1
