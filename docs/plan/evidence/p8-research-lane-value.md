# P8 evidence — the research lane's value: probe, re-rank ledger, keep-or-park

**Round:** 777 · **Phase 8** · **Date:** 2026-08-06 (CEST) / 2026-08-05 late (UTC — see the
clock note below)
**Subject:** rounds 775–776 — the steward's re-rank (task A, `48d381a`) and the reminder
triage (task B, `c31ac7f`)
**Working dir for every command:** `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
**Branch:** `project/4120f785` · **node** v22.22.2 · **egress IP** `65.108.6.149`
(`curl -s https://api.ipify.org`)

This round changed no code. It re-ran the probe that the re-rank rests on, reconstructed the
reminder before-state before it becomes unreadable, and answers the one question Konrad asked
for: is `gemini-qa` worth keeping if neither key ever arrives.

**Clock note.** This box runs `Europe/Berlin`; `date` says `Thu Aug  6 12:19:52 AM CEST 2026`
while `date -u` says `Wed Aug  5 10:19:52 PM UTC 2026`. Round-776's commits are stamped
`Thu Aug 6 00:14:03 2026 +0200`, the docs say "2026-08-06", and the API returns UTC. Same
moment, three renderings. Every timestamp below says which one it is.

---

## Scoreboard — read this first

| # | Item | Result |
|---|---|---|
| 1 | Probe re-run: `POST api.perplexity.ai/search` | **HTTP 401** `invalid_api_key` — matches R775/R776, no divergence |
| 2 | Probe re-run: `GET www.perplexity.ai/` | **HTTP 403** — matches R775/R776, no divergence |
| 3 | Re-rank landed in 7 files, each carrying an explicit ranking line | **Confirmed** |
| 4 | **Repo/live divergence on `researcher.md`** | **OPEN** — installed == deployed == browser-first; worktree is api-first and ahead |
| 5 | Reminder triage: 10 dismissed, 2 survive, 1 replacement posted | **Confirmed against the DB** |
| 6 | `5ffa4edb` (public noVNC) untouched | **Confirmed — still `pending`** |
| 7 | Replacement reminder within the 500-char API limit | **496 chars** |
| 8 | `gemini-qa-cli.test.ts` count | **75 tests / 12 suites, all pass** — the brief said 61; see §4.1 |
| 9 | Tree the reviewer inherits: `tsc --noEmit` + `npm test` | **clean · 466/466 pass** |

**Two things the reviewer must not skim past:**

1. **§2.3 — the divergence is live right now.** `agents/researcher.md` in this worktree says
   *api-first*; `/root/.claude/agents/researcher.md`, which is what a running researcher
   actually loads, says *browser-first*. They are not the same file and nothing in the
   reminder system currently tracks the gap (the reminder that did — `016e3833` — was
   dismissed at 20:34 UTC, one round before the triage). The obligation survives only as prose
   in `docs/plan/03-quality.md` §1.1.
2. **§3.4 — dismissed reminders are invisible through the API.** `listReminders()` filters
   `WHERE status != 'dismissed'` (`forge-control/src/db/reminders.ts:64-72`), and so does the
   `?contains=` lookup (`:100-107`). Ten rows vanished from every HTTP view at 22:06 UTC. The
   table in §3.1 was reconstructed with a read-only `SELECT` against `content_forge`; without
   it, the before-state of round 776 would be unauditable a month from now. That is the whole
   reason this section exists.

---

## 1. The probe, re-run at R777

Not copied from round 775. Run from this worktree, this host, now.

```
$ date -u
Wed Aug  5 10:14:48 PM UTC 2026
```

### 1.1 The API host

```
$ curl -s -m 12 -X POST https://api.perplexity.ai/search \
       -H 'content-type: application/json' -d '{"query":"x"}'
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}

curl exit: 0
```

Re-run with the status code made explicit, same second:

```
$ curl -s -m 12 -o /tmp/pplx_body.txt -w 'http=%{http_code}\n' \
       -X POST https://api.perplexity.ai/search \
       -H 'content-type: application/json' -d '{"query":"x"}'
http=401
curl exit: 0
$ cat /tmp/pplx_body.txt
{"error":{"message":"Invalid API key provided. Ensure your API key is correct and active.","type":"invalid_api_key","code":401}}
```

**Verdict: the host is reachable and answers us.** A 401 with a typed error body is a live
service completing a TLS handshake, parsing our JSON, and telling us precisely what is missing.
Nothing about this box blocks it. One file — `/opt/ai-os/.secrets/store/perplexity-api-key` —
turns this into a 200.

### 1.2 The consumer site

```
$ curl -s -o /dev/null -w '%{http_code}' -m 12 https://www.perplexity.ai/
403
curl exit: 0
```

**Verdict: refused at the edge.** No body, no login page, no challenge we can drive. R704 and
R776 both identified this as Cloudflare blocking the egress IP
(`docs/tools/perplexity.md` §12.1); this round only re-confirms the code.

### 1.3 Do the numbers differ from 401/403?

**No.** Both probes reproduce round 775's and round 776's results exactly: `401` from
`api.perplexity.ai`, `403` from `www.perplexity.ai`. The re-rank's factual basis is intact and
the recommendation in §4 is unaffected. Had either number moved — a 200 from `www`, or a 403
from `api` — the ranking would have to be revisited and this line would say so in bold.

### 1.4 Neither key exists

```
$ ls -1 /opt/ai-os/.secrets/store/
github-pat-konrad
github-pat-konrad.note
github-pat-shane
github-pat-shane.note
twenty-api-key
twenty-api-key.note
twenty-crm-admin
twenty-crm-shane

$ python3 -c "import os;print('GEMINI_API_KEY' in os.environ, 'PERPLEXITY_API_KEY' in os.environ)"
False False
```

No `perplexity-api-key`, no `gemini-api-key`, neither in the environment. Both tools are, as of
this timestamp, inert on their default paths.

---

## 2. The re-rank

### 2.1 What R702 decided, and why it was reasonable

R702 made the authenticated browser profile the default backend for `ask`. The stated reason
(preserved verbatim in `scripts/perplexity.mjs:12-15`): *"Konrad has no Perplexity API key and
will not buy one. Perplexity is a browser service for him."* That is a real constraint from the
principal, recorded the same day (2026-08-05 ~09:30). Nothing about the judgement was careless.

### 2.2 Why the probe inverts it

R702 ranked on **cost of the credential**. The probe ranks on **reachability**, and the two
point opposite ways:

| Path | Needs | Status from `65.108.6.149` |
|---|---|---|
| `--backend api` (R702: secondary) | a key Konrad does not want to buy | **401 — reachable.** Works the moment a key lands |
| `--backend browser` (R702: default) | nothing | **403 — blocked upstream.** Cannot complete from this box at all |

So R702 defaulted to the one path that cannot work here, and put the path that needs only a key
behind a flag. The re-rank does not overturn R702's reasoning; it prices it. With no key and no
egress change, this tool has **no working path from this host** — and that sentence is the
deliverable, not the flag flip.

### 2.3 Exactly which files round-776 task A changed

`git show 48d381a --stat` — seven files, `292 insertions(+), 99 deletions(-)`:

| File | The line that carries the ranking |
|---|---|
| `scripts/perplexity.mjs` | `// perplexity.mjs — the researcher lane's Perplexity helper. API-FIRST since R776` |
| `docs/tools/perplexity.md` | `The researcher lane's Perplexity instrument. Since **R776 it is api-first**: both \`ask\` and` |
| `docs/plan/02-architecture.md` | `**RE-RANKED at R776 (2026-08-06) — \`api\` is the default backend for BOTH \`ask\` and \`search\`;` |
| `agents/researcher.md` | `- \`scripts/perplexity.mjs\` — Perplexity, api-first since R776.` |
| `forge-control/src/lib/project-tick.ts` | `` `- scripts/perplexity.mjs — both \`ask "<question>"\` and \`search "<query>"\` default to the API backend ` `` |
| `forge-control/src/lib/perplexity-cli.test.ts` | `*   R776   — the ranking flipped back: \`api\` is the default for BOTH modes, because` |
| `forge-control/src/lib/project-tick.test.ts` | `/research-browser and gemini-qa need no key on their default path, perplexity does/` |

Two structural details worth recording, both verified in the diff:

- The R702 `--backend api` injection in the test harness's `run()` is **kept and re-marked
  sacred** (`perplexity-cli.test.ts:224-227`): *"`api` is the default again, so this injection
  is currently redundant — KEEP IT ANYWAY. It is the structural reason no spawned test can
  start Chrome."* Correct call — the guard must not depend on which way the default points.
- The exit-2 hint no longer sends the caller to the blocked path. The old text told them to
  *"drop `--backend api`"*; the new text names both key locations and states why the fallback
  is not a substitute (`scripts/perplexity.mjs`, the `KEY_ENV_NAME` hint block).

### 2.4 The divergence risk — stated explicitly

`roleFilePaths()` — defined in `forge-control/src/lib/project-tick.ts:185-186`, not in
`cc-runner.ts` — tries `AGENTS_DIR` **first**, so a running researcher loads
`/root/.claude/agents/researcher.md`, not this worktree's copy and not the repo fallback.
That file is a human `cp` (R19 struck the automated install; R308/R703 left the copy to a human
hand). Measured now:

```
$ md5sum /root/.claude/agents/researcher.md /opt/forge-ai-os/agents/researcher.md agents/researcher.md
d390a87d7d15cd0ba5f224163302a9c0  /root/.claude/agents/researcher.md      <- INSTALLED (what runs)
d390a87d7d15cd0ba5f224163302a9c0  /opt/forge-ai-os/agents/researcher.md   <- DEPLOYED
48c06a4c0893c7dbc29bfaec72f4a9e2  agents/researcher.md                    <- this worktree

$ grep -n "browser-first\|api-first" /root/.claude/agents/researcher.md
30:- `scripts/perplexity.mjs` — Perplexity, browser-first.

$ stat -c '%y %s %n' /root/.claude/agents/researcher.md agents/researcher.md
2026-08-05 22:34:41 +0200 7548 /root/.claude/agents/researcher.md
2026-08-06 00:11:03 +0200 8094 agents/researcher.md
```

Installed **equals** deployed, so this is not rot — it is the pending **deploy obligation** that
`docs/plan/03-quality.md` §1.1 defines. But until the deploy round copies the merged file over
it (or deletes it so the repo fallback resolves), **a researcher spawned right now is told
Perplexity is browser-first and that its default path needs no key** — instructions this round's
own probe proves cannot work. Merging to `main` alone does not fix it; `AGENTS_DIR` wins.

Aggravating detail: the reminder that tracked exactly this obligation —
`016e3833-4a6e-4e66-b80d-7eb5003dfe1b`, *"R703/deploy: after merging project/4120f785, the
deploy round must refresh /root/.claude/agents/researcher.md … AGENTS_DIR wins over the repo
fallback"* — was **dismissed at 2026-08-05 20:34:52 UTC**, one round before the triage and not
by it. Nothing in the reminder system now carries the obligation; only `03-quality.md` §1.1 does.
The deploy round must read that section, because nothing will remind it.

---

## 3. The reminder ledger

Sources: round-776 task B's brief (which names the eight ids and the reason each was
condemned), the live API (`curl -s http://127.0.0.1:7700/api/reminders`, read-only), and a
read-only `SELECT` against `content_forge` for the rows the API hides (§3.4).

### 3.1 Dismissed in R776 — the before-state

All ten flipped to `dismissed` between **22:06:01 and 22:06:13 UTC on 2026-08-05**
(`updated_at`, verbatim from the DB). "Due" is the time each would have hit Konrad's phone.

| id | due (UTC) | chars | what it said | why it went |
|---|---|---|---|---|
| `1d73fbde-fd5e-4396-b9dc-12926021ef3a` | 08-06 07:00 | 385 | *"Perplexity ONE-TIME LOGIN, part 1/2 — do this the moment egress changes (today perplexity.ai 403s 65.108.6.149, so the l…"* | Unactionable — the login page never loads through a 403 |
| `b84ce65d-f27f-4dd1-bf39-59ef7ad5dce5` | 08-06 07:00 | 397 | *"Perplexity ONE-TIME LOGIN, part 2/2 — then: ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149 and open http://127.0.0.1:69…"* | Same; part 2 of an impossible part 1 |
| `4c4532af-24ed-4642-a7ef-15ae291391e7` | 08-06 07:00 | 415 | *"Add PERPLEXITY_API_KEY — put the raw key in /opt/ai-os/.secrets/store/perplexity-api-key (or export the env var PERPLEXI…"* | Superseded by the replacement's PERPLEXITY line |
| `1fc35eb9-e49e-4899-b3c8-4676dab32dfa` | 08-06 07:00 | 462 | *"Perplexity browser lane (R702) is blocked BEFORE the login step: perplexity.ai returns HTTP 403 to this VPS IP 65.108.6.…"* | Superseded — same fact, now inside the decision |
| `a2224386-845a-4e27-a109-f766eb4f9104` | 08-06 07:00 | 428 | *"gemini-qa (R702) is blocked on the Gemini Pool, not on a key. /v1/analyze with ANY file returns 500 code 1100 (proved wi…"* | Superseded by the GEMINI line + the doc banner |
| `c88f6e19-0b41-4d43-92af-48ba5eb4f476` | 08-06 07:00 | 289 | *"Add the Gemini API key: env var GEMINI_API_KEY, or the secret-store file /opt/ai-os/.secrets/store/gemini-api-key…"* | Superseded — option (b) of the decision |
| `0a1176d1-975c-4f0e-ad81-5ea959038526` | 08-06 07:05 | 314 | *"Gemini Pool, part 2 (R702): VEOPARKING_JWT hardcoded at /opt/gemini-pool-api/src/pool.py:10 EXPIRED 2026-06-26…"* | Superseded — option (a) of the decision |
| `cacf9d2b-5f35-411c-a925-db5a795bcb48` | 08-06 07:10 | 378 | *"Optional (R702): gemini-qa also has a billed backend. If you ever want it, add a Google AI Studio key at /opt/ai-os/.sec…"* | Superseded — folded into option (b) |
| `f54b5653-b37a-4800-bb99-ab6907e61037` | **08-06 04:00** | 491 | *"P6 R20 smoke — check #2a of 2, the watcher for the safe-restart TIMEOUT branch… exit 2 means the researcher smoke NEVER RAN."* | Obsolete — the branch it watched for did not fire (§3.3) |
| `4b7e6a83-9985-4a58-97cd-d885fcc19a6b` | **08-06 04:00** | 488 | *"P6 R20 smoke — check #2b of 2, RE-ARM. Run if #2a showed exit 2, or if p6-r20-researcher-smoke is missing from /api/projects."* | Obsolete — its trigger condition is false (§3.3) |

The six `07:00`–`07:10` rows are the batch that would have landed on Konrad's phone as six
separate notifications describing one situation. Their **content still stands** — nothing they
describe has been fixed; only their delivery was merged. Task B recorded that fact in
`docs/tools/gemini-qa.md` §9.1 rather than letting the table there quietly become false.

### 3.2 Survivors

| id | status | due (UTC) | why it survived |
|---|---|---|---|
| `5ffa4edb-9cb8-4a30-982c-42f2d3631eb7` | `pending` | 08-06 07:00 | **The public noVNC exposure.** `websockify` pid 2015117 serves noVNC on `0.0.0.0:6082`, iptables ACCEPTs 6082, and `http://65.108.6.149:6082/vnc.html` answers 200 from the public internet. Pre-existing, not caused by these projects, actionable by exactly one person, and a real exposure. Task B's brief said *"DO NOT DISMISS … It survives untouched."* Verified untouched: still `pending`, `created_at 2026-08-05 19:38:36 UTC`, 393 chars |
| `eff58681-bd02-4663-b447-dd7a74bda4f6` | `pending` | 08-06 05:00 | The replacement (§3.3). Created `2026-08-05 22:07:27 UTC` |

Note the replacement is due **05:00 UTC = 07:00 CEST** — the same wall-clock slot the batch it
replaces occupied.

### 3.3 The replacement reminder — full text and count

`char_length(text)` from the DB: **496** (API hard limit 500; a 400 above it). Verbatim:

```
2 decisions.
PERPLEXITY: only a key unblocks it. Verified: api.perplexity.ai=401 (up), www=403 Cloudflare, browser login impossible here. Key -> /opt/ai-os/.secrets/store/perplexity-api-key. ~$0.005-0.007/query (perplexity-api.md §6).
GEMINI VIDEO QA: (a) RECOMMEND, free: pool.py:10 JWT expired 2026-06-26, ~10min fix IF you can mint a veoparking token for user 4915785471426 — only you know. (b) gemini-api-key, billed ~$0.52/min video (gemini-qa.md §7). Pool repair is out of scope, your call.
```

Six notifications became one, and it asks for decisions rather than reporting status. Ten of the
496 characters are spent on the word `RECOMMEND` and the conditional *"IF you can mint a
veoparking token"* — the conditional is the honest part: it names the one thing only Konrad can
answer instead of pretending the fix is unconditional.

**The 04:00 watchers — decided as obsolete, on evidence, and dismissed.** Task B's brief was
explicit: *"decide with evidence… If you can PROVE the smoke ran, dismiss both and show the
proof. If you cannot, leave them alone and say why. Never dismiss on a guess."* Both were
dismissed. The proof, re-verified read-only this round:

```
$ curl -s http://127.0.0.1:7700/api/projects/899f96f3-6570-4f98-8978-f7960080f019
name p6-r20-researcher-smoke status done created 2026-08-05 17:19:34 UTC updated 2026-08-05 18:58:24 UTC
 R0 architect standard done | Plan: p6-r20-researcher-smoke
 R1 researcher junior   done | Perplexity API surface and pricing
 R2 reviewer  standard  done | Spot-check the Perplexity research
 R3 builder   done | Fix cycle 1
 R4 reviewer  done | Re-review after fix cycle 1
 R5 builder   done | Fix cycle 2
 R6 reviewer  done | Re-review after fix cycle 2

$ tail -2 /var/log/forge-safe-restart.log
[2026-08-05T19:19:14+02:00] restarted forge-executor — status=online
[2026-08-05T22:33:21+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
```

Check #2a watched for the safe-restart **timeout** branch (`exit 2` → the chained R20 POST never
fires). The 17:26 CEST invocation logged `restarted forge-executor — status=online` at
19:19:14+02:00 — it completed, so the chain ran, and the project it was supposed to create
exists and reached `done`. #2b re-arms only if #2a showed exit 2 or the project is missing;
neither holds. Both watchers were therefore watching for something that had already not
happened.

**One honest wrinkle the dismissal does not erase:** check #1b's pass criterion was *"It must
have EXACTLY TWO tasks: round 1 researcher + round 2 reviewer."* The project has **seven** — the
reviewer went NEEDS_FIXES twice and the engine spawned two fix cycles. What the smoke proves is
that the researcher role resolves, runs, and gets reviewed end-to-end; it does **not** prove the
two-task shape the brief demanded. The watchers were about whether the smoke *ran*, and it ran,
so dismissing them is right — but nobody should read this ledger as saying the smoke passed
clean.

(Also visible in that log: a safe-restart is in flight right now — `pgrep -fa safe-restart` →
`2514836 bash /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45`, launched 22:33 CEST.
That is the R704-era deploy waiting for fleet idle, not this round's doing. Recorded so the next
reader does not mistake it for a stuck process.)

### 3.4 Why this table had to be written down

```
$ curl -s http://127.0.0.1:7700/api/reminders   # count: 73 — 71 delivered, 2 pending
0a1176d1-975c-4f0e-ad81-5ea959038526 -> NOT IN LIST
cacf9d2b-5f35-411c-a925-db5a795bcb48 -> NOT IN LIST
eff58681-bd02-4663-b447-dd7a74bda4f6 -> ('pending', '2026-08-06 05:00:00+00', None)
5ffa4edb-9cb8-4a30-982c-42f2d3631eb7 -> ('pending', '2026-08-06 07:00:00+00', None)

$ curl -s 'http://127.0.0.1:7700/api/reminders?contains=VEOPARKING'
{"count":0, "filter":{"contains":"VEOPARKING","limit":50,"order":"created_at DESC","truncated":false}}
```

Both HTTP views filter dismissed rows out — `listReminders()` at
`forge-control/src/db/reminders.ts:66-68` (`WHERE status != 'dismissed'`) and
`findRemindersByText()` at `:102-104` (same clause). A dismissed reminder is not archived from
the operator's point of view; it is gone. The rows above were recovered with a read-only
`SELECT … FROM reminders WHERE status='dismissed'` against `content_forge`. **That is why §3.1
exists**: an auditor a month from now has the API and this file, and only this file carries the
before-state.

---

## 4. The assessment — keep or park `gemini-qa`?

### 4.1 What is actually on the books

Measured this round, not quoted from the brief:

```
$ wc -l scripts/gemini-qa.mjs docs/tools/gemini-qa.md forge-control/src/lib/gemini-qa-cli.test.ts
  1411 scripts/gemini-qa.mjs
   712 docs/tools/gemini-qa.md
  1061 forge-control/src/lib/gemini-qa-cli.test.ts

$ npx tsx --test src/lib/gemini-qa-cli.test.ts
# tests 75
# suites 12
# pass 75
# fail 0
```

**Correction to the brief: 75 tests, not 61.** Twelve suites, all passing. The brief's figure is
stale — 3,184 lines and 75 tests is a larger asset than the number it quoted, which pushes
mildly toward keeping. Against that: `--backend pool` returns `HTTP 500 Unknown API error code:
1100` for a 1.3 MB `video/mp4` **and** for a 40-byte `text/plain` alike (`gemini-qa.md` §1.2,
measured 2026-08-05 19:00–20:44 CEST), and `--backend api` has no credential (§1.4 above). The
tool has never analyzed a single video.

### 4.2 The argument

**Cost of keeping.** Three thousand lines of corpus that describe a capability the system does
not have. The real risk is not disk — it is that the tool reads as *shipped*: a later video
project could plan its QA gate around `gemini-qa`, wire it into a pipeline, and discover at
integration time that no backend answers. Round-776 task B priced that risk down hard by putting
the ⚠ banner directly under the H1 — *"`gemini-qa` cannot analyze a video. Both backends are
down."* — so the misread now requires ignoring the first paragraph rather than merely failing to
reach §1.2. A secondary cost is subtler: the pool's opaque `1100` means we cannot prove the
credential is the *only* fault, so even "refresh the JWT" is a hypothesis, not a fix, and the
doc says so.

**Cost of parking.** The wiring is the cheap part — argument parsing, file upload, exit codes,
`--out` semantics. What is expensive is the frozen rubric (`RUBRIC_SCHEMA`, `gemini-qa.mjs:170-
173`, a declared contract in `02-architecture.md` §6.2) and the 75 tests that pin the error
paths: wrong key, unreachable pool, unparseable free-text reply, missing rubric key, large
payload on a closed pipe. That body of work encodes decisions — what "hook quality" means as a
field, that there is deliberately **no** automatic fallback between backends, that a sourceless
or shapeless reply fails loudly instead of degrading. Rebuilding it costs a full round; the same
round would be re-litigating design questions already settled and reviewed. Parking also does
not actually reclaim anything: the files stay in git either way, so "parking" means moving a
banner-marked doc into a `parked/` folder — deleting nothing, saving nothing, and losing the
one thing a future round would want most, which is a working, tested harness to point at a
freshly-authenticated backend.

**The asymmetry that decides it.** Unblocking is ~10 minutes and free *if* a veoparking token
can be minted for user `4915785471426`; rebuilding is a round and re-argued design. The two
outcomes are not symmetric, and the cheap side is the one that keeps the asset. The banner is
what makes keeping safe: an inert tool that says so in its first line is a documented gap, and a
documented gap is worth more than a deleted one, because it tells the next round exactly which
credential to chase.

### 4.3 Recommendation

**Keep `gemini-qa` exactly as it stands — banner and all — and treat "a backend that returns a
real rubric for a real video" as a hard precondition on any future video-pipeline work that
names it, rather than parking or deleting a tested, frozen-contract harness whose only missing
piece is a credential.**

This round decided nothing, deleted nothing, and did not touch task B's banner. The keep-or-park
call is Konrad's; the recommendation above is the deliverable he asked for.

---

## 5. Verification — the tree the reviewer inherits

No code changed this round. Proving the branch is green anyway, so a failure in R778 cannot be
attributed to R777.

```
$ cd forge-control && npx tsc --noEmit
(no output)
TSC_EXIT=0

$ cd forge-control && npm test
> tsx --test src/lib/*.test.ts
1..104
# tests 466
# suites 87
# pass 466
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5816.349759
```

**466/466 pass, 87 suites, zero failures. `tsc --noEmit` clean.**

Working tree before the commit of this file:

```
$ git status --porcelain
?? docs/plan/evidence/p8-research-lane-value.md
```

One new file. Nothing else in this worktree changed. No reminders posted, none dismissed, no
writes to any live service — every command in this document is a read (`curl` GET, `SELECT`,
`git show`, `md5sum`, `stat`, `wc`, the two probes), and `/opt/forge-ai-os` was read but never
written.

---

## 6. What the next round owes

1. **The deploy round must refresh `/root/.claude/agents/researcher.md`** from the merged
   `agents/researcher.md`, or delete it so the repo fallback resolves. Nothing in the reminder
   system tracks this any more (§2.3); `docs/plan/03-quality.md` §1.1 is the only surviving
   record.
2. **`5ffa4edb` — the public noVNC on `0.0.0.0:6082` — is still pending and still open.** It is
   not this project's bug, and it is the single genuine security item on the board.
3. **`eff58681` lands at 07:00 CEST with two decisions.** Perplexity needs a key or nothing
   works; Gemini QA needs either a fresh veoparking token or a billed key. Until one of them
   arrives, both research-lane instruments are documented, tested, and inert.
