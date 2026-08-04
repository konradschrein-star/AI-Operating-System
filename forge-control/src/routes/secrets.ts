/**
 * /api/secrets — store a credential without putting it in the chat.
 *
 *   POST   /api/secrets        { name, value, note? }  → stores, returns meta
 *   GET    /api/secrets                                → names + metadata ONLY
 *   DELETE /api/secrets/:name                          → removes it
 *
 * There is deliberately NO endpoint that returns a value. The agent already
 * runs on this machine and reads secrets from disk (/opt/ai-os/.secrets/store,
 * 0600); exposing a read endpoint would add a way to exfiltrate them over HTTP
 * while adding no capability the agent doesn't already have.
 *
 * The value must never be logged. Note that this route does not echo the body
 * on error — a validation failure that printed the payload back would undo the
 * entire point.
 */

import { Hono } from "hono";
import {
  putSecret,
  listSecrets,
  deleteSecret,
  isValidName,
} from "../lib/secret-store.ts";

const r = new Hono();

r.get("/", async (c) => {
  return c.json({ secrets: await listSecrets() });
});

r.post("/", async (c) => {
  let body: { name?: string; value?: string; note?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const name = (body.name ?? "").trim().toLowerCase();
  const value = body.value ?? "";
  const note = (body.note ?? "").trim() || null;

  if (!isValidName(name)) {
    return c.json(
      {
        error:
          "name must be 2-63 chars: lowercase letters, digits, dot, dash, underscore",
      },
      400,
    );
  }
  if (!value) return c.json({ error: "value is required" }, 400);

  try {
    const meta = await putSecret(name, value, note);
    // Response carries metadata only — never the value, not even as a check.
    return c.json({ secret: meta }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.delete("/:name", async (c) => {
  const ok = await deleteSecret(c.req.param("name").toLowerCase());
  return ok ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
});

export default r;
