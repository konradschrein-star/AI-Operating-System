# `gemini-qa` — video QA through Gemini (pool-first)

> ## ⚠ STATUS as of 2026-08-06: `gemini-qa` cannot analyze a video. Both backends are down.
>
> This is a statement of fact about the two credentials the tool runs on, not a judgement on
> the tool. Everything documented below is implemented, unit-tested and reachable; what is
> missing is a working backend to point it at.
>
> - **`--backend pool` (the default) rejects every file.** `POST /v1/analyze` returns
>   `HTTP 500 … Unknown API error code: 1100` for a 1.3 MB `video/mp4` and for a 40-byte
>   `text/plain` alike — six generation attempts, one success, and that success was text-only
>   (measured 2026-08-05, 19:00–20:44 CEST; full transcript in **§1.2**).
> - **`--backend api` has no credential.** No `GEMINI_API_KEY` exists on this box: not in the
>   environment, and no `gemini-api-key` file in `/opt/ai-os/.secrets/store/` (verified
>   2026-08-06). Every `api` run therefore stops at the missing-key error path (§4.2, §8).
>
> **Two paths unblock it**, and choosing between them is Konrad's call, not this document's:
>
> 1. **Refresh the pool's JWT — free, no new vendor.** `/opt/gemini-pool-api/src/pool.py:10`
>    carries a hardcoded `VEOPARKING_JWT` fallback that **expired 2026-06-26 12:18 UTC**
>    (`exp: 1782476321`); the env var `VEOPARKING_JWT` overrides it. That is a ~10-minute fix
>    **conditional on a fresh veoparking token being mintable for user `4915785471426`** —
>    the conditional is the whole question, and only Konrad can answer it. Note this repairs
>    the *credential*; whether the 1100 fault is solely credential-driven is unproven, because
>    §1.2 shows the pool returns the same opaque code for every failure mode.
> 2. **Add `GEMINI_API_KEY` — billed.** Cost is **~$0.52 per minute of video** (§7), so a 60 s
>    QA pass is ~$0.52 and a 10-minute pass ~$5.
>
> Repairing the Gemini Pool itself is outside this project's scope. Tracked on the reminder
> due 2026-08-06 07:00 CEST (`eff58681-bd02-4663-b447-dd7a74bda4f6`).

Transcribed from `scripts/gemini-qa.mjs --help` and the shipped script (R25; re-synced in R406
after the round-405 review changed `--out` semantics — §5.1; **rewritten at R702** when the
Gemini Pool became the primary backend — §1.1). Evidence for every claim below:
`docs/plan/evidence/p4-gemini-errorpaths.md` (real command transcripts, 2026-08-05),
`docs/research/round-399-41e8757d.md` (API/cost facts),
`docs/research/round-701-33d8cba3.md` (the pool's wire contract, limits and error shapes),
and `forge-control/src/lib/gemini-qa-cli.test.ts` (61 tests, stubbed `fetch` and `fs`).

## 1. What it is / when to use it

`scripts/gemini-qa.mjs` sends a video to Gemini and gets back structured QA findings as JSON:
hook strength, pacing, audio integrity, visual integrity, and factual red flags, each with a
timestamp. It is the QA backbone Konrad wants sitting in front of the video pipeline: the
JSON shape (§6 below) is the contract a human or a later repair agent consumes, not prose a
human has to parse.

Use it whenever a rendered video needs a structured, timestamped pass before it ships —
either as a standalone CLI call, or later wired into the pipeline as an automated gate.

### 1.1 Two backends — `pool` (default) and `api`

| | `--backend pool` **(default)** | `--backend api` |
|---|---|---|
| Service | `POST http://127.0.0.1:8090/v1/analyze` — the local Gemini Pool, a private wrapper around the Gemini **web UI** | `https://generativelanguage.googleapis.com` — the official Gemini API |
| Cost | **free** — rides pool-account entitlements | **billed** to a Google AI Studio key (~$5 per 10-min pass, §7) |
| Credential | `GEMINI_POOL_API_KEY` (§4.1) | `GEMINI_API_KEY` (§4.2) |
| Input | local video file **only** (§3.1) | local file **or** URL, YouTube included |
| Output shape | **free text** → rubric JSON is extracted, then validated (§6.1) | machine-enforced `responseSchema` |
| Model choice | **none** — `--model` is rejected (§3) | `--model`, default `gemini-omni-flash` (unverified — validated at run time, §3.2) |
| Timeout | `--timeout`, default 900 s | fixed 10-min Files API poll deadline |

Pool is the default because Konrad has no personal Gemini key and does not want to buy one.

**There is no automatic fallback between them — not even opt-in.** R702's brief allows an
opt-in fallback only if pool failures are cleanly distinguishable, and
`docs/research/round-701-33d8cba3.md` §6 proves they are not: a dead pool account, an
unsupported file, and a transient Google fault all return the same opaque
`HTTP 500 … Unknown API error code: 1100`. A fallback keyed on an undiagnosable error would
quietly move a video onto a billed endpoint. Choose the backend explicitly.

### 1.2 ⚠ Known limitation: the pool's file path is broken (measured 2026-08-05, 19:00–20:44 CEST)

Measured this round, against the live pool:

| Request | Result |
|---|---|
| `POST /v1/chat` (text only, no file) — 19:00 | **200** `{"text":"OK","account":"cdp-9400"}` in 46 s |
| `POST /v1/chat` (text only, no file) — ~15 min later | **500** `Unknown API error code: 1096` |
| `POST /v1/analyze` + 1.3 MB `video/mp4` | **500** `Unknown API error code: 1100` in 87.9 s |
| `POST /v1/analyze` + 40-byte `text/plain` | **500** `Unknown API error code: 1100` in 88.4 s |
| `POST /v1/chat` (text only, no file) — 20:39, re-check | **500** `Unknown API error code: 1096` in 133.9 s |
| `POST /v1/analyze` + the same 1.3 MB `video/mp4` — 20:43, re-check | **500** `Unknown API error code: 1100` in 96.1 s |

The last two rows are an independent re-verification ~1.5 h after the first four, run through
the shipped CLI rather than raw `curl`. Same outcome, so this is a standing condition and not
a momentary blip: **six generation attempts, one success, and that success was text-only.**

Text generation **flaps** — it worked once and has failed at every later attempt, which is
consistent with the wrapper retiring and respawning sessions around one shared cookie jar.
**Any file attachment fails, for every file type, at every time tried.** This is narrower
than round 701's finding — R701 measured text failing too, so it could only conclude "the
account cannot generate at all". The one text success isolates the failure to the
file-attachment path specifically. It is therefore *not* a video-capability limit and *not*
something this tool can work around: the pool's upload leg reaches
`content-push.googleapis.com` fine, and generation rejects the attachment afterwards.

`avg_response_s` on `GET /v1/status` is a useful side-channel the health endpoint lacks: it
is computed over successful generations only, so a non-null value means *something* once
worked. It read `46.18` throughout this round — the single 19:00 text success, never updated
since.

Consequence: **`--backend pool` is fully implemented and correct against the documented wire
contract, but cannot produce a QA result until the pool side is fixed.** What Konrad owes the
system is in §9. Until then the tool exits 1 with the diagnostic in §8.

`GET /health` will not tell you any of this — it reported `sessions_ready: 4` throughout.

## 2. Requirements

- Node.js >= 22 (this box runs v22.22.2).
- Zero npm dependencies — built-in `fetch` only, no SDK, no shared lib.
- The file is a standalone, executable, copy-anywhere script (`chmod +x`, shebang
  `#!/usr/bin/env node`; git records it `100755`). The key-resolution block is intentionally
  duplicated in `scripts/perplexity.mjs` rather than factored into a shared module, per
  `docs/plan/02-architecture.md` §6.1's standalone-copyable requirement — do not "fix" that.

## 3. Usage

```
gemini-qa.mjs <video-path-or-url> [--backend pool|api] [--model M] [--out FILE]
              [--prompt-extra "..."] [--timeout S] [--preflight] [--help]
```

**Argument**

| Argument | Meaning |
|---|---|
| `<video-path-or-url>` | Local video file path (both backends), or an `http(s)://` URL (**`api` backend only** — see §3.1) |

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--backend pool\|api` | `pool` | Which service answers. No fallback between them (§1.1) |
| `--model M` | `gemini-omni-flash` | Gemini model. **`api` only** — exit 3 on `pool`. The default is **unverified against the vendor** (§3.2) and is validated on every `api` run |
| `--out FILE` | stdout only | **Also** write the QA JSON to FILE. stdout always gets it first — see §5.1 |
| `--prompt-extra "..."` | none | Extra caller context appended to the QA prompt, e.g. `"this is a 60s YouTube Short about sky photography"` |
| `--timeout S` | `900` | Pool request timeout, whole seconds. **`pool` only** — exit 3 on `api` |
| `--preflight` | off | Pool liveness probe before uploading. **`pool` only** — exit 3 on `api` |
| `--no-model-check` | off (the check runs) | Skip the `GET /v1beta/models` validation of `--model`. **`api` only** — exit 3 on `pool`, which selects no model. See §3.2 |
| `--help`, `-h` | — | Print usage and exit 0 |

Flags accept either `--model M` or `--model=M` form. Unknown flags, a missing argument value,
or an empty flag value are all usage errors (exit 3).

**A flag the chosen backend cannot honour is rejected, never ignored.** `--model` on the pool
is exit 3 rather than a silently dropped value, because the pool wrapper never passes a model
at all — accepting it would report a choice that was not made. Same for `--timeout` and
`--preflight` on the `api` backend.

### 3.2 The model is validated before anything is billed (R705)

`gemini-omni-flash` was never confirmed against Google. It comes from
`docs/research/round-701-33d8cba3.md:331`, which said in as many words:

> Treat `gemini-omni-flash` as unconfirmed; validate against `GET /v1beta/models` before
> trusting it.

It shipped without that validation, and no key has ever existed on this box (§9.2), so no run
could catch it either. Nothing before this section's change tested the *name*; the
consistency check at the foot of this file compares the doc against the code, which agree
with each other and with nobody else.

So the caveat is now enforced rather than remembered. Every `api` run begins with one free
`GET /v1beta/models?pageSize=200` and refuses to go further unless the chosen model is listed
**and** advertises `generateContent`:

| Outcome | Behaviour |
|---|---|
| Listed, advertises `generateContent` | Proceeds. stderr: `model "..." validated against GET /v1beta/models (supported)` |
| Listed, no `supportedGenerationMethods` field | Proceeds (`exists-methods-unreported`). Absence of the field is not evidence the model cannot generate |
| Listed, but no `generateContent` | **Exit 3**, naming the methods it *does* advertise and every model this key can generate with |
| Not listed | **Exit 3**. If the model is the tool's default, the message says so and points here. If the list was truncated (`nextPageToken`), the message says "not on the first page" rather than claiming non-existence |
| `GET /v1beta/models` non-2xx or unparseable | **Exit 1**, status and body verbatim. Never treated as "unknown, carry on" — a key that cannot reach ListModels cannot reach `generateContent` either |

The check runs **before** the Files API upload, so a wrong model name costs one round trip
rather than an upload plus a poll-to-`ACTIVE`. Nothing is uploaded and nothing is billed on
any of the exit-3 paths.

`--no-model-check` skips it, prints a stderr line saying the model is unvalidated, and exists
for the case where the list endpoint is wrong rather than the model. It is exit 3 on the pool
backend, which selects no model at all.

**Still open:** this gate has never run against a real key. It is proved against a stubbed
`fetch` in `forge-control/src/lib/gemini-qa-cli.test.ts` (`R705 model validation`, 13 cases).
The first real `api` invocation is what will settle whether `gemini-omni-flash` exists —
which is precisely why it must not be the same invocation that uploads a video.

### 3.1 URL inputs and the pool backend — the decision

`gemini-qa <url>` on the **pool** backend is a **usage error (exit 3)**, not a download:

```
$ scripts/gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
gemini-qa.mjs: URL input is not supported on the pool backend: https://www.youtube.com/watch?v=dQw4w9WgXcQ
  http://127.0.0.1:8090/v1/analyze takes an uploaded file, not a URI, and this tool does not download.
  Either save the video locally and pass the file path, or use --backend api (billed), which accepts URLs including YouTube.
exit=3
```

Rejecting was chosen over downloading-to-a-bounded-temp-file because a YouTube watch URL is
an HTML page, not a video file — honouring it would mean owning a downloader (yt-dlp and its
breakage cadence), and the `api` backend already passes URLs through natively as
`file_data.file_uri`. Two ways out, both in the error message: download it yourself, or
`--backend api`.

**Examples**

```bash
# Local render through the free pool, JSON to stdout   (default backend)
scripts/gemini-qa.mjs ./render/final.mp4

# Probe the pool before spending 90s on an upload      (recommended after any outage)
scripts/gemini-qa.mjs ./render/final.mp4 --preflight

# A long feature render needs a longer ceiling
scripts/gemini-qa.mjs ./render/final.mp4 --timeout 1800

# Official API instead: billed, structured output, model selectable
scripts/gemini-qa.mjs ./clip.mp4 --backend api --out qa.json

# YouTube URL — api backend only
scripts/gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --backend api
```

Supported local video extensions: `.mp4 .mpeg .mpg .mov .avi .flv .webm .wmv .3gp .3gpp .mkv`.

On the **pool** backend the extension is load-bearing beyond validation: the wrapper derives
the upload's MIME type from the filename alone (`mimetypes.guess_type`), with no content
sniffing anywhere in the chain — so the file is uploaded under its real basename.

On the **api** backend, a URL input is passed straight to the model as `file_data.file_uri`
(no upload step); a local file goes through the Gemini Files API (resumable upload, then
polled until `ACTIVE`) before generation.

## 4. Key setup

> ## ⚠️ READ THIS TWICE: two different secrets share the name `GEMINI_API_KEY`
>
> | | What it is | Where this tool reads it |
> |---|---|---|
> | **`GEMINI_API_KEY`** (env) | A **Google AI Studio key**. Billed by Google. | `api` backend only |
> | **`GEMINI_API_KEY`** (inside `/opt/gemini-pool-api/.env`) | The **pool wrapper's own caller token**, sent as the `x-api-key` header. Nothing to do with Google. | `pool` backend only, and **only from that file** |
>
> The pool service names its caller token `GEMINI_API_KEY` *in its own `.env`* — the same
> string as the Google key's env-var name, for a completely unrelated credential. To keep
> them apart, this tool exposes the pool token under a **different** env-var name,
> `GEMINI_POOL_API_KEY`, and **never** reads `process.env.GEMINI_API_KEY` for the pool.
>
> Get this wrong in either direction and you send a pool token to Google (401 from Google) or
> a Google key to the pool (401 from the pool). Regression test:
> `gemini-qa-cli.test.ts` → *"THE NAMING TRAP: a Google GEMINI_API_KEY in the env is never
> used as the pool key"*.

### 4.1 Pool backend (default) — `GEMINI_POOL_API_KEY`

Resolution order, first non-empty wins:

1. Environment variable: `export GEMINI_POOL_API_KEY=...`
2. Secret-store file: `/opt/ai-os/.secrets/store/gemini-pool-api-key`
3. The `GEMINI_API_KEY=` line inside `/opt/gemini-pool-api/.env` — the pool service's own
   config. Parsed with an anchored per-line match, surrounding quotes stripped; a
   commented-out line is not mistaken for the token, and an empty value counts as absent.

Location 3 is why the pool backend works out of the box on this VPS with nothing configured.
Locations 1 and 2 exist so the token can be supplied without the pool's config being readable
(another box, a container, a narrower permission set).

If none of the three has a value, the script exits 2 **naming all three**, without making any
HTTP request. The key is never printed — not on success, not in any error path.

### 4.2 API backend — `GEMINI_API_KEY`

Resolution order, first non-empty wins:

1. Environment variable: `export GEMINI_API_KEY=...`
2. Secret-store file: `/opt/ai-os/.secrets/store/gemini-api-key`

The env var wins if both are set. The secret-store file follows the standard convention used
elsewhere in `/opt/ai-os/.secrets/store/` (see `twenty-api-key.note` for the pattern): the
file holds the bare key value with a trailing newline trimmed on read; a sibling
`gemini-api-key.note` should describe what the key is for and when it was created, same as
`github-pat-konrad.note` / `twenty-api-key.note` do for their keys.

If neither location has a value, the script exits 2 **without making any HTTP request** —
key resolution happens before the input path is even touched, so a caller with no key gets
the same deterministic failure whether or not the video argument is valid.

## 5. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success — QA JSON on stdout, plus a copy in `--out FILE` if one was given |
| 1 | API or processing error: invalid key, upload failure, file processing `FAILED`, poll timeout (10 min), request timeout (`--timeout`), non-2xx response, unparseable or incomplete model output. HTTP status and response body are printed verbatim; on the pool backend that includes the model's raw text between `--- BEGIN RAW MODEL TEXT ---` markers. |
| 2 | Missing key. Pool: none of the three locations in §4.1. API: neither `GEMINI_API_KEY` nor `/opt/ai-os/.secrets/store/gemini-api-key`. The message names every location checked. |
| 3 | Usage or configuration error: no argument, unknown flag, unreadable input file, unsupported extension, **a URL on the pool backend** (§3.1), **`--model` on the pool backend**, `--timeout`/`--preflight` on the api backend, **`--no-model-check` on the pool backend**, a non-positive `--timeout`, **a `--model` that `GET /v1beta/models` does not list or that cannot do `generateContent`** (§3.2 — nothing uploaded, nothing billed), or an unusable `--out` target (a directory, an unwritable file, or a missing/non-directory parent). A write that fails *after* the request is also exit 3 — and the QA JSON is on stdout in full regardless (§5.1). |
| 4 | **Pool busy or rate-limited** (pool backend only): HTTP 503 (no session came free inside the wrapper's own 60 s acquire window) or HTTP 429 (the pool account is on a ~300 s cooldown). Separate from 1 because it is the one failure worth retrying *later*. **This tool never retries by itself** — no loop, no backoff. stderr carries the `Retry-After` header when the service sends one, and cadence guidance when it does not. |

Why 429/503 get their own code: they are the only pool failures known to be transient. An
opaque 500 is *not* — round 701 traced identical 500s to a pool account that stayed dead for
7.5 days while calling itself "a temporary Google service issue". Retrying that burns pool
sessions that four other production workloads are competing for.

### 5.1 `--out` and the paid-result rule

A 10-minute QA pass costs roughly **$5** (§7) and cannot be recovered: the video has been
uploaded, polled to `ACTIVE`, and `generateContent` has been billed by the time there is
anything to write. So `--out` never diverts the result — it *duplicates* it.

1. **Pre-flight.** Before any upload or request, an existing `--out` target must be a regular
   file (not a directory) and `W_OK`; otherwise its parent must exist, be a directory, and be
   `W_OK`. A bad path costs nothing: exit 3, no HTTP. Gate order overall is arguments → key →
   input classification → `--out`, so a caller with no key still gets exit 2.
2. **stdout first.** The rubric is written to stdout *before* `writeFileSync`. If the write
   fails anyway, the exit is 3 (not 1 — a caller retrying on 1 must not re-buy a result it
   already has), and stderr says the result is not lost.

What the pre-flight cannot catch is only what changes after it runs: the target or its
directory unlinked/replaced mid-run, or `ENOSPC`. This is the same contract, function for
function, as `scripts/perplexity.mjs` (`docs/tools/perplexity.md` §5).

**Large payloads are safe on a pipe.** `process.stdout.write()` is asynchronous when stdout is
a pipe, and `process.exit()` drops whatever has not drained — a silent cut at 64 KiB. Every
byte of stdout and stderr therefore goes out through `fs.writeSync()` on the raw fd, so both
the rubric and the verbatim error bodies survive at any size. Regression tests:
`forge-control/src/lib/gemini-qa-cli.test.ts`, block `R405-2`, driving a >64 KiB payload through
a real `pipe(2)`.

## 6. The QA rubric

**This schema is a frozen contract** (`docs/plan/02-architecture.md` §6.2). Consumers may
depend on it as-is; changing a field name, adding one, or dropping one is a breaking change,
not a routine edit.

**The rubric is identical on both backends** — it does not get looser because the free path
produced it. How each backend gets there differs (§6.1), but the validation does not: every
required top-level key must be present, or exit 1.

On the **api** backend the script requests this exact shape via
`generationConfig.responseSchema` (structured output). Field by field, as the script sends it:

- **`verdict`** — `"pass" | "needs_work" | "reject"`. `pass` ships as is, `needs_work` is
  fixable with the listed `top_fixes`, `reject` means re-produce the video.
- **`confidence`** — number, `0.0`–`1.0`. Reflects how much of the video the model could
  actually assess (not the confidence of any one finding).
- **`hook`** — object:
  - `score` — integer 0–10.
  - `first_seconds_analysis` — string. Judges the first 3 seconds specifically: does it earn
    the next 10 seconds of attention?
  - `notes` — string.
- **`pacing`** — object:
  - `score` — integer 0–10.
  - `dead_spots` — array of `{ start_s, end_s, note }`. `start_s`/`end_s` are seconds from
    the start of the video, never a text range — this is what lets a human or repair agent
    jump straight to the finding.
- **`audio`** — object:
  - `score` — integer 0–10.
  - `glitches` — array of `{ at_s, type, note }`. `type` is one of `click | dropout | desync
    | clipping | other`. `at_s` is seconds from video start.
- **`visual`** — object:
  - `score` — integer 0–10.
  - `artifacts` — array of `{ at_s, type, note }`. `type` is one of `flicker | blur |
    caption_error | broken_asset | other`. `at_s` is seconds from video start.
- **`factual`** — object:
  - `red_flags` — array of `{ at_s, claim, concern }`. `at_s` is seconds from video start.
- **`top_fixes`** — array of strings, **impact-ordered (most valuable first), capped at 5**,
  each concrete and actionable ("cut 0:12–0:19", not "improve pacing").
- **`summary`** — string, 2–3 sentences.

If a category has no findings the model is instructed to return an empty array, not invent a
problem. Every `*_s` value across the schema (`start_s`, `end_s`, `at_s`) is seconds from the
start of the video — that convention is uniform across all four finding categories so a
consumer can treat them interchangeably as seek targets.

### 6.1 How the pool backend reaches the same shape — extraction, not repair

The pool has **no structured-output parameter of any kind**: its wrapper returns
`{"text": <the web UI's prose reply>, "account": <email>}` and never even selects a model.
So on the pool path the rubric is asked for in words (a JSON skeleton appended to the QA
prompt) and then **extracted** from the reply:

1. **Fenced block first.** The contents of a ` ```json ` or bare ` ``` ` fence, wherever it
   sits in the reply — so "Sure! Here is my report:" in front of it costs nothing, and
   "Let me know if you need more!" after it costs nothing.
2. **Otherwise the first brace-balanced `{...}`** in the raw text. The scanner is
   string-aware: braces and escaped quotes *inside* JSON string values do not move the depth
   counter, so a `note` field containing `"} end {"` does not truncate the object.
3. **Parse, then validate** every required rubric key.

**It extracts; it never repairs.** A truncated object, an unclosed fence, a refusal, an
array instead of an object, or a missing rubric key is **exit 1 with the model's raw text
printed verbatim** between `--- BEGIN RAW MODEL TEXT ---` / `--- END RAW MODEL TEXT ---`
markers — no second request, no patching, nothing on stdout. A silently repaired QA verdict
is worse than no verdict: it looks authoritative and is not.

The raw text survives at any size — the >64 KiB pipe case is a regression test
(`gemini-qa-cli.test.ts`, block R405-2), because a diagnostic cut at the pipe buffer is
undiagnosable.

One hazard inherited from the pool wrapper, worth knowing before it surprises someone: the
wrapper strips any `http://googleusercontent.com/<kind>/<digits>` substring from the reply
(round 701 §5). Harmless for prose; it would silently corrupt a JSON string field that
happened to contain such a URL. Nothing this tool can detect — noted so a bizarre parse
failure has a suspect.

## 7. Cost notes

- Default model: `gemini-omni-flash` — **unverified against the vendor**; validated on every
  `api` run before anything is billed (§3.2).
- Text: **$1.50 / $9.00 per 1M tokens** (input/output).
- Video input: **~5,792 tokens/sec at 720p**. At the input price above that is
  **~$0.0087 per second of video** (5,792 × $1.50 ÷ 1,000,000), i.e. **~$0.52/min**, so a
  10-minute QA pass costs **~$5** in video tokens. The QA JSON itself is the only output —
  a few thousand tokens, well under $0.05.

**Do not use the $0.10/sec figure.** `docs/research/round-399-41e8757d.md` §1–2 quotes
"≈ $0.10/sec at standard pricing **if consumed as token stream**", but that is arithmetically
inconsistent with the token rate it cites in the same sentence: 5,792 tok/s at $1.50/1M is
$0.0087/s, ~11.5× lower (even at the $9.00 *output* price it would be $0.052/s). The two
numbers cannot both describe token billing. One of them is a per-second media-billing rate
carried over from the Veo rows ($0.40–$0.60/sec) rather than from Omni Flash's token math.
Until a real invoice settles it, budget from the token rate above — it is the one derivable
from published unit prices — and treat $0.10/sec as an unverified worst case. Neither figure
has been checked against an actual bill: no key exists on this box (§9).

**Warning:** `docs/plan/02-architecture.md` §6.2 names `gemini-3.6-flash` as the default and
cites `$1.50/$7.50 per 1M; video ≈ 300 tok/s` — both are wrong. `gemini-3.6-flash` does not
accept video input at all, which would fail the tool's primary use case on every invocation,
and the real video ingestion rate is ~5,792 tok/s, not 300. The code default was set to
`gemini-omni-flash` specifically because of this; see `docs/research/round-399-41e8757d.md`
finding 1 for the source verification (checked against `ai.google.dev/models` and
`ai.google.dev/pricing`, 2026-08-05).

## 8. Error paths

### 8.0 Pool backend — live transcripts (R702, this worktree, 2026-08-05)

**Wrong pool key (exit 1)** — the pool's real 401, status and body surfaced:

```
$ GEMINI_POOL_API_KEY=definitely-not-the-pool-key scripts/gemini-qa.mjs /tmp/r702-probe-12s.mp4
gemini-qa.mjs: pool analyse — r702-probe-12s.mp4 (1297548 bytes, video/mp4), timeout 900s
gemini-qa.mjs: pool analyse failed
HTTP 401 Unauthorized
Unauthorized
raw body:
{"detail":"Unauthorized"}
exit=1
```

**`--preflight` aborting before the upload (exit 1)** — the probe found the pool unable to
generate even text, so the 1.3 MB video was never sent and no pool session was tied up for
90 s. This is exactly the failure round 701 said to design for:

```
$ scripts/gemini-qa.mjs /tmp/r702-probe-12s.mp4 --preflight
gemini-qa.mjs: pool preflight — POST http://127.0.0.1:8090/v1/chat (this takes ~45s)
gemini-qa.mjs: pool preflight failed
HTTP 500 Internal Server Error
Failed to generate contents (stream). Unknown API error code: 1096. This might be a temporary Google service issue.
  A 500 here is opaque by construction: the wrapper reports Google's error code and
  nothing else, and the same code covers a dead pool account, an unsupported file and
  a transient Google fault. Do NOT read it as "temporary" just because it says so.
  Check, in this order:
    1. gemini-qa.mjs --preflight ...        (or: POST http://127.0.0.1:8090/v1/chat {"prompt":"Reply with OK"})
       If text generation ALSO fails, the pool account is dead — re-auth it.
       If text succeeds and only file requests fail, the file-attachment path is
       broken for every file type; that is a pool-side problem, not a video problem.
    2. docker logs gemini-pool-api-gemini-api-1 | tail   (look for AuthError /
       "Account status: UNAUTHENTICATED")
  GET http://127.0.0.1:8090/health cannot tell you any of this — it reports sessions as ready
  without ever observing a generation outcome (docs/research/round-701-33d8cba3.md §2a).
raw body:
{"detail":"Failed to generate contents (stream). Unknown API error code: 1096. This might be a temporary Google service issue."}
exit=1
```

**A real video through the real pool (exit 1)** — 19:14:37 → 19:16:05, i.e. 88 s, a 12-second
1080p excerpt of an actual pipeline render. This is the failure described in §1.2, reached
through the shipped tool rather than curl:

```
$ scripts/gemini-qa.mjs /tmp/r702-probe-12s.mp4 --prompt-extra "12-second excerpt of a tutorial render, 1080p h264 + 48kHz aac narration"
gemini-qa.mjs: pool analyse — r702-probe-12s.mp4 (1297548 bytes, video/mp4), timeout 900s
gemini-qa.mjs: pool analyse failed
HTTP 500 Internal Server Error
Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue.
  [ ... the same diagnostic block as above ... ]
raw body:
{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}
exit=1
```

Note the code differs from the preflight's: **1096 for text-only, 1100 for file-bearing
requests** — the same split round 701 observed. Neither is in `gemini_webapi` 2.0.0's
`ErrorCode` enum, hence "Unknown API error code".

**Missing pool key (exit 2)** — all three locations named, no HTTP request made:

```
gemini-qa.mjs: no Gemini Pool key found. All three locations were checked:
  1. environment variable  GEMINI_POOL_API_KEY
  2. secret-store file     /opt/ai-os/.secrets/store/gemini-pool-api-key
  3. GEMINI_API_KEY= line in /opt/gemini-pool-api/.env
  This is the POOL's caller token (sent as the x-api-key header), NOT a Google AI
  Studio key. Location 3 names it GEMINI_API_KEY, which is confusingly the same
  name the --backend api path uses for an unrelated Google key; do not copy one into
  the other's slot.
  No request was made.
exit=2
```

**The five body shapes.** Round 701 §6 catalogued five distinct non-2xx bodies on this
endpoint, and a client that assumes `detail` is a string crashes on two of them. All five are
handled and covered by tests:

| Status | Body shape | This tool |
|---|---|---|
| 401 / 500 / 503 | `{"detail": "<string>"}` | message surfaced |
| 422 (missing header) | `{"detail": [ {...} ]}` — an **array** | described, not crashed on |
| 413 (public route) | raw **nginx HTML** | described, printed verbatim |
| 503 | session-acquire timeout | **exit 4** + retry guidance |
| 429 | account cooldown | **exit 4** + ~300 s guidance |

### 8.1 API backend

Transcripts below are pasted verbatim from `docs/plan/evidence/p4-gemini-errorpaths.md`
(real commands run in this worktree, node v22.22.2, 2026-08-05).

**Missing key (exit 2) — no HTTP request made:**

```
$ env -u GEMINI_API_KEY node scripts/gemini-qa.mjs /tmp/qa-sample.mp4
gemini-qa.mjs: no Gemini API key found.
  Set the environment variable GEMINI_API_KEY, or write the key to the secret-store file /opt/ai-os/.secrets/store/gemini-api-key.
  Key name: GEMINI_API_KEY (secret-store name: gemini-api-key).
  No request was made.
exit=2
```

**Invalid key, URL input (exit 1)** — Google's real response, status and body verbatim. The
failing step is `generateContent`, proving the URL path skips the Files API and passes the
YouTube URL straight through as `file_data.file_uri`:

```
$ GEMINI_API_KEY=definitely-invalid node scripts/gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
gemini-qa.mjs: generateContent failed
HTTP 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": { "service": "generativelanguage.googleapis.com" }
      },
      {
        "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
        "locale": "en-US",
        "message": "API key not valid. Please pass a valid API key."
      }
    ]
  }
}
exit=1
```

**Invalid key, local file input (exit 1)** — Files API upload failure, a different step than
the URL case above: the local-file branch reaches the resumable-upload `start` call before
failing, which is the point — the Files API path is genuinely exercised:

```
$ head -c 4096 /dev/urandom > /tmp/qa-sample.mp4
$ GEMINI_API_KEY=definitely-invalid node scripts/gemini-qa.mjs /tmp/qa-sample.mp4
gemini-qa.mjs: files upload (start) failed
HTTP 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": { "service": "generativelanguage.googleapis.com" }
      },
      {
        "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
        "locale": "en-US",
        "message": "API key not valid. Please pass a valid API key."
      }
    ]
  }
}
exit=1
```

**Files API upload failure, more generally:** any non-2xx from `files upload (start)` or
`files upload (transfer)` is exit 1 with the HTTP status and response body printed verbatim
(`dieHttp()` in the script). If `files upload (start)` returns 2xx but omits the
`x-goog-upload-url` response header, that is also exit 1 — the script cannot proceed without
somewhere to stream the file.

**10-minute poll timeout:** after a successful upload, the script polls
`GET /v1beta/{file.name}` every 5 seconds waiting for `state: ACTIVE`. If the file reaches
`state: FAILED`, that's an immediate exit 1 with the full file resource dumped as JSON. If 10
minutes pass without reaching `ACTIVE` (`FAILED` or not), it's exit 1 with the last known
state reported — no retry, no silent continuation past the deadline.

## 9. Key status — what Konrad owes the system

### 9.1 Pool backend (the default) — a key is NOT what is missing

The pool token resolves fine on this box, from location 3 (`/opt/gemini-pool-api/.env`), so
`gemini-qa` reaches the pool without any configuration. **What is broken is the pool's own
Google authentication**, which no amount of work in this tool can fix (§1.2).

Three reminders queued 2026-08-05, all `pending` at time of writing:

| Reminder id | Due (local) | What it asks for |
|---|---|---|
| `a2224386-845a-4e27-a109-f766eb4f9104` | 2026-08-06 09:00 | Fresh `__Secure-1PSID` / `__Secure-1PSIDTS` for account `cdp-9400` in `/opt/gemini-pool-api/fresh_accounts.json` — the current pair is from Jun 30 |
| `0a1176d1-975c-4f0e-ad81-5ea959038526` | 2026-08-06 09:05 | `VEOPARKING_JWT` at `/opt/gemini-pool-api/src/pool.py:10` **expired 2026-06-26**, so the account-assign fallback is dead too; and `session_pool.py:128` should reject `AccountStatus.UNAUTHENTICATED` (1016), not only `TOS_PENDING` (1040) — that is why `/health` reports dead sessions as ready |
| `cacf9d2b-5f35-411c-a925-db5a795bcb48` | 2026-08-06 09:10 | *Optional*: the billed backend, §9.2 |

**Update 2026-08-06 (R776): all three rows above are now `dismissed`, not `pending`.** They
were superseded — not answered — by a single decision reminder,
`eff58681-bd02-4663-b447-dd7a74bda4f6`, due 2026-08-06 07:00 CEST, which puts the same choice
to Konrad as (a) refresh the pool JWT vs (b) add a billed key (see the status banner under the
H1). The *content* of the three rows still stands: nothing here has been fixed, and each row
remains an accurate description of what is broken. Only their delivery was consolidated.

Verification command once the pool is re-authed, in this order:

```bash
scripts/gemini-qa.mjs /path/to/clip.mp4 --preflight
```

If the preflight passes but the analysis still returns 500/1100, the file-attachment path is
still broken and the cookies were not the whole story.

### 9.2 API backend — still keyless, and that is now optional

As of **2026-08-05, no Gemini API key exists on this box** — neither `GEMINI_API_KEY` nor
`/opt/ai-os/.secrets/store/gemini-api-key` is present
(`docs/plan/evidence/p4-gemini-errorpaths.md` §"Reminder protocol"). Since R702 this no longer
blocks the tool's default path: `--backend api` is the optional, billed secondary, and Konrad
has said he does not want to buy a key. Reminder `cacf9d2b-5f35-411c-a925-db5a795bcb48` records
what to add if that ever changes — and warns, again, not to cross the two credentials (§4).

Until that key lands, every `--backend api` invocation on this box exits 2 deterministically
(§8.1) — by design, not a bug: no HTTP request is ever attempted without a key.

## Open discrepancies

- **Video cost per second is unsettled (§7).** The token-derived figure (~$0.0087/sec) and the
  research doc's "≈ $0.10/sec" cannot both be right; this file budgets from the token math and
  flags the other as an unverified worst case. Settles on the first real invoice.
- **No successful run against the live API has ever been observed.** No Gemini key exists on
  this box (§9.2), so every success-path claim about the *vendor* — the rubric JSON the model
  actually returns, the upload/poll timings, the cost figures — is derived from the shipped
  code and published material, not from a captured round-trip. Only the error paths in §8 are
  live transcripts. What *is* exercised end to end is this script's own output handling:
  `forge-control/src/lib/gemini-qa-cli.test.ts` stubs `globalThis.fetch` (and, for key
  resolution, `fs`) through `--import` preloads and drives the §5.1 contract, the §6.1
  extraction cases and the §8.0 error shapes against the real script, with no key, no spend
  and no pool traffic.
- **No successful run against the live POOL has been observed either, for the same class of
  reason** — the pool's file path is down (§1.2). The pool backend's *failure* handling is
  proved live (§8.0: real 401, real 500/1096 preflight abort, real 500/1100 video analysis);
  its *success* handling — fenced-JSON extraction, rubric validation, `--out` duplication — is
  proved only against stubbed replies. The first thing to re-run once the pool is re-authed is
  a real video, to learn two things this round could not measure: **how long Gemini actually
  takes to watch a minute of video**, and **how much chatter surrounds the JSON** (which is
  what sizes the extraction in §6.1).
- **`gemini-omni-flash` — the api default — has never been confirmed to exist.** R701 flagged
  it (`docs/research/round-701-33d8cba3.md:331`: "treat `gemini-omni-flash` as unconfirmed;
  validate against `GET /v1beta/models` before trusting it") and it shipped anyway. It is
  latent rather than live only because `--backend api` exits 2 before any HTTP call on this
  box — but R701's own verdict is "POOL CAN CARRY VIDEO QA: **NO**" (0/7 generations), so
  `api` is the only path that can ever work, and its default model is research rather than
  observation. Since R705 the name is validated against `GET /v1beta/models` before the first
  billed run (§3.2), which converts an unverified guess into a loud exit 3 — but the
  *validation itself* is still unexercised against a real key. Settles on the first real
  `api` invocation, which is now guaranteed to be a free GET rather than a paid upload.
- **The `audio` rubric dimension is unproven on the pool path.** Round 701 §4 flagged this and
  it remains open: the upstream `gemini_webapi` library documents no video or audio input at
  all (the PR that would have added explicit multimedia MIME handling was closed unmerged), so
  whether the web-UI path decodes the audio track is unobservable from here. When the pool
  comes back, probe it with a question answerable *only* from the audio track — the tutorial
  job scripts in the `content_forge` Postgres DB are the ground truth — before trusting
  `audio.glitches` on this backend. On the api backend the dimension is documented by Google
  (~32 tokens/sec of audio, processed at 1 Kbps single channel) and is safe.

Everything else matched when this file was written: `--help` output, all five exit codes, all
five key locations across the two backends, and the frozen rubric schema (checked field by
field against the script's `responseSchema` and its pool-prompt skeleton) all agree with the
shipped script.

**Read that sentence for exactly what it claims.** It is a doc-vs-code consistency check, and
nothing more. R705 caught this paragraph reading as though it validated the
`gemini-omni-flash` default; it never did — it only established that the doc and the script
name the same model. Whether Google serves a model by that name is a question no artefact in
this repository can answer, and the only thing that will is `GET /v1beta/models` with a real
key (§3.2).
