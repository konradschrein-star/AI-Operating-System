#!/usr/bin/env node
// gemini-qa.mjs — video quality assurance through Gemini. Hand it a local video file
// (or, on the api backend, a public/YouTube URL), get back the frozen QA rubric as JSON
// with timestamped findings a human (or later a repair agent) can jump to.
//
// TWO BACKENDS (R702):
//   pool (DEFAULT) — the local Gemini Pool at http://127.0.0.1:8090/v1/analyze, a private
//     wrapper around the Gemini WEB UI riding pool-account entitlements. Costs nothing.
//     Returns FREE TEXT, so the rubric JSON is extracted from the reply (fences + chatter
//     stripped) and then validated. Konrad has no personal Gemini key and does not want
//     one, so this is the primary path.
//   api — the official Gemini API (Files API upload → poll ACTIVE → generateContent with
//     responseSchema). Billed to GEMINI_API_KEY. Structured output, selectable model.
//
// NO AUTOMATIC FALLBACK BETWEEN BACKENDS — not even opt-in. R702's brief permits an
// opt-in fallback only if pool failures are cleanly distinguishable; docs/research/
// round-701-33d8cba3.md section 6 proves they are NOT: a dead account, an unsupported
// file and a transient Google hiccup all surface as the same opaque HTTP 500
// "Unknown API error code: 1100". A fallback keyed on an undiagnosable error would
// silently ship Konrad's video to a billed endpoint. Choose the backend explicitly.
//
// ⚠ CREDENTIAL NAME COLLISION — the single most dangerous thing in this file.
//   GEMINI_API_KEY       = a Google AI Studio key. Used ONLY by the `api` backend.
//   GEMINI_POOL_API_KEY  = the pool wrapper's own caller token, sent as `x-api-key`.
//   /opt/gemini-pool-api/.env calls that pool token `GEMINI_API_KEY` in ITS OWN file —
//   the same name, a completely different credential. The two are never read from the
//   same place and never cross: resolvePoolKey() never reads process.env.GEMINI_API_KEY,
//   and resolveApiKey() never reads /opt/gemini-pool-api/.env. Keep it that way, or you
//   will send a pool token to Google and a Google key to the pool.
//
// Deliberately zero-dependency: node >= 22 built-in fetch/FormData/File only, no SDK, no
// shared lib. The key-resolution block below is duplicated in scripts/perplexity.mjs on
// purpose — 02-architecture.md section 6.1 requires each script to stay standalone-copyable.
//
// NO SILENT FALLBACKS: nothing is retried, no model is substituted, no malformed answer is
// repaired, no failure is swallowed. Every failure path prints what actually happened and
// exits non-zero.
//
// usage: scripts/gemini-qa.mjs <video-path-or-url> [--backend pool|api] [--model M]
//                              [--out FILE] [--prompt-extra "..."] [--timeout S]
//                              [--preflight] [--help]
//
// exit codes:
//   0  QA JSON produced
//   1  API or processing error (invalid key, upload failure, poll timeout, unparseable
//      or incomplete response) — HTTP status + response body reach stderr verbatim
//   2  no API key — the message names EVERY location that was checked
//   3  usage error (no argument, unknown flag, unreadable input, unusable --out target,
//      URL input on the pool backend, --model on the pool backend)
//   4  pool is busy or rate-limited (HTTP 503 / 429) — retryable LATER, by a human or a
//      caller that knows the cadence. This tool never retries by itself.
//
// The QA JSON ALWAYS goes to stdout; --out only adds a durable copy, written afterwards.
// A paid (or slow) result must never be destroyed by a local write fault.

import { readFileSync, statSync, accessSync, writeFileSync, writeSync, constants } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';

const SELF = 'gemini-qa.mjs';

// ---------------------------------------------------------------------------
// Synchronous, drain-guaranteed output (R405 finding 2).
//
// process.stdout/stderr are ASYNCHRONOUS when they point at a pipe, and the researcher lane
// captures this script through a pipe. process.stdout.write() only queues the bytes;
// process.exit() then throws away whatever has not drained, truncating at the 64 KiB pipe
// buffer. For a tool whose entire value is "here is the QA JSON you just paid ~$5 for" and
// whose diagnostics print Gemini's response body verbatim, a silent 64 KiB cut is fatal.
//
// writeSync() on the raw fd is done before exit() can discard anything. EAGAIN is the
// non-blocking-pipe "buffer full, retry" signal, not a failure; EPIPE means the reader is
// already gone (`| head`), and there is nobody left to write to.
// ---------------------------------------------------------------------------
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
      if (err.code === 'EPIPE') return; // reader closed
      throw err;
    }
  }
}

/** All stdout goes through here — never process.stdout.write (see above). */
const writeOut = (text) => writeFd(1, text);
/** All stderr goes through here — never process.stderr.write (see above). */
const writeErr = (text) => writeFd(2, text);

// round-399 finding 1: 02-architecture.md section 6.2 documents `gemini-3.6-flash` as the
// default, but that model does NOT accept video input — the tool's primary use case would
// fail on every invocation. `gemini-omni-flash` is the video-capable model as of
// 2026-08-05 (docs/research/round-399-41e8757d.md). The doc is wrong; this line is right.
//
// R705: "right" here still means UNVERIFIED against the vendor. round-701-33d8cba3.md:331
// says verbatim "treat `gemini-omni-flash` as unconfirmed; validate against
// GET /v1beta/models before trusting it", and no Gemini key has ever existed on this box, so
// nobody could. That caveat is now enforced rather than remembered: assertModelAvailable()
// below checks the model against the live model list before the first billed call. The name
// is a documented default, not a proven one, until that check passes on a real key.
const DEFAULT_MODEL = 'gemini-omni-flash';

const API_ROOT = 'https://generativelanguage.googleapis.com';
const SECRET_FILE = '/opt/ai-os/.secrets/store/gemini-api-key';
const ENV_VAR = 'GEMINI_API_KEY';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// The whole Gemini catalogue fits in one page of this size. If it ever does not, the
// "unknown model" message says so rather than asserting absence from a partial list.
const MODEL_LIST_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Pool backend (R702). Wire contract measured in docs/research/round-701-33d8cba3.md:
//   POST /v1/analyze, multipart/form-data, fields `prompt` (string) + `file` (binary),
//   header `x-api-key` → 200 {"text": string, "account": string}.
//
// INTERNAL ADDRESS ONLY. The public route (hub.schreinercontentsystems.com/gemini/) caps
// bodies at 200 MB and reads at 120 s (nginx), and returns HTML — not JSON — on 413.
// A real video analysis will exceed 120 s, so the public route is unusable here by design.
// ---------------------------------------------------------------------------
const POOL_ROOT = 'http://127.0.0.1:8090';
const POOL_ENV_VAR = 'GEMINI_POOL_API_KEY';
const POOL_SECRET_FILE = '/opt/ai-os/.secrets/store/gemini-pool-api-key';
// ⚠ The variable INSIDE this file is named GEMINI_API_KEY (see the header note). It is the
// pool's caller token, NOT a Google key. This is the only place that name may be read for
// the pool, and it is read out of a file — never out of the environment.
const POOL_DOTENV_FILE = '/opt/gemini-pool-api/.env';
const POOL_DOTENV_VAR = 'GEMINI_API_KEY';

// Default request timeout for the pool, deliberately far above anything measured.
// Reference points from round 701 + the R702 build run: a text /v1/chat round trip took
// 46 s; the wrapper's own failure ceiling (6 attempts + 75 s of backoff) is ~95 s; session
// acquisition alone can burn 60 s before work starts. Video is slower than all of it, and
// abandoning a request mid-flight wastes a pool session for another minute-and-a-half, so
// the default is generous rather than tight. --timeout overrides it.
const POOL_TIMEOUT_S = 900;
// The liveness probe is cheap in bytes but NOT in time (~46 s) and occupies one of only
// four sessions serving other production work, so it is opt-in (--preflight) rather than
// automatic. Round 701 recommends running it after any suspected pool outage: /health
// reports sessions_ready over sessions that cannot generate at all.
const POOL_PREFLIGHT_TIMEOUT_S = 180;

// Gemini infers nothing from a filename; the Files API wants an explicit MIME type, so an
// unknown extension is a hard usage error rather than a guessed content type.
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
  '.3gpp': 'video/3gpp',
  '.mkv': 'video/x-matroska',
};

// ---------------------------------------------------------------------------
// The QA rubric — FROZEN CONTRACT (02-architecture.md section 6.2). The video pipeline
// consumes this exact shape later: do not rename, add or drop a field.
// ---------------------------------------------------------------------------
const RUBRIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'needs_work', 'reject'] },
    confidence: { type: 'number' },
    hook: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        first_seconds_analysis: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['score', 'first_seconds_analysis', 'notes'],
      propertyOrdering: ['score', 'first_seconds_analysis', 'notes'],
    },
    pacing: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        dead_spots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start_s: { type: 'number' },
              end_s: { type: 'number' },
              note: { type: 'string' },
            },
            required: ['start_s', 'end_s', 'note'],
            propertyOrdering: ['start_s', 'end_s', 'note'],
          },
        },
      },
      required: ['score', 'dead_spots'],
      propertyOrdering: ['score', 'dead_spots'],
    },
    audio: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        glitches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              at_s: { type: 'number' },
              type: {
                type: 'string',
                enum: ['click', 'dropout', 'desync', 'clipping', 'other'],
              },
              note: { type: 'string' },
            },
            required: ['at_s', 'type', 'note'],
            propertyOrdering: ['at_s', 'type', 'note'],
          },
        },
      },
      required: ['score', 'glitches'],
      propertyOrdering: ['score', 'glitches'],
    },
    visual: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              at_s: { type: 'number' },
              type: {
                type: 'string',
                enum: ['flicker', 'blur', 'caption_error', 'broken_asset', 'other'],
              },
              note: { type: 'string' },
            },
            required: ['at_s', 'type', 'note'],
            propertyOrdering: ['at_s', 'type', 'note'],
          },
        },
      },
      required: ['score', 'artifacts'],
      propertyOrdering: ['score', 'artifacts'],
    },
    factual: {
      type: 'object',
      properties: {
        red_flags: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              at_s: { type: 'number' },
              claim: { type: 'string' },
              concern: { type: 'string' },
            },
            required: ['at_s', 'claim', 'concern'],
            propertyOrdering: ['at_s', 'claim', 'concern'],
          },
        },
      },
      required: ['red_flags'],
      propertyOrdering: ['red_flags'],
    },
    top_fixes: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: [
    'verdict',
    'confidence',
    'hook',
    'pacing',
    'audio',
    'visual',
    'factual',
    'top_fixes',
    'summary',
  ],
  propertyOrdering: [
    'verdict',
    'confidence',
    'hook',
    'pacing',
    'audio',
    'visual',
    'factual',
    'top_fixes',
    'summary',
  ],
};

const QA_PROMPT = [
  'You are a video quality assurance reviewer. Watch the entire video and judge it as a',
  'demanding editor would: hook strength, pacing, audio integrity, visual integrity, and',
  'factual soundness.',
  '',
  'Rules for your report:',
  '- Every finding MUST carry a timestamp in seconds from the start of the video',
  '  (start_s / end_s / at_s). Never omit a timestamp, never give a range as text.',
  '- hook.first_seconds_analysis judges the first 3 seconds specifically: does it earn the',
  '  next 10 seconds of attention?',
  '- Scores are integers 0-10. confidence is 0.0-1.0 and reflects how much of the video you',
  '  could actually assess.',
  '- top_fixes is ordered by impact, most valuable first, at most 5 entries, each concrete',
  '  and actionable ("cut 0:12-0:19", not "improve pacing").',
  '- If a category has no findings, return an empty array — do not invent problems.',
  '- verdict: "pass" ships as is, "needs_work" is fixable with the listed fixes, "reject"',
  '  means re-produce.',
  '- summary is 2-3 sentences.',
].join('\n');

// ---------------------------------------------------------------------------
// Pool-only prompt suffix. The api backend gets the rubric as a machine-enforced
// responseSchema; the pool has no structured-output parameter of any kind (its wrapper
// never even selects a model), so the shape has to be asked for in words and extracted
// from prose afterwards. The skeleton below is the SAME frozen contract as RUBRIC_SCHEMA —
// if you touch one, touch both. Nothing here repairs a bad answer; it only asks clearly.
// ---------------------------------------------------------------------------
const POOL_JSON_INSTRUCTION = [
  '',
  'OUTPUT FORMAT — this is consumed by a program, not a person:',
  'Reply with ONE fenced ```json block and nothing else. No preamble, no commentary after',
  'the block. Every key below is REQUIRED, even when its array is empty.',
  '',
  '```json',
  '{',
  '  "verdict": "pass | needs_work | reject",',
  '  "confidence": 0.0,',
  '  "hook": { "score": 0, "first_seconds_analysis": "...", "notes": "..." },',
  '  "pacing": { "score": 0, "dead_spots": [{ "start_s": 0, "end_s": 0, "note": "..." }] },',
  '  "audio": { "score": 0, "glitches": [{ "at_s": 0, "type": "click|dropout|desync|clipping|other", "note": "..." }] },',
  '  "visual": { "score": 0, "artifacts": [{ "at_s": 0, "type": "flicker|blur|caption_error|broken_asset|other", "note": "..." }] },',
  '  "factual": { "red_flags": [{ "at_s": 0, "claim": "...", "concern": "..." }] },',
  '  "top_fixes": ["..."],',
  '  "summary": "..."',
  '}',
  '```',
].join('\n');

const USAGE = `usage: gemini-qa.mjs <video-path-or-url> [--backend pool|api] [--model M] [--out FILE]
                    [--prompt-extra "..."] [--timeout S] [--preflight] [--no-model-check]
                    [--help]

Video quality assurance through Gemini. Output is the frozen QA rubric as JSON on stdout.

backends (--backend, default: pool — there is NO automatic fallback between them):
  pool   the local Gemini Pool, POST ${POOL_ROOT}/v1/analyze (multipart upload,
         x-api-key header). Rides pool-account entitlements: no Google key, no bill.
         The pool returns FREE TEXT, so the rubric JSON is extracted from the reply
         (\`\`\`json fences and surrounding chatter stripped) and then validated. An answer
         that will not parse, or is missing a rubric key, is exit 1 with the model's raw
         text printed verbatim — it is never patched up.
         Local files only (see --backend pool and URLs below), and --model is rejected:
         the pool wrapper never selects a model, so a --model value would be a silent lie.
  api    the official Gemini API: Files API resumable upload -> poll until ACTIVE ->
         generateContent with a machine-enforced responseSchema. Billed. Accepts URLs
         (YouTube included) and honours --model.

  Why no fallback: pool failures are not diagnosable. A dead pool account, an unsupported
  file and a transient Google fault all return the same opaque HTTP 500 "Unknown API error
  code: 1100" (docs/research/round-701-33d8cba3.md section 6). Falling back on an
  undiagnosable error would silently move Konrad's video onto a billed endpoint. Pick one.

arguments:
  <video-path-or-url>     local video file (both backends), or an http(s):// URL
                          (api backend ONLY — see below)

URLs and the pool backend:
  \`gemini-qa <url>\` on the pool backend is a USAGE ERROR (exit 3), not a download.
  /v1/analyze takes an uploaded body, not a URI, and a YouTube watch URL is a web page
  rather than a video file — resolving it would mean shipping a downloader and a
  bounded-size temp-file dance for a case the api backend already handles natively.
  Download the video yourself and pass the file, or use --backend api.

flags:
  --backend pool|api      which service answers                (default: pool)
  --model M               Gemini model — api backend ONLY      (default: ${DEFAULT_MODEL})
                          Rejected with exit 3 on the pool backend, which cannot select a
                          model at all: whatever the pool account's web-UI default is
                          answers, so QA verdicts may drift with it. That is a known
                          property of the free path, stated rather than hidden.
                          THE DEFAULT IS UNVERIFIED: no Gemini key has ever existed on this
                          box, so ${DEFAULT_MODEL} comes from research
                          (docs/research/round-701-33d8cba3.md), which itself said to
                          validate it before trusting it. That validation now happens on
                          every api run — see --no-model-check.
  --out FILE              ALSO write the QA JSON to FILE       (default: stdout only)
                          stdout always gets the JSON first, so a result survives a write
                          failure. FILE must not be a directory and must be writable;
                          that is pre-flighted before any upload or request (exit 3).
  --prompt-extra "..."    extra caller context appended to the QA prompt,
                          e.g. "this is a 60s YouTube Short about sky photography"
                                                               (default: none)
  --timeout S             pool request timeout in whole seconds (default: ${POOL_TIMEOUT_S})
                          pool backend only. Video analysis is slow and a session that is
                          abandoned mid-flight stays busy anyway, so the default is
                          deliberately generous. Must be a positive integer.
  --preflight             pool backend only: before uploading anything, send the cheapest
                          possible liveness probe (POST /v1/chat "Reply with OK") and abort
                          on any non-200. Off by default because it costs ~46 s and holds
                          one of only four pool sessions. Round 701 recommends it after any
                          suspected outage: GET /health reports sessions as ready even when
                          every one of them is incapable of generating.
  --no-model-check        api backend only: skip the ListModels validation below.
                          By default every api run first issues GET /v1beta/models (free,
                          one round trip) and refuses to upload anything unless the chosen
                          model is listed AND advertises generateContent. That gate exists
                          because ${DEFAULT_MODEL} was never confirmed against
                          the vendor by anyone — it is research, not observation. Skipping
                          it is exit 3 on the pool backend, which selects no model.
  --help, -h              print this help and exit 0
  Flags accept either "--model M" or "--model=M".

credentials — TWO DIFFERENT SECRETS THAT SHARE A NAME, read the whole block:
  pool backend, resolved in this order, first non-empty wins:
    1. environment variable  ${POOL_ENV_VAR}
    2. secret-store file     ${POOL_SECRET_FILE}
    3. ${POOL_DOTENV_VAR}= line inside ${POOL_DOTENV_FILE}
       That file names its own caller token ${POOL_DOTENV_VAR} — the SAME name the api
       backend uses for a Google AI Studio key, for a completely unrelated credential.
       This tool never reads the environment variable ${ENV_VAR} for the pool.
  api backend, resolved in this order, first non-empty wins:
    1. environment variable  ${ENV_VAR}
    2. secret-store file     ${SECRET_FILE}
  If the selected backend finds no key, the tool exits 2 naming every location it checked,
  without making any HTTP request. The key is never printed.

supported local video extensions:
  ${Object.keys(VIDEO_MIME).join(' ')}
  On the pool backend the extension is load-bearing beyond validation: the wrapper derives
  the upload's MIME type from the filename alone, with no content sniffing.

output:
  The frozen QA rubric (02-architecture.md section 6.2), pretty-printed JSON with keys:
    verdict (pass|needs_work|reject), confidence, hook, pacing, audio, visual, factual,
    top_fixes, summary
  Identical on both backends — the rubric is a frozen contract, not a per-backend shape.
  Every finding carries a timestamp in seconds from the start of the video.
  It is written to stdout on every successful run; --out adds a copy, it does not divert.

exit codes:
  0  success — QA JSON on stdout (and in --out FILE if given)
  1  API or processing error: invalid key, upload failure, file processing FAILED,
     poll timeout (${POLL_TIMEOUT_MS / 60000} min), non-2xx response, request timeout,
     unparseable or incomplete model output. HTTP status and response body are printed
     verbatim; on the pool backend that includes the model's raw text.
  2  missing key: the message names every location checked for the chosen backend
  3  usage or configuration error: no argument, unknown flag, unreadable input file,
     unsupported extension, a URL on the pool backend, --model on the pool backend, a bad
     --timeout, a --model that GET /v1beta/models does not list or that cannot do
     generateContent (nothing uploaded, nothing billed), or an unusable --out target (a
     directory, unwritable, or a missing parent directory). If --out fails AFTER the
     request, the exit is still 3 and the QA JSON is already on stdout in full.
  4  pool busy or rate-limited: HTTP 503 (no session free within the wrapper's own 60 s
     acquire window) or HTTP 429 (the account is cooling down, ~300 s). Distinct from 1
     because it is the one failure worth retrying later. This tool never retries itself.

examples:
  gemini-qa.mjs ./render/final.mp4                        # pool, free
  gemini-qa.mjs ./render/final.mp4 --preflight            # probe the pool first
  gemini-qa.mjs ./render/final.mp4 --timeout 1800         # a long feature render
  gemini-qa.mjs ./clip.mp4 --backend api --out qa.json    # official API, billed
  gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --backend api
  gemini-qa.mjs clip.mp4 --backend api --model ${DEFAULT_MODEL} --prompt-extra "60s Short"
`;

function die(code, message) {
  writeErr(`${SELF}: ${message}\n`);
  process.exit(code);
}

/** Non-2xx from any Gemini endpoint: status + body verbatim, exit 1. */
async function dieHttp(step, res) {
  const body = await res.text().catch((err) => `<response body unreadable: ${err.message}>`);
  writeErr(
    `${SELF}: ${step} failed\nHTTP ${res.status} ${res.statusText}\n${body}\n`,
  );
  process.exit(1);
}

/** fetch that never swallows a transport error. */
async function request(step, url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    return die(1, `${step} — network error contacting ${url}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    input: null,
    backend: 'pool',
    model: null, // stays null unless --model was given: that is how the pool check below
    // distinguishes "caller asked for a model" from "caller took the default".
    out: null,
    promptExtra: null,
    timeoutS: POOL_TIMEOUT_S,
    timeoutGiven: false,
    preflight: false,
    modelCheck: true,
  };
  const takesValue = new Set(['--backend', '--model', '--out', '--prompt-extra', '--timeout']);
  const boolFlags = new Set(['--preflight', '--no-model-check']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      writeOut(USAGE);
      process.exit(0);
    }

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);

      if (boolFlags.has(name)) {
        if (eq !== -1) die(3, `flag ${name} takes no value`);
        if (name === '--preflight') opts.preflight = true;
        else opts.modelCheck = false; // --no-model-check
        continue;
      }
      if (!takesValue.has(name)) die(3, `unknown flag: ${arg}\n\n${USAGE}`);

      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        value = argv[++i];
        if (value === undefined) die(3, `flag ${name} requires a value\n\n${USAGE}`);
      }
      if (value === '') die(3, `flag ${name} requires a non-empty value`);

      if (name === '--backend') {
        if (value !== 'pool' && value !== 'api') {
          die(3, `--backend must be "pool" or "api", got "${value}"\n\n${USAGE}`);
        }
        opts.backend = value;
      } else if (name === '--model') opts.model = value;
      else if (name === '--out') opts.out = value;
      else if (name === '--timeout') {
        if (!/^[0-9]+$/.test(value) || Number(value) === 0) {
          die(3, `--timeout must be a positive whole number of seconds, got "${value}"`);
        }
        opts.timeoutS = Number(value);
        opts.timeoutGiven = true;
      } else opts.promptExtra = value;
      continue;
    }

    if (opts.input !== null) die(3, `unexpected extra argument: ${arg}\n\n${USAGE}`);
    opts.input = arg;
  }

  if (opts.input === null) die(3, `missing <video-path-or-url>\n\n${USAGE}`);

  // Reject api-only flags on the pool backend rather than accepting and ignoring them.
  // Silently ignoring --model would tell the caller a model was chosen when the pool
  // wrapper never passes one — the exact class of quiet lie this tool refuses.
  if (opts.backend === 'pool' && opts.model !== null) {
    die(
      3,
      `--model is not supported on the pool backend: the pool wrapper never selects a ` +
        `model, so "${opts.model}" could not be honoured. Use --backend api to choose a ` +
        `model, or drop --model.`,
    );
  }
  // Same rule in the other direction: the api backend has its own 10-minute poll deadline
  // and no liveness endpoint, so these two would be accepted and quietly do nothing.
  if (opts.backend === 'api' && opts.timeoutGiven) {
    die(3, '--timeout applies to the pool backend only; the api backend uses its own poll deadline');
  }
  if (opts.backend === 'api' && opts.preflight) {
    die(3, '--preflight applies to the pool backend only');
  }
  // And the mirror of that rule: the pool backend never selects a model, so there is no
  // model for --no-model-check to skip validating.
  if (opts.backend === 'pool' && !opts.modelCheck) {
    die(3, '--no-model-check applies to the api backend only; the pool backend selects no model');
  }

  if (opts.model === null) opts.model = DEFAULT_MODEL;
  return opts;
}

// ---------------------------------------------------------------------------
// Key resolution (R23) — env var, then secret-store file, then hard exit 2.
// Duplicated verbatim-in-shape in scripts/perplexity.mjs by design; do not factor out.
// ---------------------------------------------------------------------------
function resolveApiKey() {
  const fromEnv = (process.env[ENV_VAR] ?? '').trim();
  if (fromEnv !== '') return fromEnv;

  let fromFile = '';
  try {
    fromFile = readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    fromFile = '';
  }
  if (fromFile !== '') return fromFile;

  writeErr(
    `${SELF}: no Gemini API key found.\n` +
      `  Set the environment variable ${ENV_VAR}, or write the key to the secret-store file ` +
      `${SECRET_FILE}.\n` +
      `  Key name: ${ENV_VAR} (secret-store name: ${basename(SECRET_FILE)}).\n` +
      `  This is a Google AI Studio key for the BILLED api backend. It is NOT the pool's\n` +
      `  ${POOL_ENV_VAR} — see --help, "credentials".\n` +
      `  No request was made.\n`,
  );
  process.exit(2);
}

/**
 * Pool caller token (R702). Env -> secret store -> the pool's own .env, first non-empty wins.
 *
 * ⚠ The third location holds a variable literally named GEMINI_API_KEY, which is ALSO the
 * env-var name the api backend uses for a Google key. They are unrelated credentials that
 * happen to share a name. This function reads that name only out of POOL_DOTENV_FILE and
 * never out of the environment, which is what keeps the two apart. Do not "simplify" it
 * into a fallback on process.env.GEMINI_API_KEY.
 *
 * The key is never printed — not in errors, not in diagnostics.
 */
function resolvePoolKey() {
  const fromEnv = (process.env[POOL_ENV_VAR] ?? '').trim();
  if (fromEnv !== '') return fromEnv;

  let fromFile = '';
  try {
    fromFile = readFileSync(POOL_SECRET_FILE, 'utf8').trim();
  } catch {
    fromFile = '';
  }
  if (fromFile !== '') return fromFile;

  // Last resort: parse the pool service's own .env. Deliberately strict — an anchored
  // per-line match, so a commented-out or differently-named line is not mistaken for the
  // token. Surrounding quotes are stripped because .env files commonly carry them.
  let fromDotenv = '';
  try {
    const text = readFileSync(POOL_DOTENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(new RegExp(`^\\s*${POOL_DOTENV_VAR}\\s*=\\s*(.*)$`));
      if (m) {
        fromDotenv = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
        if (fromDotenv !== '') break;
      }
    }
  } catch {
    fromDotenv = '';
  }
  if (fromDotenv !== '') return fromDotenv;

  writeErr(
    `${SELF}: no Gemini Pool key found. All three locations were checked:\n` +
      `  1. environment variable  ${POOL_ENV_VAR}\n` +
      `  2. secret-store file     ${POOL_SECRET_FILE}\n` +
      `  3. ${POOL_DOTENV_VAR}= line in ${POOL_DOTENV_FILE}\n` +
      `  This is the POOL's caller token (sent as the x-api-key header), NOT a Google AI\n` +
      `  Studio key. Location 3 names it ${POOL_DOTENV_VAR}, which is confusingly the same\n` +
      `  name the --backend api path uses for an unrelated Google key; do not copy one into\n` +
      `  the other's slot.\n` +
      `  No request was made.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Input classification and --out pre-flight (both before any network call)
// ---------------------------------------------------------------------------
function classifyInput(input, backend) {
  if (/^https?:\/\//i.test(input)) {
    // The pool takes an uploaded body, not a URI. Rejecting is the documented choice over
    // downloading: a YouTube watch URL is an HTML page rather than a video file, so honouring
    // it would mean owning a downloader — and the api backend already passes URLs straight
    // through as file_data.file_uri. See --help, "URLs and the pool backend".
    if (backend === 'pool') {
      die(
        3,
        `URL input is not supported on the pool backend: ${input}\n` +
          `  ${POOL_ROOT}/v1/analyze takes an uploaded file, not a URI, and this tool does ` +
          `not download.\n` +
          `  Either save the video locally and pass the file path, or use --backend api ` +
          `(billed), which accepts URLs including YouTube.`,
      );
    }
    return { kind: 'url', uri: input };
  }

  const path = resolve(input);
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return die(3, `cannot read input ${path}: ${err.message}`);
  }
  if (!stat.isFile()) die(3, `input is not a regular file: ${path}`);
  if (stat.size === 0) die(3, `input file is empty: ${path}`);

  const ext = extname(path).toLowerCase();
  const mimeType = VIDEO_MIME[ext];
  if (!mimeType) {
    die(
      3,
      `unsupported video extension "${ext || '(none)'}" for ${path}; supported: ` +
        `${Object.keys(VIDEO_MIME).join(' ')}`,
    );
  }
  return { kind: 'file', path, size: stat.size, mimeType };
}

/**
 * R405 finding 3: accessSync(path, W_OK) succeeds on a *directory*, so `--out /tmp` used to
 * pass this pre-flight, upload the video, poll it to ACTIVE, pay for generateContent, and only
 * then die at writeFileSync with EISDIR. Shape is checked before permission now, on the target
 * and on its parent. The window this pre-flight genuinely cannot cover is narrow: the target or
 * its directory being unlinked/replaced between here and the write, or a full disk (ENOSPC).
 * Mirrors assertOutWritable() in scripts/perplexity.mjs.
 */
function assertOutWritable(out) {
  if (out === null) return;
  const path = resolve(out);

  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') die(3, `--out target cannot be inspected: ${path}: ${err.message}`);
  }

  if (stat !== undefined) {
    // Existing target: must be a file (a directory can never be overwritten) and writable.
    if (stat.isDirectory()) die(3, `--out target is a directory, not a file: ${path}`);
    try {
      accessSync(path, constants.W_OK);
    } catch (err) {
      die(3, `--out target is not writable: ${path}: ${err.message}`);
    }
    return;
  }

  // Not there yet: the parent must exist, be a directory, and accept a new file.
  const dir = dirname(path);
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch (err) {
    return die(3, `--out directory is not usable: ${dir}: ${err.message}`);
  }
  if (!dirStat.isDirectory()) die(3, `--out directory is not a directory: ${dir}`);
  try {
    accessSync(dir, constants.W_OK);
  } catch (err) {
    die(3, `--out directory is not writable: ${dir}: ${err.message}`);
  }
}

// ===========================================================================
// POOL BACKEND
// ===========================================================================

/**
 * Pull the rubric object out of a free-text reply.
 *
 * The pool has no structured-output mode, so the model answers in prose: sometimes bare
 * JSON, sometimes a ```json fence, sometimes a fence with a paragraph of preamble in front
 * of it. This finds the JSON and nothing else.
 *
 * It EXTRACTS; it never repairs. A truncated object, a fence that never closes, trailing
 * commas — all of it fails, and the caller prints the model's raw text verbatim. Silently
 * patching a malformed QA verdict would be worse than having none.
 *
 * Returns { ok: true, value } or { ok: false, reason }.
 */
function extractRubricJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'the reply was empty' };
  }

  // Candidate 1: the contents of a fenced block, ```json or plain ```. The fence may sit
  // anywhere in the reply, so leading chatter costs nothing.
  const candidates = [];
  const fence = text.match(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);

  // Candidate 2: an unterminated fence — the model started a block and the reply was cut
  // off. Kept as a candidate so the failure is reported as bad JSON (with the raw text)
  // rather than as "no JSON found", which would misdescribe a truncation.
  if (!fence) {
    const openFence = text.match(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*)$/);
    if (openFence) candidates.push(openFence[1]);
  }

  // Candidate 3: the first balanced {...} in the raw text — the bare-JSON case, and the
  // fallback when a fence exists but holds something unparseable.
  const balanced = firstBalancedObject(text);
  if (balanced !== null) candidates.push(balanced);

  if (candidates.length === 0) {
    return { ok: false, reason: 'no JSON object was found in the reply' };
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        lastError = 'the extracted JSON is not an object';
        continue;
      }
      return { ok: true, value };
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, reason: `the extracted JSON did not parse: ${lastError}` };
}

/**
 * First brace-balanced object in `text`, or null.
 *
 * String-aware: braces inside JSON strings, and escaped quotes inside them, do not move the
 * depth counter. A naive lastIndexOf('}') would cut a reply like `{"note":"} oops"}` in the
 * wrong place, and trailing prose after the object would break a naive slice-to-end.
 */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never closed — truncated reply
}

/**
 * Human-readable description of a non-2xx pool response.
 *
 * Round 701 section 6 catalogued FIVE distinct body shapes on this endpoint, and a client
 * that assumes one of them crashes on the others:
 *   401 / 500 / 503 -> {"detail": "<string>"}
 *   422             -> {"detail": [ {...}, ... ]}   (FastAPI header validation)
 *   413 (public rt) -> raw nginx HTML, not JSON at all
 * So: parse if it parses, describe what was found, and always keep the raw body for stderr.
 */
function describePoolBody(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'response body is not JSON (nginx HTML or a proxy error page — see the body below)';
  }
  const detail = parsed?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return `request rejected: ${JSON.stringify(detail)}`;
  return `unrecognised response shape: ${JSON.stringify(parsed)}`;
}

/** Non-2xx from the pool: classify, advise, exit 4 for retryable / 1 for everything else. */
async function diePool(step, res) {
  const raw = await res.text().catch((err) => `<response body unreadable: ${err.message}>`);
  const summary = describePoolBody(raw);
  const retryAfter = res.headers.get('retry-after');

  // 503 and 429 are the two failures where "try again later" is the correct response, so
  // they get their own exit code. Everything else is exit 1: an opaque 500 from this
  // service is NOT known to be transient (round 701 traced identical 500s to a dead pool
  // account that stayed dead for 7.5 days), and retrying it just burns pool sessions.
  if (res.status === 503 || res.status === 429) {
    const advice =
      res.status === 503
        ? 'no pool session came free within the wrapper\'s own 60 s acquire window — the ' +
          'pool is saturated. Retry in a minute or two.'
        : 'the pool account is rate-limited and has been put on a ~300 s cooldown by the ' +
          'wrapper. Retry after that, not sooner.';
    writeErr(
      `${SELF}: ${step} — pool unavailable\n` +
        `HTTP ${res.status} ${res.statusText}\n` +
        `${summary}\n` +
        `${retryAfter ? `Retry-After: ${retryAfter}\n` : ''}` +
        `  ${advice}\n` +
        `  This tool does not retry by itself. Nothing was analysed; nothing was billed.\n` +
        `raw body:\n${raw}\n`,
    );
    process.exit(4);
  }

  writeErr(
    `${SELF}: ${step} failed\n` +
      `HTTP ${res.status} ${res.statusText}\n` +
      `${summary}\n` +
      `${res.status === 500 ? poolFiveHundredHint() : ''}` +
      `raw body:\n${raw}\n`,
  );
  process.exit(1);
}

/**
 * A pool 500 is undiagnosable from the outside — this hint is what turns it into something
 * an operator can act on. Round 701 established the cost of NOT saying this: GET /health
 * reported 4/4 sessions ready for 7.5 days while every generation failed.
 */
function poolFiveHundredHint() {
  return (
    `  A 500 here is opaque by construction: the wrapper reports Google's error code and\n` +
    `  nothing else, and the same code covers a dead pool account, an unsupported file and\n` +
    `  a transient Google fault. Do NOT read it as "temporary" just because it says so.\n` +
    `  Check, in this order:\n` +
    `    1. ${SELF} --preflight ...        (or: POST ${POOL_ROOT}/v1/chat {"prompt":"Reply with OK"})\n` +
    `       If text generation ALSO fails, the pool account is dead — re-auth it.\n` +
    `       If text succeeds and only file requests fail, the file-attachment path is\n` +
    `       broken for every file type; that is a pool-side problem, not a video problem.\n` +
    `    2. docker logs gemini-pool-api-gemini-api-1 | tail   (look for AuthError /\n` +
    `       "Account status: UNAUTHENTICATED")\n` +
    `  GET ${POOL_ROOT}/health cannot tell you any of this — it reports sessions as ready\n` +
    `  without ever observing a generation outcome (docs/research/round-701-33d8cba3.md §2a).\n`
  );
}

/** fetch with an explicit timeout; a timeout is reported as a timeout, never as a hang. */
async function poolRequest(step, url, init, timeoutS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutS * 1000) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return die(
        1,
        `${step} — no response from the pool within ${timeoutS}s.\n` +
          `  The request may still be occupying a pool session; do not hammer it.\n` +
          `  Raise the ceiling with --timeout <seconds> if the video is long.`,
      );
    }
    return die(1, `${step} — network error contacting ${url}: ${err.message}`);
  }
}

/**
 * Cheapest possible liveness check (--preflight): text-only, no upload.
 *
 * Round 701's closing recommendation. Its value is diagnostic ordering — if this fails, the
 * pool is dead for everything and uploading a video would only produce a slower, more
 * confusing version of the same 500.
 */
async function poolPreflight(poolKey, timeoutS) {
  writeErr(`${SELF}: pool preflight — POST ${POOL_ROOT}/v1/chat (this takes ~45s)\n`);
  const res = await poolRequest(
    'pool preflight',
    `${POOL_ROOT}/v1/chat`,
    {
      method: 'POST',
      headers: { 'x-api-key': poolKey, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with OK' }),
    },
    timeoutS,
  );
  if (!res.ok) await diePool('pool preflight', res);

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return die(1, `pool preflight returned non-JSON: ${err.message}\n${raw}`);
  }
  if (typeof parsed?.text !== 'string') {
    return die(1, `pool preflight response has no text field:\n${raw}`);
  }
  writeErr(
    `${SELF}: pool preflight ok — account ${parsed.account ?? '<unreported>'} answered ` +
      `${JSON.stringify(parsed.text.slice(0, 40))}\n`,
  );
}

/**
 * The pool analysis call: one multipart POST, one reply, no retries.
 *
 * The filename matters. The wrapper derives the upload's MIME type from the extension alone
 * (mimetypes.guess_type on the client-supplied name, no content sniffing anywhere), so the
 * File is constructed with the real basename — not a generic "upload".
 */
async function poolAnalyze(poolKey, opts, file) {
  const text = [
    opts.promptExtra ? `${QA_PROMPT}\n\nCaller context:\n${opts.promptExtra}` : QA_PROMPT,
    POOL_JSON_INSTRUCTION,
  ].join('\n');

  let bytes;
  try {
    bytes = readFileSync(file.path);
  } catch (err) {
    return die(1, `reading ${file.path} for upload failed: ${err.message}`);
  }

  const form = new FormData();
  form.set('prompt', text);
  form.set('file', new File([bytes], basename(file.path), { type: file.mimeType }));

  writeErr(
    `${SELF}: pool analyse — ${basename(file.path)} (${file.size} bytes, ${file.mimeType}), ` +
      `timeout ${opts.timeoutS}s\n`,
  );

  const res = await poolRequest(
    'pool analyse',
    `${POOL_ROOT}/v1/analyze`,
    { method: 'POST', headers: { 'x-api-key': poolKey }, body: form },
    opts.timeoutS,
  );
  if (!res.ok) await diePool('pool analyse', res);

  const raw = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    return die(1, `pool analyse returned non-JSON: ${err.message}\n${raw}`);
  }
  if (typeof envelope?.text !== 'string') {
    return die(1, `pool analyse response has no text field:\n${raw}`);
  }
  if (typeof envelope.account === 'string') {
    // Which pool account answered is a real diagnostic (round 701 found four "sessions"
    // that were all one account) and is not a secret.
    writeErr(`${SELF}: pool analyse ok — answered by account ${envelope.account}\n`);
  }

  const extracted = extractRubricJson(envelope.text);
  if (!extracted.ok) {
    // Verbatim raw text, exactly as the model wrote it — that IS the diagnostic. No repair
    // pass, no second request.
    return die(
      1,
      `the pool did not return usable rubric JSON: ${extracted.reason}\n` +
        `  The pool has no structured-output mode, so this is a prompt-adherence failure,\n` +
        `  not a transport error. The model's raw reply follows, verbatim and unmodified:\n` +
        `--- BEGIN RAW MODEL TEXT ---\n${envelope.text}\n--- END RAW MODEL TEXT ---`,
    );
  }

  assertRubricComplete(extracted.value, envelope.text);
  return extracted.value;
}

/**
 * The frozen rubric's required top-level keys must all be present. Identical contract on
 * both backends — the rubric does not get looser because the free path produced it.
 */
function assertRubricComplete(qa, rawForDiagnostics) {
  const missing = RUBRIC_SCHEMA.required.filter((key) => !(key in qa));
  if (missing.length > 0) {
    die(
      1,
      `model output is missing required rubric keys: ${missing.join(', ')}\n` +
        `  The rubric is a frozen contract (02-architecture.md section 6.2); a partial\n` +
        `  answer is not silently accepted.\n` +
        `--- BEGIN RAW MODEL TEXT ---\n${rawForDiagnostics}\n--- END RAW MODEL TEXT ---`,
    );
  }
}

// ---------------------------------------------------------------------------
// Files API: resumable upload, then poll until ACTIVE
// ---------------------------------------------------------------------------
async function uploadFile(apiKey, file) {
  const start = await request('files upload (start)', `${API_ROOT}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': file.mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: basename(file.path) } }),
  });
  if (!start.ok) await dieHttp('files upload (start)', start);

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    const body = await start.text().catch(() => '<unreadable>');
    die(
      1,
      `files upload (start) returned HTTP ${start.status} without an x-goog-upload-url ` +
        `header; body:\n${body}`,
    );
  }

  // Read the whole file into memory: zero-dependency and adequate for pipeline renders.
  let bytes;
  try {
    bytes = readFileSync(file.path);
  } catch (err) {
    return die(1, `reading ${file.path} for upload failed: ${err.message}`);
  }

  const upload = await request('files upload (transfer)', uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Length': String(file.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!upload.ok) await dieHttp('files upload (transfer)', upload);

  const raw = await upload.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return die(1, `files upload (transfer) returned non-JSON: ${err.message}\n${raw}`);
  }
  const uploaded = parsed.file;
  if (!uploaded || typeof uploaded.name !== 'string' || typeof uploaded.uri !== 'string') {
    return die(1, `files upload (transfer) response is missing file.name/file.uri:\n${raw}`);
  }
  return uploaded;
}

async function waitUntilActive(apiKey, uploaded) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let state = uploaded.state ?? 'UNKNOWN';

  while (state !== 'ACTIVE') {
    if (state === 'FAILED') {
      die(1, `file processing FAILED for ${uploaded.name}:\n${JSON.stringify(uploaded, null, 2)}`);
    }
    if (Date.now() >= deadline) {
      die(
        1,
        `file ${uploaded.name} did not reach state ACTIVE within ` +
          `${POLL_TIMEOUT_MS / 60000} minutes (last state: ${state})`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const res = await request('files poll', `${API_ROOT}/v1beta/${uploaded.name}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) await dieHttp('files poll', res);

    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return die(1, `files poll returned non-JSON: ${err.message}\n${raw}`);
    }
    if (typeof parsed.state !== 'string') {
      return die(1, `files poll response has no state field:\n${raw}`);
    }
    state = parsed.state;
    uploaded = { ...uploaded, ...parsed };
  }
  return uploaded;
}

// ---------------------------------------------------------------------------
// Model validation — the cheapest possible call, made before the expensive one
// ---------------------------------------------------------------------------

/**
 * Verdict on a model name against a ListModels page. Not exported — this file runs its main
 * at import time by design (02-architecture §6.1), so it is driven through the CLI by
 * gemini-qa-cli.test.ts rather than imported.
 *
 * Gemini reports models as `models/<id>`; both forms are accepted and normalised here.
 */
function classifyModelSupport(models, model) {
  const wanted = `models/${model}`;
  const entry = (models ?? []).find((m) => m?.name === wanted || m?.name === model);
  if (entry === undefined) {
    return { ok: false, kind: 'unknown-model' };
  }
  const methods = entry.supportedGenerationMethods ?? entry.supportedActions ?? null;
  // A model list that does not report its methods is not evidence of absence. The model
  // exists; that is what this check was asked to prove.
  if (!Array.isArray(methods)) return { ok: true, kind: 'exists-methods-unreported' };
  if (!methods.includes('generateContent')) {
    return { ok: false, kind: 'no-generate-content', methods };
  }
  return { ok: true, kind: 'supported' };
}

/**
 * Refuse to spend money on a model nobody has confirmed exists.
 *
 * R705 finding 3: DEFAULT_MODEL shipped straight from a research doc that itself said not to
 * trust it without this exact call, and the api backend has never once run against a real
 * key — so the guess was never going to be caught by use. One GET, free, before the upload.
 * A wrong model name would otherwise be discovered only after the Files API upload and the
 * poll-to-ACTIVE, which is the slow and confusing way to learn it.
 *
 * Failures here are exit 3 (a configuration error, like any other bad flag value), never a
 * silent skip — an unreachable ListModels means the same credentials cannot reach Gemini at
 * all, so proceeding would just fail later and more expensively. --no-model-check is the
 * deliberate override.
 */
async function assertModelAvailable(apiKey, model) {
  const res = await request(
    'GET /v1beta/models',
    `${API_ROOT}/v1beta/models?pageSize=${MODEL_LIST_PAGE_SIZE}`,
    { headers: { 'x-goog-api-key': apiKey } },
  );
  if (!res.ok) await dieHttp('GET /v1beta/models (model validation)', res);

  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return die(1, `GET /v1beta/models returned non-JSON: ${err.message}\n${raw}`);
  }
  if (!Array.isArray(parsed?.models)) {
    return die(1, `GET /v1beta/models has no models array; raw body:\n${raw}`);
  }

  const verdict = classifyModelSupport(parsed.models, model);
  if (verdict.ok) {
    writeErr(`${SELF}: model "${model}" validated against GET /v1beta/models (${verdict.kind})\n`);
    return;
  }

  const usable = parsed.models
    .filter((m) => (m?.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''));
  const listing =
    usable.length === 0
      ? '  (this key sees NO model advertising generateContent)\n'
      : usable.map((n) => `    ${n}\n`).join('');

  if (verdict.kind === 'no-generate-content') {
    return die(
      3,
      `model "${model}" exists but does not advertise generateContent ` +
        `(it reports: ${verdict.methods.join(', ') || 'nothing'}).\n` +
        `  Models this key can call generateContent on:\n${listing}` +
        `  Nothing was uploaded and nothing was billed.`,
    );
  }
  // Absence from a TRUNCATED list is not absence. Say which of the two this is.
  const partial =
    typeof parsed.nextPageToken === 'string' && parsed.nextPageToken !== ''
      ? `  NOTE: the list was truncated at ${MODEL_LIST_PAGE_SIZE} entries (nextPageToken present), ` +
        `so this is "not on the first page", not proof of non-existence.\n`
      : '';
  return die(
    3,
    `model "${model}" does not exist for this key — GET /v1beta/models does not list it.\n` +
      partial +
      `  ${model === DEFAULT_MODEL ? 'This is the tool\'s DEFAULT, carried unverified from ' +
        'docs/research/round-701-33d8cba3.md, which explicitly flagged it as unconfirmed. ' +
        'Pick a working model below and change DEFAULT_MODEL.\n  ' : ''}` +
      `Models this key can call generateContent on:\n${listing}` +
      `  Nothing was uploaded and nothing was billed.\n` +
      `  Override with --no-model-check only if you know the list endpoint is lying.`,
  );
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
async function generateQa(apiKey, opts, media) {
  const fileData = { file_uri: media.uri };
  if (media.mimeType) fileData.mime_type = media.mimeType;

  const text = opts.promptExtra
    ? `${QA_PROMPT}\n\nCaller context:\n${opts.promptExtra}`
    : QA_PROMPT;

  const res = await request(
    'generateContent',
    `${API_ROOT}/v1beta/models/${opts.model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ file_data: fileData }, { text }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RUBRIC_SCHEMA,
        },
      }),
    },
  );
  if (!res.ok) await dieHttp('generateContent', res);

  const raw = await res.text();
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    return die(1, `generateContent returned non-JSON: ${err.message}\n${raw}`);
  }

  const part = envelope?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof part !== 'string') {
    return die(
      1,
      `generateContent response has no candidates[0].content.parts[0].text; raw body:\n${raw}`,
    );
  }

  let qa;
  try {
    qa = JSON.parse(part);
  } catch (err) {
    // No repair loop, no second attempt — the raw body is the diagnostic.
    return die(1, `model output is not valid JSON: ${err.message}\nraw body:\n${raw}`);
  }

  if (qa === null || typeof qa !== 'object' || Array.isArray(qa)) {
    return die(1, `model output is not a JSON object\nraw body:\n${raw}`);
  }
  assertRubricComplete(qa, raw);
  return qa;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// Gate order matters: arguments, then the key, then the filesystem. Resolving the key
// before touching the input keeps exit 2 deterministic — a caller with no key gets the
// same "missing key" message whether or not the video path happens to exist.
const opts = parseArgs(process.argv.slice(2));
const key = opts.backend === 'pool' ? resolvePoolKey() : resolveApiKey();
const input = classifyInput(opts.input, opts.backend);
assertOutWritable(opts.out);

let qa;
if (opts.backend === 'pool') {
  // input.kind is always 'file' here — classifyInput rejects URLs on this backend.
  if (opts.preflight) await poolPreflight(key, POOL_PREFLIGHT_TIMEOUT_S);
  qa = await poolAnalyze(key, opts, input);
} else {
  // Before the upload, not after: a bad model name discovered at generateContent has already
  // cost a Files API upload and a poll-to-ACTIVE. This GET is free and takes one round trip.
  if (opts.modelCheck) await assertModelAvailable(key, opts.model);
  else writeErr(`${SELF}: --no-model-check — "${opts.model}" is NOT validated against GET /v1beta/models\n`);

  let media;
  if (input.kind === 'url') {
    // URLs (including YouTube) go straight to the model — no upload, no MIME type.
    media = { uri: input.uri, mimeType: null };
  } else {
    const uploaded = await uploadFile(key, input);
    const active = await waitUntilActive(key, uploaded);
    media = { uri: active.uri, mimeType: active.mimeType ?? input.mimeType };
  }
  qa = await generateQa(key, opts, media);
}

const rendered = `${JSON.stringify(qa, null, 2)}\n`;

// R405 finding 1: stdout FIRST, always — --out is an *additional* copy, never a replacement.
// A 10-minute QA pass costs ~$5 (docs/tools/gemini-qa.md section 7) and cannot be recovered
// from a failed local write, so the result leaves the process before anything that can fail.
// This mirrors emit() in scripts/perplexity.mjs; the two tools behave identically here.
writeOut(rendered);

if (opts.out !== null) {
  const path = resolve(opts.out);
  try {
    writeFileSync(path, rendered);
  } catch (err) {
    // Exit 3, not 1: the API did its job and was paid. A caller that retries on 1 would
    // re-buy a result it already has on stdout.
    die(
      3,
      `writing --out ${path} failed: ${err.code ?? 'unknown'} ${err.message}\n` +
        `  The QA result is NOT lost — it was already written to stdout in full.`,
    );
  }
  writeErr(`${SELF}: QA JSON written to ${path} (and to stdout)\n`);
}
