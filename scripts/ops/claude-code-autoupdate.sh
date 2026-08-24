#!/usr/bin/env bash
# Keep Claude Code on the frontier: pull the latest global install daily so
# forge-executor/claude-pool always spawn the newest CLI (new models + fixes).
# Installed/managed by the AI OS operator, 2026-07-29.
set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
LOG=/var/log/claude-code-update.log
before="$(claude --version 2>/dev/null || echo unknown)"
npm install -g @anthropic-ai/claude-code@latest >>"$LOG" 2>&1
after="$(claude --version 2>/dev/null || echo unknown)"
if [ "$before" != "$after" ]; then
  echo "[$(date -Is)] updated: $before -> $after" >>"$LOG"
else
  echo "[$(date -Is)] up-to-date: $after" >>"$LOG"
fi
