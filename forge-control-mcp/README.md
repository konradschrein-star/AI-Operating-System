# forge-control-mcp

Stdio MCP server exposing AI OS `memory.search` (+ `memory.note`, `memory.list`) as native tools for cc-* worker sessions.

## Why this exists

The maximalist TrustGraph re-audit listed "MCP for cc-* workers" as a Tier-3 win. The Mid-tier build path that produced it required Cassandra + Pulsar + Qdrant + Garage on the VPS (8–18 GB RAM, 4–6 new processes), and the FalkorDB profile that made it sustainable has been pulled from the official TrustGraph config builder. This package is the ~150-LOC equivalent that gets cc-* workers MCP access to our existing halfvec + knowledge_triples store without any of that infra.

## Wiring (VPS)

The cc-* workers all read `/root/.claude.json` on launch. Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "forge-memory": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/opt/forge-ai-os/forge-control-mcp/src/server.ts"
      ],
      "env": {
        "FORGE_CONTROL_URL": "http://127.0.0.1:7700"
      }
    }
  }
}
```

cc-* tmux sessions don't auto-reload `~/.claude.json` — kill + restart the session to pick up the new server (this is the same foot-gun documented in `project-auto-browser-pending`).

## Tools exposed

| tool          | shape                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| memory.search | `{query, expand?=true, hops?=2, category?, limit?=12}` — vector + multi-hop GraphRAG with optional category filter |
| memory.note   | `{slug}` — full body + frontmatter + wikilinks + backlinks for one vault note                                      |
| memory.list   | `{limit?=50}` — recent vault notes with one-chunk previews                                                         |

Categories (memory.search): `decision | rule | error | provider | job | format | person | other`. Filters the graph walk to triples of that category — vector hits are unaffected.

## Local smoke

```bash
cd forge-control-mcp
pnpm install
pnpm typecheck
# Send a ListTools request directly over stdio
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | pnpm start
```

## Updating

Restart cc-* sessions after `git pull` since they spawn this server fresh on each launch.
