#!/usr/bin/env bash
# prove-ops-mode-bites.sh — the control for check-ops-scripts.sh's 750 assertion.
#
# WHY THIS FILE EXISTS
# --------------------
# Round 5 made that assertion location-aware: it only fires when
# $TARGET_DIR/check-vps2-backup.sh symlinks back to the checkout being checked.
# In every build worktree it therefore SKIPs, and an assertion that skips
# everywhere a human looks is indistinguishable from one that has been deleted
# (memory: unreachable-guard-needs-its-own-control). This script reaches it
# deliberately: it stands up a throwaway $TARGET_DIR pointing at this worktree,
# runs the real check at 755 and at 750, and asserts the verdicts differ.
#
# It NEVER touches /opt/ai-os/scripts. The scratch target dir is created under
# /opt/ai-os/scratch and removed at exit. The only thing mutated in the repo is
# check-vps2-backup.sh's permission bits, restored on EXIT and on any untrapped
# signal (memory: bash-exit-trap-skipped-on-untrapped-signal), and verified by
# md5 so a failed restore is loud rather than silent.
#
# Usage:  bash scripts/checks/prove-ops-mode-bites.sh
# Exit:   0 — BITES (755 fails, 750 passes, file content unchanged)
#         1 — INERT: the assertion did not discriminate
#         2 — INCONCLUSIVE: setup or restore failed

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO/scripts/ops/check-vps2-backup.sh"
CHECK="$REPO/scripts/checks/check-ops-scripts.sh"

[ -f "$SUBJECT" ] || { echo "INCONCLUSIVE: no $SUBJECT" >&2; exit 2; }
[ -x "$CHECK" ]   || { echo "INCONCLUSIVE: no $CHECK" >&2; exit 2; }

ORIG_MODE="$(stat -c '%a' "$SUBJECT")"
ORIG_MD5="$(md5sum "$SUBJECT" | cut -d' ' -f1)"
SCRATCH="$(mktemp -d /opt/ai-os/scratch/ops-mode-control.XXXXXX)" || {
  echo "INCONCLUSIVE: could not make a scratch target dir" >&2; exit 2; }

restore() {
  chmod "$ORIG_MODE" "$SUBJECT" 2>/dev/null
  rm -rf -- "$SCRATCH"
  now_md5="$(md5sum "$SUBJECT" | cut -d' ' -f1)"
  now_mode="$(stat -c '%a' "$SUBJECT")"
  if [ "$now_md5" != "$ORIG_MD5" ]; then
    echo "INCONCLUSIVE: subject content changed ($ORIG_MD5 -> $now_md5)" >&2
  fi
  echo "-- restored: mode $ORIG_MODE -> $now_mode, md5 $ORIG_MD5 -> $now_md5"
}
# INT/TERM/HUP are trapped explicitly: bash skips an EXIT trap on an untrapped
# signal, which would leave the repo file at whatever mode the last step set.
trap restore EXIT
trap 'exit 130' INT TERM HUP

# The scratch "install": exactly what install-symlinks.sh makes — a symlink in
# TARGET_DIR pointing at the repo file.
ln -s "$SUBJECT" "$SCRATCH/check-vps2-backup.sh" || {
  echo "INCONCLUSIVE: could not link the scratch install" >&2; exit 2; }

run_check() {
  FORGE_OPS_TARGET_DIR="$SCRATCH" "$CHECK" 2>&1
  return "${PIPESTATUS[0]}"
}

echo "########## 1. installed checkout, mode 755 — the assertion must FAIL ##########"
chmod 755 "$SUBJECT"
out755="$(FORGE_OPS_TARGET_DIR="$SCRATCH" "$CHECK" 2>&1)"; code755=$?
echo "$out755" | grep -E 'check-vps2-backup|^SKIP' || true
echo "EXIT=$code755"

echo
echo "########## 2. installed checkout, mode 750 — the assertion must PASS ##########"
chmod 750 "$SUBJECT"
out750="$(FORGE_OPS_TARGET_DIR="$SCRATCH" "$CHECK" 2>&1)"; code750=$?
echo "$out750" | grep -E 'check-vps2-backup|^SKIP' || true
echo "EXIT=$code750"

echo
echo "########## 3. NOT the installed checkout — must SKIP, loudly ##########"
chmod 755 "$SUBJECT"
outskip="$(FORGE_OPS_TARGET_DIR="$SCRATCH/nowhere" "$CHECK" 2>&1)"; codeskip=$?
echo "$outskip" | grep -E 'check-vps2-backup|^SKIP' || true
echo "EXIT=$codeskip"

echo
verdict=0
echo "$out755" | grep -q 'FAIL: check-vps2-backup.sh mode is 755' || {
  echo "INERT: mode 755 on the installed checkout did not produce the FAIL line" >&2; verdict=1; }
echo "$out750" | grep -q 'check-vps2-backup.sh mode' && {
  echo "INERT: mode 750 still said something about the mode" >&2; verdict=1; }
echo "$outskip" | grep -q 'SKIP: check-vps2-backup.sh mode is 755' || {
  echo "INERT: a non-installed checkout did not SKIP loudly" >&2; verdict=1; }

if [ "$verdict" = 0 ]; then
  echo "BITES — 755 on the installed checkout FAILs, 750 passes, elsewhere it SKIPs loudly."
else
  echo "INERT — the 750 assertion does not discriminate."
fi
exit "$verdict"
