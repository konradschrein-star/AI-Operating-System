#!/usr/bin/env bash
# check-ops-scripts.sh — verify the scripts/ops/ migration is internally
# consistent: every managed file is present with the right mode, every shell
# script parses, install-symlinks.sh's FILES list matches what actually lives
# in scripts/ops/, and safe-restart.sh still carries the two guards that were
# built and measured the hard way (self-exclusion, single-instance lock).
#
# This checks the REPO'S copies only — it never touches /opt/ai-os/scripts or
# any live host state, so it is safe to run from a build task under the
# worktree-only policy. Verifying the actual host install (symlinks in place,
# safe-restart.sh run against a real pm2 service) is a deploy/verify-task job.
#
# Usage:  scripts/checks/check-ops-scripts.sh
# Exit:   0 — every check passed
#         1 — something is missing, mismodes, or the guard logic regressed

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS="$REPO/scripts/ops"
fail=0

note() { echo "-- $*"; }
bad()  { echo "FAIL: $*" >&2; fail=1; }

# Managed files: the shell/canvas scripts + JSON payloads + the two docs.
# Kept as a literal list (not derived) so this check can tell an intentional
# addition from an accidental one — same reasoning as install-symlinks.sh's
# own FILES array, which this check cross-references below.
EXPECTED_EXEC=(
  safe-restart.sh claude-code-autoupdate.sh reap-orphan-agents.sh pg-backup.sh
  fleet-watchdog.sh stalled-projects.sh check-corpus-backup.sh
  check-vps2-backup.sh prune-corpus-offbox.sh agy-dropout-stopgap.sh canvas
  deploy-goal-mode.sh deploy-retier.sh rebuild-web.sh install-symlinks.sh
)
EXPECTED_NONEXEC=(
  goal-engine-v2.json goal-files-pane.json goal-manager-split.json
  goal-operator-visibility.json README.md
)

note "presence + permissions"
for f in "${EXPECTED_EXEC[@]}"; do
  p="$OPS/$f"
  if [ ! -f "$p" ]; then bad "missing: scripts/ops/$f"; continue; fi
  [ -x "$p" ] || bad "not executable: scripts/ops/$f"
done
for f in "${EXPECTED_NONEXEC[@]}"; do
  p="$OPS/$f"
  [ -f "$p" ] || bad "missing: scripts/ops/$f"
done

# check-vps2-backup.sh must stay tighter than the rest — it embeds VPS2's SSH
# monitor invocation. git can only round-trip 644/755, so an installer or a
# careless `chmod` regressing it to world-readable would be silent otherwise.
if [ -f "$OPS/check-vps2-backup.sh" ]; then
  mode="$(stat -c '%a' "$OPS/check-vps2-backup.sh")"
  [ "$mode" = "750" ] || bad "check-vps2-backup.sh mode is $mode, expected 750"
fi

note "shell syntax"
for f in "${EXPECTED_EXEC[@]}"; do
  p="$OPS/$f"
  [ -f "$p" ] || continue
  head -n1 "$p" | grep -qE '^#!.*\b(bash|sh)$' || continue
  bash -n "$p" 2>/tmp/check-ops-scripts.$$.err || {
    bad "bash -n failed for scripts/ops/$f: $(cat /tmp/check-ops-scripts.$$.err)"
  }
  rm -f /tmp/check-ops-scripts.$$.err
done

note "install-symlinks.sh FILES list matches what's on disk"
if [ -f "$OPS/install-symlinks.sh" ]; then
  installer_files="$(sed -n '/^FILES=(/,/^)/p' "$OPS/install-symlinks.sh" | grep -oE '^\s*[A-Za-z0-9._-]+\s*$' | tr -d ' ' | sort)"
  disk_files="$(cd "$OPS" && ls -1 | grep -vE '^(install-symlinks\.sh|README\.md)$' | sort)"
  if [ "$installer_files" != "$disk_files" ]; then
    bad "install-symlinks.sh FILES array is out of sync with scripts/ops/ contents"
    diff <(echo "$installer_files") <(echo "$disk_files") >&2 || true
  fi
else
  bad "missing: scripts/ops/install-symlinks.sh"
fi

note "safe-restart.sh guard logic"
SR="$OPS/safe-restart.sh"
if [ -f "$SR" ]; then
  grep -q 'FORGE_RUN_UUID' "$SR" || bad "safe-restart.sh: no FORGE_RUN_UUID self-exclusion reference"
  grep -qE 'SVC.*!=.*forge-executor|forge-executor.*!=.*SVC' "$SR" || \
    bad "safe-restart.sh: self-exclusion does not appear scoped away from forge-executor"
  grep -q "SELF_EXCLUDE=" "$SR" || bad "safe-restart.sh: SELF_EXCLUDE variable not found"
  grep -qE 'flock -n -E 99' "$SR" || bad "safe-restart.sh: single-instance lock (flock -n -E 99) not found"
  grep -q 'SAFE_RESTART_LOCKED' "$SR" || bad "safe-restart.sh: re-exec lock guard SAFE_RESTART_LOCKED not found"
else
  bad "missing: scripts/ops/safe-restart.sh"
fi

if [ "$fail" = 0 ]; then
  echo "PASS: scripts/ops/ is complete, modes are correct, syntax is clean, installer is in sync, safe-restart.sh guards are present"
else
  echo "one or more checks FAILED — see above" >&2
fi
exit "$fail"
