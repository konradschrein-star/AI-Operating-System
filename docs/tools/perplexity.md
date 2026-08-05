# `scripts/perplexity.mjs`

## 1. What it is

The researcher lane's search instrument. A zero-dependency Node CLI that talks to the
Perplexity API in two modes:

- **`ask`** — a cited, web-search-grounded answer via the Agent API.
- **`search`** — raw web search results via the dedicated Search API, no model in the loop.

It is one of two external-service helpers this project ships (the other is `gemini-qa`, for
video QA — see `docs/tools/gemini-qa.md`). Both follow the same shape: a thin, whitelisted
wrapper around one vendor's HTTP API, with a hard-fail key protocol and no silent fallbacks.

## 2. Requirements

- Node.js **>= 22** (built-in `fetch`; this box runs v22.22.2).
- **Zero npm dependencies.** The only import is `node:fs` (for `--out` and key-file reads);
  everything else is the platform `fetch`. No `package.json`, `pnpm-lock.yaml`, or
  `node_modules` entry exists for this script or is needed to run it.
- Executable in place: `scripts/perplexity.mjs` is mode `100755` and can be invoked directly
  (`./scripts/perplexity.mjs ...`) or via `node scripts/perplexity.mjs ...`.
- **Standalone-copyable by design.** Per `docs/plan/02-architecture.md` §6.1, the ~15-line
  key-resolution block is duplicated verbatim-in-shape inside this script rather than pulled
  from a shared lib, so the file can be copied to another project with no other file needed.
  Do not factor it out.

## 3. Usage

```
scripts/perplexity.mjs ask "<question>" [options]
scripts/perplexity.mjs search "<query>" [options]
scripts/perplexity.mjs --help
```

### `ask` — cited answer via the Agent API (`POST https://api.perplexity.ai/v1/agent`)

Web search is attached and, by default, **forced** — this helper is citation-critical, so an
`ask` call does not silently answer from the model's own knowledge unless you opt out.

| Flag | Default | Notes |
|---|---|---|
| `--model <slug>` | `perplexity/sonar` | Mutually exclusive with `--preset`. There is **no** `perplexity/sonar-pro` slug — don't invent one. |
| `--preset <name>` | — | One of `fast \| low \| medium \| high \| xhigh`. Mutually exclusive with `--model`. |
| `--instructions "<text>"` | — | System instructions. Combined with `--preset`, this **replaces** the preset's own prompt, it does not append. |
| `--max-steps <n>` | `8` | Research loop steps, integer `1`–`100`. |
| `--max-tool-calls <n>` | `5` | Tool-call ceiling, integer `0`–`100`. `0` disables all tool calls, which requires pairing with `--no-force-search` (see below) or the tool refuses to run. |
| `--no-force-search` | off | Relaxes `tool_choice` from `{"type":"web_search"}` to `"auto"`. The model may then answer without searching at all — and without citations. |
| `--out <file>` | — | Also writes the JSON result to `<file>`. stdout is unaffected either way. |

Examples:

```
scripts/perplexity.mjs ask "What changed in the Perplexity Agent API in July 2026?"

scripts/perplexity.mjs ask "Summarize current LLM pricing trends" --preset medium

scripts/perplexity.mjs ask "Explain the MMLU benchmark" \
  --model perplexity/sonar --max-steps 4 --max-tool-calls 2 --out /tmp/mmlu.json
```

### `search` — raw web search (`POST https://api.perplexity.ai/search`)

| Flag | Default | Notes |
|---|---|---|
| `--max-results <n>` | `10` | Integer `1`–`20`. Requesting more than `20` is a **usage error** (exit `3`, no request sent) — not a silent clamp down to the cap. |
| `--out <file>` | — | Also writes the JSON result to `<file>`. |

Examples:

```
scripts/perplexity.mjs search "Perplexity Agent API pricing"

scripts/perplexity.mjs search "site:docs.perplexity.ai agent api" --max-results 5 --out /tmp/results.json
```

`--model`, `--preset`, `--instructions`, `--max-steps`, `--max-tool-calls`, and
`--no-force-search` are `ask`-only; passing any of them in `search` mode is a usage error
(exit `3`) naming the offending flag, e.g. `--preset is only valid in "ask" mode`.

## 4. Key setup

The key is resolved in this exact order, and **no HTTP request is attempted** unless one of
the two yields a non-empty value:

1. Environment variable `PERPLEXITY_API_KEY` (env wins if both are set).
2. Secret-store file `/opt/ai-os/.secrets/store/perplexity-api-key` (raw key, whitespace
   trimmed; must contain nothing else).

If neither location yields a key, the tool prints both locations verbatim and exits `2`
before any network call. It does not fall back to any other key name or path.

## 5. Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | API or response error — invalid key, non-2xx HTTP status, an Agent run with `status: failed` or `cancelled`, or a response body that fails to parse as JSON. |
| `2` | Missing API key — neither `PERPLEXITY_API_KEY` nor the secret-store file yielded a key. No request was sent. |
| `3` | Usage error — bad or missing arguments (unknown flag, missing subject, out-of-range value, mutually exclusive flags together, etc.). No request was sent. |

## 6. Response fields

### `ask` stdout

```json
{
  "answer": "...",
  "citations": ["https://...", "..."],
  "search_results": [ { "id": 13, "url": "...", "title": "...", "snippet": "...", "date": "...", "last_updated": "...", "source": "web" } ],
  "model": "perplexity/sonar",
  "usage": { "...": "..." }
}
```

`citations` is **derived, not vendor-supplied**: the Agent API has no top-level `citations`
field and no top-level `search_results` field. The tool builds both from the single
`output[]` item whose `type` is `"search_results"` (key `results` inside it), de-duplicating
URLs in the order they appear. `answer` is likewise assembled — concatenated from every
`output_text` part of every `output[]` item with `type: "message"`.

Two things about this shape that are easy to get wrong downstream: `snippet` is frequently
an **empty string** in real responses (confirmed in the vendor's own captured sample), and a
run that returns **zero sources is legal, not an error** — `citations` and `search_results`
can both legitimately be `[]` on a `status: "completed"` run.

### `search` stdout

```json
{ "search_results": [ /* raw entries from the Search API response */ ] }
```

The Search API is a different product with no status envelope; results sit at the top level
of its own response, either under `results` or `search_results` (the tool accepts whichever
key is present and hard-errors, body printed verbatim, if neither is).

## 7. Why the Agent API

Perplexity deprecated Sonar Chat Completions in **July 2026** in favor of the **Agent API**
(`POST /v1/agent`). `POST /v1/chat/completions` — the OpenAI-compatible alias some older
guidance points at — returns a live **404**; it does not exist. This is why the tool targets
`/v1/agent`, not `/chat/completions` or `/v1/sonar`.

Model slugs on the Agent API are **provider-prefixed** (`perplexity/sonar`,
`anthropic/claude-sonnet-5`, `openai/gpt-5.6-sol`, …). Critically, **there is no
`perplexity/sonar-pro` slug** — the tool rejects an attempt to pass one as a `--preset` value
locally, before paying for a round-trip 400.

Presets are `fast | low | medium | high | xhigh`. As of the July 2026 changelog they
currently resolve to **third-party models** (`fast` → `openai/gpt-5.4-mini`; `low`/`medium` →
`openai/gpt-5.6-luna`; `high`/`xhigh` → `openai/gpt-5.6-sol`), and the vendor itself warns
this mapping is not stable — check `response.model` in the tool's stdout if which model
actually served the request matters to you.

See `docs/research/perplexity-api.md` for the full live-probed research this was built from.

## 8. Two behaviors that bite callers

**(a) Failures arrive as HTTP 200.** An Agent run that fails or is cancelled does not come
back as a non-2xx HTTP status — it comes back `200 OK` with `response.status` set to
`"failed"` or `"cancelled"` and a populated `error` object. This is why `runAsk` branches on
`response.status`, never on the HTTP status code alone; an integration that only checks the
HTTP code will treat a failed run as a success with an empty answer.

**(b) Strict mode rejects any unknown field with a 400.** The Agent API 400s on the first
unrecognized field, top-level or nested. The tool therefore never forwards user options
as a pass-through — `buildAskBody` constructs the request body field by field from an
explicit whitelist (`input`, `model` XOR `preset`, `tools`, `tool_choice`, `max_steps`,
`max_tool_calls`, `instructions` when given). There is no way to smuggle an arbitrary field
through this CLI even if you wanted to.

## 9. Cost notes

- `perplexity/sonar`: **$0.25 / $2.50 per 1M tokens** (input/output).
- `web_search` tool call: **~$0.0025 per invocation** — billed per call, not per token.
- Search API (`search` mode): **~$5.00 per 1,000 requests**.

**Tool calls dominate the bill, not tokens.** A single `ask` can invoke `web_search`
repeatedly across its research loop, so the two levers that actually cap spend are
`--max-steps` (default `8`) and `--max-tool-calls` (default `5`) — reach for those before
worrying about token limits.

These figures **replace** the pricing recorded in `docs/plan/02-architecture.md` §6.3, which
was written against the pre-deprecation `sonar-pro` model at **$3 / $15 per 1M tokens** — the
current `perplexity/sonar` Agent API pricing above is roughly **10x lower** on both input and
output. That earlier figure was accurate for its source (`sonar-pro` on the now-deprecated
Sonar Chat Completions surface) but is the wrong number for what this tool actually calls.

## 10. Error paths

Real transcripts, captured on this box on 2026-08-05 (full detail in
`docs/plan/evidence/p4-perplexity-errorpaths.md`):

**Missing key (both modes, exit `2`, no request sent):**

```
$ env -u PERPLEXITY_API_KEY node scripts/perplexity.mjs ask "test"; echo "exit=$?"
No Perplexity API key found. Nothing was sent.
Set the key named PERPLEXITY_API_KEY in ONE of these two locations:
  1. environment variable: PERPLEXITY_API_KEY
  2. secret-store file:    /opt/ai-os/.secrets/store/perplexity-api-key
The file must contain the raw key and nothing else; surrounding whitespace is trimmed.
exit=2
```

(`search` mode prints the identical message — the key is resolved once, before any
mode-specific work, so both modes name both locations.)

**Invalid key (HTTP 401, body verbatim, exit `1`):**

```
$ PERPLEXITY_API_KEY=definitely-invalid node scripts/perplexity.mjs ask "test"; echo "exit=$?"
HTTP 401 Unauthorized from https://api.perplexity.ai/v1/agent
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}

exit=1
```

**Usage errors (exit `3`, no request sent):**

```
$ node scripts/perplexity.mjs; echo "exit=$?"
usage error: no mode given — expected "ask" or "search"
exit=3

$ node scripts/perplexity.mjs search "x" --max-results 21; echo "exit=$?"
usage error: --max-results must be between 1 and 20, got 21
exit=3

$ node scripts/perplexity.mjs ask "x" --model perplexity/sonar --preset high; echo "exit=$?"
usage error: --model and --preset are mutually exclusive — send one or the other, never both
exit=3
```

## 11. Browser-steering fallback — documented only, deliberately not built

If a research task needs Perplexity's web answer engine specifically (not just the API — for
example a logged-in session, or a UI feature with no API surface), the fallback is a **manual
procedure**, not code:

1. Invoke the `playwright-skill` (or the hermes `auto-browser` skill) to steer a real browser.
2. Navigate to `perplexity.ai` in a logged-in session.
3. Run the query in the UI.
4. Copy the answer **and its source links** into `docs/research/*.md`, citing what was
   actually seen (URL, title, access date), same as any other researcher-lane finding.

No scraping code exists for this and none should be written. `perplexity.ai` is a
bot-defended single-page app; scraping it is exactly the fragile, unmaintainable artifact
this system refuses to own — see `docs/plan/02-architecture.md` §10 ("Building Perplexity
browser scraping — fragile, bot-defended, unmaintainable; documented manual fallback only").
The API (§7–§9 above) is the supported path; the browser is a documented escape hatch for
when the API genuinely cannot do the job.

## 12. Key status

As of **2026-08-05**, no Perplexity key exists on this box — checked at both locations
(`PERPLEXITY_API_KEY` unset in the environment; `/opt/ai-os/.secrets/store/perplexity-api-key`
absent). Until a key is added, both `ask` and `search` hard-exit `2` and no research call can
be made.

A reminder is already queued for this — `POST /api/reminders` recorded it on 2026-08-05,
due 2026-08-06 07:00 UTC, naming the exact env var, the exact secret-store path, and what it
unlocks (reminder id `4c4532af-24ed-4642-a7ef-15ae291391e7`, per
`docs/plan/evidence/p4-perplexity-errorpaths.md` step 12). Do not queue a second one.

## Open discrepancies

- **`docs/plan/02-architecture.md` §6.3 is stale against what actually shipped.** The
  architecture doc's design sketch targets `POST /chat/completions` with default model
  `sonar-pro` at $3/$15 per 1M tokens. The shipped script targets `POST /v1/agent` with
  default model `perplexity/sonar` at $0.25/$2.50 per 1M tokens (§7, §9 above). This is not a
  bug in the script — `docs/research/perplexity-api.md` (dated the same day) is what
  triggered the change, documenting that Sonar Chat Completions was deprecated in favor of
  the Agent API and that `/v1/chat/completions` 404s live. The architecture doc's §6.3 simply
  predates that research and was never updated to match; readers should treat §6.3 as
  superseded by this file and by the research doc, not as a second source of truth.
- **No successful `200` response has ever been observed against this script.** No key exists
  on this box (§12), so every claim in §6 about `ask`'s and `search`'s success-path JSON shape
  is written against `docs/research/perplexity-api.md` §3.4/§3.5, which the research doc
  itself flags as documented-but-unverified vendor material, not a captured live round-trip
  through this script. The first real keyed run should be treated as the confirmation step.
- **The Search API's top-level results key is unconfirmed.** The script accepts either
  `results` or `search_results` and hard-errors (body printed verbatim) if neither is present,
  precisely because which one the vendor actually sends has not been observed on the wire —
  see `docs/plan/evidence/p4-perplexity-errorpaths.md`, "What is NOT proven here" section.
