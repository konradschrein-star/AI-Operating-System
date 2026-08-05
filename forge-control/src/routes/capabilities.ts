import { Hono } from "hono";

/**
 * Source of truth: vault note "Contract - Manager Control Plane API.md".
 * Every flag here starts `false` and is flipped to `true` only by the
 * engine-v2-research-lane project, one at a time, the moment the matching
 * control-plane endpoint actually ships and works — never in anticipation
 * of it. This module does no probing or dynamic detection of engine state
 * (13-ui-v3-architecture.md §11): probing invents failure modes that a
 * hardcoded, lane-owned constant does not have.
 */
const CAPABILITIES = {
  control_plane: {
    message_into_session: false,
    resume_finished: false,
    stop: false,
    terminate: false,
  },
} as const;

const r = new Hono();

r.get("/", (c) => c.json(CAPABILITIES));

export default r;
