/**
 * check-tool-summary.ts — executable unit check for the U23 tool-call
 * formatter table (`app/desktop/chat/tool-summary.ts`).
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so pure
 * helpers get a plain tsx script: table-driven, zero dependencies, one
 * PASS/FAIL line per case, `process.exit(1)` if anything fails. Same shape as
 * check-team-rows.ts, deliberately.
 *
 * The last section runs against the REAL captured thread
 * (docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json, 285 entries) —
 * synthetic cases prove the rows, real cases prove the rows match the wire.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-tool-summary.ts
 */

import { readFileSync } from "node:fs";

import {
  parseArgs,
  parseArgsWithSource,
  salvageArgs,
  summarizeTool,
  TOOL_FORMATTERS,
  type ToolSummary,
} from "../../forge-control-web/app/desktop/chat/tool-summary.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

/** One row of the case table: name → the four fields, all exact. */
function checkSummary(
  name: string,
  actual: ToolSummary,
  expected: ToolSummary,
): void {
  check(`${name} · label`, actual.label, expected.label);
  check(`${name} · gist`, actual.gist, expected.gist);
  check(`${name} · outcome`, actual.outcome, expected.outcome);
  check(`${name} · tone`, actual.tone, expected.tone);
}

const j = (o: unknown): string => JSON.stringify(o);

console.log("── the table itself ─────────────────────────────────────────");
for (const tool of [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "Task",
  "Agent",
  "SendMessage",
  "Skill",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Fallback",
]) {
  check(`row exists: ${tool}`, typeof TOOL_FORMATTERS[tool], "function");
}
check(
  "Task and Agent are the same row (one spawn concept, two names)",
  TOOL_FORMATTERS.Task === TOOL_FORMATTERS.Agent,
  true,
);

console.log("\n── Bash ────────────────────────────────────────────────────");
checkSummary(
  "short command, 3 output lines",
  summarizeTool("Bash", j({ command: "git status --short" }), "a\nb\nc", false),
  { label: "bash", gist: "git status --short", outcome: "3 lines", tone: "ok" },
);
checkSummary(
  "multi-line command collapses to one line",
  summarizeTool("Bash", j({ command: "cd /tmp &&\n  ls -la" }), "x", false),
  { label: "bash", gist: "cd /tmp && ls -la", outcome: "1 line", tone: "ok" },
);
checkSummary(
  "empty stdout is 'no output', not '0 lines'",
  summarizeTool("Bash", j({ command: "true" }), "", false),
  { label: "bash", gist: "true", outcome: "no output", tone: "ok" },
);
checkSummary(
  "whitespace-only stdout is also 'no output'",
  summarizeTool("Bash", j({ command: "true" }), "\n \n", false),
  { label: "bash", gist: "true", outcome: "no output", tone: "ok" },
);
checkSummary(
  "a failing command shows its first error line",
  summarizeTool("Bash", j({ command: "false" }), "boom: nope\ntrailing", true),
  { label: "bash", gist: "false", outcome: "boom: nope", tone: "error" },
);
checkSummary(
  "no result yet → pending, and the gist still reads",
  summarizeTool("Bash", j({ command: "sleep 100" }), null, false),
  { label: "bash", gist: "sleep 100", outcome: "running…", tone: "pending" },
);
check(
  "a 72-char command is NOT clipped",
  summarizeTool("Bash", j({ command: "x".repeat(72) }), "", false).gist,
  "x".repeat(72),
);
check(
  "a 73-char command clips to 71 chars + ellipsis",
  summarizeTool("Bash", j({ command: "x".repeat(73) }), "", false).gist,
  `${"x".repeat(71)}…`,
);

console.log("\n── Read / Write / Edit / MultiEdit ─────────────────────────");
checkSummary(
  "read shows the last two path segments",
  summarizeTool(
    "Read",
    j({ file_path: "/opt/ai-os/workspace/app/desktop/live/AgentActivity.tsx" }),
    "1\tone\n2\ttwo",
    false,
  ),
  { label: "read", gist: "…/live/AgentActivity.tsx", outcome: "2 lines", tone: "ok" },
);
checkSummary(
  "read with an offset says where it started",
  summarizeTool("Read", j({ file_path: "/a/b/c/d.ts", offset: 200 }), "x", false),
  { label: "read", gist: "…/c/d.ts @200", outcome: "1 line", tone: "ok" },
);
check(
  "a two-segment path is left alone",
  summarizeTool("Read", j({ file_path: "/etc/hosts" }), "x", false).gist,
  "/etc/hosts",
);
checkSummary(
  "write reports the size it wrote",
  summarizeTool(
    "Write",
    j({ file_path: "/repo/docs/plan/00-vision.md", content: "y".repeat(2400) }),
    "ok",
    false,
  ),
  { label: "write", gist: "…/plan/00-vision.md", outcome: "2.4k chars written", tone: "ok" },
);
checkSummary(
  "edit reports the before → after sizes",
  summarizeTool(
    "Edit",
    j({ file_path: "/repo/app/tokens.ts", old_string: "a".repeat(150), new_string: "b".repeat(1200) }),
    "ok",
    false,
  ),
  { label: "edit", gist: "…/app/tokens.ts", outcome: "150 → 1.2k chars", tone: "ok" },
);
checkSummary(
  "replace_all is visible in the gist",
  summarizeTool(
    "Edit",
    j({ file_path: "/repo/app/tokens.ts", old_string: "a", new_string: "b", replace_all: true }),
    "ok",
    false,
  ),
  { label: "edit", gist: "…/app/tokens.ts (all)", outcome: "1 → 1 chars", tone: "ok" },
);
checkSummary(
  "multiedit counts its edits",
  summarizeTool(
    "MultiEdit",
    j({ file_path: "/repo/app/tokens.ts", edits: [1, 2, 3] }),
    "ok",
    false,
  ),
  { label: "multiedit", gist: "…/app/tokens.ts ×3", outcome: "3 edits applied", tone: "ok" },
);
checkSummary(
  "one edit is singular",
  summarizeTool("MultiEdit", j({ file_path: "/a/b/c.ts", edits: [1] }), "ok", false),
  { label: "multiedit", gist: "…/b/c.ts ×1", outcome: "1 edit applied", tone: "ok" },
);

console.log("\n── Grep / Glob ─────────────────────────────────────────────");
checkSummary(
  "grep counts matching lines",
  summarizeTool("Grep", j({ pattern: "useTick" }), "a.ts:1:x\nb.ts:2:y", false),
  { label: "grep", gist: '"useTick"', outcome: "2 matches", tone: "ok" },
);
checkSummary(
  "one match is singular",
  summarizeTool("Grep", j({ pattern: "useTick" }), "a.ts:1:x", false),
  { label: "grep", gist: '"useTick"', outcome: "1 match", tone: "ok" },
);
checkSummary(
  "no matches says so",
  summarizeTool("Grep", j({ pattern: "nope", glob: "*.tsx" }), "", false),
  { label: "grep", gist: '"nope" [*.tsx]', outcome: "no matches", tone: "ok" },
);
check(
  "grep shows glob then path",
  summarizeTool("Grep", j({ pattern: "p", glob: "*.ts", path: "/a/b/c/d" }), "", false).gist,
  '"p" [*.ts] in …/c/d',
);
checkSummary(
  "glob counts files",
  summarizeTool("Glob", j({ pattern: "**/*.tsx" }), "a\nb\nc", false),
  { label: "glob", gist: "**/*.tsx", outcome: "3 files", tone: "ok" },
);
checkSummary(
  "glob with nothing found",
  summarizeTool("Glob", j({ pattern: "**/*.zzz" }), "", false),
  { label: "glob", gist: "**/*.zzz", outcome: "no files", tone: "ok" },
);

console.log("\n── Task / Agent (the org chart) ────────────────────────────");
checkSummary(
  "an async spawn reads role · description",
  summarizeTool(
    "Agent",
    j({ subagent_type: "Explore", description: "Recon the rail" }),
    "Async agent launched successfully. agentId: abc",
    false,
  ),
  { label: "spawn", gist: "Explore · Recon the rail", outcome: "launched", tone: "ok" },
);
checkSummary(
  "a synchronous Task reports what came back",
  summarizeTool(
    "Task",
    j({ subagent_type: "reviewer", description: "Attack the merge" }),
    "z".repeat(4200),
    false,
  ),
  { label: "spawn", gist: "reviewer · Attack the merge", outcome: "4.2k chars", tone: "ok" },
);
checkSummary(
  "no description falls back to the prompt's opening",
  summarizeTool("Task", j({ subagent_type: "scout", prompt: "Find every hover handler" }), "x", false),
  { label: "spawn", gist: "scout · Find every hover handler", outcome: "1 chars", tone: "ok" },
);
checkSummary(
  "a still-running spawn is pending, not 'done'",
  summarizeTool("Agent", j({ subagent_type: "builder", description: "601A" }), null, false),
  { label: "spawn", gist: "builder · 601A", outcome: "running…", tone: "pending" },
);

console.log("\n── SendMessage (operator ↔ agent) ──────────────────────────");
{
  // Verbatim payload from run a86cf7b3-9283-4315-a389-ab60bd2ea4df
  // (2026-08-04, entry sending to agent ac297fd2f48689773), read read-only
  // from the live DB — the CLI duplicates `to`/`recipient` and
  // `message`/`content` on every real call, exactly as the row expects.
  const CASE1_ARGS_TEXT =
    "{\"to\":\"ac297fd2f48689773\",\"summary\":\"Resume RAG recovery — verify partial work first\",\"message\":\"You were cut off mid-task when the operator process restarted. Resume the RAG index recovery. IMPORTANT: first re-verify actual current state before redoing anything — check whether your credential fixes to km-indexer.js/km-server.js are already on disk, whether knowledge-indexer-watch was restarted (pm2 shows uptime 3 days, so probably NOT), and whether any index changes landed. Then continue from wherever reality says you are, following the same instructions as before: env-based DB creds via ecosystem config, retry-on-failure for bulk indexing, watermark precision fix, .excalidraw.md exclusion + oversize chunk splitting, targeted purge of derived noise rows (no DROP/TRUNCATE, record before/after counts), restart knowledge-indexer-watch (NEVER forge-executor/forge-control), full reindex gated on sidecar health, then the verification battery (index coverage vs vault count, 3 previously-failed fact queries against /api/memory/search, watcher stable 2+ min, watermark no longer re-processing). Write the work log to /opt/ai-os/workspace/rework-2026-08-04/03b-rag-recovery-log.md and append a dated section to the vault note \\\"AI OS/Operator Log.md\\\". Return: what changed, verification results, anything still broken.\",\"type\":\"message\",\"recipient\":\"ac297fd2f48689773\",\"content\":\"You were cut off mid-task when the operator proce…\"}";
  const CASE1_RESULT =
    "{\"success\":true,\"message\":\"Agent \\\"ac297fd2f48689773\\\" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: /tmp/claude-0/-opt-ai-os-workspace/61d1935f-0407-40c3-8ae4-a3d68ce41302/tasks/ac297fd2f48689773.output\",\"resumedAgentId\":\"ac297fd2f48689773\",\"pin\":{\"id\":\"ac297fd2f48689773\",\"name\":\"ac297fd2f48689773\",\"ref\":\"a7c2e0\"}}";

  checkSummary(
    "(1) verbatim to/message payload from a86cf7b3",
    summarizeTool("SendMessage", CASE1_ARGS_TEXT, CASE1_RESULT, false),
    {
      label: "send",
      gist: "-> ac297fd2f48689773 · You were cut off mid-task when the operator proc…",
      outcome:
        '{"success":true,"message":"Agent \\"ac297fd2f48689773\\" had no a…',
      tone: "ok",
    },
  );

  checkSummary(
    "(2) recipient/content variant",
    summarizeTool(
      "SendMessage",
      j({ recipient: "ae1df398", content: "Resume the build please" }),
      "Understood, resuming now.",
      false,
    ),
    {
      label: "send",
      gist: "-> ae1df398 · Resume the build please",
      outcome: "Understood, resuming now.",
      tone: "ok",
    },
  );

  checkSummary(
    "(3) both duplicate pairs present — prefers to/message",
    summarizeTool(
      "SendMessage",
      j({
        to: "PRIMARY",
        recipient: "DUPLICATE",
        message: "primary message body",
        content: "duplicate content body",
      }),
      "ack",
      false,
    ),
    { label: "send", gist: "-> PRIMARY · primary message body", outcome: "ack", tone: "ok" },
  );

  checkSummary(
    "(4) missing recipient — gist is just the message",
    summarizeTool("SendMessage", j({ message: "just a body, no recipient" }), "ok", false),
    { label: "send", gist: "just a body, no recipient", outcome: "ok", tone: "ok" },
  );

  checkSummary(
    "(5) missing body — gist is just the recipient",
    summarizeTool("SendMessage", j({ to: "ae1df398" }), "ok", false),
    { label: "send", gist: "-> ae1df398", outcome: "ok", tone: "ok" },
  );

  {
    // A real-shaped payload clipped mid-string at ~1500 chars, same as the
    // executor does for any large tool_call: salvage recovers `to` (a
    // leading scalar) but the huge `message` value is cut before its
    // closing quote, so it is never guessed at (same contract as write/edit).
    const longPayload = j({
      to: "ac297fd2f48689773",
      summary: "x".repeat(50),
      message: CASE1_ARGS_TEXT.repeat(3),
    });
    const truncated = longPayload.slice(0, 1500);
    checkSummary(
      "(6) args JSON truncated mid-string at ~1500 chars — still renders",
      summarizeTool("SendMessage", truncated, "ok", false),
      { label: "send", gist: "-> ac297fd2f48689773", outcome: "ok", tone: "ok" },
    );
  }

  checkSummary(
    "(7) no tool_result yet — pending, not an error",
    summarizeTool("SendMessage", j({ to: "x", message: "hi" }), null, false),
    { label: "send", gist: "-> x · hi", outcome: "running…", tone: "pending" },
  );

  checkSummary(
    "(8) is_error result — tone error",
    summarizeTool("SendMessage", j({ to: "x", message: "hi" }), "Agent not found: x", true),
    { label: "send", gist: "-> x · hi", outcome: "Agent not found: x", tone: "error" },
  );

  checkSummary(
    "(9) a 4000-char message clips the gist, never unbounded",
    summarizeTool("SendMessage", j({ to: "agent1", message: "z".repeat(4000) }), "reply", false),
    {
      label: "send",
      gist: `-> agent1 · ${"z".repeat(59)}…`,
      outcome: "reply",
      tone: "ok",
    },
  );

  checkSummary(
    "both recipient and body missing falls back to the raw payload",
    summarizeTool("SendMessage", j({ summary: "no to, no message here" }), "ok", false),
    {
      label: "send",
      gist: '{"summary":"no to, no message here"}',
      outcome: "ok",
      tone: "ok",
    },
  );
}

console.log("\n── Skill / WebFetch / WebSearch / TodoWrite ────────────────");
checkSummary(
  "skill shows its name and the result's first line",
  summarizeTool("Skill", j({ skill: "remotion", args: "--check" }), "Loaded remotion\nmore", false),
  { label: "skill", gist: "remotion --check", outcome: "Loaded remotion", tone: "ok" },
);
checkSummary(
  "fetch shows the url and payload size",
  summarizeTool("WebFetch", j({ url: "https://example.com/docs" }), "q".repeat(1500), false),
  { label: "fetch", gist: "https://example.com/docs", outcome: "1.5k chars", tone: "ok" },
);
checkSummary(
  "search quotes the query",
  summarizeTool("WebSearch", j({ query: "react 19 useSyncExternalStore" }), "r".repeat(300), false),
  { label: "search", gist: '"react 19 useSyncExternalStore"', outcome: "300 chars", tone: "ok" },
);
checkSummary(
  "todo shows the active item and the tally",
  summarizeTool(
    "TodoWrite",
    j({
      todos: [
        { content: "write the table", status: "completed" },
        { content: "write the checks", status: "in_progress" },
        { content: "commit", status: "pending" },
      ],
    }),
    "ok",
    false,
  ),
  { label: "todo", gist: "write the checks", outcome: "1/3 done", tone: "ok" },
);
checkSummary(
  "todo with nothing active falls back to the count",
  summarizeTool(
    "TodoWrite",
    j({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }] }),
    "ok",
    false,
  ),
  { label: "todo", gist: "2 items", outcome: "2/2 done", tone: "ok" },
);

console.log("\n── Fallback: an unmapped tool still says something true ────");
checkSummary(
  "unmapped tool keeps its own name and shows its first two scalars",
  summarizeTool(
    "ScheduleWakeup",
    j({ delaySeconds: 1500, prompt: "<<loop>>", reason: "heartbeat" }),
    "Next wakeup scheduled",
    false,
  ),
  {
    label: "ScheduleWakeup",
    gist: "delaySeconds=1500 prompt=<<loop>>",
    outcome: "21 chars",
    tone: "ok",
  },
);
checkSummary(
  "a nested-only payload degrades to the raw text, never to an inner key",
  summarizeTool("MysteryTool", j({ nested: { file_path: "/a/b/c" } }), "", false),
  {
    label: "MysteryTool",
    gist: '{"nested":{"file_path":"/a/b/c"}}',
    outcome: "no output",
    tone: "ok",
  },
);
check(
  "an empty tool name still produces a label",
  summarizeTool("", "{}", "x", false).label,
  "tool",
);

console.log("\n── never throws, never lies ────────────────────────────────");
for (const [name, argsText] of [
  ["null input", null],
  ["undefined input", undefined],
  ["empty string", ""],
  ["not JSON at all", "ls -la | grep foo"],
  ["truncated object", '{"command":"echo hi'],
  ["a JSON array", "[1,2,3]"],
  ["a bare JSON string", '"just a string"'],
  ["a JSON number", "42"],
  ["JSON null", "null"],
] as const) {
  let threw = false;
  let summary: ToolSummary | null = null;
  try {
    summary = summarizeTool("Bash", argsText, "out", false);
  } catch {
    threw = true;
  }
  check(`${name}: does not throw`, threw, false);
  check(`${name}: still yields a tone`, summary?.tone, "ok");
  check(`${name}: still yields a label`, summary?.label, "bash");
}
check(
  "a non-JSON payload becomes the gist verbatim",
  summarizeTool("Bash", "ls -la | grep foo", "out", false).gist,
  "ls -la | grep foo",
);
check(
  "parseArgs rejects arrays (not a key/value payload)",
  parseArgs("[1,2]"),
  null,
);
check("parseArgs rejects malformed JSON", parseArgs("{oops"), null);
check(
  "parseArgs accepts a plain object",
  JSON.stringify(parseArgs('{"a":1}')),
  '{"a":1}',
);
{
  // A formatter that throws is a bug in tool-summary.ts, not a reason to blank
  // the transcript: it must surface, loudly and specifically.
  const saved = TOOL_FORMATTERS.Bash;
  TOOL_FORMATTERS.Bash = () => {
    throw new Error("deliberate");
  };
  const s = summarizeTool("Bash", "{}", "out", false);
  TOOL_FORMATTERS.Bash = saved;
  check("a throwing row is caught", s.tone, "error");
  check("…and names the failure", s.outcome, "formatter failed: deliberate");
  check("…and the table is restored", TOOL_FORMATTERS.Bash, saved);
}

console.log("\n── salvage: the executor clips meta.input at 1500 chars ────");
{
  const truncated = '{"description":"Recon the rail","subagent_type":"Explore","prompt":"You are do';
  check("JSON.parse cannot read it", parseArgs(truncated), null);
  const salvaged = salvageArgs(truncated);
  check("salvage recovers the first key", salvaged?.description, "Recon the rail");
  check("salvage recovers the second key", salvaged?.subagent_type, "Explore");
  check("salvage refuses the half-written value at the cut", "prompt" in (salvaged ?? {}), false);
  check("parseArgsWithSource flags it", parseArgsWithSource(truncated).source, "salvaged");
  check("…and flags a whole payload as json", parseArgsWithSource('{"a":1}').source, "json");
  check("…and an unusable one as none", parseArgsWithSource("garbage").source, "none");
  checkSummary(
    "a clipped spawn still reads as itself",
    summarizeTool("Agent", truncated, "Async agent launched successfully.", false),
    { label: "spawn", gist: "Explore · Recon the rail", outcome: "launched", tone: "ok" },
  );
}
{
  // Salvage must never descend into a nested object and report its keys.
  const nested = '{"outer":{"file_path":"/nested/x.ts"},"file_path":"/real/y.ts"';
  const salvaged = salvageArgs(nested);
  check("scan stops at a nested object", salvaged, null);
  check(
    "…so write shows the raw text rather than the wrong file",
    summarizeTool("Write", nested, "ok", false).gist,
    nested,
  );
}
{
  // A clipped Write must NOT report the clip's length as the file's size.
  const clippedWrite = `{"file_path":"/repo/docs/plan/00-vision.md","content":"${"y".repeat(200)}`;
  const s = summarizeTool("Write", clippedWrite, "ok", false);
  check("clipped write finds the path", s.gist, "…/plan/00-vision.md");
  check("clipped write refuses to state a size", s.outcome, "written");
}
check(
  "salvage handles numbers and booleans",
  JSON.stringify(salvageArgs('{"n":12,"b":true,"s":"x","broken":"unter')),
  '{"n":12,"b":true,"s":"x"}',
);
check("salvage rejects a non-object prefix", salvageArgs('["a","b"'), null);
check("salvage rejects an empty string", salvageArgs(""), null);

console.log("\n── REAL FIXTURE: run 3853c154 (285 entries, 136 tool calls) ─");
{
  interface FixtureEntry {
    role: string;
    content: string;
    ts: string;
    kind?: string;
    meta?: Record<string, unknown>;
  }
  const fixtureUrl = new URL(
    "../../docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json",
    import.meta.url,
  );
  const run = (
    JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
      run: { thread: FixtureEntry[] };
    }
  ).run;
  const thread = run.thread;
  check("fixture has the 285 entries round 600 measured", thread.length, 285);

  const results = new Map<string, FixtureEntry>();
  for (const e of thread) {
    const id = e.meta?.tool_use_id;
    if (e.kind === "tool_result" && typeof id === "string") results.set(id, e);
  }

  /** Summarize the fixture entry at `index`, joined to its real result. */
  function atIndex(index: number): ToolSummary {
    const call = thread[index];
    const meta = call.meta ?? {};
    const result = results.get(String(meta.tool_use_id));
    return summarizeTool(
      String(meta.tool),
      typeof meta.input === "string" ? meta.input : null,
      result === undefined ? null : result.content,
      result?.meta?.is_error === true,
    );
  }

  checkSummary("real Bash (entry 2)", atIndex(2), {
    label: "bash",
    gist: "ls /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838 &…",
    outcome: "29 lines",
    tone: "ok",
  });
  checkSummary("real Agent spawn, clipped payload (entry 4)", atIndex(4), {
    label: "spawn",
    gist: "Explore · Recon chat Bash block rendering",
    outcome: "launched",
    tone: "ok",
  });
  checkSummary("real Read (entry 21)", atIndex(21), {
    label: "read",
    gist: "…/live/AgentActivity.tsx",
    outcome: "67 lines",
    tone: "ok",
  });
  checkSummary("real Grep (entry 50)", atIndex(50), {
    label: "grep",
    gist: '"onMouseEnter|onMouseLeave|onMouseOver|:hover|onPointerEnter" in …/forg…',
    outcome: "34 matches",
    tone: "ok",
  });
  checkSummary("real unmapped tool → Fallback (entry 184)", atIndex(184), {
    label: "ScheduleWakeup",
    gist: "delaySeconds=1500 prompt=<<autonomous-loop-dynamic>>",
    outcome: "158 chars",
    tone: "ok",
  });
  checkSummary("real failed Write, clipped payload (entry 238)", atIndex(238), {
    label: "write",
    gist: "…/plan/00-vision.md",
    outcome: "File has not been read yet. Read it first before writing to it.",
    tone: "error",
  });

  // The whole run, not just the six hand-picked entries: every tool call must
  // produce a usable summary and none may throw.
  let calls = 0;
  let empties = 0;
  let threw = 0;
  const labels = new Set<string>();
  for (let i = 0; i < thread.length; i++) {
    if (thread[i].kind !== "tool_call") continue;
    calls++;
    try {
      const s = atIndex(i);
      labels.add(s.label);
      if (s.label === "" || s.gist === "" || s.outcome === "") empties++;
    } catch {
      threw++;
    }
  }
  check("every tool call in the run was summarized", calls, 136);
  check("…none threw", threw, 0);
  check("…none produced an empty field", empties, 0);
  check(
    "…and the labels are exactly the run's tool set",
    [...labels].sort().join(","),
    "ScheduleWakeup,bash,grep,read,spawn,write",
  );
}

console.log("\n── NO ROW EVER RENDERS A BLANK GIST (round 1353) ───────────");
/* Round 1352's reviewer probed `rawGist("")` and got `""` back. The row still
 * drew — dot, label, outcome, chevron — but with an empty middle, which reads
 * as "this call had no arguments worth showing" when the truth is "nothing
 * arrived". Criterion (b) forbids it.
 *
 * Not reachable through the live engine: `executor.ts` writes
 * `JSON.stringify(e.toolInput ?? {})`, so `meta.input` is at minimum `"{}"`,
 * and `thread-mapping.ts` falls back to the entry `content` when `meta.input`
 * is absent. Reachable from a fixture, from any future writer that does not go
 * through the executor, and from every caller of the exported `summarizeTool`.
 * Fixed in the shared helper, so it is asserted table-wide rather than for the
 * one row that happened to be under review. */
{
  const EMPTY_PAYLOADS: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ['""', ""],
    ['"   "', "   "],
    ['"\\n\\t"', "\n\t"],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const tool of Object.keys(TOOL_FORMATTERS)) {
    for (const [name, argsText] of EMPTY_PAYLOADS) {
      const s = summarizeTool(tool, argsText, "ok", false);
      check(`${tool} · args ${name} · gist is not blank`, s.gist !== "", true);
      check(`${tool} · args ${name} · label is not blank`, s.label !== "", true);
      check(`${tool} · args ${name} · outcome is not blank`, s.outcome !== "", true);
    }
  }

  // The placeholder itself is pinned, not merely "something non-empty" — three
  // rows that reach it by different routes: the Fallback row, a row whose key
  // is missing (Bash), and a row that reaches rawGist directly (SendMessage).
  check(
    "an unknown tool with an empty payload says so",
    summarizeTool("NoSuchToolExists", "", "ok", false).gist,
    "no arguments",
  );
  check(
    "bash with an empty payload says so",
    summarizeTool("Bash", "", "ok", false).gist,
    "no arguments",
  );
  check(
    "SendMessage with an empty payload says so",
    summarizeTool("SendMessage", "", "ok", false).gist,
    "no arguments",
  );
  // …and a payload that IS present is untouched by the guard.
  check(
    "an empty JSON OBJECT is not an empty payload — it renders verbatim",
    summarizeTool("SendMessage", "{}", "ok", false).gist,
    "{}",
  );
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — tool summary table`,
);
process.exit(failures === 0 ? 0 : 1);
