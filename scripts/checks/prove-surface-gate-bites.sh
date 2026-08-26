#!/usr/bin/env bash
# prove-surface-gate-bites.sh — the TWO-SIDED mutation control for the
# gates-808 gate "project-tick.ts exported surface identical to main (a waiver
# covers content, never API)".
#
# WHY IT IS TWO-SIDED, and why one side alone would prove nothing. The gate as
# it landed on main at `b3c23ce` compared DECLARATION LINES:
#
#     grep -oE '^export (async function|function|const|type|interface|class) [A-Za-z0-9_]+'
#
# It caught a REMOVED declaration — its original job — and was blind to
# `export { somethingNew };`, which is the direction that matters under a
# content waiver: the API grows and the gate stays green. Round 6 of
# project/0a0806d3 replaced the greps with scripts/checks/exported-names.sh and
# a set comparison. A control that only showed the NEW gate going red on a
# removal would be indistinguishable from a rewrite that moved coverage
# sideways. So this script runs BOTH bodies against BOTH mutations:
#
#   mutation A — remove an export declaration   old RED   new RED   (kept)
#   mutation B — `export { somethingNew };`     old GREEN new RED   (gained)
#
# The GREEN in that table is the evidence. It is the old gate failing to see a
# surface that grew, executed rather than asserted, next to the new gate seeing
# it.
#
# THE MUTATION BASE IS main's OWN project-tick.ts, not this lane's. On this lane
# the old gate is ALREADY red — that is the false red round 6 also fixes (the
# lane moved `unintegratedWorkstreams`/`CloseGateTask` into lib/task-graph.ts
# and left `export { unintegratedWorkstreams, type CloseGateTask };` behind, 34
# declaration lines against main's 36, the same 36 names). A mutation measured
# from an already-red baseline discriminates nothing (fleet memory:
# gate5-raw-colours-red-at-main-from-week-board). So section 3 first writes
# `git show main:…project-tick.ts` over the subject, where BOTH bodies are
# green, and every later difference is caused by the mutation and nothing else.
# The lane's own false red is documented first, in section 2, before any write.
#
# THE NEW GATE BODY IS EXTRACTED FROM gates-808.sh BY NAME, never hand-copied —
# a hand-copy tests the transcription (fleet memory:
# prove-it-bites-is-the-mutation-control). The OLD body is frozen here as a
# heredoc because it is about to stop existing anywhere else: this lane replaces
# it on main at merge. Section 1 checks that frozen copy against main's real
# bytes while main still carries it, and says so explicitly once main does not.
#
# RESTORE IS `cp` FROM A BYTE COPY, VERIFIED BY sha256 — never `git checkout`
# (fleet memory: mutation-control-restore-must-not-use-git-checkout): the
# subject may carry uncommitted work and this script must be safe to run
# mid-edit. An EXIT trap is the net for every path that is not the happy one.
#
# ─────────────────────────────────────────────────────────────────────────
# HAND-RUN ONLY, and it must NEVER be added to gates-808.sh: it MUTATES an
# engine source file for a few seconds, so it belongs nowhere near a build
# another lane might share a worktree with, and a control wired into the shared
# suite makes that suite red for every project on the branch (fleet memory:
# shared-suite-gate-that-cannot-pass). Do not run it while a `pnpm test` or a
# typecheck of forge-control is in flight — the sibling run would read the
# mutated file (fleet memory: gates-808-unit-suite-flakes-under-sibling-contention).
#
# Needs no database, no network and no devDependencies: both gate bodies are
# git, grep, awk and diff.
#
# Run:  bash scripts/checks/prove-surface-gate-bites.sh
#
# Exit: 0 = every declared probe ran and both mutations landed where the table
#           above says. Anything else is non-zero; if the restore probe failed,
#           the message says so and the backup is kept.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="forge-control/src/lib/project-tick.ts"
GATES="scripts/checks/gates-808.sh"
EXTRACTOR="scripts/checks/exported-names.sh"

# The awk range that lifts the gate body out of gates-808.sh, and the same range
# applied to `git show main:` for the provenance probe. Both anchors are
# printed by section 1: an anchor that matches nothing sources an EMPTY string,
# which exits 0 and reads exactly like "the gate is green".
GATE_START='/^gate_sh "project-tick.ts exported surface/'
GATE_END='/exit 1"$/'

# The declaration this control removes. Chosen because it is a plain
# `export function` on both sides, unrelated to R70, and matched exactly once.
DECL_SITE='^export function workstreamKey('
DECL_NAME='workstreamKey'
ADDED_NAME='somethingNew'

# 17 = 3 extractor-contract probes, 2 provenance/extraction probes, 2 tip
# baselines (new green, old falsely red), 2 base baselines (both green on
# main's own bytes), 3 for mutation A (applied, new RED attributed, old RED
# attributed), 3 for mutation B (applied, new RED attributed, old GREEN — the
# blind spot), the sha-verified restore, and the green re-run at the tip.
EXPECTED_ASSERTIONS=17
assertions_run=0
assertions_failed=0

ok()   { assertions_run=$((assertions_run + 1)); printf '      ok   %s\n' "$1"; }
bad()  { assertions_run=$((assertions_run + 1)); assertions_failed=$((assertions_failed + 1))
         printf '      FAIL %s\n' "$1" >&2; }
assert() { if [ "$1" = "yes" ]; then ok "$2"; else bad "$2 — $3"; fi; }
yn()   { if [ "$1" -eq 0 ] 2>/dev/null; then echo yes; else echo no; fi; }

refuse() { printf 'REFUSING TO RUN: %s\n' "$1" >&2; exit 2; }

[ -f "$REPO_ROOT/$SUBJECT" ]   || refuse "$SUBJECT not found under $REPO_ROOT"
[ -f "$REPO_ROOT/$GATES" ]     || refuse "$GATES not found under $REPO_ROOT"
[ -f "$REPO_ROOT/$EXTRACTOR" ] || refuse "$EXTRACTOR not found — the new gate cannot run without it"
git -C "$REPO_ROOT" rev-parse --verify main >/dev/null 2>&1 \
  || refuse "no local ref 'main' — both gate bodies read \`git show main:\`"

# ── the two gate bodies ──────────────────────────────────────────────────────
NEW_GATE_SRC="$(awk "$GATE_START,$GATE_END" "$REPO_ROOT/$GATES")"

# FROZEN COPY of the pre-round-6 body, verbatim from main at b3c23ce. Kept
# because this lane replaces it: after the merge there is no other copy, and
# without one the contrast in the header stops being reproducible.
OLD_GATE_SRC="$(cat <<'FROZEN'
gate_sh "project-tick.ts exported surface identical to main (a waiver covers content, never API)" \
  "a=\$(git show main:forge-control/src/lib/project-tick.ts 2>/dev/null | grep -oE '^export (async function|function|const|type|interface|class) [A-Za-z0-9_]+' | sort); \
   b=\$(grep -oE '^export (async function|function|const|type|interface|class) [A-Za-z0-9_]+' forge-control/src/lib/project-tick.ts | sort); \
   if [ \"\$a\" = \"\$b\" ]; then echo 'exported surface identical'; exit 0; fi; \
   echo 'EXPORTED SURFACE CHANGED vs main:'; echo '--- main'; printf '%s\\n' \"\$a\"; echo '--- HEAD'; printf '%s\\n' \"\$b\"; exit 1"
FROZEN
)"

# Run one gate body the way gates-808.sh runs it — `bash -c "set -o pipefail; …"`
# from the repo root — and capture output to $2. Returns the gate's exit status.
run_gate() {
  local src="$1" out="$2"
  (
    cd "$REPO_ROOT" || exit 99
    gate_sh() { bash -c "set -o pipefail; $2"; }
    eval "$src"
  ) > "$out" 2>&1
}

BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prove-surface-gate.XXXXXX")"
RESTORED=unneeded

cleanup() {
  if [ "$RESTORED" = no ] && [ -f "$BACKUP_DIR/project-tick.ts" ]; then
    cp "$BACKUP_DIR/project-tick.ts" "$REPO_ROOT/$SUBJECT"
    printf '\n  (EXIT trap restored %s from %s)\n' "$SUBJECT" "$BACKUP_DIR" >&2
  fi
  rm -f "$BACKUP_DIR"/*.ts "$BACKUP_DIR"/*.log "$BACKUP_DIR"/*.err 2>/dev/null
  rmdir "$BACKUP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== prove-surface-gate-bites.sh — build identity ============================="
echo "  repo worktree     : $REPO_ROOT"
echo "  git HEAD          : $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '<no git>')"
echo "  git branch        : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<no git>')"
echo "  local main        : $(git -C "$REPO_ROOT" rev-parse --short main)"
echo "  subject           : $SUBJECT"
echo "  gate suite        : $GATES"
echo "  awk range         : $GATE_START,$GATE_END"
echo "  backup dir        : $BACKUP_DIR"
echo "  expected probes   : $EXPECTED_ASSERTIONS"
echo "=============================================================================="
echo

echo "--- 0. the extractor's contract, on a fixture that names every form ----------"
FIXTURE="$BACKUP_DIR/forms.ts"
cat > "$FIXTURE" <<'FORMS'
export function f(a: string): void {}
export async function g() {}
export const c = 1;
export let l = 2;
export var v = 3;
export class C {}
export abstract class A {}
export interface I { x: number }
export type T = string;
export enum E { a }
export declare function d(): void;
export namespace N {}
export { a, type B };
export { x as y };
export type { T2 };
export { z } from "./m";
export * as ns from "./m";
export * from "./other";
export default class Foo {}
export {
  multi,
  type Line,
  aliased as renamed,
};
FORMS
EXPECT_NAMES='*from:./other
A
B
C
E
I
Line
N
T
T2
a
c
d
default
f
g
l
multi
ns
renamed
v
y
z'
got_names="$(bash "$REPO_ROOT/$EXTRACTOR" "$FIXTURE" 2>"$BACKUP_DIR/forms.err")"
assert "$([ "$got_names" = "$EXPECT_NAMES" ] && echo yes || echo no)" \
  "exported-names.sh resolves all 23 export forms to the names a consumer imports" \
  "set differs; an alias must resolve to its right-hand side and a star to its module. diff:
$(diff <(printf '%s\n' "$EXPECT_NAMES") <(printf '%s\n' "$got_names") | sed 's/^/        /')"
printf 'export weird thing;\n' > "$BACKUP_DIR/bad.ts"
bash "$REPO_ROOT/$EXTRACTOR" "$BACKUP_DIR/bad.ts" >/dev/null 2>&1; bad_rc=$?
assert "$(yn "$([ "$bad_rc" != 0 ] && echo 0 || echo 1)")" \
  "an \`export\` form it does not understand is a hard error, not a skipped line" \
  "exit $bad_rc — a surface instrument that silently drops what it cannot parse is the defect it was written to fix"
printf 'export {\n  a,\n' > "$BACKUP_DIR/unterm.ts"
bash "$REPO_ROOT/$EXTRACTOR" "$BACKUP_DIR/unterm.ts" >/dev/null 2>&1; unterm_rc=$?
assert "$(yn "$([ "$unterm_rc" != 0 ] && echo 0 || echo 1)")" \
  "an unterminated multi-line \`export {\` block is a hard error" \
  "exit $unterm_rc — a truncated block would silently drop every name in it"
echo

echo "--- 1. both gate bodies are the REAL bytes -----------------------------------"
assert "$([ -n "$NEW_GATE_SRC" ] && printf '%s' "$NEW_GATE_SRC" | grep -q "$EXTRACTOR" && echo yes || echo no)" \
  "the new gate body was extracted from $GATES and invokes $EXTRACTOR" \
  "the awk range matched nothing or matched the wrong gate — an empty range sources an empty string, which exits 0 and reads as 'green'"
MAIN_GATE_SRC="$(git -C "$REPO_ROOT" show main:"$GATES" 2>/dev/null | awk "$GATE_START,$GATE_END")"
if printf '%s' "$MAIN_GATE_SRC" | grep -q "grep -oE '\^export (async function"; then
  assert "$([ "$MAIN_GATE_SRC" = "$OLD_GATE_SRC" ] && echo yes || echo no)" \
    "the frozen OLD body is byte-identical to the one main still carries" \
    "main's gate body has drifted from the copy frozen here; re-freeze it before trusting the contrast. diff:
$(diff <(printf '%s\n' "$OLD_GATE_SRC") <(printf '%s\n' "$MAIN_GATE_SRC") | sed 's/^/        /')"
  echo "      (main still carries the declaration-line body — provenance checked against it)"
else
  assert "$(printf '%s' "$MAIN_GATE_SRC" | grep -q "$EXTRACTOR" && echo yes || echo no)" \
    "main has taken this lane's replacement, so the frozen OLD body is archival by design" \
    "main carries NEITHER the declaration-line body NOR the extractor — the gate this control is about is not on main at all, and the contrast below is being measured against nothing"
  echo "      (post-merge: the declaration-line body exists only in the heredoc above)"
fi
echo

echo "--- 2. THE LANE'S OWN FALSE RED, before anything is written -------------------"
run_gate "$NEW_GATE_SRC" "$BACKUP_DIR/tip-new.log"; tip_new=$?
assert "$(yn "$tip_new")" \
  "the NEW gate is GREEN at this lane's tip (the re-export resolves to the same 36 names)" \
  "exit $tip_new — output: $BACKUP_DIR/tip-new.log
$(sed 's/^/        /' "$BACKUP_DIR/tip-new.log")"
run_gate "$OLD_GATE_SRC" "$BACKUP_DIR/tip-old.log"; tip_old=$?
tip_old_names=$(sed -n '/^--- main$/,/^--- HEAD$/p' "$BACKUP_DIR/tip-old.log" | grep -cE 'unintegratedWorkstreams|CloseGateTask')
assert "$([ "$tip_old" != 0 ] && [ "$tip_old_names" = 2 ] && echo yes || echo no)" \
  "the OLD gate is RED at the same tip, naming exactly the two moved declarations" \
  "exit $tip_old with $tip_old_names of the two names on the main-only side — the false red this round fixes is not reproducing, so the rest of this control is measuring something else"
echo "      old-gate main-only names: $(sed -n '/^--- main$/,/^--- HEAD$/p' "$BACKUP_DIR/tip-old.log" | grep -oE 'unintegratedWorkstreams|CloseGateTask' | tr '\n' ' ')"
echo

echo "--- 3. MUTATION BASE: write main's own project-tick.ts over the subject -------"
cp "$REPO_ROOT/$SUBJECT" "$BACKUP_DIR/project-tick.ts"
SUBJECT_SHA=$(sha256sum "$BACKUP_DIR/project-tick.ts" | cut -d' ' -f1)
RESTORED=no
echo "      sha256($SUBJECT) = ${SUBJECT_SHA:0:16}…  (backed up first)"
git -C "$REPO_ROOT" show main:"$SUBJECT" > "$BACKUP_DIR/base.ts" || refuse "git show main:$SUBJECT failed"
site_hits=$(grep -c "$DECL_SITE" "$BACKUP_DIR/base.ts")
if [ "$site_hits" != 1 ]; then
  echo "  ABORTING before any further write: '$DECL_SITE' matches $site_hits times in main's copy," >&2
  echo "  expected 1. A mutation that mutates nothing is a control that cannot fail." >&2
  cp "$BACKUP_DIR/project-tick.ts" "$REPO_ROOT/$SUBJECT"; RESTORED=yes
  exit 1
fi
cp "$BACKUP_DIR/base.ts" "$REPO_ROOT/$SUBJECT"
run_gate "$NEW_GATE_SRC" "$BACKUP_DIR/base-new.log"; base_new=$?
run_gate "$OLD_GATE_SRC" "$BACKUP_DIR/base-old.log"; base_old=$?
assert "$(yn "$base_new")" \
  "on main's own bytes the NEW gate is GREEN" \
  "exit $base_new — the base is not neutral; every difference below would be unattributable. Output: $BACKUP_DIR/base-new.log"
assert "$(yn "$base_old")" \
  "on main's own bytes the OLD gate is GREEN — the neutral baseline the contrast needs" \
  "exit $base_old — the old body is red on main against main, which cannot be a mutation effect. Output: $BACKUP_DIR/base-old.log"
echo

echo "--- 4. MUTATION A — remove an export declaration ------------------------------"
# `export function workstreamKey(` -> `function workstreamKey(`. The symbol
# stops being exported; nothing else about the file changes.
sed "s|$DECL_SITE|function ${DECL_NAME}(|" "$BACKUP_DIR/base.ts" > "$REPO_ROOT/$SUBJECT"
mut_a_sha=$(sha256sum "$REPO_ROOT/$SUBJECT" | cut -d' ' -f1)
base_sha=$(sha256sum "$BACKUP_DIR/base.ts" | cut -d' ' -f1)
still=$(grep -c "$DECL_SITE" "$REPO_ROOT/$SUBJECT")
assert "$([ "$mut_a_sha" != "$base_sha" ] && [ "$still" = 0 ] && echo yes || echo no)" \
  "mutation A really applied: \`export function $DECL_NAME(\` is gone from the file on disk" \
  "sha unchanged or the declaration is still there ($still hits) — the RED below would be meaningless"
run_gate "$NEW_GATE_SRC" "$BACKUP_DIR/a-new.log"; a_new=$?
assert "$([ "$a_new" != 0 ] && grep -qE "^< +$DECL_NAME\$" "$BACKUP_DIR/a-new.log" && echo yes || echo no)" \
  "NEW gate RED, attributed to '$DECL_NAME' missing from HEAD" \
  "exit $a_new and no '< $DECL_NAME' line — a red from somewhere else is not evidence about this term. Output: $BACKUP_DIR/a-new.log"
run_gate "$OLD_GATE_SRC" "$BACKUP_DIR/a-old.log"; a_old=$?
a_old_main=$(sed -n '/^--- main$/,/^--- HEAD$/p' "$BACKUP_DIR/a-old.log" | grep -c "function $DECL_NAME\$")
a_old_head=$(sed -n '/^--- HEAD$/,$p'          "$BACKUP_DIR/a-old.log" | grep -c "function $DECL_NAME\$")
assert "$([ "$a_old" != 0 ] && [ "$a_old_main" = 1 ] && [ "$a_old_head" = 0 ] && echo yes || echo no)" \
  "OLD gate RED on the same mutation — REMOVAL COVERAGE IS KEPT, not moved" \
  "exit $a_old, name on main side $a_old_main, on HEAD side $a_old_head — if the old body no longer catches a removal, the rewrite traded one blind spot for another. Output: $BACKUP_DIR/a-old.log"
sed -n 's/^/      new: /p' <(grep -E '^[<>] ' "$BACKUP_DIR/a-new.log")
echo

echo "--- 5. MUTATION B — add an export the OLD body cannot see ---------------------"
cp "$BACKUP_DIR/base.ts" "$REPO_ROOT/$SUBJECT"
printf '\nexport { %s };\n' "$ADDED_NAME" >> "$REPO_ROOT/$SUBJECT"
mut_b_sha=$(sha256sum "$REPO_ROOT/$SUBJECT" | cut -d' ' -f1)
added=$(grep -c "^export { $ADDED_NAME };\$" "$REPO_ROOT/$SUBJECT")
assert "$([ "$mut_b_sha" != "$base_sha" ] && [ "$added" = 1 ] && echo yes || echo no)" \
  "mutation B really applied: one \`export { $ADDED_NAME };\` line is on disk" \
  "sha unchanged or $added such lines — the comparison below would be meaningless"
run_gate "$NEW_GATE_SRC" "$BACKUP_DIR/b-new.log"; b_new=$?
assert "$([ "$b_new" != 0 ] && grep -qE "^> +$ADDED_NAME\$" "$BACKUP_DIR/b-new.log" && echo yes || echo no)" \
  "NEW gate RED, attributed to '$ADDED_NAME' appearing on HEAD — THE COVERAGE THAT WAS GAINED" \
  "exit $b_new and no '> $ADDED_NAME' line — the whole point of the rewrite is that a GROWING surface goes red. Output: $BACKUP_DIR/b-new.log"
run_gate "$OLD_GATE_SRC" "$BACKUP_DIR/b-old.log"; b_old=$?
assert "$(yn "$b_old")" \
  "OLD gate GREEN on the very same mutation — the blind spot, executed" \
  "exit $b_old — the old body DID see this, so the claim that the rewrite is a strengthening is wrong and this whole comment needs rewriting, not the gate. Output: $BACKUP_DIR/b-old.log"
echo "      old gate said: $(head -1 "$BACKUP_DIR/b-old.log")"
sed -n 's/^/      new: /p' <(grep -E '^[<>] ' "$BACKUP_DIR/b-new.log")
echo

echo "--- 6. RESTORE by cp, verified by sha256 -------------------------------------"
cp "$BACKUP_DIR/project-tick.ts" "$REPO_ROOT/$SUBJECT"
back_sha=$(sha256sum "$REPO_ROOT/$SUBJECT" | cut -d' ' -f1)
if [ "$back_sha" = "$SUBJECT_SHA" ]; then
  RESTORED=yes
  ok "$SUBJECT restored byte-for-byte (sha256 matches the pre-mutation copy)"
else
  bad "RESTORE FAILED — $SUBJECT is NOT back to its original bytes. The copy is in $BACKUP_DIR and this script will NOT delete it."
  trap - EXIT
  echo "  original kept at: $BACKUP_DIR/project-tick.ts" >&2
  exit 1
fi
echo

echo "--- 7. GREEN again at the tip: the restore left no scar ----------------------"
run_gate "$NEW_GATE_SRC" "$BACKUP_DIR/tip-new-again.log"; tip_again=$?
assert "$(yn "$tip_again")" \
  "the NEW gate is GREEN again at the lane tip" \
  "exit $tip_again — the worktree is not back where it started. Output: $BACKUP_DIR/tip-new-again.log"
echo "      $(head -1 "$BACKUP_DIR/tip-new-again.log")"
echo

echo "=== summary =================================================================="
echo "  probes run    : $assertions_run (expected $EXPECTED_ASSERTIONS)"
echo "  probes failed : $assertions_failed"
if [ "$assertions_run" != "$EXPECTED_ASSERTIONS" ]; then
  echo "  PROBE COUNT MISMATCH: a control whose probes miss must fail, not certify itself." >&2
  exit 1
fi
if [ "$assertions_failed" != 0 ]; then
  echo "  FAILED — the surface gate's coverage is not what this script claims." >&2
  exit 1
fi
echo "  BITES — removal: old RED / new RED (kept).  addition: old GREEN / new RED (gained)."
exit 0
