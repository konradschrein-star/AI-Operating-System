/**
 * Tests for scripts/perplexity.mjs — the researcher lane's Perplexity helper.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The script is a standalone zero-dependency CLI (02-architecture §6.1 forbids factoring its
 * internals into an importable module), so it is tested the only honest way: spawned as a real
 * process, exactly as the researcher lane invokes it. No network is touched — a `--import`
 * preload replaces `globalThis.fetch` with a canned response before the script's first line
 * runs, which also means these tests cost nothing and need no key.
 *
 * The blocks below are direct regression guards for the review findings that produced them:
 *   R404-1 — a search_results item whose `results` is not an array used to yield `citations: []`
 *            and exit 0, filing an uncited answer as a successful cited one.
 *   R404-2 — a paid answer used to be discarded when the --out write failed, because the file
 *            was written before stdout and there was no pre-flight.
 *   R405-2 — process.exit() after process.stdout.write() truncates at the 64 KiB pipe buffer,
 *            so both guarantees above silently evaporated on any payload big enough to matter.
 *            spawnSync captures through pipes, which is exactly the failing configuration.
 *   R405-3 — accessSync(dir, W_OK) succeeds on a directory, so `--out /tmp` used to reach the
 *            (billed) request and fail at writeFileSync with EISDIR.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT = `${REPO_ROOT}scripts/perplexity.mjs`;
const SECRET_FILE = "/opt/ai-os/.secrets/store/perplexity-api-key";

/**
 * Preload module: swaps in a fake `fetch` and records that it was called. Written to a temp
 * dir rather than committed, so nothing that looks like production code ships a stub.
 *
 * __STUB_SABOTAGE creates a directory at the given path at request time — i.e. strictly
 * between the --out pre-flight and the write. That is the one window the pre-flight genuinely
 * cannot close, and the only honest way to test the "paid answer survives" guarantee now that
 * a directory target is rejected up front.
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
  dir = mkdtempSync(join(tmpdir(), "perplexity-cli-test-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, STUB_SOURCE);
  stubUrl = pathToFileURL(stubPath).href;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Run = { status: number; stdout: string; stderr: string; requested: boolean };

/** Spawn the CLI with a stubbed fetch. `body` is what the fake API returns. */
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
    PERPLEXITY_API_KEY: opts.key === undefined ? "test-key-not-real" : (opts.key ?? ""),
  };
  if (opts.key === null) delete env.PERPLEXITY_API_KEY;
  if (opts.sabotage !== undefined) env.__STUB_SABOTAGE = opts.sabotage;

  const res = spawnSync(process.execPath, ["--import", stubUrl, SCRIPT, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024, // the R405-2 payloads are deliberately larger than a pipe buffer
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    requested: existsSync(touch),
  };
}

/** An Agent API response envelope with the given output[] items. */
function agentResponse(output: unknown[]): unknown {
  return { status: "completed", model: "perplexity/sonar", usage: { total_tokens: 1 }, output };
}

const MESSAGE_ITEM = {
  type: "message",
  content: [{ type: "output_text", text: "The answer." }],
};

/* ========================================================================== *
 * R404-1 — the citation path must not swallow an unreadable sources payload
 * ========================================================================== */

describe("R404-1 extractSearchResults", () => {
  test("results array is emitted with its citations", () => {
    const r = run(
      ["ask", "q"],
      agentResponse([
        MESSAGE_ITEM,
        { type: "search_results", results: [{ url: "https://a.example" }, { url: "https://b.example" }] },
      ]),
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.answer, "The answer.");
    assert.deepEqual(out.citations, ["https://a.example", "https://b.example"]);
    assert.equal(out.search_results.length, 2);
  });

  test("no search_results item at all is a legal zero-source run", () => {
    const r = run(["ask", "q"], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.citations, []);
    assert.deepEqual(out.search_results, []);
  });

  test("search_results item present but `results` is not an array is a hard error, body verbatim", () => {
    const r = run(
      ["ask", "q"],
      agentResponse([MESSAGE_ITEM, { type: "search_results", items: [{ url: "https://a.example" }] }]),
    );
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "", "no answer may be emitted when the sources cannot be read");
    assert.match(r.stderr, /"results" is not an array/);
    // Verbatim body so the caller can see what the vendor actually sent.
    assert.match(r.stderr, /"items"/);
    assert.match(r.stderr, /https:\/\/a\.example/);
  });

  test("search_results.results = null is an error, not an empty citation list", () => {
    const r = run(["ask", "q"], agentResponse([MESSAGE_ITEM, { type: "search_results", results: null }]));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /got null/);
  });

  test("search mode still hard-errors when neither results key is present", () => {
    const r = run(["search", "q"], { data: [] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /neither a "results" nor a "search_results" array/);
  });
});

/* ========================================================================== *
 * R404-2 — a billed answer must survive an --out failure
 * ========================================================================== */

describe("R404-2 --out handling", () => {
  test("missing --out directory is caught BEFORE the request (exit 3, nothing sent)", () => {
    const r = run(["ask", "q", "--out", join(dir, "no-such-dir", "out.json")], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "the pre-flight must run before any HTTP request");
    assert.match(r.stderr, /--out directory is not usable/);
    assert.match(r.stderr, /ENOENT/);
  });

  test("a write failure after the request still leaves the result on stdout", () => {
    // A genuine mid-run breakage: the target passes the pre-flight (parent exists, nothing at
    // the path), then the stub turns the path into a directory at request time, so
    // writeFileSync hits EISDIR. This is the window the pre-flight really cannot close.
    const target = join(dir, `sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = run(["ask", "q", "--out", target], agentResponse([MESSAGE_ITEM]), { sabotage: target });
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.requested, true);
    const out = JSON.parse(r.stdout);
    assert.equal(out.answer, "The answer.", "the paid answer must reach stdout before the file write");
    assert.match(r.stderr, /could not write --out file/);
    assert.match(r.stderr, /NOT lost/);
  });

  test("a writable --out gets the same JSON that stdout got", () => {
    const target = join(dir, "ok.json");
    const r = run(["ask", "q", "--out", target], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(target, "utf8"), r.stdout);
  });

  test("a missing key outranks the --out pre-flight (exit 2, not 3)", (t) => {
    if (existsSync(SECRET_FILE)) {
      t.skip(`${SECRET_FILE} exists on this box — the keyless path cannot be exercised`);
      return;
    }
    const r = run(["ask", "q", "--out", join(dir, "no-such-dir", "out.json")], agentResponse([MESSAGE_ITEM]), {
      key: null,
    });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /No Perplexity API key found/);
  });

  test("usage errors still precede everything (exit 3, no request)", () => {
    const r = run(["ask", "q", "--max-tool-calls", "0"], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /usage error:/);
  });
});

/* ========================================================================== *
 * R405-3 — the --out pre-flight must reject a directory target before paying
 * ========================================================================== */

describe("R405-3 --out pre-flight rejects a directory", () => {
  test("an existing directory as --out is caught BEFORE the request", () => {
    const r = run(["ask", "q", "--out", dir], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "accessSync(dir, W_OK) succeeds — statSync must catch it first");
    assert.match(r.stderr, /--out target is a directory, not a file/);
    assert.equal(r.stdout, "");
  });

  test("a regular file used as a parent directory is caught BEFORE the request", () => {
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    const r = run(["ask", "q", "--out", join(notADir, "out.json")], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    // statSync on the target itself reports ENOTDIR here, before the parent is ever examined.
    assert.match(r.stderr, /ENOTDIR/);
  });
});

/* ========================================================================== *
 * R405-2 — process.exit() must not truncate stdout/stderr at the pipe buffer
 *
 * These runs go through a REAL pipe(2), via a shell pipeline, and NOT through
 * spawnSync. That is not a stylistic choice: spawnSync connects the child to a
 * socketpair whose buffer is ~200 KiB (net.core.wmem_default), so a 140 KiB
 * write completes inside uv_try_write and the defect is invisible — measured,
 * spawnSync returned all 140,001 bytes of a payload that `| cat` truncated to
 * exactly 65,536. A test of this bug written with spawnSync passes either way.
 * ========================================================================== */

const PIPE_BUFFER_BYTES = 65_536;

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
  opts: { sabotage?: string } = {},
): { status: number; captured: string } {
  const capture = join(dir, `piped-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __STUB_TOUCH: join(dir, `touch-${Math.random().toString(36).slice(2)}`),
    __STUB_BODY: typeof body === "string" ? body : JSON.stringify(body),
    __STUB_STATUS: "200",
    PERPLEXITY_API_KEY: "test-key-not-real",
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

/** Search results padded past the pipe buffer, with a recognisable last entry. */
function bulkResults(count: number): unknown[] {
  const results = Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Result ${i}`,
    snippet: "s".repeat(200),
  }));
  results[results.length - 1].url = "https://example.com/LAST";
  return results;
}

describe("R405-2 large payloads survive process.exit() on a pipe", () => {
  test("a >64 KiB answer reaches stdout in full when the --out write fails (exit 3)", () => {
    const target = join(dir, `big-sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = runThroughPipe(
      1,
      ["ask", "q", "--out", target],
      agentResponse([MESSAGE_ITEM, { type: "search_results", results: bulkResults(400) }]),
      { sabotage: target },
    );
    assert.equal(r.status, 3);
    assert.ok(
      r.captured.length > PIPE_BUFFER_BYTES,
      `payload must exceed the pipe buffer to be a real test (got ${r.captured.length} bytes)`,
    );
    // The whole point: parseable, not cut at 65,536 bytes mid-string.
    const out = JSON.parse(r.captured);
    assert.equal(out.answer, "The answer.");
    assert.equal(out.search_results.length, 400);
    assert.equal(out.citations.at(-1), "https://example.com/LAST", "the tail must survive exit()");
  });

  test("a >64 KiB verbatim body reaches stderr in full when sources are unreadable (exit 1)", () => {
    const r = runThroughPipe(
      2,
      ["ask", "q"],
      agentResponse([MESSAGE_ITEM, { type: "search_results", items: bulkResults(400) }]),
    );
    assert.equal(r.status, 1);
    assert.ok(
      r.captured.length > PIPE_BUFFER_BYTES,
      `diagnostic must exceed the pipe buffer to be a real test (got ${r.captured.length} bytes)`,
    );
    assert.match(r.captured, /"results" is not an array/);
    assert.match(
      r.captured,
      /https:\/\/example\.com\/LAST/,
      "the body is the justification for hard-erroring — a truncated one is worthless",
    );
  });

  test("a >64 KiB successful answer is not truncated either (exit 0, no exit() involved)", () => {
    const r = runThroughPipe(
      1,
      ["ask", "q"],
      agentResponse([MESSAGE_ITEM, { type: "search_results", results: bulkResults(400) }]),
    );
    assert.equal(r.status, 0);
    assert.ok(r.captured.length > PIPE_BUFFER_BYTES);
    assert.equal(JSON.parse(r.captured).search_results.length, 400);
  });
});
