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
 * The two blocks below are direct regression guards for the round-404 review findings:
 *   R404-1 — a search_results item whose `results` is not an array used to yield `citations: []`
 *            and exit 0, filing an uncited answer as a successful cited one.
 *   R404-2 — a paid answer used to be discarded when the --out write failed, because the file
 *            was written before stdout and there was no pre-flight.
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
 */
const STUB_SOURCE = `
import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
  writeFileSync(process.env.__STUB_TOUCH, "called");
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
function run(args: string[], body: unknown, opts: { key?: string | null; status?: number } = {}): Run {
  const touch = join(dir, `touch-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __STUB_TOUCH: touch,
    __STUB_BODY: typeof body === "string" ? body : JSON.stringify(body),
    __STUB_STATUS: String(opts.status ?? 200),
    PERPLEXITY_API_KEY: opts.key === undefined ? "test-key-not-real" : (opts.key ?? ""),
  };
  if (opts.key === null) delete env.PERPLEXITY_API_KEY;

  const res = spawnSync(process.execPath, ["--import", stubUrl, SCRIPT, ...args], {
    encoding: "utf8",
    env,
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
  test("unwritable --out directory is caught BEFORE the request (exit 3, nothing sent)", () => {
    const r = run(["ask", "q", "--out", join(dir, "no-such-dir", "out.json")], agentResponse([MESSAGE_ITEM]));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "the pre-flight must run before any HTTP request");
    assert.match(r.stderr, /--out directory is not writable/);
  });

  test("a write failure after the request still leaves the result on stdout", () => {
    // The target is an existing, writable *directory*: it passes the W_OK pre-flight and then
    // fails at writeFileSync with EISDIR — the mid-run breakage the pre-flight cannot catch.
    const r = run(["ask", "q", "--out", dir], agentResponse([MESSAGE_ITEM]));
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
