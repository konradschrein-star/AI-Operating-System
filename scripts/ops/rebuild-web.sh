#!/usr/bin/env bash
# Rebuild + redeploy forge-control-web, detached from any agent turn.
#
# Why detached: `next build` takes minutes, and if the operator's turn is
# interrupted mid-build the child dies, leaving .next half-written — which is
# exactly how the app ended up crash-looping with no BUILD_ID. Run under setsid
# so the build owns its own process group and outlives the turn that started it.
#
# Also guards against the other failure seen today: two concurrent builds in
# the same directory deleting each other's artifacts. A lock makes that
# impossible rather than unlikely.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
export NODE_ENV=production

APP=/opt/forge-ai-os/forge-control-web
LOG=/var/log/forge-web-build.log
LOCK=/var/lock/forge-web-build.lock

exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[$(date -Is)] another build holds the lock — refusing to race" >>"$LOG"
  exit 3
fi

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

cd "$APP" || { log "cannot cd $APP"; exit 1; }

log "=== rebuild starting ==="
rm -rf .next
if npm run build >>"$LOG" 2>&1; then
  if [ -f .next/BUILD_ID ]; then
    log "build OK (BUILD_ID $(cat .next/BUILD_ID)) — restarting web"
    pm2 restart forge-control-web >>"$LOG" 2>&1
    sleep 5
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/desktop || echo 000)
    log "post-restart /desktop -> $code"
    log "=== rebuild DONE ==="
    exit 0
  fi
  log "build reported success but BUILD_ID missing — NOT restarting"
  exit 1
fi
# Leave the old build in place on failure: a stale-but-working UI beats a
# blank one. (Here there is no old build, but the rule still holds.)
log "!!! build FAILED — see above"
exit 1
