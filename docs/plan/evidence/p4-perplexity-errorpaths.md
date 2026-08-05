# P4 evidence — `scripts/perplexity.mjs` error paths (R22 / R23 / R24)

**Round:** 401 · **Phase 4, task 2 of 2** · **Date:** 2026-08-05
**Artifact under test:** `scripts/perplexity.mjs` (new, zero-dependency, node v22.22.2)
**Working dir for every command below:** `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`

Every block is command → output → exit code, verbatim. The reviewer re-runs all of them (gate I4).

Two decisions taken at build time and recorded here because they are load-bearing:

1. **Search endpoint = `POST https://api.perplexity.ai/search`** — resolved empirically in step 8.
2. **No key exists on this box**, so the API-facing proofs are the 401 path (step 7). That is the
   point of R23: a 401 with the body printed verbatim proves the request path end to end without a
   valid key. No live smoke was possible; one reminder was queued instead (step 12).

---

## 1. `node --check scripts/perplexity.mjs`

```
$ node --check scripts/perplexity.mjs; echo "exit=$?"
exit=0
```

No output, exit 0 — the file parses.

---

## 2. `--help` → exit 0, complete usage for both modes

```
$ node scripts/perplexity.mjs --help; echo "exit=$?"
perplexity.mjs — Perplexity Agent API helper (zero-dependency, node >= 22)

USAGE
  scripts/perplexity.mjs ask "<question>" [options]
  scripts/perplexity.mjs search "<query>" [options]
  scripts/perplexity.mjs --help

MODES
  ask       Ask a question via the Agent API (POST https://api.perplexity.ai/v1/agent).
            Web search is attached and, by default, FORCED — this helper is citation-critical.
            stdout JSON: { "answer", "citations", "search_results", "model", "usage" }
            A run may legitimately return zero sources; that is not an error.

  search    Raw web search via the Search API (POST https://api.perplexity.ai/search).
            stdout JSON: { "search_results" }

OPTIONS FOR ask
  --model <slug>          Model to serve the request. Default: perplexity/sonar
                          Mutually exclusive with --preset. There is NO perplexity/sonar-pro slug.
  --preset <name>         One of: fast | low | medium | high | xhigh
                          Mutually exclusive with --model.
  --instructions "<text>" System instructions. With --preset this REPLACES the preset's prompt.
  --max-steps <n>         Research loop steps, 1-100. Default: 8
  --max-tool-calls <n>    Tool-call ceiling, 0-100. Default: 5
                          0 disables all tool calls and requires --no-force-search.
  --no-force-search       Relax tool_choice from {"type":"web_search"} to "auto".
                          The model may then answer without searching (uncited).
  --out <file>            Also write the JSON result to <file>. stdout is unaffected.

OPTIONS FOR search
  --max-results <n>       1-20. Default: 10
                          Above 20 is a usage error, not a silent clamp.
  --out <file>            Also write the JSON result to <file>.

COST
  Tool invocations dominate the bill, not tokens: web_search is billed per invocation
  ($0.0025 each as of 2026-08-05), while perplexity/sonar is $0.25 in / $2.50 per 1M tokens.
  That is why --max-steps (default 8) and --max-tool-calls
  (default 5) are the caps to reach for. The Search API is billed
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
exit=0
```

All four exit codes documented; cost defaults (`--max-steps` 8, `--max-tool-calls` 5) documented.

---

## 3. Missing mode / missing subject → exit 3

```
$ node scripts/perplexity.mjs; echo "exit=$?"
usage error: no mode given — expected "ask" or "search"

Run with --help for the full usage.
exit=3
```

```
$ node scripts/perplexity.mjs ask; echo "exit=$?"
usage error: ask requires a question argument

Run with --help for the full usage.
exit=3
```

---

## 4. `--max-results 21` → exit 3, no request sent

```
$ node scripts/perplexity.mjs search "x" --max-results 21; echo "exit=$?"
usage error: --max-results must be between 1 and 20, got 21

Run with --help for the full usage.
exit=3
```

**Proof that no request was sent:** the exit code is 3, not 2. Argument parsing runs to completion
*before* `resolveApiKey()`, and no key exists on this box — so had execution reached the network
stage it would have exited 2 with the missing-key message. A hard cap, not a silent clamp.

---

## 5. `--model` + `--preset` together → exit 3

```
$ node scripts/perplexity.mjs ask "x" --model perplexity/sonar --preset high; echo "exit=$?"
usage error: --model and --preset are mutually exclusive — send one or the other, never both

Run with --help for the full usage.
exit=3
```

(Exactly one of `model` / `preset` ever reaches the wire — see `buildAskBody`.)

---

## 6. No key → exit 2, both locations named, no HTTP attempted

```
$ env -u PERPLEXITY_API_KEY node scripts/perplexity.mjs ask "test"; echo "exit=$?"
No Perplexity API key found. Nothing was sent.
Set the key named PERPLEXITY_API_KEY in ONE of these two locations:
  1. environment variable: PERPLEXITY_API_KEY
  2. secret-store file:    /opt/ai-os/.secrets/store/perplexity-api-key
The file must contain the raw key and nothing else; surrounding whitespace is trimmed.
exit=2
```

```
$ env -u PERPLEXITY_API_KEY node scripts/perplexity.mjs search "test"; echo "exit=$?"
No Perplexity API key found. Nothing was sent.
Set the key named PERPLEXITY_API_KEY in ONE of these two locations:
  1. environment variable: PERPLEXITY_API_KEY
  2. secret-store file:    /opt/ai-os/.secrets/store/perplexity-api-key
The file must contain the raw key and nothing else; surrounding whitespace is trimmed.
exit=2
```

Both messages name the env var `PERPLEXITY_API_KEY` **and** the file
`/opt/ai-os/.secrets/store/perplexity-api-key` verbatim. Identical in both modes — the key is
resolved once, before any mode-specific work.

---

## 7. Invalid key → API status + body verbatim, exit 1

This is the request-path proof. Both endpoints were really contacted.

```
$ PERPLEXITY_API_KEY=definitely-invalid node scripts/perplexity.mjs ask "test"; echo "exit=$?"
HTTP 401 Unauthorized from https://api.perplexity.ai/v1/agent
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}

exit=1
```

```
$ PERPLEXITY_API_KEY=definitely-invalid node scripts/perplexity.mjs search "test"; echo "exit=$?"
HTTP 401 Unauthorized from https://api.perplexity.ai/search
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}

exit=1
```

The body is byte-identical to the envelope `docs/research/perplexity-api.md` §2 captured from the
wire on 2026-08-05 — unmodified, not re-wrapped, not summarised.

---

## 8. Endpoint probe — resolving `/search` vs `/v1/search`

`docs/research/perplexity-api.md` §2 live-probed `POST /search`; `round-399-41e8757d.md` referred to
`/v1/search`. Settled with keyless probes (401 = route exists, 404 = it does not):

```
$ for p in /search /v1/search; do
    printf '%s -> ' "$p"
    curl -s -o /dev/null -w '%{http_code}\n' -XPOST "https://api.perplexity.ai$p" \
      -H 'content-type: application/json' -d '{}'
  done
/search -> 401
/v1/search -> 401
```

**Both routes exist.** Per the task's tie-break rule, the script uses **`/search`** — the path
actually observed in the research doc. Cited in a code comment at the top of `scripts/perplexity.mjs`
and in the `SEARCH_URL` constant. One path is chosen at build time; there is deliberately **no
runtime fallback** between endpoints.

The Agent API path was not re-probed here because step 7 exercises it directly with a real
round-trip: `POST /v1/agent` returned a 401 envelope, which proves the route exists and is
auth-gated. (`/v1/chat/completions` — 404 per the research doc — is not used anywhere.)

---

## 9. File mode → `100755`

```
$ git ls-files -s scripts/perplexity.mjs
100755 d008ce1d91e92c2dc34dac43c33cc14322f56bdb 0	scripts/perplexity.mjs
```

---

## 10. Zero new dependencies

```
$ git diff --name-only main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
(no output)
```

Empty, as required. `scripts/perplexity.mjs` imports only `node:fs` and uses built-in `fetch`; no
`package.json`, `pnpm-lock.yaml`, or `node_modules` was created or modified.

---

## 11. forge-control regression — tsc + test suite

```
$ cd forge-control && pnpm install --prod=false && npx tsc --noEmit && pnpm test
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 785ms using pnpm v9.15.9
=== TSC ===
tsc_exit=0
=== TEST ===
...
ok 46 - T14 parseRoleFile robustness — BOM, CRLF, malformed header
1..46
# tests 143
# suites 29
# pass 143
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 354.898831
```

`npx tsc --noEmit` clean (exit 0); **143 tests, 143 pass, 0 fail.** This task added no TypeScript —
the run confirms it broke nothing.

---

## 12. R24 reminder — key still missing, exactly ONE reminder posted

Re-checked at build time, as instructed:

```
$ test -s /opt/ai-os/.secrets/store/perplexity-api-key && echo PRESENT || echo MISSING
MISSING
$ [ -n "$PERPLEXITY_API_KEY" ] && echo ENV_PRESENT || echo ENV_MISSING
ENV_MISSING
$ ls /opt/ai-os/.secrets/store/
github-pat-konrad
github-pat-konrad.note
github-pat-shane
github-pat-shane.note
twenty-api-key
twenty-api-key.note
twenty-crm-admin
twenty-crm-shane
```

Planning-time recon confirmed: `perplexity-api-key` does not exist. Posted **once**:

```
$ curl -sX POST http://127.0.0.1:7700/api/reminders -H 'content-type: application/json' \
    -d '{"text":"Add PERPLEXITY_API_KEY — ...","when":"tomorrow 9:00"}'
{"ok":true,"reminder":{"id":"4c4532af-24ed-4642-a7ef-15ae291391e7", ...}}
```

Confirmed with `GET /api/reminders` — the matching row, verbatim:

```json
{
  "id": "4c4532af-24ed-4642-a7ef-15ae291391e7",
  "text": "Add PERPLEXITY_API_KEY — put the raw key in /opt/ai-os/.secrets/store/perplexity-api-key (or export the env var PERPLEXITY_API_KEY instead; the tool checks the env var first, then that file). It unlocks scripts/perplexity.mjs, the researcher lane search instrument: cited web answers via the Perplexity Agent API plus raw search results. Until the key lands, both modes hard-exit 2 and no research call can be made.",
  "due_at": "2026-08-06 07:00:00.144+00",
  "recur": null,
  "status": "pending",
  "source": "chat",
  "created_at": "2026-08-05 13:57:10.1452+00",
  "delivered_at": null
}
```

The text names the exact key name `PERPLEXITY_API_KEY`, the secret-store path
`/opt/ai-os/.secrets/store/perplexity-api-key`, the env-var alternative, and what it unlocks.

**No-duplicates check** — reminders whose text mentions `perplexity.mjs`:

```
$ curl -s http://127.0.0.1:7700/api/reminders | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('total reminders mentioning perplexity.mjs:', sum(1 for r in d['reminders'] if 'perplexity.mjs' in r['text']))"
total reminders mentioning perplexity.mjs: 1
```

Exactly one. (A pre-existing delivered reminder `d342ac3b` mentions `PERPLEXITY_API_KEY` in passing
while cancelling an unrelated `researcher.md` request; it is not an R24 reminder — it names neither
the secret-store path nor the env-var alternative — and it was not created by this task.)

---

## 13. Extra strictness proofs (beyond the required list)

The Agent API hard-400s on any unknown field, so the CLI refuses to forward anything it does not
whitelist. Each of these exits 3 with no request sent:

```
$ node scripts/perplexity.mjs ask "x" --temperature 0.5; echo "exit=$?"
usage error: unknown option "--temperature"
exit=3

$ node scripts/perplexity.mjs search "x" --preset high; echo "exit=$?"
usage error: --preset is only valid in "ask" mode
exit=3

$ node scripts/perplexity.mjs ask "x" --preset sonar-pro; echo "exit=$?"
usage error: --preset must be one of fast | low | medium | high | xhigh, got "sonar-pro"
exit=3

$ node scripts/perplexity.mjs ask "x" --max-tool-calls 0; echo "exit=$?"
usage error: --max-tool-calls 0 disables all tool calls, which contradicts forced web search — pass --no-force-search too
exit=3

$ node scripts/perplexity.mjs search "x" --max-results 3.5; echo "exit=$?"
usage error: --max-results expects a non-negative integer, got "3.5"
exit=3
```

(`Run with --help for the full usage.` follows each message; elided above for density, present in
the real output — see steps 3–5 for the untrimmed form.)

The `--preset sonar-pro` case matters: there is **no** `perplexity/sonar-pro` slug and no such
preset, and the CLI rejects the invented name locally instead of paying for a 400.

---

## 14. Commit attribution note (concurrent-builder artifact)

`scripts/perplexity.mjs` landed in commit **`baf6d93`** ("feat(tools): gemini-qa CLI …"), not in
this task's own commit. Cause: the two Phase-4 builders share this worktree, and the file was
already staged (`git add`, for the step-9 mode check) when the Gemini builder committed — their
`git commit` swept the staged index entry in with theirs.

Nothing was lost or altered. Verified:

```
$ git log --oneline -- scripts/perplexity.mjs
baf6d93 feat(tools): gemini-qa CLI — zero-dep Gemini video QA with frozen rubric contract

$ git ls-tree HEAD scripts/perplexity.mjs
100755 blob d008ce1d91e92c2dc34dac43c33cc14322f56bdb	scripts/perplexity.mjs

$ git diff HEAD --stat -- scripts/perplexity.mjs
(no output)
```

The committed blob hash `d008ce1d…` is identical to the one recorded in step 9, and mode is
`100755`. History was deliberately **not** rewritten: the other builder may still be working off
these commits, and rewriting shared history mid-phase is exactly the kind of destructive fix this
project forbids.

---

## What is NOT proven here, and why

- **No successful 200 response was ever observed.** No key exists on this box. Response parsing
  (`extractAnswer`, `extractSearchResults`, `extractCitations`, the `response.status` branch) is
  written against `docs/research/perplexity-api.md` §3.4/§3.5 — which the research doc itself flags
  as documented-but-unverified for body shapes. First real run with a key should be treated as the
  confirmation step.
- **The Search API response key is unconfirmed.** `runSearch` accepts a top-level `results` array
  (documented shape) or `search_results`, and **hard-errors with the body printed verbatim** if
  neither is present. That is an explicit failure path, not a silent empty result — a wrong guess
  surfaces loudly on the first keyed call rather than returning `[]`.
- **Strict-mode acceptance of the request body is unconfirmed**: a 401 is returned before field
  validation, so the whitelist in `buildAskBody` has not been round-tripped. It sends only
  `input`, `model` XOR `preset`, `tools`, `tool_choice`, `max_steps`, `max_tool_calls`, and
  `instructions` when given — exactly the whitelist the task specified.
