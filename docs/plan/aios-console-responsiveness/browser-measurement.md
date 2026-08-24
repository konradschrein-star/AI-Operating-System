# Browser measurement — `aios-console-responsiveness`, round 4

**Every number in this file was produced by a real headless Chrome against a
real production build of a real tree, in the 90 minutes before it was written.**
Nothing here is arithmetic, and nothing here is remembered. Where an instrument
could not measure something, the row says so.

The quality document that governs this project is the repo-root
`docs/plan/03-quality.md` — **this directory holds evidence only and deliberately
contains no `03-quality.md`**, so nothing here changes which document a reviewer
should read.

---

## 0. Why this file exists

Round 3's gating review, finding 2:

> …the check's poll-budget math is disconnected from the real source constants
> (I hand-verified they currently agree, but the check can't catch future
> drift, and **no actual live/browser measurement was taken** despite the
> brief's METHOD section calling for one)

Both halves are addressed. The drift half is
`scripts/checks/check-chat-delta.ts` §5a/§5b, which now imports every poll
period from `forge-control-web/app/desktop/chat/pollBudget.ts` and pins each one
to a literal. This file is the other half.

---

## 1. The two trees, measured in the same browser

| | BEFORE | AFTER |
|---|---|---|
| tree | `main` @ `00b235c`, extracted with `git archive` to `/tmp/r4-web-before` | this branch @ round 4, `/tmp/r4-web` |
| chat client | full-thread `fetchChat` on every poll | `fetchChatDelta` (`?since=`) on every poll |
| transcript fallback poll | 3s (`ChatSurface`), 3s (`AgentChatView`) | 4s, from one shared constant |
| served on | `127.0.0.1:7811` | `127.0.0.1:7810` |
| API | the SAME worktree harness, `127.0.0.1:7812` (`scripts/checks/serve-v3-7798.ts`) | same |
| fixture chat | the same 20-row manager chat, same worker, same sub-agent | same |

Both builds talk to the **same** API process, so the only variable is the web
client. The API is the worktree's own routers on a spare port — never
`forge-control/src/index.ts`, which would boot the cron tick, the Telegram
bridge and the vault sync against live data.

---

## 2. The headline: bytes the console downloads per minute

`docs/plan/aios-console-responsiveness/depth-poll-r4.cjs`, three 60s windows in
one page session, SSE aborted (the degraded path — the expensive one this
project tuned). Bytes are **decoded response bodies**, i.e. the JSON the client
parses; the wire is smaller because the proxy gzips.

| window | BEFORE total | AFTER total | BEFORE `/chat/:id` | AFTER `/chat/:id` | cut |
|---|---|---|---|---|---|
| at rest (manager chat) | **48,288,843 B/min** | **317,535 B/min** | **48,036,978 B/min** | **65,670 B/min** | **99.86 %** |
| drilled, depth 1 (worker) | 2,443,419 B/min | 402,684 B/min | 2,190,360 B/min | 149,625 B/min | 93.2 % |
| drilled, depth 2 (sub-agent) | 2,453,488 B/min | 401,476 B/min | 2,190,360 B/min | 149,625 B/min | 93.2 % |

**48 MB per minute, downloaded and JSON-parsed on the main thread, for a chat
nobody was typing in.** That is 2.5 MB per poll at 19 polls a minute — the
KNOWN LEAD, reproduced in a browser rather than assumed. After: 65 KB/min.

Raw verdicts: `evidence/before/depth-poll-r4.json`,
`evidence/after/depth-poll-r4.json`.

### 2.1 The same measurement on the real 944-entry manager chat

Through the worktree API, read-only `GET`, chat
`2ef126b7` (the manager chat this project runs under — 944 thread entries at
measurement time):

| | uncompressed | gzipped |
|---|---|---|
| `GET /api/chat/:id` (full) | **896,477 B** | 185,559 B |
| `GET /api/chat/:id?since=944` (steady-state delta) | **11,726 B** | 4,815 B |
| cut | **98.69 %** | 97.41 % |

**An honest note on the 11.7 KB.** `PLAN.md` §0 predicted "~1.2 KB". The delta
response is ten times that, and the reason is not the thread: the `RunDetail`
envelope carries the run's `prompt`, which for this chat is 10,128 bytes of
project brief and never changes after the run is created. It rides every poll.
Removing it is a real further win (≈86 % of what is left) but it is an API
SHAPE change — the client merges `{...run, thread}`, so a delta that omitted
`prompt` would drop it from the cache — and this round's constraint is no
visible behaviour change. Recorded as the next lever, not done here.

---

## 3. Requests per minute — the committed ≤ 40 ceiling

| window | BEFORE | AFTER | ceiling |
|---|---|---|---|
| at rest | 39 | **35** | 40 |
| drilled, depth 1 | **40** | **35** | 40 |
| drilled, depth 2 | **40** | **34** | 40 |

The ceiling held before and holds after — but it held at depth 1 with **zero
requests of headroom**, and that is round 3's gap made visible: `ChatSurface`
was moved to a 4s fallback and `AgentChatView` was left on 3s, so drilling into
a worker put 5 req/min back on the surface. Both now read
`CHAT_DETAIL_FALLBACK_POLL_MS`, and the measured cost of drilling is now zero
(35 → 35 → 34; the 34 is one poll landing outside the window boundary).

### 3.1 A second, independent instrument

`docs/plan/artifacts/phase700/network-700.cjs` — a gate this project did not
write, run unmodified against the AFTER build with the 944-entry manager chat as
its fixture: **ALL PASS, 13 checks**. Its own whole-surface assertion:

```
whole-surface total, this build vs phase 500: {"phase700":35,"phase500_recorded":40,"delta":-5}
PASS  whole-surface total <= phase 500's recorded total (40/min) — same ceiling as nav-walk.cjs P3
```

It also answers the brief's third question — *any request that polls while its
panel is not visible* — with a measured **zero**:

```
zone requests while collapsed: []
zone requests on the Files tab: []
PASS  ZERO zone polls while the panel is collapsed
PASS  ZERO zone polls while the Files tab is open
```

Full verdict: `evidence/after/network-700.json`.

---

## 4. What could NOT be measured, and why

`docs/plan/artifacts/phase600/nav-walk.cjs` (gate 26) was run first and is the
natural home for the depth-1/depth-2 windows. Against this build it passes every
identity and panel-state assertion — the full log is
`evidence/after/nav-walk-r4.log` — and then dies at

```
FAIL: page.reload: Timeout 60000ms exceeded.
  - waiting for navigation until "networkidle"
```

before reaching its poll windows. That is a property of the **harness**, not of
this branch: `serve-v3-7798.ts` states in its own header that its pass-through
is buffered and "the buffered writer cannot stream SSE", so a reloaded page
holds an EventSource that never delivers and never closes, and `networkidle`
can never fire. Nothing in this round's diff touches a reload path, and the
first `goto` — same `networkidle` wait — succeeds every run.

Rather than edit a gate so it would agree with this round, the three windows
were measured by `depth-poll-r4.cjs`, out of phase 600's own shared setup
(`lib-604.cjs`: same browser, same cookie, same chat-opening idiom), and
`network-700.cjs` is recorded above as the independent second opinion.

**One instrument bug worth naming**, because it was live for a whole run: the
first version of `depth-poll-r4.cjs` measured bytes from `content-length`. Next
streams these responses chunked and sends no such header, so every window
reported `0 bytes` — and passed. A byte column that can only read 0 looks
exactly like evidence. It now reads `response.body()`, records "not measured"
separately from zero, and **asserts** that the at-rest window measured something
and that no response went unmeasured. Those three assertions are in the verdict
JSONs.

---

## 5. Reproducing

```bash
cd /opt/ai-os/workspace/projects/f248f9e3-3b40-4470-84b1-39ab518c9496
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7812 — routers only, NEVER forge-control/src/index.ts
SECRET_STORE_DIR=/tmp/r4-store SERVE_V3_PORT=7812 \
  bash -c 'cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &'

# B) build THIS tree into an isolated copy against that API
rm -rf /tmp/r4-web && mkdir -p /tmp/r4-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/r4-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/r4-web/node_modules
cd /tmp/r4-web && FORGE_CONTROL_URL=http://127.0.0.1:7812 NODE_ENV=production ./node_modules/.bin/next build

# C) mint the cookie from inside that copy. VALIDATE BY SHAPE, NOT LENGTH:
#    a JWE is 5 dot-separated base64url segments — and with alg=dir the SECOND
#    one is EMPTY by spec, so "every segment non-empty" rejects a valid token.
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node -e 'import("next-auth/jwt").then(async ({encode})=>console.log(await encode({
  token:{name:"r4 evidence",email:"check@localhost",sub:"check"},
  secret:process.env.AUTH_SECRET,salt:"authjs.session-token",maxAge:18000})))' > /tmp/r4-cookie.txt

# D) serve it. Over http the cookie is `authjs.session-token` (no __Secure- prefix)
AUTH_URL=http://127.0.0.1:7810 FORGE_CONTROL_URL=http://127.0.0.1:7812 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7810 &

# E) measure, from the worktree. Non-destructive: writes to /tmp unless told otherwise.
cd /opt/ai-os/workspace/projects/f248f9e3-3b40-4470-84b1-39ab518c9496
export FORGE_SESSION_COOKIE="$(cat /tmp/r4-cookie.txt)"
PHASE600_BASE_URL=http://127.0.0.1:7810 PHASE600_API_URL=http://127.0.0.1:7812 \
  PHASE600_OUT_DIR=/tmp/r4-depth-after \
  node docs/plan/aios-console-responsiveness/depth-poll-r4.cjs           # ~4 min

PHASE700_BASE_URL=http://127.0.0.1:7810 PHASE700_API_URL=http://127.0.0.1:7812 \
  PHASE700_CHAT="okay this is a gigantic task" \
  PHASE700_PROJECT=f248f9e3-3b40-4470-84b1-39ab518c9496 \
  PHASE700_OUT_DIR=/tmp/r4-net700 \
  node docs/plan/artifacts/phase700/network-700.cjs                      # ~4 min

# F) the BEFORE tree: same recipe, `git archive main` instead of the worktree,
#    port 7811, PHASE600_OUT_DIR=/tmp/r4-depth-before.
```

Two fixture notes a rerun will hit:

- `network-700.cjs`'s default fixture chat (`"Okay when I click the file
  section"`) **no longer exists** in the database — hence `PHASE700_CHAT` above.
- `depth-poll-r4.cjs` needs a tree containing a depth-2 sub-agent. The 944-entry
  manager chat has 11 rows and no sub-agent, so the depth walk uses phase 600's
  default fixture (20 rows) while `network-700.cjs` uses the manager chat. Each
  window says which chat it measured, in its own JSON.
