#!/usr/bin/env bash
# Restart forge-control-web when its .next bundle is rebuilt underneath it.
#
# THE FAILURE THIS EXISTS FOR — 2026-08-25 02:00
# ----------------------------------------------
# A fresh browser hitting the console got:
#
#     CONSOLE CRASHED
#     Loading chunk 9927 failed.
#     .../_next/static/chunks/9927-63570b2e57262d2f.js
#
# `.next` had been rebuilt at 02:00:57 while forge-control-web had been running
# since 01:45:21. A Next server resolves chunk hashes from the manifest it read
# at BOOT; a rebuild rewrites every hash on disk. So the running server keeps
# serving hrefs for chunks that no longer exist and every fresh page load dies.
# Konrad's own tab looked fine because it held the old bundle in memory — which
# is exactly why nobody notices until someone reloads.
#
# This is not hypothetical or one-off: agent sessions develop in
# /opt/forge-ai-os and run `next build` there. The live checkout had 6 modified
# files at 01:56 and 19 by 02:08. Every build is another window where the
# console is broken for anyone who reloads.
#
# THE CHECK. If .next/BUILD_ID is NEWER than the server process started, the
# server is serving a manifest that no longer matches disk. Restart it.
# forge-control-web owns no agent turns, so restarting it is safe at any time —
# unlike forge-executor/forge-control, which a PreToolUse hook blocks for good
# reason (restarting those killed four live runs on 2026-08-25).
#
# GRACE. A build takes time to finish writing. Only act once the build is at
# least BUILD_SETTLE_S old, so we never restart onto a half-written .next.
#
# RATE LIMIT. At most one restart per COOLDOWN_S, so a build loop cannot turn
# this into a restart loop.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

APP=forge-control-web
NEXT_DIR=/opt/forge-ai-os/forge-control-web/.next
LOG=/var/log/next-build-drift.log
STAMP=/var/tmp/next-build-drift.stamp
LAST=/var/tmp/next-build-drift.last-restart
BUILD_SETTLE_S=45
COOLDOWN_S=300

# Touched on EVERY invocation, before any early exit: a watchdog that never runs
# and a watchdog with nothing to do write identical logs. The stamp is the only
# thing that tells them apart — the same lesson fleet-pulse.sh was written after.
touch "$STAMP"

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

[ -f "$NEXT_DIR/BUILD_ID" ] || exit 0

build_mtime=$(stat -c %Y "$NEXT_DIR/BUILD_ID" 2>/dev/null) || exit 0
now=$(date +%s)

# Still being written? Come back next tick.
[ $((now - build_mtime)) -lt "$BUILD_SETTLE_S" ] && exit 0

start_ms=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
    for p in json.load(sys.stdin):
        if p['name']=='$APP' and p['pm2_env']['status']=='online':
            print(p['pm2_env'].get('pm_uptime',0)); break
    else: print(0)
except Exception: print(0)
")
[ -z "$start_ms" ] && exit 0
[ "$start_ms" = "0" ] && exit 0
start_s=$((start_ms / 1000))

# The bundle is older than the process — nothing to do. This is the normal path.
[ "$build_mtime" -le "$start_s" ] && exit 0

if [ -f "$LAST" ]; then
  since=$((now - $(stat -c %Y "$LAST")))
  if [ "$since" -lt "$COOLDOWN_S" ]; then
    log "drift detected (build $((build_mtime - start_s))s newer than process) but last restart was ${since}s ago — holding off"
    exit 0
  fi
fi

log "DRIFT: .next rebuilt $((build_mtime - start_s))s after $APP started — the server is serving chunk hashes that no longer exist. Restarting."
touch "$LAST"
pm2 restart "$APP" >/dev/null 2>&1
sleep 8

bid=$(cat "$NEXT_DIR/BUILD_ID" 2>/dev/null)
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  "http://127.0.0.1:7701/_next/static/${bid}/_buildManifest.js" 2>/dev/null)
log "restarted $APP — buildManifest($bid) -> HTTP ${code:-000}"

# Only escalate if the restart did NOT fix it. A self-healing watchdog that
# reports every success is just noise in Konrad's inbox.
if [ "$code" != "200" ]; then
  curl -s -m 15 -X POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "{\"text\":\"Console may be down: forge-control-web was restarted after a .next rebuild drift and its build manifest still returns HTTP ${code:-000}. Fresh page loads are probably failing with 'Loading chunk ... failed'. Check: pm2 logs forge-control-web\",\"when\":\"in 1m\"}" \
    >/dev/null 2>&1
fi
