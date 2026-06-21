/**
 * Pre-turn memory prefetch — pattern lifted from NousResearch/hermes-agent
 * agent/memory_manager.py (concept; MIT). Before every turn we look at the
 * user's latest message, run a vector + 1-hop GraphRAG search against the
 * existing knowledge_embeddings + knowledge_triples store (see db/memory.ts),
 * and prepend a compact `[MEMORY]` block to the prompt with the top hits.
 *
 * Why: claude-pool's underlying model has no access to Konrad's Obsidian
 * vault or the indexed HCP message corpus. Without this, the assistant
 * answers from training data only and re-derives facts the system already
 * knows. With it, recent decisions / standing preferences / project state
 * land in-context before the assistant generates anything.
 *
 * Post-turn memory write-back (taking the assistant response and pushing it
 * into the embedding/triple store) is deferred — km-indexer already owns
 * vault-file ingestion and the assistant text isn't yet captured anywhere
 * the indexer can reach. We can revisit once we decide whether to mirror
 * assistant turns into the vault or persist them directly.
 */

import { searchMemoryWithGraph, type SearchHitWithLane } from "../db/memory.ts";

const PREFETCH_ENABLED =
  (process.env.MEMORY_PREFETCH_ENABLED ?? "1") !== "0";
const VECTOR_LIMIT = Number(
  process.env.MEMORY_PREFETCH_VECTOR_LIMIT ?? "5",
);
const GRAPH_LIMIT = Number(process.env.MEMORY_PREFETCH_GRAPH_LIMIT ?? "3");
const MIN_QUERY_CHARS = Number(
  process.env.MEMORY_PREFETCH_MIN_QUERY_CHARS ?? "16",
);
const SNIPPET_CHARS = Number(process.env.MEMORY_PREFETCH_SNIPPET_CHARS ?? "320");

export interface PrefetchedMemory {
  hits: SearchHitWithLane[];
  block: string | null;
}

/** Build a single `[MEMORY]` block from the hits, suitable for prepending to a
 *  prompt sent to claude-pool. Vector hits come first (hop=0), then graph
 *  hits in hop order. Each entry's lane label distinguishes vector from
 *  graph-N-hop so the model knows how indirect the connection is. */
function formatMemoryBlock(hits: SearchHitWithLane[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = [
    "[MEMORY]",
    "Background context the user has previously decided on or recorded. " +
      "Use it as reference, NOT as the active instruction.",
    "",
  ];
  for (const h of hits) {
    const snippet = h.snippet.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ").trim();
    const lane = h.via === "graph" ? `graph ${h.hop}-hop` : "vector";
    lines.push(
      `- ${h.title || h.slug} (${lane}, score=${h.score.toFixed(2)}): ${snippet}`,
    );
  }
  lines.push("[END MEMORY]", "");
  return lines.join("\n");
}

export async function prefetchMemoryForUserTurn(
  userText: string,
): Promise<PrefetchedMemory> {
  if (!PREFETCH_ENABLED) return { hits: [], block: null };
  const query = userText.trim();
  if (query.length < MIN_QUERY_CHARS) return { hits: [], block: null };

  let hits: SearchHitWithLane[] = [];
  try {
    hits = await searchMemoryWithGraph(query, {
      vectorLimit: VECTOR_LIMIT,
      graphLimit: GRAPH_LIMIT,
    });
  } catch (e) {
    console.warn(
      "[memory-prefetch] search failed — skipping prefetch:",
      e instanceof Error ? e.message : e,
    );
    return { hits: [], block: null };
  }

  if (hits.length === 0) return { hits: [], block: null };
  return { hits, block: formatMemoryBlock(hits) };
}

/** Find the most recent user turn in a thread, or null if none. Used by the
 *  executor to derive the prefetch query without coupling the memory module
 *  to the ThreadEntry type. */
export function lastUserText(
  thread: Array<{ role: string; content: string }>,
): string | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i];
    if (e.role === "user" && e.content) return e.content;
  }
  return null;
}
