/**
 * The identity registry — data access for entities, entity_links and events
 * (ai_os :5434).
 *
 * These three tables together form the seam between the OS and its satellites
 * (see CRM Integration Plan §4). Two invariants make them worth anything:
 *
 *   1. (system, external_id) is UNIQUE on entity_links. Every link path here
 *      MUST rely on that constraint for idempotency — a re-import of the
 *      same scraped business, or a webhook delivered twice by Twenty, must
 *      collapse to one row. If a caller finds themselves writing "SELECT
 *      then INSERT" logic to avoid duplicates, they are re-implementing
 *      what the DB already enforces; use linkEntity() instead.
 *
 *   2. events is append-only. There is no update or delete path on purpose.
 *      A wrong row is corrected by a new row.
 *
 * Same house style as ledger.ts: this module owns SQL, the routes module owns
 * validation and error shape.
 */

import { aiOsPool } from "./ai-os-pool.ts";

export type EntityKind = "person" | "company";

export type EntityArm =
  | "directory"
  | "axtrelis"
  | "youtube"
  | "infra"
  | "personal"
  | "other";

export const ENTITY_KINDS: EntityKind[] = ["person", "company"];

export const ENTITY_ARMS: EntityArm[] = [
  "directory",
  "axtrelis",
  "youtube",
  "infra",
  "personal",
  "other",
];

/** Satellites that the OS knows how to link out to. New values require both
 *  a migration (the CHECK constraint) and a corresponding integration; keep
 *  this list in lockstep with 0003_entities.sql. */
export type EntitySystem = "twenty" | "scraper" | "axtrelis" | "ledger";

export const ENTITY_SYSTEMS: EntitySystem[] = [
  "twenty",
  "scraper",
  "axtrelis",
  "ledger",
];

export interface EntityInput {
  kind: EntityKind;
  displayName: string;
  arm: EntityArm;
  ownerId?: string | null;
}

export interface Entity {
  id: string;
  kind: EntityKind;
  displayName: string;
  arm: EntityArm;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EntityRow {
  id: string;
  kind: EntityKind;
  display_name: string;
  arm: EntityArm;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    arm: r.arm,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Create a new entity. There is no upsert path here on purpose: unlike
 *  ledger imports, entity creation is a deliberate act (someone or some
 *  workflow decided this soul is worth tracking). The dedupe that matters
 *  happens at the LINK layer, keyed on external ids. */
export async function createEntity(input: EntityInput): Promise<Entity> {
  const r = await aiOsPool().query<EntityRow>(
    `INSERT INTO entities (kind, display_name, arm, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, kind, display_name, arm, owner_id,
               created_at::text AS created_at,
               updated_at::text AS updated_at`,
    [input.kind, input.displayName, input.arm, input.ownerId ?? null],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error("createEntity: INSERT ... RETURNING returned no row");
  }
  return rowToEntity(row);
}

/** Rename an entity in place (keeps its id, all links, and all events).
 *
 * The rationale worth pinning: for scraped businesses the ref is the identity
 * anchor and the display name is mutable metadata — brand changes, typo fixes
 * in the source, or a more precise scrape all produce the same ref with a new
 * name. Minting a fresh entity on rename would orphan every event, ledger
 * link and Twenty pointer that already resolves to the old UUID, which is the
 * exact identity fork the registry exists to prevent. So: mutate the name,
 * bump updated_at (no trigger — see 0003_entities.sql:58), leave id alone.
 *
 * Returns the updated row, or null if `id` did not exist. Callers upstream
 * (the scraper importer, Twenty webhook handlers) treat a null as a bug worth
 * shouting about — you should not have been holding an id that just vanished.
 */
export async function renameEntity(
  id: string,
  newDisplayName: string,
): Promise<Entity | null> {
  const r = await aiOsPool().query<EntityRow>(
    `UPDATE entities
        SET display_name = $2,
            updated_at   = now()
      WHERE id = $1
      RETURNING id, kind, display_name, arm, owner_id,
                created_at::text AS created_at,
                updated_at::text AS updated_at`,
    [id, newDisplayName],
  );
  return r.rows[0] ? rowToEntity(r.rows[0]) : null;
}

export async function getEntityById(id: string): Promise<Entity | null> {
  const r = await aiOsPool().query<EntityRow>(
    `SELECT id, kind, display_name, arm, owner_id,
            created_at::text AS created_at,
            updated_at::text AS updated_at
       FROM entities
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? rowToEntity(r.rows[0]) : null;
}

/** Fetch an entity by any of its external system ids. Returns null when the
 *  link does not exist; does NOT throw. Callers upstream (import scripts,
 *  webhook handlers) rely on this null-vs-row distinction to decide between
 *  createEntity + linkEntity and a straight update path. */
export async function getEntityByExternal(
  system: EntitySystem,
  externalId: string,
): Promise<Entity | null> {
  const r = await aiOsPool().query<EntityRow>(
    `SELECT e.id, e.kind, e.display_name, e.arm, e.owner_id,
            e.created_at::text AS created_at,
            e.updated_at::text AS updated_at
       FROM entities e
       JOIN entity_links l ON l.entity_id = e.id
      WHERE l.system = $1 AND l.external_id = $2
      LIMIT 1`,
    [system, externalId],
  );
  return r.rows[0] ? rowToEntity(r.rows[0]) : null;
}

export interface EntityLink {
  id: string;
  entityId: string;
  system: EntitySystem;
  externalId: string;
  createdAt: string;
}

interface LinkRow {
  id: string;
  entity_id: string;
  system: EntitySystem;
  external_id: string;
  created_at: string;
}

function rowToLink(r: LinkRow): EntityLink {
  return {
    id: r.id,
    entityId: r.entity_id,
    system: r.system,
    externalId: r.external_id,
    createdAt: r.created_at,
  };
}

export interface LinkResult {
  link: EntityLink;
  /** True when this call inserted a new row; false when the (system,
   *  external_id) pair already existed. Callers can use this to decide
   *  whether to fire a "linked" event. */
  created: boolean;
  /** True when the existing link points at a DIFFERENT entity than the
   *  caller asked to link. This is the one failure mode this function
   *  will not swallow — silently reassigning an external id to another
   *  entity would corrupt every downstream aggregate. In that case
   *  `link` is the pre-existing row and no write happened. */
  conflict: boolean;
}

/**
 * Link an entity to an external system's record. Idempotent: re-linking the
 * same (system, external_id) to the same entity is a no-op and returns the
 * existing row.
 *
 * The uniqueness contract lives in 0003_entities.sql (UNIQUE(system,
 * external_id)); this function is the only sanctioned write path against it.
 * ON CONFLICT DO NOTHING is used, then a second SELECT determines whether
 * the pre-existing row points where the caller expects — if not, the caller
 * gets a conflict flag rather than a silent overwrite.
 */
export async function linkEntity(opts: {
  entityId: string;
  system: EntitySystem;
  externalId: string;
}): Promise<LinkResult> {
  const pool = aiOsPool();
  const ins = await pool.query<LinkRow>(
    `INSERT INTO entity_links (entity_id, system, external_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (system, external_id) DO NOTHING
     RETURNING id, entity_id, system, external_id,
               created_at::text AS created_at`,
    [opts.entityId, opts.system, opts.externalId],
  );
  if (ins.rows[0]) {
    return { link: rowToLink(ins.rows[0]), created: true, conflict: false };
  }

  const existing = await pool.query<LinkRow>(
    `SELECT id, entity_id, system, external_id,
            created_at::text AS created_at
       FROM entity_links
      WHERE system = $1 AND external_id = $2
      LIMIT 1`,
    [opts.system, opts.externalId],
  );
  const row = existing.rows[0];
  if (!row) {
    // ON CONFLICT skipped the insert but no row is present — either the
    // constraint fired against a row that was then deleted in a race, or
    // the DB is lying. Neither is silently recoverable.
    throw new Error(
      `linkEntity: (${opts.system}, ${opts.externalId}) conflicted on ` +
        `insert but no existing row was found — investigate races or ` +
        `manual deletes against entity_links`,
    );
  }
  return {
    link: rowToLink(row),
    created: false,
    conflict: row.entity_id !== opts.entityId,
  };
}

/** All external ids known for an entity, useful for "show me this row across
 *  every system that also knows it". */
export async function listLinksForEntity(
  entityId: string,
): Promise<EntityLink[]> {
  const r = await aiOsPool().query<LinkRow>(
    `SELECT id, entity_id, system, external_id,
            created_at::text AS created_at
       FROM entity_links
      WHERE entity_id = $1
      ORDER BY system, external_id`,
    [entityId],
  );
  return r.rows.map(rowToLink);
}

/* ============================================================================
 * Events — append-only spine.
 * ========================================================================== */

export interface EventInput {
  system: string;
  verb: string;
  entityId?: string | null;
  subject?: string | null;
  payload?: Record<string, unknown>;
  /** ISO-8601 timestamp. Omit to let the DB stamp now(). Set explicitly
   *  when importing historical events so the timeline stays honest. */
  occurredAt?: string;
}

export interface EventRecord {
  id: string;
  occurredAt: string;
  system: string;
  verb: string;
  entityId: string | null;
  subject: string | null;
  payload: Record<string, unknown>;
}

interface EventRow {
  id: string;
  occurred_at: string;
  system: string;
  verb: string;
  entity_id: string | null;
  subject: string | null;
  payload: Record<string, unknown>;
}

function rowToEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    system: r.system,
    verb: r.verb,
    entityId: r.entity_id,
    subject: r.subject,
    payload: r.payload ?? {},
  };
}

/** Append one event. There is intentionally no update or delete path in this
 *  module — see 0004_events.sql header for the reasoning. */
export async function appendEvent(input: EventInput): Promise<EventRecord> {
  const system = input.system?.trim();
  const verb = input.verb?.trim();
  if (!system) throw new Error("appendEvent: system is required");
  if (!verb) throw new Error("appendEvent: verb is required");

  const r = await aiOsPool().query<EventRow>(
    `INSERT INTO events (occurred_at, system, verb, entity_id, subject, payload)
     VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6::jsonb)
     RETURNING id,
               occurred_at::text AS occurred_at,
               system, verb, entity_id, subject, payload`,
    [
      input.occurredAt ?? null,
      system,
      verb,
      input.entityId ?? null,
      input.subject ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error("appendEvent: INSERT ... RETURNING returned no row");
  }
  return rowToEvent(row);
}

/** Recent events, newest first. Optional filter by entity — the per-entity
 *  timeline is the highest-traffic read pattern this table has. */
export async function listEvents(opts: {
  entityId?: string;
  limit?: number;
} = {}): Promise<EventRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  if (opts.entityId) {
    const r = await aiOsPool().query<EventRow>(
      `SELECT id,
              occurred_at::text AS occurred_at,
              system, verb, entity_id, subject, payload
         FROM events
        WHERE entity_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [opts.entityId, limit],
    );
    return r.rows.map(rowToEvent);
  }
  const r = await aiOsPool().query<EventRow>(
    `SELECT id,
            occurred_at::text AS occurred_at,
            system, verb, entity_id, subject, payload
       FROM events
      ORDER BY occurred_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map(rowToEvent);
}

export interface ListEntitiesOptions {
  arm?: EntityArm;
  kind?: EntityKind;
  limit?: number;
  offset?: number;
}

export interface ListEntitiesResult {
  entities: Entity[];
  total: number;
}

/**
 * List entities with optional filtering by arm and kind, newest updated first.
 */
export async function listEntities(
  opts: ListEntitiesOptions = {},
): Promise<ListEntitiesResult> {
  const pool = aiOsPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.arm) {
    params.push(opts.arm);
    conditions.push(`arm = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    conditions.push(`kind = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM entities ${whereClause}`,
    params,
  );
  const total = Number(countRes.rows[0]?.count ?? "0");

  const queryParams = [...params, limit, offset];
  const r = await pool.query<EntityRow>(
    `SELECT id, kind, display_name, arm, owner_id,
            created_at::text AS created_at,
            updated_at::text AS updated_at
       FROM entities
       ${whereClause}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams,
  );

  return {
    entities: r.rows.map(rowToEntity),
    total,
  };
}

export interface EntitySummaryRow {
  arm: EntityArm;
  kind: EntityKind;
  count: number;
}

export interface EntityArmSummary {
  arm: EntityArm;
  total: number;
  companies: number;
  persons: number;
}

export interface EntitiesSummary {
  total: number;
  by_arm_and_kind: EntitySummaryRow[];
  by_arm: Record<string, { total: number; companies: number; persons: number }>;
  arms: EntityArmSummary[];
  as_of: string;
}

/**
 * Return aggregate counts of entities grouped by arm and kind.
 */
export async function entitiesSummary(): Promise<EntitiesSummary> {
  const pool = aiOsPool();
  const res = await pool.query<{
    arm: EntityArm;
    kind: EntityKind;
    count: string;
  }>(
    `SELECT arm, kind, COUNT(*)::text AS count
       FROM entities
      GROUP BY arm, kind
      ORDER BY arm, kind`,
  );

  const byArmAndKind: EntitySummaryRow[] = res.rows.map((r) => ({
    arm: r.arm,
    kind: r.kind,
    count: Number(r.count),
  }));

  const total = byArmAndKind.reduce((sum, r) => sum + r.count, 0);

  const byArm: Record<
    string,
    { total: number; companies: number; persons: number }
  > = {};

  for (const arm of ENTITY_ARMS) {
    byArm[arm] = { total: 0, companies: 0, persons: 0 };
  }

  for (const row of byArmAndKind) {
    if (!byArm[row.arm]) {
      byArm[row.arm] = { total: 0, companies: 0, persons: 0 };
    }
    const bucket = byArm[row.arm];
    bucket.total += row.count;
    if (row.kind === "company") {
      bucket.companies += row.count;
    } else if (row.kind === "person") {
      bucket.persons += row.count;
    }
  }

  const arms: EntityArmSummary[] = ENTITY_ARMS.map((arm) => ({
    arm,
    total: byArm[arm]?.total ?? 0,
    companies: byArm[arm]?.companies ?? 0,
    persons: byArm[arm]?.persons ?? 0,
  }));

  return {
    total,
    by_arm_and_kind: byArmAndKind,
    by_arm: byArm,
    arms,
    as_of: new Date().toISOString(),
  };
}

