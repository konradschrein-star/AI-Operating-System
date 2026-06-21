/**
 * forge-control-mcp — stdio MCP server exposing AI OS memory.search.
 *
 * Wraps GET /api/memory/search on the local forge-control instance so cc-*
 * workers can call it as a native MCP tool from their tmux sessions. The
 * audit's "MCP for cc-* workers" win without standing up TrustGraph Mid's
 * Cassandra+Pulsar+Qdrant+Garage stack.
 *
 * Tools exposed:
 *   - memory.search    Vector + multi-hop GraphRAG + category filter
 *   - memory.note      Fetch a single Obsidian note by slug
 *   - memory.list      List recent vault notes (paginated)
 *
 * Wire-up: add to /root/.claude.json mcpServers — see README.md beside this
 * file for the exact entry.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const FORGE_CONTROL_URL =
  process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

const TRIPLE_CATEGORIES = [
  "decision",
  "rule",
  "error",
  "provider",
  "job",
  "format",
  "person",
  "other",
] as const;

const server = new Server(
  { name: "forge-control-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory.search",
      description:
        "Search Konrad's AI OS memory: halfvec(1024) vector + multi-hop GraphRAG " +
        "over the Obsidian vault and HCP message corpus. Each hit carries lane " +
        "metadata (via='vector'|'graph', hop=0|1|2) so the model can judge " +
        "indirection. Optional category filter narrows the graph walk to one " +
        "of: decision / rule / error / provider / job / format / person / other.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language query.",
          },
          expand: {
            type: "boolean",
            description:
              "Enable GraphRAG expansion on top of vector cosine. Default true.",
            default: true,
          },
          hops: {
            type: "integer",
            description: "Max graph hops (0-3). Default 2.",
            minimum: 0,
            maximum: 3,
            default: 2,
          },
          category: {
            type: "string",
            enum: [...TRIPLE_CATEGORIES],
            description:
              "Only follow triples of this category during graph expansion.",
          },
          limit: {
            type: "integer",
            description: "Max vector hits (1-50). Default 12.",
            minimum: 1,
            maximum: 50,
            default: 12,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory.note",
      description:
        "Fetch a single Obsidian note by slug (filename without .md). " +
        "Returns full body, frontmatter, wikilinks, and backlinks.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Vault note slug." },
        },
        required: ["slug"],
      },
    },
    {
      name: "memory.list",
      description:
        "List recent vault notes with one-chunk previews. Use to browse what's " +
        "available before drilling in via memory.note.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "How many notes to return (1-500). Default 50.",
            minimum: 1,
            maximum: 500,
            default: 50,
          },
        },
      },
    },
  ],
}));

interface ToolArgs {
  [key: string]: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

async function callMemorySearch(args: ToolArgs): Promise<unknown> {
  const query = asString(args.query)?.trim();
  if (!query) throw new Error("memory.search requires `query` (string)");

  const url = new URL("/api/memory/search", FORGE_CONTROL_URL);
  url.searchParams.set("q", query);

  const expand = asBool(args.expand) ?? true;
  if (expand) url.searchParams.set("expand", "1");

  const hops = asInt(args.hops);
  if (hops !== undefined) url.searchParams.set("hops", String(hops));

  const category = asString(args.category);
  if (category) {
    if (!(TRIPLE_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(
        `unknown category "${category}" — valid: ${TRIPLE_CATEGORIES.join(", ")}`,
      );
    }
    url.searchParams.set("category", category);
  }

  const limit = asInt(args.limit);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`forge-control returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function callMemoryNote(args: ToolArgs): Promise<unknown> {
  const slug = asString(args.slug)?.trim();
  if (!slug) throw new Error("memory.note requires `slug` (string)");
  const url = new URL(
    `/api/memory/${encodeURIComponent(slug)}`,
    FORGE_CONTROL_URL,
  );
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`forge-control returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function callMemoryList(args: ToolArgs): Promise<unknown> {
  const limit = asInt(args.limit) ?? 50;
  const url = new URL("/api/memory", FORGE_CONTROL_URL);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`forge-control returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;

  let result: unknown;
  try {
    switch (name) {
      case "memory.search":
        result = await callMemorySearch(args);
        break;
      case "memory.note":
        result = await callMemoryNote(args);
        break;
      case "memory.list":
        result = await callMemoryList(args);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: e instanceof Error ? e.message : String(e),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
