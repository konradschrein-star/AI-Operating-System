/**
 * `aios` CLI behaviour tests — round 2 (fix cycle 1).
 *
 * WHY IMPORT-AND-CALL, NOT SOURCE-ASSERTION. The defects this file guards
 * against were all invisible to `tsc` and to any grep: the CLI read fields
 * (`days_30`, `by_provider`, `entry.text`, `entry.from`) that the API does not
 * send, and every one of them was optional, so the code compiled, ran, and
 * printed a confident €0.00 / a blank comms line. Only exercising the handler
 * against a payload of the REAL shape catches that. So each test stands up a
 * stub HTTP server on an ephemeral port, points an `AiosClient` at it, and
 * asserts on what the handler actually printed and which requests it made.
 *
 * Nothing here touches :7700, the database, or tmux. The stub records every
 * request it receives, which is what makes the terminal-ownership test a
 * negative control rather than a description of one.
 *
 * EVERY TEST IS PAIRED WITH ITS DISCRIMINATION CASE. For each fix there is one
 * test that would have FAILED against the pre-fix code (marked "DISCRIMINATES")
 * — a test that passes both before and after a fix proves nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AiosClient,
  CliError,
  handleRuns,
  handleSpend,
  handleTerminal,
  parseArgs,
} from "./cli-runner.ts";

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

type StubResponder = (body: unknown) => unknown;
type StubRoutes = Record<string, unknown | StubResponder>;

/** Serves `routes` keyed "METHOD /path"; records every call it receives.
 *  An unrouted request is a 404 with the path in it, never a silent {}. */
async function withStub(
  routes: StubRoutes,
  fn: (client: AiosClient, calls: StubCall[]) => Promise<void>,
): Promise<void> {
  const calls: StubCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "").split("?")[0];
      const method = req.method ?? "GET";
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({ method, path, body });

      const route = routes[`${method} ${path}`];
      res.setHeader("content-type", "application/json");
      if (route === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `stub has no route for ${method} ${path}` }));
        return;
      }
      const payload = typeof route === "function" ? (route as StubResponder)(body) : route;
      res.statusCode = 200;
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(new AiosClient(`http://127.0.0.1:${port}`), calls);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Runs `fn` with console.log captured, and returns everything it printed. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

/** Runs `fn`, returning both what it printed and the error it threw (if any). */
async function captureFailure(
  fn: () => Promise<void>,
): Promise<{ output: string; error: unknown }> {
  let error: unknown = null;
  const output = await captureOutput(async () => {
    try {
      await fn();
    } catch (e) {
      error = e;
    }
  });
  return { output, error };
}

/* ── spend summary ────────────────────────────────────────────────────────── */

/** The shape `spendSummary()` in db/spend.ts really returns, verified against
 *  the live API on 2026-08-23: fixed windows today/d7/d30, `by_area` as an
 *  ARRAY of provider×kind rows. Numbers here are invented for the fixture —
 *  their only job is to be distinguishable from 0. */
const LIVE_SPEND_SUMMARY = {
  today: { total_eur: 1.25, calls: 34, claude_eur: 274.47, claude_calls: 91 },
  d7: { total_eur: 4.5, calls: 84, claude_eur: 2896.11, claude_calls: 824 },
  d30: { total_eur: 12.34, calls: 84, claude_eur: 4010.47, claude_calls: 1195 },
  by_area: [
    { provider: "claude-code", kind: "llm_output", total_eur: 4010.47, calls: 1195, units: 43437 },
    { provider: "gemini", kind: "llm_input", total_eur: 0, calls: 42, units: 9796692 },
  ],
  daily: [{ day: "2026-08-23", total_eur: 1.25, calls: 34 }],
};

test("DISCRIMINATES: spend summary reads d30/by_area, not days_30/by_provider", async () => {
  await withStub({ "GET /api/spend/summary": LIVE_SPEND_SUMMARY }, async (client) => {
    const output = await captureOutput(() =>
      handleSpend(client, parseArgs(["spend", "summary"])),
    );

    // The pre-fix handler read res.days_30?.total_eur — absent from this
    // payload — and printed "30-Day Window: €0.00" against real spend.
    assert.match(output, /€12\.34/, "30-day metered total must come from d30.total_eur");
    assert.match(output, /€4010\.47/, "claude-code notional cost must be rendered");
    assert.match(output, /1195/, "claude_calls must be rendered");

    // by_area is an array; the pre-fix handler iterated a by_provider MAP and
    // therefore printed no breakdown at all for this payload.
    assert.match(output, /gemini/, "by_area rows must be listed");
    assert.match(output, /9796692/, "by_area units must be rendered");
  });
});

test("DISCRIMINATES: spend summary throws on an unknown payload shape instead of printing €0.00", async () => {
  const legacyShape = {
    days_30: { total_eur: 12.34 },
    today: { total_eur: 1.25 },
    by_provider: { gemini: 5 },
  };
  await withStub({ "GET /api/spend/summary": legacyShape }, async (client) => {
    const { output, error } = await captureFailure(() =>
      handleSpend(client, parseArgs(["spend", "summary"])),
    );
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.match((error as CliError).message, /d7, d30/, "the error must name the missing windows");
    assert.doesNotMatch(output, /€0\.00/, "a missing window must never render as €0.00");
  });
});

test("spend summary --json passes the payload through untouched", async () => {
  await withStub({ "GET /api/spend/summary": LIVE_SPEND_SUMMARY }, async (client) => {
    const output = await captureOutput(() =>
      handleSpend(client, parseArgs(["spend", "summary", "--json"])),
    );
    assert.deepEqual(JSON.parse(output), LIVE_SPEND_SUMMARY);
  });
});

/* ── runs show · comms ────────────────────────────────────────────────────── */

const RUN_ROW = {
  run: {
    id: "2ef126b7-d6d9-4a55-a8e7-d9acf0508645",
    title: "manager chat",
    status: "completed",
    created_at: "2026-08-22T22:28:21Z",
    completed_at: "2026-08-23T17:06:31Z",
  },
};

/** The projection `listComms()` in db/runs.ts builds: role/content/ts/kind/meta,
 *  with the sender at meta.comms.from. There is no top-level `from` or `text`. */
const LIVE_COMMS_ENTRY = {
  role: "user",
  content: "[message from worker c2c7b49a] round 2 done, committed bc136c7",
  ts: "2026-08-23T00:52:15.930Z",
  kind: "comms",
  meta: { comms: { from: "worker", direction: "in", peer_role: "builder", peer_run_id: "c2c7b49a" } },
};

test("DISCRIMINATES: runs show renders comms from entry.content and meta.comms.from", async () => {
  await withStub(
    {
      "GET /api/chat/2ef126b7-d6d9-4a55-a8e7-d9acf0508645": RUN_ROW,
      "GET /api/runs/2ef126b7-d6d9-4a55-a8e7-d9acf0508645/comms": {
        run_id: "2ef126b7-d6d9-4a55-a8e7-d9acf0508645",
        comms: [LIVE_COMMS_ENTRY],
      },
    },
    async (client) => {
      const output = await captureOutput(() =>
        handleRuns(client, parseArgs(["runs", "show", "2ef126b7-d6d9-4a55-a8e7-d9acf0508645"])),
      );
      // Pre-fix this line was "[worker] " — entry.text and entry.from are both
      // undefined on a real comms entry, so every message rendered blank.
      assert.match(output, /round 2 done, committed bc136c7/, "the message body must be rendered");
      assert.match(output, /worker\/builder/, "the sender must come from meta.comms");
    },
  );
});

test("DISCRIMINATES: a comms entry with no content is named, not rendered as silence", async () => {
  await withStub(
    {
      "GET /api/chat/2ef126b7-d6d9-4a55-a8e7-d9acf0508645": RUN_ROW,
      "GET /api/runs/2ef126b7-d6d9-4a55-a8e7-d9acf0508645/comms": {
        run_id: "2ef126b7-d6d9-4a55-a8e7-d9acf0508645",
        // The pre-fix shape: what the CLI used to expect and the API never sent.
        comms: [{ text: "legacy", from: "worker", ts: "2026-08-23T00:52:15.930Z" }],
      },
    },
    async (client) => {
      const output = await captureOutput(() =>
        handleRuns(client, parseArgs(["runs", "show", "2ef126b7-d6d9-4a55-a8e7-d9acf0508645"])),
      );
      assert.match(output, /no 'content' on this comms entry/, "the shape mismatch must be visible");
      assert.match(output, /text,from,ts/, "the keys actually present must be named");
    },
  );
});

/* ── terminal run · session ownership ─────────────────────────────────────── */

const KONRAD_SESSION = { id: "konrad-desktop-shell", title: "shell", alive: true, created_at: "2026-08-23T18:00:00Z" };

test("DISCRIMINATES: terminal run refuses to type into a session it did not create", async () => {
  await withStub(
    { "GET /api/terminal/sessions": { sessions: [KONRAD_SESSION] } },
    async (client, calls) => {
      const { error } = await captureFailure(() =>
        handleTerminal(client, parseArgs(["terminal", "run", "echo hello"])),
      );
      assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
      assert.match((error as CliError).action ?? "", /--session|--new/, "the error must say what to do next");

      // The load-bearing assertion: pre-fix, this exact invocation POSTed the
      // command into the first alive session — the desktop Terminal pane's.
      const writes = calls.filter((call) => call.path.includes("/input"));
      assert.deepEqual(writes, [], "no input may be submitted to anyone's shell");
      const creates = calls.filter((call) => call.method === "POST");
      assert.deepEqual(creates, [], "a refusal must not create a session either");
    },
  );
});

test("terminal run --new writes only into the session it just created", async () => {
  await withStub(
    {
      "GET /api/terminal/sessions": { sessions: [KONRAD_SESSION] },
      "POST /api/terminal/sessions": { id: "cli-owned-session", title: "aios-cli-run", cwd: "/opt/forge-ai-os", alive: true },
      "POST /api/terminal/sessions/cli-owned-session/input": { ok: true },
      "GET /api/terminal/sessions/cli-owned-session": { content: "hello", alive: true },
    },
    async (client, calls) => {
      const output = await captureOutput(() =>
        handleTerminal(client, parseArgs(["terminal", "run", "echo hello", "--new"])),
      );
      assert.match(output, /hello/, "the session's output must be shown");

      const writes = calls.filter((call) => call.path.includes("/input"));
      assert.equal(writes.length, 1, "exactly one input submission");
      assert.equal(writes[0].path, "/api/terminal/sessions/cli-owned-session/input");
      assert.ok(
        !calls.some((call) => call.path.includes(KONRAD_SESSION.id)),
        "the pre-existing session must never be touched",
      );
    },
  );
});

test("terminal run rejects --session together with --new", async () => {
  await withStub({}, async (client, calls) => {
    const { error } = await captureFailure(() =>
      handleTerminal(client, parseArgs(["terminal", "run", "echo hello", "--session", "abc", "--new"])),
    );
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    assert.match((error as CliError).message, /mutually exclusive/);
    assert.deepEqual(calls, [], "an argument conflict must be caught before any request");
  });
});

/* ── argument parsing ─────────────────────────────────────────────────────── */

test("DISCRIMINATES: a boolean switch does not swallow the following positional", async () => {
  const parsed = parseArgs(["terminal", "run", "--new", "git status"]);
  assert.equal(parsed.flags.new, true, "--new is a switch, not a key/value pair");
  assert.deepEqual(parsed.args, ["git status"], "the command must survive as a positional");

  const withValue = parseArgs(["terminal", "run", "ls", "--session", "abc123"]);
  assert.equal(withValue.flags.session, "abc123", "value flags still consume their value");
  assert.deepEqual(withValue.args, ["ls"]);
});
