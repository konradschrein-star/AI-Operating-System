/**
 * chat-linkage.ts — chat↔project linkage (U2, U3; 13-ui-v3-architecture.md §5).
 *
 * A chat in the rail may have started a coding project. Nothing in the schema
 * said so until phase 300f: `POST /api/projects` now accepts `origin_chat_id`
 * and stores it in `projects.metadata`. That is the forward path, and it only
 * helps projects created from now on. Everything created before this week has
 * to be recovered from the one place the evidence survives — the operator
 * chat's own thread, where the `curl -X POST /api/projects` and its response
 * are recorded as `tool_call` / `tool_result` entries.
 *
 * Two callers, two very different cost profiles, so two exported functions:
 *
 *   • resolveChatProject(chatId)  — DETAIL path. metadata first, bounded
 *     thread scan as fallback, backfill on an unambiguous scan hit. Reads one
 *     run's whole `thread` (megabytes on a long chat), so it runs once per
 *     opened chat, never per row of a list.
 *
 *   • rollupChatProjects(chatIds) — LIST path (the rail). ONE grouped query
 *     for the whole page, `metadata.origin_chat_id` only, no thread, no scan.
 *
 * No route lives here and nothing is mounted — `chat.ts` owns the endpoints.
 * The pool is route-local (mirroring `agents.ts`) because `db/projects.ts` and
 * `db/runs.ts` are owned by the engine lane this cycle and must not change.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[chat-linkage pool]", e.message));

/**
 * Every database call in this module goes through here — which is what makes
 * "the rail costs ONE query per page, whatever the page size" a checkable
 * claim instead of a promise. Set `FORGE_LINKAGE_DEBUG=1` and each call logs
 * its running number, its label and its row count; counting log lines for
 * `?limit=5` versus `?limit=30` is then the O(1) proof (recorded in
 * docs/plan/artifacts/phase300/rollup-cost.md).
 *
 * Off by default: the rail polls every 8 s and a line per poll would be noise
 * in the pm2 log, not observability.
 */
const LINKAGE_DEBUG = process.env.FORGE_LINKAGE_DEBUG === "1";
let dbCalls = 0;

async function q<R extends QueryResultRow>(
  label: string,
  text: string,
  params: unknown[],
): Promise<QueryResult<R>> {
  const n = ++dbCalls;
  const res = await pool.query<R>(text, params);
  if (LINKAGE_DEBUG) {
    console.log(
      `[chat-linkage] db#${n} ${label} in=${JSON.stringify(params).slice(0, 90)} rows=${res.rowCount}`,
    );
  }
  return res;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid-shaped token in a blob of tool output. */
const UUID_SCAN_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* ═══════════════════════════════════════════════════════════════════════════
 * PART A — the resolver (U2)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One project that claims this chat, as the switcher renders it. */
export interface ChatProjectCandidate {
  id: string;
  name: string | null;
  status: string;
}

export interface ChatProjectLink {
  project_id: string | null;
  project_status: string | null;
  /** How the link was established. `null` iff `project_id` is null. */
  link_source: "metadata" | "thread_scan" | null;
  /** True when more than one project claims this chat. The RANKED winner is
   *  returned (see `rankCandidates`), and `candidates` carries the rest so the
   *  UI can offer them instead of only confessing to a problem. */
  link_ambiguous: boolean;
  /** Every project that claims this chat, best first. One entry in the normal
   *  case; empty only when `project_id` is null. */
  candidates: ChatProjectCandidate[];
}

const UNLINKED: ChatProjectLink = {
  project_id: null,
  project_status: null,
  link_source: null,
  link_ambiguous: false,
  candidates: [],
};

/** A `runs.thread` entry, narrowed to what the scan reads. The full shape is
 *  `{role, content, ts, kind?, meta?}` (plan-300.md, "Facts established"). */
interface ThreadEntryLite {
  kind?: string;
  content?: string;
}

interface ProjectLinkRow {
  id: string;
  name: string | null;
  status: string;
}

/* ── Which project a chat is ABOUT, when it started more than one ────────────
 *
 * Round 1871. Chat `bfd1283a…` created two projects: `operator-visibility`
 * (active, 5 Aug) and `engine-task-graph` (paused, 17 Aug). "Newest wins"
 * handed the panel the PAUSED one, so the chat that is running
 * operator-visibility rendered engine-task-graph's seventeen workers and its
 * 16/27 board, and the only disclosure was a nine-pixel "ambiguous link".
 * Konrad's reading of that, correctly: this is not my chat's team.
 *
 * Creation order is the weakest possible signal for "what is this chat about
 * right now". LIVENESS is the strong one — a project still running is the one
 * whose workers are moving, and it is the reason the panel is open. So:
 *
 *   1. RUNNING statuses first — the project that still has agents in it.
 *   2. Then dormant-but-unfinished, then finished, then abandoned.
 *   3. Newest first inside a tier — the old tie-break, demoted to a tie-break.
 *
 * An unranked status (a new one nobody taught this map about) sorts with the
 * dormant tier rather than last: an unrecognised status is not evidence of
 * being finished, and burying it would hide a project entirely.
 *
 * The ranking decides a DEFAULT, not a verdict. Every candidate ships on the
 * wire and the panel offers them, which is the half that makes a wrong default
 * a click rather than a dead end.
 */
const STATUS_RANK: Record<string, number> = {
  active: 0,
  running: 0,
  planning: 1,
  paused: 2,
  blocked: 2,
  completed: 3,
  done: 3,
  failed: 4,
  cancelled: 4,
  archived: 5,
};

const STATUS_RANK_UNKNOWN = 2;

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? STATUS_RANK_UNKNOWN;
}

/**
 * Order the projects claiming one chat, best first. Pure and exported so
 * `scripts/checks` can assert the tie-break without a database.
 *
 * `rows` MUST already be ordered `created_at DESC` — the sort below is stable
 * (V8's `Array.prototype.sort` is, and has been since Node 11), so equal ranks
 * keep the query's newest-first order and no created_at travels on the wire.
 */
export function rankCandidates(rows: ProjectLinkRow[]): ProjectLinkRow[] {
  return [...rows].sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

function toCandidates(rows: ProjectLinkRow[]): ChatProjectCandidate[] {
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
}

/* ── Scan bounds — the bound IS the feature ──────────────────────────────────
 *
 * The planner measured what an unbounded "uuid appears somewhere in the
 * thread" scan produces: chat `bfd1283a…` mentions 5 project uuids and
 * `a86cf7b3…` mentions 7 — task-posting curls, `GET /api/projects` dumps,
 * git output. Every one of those would be a false link. Three bounds, all
 * documented here because a reviewer has to be able to check them:
 *
 *   1. ENDPOINT — the mention must be `/api/projects` with NO further path
 *      segment. `/api/projects/<uuid>/tasks` is TASK creation inside an
 *      existing project and is explicitly not evidence that this chat created
 *      it; `/api/projects/board`, `/api/projects/managers` and
 *      `/api/projects/<id>` are reads.
 *   2. METHOD — a literal, case-sensitive `POST` within POST_LOOKBACK chars
 *      before the mention. Case-sensitive on purpose: it must not match the
 *      `r.post("/", …)` route source that these chats routinely paste.
 *      Known limit: a POST expressed only as `curl -d … /api/projects`, with
 *      no `-X POST` before the URL, is NOT matched. Missing a link is a
 *      recoverable "no x/y badge yet"; a wrong link is a lie in the UI.
 *   3. LOOKAHEAD — the uuid is taken from the FIRST `tool_result` within
 *      RESULT_LOOKAHEAD entries after the matching `tool_call`, and the walk
 *      stops early at the next `tool_call` (a call whose result never landed
 *      has no answer to give). In this database every tool_call is followed
 *      immediately by its tool_result; the slack absorbs an interleaved
 *      `text`/`error` entry without ever crossing into another tool's output.
 */
const POST_LOOKBACK = 200;
const RESULT_LOOKAHEAD = 3;
const PROJECTS_ENDPOINT = "/api/projects";

/**
 * Does this `tool_call` content contain a POST to the project-CREATION
 * endpoint? Bounds 1 and 2 above.
 *
 * Exported for the checks tree: the rule is the whole safety argument of the
 * scan, so it must be testable without a database.
 */
export function isProjectCreateCall(content: string): boolean {
  for (
    let i = content.indexOf(PROJECTS_ENDPOINT);
    i !== -1;
    i = content.indexOf(PROJECTS_ENDPOINT, i + 1)
  ) {
    // Bound 1: what follows the endpoint decides whether this is creation.
    // `undefined` (end of string) counts as a clean end, as does a quote,
    // space, pipe or backslash — anything that is not more path or more word.
    const next = content[i + PROJECTS_ENDPOINT.length];
    if (next !== undefined && /[/A-Za-z0-9-]/.test(next)) continue;
    // Bound 2: the method, in the window right before the URL.
    const before = content.slice(Math.max(0, i - POST_LOOKBACK), i);
    if (/\bPOST\b/.test(before)) return true;
  }
  return false;
}

/**
 * Walk a thread in order and collect the uuids that a bounded scan attributes
 * to project creation. Pure — no DB. The returned uuids are CANDIDATES; they
 * are worth nothing until checked against the `projects` table (bound 4: a
 * uuid that is not a project row is not a project).
 */
export function scanThreadForProjectIds(thread: ThreadEntryLite[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < thread.length; i++) {
    const entry = thread[i];
    if (entry?.kind !== "tool_call") continue;
    const call = typeof entry.content === "string" ? entry.content : "";
    if (!isProjectCreateCall(call)) continue;

    for (let j = i + 1; j <= i + RESULT_LOOKAHEAD && j < thread.length; j++) {
      const ahead = thread[j];
      if (ahead?.kind === "tool_call") break; // its result never landed
      if (ahead?.kind !== "tool_result") continue;
      const result = typeof ahead.content === "string" ? ahead.content : "";
      for (const uuid of result.match(UUID_SCAN_RE) ?? []) {
        const lower = uuid.toLowerCase();
        if (!found.includes(lower)) found.push(lower);
      }
      break;
    }
  }
  return found;
}

/**
 * Resolve which coding project a chat started.
 *
 * Order: `metadata.origin_chat_id` (truth, written by the create path), then
 * the bounded thread scan (recovery, for chats that predate that field). An
 * unlinked chat is a normal answer, not an error — callers return HTTP 200.
 *
 * @throws when `chatId` is not a uuid, or when the database is unreachable —
 *         both are propagated to the route as a 500 with the message, never
 *         swallowed into a "no project" answer, which would be a different
 *         and false statement (NFU6).
 */
export async function resolveChatProject(
  chatId: string,
): Promise<ChatProjectLink> {
  if (!UUID_RE.test(chatId)) {
    throw new Error(`resolveChatProject: chat id is not a uuid: ${chatId}`);
  }

  // ── 1. PRIMARY: metadata. When more than one project claims the chat the
  //       LIVEST wins, not the newest — see `rankCandidates`. Both travel.
  const byMeta = await q<ProjectLinkRow>(
    "resolve/metadata",
    `SELECT id::text, name, status
       FROM projects
      WHERE metadata->>'origin_chat_id' = $1
      ORDER BY created_at DESC`,
    [chatId],
  );
  if (byMeta.rows.length > 0) {
    const ranked = rankCandidates(byMeta.rows);
    const winner = ranked[0]!;
    return {
      project_id: winner.id,
      project_status: winner.status,
      link_source: "metadata",
      link_ambiguous: ranked.length > 1,
      candidates: toCandidates(ranked),
    };
  }

  // ── 2. FALLBACK: bounded thread scan. One run's thread, on the detail path
  //       only — `runs.thread` is a multi-megabyte JSONB on a long chat and
  //       this is why the list path (rollupChatProjects) never scans.
  const runRow = await q<{ thread: ThreadEntryLite[] | null }>(
    "resolve/thread",
    `SELECT thread FROM runs WHERE id = $1`,
    [chatId],
  );
  const thread = runRow.rows[0]?.thread;
  if (!Array.isArray(thread) || thread.length === 0) return UNLINKED;

  const candidates = scanThreadForProjectIds(thread);
  if (candidates.length === 0) return UNLINKED;

  // Bound 4: only uuids that are actually project rows survive.
  const real = await q<ProjectLinkRow>(
    "resolve/validate-candidates",
    `SELECT id::text, name, status
       FROM projects
      WHERE id = ANY($1::uuid[])
      ORDER BY created_at DESC`,
    [candidates],
  );
  if (real.rows.length === 0) return UNLINKED;

  const ranked = rankCandidates(real.rows);
  const winner = ranked[0]!;
  const ambiguous = ranked.length > 1;

  // ── 3. BACKFILL — the only write in phase 300, and deliberately the
  //       narrowest one possible. It fires ONLY on an unambiguous scan hit:
  //       an ambiguous chat gets no guess written into the database, because
  //       a wrong `origin_chat_id` would then be served as `link_source:
  //       "metadata"` forever — a heuristic laundered into truth.
  if (!ambiguous) {
    await backfillOriginChatId(chatId, winner.id);
  }

  return {
    project_id: winner.id,
    project_status: winner.status,
    link_source: "thread_scan",
    link_ambiguous: ambiguous,
    candidates: toCandidates(ranked),
  };
}

/**
 * Where the backfill ledger is appended. Deliberately OUT of the git tree: it
 * is a runtime audit record, and while it lived at
 * `docs/plan/artifacts/phase300/backfill.log` the engine dirtied a tracked file
 * inside the live checkout as normal operation — which made the reviewer brief's
 * "`git status --porcelain` empty is the only pass" unreachable. The in-tree
 * file stays where it is, frozen, as committed history.
 *
 * `||`, not `??`: an empty `FORGE_BACKFILL_LOG` is a misconfiguration, and
 * falling through to the real destination beats appending to "" and losing the
 * ledger into the swallowed-error path below.
 */
export const BACKFILL_LOG =
  process.env.FORGE_BACKFILL_LOG || "/var/log/forge/chat-linkage-backfill.log";

/**
 * Write `origin_chat_id` into a project's metadata, once, ever.
 *
 * Idempotent by SQL, not by convention: `NOT (metadata ? 'origin_chat_id')`
 * means a second call updates zero rows, and an existing value — including
 * one a human or the create path wrote — is never overwritten. `metadata ||`
 * merges, so no other key is touched.
 *
 * Every actual write is logged twice: to the process log (visible in pm2) and
 * appended to `/var/log/forge/chat-linkage-backfill.log` (or FORGE_BACKFILL_LOG), which is the list
 * the phase's rollback line consumes.
 */
export async function backfillOriginChatId(
  chatId: string,
  projectId: string,
): Promise<void> {
  const res = await q(
    "backfill/update",
    `UPDATE projects
        SET metadata = metadata || jsonb_build_object('origin_chat_id', $1::text)
      WHERE id = $2
        AND NOT (metadata ? 'origin_chat_id')`,
    [chatId, projectId],
  );
  if (res.rowCount === 0) return; // already linked — nothing written, nothing logged

  const line = `${new Date().toISOString()} backfill origin_chat_id chat=${chatId} project=${projectId}`;
  console.log(`[chat-linkage] ${line}`);
  try {
    await mkdir(path.dirname(BACKFILL_LOG), { recursive: true });
    await appendFile(BACKFILL_LOG, `${line}\n`, "utf8");
  } catch (e) {
    // The row is already written; failing the caller's read would misreport a
    // resolved link as a server error. Loud in the log, never silent — and the
    // console line above still carries both ids for manual rollback.
    console.error(
      `[chat-linkage] backfill.log append failed (${BACKFILL_LOG}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PART B — the rail rollup (U3)
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ChatProjectRollup {
  project_id: string;
  project_status: string;
  tasks_done: number;
  tasks_total: number;
}

interface RollupRow {
  chat_id: string;
  project_id: string;
  status: string;
  created_at: string;
  total: string;
  done: string;
}

/**
 * Task progress for a whole page of chats, in ONE query.
 *
 * Linkage here is `metadata.origin_chat_id` ONLY — no thread scan on the hot
 * list path (13-ui-v3-architecture.md §3). The scan is O(thread) and the rail
 * is 30 rows wide; scanning it would mean reading thirty multi-megabyte JSONB
 * columns every 8 seconds.
 *
 * CONSEQUENCE, stated plainly: a chat created before `origin_chat_id` existed
 * shows NO x/y in the rail until it is opened once. Opening it runs the detail
 * resolver, which scans and backfills `origin_chat_id` — after that the chat
 * has metadata linkage and the rail shows its progress like any other. A chat
 * whose scan is ambiguous is never backfilled and therefore never gets a rail
 * badge; that is the intended price of not guessing.
 *
 * Returns a map keyed by chat id, containing ONLY chats that resolved. Callers
 * must OMIT the fields for the rest — a 0/0 would render as a real progress
 * badge for a chat that has no project at all.
 *
 * @throws on any database error — the rail would rather show an error than a
 *         page of chats silently missing their progress.
 */
export async function rollupChatProjects(
  chatIds: string[],
): Promise<Map<string, ChatProjectRollup>> {
  const out = new Map<string, ChatProjectRollup>();
  if (chatIds.length === 0) return out;

  // `p.status` and `p.created_at` are selected without being grouped: grouping
  // by the PRIMARY KEY `p.id` makes every other column of `p` functionally
  // dependent on the group, which Postgres accepts. That is also why the
  // GROUP BY lists `p.id` and not the ordinal of `p.id::text` — a cast is an
  // expression, not the key column, and Postgres does not chase the
  // dependency through it (verified the hard way: `42803
  // check_ungrouped_columns_walker`).
  // `created_at` earns its place by breaking ties when two projects claim the
  // same chat: newest wins, the same rule the detail resolver applies.
  const res = await q<RollupRow>(
    "rollup/list",
    `SELECT p.metadata->>'origin_chat_id' AS chat_id,
            p.id::text AS project_id,
            p.status,
            p.created_at::text,
            count(t.*)::text AS total,
            count(t.*) FILTER (WHERE t.status = 'done')::text AS done
       FROM projects p
       LEFT JOIN project_tasks t ON t.project_id = p.id
      WHERE p.metadata->>'origin_chat_id' = ANY($1::text[])
      GROUP BY p.metadata->>'origin_chat_id', p.id`,
    [chatIds],
  );

  const newest = new Map<string, RollupRow>();
  for (const row of res.rows) {
    const prev = newest.get(row.chat_id);
    if (!prev || row.created_at > prev.created_at) newest.set(row.chat_id, row);
  }
  for (const [chatId, row] of newest) {
    out.set(chatId, {
      project_id: row.project_id,
      project_status: row.status,
      // `count()` is bigint; node-postgres hands bigints back as strings so
      // large values can't lose precision. Task counts are two digits — Number
      // is exact here, and the wire field stays a JSON number as specified.
      tasks_done: Number(row.done),
      tasks_total: Number(row.total),
    });
  }
  return out;
}
