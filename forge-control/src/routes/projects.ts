import { Hono } from "hono";
import {
  listProjects,
  getProject,
  createProject,
  setProjectWorkspace,
  setProjectStatus,
  listTasksForProject,
  listActiveTasks,
  listManagerRollup,
  createTask,
  getTask,
  unwedgeProject,
  type ProjectRepo,
  type ProjectStatus,
  type ProjectTask,
  type TaskRole,
  type TaskTier,
} from "../db/projects.ts";
import {
  computeRound,
  findCycle,
  normaliseWritePath,
  validateWorkstream,
  GraphValidationError,
} from "../lib/task-graph.ts";
import { provisionWorkspace, removeWorkspace } from "../lib/workspace.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOS = new Set<ProjectRepo>(["ai-os", "content-forge", "scratch"]);
const ROLES = new Set<TaskRole>([
  "architect",
  "planner",
  "scout",
  "researcher",
  "builder",
  "reviewer",
  "steward",
  "tester",
]);
const STATUSES = new Set<ProjectStatus>([
  "active",
  "paused",
  "done",
  "blocked",
  "cancelled",
]);
const TIERS = new Set<TaskTier>(["fast", "junior", "standard", "flagship"]);

/* ── R39's workstream cap ───────────────────────────────────────────────────
 *
 * Defined HERE because task creation is where R39 is enforced — its own words:
 * "the refusal is a hard error naming the count and the limit at task-creation
 * time (400), not at spawn time". PHASE 4's provisioning path
 * (`provisionWorkstream` in lib/workspace.ts, R32) reads THIS constant rather
 * than re-reading the environment, so the refusal at task creation and the
 * refusal at provisioning cannot drift into disagreeing about the limit, and
 * phase 4 must not re-open this 400.
 *
 * A MALFORMED OVERRIDE REFUSES TO BOOT rather than defaulting. The obvious
 * spelling, `Number(process.env.PROJECT_MAX_WORKSTREAMS ?? 6)`, yields `NaN` for
 * `PROJECT_MAX_WORKSTREAMS=six`, and `count >= NaN` is false for every count —
 * a silently INFINITE cap, which is exactly the degradation NF1 forbids and the
 * disk-filling failure R39 exists to prevent. Failing at module load names the
 * offending value while someone is still watching the deploy.
 */
export const PROJECT_MAX_WORKSTREAMS = ((): number => {
  const raw = process.env.PROJECT_MAX_WORKSTREAMS ?? "6";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `PROJECT_MAX_WORKSTREAMS must be a positive integer; got ${JSON.stringify(raw)} (R39)`,
    );
  }
  return parsed;
})();

/* ── Project metadata construction (U1, 13-ui-v3-architecture.md §5) ────────
 *
 * The metadata object is built HERE, at the route layer. db/projects.ts takes
 * whatever `metadata` it is handed and writes it verbatim — that `metadata`
 * parameter is the entire seam, and the engine's db layer stays untouched.
 *
 * OPERATOR-PROMPT IMPLICATION (13 §5): for `origin_chat_id` to ever be set on
 * the write path, the operator must pass ITS OWN run id when it creates a
 * project. That is a change to the operator's prompt contract in the vault
 * (config), not to engine code — nothing in this repo can make the operator
 * send the field. Projects created without it stay resolvable only through
 * round 304's thread-scan fallback, which is why that fallback exists at all.
 */

/** The `POST /` request body, as it arrives off the wire: every field optional
 *  and untrusted, validated below. */
type CreateProjectBody = {
  name?: string;
  brief?: string;
  repo?: string;
  base_branch?: string;
  architect_tier?: string;
  mode?: string;
  checkin_hours?: number;
  origin_chat_id?: string;
};

/** Thrown by buildProjectMetadata for input it refuses to shape. The route
 *  maps it to a 400 — never to a silently dropped key, because round 304's
 *  linkage resolver treats the PRESENCE of `origin_chat_id` as truth: a
 *  malformed id that got swallowed here would read downstream as "this project
 *  was never linked to a chat", which is a different and false statement. */
export class ProjectMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectMetadataError";
  }
}

/**
 * Build the `projects.metadata` object for a create request. Pure: no DB, no
 * clock, no I/O — so scripts/checks/check-project-metadata.ts can table-drive
 * it directly.
 *
 * Keys are OMITTED rather than set to null/"" when they do not apply. Callers
 * downstream test presence (`metadata ? 'origin_chat_id'` in SQL, `has()` in
 * jq), so an explicit null would be a false positive.
 *
 * @throws {ProjectMetadataError} when `origin_chat_id` is present, non-empty
 *         and not a uuid.
 */
export function buildProjectMetadata(body: CreateProjectBody): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (body.mode === "goal") {
    metadata.mode = "goal";
    // Number(undefined) is NaN and NaN > 0 is false, so a missing, zero,
    // negative or unparsable interval drops the key — goal mode without a
    // check-in cadence is legal, a check-in every "NaN" hours is not.
    const checkinHours = Number(body.checkin_hours);
    if (checkinHours > 0) metadata.checkin_hours = checkinHours;
    // R31 — NEW goal-mode projects created by this engine demand a write_set on
    // every builder and tester task; EXISTING projects do not carry the key and
    // are untouched, which is what keeps R18's replica of today's behaviour
    // exact. Set unconditionally for goal mode rather than offered as a body
    // field: it is a property of how this engine plans, not a caller's choice.
    metadata.strict_write_sets = true;
  }

  // An empty/whitespace string is "the caller had nothing to send", not an
  // error — that is the shape a shell `--arg` or an unset template variable
  // produces. Anything else non-empty must be a real uuid.
  const originChatId = (body.origin_chat_id ?? "").trim();
  if (originChatId) {
    if (!UUID_RE.test(originChatId)) {
      throw new ProjectMetadataError("origin_chat_id must be a uuid");
    }
    metadata.origin_chat_id = originChatId;
  }

  return metadata;
}

/* Unified board feed — every task across every active/blocked project,
 * for the Kanban UI. Registered before /:id so "board" doesn't get parsed
 * as a project id. */
r.get("/board", async (c) => {
  const tasks = await listActiveTasks();
  return c.json({ count: tasks.length, tasks });
});

/* Manager rollup — one card per active/blocked project with aggregate
 * token/spend/task stats. Registered before /:id so "managers" is never
 * matched as a project id by Hono's param router. */
r.get("/managers", async (c) => {
  const managers = await listManagerRollup();
  return c.json({ managers });
});

r.get("/", async (c) => {
  const projects = await listProjects();
  return c.json({ count: projects.length, projects });
});

r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateProjectBody;
  const name = (body.name ?? "").trim();
  const brief = (body.brief ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if (!brief) return c.json({ error: "brief required" }, 400);
  if (!body.repo || !REPOS.has(body.repo as ProjectRepo)) {
    return c.json({ error: `repo must be one of: ${[...REPOS].join(", ")}` }, 400);
  }
  if (body.architect_tier && !TIERS.has(body.architect_tier as TaskTier)) {
    return c.json({ error: `architect_tier must be one of: ${[...TIERS].join(", ")}` }, 400);
  }
  if (body.mode !== undefined && body.mode !== "goal") {
    return c.json({ error: `mode must be "goal" or omitted` }, 400);
  }

  // Built (and validated) BEFORE createProject: a rejected origin_chat_id must
  // not leave a half-born project and its round-0 architect task behind.
  let metadata: Record<string, unknown>;
  try {
    metadata = buildProjectMetadata(body);
  } catch (e) {
    if (e instanceof ProjectMetadataError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const { project, architectTask } = await createProject({
    name,
    brief,
    repo: body.repo as ProjectRepo,
    base_branch: body.base_branch,
    architect_tier: body.architect_tier as TaskTier | undefined,
    metadata,
  });

  try {
    const ws = await provisionWorkspace(project);
    await setProjectWorkspace(project.id, ws);
  } catch (e) {
    // The project row and its round-0 task exist either way — surfacing the
    // failure as 'blocked' beats silently leaving workspace_dir null with
    // no explanation on the Kanban card.
    await setProjectStatus(project.id, "blocked");
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[projects] workspace provisioning failed for ${project.id}:`, msg);
    return c.json(
      { project: await getProject(project.id), architectTask, warning: `workspace provisioning failed: ${msg}` },
      201,
    );
  }

  return c.json({ project: await getProject(project.id), architectTask }, 201);
});

r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);
  const tasks = await listTasksForProject(id);
  return c.json({ project, tasks });
});

/* ── Task-creation request validation (R22–R31, R39) ────────────────────────
 *
 * The route below validates in ONE order and returns on the FIRST failure. The
 * order is phase 3's "order of operations", which differs from the reading
 * order of the contract table in exactly two places: the computed round (R24)
 * is decided BEFORE the workstream (R28) and the cap (R39), and the write-set
 * (R28) after both. That is deliberate — the round is a property of the
 * dependencies just validated, so it is settled while those rows are in hand —
 * and it is recorded here because it is the only thing that decides which of two
 * simultaneously-broken fields a caller hears about first.
 */

/**
 * A refused task-creation body. Carries a message and nothing else: the route
 * maps it to `400 { error: <message> }`, exactly as it maps
 * `GraphValidationError`.
 *
 * Its own class rather than reusing `GraphValidationError` for the reason that
 * class's own doc-comment gives for not being `GraphIntegrityError`: this is a
 * refusal about the SHAPE OF A REQUEST that lib/task-graph.ts never saw, while
 * `GraphValidationError` is that module refusing a value it was asked to judge.
 * Both are `400`s; a test asserting on the class can still say which layer
 * refused. Same precedent as `ProjectMetadataError` above.
 */
export class TaskRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRequestError";
  }
}

/**
 * Narrow `depends_on` off the wire and de-duplicate it (R22; the input R25 and
 * R27 then judge). Pure apart from its `console.warn`, so it is unit-testable
 * without a database.
 *
 * THE THREE RETURN CASES ARE THE SENTINEL (`02-architecture.md` §2.2, settled
 * as E2 in §9.1), and getting them backwards is the most expensive mistake
 * available in this phase:
 *
 *   absent   → `undefined` → createTask writes SQL NULL → a LEGACY row that
 *              keeps today's round semantics forever. Every old-engine caller.
 *   `[]`     → `[]`        → an explicit GRAPH ROOT that promotes immediately.
 *   `[a, b]` → `[a, b]`    → promotes when a and b are done.
 *
 * AN EXPLICIT `null` IS REFUSED rather than read as absent. `createTask()`'s
 * signature accepts `null` as a synonym for `undefined`, but that is a
 * convenience for internal callers; at the wire boundary `"depends_on": null`
 * is a caller who meant something and typed the wrong thing, and silently
 * reinterpreting it as "legacy row" is a guess with the E2 deploy race behind
 * it. It lands in row 5's `400`.
 *
 * DUPLICATES ARE DROPPED WITH A `console.warn` NAMING THE PROJECT AND THE ID —
 * not silently, and not with a `400`. Phase 2B measured that a
 * `cardinality(depends_on)` exceeding the number of matched rows blocks a task
 * forever, and a repeated id is one of the two ways that happens; this API is
 * the only place one could ever enter, because R6's backfill aggregates
 * distinct rows. NF1 permits a degradation that is a `console.warn` naming the
 * row, and refusing outright would turn a harmless typo into a failed fan-out
 * curl. This is prevention at the boundary, not a live bug.
 *
 * @throws {TaskRequestError} row 5 of phase 3's contract table.
 */
export function parseDependsOn(raw: unknown, projectId: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const SHAPE = "depends_on must be an array of task uuids";
  if (!Array.isArray(raw)) throw new TaskRequestError(SHAPE);
  // Re-typed to `unknown[]`: `Array.isArray()` narrows `unknown` to `any[]`, and
  // NF4 forbids letting an `any` element loose in this file.
  const entries: readonly unknown[] = raw;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !UUID_RE.test(entry)) throw new TaskRequestError(SHAPE);
    if (seen.has(entry)) {
      console.warn(
        `[projects] project ${projectId}: depends_on named ${entry} more than once — ` +
          "the repeat was dropped; a duplicated id makes cardinality(depends_on) exceed " +
          "the rows it matches, which blocks the task forever (R14)",
      );
      continue;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Narrow `write_set` off the wire and normalise every entry (R28). Pure.
 *
 * `undefined` for an absent field — `createTask()` then writes the schema's
 * `'{}'`, an empty set that intersects nothing and is therefore always
 * claimable (R17), which is today's behaviour exactly.
 *
 * A NON-STRING ENTRY IS REFUSED WITH THE ARRAY-SHAPE MESSAGE (row 11), not with
 * `normaliseWritePath()`'s (row 10). That function's contract is
 * `(raw: string)`, and handing it a number would need an `as` cast (NF4) to
 * produce a message about a value it never judged. Row 10 is an invalid PATH;
 * a non-string is a malformed ARRAY.
 *
 * @throws {TaskRequestError} row 11.
 * @throws {GraphValidationError} row 10, from `normaliseWritePath()`, verbatim.
 */
export function parseWriteSet(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const SHAPE = "write_set must be an array of at most 200 repo-relative paths";
  if (!Array.isArray(raw)) throw new TaskRequestError(SHAPE);
  const entries: readonly unknown[] = raw;
  if (entries.length > 200) throw new TaskRequestError(SHAPE);
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new TaskRequestError(SHAPE);
    return normaliseWritePath(entry);
  });
}

/* Task creation — this is what an architect/reviewer run calls via curl
 * from inside its own CC session to fan out the next round of work. */
r.post("/:id/tasks", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    role?: string;
    /** `unknown`, so that `=== null` is a legal comparison and so that the
     *  existing `Number()` expression below stays the only thing that judges
     *  it. The three fields below are `unknown` for R22's own reason: they are
     *  narrowed BY COMPARISON, never by an `as` cast (NF4). */
    round?: unknown;
    title?: string;
    brief?: string;
    tier?: string;
    depends_on?: unknown;
    workstream?: unknown;
    write_set?: unknown;
  };

  /* Loaded ONCE. Dependency resolution (R27), the cycle walk (R25), the
   * computed round (R23/R24) and the workstream count (R39) all read this one
   * list; TASK_COLS carries every column they need. The ONLY per-id query below
   * is the bucket-6/7 split, which asks a question this list cannot answer —
   * "does this id name a row of ANOTHER project?" */
  const tasks = await listTasksForProject(id);
  const byId = new Map<string, ProjectTask>(tasks.map((t) => [t.id, t]));

  if (!body.role || !ROLES.has(body.role as TaskRole)) {
    return c.json({ error: `role must be one of: ${[...ROLES].join(", ")}` }, 400);
  }

  /* R23 — an EXPLICITLY SUPPLIED round is honoured unchanged and never reaches
   * computeRound(): the architect legitimately seeds one phase-block label per
   * phase at k*100 and everything below inherits from it by the +1 rule (E1,
   * ruled settled in 02-architecture.md §9.1). Its validation is the expression
   * that was here before this change, character for character — `round` was
   * REQUIRED until today, so the only requests whose behaviour changes are ones
   * that used to be refused.
   *
   * `null` counts as OMITTED rather than as `Number(null) === 0`: a caller who
   * sends the key with no value is asking the engine to decide, and with
   * depends_on absent computeRound([]) returns that same 0 anyway. */
  const roundSupplied = body.round !== undefined && body.round !== null;
  let round = 0;
  if (roundSupplied) {
    round = Number(body.round);
    if (!Number.isFinite(round) || round < 0) {
      return c.json({ error: "round must be a non-negative integer" }, 400);
    }
  }

  const title = (body.title ?? "").trim();
  const brief = (body.brief ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  if (!brief) return c.json({ error: "brief required" }, 400);
  if (body.tier && !TIERS.has(body.tier as TaskTier)) {
    return c.json({ error: `tier must be one of: ${[...TIERS].join(", ")}` }, 400);
  }

  let dependsOn: string[] | undefined;
  try {
    dependsOn = parseDependsOn(body.depends_on, id);
  } catch (e) {
    // TaskRequestError only. Anything else is a bug in this process and belongs
    // in the 500 that an unhandled throw produces (NF1) — never blamed on the
    // caller as a 400.
    if (e instanceof TaskRequestError) return c.json({ error: e.message }, 400);
    throw e;
  }

  /* R27 — every id must name an existing row OF THIS PROJECT. The two failures
   * are DELIBERATELY DISTINCT messages: phase 2B learned the cost of one shared
   * message the expensive way, where a cross-project id counted as "does not
   * exist" would have sent the next reader hunting a vanished row that is
   * sitting right there under another project id. `byId` answers "in this
   * project" for free; only the ids it misses cost a getTask(), and that lookup
   * is the whole difference between the two buckets.
   *
   * `dependsOn ?? []` is "there was no field, so there is nothing to resolve" —
   * not an NF1 rescue. `undefined` is the legacy sentinel and `[]` is an
   * explicit root; both name zero dependency rows, and the distinction between
   * them is preserved intact in `dependsOn` itself, which is what reaches
   * createTask(). */
  const unknownDeps: string[] = [];
  const foreignDeps: string[] = [];
  const deps: ProjectTask[] = [];
  for (const depId of dependsOn ?? []) {
    const local = byId.get(depId);
    if (local !== undefined) {
      deps.push(local);
      continue;
    }
    const elsewhere = await getTask(depId);
    if (elsewhere === null) unknownDeps.push(depId);
    else foreignDeps.push(depId);
  }
  /* BOTH buckets can be non-empty in one request. Decision: the unknown ids are
   * reported FIRST and alone. Two refusals in one body would need either two
   * `error` strings or a nested shape, and every other 400 on this route is a
   * flat `{ error }`; a caller who fixes the ids re-POSTs and sees the second
   * refusal immediately, while the structured field always matches the message
   * it accompanies. */
  if (unknownDeps.length > 0) {
    return c.json(
      {
        error:
          `depends_on names ${unknownDeps.length} dependency id(s) that do not exist: ` +
          unknownDeps.join(", "),
        unknown_dependencies: unknownDeps,
      },
      400,
    );
  }
  if (foreignDeps.length > 0) {
    return c.json(
      {
        error:
          `depends_on names ${foreignDeps.length} dependency id(s) belonging to another ` +
          `project: ${foreignDeps.join(", ")}`,
        cross_project_dependencies: foreignDeps,
      },
      400,
    );
  }

  /* R25 — the belt (R26 says why it is one). The candidate row does not exist
   * yet, so it is walked under a MINTED id, and the placeholder is sound for a
   * stated reason rather than a convenient one: R29 makes `depends_on`
   * immutable after insert, so the only edges this node can ever have are the
   * ones in this request body, and a v4 uuid cannot collide with a stored row's
   * id. Nothing is written under the placeholder — createTask() below lets the
   * database mint the real id. */
  if (dependsOn !== undefined && dependsOn.length > 0) {
    const cycle = findCycle(
      { id: globalThis.crypto.randomUUID(), depends_on: dependsOn },
      byId,
    );
    if (cycle !== null) {
      return c.json(
        {
          error:
            "depends_on would close a cycle: " +
            cycle.map((n) => `${n.title} (${n.id})`).join(" -> "),
          cycle,
        },
        400,
      );
    }
  }

  // R23/R24 — computed only when the caller supplied no round. GraphValidationError
  // is R24's block overflow and is the caller's `depends_on`, so it is a 400;
  // anything else rethrows (a GraphIntegrityError here would mean the STORED
  // graph is corrupt, which is a 500 and correctly not the caller's fault).
  if (!roundSupplied) {
    try {
      round = computeRound(deps);
    } catch (e) {
      if (e instanceof GraphValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  }

  /* R28/R4 — the workstream. Absent stays `undefined` and createTask()'s
   * documented default ('main', mirroring the schema) fires; nothing here
   * coerces an invalid name into 'main', which NF1 names as forbidden. */
  let workstream: string | undefined;
  if (body.workstream !== undefined) {
    if (typeof body.workstream !== "string") {
      // validateWorkstream()'s contract is `(raw: string)`; handing it a number
      // would need an `as` cast (NF4) to get a message about a value it never
      // judged, so the type refusal is made here and named as such.
      return c.json(
        { error: `workstream must be a string; got ${typeof body.workstream}` },
        400,
      );
    }
    try {
      workstream = validateWorkstream(body.workstream);
    } catch (e) {
      if (e instanceof GraphValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  }

  /* R39 — the cap, refused at TASK-CREATION time and not at spawn time, in R39's
   * own words. Counted over the DISTINCT workstreams this project already has;
   * a task joining one of them is always allowed, however many there are, because
   * it provisions no new worktree. Sorted so the message is byte-identical for
   * one project state regardless of insert order.
   *
   * `workstream ?? "main"` is the same default-for-OMITTED that createTask()
   * applies one call below, stated here because the cap must count the
   * workstream the row will actually be written into. It is not a
   * fallback-for-invalid: an invalid name has already been refused above. */
  const requestedWorkstream = workstream ?? "main";
  const presentWorkstreams = [...new Set(tasks.map((t) => t.workstream))].sort();
  if (
    !presentWorkstreams.includes(requestedWorkstream) &&
    presentWorkstreams.length >= PROJECT_MAX_WORKSTREAMS
  ) {
    return c.json(
      {
        error:
          `project already has ${presentWorkstreams.length} workstream(s) ` +
          `(limit PROJECT_MAX_WORKSTREAMS=${PROJECT_MAX_WORKSTREAMS}): ` +
          `${presentWorkstreams.join(", ")}; refusing to create a task in new ` +
          `workstream "${requestedWorkstream}"`,
      },
      400,
    );
  }

  // R28 — the write set. The NORMALISED values are what gets stored: R16's
  // contention test is exact string equality, so two spellings of one file
  // would stop conflicting.
  let writeSet: string[] | undefined;
  try {
    writeSet = parseWriteSet(body.write_set);
  } catch (e) {
    if (e instanceof TaskRequestError || e instanceof GraphValidationError) {
      return c.json({ error: e.message }, 400);
    }
    throw e;
  }

  /* R31 — `=== true`, not a truthiness test: `metadata` is free-form jsonb and
   * the string "false" is truthy. The optional chain is for the row, not for the
   * key: `Project.metadata` is typed non-nullable, and a project whose column
   * somehow arrived NULL must read as "does not set the flag" rather than throw
   * on every task creation. Roles are compared as literals rather than cast
   * (NF4); `body.role` has already been proved a member of ROLES above. */
  const strictWriteSets = project.metadata?.strict_write_sets === true;
  if (
    strictWriteSets &&
    (body.role === "builder" || body.role === "tester") &&
    (writeSet === undefined || writeSet.length === 0)
  ) {
    return c.json(
      {
        error:
          "this project sets metadata.strict_write_sets: a " +
          `${body.role} task requires a non-empty write_set`,
      },
      400,
    );
  }

  const { task, created } = await createTask({
    project_id: id,
    round,
    role: body.role as TaskRole,
    title,
    brief,
    tier: body.tier as TaskTier | undefined,
    /* THE SENTINEL — the single line in this phase most worth a second reader
     * (02-architecture.md §2.2, ruled as E2 in §9.1). `dependsOn` is `undefined`
     * when the caller sent NO depends_on, which createTask() writes as SQL NULL:
     * a LEGACY row that keeps today's round semantics. It is `[]` only when the
     * caller sent `[]`, which is an explicit graph ROOT that promotes
     * immediately. Passing `[]` for an absent field would make every row written
     * by an old-engine caller a root and re-open the deploy race E2 exists to
     * close — on a project that is live right now. */
    depends_on: dependsOn,
    workstream,
    write_set: writeSet,
  });
  if (!created) {
    // Idempotency (migration 0035): a retried curl gets the original task id
    // back, not a second task that would race it in the same worktree.
    return c.json(
      {
        task,
        error:
          "duplicate task: this project already has a task with that round/role/title",
      },
      409,
    );
  }
  return c.json({ task }, 201);
});

/* Unwedge: retry every failed/blocked task in the earliest round that has one,
 * and un-block the project. The bulk counterpart to POST /api/tasks/:id/retry
 * — one call to get a frozen project moving again instead of hand-written SQL
 * against project_tasks (E3). */
r.post("/:id/unwedge", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
  const out = await unwedgeProject(id, { force: body.force === true });
  if (out.round === null) {
    return c.json(
      { error: "nothing to unwedge: no failed or blocked tasks", project },
      409,
    );
  }
  console.log(
    `[projects] unwedge ${id} round ${out.round}: ${out.retried.length} retried, ` +
      `${out.skipped.length} skipped`,
  );
  /* The warning is composed per REASON (round 204). Until R14 gained its retry
   * refusal, "exceeded the retry cap" was the only way a task could be skipped;
   * telling an operator to re-send with {"force":true} for a task whose
   * depends_on is corrupt would send them round a loop force cannot open. */
  const corrupt = out.skipped_reasons.filter((s) => s.reason === "dependencies_corrupt");
  const capped = out.skipped_reasons.filter((s) => s.reason === "attempts_exhausted");
  const other = out.skipped_reasons.filter(
    (s) => s.reason !== "dependencies_corrupt" && s.reason !== "attempts_exhausted",
  );
  const warnings = [
    ...(capped.length > 0
      ? [`${capped.length} task(s) exceeded the retry cap — re-send with {"force":true} to override`]
      : []),
    ...corrupt.map(
      (s) => `task ${s.id} was NOT retried: its depends_on ${s.detail ?? "is corrupt"} (R14) — force does not override this`,
    ),
    ...other.map((s) => `task ${s.id} was NOT retried: ${s.reason}`),
  ];
  return c.json({
    project: await getProject(id),
    round: out.round,
    retried: out.retried,
    skipped: out.skipped,
    skipped_reasons: out.skipped_reasons,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  });
});

/* Pause / resume / cancel. Cancel best-effort tears down the git worktree. */
r.post("/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = (body.status ?? "") as ProjectStatus;
  if (!STATUSES.has(status)) {
    return c.json({ error: `status must be one of: ${[...STATUSES].join(", ")}` }, 400);
  }
  const updated = await setProjectStatus(id, status);
  if (status === "cancelled") {
    await removeWorkspace(project);
  }
  return c.json({ project: updated });
});

export default r;
