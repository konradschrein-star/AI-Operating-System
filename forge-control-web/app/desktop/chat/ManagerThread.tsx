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
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunDetail } from "../../api";
import { AssistantThread } from "./AssistantThread";
import type { RichActions } from "./RichMessage";
import { fetchChatTeam, type TeamNode, type TeamResponse } from "../team/teamApi";

/** run id → `metadata.role`, for every run node in the tree.
 *
 *  Sub-agents are deliberately included: their `id` is a Task `tool_use_id`,
 *  which can never collide with a run uuid, and a relay addressed at one
 *  (`meta.comms.subagent_id`) is the one case where that id is what the
 *  transcript holds. Nodes with no role contribute nothing rather than an
 *  empty string — "absent" and "" must not become the same answer. */
export function buildPeerRoles(team: TeamResponse | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (!team) return map;
  const add = (node: TeamNode) => {
    if (typeof node.role === "string" && node.role !== "") map.set(node.id, node.role);
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

export function ManagerThread({ run, onInsertDraft, onOpenSecret }: ManagerThreadProps) {
  const teamQ = useQuery<TeamResponse, Error>({
    queryKey: ["chat-team", run.id],
    // Required by the adapter and never called while `enabled` is false. It is
    // the panel's identical function, so if this ever WERE enabled it would
    // read the same endpoint rather than inventing a second contract.
    queryFn: () => fetchChatTeam(run.id),
    enabled: false,
    staleTime: Infinity,
  });

  const peers = useMemo(() => buildPeerRoles(teamQ.data), [teamQ.data]);
  const actions = useMemo<RichActions>(
    () => ({ insertDraft: onInsertDraft, openSecret: onOpenSecret }),
    [onInsertDraft, onOpenSecret],
  );

  return <AssistantThread run={run} peers={peers} actions={actions} />;
}

export default ManagerThread;
