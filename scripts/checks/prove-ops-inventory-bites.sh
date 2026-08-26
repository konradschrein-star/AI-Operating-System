#!/usr/bin/env bash
# prove-ops-inventory-bites.sh — the control for the two check-ops-scripts.sh
# assertions that scripts/checks/prove-it-bites.sh structurally cannot express.
#
# WHY NOT prove-it-bites.sh
# -------------------------
# That harness is the standard and it is used for everything it fits: the five
# newly-registered scripts' `bash -n` coverage was proven with it, one command
# each. It discriminates by md5 of a single subject file, which rules out both
# assertions below:
#
#   1. THE EXEC BIT. `chmod -x "$SUBJECT"` leaves the bytes identical, so
#      prove-it-bites.sh stops with "the mutation did not change the subject's
#      bytes" before it ever runs the check. Measured, not assumed — it hard
#      errors and restores. A mode assertion needs a mode-aware restore, which
#      is the shape scripts/checks/prove-ops-mode-bites.sh already established.
#
#   2. THE REVERSE-DIRECTION INVENTORY. Its mutation is not an edit to any file
#      in this repo at all — it is a file appearing in $TARGET_DIR. There is no
#      subject to hash.
#
# WHAT IT NEVER TOUCHES. /opt/ai-os/scripts is only ever READ, and only by the
# check itself in section 2's negative case. Every mutation lands in a throwaway
# dir under /opt/ai-os/scratch, removed at exit. The only repo mutation is one
# permission bit, restored on EXIT and on INT/TERM/HUP (bash skips an EXIT trap
# on an untrapped signal — memory: bash-exit-trap-skipped-on-untrapped-signal)
# and verified by md5 AND by mode, so a failed restore is loud.
#
# Usage:  bash scripts/checks/prove-ops-inventory-bites.sh
# Exit:   0 — BITES: both assertions discriminated, repo restored
#         1 — INERT: an assertion did not discriminate
#         2 — INCONCLUSIVE: setup or restore failed

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS="$REPO/scripts/ops"
CHECK="$REPO/scripts/checks/check-ops-scripts.sh"
SUBJECT="$OPS/recover-stuck-task.sh"

[ -x "$CHECK" ]   || { echo "INCONCLUSIVE: no $CHECK" >&2; exit 2; }
[ -f "$SUBJECT" ] || { echo "INCONCLUSIVE: no $SUBJECT" >&2; exit 2; }

ORIG_MODE="$(stat -c '%a' "$SUBJECT")"
ORIG_MD5="$(md5sum "$SUBJECT" | cut -d' ' -f1)"
SCRATCH="$(mktemp -d /opt/ai-os/scratch/ops-inventory-control.XXXXXX)" || {
  echo "INCONCLUSIVE: could not make a scratch target dir" >&2; exit 2; }

restore() {
  chmod "$ORIG_MODE" "$SUBJECT" 2>/dev/null
  rm -rf -- "$SCRATCH"
  now_md5="$(md5sum "$SUBJECT" | cut -d' ' -f1)"
  now_mode="$(stat -c '%a' "$SUBJECT")"
  if [ "$now_md5" != "$ORIG_MD5" ] || [ "$now_mode" != "$ORIG_MODE" ]; then
    echo "INCONCLUSIVE: subject not restored (mode $ORIG_MODE -> $now_mode, md5 $ORIG_MD5 -> $now_md5)" >&2
  fi
  echo "-- restored: mode $ORIG_MODE -> $now_mode, md5 $ORIG_MD5 -> $now_md5"
}
trap restore EXIT
trap 'exit 130' INT TERM HUP

verdict=0
inert() { echo "INERT: $*" >&2; verdict=1; }

# The scratch "install". Deliberately WITHOUT a check-vps2-backup.sh symlink:
# that one would make the 750 mode assertion fire and fail (the repo copy is
# 755, since git cannot store 750), which is prove-ops-mode-bites.sh's subject,
# not this one. Leaving it out keeps that assertion on SKIP so the only thing
# moving in this transcript is the inventory.
ln -s "$OPS/safe-restart.sh" "$SCRATCH/safe-restart.sh" || {
  echo "INCONCLUSIVE: could not link the scratch install" >&2; exit 2; }

run_check() { FORGE_OPS_TARGET_DIR="$1" "$CHECK" 2>&1; }

echo "########## 1. the exec bit — EXPECTED_EXEC must FAIL on a script that lost it ##########"
echo "-- baseline, unmutated"
out0="$(run_check "$SCRATCH")"; code0=$?
echo "EXIT=$code0"
[ "$code0" = 0 ] || inert "the check is ALREADY RED unmutated — nothing below proves anything (exit $code0)"

chmod -x "$SUBJECT"
echo "-- mutated: chmod -x scripts/ops/recover-stuck-task.sh (mode now $(stat -c '%a' "$SUBJECT"))"
out1="$(run_check "$SCRATCH")"; code1=$?
echo "$out1" | grep -E 'not executable' || true
echo "EXIT=$code1"
echo "$out1" | grep -q 'FAIL: not executable: scripts/ops/recover-stuck-task.sh' || \
  inert "dropping the exec bit did not produce the 'not executable' FAIL line"
[ "$code1" != 0 ] || inert "dropping the exec bit left the check exiting 0"
chmod "$ORIG_MODE" "$SUBJECT"

echo
echo "########## 2. reverse direction — an unmanaged regular file in TARGET_DIR ##########"
echo "-- 2a. scratch target holds only a symlink to a managed file — must PASS"
out2a="$(run_check "$SCRATCH")"; code2a=$?
echo "EXIT=$code2a"
[ "$code2a" = 0 ] || inert "a target dir holding only an installed symlink did not pass (exit $code2a)"
echo "$out2a" | grep -q 'unmanaged regular file' && \
  inert "a symlink to a managed file was reported as unmanaged — -type f is not discriminating"

echo
echo "-- 2b. drop a rogue REGULAR file in — must FAIL and name it"
printf '#!/usr/bin/env bash\necho rogue\n' > "$SCRATCH/rogue-watchdog.sh"
chmod 755 "$SCRATCH/rogue-watchdog.sh"
out2b="$(run_check "$SCRATCH")"; code2b=$?
echo "$out2b" | grep -E 'unmanaged regular file' || true
echo "EXIT=$code2b"
echo "$out2b" | grep -q 'unmanaged regular file.*rogue-watchdog.sh' || \
  inert "an unmanaged regular file in TARGET_DIR did not produce the FAIL line naming it"
[ "$code2b" != 0 ] || inert "an unmanaged regular file left the check exiting 0"

echo
echo "-- 2c. same file renamed to the backup suffix — must PASS (the allowlist, and only it)"
mv "$SCRATCH/rogue-watchdog.sh" "$SCRATCH/rogue-watchdog.sh.bak-20260826"
out2c="$(run_check "$SCRATCH")"; code2c=$?
echo "EXIT=$code2c"
[ "$code2c" = 0 ] || inert "a *.bak-* file was not allowlisted (exit $code2c)"
rm -f "$SCRATCH/rogue-watchdog.sh.bak-20260826"

echo
echo "-- 2d. TARGET_DIR does not exist — must SKIP, loudly, not silently pass"
out2d="$(run_check "$SCRATCH/nowhere")"; code2d=$?
echo "$out2d" | grep -E '^SKIP: no ' || true
echo "EXIT=$code2d"
echo "$out2d" | grep -q "SKIP: no $SCRATCH/nowhere" || \
  inert "a missing TARGET_DIR did not SKIP loudly — the assertion is indistinguishable from a deleted one"
[ "$code2d" = 0 ] || inert "a missing TARGET_DIR should skip, not fail (exit $code2d)"

echo
echo "-- 2e. the LISTING itself fails — must SKIP loudly, never pass silently"
# This box runs everything as root, so an unreadable directory is unreachable:
# root reads it anyway. Left uncontrolled, the branch that handles a failed
# listing would be an assertion nobody can reach — the same defect the loud
# SKIP exists to avoid. So reach it the other way the comment names: a `find`
# that is not GNU find, or not there at all. A stub earlier in PATH exits 3;
# every other tool the check uses still resolves normally.
STUBBIN="$SCRATCH/stubbin"
mkdir -p "$STUBBIN"
printf '#!/usr/bin/env bash\necho "find: simulated failure" >&2\nexit 3\n' > "$STUBBIN/find"
chmod 755 "$STUBBIN/find"
printf '#!/usr/bin/env bash\necho rogue\n' > "$SCRATCH/rogue-watchdog.sh"
out2e="$(PATH="$STUBBIN:$PATH" FORGE_OPS_TARGET_DIR="$SCRATCH" "$CHECK" 2>&1)"; code2e=$?
echo "$out2e" | grep -E 'SKIP: could not list' || true
echo "EXIT=$code2e"
echo "$out2e" | grep -q 'SKIP: could not list .* the reverse-inventory question was NOT answered' || \
  inert "a failed listing did not SKIP loudly — an unlistable TARGET_DIR reports PASS for a directory nobody looked in"
echo "$out2e" | grep -q 'unmanaged regular file' && \
  inert "a failed listing still claimed to have inspected the directory"
rm -f "$SCRATCH/rogue-watchdog.sh"
rm -rf "$STUBBIN"

echo
if [ "$verdict" = 0 ]; then
  echo "BITES — a lost exec bit FAILs, an unmanaged regular file in TARGET_DIR FAILs and is named,"
  echo "        an installed symlink and a *.bak-* backup do not, and a TARGET_DIR that is missing"
  echo "        or cannot be listed SKIPs loudly instead of passing."
else
  echo "INERT — at least one assertion did not discriminate; see the lines above."
fi
exit "$verdict"
