#!/usr/bin/env bash
# Add the forge-memory MCP server to /root/.claude.json under mcpServers.
# Idempotent: if the key already exists, leaves it alone. Backs up first.
set -euo pipefail

cfg=/root/.claude.json
if [ ! -f "$cfg" ]; then
  echo "no $cfg — abort" >&2
  exit 1
fi

cp -p "$cfg" "$cfg.bak-$(date +%Y%m%d-%H%M%S)"

python3 - <<'PY'
import json, sys
PATH = '/root/.claude.json'
with open(PATH) as f:
    cfg = json.load(f)
servers = cfg.setdefault('mcpServers', {})
if 'forge-memory' in servers:
    print('forge-memory already wired — no change')
    sys.exit(0)
servers['forge-memory'] = {
    'type': 'stdio',
    'command': 'node',
    'args': ['--import', 'tsx', '/opt/forge-ai-os/forge-control-mcp/src/server.ts'],
    'env': {
        'FORGE_CONTROL_URL': 'http://127.0.0.1:7700',
    },
}
with open(PATH, 'w') as f:
    json.dump(cfg, f, indent=2)
print('forge-memory wired into /root/.claude.json mcpServers')
PY
