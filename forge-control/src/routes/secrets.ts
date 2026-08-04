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
 *   DELETE /api/secrets/:name                 → removes it
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

r.get("/", async (c) => {
  return c.json({ secrets: await listSecrets() });
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
  // Do NOT include the name in a top-level `error`/`message` field on any
  // future error branches added here — some log shippers grep for those.
  return c.json({ name, value });
});

/** Retroactively flag an already-stored secret as "for Konrad to collect".
 *  The agent uses this when a credential was stored in an earlier turn and
 *  it now wants Konrad's attention on it without re-supplying the value. */
r.post("/:name/mark-pending", async (c) => {
  const name = normalizeName(c.req.param("name"));
  if (!isValidName(name)) {
    return c.json({ error: "invalid name" }, 400);
  }
  const ok = await markPending(name);
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
  return c.json({ ok: true });
});

r.delete("/:name", async (c) => {
  const ok = await deleteSecret(normalizeName(c.req.param("name")));
  return ok ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
});

export default r;
