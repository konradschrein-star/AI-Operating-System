#!/usr/bin/env bash
#
# check-instrument-typecheck.sh — UNIVERSAL GATE ITEM 9 (`03-quality.md` §3.1).
# Compiles every instrument named in `scripts/checks/instrument-manifest.txt`,
# one file per invocation, and refuses to let a new instrument escape the gate.
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
# WHY MANIFEST-SCOPED AND NOT DIRECTORY-WIDE — MEASURED AT ROUND 800, and this
# is standing rule 2 applied rather than quoted. A gate over all 25
# `scripts/checks/*.ts` cannot pass on this tree and cannot be made to pass by
# this project: compiled together they drag `forge-control-web/app` into the
# program (DOM-lib failures in `useAutogrow.ts` and `tokens.ts`), and three other
# projects' scripts are independently red (`check-orientation.ts`,
# `serve-sse-808.ts`, `check-chat-rich.tsx`). An unsatisfiable gate teaches
# reviewers that disclose-and-proceed is normal, which is exactly the habit
# §3.1's other items exist to break. So the gate covers what this branch OWNS —
# and GROWS BY CONSTRUCTION through the manifest guard below.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) A GREEN RUN OVER AN EMPTY MANIFEST. A glob that matches nothing, a
#       manifest whose entries are all comments, a file read that silently
#       failed. Guarded by the closing census — entries declared vs entries
#       COMPILED, compared in both directions — and by refusing outright when
#       the manifest resolves to zero entries.
#   (b) AN ENTRY THAT DOES NOT EXIST ON DISK, quietly skipped. `tsc` on a
#       missing file is a confusing error, and a skip is worse. Guarded by an
#       explicit existence test per entry that FAILS rather than continues.
#   (c) A NEW INSTRUMENT THAT NEVER JOINED THE MANIFEST. This is the failure
#       mode the gate exists for: the next builder adds `check-something.ts`,
#       nobody adds the line, and the hole reopens under a green gate. Guarded
#       by the manifest guard — every `scripts/checks/*.ts` this branch added or
#       modified must appear in the manifest, by name.
#   (d) `tsc: not found`, disclosed and ignored. A gate whose first response is
#       an error is a gate reviewers learn to skip (the precedent is §3.2's
#       phase-6 precondition block). Guarded by refusing, non-zero, with the
#       exact install line printed.
#   (e) A PASS THAT WAS NEVER OBSERVED FAILING. Guarded outside this file: the
#       three deliberate breakages — a broken type in a manifested file, an
#       entry removed while the file is still in the branch diff, and a tree
#       with no `forge-control-web/node_modules` — are transcribed in
#       `docs/plan/engine-task-graph/evidence/phase8-tooling.md`.
#
# Usage:  bash scripts/checks/check-instrument-typecheck.sh
# Exit:   0 = every manifested entry compiled clean AND the manifest covers
#             everything this branch touched under scripts/checks/*.ts.
#
set -euo pipefail
trap 'rc=$?; [ $rc -ne 0 ] && echo "check-instrument-typecheck.sh: ABORTED at line $LINENO (exit $rc) — NOT a pass" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
MANIFEST="$REPO_ROOT/scripts/checks/instrument-manifest.txt"
WEB="$REPO_ROOT/forge-control-web"

# The compile options, verbatim from the round-800 measurement recorded in
# `instrument-manifest.txt`. They live in one array so the transcript can print
# the exact command it ran rather than a description of it.
TSC_OPTS=(
  --noEmit --strict --target ES2022 --module esnext
  --moduleResolution bundler --allowImportingTsExtensions
  --types node --lib ES2022
)

[ -f "$MANIFEST" ] || {
  echo "REFUSING TO RUN: no manifest at $MANIFEST" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# (d) THE TOOLCHAIN PRECONDITION. Refuse loudly, with the fix, rather than
#     letting `tsc: not found` become the gate's answer.
# ---------------------------------------------------------------------------
if [ ! -d "$WEB/node_modules" ] || [ ! -x "$WEB/node_modules/.bin/tsc" ]; then
  cat >&2 <<EOF
REFUSING TO RUN: forge-control-web/node_modules is absent (or carries no tsc).

  looked in: $WEB/node_modules/.bin/tsc

This worktree ships WITHOUT forge-control-web/node_modules — it is gitignored —
so a fresh worktree has no compiler and this gate would otherwise answer
"tsc: not found", which is how a gate gets disclosed and ignored. Fix it with
exactly this line (measured at round 221: ~1s offline from the local pnpm
store), then re-run:

  cd forge-control-web && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline

Keep --frozen-lockfile: it is what guarantees NFU8's
\`git diff main -- forge-control-web/package.json\` stays empty.
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# Read the manifest. Comments and blank lines out; everything else is an entry.
# ---------------------------------------------------------------------------
ENTRIES=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$line" ] && ENTRIES+=("$line")
done < "$MANIFEST"

DECLARED=${#ENTRIES[@]}
COMPILED=0
FAILED=0

# ---------------------------------------------------------------------------
# 0. PROVENANCE — before any verdict. A harness that does not expose its own
#    build identity is not evidence (standing rule 3).
# ---------------------------------------------------------------------------
echo "check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)"
echo
echo "PROVENANCE"
echo "  worktree path    : $REPO_ROOT"
echo "  git HEAD         : $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo no-git)"
echo "  git branch       : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo no-git)"
echo "  this check sha256: $(sha256sum "$SELF" | cut -d' ' -f1)"
echo "  manifest         : $MANIFEST"
echo "  manifest sha256  : $(sha256sum "$MANIFEST" | cut -d' ' -f1)"
echo "  manifest entries : $DECLARED"
echo "  tsc              : $("$WEB/node_modules/.bin/tsc" --version)"
echo "  node             : $(node --version)"
echo "  options          : ${TSC_OPTS[*]}"
echo

if [ "$DECLARED" -eq 0 ]; then
  echo "REFUSING TO RUN: the manifest resolves to ZERO entries — a gate over nothing" >&2
  echo "certifies nothing, and would report a clean run for a directory it never read." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. COMPILE — one file per invocation. Compiling them together is what pulls
#    forge-control-web/app into the program; see the header.
# ---------------------------------------------------------------------------
echo "TYPECHECK — one invocation per entry"
for entry in "${ENTRIES[@]}"; do
  abs="$REPO_ROOT/$entry"
  if [ ! -f "$abs" ]; then
    printf '  FAIL %-52s %s\n' "$entry" "manifested but ABSENT from disk at $abs"
    FAILED=$((FAILED + 1))
    COMPILED=$((COMPILED + 1))
    continue
  fi
  OUT="$( (cd "$WEB" && npx tsc "${TSC_OPTS[@]}" "../$entry") 2>&1 )" && RC=0 || RC=$?
  COMPILED=$((COMPILED + 1))
  if [ "$RC" -eq 0 ]; then
    printf '  PASS %-52s %s\n' "$entry" "exit 0, 0 errors"
  else
    printf '  FAIL %-52s %s\n' "$entry" "exit $RC"
    printf '%s\n' "$OUT" | sed 's/^/         /'
    FAILED=$((FAILED + 1))
  fi
done
echo

# ---------------------------------------------------------------------------
# 2. THE MANIFEST GUARD — (c). A file this branch added or modified is a file
#    this branch is responsible for compiling.
#
#    `--diff-filter=ACMR` deliberately EXCLUDES deletions: a file this branch
#    DELETED cannot be compiled, and demanding it be manifested would be an
#    unsatisfiable gate of exactly the kind standing rule 2 forbids. Renames are
#    reported at their new path, which is the path that must be manifested.
# ---------------------------------------------------------------------------
echo "MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested"
MERGE_BASE="$(git -C "$REPO_ROOT" merge-base main HEAD 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  echo "  REFUSING: could not compute 'git merge-base main HEAD' in $REPO_ROOT." >&2
  echo "  Without it the guard would compare against nothing and pass vacuously." >&2
  exit 1
fi
echo "  merge-base       : $MERGE_BASE"

TOUCHED="$(git -C "$REPO_ROOT" diff --name-only --diff-filter=ACMR \
  "$MERGE_BASE"..HEAD -- 'scripts/checks/*.ts' || true)"
if [ -z "$TOUCHED" ]; then
  echo "  this branch touched no scripts/checks/*.ts — guard vacuous but reported"
else
  echo "  touched by this branch:"
  printf '%s\n' "$TOUCHED" | sed 's/^/    /'
fi

UNMANIFESTED=0
while IFS= read -r touched; do
  [ -n "$touched" ] || continue
  found=0
  for entry in "${ENTRIES[@]}"; do
    [ "$entry" = "$touched" ] && found=1 && break
  done
  if [ "$found" -eq 0 ]; then
    printf '  FAIL %-52s %s\n' "$touched" "MODIFIED BY THIS BRANCH AND ABSENT FROM THE MANIFEST"
    UNMANIFESTED=$((UNMANIFESTED + 1))
  fi
done <<< "$TOUCHED"

if [ "$UNMANIFESTED" -eq 0 ]; then
  echo "  ok: every touched instrument is manifested"
else
  echo "  add the $UNMANIFESTED file(s) named above to $MANIFEST and make them compile." >&2
fi
echo

# ---------------------------------------------------------------------------
# 3. CENSUS — (a) and (b). Differ in either direction and this exits non-zero.
# ---------------------------------------------------------------------------
echo "CENSUS"
printf '  entries declared %d   entries compiled %d   failures %d   unmanifested %d\n' \
  "$DECLARED" "$COMPILED" "$FAILED" "$UNMANIFESTED"

STATUS=0
if [ "$COMPILED" -ne "$DECLARED" ]; then
  printf 'check-instrument-typecheck.sh FAILED: compiled %d entries, declared %d.\n' \
    "$COMPILED" "$DECLARED" >&2
  printf '  fewer => an entry was skipped and this run certifies nothing.\n' >&2
  printf '  more  => the loop ran an entry the manifest does not declare.\n' >&2
  STATUS=1
fi
[ "$FAILED" -eq 0 ] || STATUS=1
[ "$UNMANIFESTED" -eq 0 ] || STATUS=1

if [ "$STATUS" -ne 0 ]; then
  printf '\ncheck-instrument-typecheck.sh FAILED — %d type failure(s), %d unmanifested file(s).\n' \
    "$FAILED" "$UNMANIFESTED" >&2
  exit 1
fi

printf '\ncheck-instrument-typecheck.sh PASSED — %d/%d entries compiled clean, manifest complete.\n' \
  "$COMPILED" "$DECLARED"
