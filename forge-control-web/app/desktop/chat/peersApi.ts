/**
 * peersApi.ts — naming the senders the team tree cannot reach.
 *
 * ── THE FINDING (round 1874, finding 1) ───────────────────────────────────
 * "28 of 128 comms cards don't say who spoke … `◂ c8bc5ffa unknown role Phase
 * 800 planned` — an 8-character id fragment and the literal words 'unknown
 * role' where the agent's name and role belong. Every affected card is ≥17h
 * old; cards from the last hour correctly read `◂ builder …`."
 *
 * That age split is the whole diagnosis. A card names its sender from two
 * sources and BOTH are bounded in time:
 *
 *   1. `meta.comms.peer_role`, stamped into the thread entry at write time —
 *      but only since round 808, so every entry older than that stamp has none;
 *   2. the team panel's already-polled `["chat-team", chatId]` tree, which is
 *      the team of ONE project and is itself built from a bounded feed. A run
 *      that finished yesterday is not in it, and 28 senders were not.
 *
 * Neither is fixable by rendering harder: the words are not in the payload. So
 * this module asks the ONE question the client cannot answer — "who are these
 * run ids" — of a route that exists for nothing else
 * (`forge-control/src/routes/agents.ts`, `GET /api/agents/peers`).
 *
 * ── WHY THIS ADDS NO POLL (NFU3) ──────────────────────────────────────────
 * A run's role and title are IMMUTABLE for the purposes of this card: a
 * settled run never changes either, and a live one is in the team tree, which
 * outranks this lookup anyway. So the query is keyed by the exact set of
 * unresolved ids, has `staleTime: Infinity`, no `refetchInterval`, and no
 * window/focus refetch. Opening the chat asks once for the ids the transcript
 * still cannot name; the answer is then cached for the life of the tab, and a
 * subsequent poll of the transcript re-renders against the same cache entry.
 *
 * Nothing here imports React — `scripts/checks/check-r1875-fixes.ts` imports
 * `unresolvedPeerIds` and `mergePeerFacts` directly under tsx.
 */

import type { PeerFacts } from "./comms-identity";
import { readComms } from "./comms-identity";

const ROOT = "/api/proxy";

/** One run, as `GET /api/agents/peers` describes it. Hand-mirrored from the
 *  `Peer` interface in forge-control/src/routes/agents.ts — same rule the team
 *  client states: this module must not reach across repos. */
export interface PeerRecord {
  id: string;
  role: string | null;
  description: string | null;
  project: string | null;
}

export interface PeersResponse {
  peers: PeerRecord[];
  /** Ids with no `runs` row. Returned so a caller can tell "this run is gone"
   *  from "we never asked", and so the merge below can record the ANSWER
   *  rather than asking again on the next render. */
  unknown: string[];
}

/** How many ids one request may carry — the server's own limit, mirrored so a
 *  transcript with hundreds of unnamed peers is truncated deliberately here
 *  rather than 400ed there. */
export const PEERS_MAX_IDS = 200;

export const fetchPeers = async (ids: readonly string[]): Promise<PeersResponse> => {
  if (ids.length === 0) return { peers: [], unknown: [] };
  const q = encodeURIComponent(ids.join(","));
  const r = await fetch(`${ROOT}/agents/peers?ids=${q}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /agents/peers`);
  return (await r.json()) as PeersResponse;
};

/** A run uuid, and nothing else. `peer_run_id` is written by the server so this
 *  should always hold; a sub-agent relay carries its `tool_use_id` in
 *  `subagent_id` instead, and sending one of those to a route that queries a
 *  `uuid` column is a 400 for the whole batch. */
const RUN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A thread entry, as much of it as this module reads. */
export interface PeerScanEntry {
  meta?: unknown;
}

/**
 * Which peer run ids this transcript mentions that NOBODY can currently name.
 *
 * "Name" is the same test the card applies, in the same order the header
 * applies it (`commsHeader`): the write-time stamp first, the team tree second.
 * An entry that already has either is not asked about — which is why a healthy
 * recent chat asks for nothing at all and issues no request.
 *
 * Sorted and de-duplicated, because the result is a react-query KEY: two
 * renders that need the same set must produce the same string, or the "one
 * request per chat" property above quietly becomes one request per render.
 *
 * Pure and total over `unknown` metas — it reads them through `readComms`, the
 * same validator the cards use, so the set of ids asked about is by
 * construction a subset of the cards on screen.
 */
export function unresolvedPeerIds(
  thread: readonly PeerScanEntry[] | null | undefined,
  known: ReadonlyMap<string, PeerFacts>,
  limit = PEERS_MAX_IDS,
): string[] {
  if (!thread || thread.length === 0) return [];
  const out = new Set<string>();
  for (const entry of thread) {
    const facts = readComms(entry.meta);
    if (facts === null) continue;
    if (facts.from === "konrad") continue; // not an agent; has no run to name
    if (facts.peerRole !== null) continue; // the stamp already named it
    const id = facts.peerRunId;
    if (id === null || !RUN_UUID_RE.test(id)) continue;
    const seen = known.get(id);
    if (seen && (seen.role !== null || seen.description !== null)) continue;
    out.add(id);
  }
  return [...out].sort().slice(0, limit);
}

/**
 * The map the transcript reads: the team tree, plus whatever the lookup could
 * add.
 *
 * THE TREE OUTRANKS THE LOOKUP, always. It is polled, so it holds the CURRENT
 * task title of a live worker, while this lookup is cached from whenever it
 * first ran. Where the tree has nothing, the lookup's answer is used; where
 * neither has anything, the id is absent from the map and the card falls back
 * to "unknown role" exactly as before. Nothing is invented at any step.
 *
 * Returns the tree map UNCHANGED (same object) when the lookup adds nothing —
 * so a chat whose peers are all named allocates no map and re-renders no
 * transcript. That identity is load-bearing: `peers` is a prop of the memoised
 * `AssistantThread`.
 */
export function mergePeerFacts(
  tree: ReadonlyMap<string, PeerFacts>,
  looked: readonly PeerRecord[] | undefined,
): ReadonlyMap<string, PeerFacts> {
  if (!looked || looked.length === 0) return tree;
  const additions: PeerRecord[] = [];
  for (const p of looked) {
    if (p.role === null && p.description === null) continue; // nothing to add
    const seen = tree.get(p.id);
    if (seen && (seen.role !== null || seen.description !== null)) continue;
    additions.push(p);
  }
  if (additions.length === 0) return tree;
  const map = new Map(tree);
  for (const p of additions) map.set(p.id, { role: p.role, description: p.description });
  return map;
}
