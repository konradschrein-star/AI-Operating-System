#!/usr/bin/env node
// perplexity.mjs — zero-dependency Perplexity helper for the researcher lane (R22/R23).
//
// Node >= 22, built-in fetch only. No npm packages, no SDK, no shared lib: 02-architecture
// section 6.1 requires this script stay standalone-copyable, so the key-resolution block below
// is duplicated per script ON PURPOSE. Do not factor it out.
//
// API facts come from docs/research/perplexity-api.md (live-probed 2026-08-05), which supersedes
// 02-architecture section 6.3:
//   - Sonar Chat Completions was deprecated July 2026; the target is the Agent API POST /v1/agent.
//     (POST /v1/chat/completions returns 404 — it does not exist.)
//   - The Agent API is STRICT: any unknown field, top-level or nested, is a hard HTTP 400.
//     Everything sent below is an explicit whitelist, never a pass-through of user options.
//   - Web search is NOT automatic and failures arrive as HTTP 200 — see buildAskBody/runAsk.
//
// Search endpoint chosen empirically at build time (2026-08-05), because docs/research disagreed
// between /search and /v1/search. Keyless POST probe: /search -> 401, /v1/search -> 401. Both
// routes exist, so per the task's tie-break rule this script uses /search — the path actually
// observed in docs/research/perplexity-api.md section 2. One path is picked at build time; there
// is deliberately NO runtime fallback between endpoints. Probe output is in
// docs/plan/evidence/p4-perplexity-errorpaths.md.

import { readFileSync, writeFileSync } from 'node:fs';

const AGENT_URL = 'https://api.perplexity.ai/v1/agent';
const SEARCH_URL = 'https://api.perplexity.ai/search';

const DEFAULT_MODEL = 'perplexity/sonar';
const PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh'];

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CALLS = 5;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;

const EXIT_OK = 0;
const EXIT_API = 1;
const EXIT_NO_KEY = 2;
const EXIT_USAGE = 3;

const USAGE = `perplexity.mjs — Perplexity Agent API helper (zero-dependency, node >= 22)

USAGE
  scripts/perplexity.mjs ask "<question>" [options]
  scripts/perplexity.mjs search "<query>" [options]
  scripts/perplexity.mjs --help

MODES
  ask       Ask a question via the Agent API (POST ${AGENT_URL}).
            Web search is attached and, by default, FORCED — this helper is citation-critical.
            stdout JSON: { "answer", "citations", "search_results", "model", "usage" }
            A run may legitimately return zero sources; that is not an error.

  search    Raw web search via the Search API (POST ${SEARCH_URL}).
            stdout JSON: { "search_results" }

OPTIONS FOR ask
  --model <slug>          Model to serve the request. Default: ${DEFAULT_MODEL}
                          Mutually exclusive with --preset. There is NO perplexity/sonar-pro slug.
  --preset <name>         One of: ${PRESETS.join(' | ')}
                          Mutually exclusive with --model.
  --instructions "<text>" System instructions. With --preset this REPLACES the preset's prompt.
  --max-steps <n>         Research loop steps, 1-${100}. Default: ${DEFAULT_MAX_STEPS}
  --max-tool-calls <n>    Tool-call ceiling, 0-100. Default: ${DEFAULT_MAX_TOOL_CALLS}
                          0 disables all tool calls and requires --no-force-search.
  --no-force-search       Relax tool_choice from {"type":"web_search"} to "auto".
                          The model may then answer without searching (uncited).
  --out <file>            Also write the JSON result to <file>. stdout is unaffected.

OPTIONS FOR search
  --max-results <n>       1-${MAX_RESULTS_CAP}. Default: ${DEFAULT_MAX_RESULTS}
                          Above ${MAX_RESULTS_CAP} is a usage error, not a silent clamp.
  --out <file>            Also write the JSON result to <file>.

COST
  Tool invocations dominate the bill, not tokens: web_search is billed per invocation
  ($0.0025 each as of 2026-08-05), while ${DEFAULT_MODEL} is $0.25 in / $2.50 per 1M tokens.
  That is why --max-steps (default ${DEFAULT_MAX_STEPS}) and --max-tool-calls
  (default ${DEFAULT_MAX_TOOL_CALLS}) are the caps to reach for. The Search API is billed
  per request ($5.00 / 1K requests).

API KEY
  Resolved in this order, and no HTTP request is attempted unless one of them yields a key:
    1. environment variable  PERPLEXITY_API_KEY
    2. secret-store file     /opt/ai-os/.secrets/store/perplexity-api-key
  An invalid key is not hidden: the API's HTTP status and response body are printed verbatim.

EXIT CODES
  0  success
  1  API or response error (invalid key, non-2xx, status failed/cancelled, unparseable body)
  2  missing API key (neither location above yielded a key; no request was sent)
  3  usage error (bad or missing arguments; no request was sent)
`;

/** Usage error: no request has been sent and none will be. */
function usageError(message) {
  process.stderr.write(`usage error: ${message}\n\nRun with --help for the full usage.\n`);
  process.exit(EXIT_USAGE);
}

/** API/response error. */
function apiError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_API);
}

// ---------------------------------------------------------------------------------------------
// Key resolution (R23). Duplicated verbatim-in-shape across the helper scripts by design —
// 02-architecture section 6.1: each script must stay standalone-copyable. Do not factor out.
// ---------------------------------------------------------------------------------------------
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
      process.stderr.write(
        `Could not read the secret-store file ${KEY_FILE_PATH}: ${err.code ?? 'unknown'} ${err.message}\n` +
          `Fix the file or set the environment variable ${KEY_ENV_NAME} instead. No request was sent.\n`,
      );
      process.exit(EXIT_NO_KEY);
    }
  }
  if (fromFile) return fromFile;
  process.stderr.write(
    `No Perplexity API key found. Nothing was sent.\n` +
      `Set the key named ${KEY_ENV_NAME} in ONE of these two locations:\n` +
      `  1. environment variable: ${KEY_ENV_NAME}\n` +
      `  2. secret-store file:    ${KEY_FILE_PATH}\n` +
      `The file must contain the raw key and nothing else; surrounding whitespace is trimmed.\n`,
  );
  process.exit(EXIT_NO_KEY);
}
// ---------------------------------------------------------------------------------------------

/** Strict integer flag parsing — no truncation, no NaN-to-default. */
function parseIntFlag(flag, raw, min, max) {
  if (raw === undefined) usageError(`${flag} requires a value`);
  if (!/^\d+$/.test(raw)) usageError(`${flag} expects a non-negative integer, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) usageError(`${flag} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(EXIT_OK);
  }

  const mode = argv[0];
  if (mode === undefined) usageError('no mode given — expected "ask" or "search"');
  if (mode !== 'ask' && mode !== 'search') usageError(`unknown mode "${mode}" — expected "ask" or "search"`);

  const subject = argv[1];
  if (subject === undefined || subject.trim() === '') {
    usageError(mode === 'ask' ? 'ask requires a question argument' : 'search requires a query argument');
  }

  const opts = {
    mode,
    subject,
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
    if (mode !== 'ask') usageError(`${flag} is only valid in "ask" mode`);
  };
  const searchOnly = (flag) => {
    if (mode !== 'search') usageError(`${flag} is only valid in "search" mode`);
  };
  const value = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined) usageError(`${flag} requires a value`);
    return v;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
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
        usageError(`unknown option "${flag}"`);
    }
  }

  if (opts.model !== undefined && opts.preset !== undefined) {
    usageError('--model and --preset are mutually exclusive — send one or the other, never both');
  }
  if (opts.preset !== undefined && !PRESETS.includes(opts.preset)) {
    usageError(`--preset must be one of ${PRESETS.join(' | ')}, got "${opts.preset}"`);
  }
  if (opts.model !== undefined && opts.model.trim() === '') {
    usageError('--model requires a non-empty model slug');
  }
  if (opts.maxToolCalls === 0 && opts.forceSearch) {
    usageError('--max-tool-calls 0 disables all tool calls, which contradicts forced web search — pass --no-force-search too');
  }
  if (opts.out !== undefined && opts.out.trim() === '') {
    usageError('--out requires a file path');
  }

  return opts;
}

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

/** Sources live in the output[] item with type "search_results", under key "results". */
function extractSearchResults(response) {
  if (!Array.isArray(response.output)) return [];
  const item = response.output.find((o) => o !== null && typeof o === 'object' && o.type === 'search_results');
  if (item === undefined || !Array.isArray(item.results)) return [];
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

function emit(payload, outPath) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath !== undefined) {
    try {
      writeFileSync(outPath, json);
    } catch (err) {
      apiError(`Could not write --out file ${outPath}: ${err.code ?? 'unknown'} ${err.message}`);
    }
  }
  process.stdout.write(json);
}

async function runAsk(opts, apiKey) {
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
    process.stderr.write(`warning: Agent run status "incomplete" — incomplete_details.reason: ${reason}\n`);
  }

  const searchResults = extractSearchResults(response);
  emit(
    {
      answer: extractAnswer(response),
      citations: extractCitations(searchResults),
      search_results: searchResults,
      model: response.model ?? null,
      usage: response.usage ?? null,
    },
    opts.out,
  );
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

  emit({ search_results: results }, opts.out);
}

const opts = parseArgs(process.argv.slice(2));
const apiKey = resolveApiKey();
if (opts.mode === 'ask') await runAsk(opts, apiKey);
else await runSearch(opts, apiKey);
