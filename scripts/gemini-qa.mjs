#!/usr/bin/env node
// gemini-qa.mjs — video quality assurance through the Gemini API. Hand it a local video
// file or a public/YouTube URL, get back the frozen QA rubric as JSON with timestamped
// findings a human (or later a repair agent) can jump to.
//
// Deliberately zero-dependency: node >= 22 built-in fetch only, no SDK, no shared lib.
// The key-resolution block below is duplicated in scripts/perplexity.mjs on purpose —
// 02-architecture.md section 6.1 requires each script to stay standalone-copyable.
//
// NO SILENT FALLBACKS: nothing is retried, no model is substituted, no failure is
// swallowed. Every failure path prints what actually happened and exits non-zero.
//
// usage: scripts/gemini-qa.mjs <video-path-or-url> [--model M] [--out FILE]
//                              [--prompt-extra "..."] [--help]
//
// exit codes:
//   0  QA JSON produced
//   1  API or processing error (invalid key, upload failure, poll timeout, unparseable
//      or incomplete response) — HTTP status + response body reach stderr verbatim
//   2  no API key (neither GEMINI_API_KEY nor the secret-store file)
//   3  usage error (no argument, unknown flag, unreadable input, unusable --out target)
//
// The QA JSON ALWAYS goes to stdout; --out only adds a durable copy, written afterwards.
// A billed result must never be destroyed by a local write fault.

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
const DEFAULT_MODEL = 'gemini-omni-flash';

const API_ROOT = 'https://generativelanguage.googleapis.com';
const SECRET_FILE = '/opt/ai-os/.secrets/store/gemini-api-key';
const ENV_VAR = 'GEMINI_API_KEY';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

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

const USAGE = `usage: gemini-qa.mjs <video-path-or-url> [--model M] [--out FILE] [--prompt-extra "..."] [--help]

Video quality assurance through the Gemini API. Input is either a local video file (uploaded
via the Gemini Files API, then polled until ACTIVE) or a public video URL including YouTube
(passed straight to the model, no upload). Output is the QA rubric as JSON.

arguments:
  <video-path-or-url>     local video file, or an http(s):// URL (YouTube supported)

flags:
  --model M               Gemini model to use              (default: ${DEFAULT_MODEL})
  --out FILE              ALSO write the QA JSON to FILE   (default: stdout only)
                          stdout always gets the JSON first, so a billed result survives a
                          write failure. FILE must not be a directory and must be writable;
                          that is pre-flighted before any upload or request (exit 3).
  --prompt-extra "..."    extra caller context appended to the QA prompt,
                          e.g. "this is a 60s YouTube Short about sky photography"
                                                           (default: none)
  --help, -h              print this help and exit 0
  Flags accept either "--model M" or "--model=M".

api key (resolved in this order, first non-empty wins):
  1. environment variable  ${ENV_VAR}
  2. secret-store file     ${SECRET_FILE}
  If neither is present the tool exits 2 without making any HTTP request.

supported local video extensions:
  ${Object.keys(VIDEO_MIME).join(' ')}

output:
  The frozen QA rubric (02-architecture.md section 6.2), pretty-printed JSON with keys:
    verdict (pass|needs_work|reject), confidence, hook, pacing, audio, visual, factual,
    top_fixes, summary
  Every finding carries a timestamp in seconds from the start of the video.
  It is written to stdout on every successful run; --out adds a copy, it does not divert.

exit codes:
  0  success — QA JSON on stdout (and in --out FILE if given)
  1  API or processing error: invalid key, upload failure, file processing FAILED,
     poll timeout (${POLL_TIMEOUT_MS / 60000} min), non-2xx response, unparseable or
     incomplete model output. HTTP status and response body are printed verbatim.
  2  missing key: neither ${ENV_VAR} nor ${SECRET_FILE}
  3  usage error: no argument, unknown flag, unreadable input file, unsupported
     extension, or an unusable --out target (a directory, unwritable, or a missing
     parent directory). If --out fails AFTER the request, the exit is still 3 and the
     QA JSON is already on stdout in full.

examples:
  gemini-qa.mjs ./render/final.mp4
  gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --out qa.json
  gemini-qa.mjs clip.mp4 --model ${DEFAULT_MODEL} --prompt-extra "60s Short, target audience: beginners"
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
  const opts = { input: null, model: DEFAULT_MODEL, out: null, promptExtra: null };
  const takesValue = new Set(['--model', '--out', '--prompt-extra']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      writeOut(USAGE);
      process.exit(0);
    }

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!takesValue.has(name)) die(3, `unknown flag: ${arg}\n\n${USAGE}`);

      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        value = argv[++i];
        if (value === undefined) die(3, `flag ${name} requires a value\n\n${USAGE}`);
      }
      if (value === '') die(3, `flag ${name} requires a non-empty value`);

      if (name === '--model') opts.model = value;
      else if (name === '--out') opts.out = value;
      else opts.promptExtra = value;
      continue;
    }

    if (opts.input !== null) die(3, `unexpected extra argument: ${arg}\n\n${USAGE}`);
    opts.input = arg;
  }

  if (opts.input === null) die(3, `missing <video-path-or-url>\n\n${USAGE}`);
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
      `  No request was made.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Input classification and --out pre-flight (both before any network call)
// ---------------------------------------------------------------------------
function classifyInput(input) {
  if (/^https?:\/\//i.test(input)) return { kind: 'url', uri: input };

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

  const missing = RUBRIC_SCHEMA.required.filter(
    (key) => qa === null || typeof qa !== 'object' || !(key in qa),
  );
  if (missing.length > 0) {
    return die(
      1,
      `model output is missing required rubric keys: ${missing.join(', ')}\nraw body:\n${raw}`,
    );
  }
  return qa;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// Gate order matters: arguments, then the key, then the filesystem. Resolving the key
// before touching the input keeps exit 2 deterministic — a caller with no key gets the
// same "missing key" message whether or not the video path happens to exist.
const opts = parseArgs(process.argv.slice(2));
const apiKey = resolveApiKey();
const input = classifyInput(opts.input);
assertOutWritable(opts.out);

let media;
if (input.kind === 'url') {
  // URLs (including YouTube) go straight to the model — no upload, no MIME type.
  media = { uri: input.uri, mimeType: null };
} else {
  const uploaded = await uploadFile(apiKey, input);
  const active = await waitUntilActive(apiKey, uploaded);
  media = { uri: active.uri, mimeType: active.mimeType ?? input.mimeType };
}

const qa = await generateQa(apiKey, opts, media);
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
