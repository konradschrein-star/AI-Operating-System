/**
 * delete-test.ts — scratch-chat proof for `DELETE /api/chat/:id`.
 *
 * The brief (aios-projects-and-chat, CHAT item 5) requires deletion to be
 * exact: the `runs` row goes, every `knowledge_embeddings` chunk indexed
 * under it goes, and the chat becomes unfindable in search. `deleteRun`
 * (forge-control/src/db/runs.ts) does the removal in one transaction; this
 * script is the end-to-end proof against a running forge-control and its
 * database, using ONLY chats this run creates and deletes itself — never one
 * of Konrad's real conversations.
 *
 * ## Why this script now builds a TREE, not a single chat
 *
 * Rounds 3 and 5 both passed the delete, because round 2's proof used a
 * CHILDLESS scratch run. `runs_parent_run_id_fkey` is ON DELETE SET NULL, so
 * a chat with sub-runs behaves completely differently from one without:
 * deleting the parent used to PROMOTE its workers into top-level rows that
 * `listRuns` then shows as brand-new chats, thread intact, embeddings still
 * searchable. A childless run cannot exercise a single line of that. So the
 * fixture here is a parent, two workers, and a worker's own subagent — three
 * levels — plus a `project_tasks` row pointing at the parent, because that FK
 * is SET NULL too and the card must SURVIVE with its link cut.
 *
 * The real embedding indexer (`km-indexer.js`) runs on its own schedule and
 * may not have chunked these scratch chats before the delete step, so relying
 * on it would let the knowledge_embeddings assertion pass by accident (zero
 * rows because none were ever written, not because delete removed them). This
 * script inserts the rows itself under the exact `chat://<id>` source_path the
 * indexer would use — one per run in the tree — so the "embeddings are gone"
 * assertion is proving the DELETE FROM knowledge_embeddings path, not the
 * absence of a job run.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx app/desktop/chat/delete-test.ts
 *
 * Requires DATABASE_URL and FORGE_CONTROL_URL (default http://127.0.0.1:7700)
 * in the environment, and they MUST describe the same server:
 *
 *   DATABASE_URL=<scratch dsn> FORGE_CONTROL_URL=http://127.0.0.1:<probe port> \
 *     ../forge-control/node_modules/.bin/tsx app/desktop/chat/delete-test.ts
 *
 * From a BUILD task point both at a scratch database and a throwaway probe
 * that mounts only the chat router. Exit 0 = every assertion passed. Anything
 * else is a failure; the thrown error names which assertion and what it saw.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const API_BASE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. This script verifies knowledge_embeddings " +
      "rows directly against the database and refuses to guess a DSN.",
  );
}

interface Run {
  id: string;
  title: string;
}

interface RunSummary {
  id: string;
}

interface TreeMember {
  id: string;
  title: string;
  status: string;
  depth: number;
}

interface DeletePreview {
  run: TreeMember;
  descendants: TreeMember[];
  descendant_count: number;
  runs_to_delete: number;
  embeddings: number;
  linked_tasks: number;
  running: TreeMember[];
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

/** Single-quote a literal for the psql -c statements above. Every value this
 *  script interpolates is a uuid or a marker it generated itself, but the
 *  escape is not optional on principle: a helper that only sometimes escapes
 *  is the one that gets reused with a title next time. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Insert a sub-run directly. `POST /api/chat` has no parent_run_id argument —
 *  worker runs are spawned by the executor, not by a person — so the fixture
 *  is built in SQL. These are scratch rows in a scratch database. */
function insertSubRun(
  parentId: string,
  marker: string,
  label: string,
  status = "completed",
): string {
  const id = randomUUID();
  psqlExec(
    `INSERT INTO runs (id, title, prompt, status, parent_run_id, worker) VALUES (` +
      `${lit(id)}::uuid, ${lit(`[SCRATCH] ${label} ${marker}`)}, ` +
      `${lit(`Scratch sub-run ${label}. Marker: ${marker}`)}, ${lit(status)}, ` +
      `${lit(parentId)}::uuid, 'builder')`,
  );
  return id;
}

function insertEmbedding(runId: string, marker: string, chunk: number): void {
  psqlExec(
    `INSERT INTO knowledge_embeddings (source_path, title, chunk_index, content) VALUES (` +
      `${lit(`chat://${runId}`)}, ${lit(`[SCRATCH] ${marker}`)}, ${chunk}, ` +
      `${lit(`scratch delete-test content ${marker} chunk ${chunk}`)})`,
  );
}

function countEmbeddings(ids: string[]): number {
  const list = ids.map((i) => lit(`chat://${i}`)).join(",");
  return Number(
    psqlScalar(`SELECT count(*) FROM knowledge_embeddings WHERE source_path IN (${list})`),
  );
}

function countRuns(ids: string[]): number {
  const list = ids.map((i) => `${lit(i)}::uuid`).join(",");
  return Number(psqlScalar(`SELECT count(*) FROM runs WHERE id IN (${list})`));
}

async function main(): Promise<void> {
  const marker = `scratch-delete-test-${randomUUID()}`;
  const title = `[SCRATCH] ${marker}`;
  const prompt = `Scratch chat created by delete-test.ts for the CHAT deletion proof. Marker: ${marker}`;

  console.log(`[1/14] creating scratch parent chat (marker ${marker})`);
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
  console.log(`      parent run id: ${runId}`);

  console.log("[2/14] attaching two worker sub-runs and one subagent (depth 2)");
  const workerA = insertSubRun(runId, marker, "worker-a");
  const workerB = insertSubRun(runId, marker, "worker-b");
  const subagent = insertSubRun(workerA, marker, "subagent-of-a");
  const tree = [runId, workerA, workerB, subagent];
  console.log(`      ${workerA} / ${workerB} / ${subagent}`);

  console.log("[3/14] the sub-runs are NOT on the rail while the parent lives");
  const listBefore = (await (await fetch(`${API_BASE}/api/chat?limit=200`)).json()) as {
    runs: RunSummary[];
  };
  const railBefore = new Set(listBefore.runs.map((r) => r.id));
  for (const child of [workerA, workerB, subagent]) {
    assert(
      !railBefore.has(child),
      `sub-run ${child} is on the rail before the delete — the fixture is wrong, ` +
        `not the code (listRuns filters parent_run_id IS NULL)`,
    );
  }

  console.log("[4/14] inserting knowledge_embeddings rows under each run in the tree");
  insertEmbedding(runId, marker, 0);
  insertEmbedding(runId, marker, 1);
  insertEmbedding(workerA, marker, 0);
  insertEmbedding(workerB, marker, 0);
  insertEmbedding(subagent, marker, 0);
  const embeddingsBefore = countEmbeddings(tree);
  assert(
    embeddingsBefore === 5,
    `expected 5 knowledge_embeddings rows across the tree before delete, got ${embeddingsBefore}`,
  );

  console.log("[5/14] linking a project_tasks row to the parent (the FK that must SURVIVE)");
  const projectId = randomUUID();
  const taskId = randomUUID();
  psqlExec(
    `INSERT INTO projects (id, name, brief, repo, base_branch, status) VALUES (` +
      `${lit(projectId)}::uuid, ${lit(`[SCRATCH] ${marker}`)}, 'scratch', 'ai-os', 'main', 'active')`,
  );
  psqlExec(
    `INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, run_id) VALUES (` +
      `${lit(taskId)}::uuid, ${lit(projectId)}::uuid, 1, 'builder', ${lit(`[SCRATCH] ${marker}`)}, ` +
      `'scratch', 'done', ${lit(runId)}::uuid)`,
  );

  console.log("[6/14] GET /api/chat/:id sees the new chat");
  const getRes = await fetch(`${API_BASE}/api/chat/${runId}`);
  assert(getRes.status === 200, `GET /api/chat/${runId} expected 200, got ${getRes.status}`);
  const got = (await getRes.json()) as { run: Run };
  assert(got.run.title === title, `title mismatch: expected ${title}, got ${got.run.title}`);

  console.log("[7/14] search (scope=all) finds the parent AND reaches into sub-runs");
  const searchRes = await fetch(
    `${API_BASE}/api/chat/search?q=${encodeURIComponent(marker)}&scope=all`,
  );
  assert(searchRes.status === 200, `GET /api/chat/search expected 200, got ${searchRes.status}`);
  const searched = (await searchRes.json()) as { runs: RunSummary[] };
  const foundAll = new Set(searched.runs.map((r) => r.id));
  assert(foundAll.has(runId), `scope=all did not surface parent ${runId}`);
  assert(
    foundAll.has(workerA) && foundAll.has(workerB) && foundAll.has(subagent),
    `scope=all must reach worker threads; got ${JSON.stringify([...foundAll])}`,
  );

  console.log("[8/14] search (scope=open) returns ONLY rail chats — no sub-runs");
  const openRes = await fetch(
    `${API_BASE}/api/chat/search?q=${encodeURIComponent(marker)}&scope=open`,
  );
  const opened = (await openRes.json()) as { runs: RunSummary[] };
  const foundOpen = new Set(opened.runs.map((r) => r.id));
  assert(foundOpen.has(runId), `scope=open lost the parent ${runId}, which IS on the rail`);
  for (const child of [workerA, workerB, subagent]) {
    assert(
      !foundOpen.has(child),
      `scope=open returned sub-run ${child}, which is nowhere on the rail — ` +
        `this is the round-7 finding (parent_run_id IS NULL missing from the "open" arm)`,
    );
  }

  console.log("[9/14] delete-preview names the whole tree, exactly");
  const previewRes = await fetch(`${API_BASE}/api/chat/${runId}/delete-preview`);
  assert(previewRes.status === 200, `delete-preview expected 200, got ${previewRes.status}`);
  const preview = (await previewRes.json()) as DeletePreview;
  assert(
    preview.runs_to_delete === 4,
    `preview says ${preview.runs_to_delete} runs, expected 4 (parent + 2 workers + 1 subagent)`,
  );
  assert(
    preview.descendant_count === 3,
    `preview says ${preview.descendant_count} descendants, expected 3`,
  );
  assert(
    preview.embeddings === embeddingsBefore,
    `preview says ${preview.embeddings} embeddings, database holds ${embeddingsBefore}`,
  );
  assert(
    preview.linked_tasks === 1,
    `preview says ${preview.linked_tasks} linked tasks, expected 1`,
  );
  const depths = preview.descendants.map((d) => d.depth).sort();
  assert(
    JSON.stringify(depths) === JSON.stringify([1, 1, 2]),
    `preview descendant depths ${JSON.stringify(depths)}, expected [1,1,2] — ` +
      `depth 2 missing means the walk is not recursive`,
  );

  console.log("[10/14] a RUNNING sub-run makes the delete refuse with 409, deleting nothing");
  psqlExec(`UPDATE runs SET status = 'running' WHERE id = ${lit(workerB)}::uuid`);
  const refusedRes = await fetch(`${API_BASE}/api/chat/${runId}`, { method: "DELETE" });
  assert(refusedRes.status === 409, `expected 409 while a sub-run runs, got ${refusedRes.status}`);
  const refused = (await refusedRes.json()) as { running: { id: string }[] };
  assert(
    refused.running.some((r) => r.id === workerB),
    `409 body did not name the running sub-run: ${JSON.stringify(refused)}`,
  );
  assert(
    countRuns(tree) === 4,
    `the refused delete removed rows anyway — ${countRuns(tree)} of 4 remain`,
  );
  psqlExec(`UPDATE runs SET status = 'completed' WHERE id = ${lit(workerB)}::uuid`);

  console.log(`[11/14] DELETE /api/chat/${runId}`);
  const deleteRes = await fetch(`${API_BASE}/api/chat/${runId}`, { method: "DELETE" });
  assert(deleteRes.status === 200, `DELETE /api/chat/${runId} expected 200, got ${deleteRes.status}`);
  const deleted = (await deleteRes.json()) as {
    deleted: boolean;
    runs_deleted: number;
    descendant_ids: string[];
    embeddings_deleted: number;
    tasks_unlinked: number;
  };
  assert(deleted.deleted === true, `delete response did not report deleted:true: ${JSON.stringify(deleted)}`);
  assert(
    deleted.runs_deleted === 4,
    `delete reported runs_deleted=${deleted.runs_deleted}, expected 4`,
  );
  assert(
    deleted.descendant_ids.length === 3,
    `delete reported ${deleted.descendant_ids.length} descendant ids, expected 3`,
  );
  assert(
    deleted.embeddings_deleted === embeddingsBefore,
    `delete reported embeddings_deleted=${deleted.embeddings_deleted}, expected ${embeddingsBefore}`,
  );
  assert(
    deleted.tasks_unlinked === 1,
    `delete reported tasks_unlinked=${deleted.tasks_unlinked}, expected 1`,
  );

  console.log("[12/14] every run in the tree is gone — nothing was promoted onto the rail");
  const runsRemaining = countRuns(tree);
  assert(runsRemaining === 0, `expected 0 rows in runs for the tree, found ${runsRemaining}`);
  const listAfter = (await (await fetch(`${API_BASE}/api/chat?limit=200`)).json()) as {
    runs: RunSummary[];
  };
  const railAfter = new Set(listAfter.runs.map((r) => r.id));
  for (const gone of tree) {
    assert(
      !railAfter.has(gone),
      `deleted run ${gone} is ON THE RAIL after the delete — this is the SET NULL promotion`,
    );
  }
  const orphans = Number(
    psqlScalar(
      `SELECT count(*) FROM runs WHERE title LIKE ${lit(`%${marker}%`)} ` +
        `AND parent_run_id IS NULL`,
    ),
  );
  assert(orphans === 0, `${orphans} scratch run(s) survived as orphaned top-level rows`);

  console.log("[13/14] the search trail is gone in both scopes");
  const embeddingsRemaining = countEmbeddings(tree);
  assert(
    embeddingsRemaining === 0,
    `expected 0 rows in knowledge_embeddings for the tree, found ${embeddingsRemaining}`,
  );
  for (const scope of ["all", "open"]) {
    const after = (await (
      await fetch(`${API_BASE}/api/chat/search?q=${encodeURIComponent(marker)}&scope=${scope}`)
    ).json()) as { runs: RunSummary[] };
    assert(
      after.runs.length === 0,
      `search scope=${scope} still surfaces ${after.runs.length} deleted run(s)`,
    );
  }
  const previewAfter = await fetch(`${API_BASE}/api/chat/${runId}/delete-preview`);
  assert(
    previewAfter.status === 404,
    `delete-preview for a deleted run expected 404, got ${previewAfter.status}`,
  );

  console.log("[14/14] the project task SURVIVED with its run link cut, as disclosed");
  const taskRunId = psqlScalar(
    `SELECT coalesce(run_id::text, 'NULL') FROM project_tasks WHERE id = ${lit(taskId)}::uuid`,
  );
  assert(
    taskRunId === "NULL",
    `project_tasks.run_id should be NULL after the delete, got ${taskRunId}`,
  );
  const taskStillThere = Number(
    psqlScalar(`SELECT count(*) FROM project_tasks WHERE id = ${lit(taskId)}::uuid`),
  );
  assert(taskStillThere === 1, `the Kanban card was DELETED — it must survive the chat`);

  console.log(
    "PASS: parent + 2 workers + 1 subagent created, previewed exactly, refused while running, " +
      "deleted whole, unrecoverable in runs / knowledge_embeddings / search, no orphan promoted, " +
      "linked project task kept with a null run_id.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
