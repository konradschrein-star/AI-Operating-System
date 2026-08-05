# P4 evidence — `scripts/gemini-qa.mjs` error paths

Round 401, phase 4 task 1. Every command below was run in this worktree
(`/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`, branch
`project/4120f785`) on 2026-08-05 with node v22.22.2. Output is pasted verbatim, including
exit codes. Commands 5 and 6 are real requests against `generativelanguage.googleapis.com`
— the bodies are Google's, not fabricated.

## Design notes the reviewer will want up front

- **Default model is `gemini-omni-flash`, not `gemini-3.6-flash`.** `docs/plan/02-architecture.md`
  section 6.2 is wrong; `gemini-3.6-flash` does not accept video input, so the documented
  default would fail on the tool's primary use case. Per the task brief,
  `docs/research/round-399-41e8757d.md` finding 1 wins. The script carries a comment at the
  `DEFAULT_MODEL` constant citing that finding so the next reader knows why doc and code
  disagree. `--model` still overrides.
- **Cost figures appear nowhere in the code** — they belong to the round-402 docs task. The
  wrong "~300 tok/s" number is not repeated anywhere in this script.
- **Gate order is arguments → key → filesystem.** Key resolution runs before the input path
  is touched, so exit 2 is deterministic: a caller with no key gets the same missing-key
  message whether or not the video path exists. This also guarantees the R23 requirement
  that no HTTP request is attempted when the key is missing.
- **Unreadable input / unsupported extension are exit 3**, classed with `--out unwritable`:
  both are filesystem-and-argument problems detected before any network call, not API or
  processing errors. Documented as such in `--help`.
- **Zero dependencies, no shared lib.** Built-in `fetch` only. The ~15-line key-resolution
  block is duplicated with `scripts/perplexity.mjs` on purpose (02-architecture section 6.1,
  standalone-copyable requirement).
- **No silent fallbacks.** No retry, no alternate model, no repair loop on unparseable model
  output, no default answer. Every failure prints what happened and exits non-zero.

---

## 1. `node --check scripts/gemini-qa.mjs`

```console
$ node --check scripts/gemini-qa.mjs
exit=0
```

(No output — clean parse.)

## 2. `node scripts/gemini-qa.mjs --help; echo "exit=$?"`

```console
$ node scripts/gemini-qa.mjs --help
usage: gemini-qa.mjs <video-path-or-url> [--model M] [--out FILE] [--prompt-extra "..."] [--help]

Video quality assurance through the Gemini API. Input is either a local video file (uploaded
via the Gemini Files API, then polled until ACTIVE) or a public video URL including YouTube
(passed straight to the model, no upload). Output is the QA rubric as JSON.

arguments:
  <video-path-or-url>     local video file, or an http(s):// URL (YouTube supported)

flags:
  --model M               Gemini model to use              (default: gemini-omni-flash)
  --out FILE              write the QA JSON to FILE        (default: stdout)
  --prompt-extra "..."    extra caller context appended to the QA prompt,
                          e.g. "this is a 60s YouTube Short about sky photography"
                                                           (default: none)
  --help, -h              print this help and exit 0
  Flags accept either "--model M" or "--model=M".

api key (resolved in this order, first non-empty wins):
  1. environment variable  GEMINI_API_KEY
  2. secret-store file     /opt/ai-os/.secrets/store/gemini-api-key
  If neither is present the tool exits 2 without making any HTTP request.

supported local video extensions:
  .mp4 .mpeg .mpg .mov .avi .flv .webm .wmv .3gp .3gpp .mkv

output:
  The frozen QA rubric (02-architecture.md section 6.2), pretty-printed JSON with keys:
    verdict (pass|needs_work|reject), confidence, hook, pacing, audio, visual, factual,
    top_fixes, summary
  Every finding carries a timestamp in seconds from the start of the video.

exit codes:
  0  success — QA JSON written to stdout or --out
  1  API or processing error: invalid key, upload failure, file processing FAILED,
     poll timeout (10 min), non-2xx response, unparseable or
     incomplete model output. HTTP status and response body are printed verbatim.
  2  missing key: neither GEMINI_API_KEY nor /opt/ai-os/.secrets/store/gemini-api-key
  3  usage error: no argument, unknown flag, unreadable input file, unsupported
     extension, or an unwritable --out target

examples:
  gemini-qa.mjs ./render/final.mp4
  gemini-qa.mjs 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --out qa.json
  gemini-qa.mjs clip.mp4 --model gemini-omni-flash --prompt-extra "60s Short, target audience: beginners"
exit=0
```

This is the contract the round-402 docs task transcribes: usage line, every flag with its
default, both key locations, the default model, and all four exit codes.

## 3. `node scripts/gemini-qa.mjs; echo "exit=$?"` — usage error

```console
$ node scripts/gemini-qa.mjs
gemini-qa.mjs: missing <video-path-or-url>

usage: gemini-qa.mjs <video-path-or-url> [--model M] [--out FILE] [--prompt-extra "..."] [--help]
... (full usage block, identical to command 2, printed to stderr) ...
exit=3
```

## 4. Missing key — exit 2, no HTTP request

```console
$ env -u GEMINI_API_KEY node scripts/gemini-qa.mjs /tmp/qa-sample.mp4
gemini-qa.mjs: no Gemini API key found.
  Set the environment variable GEMINI_API_KEY, or write the key to the secret-store file /opt/ai-os/.secrets/store/gemini-api-key.
  Key name: GEMINI_API_KEY (secret-store name: gemini-api-key).
  No request was made.
exit=2
```

The message names both locations verbatim: the env var `GEMINI_API_KEY` and the file
`/opt/ai-os/.secrets/store/gemini-api-key`.

## 5. Invalid key, URL input — real Google response, exit 1 (no upload step)

```console
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
        "metadata": {
          "service": "generativelanguage.googleapis.com"
        }
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

The failing step is `generateContent`, which proves the URL path skipped the Files API
entirely and passed the YouTube URL through as `file_data.file_uri`.

## 6. Invalid key, local file input — real Files API response, exit 1 (upload path reached)

```console
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
        "metadata": {
          "service": "generativelanguage.googleapis.com"
        }
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

The failing step is `files upload (start)` — a different step than command 5. That is the
point: the local-file branch reaches the resumable-upload start call. A valid video is not
needed to prove the path.

## 6b. Extra exit-3 paths (not required by the brief, run for completeness)

```console
$ node scripts/gemini-qa.mjs /tmp/qa-sample.mp4 --bogus
gemini-qa.mjs: unknown flag: --bogus
... (usage block) ...
exit=3

$ GEMINI_API_KEY=x node scripts/gemini-qa.mjs /tmp/qa-sample.mp4 --out /nonexistent-dir/qa.json
gemini-qa.mjs: --out directory is not writable: /nonexistent-dir: ENOENT: no such file or directory, access '/nonexistent-dir'
exit=3
```

`--out` is checked before any network call, so an unwritable target never burns an API call.

## 7. Executable bit

```console
$ git ls-files -s scripts/gemini-qa.mjs
100755 95de9e304a9f97c8e27c96ed794d6ed7af1e1f9b 0	scripts/gemini-qa.mjs
```

## 8. Zero new dependencies

```console
$ git diff --name-only main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
[end]
```

Empty — no package.json, no lockfile, no node_modules touched.

## 9. forge-control untouched and still green

```console
$ cd forge-control && pnpm install --prod=false
Already up to date
Done in 717ms using pnpm v9.15.9
install exit=0

$ npx tsc --noEmit
tsc exit=0

$ pnpm test
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
# duration_ms 331.123761
test exit=0
```

143/143 tests pass, typecheck clean. This task changed nothing under `forge-control/`.

---

## Reminder protocol (R24) — key still missing, ONE reminder posted

Re-checked at build time:

```console
$ test -s /opt/ai-os/.secrets/store/gemini-api-key && echo PRESENT || echo MISSING
MISSING
$ [ -n "$GEMINI_API_KEY" ] && echo ENV_PRESENT || echo ENV_MISSING
ENV_MISSING
```

Posted exactly once (no retry loop):

```console
$ curl -sX POST http://127.0.0.1:7700/api/reminders -H 'content-type: application/json' \
    -d '{"text":"Add the Gemini API key: env var GEMINI_API_KEY, or the secret-store file /opt/ai-os/.secrets/store/gemini-api-key (secret name gemini-api-key). It unlocks scripts/gemini-qa.mjs — automated video QA (hook, pacing, audio, visual, factual red flags) as the QA backbone for the video pipeline.","when":"tomorrow 9:00"}'
{"ok":true,"reminder":{"id":"c88f6e19-0b41-4d43-92af-48ba5eb4f476", ...}}
```

Confirmed row from `GET http://127.0.0.1:7700/api/reminders`:

```json
{"id": "c88f6e19-0b41-4d43-92af-48ba5eb4f476", "text": "Add the Gemini API key: env var GEMINI_API_KEY, or the secret-store file /opt/ai-os/.secrets/store/gemini-api-key (secret name gemini-api-key). It unlocks scripts/gemini-qa.mjs — automated video QA (hook, pacing, audio, visual, factual red flags) as the QA backbone for the video pipeline.", "due_at": "2026-08-06 07:00:00.716+00", "recur": null, "status": "pending", "source": "chat", "created_at": "2026-08-05 13:57:16.717384+00", "delivered_at": null}
```

**Reminder id: `c88f6e19-0b41-4d43-92af-48ba5eb4f476`** — due 2026-08-06 09:00 local
(07:00Z), status `pending`. It names the exact key name, both locations, and what it unlocks.

The only other GEMINI-mentioning row is `d342ac3b-32b2-4b62-8d40-59fad08b61bd`, created in an
earlier round (status `delivered`, 2026-08-05 08:47Z) by a different task. This task created
one reminder and one only.

## Not done here (owned by other tasks)

- `docs/tools/gemini-qa.md` — round-402 junior task, transcribed from the `--help` output above.
- Cost model documentation (5,792 tok/s at 720p, ~$0.10/sec video; $1.50/$9.00 per 1M text) —
  same docs task.
- A live smoke run against a real video: impossible until `GEMINI_API_KEY` exists.
