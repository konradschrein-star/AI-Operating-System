#!/usr/bin/env bash
# Nightly logical backup of every database the AI OS depends on.
#
# Why this exists: as of 2026-08-02 this box had NO scheduled database backup
# at all. The only backup cron in root's crontab was content-forge media, and
# it was commented out. Meanwhile ai_os on :5434 had just become the home of
# the account registry, and content_forge holds 1,452 knowledge triples. Three
# independent reviews flagged it; this closes it.
#
# Design notes:
#  - pg_dump -Fc (custom format): compressed, and restorable selectively with
#    pg_restore -t, which plain SQL can't do.
#  - Dumps are written to a .part file and renamed only on success, so a
#    truncated dump can never masquerade as a good one.
#  - Retention is by count-per-database, not by find -mtime: if the script
#    stops running, mtime pruning would happily delete the last good backup.
#  - Exit non-zero if ANY database fails, so cron mail / the log shows it.

set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

ENV_FILE=/opt/ai-os/.secrets/pg-backup.env
DEST=/opt/backups/postgres
LOG=/var/log/pg-backup.log
KEEP=14                      # nightly dumps retained per database

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

# Credential resolution, in priority order:
#   1. the LIVE forge-control process env  2. the static secrets file
#
# Why the live process first: on 2026-08-02 the postgres password was rotated
# mid-session and this script — which had the old password pasted into its env
# file — would have failed silently at 03:20 that night. A backup whose
# credentials can go stale independently of the app is not a backup. The
# running app is the only thing guaranteed to hold *working* credentials, so we
# read from it and treat the file as fallback for when the app is down.
if [ -r "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  . "$ENV_FILE"
fi

resolve_from_live() {
  local var="$1" pid
  pid="$(pgrep -f 'forge-control/src/index.ts' | head -1)"
  [ -n "$pid" ] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep "^${var}=" | cut -d= -f2- | head -1
}

live_cf="$(resolve_from_live DATABASE_URL     || true)"
live_hcp="$(resolve_from_live HCP_DATABASE_URL || true)"
live_ai="$(resolve_from_live AI_OS_DATABASE_URL || true)"
[ -n "${live_cf:-}"  ] && CF_URL="$live_cf"
[ -n "${live_hcp:-}" ] && HCP_URL="$live_hcp"
[ -n "${live_ai:-}"  ] && AI_OS_URL="$live_ai"

[ -n "${CF_URL:-}${HCP_URL:-}${AI_OS_URL:-}" ] || {
  log "FATAL: no credentials from live process or $ENV_FILE"; exit 1; }

mkdir -p "$DEST"
stamp="$(date +%Y%m%d-%H%M%S)"
rc=0

dump_one() {
  local name="$1" url="$2"
  if [ -z "${url:-}" ]; then
    log "SKIP $name — no connection string in $ENV_FILE"
    return 1
  fi
  local out="$DEST/${name}-${stamp}.dump"
  if pg_dump "$url" -Fc --no-owner --no-acl -f "${out}.part" 2>>"$LOG"; then
    mv "${out}.part" "$out"
    log "ok   $name -> $(basename "$out") ($(du -h "$out" | cut -f1))"
  else
    rm -f "${out}.part"
    log "FAIL $name — pg_dump returned non-zero"
    return 1
  fi
}

prune_one() {
  # Keep the newest $KEEP dumps for this database, delete the rest.
  local name="$1"
  ls -1t "$DEST/${name}-"*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && log "prune $(basename "$old")"
  done
}

for pair in "content_forge:${CF_URL:-}" "hcp:${HCP_URL:-}" "ai_os:${AI_OS_URL:-}"; do
  name="${pair%%:*}"
  url="${pair#*:}"
  dump_one "$name" "$url" || rc=1
  prune_one "$name"
done

# Integrity gate: a dump that pg_restore can't read is not a backup. Listing the
# table of contents is cheap and catches truncation/corruption immediately.
for name in content_forge hcp ai_os; do
  newest="$(ls -1t "$DEST/${name}-"*.dump 2>/dev/null | head -1)"
  [ -n "$newest" ] || continue
  if pg_restore -l "$newest" >/dev/null 2>&1; then
    log "verify $name — restorable"
  else
    log "FAIL   $name — dump is NOT restorable: $(basename "$newest")"
    rc=1
  fi
done

if [ "$rc" -eq 0 ]; then
  log "run complete — all databases backed up"
else
  log "run complete WITH FAILURES (rc=$rc)"
  # A failing backup that only writes to a logfile nobody reads is the same as
  # no backup. Push it at Konrad through the reminder path (the inbox endpoint
  # is a 404 — reminders is what actually reaches him).
  curl -s --max-time 10 -X POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "{\"text\":\"DB BACKUP FAILED on $(hostname -s) — check /var/log/pg-backup.log\",\"when\":\"in 1m\"}" \
    >/dev/null 2>&1 || log "warn: could not queue failure alert"
fi
exit "$rc"
