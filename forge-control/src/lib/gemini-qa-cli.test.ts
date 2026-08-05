/**
 * Tests for scripts/gemini-qa.mjs — the video QA CLI.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Same approach as perplexity-cli.test.ts: the script is a standalone zero-dependency CLI
 * (02-architecture §6.1 forbids factoring its internals into an importable module), so it is
 * spawned as a real process with `globalThis.fetch` replaced by a `--import` preload. No
 * network, no key, no spend, and — since R702 — no traffic to the shared Gemini Pool, which
 * has four sessions serving other production work.
 *
 * HERMETIC BY CONSTRUCTION. Two preloads do the isolating:
 *   1. a `fetch` stub, which also records the request URL and headers so backend selection
 *      and credential routing can be asserted rather than assumed;
 *   2. an `fs` shim installed through a module `resolve` hook, which lets a test decide
 *      which key locations exist. That indirection is needed because this box really does
 *      have /opt/gemini-pool-api/.env — without it, the pool's exit-2 path could never be
 *      exercised here, only skipped. A `--import` preload that monkey-patches `fs` does NOT
 *      work: the script does `import { readFileSync } from "node:fs"`, and a named ESM
 *      import of a builtin is bound before any preload mutation is visible (measured).
 *
 * Regression guards for the round-405 review findings:
 *   R405-1 — with --out set, the QA JSON went ONLY to the file. A write fault after a billed
 *            generateContent call therefore destroyed a ~$5 result. stdout now always gets it
 *            first, exactly like emit() in scripts/perplexity.mjs.
 *   R405-2 — process.exit() after process.stdout.write() truncates at the 64 KiB pipe buffer.
 *   R405-3 — accessSync(dir, W_OK) succeeds on a directory, so `--out /tmp` used to pre-flight
 *            clean, upload, poll and bill before dying at writeFileSync with EISDIR.
 *
 * R702 adds the pool backend: backend selection and defaulting, the three-location pool key
 * resolution and its exit-2 message, free-text rubric extraction (fenced, chattered, bare,
 * truncated), rubric validation, and the pool's five distinct error-body shapes.
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

/** The api backend is no longer the default — these tests must ask for it explicitly. */
const API = ["--backend", "api"];

/** Pool key locations, in resolution order. Must match scripts/gemini-qa.mjs. */
const POOL_ENV_VAR = "GEMINI_POOL_API_KEY";
const POOL_SECRET_FILE = "/opt/ai-os/.secrets/store/gemini-pool-api-key";
const POOL_DOTENV_FILE = "/opt/gemini-pool-api/.env";

/**
 * Preload module: fake `fetch`, a touch file recording that a request happened, a record of
 * the request (URL + headers) for routing assertions, and the sabotage hook — mkdir at the
 * --out path at request time, i.e. strictly between the pre-flight and the write. That
 * window is the only one the pre-flight cannot close, and it is where the "a paid result is
 * never lost" guarantee has to hold.
 */
const STUB_SOURCE = `
import { writeFileSync, mkdirSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  writeFileSync(process.env.__STUB_TOUCH, "called");
  if (process.env.__STUB_RECORD) {
    writeFileSync(
      process.env.__STUB_RECORD,
      JSON.stringify({ url: String(url), headers: { ...(init?.headers ?? {}) } }),
    );
  }
  if (process.env.__STUB_SABOTAGE) mkdirSync(process.env.__STUB_SABOTAGE, { recursive: true });
  return new Response(process.env.__STUB_BODY ?? "{}", {
    status: Number(process.env.__STUB_STATUS ?? "200"),
    statusText: process.env.__STUB_STATUS_TEXT ?? "",
    headers: { "content-type": process.env.__STUB_CONTENT_TYPE ?? "application/json" },
  });
};
`;

/**
 * fs shim: real fs, except that __STUB_FS_MISSING paths throw ENOENT and __STUB_FS_FILES
 * paths return canned contents. Only these two knobs are simulated; everything else is the
 * genuine filesystem, so the --out pre-flight tests keep exercising real stat/access.
 */
const FS_SHIM_SOURCE = `
import * as real from "node:fs";
const missing = new Set(JSON.parse(process.env.__STUB_FS_MISSING ?? "[]"));
const files = JSON.parse(process.env.__STUB_FS_FILES ?? "{}");
export function readFileSync(path, ...rest) {
  const p = String(path);
  if (missing.has(p)) {
    const err = new Error(\`ENOENT: no such file or directory, open '\${p}'\`);
    err.code = "ENOENT";
    throw err;
  }
  if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
  return real.readFileSync(path, ...rest);
}
export const statSync = real.statSync;
export const accessSync = real.accessSync;
export const writeFileSync = real.writeFileSync;
export const writeSync = real.writeSync;
export const mkdirSync = real.mkdirSync;
export const constants = real.constants;
export default { ...real, readFileSync };
`;

/** Resolve hook redirecting "node:fs" to the shim — except for the shim's own import. */
const HOOKS_SOURCE = (shimUrl: string) => `
const SHIM = ${JSON.stringify(shimUrl)};
export async function resolve(specifier, context, next) {
  if ((specifier === "node:fs" || specifier === "fs") && context.parentURL !== SHIM) {
    return { url: SHIM, shortCircuit: true };
  }
  return next(specifier, context);
}
`;

const LOADER_SOURCE = (hooksUrl: string) => `
import { register } from "node:module";
register(${JSON.stringify(hooksUrl)});
`;

let dir = "";
let stubUrl = "";
let loaderUrl = "";
let videoPath = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-qa-cli-test-"));

  const stubPath = join(dir, "fetch-stub.mjs");
  writeFileSync(stubPath, STUB_SOURCE);
  stubUrl = pathToFileURL(stubPath).href;

  const shimPath = join(dir, "fs-shim.mjs");
  writeFileSync(shimPath, FS_SHIM_SOURCE);
  const shimUrl = pathToFileURL(shimPath).href;

  const hooksPath = join(dir, "fs-hooks.mjs");
  writeFileSync(hooksPath, HOOKS_SOURCE(shimUrl));
  const hooksUrl = pathToFileURL(hooksPath).href;

  const loaderPath = join(dir, "fs-loader.mjs");
  writeFileSync(loaderPath, LOADER_SOURCE(hooksUrl));
  loaderUrl = pathToFileURL(loaderPath).href;

  // A real local file for the pool backend, which refuses URL inputs. The bytes are never
  // sent anywhere — fetch is stubbed — but classifyInput() genuinely stats it and checks
  // the extension, so it has to exist, be non-empty and end in a known video suffix.
  videoPath = join(dir, "clip.mp4");
  writeFileSync(videoPath, "not really a video, and never leaves this box");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Run = {
  status: number;
  stdout: string;
  stderr: string;
  requested: boolean;
  record: { url: string; headers: Record<string, string> } | null;
};

type RunOpts = {
  key?: string | null;
  poolKey?: string | null;
  status?: number;
  statusText?: string;
  contentType?: string;
  sabotage?: string;
  fsMissing?: string[];
  fsFiles?: Record<string, string>;
};

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

/** The pool envelope: free text plus the account that answered. */
function poolEnvelope(text: string, account = "cdp-9400"): unknown {
  return { text, account };
}

function run(args: string[], body: unknown, opts: RunOpts = {}): Run {
  const suffix = Math.random().toString(36).slice(2);
  const touch = join(dir, `touch-${suffix}`);
  const record = join(dir, `record-${suffix}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    __STUB_TOUCH: touch,
    __STUB_RECORD: record,
    __STUB_BODY: typeof body === "string" ? body : JSON.stringify(body),
    __STUB_STATUS: String(opts.status ?? 200),
    GEMINI_API_KEY: opts.key === undefined ? "test-key-not-real" : (opts.key ?? ""),
    [POOL_ENV_VAR]: opts.poolKey === undefined ? "test-pool-key-not-real" : (opts.poolKey ?? ""),
  };
  if (opts.key === null) delete env.GEMINI_API_KEY;
  if (opts.poolKey === null) delete env[POOL_ENV_VAR];
  if (opts.statusText !== undefined) env.__STUB_STATUS_TEXT = opts.statusText;
  if (opts.contentType !== undefined) env.__STUB_CONTENT_TYPE = opts.contentType;
  if (opts.sabotage !== undefined) env.__STUB_SABOTAGE = opts.sabotage;
  if (opts.fsMissing !== undefined) env.__STUB_FS_MISSING = JSON.stringify(opts.fsMissing);
  if (opts.fsFiles !== undefined) env.__STUB_FS_FILES = JSON.stringify(opts.fsFiles);

  const preloads = ["--import", stubUrl];
  if (opts.fsMissing !== undefined || opts.fsFiles !== undefined) {
    preloads.push("--import", loaderUrl);
  }

  const res = spawnSync(process.execPath, [...preloads, SCRIPT, ...args], {
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
    record: existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null,
  };
}

/* ========================================================================== *
 * R702 — backend selection and defaulting
 * ========================================================================== */

describe("R702 backend selection", () => {
  test("the DEFAULT backend is pool: a local file goes to 127.0.0.1:8090/v1/analyze", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.record?.url,
      "http://127.0.0.1:8090/v1/analyze",
      "no --backend must mean the free pool, never the billed API",
    );
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("--backend api targets generativelanguage.googleapis.com instead", () => {
    const r = run([VIDEO_URL, ...API], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.record?.url ?? "", /^https:\/\/generativelanguage\.googleapis\.com/);
  });

  test("an unknown --backend value is a usage error, not a silent default", () => {
    const r = run([videoPath, "--backend", "gemini"], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /--backend must be "pool" or "api"/);
  });

  test("--backend=pool form is accepted", () => {
    const r = run([videoPath, "--backend=pool"], poolEnvelope(JSON.stringify(qaPayload())));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record?.url, "http://127.0.0.1:8090/v1/analyze");
  });
});

/* ========================================================================== *
 * R702 — flags that only one backend can honour are rejected, never ignored
 * ========================================================================== */

describe("R702 backend-specific flags", () => {
  test("--model on the pool backend is rejected (the pool cannot select a model)", () => {
    const r = run([videoPath, "--model", "gemini-omni-flash"], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "a rejected flag must cost no request");
    assert.match(r.stderr, /--model is not supported on the pool backend/);
  });

  test("--model on the api backend is honoured and reaches the URL", () => {
    const r = run([VIDEO_URL, ...API, "--model", "gemini-3.6-flash"], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.record?.url ?? "", /models\/gemini-3\.6-flash:generateContent/);
  });

  test("--timeout on the api backend is rejected", () => {
    const r = run([VIDEO_URL, ...API, "--timeout", "600"], envelope(qaPayload()));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--timeout applies to the pool backend only/);
  });

  test("--preflight on the api backend is rejected", () => {
    const r = run([VIDEO_URL, ...API, "--preflight"], envelope(qaPayload()));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /--preflight applies to the pool backend only/);
  });

  test("a non-numeric or zero --timeout is a usage error", () => {
    for (const bad of ["abc", "0", "-5", "12.5"]) {
      const r = run([videoPath, "--timeout", bad], poolEnvelope("{}"));
      assert.equal(r.status, 3, `--timeout ${bad} must be rejected`);
      assert.match(r.stderr, /--timeout must be a positive whole number/);
    }
  });

  test("--preflight makes an extra liveness call BEFORE the analysis call", () => {
    // The stub answers every request identically, so a preflight run that reaches the
    // rubric proves both calls were made and the /v1/chat response was accepted.
    const r = run([videoPath, "--preflight"], poolEnvelope(JSON.stringify(qaPayload())));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /pool preflight — POST http:\/\/127\.0\.0\.1:8090\/v1\/chat/);
    assert.match(r.stderr, /pool preflight ok/);
    assert.equal(r.record?.url, "http://127.0.0.1:8090/v1/analyze", "analysis must run second");
  });

  test("a failing preflight aborts before the video is uploaded", () => {
    const r = run([videoPath, "--preflight"], { detail: "Unauthorized" }, { status: 401 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pool preflight failed/);
    assert.doesNotMatch(r.stderr, /pool analyse/, "nothing may be uploaded after a dead probe");
  });
});

/* ========================================================================== *
 * R702 — URL inputs on the pool backend (the documented decision: reject)
 * ========================================================================== */

describe("R702 URL input handling", () => {
  test("a URL on the pool backend is a usage error naming the way out", () => {
    const r = run([VIDEO_URL], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "no download, no request");
    assert.match(r.stderr, /URL input is not supported on the pool backend/);
    assert.match(r.stderr, /--backend api/, "the error must name the backend that does accept URLs");
  });

  test("the same URL on the api backend is accepted", () => {
    const r = run([VIDEO_URL, ...API], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
  });
});

/* ========================================================================== *
 * R702 — pool key resolution: order, isolation from GEMINI_API_KEY, exit 2
 * ========================================================================== */

describe("R702 pool key resolution", () => {
  test("1st: GEMINI_POOL_API_KEY wins and is sent as x-api-key", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())), {
      poolKey: "from-env-wins",
      fsFiles: { [POOL_SECRET_FILE]: "from-secret-file", [POOL_DOTENV_FILE]: "GEMINI_API_KEY=from-dotenv\n" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record?.headers["x-api-key"], "from-env-wins");
  });

  test("2nd: the secret-store file is used when the env var is absent", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())), {
      poolKey: null,
      fsFiles: { [POOL_SECRET_FILE]: "from-secret-file\n", [POOL_DOTENV_FILE]: "GEMINI_API_KEY=from-dotenv\n" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record?.headers["x-api-key"], "from-secret-file", "trailing newline must be trimmed");
  });

  test("3rd: the GEMINI_API_KEY= line inside the pool's own .env is the last resort", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())), {
      poolKey: null,
      fsMissing: [POOL_SECRET_FILE],
      fsFiles: { [POOL_DOTENV_FILE]: "PORT=8090\nGEMINI_API_KEY=from-dotenv\nOTHER=x\n" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record?.headers["x-api-key"], "from-dotenv");
  });

  test("quoted and commented .env lines are handled without picking up the comment", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())), {
      poolKey: null,
      fsMissing: [POOL_SECRET_FILE],
      fsFiles: { [POOL_DOTENV_FILE]: '# GEMINI_API_KEY=commented-out\nGEMINI_API_KEY="quoted-value"\n' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.record?.headers["x-api-key"], "quoted-value");
  });

  test("THE NAMING TRAP: a Google GEMINI_API_KEY in the env is never used as the pool key", () => {
    // The env holds GEMINI_API_KEY (a Google key) but no GEMINI_POOL_API_KEY, and neither
    // pool file exists. The pool path must NOT borrow it — it must exit 2.
    const r = run([videoPath], poolEnvelope("{}"), {
      key: "a-real-google-ai-studio-key",
      poolKey: null,
      fsMissing: [POOL_SECRET_FILE, POOL_DOTENV_FILE],
    });
    assert.equal(r.status, 2, "borrowing the Google key for the pool would be a credential leak");
    assert.equal(r.requested, false);
  });

  test("exit 2 names ALL THREE locations and warns about the shared name", () => {
    const r = run([videoPath], poolEnvelope("{}"), {
      poolKey: null,
      fsMissing: [POOL_SECRET_FILE, POOL_DOTENV_FILE],
    });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false, "no key means no HTTP request at all");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(POOL_ENV_VAR));
    assert.match(r.stderr, new RegExp(POOL_SECRET_FILE.replace(/[/.]/g, "\\$&")));
    assert.match(r.stderr, new RegExp(POOL_DOTENV_FILE.replace(/[/.]/g, "\\$&")));
    assert.match(r.stderr, /NOT a Google AI\n\s+Studio key/);
  });

  test("an empty / key-less .env is treated as absent, not as an empty key", () => {
    const r = run([videoPath], poolEnvelope("{}"), {
      poolKey: null,
      fsMissing: [POOL_SECRET_FILE],
      fsFiles: { [POOL_DOTENV_FILE]: "PORT=8090\nGEMINI_API_KEY=\n" },
    });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false);
  });

  test("the api backend's exit 2 still names its own two locations", (t) => {
    if (existsSync(SECRET_FILE)) {
      t.skip(`${SECRET_FILE} exists on this box — the keyless path cannot be exercised`);
      return;
    }
    const r = run([VIDEO_URL, ...API], envelope(qaPayload()), { key: null });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /no Gemini API key found/);
    assert.match(r.stderr, /GEMINI_API_KEY/);
    assert.match(r.stderr, new RegExp(SECRET_FILE.replace(/[/.]/g, "\\$&")));
  });

  test("the pool key is never printed, on success or on failure", () => {
    const secret = "sk-pool-do-not-leak-me";
    const ok = run([videoPath], poolEnvelope(JSON.stringify(qaPayload())), { poolKey: secret });
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stderr + ok.stdout, new RegExp(secret));

    const bad = run([videoPath], { detail: "Unauthorized" }, { poolKey: secret, status: 401 });
    assert.equal(bad.status, 1);
    assert.doesNotMatch(bad.stderr + bad.stdout, new RegExp(secret));
  });
});

/* ========================================================================== *
 * R702 — free-text rubric extraction. The pool has no structured-output mode,
 * so this is the layer that turns prose into the frozen contract — or fails loudly.
 * ========================================================================== */

describe("R702 rubric extraction from free text", () => {
  const rubric = JSON.stringify(qaPayload());

  test("bare JSON with no fence", () => {
    const r = run([videoPath], poolEnvelope(rubric));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("a ```json fenced block", () => {
    const r = run([videoPath], poolEnvelope("```json\n" + rubric + "\n```"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).summary, "Watchable but loose in the middle.");
  });

  test("a bare ``` fence with no language tag", () => {
    const r = run([videoPath], poolEnvelope("```\n" + rubric + "\n```"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("a fenced block behind leading prose, with trailing commentary", () => {
    const chatty =
      "Sure! I watched the video carefully. Here is my QA report:\n\n" +
      "```json\n" +
      rubric +
      "\n```\n\nLet me know if you'd like me to look at anything else!";
    const r = run([videoPath], poolEnvelope(chatty));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
    assert.equal(JSON.parse(r.stdout).pacing.score, 5);
  });

  test("bare JSON behind leading prose (no fence at all)", () => {
    const r = run([videoPath], poolEnvelope("Here you go:\n" + rubric));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("braces inside string values do not truncate the object", () => {
    const tricky = qaPayload();
    (tricky.hook as Record<string, unknown>).notes = 'the caption reads "} end {" on screen';
    const r = run([videoPath], poolEnvelope("```json\n" + JSON.stringify(tricky) + "\n```"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hook.notes, 'the caption reads "} end {" on screen');
  });

  test("a TRUNCATED reply is exit 1 with the raw text verbatim — never repaired", () => {
    const cut = "```json\n" + rubric.slice(0, 120);
    const r = run([videoPath], poolEnvelope(cut));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "", "a half-parsed rubric must never reach stdout");
    assert.match(r.stderr, /did not return usable rubric JSON/);
    assert.match(r.stderr, /BEGIN RAW MODEL TEXT/);
    assert.ok(r.stderr.includes(cut), "the model's raw text is the diagnostic; it must be intact");
  });

  test("a reply with no JSON at all is exit 1 with the refusal shown verbatim", () => {
    const prose = "I'm sorry, I can't watch videos. Could you describe it to me instead?";
    const r = run([videoPath], poolEnvelope(prose));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no JSON object was found/);
    assert.ok(r.stderr.includes(prose));
  });

  test("an empty reply is exit 1", () => {
    const r = run([videoPath], poolEnvelope("   "));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the reply was empty/);
  });

  test("a JSON array instead of an object is exit 1", () => {
    const r = run([videoPath], poolEnvelope("```json\n[1,2,3]\n```"));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  });

  test("a pool envelope with no text field is exit 1", () => {
    const r = run([videoPath], { account: "cdp-9400" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no text field/);
  });

  test("the answering pool account is reported to stderr as a diagnostic", () => {
    const r = run([videoPath], poolEnvelope(rubric, "cdp-1234"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /answered by account cdp-1234/);
  });
});

/* ========================================================================== *
 * R702 — rubric validation. The frozen contract does not get looser because
 * the free backend produced it.
 * ========================================================================== */

describe("R702 rubric key validation", () => {
  test("a missing required key is exit 1, naming the key, with the raw text", () => {
    const partial = qaPayload();
    delete (partial as Record<string, unknown>).audio;
    delete (partial as Record<string, unknown>).top_fixes;
    const raw = "```json\n" + JSON.stringify(partial) + "\n```";
    const r = run([videoPath], poolEnvelope(raw));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "", "an incomplete rubric must not be emitted as if it were valid");
    assert.match(r.stderr, /missing required rubric keys: audio, top_fixes/);
    assert.match(r.stderr, /BEGIN RAW MODEL TEXT/);
  });

  test("the same validation applies on the api backend", () => {
    const partial = qaPayload();
    delete (partial as Record<string, unknown>).verdict;
    const r = run([VIDEO_URL, ...API], envelope(partial));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required rubric keys: verdict/);
  });

  test("every required key present is enough to pass", () => {
    const r = run([videoPath], poolEnvelope(JSON.stringify(qaPayload(3))));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).pacing.dead_spots.length, 3);
  });
});

/* ========================================================================== *
 * R702 — the pool's five distinct error-body shapes (round 701 §6).
 * A client that assumes `detail` is a string crashes on two of them.
 * ========================================================================== */

describe("R702 pool error shapes", () => {
  test("401 with a string detail — exit 1, status and body surfaced", () => {
    const r = run([videoPath], { detail: "Unauthorized" }, { status: 401, statusText: "Unauthorized" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pool analyse failed/);
    assert.match(r.stderr, /HTTP 401/);
    assert.match(r.stderr, /Unauthorized/);
  });

  test("422 with an ARRAY detail does not crash the client", () => {
    const body = {
      detail: [{ type: "missing", loc: ["header", "x-api-key"], msg: "Field required", input: null }],
    };
    const r = run([videoPath], body, { status: 422 });
    assert.equal(r.status, 1, "a 422 must be a clean exit, not an unhandled TypeError");
    assert.match(r.stderr, /request rejected/);
    assert.match(r.stderr, /Field required/);
  });

  test("413 with raw nginx HTML does not crash the client", () => {
    const html = "<html><head><title>413 Request Entity Too Large</title></head><body></body></html>";
    const r = run([videoPath], html, { status: 413, contentType: "text/html" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /response body is not JSON/);
    assert.ok(r.stderr.includes(html), "the HTML body is still shown verbatim");
  });

  test("503 is exit 4 with retry guidance — a distinct, retryable-later path", () => {
    const r = run([videoPath], { detail: "All sessions cooling down — try again shortly" }, { status: 503 });
    assert.equal(r.status, 4, "pool saturation is not the same failure as a broken request");
    assert.match(r.stderr, /pool unavailable/);
    assert.match(r.stderr, /60 s acquire window/);
    assert.match(r.stderr, /does not retry by itself/);
  });

  test("429 is exit 4 and names the ~300 s cooldown", () => {
    const r = run([videoPath], { detail: "Gemini rate limit — account cooling down" }, { status: 429 });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /300 s cooldown/);
  });

  test("500 is exit 1 and refuses to call itself temporary", () => {
    const body = {
      detail:
        "Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue.",
    };
    const r = run([videoPath], body, { status: 500 });
    assert.equal(r.status, 1, "an opaque 500 is NOT retryable — round 701 traced it to a 7.5-day outage");
    assert.match(r.stderr, /opaque by construction/);
    assert.match(r.stderr, /--preflight/, "the hint must tell the operator how to diagnose it");
    assert.ok(r.stderr.includes("1100"), "Google's error code must survive to stderr");
  });
});

/* ========================================================================== *
 * R405-1 — a billed QA result must never live only in a file that may fail
 * ========================================================================== */

describe("R405-1 --out never diverts the result away from stdout", () => {
  test("without --out the rubric goes to stdout", () => {
    const r = run([VIDEO_URL, ...API], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work");
  });

  test("with --out the rubric goes to BOTH stdout and the file, byte for byte", () => {
    const target = join(dir, "qa.json");
    const r = run([VIDEO_URL, ...API, "--out", target], envelope(qaPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work", "--out must not empty stdout");
    assert.equal(readFileSync(target, "utf8"), r.stdout);
    assert.match(r.stderr, /QA JSON written to .*qa\.json \(and to stdout\)/);
  });

  test("a write failure after generateContent still leaves the paid result on stdout", () => {
    // Genuine mid-run breakage: the path passes the pre-flight, then the stub turns it into a
    // directory at request time, so writeFileSync hits EISDIR after the call is billed.
    const target = join(dir, `sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = run([VIDEO_URL, ...API, "--out", target], envelope(qaPayload()), { sabotage: target });
    assert.equal(r.status, 3, "a local write fault is exit 3, never 1 — a retry must not re-pay");
    assert.equal(r.requested, true);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work", "the ~$5 result must survive");
    assert.match(r.stderr, /writing --out .* failed/);
    assert.match(r.stderr, /NOT lost/);
  });

  test("the same guarantee holds on the pool backend", () => {
    const target = join(dir, `pool-sabotaged-${Math.random().toString(36).slice(2)}.json`);
    const r = run([videoPath, "--out", target], poolEnvelope(JSON.stringify(qaPayload())), {
      sabotage: target,
    });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).verdict, "needs_work", "a slow free result is still a result");
    assert.match(r.stderr, /NOT lost/);
  });
});

/* ========================================================================== *
 * R405-3 — the pre-flight must reject a directory before anything is billed
 * ========================================================================== */

describe("R405-3 --out pre-flight rejects a directory", () => {
  test("an existing directory as --out is caught BEFORE any request", () => {
    const r = run([VIDEO_URL, ...API, "--out", dir], envelope(qaPayload()));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "accessSync(dir, W_OK) passes — statSync must catch it first");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--out target is a directory, not a file/);
  });

  test("a missing --out directory is caught BEFORE any request", () => {
    const r = run(
      [VIDEO_URL, ...API, "--out", join(dir, "no-such-dir", "qa.json")],
      envelope(qaPayload()),
    );
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /--out directory is not usable/);
    assert.match(r.stderr, /ENOENT/);
  });

  test("the pool backend pre-flights --out before uploading a video too", () => {
    const r = run([videoPath, "--out", dir], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "a bad --out must cost neither an upload nor a pool session");
    assert.match(r.stderr, /--out target is a directory, not a file/);
  });

  test("a missing key outranks the --out pre-flight (exit 2, not 3)", (t) => {
    if (existsSync(SECRET_FILE)) {
      t.skip(`${SECRET_FILE} exists on this box — the keyless path cannot be exercised`);
      return;
    }
    const r = run([VIDEO_URL, ...API, "--out", dir], envelope(qaPayload()), { key: null });
    assert.equal(r.status, 2);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /no Gemini API key found/);
  });
});

/* ========================================================================== *
 * Input validation, shared by both backends
 * ========================================================================== */

describe("input validation", () => {
  test("no argument at all is a usage error", () => {
    const r = run([], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /missing <video-path-or-url>/);
  });

  test("an unknown flag is a usage error", () => {
    const r = run([videoPath, "--turbo"], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /unknown flag: --turbo/);
  });

  test("an unsupported extension is rejected before any request", () => {
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "hello");
    const r = run([txt], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /unsupported video extension/);
  });

  test("a missing input file is rejected before any request", () => {
    const r = run([join(dir, "nope.mp4")], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /cannot read input/);
  });

  test("an empty input file is rejected before any request", () => {
    const empty = join(dir, "empty.mp4");
    writeFileSync(empty, "");
    const r = run([empty], poolEnvelope("{}"));
    assert.equal(r.status, 3);
    assert.equal(r.requested, false);
    assert.match(r.stderr, /input file is empty/);
  });

  test("--help exits 0 and documents both backends and all five exit codes", () => {
    const r = run(["--help"], poolEnvelope("{}"));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--backend pool\|api/);
    assert.match(r.stdout, /URLs and the pool backend/);
    assert.match(r.stdout, /GEMINI_POOL_API_KEY/);
    assert.match(r.stdout, /4  pool busy or rate-limited/);
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
    [POOL_ENV_VAR]: "test-pool-key-not-real",
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
    const r = runThroughPipe(1, [VIDEO_URL, ...API, "--out", target], envelope(qaPayload(400)), {
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
    const r = runThroughPipe(2, [VIDEO_URL, ...API], hugeError, { status: 400 });
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
    const r = runThroughPipe(1, [VIDEO_URL, ...API], envelope(qaPayload(400)));
    assert.equal(r.status, 0);
    assert.ok(r.captured.length > PIPE_BUFFER_BYTES);
    assert.equal(JSON.parse(r.captured).pacing.dead_spots.length, 400);
  });

  test("a >64 KiB raw pool reply reaches stderr verbatim when it will not parse (exit 1)", () => {
    // The pool's failure diagnostic IS the model's raw text. If that is cut at 64 KiB, a
    // long chatty non-answer becomes undiagnosable.
    const rambling = "I cannot produce JSON. ".repeat(4_000);
    const r = runThroughPipe(2, [videoPath], poolEnvelope(rambling));
    assert.equal(r.status, 1);
    assert.ok(
      r.captured.length > PIPE_BUFFER_BYTES,
      `diagnostic must exceed the pipe buffer to be a real test (got ${r.captured.length} bytes)`,
    );
    assert.match(r.captured, /BEGIN RAW MODEL TEXT/);
    assert.match(r.captured, /END RAW MODEL TEXT/);
    assert.ok(r.captured.includes(rambling), "the raw reply must survive exit() in full");
  });
});
