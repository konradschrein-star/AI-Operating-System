/**
 * /api/secrets — store a credential, and (2026-08-04) hand one back to Konrad
 * without it entering the chat thread.
 *
 *   POST /api/secrets                         { name, value, note?, for_konrad? }
 *   GET  /api/secrets                         → names + metadata ONLY
 *   POST /api/secrets/:name/reveal            → returns the value; clears
 *                                               `pending`. Deliberately a POST
 *                                               so the value can never end up
 *                                               in an access log's URL or a
 *                                               browser history entry.
 *   POST /api/secrets/:name/clear-pending     → drop the "for Konrad" flag
 *                                               without revealing (dismiss).
 *   POST /api/secrets/:name/mark-pending      { requested_by_run_id? }
 *                                               → (re)flag "for Konrad",
 *                                               optionally naming the run
 *                                               waiting on it.
 *   GET  /api/secrets/events                  → SSE: `request` when an agent
 *                                               raises a "for Konrad" flag,
 *                                               `cleared` when one goes away.
 *   DELETE /api/secrets/:name                 → removes it
 *
 * WHY A STREAM (round 808). The composer's credential panel is supposed to
 * open BY ITSELF the moment an agent asks — Konrad's words: "when I ask for a
 * secret this thing should automatically sort of open up and there should be
 * text appearing in there". Phase 800 shipped that on a 60s poll, which makes
 * him wait up to a minute AND costs 1 req/min out of a surface already sitting
 * at 39/min against phase 600's ≤40 ceiling. This is the same trade `canvas.ts`
 * made when its pane stopped walking the vault every 4s: push instead of poll,
 * and the at-rest cost of "is anything waiting for me?" drops to zero requests.
 *
 * The stream carries NO VALUES — the same rule the rest of this file lives by.
 * A `request` frame carries name, the agent's note, and the run that asked;
 * exactly the fields `GET /api/secrets` already publishes. The client treats a
 * frame as "the pending set moved, go re-read the list", so the list endpoint
 * stays the single source of truth and the stream cannot drift from it.
 *
 * The reveal endpoint is intentionally at a distinct path from the list
 * endpoint so no listing call can ever accidentally spill values. Nothing
 * here echoes the body on error either — a validation failure that printed
 * the payload back would undo the entire point.
 *
 * All routes here bind to 127.0.0.1 in index.ts. External access goes through
 * the Next.js proxy at forge-control-web, which sits behind NextAuth; there
 * is no separate auth layer inside this route, and adding one would be a new
 * moving part with a different failure mode. Do not weaken this by adding a
 * bypass; do not "improve" it by adding a second unrelated gate.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  putSecret,
  listSecrets,
  deleteSecret,
  getSecret,
  markCollected,
  markPending,
  isValidName,
  normalizeName,
} from "../lib/secret-store.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
 * The change stream. Same shape as canvas.ts's event bus: an in-process
 * Set of subscribers, one frame per mutation, no queue and no history.
 *
 * NO HISTORY IS A DECISION, not an omission. The durable state is the
 * `.pending` marker on disk, and every client re-reads `GET /api/secrets` on
 * `hello` — so a client that was disconnected while a request was filed learns
 * about it the instant its stream comes back, without the server having to
 * remember anything. (canvas.ts keeps a single intent slot because an intent
 * has no on-disk counterpart; a credential request does.)
 * ------------------------------------------------------------------------- */

/** What an agent's "for Konrad" flag looks like on the wire. Metadata only:
 *  these are exactly the fields `GET /api/secrets` already publishes, and no
 *  secret VALUE is reachable from this stream by any path. */
interface SecretRequestFrame {
  rev: number;
  name: string;
  /** The requesting agent's text, as stored. Attacker-influenced — clients
   *  must render it as plain text. Null when the agent gave no reason. */
  note: string | null;
  /** The run that asked, when it named itself (uuid-validated on the way in). */
  requestedByRunId: string | null;
  ts: number;
}

type SecretEvent =
  | { kind: "request"; frame: SecretRequestFrame }
  | { kind: "cleared"; rev: number; name: string; ts: number };

type Subscriber = (ev: SecretEvent) => void;
const subscribers = new Set<Subscriber>();

/** Monotonic within this process. Its only job is to order frames in a log or
 *  a devtools watch — clients key off the list they refetch, never off `rev`,
 *  so a restart resetting it to 0 costs nothing. */
let rev = 0;

function fanOut(ev: SecretEvent): void {
  for (const fn of subscribers) {
    try {
      fn(ev);
    } catch {
      /* a subscriber that throws is already tearing down; its own finally
       * block removes it. One bad stream must not stop the others. */
    }
  }
}

/** Announce "an agent is waiting on <name>". The note is read back from the
 *  store rather than taken from the caller, so mark-pending (which carries no
 *  note) and POST / (which may) produce the same frame. A store read that
 *  finds nothing still emits — the client's refetch is the source of truth,
 *  and a silent drop here would be a request Konrad never sees. */
async function broadcastRequest(name: string): Promise<void> {
  const meta = (await listSecrets()).find((s) => s.name === name) ?? null;
  fanOut({
    kind: "request",
    frame: {
      rev: ++rev,
      name,
      note: meta?.note ?? null,
      requestedByRunId: meta?.requestedByRunId ?? null,
      ts: Date.now(),
    },
  });
}

/** Announce "nothing is waiting on <name> any more" — revealed, dismissed,
 *  deleted, or re-stored without the flag. Emitted unconditionally rather than
 *  only when a flag was actually set: the frame means "re-read the list", and
 *  a redundant one costs a single request on an idle surface. */
function broadcastCleared(name: string): void {
  fanOut({ kind: "cleared", rev: ++rev, name, ts: Date.now() });
}

r.get("/", async (c) => {
  return c.json({ secrets: await listSecrets() });
});

/** SSE: `hello` on connect, then `request` / `cleared` as the pending set
 *  moves. Registered before the `/:name` handlers below purely for reading
 *  order — those are POST/DELETE, so nothing here can shadow a secret named
 *  "events".
 *
 *  The client's contract, and the reason this endpoint stays this small: every
 *  frame — INCLUDING `hello` — means "re-read `GET /api/secrets`". So a dropped
 *  stream self-heals on reconnect, no frame has to be replayed, and the panel
 *  can never render a request that the list disagrees with. */
r.get("/events", (c) => {
  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    const send = async (event: string, data: string): Promise<boolean> => {
      if (!alive) return false;
      try {
        await stream.writeSSE({ event, data });
        return true;
      } catch {
        alive = false;
        return false;
      }
    };

    if (!(await send("hello", JSON.stringify({ rev, ts: Date.now() })))) return;

    const queue: SecretEvent[] = [];
    let notify: (() => void) | null = null;
    /** Wake the drain loop if it is parked. A function rather than a bare
     *  `notify?.()` at each call site because the teardown below has to do it
     *  too, and TypeScript narrows the captured `let` to `null` there. */
    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };
    const sub: Subscriber = (ev) => {
      queue.push(ev);
      wake();
    };
    subscribers.add(sub);

    // Deliberately unthrottled: a credential request is a human-paced event —
    // the store has never seen two in the same second — and the whole point of
    // the round is that it reaches the panel immediately.
    const drain = async () => {
      while (alive) {
        while (queue.length && alive) {
          const ev = queue.shift()!;
          const body =
            ev.kind === "request"
              ? JSON.stringify(ev.frame)
              : JSON.stringify({ rev: ev.rev, name: ev.name, ts: ev.ts });
          if (!(await send(ev.kind, body))) return;
        }
        if (!alive) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    };

    // Keep-alive only. No fallback tick here: unlike canvas.ts there is no
    // fs.watch that can miss an event — every mutation goes through this file.
    const heartbeat = async () => {
      while (alive) {
        await stream.sleep(14_000);
        if (!alive) break;
        if (!(await send("ping", String(Date.now())))) break;
      }
    };

    try {
      await Promise.race([drain(), heartbeat()]);
    } finally {
      alive = false;
      subscribers.delete(sub);
      // Unpark `drain` if it is waiting, so its promise settles instead of
      // holding this stream's closure alive until process exit.
      wake();
    }
  });
});

r.post("/", async (c) => {
  let body: {
    name?: string;
    value?: string;
    note?: string;
    for_konrad?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Normalise rather than reject. See normalizeName() for why: a 400 here
  // pushes the user toward pasting the credential into chat, which is the exact
  // outcome this endpoint exists to prevent.
  const name = normalizeName(body.name ?? "");
  const value = body.value ?? "";
  const rawNote = body.note;
  const note =
    typeof rawNote === "string" ? (rawNote.trim() || null) : undefined;
  const forKonrad =
    typeof body.for_konrad === "boolean" ? body.for_konrad : undefined;

  if (!isValidName(name)) {
    return c.json(
      {
        error:
          "name must contain at least two letters or digits (it is normalised: \"GitHub PAT\" becomes \"github-pat\")",
      },
      400,
    );
  }
  if (!value) return c.json({ error: "value is required" }, 400);

  try {
    const meta = await putSecret(name, value, { note, forKonrad });
    // Only the two EXPLICIT forms of the flag say anything about the pending
    // set. `undefined` means "leave whatever is on disk alone" (see putSecret),
    // so it must not push a frame either — a re-POST of an unrelated value
    // would otherwise pop Konrad's panel open for a request nobody made.
    if (forKonrad === true) await broadcastRequest(name);
    else if (forKonrad === false) broadcastCleared(name);
    // Response carries metadata only — never the value, not even as a check.
    return c.json({ secret: meta }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** Reveal — the ONE route that returns a value. Distinct path from list;
 *  POST rather than GET so the name never ends up in a URL that could be
 *  logged, cached, or bookmarked. Clears the `pending` marker as a side
 *  effect so a collected credential stops shouting for attention. */
r.post("/:name/reveal", async (c) => {
  const name = normalizeName(c.req.param("name"));
  if (!isValidName(name)) {
    return c.json({ error: "invalid name" }, 400);
  }
  const value = await getSecret(name);
  if (value === null) {
    return c.json({ error: "not found" }, 404);
  }
  await markCollected(name);
  broadcastCleared(name);
  // Do NOT include the name in a top-level `error`/`message` field on any
  // future error branches added here — some log shippers grep for those.
  return c.json({ name, value });
});

/** Retroactively flag an already-stored secret as "for Konrad to collect".
 *  The agent uses this when a credential was stored in an earlier turn and
 *  it now wants Konrad's attention on it without re-supplying the value.
 *
 *  Body is OPTIONAL (2026-08-05, U7/round 303): `{ requested_by_run_id? }`
 *  lets the agent say which run is waiting, so a UI can route the request
 *  to the right chat. Some callers send no body and no content-type at all —
 *  that must resolve to "no run id supplied", not a 500, so an unparseable
 *  body is treated the same as an absent one. Only a body that DOES parse
 *  but carries an invalid `requested_by_run_id` is a 400. */
r.post("/:name/mark-pending", async (c) => {
  const name = normalizeName(c.req.param("name"));
  if (!isValidName(name)) {
    return c.json({ error: "invalid name" }, 400);
  }

  let body: { requested_by_run_id?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  let requestedByRunId: string | undefined;
  if (body.requested_by_run_id !== undefined && body.requested_by_run_id !== null) {
    if (
      typeof body.requested_by_run_id !== "string" ||
      !UUID_RE.test(body.requested_by_run_id)
    ) {
      // Do NOT echo the supplied value (or the secret name) into `error` —
      // see the reveal route's comment above about log shippers grepping
      // top-level error/message fields.
      return c.json({ error: "requested_by_run_id must be a valid uuid" }, 400);
    }
    requestedByRunId = body.requested_by_run_id;
  }

  const ok = await markPending(name, requestedByRunId);
  // Push AFTER the marker is on disk and ONLY on success: the frame tells the
  // chat to re-read the list, and a frame for a flag that was never set would
  // buy a request that finds nothing.
  if (ok) await broadcastRequest(name);
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

/** Dismiss the "for Konrad" flag without revealing — for the case where the
 *  agent flagged something Konrad already knows or no longer cares about. */
r.post("/:name/clear-pending", async (c) => {
  const name = normalizeName(c.req.param("name"));
  if (!isValidName(name)) {
    return c.json({ error: "invalid name" }, 400);
  }
  await markCollected(name);
  broadcastCleared(name);
  return c.json({ ok: true });
});

r.delete("/:name", async (c) => {
  const name = normalizeName(c.req.param("name"));
  const ok = await deleteSecret(name);
  // A deleted secret cannot still be pending, so an open panel showing it must
  // be told — otherwise it offers Konrad a request for a name that is gone.
  if (ok) broadcastCleared(name);
  return ok ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
});

export default r;
