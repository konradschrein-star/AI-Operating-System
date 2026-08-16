/**
 * Tests for scripts/perplexity.mjs — the researcher lane's Perplexity helper.
 *
 * Run: pnpm test   (node:test via tsx, no test framework dependency)
 *
 * NO NETWORK, NO BROWSER, NO X DISPLAY is ever a precondition of this suite, and that is
 * enforced structurally rather than by discipline:
 *
 *  - The pure logic (argv/backend parsing, the answer+citation parser, the bot-wall classifier,
 *    the streaming-settled rule, screenshot path/URL construction, the needs-login payload) is
 *    imported straight from the .mjs. Since R702 the script runs main() only behind an isMain()
 *    inode check, so importing it parses no argv, resolves no key and launches nothing.
 *  - The API backend's CLI contract is exercised by spawning the real script with a `--import`
 *    preload that replaces globalThis.fetch before the script's first line runs.
 *  - The BROWSER backend is never spawned. Its DOM harvest is represented by a committed capture
 *    fixture (fixtures/perplexity-answer-capture.json); everything downstream of the harvest is
 *    pure and tested against that fixture. Its provenance is stated inside the file.
 *
 * The blocks below are direct regression guards for the findings that produced them:
 *   R404-1 — a search_results item whose `results` is not an array used to yield `citations: []`
 *            and exit 0, filing an uncited answer as a successful cited one.
 *   R404-2 — a paid answer used to be discarded when the --out write failed, because the file
 *            was written before stdout and there was no pre-flight.
 *   R405-2 — process.exit() after process.stdout.write() truncates at the 64 KiB pipe buffer,
 *            so both guarantees above silently evaporated on any payload big enough to matter.
 *   R405-3 — accessSync(dir, W_OK) succeeds on a directory, so `--out /tmp` used to reach the
 *            (billed) request and fail at writeFileSync with EISDIR.
 *   R702   — the browser backend became the default, so every API-backend case below had to say
 *            `--backend api` explicitly. A test that forgot to would launch Chrome.
 *   R776   — the ranking flipped back: `api` is the default for BOTH modes, because
 *            perplexity.ai answers this host with 403 while api.perplexity.ai answers 401.
 *            The explicit `--backend api` injection from R702 STAYS — it is a structural guard,
 *            not a consequence of the default, and it must survive any future re-rank. What
 *            changed here is the mirror image: every case that exercises BROWSER behaviour now
 *            says `--backend browser` explicitly, and the browser path is asserted to be still
 *            reachable rather than assumed because it was the default.
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
const SCRIPT_URL = new URL("../../../scripts/perplexity.mjs", import.meta.url).href;
const HARNESS_URL = new URL("../../../scripts/research-browser.mjs", import.meta.url).href;
const FIXTURE_URL = new URL("./fixtures/perplexity-answer-capture.json", import.meta.url);
const SECRET_FILE = "/opt/ai-os/.secrets/store/perplexity-api-key";

/* -------------------------------------------------------------------------- *
 * The shape of what the scripts export for testing
 * -------------------------------------------------------------------------- */

interface CaptureLink {
  href: string;
  text?: string;
  title?: string;
  region?: string;
  order?: number;
  citation_index?: number | null;
}

interface Capture {
  url?: string;
  title?: string;
  answer: { selector: string; text: string } | null;
  answer_candidates_tried?: { selector: string; result: string }[];
  sources_region_selector?: string | null;
  streaming?: boolean;
  links: CaptureLink[];
  page_text_excerpt?: string;
}

interface ParsedSource {
  url: string;
  title: string;
  citation_index: number | null;
  region: string;
}

interface ParsedCapture {
  answer: string;
  sources: ParsedSource[];
  sources_strategy: string;
  answer_selector: string | null;
  dropped: { internal: number; non_http: number; duplicate: number };
}

interface ParsedArgs {
  help?: boolean;
  mode?: string;
  subject?: string;
  backend?: string;
  backendExplicit?: boolean;
  profile?: string;
  runId?: string;
  label?: string;
  answerTimeoutMs?: number;
  challengeTimeoutMs?: number;
  allowUncited?: boolean;
  dumpCapture?: string;
  keepOpen?: boolean;
  model?: string;
  maxResults?: number;
  out?: string;
}

interface ScreenshotRecord {
  label: string;
  path: string;
  url: string;
  url_servable: boolean;
}

interface NeedsLoginPayload {
  backend: string;
  needs_login: boolean;
  question: string;
  answer: null;
  citations: string[];
  sources: unknown[];
  search_results: unknown[];
  reason: string;
  screenshots: ScreenshotRecord[];
  reminder: unknown;
  login: unknown;
  takeover: unknown;
  next_steps: string[];
  profile: { name: string; dir: string };
  run_id: string;
  lock_actions: unknown[];
}

interface PerplexityCli {
  EXIT: Readonly<Record<string, number>>;
  BACKENDS: string[];
  DEFAULT_PROFILE: string;
  DEFAULT_ANSWER_TIMEOUT_MS: number;
  BOT_CHALLENGE_TIMEOUT_MS: number;
  SELECTORS: Record<string, unknown>;
  STABLE_SAMPLES: number;
  parseArgs(argv: string[]): ParsedArgs;
  parseAnswerCapture(capture: unknown, opts?: { allowUncited?: boolean }): ParsedCapture;
  normaliseSourceUrl(raw: string): string | null;
  isPerplexityInternal(raw: string): boolean;
  detectBotWall(input: { title?: string; text?: string }): string | null;
  isSettled(samples: { length: number; streaming: boolean }[], stable?: number): boolean;
  searchUrl(question: string): string;
  screenshotFor(runId: string, label: string, date?: Date): ScreenshotRecord;
  needsLoginPayload(input: Record<string, unknown>): NeedsLoginPayload;
}

interface Harness {
  EXIT: Readonly<Record<string, number>>;
}

// Importing must launch nothing — that is itself part of the contract being tested.
const px = (await import(SCRIPT_URL)) as PerplexityCli;
const rb = (await import(HARNESS_URL)) as Harness;
const FIXTURE = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Capture;

/** A fresh, independent copy of the fixture — every mutation test gets its own. */
const fixture = (): Capture => structuredClone(FIXTURE);

/** Assert that a call throws, and hand the message back for content assertions. */
function throwsWith(fn: () => unknown): { code: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: number; message: string };
    return { code: e.code ?? -1, message: e.message };
  }
  assert.fail("expected a throw, got a value");
}

/* ========================================================================== *
 * Spawn harness for the API backend (unchanged in spirit since R404)
 * ========================================================================== */

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

/**
 * Spawn the CLI with a stubbed fetch. `body` is what the fake API returns.
 *
 * SACRED (R702, reaffirmed R776): `--backend api` is injected for every `ask` case. `api` is the
 * default again, so this injection is currently redundant — KEEP IT ANYWAY. It is the structural
 * reason no spawned test can start Chrome, and it must not depend on which way the default
 * happens to point. A spawned test must never be one forgotten flag away from launching a
 * browser. Cases that genuinely want the browser path pass `raw: true` and say so explicitly.
 */
function run(
  args: string[],
  body: unknown,
  opts: { key?: string | null; status?: number; sabotage?: string; raw?: boolean } = {},
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

  const full =
    opts.raw === true || args[0] !== "ask"
      ? args
      : [args[0], args[1], "--backend", "api", ...args.slice(2)];

  const res = spawnSync(process.execPath, ["--import", stubUrl, SCRIPT, ...full], {
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
 * R702-A — backend selection and defaulting
 *
 * R702 made `ask` reach the browser without anyone typing a flag, because Konrad has no
 * Perplexity API key and will not buy one. R776 re-ranked the two on new evidence: the consumer
 * site 403s this host's egress IP while the API host answers 401, so the R702 default was the
 * only path that cannot complete from here. `api` is now the default for BOTH modes; the browser
 * backend is unchanged, still fully reachable, and still the only path for logged-in work.
 * ========================================================================== */

describe("R702-A backend selection", () => {
  test("ask defaults to the api backend (R776 re-rank)", () => {
    const opts = px.parseArgs(["ask", "what changed in node 22"]);
    assert.equal(opts.backend, "api");
    assert.equal(opts.backendExplicit, false);
    assert.equal(opts.profile, px.DEFAULT_PROFILE, "the shared research profile from R701");
  });

  test("--backend api selects the API path and is recorded as explicit", () => {
    const opts = px.parseArgs(["ask", "q", "--backend", "api"]);
    assert.equal(opts.backend, "api");
    assert.equal(opts.backendExplicit, true);
  });

  test("--backend browser is still accepted and still resolves to the browser path", () => {
    // R776 demoted the browser backend to a documented fallback. Demoted is not removed: this is
    // the guard that the re-rank did not quietly amputate the path it stopped defaulting to.
    const opts = px.parseArgs(["ask", "q", "--backend", "browser"]);
    assert.equal(opts.backend, "browser");
    assert.equal(opts.backendExplicit, true, "an explicit choice must be recorded as one");
    assert.equal(opts.profile, px.DEFAULT_PROFILE, "it still routes through the shared profile");
    // Browser-only flags are accepted here and nowhere else — proof the whole browser flag
    // surface is still wired to this backend, not just the string.
    const full = px.parseArgs([
      "ask", "q", "--backend", "browser",
      "--allow-uncited", "--keep-open", "--label", "fallback-check",
    ]);
    assert.equal(full.backend, "browser");
    assert.equal(full.allowUncited, true);
    assert.equal(full.keepOpen, true);
    assert.equal(full.label, "fallback-check");
  });

  test("an unknown backend is a usage error naming the valid ones", () => {
    const err = throwsWith(() => px.parseArgs(["ask", "q", "--backend", "curl"]));
    assert.equal(err.code, px.EXIT.USAGE);
    assert.match(err.message, /--backend must be one of browser \| api/);
  });

  test("search stays on the API backend and refuses a browser one", () => {
    assert.equal(px.parseArgs(["search", "q"]).backend, "api");
    const err = throwsWith(() => px.parseArgs(["search", "q", "--backend", "browser"]));
    assert.equal(err.code, px.EXIT.USAGE);
    assert.match(err.message, /no browser backend/);
  });

  test("api-only flags are rejected on the browser backend instead of silently ignored", () => {
    // The danger this guards: a caller passes --model, believes they chose a model, and gets a
    // browser answer from whatever Perplexity's web UI felt like using.
    // R776: --backend browser is explicit now that api is the default.
    const err = throwsWith(() =>
      px.parseArgs(["ask", "q", "--backend", "browser", "--model", "perplexity/sonar"]),
    );
    assert.equal(err.code, px.EXIT.USAGE);
    assert.match(err.message, /--model only appl/);
    assert.match(err.message, /--backend browser/);
  });

  test("browser-only flags are rejected on the api backend", () => {
    const err = throwsWith(() =>
      px.parseArgs(["ask", "q", "--backend", "api", "--allow-uncited"]),
    );
    assert.equal(err.code, px.EXIT.USAGE);
    assert.match(err.message, /--allow-uncited only appl/);
  });

  test("--profile is validated against the harness's profile grammar", () => {
    assert.equal(px.parseArgs(["ask", "q", "--profile", "research-2"]).profile, "research-2");
    const err = throwsWith(() => px.parseArgs(["ask", "q", "--profile", "../escape"]));
    assert.equal(err.code, px.EXIT.USAGE);
    assert.match(err.message, /invalid --profile/);
  });

  test("--answer-timeout is bounded, not silently clamped", () => {
    // R776: browser-only flag, so the backend is explicit now that api is the default.
    const B = ["ask", "q", "--backend", "browser"];
    assert.equal(px.parseArgs([...B, "--answer-timeout", "30000"]).answerTimeoutMs, 30_000);
    assert.match(
      throwsWith(() => px.parseArgs([...B, "--answer-timeout", "1"])).message,
      /must be between 5000 and 900000/,
    );
    assert.match(
      throwsWith(() => px.parseArgs([...B, "--answer-timeout", "10s"])).message,
      /non-negative integer/,
    );
  });

  test("--challenge-timeout is a browser-only flag, bounded the same way", () => {
    // Added after the first real run (2026-08-05) found perplexity.ai edge-blocking this host:
    // the interstitial wait had to become an operator lever rather than a constant. It is still
    // browser-only — on --backend api there is no page to be challenged.
    const B = ["ask", "q", "--backend", "browser"];
    assert.equal(
      px.parseArgs(B).challengeTimeoutMs,
      px.BOT_CHALLENGE_TIMEOUT_MS,
      "the default must come from the exported constant, not a second literal",
    );
    assert.equal(px.parseArgs([...B, "--challenge-timeout", "20000"]).challengeTimeoutMs, 20_000);
    assert.match(
      throwsWith(() => px.parseArgs([...B, "--challenge-timeout", "600001"])).message,
      /must be between 5000 and 600000/,
    );
    const onApi = throwsWith(() =>
      px.parseArgs(["ask", "q", "--backend", "api", "--challenge-timeout", "20000"]),
    );
    assert.equal(onApi.code, px.EXIT.USAGE);
    assert.match(onApi.message, /--challenge-timeout only appl/);
  });
});

/* ========================================================================== *
 * R702-B — argv / usage / exit-code contract
 * ========================================================================== */

describe("R702-B argv and exit-code contract", () => {
  test("the needs-login code is the SAME number the harness uses", () => {
    // If these ever diverge, a caller that learned "4 means a human must log in" from
    // research-browser.mjs would read a perplexity.mjs wall as an API error. The script asserts
    // this at import time too; this test is the visible statement of the contract.
    assert.equal(px.EXIT.NEEDS_LOGIN, rb.EXIT.LOGIN_REQUIRED);
    assert.equal(px.EXIT.NEEDS_LOGIN, 4);
  });

  test("the documented codes are exactly 0/1/2/3/4", () => {
    assert.deepEqual(px.EXIT, { OK: 0, API: 1, PREREQ: 2, USAGE: 3, NEEDS_LOGIN: 4 });
  });

  test("--help exits 0 and documents the api-first default, the fallback and the needs-login code", () => {
    const r = run(["--help"], {}, { raw: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Default backend: api/);
    // The re-rank is only honest if --help says the browser path still exists and why it is not
    // the default — a bare "Default backend: api" would read as "the browser backend is gone".
    assert.match(r.stdout, /--backend browser\|api\s+Default: api/);
    assert.match(r.stdout, /FALLBACK/);
    assert.match(r.stdout, /403/, "--help must name the edge block that demoted the browser path");
    assert.match(r.stdout, /4\s+NEEDS LOGIN/);
    assert.match(r.stdout, /No password is stored anywhere/);
    assert.equal(r.requested, false, "--help must not send anything");
  });

  test("no mode, unknown mode and a missing subject are usage errors that cost nothing", () => {
    for (const argv of [[], ["explain"], ["ask"], ["ask", "   "]]) {
      const r = run(argv, {}, { raw: true });
      assert.equal(r.status, 3, `argv ${JSON.stringify(argv)} should be a usage error`);
      assert.equal(r.requested, false);
      assert.match(r.stderr, /usage error:/);
    }
  });

  test("an unknown option is a usage error, never ignored", () => {
    const r = run(["ask", "q", "--turbo"], {}, { raw: true });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /unknown option "--turbo"/);
    assert.equal(r.requested, false);
  });

  test("a browser-backend run never reaches the API even with a key present", () => {
    // `--dump-capture` into an unwritable directory fails the pre-flight, which happens after
    // the key gate and before any launch. If the browser path were secretly calling fetch, the
    // stub touch file would exist. R776: `--backend browser` is explicit now that api defaults —
    // without it this would exercise the api path and prove nothing about the browser one.
    const r = run(
      ["ask", "q", "--backend", "browser", "--dump-capture", join(dir, "no-such-dir", "cap.json")],
      {},
      { raw: true },
    );
    assert.equal(r.status, 3);
    assert.equal(r.requested, false, "the browser backend must not call the Perplexity API");
    assert.match(r.stderr, /--dump-capture directory is not usable/);
  });
});

/* ========================================================================== *
 * R702-C — answer + citation parsing, against the committed fixture
 * ========================================================================== */

describe("R702-C parseAnswerCapture against the saved fixture", () => {
  test("the fixture yields the answer and its de-duplicated sources", () => {
    const parsed = px.parseAnswerCapture(fixture());
    assert.match(parsed.answer, /^Node\.js 22 ships the require\(esm\) interop/);
    assert.equal(parsed.answer_selector, '[data-testid="answer"]');
    assert.equal(parsed.sources_strategy, "sources-region");
    assert.deepEqual(
      parsed.sources.map((s) => s.url),
      [
        "https://nodejs.org/en/blog/announcements/v22-release-announce",
        "https://v8.dev/blog/maglev",
        "https://github.com/nodejs/release#release-schedule",
      ],
    );
    assert.equal(parsed.dropped.duplicate, 1, "the trailing-slash twin must collapse into one");
    assert.equal(parsed.sources[0].title, "nodejs.org");
    assert.equal(parsed.sources[1].title, "Maglev - V8's Fastest Optimizing JIT");
  });

  test("perplexity.ai's own links are never filed as sources", () => {
    const urls = px.parseAnswerCapture(fixture()).sources.map((s) => s.url);
    assert.ok(!urls.some((u) => u.includes("perplexity.ai")), urls.join(" "));
  });

  test("with the sources strip gone it falls to numbered citations, in citation order", () => {
    // The realistic rot: the wrapper div's test id disappears in a redesign, but the inline
    // [1][2][3] anchors survive because they are what the answer text points at.
    const cap = fixture();
    cap.sources_region_selector = null;
    for (const link of cap.links) if (link.region === "sources") link.region = "content";
    const parsed = px.parseAnswerCapture(cap);
    assert.equal(parsed.sources_strategy, "numbered-citations");
    assert.deepEqual(
      parsed.sources.map((s) => s.citation_index),
      [1, 2, 3],
    );
    assert.equal(parsed.sources[0].url, "https://nodejs.org/en/blog/announcements/v22-release-announce");
  });

  test("with neither hook it falls to external anchors under the content root", () => {
    const cap = fixture();
    cap.sources_region_selector = null;
    for (const link of cap.links) {
      link.region = "content";
      link.citation_index = null;
    }
    const parsed = px.parseAnswerCapture(cap);
    assert.equal(parsed.sources_strategy, "content-external-anchors");
    assert.equal(parsed.sources.length, 3);
    assert.equal(parsed.dropped.internal, 2, "both perplexity.ai links");
    assert.equal(parsed.dropped.non_http, 2, "mailto: and the relative /library href");
  });

  test("a rotted answer selector is a hard error naming every candidate tried", () => {
    const cap = fixture();
    cap.answer = null;
    cap.answer_candidates_tried = [
      { selector: '[data-testid="answer"]', result: "no element matched" },
      { selector: "main article", result: "matched an element with no text" },
    ];
    const err = throwsWith(() => px.parseAnswerCapture(cap));
    assert.equal(err.code, px.EXIT.API);
    assert.match(err.message, /no answer could be extracted/);
    assert.match(err.message, /THE SELECTOR TABLE HAS ROTTED/);
    assert.match(err.message, /\[data-testid="answer"\] — no element matched/);
    assert.match(err.message, /main article — matched an element with no text/);
    // The page excerpt is what tells a human whether the page was an answer at all.
    assert.match(err.message, /What changed in Node 22/);
  });

  test("an answer that is only whitespace is treated as no answer", () => {
    const cap = fixture();
    cap.answer = { selector: '[data-testid="answer"]', text: "   \n\t " };
    assert.match(throwsWith(() => px.parseAnswerCapture(cap)).message, /no answer could be extracted/);
  });

  test("zero extractable sources is an error, NOT an uncited answer", () => {
    const cap = fixture();
    cap.links = cap.links.filter((l) => !/^https?:/.test(l.href) || l.href.includes("perplexity.ai"));
    const err = throwsWith(() => px.parseAnswerCapture(cap));
    assert.equal(err.code, px.EXIT.API);
    assert.match(err.message, /ZERO sources/);
    assert.match(err.message, /--allow-uncited/);
  });

  test("--allow-uncited accepts it explicitly, and says which strategy found nothing", () => {
    const cap = fixture();
    cap.links = [];
    const parsed = px.parseAnswerCapture(cap, { allowUncited: true });
    assert.deepEqual(parsed.sources, []);
    assert.equal(parsed.sources_strategy, "none");
    assert.ok(parsed.answer.length > 0, "the answer itself is still returned");
  });

  test("a capture that is not an object is refused rather than coerced", () => {
    assert.match(throwsWith(() => px.parseAnswerCapture(null)).message, /not an object/);
    assert.match(throwsWith(() => px.parseAnswerCapture("{}")).message, /not an object/);
  });
});

describe("R702-C url helpers", () => {
  test("normaliseSourceUrl collapses trailing slashes and fragments, keeps the query", () => {
    assert.equal(px.normaliseSourceUrl("https://a.example/x/"), "https://a.example/x");
    assert.equal(px.normaliseSourceUrl("https://A.Example/x#frag"), "https://a.example/x");
    assert.equal(px.normaliseSourceUrl("https://a.example/s?q=1"), "https://a.example/s?q=1");
  });

  test("non-absolute and non-http hrefs are not sources", () => {
    for (const href of ["/library", "mailto:x@y.z", "javascript:void(0)", "#top", ""]) {
      assert.equal(px.normaliseSourceUrl(href), null, href);
    }
  });

  test("isPerplexityInternal matches the apex and its subdomains only", () => {
    assert.equal(px.isPerplexityInternal("https://www.perplexity.ai/x"), true);
    assert.equal(px.isPerplexityInternal("https://perplexity.ai/"), true);
    assert.equal(px.isPerplexityInternal("https://notperplexity.ai/"), false);
    assert.equal(px.isPerplexityInternal("https://perplexity.ai.evil.example/"), false);
  });

  test("searchUrl encodes the question rather than concatenating it", () => {
    assert.equal(
      px.searchUrl('node 22 & "esm"'),
      "https://www.perplexity.ai/search?q=node%2022%20%26%20%22esm%22",
    );
  });
});

/* ========================================================================== *
 * R702-D — the needs-login exit path
 *
 * The expected FIRST-RUN outcome, and therefore the one that must never look like a crash.
 * ========================================================================== */

describe("R702-D needs-login", () => {
  const harnessStatus = {
    takeover: {
      novnc_port: 6937,
      novnc_url: "http://127.0.0.1:6937/vnc.html?autoconnect=1&resize=scale",
      ssh_tunnel: "ssh -N -L 6937:127.0.0.1:6937 root@65.108.6.149",
    },
    reminder: { queued: true, id: "rem_1", when: "in 5m" },
    login: { needs_login: true, decision: "logged-out-selector", reasons: ["a[href*=\"/sign-in\"]"] },
    screenshots: [
      {
        label: "perplexity-login-wall",
        path: "/opt/ai-os/uploads/148ae1fd8f65/20260805T101530Z-perplexity-login-wall.png",
        url: "/api/uploads/148ae1fd8f65/20260805T101530Z-perplexity-login-wall.png",
        url_servable: true,
      },
    ],
  };

  const payload = (): NeedsLoginPayload =>
    px.needsLoginPayload({
      opts: { subject: "what changed in node 22", profile: "perplexity" },
      runInfo: { runId: "148ae1fd8f65", source: "flag" },
      screenshots: [
        {
          label: "perplexity-login-wall-seen",
          path: "/opt/ai-os/uploads/148ae1fd8f65/20260805T101529Z-perplexity-login-wall-seen.png",
          url: "/api/uploads/148ae1fd8f65/20260805T101529Z-perplexity-login-wall-seen.png",
          url_servable: true,
        },
      ],
      reason: "logged-out-selector: a[href*=\"/sign-in\"]",
      harnessStatus,
      harnessAuth: null,
    });

  test("no answer is presented, in any field, when a login is needed", () => {
    const p = payload();
    assert.equal(p.needs_login, true);
    assert.equal(p.answer, null, "explicitly null, never omitted and never an empty-string answer");
    assert.deepEqual(p.citations, []);
    assert.deepEqual(p.sources, []);
    assert.deepEqual(p.search_results, []);
  });

  test("the harness's reminder and takeover details are surfaced, not re-derived", () => {
    const p = payload();
    assert.deepEqual(p.reminder, harnessStatus.reminder);
    assert.deepEqual(p.takeover, harnessStatus.takeover);
    assert.deepEqual(p.login, harnessStatus.login);
  });

  test("both this tool's screenshot and the harness's wall shot are listed", () => {
    const p = payload();
    assert.equal(p.screenshots.length, 2);
    assert.deepEqual(
      p.screenshots.map((s) => s.label),
      ["perplexity-login-wall-seen", "perplexity-login-wall"],
    );
    for (const shot of p.screenshots) {
      assert.match(shot.path, /^\/opt\/ai-os\/uploads\/148ae1fd8f65\//);
      assert.match(shot.url, /^\/api\/uploads\/148ae1fd8f65\//);
    }
  });

  test("the next steps are the tunnel, the noVNC URL, a manual login, and a re-run", () => {
    const steps = payload().next_steps;
    assert.equal(steps.length, 4);
    assert.match(steps[0], /ssh -N -L 6937:127\.0\.0\.1:6937/);
    assert.match(steps[1], /http:\/\/127\.0\.0\.1:6937\/vnc\.html/);
    assert.match(steps[2], /BY HAND/);
    assert.match(steps[3], /No password is stored anywhere/);
    assert.match(steps[3], /\/opt\/ai-os\/browser-profiles\/perplexity/);
  });

  test("a harness that reported no noVNC port still yields usable instructions", () => {
    // Degraded input must not produce `undefined` in a message a human is meant to follow.
    const p = px.needsLoginPayload({
      opts: { subject: "q", profile: "perplexity" },
      runInfo: { runId: "148ae1fd8f65", source: "env:FORGE_RUN_ID" },
      screenshots: [],
      reason: "a login handshake is already in flight for this profile",
      harnessStatus: null,
      harnessAuth: { needs_login: true, decision: "logged-out-selector" },
    });
    assert.equal(p.reminder, null);
    assert.deepEqual(p.login, { needs_login: true, decision: "logged-out-selector" });
    for (const step of p.next_steps) assert.ok(!step.includes("undefined"), step);
    assert.match(p.next_steps[0], /reminder/i);
  });
});

/* ========================================================================== *
 * R702-E — screenshot path and URL construction
 * ========================================================================== */

describe("R702-E screenshot paths", () => {
  const AT = new Date("2026-08-05T10:15:30.123Z");

  test("path and URL follow the harness's uploads convention", () => {
    const shot = px.screenshotFor("148ae1fd8f65", "perplexity-answer", AT);
    assert.equal(shot.path, "/opt/ai-os/uploads/148ae1fd8f65/20260805T101530Z-perplexity-answer.png");
    assert.equal(shot.url, "/api/uploads/148ae1fd8f65/20260805T101530Z-perplexity-answer.png");
    assert.equal(shot.url_servable, true);
    assert.equal(shot.label, "perplexity-answer");
  });

  test("labels are sanitised so the URL is always valid", () => {
    const shot = px.screenshotFor("148ae1fd8f65", "Perplexity — Answer #1!", AT);
    assert.equal(shot.label, "perplexity-answer-1");
    assert.equal(shot.url, "/api/uploads/148ae1fd8f65/20260805T101530Z-perplexity-answer-1.png");
  });

  test("a run id the uploads route would reject still gets the documented path, and says so", () => {
    // forge-control/src/routes/uploads.ts gates on /^[a-f0-9]{12}$/. Mangling the id to force a
    // 200 would produce a URL pointing at a file that is not there.
    const shot = px.screenshotFor("run-702", "perplexity-answer", AT);
    assert.equal(shot.path, "/opt/ai-os/uploads/run-702/20260805T101530Z-perplexity-answer.png");
    assert.equal(shot.url, "/api/uploads/run-702/20260805T101530Z-perplexity-answer.png");
    assert.equal(shot.url_servable, false);
  });
});

/* ========================================================================== *
 * R702-F — page classification and streaming completion
 * ========================================================================== */

describe("R702-F bot wall and streaming", () => {
  test("a Cloudflare challenge is classified as a bot wall, not a login wall", () => {
    assert.equal(px.detectBotWall({ title: "Just a moment...", text: "" }), "Just a moment");
    assert.equal(
      px.detectBotWall({ title: "perplexity.ai", text: "Verify you are human by completing the action below." }),
      "Verify you are human",
    );
  });

  test("an ordinary answer page is not a bot wall", () => {
    assert.equal(
      px.detectBotWall({ title: "What changed in Node 22 | Perplexity", text: FIXTURE.page_text_excerpt }),
      null,
    );
  });

  test("a still-growing answer is never settled", () => {
    const growing = [10, 200, 900, 1500].map((length) => ({ length, streaming: true }));
    assert.equal(px.isSettled(growing), false);
  });

  test("stable length AND no streaming indicator settles it", () => {
    const samples = [
      { length: 900, streaming: true },
      { length: 1500, streaming: false },
      { length: 1500, streaming: false },
      { length: 1500, streaming: false },
    ];
    assert.equal(px.isSettled(samples), true);
    assert.equal(px.STABLE_SAMPLES, 3);
  });

  test("a visible stop button vetoes a stable length", () => {
    // Perplexity pauses between the answer and the follow-up block; length alone would call
    // that finished and cut the answer off.
    const samples = [
      { length: 1500, streaming: true },
      { length: 1500, streaming: true },
      { length: 1500, streaming: true },
    ];
    assert.equal(px.isSettled(samples), false);
  });

  test("an empty answer never counts as settled, however stable", () => {
    const samples = [0, 0, 0, 0].map((length) => ({ length, streaming: false }));
    assert.equal(px.isSettled(samples), false);
  });

  test("fewer samples than the stability window is not settled", () => {
    assert.equal(px.isSettled([{ length: 1500, streaming: false }]), false);
  });
});

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
    assert.equal(out.backend, "api", "R702: the envelope now names the backend that served it");
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
    // R776: the keyless message used to send the caller to `--backend browser` as the free way
    // out. It is not one — that path 403s from this host. The message must now name BOTH key
    // locations and say why the fallback is not a substitute for the key.
    assert.match(r.stderr, /PERPLEXITY_API_KEY/);
    assert.match(r.stderr, /\/opt\/ai-os\/\.secrets\/store\/perplexity-api-key/);
    assert.match(r.stderr, /403/);
    assert.doesNotMatch(
      r.stderr,
      /Drop --backend api/,
      "the old hint pointed at the blocked path — it must not come back",
    );
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
  const full = [args[0], args[1], "--backend", "api", ...args.slice(2)];
  const cmd =
    `${shq(process.execPath)} --import ${shq(stubUrl)} ${shq(SCRIPT)} ` +
    `${full.map(shq).join(" ")} ${redirect} | cat > ${shq(capture)}; exit \${PIPESTATUS[0]}`;

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
