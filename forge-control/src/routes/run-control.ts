/**
 * Manager control plane — the HTTP surface (07 §4).
 *
 * Mounted at `/api/runs` (index.ts, boundary D2: two appended lines and nothing
 * else). This is the ONLY new route file the control plane gets, and with CP2
 * it is complete — six endpoints, no more planned:
 *
 *   POST /:id/message            talk to a live-ish run          §1, C1–C5
 *   POST /:id/resume-chat        reopen a settled run IN PLACE   §2, C6–C8
 *   POST /:parentId/subagent-message  relay to a sub-agent       §2b, C10
 *   POST /:id/stop               graceful stop → `paused`        §3, C11
 *   POST /:id/terminate          hard stop → `cancelled`         §4, C12
 *   GET  /:id/comms              read a run's comms traffic      C14
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
 * §1 (message), §2 + §2b (resume-chat, subagent-message), §3 (stop), §4
 * (terminate); requirements 06 C1–C14, C20, C24; architecture 07 §4 (the
 * endpoint table this file implements literally).
 */

import { Hono, type Context } from "hono";
import { existsSync } from "node:fs";
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
  resumeAction,
  stopAction,
  terminateAction,
  commsEntries,
  subagentAddressable,
  workspaceDirOf,
  workspaceGoneReason,
  RESUME_ELIGIBLE,
  SUBAGENT_UNADDRESSABLE,
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

/**
 * The raw request body of the three POSTs that carry text. Every field is
 * `unknown`: it arrives from the wire, and each handler narrows it itself with
 * the checks its own contract section specifies (which is why the validation
 * below is written out per handler rather than shared — the orders and the
 * required/optional split differ, and 08 §1 wants each 400's reason to be
 * readable next to the check that produces it).
 */
type CommsBody = {
  text?: unknown;
  from?: unknown;
  manager_run_id?: unknown;
  sender_run_id?: unknown;
  subagent_id?: unknown;
};

/**
 * The ONE sanctioned swallowed error in this file (C20): a malformed JSON body
 * is a 400 produced by the validation below, not a 500 from the parser. It
 * lives in a function rather than being inlined three times so the file has
 * exactly one place where a parse failure is tolerated — CP1's surface test
 * asserts that count, and it should keep being able to.
 *
 * Nothing else is caught here or anywhere else in this file.
 */
async function readCommsBody(c: Context): Promise<CommsBody> {
  return (await c.req.json().catch(() => ({}))) as CommsBody;
}

/* ------------------------------------------------------------------------- *
 * POST /:id/message  (contract §1; C1–C5)
 * ------------------------------------------------------------------------- */

r.post("/:id/message", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const body = await readCommsBody(c);

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

/* ------------------------------------------------------------------------- *
 * POST /:id/resume-chat  (contract §2; C6, C7, C8)
 *
 * Reopen a settled run IN PLACE with a follow-up. Same row, same id, stable
 * across any number of resumes (contract Q2) — this handler NEVER creates a
 * run, and `resumed_run_id` is always the `:id` it was called with.
 *
 * `text` IS REQUIRED. Resume-chat means "reopen it WITH something to say";
 * waking a run with nothing to say is `/message`'s job against a paused or
 * completed target, which requeues it exactly the same way. A resume carrying
 * no text would spend a CC turn on an empty prompt, so it is a 400 here rather
 * than a silently accepted no-op (C20).
 *
 * C8 NEEDS NO CODE, AND NO `allow_fresh` FLAG SHOULD EVER BE ADDED. If the CC
 * session file for this run is gone, the executor's existing `CcResumeError`
 * path already handles it: it retries once with the FULL transcript plus a loud
 * in-thread marker. That is context-preserving, so the contract's opt-in
 * fresh-start fallback is unnecessary and was withdrawn in the note itself
 * (Q2). There is no silent-fresh path in this system and adding one here would
 * be exactly the "pretending" the contract bans.
 * ------------------------------------------------------------------------- */

r.post("/:id/resume-chat", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);

  const body = await readCommsBody(c);

  // Validated in the same order, with the same reasons, as /message: the two
  // endpoints take the same body (contract §2), and an operator switching verbs
  // must not meet a different vocabulary of 400s.
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);

  if (typeof body.from !== "string" || !COMMS_FROM.has(body.from)) {
    return c.json(
      { error: "from must be one of: konrad, manager, worker" },
      400,
    );
  }
  const from = body.from as CommsFrom;

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

  const action = resumeAction(run.status);
  if (action.kind === "reject") {
    // running/queued → 409 pointing at /message, worded by the rules module.
    return c.json({ error: action.reason }, action.status);
  }

  // C7 PRE-FLIGHT, BEFORE ANY WRITE. A resumed turn is spawned with
  // `metadata.workspace_dir` as its cwd (executor.ts), so a run whose worktree
  // was deleted can only fail — noisily, mid-turn, after the thread already
  // holds a message nobody will ever act on. Refusing here leaves the row
  // exactly as it was: nothing appended, no status moved.
  //
  // The EXTRACTION is pure and lives in run-control-rules.ts; the `existsSync`
  // does not, and must not: that module has no fs, no pg and no clock, which is
  // what makes the whole rule surface table-testable without a database. So the
  // impure half stays here, in the one process that owns the request.
  //
  // No `workspace_dir` → nothing to check. That is normal, not an error: plain
  // Chat and Manager runs share CC_WORKSPACE and carry no such key.
  const ws = workspaceDirOf(run.metadata);
  if (ws !== null && !existsSync(ws)) {
    return c.json({ error: workspaceGoneReason(ws) }, 409);
  }

  // Same builder, same clock discipline as /message: `ts` is minted here and
  // shared by delivery and echo. No relay id — this is a message to the run
  // itself, not to one of its sub-agents.
  const ts = new Date().toISOString();
  const { receiver, echo } = commsEntries({
    text,
    from,
    targetRunId: id,
    senderRunId: senderId,
    ts,
  });
  const entry = toThreadEntry(receiver);

  // THIS MUST STAY ONE STATEMENT — append and status move together, never two
  // writes. db/projects.ts `markVerdictTaskDone` detects "nobody has touched
  // this settled run" with `AND r.status = 'completed'`, and that detector is
  // only exact because every delivery write moves the row out of `completed` in
  // the SAME statement as the append (07 §7, R905 red-team S4). Split it and a
  // round consolidation landing in the gap marks the reviewer task `done` while
  // the resumed run is about to produce a flipped verdict — which is then
  // honoured zero times, in silence.
  //
  // The two cleared stamps are `/message`'s append_and_queue reasons verbatim:
  // a requeued row carrying `completed_at` makes every duration in the UI lie
  // and can leave the watchdog a `stuck` row with a completion timestamp, which
  // completeRun's invariant forbids; a `wake_after` left over from a usage-wall
  // backoff would delay a resume Konrad just asked for. `clearPendingInput`
  // because a run can be `completed` with the flag still raised (the executor
  // died between E1 and E2 of the 07 §5 handshake) — the next turn delivers
  // that message along with this one, so the flag has been consumed and must
  // not requeue the run a second time at the end of it.
  //
  // One const, used by the attempt and the re-dispatch below, so the two can
  // never drift into being different writes. LOCAL, not hoisted next to
  // MESSAGE_WRITE: that table describes EFFECTS only and CP1's surface test
  // asserts it declares no eligibility (R905 finding 4), while resume's
  // precondition is a single fixed list that belongs with the write it guards.
  const RESUME_WRITE = {
    eligible: RESUME_ELIGIBLE,
    setStatus: "queued",
    clearCompletedAt: true,
    clearWakeAfter: true,
    clearPendingInput: true,
  } as const;

  let delivered = await appendCommsEntry(id, entry, RESUME_WRITE);

  // ONE bounded re-dispatch, exactly as /message's — same reasoning (07 §5,
  // R905 red-team finding 5) and safe for the same reason: rowcount 0 means
  // NOTHING was appended, so the retry is a first delivery against a freshly
  // read status, not a second one.
  if (!delivered.applied && delivered.status) {
    const current = resumeAction(delivered.status);
    if (current.kind !== "reject") {
      console.log(
        `[run-control] resume-chat ${id} lost the write race to '${delivered.status}' - one re-dispatch`,
      );
      delivered = await appendCommsEntry(id, entry, RESUME_WRITE);
    }
  }

  if (!delivered.applied) {
    if (!delivered.status) return c.json({ error: "unknown run" }, 404);
    const current = resumeAction(delivered.status);
    return c.json(
      {
        error:
          current.kind === "reject"
            ? current.reason
            : raceReason(delivered.status, "resume-chat"),
      },
      409,
    );
  }

  // C3, identical to /message: the sender's echo carries no status change and
  // no eligibility list, and a missing echo target never retracts a delivery
  // that already happened — it is reported in the 202 body and the log.
  let echoed: boolean | null = null;
  if (echo && senderId) {
    const echoWrite = await appendCommsEntry(senderId, toThreadEntry(echo));
    echoed = echoWrite.applied;
    if (!echoed) {
      console.warn(
        `[run-control] resume-chat ${id} echo target ${senderId} not found - resumed anyway`,
      );
    }
  }

  console.log(
    `[run-control] resume-chat ${id} -> ${delivered.status} (from ${from}` +
      `${senderId ? `, sender ${senderId}` : ""}` +
      `${echoed === null ? "" : `, echo ${echoed}`})`,
  );

  return c.json(
    {
      // The contract's field name (C6, §2). Not `queued`, not `delivery` — a
      // resume answers with the id it reopened, and it is the id that came in.
      resumed_run_id: id,
      ...(echoed === null ? {} : { echo: echoed }),
    },
    202,
  );
});

/* ------------------------------------------------------------------------- *
 * POST /:parentId/subagent-message  (contract §2b; C10)
 *
 * A sub-agent has NO session of its own outside its parent, so the only honest
 * mechanism is a relay: a `kind:"comms"` entry appended to the PARENT's thread
 * instructing it to hand the text over via its harness (SendMessage) and report
 * the reply back. That prefix and the `meta.comms.subagent_id` key are built by
 * `commsEntries({relaySubagentId})` — never assembled here.
 *
 * The request shape is the contract's own §2b body verbatim: `{subagent_id,
 * text}`. §2b declares no response shape ("202 / 409 / 404 as above"), so the
 * 202 body is §1's, plus the `subagent_id` the relay was addressed to.
 *
 * `from` is OPTIONAL and defaults to `"manager"`: a relay comes by definition
 * from whoever holds the parent's manager role, and the contract's own body
 * does not carry the field. Present-but-invalid is still a 400 — a default is
 * not a licence to accept nonsense (C20).
 * ------------------------------------------------------------------------- */

r.post("/:parentId/subagent-message", async (c) => {
  const parentId = c.req.param("parentId");
  if (!UUID_RE.test(parentId)) return c.json({ error: "invalid run id" }, 400);

  const body = await readCommsBody(c);

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);

  // The address space is opaque (a Task tool_use_id), so the only shape check
  // possible is "a non-empty string".
  const subagentId =
    typeof body.subagent_id === "string" ? body.subagent_id.trim() : "";
  if (!subagentId) return c.json({ error: "subagent_id required" }, 400);

  let from: CommsFrom = "manager";
  if (body.from !== undefined && body.from !== null) {
    if (typeof body.from !== "string" || !COMMS_FROM.has(body.from)) {
      return c.json(
        { error: "from must be one of: konrad, manager, worker" },
        400,
      );
    }
    from = body.from as CommsFrom;
  }

  const senderRaw = body.sender_run_id ?? body.manager_run_id ?? null;
  if (senderRaw !== null && senderRaw !== undefined) {
    if (typeof senderRaw !== "string" || !UUID_RE.test(senderRaw)) {
      return c.json({ error: "invalid sender run id" }, 400);
    }
  }
  const senderId =
    typeof senderRaw === "string" && senderRaw.length > 0 ? senderRaw : null;

  const run = await getRun(parentId);
  if (!run) return c.json({ error: "unknown run" }, 404);

  // ADDRESSABILITY BEFORE ELIGIBILITY, and the order is a decision, not an
  // accident: addressability is a property of the ADDRESS, not of timing. An
  // unknown `subagent_id` must produce the same honest refusal whether the
  // parent happens to be `running` or `completed` at that instant — otherwise
  // the UI shows "run failed - use resume-chat" for an id that never existed,
  // and an operator retries a relay that can never be delivered.
  //
  // `subagentAddressable` never throws: a run predating the sub-agent rollup
  // simply has no `subagents_v2` key, and the correct answer for that is this
  // 409, not a 500.
  if (!subagentAddressable(run.metadata, subagentId)) {
    return c.json({ error: SUBAGENT_UNADDRESSABLE }, 409);
  }

  // The relay is delivered under /message's rules, applied to the PARENT (C10,
  // 07 §4): the parent is the run that has to act on it. A failed/cancelled
  // parent therefore 409s naming /resume-chat — S8's honest refusal. There is
  // no path below that answers 2xx without an entry having been appended to the
  // parent's thread; if a parent's session has evaporated, the visible outcome
  // is that parent's own next-turn transcript reporting the relay undelivered,
  // never a silently swallowed one.
  //
  // Named `parentAction`/`currentParent` rather than /message's
  // `action`/`current` because they gate a DIFFERENT row's status than the one
  // the request is addressed to; the shape is deliberately the same.
  const parentAction = messageAction(run.status);
  if (parentAction.kind === "reject") {
    return c.json({ error: parentAction.reason }, parentAction.status);
  }

  const ts = new Date().toISOString();
  const { receiver, echo } = commsEntries({
    text,
    from,
    targetRunId: parentId,
    senderRunId: senderId,
    ts,
    relaySubagentId: subagentId,
  });
  const entry = toThreadEntry(receiver);

  let delivered = await appendCommsEntry(parentId, entry, {
    ...MESSAGE_WRITE[parentAction.kind],
    eligible: parentAction.eligible,
  });

  // The same ONE bounded re-dispatch as /message, for the same reason: the
  // relay's payload is text, which means the same thing in every status that
  // accepts it, so a lost race deserves a second first-delivery rather than a
  // 409 the plan never asked managers to retry.
  if (!delivered.applied && delivered.status) {
    const currentParent = messageAction(delivered.status);
    if (currentParent.kind !== "reject") {
      console.log(
        `[run-control] subagent-message ${parentId} lost the write race to '${delivered.status}' - one re-dispatch`,
      );
      delivered = await appendCommsEntry(parentId, entry, {
        ...MESSAGE_WRITE[currentParent.kind],
        eligible: currentParent.eligible,
      });
    }
  }

  if (!delivered.applied) {
    if (!delivered.status) return c.json({ error: "unknown run" }, 404);
    const currentParent = messageAction(delivered.status);
    return c.json(
      {
        error:
          currentParent.kind === "reject"
            ? currentParent.reason
            : raceReason(delivered.status, "subagent-message"),
      },
      409,
    );
  }

  let echoed: boolean | null = null;
  if (echo && senderId) {
    const echoWrite = await appendCommsEntry(senderId, toThreadEntry(echo));
    echoed = echoWrite.applied;
    if (!echoed) {
      console.warn(
        `[run-control] subagent-message ${parentId} echo target ${senderId} not found - relayed anyway`,
      );
    }
  }

  console.log(
    `[run-control] subagent-message ${parentId} -> ${delivered.status} ` +
      `(subagent ${subagentId}, from ${from}` +
      `${senderId ? `, sender ${senderId}` : ""}` +
      `${echoed === null ? "" : `, echo ${echoed}`})`,
  );

  return c.json(
    {
      queued: true,
      delivery: "next-turn",
      subagent_id: subagentId,
      ...(echoed === null ? {} : { echo: echoed }),
    },
    202,
  );
});

export default r;
