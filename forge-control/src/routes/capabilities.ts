import { Hono } from "hono";

/**
 * Source of truth: vault note "Contract - Manager Control Plane API.md".
 *
 * WHO FLIPS THESE FLAGS: we do — operator-visibility — unconditionally, in
 * every merge order. The earlier comment here said engine-v2-research-lane
 * flips them; that is WITHDRAWN. The r764 revision of the contract's
 * negotiation note replaced the ordering rule ("whoever merges second")
 * with an ownership rule, because "second" stops being well-defined the
 * moment either branch lands and both lanes then read the same sentence and
 * conclude the other party owns the flip — a silent failure, where the
 * endpoint is live, the flag reads `false`, and the UI renders a plausible
 * disabled button with nothing in any log. `capabilities.ts` is OUR file,
 * so the flip is ours; the engine lane will not make it even once this
 * branch has landed and the file sits editable on `main`.
 *
 * WHERE THE WORKLIST LIVES: the `flipped?` column of the announcement table
 * under "Negotiation note — engine-v2-research-lane" in that vault note. The
 * engine lane appends a row with a proof the moment an endpoint is proven
 * and leaves the `flipped?` cell empty by policy; every empty cell is
 * outstanding work for us. Filling the cell is part of the flip, not a
 * courtesy — an empty cell against a shipped endpoint is exactly the defect
 * that left the r1203 control plane unannounced until r1352.
 *
 * Flags are flipped one at a time, against a proof row, never in
 * anticipation of an endpoint. This module does no probing or dynamic
 * detection of engine state (13-ui-v3-architecture.md §11): probing invents
 * failure modes that a hardcoded, lane-owned constant does not have.
 *
 * Key order follows contract §5. All five keys §5 specifies are present:
 * `subagent_message` was missing here and the engine lane recorded it as a
 * defect in our file ("the key is yours to add"); added r1352, false.
 */
const CAPABILITIES = {
  control_plane: {
    // Proven live 2026-08-17 (round 1350 re-proof, cp-reproof-verdict.md):
    // POST /api/runs/:id/message -> 202 {"queued":true,"delivery":"next-turn"}
    // against queued, paused, cancelled (409), completed and RUNNING targets,
    // with both comms directions read back. The `[EXPECTED PRE-RESTART]`
    // caveat no longer applies: the executor carrying the pending-input
    // handshake has been the live process since 2026-08-11.
    message_into_session: true,
    // Announcement-table proof row, project/4120f785 r1203:
    // POST /api/runs/:id/resume-chat -> 202 {"resumed_run_id": <same id>},
    // readback status 'queued' with completed_at cleared, second call -> 409.
    resume_finished: true,
    // STAYS FALSE. Round 1351's verdict: NOT VERIFIABLE AS WRITTEN. The
    // honest-refusal halves of POST /api/runs/:parentId/subagent-message are
    // proven (409 "subagent context not addressable", 400 "subagent_id
    // required", and a refused call appends nothing), but the addressable
    // relay half has no live target: nothing has populated
    // `runs.metadata.subagents_v2` — the address space — since 2026-08-05, so
    // no running parent holds a live sub-agent id. Manufacturing one means a
    // hand-written DB row, which the re-proof was forbidden to do. Flip only
    // on a CP4-style proof against a real fleet run with a running sub-agent.
    subagent_message: false,
    // Announcement-table proof row, project/4120f785 r1203:
    // POST /api/runs/:id/stop -> 202 {"stopping":true}, readback status
    // 'paused' (contract Q3), second stop -> 409 "run is already paused".
    stop: true,
    // Announcement-table proof row, project/4120f785 r1203:
    // POST /api/runs/:id/terminate -> 202 {"terminating":true}, readback
    // status 'cancelled' with completed_at set, second call -> 409.
    terminate: true,
  },
} as const;

const r = new Hono();

r.get("/", (c) => c.json(CAPABILITIES));

export default r;
