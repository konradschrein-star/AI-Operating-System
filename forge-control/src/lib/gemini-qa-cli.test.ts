/**
 * Tests for scripts/gemini-qa.mjs — the video QA CLI.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Same approach as perplexity-cli.test.ts: the script is a standalone zero-dependency CLI
 * (02-architecture §6.1 forbids factoring its internals into an importable module), so it is
 * spawned as a real process with `globalThis.fetch` replaced by a `--import` preload. No
 * network, no key, no spend — which matters here more than anywhere else, because a real
 * 10-minute pass costs ~$5 (docs/tools/gemini-qa.md §7).
 *
 * Every URL-input run makes exactly ONE request (generateContent); the Files API upload/poll
 * path is skipped by design for `http(s)://` inputs, so a URL input is the honest way to reach
 * the output stage without simulating a resumable upload.
 *
 * Regression guards for the round-405 review findings:
 *   R405-1 — with --out set, the QA JSON went ONLY to the file. A write fault after a billed
 *            generateContent call therefore destroyed a ~$5 result. stdout now always gets it
 *            first, exactly like emit() in scripts/perplexity.mjs.
 *   R405-2 — process.exit() after process.stdout.write() truncates at the 64 KiB pipe buffer.
 *   R405-3 — accessSync(dir, W_OK) succeeds on a directory, so `--out /tmp` used to pre-flight
 *            clean, upload, poll and bill before dying at writeFileSync with EISDIR.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT = `${REPO_ROOT}scripts/gemini-qa.mjs`;
const SECRET_FILE = "/opt/ai-os/.secrets/store/gemini-api-key";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PIPE_BUFFER_BYTES = 65_536;

/**
 * Preload module: fake `fetch`, a touch file recording that a request happened, and the
 * sabotage hook — mkdir at the --out path at request time, i.e. strictly between the
 * pre-flight and the write. That window is the only one the pre-flight cannot close, and it
 * is where the "a paid result is never lost" guarantee has to hold.
 */
const STUB_SOURCE = `
import { writeFileSync, mkdirSync } from "node:fs";
globalThis.fetch = async () => {
  writeFileSync(process.env.__STUB_TOUCH, "called");
  if (process.env.__STUB_SABOTAGE) mkdirSync(process.env.__STUB_SABOTAGE, { recursive: true });
  return new Response(process.env.__STUB_BODY ?? "{}", {
    status: Number(process.env.__STUB_STATUS ?? "200"),
    headers: { "content-type": "application/json" },
  });
};
`;

let dir = "";
let stubUrl = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-qa-cli-test-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, STUB_SOURCE);
  stubUrl = pathToFileURL(stubPath).href;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Run = { status: number; stdout: string; stderr: string; requested: boolean };

/** A rubric payload that satisfies every required key the script validates on return. */
function qaPayload(deadSpots = 0): Record<string, unknown> {
  return {
    verdict: "needs_work",
    confidence: 0.8,
    hook: { score: 6, first_seconds_analysis: "Slow open.", notes: "Tighten the first beat." },
    pacing: {
      score: 5,
      dead_spots: Array.from({ length: deadSpots }, (_, i) => ({
        start_s: i,
        end_s: i + 1,
        note: `dead spot ${i} ${"padding ".repeat(20)}`,
      })),
    },
    audio: { score: 7, glitches: [] },
    visual: { score: 7, artifacts: [] },
    factual: { red_flags: [] },
    top_fixes: ["cut 0:12-0:19"],
    summary: "Watchable but loose in the middle.",
  };
}

/** The generateContent envelope Gemini returns, carrying the rubric as JSON text. */
function envelope(qa: unknown): unknown {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(qa) }] } }] };
}

function run(
  args: string[],
  body: unknown,
  opts: { key?: string | null; status?: number; sabotage?: string } = {},
): Run {
  const touch = join(dir, `touch-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __STUB_TOUCH: touch,
    __STUB_BODY: typeof body === "string" ? body : JSON.stringify(body),
    __STUB_STATUS: String(opts.status ?? 200),
    GEMINI_API_KEY: opts.key === undefined ? "test-key-not-real" : (opts.key ?? ""),
  };
  if (opts.key === null) delete env.GEMINI_API_KEY;
  if (opts.sabotage !== undefined) env.__STUB_SABOTAGE = opts.sabotage;

  const res = spawnSync(process.execPath, ["--import", stubUrl, SCRIPT, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024, // the R405-2 payloads deliberately exceed a pipe buffer
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    requested: existsSync(touch),
  };
}

/* ========================================================================== *
 * R405-1 — a billed QA result must never live only in a file that may fail
 * ========================================================================== */

describe("R405-1 --out never diverts the result away from stdout", () => {
  test("without --out the rubric goes to stdout", () => {
    const r = run([VIDEO_URL], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("with --out the rubric goes to BOTH stdout and the file, byte for byte", () => {
    const target = join(dir, "qa.json");
    const r = run([VIDEO_URL, "--out", target], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work", "--out must not empty stdout");
    assert.equal(readFileSync(target, "utf8"), r.stdout);
    assert.match(r.stderr, /QA JSON written to .*qa\.json \(and to stdout\)/);
  });

  test("a write failure after generateContent still leaves the paid result on stdout", () => {
    // Genuine mid-run breakage: the path passes the pre-flight, then the stub turns it into a
    // directory at request time, so writeFileSync hits EISDIR after the call is billed.
    const target = join(dir, `sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = run([VIDEO_URL, "--out", target], envelope(qaPayload()), { sabotage: target });
    assert.equal(r.status, 3, "a local write fault is exit 3, never 1 — a retry must not re-pay");
    assert.equal(r.requested, true);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work", "the ~$5 result must survive");
    assert.match(r.stderr, /writing --out .* failed/);
    assert.match(r.stderr, /NOT lost/);
  });
});

/* ========================================================================== *
 * R405-3 — the pre-flight must reject a directory before anything is billed
 * ========================================================================== */

describe("R405-3 --out pre-flight rejects a directory", () => {
  test("an existing directory as --out is caught BEFORE any request", () => {
    const r = run([VIDEO_URL, "--out", dir], envelope(qaPayload()));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "accessSync(dir, W_OK) passes — statSync must catch it first");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--out target is a directory, not a file/);
  });

  test("a missing --out directory is caught BEFORE any request", () => {
    const r = run([VIDEO_URL, "--out", join(dir, "no-such-dir", "qa.json")], envelope(qaPayload()));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /--out directory is not usable/);
    assert.match(r.stderr, /ENOENT/);
  });

  test("a missing key outranks the --out pre-flight (exit 2, not 3)", (t) => {
    if (existsSync(SECRET_FILE)) {
      t.skip(`${SECRET_FILE} exists on this box — the keyless path cannot be exercised`);
      return;
    }
    const r = run([VIDEO_URL, "--out", dir], envelope(qaPayload()), { key: null });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /no Gemini API key found/);
  });
});

/* ========================================================================== *
 * R405-2 — process.exit() must not truncate stdout/stderr at the pipe buffer
 *
 * These runs go through a REAL pipe(2), via a shell pipeline, and NOT through
 * spawnSync. spawnSync connects the child to a socketpair with a ~200 KiB
 * buffer, so a 140 KiB write completes inside uv_try_write and the defect never
 * appears — measured, spawnSync returned all 140,001 bytes of a payload that
 * `| cat` cut to exactly 65,536. A spawnSync test of this bug passes either way.
 * ========================================================================== */

/** Single-quote for /bin/bash. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run the CLI with `fd` connected to a real pipe and capture what actually made it through.
 * Returns the pipeline's *first* exit status (the CLI's), not `cat`'s.
 */
function runThroughPipe(
  fd: 1 | 2,
  args: string[],
  body: unknown,
  opts: { status?: number; sabotage?: string } = {},
): { status: number; captured: string } {
  const capture = join(dir, `piped-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __STUB_TOUCH: join(dir, `touch-${Math.random().toString(36).slice(2)}`),
    __STUB_BODY: typeof body === "string" ? body : JSON.stringify(body),
    __STUB_STATUS: String(opts.status ?? 200),
    GEMINI_API_KEY: "test-key-not-real",
  };
  if (opts.sabotage !== undefined) env.__STUB_SABOTAGE = opts.sabotage;

  // fd 2: stderr onto the pipe, stdout discarded, so only the diagnostic is measured.
  const redirect = fd === 1 ? "" : "2>&1 >/dev/null";
  const cmd =
    `${shq(process.execPath)} --import ${shq(stubUrl)} ${shq(SCRIPT)} ` +
    `${args.map(shq).join(" ")} ${redirect} | cat > ${shq(capture)}; exit \${PIPESTATUS[0]}`;

  const res = spawnSync("/bin/bash", ["-c", cmd], { encoding: "utf8", env });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, captured: readFileSync(capture, "utf8") };
}

describe("R405-2 large payloads survive process.exit() on a pipe", () => {
  test("a >64 KiB rubric reaches stdout in full when the --out write fails (exit 3)", () => {
    const target = join(dir, `big-sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = runThroughPipe(1, [VIDEO_URL, "--out", target], envelope(qaPayload(400)), {
      sabotage: target,
    });
    assert.equal(r.status, 3);
    assert.ok(
      r.captured.length > PIPE_BUFFER_BYTES,
      `payload must exceed the pipe buffer to be a real test (got ${r.captured.length} bytes)`,
    );
    const out = JSON.parse(r.captured); // would throw on a 65,536-byte cut mid-string
    assert.equal(out.pacing.dead_spots.length, 400, "the tail must survive exit()");
    assert.equal(out.summary, "Watchable but loose in the middle.");
  });

  test("a >64 KiB error body reaches stderr verbatim, uncut (exit 1)", () => {
    const hugeError = { error: { code: 400, message: "bad".repeat(30_000), status: "INVALID_ARGUMENT" } };
    const r = runThroughPipe(2, [VIDEO_URL], hugeError, { status: 400 });
    assert.equal(r.status, 1);
    assert.ok(
      r.captured.length > PIPE_BUFFER_BYTES,
      `diagnostic must exceed the pipe buffer to be a real test (got ${r.captured.length} bytes)`,
    );
    assert.match(r.captured, /generateContent failed/);
    assert.match(r.captured, /HTTP 400/);
    assert.ok(
      r.captured.includes(JSON.stringify(hugeError)),
      "the body is the whole diagnostic — a truncated one cannot be acted on",
    );
  });

  test("a >64 KiB successful rubric is not truncated either (exit 0, no exit() involved)", () => {
    const r = runThroughPipe(1, [VIDEO_URL], envelope(qaPayload(400)));
    assert.equal(r.status, 0);
    assert.ok(r.captured.length > PIPE_BUFFER_BYTES);
    assert.equal(JSON.parse(r.captured).pacing.dead_spots.length, 400);
  });
});
