/**
 * /api/entities — the identity registry.
 *
 * GET  /api/entities?arm=&kind=&limit=&offset= — list entities
 * GET  /api/entities/summary                 — aggregate counts by arm and kind
 * POST /api/entities                        — create a person or company
 * GET  /api/entities/:id                    — fetch by OS id
 * GET  /api/entities/lookup?system=&external_id=
 *                                            — fetch by satellite id
 * POST /api/entities/:id/links              — link to an external record
 * GET  /api/entities/:id/links              — list all known external ids
 * POST /api/entities/events                 — append one event
 * GET  /api/entities/events                 — list recent events (?entity_id=,?limit=)
 *
 * Validation lives here, SQL lives in db/entities.ts — same split as
 * routes/ledger.ts. A malformed request is a 400 with a human explanation,
 * never a 500 from a constraint the caller had no way to know about.
 */

import { Hono } from "hono";
import {
  createEntity,
  getEntityById,
  getEntityByExternal,
  linkEntity,
  listLinksForEntity,
  appendEvent,
  listEvents,
  listEntities,
  entitiesSummary,
  ENTITY_KINDS,
  ENTITY_ARMS,
  ENTITY_SYSTEMS,
  type EntityArm,
  type EntityKind,
  type EntitySystem,
  type EntityInput,
  type EventInput,
} from "../db/entities.ts";

const r = new Hono();

const KIND_SET = new Set<string>(ENTITY_KINDS);
const ARM_SET = new Set<string>(ENTITY_ARMS);
const SYSTEM_SET = new Set<string>(ENTITY_SYSTEMS);

// UUID v1–v5 shape. Strict enough to reject obvious garbage, loose enough
// not to fight the DB — Postgres is still the source of truth on validity.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseEntity(raw: unknown): EntityInput | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "body must be an object" };
  }
  const b = raw as Record<string, unknown>;

  const kind = typeof b.kind === "string" ? b.kind : "";
  if (!KIND_SET.has(kind)) {
    return { error: `kind must be one of: ${ENTITY_KINDS.join(", ")}` };
  }

  const displayName =
    typeof b.display_name === "string" ? b.display_name.trim() : "";
  if (!displayName) return { error: "display_name is required" };

  const arm = typeof b.arm === "string" ? b.arm : "";
  if (!ARM_SET.has(arm)) {
    return { error: `arm must be one of: ${ENTITY_ARMS.join(", ")}` };
  }

  return {
    kind: kind as EntityKind,
    displayName,
    arm: arm as EntityArm,
    ownerId: typeof b.owner_id === "string" ? b.owner_id : null,
  };
}

function parseLinkBody(
  raw: unknown,
): { system: EntitySystem; externalId: string } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "body must be an object" };
  }
  const b = raw as Record<string, unknown>;

  const system = typeof b.system === "string" ? b.system : "";
  if (!SYSTEM_SET.has(system)) {
    return { error: `system must be one of: ${ENTITY_SYSTEMS.join(", ")}` };
  }

  const externalId =
    typeof b.external_id === "string" ? b.external_id.trim() : "";
  if (!externalId) return { error: "external_id is required" };

  return { system: system as EntitySystem, externalId };
}

function parseEvent(raw: unknown): EventInput | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "body must be an object" };
  }
  const b = raw as Record<string, unknown>;

  const system = typeof b.system === "string" ? b.system.trim() : "";
  if (!system) return { error: "system is required" };

  const verb = typeof b.verb === "string" ? b.verb.trim() : "";
  if (!verb) return { error: "verb is required" };

  const entityId =
    b.entity_id === null || b.entity_id === undefined
      ? null
      : typeof b.entity_id === "string"
        ? b.entity_id
        : "";
  if (entityId !== null && !UUID_RE.test(entityId)) {
    return { error: "entity_id must be a UUID or null" };
  }

  const subject =
    b.subject === null || b.subject === undefined
      ? null
      : typeof b.subject === "string"
        ? b.subject
        : "";
  if (subject !== null && typeof subject !== "string") {
    return { error: "subject must be a string or null" };
  }

  const payload =
    b.payload === undefined || b.payload === null
      ? {}
      : typeof b.payload === "object" && !Array.isArray(b.payload)
        ? (b.payload as Record<string, unknown>)
        : null;
  if (payload === null) return { error: "payload must be an object" };

  const occurredAt =
    b.occurred_at === undefined || b.occurred_at === null
      ? undefined
      : typeof b.occurred_at === "string"
        ? b.occurred_at
        : "";
  if (occurredAt === "") {
    return { error: "occurred_at must be an ISO timestamp string" };
  }

  return {
    system,
    verb,
    entityId,
    subject,
    payload,
    occurredAt,
  };
}

r.get("/", async (c) => {
  const arm = c.req.query("arm");
  if (arm !== undefined && !ARM_SET.has(arm)) {
    return c.json(
      { error: `arm must be one of: ${ENTITY_ARMS.join(", ")}` },
      400,
    );
  }
  const kind = c.req.query("kind");
  if (kind !== undefined && !KIND_SET.has(kind)) {
    return c.json(
      { error: `kind must be one of: ${ENTITY_KINDS.join(", ")}` },
      400,
    );
  }
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
  const offsetRaw = Number(c.req.query("offset") ?? 0);
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;

  try {
    const res = await listEntities({
      arm: arm as EntityArm | undefined,
      kind: kind as EntityKind | undefined,
      limit,
      offset,
    });
    return c.json({
      entities: res.entities,
      total: res.total,
      limit: Math.min(Math.max(limit, 1), 200),
      offset: Math.max(offset, 0),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseEntity(body);
  if ("error" in parsed) return c.json(parsed, 400);

  try {
    const entity = await createEntity(parsed);
    return c.json({ entity }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Order matters: /summary, /events and /lookup must come BEFORE /:id or Hono will match
// them as if they were an id.
r.get("/summary", async (c) => {
  try {
    const summary = await entitiesSummary();
    return c.json(summary);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.get("/lookup", async (c) => {
  const system = c.req.query("system") ?? "";
  const externalId = c.req.query("external_id") ?? "";
  if (!SYSTEM_SET.has(system)) {
    return c.json(
      { error: `system must be one of: ${ENTITY_SYSTEMS.join(", ")}` },
      400,
    );
  }
  if (!externalId) return c.json({ error: "external_id is required" }, 400);

  try {
    const entity = await getEntityByExternal(
      system as EntitySystem,
      externalId,
    );
    if (!entity) return c.json({ entity: null }, 404);
    return c.json({ entity });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseEvent(body);
  if ("error" in parsed) return c.json(parsed, 400);

  try {
    const event = await appendEvent(parsed);
    return c.json({ event }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.get("/events", async (c) => {
  const entityId = c.req.query("entity_id") ?? undefined;
  if (entityId !== undefined && !UUID_RE.test(entityId)) {
    return c.json({ error: "entity_id must be a UUID" }, 400);
  }
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  try {
    const events = await listEvents({ entityId, limit });
    return c.json({ events });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "id must be a UUID" }, 400);
  }
  try {
    const entity = await getEntityById(id);
    if (!entity) return c.json({ error: "not found" }, 404);
    return c.json({ entity });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.post("/:id/links", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "id must be a UUID" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseLinkBody(body);
  if ("error" in parsed) return c.json(parsed, 400);

  try {
    const entity = await getEntityById(id);
    if (!entity) return c.json({ error: "entity not found" }, 404);

    const result = await linkEntity({
      entityId: id,
      system: parsed.system,
      externalId: parsed.externalId,
    });
    if (result.conflict) {
      // 409 rather than silently reassigning. See linkEntity() for why.
      return c.json(
        {
          error:
            `(${parsed.system}, ${parsed.externalId}) is already linked ` +
            `to a different entity`,
          link: result.link,
        },
        409,
      );
    }
    return c.json(
      { link: result.link, created: result.created },
      result.created ? 201 : 200,
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

r.get("/:id/links", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "id must be a UUID" }, 400);
  }
  try {
    const links = await listLinksForEntity(id);
    return c.json({ links });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default r;
