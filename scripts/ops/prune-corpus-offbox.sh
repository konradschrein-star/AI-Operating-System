#!/usr/bin/env bash
# Runs on VPS1. Prunes the off-box corpus copies pushed from VPS2.
#
# WHY THE DESTINATION PRUNES ITSELF. VPS2 pushes with rsync but deliberately
# WITHOUT --delete: a mirror is not a backup. If /opt/backups/corpus on VPS2
# were wiped, a --delete mirror would propagate that wipe to the only off-box
# copy on the very next run — the backup would delete itself precisely when it
# was needed. So the source may only ADD, and deletion authority lives here,
# on the destination, where a compromise or accident on VPS2 cannot reach it.
#
# Retention by COUNT, not by `find -mtime`: if VPS2 stops pushing, age-based
# pruning would delete the last good copy it holds.

set -uo pipefail
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"

ROOT=/srv/corpus-backups
LOG=/var/log/corpus-backup-prune.log

KEEP_DAILY=10      # a little deeper than VPS2's 7, since this is the copy that
                   # survives VPS2 being lost entirely
KEEP_WEEKLY=6
KEEP_MONTHLY=6

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

prune_dir() {
  local dir="$1" keep="$2"
  [ -d "$dir" ] || return 0
  # Group by everything before the trailing .YYYYMMDD.gz so each corpus file
  # keeps its own N, and a burst of one cannot evict another.
  local prefixes
  prefixes="$(ls -1 "$dir" 2>/dev/null | sed -nE 's/^(.*)\.[0-9]{8}\.gz$/\1/p' | sort -u)"
  for p in $prefixes; do
    ls -1t "$dir/$p."*.gz 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do
      rm -f "$old" && log "prune $(basename "$old")"
    done
  done
  # SHA256SUMS manifests follow the dailies they describe.
  ls -1t "$dir/SHA256SUMS."* 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -f
}

prune_dir "$ROOT/daily"   "$KEEP_DAILY"
prune_dir "$ROOT/weekly"  "$KEEP_WEEKLY"
prune_dir "$ROOT/monthly" "$KEEP_MONTHLY"

chown -R corpusbak:corpusbak "$ROOT" 2>/dev/null

log "prune complete — daily=$(ls -1 "$ROOT/daily"/*.gz 2>/dev/null | wc -l) weekly=$(ls -1 "$ROOT/weekly"/*.gz 2>/dev/null | wc -l) monthly=$(ls -1 "$ROOT/monthly"/*.gz 2>/dev/null | wc -l) size=$(du -sh "$ROOT" 2>/dev/null | cut -f1)"
