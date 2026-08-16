#!/usr/bin/env node
// perplexity.mjs — the researcher lane's Perplexity helper. API-FIRST since R776
// (browser-first from R702 to R776; the browser backend is intact and is the documented fallback).
//
// WHY BROWSER-FIRST AT R702 (Konrad, 2026-08-05 ~09:30): he has no Perplexity API key and will
// not buy one. Perplexity is a browser service for him. That constraint made the authenticated
// browser profile owned by scripts/research-browser.mjs the primary path.
//
// WHY API-FIRST FROM R776 — a RE-RANK on new evidence, not a reversal of that reasoning. Probed
// from this host (65.108.6.149) at R775 and re-probed at R776:
//   POST https://api.perplexity.ai/search           => HTTP 401 invalid_api_key  (host reachable)
//   GET  https://www.perplexity.ai/                 => HTTP 403  (Cloudflare "Just a moment")
// The API host answers us; the CONSUMER site refuses us at the edge, upstream of anything a
// browser flag can change (docs/tools/perplexity.md §12.1). R702 therefore made the ONE path that
// cannot work at all from this box the default, while the path that needs nothing but a key sat
// behind a flag. So `ask` and `search` both default to `api`, and Konrad's constraint now has a
// visible price: without a key this tool has no working path from this host. `--backend browser`
// keeps every browser code path reachable and unchanged — it is the fallback for logged-in work,
// and the fix that makes it work unattended is an egress change, not a code change.
//
// This DELIBERATELY CONTRADICTS docs/plan/02-architecture.md §10, which rejected "building
// Perplexity browser scraping" as "fragile, bot-defended, unmaintainable". That judgement was
// correct and is not withdrawn — Konrad's constraint simply overrules it. The response is to
// MITIGATE, not to pretend:
//   1. EVERY DOM selector lives in ONE table (SELECTORS, below). It is the only place to edit
//      when Perplexity's markup changes, and it says out loud that it WILL rot.
//   2. Selection prefers stable, semantic hooks (data-testid, aria-label, anchor semantics)
//      over class-name soup, and the citation harvest is anchor-based rather than
//      layout-based, because "an external <a> inside the answer" outlives any class name.
//   3. When a selector misses, the run FAILS LOUDLY — screenshot plus a page-text excerpt —
//      and emits NO answer. A partial answer presented as a complete one is the one outcome a
//      research lane must never produce.
//
// WHAT THIS FILE DOES NOT OWN. Profiles, the Xvfb/x11vnc/noVNC takeover stack, the login-wall
// handshake and the login reminder all belong to scripts/research-browser.mjs (R701). This
// script imports that file's pure helpers and shells out to its CLI for the handshake. It never
// reimplements them, and it never logs in: on a wall it surfaces the harness's reminder,
// prints what Konrad must do by hand, and exits ${EXIT_NEEDS_LOGIN}.
//
// NO PASSWORD IS STORED ANYWHERE by this script or by the harness. Session cookies live only
// inside the Chrome profile directory /opt/ai-os/browser-profiles/<profile>/ (mode 0700). There
// is no credential flag, no credential file, no keystroke injection of a secret.
//
// DEPENDENCIES: zero npm packages, as before. Node >= 22 built-ins, plus playwright resolved at
// RUNTIME from outside this repo (docs/plan/03-quality.md gates on an empty package.json /
// pnpm-lock.yaml diff), plus the sibling research-browser.mjs. That sibling import is the one
// amendment to 02-architecture §6.1's "standalone-copyable" rule: this script is copyable
// TOGETHER WITH research-browser.mjs, which is its harness — the brief for R702 requires
// building on it rather than duplicating a second profile/takeover implementation. Everything
// else (the writeFd output helpers, key resolution, the --out pre-flight) stays duplicated
// per §6.1, on purpose. Do not factor those out.
//
// API-BACKEND FACTS (unchanged, from docs/research/perplexity-api.md, live-probed 2026-08-05):
//   - Sonar Chat Completions was deprecated July 2026; the target is POST /v1/agent.
//   - The Agent API is STRICT: any unknown field is a hard HTTP 400, so the body is a whitelist.
//   - Web search is NOT automatic and failures arrive as HTTP 200 — see buildAskBody/runAsk.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  accessSync,
  statSync,
  writeSync,
  constants,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  CHROME_CANDIDATE_PATHS,
  CliError,
  EXIT as RB_EXIT,
  PLAYWRIGHT_CANDIDATE_PATHS,
  PROFILE_RE,
  REMINDER_DEDUP_WINDOW_MS,
  REMINDER_TEXT_MAX,
  REMINDER_WHEN,
  REMINDERS_URL,
  SERVICES,
  SSH_TARGET,
  UPLOADS_ROOT,
  evaluateLoginWall,
  isServableRunId,
  novncUrl,
  parsePgTimestamp,
  profileDir,
  resolveRunId,
  screenshotRecord,
  sshTunnelCommand,
  stateDir,
} from './research-browser.mjs';

const SELF = 'perplexity.mjs';
const RESEARCH_BROWSER = fileURLToPath(new URL('./research-browser.mjs', import.meta.url));

// =================================================================================================
// THE SELECTOR TABLE — THE ONLY PLACE IN THIS FILE THAT KNOWS WHAT PERPLEXITY'S DOM LOOKS LIKE.
//
// ⚠️  THESE SELECTORS WILL ROT. Perplexity is a bot-defended SPA that ships markup changes
// ⚠️  whenever it likes; nothing here is a documented interface. When this tool starts failing
// ⚠️  with "none of the ... selectors matched", THIS TABLE is what you edit — nothing else in
// ⚠️  this file, and nothing in research-browser.mjs. docs/tools/perplexity.md §7 is the
// ⚠️  step-by-step recovery procedure, and `--dump-capture` exists precisely to make the repair
// ⚠️  a five-minute job instead of an investigation.
//
// RULES THIS TABLE FOLLOWS:
//  - Candidates are ordered most-semantic → least. `data-testid` and `aria-label` first, then
//    element semantics, then structural CSS. Class-name soup is the LAST resort, never the
//    first, because a class name is the fastest-rotting thing on the page.
//  - `domCss` entries run inside page.evaluate() via document.querySelector, so they must be
//    PLAIN CSS. Playwright pseudo-classes (`:has-text()`, `text=`) are invalid there and would
//    throw; they belong in the `pwLocator` entries, which are used with page.locator().
//  - An unparseable selector is RECORDED, not fatal: the capture reports which candidates were
//    tried and which one matched, so a rotted entry is visible in the output rather than
//    inferred from a stack trace.
//  - Nothing here is allowed to silently degrade the result. Missing answer → hard error.
//    Missing sources → hard error unless --allow-uncited is passed explicitly.
// =================================================================================================
export const SELECTORS = {
  /** The rendered answer body. First match wins; NO fallback to <main> — see parseAnswerCapture. */
  answerBody: {
    domCss: [
      '[data-testid="answer"]',
      '[data-testid="copilot-answer"]',
      'main [id^="markdown-content"]',
      'main article',
      'main .prose',
      'main [class*="prose"]',
    ],
  },
  /**
   * The "Sources" strip. Only used to TAG links as coming from it — the citation harvest does
   * not depend on finding it (see parseAnswerCapture's strategy ladder), because a region
   * wrapper is exactly the kind of div whose test id disappears in a redesign.
   */
  sourcesRegion: {
    domCss: [
      '[data-testid="sources"]',
      '[data-testid="citations"]',
      '[class*="citation"]',
      'main :is(div,section):has(> a[href^="http"][target="_blank"])',
    ],
  },
  /** Everything link-bearing is harvested from here. `main` is the semantic root, not a class. */
  contentRoot: {
    domCss: ['main', '[role="main"]', 'body'],
  },
  /** Visible ⇒ the answer is still streaming. Absence alone is NOT treated as "done". */
  streamingIndicator: {
    domCss: [
      '[data-testid="stop-generating"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop generating" i]',
    ],
  },
  /** The query box on the home page — only needed by the `typed` submission fallback. */
  askBox: {
    pwLocator: [
      'textarea[placeholder*="Ask" i]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
  },
  /**
   * Cloudflare / bot-wall fingerprints. NOT a login wall: a login wall means "Konrad must log
   * in once"; this means "Perplexity refused the automation". Conflating them would queue a
   * reminder that cannot fix anything.
   */
  botWallText: [
    'Just a moment',
    'Verify you are human',
    'Checking your browser',
    'Enable JavaScript and cookies to continue',
    'Access denied',
  ],
};

/** The service key in research-browser.mjs's SERVICES table that this tool drives. */
export const SERVICE_KEY = 'perplexity';
/** The shared research profile defined by R701. One profile, one Perplexity session. */
export const DEFAULT_PROFILE = 'perplexity';
export const PERPLEXITY_HOME = SERVICES[SERVICE_KEY].home;
/** Submission by URL needs no selector at all, which is why it is the primary strategy. */
export const searchUrl = (question) =>
  `https://www.perplexity.ai/search?q=${encodeURIComponent(question)}`;

// --- API backend constants (unchanged since R502) -----------------------------------------------
const AGENT_URL = 'https://api.perplexity.ai/v1/agent';
const SEARCH_URL = 'https://api.perplexity.ai/search';

const DEFAULT_MODEL = 'perplexity/sonar';
const PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh'];

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS = 5;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;

// --- Browser backend tuning ---------------------------------------------------------------------
export const DEFAULT_ANSWER_TIMEOUT_MS = 120_000;
export const NAV_TIMEOUT_MS = 60_000;
/**
 * How long a Cloudflare interstitial is allowed to resolve itself before it counts as a hard
 * bot wall. A managed challenge ("Just a moment...", `__cf_chl_rt_tk` in the URL) is normally
 * transient, and classifying one the instant domcontentloaded fires would report a passing
 * interstitial as a permanent refusal — wrong in the direction that matters, because it fails a
 * run that would have worked. Persisting past this deadline IS the real refusal.
 *
 * MEASURED ON THIS BOX 2026-08-05, and the reason this is a flag (--challenge-timeout) rather
 * than a constant: perplexity.ai does not challenge 65.108.6.149, it BLOCKS it. The interstitial
 * never resolves — 150 s of polling on a brand-new throwaway profile, and plain
 * `curl -A '<real Chrome UA>' https://www.perplexity.ai/` returns 403 from the same host while
 * google.com returns 200. That is an edge block on the egress IP, not a fingerprint the browser
 * can fix. Raising this number cannot help there; it exists for a box whose challenge is slow,
 * not for one that is refused. See docs/tools/perplexity.md §12.
 */
export const BOT_CHALLENGE_TIMEOUT_MS = 90_000;
/** Streaming is "settled" once the answer text stops growing for this many consecutive samples. */
export const STABLE_SAMPLES = 3;
export const SAMPLE_INTERVAL_MS = 1_500;
/** How much page text a loud failure carries, so a human can see what the page actually was. */
export const PAGE_EXCERPT_CHARS = 1_200;

export const BACKENDS = ['browser', 'api'];

// --- Exit codes ---------------------------------------------------------------------------------
const EXIT_OK = 0;
const EXIT_API = 1;
const EXIT_NO_KEY = 2;
const EXIT_USAGE = 3;
/**
 * NEEDS LOGIN. Deliberately the same number as research-browser.mjs's EXIT.LOGIN_REQUIRED: a
 * caller that already knows "4 means a human must log in once" must not have to learn a second
 * number for the tool layered on top. The assertion below is not decoration — if the harness
 * ever renumbers, this fails at import time instead of silently reporting a wall as an API error.
 */
const EXIT_NEEDS_LOGIN = 4;

/**
 * The exit-code contract as data, so the suite can assert it instead of trusting prose. `PREREQ`
 * carries both meanings — no API key on the api backend, no playwright/Chrome/noVNC on the
 * browser backend — because to a caller they are the same thing: "install something, then retry".
 */
export const EXIT = Object.freeze({
  OK: EXIT_OK,
  API: EXIT_API,
  PREREQ: EXIT_NO_KEY,
  USAGE: EXIT_USAGE,
  NEEDS_LOGIN: EXIT_NEEDS_LOGIN,
});

if (RB_EXIT.LOGIN_REQUIRED !== EXIT_NEEDS_LOGIN) {
  throw new Error(
    `${SELF}: exit-code contract broken — research-browser.mjs EXIT.LOGIN_REQUIRED is ` +
      `${RB_EXIT.LOGIN_REQUIRED} but this script documents ${EXIT_NEEDS_LOGIN}. Fix one of them.`,
  );
}

const USAGE = `${SELF} — Perplexity for the researcher lane (api-first, zero-dependency, node >= 22)

USAGE
  scripts/perplexity.mjs ask "<question>" [options]
  scripts/perplexity.mjs search "<query>" [options]
  scripts/perplexity.mjs --help

MODES
  ask       Ask a question. Default backend: api.
            api     — POST ${AGENT_URL} (needs PERPLEXITY_API_KEY). The default since R776:
                      the API host answers this box, the consumer site does not (see FALLBACK).
            browser — the documented FALLBACK, and the only path for logged-in work: drives
                      perplexity.ai in the authenticated Chrome profile owned by
                      scripts/research-browser.mjs, waits for the answer to finish streaming,
                      and extracts the answer text AND the cited source URLs.
            stdout JSON: { "backend", "question", "answer", "citations", "sources",
                           "search_results", "screenshots", ... }

  search    Raw web search via the Search API (POST ${SEARCH_URL}).
            API ONLY — there is no browser equivalent, and inventing one would be scraping
            a second surface. stdout JSON: { "backend", "search_results" }

FALLBACK — WHY api IS THE DEFAULT AND browser IS NOT
  Probed from this host: POST ${SEARCH_URL} returns 401 invalid_api_key (reachable — it just
  wants a key), while GET https://www.perplexity.ai/ returns 403, a Cloudflare edge block on
  this box's IP. So the browser backend cannot complete a run from here no matter what you
  pass it; every browser code path is intact and reachable via --backend browser, and making
  it work unattended needs a different egress (proxy/VPN), not a flag. See
  docs/tools/perplexity.md §12.

OPTIONS FOR ask (api backend — the default)
  --model <slug>          Default: ${DEFAULT_MODEL}. Mutually exclusive with --preset.
  --preset <name>         One of: ${PRESETS.join(' | ')}. Mutually exclusive with --model.
  --instructions "<text>" System instructions. With --preset this REPLACES the preset's prompt.
  --max-steps <n>         Research loop steps, 1-100. Default: ${DEFAULT_MAX_STEPS}
  --max-tool-calls <n>    Tool-call ceiling, 0-100. Default: ${DEFAULT_MAX_TOOL_CALLS}
                          0 disables all tool calls and requires --no-force-search.
  --no-force-search       Relax tool_choice from {"type":"web_search"} to "auto".

OPTIONS FOR ask (browser backend — pass --backend browser)
  --backend browser|api   Default: api
  --profile <name>        Chrome profile to use. Default: ${DEFAULT_PROFILE}
                          (the shared research profile; see docs/tools/research-browser.md)
  --run-id <id>           Screenshot directory under ${UPLOADS_ROOT}/
                          Default: $FORGE_RUN_ID, else the sentinel used by the harness.
  --label <text>          Screenshot label, sanitised to [a-z0-9-]. Default: perplexity-answer
  --answer-timeout <ms>   How long to wait for streaming to settle. Default: ${DEFAULT_ANSWER_TIMEOUT_MS}
  --challenge-timeout <ms> How long a Cloudflare interstitial may take to clear itself before it
                          counts as a hard bot wall. Default: ${BOT_CHALLENGE_TIMEOUT_MS}
                          (raising it cannot help when the host's egress IP is edge-blocked —
                          plain \`curl -sI https://www.perplexity.ai/\` returning 403 says it is)
  --allow-uncited         Accept an answer with ZERO extracted sources. Off by default: the
                          citations are the entire reason a researcher uses this tool, so a
                          sourceless answer is treated as a broken extraction, not a result.
  --dump-capture <file>   Also write the raw DOM capture (what the selector table harvested)
                          to <file>. This is how you re-cut the parser fixture when the
                          selectors rot — see docs/tools/perplexity.md §7.
  --keep-open             Leave the browser session running after the answer (for debugging).

OPTIONS FOR search
  --max-results <n>       1-${MAX_RESULTS_CAP}. Default: ${DEFAULT_MAX_RESULTS}

OPTIONS FOR EVERYTHING
  --out <file>            Also write the JSON result to <file>. stdout is written FIRST and is
                          unaffected, so a completed run survives a write failure. The target
                          is pre-flighted before any work (exit 3, nothing sent/launched).

A --backend browser RUN WILL STOP AT A LOGIN WALL — THAT IS NORMAL
  The browser backend needs a logged-in Perplexity session in the profile. Until Konrad has
  logged in ONCE by hand, every browser run exits ${EXIT_NEEDS_LOGIN} and tells him exactly what to do:
  the harness screenshots the wall, queues a reminder, brings up a loopback-only noVNC session
  and leaves the browser running so it can be taken over. This tool NEVER attempts a login and
  NEVER prompts for credentials. No password is stored anywhere; the only thing that persists
  is Chrome's own cookie jar inside the profile directory.

API KEY (api backend — the default, so this is the key the tool normally wants)
  Resolved in this order, and no HTTP request is attempted unless one of them yields a key:
    1. environment variable  PERPLEXITY_API_KEY
    2. secret-store file     /opt/ai-os/.secrets/store/perplexity-api-key

EXIT CODES
  0  success
  1  API, browser or extraction error (invalid key, non-2xx, unparseable body, a selector that
     matched nothing, a bot wall, an answer that never stopped streaming). NO partial answer is
     ever emitted on this path.
  2  missing prerequisite — no API key (api backend), or no playwright/Chrome/Xvfb/noVNC
     (browser backend). Nothing was sent and nothing was launched.
  3  usage error, or an unusable --out target (pre-flighted before any request or launch).
  ${EXIT_NEEDS_LOGIN}  NEEDS LOGIN — a login wall. The takeover stack is up, the wall is screenshotted, a
     reminder is queued and the browser is left running for a one-time human login. This is
     "needs Konrad", not "broke", and it is the EXPECTED outcome of a first run.
`;

// -------------------------------------------------------------------------------------------------
// Synchronous, drain-guaranteed output (R405 finding 2). DUPLICATED PER SCRIPT BY DESIGN
// (02-architecture §6.1) — do not factor out.
//
// process.stdout/stderr are ASYNCHRONOUS when they point at a pipe, and the researcher lane
// captures this script through a pipe. process.stdout.write() only queues; process.exit() then
// discards whatever has not drained, truncating at the 64 KiB pipe buffer. writeSync() on the raw
// fd bypasses the stream entirely, so the bytes are gone before exit(). EAGAIN is the
// non-blocking-pipe "buffer full, try again" signal; EPIPE means the reader is already gone.
// -------------------------------------------------------------------------------------------------
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

function writeFd(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        Atomics.wait(SLEEP_SLOT, 0, 0, 5); // 5 ms, synchronous: nothing else may run first
        continue;
      }
      if (err.code === 'EPIPE') return; // reader closed; there is nobody left to tell
      throw err;
    }
  }
}

/** All stdout in this script goes through here — never process.stdout.write (see above). */
const writeOut = (text) => writeFd(1, text);
/** All stderr in this script goes through here — never process.stderr.write (see above). */
const writeErr = (text) => writeFd(2, text);

function die(code, message) {
  writeErr(`${message}\n`);
  process.exit(code);
}

/** Usage error: nothing has been sent or launched, and nothing will be. */
function usageError(message) {
  die(EXIT_USAGE, `usage error: ${message}\n\nRun with --help for the full usage.`);
}

/** API / browser / extraction error. */
function apiError(message) {
  die(EXIT_API, message);
}

/**
 * Local output error (an unwritable --out target). Exit 3, not 1: nothing about the API or the
 * browser went wrong, and callers that retry on 1 must not retry — and re-pay for — a
 * filesystem fault.
 */
function outputError(message) {
  die(EXIT_USAGE, `output error: ${message}`);
}

// -------------------------------------------------------------------------------------------------
// Key resolution (R23). Duplicated verbatim-in-shape across the helper scripts by design —
// 02-architecture §6.1: each script must stay standalone-copyable. Do not factor out.
// -------------------------------------------------------------------------------------------------
const KEY_ENV_NAME = 'PERPLEXITY_API_KEY';
const KEY_FILE_PATH = '/opt/ai-os/.secrets/store/perplexity-api-key';

function resolveApiKey() {
  const fromEnv = (process.env[KEY_ENV_NAME] ?? '').trim();
  if (fromEnv) return fromEnv;
  let fromFile = '';
  try {
    fromFile = readFileSync(KEY_FILE_PATH, 'utf8').trim();
  } catch (err) {
    // Only "not there" is a normal miss; anything else (EACCES, EISDIR) is a real fault to report.
    if (err.code !== 'ENOENT') {
      die(
        EXIT_NO_KEY,
        `Could not read the secret-store file ${KEY_FILE_PATH}: ${err.code ?? 'unknown'} ${err.message}\n` +
          `Fix the file or set the environment variable ${KEY_ENV_NAME} instead. No request was sent.`,
      );
    }
  }
  if (fromFile) return fromFile;
  die(
    EXIT_NO_KEY,
    `No Perplexity API key found. Nothing was sent.\n` +
      `Set the key named ${KEY_ENV_NAME} in ONE of:\n` +
      `  1. environment variable: ${KEY_ENV_NAME}\n` +
      `  2. secret-store file:    ${KEY_FILE_PATH}\n` +
      `The file must contain the raw key and nothing else; surrounding whitespace is trimmed.\n` +
      `\n` +
      `Konrad has no Perplexity API key and did not intend to buy one, which is why R702 made the\n` +
      `browser backend the default. R776 reversed the RANKING on new evidence: --backend browser\n` +
      `still exists and still works as code, but https://www.perplexity.ai/ answers this host with\n` +
      `HTTP 403 (Cloudflare edge block on the egress IP), while ${SEARCH_URL}\n` +
      `answers 401 — reachable, it only wants a key. So --backend browser is NOT the cheap way out\n` +
      `of this message: a key is the real unblock, and the only alternative that makes the browser\n` +
      `path work unattended is a different egress (proxy/VPN). See docs/tools/perplexity.md §12.`,
  );
}
// -------------------------------------------------------------------------------------------------

/** Strict integer flag parsing — no truncation, no NaN-to-default. */
function parseIntFlag(flag, raw, min, max) {
  if (raw === undefined) throw new CliError(EXIT_USAGE, `${flag} requires a value`);
  if (!/^\d+$/.test(raw)) {
    throw new CliError(EXIT_USAGE, `${flag} expects a non-negative integer, got "${raw}"`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new CliError(EXIT_USAGE, `${flag} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

/**
 * Pure argv parser. Throws CliError instead of exiting so the suite can drive the whole flag
 * contract in-process — main() is the single place that turns a CliError into an exit code.
 * (Same shape as research-browser.mjs's parseArgs, deliberately.)
 */
export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const mode = argv[0];
  if (mode === undefined) throw new CliError(EXIT_USAGE, 'no mode given — expected "ask" or "search"');
  if (mode !== 'ask' && mode !== 'search') {
    throw new CliError(EXIT_USAGE, `unknown mode "${mode}" — expected "ask" or "search"`);
  }

  const subject = argv[1];
  if (subject === undefined || subject.trim() === '') {
    throw new CliError(
      EXIT_USAGE,
      mode === 'ask' ? 'ask requires a question argument' : 'search requires a query argument',
    );
  }

  const opts = {
    help: false,
    mode,
    subject,
    // BACKEND DEFAULTING (R776): api for BOTH modes. `search` has never had a browser surface
    // this tool is willing to scrape; `ask` moved to api because perplexity.ai 403s this host's
    // egress IP while api.perplexity.ai answers (401 without a key) — the R702 default was the
    // one path that cannot complete from here. --backend browser stays fully supported for
    // logged-in work; an explicit --backend browser on `search` is still a usage error rather
    // than a silent downgrade.
    backend: 'api',
    backendExplicit: false,
    profile: DEFAULT_PROFILE,
    runId: undefined,
    label: undefined,
    answerTimeoutMs: DEFAULT_ANSWER_TIMEOUT_MS,
    challengeTimeoutMs: BOT_CHALLENGE_TIMEOUT_MS,
    allowUncited: false,
    dumpCapture: undefined,
    keepOpen: false,
    model: undefined,
    preset: undefined,
    instructions: undefined,
    maxSteps: DEFAULT_MAX_STEPS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    forceSearch: true,
    maxResults: DEFAULT_MAX_RESULTS,
    out: undefined,
  };

  const askOnly = (flag) => {
    if (mode !== 'ask') throw new CliError(EXIT_USAGE, `${flag} is only valid in "ask" mode`);
  };
  const searchOnly = (flag) => {
    if (mode !== 'search') throw new CliError(EXIT_USAGE, `${flag} is only valid in "search" mode`);
  };
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined) throw new CliError(EXIT_USAGE, `${flag} requires a value`);
    return v;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--backend':
        opts.backend = value(flag, i);
        opts.backendExplicit = true;
        i += 1;
        break;
      case '--profile':
        askOnly(flag);
        opts.profile = value(flag, i);
        i += 1;
        break;
      case '--run-id':
        askOnly(flag);
        opts.runId = value(flag, i);
        i += 1;
        break;
      case '--label':
        askOnly(flag);
        opts.label = value(flag, i);
        i += 1;
        break;
      case '--answer-timeout':
        askOnly(flag);
        opts.answerTimeoutMs = parseIntFlag(flag, value(flag, i), 5_000, 900_000);
        i += 1;
        break;
      case '--challenge-timeout':
        askOnly(flag);
        opts.challengeTimeoutMs = parseIntFlag(flag, value(flag, i), 5_000, 600_000);
        i += 1;
        break;
      case '--allow-uncited':
        askOnly(flag);
        opts.allowUncited = true;
        break;
      case '--dump-capture':
        askOnly(flag);
        opts.dumpCapture = value(flag, i);
        i += 1;
        break;
      case '--keep-open':
        askOnly(flag);
        opts.keepOpen = true;
        break;
      case '--model':
        askOnly(flag);
        opts.model = value(flag, i);
        i += 1;
        break;
      case '--preset':
        askOnly(flag);
        opts.preset = value(flag, i);
        i += 1;
        break;
      case '--instructions':
        askOnly(flag);
        opts.instructions = value(flag, i);
        i += 1;
        break;
      case '--max-steps':
        askOnly(flag);
        opts.maxSteps = parseIntFlag(flag, value(flag, i), 1, 100);
        i += 1;
        break;
      case '--max-tool-calls':
        askOnly(flag);
        opts.maxToolCalls = parseIntFlag(flag, value(flag, i), 0, 100);
        i += 1;
        break;
      case '--no-force-search':
        askOnly(flag);
        opts.forceSearch = false;
        break;
      case '--max-results':
        searchOnly(flag);
        opts.maxResults = parseIntFlag(flag, value(flag, i), 1, MAX_RESULTS_CAP);
        i += 1;
        break;
      case '--out':
        opts.out = value(flag, i);
        i += 1;
        break;
      default:
        throw new CliError(EXIT_USAGE, `unknown option "${flag}"`);
    }
  }

  if (!BACKENDS.includes(opts.backend)) {
    throw new CliError(
      EXIT_USAGE,
      `--backend must be one of ${BACKENDS.join(' | ')}, got "${opts.backend}"`,
    );
  }
  if (opts.mode === 'search' && opts.backend !== 'api') {
    throw new CliError(
      EXIT_USAGE,
      `search mode has no browser backend — the Search API is a separate product and there is ` +
        `no perplexity.ai surface this tool is willing to scrape for it. Use "ask" for the ` +
        `browser path, or drop --backend on search.`,
    );
  }
  if (!PROFILE_RE.test(opts.profile)) {
    throw new CliError(
      EXIT_USAGE,
      `invalid --profile "${opts.profile}" — must match ${PROFILE_RE} (the harness owns profile ` +
        `naming; see docs/tools/research-browser.md §4)`,
    );
  }

  // Flags that only mean something on one backend must not be accepted silently on the other:
  // a caller who passes --model with the browser backend believes they chose a model.
  const apiOnlyUsed = [
    opts.model !== undefined && '--model',
    opts.preset !== undefined && '--preset',
    opts.instructions !== undefined && '--instructions',
    opts.maxSteps !== DEFAULT_MAX_STEPS && '--max-steps',
    opts.maxToolCalls !== DEFAULT_MAX_TOOL_CALLS && '--max-tool-calls',
    opts.forceSearch === false && '--no-force-search',
  ].filter(Boolean);
  const browserOnlyUsed = [
    opts.runId !== undefined && '--run-id',
    opts.label !== undefined && '--label',
    opts.answerTimeoutMs !== DEFAULT_ANSWER_TIMEOUT_MS && '--answer-timeout',
    opts.challengeTimeoutMs !== BOT_CHALLENGE_TIMEOUT_MS && '--challenge-timeout',
    opts.allowUncited && '--allow-uncited',
    opts.dumpCapture !== undefined && '--dump-capture',
    opts.keepOpen && '--keep-open',
  ].filter(Boolean);

  /** "--model only applies" / "--model, --preset only apply" — the message has to read right. */
  const onlyApplies = (flags) => `${flags.join(', ')} only ${flags.length === 1 ? 'applies' : 'apply'}`;

  if (opts.backend === 'browser' && apiOnlyUsed.length > 0) {
    throw new CliError(
      EXIT_USAGE,
      `${onlyApplies(apiOnlyUsed)} to the api backend, and you selected the browser one. ` +
        `Drop --backend browser (api is the default), or drop the flag(s).`,
    );
  }
  if (opts.backend === 'api' && opts.mode === 'ask' && browserOnlyUsed.length > 0) {
    throw new CliError(
      EXIT_USAGE,
      `${onlyApplies(browserOnlyUsed)} to the browser backend, not --backend api.`,
    );
  }

  if (opts.model !== undefined && opts.preset !== undefined) {
    throw new CliError(
      EXIT_USAGE,
      '--model and --preset are mutually exclusive — send one or the other, never both',
    );
  }
  if (opts.preset !== undefined && !PRESETS.includes(opts.preset)) {
    throw new CliError(
      EXIT_USAGE,
      `--preset must be one of ${PRESETS.join(' | ')}, got "${opts.preset}"`,
    );
  }
  if (opts.model !== undefined && opts.model.trim() === '') {
    throw new CliError(EXIT_USAGE, '--model requires a non-empty model slug');
  }
  if (opts.maxToolCalls === 0 && opts.forceSearch) {
    throw new CliError(
      EXIT_USAGE,
      '--max-tool-calls 0 disables all tool calls, which contradicts forced web search — pass --no-force-search too',
    );
  }
  if (opts.out !== undefined && opts.out.trim() === '') {
    throw new CliError(EXIT_USAGE, '--out requires a file path');
  }
  if (opts.dumpCapture !== undefined && opts.dumpCapture.trim() === '') {
    throw new CliError(EXIT_USAGE, '--dump-capture requires a file path');
  }

  return opts;
}

/**
 * Pre-flight a JSON output target BEFORE any request or browser launch. An Agent run is billed
 * per web_search invocation and a browser run costs a minute of wall clock, so discovering
 * ENOENT/EACCES afterwards means paying twice. Mirrors assertOutWritable() in gemini-qa.mjs.
 *
 * R405 finding 3: accessSync(path, W_OK) succeeds on a *directory*, so `--out /tmp` used to sail
 * through and only blow up at writeFileSync with EISDIR — after the bill. Shape is therefore
 * checked before permission, on both the target and its parent. What this cannot cover is
 * genuinely narrow: the target being unlinked/replaced between the check and the write, or ENOSPC.
 */
function assertOutWritable(outPath, flag = '--out') {
  if (outPath === undefined) return;
  const path = resolve(outPath);

  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      outputError(`${flag} target cannot be inspected: ${path}: ${err.code ?? 'unknown'} ${err.message}`);
    }
  }

  if (stat !== undefined) {
    if (stat.isDirectory()) outputError(`${flag} target is a directory, not a file: ${path}`);
    try {
      accessSync(path, constants.W_OK);
    } catch (err) {
      outputError(`${flag} target is not writable: ${path}: ${err.code ?? 'unknown'} ${err.message}`);
    }
    return;
  }

  const dir = dirname(path);
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch (err) {
    outputError(`${flag} directory is not usable: ${dir}: ${err.code ?? 'unknown'} ${err.message}`);
  }
  if (!dirStat.isDirectory()) outputError(`${flag} directory is not a directory: ${dir}`);
  try {
    accessSync(dir, constants.W_OK);
  } catch (err) {
    outputError(`${flag} directory is not writable: ${dir}: ${err.code ?? 'unknown'} ${err.message}`);
  }
}

/**
 * stdout FIRST, then the file. The run is already paid for (in dollars or in a minute of
 * browser time) by the time this executes, so the durable copy has to leave the process before
 * anything that can fail. assertOutWritable() pre-flights the target; reaching the catch means
 * the target was unlinked or replaced mid-run, or the disk filled — and by then the result is
 * safely out, because writeOut() is synchronous even when stdout is a pipe.
 */
function emit(payload, outPath) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  writeOut(json);
  if (outPath === undefined) return;
  const path = resolve(outPath);
  try {
    writeFileSync(path, json);
  } catch (err) {
    outputError(
      `could not write --out file ${path}: ${err.code ?? 'unknown'} ${err.message}\n` +
        `The result is NOT lost — it was already written to stdout in full.`,
    );
  }
}

// =================================================================================================
// BROWSER BACKEND — pure parts first, so the suite can drive them without a browser
// =================================================================================================

/**
 * Normalise a URL for de-duplication. Perplexity renders the same source as an inline numbered
 * citation AND as a card in the sources strip, usually with a trailing slash or a tracking
 * fragment between them. Comparing raw strings would file one source twice.
 */
export function normaliseSourceUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // not absolute — a relative href is app navigation, never a citation
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/** perplexity.ai's own links are product navigation, not sources. */
export function isPerplexityInternal(raw) {
  try {
    return /(^|\.)perplexity\.ai$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * THE PARSER — pure, exported, and fixture-tested (see
 * forge-control/src/lib/fixtures/perplexity-answer-capture.json).
 *
 * It takes the raw DOM capture harvested by CAPTURE_SOURCE below and turns it into the answer
 * plus its cited sources. Every rejection path here is a THROW with diagnostics, never a
 * degraded result: an empty answer, an answer whose selector never matched, or a run with no
 * extractable citations are all failures, because "here is an answer, I could not find where it
 * came from" is exactly the artifact a research lane must not produce.
 *
 * SOURCE STRATEGY LADDER (reported in the output as `sources_strategy`, never silent):
 *   1. `sources-region`  — links tagged as living inside the sources strip. Best signal.
 *   2. `numbered-citations` — links whose visible text is a bare citation number ([1], 2, …).
 *   3. `content-external-anchors` — every external anchor under the content root, in DOM order.
 * The ladder exists because the region wrapper is the fastest-rotting hook and anchor semantics
 * are the slowest; each rung is strictly more permissive than the one above it.
 */
export function parseAnswerCapture(capture, { allowUncited = false } = {}) {
  if (capture === null || typeof capture !== 'object') {
    throw new CliError(EXIT_API, `capture is not an object (got ${capture === null ? 'null' : typeof capture})`);
  }

  const tried = capture.answer_candidates_tried ?? [];
  const answerText = typeof capture.answer?.text === 'string' ? capture.answer.text.trim() : '';
  if (capture.answer === null || capture.answer === undefined || answerText === '') {
    throw new CliError(
      EXIT_API,
      `no answer could be extracted from ${capture.url ?? '<unknown url>'}.\n` +
        `  None of the answerBody selectors matched a non-empty element. Tried, in order:\n` +
        tried.map((t) => `    - ${t.selector} — ${t.result}\n`).join('') +
        `  THE SELECTOR TABLE HAS ROTTED (or the page is not an answer page). Edit SELECTORS\n` +
        `  .answerBody in scripts/perplexity.mjs; see docs/tools/perplexity.md §7.\n` +
        `  Page text excerpt:\n${indent(capture.page_text_excerpt ?? '<none captured>')}`,
    );
  }

  const links = Array.isArray(capture.links) ? capture.links : [];
  const dropped = { internal: 0, non_http: 0, duplicate: 0 };
  const collect = (predicate) => {
    const seen = new Set();
    const out = [];
    for (const link of links) {
      if (link === null || typeof link !== 'object' || typeof link.href !== 'string') continue;
      if (!predicate(link)) continue;
      const url = normaliseSourceUrl(link.href);
      if (url === null) {
        dropped.non_http += 1;
        continue;
      }
      if (isPerplexityInternal(link.href)) {
        dropped.internal += 1;
        continue;
      }
      if (seen.has(url)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(url);
      out.push({
        url: link.href,
        title: sourceTitle(link),
        citation_index: Number.isInteger(link.citation_index) ? link.citation_index : null,
        region: link.region ?? 'content',
      });
    }
    return out;
  };

  const ladder = [
    ['sources-region', (l) => l.region === 'sources'],
    ['numbered-citations', (l) => Number.isInteger(l.citation_index)],
    ['content-external-anchors', () => true],
  ];

  let sources = [];
  let strategy = 'none';
  for (const [name, predicate] of ladder) {
    // Each rung resets the drop counters: they must describe the rung that actually produced
    // the result, not the sum of every attempt.
    dropped.internal = 0;
    dropped.non_http = 0;
    dropped.duplicate = 0;
    const found = collect(predicate);
    if (found.length > 0) {
      sources = found;
      strategy = name;
      break;
    }
  }

  // Numbered citations carry an explicit order; honour it. Everything else keeps DOM order,
  // which is the order Perplexity itself renders the sources strip in.
  if (sources.every((s) => Number.isInteger(s.citation_index))) {
    sources.sort((a, b) => a.citation_index - b.citation_index);
  }

  if (sources.length === 0 && !allowUncited) {
    throw new CliError(
      EXIT_API,
      `an answer was extracted from ${capture.url ?? '<unknown url>'} but ZERO sources were.\n` +
        `  ${links.length} link(s) were harvested; none survived (perplexity-internal: ` +
        `${dropped.internal}, non-http: ${dropped.non_http}).\n` +
        `  Citations are the entire reason this tool exists, so a sourceless answer is treated\n` +
        `  as a broken extraction rather than a result. Either the sources markup changed\n` +
        `  (edit SELECTORS.sourcesRegion / SELECTORS.contentRoot) or this really was an\n` +
        `  uncited answer — pass --allow-uncited to accept that explicitly.\n` +
        `  Answer text (first 400 chars):\n${indent(answerText.slice(0, 400))}`,
    );
  }

  return {
    answer: answerText,
    sources,
    sources_strategy: strategy,
    answer_selector: capture.answer.selector ?? null,
    dropped,
  };
}

/** A human-readable label for a source: the anchor's title, else its text, else its host. */
function sourceTitle(link) {
  const title = typeof link.title === 'string' ? link.title.trim() : '';
  if (title !== '') return title;
  const text = typeof link.text === 'string' ? link.text.replace(/\s+/g, ' ').trim() : '';
  // A bare citation number is a marker, not a title.
  if (text !== '' && !/^\[?\d{1,3}\]?$/.test(text)) return text.slice(0, 200);
  try {
    return new URL(link.href).hostname;
  } catch {
    return '';
  }
}

const indent = (text) =>
  String(text)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

/**
 * Was the page a bot wall rather than a login wall or an answer? Pure so the classifier is
 * testable. The distinction matters: a login wall is fixed by Konrad logging in once; a bot wall
 * is Perplexity refusing the automation, and queueing a "please log in" reminder for it would
 * send him to do something that cannot help.
 */
export function detectBotWall({ title = '', text = '' } = {}) {
  const haystack = `${title}\n${text}`.toLowerCase();
  const hit = SELECTORS.botWallText.find((needle) => haystack.includes(needle.toLowerCase()));
  return hit === undefined ? null : hit;
}

/**
 * Has the answer stopped streaming? Pure, from a sample history of answer lengths.
 * Settled means: non-empty, no streaming indicator visible, and the length unchanged across the
 * last STABLE_SAMPLES samples. Absence of the stop button ALONE is not enough — that selector is
 * in the rot table like every other one, and trusting it alone would cut answers off mid-sentence.
 */
export function isSettled(samples, stableSamples = STABLE_SAMPLES) {
  if (samples.length < stableSamples) return false;
  const window = samples.slice(-stableSamples);
  if (window.some((s) => s.streaming)) return false;
  if (window[0].length === 0) return false;
  return window.every((s) => s.length === window[0].length);
}

/**
 * The in-page harvester, as SOURCE TEXT. It is passed to page.evaluate() as a string-compiled
 * function so it can be exercised from a jsdom-free unit test only through its OUTPUT (the
 * committed fixture) — there is no DOM in the test process, and standing one up would add the
 * npm dependency this repo forbids. The fixture is therefore the contract between this function
 * and parseAnswerCapture; `--dump-capture` re-cuts it from a real page in one command.
 */
/**
 * The exact argument CAPTURE_SOURCE receives, flattened out of the selector table. Built here
 * rather than inline so the three evaluate() call sites cannot drift apart, and so the shape the
 * harvester is handed (plain arrays of plain CSS — no `{domCss}` wrappers, no playwright
 * pseudo-selectors) is stated in one place.
 */
export const captureArg = () => ({
  selectors: {
    answerBody: SELECTORS.answerBody.domCss,
    sourcesRegion: SELECTORS.sourcesRegion.domCss,
    contentRoot: SELECTORS.contentRoot.domCss,
    streamingIndicator: SELECTORS.streamingIndicator.domCss,
  },
  excerptChars: PAGE_EXCERPT_CHARS,
});

const CAPTURE_SOURCE = ({ selectors, excerptChars }) => {
  const tried = [];
  const firstMatch = (list) => {
    for (const selector of list) {
      try {
        const el = document.querySelector(selector);
        if (el === null) {
          tried.push({ selector, result: 'no element matched' });
          continue;
        }
        const text = (el.innerText ?? el.textContent ?? '').trim();
        if (text === '') {
          tried.push({ selector, result: 'matched an element with no text' });
          continue;
        }
        tried.push({ selector, result: `matched (${text.length} chars)` });
        return { selector, el, text };
      } catch (err) {
        tried.push({ selector, result: `invalid selector: ${err.message}` });
      }
    }
    return null;
  };

  const answer = firstMatch(selectors.answerBody);
  const rootHit = firstMatch(selectors.contentRoot);
  const root = rootHit === null ? document.body : rootHit.el;

  let sourcesRegionSelector = null;
  const sourceNodes = [];
  for (const selector of selectors.sourcesRegion) {
    try {
      const found = document.querySelectorAll(selector);
      if (found.length > 0) {
        sourcesRegionSelector = selector;
        for (const node of found) sourceNodes.push(node);
        break;
      }
    } catch {
      /* invalid selector — recorded implicitly by sourcesRegionSelector staying null */
    }
  }

  const inAny = (nodes, el) => nodes.some((n) => n === el || n.contains(el));
  const links = [];
  let order = 0;
  for (const a of root.querySelectorAll('a[href]')) {
    const text = (a.innerText ?? a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const numeric = /^\[?(\d{1,3})\]?$/.exec(text);
    links.push({
      href: a.href,
      text,
      title: a.getAttribute('title') ?? a.getAttribute('aria-label') ?? '',
      region: inAny(sourceNodes, a)
        ? 'sources'
        : answer !== null && answer.el.contains(a)
          ? 'answer'
          : 'content',
      order: order++,
      citation_index: numeric === null ? null : Number(numeric[1]),
    });
  }

  let streaming = false;
  for (const selector of selectors.streamingIndicator) {
    try {
      const el = document.querySelector(selector);
      if (el !== null && el.offsetParent !== null) {
        streaming = true;
        break;
      }
    } catch {
      /* invalid selector — treated as "no indicator", and the length-stability rule still holds */
    }
  }

  return {
    url: location.href,
    title: document.title,
    answer: answer === null ? null : { selector: answer.selector, text: answer.text },
    answer_candidates_tried: tried,
    sources_region_selector: sourcesRegionSelector,
    links,
    streaming,
    page_text_excerpt: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, excerptChars),
  };
};

// -------------------------------------------------------------------------------------------------
// Browser prerequisites.
//
// DUPLICATION NOTE: research-browser.mjs resolves playwright and Chrome with the same two loops,
// but its resolvePlaywright()/resolveChrome() are module-private. Only the loops are repeated
// here — the CANDIDATE PATH TABLES are imported from it, so there is still exactly one place
// that knows where playwright and Chrome live. Exporting the resolvers (and the hardened launch
// args) from research-browser.mjs is the right fix; it is listed as a needed change in
// docs/tools/perplexity.md §8 because R702 may not edit that file.
// -------------------------------------------------------------------------------------------------
function resolvePlaywright() {
  const require = createRequire('/');
  const tried = [];
  const candidates = [];
  const fromEnv = (process.env.PLAYWRIGHT_MODULE ?? '').trim();
  if (fromEnv !== '') candidates.push({ source: 'PLAYWRIGHT_MODULE', spec: fromEnv });
  for (const spec of PLAYWRIGHT_CANDIDATE_PATHS) candidates.push({ source: 'builtin path', spec });

  for (const candidate of candidates) {
    try {
      const mod = require(candidate.spec);
      if (typeof mod?.chromium?.launchPersistentContext !== 'function') {
        tried.push(`${candidate.spec} (${candidate.source}) — loaded but has no chromium.launchPersistentContext`);
        continue;
      }
      return { mod, path: require.resolve(candidate.spec) };
    } catch (err) {
      tried.push(`${candidate.spec} (${candidate.source}) — ${err.code ?? 'error'}: ${err.message}`);
    }
  }
  die(
    EXIT_NO_KEY, // exit 2 = missing prerequisite, the same meaning the harness gives it
    `${SELF}: cannot resolve the playwright module. Tried, in order:\n` +
      tried.map((t) => `  - ${t}\n`).join('') +
      `  playwright is intentionally NOT a dependency of this repo. Point PLAYWRIGHT_MODULE at\n` +
      `  an installed playwright, or install one at ${PLAYWRIGHT_CANDIDATE_PATHS[0]}.`,
  );
}

function resolveChrome() {
  const tried = [];
  const candidates = [];
  const fromEnv = (process.env.RESEARCH_BROWSER_CHROME ?? '').trim();
  if (fromEnv !== '') candidates.push(fromEnv);
  candidates.push(...CHROME_CANDIDATE_PATHS);
  for (const path of candidates) {
    try {
      if (statSync(path).isFile()) return path;
      tried.push(`${path} — not a regular file`);
    } catch (err) {
      tried.push(`${path} — ${err.code ?? 'error'}`);
    }
  }
  die(
    EXIT_NO_KEY,
    `${SELF}: no Chrome/Chromium executable found. Tried, in order:\n` +
      tried.map((t) => `  - ${t}\n`).join('') +
      `  Set RESEARCH_BROWSER_CHROME to an executable to override.`,
  );
}

// -------------------------------------------------------------------------------------------------
// Talking to the harness CLI
// -------------------------------------------------------------------------------------------------
/**
 * Run research-browser.mjs and parse its JSON status. Its stdout is a documented contract, so a
 * non-JSON body is a hard error carrying both streams verbatim rather than a shrug.
 */
function harness(args, { allowExit = [RB_EXIT.OK] } = {}) {
  const res = spawnSync(process.execPath, [RESEARCH_BROWSER, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    apiError(`${SELF}: could not run the browser harness ${RESEARCH_BROWSER}: ${res.error.message}`);
  }
  const status = res.status ?? -1;
  let json = null;
  if (res.stdout.trim() !== '') {
    try {
      json = JSON.parse(res.stdout);
    } catch (err) {
      apiError(
        `${SELF}: the browser harness printed non-JSON on stdout (${err.message}).\n` +
          `  command: research-browser.mjs ${args.join(' ')}\n  exit: ${status}\n` +
          `  stdout verbatim:\n${indent(res.stdout)}\n  stderr verbatim:\n${indent(res.stderr)}`,
      );
    }
  }
  if (!allowExit.includes(status)) {
    // Exit codes are passed through, not flattened: 2 stays "missing prerequisite", 4 stays
    // "needs login". A caller must be able to tell those apart from a real failure.
    const code = status === RB_EXIT.PREREQ ? EXIT_NO_KEY : status === RB_EXIT.LOGIN_REQUIRED ? EXIT_NEEDS_LOGIN : EXIT_API;
    die(
      code,
      `${SELF}: research-browser.mjs ${args.join(' ')} exited ${status}.\n` +
        `  stdout:\n${indent(res.stdout)}\n  stderr:\n${indent(res.stderr)}`,
    );
  }
  return { status, json, stdout: res.stdout, stderr: res.stderr };
}

/** Is the harness's supervisor holding this profile's Chrome user-data-dir right now? */
function readHarnessSession(profile) {
  let session;
  try {
    session = JSON.parse(readFileSync(join(stateDir(profile), 'session.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { live: false, session: null };
    apiError(`${SELF}: cannot read the harness session file for "${profile}": ${err.message}`);
  }
  const pid = session?.pid;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  if (alive) {
    // Guard against pid reuse exactly the way the harness does.
    try {
      alive = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').includes('__supervise');
    } catch {
      alive = false;
    }
  }
  return { live: alive, session };
}

/** The harness's last recorded login evaluation for this profile, or null if never evaluated. */
function readHarnessAuth(profile) {
  try {
    return JSON.parse(readFileSync(join(stateDir(profile), 'auth.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    apiError(`${SELF}: cannot read the harness auth file for "${profile}": ${err.message}`);
  }
}

// -------------------------------------------------------------------------------------------------
// The browser run
// -------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The screenshot record for one shot: absolute path AND the /api/uploads/<run_id>/<name> URL the
 * Console serves it at. Delegated to research-browser.mjs's screenshotRecord() so there is ONE
 * owner of the convention (docs/tools/research-browser.md §5) — this wrapper exists only so the
 * suite can assert what THIS tool produces, without a browser.
 */
export const screenshotFor = (runId, label, date = new Date()) => screenshotRecord(runId, date, label);

function saveScreenshotSync(runId, label, buffer) {
  const shot = screenshotFor(runId, label);
  mkdirSync(dirname(shot.path), { recursive: true, mode: 0o755 }); // forge-control must serve it
  writeFileSync(shot.path, buffer);
  return shot;
}

/** Screenshot the current page; never let a screenshot failure mask the error that prompted it. */
async function shoot(page, runId, label, screenshots) {
  try {
    const buffer = await page.screenshot({ fullPage: false });
    const shot = saveScreenshotSync(runId, label, buffer);
    screenshots.push(shot);
    if (!shot.url_servable) {
      writeErr(
        `${SELF}: run id "${runId}" is not 12 hex chars, so GET ${shot.url} will 400 ` +
          `(forge-control/src/routes/uploads.ts). The file itself is at ${shot.path}.\n`,
      );
    }
    return shot;
  } catch (err) {
    writeErr(`${SELF}: screenshot "${label}" failed: ${err.message.split('\n')[0]}\n`);
    return null;
  }
}

/**
 * The whole browser flow. Ordering is deliberate:
 *   1. resolve prerequisites (cheap, fails at exit 2 before anything is launched)
 *   2. hand the profile lock over from the harness, EXPLICITLY
 *   3. bring up the takeover stack (display + noVNC), via the harness
 *   4. launch, navigate, classify the page (bot wall / login wall / answer)
 *   5. wait for streaming to settle, harvest, parse, screenshot
 * A login wall short-circuits at step 4 and is handed straight back to the harness, which owns
 * the handshake: screenshot, reminder, noVNC, browser left running.
 */
async function runBrowserAsk(opts) {
  const runInfo = resolveRunId(opts.runId);
  const runId = runInfo.runId;
  const screenshots = [];
  const { mod: playwright, path: playwrightPath } = resolvePlaywright();
  const chromePath = resolveChrome();

  // --- 2. profile-lock handover -----------------------------------------------------------------
  // The harness's supervisor owns the Chrome user-data-dir for as long as it lives, and two
  // Chromes cannot share one. This tool needs the lock because the supervisor exposes navigation
  // only — it has no content-extraction action (see docs/tools/perplexity.md §8, "needed changes
  // in research-browser.mjs"). So the handover is explicit and reported, never a silent kill.
  const lockActions = [];
  const held = readHarnessSession(opts.profile);
  if (held.live) {
    const auth = readHarnessAuth(opts.profile);
    if (auth?.needs_login === true) {
      // A login handshake is IN FLIGHT: that browser is sitting on a wall waiting for Konrad,
      // possibly with him typing into it right now. Closing it would destroy exactly the thing
      // this tool needs. Surface it and stop.
      return {
        exitCode: EXIT_NEEDS_LOGIN,
        payload: needsLoginPayload({
          opts,
          runInfo,
          screenshots,
          reason: 'a login handshake is already in flight for this profile',
          harnessStatus: harness(['takeover', opts.profile, '--run-id', runId]).json,
          harnessAuth: auth,
        }),
      };
    }
    writeErr(
      `${SELF}: the harness supervisor (pid ${held.session.pid}) holds profile "${opts.profile}"; ` +
        `closing it to take the Chrome profile lock. Cookies are untouched — ` +
        `research-browser.mjs close never removes the profile directory.\n`,
    );
    harness(['close', opts.profile, '--run-id', runId]);
    lockActions.push({ what: 'harness supervisor', result: 'closed to take the profile lock', pid: held.session.pid });
  }

  // --- 3. takeover stack ------------------------------------------------------------------------
  // Needed even on the happy path: the browser must be HEADED (a headless session is useless to
  // take over, and Perplexity's bot defenses treat it worse), so it needs a real X display.
  const takeoverStatus = harness(['takeover', opts.profile, '--run-id', runId]).json;
  const display = takeoverStatus?.display;
  const novncPort = takeoverStatus?.takeover?.novnc_port;
  if (typeof display !== 'string' || !Number.isInteger(novncPort)) {
    apiError(
      `${SELF}: research-browser.mjs takeover returned no usable display/port. Body verbatim:\n` +
        `${JSON.stringify(takeoverStatus, null, 2)}`,
    );
  }

  // --- 4. launch --------------------------------------------------------------------------------
  // The launch flags are copied from research-browser.mjs's supervise(); they are not exported.
  // --disable-features=CDPScreenshotNewSurface is LOad-BEARING on this box (measured 2026-08-05:
  // without it every headed screenshot on Xvfb fails with "Unable to capture screenshot").
  const context = await playwright.chromium
    .launchPersistentContext(profileDir(opts.profile), {
      headless: false,
      executablePath: chromePath,
      viewport: { width: 1600, height: 1000 },
      env: { ...process.env, DISPLAY: display },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=CDPScreenshotNewSurface',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })
    .catch((err) => {
      apiError(
        `${SELF}: could not launch Chrome on ${profileDir(opts.profile)} (DISPLAY=${display}): ` +
          `${err.message.split('\n')[0]}\n` +
          `  If this says the profile is in use, another Chrome holds it: ` +
          `scripts/research-browser.mjs close ${opts.profile}`,
      );
    });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // --- navigate ---
    // URL submission is primary because it needs NO selector at all — the least rot-prone way to
    // start a query. The typed fallback exists for the day that URL scheme changes, and which one
    // ran is reported in the output as submission_strategy.
    let submission = 'url-query';
    try {
      await page.goto(searchUrl(opts.subject), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      apiError(`${SELF}: navigating to the Perplexity search URL failed: ${err.message.split('\n')[0]}`);
    }

    // --- Cloudflare interstitial, then classify ---
    // Measured 2026-08-05: the FIRST navigation to perplexity.ai reliably lands on a managed
    // challenge that clears itself. So a challenge is waited out, not judged on sight — and
    // whether one appeared, and how long it took, is reported rather than hidden.
    let capture = await harvest(page, runId, screenshots);
    const challenge = { seen: false, matched: null, cleared_after_ms: null };
    const challengeDeadline = Date.now() + opts.challengeTimeoutMs;
    const challengeStart = Date.now();
    for (;;) {
      const botWall = detectBotWall({ title: capture.title, text: capture.page_text_excerpt });
      if (botWall === null) {
        if (challenge.seen) {
          challenge.cleared_after_ms = Date.now() - challengeStart;
          writeErr(`${SELF}: Cloudflare challenge cleared after ${challenge.cleared_after_ms} ms\n`);
        }
        break;
      }
      if (!challenge.seen) {
        challenge.seen = true;
        challenge.matched = botWall;
        writeErr(
          `${SELF}: Perplexity served a Cloudflare challenge ("${botWall}"); waiting up to ` +
            `${opts.challengeTimeoutMs / 1000}s for it to clear itself\n`,
        );
      }
      if (Date.now() >= challengeDeadline) {
        await shoot(page, runId, 'perplexity-bot-wall', screenshots);
        // HAND THE PAGE BACK TO THE HARNESS BEFORE DYING, exactly as the login-wall branch does,
        // and for the same reason: this process cannot leave a browser on screen (playwright
        // kills the context when it exits), and a wall nobody can LOOK at is a dead end. The
        // harness re-opens the profile headed and leaves it running, so Konrad can reach the
        // real page over noVNC and — the only move that can actually clear a managed challenge —
        // interact with it himself. --no-reminder is not an oversight: a bot wall is not a login
        // wall, and queueing "please log in" for it would send him to do something that cannot
        // help. What he actually needs is in the message below and in the operator's report.
        await context.close().catch(() => {});
        const parked = harness(
          ['open', opts.profile, '--url', PERPLEXITY_HOME, '--run-id', runId,
           '--label', 'perplexity-bot-wall-parked', '--no-reminder'],
          { allowExit: [RB_EXIT.OK, RB_EXIT.LOGIN_REQUIRED] },
        );
        apiError(
          `${SELF}: Perplexity served a bot wall, not an answer — matched "${botWall}" at ${capture.url},\n` +
            `  and it did NOT clear within ${opts.challengeTimeoutMs / 1000}s.\n` +
            `  This is NOT a login wall and NO reminder was queued: logging in cannot fix a\n` +
            `  challenge page. 02-architecture §10 called this risk when it rejected scraping;\n` +
            `  see docs/tools/perplexity.md §7.2 and §12 for what is known and what to try.\n` +
            `  Screenshot: ${screenshots.at(-1)?.path ?? '<screenshot failed>'}\n` +
            `  A browser has been LEFT RUNNING on that page for a human takeover:\n` +
            `    tunnel: ${sshTunnelCommand(novncPort)}\n` +
            `    open:   ${novncUrl(novncPort)}\n` +
            `  If the challenge is an edge block on this host's egress IP (verify with\n` +
            `  \`curl -sI https://www.perplexity.ai/\` — a 403 to plain curl means it is), then no\n` +
            `  browser flag, longer --challenge-timeout or human click will pass it: the run needs\n` +
            `  a different egress IP. Harness status of the parked browser:\n` +
            `${indent(JSON.stringify(parked.json?.page ?? null, null, 2))}\n` +
            `  Page text excerpt:\n${indent(capture.page_text_excerpt)}`,
        );
      }
      await sleep(SAMPLE_INTERVAL_MS);
      capture = await harvest(page, runId, screenshots);
    }

    const verdict = evaluateLoginWall(SERVICES[SERVICE_KEY], {
      finalUrl: capture.url,
      passwordFieldCount: await page.locator('input[type="password"]:visible').count().catch(() => 0),
      loggedOutHits: await visibleHits(page, SERVICES[SERVICE_KEY].loggedOutSelectors),
      loggedInHits: await visibleHits(page, SERVICES[SERVICE_KEY].loggedInSelectors),
    });

    if (verdict.needsLogin) {
      // HAND THE WHOLE HANDSHAKE BACK TO THE HARNESS. This tool must not log in, must not prompt
      // for credentials, and cannot leave a browser running for a takeover (playwright kills the
      // context when this process exits) — all three are the harness's job. Close ours first so
      // it can take the profile lock back.
      await shoot(page, runId, 'perplexity-login-wall-seen', screenshots);
      await context.close().catch(() => {});
      const handshake = harness(
        ['open', opts.profile, '--url', PERPLEXITY_HOME, '--run-id', runId, '--label', 'perplexity-login-wall'],
        { allowExit: [RB_EXIT.OK, RB_EXIT.LOGIN_REQUIRED] },
      );
      if (handshake.status === RB_EXIT.OK) {
        apiError(
          `${SELF}: contradictory login state. This tool saw a login wall at ${capture.url} ` +
            `(${verdict.decision}: ${verdict.reasons.join('; ')}), but research-browser.mjs then ` +
            `reported the profile as fine. Nothing is emitted rather than guessing which is right.\n` +
            `  harness status:\n${indent(JSON.stringify(handshake.json, null, 2))}`,
        );
      }
      return {
        exitCode: EXIT_NEEDS_LOGIN,
        payload: needsLoginPayload({
          opts,
          runInfo,
          screenshots,
          reason: `${verdict.decision}: ${verdict.reasons.join('; ')}`,
          harnessStatus: handshake.json,
          harnessAuth: null,
          lockActions,
        }),
      };
    }

    // --- typed fallback, if the URL scheme stopped kicking off a query ---
    if (capture.answer === null) {
      const typed = await trySubmitByTyping(page, opts.subject);
      if (typed) {
        submission = 'typed';
        capture = await harvest(page, runId, screenshots);
      }
    }

    // --- 5. wait for streaming to settle ---
    const samples = [];
    const deadline = Date.now() + opts.answerTimeoutMs;
    for (;;) {
      capture = await harvest(page, runId, screenshots);
      samples.push({
        at_ms: Date.now(),
        length: capture.answer?.text?.length ?? 0,
        streaming: capture.streaming === true,
      });
      if (isSettled(samples)) break;
      if (Date.now() >= deadline) {
        await shoot(page, runId, 'perplexity-stream-timeout', screenshots);
        apiError(
          `${SELF}: the answer never settled within ${opts.answerTimeoutMs} ms at ${capture.url}.\n` +
            `  Answer length per sample: ${samples.map((s) => s.length).join(' → ')}\n` +
            `  Streaming indicator on the last sample: ${samples.at(-1).streaming}\n` +
            `  NO answer is emitted: a still-growing answer is a partial one, and a partial\n` +
            `  answer presented as complete is the failure mode this tool refuses.\n` +
            `  Raise --answer-timeout, or see docs/tools/perplexity.md §7 if the selectors rotted.\n` +
            `  Screenshot: ${screenshots.at(-1)?.path ?? '<screenshot failed>'}\n` +
            `  Page text excerpt:\n${indent(capture.page_text_excerpt)}`,
        );
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }

    // --- harvest, parse, screenshot ---
    if (opts.dumpCapture !== undefined) {
      writeFileSync(resolve(opts.dumpCapture), `${JSON.stringify(capture, null, 2)}\n`);
      writeErr(`${SELF}: raw DOM capture written to ${resolve(opts.dumpCapture)}\n`);
    }

    let parsed;
    try {
      parsed = parseAnswerCapture(capture, { allowUncited: opts.allowUncited });
    } catch (err) {
      // A parse failure is exactly the "selector rotted" case: screenshot it before dying, so the
      // diagnostic carries a picture as well as a page excerpt.
      await shoot(page, runId, 'perplexity-extraction-failed', screenshots);
      if (err instanceof CliError) {
        apiError(
          `${err.message}\n  Screenshot: ${screenshots.at(-1)?.path ?? '<screenshot failed>'}\n` +
            `  Screenshot URL: ${screenshots.at(-1)?.url ?? 'n/a'}`,
        );
      }
      throw err;
    }

    await shoot(page, runId, opts.label ?? 'perplexity-answer', screenshots);

    return {
      exitCode: EXIT_OK,
      payload: {
        backend: 'browser',
        needs_login: false,
        question: opts.subject,
        answer: parsed.answer,
        citations: parsed.sources.map((s) => s.url),
        sources: parsed.sources,
        // Kept for the R22/R23 output contract: consumers written against the API backend read
        // search_results. Browser sources carry {url,title} and no snippet — documented in
        // docs/tools/perplexity.md §4.
        search_results: parsed.sources.map((s) => ({ url: s.url, title: s.title })),
        model: null, // the web UI does not disclose which model served the answer
        usage: null, // nor any token accounting
        screenshots,
        extraction: {
          answer_selector: parsed.answer_selector,
          sources_strategy: parsed.sources_strategy,
          sources_region_selector: capture.sources_region_selector,
          submission_strategy: submission,
          links_harvested: capture.links.length,
          links_dropped: parsed.dropped,
          answer_candidates_tried: capture.answer_candidates_tried,
        },
        bot_challenge: challenge,
        stream: {
          samples: samples.length,
          settled_after_ms: samples.at(-1).at_ms - samples[0].at_ms,
          final_length: samples.at(-1).length,
        },
        page: { url: capture.url, title: capture.title },
        profile: { name: opts.profile, dir: profileDir(opts.profile) },
        run_id: runId,
        run_id_source: runInfo.source,
        run_id_servable: isServableRunId(runId),
        takeover: {
          display,
          novnc_port: novncPort,
          novnc_url: novncUrl(novncPort),
          ssh_tunnel: sshTunnelCommand(novncPort),
          bound_to: '127.0.0.1 only — never a public interface',
        },
        lock_actions: lockActions,
        runtime: { playwright: playwrightPath, chrome: chromePath },
      },
    };
  } finally {
    if (!opts.keepOpen) await context.close().catch(() => {});
  }
}

/**
 * Run the DOM harvest, or fail LOUDLY. An evaluate() that throws means the harvester itself
 * could not run — a broken selector string, a page that navigated out from under it, a CSP that
 * refused the injection. That is a tooling failure, and it gets the same treatment as a rotted
 * selector: a screenshot, the page URL, and no answer. It must never surface as a bare stack.
 */
async function harvest(page, runId, screenshots) {
  try {
    return await page.evaluate(CAPTURE_SOURCE, captureArg());
  } catch (err) {
    await shoot(page, runId, 'perplexity-harvest-failed', screenshots);
    return apiError(
      `${SELF}: the DOM harvest could not run on ${page.url()}: ${err.message.split('\n')[0]}\n` +
        `  This is the harvester itself failing, not a missing element. Check SELECTORS in\n` +
        `  scripts/perplexity.mjs for an unparseable entry (the domCss lists must be PLAIN CSS —\n` +
        `  playwright pseudo-classes like :has-text() are invalid inside page.evaluate).\n` +
        `  Screenshot: ${screenshots.at(-1)?.path ?? '<screenshot failed>'}`,
    );
  }
}

/** Which of `selectors` are visible right now. A selector that cannot be evaluated counts as a miss. */
async function visibleHits(page, selectors) {
  const hits = [];
  for (const sel of selectors ?? []) {
    try {
      if (await page.locator(sel).first().isVisible()) hits.push(sel);
    } catch {
      /* unevaluatable selector — the harness reports these too; here a miss is the safe reading */
    }
  }
  return hits;
}

/**
 * Secondary submission path: type the question into the ask box and press Enter. Only reached
 * when the URL-query navigation produced no answer element, and always reported as
 * submission_strategy: "typed" so nobody has to guess which path ran.
 */
async function trySubmitByTyping(page, question) {
  for (const sel of SELECTORS.askBox.pwLocator) {
    try {
      const box = page.locator(sel).first();
      if (!(await box.isVisible())) continue;
      await box.click();
      await box.fill(question);
      await page.keyboard.press('Enter');
      writeErr(`${SELF}: URL submission produced no answer element; typed the query into "${sel}" instead\n`);
      return true;
    } catch {
      /* try the next candidate; a total miss is handled by the caller's extraction failure */
    }
  }
  return false;
}

/**
 * The needs-login result shape. Stable, exported, and the same whichever branch produced it —
 * an in-flight handshake found before launch and a wall seen after navigation must be
 * indistinguishable to a consumer. Exported so the suite can pin the shape without a browser.
 */
export function needsLoginPayload({ opts, runInfo, screenshots, reason, harnessStatus, harnessAuth, lockActions = [] }) {
  const harnessShots = Array.isArray(harnessStatus?.screenshots) ? harnessStatus.screenshots : [];
  const novncPort = harnessStatus?.takeover?.novnc_port ?? null;
  return {
    backend: 'browser',
    needs_login: true,
    question: opts.subject,
    // Explicitly null/empty, never omitted: a consumer must be able to read `answer` on every
    // browser result and see that there is none.
    answer: null,
    citations: [],
    sources: [],
    search_results: [],
    model: null,
    usage: null,
    reason,
    screenshots: [...screenshots, ...harnessShots],
    reminder: harnessStatus?.reminder ?? null,
    login: harnessStatus?.login ?? harnessAuth ?? null,
    takeover: harnessStatus?.takeover ?? null,
    next_steps: [
      novncPort === null
        ? 'Open the tunnel named in the reminder (the harness reported no noVNC port)'
        : `1. From your laptop: ${sshTunnelCommand(novncPort)}`,
      novncPort === null ? 'Open the noVNC URL from the reminder' : `2. Open ${novncUrl(novncPort)}`,
      '3. Log into Perplexity BY HAND in that Chrome window, then leave it alone.',
      `4. Re-run this command. No password is stored anywhere — only Perplexity's session cookie, inside ${profileDir(opts.profile)}.`,
    ],
    profile: { name: opts.profile, dir: profileDir(opts.profile) },
    run_id: runInfo.runId,
    run_id_source: runInfo.source,
    run_id_servable: isServableRunId(runInfo.runId),
    lock_actions: lockActions,
  };
}

// =================================================================================================
// API BACKEND — behaviour unchanged from R502. Only the emitted envelope gained a "backend" field.
// =================================================================================================

/**
 * Whitelist body for POST /v1/agent. The Agent API rejects ANY unknown field with a hard 400,
 * so this is built field by field — never spread from user input.
 */
function buildAskBody(opts) {
  const body = {
    input: opts.subject,
    // Web search is NOT automatic on the Agent API: without this the answer is ungrounded.
    tools: [{ type: 'web_search' }],
    tool_choice: opts.forceSearch ? { type: 'web_search' } : 'auto',
    max_steps: opts.maxSteps,
    max_tool_calls: opts.maxToolCalls,
  };
  // model XOR preset — exactly one goes on the wire.
  if (opts.preset !== undefined) body.preset = opts.preset;
  else body.model = opts.model ?? DEFAULT_MODEL;
  if (opts.instructions !== undefined) body.instructions = opts.instructions;
  return body;
}

async function post(url, apiKey, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    apiError(`Request to ${url} failed at the transport layer: ${err.name}: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Verbatim status + body: this is what proves the request path without a valid key (R23).
    apiError(`HTTP ${res.status} ${res.statusText} from ${url}\n${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    apiError(`HTTP ${res.status} from ${url} but the body is not valid JSON (${err.message}). Body verbatim:\n${text}`);
  }
}

/**
 * Sources live in the output[] item with type "search_results", under key "results".
 *
 * The two "no sources" shapes are deliberately NOT merged. No search_results item at all is a
 * legal run that cited nothing. An item that IS present but whose "results" is not an array
 * means the vendor moved the payload, and emitting [] there would file an uncited answer in the
 * researcher lane as a successful cited one, exit 0 and all. That is a hard error with the body
 * verbatim, exactly as runSearch() treats the same ambiguity.
 */
function extractSearchResults(response) {
  if (!Array.isArray(response.output)) return [];
  const item = response.output.find((o) => o !== null && typeof o === 'object' && o.type === 'search_results');
  if (item === undefined) return [];
  if (!Array.isArray(item.results)) {
    apiError(
      `Agent response carries a "search_results" output item whose "results" is not an array ` +
        `(got ${item.results === null ? 'null' : typeof item.results}) — the sources cannot be read, ` +
        `so no answer is emitted rather than one that looks uncited. Body verbatim:\n` +
        `${JSON.stringify(response, null, 2)}`,
    );
  }
  return item.results;
}

/** Answer text = the output_text parts of every output[] item with type "message". */
function extractAnswer(response) {
  if (!Array.isArray(response.output)) return '';
  const parts = [];
  for (const item of response.output) {
    if (item === null || typeof item !== 'object' || item.type !== 'message') continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part !== null && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

/** De-duplicated URLs from the search_results item, in order. No top-level citations field exists. */
function extractCitations(searchResults) {
  const seen = new Set();
  const urls = [];
  for (const r of searchResults) {
    if (r === null || typeof r !== 'object' || typeof r.url !== 'string' || r.url === '') continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    urls.push(r.url);
  }
  return urls;
}

async function runApiAsk(opts, apiKey) {
  const response = await post(AGENT_URL, apiKey, buildAskBody(opts));

  // Failures arrive as HTTP 200 — branch on response.status, never on the HTTP code alone.
  const status = response.status;
  if (typeof status !== 'string') {
    apiError(`Agent response has no "status" field. Body verbatim:\n${JSON.stringify(response, null, 2)}`);
  }
  if (status === 'failed' || status === 'cancelled') {
    apiError(`Agent run ${status}. error object verbatim:\n${JSON.stringify(response.error ?? null, null, 2)}`);
  }
  if (status !== 'completed' && status !== 'incomplete') {
    // queued / in_progress are not terminal, and this helper never requests background mode.
    apiError(`Agent run is not terminal (status "${status}") — no answer to emit. Body verbatim:\n${JSON.stringify(response, null, 2)}`);
  }
  if (status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? '(no incomplete_details.reason in the response)';
    writeErr(`warning: Agent run status "incomplete" — incomplete_details.reason: ${reason}\n`);
  }

  const searchResults = extractSearchResults(response);
  return {
    exitCode: EXIT_OK,
    payload: {
      backend: 'api',
      question: opts.subject,
      answer: extractAnswer(response),
      citations: extractCitations(searchResults),
      search_results: searchResults,
      model: response.model ?? null,
      usage: response.usage ?? null,
    },
  };
}

async function runSearch(opts, apiKey) {
  const response = await post(SEARCH_URL, apiKey, { query: opts.subject, max_results: opts.maxResults });

  // The Search API is a separate product from the Agent API: no status envelope, results at the
  // top level. Its response key could not be confirmed against the wire (no key on this box as of
  // 2026-08-05), so both documented spellings are accepted and anything else is a hard error with
  // the body printed verbatim — never a silent empty result.
  const results = Array.isArray(response.results)
    ? response.results
    : Array.isArray(response.search_results)
      ? response.search_results
      : undefined;
  if (results === undefined) {
    apiError(
      `Search response contains neither a "results" nor a "search_results" array. Body verbatim:\n${JSON.stringify(response, null, 2)}`,
    );
  }

  return { exitCode: EXIT_OK, payload: { backend: 'api', search_results: results } };
}

// =================================================================================================
// main
// =================================================================================================
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliError) usageError(err.message);
    throw err;
  }
  if (opts.help) {
    writeOut(USAGE);
    process.exit(EXIT_OK);
  }

  // Gate order: arguments, then the backend's own prerequisite, then the filesystem — the same
  // order as gemini-qa.mjs. The key check stays ahead of the --out pre-flight so a keyless caller
  // on the api backend always gets exit 2.
  const apiKey = opts.backend === 'api' ? resolveApiKey() : null;
  assertOutWritable(opts.out);
  assertOutWritable(opts.dumpCapture, '--dump-capture');

  let result;
  if (opts.mode === 'search') result = await runSearch(opts, apiKey);
  else if (opts.backend === 'api') result = await runApiAsk(opts, apiKey);
  else result = await runBrowserAsk(opts);

  emit(result.payload, opts.out);

  if (result.exitCode === EXIT_NEEDS_LOGIN) {
    writeErr(
      `\n${SELF}: NEEDS LOGIN — Perplexity is not logged in inside profile "${opts.profile}".\n` +
        `  This is the EXPECTED first-run outcome, not a crash. Nothing was scraped and no\n` +
        `  credential was read, typed or stored by this tool.\n` +
        `  What Konrad must do, once:\n` +
        result.payload.next_steps.map((s) => `    ${s}\n`).join('') +
        `  A reminder was ${result.payload.reminder?.queued === true ? 'queued' : `not queued (${result.payload.reminder?.reason ?? 'no reminder reported by the harness'})`}.\n` +
        `  Wall screenshot(s):\n` +
        (result.payload.screenshots.length === 0
          ? '    <none>\n'
          : result.payload.screenshots.map((s) => `    ${s.path}  (${s.url})\n`).join('')),
    );
  }
  process.exit(result.exitCode);
}

/**
 * Only run as a program when invoked as one. The test suite imports the pure helpers above from
 * this same file — importing must therefore not parse argv, resolve a key, or launch a browser.
 * Inode comparison rather than path comparison, so a symlinked invocation still counts.
 */
function isMain() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return statSync(entry).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isMain()) {
  await main(process.argv.slice(2)).catch((err) => {
    if (err instanceof CliError) die(err.code, err.message);
    die(EXIT_API, `${SELF}: unhandled: ${err?.stack ?? err}`);
  });
}
