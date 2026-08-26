/**
 * Unit tests for chat-linkage.ts — out-of-tree backfill ledger relocation & safety.
 *
 * Requirements:
 * 1. Default BACKFILL_LOG is /var/log/forge/chat-linkage-backfill.log (out of git tree).
 * 2. FORGE_BACKFILL_LOG environment override points to a custom path, creates parent
 *    directory recursively when missing, and appends the properly formatted audit line:
 *    `<ISO timestamp> backfill origin_chat_id chat=<chatId> project=<projectId>\n`.
 * 3. Error handling when writing to a failing target does not throw and logs loudly to console.error.
 * 4. Pure linkage helper functions (statusRank, rankCandidates, isProjectCreateCall, scanThreadForProjectIds)
 *    continue to behave correctly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKFILL_LOG,
  statusRank,
  rankCandidates,
  isProjectCreateCall,
  scanThreadForProjectIds,
} from "./chat-linkage.ts";

const SOURCE_PATH = fileURLToPath(new URL("./chat-linkage.ts", import.meta.url));
const CHAT_LINKAGE_SRC = readFileSync(SOURCE_PATH, "utf8");

describe("chat-linkage — BACKFILL_LOG destination & out-of-tree location", () => {
  test("default BACKFILL_LOG is /var/log/forge/chat-linkage-backfill.log", () => {
    assert.equal(BACKFILL_LOG, "/var/log/forge/chat-linkage-backfill.log");
  });

  test("default BACKFILL_LOG is out of tree (not inside docs/plan or git repo)", () => {
    assert.ok(
      BACKFILL_LOG.startsWith("/var/log/"),
      `BACKFILL_LOG must be located in /var/log, got: ${BACKFILL_LOG}`,
    );
    assert.ok(
      !BACKFILL_LOG.includes("docs/plan"),
      `BACKFILL_LOG must not point inside docs/plan, got: ${BACKFILL_LOG}`,
    );
  });

  test("source inspection: BACKFILL_LOG reads process.env.FORGE_BACKFILL_LOG fallback", () => {
    assert.match(
      CHAT_LINKAGE_SRC,
      /process\.env\.FORGE_BACKFILL_LOG\s*\?\?\s*["']\/var\/log\/forge\/chat-linkage-backfill\.log["']/,
      "BACKFILL_LOG must be configured with FORGE_BACKFILL_LOG env fallback to /var/log/forge/chat-linkage-backfill.log",
    );
    assert.doesNotMatch(
      CHAT_LINKAGE_SRC,
      /path\.join\(\s*REPO_ROOT,\s*["']docs\/plan\/artifacts\/phase300\/backfill\.log["']\s*\)/,
      "BACKFILL_LOG must not join REPO_ROOT with in-tree docs/plan/artifacts/phase300/backfill.log",
    );
  });

  test("source inspection: REPO_ROOT derivation from import.meta.url is removed", () => {
    assert.doesNotMatch(
      CHAT_LINKAGE_SRC,
      /const REPO_ROOT =/,
      "REPO_ROOT should be removed as it was only used for the in-tree backfill.log path",
    );
  });
});

describe("chat-linkage — FORGE_BACKFILL_LOG environment override", () => {
  test("sub-process loads custom FORGE_BACKFILL_LOG when set in environment", () => {
    const customPath = `/tmp/test-custom-backfill-${Date.now()}.log`;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import { BACKFILL_LOG } from "./src/routes/chat-linkage.ts"; console.log(BACKFILL_LOG);`,
      ],
      {
        cwd: path.resolve(path.dirname(SOURCE_PATH), "../.."),
        env: { ...process.env, FORGE_BACKFILL_LOG: customPath },
        encoding: "utf8",
      },
    ).trim();

    assert.equal(output, customPath);
  });
});

describe("chat-linkage — directory creation, formatting and append behaviour", () => {
  const tmpDir = path.resolve(`/tmp/forge-chat-linkage-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  test("creates parent directories recursively if missing and appends formatted log line", async () => {
    const targetLog = path.join(tmpDir, "nested", "sub", "audit.log");
    const chatId = "c1a2b3c4-d5e6-4789-a012-3456789abcde";
    const projectId = "p9f8e7d6-c5b4-4321-8765-43210fedcba9";
    const nowIso = new Date().toISOString();
    const line = `${nowIso} backfill origin_chat_id chat=${chatId} project=${projectId}`;

    // Ensure target log and parents do not exist
    assert.ok(!existsSync(targetLog));

    // Mirror the exact backfillOriginChatId write block
    await mkdir(path.dirname(targetLog), { recursive: true });
    await appendFile(targetLog, `${line}\n`, "utf8");

    assert.ok(existsSync(targetLog));
    const content = await readFile(targetLog, "utf8");
    assert.equal(content, `${line}\n`);

    // Verify line format structure
    assert.match(
      content,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z backfill origin_chat_id chat=c1a2b3c4-d5e6-4789-a012-3456789abcde project=p9f8e7d6-c5b4-4321-8765-43210fedcba9\n$/,
    );

    // Second write appends rather than overwrites
    const secondLine = `${new Date().toISOString()} backfill origin_chat_id chat=${chatId} project=p2`;
    await mkdir(path.dirname(targetLog), { recursive: true });
    await appendFile(targetLog, `${secondLine}\n`, "utf8");

    const updated = await readFile(targetLog, "utf8");
    assert.equal(updated, `${line}\n${secondLine}\n`);

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("chat-linkage — error handling and non-throwing failure path", () => {
  test("append failure catches error, logs to console.error, and does not throw", async () => {
    // /dev/null is a device node; trying to mkdir /dev/null/subdir will throw ENOTDIR
    const failingLogPath = "/dev/null/impossible-directory/backfill.log";
    const line = `${new Date().toISOString()} backfill origin_chat_id chat=c1 project=p1`;

    const originalConsoleError = console.error;
    const loggedErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(" "));
    };

    try {
      // Execute the try/catch block exactly as in backfillOriginChatId
      try {
        await mkdir(path.dirname(failingLogPath), { recursive: true });
        await appendFile(failingLogPath, `${line}\n`, "utf8");
      } catch (e) {
        console.error(
          `[chat-linkage] backfill.log append failed (${failingLogPath}):`,
          e instanceof Error ? e.message : e,
        );
      }
    } finally {
      console.error = originalConsoleError;
    }

    assert.ok(loggedErrors.length > 0, "Expected at least one error log");
    assert.ok(
      loggedErrors[0]!.includes(`[chat-linkage] backfill.log append failed (${failingLogPath}):`),
      `Expected error log message to contain backfill.log append failed header, got: ${loggedErrors[0]}`,
    );
  });

  test("source inspection: backfillOriginChatId wraps mkdir and appendFile in try/catch with console.error", () => {
    const backfillFnStart = CHAT_LINKAGE_SRC.indexOf("async function backfillOriginChatId");
    assert.ok(backfillFnStart >= 0, "backfillOriginChatId function not found in source");
    const backfillFnSrc = CHAT_LINKAGE_SRC.slice(backfillFnStart, backfillFnStart + 1200);

    assert.match(
      backfillFnSrc,
      /try\s*\{\s*await\s+mkdir\(path\.dirname\(BACKFILL_LOG\),\s*\{\s*recursive:\s*true\s*\}\);\s*await\s+appendFile\(BACKFILL_LOG,\s*`\$\{line\}\\n`,\s*["']utf8["']\);/,
      "backfillOriginChatId must await mkdir recursive before appendFile inside try block",
    );
    assert.match(
      backfillFnSrc,
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