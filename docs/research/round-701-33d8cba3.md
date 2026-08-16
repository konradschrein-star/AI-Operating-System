# R701 — Gemini Pool recon: can it actually carry video QA?

**Round:** 701 · engine-v2-research-lane
**Researcher run date:** 2026-08-05 (all probes 18:33–18:47 CEST / 16:33–16:47 UTC)
**Target:** `/opt/gemini-pool-api/` — private FastAPI wrapper around the Gemini **web UI**, internal `http://127.0.0.1:8090`, public `https://hub.schreinercontentsystems.com/gemini/`
**Method:** source read of the running container's code (`docker exec`, read-only), 13 live HTTP requests against the internal endpoint, 1 against the public route, plus primary vendor docs. No writes anywhere except `/tmp` (all test artefacts deleted afterwards). No `systemctl restart`, no `/v1/pool/retire`, no `/v1/pool/warm`, no edit to `/opt/gemini-pool-api`. `git -C /opt/forge-ai-os status --short` verified empty at the end of the run.

---

## 0. Headline — the planner's premise is wrong

> "The Gemini Pool ALREADY EXISTS and is healthy — do NOT rebuild it."

**It exists. It is not healthy, and `/health` cannot tell you that.** The pool cannot currently generate *any* content — not video, not an image, not a one-word text prompt. Every generation request fails after ~88–95 s with HTTP 500. Meanwhile `GET /health` reports `sessions_ready: 4` and `GET /v1/status` reports `errors: 0` on every session, because neither surface observes generation outcomes.

This is not a video-specific finding. I proved it with a control: a **40-byte plain-text file** through `/v1/analyze` fails identically to a real 60-second 1080p render. So the honest answer to "can `/v1/analyze` carry video QA?" is: **the question cannot be answered against this service until it is re-authenticated**, and the *reason* it is broken is precisely diagnosed below.

Uptime at probe time was 648 154 s ≈ **7.5 days**, and `total_requests` (which counts only successful generations, `session_pool.py:173`) was **0**. Nothing has successfully used this service in 7.5 days.

---

## 1. What `/v1/analyze` actually does with `file` (source-verified)

Handler: `/opt/gemini-pool-api/src/api.py:78–105`.

```python
 78	@app.post("/v1/analyze", response_model=ChatResponse)
 79	async def analyze(
 80	    prompt: str = Form(...),
 81	    file: UploadFile = File(...),
 82	    x_api_key: str = Header(...),
 83	):
 84	    _auth(x_api_key)
...
 92	    suffix   = "." + (file.filename or "upload").rsplit(".", 1)[-1]
 93	    tmp_path = None
 94	    try:
 95	        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
 96	            tmp.write(await file.read())
 97	            tmp_path = tmp.name
 98	        resp = await _run(s, s.client.generate_content(prompt, files=[tmp_path]), rid)
 99	        return {"text": resp.text, "account": s.email}
```

Chain, end to end:

1. **No upload widget, no browser.** `s.client` is a `gemini_webapi.GeminiClient` (`src/session_pool.py:4,126`) — a reverse-engineered HTTP client for `gemini.google.com`, not Playwright. There is no Chrome in the loop.
2. **Whole body into RAM, then a temp file.** `await file.read()` buffers the entire upload in memory before writing `/tmp/tmpXXXX<suffix>` (`api.py:95–97`). The temp file is `os.unlink`ed in a `finally` (`api.py:100–105`).
3. **MIME type comes from the filename extension and nothing else.** `gemini_webapi/utils/upload_file.py:76`:
   `content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"`
   Because `api.py:92` preserves the client-supplied extension into the temp file's suffix, a file named `x.mp4` becomes `video/mp4`. **There is no content sniffing and no allowlist anywhere** — not in the wrapper, not in the library. Send `hello.txt` renamed to `hello.mp4` and Google is told it is `video/mp4`.
4. **Upload target:** `POST https://content-push.googleapis.com/upload` with header `X-Tenant-Id: bard-storage` and `Push-ID`, as a `CurlMime` part named `file` (`upload_file.py:78–98`, endpoint at `gemini_webapi/constants.py:34`, header at `constants.py:88`). Returns an opaque identifier string.
5. **Then generation:** the identifier is paired with the original filename (`client.py:611–614`) and passed to `_generate`, which streams `StreamGenerate` on `gemini.google.com` (`constants.py:33`).
6. **Model:** `Model.UNSPECIFIED` — the wrapper never selects a model (`api.py:98` passes no `model=`), so whatever the account's web-UI default is, that is what answers. `constants.py:98–115` shows the selectable set (`gemini-3-pro`, `gemini-3-flash`, `gemini-3-flash-thinking`, `gemini-3-pro-plus`, `gemini-3-flash-plus`) — none of it reachable through `/v1/analyze` as written.
7. **Response:** `{"text": resp.text, "account": s.email}` where `resp.text` is `candidates[chosen].text` (`types/modeloutput.py`), HTML-unescaped (`types/candidate.py:53–62`) and stripped of `googleusercontent.com/<kind>/<n>` artefact URLs (`client.py:1422`, regex at `constants.py:11`). **Free text. No structure, no `thoughts`, no candidate list — the wrapper discards everything except `text`.**

**Upload happens exactly once per request.** `generate_content` uploads at `client.py:600–614` and *then* enters `self._generate(...)` at `client.py:627`; the retry decorator sits on `_generate` (`client.py:762`), not on the upload. A failing request does **not** re-upload the file 6 times. (This matters for bandwidth budgeting and I checked it specifically.)

### Does it accept a video? Empirically: the upload leg does; generation never got far enough to prove analysis.

**Probe A** — a real pipeline render (first 12.07 s of `/opt/content-forge/media/tutorial/231f0032-ae74-4a34-a632-d42bbafc6474/final.mp4`, stream-copied with `ffmpeg -c copy`, 1920×1080 h264 + 48 kHz aac, 1 297 548 bytes):

```
curl -X POST http://127.0.0.1:8090/v1/analyze \
  -H "x-api-key: $K" \
  -F 'prompt=Describe this video: what is on screen, and what is said in the audio narration. Quote the first sentence of the narration verbatim.' \
  -F 'file=@/tmp/qa-real-12s.mp4;type=video/mp4'
```

Verbatim response body:

```json
{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}
```

`HTTP 500`, `total=86.564556s`, `size_upload=1297985`. Started 2026-08-05T18:38:39+02:00, ended 18:40:06+02:00.

The error is raised at `client.py:958–961` — i.e. Google's `StreamGenerate` *answered* and the answer carried a fatal error code in the response frame. That means the `content-push` upload leg completed without raising (`upload_file.py:103` `response.raise_for_status()` did not fire) — **a `video/mp4` body is accepted by Google's upload endpoint** — and the failure is downstream, at generation.

**Probe B (the control that settles it)** — a 40-byte `text/plain` file, same endpoint:

```
-F 'prompt=What is the secret pass phrase in this file? Answer with the phrase only.' -F 'file=@/tmp/qa-control.txt'
```

```json
{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}
```

`HTTP 500`, `total=87.986062s`. **Byte-identical failure to the video.** Video is not being singled out; the account cannot generate.

For completeness, text-only `/v1/chat` fails too, with a *different* code:

```json
{"detail":"Failed to generate contents (stream). Unknown API error code: 1096. This might be a temporary Google service issue."}
```

`HTTP 500`, `total=122.306653s`.

**Observed pattern (n=6 file requests, n=1 text request): file-bearing requests → code `1100`; text-only → code `1096`.** Neither is in `gemini_webapi` 2.0.0's `ErrorCode` enum (`constants.py:277–286` knows only 1013, 1037, 1050, 1052, 1060), hence the "Unknown API error code" wording. Google's own consumer help surface treats 1096 as a generic "something went wrong" bucket — but the only sources for that are community threads, not documentation (see Sources; treat as weak).

---

## 2. Why it is broken — exact diagnosis

### 2a. The account's cookies are dead, and the pool does not check for it

Container log during my probes (`docker logs gemini-pool-api-gemini-api-1`), verbatim:

```
2026-08-05 16:38:35.244 | WARNING  | gemini_webapi.client:start_auto_refresh:347 - AuthError: Failed to refresh cookies. The current cookies may have been invalidated by the server. Retrying in next interval.
2026-08-05 16:38:47.146 | WARNING  | gemini_webapi.client:_fetch_user_status:402 - Account status: UNAUTHENTICATED - Session is not authenticated or cookies have expired. Please check your cookies.
2026-08-05 16:38:47.662 | SUCCESS  | gemini_webapi.client:init:270 - Gemini client initialized successfully.
```

`UNAUTHENTICATED` is `AccountStatus` **1016** — `gemini_webapi/constants.py:206–209`:

> `UNAUTHENTICATED = (1016, "Session is not authenticated or cookies have expired. Please check your cookies.",)`

And here is the bug that makes `/health` lie — `src/session_pool.py:126–132`:

```python
126	                client = GeminiClient(psid, psidts, proxy=self.proxy)
127	                await client.init(timeout=30, auto_close=False)
128	                if getattr(client, "account_status", None) == TOS_PENDING:
129	                    await client.close()
130	                    continue
131	                log.info("Session ready: %s", email)
132	                return GeminiSession(client=client, email=email)
```

`TOS_PENDING` is 1040 (`session_pool.py:9`). **1016 is not checked.** An unauthenticated session is admitted to the pool, `init()` logs `SUCCESS`, `ready` returns `True` (`session_pool.py:50–57` only looks at `in_use`/cooldown/backoff), and `/health` counts it as ready. The pool has four such sessions.

`total_errors` is only incremented on the rate-limit path (`session_pool.py:178`); the retire path (`api.py:56`) never touches it. So `/v1/status` shows `errors: 0` after seven failed requests. **Both observability surfaces are structurally incapable of reporting this failure mode.**

### 2b. Credential supply chain: two expiries, both already passed

**`/v1/status` (verbatim, 2026-08-05 18:34):**

```json
{"pool_size": 5, "egress_proxy": "direct (eduVPN kernel routing)", "uptime_s": 648154,
 "total_requests": 0, "avg_response_s": null,
 "sessions": [{"email": "cdp-9400", "in_use": false, "ready": true, "cooldown_s": 0.0, "backoff_s": 0.0, "ok": 0, "errors": 0, "avg_response_s": null},
              {"email": "cdp-9400", ...}, {"email": "cdp-9400", ...}, {"email": "cdp-9400", ...}]
}
```

**All four "sessions" are the same account**, `cdp-9400`. The vault's "pool of Google accounts" is, right now, one cookie jar cloned four times — which also means the per-account cooldown/backoff logic buys no real quota parallelism, since Google sees a single account.

Why: `src/pool.py:50–58` short-circuits the whole account-assignment mechanism if a local file exists —

```python
 52	        _fp = "/data/fresh_accounts.json"
 53	        if _os.path.exists(_fp):
 54	            _fresh = [a for a in json.load(open(_fp)) if a.get("cookie") and a.get("email")]
 55	            if _fresh:
 56	                return _fresh
```

That file is bind-mounted read-only from `/opt/gemini-pool-api/fresh_accounts.json` (`docker-compose.yml`), contains **exactly one** entry (`email: "cdp-9400"`, a `__Secure-1PSID` + `__Secure-1PSIDTS` pair), and its mtime is **Jun 30 06:00** — 36 days before this run. `__Secure-1PSIDTS` rotates on the order of hours; the `start_auto_refresh` `AuthError` above is that rotation failing.

And the fallback path is dead too. `src/pool.py:8–11` hardcodes a `VEOPARKING_JWT`; `.env` does not override it. Decoding its payload locally:

```
{'userId': 3990, 'username': '4915785471426', 'plan': 'infinity', 'iat': 1779884321, 'exp': 1782476321}
iat 2026-05-27T12:18:41Z    exp 2026-06-26T12:18:41Z    now 2026-08-05T16:38:19Z
```

**The JWT expired 2026-06-26 — 40 days ago.** Konrad's own vault note already flagged the date: *"**Pool JWT expires 2026-06-26** — update in `/opt/gemini-pool-api/src/pool.py` and `/opt/veo-api/.env`."* (`Infrastructure - Content Production APIs.md:34`). Nobody did. So even if `fresh_accounts.json` were removed, `pull_account_batch()` would get 401s from `veoparking.site/nxcore/shared-pool/assign` and return `[]`.

### 2c. Egress is fine — I initially suspected it and was wrong

The vault warns that a Hetzner IP gets flagged (`Insights - Content Production API Stack.md:16–23`: *"A logged-in account on a Hetzner/AWS/Cloudflare IP will get flagged immediately… **What doesn't:** Hetzner datacenter (65.108.6.149)"*). My first check inside the container returned `65.108.6.149 / Helsinki / AS24940 Hetzner` from `ipinfo.io` — but that is misleading, because the policy routing is **prefix-scoped to Google ranges only**:

```
$ ip route get 142.251.150.2          # gemini.google.com
142.251.150.2 dev wg-htwd src 141.56.60.3 uid 0
$ ip route get 172.217.112.4          # content-push.googleapis.com
172.217.112.4 dev wg-htwd src 141.56.60.3 uid 0
$ docker exec … python3 -c "s.connect(('142.251.150.2',443)); print(s.getsockname())"
local socket addr: ('141.56.60.3', 56012)
```

`wg show wg-htwd` → peer `141.56.16.52:51820`, `latest handshake: 1 minute, 5 seconds ago`. `cat /opt/veo-proxy/egress.conf` → `MODE=university`. **Google-bound traffic exits from 141.56.60.3 (HTW Dresden), not from Hetzner.** Minor drift worth noting: the vault says the IP appears as `141.56.62.x`; it is actually `141.56.60.3`. Also note `ip rule` line `5270: from all lookup 52` points at a table that does not exist (`ip route show table 52` → *"FIB table does not exist"*); the Google prefixes live in `main`, so the rule is inert, not harmful.

Also: `"egress": "direct (eduVPN kernel routing)"` in `/health` is **a hardcoded string, not a measurement** — `session_pool.py:270`: `"egress_proxy": self.proxy or "direct (eduVPN kernel routing)"`. It says that whenever `SOCKS_PROXY` is empty, whether or not the tunnel is up. Do not trust it as a health signal.

---

## 3. Practical limits (measured + source-verified)

| Limit | Value | Evidence |
|---|---|---|
| Wrapper-side max body size | **none** | `api.py:78–97`: no size check; Starlette/FastAPI imposes no default cap. Whole body is buffered in RAM. |
| Public route max body | **200 MB**, then nginx `413` | `/etc/nginx/sites-enabled/hub.schreinercontentsystems.com:96` `client_max_body_size 200m`; proved in Probe E below. |
| Public route read timeout | **120 s**, then nginx `504` | same file, line 95: `proxy_read_timeout 120s`. **Not** empirically triggered — my requests finished at 86–95 s, just under it. Inferred from config; a genuinely *successful* video analysis would very plausibly exceed 120 s and 504 on the public URL. |
| Per-request curl timeout inside the wrapper | **30 s** read timeout | `session_pool.py:127` `await client.init(timeout=30, …)` → `client.py:241` `session.timeout = timeout` and `client.py:252` `self.timeout = timeout`. |
| Actual wall-clock ceiling on a failing request | **~88–95 s** (not 30 s) | `@running(retry=5)` on `_generate` (`client.py:762`) + `DELAY_FACTOR = 5` (`utils/decorators.py:9`) → sleeps of 5+10+15+20+25 = **75 s** across 6 attempts. 75 s backoff + 6 short attempts ≈ the 86.6/88.0/87.5/87.8 s I measured. |
| Session-acquire timeout | **exactly 60.0 s**, then `503` | `session_pool.py:14` `ACQUIRE_TIMEOUT = 60.0`; measured `60.037519s` and `60.037430s` (Probe C). |
| Per-request cooldown after success | `max(10 s, elapsed + 10 s)` | `session_pool.py:169`. Note: **failures do not cool the session** — they retire and replace it (`api.py:56`), and the replacement starts with `cooldown_until = 0`. |
| Duration ceiling | **not determinable from this service** | Nothing in the wrapper or `gemini_webapi` limits duration. The ceiling is whatever the Gemini *web app* enforces for the account: "Each video can be up to 2 GB", "Total video length can be up to 5 minutes. Upgrade to Google AI Pro or Google AI Ultra to extend total upload length to 1 hour", "Up to 10 files (subject to availability) can be uploaded in the same prompt" (Gemini Apps Help, accessed 2026-08-05). `cdp-9400` is almost certainly a free-tier pool account, so assume the **5-minute** cap, not 1 hour — *inferred from the account's provenance (veoparking AI-Test-Kitchen/Veo pool per the vault) and the help page's tiering; not stated by either.* |
| **End-to-end latency for a ~60 s video** | **UNKNOWN — cannot be measured while generation fails** | See below. |

**On the ~60 s video timing question specifically.** Probe D used a real 60.07 s 1080p render (5 550 817 bytes) and returned in `87.774972s`; Probe B used a 40-byte text file and returned in `87.986062s`. The two are within 0.3 % of each other, and both are dominated by the fixed 75 s retry backoff. What that *does* establish: **pushing 5.5 MB through the wrapper to `content-push.googleapis.com` costs no measurable time** (well under the noise floor of a couple of seconds) — *inferred from the equality of the two timings, not directly instrumented.* What it does **not** establish: how long Gemini takes to actually watch a minute of video. Round 702 must measure that after re-auth. Ignore curl's `speed_up=63245B/s` from Probe D — that is `size_upload / total_time` including the 75 s of server-side sleeping, not a transfer rate.

---

## 4. Audio track: unproven, and the QA rubric must not assume it

The brief's question — "does the web-UI path analyse AUDIO, or frames only?" — is **unanswered**. Probe A asked exactly the right question ("what is said in the audio narration… quote the first sentence verbatim", against a render whose audio is TTS narration) and got error 1100 instead of an answer.

What I can say from sources:

- The wrapper does nothing audio-specific. It hands one file to the web app and asks for text. Whether the audio track is decoded is entirely Google's behaviour, unobservable from here.
- The upstream library **does not document video or audio input at all**. `gemini_webapi` 2.0.0's own README says only: *"Gemini supports file input, including images and documents. Optionally, you can pass files as a list of paths in `str` or `pathlib.Path` to `GeminiClient.generate_content` together with a text prompt."* (README.md:177, fetched via `gh api` 2026-08-05). Its example passes a `.pdf` and a `.png`. Installed version is **2.0.0**, which is the latest upstream release (`gh api repos/HanaokaYuzu/Gemini-API/releases` → `v2.0.0`, published `2026-04-06T21:18:46Z`).
- A PR to add exactly this — **"Add support for audio/video + other file types and structured file inputs"** (#179, opened 2025-11-27) — was **closed unmerged** (`"merged": false, "merged_at": null, "state": "closed"`). Its author wrote: *"From now on, to upload any multimedia the user should explicitly specify the mime-type."* So the maintainer declined explicit multimedia MIME handling, and 2.0.0 still relies on `mimetypes.guess_type`.
- By contrast the **official** Gemini API documents audio-in-video explicitly: *"Approximately 300 tokens per second of video at default media resolution, or 100 tokens per second of video at low media resolution"* plus *"32 tokens for audio per second"*, and *"Audio is processed at 1Kbps (single channel)"* (Video understanding docs, updated 2026-07-30).

**Consequence for the rubric:** the `audio_glitches` dimension is **not yet earned on the pool path**. Round 702 must gate it behind a live probe: upload a render, ask a question answerable *only* from the audio track (ground truth is available — the tutorial job scripts are in the `content_forge` Postgres DB), and only keep the dimension if the answer matches. On the official-API path the dimension is documented and safe.

---

## 5. Can the response be coerced into strict JSON? — UNPROVEN, and here is exactly why it matters

**Probe D** deliberately demanded a fenced JSON block against a fixed rubric, with a real 60 s render:

```
curl -X POST http://127.0.0.1:8090/v1/analyze -H "x-api-key: $K" \
  -F 'prompt=You are a video QA reviewer. Return ONLY a fenced json block, no prose before or after. Schema: {"verdict":"pass|needs_work|reject","hook_score":0-10,"pacing":"string","audio_glitches":["string"],"visual_artifacts":["string"],"narration_first_sentence":"string"}' \
  -F 'file=@/tmp/qa-real-60s.mp4;type=video/mp4'
```

Verbatim, complete response body:

```json
{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}
```

`HTTP 500`, `total=87.774972s`, `size_upload=5551384`.

So the JSON question is open. But the *structural* answer is already settled by the source, and it is the bad one:

- `ChatResponse` is `{"text": str, "account": str}` (`api.py:28–30`). `text` is the web app's prose reply, HTML-unescaped and artefact-stripped (`candidate.py:53–62`, `client.py:1418–1422`). There is **no** `responseMimeType`/`responseSchema` equivalent anywhere on this path — the web UI has no structured-output parameter, and `api.py:98` doesn't even select a model.
- Therefore **`gemini-qa` on the pool path would always need a parse-and-repair pass**: strip leading chatter, find the ```` ```json ```` fence (or the first balanced `{`), tolerate trailing commentary, retry on failure. That is a design certainty from the response schema, not a guess — but *how bad* the chatter is (fence or no fence, preamble length, truncation) is unmeasured, so do not size the repair pass yet.
- Note one real truncation hazard on this path: `ARTIFACTS_RE.sub("", text)` (`client.py:1422`) deletes any `http://googleusercontent.com/<word>/<digits>` substring from the reply. Harmless for prose; it would silently corrupt a JSON string field that happened to contain such a URL.

For contrast, the official API path *does* have a first-class answer — see §8.

---

## 6. Failure shapes — the exact error contract (all measured this run)

| Case | HTTP | Body (verbatim) | Timing | Source |
|---|---|---|---|---|
| Wrong `x-api-key` | **401** | `{"detail":"Unauthorized"}` | instant | `api.py:39–41` |
| **Missing** `x-api-key` header | **422** | `{"detail":[{"type":"missing","loc":["header","x-api-key"],"msg":"Field required","input":null}]}` | instant | FastAPI `Header(...)` validation, `api.py:82` — **different shape from 401; a client that only handles `detail: string` will crash on this** |
| Generation failure, file request (video **or** non-video) | **500** | `{"detail":"Failed to generate contents (stream). Unknown API error code: 1100. This might be a temporary Google service issue."}` | 86.6 / 88.0 / 87.5 / 87.8 / 95.0 / 95.1 / 95.4 s | `api.py:57` wrapping `client.py:958–961` |
| Generation failure, text `/v1/chat` | **500** | `{"detail":"Failed to generate contents (stream). Unknown API error code: 1096. This might be a temporary Google service issue."}` | 122.3 s | same |
| No session free within 60 s | **503** | `{"detail":"All sessions cooling down — try again shortly"}` | **60.037519s / 60.037430s** | `api.py:88–90`, `session_pool.py:14` |
| Gemini 429 / quota (**not reproduced this run**) | 429 | `{"detail":"Gemini rate limit — account cooling down: <exc>"}` and 300 s backoff on that session | — | `api.py:53–55`, `session_pool.py:176–180`. Triggered when the exception text contains any of `429`, `quota`, `rate limit`, `too many request`, `resource exhausted`, `overloaded`, `recitation`, `user location is not supported` (`session_pool.py:16–20`) — note `recitation` and `user location is not supported` are misclassified as rate limits here; they are not transient. |
| Oversized body, **public** route | **413** | `<html><head><title>413 Request Entity Too Large</title></head>…<hr><center>nginx/1.24.0 (Ubuntu)</center>…` | 0.021740 s, only 65 536 bytes sent before reset | Probe E: 210 MB body via `--resolve hub.schreinercontentsystems.com:443:127.0.0.1`. **HTML, not JSON — a naive `res.json()` throws here.** |
| Oversized body, **internal** route | no limit | — | — | source-verified absence (`api.py`), not probed |

**"Non-video file" caveat, stated plainly:** my non-video probe (40-byte `.txt`) returned the same 1100 as video, so it does **not** isolate a "wrong file type" error shape — it is confounded by the account failure. There is no reason from the source to expect a distinct error: nothing validates type, so a bad type would surface as whatever Google says, i.e. another opaque 500.

**One more subtlety the builder must handle:** a genuine 30 s read timeout raises `gemini_webapi.TimeoutError`, which subclasses `GeminiError`, **not** `APIError` (`exceptions.py`). The `@running(retry=5)` decorator only retries `APIError` (`decorators.py:87`). So:
- **500 arriving in ~30 s** = real read timeout, one attempt, session **retired**.
- **500 arriving in ~88 s** = `APIError` × 6 attempts with 75 s of backoff, session retired at the end.
The latency itself is the diagnostic. Do not set a client timeout below ~100 s on this endpoint or you will abandon requests mid-retry.

---

## 7. Queue behaviour and pool starvation — clean result

**Probe C:** six concurrent tiny `/v1/analyze` requests against 4 sessions. `/v1/queue` at t=20 s, verbatim (abridged to the shape):

```json
{"active":[
  {"request_id":"d0972b0b-…","preview":"[file: qa-control.txt] probe 2","elapsed_s":20.0,"state":"processing","session":"cdp-9400","processing_s":20.0},
  {"request_id":"615f04f3-…","preview":"[file: qa-control.txt] probe 3","elapsed_s":20.0,"state":"processing","session":"cdp-9400","processing_s":20.0},
  {"request_id":"3b252847-…","preview":"[file: qa-control.txt] probe 1","elapsed_s":20.0,"state":"processing","session":"cdp-9400","processing_s":20.0},
  {"request_id":"3128ac50-…","preview":"[file: qa-control.txt] probe 4","elapsed_s":20.0,"state":"processing","session":"cdp-9400","processing_s":20.0}],
 "waiting":[
  {"request_id":"161345c8-…","preview":"[file: qa-control.txt] probe 5","elapsed_s":20.0,"state":"queued"},
  {"request_id":"7790148a-…","preview":"[file: qa-control.txt] probe 6","elapsed_s":20.0,"state":"queued"}]}
```

`/health` at the same instant: `{"sessions_total":4,"sessions_ready":0,"queue_active":4,"queue_waiting":2,…}`.

Outcomes: probes 1–4 → `500`/1100 at 87.5–95.4 s; probes 5–6 → `503` at **60.037 s** each.

Answers:
- **Yes, `/v1/queue` shows a file request while it is in flight**, with `preview` prefixed `[file: <filename>] <prompt[:100]>` (`api.py:86`), `state: "processing"`, the owning `session` email, and both `elapsed_s` (since enqueue) and `processing_s` (since acquire).
- **A single long video request does NOT starve the pool.** During Probe A, `/health` read `sessions_ready: 3` with `queue_active: 1` for the whole request — one session occupied, three free. Concurrency is capped by session count, and the wrapper degrades by queueing (up to 60 s) then `503`, never by dropping.
- **Failures do not cool sessions.** After Probe C's four 500s the pool was back to `sessions_ready: 4` within seconds, because the error path retires-and-respawns rather than cooling. Only *successes* impose the `elapsed + 10 s` cooldown. That inverts the intuitive backpressure: a broken pool spins hot.
- **Cost of a failure is a session churn.** `api.py:56` → `pool.retire(s)` closes the client, removes the session, and spawns a replacement (`session_pool.py:182–195`). Replacement currently always succeeds only because it re-reads the same (dead) cookie. Once the cookie file is fixed but the source dries up, a burst of failures will *shrink* the pool with no self-heal until the 10-minute health loop (`HEALTH_INTERVAL = 300`, `HEALTH_IDLE_SECS = 600`) calls `top_up()`.

**Pool state at end of run: `{"sessions_total":4,"sessions_ready":4,"queue_active":0,"queue_waiting":0}` — unchanged from the start. No damage.**

---

## 8. The fallback path, since the verdict below forces it: official Gemini API

`scripts/gemini-qa.mjs` **already exists in this worktree** (24 850 bytes, mtime 2026-08-05 16:32, built by an earlier round) and already targets the official API: `const API_ROOT = 'https://generativelanguage.googleapis.com'` (line 74), Files API resumable upload (`${API_ROOT}/upload/v1beta/files`, line 475), poll to `ACTIVE`, then `:generateContent` with `responseMimeType: 'application/json'` (line 591) and a frozen `RUBRIC_SCHEMA`. `scripts/perplexity.mjs` also exists (22 868 bytes). `bin/gemini-qa` does **not** exist. I did not run either — no key.

**Key status:** `GEMINI_API_KEY` is **not set** in this environment and **not present** in `/opt/ai-os/.secrets/store/` (contents: `github-pat-konrad`, `github-pat-shane`, `twenty-api-key`, `twenty-crm-admin`, `twenty-crm-shane`, plus `.note` files; parent dir also holds `forge-control.env`, `pg-backup.env`). `gemini-qa.mjs` looks for `GEMINI_API_KEY` then `/opt/ai-os/.secrets/store/gemini-api-key` (lines 75–76). **Konrad owes the system one file: `/opt/ai-os/.secrets/store/gemini-api-key` containing a Google AI Studio key.**

⚠️ **Naming collision that will bite someone.** `/opt/gemini-pool-api/.env` also defines a variable literally named `GEMINI_API_KEY` (43 chars) — but that is the **caller's bearer token for the pool's `x-api-key` header** (`api.py:7`, `api.py:39–41`), *not* a Google API key. They are unrelated secrets with the same name. Do not let one leak into the other's slot.

Vendor facts for the fallback, from primary docs (all accessed 2026-08-05):

| Fact | Value | Source |
|---|---|---|
| Accepted video MIME types | `video/mp4`, `video/mpeg`, `video/mov`, `video/avi`, `video/x-flv`, `video/mpg`, `video/webm`, `video/wmv`, `video/3gpp` | Video understanding, updated 2026-07-30 |
| Video context capacity | *"videos up to 1 hour at default resolution or 3 hours at low resolution"* (1M-context models) | ditto |
| Videos per request | max 10 (Gemini 2.5+); 1 for earlier models | ditto |
| Token cost of video | *"Approximately 300 tokens per second of video at default media resolution, or 100 tokens per second of video at low media resolution"*; frames 258 (default) / 66 (low) tokens; **+32 tokens/s for audio** | ditto |
| Audio handling | *"Audio is processed at 1Kbps (single channel)"* | ditto |
| Files API upload | `POST ${BASE_URL}/upload/v1beta/files` (resumable) | Files API, updated 2026-07-30 |
| Files API limits | *"The Files API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB."* | ditto |
| Retention | *"Files are stored for 48 hours."* | ditto |
| When Files API is mandatory | *"Always use the Files API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 100 MB."* | ditto |
| Pricing (paid tier) | Gemini 3.6 Flash `$1.50` in / `$7.50` out per 1M; 2.5 Flash `$0.30` in / `$2.50` out; 2.5 Pro `$1.25`–`$2.50` in / `$10.00`–`$15.00` out. Free tier available for 3.6 Flash and 2.5 Flash. | Pricing, updated 2026-07-30 |

**⚠️ Contradiction in Google's own docs on the structured-output field names — do not average these.**
- The **REST reference** (`ai.google.dev/api/generate-content`, GenerationConfig) gives `responseMimeType` / `responseSchema`, with the example `"generationConfig": {"response_mime_type": "application/json", "response_schema": {…}}`.
- The **guide page** (`ai.google.dev/gemini-api/docs/structured-output`, updated 2026-07-30) instead documents a `response_format` object with `type: "text"`, `mime_type: "application/json"`, `schema: {…}`, demonstrated on `gemini-3.6-flash` and `gemini-3.1-pro-preview`, and warns *"Very large or deeply nested schemas may be rejected"* and *"Not all JSON Schema features are supported"*.

I trust the **REST reference (`responseMimeType`/`responseSchema`)** for a raw-`fetch` implementation, because that is the wire contract the endpoint documents, and it is what the already-written `gemini-qa.mjs:591` uses. The `response_format` shape looks like a newer Gemini-3-era alias surfaced in the guide. **Round 702 must not pick by reading alone — send one tiny probe with each shape and keep the one that returns 200.** A wrong field name here is silently ignored by some API versions, which yields prose instead of JSON and looks like a model failure rather than a config bug.

**Also unverified and worth one probe:** `gemini-qa.mjs:70–72` hardcodes `DEFAULT_MODEL = 'gemini-omni-flash'` with a comment asserting the R399 research doc is wrong about the video-capable model. I could not verify that model ID against any page I opened this run — the pricing and video-understanding pages I read name `gemini-3.6-flash`, `gemini-3.1-pro-preview`, `gemini-2.5-flash`, `gemini-2.5-pro`. **Treat `gemini-omni-flash` as unconfirmed;** validate against `GET /v1beta/models` before trusting it.

---

## 9. Instruments named in my brief

- `scripts/perplexity.mjs` — **exists** (22 868 bytes, 2026-08-05 16:32). `PERPLEXITY_API_KEY` **not set**, and no `perplexity`-named file in `/opt/ai-os/.secrets/store/`. Not invoked this run.
- `scripts/gemini-qa.mjs` — **exists** (24 850 bytes, 2026-08-05 16:32). `GEMINI_API_KEY` **not set**, `/opt/ai-os/.secrets/store/gemini-api-key` **absent**. Not invoked this run.
- Neither was used for any finding here. All web sources came through plain `WebSearch`/`WebFetch` and `gh api` — **no browser session was needed or used for this round**, so every source below is reproducible by a plain fetch. Everything about the pool came from `docker exec` source reads and direct `curl` against `127.0.0.1:8090`.

---

## 10. VERDICT

**POOL CAN CARRY VIDEO QA: NO** — as it stands today, 2026-08-05. Not "partially": zero of 7 generation requests succeeded, including a 40-byte text file, so there is no working path of any kind, for any modality.

Precisely: **this is an expired-credential failure, not a capability refusal.** Everything structural checks out — `/v1/analyze` accepts multipart `video/mp4`, Google's `content-push` upload leg accepted a real 1080p render without error, egress correctly exits via HTW Dresden (141.56.60.3), the queue accounts for file requests properly and does not starve the pool, and the error contract is clean and predictable. What is dead is the one cookie jar the whole pool shares.

### What must be true before the pool can be reconsidered (all of it is Konrad-side, none of it is round 702's code)

1. `/opt/gemini-pool-api/fresh_accounts.json` holds cookies from **Jun 30**; `__Secure-1PSIDTS` has long since rotated and `start_auto_refresh` cannot renew it (`AuthError` in the log). Needs a fresh `__Secure-1PSID`/`__Secure-1PSIDTS` pair.
2. The `VEOPARKING_JWT` hardcoded at `src/pool.py:10` **expired 2026-06-26**. Until it is replaced, the automatic account-assignment fallback returns nothing — the vault flagged this deadline and it lapsed.
3. `session_pool.py:128` must also reject `AccountStatus.UNAUTHENTICATED` (1016), not just `TOS_PENDING` (1040), or `/health` will keep reporting 4/4 ready over four dead sessions.
4. `session_pool.py` should increment `total_errors` on the retire path too (`api.py:56`), so `/v1/status` stops reporting `errors: 0` through a total outage.

**Even after re-auth, the pool is the wrong backbone for `gemini-qa`, on three structural grounds** (all source-verified, independent of the outage): the response is unschematized free text (`api.py:28–30`) needing a repair pass; the model is unselectable (`api.py:98` never passes `model=`), so QA verdicts would silently drift with whatever the web UI defaults to; and video-input support is undocumented upstream, with the PR that would have added it closed unmerged. Keep the pool for cheap unstructured text work; do not build the QA contract on it.

### Recipe round 702 should implement

**Primary — official API, which `scripts/gemini-qa.mjs` already targets.** Keep that file's architecture (Files API resumable upload → poll to `ACTIVE` → `:generateContent` with `responseMimeType: application/json` + `responseSchema`). Three concrete corrections to make first:
- Verify `DEFAULT_MODEL` (`gemini-omni-flash`, line 72) against `GET https://generativelanguage.googleapis.com/v1beta/models` before shipping — I could not confirm that ID in any vendor page this run.
- Probe both structured-output shapes (`responseMimeType`/`responseSchema` vs `response_format`) with one throwaway request each and keep what returns 200; the docs disagree (§8).
- Prove the error path with a deliberately invalid key, as the brief requires, and queue the reminder for `/opt/ai-os/.secrets/store/gemini-api-key`.

**Secondary — the pool, only as a re-auth-gated smoke path.** The wire recipe is confirmed correct as far as the upload leg:

```bash
K=$(grep -oP '(?<=^GEMINI_API_KEY=).*' /opt/gemini-pool-api/.env)   # pool caller token, NOT a Google key
curl -sS --max-time 180 \
     -X POST http://127.0.0.1:8090/v1/analyze \
     -H "x-api-key: $K" \
     -F 'prompt=<rubric prompt demanding a fenced ```json block>' \
     -F 'file=@/path/render.mp4;type=video/mp4'
# → 200 {"text":"<free text, needs fence-extraction + repair>","account":"cdp-9400"}
```
Non-negotiables if this path is ever wired up: **internal `127.0.0.1:8090` only** — the public route caps bodies at 200 MB (nginx HTML `413`) and reads at 120 s, which a real video analysis will likely exceed; client timeout **≥ 180 s** (the wrapper's own failure ceiling is ~95 s); handle five distinct body shapes (`detail` string for 401/500/503, `detail` **array** for 422, raw **HTML** for nginx 413); filenames must carry a real `.mp4` extension because MIME is derived from the extension alone; and re-check `/v1/status` for `email` diversity — four identical emails means one account, not a pool.

**Before any of that, round 702's first pool request must be the cheapest possible liveness check** — `POST /v1/chat {"prompt":"Reply with OK"}` — and it must **abort the pool path on non-200** rather than proceeding to upload video into a dead session. That single call is what this round did not have, and its absence is why a service reporting `"status":"ok"` had served nothing for 7.5 days.

---

## Sources

**Local source files read this run (2026-08-05, read-only via `docker exec` / `cat`):**
- `/opt/gemini-pool-api/src/api.py` (174 lines) — endpoints, auth, error classification, `/v1/analyze` multipart handling
- `/opt/gemini-pool-api/src/session_pool.py` (287 lines) — pool lifecycle, cooldown/backoff, `ACQUIRE_TIMEOUT`, `init(timeout=30)`, egress label, snapshots
- `/opt/gemini-pool-api/src/pool.py` (150 lines) — account sourcing, `fresh_accounts.json` short-circuit, hardcoded `VEOPARKING_JWT`, cookie parsing
- `/opt/gemini-pool-api/{Dockerfile,docker-compose.yml,requirements.txt,.env.example}`; `/opt/gemini-pool-api/fresh_accounts.json` (structure only; single entry `cdp-9400`, mtime Jun 30 06:00)
- `gemini_webapi` **2.0.0** inside container `gemini-pool-api-gemini-api-1`: `utils/upload_file.py`, `utils/decorators.py`, `client.py` (lines 180–270, 537–660, 755–775, 915–970, 1330–1375, 1408–1432, 1625–1660), `constants.py` (lines 1–120, 194–290), `exceptions.py`, `types/modeloutput.py`, `types/candidate.py`
- `/etc/nginx/sites-enabled/hub.schreinercontentsystems.com` lines 90–96 — `/gemini/` proxy, `proxy_read_timeout 120s`, `client_max_body_size 200m`
- `systemctl status gemini-api`, `docker logs gemini-pool-api-gemini-api-1`, `wg show wg-htwd`, `/opt/veo-proxy/egress.conf`, `ip rule show`, `ip route get`
- Test media: `/opt/content-forge/media/tutorial/231f0032-ae74-4a34-a632-d42bbafc6474/final.mp4` (94.38 s, 8 674 049 B) — real pipeline render, stream-copied to 12 s / 60 s excerpts in `/tmp` (deleted after the run)
- Worktree: `scripts/gemini-qa.mjs`, `scripts/perplexity.mjs`; `/opt/ai-os/.secrets/store/` listing

**Vault notes (`/opt/obsidian-vault/90_AI_OS/`, read 2026-08-05):**
- `API - Gemini Pool.md` (`date_modified: 2026-06-01`) — endpoint catalogue and rate-limit description. **Stale in one respect:** claims `/v1/analyze` takes "File (image / video / PDF)"; video input is undocumented upstream and unproven here.
- `Infrastructure - Content Production APIs.md` — line 34: *"**Pool JWT expires 2026-06-26** — update in `/opt/gemini-pool-api/src/pool.py` and `/opt/veo-api/.env`."* Line 25 states the eduVPN IP appears as `141.56.62.x`; measured `141.56.60.3`.
- `Insights - Content Production API Stack.md` — lines 16–23 on egress-IP sensitivity; lines 55–67 on `TOS_PENDING` (1040).

**Web sources (all fetched 2026-08-05; plain `WebFetch`/`WebSearch`/`gh api` — no browser session):**
- *Video understanding | Gemini API* — https://ai.google.dev/gemini-api/docs/video-understanding — page states "Last Updated: 2026-07-30 UTC"
- *Files API | Gemini API* — https://ai.google.dev/gemini-api/docs/files — "Last Updated: July 30, 2026 UTC"
- *Structured output | Gemini API* — https://ai.google.dev/gemini-api/docs/structured-output — "Last Updated: 2026-07-30 UTC" (documents `response_format`; conflicts with the REST reference)
- *Generating content — GenerationConfig | Gemini API reference* — https://ai.google.dev/api/generate-content (documents `responseMimeType` / `responseSchema`)
- *Pricing | Gemini API* — https://ai.google.dev/gemini-api/docs/pricing — "Last Updated: 2026-07-30 UTC"
- *Upload & analyze files in Gemini Apps (Computer)* — https://support.google.com/gemini/answer/14903178?hl=en&co=GENIE.Platform%3DDesktop — no update date shown on page
- *HanaokaYuzu/Gemini-API* README (`gh api repos/HanaokaYuzu/Gemini-API/contents/README.md`, 777 lines) — file-input section, line 177
- *HanaokaYuzu/Gemini-API* releases (`gh api …/releases`) — `v2.0.0` published `2026-04-06T21:18:46Z`; prior `v1.21.0` `2026-03-06`
- *PR #179 "Add support for audio/video + other file types and structured file inputs"* — https://github.com/HanaokaYuzu/Gemini-API/pull/179 — created 2025-11-27, `"merged": false`, `"state": "closed"`
- *gemini-webapi on PyPI* — https://pypi.org/pypi/gemini-webapi/json — latest 2.0.0
- Error-code 1096 context (**community, secondary — cited only as weak corroboration that 1096 is a generic bucket**): https://support.google.com/gemini/thread/440604810/error-1076-or-1096-something-went-wrong and https://www.fdaytalk.com/gemini-error-1096/
