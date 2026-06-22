#!/usr/bin/env bash
# Smoke the MCP server on the VPS: send a ListTools request over stdio,
# verify the 3 expected tools come back.
set -euo pipefail
cd /opt/forge-ai-os/forge-control-mcp
out=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | timeout 8 node --import tsx src/server.ts 2>&1 || true)
if echo "$out" | grep -q "memory.search"; then
  echo "OK — memory.search listed"
else
  echo "FAILED — memory.search not in output"
  echo "----"
  echo "$out" | head -c 1200
  exit 1
fi
if echo "$out" | grep -q "memory.note" && echo "$out" | grep -q "memory.list"; then
  echo "OK — memory.note + memory.list listed"
else
  echo "FAILED — missing tools"
  exit 1
fi
