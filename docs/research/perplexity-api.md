# Perplexity API — current state (research for a `scripts/perplexity.mjs` helper)

**Researched:** 2026-08-05 · **Researcher:** P3 researcher role, round 306
**Scope:** base URL, auth, request/response shape, model names, citations, pricing, recent changes.
**Method:** all sources fetched live this run via WebFetch/WebSearch and `curl` against
`docs.perplexity.ai` raw markdown (`<page>.md`) plus unauthenticated probes of
`api.perplexity.ai`. No browser session was needed — every source below is a plain fetch and
is reproducible with `curl`. No claim here comes from memory.

---

## 0. Instrument status (read this first)

- **`scripts/perplexity.mjs` does not exist** in this worktree. Verified by listing `scripts/`
  on 2026-08-05: the directory holds `git-sync-branch.sh`, `import-scraper-places.ts`,
  `seed-heartbeats.sh`, and others — no `perplexity.mjs`, no `gemini-qa.mjs`.
- **`PERPLEXITY_API_KEY` is not set.** Not in the environment, and not in
  `/opt/ai-os/.secrets/store/` (which contains only `github-pat-konrad`, `github-pat-shane`,
  `twenty-api-key`, `twenty-crm-admin`, `twenty-crm-shane`).

Consequence: **no authenticated call was possible this run.** Everything about response
*bodies* below comes from vendor documentation, not from a live authenticated round-trip.
The unauthenticated probes in §2 are live observations and are marked as such.
**A planner should treat the response-shape details as documented-but-unverified** until
someone runs one real request with a key.

---

## 1. The headline: the API you were asked about has been superseded

Perplexity has moved its recommended surface from **Sonar Chat Completions** to the
**Agent API**. Both are live; the former now carries a deprecation-tagged notice.

The notice is rendered at the top of the chat-completions API reference itself, as a
`<Warning>` component:

> "More models, tools, and research-backed presets: Sonar Chat Completions is now
> [Agent API.](/docs/agent-api/quickstart) Migration guide [here](/docs/agent-api/migrate-from-sonar/overview)."
>
> — *Create Chat Completion*, https://docs.perplexity.ai/api-reference/chat-completions-post
> (fetched as `.md`, accessed 2026-08-05)

The same text appears in the changelog under a **July 2026** entry tagged
`["Agent API", "Deprecation"]`:

> "**Sonar Chat Completions migration** — More models, tools, and research-backed presets:
> Sonar Chat Completions is now [Agent API.](/docs/agent-api/quickstart)"
>
> — *Changelog*, https://docs.perplexity.ai/docs/resources/changelog (accessed 2026-08-05)

But no removal date is announced, and the vendor's own migration guide is explicit that
both remain callable:

> "Both APIs are live; this is a contract migration - endpoint, request body, response
> parsing, streaming - not a rewrite."
>
> — *migrate-sonar-to-agent-api/SKILL.md*, https://github.com/perplexityai/api-platform-developers
> (raw fetch, accessed 2026-08-05)

> "While Sonar Chat Completions remains supported, the Agent API is more performant and
> cost-effective for production workloads."
>
> — *Migrate from Sonar*, https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar
> (accessed 2026-08-05)

**Recommendation for the helper:** build against **`POST /v1/agent`**. The cost evidence in
§6 independently supports the vendor's "more cost-effective" claim — `perplexity/sonar` on
the Agent API is materially cheaper than `sonar` on chat completions, mostly because the
Agent API has no per-request fee. Building the helper on chat completions today would mean
writing a migration ticket the same week.

---

## 2. Base URL, auth, and which endpoints actually route (live-probed)

**Base URL:** `https://api.perplexity.ai` — declared in the OpenAPI `servers` block:

> ```yaml
> servers:
>   - url: https://api.perplexity.ai
>     description: Perplexity AI API
> ```
> — *Create Chat Completion* OpenAPI, https://docs.perplexity.ai/api-reference/chat-completions-post (accessed 2026-08-05)

**Auth header:** `Authorization: Bearer $PERPLEXITY_API_KEY`, unchanged across both APIs:

> "Auth is unchanged: `Authorization: Bearer $PERPLEXITY_API_KEY`."
>
> — *request-mapping.md*, https://github.com/perplexityai/api-platform-developers (accessed 2026-08-05)

### Live probe results (unauthenticated `POST` with `{}` body, 2026-08-05)

I ran these against production myself. A `401` proves the route exists and is auth-gated;
a `404` proves it does not exist.

| Endpoint | HTTP | Interpretation |
|---|---|---|
| `POST /chat/completions` | **401** | live (OpenAI-compatible alias) |
| `POST /v1/sonar` | **401** | live (canonical Sonar path) |
| `POST /v1/agent` | **401** | live (Agent API) |
| `POST /v1/responses` | **401** | live (Agent API equivalent) |
| `POST /v1/models` | **401** | route exists, auth-gated |
| `POST /search` | **401** | live (separate Search API product) |
| `POST /v1/chat/completions` | **404** | **does not exist** |

Observed error envelope, verbatim from the wire:

```json
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}
```

Two of these results **contradict the vendor's own documentation** — see §7.

---

## 3. Agent API (`POST /v1/agent`) — the recommended target

### 3.1 Request shape

Minimal request, verbatim from the vendor quickstart:

> ```bash
> curl https://api.perplexity.ai/v1/agent \
>   -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "model": "openai/gpt-5.6-sol",
>     "input": "Explain the difference between supervised and unsupervised learning in machine learning."
>   }' | jq
> ```
> — *Agent API Quickstart*, https://docs.perplexity.ai/docs/agent-api/quickstart (accessed 2026-08-05)

Preset form (no `model` field):

> ```bash
> curl https://api.perplexity.ai/v1/agent \
>   -H "Authorization: Bearer $PERPLEXITY_API_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "preset": "low",
>     "input": "Explain what the MMLU benchmark measures for large language models, ..."
>   }' | jq
> ```
> — same source, accessed 2026-08-05

### 3.2 Parameters

From the API reference (`ResponsesRequest`), https://docs.perplexity.ai/api-reference/agent-post,
accessed 2026-08-05. **Required: `input`** (string, or an array of `{role, content}` items).

| Param | Type | Notes (quoted where the doc is terse) |
|---|---|---|
| `input` | string \| array | **required** |
| `model` | string | "Model ID in provider/model format" |
| `models` | string[] 1–5 | "Model fallback chain"; `response.model` echoes the served one |
| `preset` | string | "Preset configuration name" — `fast\|low\|medium\|high\|xhigh` |
| `instructions` | string | "System instructions for the model" |
| `max_output_tokens` | int ≥1 | "Required when using anthropic/\* models" |
| `max_steps` | int 1–100 | "Maximum number of research loop steps" |
| `max_tool_calls` | int | `0` disables **all** tool calls |
| `tools` | Tool[] | "Tools available to model" |
| `tool_choice` | string \| object | `"none"\|"auto"\|"required"`, or `{"type":"web_search"}` |
| `reasoning` | object | `{"effort": minimal\|low\|medium\|high\|xhigh\|max}` |
| `response_format` | object | **top-level**, not `text.format` |
| `stream` | bool | "If true, returns SSE stream" |
| `background` | bool | "Run the response asynchronously" |
| `previous_response_id` | string | "For multi-turn response chains" |
| `store`, `truncation`, `metadata`, `temperature` (0–2), `top_p` (0–1), `language_preference`, `skills` (≤16) | | |

### 3.3 Three behaviours that will bite the helper

**(a) Strict mode — unknown fields are a hard 400.** This is called out as the single
biggest migration failure:

> "**THE #1 MIGRATION FAILURE:** the Agent API rejects ANY unknown or leftover field -
> top-level or nested - with HTTP 400:
> `{"error":{"message":"invalid request body: json: unknown field \"X\"","type":"invalid_request","code":400,"param":"X"}}`
> Sonar silently dropped many params; the Agent API does not."
>
> — *SKILL.md*, accessed 2026-08-05

So the helper must send a whitelist, not a pass-through of user options.

**(b) Web search is NOT automatic.** This is the one most likely to silently produce
uncited answers:

> "A bare model request does no search and returns an ungrounded answer. If the Sonar code
> relied on search (almost all does), add `"tools": [{"type": "web_search"}]` - or use a
> preset, which bundles tools. Offering the tool does not guarantee the model calls it; for
> citation-critical flows force it with `"tool_choice": {"type": "web_search"}`."
>
> — *request-mapping.md*, accessed 2026-08-05

And even forced, it can come back empty:

> "Even forced, an occasional run returns zero sources - handle empty `search_results` gracefully."
>
> — *SKILL.md*, accessed 2026-08-05

**(c) Failures arrive as HTTP 200.** Branching on the HTTP status alone is wrong:

> "CRITICAL: cancelled and model-error runs return HTTP 200. The Response object arrives
> with `status: "cancelled"` or `"failed"` and a populated `error` field. Always branch on
> `response.status`, not on the HTTP code"
>
> — *response-and-streaming.md*, accessed 2026-08-05

`status` enum: `completed | failed | incomplete | in_progress | queued | cancelled`
(confirmed identically in the API reference and in `response-and-streaming.md`).
Truncation signal is `incomplete_details.reason: "max_output_tokens"`, replacing Sonar's
`finish_reason: "length"`.

### 3.4 How citations come back — the important part

There is **no top-level `citations` field** on an Agent response. Sources live in an item
inside the `output[]` array:

> "`citations` (top-level URL list) | GONE. Use the `search_results` OUTPUT ITEM: the
> `output[]` item with `type:"search_results"`, shape
> `{type, queries: [...], results: [{id, url, title, snippet, date, last_updated, source}]}`.
> There is NO top-level `citations` or `search_results` on Agent responses."
>
> — *response-and-streaming.md*, accessed 2026-08-05

> "message `annotations` | May carry `url_citation {url, start_index, end_index, title}`
> entries but is often an EMPTY array - do not rely on annotations for citations; use the
> `search_results` item."
>
> — same source

Confirmed against a real captured response in the quickstart, where the `output[]` array
contains an item with `"queries": [...]`, `"results": [...]`, `"type": "search_results"`,
and result entries of exactly this shape:

> ```json
> {
>   "date": "2025-12-10",
>   "id": 13,
>   "last_updated": "2026-02-23T18:38:26",
>   "snippet": "",
>   "source": "web",
>   "title": "Full Benchmark Table For...",
>   "url": "https://skywork.ai/blog/llm/top-10-open-llms-2025-november-ranking-analysis/"
> }
> ```
> — *Agent API Quickstart* sample response, accessed 2026-08-05

Note `"snippet": ""` in that real sample — **snippets can be empty strings**, so the helper
should not assume a snippet is present.

Other `output[]` item types: `message`, `search_results`, `fetch_url_results`,
`people_search_results`, `finance_results`, `function_call`, `sandbox_results`,
`mcp_list_tools`, `mcp_call`, plus `unknown` for forward-compat. Two caveats worth
carrying into the design:

> "`finance_results` and `sandbox_results` items carry no `url` field - code that surfaces
> sources must account for finance-only answers yielding zero citation URLs."
>
> — *response-and-streaming.md*, accessed 2026-08-05

> "There are NO reasoning output items - reasoning appears only as `response.reasoning.*`
> streaming events."
>
> — same source

Text extraction walks `output[]` for `message` items and concatenates `output_text` parts;
SDKs expose the shortcut `response.output_text`.

### 3.5 Usage and cost fields

Renamed from Sonar: `usage.prompt_tokens` → **`usage.input_tokens`**,
`usage.completion_tokens` → **`usage.output_tokens`**, `total_tokens` unchanged.
Cost object: `usage.cost.{input_cost, output_cost, tool_calls_cost, total_cost, currency:"USD", tool_calls_cost_details}`.

A naming trap worth encoding in the helper's cost parsing:

> "`usage.tool_calls_details` and `cost.tool_calls_cost_details` are keyed by billing tool
> names that differ from the request-side tool types: `search_web` (not web_search),
> `search_people` (not people_search), `fetch_url`, `finance_search`, `sandbox`."
>
> — *response-and-streaming.md*, accessed 2026-08-05

### 3.6 Streaming

Typed SSE events, each `data: <one-line JSON>` followed by a blank line. **No `[DONE]`
sentinel** and no `event:` line. Text arrives as `response.output_text.delta` (field
`delta`), not `choices[0].delta.content`.

> "MANDATORY: handle ALL terminals. Exactly one of `response.completed`, `response.failed`,
> `response.incomplete`, `response.cancelled` arrives, plus a bare `error` event for
> transport failures. A consumer that only exits on `response.completed` hangs (or silently
> drops errors) on failed runs."
>
> — *response-and-streaming.md*, accessed 2026-08-05

> "`stream_options.include_usage` defaults to TRUE (opposite of OpenAI)."
>
> — same source

---

## 4. Sonar Chat Completions (legacy but live)

**Canonical path is `POST /v1/sonar`**, not `/chat/completions`. The OpenAPI declares:

> ```yaml
> paths:
>   /v1/sonar:
>     post:
>       summary: Create Chat Completion
>       operationId: chat_completions_chat_completions_post
> ```
> — accessed 2026-08-05

`/chat/completions` is an accepted OpenAI-compatible alias (live-confirmed 401 in §2), which
lets the OpenAI SDK work by setting only `base_url="https://api.perplexity.ai"`.

**Required fields:** `model`, `messages`.

**Model enum — these four and no others**, quoted from the OpenAPI schema:

> ```yaml
> model:
>   description: Model to use, for example, sonar-pro
>   enum:
>     - sonar
>     - sonar-pro
>     - sonar-deep-research
>     - sonar-reasoning-pro
> ```
> — accessed 2026-08-05

`max_tokens` has `maximum: 128000`.

**Response** (`CompletionResponse`) declares `id`, `model`, `created`, `usage`,
`object` (default `chat.completion`), `choices`, and:

> ```yaml
> citations:
>   description: URLs of sources used to generate the response
> search_results:
>   description: Search results used for context in the response
> ```
> — accessed 2026-08-05

`ApiPublicSearchResult` = `{title, url, date, last_updated, ...}` ("A single search result
from the web"). Also present: `images` (when `return_images`), `related_questions` (when
`return_related_questions`) — **neither has an Agent API equivalent** (§5).

---

## 5. Model names

### Agent API — slugs are provider-prefixed

Confirmed from the pricing page's embedded `PRICING` object (the vendor's own
"Single source of truth for the PricingCalculator widget"), accessed 2026-08-05:

- **Perplexity:** `perplexity/sonar`, `perplexity/glm-5.2`, `perplexity/kimi-k3`, `perplexity/kimi-k2.7-code`
- **Anthropic:** `anthropic/claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- **OpenAI:** `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.4-mini`
- **Google:** `google/gemini-3.5-flash`, `google/gemini-3.1-flash-lite`

> "Do not invent slugs: there is NO `perplexity/sonar-pro` slug."
>
> — *models-and-presets.md*, accessed 2026-08-05

The authoritative live list is `GET /v1/models` — **but see §7.2: it requires auth**,
contrary to the doc.

### Presets

> "Short names `fast | low | medium | high | xhigh` are the canonical preset names;
> `fast-search | pro-search | deep-research | advanced-deep-research` are accepted as
> previous names for the first four."
>
> — *models-and-presets.md*, accessed 2026-08-05

Presets currently resolve to third-party models (from the `PRICING` object, accessed
2026-08-05): `fast` → `openai/gpt-5.4-mini`; `low` and `medium` → `openai/gpt-5.6-luna`;
`high` and `xhigh` → `openai/gpt-5.6-sol`. The doc warns this is not stable — "Presets may
resolve to third-party models; check `response.model` if branding or data-handling matters."

Preset mechanics the helper must respect: `instructions` alongside a preset **replaces** the
preset's system prompt (`""` clears it); preset tools **cannot** be disabled (`tools: []`
does not clear them); request fields override preset values.

### Sonar → Agent mapping

| Sonar model | Migrate to |
|---|---|
| `sonar` | `perplexity/sonar` + `web_search` tool, or `preset: "fast"` |
| `sonar-pro` | `preset: "low"`, or `perplexity/sonar` + `web_search` (no `sonar-pro` slug exists) |
| `sonar-reasoning` | **retired** — `preset: "low"` or a reasoning model |
| `sonar-reasoning-pro` | `preset: "low"` |
| `sonar-deep-research` | `preset: "medium"` |

— *models-and-presets.md*, accessed 2026-08-05. Note the caution attached to the first row:
"output is not byte-identical to chat `sonar` and pricing differs ... A/B compare quality
and cost before cutover."

### Removals with dates

> "As of December 15, 2025, the `sonar-reasoning` model has been deprecated and removed from
> the API."
>
> — *Changelog*, accessed 2026-08-05

> "As of March 20, 2026, `google/gemini-2.5-flash` has been deprecated and removed from the
> API. `google/gemini-2.5-pro` followed on April 1, along with `google/gemini-3-pro-preview`."
>
> — same source

### Sonar features with no Agent equivalent

`return_images`, `return_related_questions`, `search_mode: "academic"`, `presence_penalty`,
`frequency_penalty`, `stop`, `top_k`, `n`, `search_language_filter`, `return_videos`, and
`file_url`/`pdf_url`/`video_url` content parts are all on the REMOVE list — leaving any of
them in a request is a 400 under strict mode. `search_mode: "sec"` is replaced by the
`finance_search` tool. (*request-mapping.md*, accessed 2026-08-05.)

---

## 6. Pricing

All figures below are transcribed from the `PRICING` object embedded in
https://docs.perplexity.ai/getting-started/pricing (fetched as `.md`, accessed 2026-08-05).
The page **carries no visible "last updated" date** — the only temporal anchor is the
changelog. Units are declared by the object itself:

> ```json
> "units": {
>   "model input/output/cache": "$ per 1,000,000 tokens",
>   "tools": "$ per invocation",
>   "search.per1k": "$ per 1,000 requests",
>   "sonar.input/output/citation/reasoning": "$ per 1,000,000 tokens",
>   "sonar.request.{low,medium,high}": "$ per 1,000 requests (varies by search context size)",
>   "sonar.searchQueries": "$ per 1,000 searches (Deep Research only)"
> }
> ```

### Sonar API (chat completions) — token price **plus a per-request fee**

| Model | Input $/1M | Output $/1M | Request fee $/1K (low / med / high context) |
|---|---|---|---|
| `sonar` | 1 | 1 | 5 / 8 / 12 |
| `sonar-pro` | 3 | 15 | 6 / 10 / 14 |
| `sonar-reasoning-pro` | 2 | 8 | 6 / 10 / 14 |
| `sonar-deep-research` | 2 | 8 | — (plus citation $2/1M, reasoning $3/1M, search queries $5/1K) |

### Agent API — token price plus metered tool invocations

Selected models ($/1M):

| Model | Input | Output | Cache read |
|---|---|---|---|
| `perplexity/sonar` | **0.25** | **2.50** | 0.0625 |
| `anthropic/claude-haiku-4-5` | 1 | 5 | 0.10 |
| `anthropic/claude-sonnet-5` | 2 | 10 | 0.20 |
| `anthropic/claude-opus-5` | 5 | 25 | 0.50 |
| `openai/gpt-5.6-luna` | 0.20 → 0.40 | 1.20 → 1.80 | 0.02 |
| `openai/gpt-5.6-terra` | 2 → 4 | 12 → 18 | input×0.1 |
| `openai/gpt-5.6-sol` | 5 → 10 | 30 → 45 | 0.50 |
| `openai/gpt-5.4-mini` | 0.75 | 4.50 | 0.075 |
| `google/gemini-3.5-flash` | 1.50 | 9.00 | 0.15 |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.50 | input×0.1 |

Arrows mark tiered rates: the higher rate applies above the model's `tierThreshold`, which is
**272,000 input tokens** for each GPT-5.6 model.

Tools, **$ per invocation**: `web_search` 0.0025 · `fetch_url` 0.00025 ·
`people_search` 0.005 · `finance_search` 0.005 · sandbox session 0.03 (≤20-min window).

Other products: **Search API** $5.00/1K requests. **Embeddings** ($/1M tokens):
`pplx-embed-v1-0.6b` 0.004 (1024 dims), `pplx-embed-v1-4b` 0.03 (2560),
`pplx-embed-context-v1-0.6b` 0.008 (1024), `pplx-embed-context-v1-4b` 0.05 (2560).

### The cost case for the Agent API

**Inference, not a quoted claim.** For a search-grounded query of ~1K input / ~1K output:
Sonar `sonar` at low context ≈ $0.001 + $0.001 + $0.005 request fee ≈ **$0.007**.
Agent `perplexity/sonar` + one `web_search` ≈ $0.00025 + $0.0025 + $0.0025 ≈ **$0.005**.
The gap widens sharply against `sonar-pro` ($15/1M output + $6–14/1K request fee).
*Derived from the two pricing tables above — this comparison is not stated in the source.*
The dominant cost on the Agent API is the per-invocation `web_search` fee, not tokens, so
capping `max_steps` / `max_tool_calls` is the main cost lever.

### Third-party pricing sites are stale — do not use them

A WebSearch on 2026-08-05 returned aggregator pages quoting "Sonar Small Online $0.20,
Sonar Large Online $1.00, Sonar Huge Online $5.00". **None of those model names exist** in
the current API (§5). Those figures contradict the vendor's own pricing object and should be
discarded. I trust the vendor page: it is primary, machine-readable, and self-describes as
the single source of truth.

---

## 7. Contradictions found (all load-bearing)

### 7.1 `/v1/chat/completions` — documented as live, actually 404

The vendor's migration reference lists three interchangeable legacy paths:

> "| `POST /chat/completions`, `POST /v1/sonar`, `POST /v1/chat/completions` (all live, still supported) | `POST https://api.perplexity.ai/v1/agent` |"
>
> — *request-mapping.md*, accessed 2026-08-05

My live probe on 2026-08-05 returned **HTTP 404 with an empty body** for
`POST /v1/chat/completions`, while the other two returned 401. **I trust the probe** — it is
a direct observation of production, and the doc is a hand-maintained table. A helper must not
use `/v1/chat/completions`.

### 7.2 `GET /v1/models` — documented as keyless, actually requires auth

> "`GET https://api.perplexity.ai/v1/models` (no auth required) is authoritative - always
> verify slugs there before writing them into code."
>
> — *models-and-presets.md*, accessed 2026-08-05

My live `GET` on 2026-08-05 returned **HTTP 401**:
`{"error":{"message":"Invalid API key provided...","type":"invalid_api_key","code":401}}`.
**I trust the probe.** Practical consequence: the helper cannot validate model slugs at
startup without a key, and any "list models" subcommand must be auth-gated.

### 7.3 `citations` — announced as removed, still in the live schema

The changelog states flatly:

> "**Update: The `citations` field has been fully deprecated and removed.** All applications
> should now use the `search_results` field, which provides more detailed information
> including titles, URLs, and publication dates."
>
> — *Changelog*, accessed 2026-08-05

Yet the current `/v1/sonar` OpenAPI still declares `citations` as a nullable string array
("URLs of sources used to generate the response"), fetched the same day.
**I trust the changelog for intent and the schema for present behaviour** — most likely the
field is still emitted but frozen and unsupported. Either way the resolution is the same:
**read `search_results`, never `citations`.** On the Agent API the question is moot — there
is no top-level `citations` at all (§3.4).

### 7.4 Observed 401 error `type` differs from the documented catalogue

The error table gives `forbidden` for 401/403 (*response-and-streaming.md*, accessed
2026-08-05). The live wire returned `"type":"invalid_api_key"`. Minor, but a helper that
switches on `error.type` should treat the catalogue as non-exhaustive and fall back on
`error.code`.

### 7.5 Version drift inside the vendor's own material

`models-and-presets.md` illustrates slugs with `openai/gpt-5.1`,
`anthropic/claude-sonnet-4-5`, and `google/gemini-3-flash-preview` (accessed 2026-08-05).
The pricing object of the same date lists `openai/gpt-5.6-*` and `anthropic/claude-opus-5`,
and `google/gemini-3-flash-preview` does not appear at all — a sibling
`google/gemini-3-pro-preview` was **removed on April 1, 2026** per the changelog. Treat the
GitHub skill's example slugs as illustrative and stale; treat the pricing page as current.

---

## 8. What changed recently (dated, from the changelog)

All accessed 2026-08-05 at https://docs.perplexity.ai/docs/resources/changelog.
The changelog labels entries by month, not by day.

**July 2026**
- **Sonar Chat Completions → Agent API** (tagged `Deprecation`). No sunset date given.
- **New models:** `anthropic/claude-opus-5`; the GPT-5.6 family (`sol`, `terra`, `luna`);
  Gemini Flash models; Grok 4.5; Kimi K3 — "all with direct first-party token pricing."
- **`low` preset changed:** "The Agent API `low` preset now uses `openai/gpt-5.6-luna` with
  `minimal` reasoning effort and a 32,768-token maximum output." Frozen configurations must
  be updated by hand; dynamic requests pick it up automatically.
- **Inline citations for presets:** "`fast` cites claims drawn from search results with
  numbered citations such as `[1]`, while `low`, `medium`, and `high` now cite claims drawn
  from tool results or provided source artifacts with source-typed citations such as
  `[web:1]`. After a successful tool call, the `low`, `medium`, and `high` presets include at
  least one citation in the final answer." — relevant if the helper parses inline markers
  rather than the `search_results` item.
- **Remote MCP server:** "available as a remote server hosted by Perplexity at
  `https://api.perplexity.ai/mcp`. Connect any MCP client that supports Streamable HTTP using
  your API key as a bearer token" — billed at standard API pricing. *A plausible alternative
  to building a CLI helper at all, if the engine can consume MCP.*
- **MCP Server 1.0** moved its tools off Sonar onto presets: `perplexity_ask` → `fast`,
  `perplexity_reason` → `medium`, `perplexity_research` → `high`.

**June 2026** — Agent API added `claude-sonnet-5`, GLM 5.2, Kimi K2.7 Code, Nemotron 3 Super.

**April 1, 2026** — `google/gemini-2.5-pro` and `google/gemini-3-pro-preview` removed.
**March 20, 2026** — `google/gemini-2.5-flash` removed.
**December 15, 2025** — `sonar-reasoning` removed.

---

## 9. Concrete guidance for the helper (planner-facing)

1. **Target `POST https://api.perplexity.ai/v1/agent`.** Auth `Authorization: Bearer $PERPLEXITY_API_KEY`.
2. **Provision the key first.** `PERPLEXITY_API_KEY` exists nowhere on this box today (§0);
   the builder will be blocked without it. Suggested home: `/opt/ai-os/.secrets/store/perplexity-api-key`,
   matching the existing `twenty-api-key` convention.
3. **Send a whitelisted body.** Strict mode 400s on any unknown field. Never forward
   arbitrary user options.
4. **Always attach `tools: [{"type":"web_search"}]`** for a research helper, and use
   `tool_choice: {"type":"web_search"}` on citation-critical calls. Without it, answers are
   ungrounded and carry no sources.
5. **Branch on `response.status`, not the HTTP code.** Failures come back as 200.
6. **Read sources from the `output[]` item with `type:"search_results"`, key `results`.**
   Not from `citations` (absent), not from `annotations` (usually empty). Handle
   empty-string snippets and zero-result runs.
7. **Two sensible defaults:** `model: "perplexity/sonar"` + `web_search` for cheap lookups
   ($0.25/$2.50 per 1M + $0.0025/search); `preset: "medium"` for deep research. Expose both.
8. **Cap cost with `max_steps` and `max_tool_calls`** — tool invocations, not tokens,
   dominate the bill.
9. **If `anthropic/*` models are ever selectable, `max_output_tokens` is mandatory** or the
   request 400s.
10. **Do not add a keyless "list models" path** — `/v1/models` is auth-gated (§7.2).
11. **Consider the hosted MCP server** (`https://api.perplexity.ai/mcp`) as an alternative to
    a bespoke CLI, if the engine can consume MCP tools.

### Open questions a live key would settle
- Does `/v1/sonar` still emit `citations`, or is the schema stale (§7.3)?
- What are the actual rate limits and `X-RateLimit-*` header names for this account tier?
  The docs say only "Vary by tier."
- Does `GET /v1/models` list presets alongside model slugs?

---

## Sources

All accessed **2026-08-05**. All retrieved by plain HTTP fetch (WebFetch/WebSearch or
`curl`); **no browser session was used**, so every source here is reproducible with `curl`.
Pages marked *(raw .md)* were fetched by appending `.md` to the docs URL, which returns the
page's Mintlify source including embedded data objects.

1. **Create Chat Completion (Sonar API reference + OpenAPI spec)** — https://docs.perplexity.ai/api-reference/chat-completions-post *(raw .md)*
2. **Agent API reference — POST /v1/agent** — https://docs.perplexity.ai/api-reference/agent-post
3. **Agent API Quickstart** (verbatim cURL + captured response JSON) — https://docs.perplexity.ai/docs/agent-api/quickstart *(raw .md)*
4. **Migrate from Sonar** — https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar
5. **Pricing** (embedded `PRICING` single-source-of-truth object) — https://docs.perplexity.ai/getting-started/pricing *(raw .md)*
6. **Changelog** — https://docs.perplexity.ai/docs/resources/changelog *(raw .md)*
7. **Sonar Models overview** — https://docs.perplexity.ai/getting-started/models
8. **OpenAI compatibility** — https://docs.perplexity.ai/docs/sonar/openai-compatibility
9. **perplexityai/api-platform-developers — `skills/migrate-sonar-to-agent-api/SKILL.md`** — https://github.com/perplexityai/api-platform-developers/blob/main/skills/migrate-sonar-to-agent-api/SKILL.md *(raw.githubusercontent.com)*
10. **…/references/request-mapping.md** — same repo *(raw)*
11. **…/references/response-and-streaming.md** — same repo *(raw)*
12. **…/references/models-and-presets.md** — same repo *(raw)*
13. **Live unauthenticated probes of `api.perplexity.ai`** — my own `curl` calls, 2026-08-05; endpoints and status codes in §2. Not a published source; reproducible with the table in §2.
