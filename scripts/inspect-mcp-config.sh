#!/usr/bin/env bash
# Show the MCP server config from /root/.claude.json (the file cc-* workers read on launch).
set -euo pipefail
python3 - <<'PY'
import json, sys
data = json.load(open('/root/.claude.json'))
servers = data.get('mcpServers') or {}
print(f"Top-level mcpServers: {len(servers)}")
for name, cfg in servers.items():
    print(f"  {name}: {json.dumps(cfg)}")
# Also check per-project configs (claude code sometimes stores project-level).
projects = data.get('projects') or {}
for path, pcfg in projects.items():
    psrv = pcfg.get('mcpServers') or {}
    if psrv:
        print(f"Project {path} mcpServers: {len(psrv)}")
        for name, cfg in psrv.items():
            print(f"  {name}: {json.dumps(cfg)}")
PY
