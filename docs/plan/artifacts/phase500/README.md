# Phase 500 (right panel v3) — artifacts

Rounds 501–503 built the Team panel; **round 504 is the evidence round**. Every
number below was produced by a script in this directory, against a build of
this worktree, and every script can be re-run by a reviewer from §2.

Round 504 changed **no application code**. `git status` at the end of the round
touches `docs/plan/artifacts/phase500/` and nothing else — the gate output in
`gates-504.txt` proves it. What the protocols found and could not fix is in
[§6 Findings](#6-findings-round-504); the reviewer decides what happens to them.

Two things in this file are deliberately loud, because they are the places a
reader could be misled:

- **`team-frozen.cjs` visits two chats, not one**, and one of them is reached
  by injecting a rail row. Why, and what stays real, is [§3.1](#31-frozen-time-truth-u16--pass).
- **The `armed` screenshot fakes one capability flag.** It has to; the armed
  state is unreachable today, for a reason nobody had written down. [§3.4](#34-screenshots-captureteamcjs--pass-88-cases)
  and [§6.1](#61-the-fourth-defence-nobody-claimed--and-a-comment-it-falsifies).

---

## 1. What each file is

### Protocols (round 501b wrote four; round 504 revised two and added two)

| File | Protocol | Verdict | Proves |
|---|---|---|---|
| `team-frozen.cjs` → `team-frozen.json` | U16, 14 §"Frozen-time truth" | **PASS** | settled rows are byte-identical at t and t+12s and carry `data-frozen="true"`; a row that is running right now ticks and carries `data-frozen="false"` |
| `team-hover.cjs` → `team-hover-after.json` | NFU2, 14 §"Hover non-regression" | **PASS** | 75 pointer crossings over 20 team rows cost **0** react commits and **0** DOM mutations, with byte-identical row geometry hovered vs not |
| `team-network.cjs` → `team-network-after.json` | NFU3, 14 §"Poll budget" | **PASS** | `/agents` and `/projects/board` are gone from the chat surface; `/chat/:id/team` is 12.0/min; total 40.0/min against a 52.0 baseline; **0** team requests while collapsed |
| `capture-team.cjs` → `capture-team.json` + 16 PNGs | both-theme evidence | **PASS** 8/8 | eight panel states × dark and light, every one against a real chat |
| `control-inert.cjs` → `control-inert.json` | 14 §500 RED-TEAM (destructive controls) | **PASS** | six attacks on stop/✕ of a RUNNING row under **real** all-false capabilities: nothing leaves the page, the confirm step never arms |
| `dismiss-persist.cjs` → `dismiss-persist.json` | 14 §500 (dismissal persistence) | **PASS** | one click dismisses a settled row with no write, it survives a full reload, and the restore affordance brings it back |

### Supporting

| File | Data | Shows |
|---|---|---|
| `gates-504.txt` | **real** | every universal gate command and its verbatim output, including the token-purity resolution |
| `fixtures-504.txt` | **real** | every fixture chat curled against `:7798` before use, plus the 404/400 error cases and the live capabilities response |
| `rail-hover-round504.json` | **real** | phase 400's own `hover-cost.cjs` re-run against THIS build — the rail did not regress while phase 500 added a panel |
| `phase500-{ready,ambiguous,unlinked,empty,error,hover,live,armed}-{dark,light}.png` | see §3.4 | the panel in every state, both themes |

Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules`
and chromium resolved from `/root/.cache/ms-playwright` — the `resolveChromium`
copied verbatim from `scripts/checks/frozen-dom.cjs:30-58`, in every script. It
is not, and must not become, a dependency of either repo (NFU8); `gates-504.txt`
greps both `package.json`s to prove it.

---

## 2. Reproducing

Both traps from `docs/plan/artifacts/phase1/REPRODUCE.md` still apply: the proxy
target is baked at **build** time, and `/desktop` is behind GitHub OAuth so a
session cookie has to be minted.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7798. NEVER boot forge-control/src/index.ts (double cron +
#    stolen Telegram poll), never touch pm2. Skip if it is already up:
curl -s 127.0.0.1:7798/api/health || \
  (cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# B) build the web app AGAINST the harness, into an ISOLATED copy. :7789 and
#    :7788 are served from forge-control-web/.next by another round's live
#    `next start`; rebuilding that directory in place would corrupt their run.
rm -rf /tmp/phase500-web && mkdir -p /tmp/phase500-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase500-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase500-web/node_modules
cd /tmp/phase500-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the session cookie — from inside the copy
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase500 round504 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 240 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-phase500.txt && rm mint-cookie.mjs

# D) serve the copy on :7787. AUTH_URL must match the port, and AUTH_SECRET must
#    be in the SERVER's env, not just the minting subshell (MissingSecret
#    otherwise). If :7787 is taken by the time you run this, move to 7786/7785 —
#    never kill another round's process.
AUTH_URL=http://127.0.0.1:7787 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7787 &

# E) run every script from the WORKTREE (not the /tmp copy) against that server
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase500.txt)"
export TEAM_BASE_URL=http://127.0.0.1:7787

node docs/plan/artifacts/phase500/team-frozen.cjs
TEAM_HOVER_LABEL=after node docs/plan/artifacts/phase500/team-hover.cjs
TEAM_WATCH_LABEL=after node docs/plan/artifacts/phase500/team-network.cjs
node docs/plan/artifacts/phase500/capture-team.cjs
node docs/plan/artifacts/phase500/control-inert.cjs
node docs/plan/artifacts/phase500/dismiss-persist.cjs
HOVER_URL=http://127.0.0.1:7787 HOVER_LABEL=phase500-round504 \
  node docs/plan/artifacts/phase400/hover-cost.cjs     # the rail, for comparison

# F) gates LAST — the plain build re-bakes :7700 into forge-control-web/.next,
#    so ALL browser evidence must be captured before this point.
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
bash scripts/checks/dollar-sweep.sh
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts)
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-team-confirm.ts)
grep -rnE '#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(' forge-control-web/app/desktop/team/
git diff --name-only 08106cb..HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|FileExplorerPanel|VaultFileList|routes/files'
```

**Three protocols need a run in flight** (`team-frozen` part B, `capture-team`'s
`live`/`armed` cases, all of `control-inert`). None of them hardcodes a run id:
each asks `GET /api/agents` for whatever is running at that moment and refuses
with a named error if the fleet is idle. They start nothing and change nothing.

---

## 3. Results

### 3.1 Frozen-time truth (U16) — **PASS**

`team-frozen.json`, gap 12 000 ms.

| | part A — settled | part B — live |
|---|---|---|
| chat / run | `11dd264b…` via a real rail click | run `e5cc35d7…`, running at capture time |
| rows sampled | 20 (manager + 11 workers + 8 sub-agents) | 1 |
| settled rows byte-identical at t and t+12s | **20 / 20** | — |
| every settled working cell `data-frozen="true"` at both samples | **yes** | — |
| running rows that changed | 0 present | **1 / 1** — `8m 29s` → `8m 40s` |
| running working cell `data-frozen="false"` | — | **yes** |
| verdict | PASS | PASS |

**Why two chats, and what is real.** Round 501b wrote this as one sweep and
reported `SKIPPED-NO-RUNNING`. Round 504 ran it and hit exactly that, and the
cause is structural rather than a bad fixture pick:

- the panel's rows are `GET /api/chat/:id/team` = the chat's own run plus every
  run carrying `metadata.project_id = <the chat's project>`;
- a chat only *has* a project when `projects.metadata.origin_chat_id` names it
  or the bounded thread scan recovers one (`chat-linkage.ts`);
- the only runs alive in this database at any moment are project workers, and
  the two projects that own today's live runs (`8ea0cc08…`, `4120f785…`) carry
  **no `origin_chat_id` and no scan-recoverable link at all**.

So no single chat here can show a settled tree *and* a live row. The brief's
instruction — "start nothing and change nothing" — rules out spawning a run, and
writing an `origin_chat_id` into the production `projects` table is exactly the
production write phase 400 round 403 declined to make. Both halves are therefore
proven against real data instead of one of them being faked:

- **Part A** opens the fixture chat through the rail, the way a person does.
- **Part B** points the panel at a run that is running right now. The rail lists
  conversations only — `listRuns` drops rows carrying `metadata.project_id`
  (`forge-control/src/db/runs.ts:132`) — so a project worker can never be
  clicked there. One row is spliced into the `GET /api/proxy/chat` **list**
  response as navigation. `/chat/:id/team` is not intercepted: the tree, the
  working time, the token counts and the status are all the real server's
  answer. The JSON records this as `navigation: "injected-rail-row"`.

If the fleet is idle the script returns `NO-LIVE-RUN` and exits non-zero. A
missing half is never reported as a pass.

### 3.2 Hover non-regression (NFU2) — **PASS**

`team-hover-after.json`, `rail-hover-round504.json`. Both windows are 10 s: the
pointer parked far away, then swept across the rows; the reported cost is
`hover − idle`, because the app polls on its own.

| surface | build | rows | crossings | react commits attributable to hover | DOM mutations | layout shift |
|---|---|---|---|---|---|---|
| chat rail (phase 400 "before") | `/opt/forge-ai-os` main | 7 | 76 | **77** | **1057** | — |
| chat rail (phase 400 "after") | phase-400 worktree | 7 | 76 | **1** | **0** | none |
| chat rail (re-run on THIS build) | round-504 worktree | 7 | 74 | **0** | **0** | — |
| **team panel (phase 500)** | round-504 worktree | **20** | **75** | **0** | **0** | **none** |

Idle and hover windows were identical in both team-panel counters (2 commits, 0
mutations each) — the 2 commits are the panel's own 5 s poll landing inside a
10 s window, present with or without a pointer.

The team panel has no "before" of its own to subtract: it is new in phase 500,
and the thing it replaced in that slot (`LiveProjectsBody`, retired in round
503) exposed none of the `[data-team-row]` selectors this protocol measures.
The number above is therefore an **absolute** measurement, not a delta — 75
crossings, zero commits. The mechanism behind it is checkable by grep rather
than by trust: there is no pointer handler and no hover state anywhere in
`app/desktop/team/`, and the controls are revealed by the `.team-row:hover`
opacity rule in `app/globals.css`. The geometry assertion is the other half:
every row's `getBoundingClientRect()` is byte-identical hovered and not
(`geom_before` / `geom_during` in the JSON), because `.team-row-controls` is a
fixed-width slot that is always mounted.

### 3.3 Poll budget (NFU3) — **PASS**

`team-network-after.json` — one file holding **both** captures: 75 s with the
panel visible, then 75 s with it collapsed, same page, same session. Baseline is
`phase400/managers-network-after.json` (52.0 req/min, SSE aborted), and this run
aborts SSE the same way so the comparison is like-for-like.

| endpoint | baseline /min | panel visible /min | collapsed /min | delta vs baseline |
|---|---|---|---|---|
| `/agents` | 14.40 | **0.00** | 0.00 | **−14.40** |
| `/projects/board` | 9.60 | **0.00** | 0.00 | **−9.60** |
| `/chat/:id/team` | 0.00 | **12.00** | **0.00** | +12.00 |
| `/chat/:id` | 20.00 | 20.00 | 20.00 | 0.00 |
| `/chat` | 8.00 | 8.00 | 7.20 | 0.00 |
| `/usage/quota` | 0.00 | 0.00 | 0.80 | — |
| **total** | **52.00** | **40.00** | **28.00** | **−12.00** |

Every required outcome met: `/agents` and `/projects/board` gone from the chat
surface, `/chat/:id/team` at 12.0/min (cap 12 — one poll per 5 s, exactly the
`TEAM_POLL_MS` the panel declares), total 40.0 ≤ 52, and
`team_requests_while_collapsed: 0`. The collapsed window's `/usage/quota` hit is
the status bar's own minute timer, unrelated to the panel.

The panel is gated twice over, which is why collapsing takes it to zero: the
`ChatTeamPanel` mount is conditional on `!collapsed && tab === "team"`, and the
query's `enabled` reads the same fact.

### 3.4 Screenshots (`capture-team.cjs`) — **PASS** (8/8 cases)

Sixteen PNGs, each case shot dark and light in the same page state with only
`document.documentElement.dataset.theme` flipped (`app/tokens.ts:101-109`).
Every shot is of a real chat rendered by the app; the `data` column names
exactly what, if anything, is not the server's own answer.

| case | chat / run | data | shows |
|---|---|---|---|
| `ready` | `c0de0304…` (metadata link) | **real** | a clean linked tree: manager + 2 architect workers, `data-team-state="ready"` |
| `ambiguous` | `11dd264b…` (thread_scan, ambiguous) | **real** | both linkage markers — `linked heuristically` and `linkage ambiguous` — over the full 20-row org chart: `session` vs `sub-agent` badges, roles, models, settled rows showing `—` for time (U15) and the manager keeping `2h 37m` |
| `unlinked` | `bfd1283a…` | **real** | `no project linked to this chat`, manager row still rendered |
| `empty` | `c0de0304…` | **synthetic** (browser-side fulfilled `/team`) | `no agents yet` — no chat in live data is "linked project, zero workers" (same finding phase 400 §3 made for `0/0 tasks`) |
| `error` | `c0de0304…` → rewritten to the nonsense uuid | **real 404** | `team unavailable — 404 Not Found on /chat/:id/team`, and no stale tree beside it (NFU6) |
| `hover` | `c0de0304…` | **real** | `⏸` and `✕` revealed on the hovered row, no other row moved |
| `live` | run `e5cc35d7…` | **real** `/team`, injected rail-row navigation | a row that is running: filled dot, `session` badge, `builder`, `opus-5`, a ticking time |
| `armed` | run `e5cc35d7…` | **real** row and numbers, **synthetic capabilities** | the confirm step: `✕` → `sure?` in `dangerAction` tokens |

The `live` and `armed` shots carry the note `no project linked to this chat`
under the row, and that is correct: the panel is pointed at a worker run, and a
worker run owns no project of its own, so the tree below the manager is empty
(`data-team-state="unlinked"`). The row itself is the subject of those two
captures.

**The `armed` case is the one that fakes something, and it must.** See §6.1: with
today's all-false capabilities the armed state cannot be reached through the UI
at all. The case intercepts `GET /api/proxy/capabilities` and answers
`terminate: true` — the single flag `engine-v2-research-lane` will flip — and
photographs the confirm step as it will look that day. The row, the run and
every number in the shot are real. `control-inert.cjs`, which asserts the gate
holds, fakes nothing.

### 3.5 Destructive-control inertness (RED-TEAM) — **PASS**

`control-inert.json`. Capabilities are the **real** `GET /api/capabilities`
response, asserted all-false before any attack runs; the script aborts if the
server ever answers otherwise. The only client-side rewrite is the rail-row
injection described in §3.1.

First, the affordance (NFU6 — disabled with a reason, never hidden, never a
silent no-op). On the running row: `⏸` and `✕` both `disabled`, both rendered
with non-zero width, `cursor: not-allowed`, and both titles reading
`engine support pending (control plane contract: stop|terminate)`.

Then six windows, each 4 s of network capture:

| # | attack | clicks that reached the DOM | `data-confirm` after | non-GET requests | requests outside the poll set |
|---|---|---|---|---|---|
| 1 | baseline (no clicking) | 0 | idle | 0 | 0 |
| 2 | click `[data-team-stop]` (force) | 0 | idle | 0 | 0 |
| 3 | click `[data-team-x]` (force) | 0 | idle | 0 | 0 |
| 4 | strip `disabled`, then click stop | 1 | idle | 0 | 0 |
| 5 | strip `disabled`, click X, click again 40 ms later | 2 | idle | 0 | 0 |
| 6 | `element.click()` twice from page script | 2 | idle | 0 | 0 |

"Zero requests leave the page" is asserted as a **whitelist of GET paths** (the
panel's documented polls: `/chat`, `/chat/:id`, `/chat/:id/team`,
`/chat/:id/linkage`, `/chat/:id/events`, `/capabilities`, `/usage/quota`,
`/agents`, `/health`) plus **zero non-GET requests of any kind**. A literal
"zero requests" gate is not available to a polling panel, and a blacklist of
scary words would pass a terminate implemented as `POST /api/x`. The `raw`
array in the JSON lists every request in every window for eyeballing.

Attacks 2 and 3 show `dom_clicks: 0` — the browser does not dispatch click
events to a disabled button at all. Attacks 4–6 show clicks that genuinely
landed (`defaultPrevented: false`, seen by a capture-phase listener) with the
machine still idle. That is §6.1.

### 3.6 Dismissal persistence — **PASS**

`dismiss-persist.json`, chat `11dd264b…`, no interception at all in this script.

| step | result |
|---|---|
| a settled row's `✕` is enabled (a dismissal is reversible, so never capability-gated) | ok |
| one click dismisses — rows 20 → 19, target gone | ok |
| the dismissal issues **0** non-GET requests (local today; server-backed in round 1600) | ok |
| `[data-team-restore]` appears reading `1 hidden · show` | ok |
| `localStorage["forge.teamDismissed"]` = `{"11dd264b…":["toolu_01S2khB7D19HjSMJzgjGQGMH"]}` | ok |
| **after a full page reload**: 19 rows, target still hidden | ok |
| the affordance is still there after the reload | ok |
| clicking it restores — rows 19 → 20, same node id | ok |
| the affordance disappears once nothing is hidden | ok |

The script clears the storage key before it starts (so a previous run cannot
make it pass) and again at the end (so it leaves the profile as it found it).

---

## 4. Universal gates

Verbatim output in `gates-504.txt`.

| gate | result |
|---|---|
| `npx tsc --noEmit` in `forge-control` | clean |
| `npx tsc --noEmit` in `forge-control-web` | clean |
| `NODE_ENV=production pnpm build` in `forge-control-web` | green (and re-bakes the `:7700` proxy target — run it last) |
| `bash scripts/checks/dollar-sweep.sh` | `PASS — every primary-gate hit is on the allowlist` |
| `scripts/checks/check-team-rows.ts` | `ALL PASS — team row model` |
| `scripts/checks/check-team-confirm.ts` | `ALL PASS — team confirm machine` (80 combinations swept, 0 terminates issued) |
| token purity over `app/desktop/team/` | **empty** — the panel defines no colour of any notation |
| token purity over `app/globals.css` | 2 hits, both pre-existing — see §6.2 |
| forbidden-file grep over `08106cb..HEAD` | **empty** |
| Playwright in either `package.json` (NFU8) | **empty** |

---

## 5. Deviations from the round-504 brief

Eight, each with its reason.

**1. Port 7787, and an isolated build directory.** `:7789` and `:7788` are held
by another round's live `next start` (pids 1882827 / 1882801) and `:7799` by a
phase-300 probe (pid 1497281). Killing another round's process to free a port is
not worth the risk, so this round used `:7787`, with `AUTH_URL` moved to match —
which is all the minted cookie cares about. The build also goes into
`/tmp/phase500-web` rather than `forge-control-web/.next`, because those two
servers are *serving from* that directory and rebuilding it under them would
corrupt their session. Same pattern round 501b established.

**2. The brief's fixture descriptions are stale; `fixtures-504.txt` is what is
true today.** The brief names `bfd1283a…` as "backfilled origin_chat_id, owns
THIS project (many workers)". Curled today it answers `project: null`,
`workers: []` — one manager row. Nothing in this worktree re-ran a backfill; the
description reflects an intent that phase 400 round 403 checked and deliberately
did not perform (`phase400/linkage-dryrun.txt`: zero scan candidates in that
chat). It is used here as the **unlinked** fixture. `11dd264b…` is described as
"7 sub-agents"; it has **8** sub-agent rows under 11 workers, 20 rows in total,
which is why it is also the hover fixture (NFU2 needs ≥ 20).

**3. `team-frozen.cjs` was rewritten into two parts, one of which injects a rail
row.** Full argument in §3.1. The alternative — writing `origin_chat_id` into the
production `projects` table so a chat would resolve to a project with a live
worker — is a production database write from a build task, and it is exactly the
write phase 400 declined to make.

**4. `capture-team.cjs`'s `armed` case fakes the terminate capability.** The
method `ChatTeamPanel.tsx`'s own header prescribes (strip `disabled`, click)
does not work, for the reason in §6.1. The alternative was to ship no `armed`
screenshot at all. The fake is one boolean, named in `capture-team.json`.

**5. An eighth capture case, `live`, was added.** The brief lists seven. A
running row is the single most load-bearing thing this panel renders (frozen
time only means something next to a clock that moves), and nothing in the
original seven photographs one.

**6. `team-network.cjs` writes both windows into one JSON, not two files.** The
brief asks for "both JSON captures". `team-network-after.json` carries
`panel_visible` and `panel_collapsed` as separate summaries with separate raw
request logs, captured in the same page and the same session — which is what
makes the comparison meaningful. Splitting them into two files would have meant
two page loads and two different sets of poll phases.

**7. `rail-hover-round504.json` lives in this directory, not phase 400's.** It is
phase 400's script re-run against this build, so its output would naturally land
next to `hover-cost-after.json`; round 504's scope is `phase500/*` only, so it
was moved here.

**8. No panel fix was made.** The scope allows a small one if a protocol exposed
a real defect. §6.1 is a defect in a *comment*, not in behaviour — the panel is
safer than its documentation claims — and §6.2 predates this project. Changing
shipped code to fix a comment during an evidence round would have meant
re-running every gate to buy nothing, so both are left for the reviewer.

---

## 6. Findings (round 504)

### 6.1 The fourth defence nobody claimed — and a comment it falsifies

`team/confirm.ts` documents three defences on the destructive path: the decision
function, a redundant guard clause in the component, and the absence of any
fetch. There is a fourth, and it is the one that actually stops attacks 4–6:

> **react-dom does not dispatch mouse events to a form element whose *props* say
> `disabled`, whatever the DOM attribute currently says.**

Stripping the attribute sets `button.disabled` to `false`, and the browser then
delivers a real click — a capture-phase listener sees it, `defaultPrevented` is
`false` — and React's `onClick` still never runs. Measured, not asserted:
`control-inert.json` attacks 4–6 report `dom_click_observed: 1–2` beside
`confirm_state: "idle"` and zero requests.

The consequence is a **factually wrong comment in shipped code**.
`ChatTeamPanel.tsx:39-50` tells round 504 to reach the armed screenshot by
stripping `disabled` in the page and clicking a running row's X, and says "the
second click is what dead-ends in the guard". Neither click ever reaches the
handler, so the first click cannot arm and the guard is never the thing that
stops it. With all-false capabilities the armed state is **unreachable through
the UI**. The panel is stricter than documented, not looser — but a reviewer
following that comment will conclude the panel is broken.

Suggested repair (a comment edit in `ChatTeamPanel.tsx` and one added sentence
in `confirm.ts`), left to the reviewer because an evidence round may not change
application code.

### 6.2 Two hardcoded colours in `globals.css`, from the initial commit

The token-purity grep over `app/globals.css` returns two hits — `background:
#000` and `color: #ededee` on the `html, body` rule. `git blame` dates both to
`c7e488d4` (2026-06-21), the initial commit; phase 500's addition to that file
is the opacity-only `.team-row` block, and
`git diff 08106cb..HEAD -- app/globals.css` adds **zero** colours. In practice
the app shell paints over the body in both themes (the light captures are white,
not black), so this is latent rather than visible. It belongs with phase 400
§5's list of pre-existing hardcoded colours in `DesktopApp.tsx` /
`MobileApp.tsx`, for whoever schedules that sweep.

### 6.3 The database currently has no chat that shows a live team

Not a defect, but the fact that shaped this round's evidence, and it will shape
round 505's too. `projects.metadata.origin_chat_id` is only written by the
create path (phase 300f) and by the bounded thread-scan backfill; both of the
projects with runs in flight today were created before that and are not
scan-recoverable. Until a project is started from a chat through the current
create path, the Team panel's live-tree behaviour can only be observed the way
§3.1 observes it. A single project created via `POST /api/projects` with an
`origin_chat_id` would give every future round a one-chat fixture that shows a
manager, live workers, sub-agents and settled history at once.

---

## 7. Rounds 501b–503 — what came before

Round 501b wrote the four original scripts and proved them against a build with
no Team panel: each failed with a clean one-line diagnostic and a non-zero exit
rather than a stack trace or a silent pass. That transcript, and the browser-hang
bug it caught (`browser.close()` only on the success path — now in a `finally`
in every script), are worth keeping in mind when reading a green run: these
scripts are known to fail loudly when the thing they measure is absent.

Round 501a built the data layer, 502 the panel, 503 mounted it in the chat
SidePanel and retired `LiveProjectsBody`.
