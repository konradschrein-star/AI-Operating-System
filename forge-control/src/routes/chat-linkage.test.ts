/**
 * Tests for the backfill ledger of chat-linkage.ts — the audit record that
 * used to live at `docs/plan/artifacts/phase300/backfill.log`, INSIDE the git
 * tree, and therefore dirtied the live checkout as normal engine operation.
 *
 * Run: npx tsx --test src/routes/chat-linkage.test.ts
 *
 * What is pinned here:
 *  - The default destination is out of tree (`/var/log/forge/…`), asserted in a
 *    SUBPROCESS with FORGE_BACKFILL_LOG deleted — never on the resolved value
 *    of the imported constant, which is env-dependent and would red the fleet's
 *    shared suite for anyone who has the override set.
 *  - FORGE_BACKFILL_LOG overrides it, in-process and in a subprocess.
 *  - The REAL `backfillOriginChatId` — not a re-implementation of its write
 *    block — creates the parent directory tree, appends the formatted line,
 *    appends rather than truncates, writes nothing when the SQL is a no-op, and
 *    survives an unwritable destination without throwing.
 *  - The pure linkage helpers still behave.
 *
 * Nothing in this file touches a database. See "THE PG SEAM" below before
 * adding an import.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = fileURLToPath(new URL("./chat-linkage.ts", import.meta.url));
const PACKAGE_ROOT = path.resolve(path.dirname(SOURCE_PATH), "../..");
const CHAT_LINKAGE_SRC = readFileSync(SOURCE_PATH, "utf8");

/** The destination the engine must use when nothing overrides it. */
const DEFAULT_BACKFILL_LOG = "/var/log/forge/chat-linkage-backfill.log";

/* ------------------------------------------------------------------------- *
 * THE LOAD-TIME ENV — `BACKFILL_LOG` is a module constant, resolved ONCE when
 * chat-linkage.ts is first evaluated. The override must therefore be set here,
 * above the dynamic import below, not inside a test. Every case that drives the
 * real write path shares this one path and clears it first.
 * ------------------------------------------------------------------------- */
const TMP_ROOT = path.resolve(`/tmp/forge-chat-linkage-test-${process.pid}`);
const TMP_LOG = path.join(TMP_ROOT, "nested", "sub", "audit.log");
rmSync(TMP_ROOT, { recursive: true, force: true });
process.env.FORGE_BACKFILL_LOG = TMP_LOG;

/* ------------------------------------------------------------------------- *
 * THE PG SEAM — read this before adding a static import to this file
 *
 * `chat-linkage.ts` constructs `new Pool(...)` at MODULE SCOPE. `pg` is
 * CommonJS, so `import pg from "pg"` hands every consumer the same
 * `module.exports` object and each module destructures `Pool` off it at ITS
 * load time — replacing `pg.Pool` before the first `import()` gives the module
 * a fake with no injection parameter added to production code.
 *
 * The import of chat-linkage.ts is therefore DYNAMIC and lives below the swap.
 * A static `import … from "./chat-linkage.ts"` is hoisted above all top-level
 * code by the ESM loader, so it would bind the REAL pool — and the module
 * defaults DATABASE_URL to the live `content_forge`, which authenticates from a
 * worker shell. The fake below THROWS on an unrouted statement rather than
 * answering `{rows: []}`, so a lost query is a failure, not a tautology.
 * ------------------------------------------------------------------------- */

interface FakeQuery {
  sql: string;
  params: unknown[];
}

/** Statements the fake pool saw, in order. Cleared per test. */
const seenQueries: FakeQuery[] = [];

/** What the fake pool answers next, keyed by a distinctive SQL fragment.
 *  Reassigned per test; never merged, so one test cannot inherit another's
 *  fixture. `rowCount` is explicit because the backfill UPDATE returns no rows
 *  and decides everything on the count. */
let queryResponses: Array<{ match: RegExp; rows: Record<string, unknown>[]; rowCount: number }> = [];

class FakePgPool {
  constructor(_config: unknown) {}
  on(_event: string, _handler: unknown): this {
    return this;
  }
  async query(sql: string, params?: unknown[]) {
    seenQueries.push({ sql, params: params ?? [] });
    const hit = queryResponses.find((r) => r.match.test(sql));
    if (!hit) {
      throw new Error(
        `chat-linkage.test: the module issued a query this fake has no answer for.\n` +
          `SQL: ${sql.replace(/\s+/g, " ").trim().slice(0, 240)}\n` +
          `params: ${JSON.stringify(params)}`,
      );
    }
    return { rows: hit.rows, rowCount: hit.rowCount, command: "", oid: 0, fields: [] };
  }
  async end() {}
}

const pgModule = (await import("pg")).default as unknown as { Pool: unknown };
const realPool = pgModule.Pool;
pgModule.Pool = FakePgPool;
const {
  BACKFILL_LOG,
  backfillOriginChatId,
  statusRank,
  rankCandidates,
  isProjectCreateCall,
  scanThreadForProjectIds,
} = await import("./chat-linkage.ts");
pgModule.Pool = realPool; // restore, so a later import in this process is unaffected

/** Run a throwaway process that prints the module's resolved BACKFILL_LOG.
 *  `env` is built explicitly so the caller decides whether the override exists
 *  at all — this process has it set. */
function backfillLogIn(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import { BACKFILL_LOG } from "./src/routes/chat-linkage.ts"; console.log(BACKFILL_LOG);`,
    ],
    { cwd: PACKAGE_ROOT, env, encoding: "utf8" },
  ).trim();
}

/** This process's env with FORGE_BACKFILL_LOG removed entirely. */
function envWithoutOverride(): NodeJS.ProcessEnv {
  const { FORGE_BACKFILL_LOG: _dropped, ...rest } = process.env;
  return rest;
}

/** A successful backfill UPDATE: no rows returned, exactly one row changed. */
function respondToBackfillUpdate(rowCount: number): void {
  queryResponses = [{ match: /UPDATE\s+projects/i, rows: [], rowCount }];
  seenQueries.length = 0;
}

describe("chat-linkage — the default ledger destination is out of the git tree", () => {
  test("with FORGE_BACKFILL_LOG unset, BACKFILL_LOG is /var/log/forge/chat-linkage-backfill.log", () => {
    // Measured in a subprocess with the variable DELETED. Asserting the
    // imported constant instead would fail for anyone who has the override
    // exported — and gate 30 runs this file for the whole fleet.
    assert.equal(backfillLogIn(envWithoutOverride()), DEFAULT_BACKFILL_LOG);
  });

  test("the default is not inside the repository", () => {
    const resolved = backfillLogIn(envWithoutOverride());
    assert.ok(
      resolved.startsWith("/var/log/"),
      `the default ledger must live under /var/log, got: ${resolved}`,
    );
    assert.ok(
      !resolved.includes("docs/plan"),
      `the default ledger must not point inside docs/plan, got: ${resolved}`,
    );
  });

  test("source inspection: BACKFILL_LOG reads FORGE_BACKFILL_LOG with the out-of-tree default", () => {
    assert.match(
      CHAT_LINKAGE_SRC,
      /process\.env\.FORGE_BACKFILL_LOG\s*(\?\?|\|\|)\s*["']\/var\/log\/forge\/chat-linkage-backfill\.log["']/,
      "BACKFILL_LOG must be configured with FORGE_BACKFILL_LOG falling back to /var/log/forge/chat-linkage-backfill.log",
    );
    assert.doesNotMatch(
      CHAT_LINKAGE_SRC,
      /path\.join\(\s*REPO_ROOT,\s*["']docs\/plan\/artifacts\/phase300\/backfill\.log["']\s*\)/,
      "BACKFILL_LOG must not join REPO_ROOT with the in-tree docs/plan/artifacts/phase300/backfill.log",
    );
  });

  test("source inspection: the REPO_ROOT derivation is gone", () => {
    assert.doesNotMatch(
      CHAT_LINKAGE_SRC,
      /const REPO_ROOT =/,
      "REPO_ROOT existed only to build the in-tree backfill.log path",
    );
  });
});

describe("chat-linkage — FORGE_BACKFILL_LOG override", () => {
  test("the module honours the override this process set before importing it", () => {
    assert.equal(BACKFILL_LOG, TMP_LOG);
  });

  test("a subprocess honours an override it is given", () => {
    const customPath = `/tmp/test-custom-backfill-${process.pid}.log`;
    assert.equal(
      backfillLogIn({ ...process.env, FORGE_BACKFILL_LOG: customPath }),
      customPath,
    );
  });
});

describe("chat-linkage — backfillOriginChatId writes the ledger, out of tree", () => {
  const chatId = "c1a2b3c4-d5e6-4789-a012-3456789abcde";
  const projectId = "9f8e7d6c-5b4a-4321-8765-43210fedcba9";

  test("creates the parent directory tree and appends one formatted line", async () => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.ok(!existsSync(path.dirname(TMP_LOG)), "precondition: the ledger directory must be absent");
    respondToBackfillUpdate(1);

    await backfillOriginChatId(chatId, projectId);

    assert.ok(existsSync(TMP_LOG), `the real write path must create ${TMP_LOG}, directories and all`);
    const content = await readFile(TMP_LOG, "utf8");
    assert.match(
      content,
      new RegExp(
        `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z backfill origin_chat_id chat=${chatId} project=${projectId}\\n$`,
      ),
      `unexpected ledger content: ${JSON.stringify(content)}`,
    );

    // The statement that ran is the idempotent one, with both ids bound.
    assert.equal(seenQueries.length, 1);
    assert.deepEqual(seenQueries[0]!.params, [chatId, projectId]);
    assert.match(seenQueries[0]!.sql, /NOT \(metadata \? 'origin_chat_id'\)/);
  });

  test("a second write appends rather than truncating", async () => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    respondToBackfillUpdate(1);

    await backfillOriginChatId(chatId, projectId);
    await backfillOriginChatId(chatId, "11111111-2222-4333-8444-555555555555");

    const lines = (await readFile(TMP_LOG, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2, `expected two ledger lines, got: ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, new RegExp(`project=${projectId}$`));
    assert.match(lines[1]!, /project=11111111-2222-4333-8444-555555555555$/);
  });

  test("an already-linked project writes no ledger line at all", async () => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    respondToBackfillUpdate(0); // UPDATE matched nothing — origin_chat_id already set

    await backfillOriginChatId(chatId, projectId);

    assert.ok(
      !existsSync(TMP_LOG),
      "a no-op UPDATE must not append to the ledger — the log is the list the rollback line consumes",
    );
  });

  test("a database failure is NOT swallowed — only the ledger append is", async () => {
    // Proves the fake can fail: with an empty routing table the UPDATE throws,
    // and backfillOriginChatId propagates it. Without this, every assertion
    // above could be passing on a pool that answers nothing to everything.
    queryResponses = [];
    seenQueries.length = 0;
    await assert.rejects(
      () => backfillOriginChatId(chatId, projectId),
      /no answer for/,
      "a failing UPDATE must reject; the try/catch covers the file write only",
    );
  });
});

describe("chat-linkage — an unwritable ledger cannot break a resolved link", () => {
  test("append failure is caught, logged to console.error, and does not throw", () => {
    // The real function, in a subprocess, pointed at a path whose mkdir cannot
    // succeed (`/dev/null` is a device node, so ENOTDIR). It must still
    // resolve: the database row is already written and failing the caller's
    // read would misreport a resolved link as a server error.
    const failingLogPath = "/dev/null/impossible-directory/backfill.log";
    const driver = `
      import("pg")
        .then((pg) => {
          pg.default.Pool = class {
            on() { return this; }
            async query() { return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] }; }
          };
          return import("./src/routes/chat-linkage.ts");
        })
        .then((mod) => mod.backfillOriginChatId("c1", "p1"))
        .then(() => console.log("RESOLVED_WITHOUT_THROWING"));
    `;
    const run = spawnSync(process.execPath, ["--import", "tsx", "-e", driver], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, FORGE_BACKFILL_LOG: failingLogPath },
      encoding: "utf8",
    });

    assert.equal(run.status, 0, `the driver exited ${run.status}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /RESOLVED_WITHOUT_THROWING/);
    assert.match(
      run.stderr,
      new RegExp(`\\[chat-linkage\\] backfill\\.log append failed \\(${failingLogPath}\\):`),
      `expected a loud console.error naming the destination, got stderr:\n${run.stderr}`,
    );
  });

  test("source inspection: the write block is mkdir-then-append inside try/catch", () => {
    const start = CHAT_LINKAGE_SRC.indexOf("async function backfillOriginChatId");
    assert.ok(start >= 0, "backfillOriginChatId not found in source");
    const fnSrc = CHAT_LINKAGE_SRC.slice(start, start + 1200);

    assert.match(
      fnSrc,
      /try\s*\{\s*await\s+mkdir\(path\.dirname\(BACKFILL_LOG\),\s*\{\s*recursive:\s*true\s*\}\);\s*await\s+appendFile\(BACKFILL_LOG,\s*`\$\{line\}\\n`,\s*["']utf8["']\);/,
      "backfillOriginChatId must await a recursive mkdir before appendFile, inside the try block",
    );
    assert.match(
      fnSrc,
      /catch\s*\(\s*e\s*\)\s*\{[\s\S]*?console\.error\(\s*`\[chat-linkage\] backfill\.log append failed \(\$\{BACKFILL_LOG\}\):`,\s*e instanceof Error \? e\.message : e,?\s*\);?\s*\}/,
      "backfillOriginChatId must catch and log append failures without throwing",
    );
  });
});

describe("chat-linkage — candidate ranking & status priority", () => {
  test("statusRank maps statuses to appropriate tiers", () => {
    assert.equal(statusRank("active"), 0);
    assert.equal(statusRank("running"), 0);
    assert.equal(statusRank("planning"), 1);
    assert.equal(statusRank("paused"), 2);
    assert.equal(statusRank("blocked"), 2);
    assert.equal(statusRank("completed"), 3);
    assert.equal(statusRank("done"), 3);
    assert.equal(statusRank("failed"), 4);
    assert.equal(statusRank("cancelled"), 4);
    assert.equal(statusRank("archived"), 5);
    assert.equal(statusRank("unrecognised_status"), 2);
  });

  test("rankCandidates orders running before paused before completed", () => {
    const rows = [
      { id: "p-done", name: "Done Project", status: "done" },
      { id: "p-paused", name: "Paused Project", status: "paused" },
      { id: "p-active", name: "Active Project", status: "active" },
    ];
    const ranked = rankCandidates(rows);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ["p-active", "p-paused", "p-done"],
    );
  });
});

describe("chat-linkage — thread scanning bounds", () => {
  test("isProjectCreateCall identifies valid creation endpoints with POST method", () => {
    assert.ok(isProjectCreateCall("curl -X POST http://127.0.0.1:7700/api/projects -d '...'"));
    assert.ok(isProjectCreateCall("POST /api/projects"));
    assert.ok(!isProjectCreateCall("GET /api/projects"));
    assert.ok(!isProjectCreateCall("POST /api/projects/123/tasks"));
    assert.ok(!isProjectCreateCall("POST /api/projects/board"));
  });

  test("scanThreadForProjectIds extracts project uuid following create call", () => {
    const projUuid = "12345678-1234-4234-8234-123456789abc";
    const thread = [
      {
        kind: "tool_call",
        content: "curl -X POST http://127.0.0.1:7700/api/projects -d '{\"name\":\"test\"}'",
      },
      {
        kind: "tool_result",
        content: `{"project":{"id":"${projUuid}","name":"test"}}`,
      },
    ];

    const result = scanThreadForProjectIds(thread);
    assert.deepEqual(result, [projUuid]);
  });
});
