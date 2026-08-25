#!/usr/bin/env bash
# Installs /opt/ai-os/scripts/<name> as a symlink into this repo's scripts/ops/,
# so every cron job and every script's own hardcoded `/opt/ai-os/scripts/...`
# reference (safe-restart.sh, deploy-goal-mode.sh, deploy-retier.sh all call
# siblings and read the goal-*.json files by that absolute path) keeps working
# unchanged after the scripts move into git history.
#
# Idempotent and non-destructive: a real file already at the target path is
# backed up (never deleted) before the symlink replaces it. Re-running once
# the symlinks are in place is a no-op.
#
#   scripts/ops/install-symlinks.sh [--target-dir DIR] [--dry-run]
#
# Exits 0 on success (including "already installed"), 1 on any failure.

set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="/opt/ai-os/scripts"
BACKUP_DIR="/opt/ai-os/backups/scripts"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Every file the ops migration manages. Order doesn't matter — none of these
# depend on another already being installed, only on ending up at TARGET_DIR.
FILES=(
  safe-restart.sh
  claude-code-autoupdate.sh
  reap-orphan-agents.sh
  pg-backup.sh
  fleet-watchdog.sh
  stalled-projects.sh
  fleet-pulse.sh
  check-corpus-backup.sh
  check-vps2-backup.sh
  prune-corpus-offbox.sh
  agy-dropout-stopgap.sh
  canvas
  deploy-goal-mode.sh
  deploy-retier.sh
  rebuild-web.sh
  goal-engine-v2.json
  goal-files-pane.json
  goal-manager-split.json
  goal-operator-visibility.json
  guard-service-restart.py
  guard-autonomy.py
  guard-protected-paths.py
  test-guard-service-restart.py
  test-guard-autonomy.py
  test-guard-protected-paths.py
  install-hooks.sh
  hooks.settings.json
)

# git only tracks the executable bit (100644/100755) — it cannot represent
# check-vps2-backup.sh's tighter 750 (group r-x, world none). Restore it here
# on every install rather than relying on the checkout's mode.
RESTRICTED_MODE_FILES=(check-vps2-backup.sh)

# The three PreToolUse hooks are invoked by the Claude CLI as commands. A hook
# that has lost its executable bit does not fail loudly — it fails as a hook
# that did not run, which is indistinguishable from a box with no guard on it
# at all. git DOES round-trip 755, so this is belt-and-braces rather than a
# workaround; it costs one chmod and removes a silent-disable path.
EXEC_MODE_FILES=(
  guard-service-restart.py
  guard-autonomy.py
  guard-protected-paths.py
  test-guard-service-restart.py
  test-guard-autonomy.py
  test-guard-protected-paths.py
  install-hooks.sh
)

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
fail=0

mkdir -p "$BACKUP_DIR"

for f in "${FILES[@]}"; do
  src="$REPO_ROOT/scripts/ops/$f"
  dst="$TARGET_DIR/$f"

  if [ ! -e "$src" ]; then
    echo "MISSING in repo: $src" >&2
    fail=1
    continue
  fi

  if [ -L "$dst" ]; then
    current="$(readlink -f "$dst" 2>/dev/null || true)"
    if [ "$current" = "$(readlink -f "$src")" ]; then
      echo "ok (already linked): $dst"
      continue
    fi
    echo "relinking (pointed elsewhere): $dst -> was $current"
    [ "$DRY_RUN" = 1 ] || rm -f "$dst"
  elif [ -e "$dst" ]; then
    backup="$BACKUP_DIR/$f.$stamp-preinstall"
    echo "backing up real file before symlinking: $dst -> $backup"
    if [ "$DRY_RUN" = 0 ]; then
      cp -p "$dst" "$backup"
      rm -f "$dst"
    fi
  fi

  if [ "$DRY_RUN" = 1 ]; then
    echo "would link: $dst -> $src"
    continue
  fi

  ln -s "$src" "$dst"
  echo "linked: $dst -> $src"
done

if [ "$DRY_RUN" = 0 ]; then
  for f in "${RESTRICTED_MODE_FILES[@]}"; do
    chmod 750 "$REPO_ROOT/scripts/ops/$f"
  done
  for f in "${EXEC_MODE_FILES[@]}"; do
    chmod 755 "$REPO_ROOT/scripts/ops/$f"
  done
fi

exit "$fail"
