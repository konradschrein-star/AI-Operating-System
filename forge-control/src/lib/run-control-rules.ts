/**
 * Manager control plane — the pure decision rules.
 *
 * Two processes act on the same `runs` row: forge-control (the HTTP route
 * `routes/run-control.ts`) and forge-executor (`executor.ts`). If either one
 * decided eligibility or completion semantics on its own, the two would drift
 * the first time somebody edited one and not the other. So both import THIS
 * file and neither is allowed to reimplement any of it (07 §2, requirement C5).
 *
 * Everything here is pure and synchronous: no db/, no pg, no fs, no network,
 * and no clock — `ts` is always a parameter — so the whole surface is
 * table-testable without a database (there is no test DB in this suite) and a
 * given input always produces a byte-identical output.
 *
 * Design sources: docs/plan/06-control-plane-requirements.md (C1–C24),
 * docs/plan/07-control-plane-architecture.md §3 (the comms wire contract),
 * §4 (the endpoint table), §5 (the delivery handshake), §6 (the completion
 * guard), and the vault note "AI OS/Contract - Manager Control Plane API.md".
 */

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "stuck"
  | "completed"
  | "failed"
  | "cancelled";

export type CommsFrom = "konrad" | "manager" | "worker";

/**
 * The only failure shape on this surface. C20: no 200-that-did-nothing, no
 * silent fallback — every refusal is a 4xx carrying a `reason` the UI renders
 * verbatim in a toast, so each string below is written for a human to read.
 */
export type Rejection = { kind: "reject"; status: 409; reason: string };

/* ------------------------------------------------------------------------- *
 * Eligibility matrices (07 §4).
 *
 * These are exported as data — not just baked into the switches — because the
 * eligible list is carried into SQL as the UPDATE's precondition
 * (`WHERE id=$1 AND status = ANY($2)`), which is what makes two operators
 * clicking at once resolve to one 202 and one 409 instead of a mixed state.
 *
 * WHO CARRIES WHAT, precisely (the R905 gating reviewer caught this comment
 * claiming more than it delivered):
 *
 *  - `STOP_ELIGIBLE` / `TERMINATE_ELIGIBLE` are imported by `db/runs.ts` and
 *    baked into `stopRun`/`terminateRun`'s own WHERE clause. The route never
 *    sees them.
 *  - `/message` has THREE preconditions, not one — a message to a `running`
 *    row must not land on a row that became `completed` under it, because the
 *    two need different writes. So the per-status precondition travels inside
 *    the action itself (`MessageAction.eligible`), and the route puts THAT in
 *    the WHERE. `MESSAGE_ELIGIBLE` below is derived from the same three arrays,
 *    so the union and the partition cannot drift.
 *  - `RESUME_ELIGIBLE` is CP2's; nothing carries it into SQL yet.
 * ------------------------------------------------------------------------- */

/** queued — nothing to move: the pending turn folds the thread tail in itself. */
const APPEND_ELIGIBLE: readonly RunStatus[] = ["queued"];
/** running — the flag write's precondition (07 §5, T2). */
const FLAG_ELIGIBLE: readonly RunStatus[] = ["running"];
/** paused | stuck | completed — the requeue's precondition. */
const QUEUE_ELIGIBLE: readonly RunStatus[] = ["paused", "stuck", "completed"];

/**
 * Derived, never hand-written: the union of the three partitions above. A
 * status added to one of them is a status this matrix reports as eligible, with
 * no second edit and no way to forget one.
 */
export const MESSAGE_ELIGIBLE: readonly RunStatus[] = [
  ...APPEND_ELIGIBLE,
  ...FLAG_ELIGIBLE,
  ...QUEUE_ELIGIBLE,
];

export const RESUME_ELIGIBLE: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "stuck",
  "paused",
];

export const STOP_ELIGIBLE: readonly RunStatus[] = [
  "queued",
  "running",
  "stuck",
];

export const TERMINATE_ELIGIBLE: readonly RunStatus[] = [
  "queued",
  "running",
  "paused",
  "stuck",
];

/**
 * Every switch over RunStatus in this file ends in `default:` calling this, so
 * adding a status to the union without deciding what each verb does to it is a
 * COMPILE error rather than a silently-missing row in a matrix.
 */
function unreachableStatus(status: never): never {
  throw new Error(`unhandled run status: ${String(status)}`);
}

/* ------------------------------------------------------------------------- *
 * POST /api/runs/:id/message  (C1–C4)
 * ------------------------------------------------------------------------- */

/**
 * `eligible` is the precondition the route puts into the append's WHERE, the
 * same way `StatusVerbAction` carries stop's and terminate's. It lives ON the
 * action rather than in a lookup table beside it so that a status added to a
 * `case` below cannot be accepted by `messageAction` and then rejected by an
 * out-of-date precondition list — the accept and the precondition are now one
 * value, produced in one place.
 */
export type MessageAction =
  /** queued — the pending turn's prompt builder folds the thread tail in. */
  | { kind: "append"; eligible: readonly RunStatus[] }
  /** running — append + metadata.pending_input=true in ONE statement (07 §5). */
  | { kind: "append_and_flag"; eligible: readonly RunStatus[] }
  /** paused | stuck | completed — append + status 'queued' (for stuck this doubles as the nudge). */
  | { kind: "append_and_queue"; eligible: readonly RunStatus[] }
  | Rejection;

export function messageAction(status: RunStatus): MessageAction {
  switch (status) {
    case "queued":
      return { kind: "append", eligible: APPEND_ELIGIBLE };
    case "running":
      // The turn in flight is untouchable (`claude -p` closed its stdin at
      // spawn). The flag is consumed by the executor's completion handshake,
      // which requeues instead of completing — see completionTransition.
      return { kind: "append_and_flag", eligible: FLAG_ELIGIBLE };
    case "paused":
    case "stuck":
    case "completed":
      return { kind: "append_and_queue", eligible: QUEUE_ELIGIBLE };
    // failed/cancelled are resume-chat's job: reopening a dead run is a
    // deliberate act, not casual messaging (06 C1).
    case "failed":
      return {
        kind: "reject",
        status: 409,
        reason: "run failed - use POST /api/runs/:id/resume-chat to reopen it",
      };
    case "cancelled":
      return {
        kind: "reject",
        status: 409,
        reason:
          "run cancelled - use POST /api/runs/:id/resume-chat to reopen it",
      };
    default:
      return unreachableStatus(status);
  }
}

/* ------------------------------------------------------------------------- *
 * POST /api/runs/:id/resume-chat  (C6)
 * ------------------------------------------------------------------------- */

export type ResumeAction = { kind: "resume" } | Rejection;

export function resumeAction(status: RunStatus): ResumeAction {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "stuck":
    case "paused":
      return { kind: "resume" };
    // Both rejections name the other verb: no status is unreachable by both
    // /message and /resume-chat without the reason saying where to go (08 §1).
    case "running":
      return {
        kind: "reject",
        status: 409,
        reason: "run is still running - use POST /api/runs/:id/message to talk to it",
      };
    case "queued":
      return {
        kind: "reject",
        status: 409,
        reason:
          "run is queued and will start on its own - use POST /api/runs/:id/message to talk to it",
      };
    default:
      return unreachableStatus(status);
  }
}

/* ------------------------------------------------------------------------- *
 * POST /api/runs/:id/stop  and  /terminate  (C11, C12)
 * ------------------------------------------------------------------------- */

/** `eligible` is the precondition the route puts into the UPDATE's WHERE. */
export type StatusVerbAction =
  | { kind: "apply"; to: RunStatus; eligible: readonly RunStatus[] }
  | Rejection;

/**
 * Stop is `paused` — an existing status the executor's 5s kill-poll already
 * honors, and which stays resumable. No new enum value (contract Q3).
 */
export function stopAction(status: RunStatus): StatusVerbAction {
  switch (status) {
    case "queued":
    case "running":
    case "stuck":
      return { kind: "apply", to: "paused", eligible: STOP_ELIGIBLE };
    case "paused":
      return { kind: "reject", status: 409, reason: "run is already paused" };
    case "completed":
    case "failed":
    case "cancelled":
      return {
        kind: "reject",
        status: 409,
        reason: `run is already settled (${status})`,
      };
    default:
      return unreachableStatus(status);
  }
}

/**
 * Terminate is `cancelled` AND `completed_at = now()` in one UPDATE — the
 * consistency fix the contract §4 explicitly invites (today's cancel path
 * leaves completed_at NULL and durations fall back to updated_at).
 */
export function terminateAction(status: RunStatus): StatusVerbAction {
  switch (status) {
    case "queued":
    case "running":
    case "paused":
    case "stuck":
      return { kind: "apply", to: "cancelled", eligible: TERMINATE_ELIGIBLE };
    case "cancelled":
      return { kind: "reject", status: 409, reason: "run is already cancelled" };
    case "completed":
    case "failed":
      return {
        kind: "reject",
        status: 409,
        reason: `run is already settled (${status})`,
      };
    default:
      return unreachableStatus(status);
  }
}

/* ------------------------------------------------------------------------- *
 * The completion transition (07 §5 handshake + 07 §6 guard).
 * ------------------------------------------------------------------------- */

export interface CompletionInput {
  outcome: "completed" | "failed" | "stuck";
  /** The status the row ACTUALLY holds when the completion write is attempted. */
  rowStatus: RunStatus;
  /** metadata.pending_input — set by /message against a running target. */
  pendingInput: boolean;
}

export interface CompletionDecision {
  /** false → the executor writes nothing at all and logs the yield. */
  write: boolean;
  status: RunStatus | null;
  clearPendingInput: boolean;
  notify: boolean;
  stampCompletedAt: boolean;
  yielded: boolean;
  /** Log line / test assertion text. */
  reason: string;
}

export function completionTransition(i: CompletionInput): CompletionDecision {
  // C13, the completion guard. Window: the child emits its final events and
  // exits cleanly inside the same ~5s in which an operator writes
  // paused/cancelled — the kill-poll never fires, and an unconditional
  // completion write would overwrite the operator's verb. The operator ALWAYS
  // wins, for every outcome, regardless of pendingInput. In SQL this is the
  // `AND status='running'` on the completion UPDATE; rowcount 0 lands here.
  if (i.rowStatus !== "running") {
    return {
      write: false,
      status: null,
      clearPendingInput: false,
      notify: false,
      stampCompletedAt: false,
      yielded: true,
      reason: `completion yielded to operator status ${i.rowStatus}`,
    };
  }

  switch (i.outcome) {
    case "completed":
      // The message landed before this write, so the run owes one more turn.
      // Requeue instead of completing: the next turn's trailingUserBlock
      // contains the comms entry. Flag cleared here (E2 in the 07 §5 diagram);
      // the claim loop clears it again as a belt to the braces.
      if (i.pendingInput) {
        return {
          write: true,
          status: "queued",
          clearPendingInput: true,
          notify: false,
          stampCompletedAt: false,
          yielded: false,
          reason: "pending input consumed - requeued for next turn",
        };
      }
      return {
        write: true,
        status: "completed",
        clearPendingInput: false,
        notify: true,
        stampCompletedAt: true,
        yielded: false,
        reason: "completed",
      };

    // failed/stuck deliberately do NOT consume the flag (07 §5, last bullet):
    // a message must never convert a failure into a silent retry loop. The
    // comms entry stays in the thread, the failure notification fires as
    // normal, and resume-chat is what delivers the message.
    case "failed":
      return {
        write: true,
        status: "failed",
        clearPendingInput: false,
        notify: true,
        stampCompletedAt: true,
        yielded: false,
        reason: "failed",
      };
    case "stuck":
      // stuck leaves completed_at NULL — executor.ts completeRun already
      // documents this; a stuck run is not finished, it is abandoned mid-flight.
      return {
        write: true,
        status: "stuck",
        clearPendingInput: false,
        notify: true,
        stampCompletedAt: false,
        yielded: false,
        reason: "stuck",
      };
    default:
      return unreachableOutcome(i.outcome);
  }
}

function unreachableOutcome(outcome: never): never {
  throw new Error(`unhandled completion outcome: ${String(outcome)}`);
}

/* ------------------------------------------------------------------------- *
 * Comms thread entries — a WIRE CONTRACT (07 §3). The UI parses `meta`.
 * ------------------------------------------------------------------------- */

/** Run ids are shown to humans in 8-char form everywhere in this system. */
export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

export interface CommsMeta {
  comms: {
    direction: "in" | "out";
    from: CommsFrom;
    peer_run_id: string | null;
    subagent_id?: string;
  };
}

export interface CommsThreadEntry {
  role: "user" | "agent";
  content: string;
  ts: string;
  kind: "comms";
  meta: CommsMeta;
}

export interface CommsInput {
  text: string;
  from: CommsFrom;
  targetRunId: string;
  senderRunId?: string | null;
  /** ISO timestamp — a parameter, never a default, so this module has no clock. */
  ts: string;
  /** Non-empty → the relay variant for POST /:parentId/subagent-message (C10). */
  relaySubagentId?: string | null;
}

/**
 * Who the message is from, as the receiver reads it. The label is IN-BAND on
 * purpose: it survives a full-transcript rebuild after a resume-miss, so
 * attribution can never be lost to a session that had to be replayed.
 */
function actorLabel(from: CommsFrom, senderRunId?: string | null): string {
  switch (from) {
    case "konrad":
      return "konrad";
    case "manager":
      return senderRunId ? `manager ${shortId(senderRunId)}` : "manager";
    case "worker":
      return senderRunId ? `worker ${shortId(senderRunId)}` : "worker";
    default:
      return unreachableFrom(from);
  }
}

function unreachableFrom(from: never): never {
  throw new Error(`unhandled comms sender: ${String(from)}`);
}

/** Managers and Konrad talk DOWN to a worker; a worker reports UP to its manager. */
function echoLabel(from: CommsFrom, targetRunId: string): string {
  switch (from) {
    case "konrad":
    case "manager":
      return `[to worker ${shortId(targetRunId)}]`;
    case "worker":
      return `[to manager ${shortId(targetRunId)}]`;
    default:
      return unreachableFrom(from);
  }
}

export function commsEntries(i: CommsInput): {
  receiver: CommsThreadEntry;
  echo: CommsThreadEntry | null;
} {
  const text = i.text.trim();
  // C20: a hard error, not an empty entry. The route validates first and
  // returns 400; this throw is the backstop for any other caller.
  if (!text) throw new Error("text required");

  const actor = actorLabel(i.from, i.senderRunId);
  const relayId =
    typeof i.relaySubagentId === "string" && i.relaySubagentId.length > 0
      ? i.relaySubagentId
      : null;

  // A sub-agent has no session of its own outside its parent, so the only
  // honest delivery is to instruct the parent to hand it over via its harness
  // and report back. Still role "user", still kind "comms", still direction
  // "in" — only the content and one meta key differ (C10).
  const content = relayId
    ? `[relay from ${actor} -> sub-agent ${relayId}] Deliver this to that sub-agent via your harness (SendMessage) and report its reply back here: ${text}`
    : `[message from ${actor}] ${text}`;

  const receiver: CommsThreadEntry = {
    // role "user" so BOTH prompt builders deliver it unchanged —
    // trailingUserBlock for resumed sessions, buildPromptFromThread for fresh.
    role: "user",
    content,
    ts: i.ts,
    kind: "comms",
    meta: {
      comms: {
        direction: "in",
        from: i.from,
        peer_run_id: i.senderRunId ?? null,
        ...(relayId ? { subagent_id: relayId } : {}),
      },
    },
  };

  // No sender → no echo. Konrad messaging from the UI has no run of his own.
  const senderRunId =
    typeof i.senderRunId === "string" && i.senderRunId.length > 0
      ? i.senderRunId
      : null;
  if (!senderRunId) return { receiver, echo: null };

  return {
    receiver,
    echo: {
      // role "agent": db/runs.ts already allows it, and neither prompt builder
      // treats it as engine output — so an echo can never requeue the sender
      // nor terminate trailingUserBlock's tail scan (C3, red-team S7).
      role: "agent",
      content: `${echoLabel(i.from, i.targetRunId)} ${text}`,
      ts: i.ts,
      kind: "comms",
      meta: {
        comms: {
          direction: "out",
          from: i.from,
          peer_run_id: i.targetRunId,
        },
      },
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Sub-agent addressing (C10)
 * ------------------------------------------------------------------------- */

/** The contract's own honest-refusal wording; the UI shows it verbatim. */
export const SUBAGENT_UNADDRESSABLE = "subagent context not addressable";

/**
 * The address space is `metadata.subagents_v2[*].id` — the Task tool_use_id the
 * rollup records, and the only stable address a sub-agent has.
 *
 * NEVER throws: a run that predates the rollup, or has never spawned a
 * sub-agent, simply has no such key. That is normal, and the correct answer is
 * `false` (→ 409 with the wording above), not a 500.
 */
export function subagentAddressable(
  metadata: unknown,
  subagentId: string,
): boolean {
  if (typeof subagentId !== "string" || subagentId.length === 0) return false;
  if (typeof metadata !== "object" || metadata === null) return false;
  const list = (metadata as Record<string, unknown>).subagents_v2;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 && id === subagentId;
  });
}

/* ------------------------------------------------------------------------- *
 * Project slug (C18 / boundary D6)
 * ------------------------------------------------------------------------- */

const SLUG_MAX = 48;

/**
 * Every FUTURE project's planning corpus is born at `docs/plan/<slug>/`, so
 * this string ends up interpolated into paths in the goal-mode architect and
 * planner prompts (wired in CP3). It must therefore be filesystem-safe and,
 * above all, IDEMPOTENT: `projectSlug(projectSlug(x)) === projectSlug(x)`, or a
 * corpus path re-derived from an already-slugged name would drift.
 *
 * NFKD + combining-mark strip is what turns "Übungs-Projekt" into
 * "ubungs-projekt" rather than dropping the vowel entirely.
 */
export function projectSlug(name: string, id?: string | null): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");

  if (slug) return slug;

  // Degenerate name (all punctuation, all CJK, empty). Fall back to the id so
  // two unnameable projects never collide on one corpus directory.
  const trimmedId = typeof id === "string" ? id.trim() : "";
  return trimmedId ? `project-${trimmedId.slice(0, 8)}` : "project-unnamed";
}
