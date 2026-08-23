/**
 * Pipeline transition guard — the pure legality rules behind
 * `POST /api/pipeline/jobs/:id/{retry,advance}`.
 *
 * Why this file exists: round 4's reviewer found that both handlers fell back
 * to `VALID_JOB_STATUSES.has(norm)` for a free-form `target_stage` /
 * `target_status`. That set contains `DELETED`, `CANCELLED`,
 * `MARKED_FOR_DELETION` and `PUBLISHED`, so any client could push any job into
 * a destructive or a publish-claiming status from any current status, with no
 * legality check and no confirmation. The drawer's dropdowns never offer those
 * moves — but the API is the boundary, not the dropdown.
 *
 * Everything here is PURE: no database, no clock, no `process.env`. That is
 * what lets `pnpm test` (`tsx --test src/lib/*.test.ts`) prove the refusals
 * against the live enum without writing a single `content_jobs` row.
 *
 * ── The model, in three sentences ─────────────────────────────────────────
 * 1. Some targets are never an operator's to write from this surface at all
 *    (`DESTRUCTIVE_TARGETS`): deleting or cancelling a video is a Content
 *    Forge lifecycle decision with its own confirmation, not a pipeline nudge.
 * 2. Some targets are reachable only from the statuses that legitimately
 *    precede them (`RESTRICTED_TARGET_SOURCES`): writing `PUBLISHED` onto a
 *    `SCRIPTING` job would have the surface claim a video is live on YouTube
 *    when nothing was ever uploaded — the worst kind of fabricated data.
 * 3. Everything else that is not on the curated list the UI offers is
 *    *possible but deliberate*: it needs an explicit `confirm: true`, so a
 *    stray POST cannot do it and an operator who means it still can.
 *
 * ── Round 6's regression, and the rule that replaces it ───────────────────
 * The first cut refused `from === to` outright, above the `confirm` fallthrough,
 * which killed the brief's own "re-queue / unstick" control: a job wedged in
 * `ROUTING_RENDER` because the render worker died is retried *into
 * `ROUTING_RENDER`*, and the point of the click is the queue dispatch, not the
 * status write. A retry into a queue-backed stage is therefore a RE-DISPATCH,
 * not a transition, and is allowed (see `STAGE_QUEUES`). A retry into a stage
 * with no queue really does nothing but bump the clock, so it stays refused —
 * but confirmably, so "Force This Retry" can still reach it. `advance` keeps
 * the hard refusal: there is no forward move to the status you are already in.
 */

/* ========================================================================== *
 * The status vocabulary
 * ========================================================================== */

/**
 * Statuses this surface must never WRITE. Reaching one is a destructive
 * lifecycle event that Content Forge owns (hub-web has the confirmation flow
 * and the cascade); a control room that can silently delete a fortnight of
 * work is a control room Konrad cannot trust.
 */
export const DESTRUCTIVE_TARGETS = new Set([
  "DELETED",
  "MARKED_FOR_DELETION",
  "CANCELLED",
]);

/**
 * Statuses a job cannot be moved OUT of by retry/advance. Three are finished
 * or destroyed; `FAILED_IRRECOVERABLE` is the pipeline's own "a human must
 * look at this" flag, which the retry handler already refused before this
 * module existed and which is now refused for `advance` too.
 */
export const TERMINAL_SOURCES = new Set([
  "PUBLISHED",
  "DELETED",
  "CANCELLED",
  "MARKED_FOR_DELETION",
  "FAILED_IRRECOVERABLE",
]);

/**
 * Targets that are legal only from an enumerated set of sources — the
 * publish-claiming end of the pipeline. An empty list means "no source is
 * legal": `FAILED_IRRECOVERABLE` is set by the workers when recovery has been
 * ruled out, never by an operator clicking a control.
 *
 * `PUBLISHED` from `AWAITING_UPLOADER` is allowed because the uploader VA does
 * publish by hand on YouTube and then records it — that is the real workflow
 * the drawer's "Confirm Upload → PUBLISHED" option serves.
 */
export const RESTRICTED_TARGET_SOURCES: Record<string, readonly string[]> = {
  PUBLISHED: ["UPLOADING", "AWAITING_UPLOADER"],
  UPLOADING: ["AWAITING_UPLOADER"],
  FAILED_IRRECOVERABLE: [],
};

/**
 * Statuses whose entry hands the job to a BullMQ worker, and the queue that
 * picks it up. This is the ONE copy of that mapping in this package: both
 * handlers derive `queueName` from it, and `classifyTransition` uses it to tell
 * a re-dispatch apart from a no-op.
 *
 * Ground truth is Content Forge's own dispatcher, `worker-orchestrator`'s
 * `src/utils/dispatch-next.ts` (the `switch (newStatus)` at ~L61-165): those
 * five cases are the complete set of statuses that trigger a queue add. Every
 * other status — `AWAITING_UPLOADER`, `AWAITING_QC`, `IDEA_GENERATION`, the TTS
 * stages — is either human-gated or driven by a worker that polls, so entering
 * it a second time genuinely dispatches nothing.
 */
export const STAGE_QUEUES: Record<string, string> = {
  SCRIPTING: "queue-ai-generation",
  ASSET_COLLECTION: "queue-asset-collection",
  QMS_VALIDATING: "queue-qms-validation",
  ROUTING_RENDER: "queue-render-heavy",
  CLIP_SELECTION: "queue-clip-selection",
};

/** True when re-entering `status` actually hands the job to a worker again. */
export function isQueueBackedStage(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STAGE_QUEUES, status);
}

/**
 * Re-entry stages a retry may legitimately send a job back to. These are the
 * values the drawer's retry dropdown produces once aliases are resolved, plus
 * every target `determineRetryStage()` picks on its own. A retry to one of
 * these from a non-terminal source is the ordinary meaning of "retry" and
 * needs no confirmation.
 */
export const CURATED_RETRY_TARGETS = new Set([
  "IDEA_GENERATION",
  "SCRIPTING",
  "ASSET_COLLECTION",
  "QMS_VALIDATING",
  "AWAITING_QC",
  "ROUTING_RENDER",
  "CLIP_SELECTION",
  "AWAITING_UPLOADER",
  "SPACE_TTS_GENERATING",
  "DRAMA_TTS_GENERATING",
  "REACTOR_DOWNLOADING",
  "TECH_FOOTAGE_COLLECTING",
]);

/**
 * The forward moves the advance control offers, keyed by current status. This
 * is `determineAdvanceStage()`'s map plus the four options the drawer's
 * dropdown can produce — anything else an operator types is a jump, not an
 * advance, and falls through to the confirmation rule.
 */
export const CURATED_ADVANCE_TRANSITIONS: Record<string, readonly string[]> = {
  AWAITING_QC: ["AWAITING_UPLOADER", "ROUTING_RENDER"],
  AWAITING_IMAGE_QC: ["QMS_VALIDATING", "ROUTING_RENDER"],
  AWAITING_PRODUCTION_VA: ["QMS_VALIDATING", "ROUTING_RENDER"],
  AWAITING_VA_REVIEW: ["QMS_VALIDATING", "ROUTING_RENDER"],
  AWAITING_CLIP_REVIEW: ["QMS_VALIDATING", "ROUTING_RENDER"],
  QMS_VALIDATING: ["ROUTING_RENDER"],
  SCRIPTING: ["ASSET_COLLECTION"],
  ASSET_COLLECTION: ["QMS_VALIDATING"],
  RENDERING_FFMPEG: ["AWAITING_QC", "AWAITING_UPLOADER"],
  RENDERING_REMOTION: ["AWAITING_QC", "AWAITING_UPLOADER"],
  DRAMA_QC: ["AWAITING_UPLOADER"],
  AWAITING_UPLOADER: ["UPLOADING", "PUBLISHED"],
  UPLOADING: ["PUBLISHED"],
};

/* ========================================================================== *
 * The verdict
 * ========================================================================== */

export type TransitionAction = "retry" | "advance";

export type TransitionVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** HTTP status the route answers with. 403 = never; 409 = not from here,
       *  or not without `confirm`. */
      httpStatus: 403 | 409;
      error: string;
      /** True only for the confirmable case, so the client can offer the
       *  second click instead of showing a dead end. */
      requiresConfirmation: boolean;
    };

/**
 * Decide whether `from → to` may be written by `action`.
 *
 * Order matters and is deliberate: destructive targets are refused before
 * anything else can excuse them (a `confirm: true` does NOT unlock them —
 * this endpoint has no delete semantics at all), then dead-end sources, then
 * the publish-claiming targets, THEN the `from === to` rule, then the curated
 * lists, and only what survives all of it falls through to the confirmation
 * rule.
 *
 * The `from === to` rule sits *below* the three hard refusals on purpose: a
 * job in `PUBLISHED` retried to `PUBLISHED` must read as "terminal", and
 * `UPLOADING → UPLOADING` must read as "only reachable from AWAITING_UPLOADER".
 * Putting the re-dispatch allowance above them would let the same-status door
 * answer for cases the stronger rules own. None of the five queue-backed
 * stages appears in `TERMINAL_SOURCES` or `RESTRICTED_TARGET_SOURCES`, so the
 * re-dispatch path is never shadowed by that ordering.
 */
export function classifyTransition(
  from: string,
  to: string,
  action: TransitionAction,
  confirmed: boolean,
): TransitionVerdict {
  if (DESTRUCTIVE_TARGETS.has(to)) {
    return {
      allowed: false,
      httpStatus: 403,
      error: `Refusing to set status ${to} — deleting or cancelling a job is a Content Forge lifecycle action, not a pipeline control. Do it in hub-web, where it is confirmed and cascaded.`,
      requiresConfirmation: false,
    };
  }

  if (TERMINAL_SOURCES.has(from)) {
    return {
      allowed: false,
      httpStatus: 409,
      error:
        from === "FAILED_IRRECOVERABLE"
          ? `Cannot ${action} FAILED_IRRECOVERABLE job — requires manual human intervention`
          : `Cannot ${action} a job in terminal status ${from}. Reopen it in Content Forge first.`,
      requiresConfirmation: false,
    };
  }

  const restricted = RESTRICTED_TARGET_SOURCES[to];
  if (restricted !== undefined && !restricted.includes(from)) {
    return {
      allowed: false,
      httpStatus: 409,
      error:
        restricted.length === 0
          ? `Status ${to} is set by the pipeline workers, never by an operator control.`
          : `${to} is only reachable from ${restricted.join(" or ")} — this job is ${from}. Setting it from here would claim work that never happened.`,
      requiresConfirmation: false,
    };
  }

  if (from === to) {
    // A retry into a queue-backed stage is the re-dispatch control: the status
    // write is a no-op on purpose, and the queue add is the whole point. This
    // is how a job wedged in ROUTING_RENDER (render worker died, nothing ever
    // consumed the queue job) gets moving again.
    if (action === "retry" && isQueueBackedStage(to)) {
      return { allowed: true };
    }
    if (action === "retry") {
      // No queue behind this stage, so re-entering it dispatches nothing: all
      // it does is bump `retry_count` and reset `status_updated_at`, which is
      // occasionally what an operator wants (clearing a stale stall clock) and
      // is never what a stray POST should do by accident.
      if (confirmed) return { allowed: true };
      return {
        allowed: false,
        httpStatus: 409,
        error: `Job is already in ${to}, and ${to} has no worker queue to re-dispatch to — retrying it only clears the error fields and restarts the stall clock. Re-send with "confirm": true if that is what you mean.`,
        requiresConfirmation: true,
      };
    }
    return {
      allowed: false,
      httpStatus: 409,
      error: `Job is already in status ${to} — there is no forward step to the status it is already in. Pick a different target, or use retry to re-dispatch this stage.`,
      requiresConfirmation: false,
    };
  }

  const curated =
    action === "retry"
      ? CURATED_RETRY_TARGETS.has(to)
      : (CURATED_ADVANCE_TRANSITIONS[from] ?? []).includes(to);

  if (curated) return { allowed: true };
  if (confirmed) return { allowed: true };

  return {
    allowed: false,
    httpStatus: 409,
    error: `${from} → ${to} is not a standard ${action} step. Re-send with "confirm": true to force it.`,
    requiresConfirmation: true,
  };
}
