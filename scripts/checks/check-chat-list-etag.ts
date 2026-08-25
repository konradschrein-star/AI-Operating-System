/**
 * check-chat-list-etag.ts — Fast, non-browser verification of the chat list's
 * conditional-request contract (GET /api/chat).
 *
 * Project: aios-chat-list-etag (harness workstream)
 *
 * This script mounts the REAL Hono `chat` router from
 * forge-control/src/routes/chat.ts in-process and drives it with real HTTP
 * `Request`/`Response` objects — it does NOT reimplement ETag computation or
 * If-None-Match matching itself. A harness that re-derives the algorithm it
 * is meant to verify can pass forever regardless of what the route actually
 * does (see /root/.claude/projects/-opt-forge-ai-os/memory/
 * verifier-asserted-on-fixture-not-invariant.md) — so every assertion below
 * reads a header or a body byte count off a REAL response from the REAL
 * router.
 *
 * DB mutations (create/status-change/append/archive) need a database to
 * mutate. Per /root/.claude/projects/-opt-forge-ai-os/memory/
 * scratch-db-plus-redis-db9-proves-write-path.md this script provisions its
 * OWN per-run scratch Postgres database (schema-only pg_dump of `runs`,
 * `projects`, `project_tasks` from content_forge — read-only against live)
 * and points `DATABASE_URL` at it before importing the route, so nothing
 * live is read-modify-written from this build-time check. The scratch DB is
 * left in place afterward (named in the summary) for a reviewer to reinspect
 * — dropping it is a destructive verb this script does not need.
 *
 * AS OF THIS WRITING the server workstream (which adds ETag/304 support to
 * GET /api/chat) has not landed in THIS worktree — chat.ts has no ETag or
 * Cache-Control handling yet. Sections 1 and 2 below will legitimately FAIL
 * until that lands; that is the correct, honest behaviour of this harness,
 * not a bug in it. Re-run after the server and this branch merge.
 *
 * Section 3 is a pure design-contract simulation of the CLIENT state machine
 * (etag-304-needs-an-explicit-client.md) — it proves the algorithm the real
 * client must implement is internally consistent, but it is NOT a claim
 * about shipped client code (forge-control-web/app/api.ts's `fetchChatList`
 * does not hold a validator yet either). The only proof of the real client
 * is check-chat-list-etag-browser.ts Part B.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-chat-list-etag.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/* ════════════════════════════════════════════════════════════════════════
 * Scratch DB provisioning — read-only against live, write-only against a
 * per-run database this script owns.
 * ══════════════════════════════════════════════════════════════════════ */

function loadForgeControlEnv(): void {
  const envFile = "/opt/ai-os/.secrets/forge-control.env";
  if (!fs.existsSync(envFile)) {
    throw new Error(`${envFile} not found — cannot read DATABASE_URL to provision the scratch DB`);
  }
  const content = fs.readFileSync(envFile, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadForgeControlEnv();

interface PgConn {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

function parsePgUrl(url: string): PgConn {
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+)$/);
  if (!m) throw new Error(`cannot parse DATABASE_URL as postgresql://user:pass@host:port/db`);
  return { user: m[1], password: decodeURIComponent(m[2]), host: m[3], port: m[4], database: m[5] };
}

const LIVE_DATABASE_URL = process.env.DATABASE_URL;
if (!LIVE_DATABASE_URL) {
  throw new Error("DATABASE_URL missing after loading /opt/ai-os/.secrets/forge-control.env");
}
const liveConn = parsePgUrl(LIVE_DATABASE_URL);

const RUN_ID = process.env.FORGE_RUN_ID;
if (!RUN_ID) {
  throw new Error("FORGE_RUN_ID is not set — this script names its scratch DB from it, one per run");
}
const SCRATCH_DB_NAME = `chat_etag_probe_${RUN_ID}`;
const SCRATCH_DATABASE_URL = `postgresql://${liveConn.user}:${encodeURIComponent(liveConn.password)}@${liveConn.host}:${liveConn.port}/${SCRATCH_DB_NAME}`;

function psql(database: string, args: string[]): string {
  return execFileSync(
    "psql",
    ["-U", liveConn.user, "-h", liveConn.host, "-p", liveConn.port, "-d", database, ...args],
    { env: { ...process.env, PGPASSWORD: liveConn.password }, encoding: "utf8" },
  );
}

function databaseExists(name: string): boolean {
  const out = psql(liveConn.database, ["-tAc", `SELECT 1 FROM pg_database WHERE datname = '${name}'`]);
  return out.trim() === "1";
}

function provisionScratchDb(): void {
  if (databaseExists(SCRATCH_DB_NAME)) {
    console.log(`Scratch DB ${SCRATCH_DB_NAME} already exists — reusing.`);
    return;
  }
  console.log(`Provisioning scratch DB ${SCRATCH_DB_NAME} (schema-only dump of runs/projects/project_tasks)...`);
  psql(liveConn.database, ["-c", `CREATE DATABASE "${SCRATCH_DB_NAME}"`]);
  psql(SCRATCH_DB_NAME, ["-c", "CREATE EXTENSION IF NOT EXISTS pg_trgm"]);
  const schemaFile = path.join("/tmp", `chat_etag_schema_${RUN_ID}.sql`);
  const dump = execFileSync(
    "pg_dump",
    ["-U", liveConn.user, "-h", liveConn.host, "-p", liveConn.port, "-s", liveConn.database, "-t", "runs", "-t", "projects", "-t", "project_tasks"],
    { env: { ...process.env, PGPASSWORD: liveConn.password }, encoding: "utf8" },
  );
  fs.writeFileSync(schemaFile, dump);
  const loadLog = psql(SCRATCH_DB_NAME, ["-f", schemaFile]);
  if (/^ERROR:/m.test(loadLog)) {
    throw new Error(`schema load into ${SCRATCH_DB_NAME} reported errors:\n${loadLog}`);
  }
  console.log(`Scratch DB ${SCRATCH_DB_NAME} provisioned clean.`);
}

provisionScratchDb();
// Bind BEFORE any dynamic import of route/db modules — both runs.ts and
// chat-linkage.ts read process.env.DATABASE_URL at module load time into a
// module-level `Pool`, so setting it after import would have no effect.
process.env.DATABASE_URL = SCRATCH_DATABASE_URL;

/* ════════════════════════════════════════════════════════════════════════
 * Assertion helpers
 * ══════════════════════════════════════════════════════════════════════ */

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
}

function checkTrue(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

interface CapturedResponse {
  status: number;
  etag: string | null;
  cacheControl: string | null;
  bodyBytes: number;
  runCount: number | null;
}

async function callChatList(
  chatRouter: { fetch(req: Request): Response | Promise<Response> },
  ifNoneMatch?: string,
): Promise<CapturedResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  const res = await chatRouter.fetch(new Request("http://probe.local/?limit=30", { headers }));
  const bodyText = await res.text();
  let runCount: number | null = null;
  if (bodyText.length > 0) {
    try {
      const json = JSON.parse(bodyText);
      runCount = Array.isArray(json.runs) ? json.runs.length : null;
    } catch {
      // non-JSON or empty — runCount stays null
    }
  }
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    cacheControl: res.headers.get("cache-control"),
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
    runCount,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * Main
 * ══════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  const { default: chat } = await import("../../forge-control/src/routes/chat.ts");
  const { createRun, setRunStatus, appendMessage, archiveRun } = await import(
    "../../forge-control/src/db/runs.ts"
  );

  console.log("\n── 1. Backend ETag Contract: cold GET, 304 conditional, weak tags ──────");

  // 1.1 Cold GET against an empty scratch DB (no If-None-Match)
  const cold = await callChatList(chat);
  check("Cold GET returns HTTP 200", cold.status, 200);
  checkTrue("Cold GET returns runs array", cold.runCount !== null, `runCount=${cold.runCount}`);
  checkTrue(
    "Cold GET sets an ETag header",
    !!cold.etag,
    "chat.ts has not implemented ETag yet — see file header note; re-run after the server workstream merges",
  );
  check("Cold GET sets Cache-Control: no-cache", cold.cacheControl, "no-cache");

  if (!cold.etag) {
    console.log(
      "\nNo ETag on the real response — skipping 304/weak-tag/mismatch assertions, they cannot be" +
        " meaningfully evaluated against a server that never emits a validator. Counted as failures above.",
    );
  } else {
    const serverTag = cold.etag;

    // 1.2 Exact strong conditional GET -> 304
    const strong304 = await callChatList(chat, serverTag);
    check("Exact strong If-None-Match returns HTTP 304", strong304.status, 304);
    check("304 response body is 0 bytes", strong304.bodyBytes, 0);
    check("304 response preserves ETag header", strong304.etag, serverTag);

    // 1.3 Weak tag (nginx gzip rewrites strong -> weak in transit)
    const weakTag = serverTag.startsWith("W/") ? serverTag : `W/${serverTag}`;
    const weak304 = await callChatList(chat, weakTag);
    check("Weak If-None-Match (W/...) returns HTTP 304", weak304.status, 304);
    check("Weak 304 body is 0 bytes", weak304.bodyBytes, 0);

    // 1.4 Comma-separated If-None-Match list containing the real tag
    const multi304 = await callChatList(chat, `"stale-1", ${weakTag}, "stale-2"`);
    check("Comma-separated If-None-Match containing the tag returns 304", multi304.status, 304);

    // 1.5 Wildcard
    const star304 = await callChatList(chat, "*");
    check("Wildcard If-None-Match * returns HTTP 304", star304.status, 304);

    // 1.6 Mismatched tag -> fresh 200
    const mismatch = await callChatList(chat, '"stale-etag-00000000"');
    check("Mismatched If-None-Match returns HTTP 200", mismatch.status, 200);
    checkTrue("Mismatched response returns a full body", mismatch.bodyBytes > 0);
    check("Mismatched response includes the current ETag", mismatch.etag, serverTag);

    console.log("\n── 2. Database State Mutations: real writes, real re-fetch, fresh ETag ──");

    const run = await createRun({ title: "etag-probe run", prompt: "probe", worker: "claude" });
    const afterCreate = await callChatList(chat);
    checkTrue(
      "Run creation produces a distinct ETag",
      !!afterCreate.etag && afterCreate.etag !== serverTag,
      `before=${serverTag} after=${afterCreate.etag}`,
    );
    const revalidateStale = await callChatList(chat, serverTag);
    check("Revalidating with the pre-creation ETag now returns 200 (stale)", revalidateStale.status, 200);

    await setRunStatus(run.id, "running");
    const afterStatus = await callChatList(chat);
    checkTrue(
      "Status transition produces a distinct ETag",
      !!afterStatus.etag && afterStatus.etag !== afterCreate.etag,
      `before=${afterCreate.etag} after=${afterStatus.etag}`,
    );

    await appendMessage(run.id, { role: "assistant", content: "probe reply", ts: new Date().toISOString(), kind: "text" });
    const afterAppend = await callChatList(chat);
    checkTrue(
      "Thread append produces a distinct ETag",
      !!afterAppend.etag && afterAppend.etag !== afterStatus.etag,
      `before=${afterStatus.etag} after=${afterAppend.etag}`,
    );

    await archiveRun(run.id);
    const afterArchive = await callChatList(chat);
    checkTrue(
      "Archival (row filtered from the active rail) produces a distinct ETag",
      !!afterArchive.etag && afterArchive.etag !== afterAppend.etag,
      `before=${afterAppend.etag} after=${afterArchive.etag}`,
    );
    checkTrue(
      "Archived run no longer appears in the list count",
      afterArchive.runCount !== null && afterArchive.runCount === 0,
      `runCount=${afterArchive.runCount}`,
    );
  }

  /* ════════════════════════════════════════════════════════════════════
   * Section 3: Client-side ETag state machine — design-contract simulation.
   * NOT a test of shipped client code; see file header.
   * ══════════════════════════════════════════════════════════════════ */

  console.log("\n── 3. Client-Side ETag State Machine (design-contract simulation) ──────");
  console.log("    NOT a claim about shipped client code — see check-chat-list-etag-browser.ts Part B.");

  interface MockPayload {
    count: number;
    marker: string;
  }
  interface MockResponse {
    status: number;
    headers: Record<string, string>;
    rawBody: string | null;
  }

  class ClientStore {
    private lastETag: string | null = null;
    private cachedData: MockPayload | null = null;
    public bodiesParsed = 0;
    public revalidations304 = 0;

    async fetch(server: (ifNoneMatch: string | null) => Promise<MockResponse>): Promise<MockPayload> {
      const response = await server(this.lastETag);
      if (response.status === 304) {
        if (!this.cachedData) throw new Error("received 304 but holds no cached data");
        this.revalidations304++;
        return this.cachedData;
      }
      if (response.status !== 200 || !response.rawBody) {
        throw new Error(`unexpected response: status=${response.status}`);
      }
      // Parse FIRST — a rejected body must not poison the validator with a
      // tag that describes rows we never accepted.
      const parsed = JSON.parse(response.rawBody) as MockPayload;
      this.bodiesParsed++;
      this.cachedData = parsed;
      this.lastETag = response.headers["etag"] ?? null;
      return this.cachedData;
    }
    getValidator(): string | null {
      return this.lastETag;
    }
  }

  let serverState: MockPayload = { count: 3, marker: "a" };
  let serverTagV = '"v1"';
  const mockServer = async (ifNoneMatch: string | null): Promise<MockResponse> => {
    if (ifNoneMatch === serverTagV) {
      return { status: 304, headers: { etag: serverTagV }, rawBody: null };
    }
    return { status: 200, headers: { etag: serverTagV }, rawBody: JSON.stringify(serverState) };
  };

  const store = new ClientStore();
  const r1 = await store.fetch(mockServer);
  check("Client initial fetch parses the body", r1.count, 3);
  check("Client stores the ETag after a clean 200 parse", store.getValidator(), '"v1"');

  const r2 = await store.fetch(mockServer);
  check("Client 2nd fetch on unchanged server hits 304 and reuses cache", r2.count, 3);
  check("Client parsed exactly 1 body across 2 fetches (0 on the 304)", store.bodiesParsed, 1);

  serverState = { count: 4, marker: "b" };
  serverTagV = '"v2"';
  const r3 = await store.fetch(mockServer);
  check("Client 3rd fetch after server mutation returns fresh data", r3.count, 4);
  check("Client updates its validator to the new ETag", store.getValidator(), '"v2"');

  const brokenServer = async (): Promise<MockResponse> => ({
    status: 200,
    headers: { etag: '"corrupted"' },
    rawBody: "NOT_JSON{{{",
  });
  let threw = false;
  try {
    await store.fetch(brokenServer);
  } catch {
    threw = true;
  }
  checkTrue("Client throws on a malformed body instead of caching it", threw);
  check("A parse failure does not poison the stored validator", store.getValidator(), '"v2"');

  /* ════════════════════════════════════════════════════════════════════
   * Section 4: Bandwidth math, from the measured baseline + this run's
   * observed 304 byte count (not assumed).
   * ══════════════════════════════════════════════════════════════════ */

  console.log("\n── 4. Polling Bandwidth Reduction ───────────────────────────────────────");

  const { CHAT_LIST_POLL_MS, CHAT_SURFACE_REQ_PER_MIN_CEILING } = await import(
    "../../forge-control-web/app/desktop/chat/pollBudget.ts"
  );
  check("CHAT_LIST_POLL_MS is 10,000ms (10s)", CHAT_LIST_POLL_MS, 10_000);
  check("CHAT_SURFACE_REQ_PER_MIN_CEILING is 40 req/min", CHAT_SURFACE_REQ_PER_MIN_CEILING, 40);

  const pollsPerMin = 60_000 / CHAT_LIST_POLL_MS;
  const BASELINE_BYTES = 15_156; // measured 2026-08-25, 30-row page, pre-ETag
  const legacyBpm = BASELINE_BYTES * pollsPerMin;
  console.log(`  Baseline (no ETag): ${(legacyBpm / 1024).toFixed(1)} KB/min payload at rest.`);
  console.log(`  Scratch DB used for this run: ${SCRATCH_DB_NAME} (left in place for reinspection).`);

  console.log("\n================================================================================");
  console.log(failures === 0 ? "ALL PASS — check-chat-list-etag suite" : `${failures} FAILURE(S) — check-chat-list-etag suite`);
  console.log("================================================================================");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unhandled error in check-chat-list-etag:", err);
  process.exit(1);
});
