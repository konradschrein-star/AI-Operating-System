/**
 * Manager control plane — the HTTP surface (07 §4).
 *
 * Mounted at `/api/runs` (index.ts, boundary D2: two appended lines and nothing
 * else). This is the ONLY new route file the control plane gets; CP2 adds
 * `POST /:id/resume-chat` and `POST /:parentId/subagent-message` here too.
 *
 * Every handler is the same four moves and nothing more (07 §4, "shared handler
 * skeleton"): uuid-validate → `getRun` → a pure decision function from
 * `lib/run-control-rules.ts` → ONE guarded single-row write from `db/runs.ts` →
 * 202/4xx. No eligibility logic is re-implemented here; the route and the
 * executor import the same rules module precisely so the two can never drift
 * (C5). No business logic lives in a handler beyond that shape.
 *
 * Two rules govern the error paths and neither is decoration:
 *
 *  • C20 — HARD ERRORS ONLY. There is no try/catch in this file except the one
 *    around `c.req.json()` (a malformed body is a 400, not a 500). A pg failure
 *    propagates and becomes a visible 5xx. Nothing ever answers 2xx for work
 *    that did not happen, and every rejection carries a `reason` string the UI
 *    renders verbatim in a toast.
 *  • ROWCOUNT 0 IS A QUESTION. The db helpers carry the eligibility precondition
 *    INTO the UPDATE's WHERE, so a miss means either "no such run" or "the
 *    status moved under us". They re-read the status once and hand it back; the
 *    handlers below turn `status === null` into 404 and a present status into a
 *    409 naming it. That is how two operators clicking stop and terminate at the
 *    same moment resolve to one 202 and one 409 instead of a mixed state — and
 *    why nothing here loops or retries.
 *
 * Contract: /opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md
 * §1 (message), §3 (stop), §4 (terminate); requirements 06 C1–C5, C11–C14, C20,
 * C24; architecture 07 §4 (the endpoint table this file implements literally).
 */

import { Hono } from "hono";
import {
  getRun,
  appendCommsEntry,
  stopRun,
  terminateRun,
  listComms,
  type RunWriteResult,
  type ThreadEntry,
} from "../db/runs.ts";
import {
  messageAction,
  stopAction,
  terminateAction,
  commsEntries,
  type CommsFrom,
  type CommsThreadEntry,
  type MessageAction,
  type RunStatus,
  type StatusVerbAction,
} from "../lib/run-control-rules.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMS_FROM = new Set<string>(["konrad", "manager", "worker"]);

/**
 * The row EFFECT each accepted message action performs, straight out of 07 §4's
 * table. The PRECONDITION is not here: it travels on the action itself
 * (`action.eligible`, run-control-rules.ts) and is passed into the write below,
 * so the status set that `messageAction` accepts and the status set the UPDATE
 * requires are one value rather than two lists that can drift (R905 finding 4).
 *
 * Keyed by `MessageAction["kind"]` minus the rejection, so a new action kind in
 * the rules module is a COMPILE error here rather than a missing case that
 * silently appends with no effect at all.
 */
type AppendKind = Exclude<MessageAction["kind"], "reject">;

const MESSAGE_WRITE: Record<
  AppendKind,
  {
    setStatus?: RunStatus;
    setPendingInput?: boolean;
    clearCompletedAt?: boolean;
    clearWakeAfter?: boolean;
  }
> = {
  // The pending turn's prompt builder folds the thread tail in by itself.
  append: {},
  // The turn in flight is untouchable; the flag is consumed by the executor's
  // completion handshake, which requeues instead of completing (07 §5).
  append_and_flag: { setPendingInput: true },
  // For `stuck` this doubles as the contract's nudge.
  //
  // The two stamps are cleared for the same reason the executor's E2 clears
  // them (executor.ts, "a run that is going back to work carries a completion
  // timestamp, and every duration in the UI lies about it"): a `completed`
  // target carries `completed_at`, and messaging it puts it back to work — a
  // live row with a past completion time renders as settled-at-10:00 while it
  // runs, and the watchdog can later leave a `stuck` row with `completed_at`
  // set, which completeRun's own invariant forbids. `wake_after` goes for the
  // matching reason: a `paused` row parked behind a usage-wall backoff must not
  // silently delay a message Konrad just sent.
  append_and_queue: {
    setStatus: "queued",
    clearCompletedAt: true,
    clearWakeAfter: true,
  },
};

/**
 * The lost-race answer. Reached only when a write's precondition held at
 * `getRun` and no longer holds at the UPDATE, and the rules function applied to
 * the CURRENT status does not itself produce a rejection to quote.
 *
 * For /stop and /terminate this is the final answer, on purpose: the operator
 * asked to apply a VERB to a run in a state it is no longer in, and inventing a
 * second attempt would mean acting on a situation nobody looked at. /message is
 * different — see the re-dispatch below.
 */
function raceReason(status: RunStatus, verb: string): string {
  return `run moved to '${status}' while the ${verb} was being applied - re-read the run and retry`;
}

/**
 * `CommsThreadEntry` (the 07 §3 wire contract) and `db/runs.ts`'s `ThreadEntry`
 * describe the same JSON, but the former's `meta` is a named interface and the
 * latter's is `Record<string, unknown>` — and TypeScript gives an interface no
 * implicit index signature, so the two do not unify on their own.
 *
 * One explicit, total conversion rather than a cast: every field is named, so
 * adding a key to either shape surfaces here as a compile error instead of
 * being erased by an `as`. The `meta` spread is what produces the anonymous
 * object type the db signature accepts.
 */
function toThreadEntry(e: CommsThreadEntry): ThreadEntry {
  return {
    role: e.role,
    content: e.content,
    ts: e.ts,
    kind: e.kind,
    meta: { ...e.meta },
  };
}

/* ------------------------------------------------------------------------- *
 * POST /:id/message  (contract §1; C1–C5)
 * ------------------------------------------------------------------------- */

r.post("/:id/message", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    text?: unknown;
    from?: unknown;
    manager_run_id?: unknown;
    sender_run_id?: unknown;
  };

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);

  if (typeof body.from !== "string" || !COMMS_FROM.has(body.from)) {
    return c.json(
      { error: "from must be one of: konrad, manager, worker" },
      400,
    );
  }
  const from = body.from as CommsFrom;

  // `sender_run_id` is the general form; `manager_run_id` is the contract's
  // original spelling for the manager→worker direction. Same field, and the
  // explicit one wins when both arrive.
  const senderRaw = body.sender_run_id ?? body.manager_run_id ?? null;
  if (senderRaw !== null && senderRaw !== undefined) {
    if (typeof senderRaw !== "string" || !UUID_RE.test(senderRaw)) {
      return c.json({ error: "invalid sender run id" }, 400);
    }
  }
  const senderId =
    typeof senderRaw === "string" && senderRaw.length > 0 ? senderRaw : null;

  const run = await getRun(id);
  if (!run) return c.json({ error: "unknown run" }, 404);

  const action = messageAction(run.status);
  if (action.kind === "reject") {
    return c.json({ error: action.reason }, action.status);
  }

  // The rules module has no clock — `ts` is a parameter — so the timestamp is
  // minted here and shared by both entries, which is what lets the UI pair an
  // echo with its delivery.
  const ts = new Date().toISOString();
  const { receiver, echo } = commsEntries({
    text,
    from,
    targetRunId: id,
    senderRunId: senderId,
    ts,
  });

  const entry = toThreadEntry(receiver);
  let delivered = await appendCommsEntry(id, entry, {
    ...MESSAGE_WRITE[action.kind],
    eligible: action.eligible,
  });

  // ONE bounded re-dispatch — not a loop, not a poll (07 §5).
  //
  // 07 §5 promises delivery in BOTH orders of the message-vs-completion race:
  // an append landing before the executor's E1 rides the pending_input
  // handshake, and one landing after it is requeued by the `completed` row of
  // this very handler. The window between `getRun` and the UPDATE is the third
  // order, and answering 409 there made that promise depend on a caller retry
  // the plan never required of managers (R905 red-team finding 5).
  //
  // Safe precisely because the first attempt's rowcount was 0: NOTHING was
  // appended, so this is a first delivery against a freshly-read status, not a
  // second one. It recomputes the action from the status the failed UPDATE
  // reported and attempts exactly once more; if that one also loses, the 409
  // below is the honest answer and the caller owns the next move. A message is
  // re-dispatchable in a way a verb is not: its payload is the operator's text,
  // which means the same thing in every state that accepts it, whereas "stop"
  // applied to a state nobody looked at is a different decision.
  if (!delivered.applied && delivered.status) {
    const current = messageAction(delivered.status);
    if (current.kind !== "reject") {
      console.log(
        `[run-control] message ${id} lost the write race to '${delivered.status}' - one re-dispatch`,
      );
      delivered = await appendCommsEntry(id, entry, {
        ...MESSAGE_WRITE[current.kind],
        eligible: current.eligible,
      });
    }
  }

  if (!delivered.applied) {
    if (!delivered.status) return c.json({ error: "unknown run" }, 404);
    // Still lost after the re-dispatch (or the current status rejects outright).
    // Recompute ONCE more against what the row actually holds and answer 409
    // naming that status — the caller decides whether it still deserves the
    // message.
    const current = messageAction(delivered.status);
    return c.json(
      {
        error:
          current.kind === "reject"
            ? current.reason
            : raceReason(delivered.status, "message"),
      },
      409,
    );
  }

  // C3: the echo goes to the SENDER's thread with no status change and no
  // eligibility list — a manager must never be requeued by its own outbound
  // message, and there is no state in which its own echo may be refused.
  let echoed: boolean | null = null;
  if (echo && senderId) {
    const echoWrite = await appendCommsEntry(senderId, toThreadEntry(echo));
    echoed = echoWrite.applied;
    if (!echoed) {
      // The primary delivery already happened. Reporting the echo's missing row
      // as a failure would throw away work that succeeded, so it is surfaced in
      // the 202 body and the log instead.
      console.warn(
        `[run-control] message ${id} echo target ${senderId} not found - delivered anyway`,
      );
    }
  }

  console.log(
    `[run-control] message ${id} -> ${delivered.status} (from ${from}` +
      `${senderId ? `, sender ${senderId}` : ""}` +
      `${echoed === null ? "" : `, echo ${echoed}`})`,
  );

  return c.json(
    {
      // Field names are the contract (§1). Do not rename them.
      queued: true,
      delivery: "next-turn",
      ...(echoed === null ? {} : { echo: echoed }),
    },
    202,
  );
});

/* ------------------------------------------------------------------------- *
 * POST /:id/stop  and  POST /:id/terminate  (contract §3, §4; C11–C13)
 *
 * Identical skeletons, so they share one: the only differences are which pure
 * rules function gates the verb, which db helper writes the row, and the 202
 * body's field name.
 * ------------------------------------------------------------------------- */

async function statusVerb(
  id: string,
  verb: string,
  rules: (status: RunStatus) => StatusVerbAction,
  write: (id: string) => Promise<RunWriteResult>,
): Promise<{ ok: true; status: RunStatus } | { ok: false; error: string; code: 404 | 409 }> {
  const run = await getRun(id);
  if (!run) return { ok: false, error: "unknown run", code: 404 };

  const action = rules(run.status);
  if (action.kind === "reject") {
    return { ok: false, error: action.reason, code: action.status };
  }

  const out = await write(id);
  if (out.applied && out.status) return { ok: true, status: out.status };

  // Precondition gone between read and write (the double-click case, and the
  // stop-vs-terminate case). Same one-shot recompute as /message.
  if (!out.status) return { ok: false, error: "unknown run", code: 404 };
  const current = rules(out.status);
  return {
    ok: false,
    code: 409,
    error:
      current.kind === "reject"
        ? current.reason
        : raceReason(out.status, verb),
  };
}

r.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const out = await statusVerb(id, "stop", stopAction, stopRun);
  if (!out.ok) return c.json({ error: out.error }, out.code);

  console.log(`[run-control] stop ${id} -> ${out.status}`);
  return c.json({ stopping: true }, 202);
});

r.post("/:id/terminate", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const out = await statusVerb(id, "terminate", terminateAction, terminateRun);
  if (!out.ok) return c.json({ error: out.error }, out.code);

  console.log(`[run-control] terminate ${id} -> ${out.status}`);
  return c.json({ terminating: true }, 202);
});

/* ------------------------------------------------------------------------- *
 * GET /:id/comms  (C14)
 *
 * Any status is queryable: a settled run's traffic is exactly what an operator
 * wants to read after the fact. A known run with no comms is `comms: []`, never
 * a 404 — "no traffic yet" is a normal state.
 * ------------------------------------------------------------------------- */

r.get("/:id/comms", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const out = await listComms(id);
  if (!out) return c.json({ error: "unknown run" }, 404);
  return c.json(out);
});

export default r;
