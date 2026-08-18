# Google AI Ultra over OAuth — what is actually true (round 1302)

Research only. No code, no tasks. All sources opened **2026-08-17**; every live probe below was run
from this box (65.108.6.149) during this run, with the raw response quoted.

---

## TL;DR for the settings builder

1. **There is no OAuth flow that turns an AI Ultra subscription into programmatic Gemini API access.**
   The one flow that ever did that for consumers — "Login with Google" into Gemini Code Assist /
   Gemini CLI — was **switched off on 2026-06-18** (Google's own words quoted in §1.3).
2. **"Gemini 4.7 Flash" does not exist.** A live `models.list` call returns 53 models; the newest Flash
   is **`gemini-3.7-flash`** (version `3.7-flash-08-2026`, 1,048,576 in / 65,536 out, `thinking: true`).
   Full raw record in §2.1. Konrad is almost certainly describing 3.7 Flash.
3. **No public endpoint exposes an Ultra subscriber's remaining quota.** The Gemini API discovery
   document (revision `20260814`) has no quota resource. The only place a remaining-credit number is
   surfaced is inside Google's own agent clients (Antigravity CLI statusline / `/usage` panel, and the
   deprecated Code Assist `loadCodeAssist` response). **Do not build a Gemini bar next to the Claude
   5h/7d bars from an invented number** — §3.4 lists what CAN be shown honestly.
4. **Two real integration paths exist, and they are different products.** (a) Gemini API with an
   API key, billed to a Cloud project — Ultra subsidises this only through a monthly Cloud credit,
   not through the subscription itself. (b) **Antigravity CLI (`agy`), headless mode**, which signs in
   with the Google account and runs *on the Ultra quota*. Recommendation in §6.
5. **The existing Google OAuth on this box cannot be extended into Gemini access** in a way that
   helps: adding `cloud-platform` to `setup.py`'s SCOPES is technically one extra consent on the same
   Desktop client (proven in §1.2), but the resulting token still bills a Cloud project and still does
   not see the Ultra subscription. One click or two is the wrong question — the answer is "neither
   click buys Ultra access". §1.5.

---

## 1. AUTH — which OAuth flow grants an AI Ultra subscriber programmatic model access

### 1.1 The Gemini API does accept OAuth, but only as an alternative to an API key on a Cloud project

> "The easiest way to authenticate to the Gemini API is to configure an API key" … OAuth is an
> alternative "if you need stricter access controls"
> — *Authentication with OAuth quickstart*, https://ai.google.dev/gemini-api/docs/oauth,
> page last updated **2026-07-01**, accessed 2026-08-17.

Scopes named on that page: `https://www.googleapis.com/auth/cloud-platform` and
`https://www.googleapis.com/auth/generative-language.retriever`. Client type required: **Desktop app**.

The discovery document confirms no per-method OAuth scope is declared for the model methods — i.e.
the API-key path is the documented default and OAuth rides the generic Cloud scope:

```
$ curl -s 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta'
HTTP 200  bytes=366326   revision: 20260814   title: Gemini API
auth.oauth2.scopes = { "https://www.googleapis.com/auth/devstorage.read_only": ... }   # only entry
models.generateContent  POST v1beta/{+model}:generateContent   SCOPES: None
models.list             GET  v1beta/models                     SCOPES: None
```
(live probe, this run, 2026-08-17)

### 1.2 Live probe — the existing box OAuth reaches the endpoint but is scope-short

The durable credential at `/root/.hermes/google_token.json` (client
`904113079984-…hri.apps.googleusercontent.com`, an *installed/Desktop* client — `setup.py` rejects a
secret file without the `installed` key, line ~243) refreshed cleanly and returned these granted
scopes: calendar, documents, drive, gmail.{readonly,send,modify}, spreadsheets, contacts.readonly.
`expires_in: 3599`.

Probing Gemini with that bearer token:

```
POST/GET https://generativelanguage.googleapis.com/v1beta/models   → HTTP 403
{"error":{"code":403,"message":"Request had insufficient authentication scopes.",
 "status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",
 "reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT",
 "metadata":{"service":"generativelanguage.googleapis.com",
 "method":"google.ai.generativelanguage.v1beta.ModelService.ListModels"}}]}}
```

Same token against the Code Assist backend used by Gemini CLI:

```
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist  → HTTP 403
… "reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT","domain":"googleapis.com",
   "metadata":{"service":"cloudcode-pa.googleapis.com",
   "method":"google.internal.cloud.code.v1internal.CloudCode.LoadCodeAssist"}
```

With no credential at all the shape is different — useful for error handling:

```
GET https://generativelanguage.googleapis.com/v1beta/models  (no key) → HTTP 403
{"error":{"code":403,"message":"Method doesn't allow unregistered callers (callers without
 established identity). Please use API Key or other form of API consumer identity to call this API.",
 "status":"PERMISSION_DENIED"}}
```

**Reading:** both services accept Bearer tokens from this client; the wall is scope, not client
registration. Adding `https://www.googleapis.com/auth/cloud-platform` to the `SCOPES` list in
`/opt/ai-os/google-setup/setup.py` would be **one re-consent on the same client** (same redirect
`http://localhost:8765`), not a second OAuth app. *(Inferred from the two 403 bodies plus the
Desktop-client requirement on the OAuth quickstart — no Google doc states this combination.)*

### 1.3 The consumer OAuth path into Gemini CLI / Code Assist is DEAD (this is the decisive fact)

> "Starting June 18, 2026, Gemini Code Assist IDE extensions stopped serving requests for the Gemini
> Code Assist for individuals, Google AI Pro, and Google AI Ultra tiers. **This also applies to usage
> of Gemini CLI. As part of the deprecation, you can no longer use the Login with Google option to
> access the IDE extensions or Gemini CLI.** … Users of Gemini Code Assist consumer accounts on both
> Gemini Code Assist IDE extensions and Gemini CLI can migrate to the Antigravity family of products."
> — *Gemini Code Assist consumer accounts*,
> https://developers.google.com/gemini-code-assist/resources/faqs, page last updated **2026-06-23**,
> accessed 2026-08-17 (verbatim from the fetched HTML).

Same page, still true for corporate licences: *"No, access to Gemini Code Assist IDE extensions and
Gemini CLI using Gemini Code Assist Standard or Enterprise subscriptions remain unchanged."*
Those are the 1,500 req/user/day (Standard) and 2,000 req/user/day (Enterprise) quotas at
https://docs.cloud.google.com/gemini/docs/quotas (last updated **2026-08-11**) — a paid Cloud SKU,
not Konrad's consumer Ultra.

So the `cloudcode-pa.googleapis.com/v1internal` machinery described in §3.2 — still present in the
gemini-cli source, still the cleanest quota API that has ever existed for this — is **not reachable
with a consumer Ultra account any more**. Building on it would be building on a switched-off door.

### 1.4 Refresh-token longevity (applies to whichever Google OAuth we do keep)

> "A Google Cloud Platform project with an OAuth consent screen configured for an external user type
> and a publishing status of 'Testing' is issued a refresh token expiring in 7 days" … "The refresh
> token has not been used for six months." … "There is currently a limit of 100 refresh tokens per
> Google Account per OAuth 2.0 client ID."
> — *Using OAuth 2.0 to Access Google APIs*, https://developers.google.com/identity/protocols/oauth2,
> last updated **2026-05-26**, accessed 2026-08-17.

The box's existing token is long-lived in practice (it refreshed today against a client created
earlier this year), so that consent screen is **not** in Testing status. If the settings UI creates a
*new* client for Gemini, it inherits the 7-day trap unless the consent screen is published — a
concrete reason to extend the existing client rather than add a second one. The page does not state a
re-consent rule for added scopes; in practice a token issued before the scope was added simply lacks
it, which is exactly the `ACCESS_TOKEN_SCOPE_INSUFFICIENT` body in §1.2.

### 1.5 Consumer vs Workspace

Not separately verified this run beyond one signal: the Code Assist tier machinery carries an
ineligibility reason code `DASHER_USER` (= Workspace-managed account) alongside `INELIGIBLE_ACCOUNT`,
`RESTRICTED_AGE`, `UNSUPPORTED_LOCATION`
(https://github.com/google-gemini/gemini-cli `packages/core/src/code_assist/types.ts`, fetched
2026-08-17), i.e. Google's own client expects managed accounts to be *rejected* from consumer tiers.
**Konrad's `konrad.schrein@gmail.com` is a consumer account, so this is moot for us** — flagged only
so nobody wires a Workspace account into the same button and expects Ultra.

---

## 2. MODELS — verified by calling `models.list`, not by reading a blog

### 2.1 The live call

Executed 2026-08-17 with the `GEMINI_API_KEY` already present in `/opt/content-forge/.env`
(read-only use, `models.list` is free):

```
GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=200   → HTTP 200
count 53, nextPageToken: none
```

Raw record for the newest Flash:

```json
{ "name": "models/gemini-3.7-flash", "version": "3.7-flash-08-2026",
  "displayName": "Gemini 3.7 Flash", "description": "Gemini 3.7 Flash",
  "inputTokenLimit": 1048576, "outputTokenLimit": 65536,
  "supportedGenerationMethods": ["generateContent","countTokens","createCachedContent",
                                 "batchGenerateContent"],
  "temperature": 1, "topP": 0.95, "topK": 64, "maxTemperature": 2, "thinking": true }
```

Selected siblings from the same response (all `1048576` in / `65536` out):
`gemini-3.6-flash` (`3.6-flash-07-2026`), `gemini-3.5-flash` (`3.5-flash-05-2026`),
`gemini-3.5-flash-lite`, `gemini-3.1-pro-preview` (`3.1-pro-preview-01-2026`),
`gemini-3.1-pro-preview-customtools`.

Full name list returned (53): gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-preview-tts,
gemini-2.5-pro-preview-tts, gemma-4-26b-a4b-it, gemma-4-31b-it, **gemini-flash-latest**,
gemini-flash-lite-latest, **gemini-pro-latest**, gemini-2.5-flash-lite, gemini-2.5-flash-image,
gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools,
gemini-3.1-flash-lite-preview, gemini-3.1-flash-lite, gemini-3-pro-image-preview, gemini-3-pro-image,
nano-banana-pro-preview, gemini-3.1-flash-image-preview, gemini-3.1-flash-image,
gemini-3.1-flash-lite-image, gemini-3.5-flash, gemini-3.5-flash-lite, **gemini-omni-flash-preview**,
gemini-3.6-flash, **gemini-3.7-flash**, lyria-3-clip-preview, lyria-3-pro-preview,
gemini-3.1-flash-tts-preview, gemini-robotics-er-1.6-preview, gemini-robotics-er-2-preview,
gemini-2.5-computer-use-preview-10-2025, **antigravity-preview-05-2026**,
deep-research-max-preview-04-2026, deep-research-preview-04-2026, deep-research-pro-preview-12-2025,
gemini-embedding-001, gemini-embedding-2-preview, gemini-embedding-2, aqa, imagen-4.0-generate-001,
imagen-4.0-ultra-generate-001, imagen-4.0-fast-generate-001, veo-3.1-generate-preview,
veo-3.1-fast-generate-preview, veo-3.1-lite-generate-preview,
gemini-2.5-flash-native-audio-latest, gemini-2.5-flash-native-audio-preview-09-2025,
gemini-2.5-flash-native-audio-preview-12-2025, gemini-3.1-flash-live-preview,
gemini-robotics-er-2-streaming-preview, gemini-3.5-live-translate-preview.

**`gemini-4.7-flash` is not in the list. No model string containing "4.7" is.**
Note also `gemini-omni-flash-preview` — the model our own `scripts/gemini-qa.mjs --backend api
--model gemini-omni-flash` names; the served id carries a `-preview` suffix.

### 2.2 What the docs say about the same models (cross-check)

- `gemini-3.7-flash` — *"Our latest and most capable Flash model, built for complex coding, agentic
  workflows, and reliable multi-step execution"*; inputs **Text, Image, Video, Audio and PDF**;
  1,048,576 input / 65,536 output; stable id `gemini-3.7-flash`; released August 2026.
  https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash (last updated **2026-08-13**).
- Model index https://ai.google.dev/gemini-api/docs/models (last updated **2026-08-14**) lists the
  same GA set and marks `gemini-3.1-pro-preview` and `gemini-3-flash-preview` as Preview.
- **VIDEO: yes.** Every Gemini 3.x Flash/Pro row lists Video as an input modality, and the API
  accepts video for `generateContent`. That covers the video-QA use case at the API layer. *Not
  verified this run:* an actual video `generateContent` call (would spend money on the content-forge
  key; out of scope for a research task).
- Strongest currently servable: **`gemini-3.1-pro-preview`** (Preview status, no free tier). There is
  no GA "3.7 Pro" in the list.

### 2.3 Access restrictions observed

None on the list call — the 53 models came back on a plain AI-Studio-style key. Preview ids can be
withdrawn without notice (Google marks them Preview precisely for that). `gemini-3.1-pro-preview` has
**no free tier** (§5.1), so a key with no billing will 429/403 on it while Flash still works.

---

## 3. USAGE / QUOTA — can we honestly draw a Gemini bar?

### 3.1 Public Gemini API: NO quota endpoint. Unambiguously.

The v1beta discovery document (revision `20260814`, fetched this run) exposes exactly these
top-level resources:

`auth_tokens, batches, cachedContents, corpora, dynamic, environments, fileSearchStores, files,
generatedFiles, media, models, tunedModels`

No `quota`, no `usage`, no `credits` resource; the three string matches for "quota" in the whole
document are the standard `quotaUser` query parameter. And the rate-limits page itself pushes the
number into a dashboard rather than an API:

> "Rate limits depend on a variety of factors (such as your usage tier) and can be viewed in Google
> AI Studio." … "Rate limits are tied to the project's usage tier."
> — https://ai.google.dev/gemini-api/docs/rate-limits, last updated **2026-08-13**, accessed 2026-08-17.

That page also **never mentions Google One / AI Pro / AI Ultra**. API tiers are Free → Tier 1 (billing
linked, $250 cap) → Tier 2 ($100 cumulative spend + 3 days, $2,000 cap) → Tier 3 ($1,000 + 30 days).
Tier is a property of the **Cloud project's spend**, not of a consumer subscription.

### 3.2 The one real credits API — and why we cannot use it

Google's own agent clients do get a remaining-credit number. In the gemini-cli source
(https://github.com/google-gemini/gemini-cli, `packages/core/src/code_assist/`, fetched 2026-08-17):

```ts
// types.ts
export type CreditType = 'CREDIT_TYPE_UNSPECIFIED' | 'GOOGLE_ONE_AI';
export interface Credits { creditType: CreditType; creditAmount: string; } // int64 as string
export interface GeminiUserTier { id?: UserTierId; name?: string; …
  /** Available AI credits for this tier (e.g., Google One AI credits) */
  availableCredits?: AvailableCredits[]; }
export interface LoadCodeAssistResponse { currentTier?; allowedTiers?; ineligibleTiers?;
  cloudaicompanionProject?; paidTier?: GeminiUserTier | null; }
export const UserTierId = { FREE:'free-tier', LEGACY:'legacy-tier', STANDARD:'standard-tier' }
// converter.ts (per-response)
consumedCredits?: Credits[];  remainingCredits?: Credits[];
// server.ts
export const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const CODE_ASSIST_API_VERSION = 'v1internal';
async refreshAvailableCredits() { … loadCodeAssist({ cloudaicompanionProject, metadata:{ideType:
  'IDE_UNSPECIFIED', platform:'PLATFORM_UNSPECIFIED', pluginType:'GEMINI', duetProject}, mode:
  'HEALTH_CHECK'}) … this.paidTier.availableCredits = res.paidTier.availableCredits; }
```

So the shape a bar would want exists: `POST /v1internal:loadCodeAssist` with `mode:"HEALTH_CHECK"`
returns `paidTier.availableCredits[] = {creditType:"GOOGLE_ONE_AI", creditAmount:"<int64 string>"}`,
and every `generateContent` response carries `remainingCredits[]`. OAuth scopes the CLI uses:
`cloud-platform`, `userinfo.email`, `userinfo.profile` (client id
`681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com`, secret embedded in
source as an installed app).

**Three reasons not to build on it:** (a) §1.3 — consumer Ultra sign-in to this surface was removed
2026-06-18; (b) it is `v1internal`, an undocumented private API with a `google3` proto reference in
the comments, i.e. no stability contract; (c) it reports **credits**, not "% of a 5-hour window".

### 3.3 Antigravity is where the Ultra number actually lives — but only in a TUI

- *"The right side of the CLI statusline displays your remaining credit count (e.g., `AI Credits: 42`)."*
  and a settings key `{"useG1Credits": true}` ("G1" = Google One, matching `GOOGLE_ONE_AI` above).
  https://antigravity.google/docs/cli/credits/ (no date shown), accessed 2026-08-17.
- `/usage` (alias `/quota`) opens a panel showing *"a breakdown of your usage limits and remaining
  requests/tokens for each supported model (e.g., Gemini 3.5 Flash, Gemini 3.1 Pro)"* and *"refreshes
  your model configuration and quota status from the backend"*.
  https://antigravity.google/docs/cli/commands/usage/ (no date shown), accessed 2026-08-17.
- Plans: Ultra = *"The highest, most generous quota, refreshed every five hours"* + *"Highest weekly
  rate limits"* + *"Access to third-party models"*; Pro = *"High, generous quota, refreshed every five
  hours until weekly limit reached"*. https://antigravity.google/docs/plans (no date shown), accessed
  2026-08-17. Corroborated by Google's own post: subscribers get *"priority access, featuring our
  highest, most generous rate limits with quotas that refresh every five hours"*
  (https://blog.google/feed/new-antigravity-rate-limits-pro-ultra-subsribers/, posted **2025-12-05**).

**The 5-hour refresh is the same cadence as Konrad's Claude 5h bar** — so the mental model transfers.
What does not transfer: the docs published **no numbers**, and the CLI docs describe **no JSON output
for `/usage`** (checked: the headless doc lists `--output-format text|json|stream-json` for prompts
only; `/usage` is a TUI panel). *Not verified: whether `agy` writes quota into a local state file we
could read.* `agy` is not installed on this box (`which agy` → nothing) and installing it is a
builder's job, not a researcher's.

### 3.4 What can be shown honestly, today

Ranked, all buildable without inventing a number:

1. **Our own meter, not Google's.** forge-control already sees every Gemini call it makes. Count
   requests and tokens *we* spent per rolling 5h / 7d window and label the bar
   "Gemini — spent (our count)" with no denominator. Truthful, zero new plumbing risk.
2. **Cost bar instead of quota bar** — if we go the API-key route, `usageMetadata` on every
   `generateContent` response gives promptTokenCount/candidatesTokenCount; multiply by the published
   prices in §5.1 and show €/day against the $100 Cloud credit (§5.2). That denominator is real.
3. **Only if a builder confirms it from a live `agy` session:** parse `agy`'s own credit number.
   Requires Konrad to sign in once on this host and someone to check for a machine-readable source.
   Do not promise this before that check.
4. **Do not** render a percentage-of-Ultra bar. No API returns that figure for a consumer
   subscription, and the docs deliberately publish no denominator.

---

## 4. RELATIONSHIP TO THE GEMINI POOL WE ALREADY RUN

Live check this run:

```
GET http://127.0.0.1:8090/health →
{"status":"ok","sessions_total":4,"sessions_ready":4,"queue_active":0,"queue_waiting":0,
 "uptime_s":1629126,"avg_response_s":46.18,"egress":"direct (eduVPN kernel routing)"}
GET http://127.0.0.1:8090/openapi.json → title "Gemini Pool API" v0.1.0
  paths: POST /v1/chat, POST /v1/analyze, GET /v1/queue, DELETE /v1/queue/{request_id},
         POST /v1/pool/retire, POST /v1/pool/warm, GET /health, GET /v1/status
GET /v1/status → 422 {"loc":["header","x-api-key"],"msg":"Field required"}   # auth’d, fine
GET /models → 404  # the pool exposes no model-selection surface
```

Uptime 1,629,126 s ≈ **18.9 days** continuous, 4/4 sessions ready, mean response **46 s**.

**Verdict: complement, and keep it as the fallback. Do not replace it.**
- It is the only surface here that costs nothing per call and needs no billing account, and it has
  been up nearly three weeks unattended.
- Its weakness is exactly where the API is strong: **46 s average response** vs a direct
  `gemini-3.7-flash` call, and no model pinning (`/models` 404 — you get whatever the web UI serves).
  Konrad's "very fast" impression of Flash will not be reproduced through the pool.
- The API path's weakness is exactly where the pool is strong: it bills.
- Concrete split: **latency-sensitive / model-pinned / structured-output work → API
  (`gemini-3.7-flash`)**; **bulk video QA and anything tolerant of ~46 s → pool** (which is what
  `scripts/gemini-qa.mjs` already defaults to). Keep the pool as the automatic fallback when the API
  key is missing or 429s — but note our own tool deliberately has *"no automatic fallback between the
  two backends"* today, and that design choice should be re-affirmed rather than quietly reversed.

---

## 5. RATE / COST SHAPE — what "20x" multiplies

### 5.1 API prices (the path that actually bills)

> `gemini-3.7-flash` — "Input price: $0.75 through December 31, 2026. $1.50 starting January 1, 2027."
> / "Output price (including thinking tokens): $3.75 through December 31, 2026. $7.50 starting
> January 1, 2027." Free tier: "Free of charge".
> `gemini-3.1-pro-preview` — input "$2.00, prompts <= 200k tokens", "$4.00, prompts > 200k tokens";
> output "$12.00, prompts <= 200k", "$18.00, prompts > 200k". Free tier: "Not available".
> — https://ai.google.dev/gemini-api/docs/pricing, last updated **2026-08-13**, accessed 2026-08-17.
> (per 1M tokens)

Note the **price doubles on 2027-01-01** for 3.7 Flash. Any cost model the settings UI shows should
carry that date.

### 5.2 What the subscription multiplies — and a contradiction worth naming

- Google One plans page: *"Mit bis zu 20-fachem Zugriff\* auf Gemini"* ("up to 20x access to
  Gemini"), plus *"Höhere Limits in AI Studio, Google Antigravity und Jules"* and
  *"40 $ monatliches Google Cloud-Guthaben im Rahmen des Google Developer Program"*.
  https://one.google.com/about/google-ai-plans/ (no date shown; served in German to this host),
  accessed 2026-08-17.
- Google's developer blog: *"This includes $10 per month in Google Cloud credits for Google AI Pro
  subscribers and $100 per month for Google AI Ultra subscribers."*
  https://blog.google/innovation-and-ai/technology/developers-tools/gdp-premium-ai-pro-ultra/,
  posted **2026-01-27**, accessed 2026-08-17.

**Contradiction: $40/month (one.google.com, undated, German locale) vs $100/month (blog.google,
2026-01-27).** I do not average them. I trust the **$100** figure more for an Ultra subscriber —
the blog states the Pro/Ultra split explicitly ($10 / $100) while the plans page shows a single
figure without saying which tier it belongs to, and the $40 could be the Pro-plus/Plus row bleeding
into the summary. **The builder must not hard-code either number**; show the credit from Konrad's
actual Cloud billing page if it is shown at all.

So "20x" is a **consumer-product multiplier** (Gemini app, AI Studio UI, Antigravity, Jules limits) —
**not an API quota multiplier**. Nothing on any page opened this run states that AI Ultra raises
`generativelanguage.googleapis.com` rate limits. The only Ultra→API bridge is the monthly Cloud
credit, which is money, not quota.

### 5.3 Practical limits an agent fleet will hit

- **API route:** the ceiling is the project's usage tier, and Tier 1 is capped at **$250** monthly
  spend (§3.1 source). At 3.7 Flash prices, $250 ≈ 333M input tokens or 66M output tokens — a fleet
  doing heavy video QA will hit the *tier cap*, not RPM, first. Tier 2 needs $100 cumulative spend
  **plus 3 days elapsed**; Tier 3 needs $1,000 **plus 30 days** — so capacity cannot be bought
  instantly, it has to be aged. Plan for that lead time before a big batch.
- **Antigravity route:** quota refreshes every 5 hours with an additional **weekly** ceiling
  (§3.3) — a fleet can exhaust a 5h window and then discover the weekly wall behind it. Overage is
  possible: Pro/Ultra can spend *"purchased AI credits"* at *"standard Gemini Enterprise Agent
  Platform consumption pricing"*, gated by an *"AI Credit Overages"* setting with *"Never"* or
  *"Always"* (https://antigravity.google/docs/plans, accessed 2026-08-17). **Default that to "Never"
  for an unattended fleet** — "Always" is an uncapped spend switch on an autonomous agent.
- **Pool route:** 4 sessions, ~46 s mean → theoretical ceiling ≈ 4 concurrent, ~5 req/min. Fine for
  batch QA, useless as an interactive backend.

---

## 6. RECOMMENDED INTEGRATION SHAPE (implementable without further research)

**Do not sell this in the settings UI as "connect your Google AI Ultra".** Nothing connects a
consumer Ultra subscription to our code over OAuth. Sell two independent switches:

**A. "Gemini API key" — ship this one. Small, documented, stable.**
- Field: a paste-in API key, stored the way every other secret here is
  (`/opt/ai-os/.secrets/store/gemini-api-key` — the path `scripts/gemini-qa.mjs` already reads).
  No OAuth, no consent screen, no 7-day refresh trap.
- Validate on save with `GET https://generativelanguage.googleapis.com/v1beta/models` +
  header `x-goog-api-key: <key>`. HTTP 200 → populate the model picker from the response
  (`models[].name`, `displayName`, `inputTokenLimit`, `supportedGenerationMethods`). Handle exactly
  two failure bodies, both captured verbatim in §1.2: `"Method doesn't allow unregistered callers"`
  (no key) and `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (wrong credential type).
- Default model **`gemini-3.7-flash`**; strongest **`gemini-3.1-pro-preview`** (mark Preview);
  keep `gemini-flash-latest` out of defaults (a floating alias will silently change behaviour).
- Video QA can use the same key with `--backend api` in `gemini-qa.mjs`; video is a supported input
  modality (§2.2).

**B. "Google account (Gmail/Calendar/Drive)" — leave exactly as it is.**
Do not add `cloud-platform` to `setup.py`'s SCOPES. It would work as one extra consent on the same
Desktop client (§1.2), but it buys nothing Ultra-related, and it widens the box's most valuable
long-lived credential to a full-Cloud-access scope. If a builder later needs Vertex AI, that is the
moment to revisit — with a separate client, so a Vertex mistake cannot cost us Gmail.

**C. The Gemini bar next to the Claude bars — ship option 1 from §3.4, labelled honestly.**
"Gemini · spent this 5h / 7d (our count)", counted from forge-control's own call log, no denominator,
no percentage. If Konrad wants a filled bar with a ceiling, the only truthful denominator available
is money: the Cloud credit from §5.2 against measured token cost from `usageMetadata` at the prices
in §5.1. **Anything else is a made-up number and should not be drawn.**

**D. Antigravity CLI — evaluate later, do not build now.** It is the only surface that runs on the
Ultra quota, it has a real headless mode (`agy -p "…" --output-format json|stream-json`,
`--model gemini-3.5-flash-medium`, `--effort high`, `--json-schema`, `--continue`,
`--print-timeout`, `agy models`, exit 0 on success — https://antigravity.google/docs/cli/headless/,
accessed 2026-08-17), and it handles SSH boxes: *"Detects SSH sessions and prints an authorization URL
to complete login locally"* (README, https://github.com/google-antigravity/antigravity-cli, fetched
2026-08-17). That makes it *installable here with one manual login from Konrad*. Two things must be
settled before anyone builds on it: whether `/usage` has a machine-readable form, and whether the ToS
— *"you agree to help improve the product by allowing Google to collect and use your Interactions
data"* (same README) — is acceptable for Konrad's code. **That is a Konrad decision, not a builder's.**

---

## 7. What I could NOT verify

- **A live `agy` run, its model list, or its quota output.** `agy` is not installed on this box and
  installing + signing in is outside a research task. All Antigravity facts above are from its docs
  and README, not from execution.
- **Whether AI Studio's UI exposes an Ultra quota figure.** Browser attempt hit a Google sign-in wall
  (§8) — reported, not worked around.
- **Any Ultra-specific numeric quota.** No page opened this run publishes one; Google states the
  refresh cadence and the relative ranking only.
- **A video `generateContent` call.** Modality support is documented and the model record confirms
  `generateContent`, but I did not spend money proving it end to end.
- **Whether adding `cloud-platform` to the existing client succeeds in practice.** That needs a real
  consent click; the 403 bodies only prove the current token lacks the scope.

---

## 8. Browser session (login wall — reported, not bypassed)

`scripts/research-browser.mjs open scratch --url https://aistudio.google.com/prompts/new_chat
--label aistudio-model-list` → **LOGIN REQUIRED**. Screenshot shows the Google "Sign in — with your
Google Account" page. The tool queued Konrad a reminder (id `c64ca519-2fa4-48da-ae5c-bdb09a3a9b1b`)
and left the session live for a manual login over loopback noVNC
(`http://127.0.0.1:6941/vnc.html?autoconnect=1&resize=scale`, reachable only through
`ssh -N -L 6941:127.0.0.1:6941 root@65.108.6.149`). No credentials were attempted.

Screenshot: `/api/uploads/a6861aec3b2a/20260817T010843Z-aistudio-model-list.png`

**Everything else in this document came from plain HTTP fetches or from `curl` probes run on this
host — reproducible without a browser.** Only §8 is browser-derived.

---

## Sources

All accessed **2026-08-17**.

| # | Title | URL | Source date |
|---|---|---|---|
| 1 | Gemini API — Authentication with OAuth | https://ai.google.dev/gemini-api/docs/oauth | updated 2026-07-01 |
| 2 | Gemini API v1beta discovery document (live fetch) | https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta | revision 20260814 |
| 3 | Gemini API `models.list` (live call, HTTP 200, 53 models) | https://generativelanguage.googleapis.com/v1beta/models?pageSize=200 | 2026-08-17 |
| 4 | Gemini API — Rate limits | https://ai.google.dev/gemini-api/docs/rate-limits | updated 2026-08-13 |
| 5 | Gemini API — Pricing | https://ai.google.dev/gemini-api/docs/pricing | updated 2026-08-13 |
| 6 | Gemini API — Models index | https://ai.google.dev/gemini-api/docs/models | updated 2026-08-14 |
| 7 | Gemini 3.7 Flash model page | https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash | updated 2026-08-13 |
| 8 | Gemini Code Assist consumer accounts (deprecation) | https://developers.google.com/gemini-code-assist/resources/faqs | updated 2026-06-23 |
| 9 | Gemini for Google Cloud — Quotas | https://docs.cloud.google.com/gemini/docs/quotas | updated 2026-08-11 |
| 10 | Using OAuth 2.0 to Access Google APIs | https://developers.google.com/identity/protocols/oauth2 | updated 2026-05-26 |
| 11 | gemini-cli source — `code_assist/{oauth2,types,server,converter}.ts` | https://github.com/google-gemini/gemini-cli | fetched 2026-08-17 (main) |
| 12 | Google One — Google AI plans | https://one.google.com/about/google-ai-plans/ | no date shown |
| 13 | Google Developer Program premium for AI Pro/Ultra | https://blog.google/innovation-and-ai/technology/developers-tools/gdp-premium-ai-pro-ultra/ | posted 2026-01-27 |
| 14 | New Antigravity rate limits for Pro/Ultra subscribers | https://blog.google/feed/new-antigravity-rate-limits-pro-ultra-subsribers/ | posted 2025-12-05 |
| 15 | Antigravity — Plans | https://antigravity.google/docs/plans | no date shown |
| 16 | Antigravity — Models | https://antigravity.google/docs/models/ | no date shown |
| 17 | Antigravity CLI — Overview | https://antigravity.google/docs/cli/overview | no date shown |
| 18 | Antigravity CLI — Headless mode | https://antigravity.google/docs/cli/headless/ | no date shown |
| 19 | Antigravity CLI — AI Credits | https://antigravity.google/docs/cli/credits/ | no date shown |
| 20 | Antigravity CLI — `/usage` command | https://antigravity.google/docs/cli/commands/usage/ | no date shown |
| 21 | Antigravity CLI repo README | https://github.com/google-antigravity/antigravity-cli | fetched 2026-08-17 |
| 22 | Gemini Pool (local) — `/health`, `/openapi.json` | http://127.0.0.1:8090 | live 2026-08-17 |
| 23 | Browser screenshot — AI Studio sign-in wall | /api/uploads/a6861aec3b2a/20260817T010843Z-aistudio-model-list.png | captured 2026-08-17 |
