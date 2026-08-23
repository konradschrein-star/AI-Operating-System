/**
 * delete-test.ts — scratch-chat proof for `DELETE /api/chat/:id`.
 *
 * The brief (aios-projects-and-chat, CHAT item 5) requires deletion to be
 * exact: the `runs` row goes, every `knowledge_embeddings` chunk indexed
 * under it goes, and the chat becomes unfindable in search. `deleteRun`
 * (forge-control/src/db/runs.ts) does the removal in one transaction; this
 * script is the end-to-end proof against the live API and the live
 * `content_forge` database, using ONLY a chat this run creates and deletes
 * itself — never one of Konrad's real conversations.
 *
 * The real embedding indexer (`km-indexer.js`) runs on its own schedule and
 * may not have chunked this scratch chat before the script's delete step, so
 * relying on it would let the knowledge_embeddings assertion pass by
 * accident (zero rows because none were ever written, not because delete
 * removed them). This script inserts one synthetic row itself under the
 * exact `chat://<id>` source_path the indexer would use, so the "embeddings
 * are gone" assertion is proving the DELETE FROM knowledge_embeddings path,
 * not the absence of a job run.
 *
 * Run:
 *   cd forge-control-web && ../node_modules/.bin/tsx app/desktop/chat/delete-test.ts
 *   (or ./node_modules/.bin/tsx if tsx is hoisted into this package)
 *
 * Requires DATABASE_URL (content_forge, the same DSN forge-control/src/db/runs.ts
 * falls back to) and FORGE_CONTROL_URL (default http://127.0.0.1:7700) in the
 * environment. Exit 0 = every assertion passed. Anything else is a failure;
 * the thrown error names which assertion and what it saw.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const API_BASE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. This script verifies knowledge_embeddings " +
      "rows directly against content_forge and refuses to guess a DSN.",
  );
}

interface Run {
  id: string;
  title: string;
}

interface RunSummary {
  id: string;
}

function psqlScalar(sql: string): string {
  return execFileSync(
    "psql",
    [DATABASE_URL as string, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function psqlExec(sql: string): void {
  execFileSync("psql", [DATABASE_URL as string, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const marker = `scratch-delete-test-${randomUUID()}`;
  const title = `[SCRATCH] ${marker}`;
  const prompt = `Scratch chat created by delete-test.ts for the CHAT deletion proof. Marker: ${marker}`;

  console.log(`[1/9] creating scratch chat (marker ${marker})`);
  const createRes = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, prompt }),
  });
  assert(createRes.status === 201, `POST /api/chat expected 201, got ${createRes.status}`);
  const created = (await createRes.json()) as { run: Run };
  const runId = created.run.id;
  assert(
    /^[0-9a-f-]{36}$/i.test(runId),
    `created run id does not look like a uuid: ${JSON.stringify(runId)}`,
  );
  console.log(`      run id: ${runId}`);

  console.log("[2/9] GET /api/chat/:id sees the new chat");
  const getRes = await fetch(`${API_BASE}/api/chat/${runId}`);
  assert(getRes.status === 200, `GET /api/chat/${runId} expected 200, got ${getRes.status}`);
  const got = (await getRes.json()) as { run: Run };
  assert(got.run.title === title, `title mismatch: expected ${title}, got ${got.run.title}`);

  console.log("[3/9] search (scope=all) finds the new chat");
  const searchRes = await fetch(
    `${API_BASE}/api/chat/search?q=${encodeURIComponent(marker)}&scope=all`,
  );
  assert(searchRes.status === 200, `GET /api/chat/search expected 200, got ${searchRes.status}`);
  const searched = (await searchRes.json()) as { runs: RunSummary[] };
  assert(
    searched.runs.some((r) => r.id === runId),
    `search for marker did not surface run ${runId}: ${JSON.stringify(searched.runs.map((r) => r.id))}`,
  );

  console.log("[4/9] inserting a synthetic knowledge_embeddings row under chat://<id>");
  const sourcePath = `chat://${runId}`;
  const escapedSourcePath = sourcePath.replace(/'/g, "''");
  const escapedTitle = title.replace(/'/g, "''");
  psqlExec(
    `INSERT INTO knowledge_embeddings (source_path, title, content) ` +
      `VALUES ('${escapedSourcePath}', '${escapedTitle}', 'scratch delete-test content')`,
  );

  console.log("[5/9] confirming the embeddings row landed");
  const embeddingsBefore = Number(
    psqlScalar(
      `SELECT count(*) FROM knowledge_embeddings WHERE source_path = '${escapedSourcePath}'`,
    ),
  );
  assert(
    embeddingsBefore >= 1,
    `expected >=1 knowledge_embeddings row for ${sourcePath} before delete, got ${embeddingsBefore}`,
  );

  console.log(`[6/9] DELETE /api/chat/${runId}`);
  const deleteRes = await fetch(`${API_BASE}/api/chat/${runId}`, { method: "DELETE" });
  assert(deleteRes.status === 200, `DELETE /api/chat/${runId} expected 200, got ${deleteRes.status}`);
  const deleted = (await deleteRes.json()) as { deleted: boolean; embeddings_deleted: number };
  assert(deleted.deleted === true, `delete response did not report deleted:true: ${JSON.stringify(deleted)}`);
  assert(
    deleted.embeddings_deleted >= embeddingsBefore,
    `delete response reported embeddings_deleted=${deleted.embeddings_deleted}, expected >=${embeddingsBefore}`,
  );

  console.log("[7/9] GET /api/chat/:id now 404s");
  const getAfter = await fetch(`${API_BASE}/api/chat/${runId}`);
  assert(getAfter.status === 404, `GET /api/chat/${runId} after delete expected 404, got ${getAfter.status}`);

  console.log("[8/9] search (scope=all) no longer finds the deleted chat");
  const searchAfter = await fetch(
    `${API_BASE}/api/chat/search?q=${encodeURIComponent(marker)}&scope=all`,
  );
  const searchedAfter = (await searchAfter.json()) as { runs: RunSummary[] };
  assert(
    !searchedAfter.runs.some((r) => r.id === runId),
    `search still surfaces deleted run ${runId} after delete`,
  );

  console.log("[9/9] zero rows remain in runs and knowledge_embeddings");
  const runsRemaining = Number(psqlScalar(`SELECT count(*) FROM runs WHERE id = '${runId}'`));
  assert(runsRemaining === 0, `expected 0 rows in runs for ${runId}, found ${runsRemaining}`);
  const embeddingsRemaining = Number(
    psqlScalar(
      `SELECT count(*) FROM knowledge_embeddings WHERE source_path = '${escapedSourcePath}'`,
    ),
  );
  assert(
    embeddingsRemaining === 0,
    `expected 0 rows in knowledge_embeddings for ${sourcePath}, found ${embeddingsRemaining}`,
  );

  console.log("PASS: scratch chat created, searchable, deleted, and unrecoverable in runs + knowledge_embeddings.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
