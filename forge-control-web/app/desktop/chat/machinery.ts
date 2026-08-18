/**
 * machinery.ts — when an "assistant message" is not prose at all.
 *
 * Round 1871, customer finding 10: an assistant bubble in a worker transcript
 * whose entire body is
 *
 *     {"queued":true,"delivery":"next-turn","echo":true}
 *
 * That is `POST /api/runs/:id/message`'s 202 body. It reached the thread as an
 * assistant text entry, and the chat renders assistant text as the agent's own
 * words — so a control-plane receipt is sitting in the transcript wearing the
 * costume of something the machine said to Konrad.
 *
 * ── WHY THIS IS FIXED IN THE RENDERER ─────────────────────────────────────
 * The entry is real and it is already written. Rewriting the engine's append
 * path would change what is in the database for every future run and nothing
 * about the hundreds of entries already there, and this project's brief is
 * explicit that the chat surface is to RENDER what exists rather than build new
 * plumbing. So the transcript keeps the entry, byte for byte, and this module
 * decides how to show it: a one-line receipt instead of a prose card, with the
 * raw JSON one click away.
 *
 * ── THE DETECTOR IS DELIBERATELY NARROW ───────────────────────────────────
 * A false positive here would swallow something an agent actually said, which
 * is far worse than the paper-cut being fixed. Four conditions, all required:
 *
 *   1. the WHOLE message, trimmed, parses as one JSON object — not a message
 *      that merely contains JSON, and not an array;
 *   2. it has between one and MAX_KEYS keys;
 *   3. every value is a scalar (string, number, boolean, null) — a nested
 *      object is a payload, and a payload might be an answer;
 *   4. at least one key is in `CONTROL_KEYS`, the closed vocabulary the
 *      control plane actually answers with.
 *
 * Anything else is prose and is rendered as prose, unchanged.
 *
 * Pure, React-free, dependency-free, so `scripts/checks` can import it.
 */

/** The keys forge-control's control-plane 202/200 envelopes are built from.
 *  Sourced by grepping `c.json({…})` in forge-control/src/routes/run-control.ts
 *  and chat.ts; a key that is not here does not make a message machinery. */
const CONTROL_KEYS: ReadonlySet<string> = new Set([
  "queued",
  "delivery",
  "echo",
  "accepted",
  "terminating",
  "stopping",
  "requeued",
  "applied",
  "resumed",
  "archived",
  "cleared",
]);

/** Above this, it is a data structure somebody meant to show. */
const MAX_KEYS = 8;

export interface ControlEnvelope {
  /** The one-line receipt, in words. */
  label: string;
  /** The original text, verbatim, for the expanded view. Never reformatted —
   *  a reader opening it must see exactly what is in the thread. */
  raw: string;
}

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

/**
 * Turn a control-plane envelope into a sentence, or answer null.
 *
 * The sentence is built from the fields that are present rather than from a
 * lookup of the whole shape, so an envelope this file has never seen still
 * reads as English instead of falling back to the JSON.
 */
export function readControlEnvelope(text: string): ControlEnvelope | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > MAX_KEYS) return null;
  if (!keys.every((k) => isScalar(obj[k]))) return null;
  if (!keys.some((k) => CONTROL_KEYS.has(k))) return null;

  const parts: string[] = [];
  if (obj.queued === true) parts.push("message queued");
  if (obj.terminating === true) parts.push("terminate accepted");
  if (obj.stopping === true) parts.push("stop accepted");
  if (obj.resumed === true) parts.push("run resumed");
  if (obj.archived === true) parts.push("chat archived");
  if (obj.cleared === true) parts.push("cleared");
  if (obj.requeued === true) parts.push("run requeued");
  if (obj.applied === true && parts.length === 0) parts.push("change applied");
  if (obj.accepted === true && parts.length === 0) parts.push("accepted");
  if (parts.length === 0) parts.push("control-plane receipt");

  if (obj.delivery === "next-turn") {
    parts.push("will be delivered on the agent's next turn");
  } else if (typeof obj.delivery === "string" && obj.delivery !== "") {
    parts.push(`delivery: ${obj.delivery}`);
  }
  if (obj.echo === true) parts.push("echoed into this transcript");

  return { label: parts.join(" · "), raw: text };
}
