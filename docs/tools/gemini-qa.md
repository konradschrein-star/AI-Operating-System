# `gemini-qa` — video QA through the Gemini API

Transcribed from `scripts/gemini-qa.mjs --help` and the shipped script (R25; re-synced in R406
after the round-405 review changed `--out` semantics — §5.1). Evidence for every claim below:
`docs/plan/evidence/p4-gemini-errorpaths.md` (real command transcripts, 2026-08-05),
`docs/research/round-399-41e8757d.md` (API/cost facts), and
`forge-control/src/lib/gemini-qa-cli.test.ts` (the output-path behaviour, stubbed `fetch`).

## 1. What it is / when to use it

`scripts/gemini-qa.mjs` sends a video — local file or public URL, including YouTube — to the
Gemini API and gets back structured QA findings as JSON: hook strength, pacing, audio
integrity, visual integrity, and factual red flags, each with a timestamp. It is the QA
backbone Konrad wants sitting in front of the video pipeline: the JSON shape (§6 below) is
the contract a human or a later repair agent consumes, not prose a human has to parse.

Use it whenever a rendered video needs a structured, timestamped pass before it ships —
either as a standalone CLI call, or later wired into the pipeline as an automated gate.

## 2. Requirements

- Node.js >= 22 (this box runs v22.22.2).
- Zero npm dependencies — built-in `fetch` only, no SDK, no shared lib.
- The file is a standalone, executable, copy-anywhere script (`chmod +x`, shebang
  `#!/usr/bin/env node`; git records it `100755`). The key-resolution block is intentionally
  duplicated in `scripts/perplexity.mjs` rather than factored into a shared module, per
  `docs/plan/02-architecture.md` §6.1's standalone-copyable requirement — do not "fix" that.

## 3. Usage

```
gemini-qa.mjs <video-path-or-url> [--model M] [--out FILE] [--prompt-extra "..."] [--help]
```

**Argument**

| Argument | Meaning |
|---|---|
| `<video-path-or-url>` | Local video file path, or an `http(s)://` URL (YouTube supported) |

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--model M` | `gemini-omni-flash` | Gemini model to use |
| `--out FILE` | stdout only | **Also** write the QA JSON to FILE. stdout always gets it first — see §5.1 |
| `--prompt-extra "..."` | none | Extra caller context appended to the QA prompt, e.g. `"this is a 60s YouTube Short about sky photography"` |
| `--help`, `-h` | — | Print usage and exit 0 |

Flags accept either `--model M` or `--model=M` form. Unknown flags, a missing argument value,
or an empty flag value are all usage errors (exit 3).

**Examples**

```bash
# Local render, JSON to stdout
scripts/gemini-qa.mjs ./render/final.mp4

# YouTube URL, write result to a file
scripts/gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --out qa.json

# Local file, explicit model, extra context for the reviewer
scripts/gemini-qa.mjs clip.mp4 --model gemini-omni-flash --prompt-extra "60s Short, target audience: beginners"
```

Supported local video extensions: `.mp4 .mpeg .mpg .mov .avi .flv .webm .wmv .3gp .3gpp .mkv`.
A URL input (`^https?://`) is passed straight to the model as `file_data.file_uri` — no
upload step. A local file goes through the Gemini Files API (resumable upload, then polled
until `ACTIVE`) before generation.

## 4. Key setup

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
| 1 | API or processing error: invalid key, upload failure, file processing `FAILED`, poll timeout (10 min), non-2xx response, unparseable or incomplete model output. HTTP status and response body are printed verbatim. |
| 2 | Missing key: neither `GEMINI_API_KEY` nor `/opt/ai-os/.secrets/store/gemini-api-key` |
| 3 | Usage error: no argument, unknown flag, unreadable input file, unsupported extension, or an unusable `--out` target (a directory, an unwritable file, or a missing/non-directory parent). A write that fails *after* the request is also exit 3 — and the QA JSON is on stdout in full regardless (§5.1). |

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

The script requests this exact shape from Gemini via `generationConfig.responseSchema`
(structured output), then validates on return that every required top-level key is present
before printing. Field by field, as the script sends it:

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

## 7. Cost notes

- Default model: `gemini-omni-flash`.
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

## 9. Key status

As of **2026-08-05, no Gemini API key exists on this box** — neither `GEMINI_API_KEY` nor
`/opt/ai-os/.secrets/store/gemini-api-key` is present (`docs/plan/evidence/p4-gemini-errorpaths.md`
§"Reminder protocol"). A reminder was queued to unblock this:

- Reminder id **`c88f6e19-0b41-4d43-92af-48ba5eb4f476`**, due 2026-08-06 09:00 local
  (07:00Z), status `pending` as of writing.
- It names exactly what to add: env var `GEMINI_API_KEY`, or the secret-store file
  `/opt/ai-os/.secrets/store/gemini-api-key` (secret name `gemini-api-key`).

Until that key lands, every invocation of `gemini-qa.mjs` on this box exits 2 deterministically
(§8) — that is by design, not a bug: no HTTP request is ever attempted without a key.

## Open discrepancies

- **Video cost per second is unsettled (§7).** The token-derived figure (~$0.0087/sec) and the
  research doc's "≈ $0.10/sec" cannot both be right; this file budgets from the token math and
  flags the other as an unverified worst case. Settles on the first real invoice.
- **No successful run against the live API has ever been observed.** No Gemini key exists on
  this box (§9), so every success-path claim about the *vendor* — the rubric JSON the model
  actually returns, the upload/poll timings, the cost figures — is derived from the shipped
  code and published material, not from a captured round-trip. Only the error paths in §8 are
  live transcripts. What *is* exercised end to end is this script's own output handling:
  `forge-control/src/lib/gemini-qa-cli.test.ts` stubs `globalThis.fetch` through a `--import`
  preload and drives the §5.1 contract (stdout-first, the pre-flight, the >64 KiB pipe cases)
  against the real script, with no key and no spend.

Everything else matched when this file was written: `--help` output, the four exit codes, both
key locations, the frozen rubric schema (checked field by field against the script's
`responseSchema`), and the `gemini-omni-flash` default all agree with the shipped script.
