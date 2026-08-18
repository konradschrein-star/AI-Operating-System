"use client";

/**
 * ManagerThread — the operator chat's transcript, with the two things only
 * this surface can supply: who the peers are, and what a control may do.
 *
 * It exists as its own component for a scope reason, not an aesthetic one.
 * `AssistantThread` is mounted from four places (the manager chat, the drilled
 * agent view, a sub-agent slice, ProjectsSurface), and only ONE of them has a
 * composer to type into or a credential panel to open. Putting the wiring here
 * keeps `ChatSurface`'s change to a single line and keeps `AssistantThread`
 * ignorant of react-query, which is what lets the check scripts import its
 * mapper without a client.
 *
 * ── THE PEER MAP COSTS NOTHING ────────────────────────────────────────────
 * `enabled: false` on a query key the TEAM PANEL already polls
 * (`["chat-team", chatId]`, ChatTeamPanel.tsx:162). react-query still
 * subscribes this component to that cache entry — so the roles arrive and
 * re-render the transcript the moment the panel refreshes — but it issues no
 * request of its own, ever. The poll budget (NFU3) does not move by one
 * request per minute.
 *
 * When the panel has never been open the cache is empty, the map is empty, and
 * a comms card with no `peer_role` stamp says "unknown role". That is the
 * honest reading of "nobody has told me", and it is why the server-side stamp
 * exists (comms-identity.ts).
 *
 * ── AND THE PEERS THE TREE CANNOT REACH (round 1875, finding 1) ───────────
 * "28 of 128 comms cards don't say who spoke … every affected card is ≥17h
 * old." The tree above is one project's team; a run that finished yesterday is
 * not in it, and neither is a run of the OTHER project this chat started. Those
 * senders were unnameable from anything the client held.
 *
 * So a second query fills the remainder — `GET /api/agents/peers`, asked once,
 * for exactly the ids the transcript still cannot name, cached for the life of
 * the tab. It is a LOOKUP, not a poll: its key is the id set itself, its
 * `staleTime` is Infinity, and a chat whose peers are all named produces an
 * empty key and issues no request at all. See ./peersApi for the reasoning in
 * full, including why the tree still outranks it.
 */

import { memo, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunDetail } from "../../api";
import { AssistantThread } from "./AssistantThread";
import type { PeerFacts } from "./comms-identity";
import type { RichActions } from "./RichMessage";
import {
  fetchPeers,
  mergePeerFacts,
  unresolvedPeerIds,
  type PeersResponse,
} from "./peersApi";
import { fetchChatTeam, type TeamNode, type TeamResponse } from "../team/teamApi";

/** run id → what the tree knows about that run: its `metadata.role` and its
 *  task title.
 *
 *  Sub-agents are deliberately included: their `id` is a Task `tool_use_id`,
 *  which can never collide with a run uuid, and a relay addressed at one
 *  (`meta.comms.subagent_id`) is the one case where that id is what the
 *  transcript holds.
 *
 *  ROUND 1871 — `description` joins `role` here. It is the peer's task title
 *  ("Fix cycle 1"), and it is what a comms card now leads with; a node with
 *  neither still contributes an entry, because knowing a peer exists in this
 *  team is itself worth more than the raw uuid the card fell back to. Both
 *  fields are null rather than "" when absent: "absent" and "" must not become
 *  the same answer. */
export function buildPeerRoles(
  team: TeamResponse | undefined,
): ReadonlyMap<string, PeerFacts> {
  const map = new Map<string, PeerFacts>();
  if (!team) return map;
  const nonEmpty = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  const add = (node: TeamNode) => {
    map.set(node.id, {
      role: nonEmpty(node.role),
      description: nonEmpty(node.description),
    });
    for (const sub of node.subagents) add(sub);
  };
  add(team.manager);
  for (const worker of team.workers) add(worker);
  return map;
}

export interface ManagerThreadProps {
  run: RunDetail;
  /** Append an agent-offered option to the composer draft. */
  onInsertDraft: (text: string) => void;
  /** Open the secure credential panel for a named secret. */
  onOpenSecret: (name: string) => void;
}

/**
 * ── ROUND 1871: THIS MEMO IS THE TYPING FIX ───────────────────────────────
 *
 * Measured on this box, worktree build, chat `bfd1283a` (117 comms cards, 449
 * tool rows): 60 keystrokes into the composer cost **79 ms/key** against a
 * **1.05 ms/key** bare-textarea control in the same page, with 9–24 long tasks
 * per six-second burst. The mechanism is one line of React:
 * `ChatThread` owns `draft`, and `ChatThread` renders this component. Every
 * keystroke therefore re-rendered the entire transcript — every `CommsMessage`,
 * every `ToolCallRow`, every assistant-ui message wrapper — to change the value
 * of one `<textarea>`.
 *
 * `memo` stops that at this boundary, and the boundary is the right one: the
 * transcript's inputs are `run`, `peers` and `actions`, and NONE of them is a
 * function of the draft. What makes the bail-out actually happen is the caller:
 * `ChatThread` hoists `onInsertDraft`/`onOpenSecret` into `useCallback`s with
 * no changing dependencies, so the two props keep their identity across a
 * keystroke. A fresh arrow at the call site would defeat this entirely and the
 * measurement would silently go back to 79 ms/key — which is why the check
 * `scripts/checks/check-typing-memo.ts` asserts both halves.
 *
 * `run` comes from react-query and keeps its identity between polls, so typing
 * bails out and a poll still re-renders. That is exactly the split wanted.
 */
function ManagerThreadImpl({ run, onInsertDraft, onOpenSecret }: ManagerThreadProps) {
  const teamQ = useQuery<TeamResponse, Error>({
    queryKey: ["chat-team", run.id],
    // Required by the adapter and never called while `enabled` is false. It is
    // the panel's identical function, so if this ever WERE enabled it would
    // read the same endpoint rather than inventing a second contract.
    queryFn: () => fetchChatTeam(run.id),
    enabled: false,
    staleTime: Infinity,
  });

  const treePeers = useMemo(() => buildPeerRoles(teamQ.data), [teamQ.data]);

  /* The ids nobody can name yet, recomputed only when the thread or the tree
   * changes — never on a keystroke, because this component is memoised above
   * that. `.join(",")` is the query KEY: two renders that need the same set
   * must produce the same key, which is why `unresolvedPeerIds` sorts. */
  const missing = useMemo(
    () => unresolvedPeerIds(run.thread, treePeers),
    [run.thread, treePeers],
  );
  const missingKey = missing.join(",");

  const peersQ = useQuery<PeersResponse, Error>({
    queryKey: ["comms-peers", missingKey],
    queryFn: () => fetchPeers(missing),
    // Nothing to ask about is the healthy case, and it must not become a
    // request for the empty set.
    enabled: missing.length > 0,
    /* A settled run never changes its role or its title, and a LIVE one is in
     * the tree, which outranks this. So: fetched once, never refetched, never
     * garbage-collected out from under a transcript the operator is reading. */
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    /* One failure is one un-named card, not a broken transcript — the header
     * falls back to exactly what it printed before this query existed. Retrying
     * a lookup that 400s on a malformed id would only repeat it. */
    retry: 0,
  });

  const peers = useMemo(
    () => mergePeerFacts(treePeers, peersQ.data?.peers),
    [treePeers, peersQ.data],
  );
  const actions = useMemo<RichActions>(
    () => ({ insertDraft: onInsertDraft, openSecret: onOpenSecret }),
    [onInsertDraft, onOpenSecret],
  );

  return <AssistantThread run={run} peers={peers} actions={actions} />;
}

export const ManagerThread = memo(ManagerThreadImpl);

export default ManagerThread;
