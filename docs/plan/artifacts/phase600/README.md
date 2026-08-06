# Phase 600 (drill-in navigation + worker-chat legibility) — artifacts

Rounds 601A–603 built the nav stack, the readable transcript, the orientation
strip and the story-so-far digest; **round 604 is the evidence round**, the same
shape round 504 was for phase 500. Every number below was produced by a script in
this directory against a build of this worktree, and every script can be re-run
by a reviewer from [§2](#2-reproducing).

Round 604 changed **no application code**. `git status` at the end of the round
touches `docs/plan/artifacts/phase600/` and nothing else; `gates-604.txt` proves
it. What the protocols found and could not fix is in [§6](#6-findings-round-604);
the reviewer decides what happens to them.

Four things in this file are deliberately loud, because they are the places a
reader could be misled:

- **Two protocols reach their subject by injecting a team row.** No chat in this
  database has a live worker or a ≥200-entry run in its team, for a structural
  reason. What is real and what is not is [§3.0](#30-the-one-thing-that-is-not-real-injected-team-rows).
- **"A reload lands on the manager chat" is not what the app does.** It lands on
  TODAY. What actually survives a reload — nothing — is [§3.1](#31-nav-walk-navwalkcjs--pass-3838).
- **The plan-doc screenshot is an offline render**, because nothing in this round
  can push a `plandoc` frame. [§3.5](#35-both-theme-capture-capture600cjs--pass).
- **The digest calls a sub-agent "unknown" that the team panel calls "scout".**
  Same sub-agent, three surfaces, two answers. [§6.1](#61-the-same-sub-agent-is-scout-in-two-places-and-unknown-in-a-third).
  *(Fixed in round 606 — [README-606.md](README-606.md). The numbers and
  screenshots in this file are round 604's and are left exactly as measured.)*

---

## 1. What each file is

### Protocols (round 604)

| File | Protocol | Verdict | Proves |
|---|---|---|---|
| `nav-walk.cjs` → `nav-walk.json` | 14 §600 "walk the stack down and back; refresh mid-stack" + NFU3 drilled | **PASS 38/38** | manager → worker → sub-agent with the header identity checked against the API at every level; the team panel never follows the drill; a reload restores nothing and raises zero console errors; a drilled view costs no extra requests |
| `transcript-expand.cjs` → `transcript-expand.json` | U23, 14 §600 "byte-complete expand" | **PASS 18/18** | 73 tool rows over 6 tools: every collapsed line equals `summarizeTool`'s one-liner, every expanded ARGS/RESULT is sha256-identical to the API payload, and the fold conserves every entry |
| `orientation-live.cjs` → `orientation-live.json` | U22, 14 §600 "live worker" | **PASS 14/14** | a run discovered from `/api/agents` at run time, sampled twice 25 s apart, both readings matched to `metadata.current_activity` by activity timestamp |
| `digest-honesty.cjs` → `digest-honesty.json` | U24, 14 §600 "digest honesty on a 200-entry session" | **PASS 41/41** | a 327-entry session: every count re-derived from the wire by the protocol itself, every quotation proven a verbatim substring, the duration frozen and equal to `completed_at − started_at` |
| `capture-600.cjs` → `capture-600.json` + 12 PNGs | both-theme evidence | **PASS 30/30** | six surfaces × dark and light, with the painted surface colour probed per region so "both themes work" is measured, not eyeballed |

### Supporting

| File | Data | Shows |
|---|---|---|
| `lib-604.cjs` | — | the shared browser harness: `resolveChromium` (verbatim from `frozen-dom.cjs:30-58`), cookie handling, chat opening, and the team-row injection with its full justification |
| `oracle-604.ts` | — | what the **shipped** `thread-mapping.ts` / `tool-summary.ts` / `agentsApi.ts` say the screen should read. Used for rendering contracts only — never for numbers that must be independent |
| `capture-plandoc.ts` → `capture-plandoc.html` | **real component, synthetic mount** | the plan-doc shell in both palettes; see §3.5 |
| `gates-604.txt` | **real** | every universal gate command and its verbatim output |
| `team-hover-round604.json` | **real** | phase 500's `team-hover.cjs` (NFU2) re-run against THIS build |
| `rail-hover-round604.json` | **real** | phase 400's `hover-cost.cjs` re-run against THIS build |
| `team-network-round604.json` | **real** | phase 500's `team-network.cjs` (NFU3) re-run against THIS build |
| `phase600-604-{manager,worker,expanded,subagent,degraded,plandoc}-{dark,light}.png` | see §3.5 | the twelve captures |

Round-604 PNGs carry a `604-` infix on purpose: round 601B already owns
`phase600-manager-{dark,light}.png` and the first draft of `capture-600.cjs`
overwrote them. They were restored from git and the naming fixed; `git status`
shows no modification to any 601B/603 artifact.

Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules`
with chromium resolved from `/root/.cache/ms-playwright`. It is not, and must not
become, a dependency of either repo (NFU8); `gates-604.txt` greps both
`package.json`s and the `ec2c799..HEAD` diff to prove it.

---

## 2. Reproducing

Both traps from `docs/plan/artifacts/phase1/REPRODUCE.md` still apply: the proxy
target is baked at **build** time, and `/desktop` is behind GitHub OAuth so a
session cookie has to be minted. This is `phase500/README.md` §2 with the ports
moved.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7798. NEVER boot forge-control/src/index.ts (double cron +
#    stolen Telegram poll), never touch pm2. Skip if it is already up:
curl -s 127.0.0.1:7798/api/health || \
  (cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# B) build the web app AGAINST the harness, into an ISOLATED copy. :7785/7787/
#    7788/7789 are served from other rounds' live `next start`; rebuilding
#    forge-control-web/.next in place would corrupt their runs.
rm -rf /tmp/phase600-web && mkdir -p /tmp/phase600-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase600-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase600-web/node_modules
cd /tmp/phase600-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the session cookie — from inside the copy
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase600 round604 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 480 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-phase600.txt && rm mint-cookie.mjs

# D) serve the copy on :7786. AUTH_URL must match the port, and AUTH_SECRET must
#    be in the SERVER's env, not just the minting subshell (MissingSecret
#    otherwise). If :7786 is taken, move DOWN — never kill another round's
#    process. 7785/7787/7788/7789 were all held when this round ran.
AUTH_URL=http://127.0.0.1:7786 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7786 &

# E) run every protocol from the WORKTREE (not the /tmp copy) against that server
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase600.txt)"
export PHASE600_BASE_URL=http://127.0.0.1:7786   # defaults, listed for clarity
export PHASE600_API_URL=http://127.0.0.1:7798

node docs/plan/artifacts/phase600/nav-walk.cjs
node docs/plan/artifacts/phase600/transcript-expand.cjs
node docs/plan/artifacts/phase600/orientation-live.cjs     # needs a live run
node docs/plan/artifacts/phase600/digest-honesty.cjs
node docs/plan/artifacts/phase600/capture-600.cjs

# F) non-regression — phase 500's and phase 400's own scripts, this build.
#    They write beside THEMSELVES; round 604's scope is phase600/*, so each
#    output is moved here afterwards (same as round 504 did for the rail).
TEAM_BASE_URL=http://127.0.0.1:7786 TEAM_HOVER_LABEL=phase600-round604 \
  node docs/plan/artifacts/phase500/team-hover.cjs
mv docs/plan/artifacts/phase500/team-hover-phase600-round604.json \
   docs/plan/artifacts/phase600/team-hover-round604.json

TEAM_BASE_URL=http://127.0.0.1:7786 TEAM_WATCH_LABEL=phase600-round604 \
  node docs/plan/artifacts/phase500/team-network.cjs      # ~4 min: two 75s windows
mv docs/plan/artifacts/phase500/team-network-phase600-round604.json \
   docs/plan/artifacts/phase600/team-network-round604.json

HOVER_URL=http://127.0.0.1:7786 HOVER_LABEL=phase600-round604 \
  node docs/plan/artifacts/phase400/hover-cost.cjs
mv docs/plan/artifacts/phase400/hover-cost-phase600-round604.json \
   docs/plan/artifacts/phase600/rail-hover-round604.json

# G) gates LAST — the plain build re-bakes :7700 into forge-control-web/.next,
#    so ALL browser evidence must be captured before this point.
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
bash scripts/checks/dollar-sweep.sh
for c in nav-stack thread-mapping subagent-slice tool-summary story-digest orientation \
         team-rows team-confirm duration classify; do
  (cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-$c.ts)
done
git diff --name-only ec2c799..HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|FileExplorerPanel|VaultFileList|routes/files'
git diff ec2c799..HEAD -- '*/package.json'
```

**Left running for round 605.** `:7798` (the API harness) and `:7786` (the
isolated build of this worktree, `/tmp/phase600-web`) were still up when this
round ended, so a reviewer can skip steps A–D and go straight to §E. Neither is
pm2-managed; neither is production. `forge-executor` was never touched, and
`/opt/forge-ai-os` was never opened.

**Two protocols need a run in flight** (`orientation-live` always,
`digest-honesty` only if the largest thread in the fleet happens to be a live
run). Neither hardcodes a run id: each asks `GET /api/agents` at run time and
refuses with a named error (`NO-LIVE-RUN` / `NO-LARGE-SESSION`, exit 1) if the
fleet cannot supply one. They start nothing and change nothing.

---

## 3. Results

### 3.0 The one thing that is not real: injected team rows

`orientation-live.cjs` and `digest-honesty.cjs`'s `[big]` fixture reach their
subject by adding one node to the `GET /api/proxy/chat/:id/team` **response**.
Both JSONs record `navigation: "injected-team-row"`. Why it is necessary is the
same structural fact phase 500 §3.1 hit and phase 500 §6.3 predicted would shape
this round too:

- the team panel's rows are the chat's own run plus every run carrying
  `metadata.project_id = <the chat's project>`;
- a chat only *has* a project when `projects.metadata.origin_chat_id` names it or
  the bounded thread scan recovers one (`chat-linkage.ts`);
- the projects that own today's live runs carry neither. Curled on 2026-08-06,
  the seven chats in this database resolve to exactly two projects, whose trees
  hold **11 workers and 2 workers**, all settled, the largest thread among them
  **170 entries**.

So a live worker and a ≥200-entry session are not clickable, and the brief asks
for both. The alternative — writing an `origin_chat_id` into the production
`projects` table — is the production write phase 400 round 403 declined to make,
from a build task that is not allowed to make it.

**What the injected node contains.** Its `id`, `status`, `role`, `model`,
`description`, `started_at`, `settled`, `working_ms` and token counts are copied
verbatim from that run's `GET /api/agents` row. Its `task` is `null`, because
this chat's project did not give it one — which is why the strip in those runs
reads `no project task on this node`, recorded as `degraded: "no-task"`. Nothing
is invented.

**What is real in those runs.** Everything asserted. `/api/chat/:runId` — the
query `AgentChatView` actually issues — is not intercepted, so the transcript, the
metadata, `current_activity`, the digest's entire input and the run's status are
the server's own answer, fetched again independently by the protocol for
comparison.

`nav-walk.cjs`, `transcript-expand.cjs`, `capture-600.cjs` and
`digest-honesty.cjs`'s `[roster]` fixture intercept **nothing**. Every level they
visit is reached by clicking a row the server put there.

### 3.1 Nav walk (`nav-walk.cjs`) — **PASS 38/38**

Chat `11dd264b…` (20 team rows), worker `58096061…` (architect), its sub-agent
`toolu_01KAFV63…` (scout). Both levels chosen at run time by structure — the
first `data-depth="2"` sub-agent row and the worker above it — not by id.

| level | kind | header role · model | the API's raw value | source |
|---|---|---|---|---|
| 1 | `session` | `architect · sonnet-4-6` | `metadata.role="architect"`, `model_resolved="claude-sonnet-4-6"` | the run's own metadata |
| 2 | `sub-agent` | `scout · sonnet-4-6` | `subagent_type="scout"`, `meta.model="claude-sonnet-4-6"` | **the spawn call** — `subagents_v2` is empty on this run |

Identity is not inherited: level 1 and level 2 differ in role, asserted rather
than eyeballed. Crumbs read `manager chat › session 58096061` and
`manager chat › session 58096061 › sub-agent toolu_01`.

**(a) The team panel never follows the drill.** The full row set — id, kind and
depth of all 20 rows — is byte-identical at depth 0, depth 1, depth 2, after the
first pop and after the second, and so is `data-team-state`. That is round 601B's
semantic fix (`selId` does not move), measured at five points.

**(b) The reload, and what actually happens.** Round 601B's README says a refresh
"lands on the manager chat". Measured, it does not:

| after `page.reload()` at depth 2 | observed |
|---|---|
| the drilled frame | **gone** — no `[data-agent-chat-view]`, no orientation strip |
| the surface | **TODAY** — `DesktopApp` holds `surface` in `useState("today")` and persists it nowhere |
| clicking CHAT | opens a manager chat (the rail's first row), never a worker |
| re-opening the fixture chat | the same 20-row tree, nothing drilled |
| console errors across the whole sequence | **0** |
| uncaught page errors | **0** |

The property U21 needs is intact and is the one asserted: **nothing about the
drilled view survives a reload**, so no stale worker transcript is ever restored
under a chat's name. The landing surface is a separate fact and it is recorded
verbatim in `nav-walk.json` (`levels.landing`) rather than smoothed over. This is
[Finding 6.2](#62-round-601bs-readme-says-a-refresh-lands-on-the-manager-chat-it-lands-on-today).

**Back pops one level at a time.** depth 2 → depth 1 lands on the same worker
frame that was there before (`drilledRunId` identical, `drilledSubagentId` back to
null), and depth 1 → depth 0 returns to the chat with the tree intact and no
orientation strip.

### 3.2 Byte-complete expand + conservation (`transcript-expand.cjs`) — **PASS 18/18**

Two workers, both clicked in the real tree, chosen at run time for what they can
prove: the only worker in this chat that owns a sub-agent, and the worker with the
widest tool mix.

| | `58096061…` `[fold]` | `ca54e5ae…` `[wide]` |
|---|---|---|
| thread | 72 entries | 160 entries |
| tool rows rendered | **11** | **62** |
| distinct tools | 4 — Read, Agent, Write, Bash | 5 — Read, Grep, Edit, Bash, Write |
| collapsed line == `summarizeTool` | **11 / 11** | **62 / 62** |
| expanded ARGS+RESULT sha256 == API payload | **11 / 11** | **62 / 62** |
| bytes compared | 11 846 args + 9 085 result | 14 908 args + 38 801 result |

**73 rows over 6 distinct tools, 74 640 bytes, zero mismatches.** The comparison
is sha256 over the `<pre>` text against `meta.input` and the matching
`tool_result.content` fetched by the protocol straight from `:7798` — no
tolerance, no prefix matching, no oracle in that path.

**Nine of those 73 payloads arrived pre-clipped**, and that is not a rendering
result: the executor stores `meta.input` clipped to 1500 chars + `…` before
anything in this repo sees it (`tool-summary.ts:21-31`, `digest-gap.md`). The UI
adds nothing of its own; the number is reported per run
(`rows_whose_meta_input_the_EXECUTOR_clipped_before_storage`) so it is never read
as truncation by the transcript.

**Count conservation.** For the fold worker:

| | value |
|---|---|
| thread length | **72** |
| parent view: visible + folded + above + deeper | 28 + 44 + 0 + 0 = **72** ✓ |
| the spawn row's chip | **44 events** |
| the API's own count of `parent_tool_use_id = toolu_01KAFV63…` | **44** ✓ |
| the sub-agent view's own claim on screen | *"46 entries — 44 of this sub-agent's own, plus the spawn call and result that framed it"* |
| child coverage: visible + above | 46 + 26 = **72** ✓ |
| **parent visible + this slice** | 28 + 44 = **72** = the thread ✓ |

**The envelope is counted twice, on purpose.** The spawn `tool_call` and its
`tool_result` appear in the parent view (as the row you clicked) *and* in the
sub-agent view (as its brief and its report), so the naive sum of the two views is
**74**, not 72. The JSON records both under
`naive_sum_with_envelope_double_counted` and `conserved_sum`. Nothing is hidden by
the fold; two entries are deliberately shown in two places, and the sub-agent view
says so in words above its transcript.

### 3.3 Orientation strip on a live worker (`orientation-live.cjs`) — **PASS 14/14**

Target discovered at run time: `e07bc570…`, `planner`, `claude-opus-5`,
*"engine-v2-research-lane · CP1: control-plane verbs core + delivery handshake"*,
running. Header read `planner · opus-5`. 26 API samples taken at 1.5 s while the
browser ran.

| | sample 1 | sample 2 |
|---|---|---|
| gap | — | **25 007 ms** (brief: ≥20 s) |
| verb | `currently:` | `currently:` |
| kind | `assistant_text` | `assistant_text` |
| line | `writing Corpus and code scouted. Creating the CP1 task fan-out now.` | same |
| activity `ts` read off the DOM | `2026-08-05T23:38:10.486Z` | `2026-08-05T23:38:10.486Z` |
| matched an activity the API actually reported | **yes**, by exact `ts` | **yes** |
| was it the NEWEST the API had at that instant | **yes** | **yes** |
| how long that activity had already been current | 14.1 s | 39.1 s |

Both readings are matched to the API by the activity's own timestamp — an exact
identity, not a time-window comparison — and the rendered line is re-derived in
the protocol from the taxonomy (`activityLine` + `clipLine` restated in
`orientation-live.cjs`, not imported), so the two implementations are compared
rather than one checking itself. `currently:` versus `ended:` is asserted against
the run's status at that moment.

**The reading did NOT move between the two samples in the recorded run**
(`reading_changed: false`), and that is data rather than a failure: this planner
spent 39 s writing one message, and the strip correctly showed the same thing for
39 s. What the protocol gates on is that each reading is the newest activity the
API had — proven twice. A reviewer re-running it against a busier target will
likely see `reading_changed: true`; both outcomes pass, and the field is in the
JSON so the difference is never mistaken for a regression.

### 3.4 Digest honesty (`digest-honesty.cjs`) — **PASS 41/41**

`deriveDigest` is never called and `story-digest.ts` is never imported. Every
number below was counted from `GET /api/chat/:id`'s thread by arithmetic written
inside `digest-honesty.cjs`, then compared to the DOM.

| | `[big]` `406ef179…` | `[roster]` `58096061…` |
|---|---|---|
| navigation | injected team row (§3.0) | **clicked in the real tree** |
| status | completed | completed |
| entries | **327** | **72** |
| its own / delegated | 327 / 0 | **28 / 44** |
| tool calls | **145** | 33 |
| tool errors | **8** | 0 |
| sub-agents | 0 | **1** (`unknown` — see §6.1) |
| collapsed header agrees with the expanded block | ✓ | ✓ |
| `data-story-elapsed` | **`frozen`** | **`frozen`** |
| rendered duration | `ran 27m 26s` | `ran 5m 31s` |
| `completed_at − started_at` | 1 646 141 ms → 27m 26s ✓ | 331 502 ms → 5m 31s ✓ |
| snippets verbatim | **3 / 3** | **3 / 3** |
| snippets are the last 3 prose turns, in order | ✓ | ✓ |
| snippet timestamps are their entries' own | ✓ | ✓ |
| WHERE IT STANDS verbatim from the last prose turn | ✓ | ✓ |

The duration check does not re-implement `fmtWorkingTime`: it parses the rendered
string **back** into milliseconds and requires agreement within the smallest unit
printed (1 s here). Every quotation is searched for as a substring across the
whole thread, with the trailing `…` of a clipped snippet removed first — so
"verbatim" means found, not resembled.

**Two fixtures, because no single run exercises the whole block.** Not one
≥200-entry run in this database has a sub-agent, so the roster half is measured on
the 72-entry worker that does. That gap is [Finding 6.3](#63-no-200-entry-session-in-this-database-has-a-sub-agent).

### 3.5 Both-theme capture (`capture-600.cjs`) — **PASS**

Twelve PNGs. Each case is shot dark and light **in the same page state**, with
only `document.documentElement.dataset.theme` flipped — which is exactly what the
app's own `applyTheme` does (`tokens.ts:100-109`), so the flip is the product's,
not the harness's.

| case | data | shows |
|---|---|---|
| `manager` | **real** | the operator chat undrilled — the surface phase 600 must NOT change |
| `worker` | **real** | strip + digest (expanded) + summarized transcript on worker `58096061…` |
| `expanded` | **real** | one tool row open, ARGS and RESULT panes both present |
| `subagent` | **real** | depth 2: `sub-agent`, its slice, and the envelope note |
| `degraded` | **real** | the strip after collapsing the side panel — `team-not-polling`, with the reason spelled out |
| `plandoc` | **real component, synthetic mount** | the plan-doc shell at depth 2 and depth 1 |

**Both themes are asserted, not eyeballed.** Before each shot the protocol probes
the painted colour under four points — top bar, nav rail, drilled surface, team
panel — walking to the first **opaque** ancestor, and requires every region to
repaint lighter under `[data-theme="light"]`. 20 region assertions, all pass. The
opacity rule matters and cost one false failure: a code block's
`rgba(44, 98, 212, 0.08)` tint is *darker* in light mode by design (`theme.css`:
"the dark palette's saturated status colours wash out on light backgrounds"), so
comparing a translucent foreground would fail a correct theme. What must get
lighter is the surface.

**Why `plandoc` is not shot in the app.** `PlanDocView` renders only when the top
of the nav stack is a `plandoc` frame, and **nothing pushes one** — the Kanban
that will is phase 700's, together with the `GET /api/chat/:id/plan/doc` endpoint
the view is waiting for (`PlanDocView.tsx:11-14`, round 601B README §6 deviation
3). The stack lives in `useState` inside `ChatSurface` with no global handle, so a
browser protocol cannot push one either, and an evidence round may not add one.
`capture-plandoc.ts` therefore renders the shipped component to static HTML
against the real `theme.css`/`globals.css` — round 603's method for exactly this
problem — with a nav stack built by the shipped `crumbs()` reducer, so the lineage
line in the picture is the one the app will draw. `capture-600.json` marks that
case `render: "offline-static"` and marks nothing else.

### 3.6 Non-regression — **PASS, nothing regressed**

Phase 500's and phase 400's own scripts, unmodified, re-run against this build.

**Hover (NFU2 / the rail):**

| surface | build | rows | crossings | commits attributable to hover | DOM mutations | layout shift |
|---|---|---|---|---|---|---|
| chat rail | `/opt/forge-ai-os` main (phase 400 "before") | 7 | 76 | **77** | **1057** | — |
| chat rail | phase-400 worktree ("after") | 7 | 76 | **1** | **0** | none |
| chat rail | round-504 worktree | 7 | 74 | **0** | **0** | — |
| **chat rail** | **round-604 worktree** | 7 | **76** | **0** | **0** | — |
| team panel | round-504 worktree | 20 | 75 | **0** | **0** | none |
| **team panel** | **round-604 worktree** | **20** | **75** | **0** | **0** | **none** |

Idle and hover windows are identical in both counters on this build (2 commits, 0
mutations each) — the 2 commits are the panel's own 5 s poll landing inside a 10 s
window, present with or without a pointer. Row geometry is byte-identical hovered
and not, across all 20 rows.

**Poll budget (NFU3), the manager chat** — `team-network-round604.json`, two 75 s
windows in one page and one session, SSE aborted the same way phase 500's
baseline aborted it:

| endpoint | phase 400 baseline /min | phase 500 "after" /min | **round 604** /min | collapsed /min |
|---|---|---|---|---|
| `/agents` | 14.40 | 0.00 | **0.00** | 0.00 |
| `/projects/board` | 9.60 | 0.00 | **0.00** | 0.00 |
| `/chat/:id/team` | 0.00 | 12.00 | **12.00** | **0.00** |
| `/chat/:id` | 20.00 | 20.00 | **20.00** | 20.00 |
| `/chat` | 8.00 | 8.00 | **8.00** | 7.20 |
| `/usage/quota` | 0.00 | 0.00 | 0.00 | 0.80 |
| **total** | **52.00** | **40.00** | **40.00** | **28.00** |

`team_requests_while_collapsed: 0`. Identical to phase 500's "after" in every
row — rounds 601B–603 added three components to the drilled view and moved
nothing on the chat surface.

**Poll budget for the DRILLED view** — the question phase 500's script cannot
reach, and the one the round-604 brief singles out ("the poll budget must be ≤
phase 500's 'after' numbers even though a drilled view now runs its own detail
query"). Measured by `nav-walk.cjs` as three 30 s windows in one page and one
session, `nav-walk.json` → `poll_budget`:

| window | `/chat/:id` | `/chat/:id/team` | `/chat` | **total /min** |
|---|---|---|---|---|
| at rest, manager chat | 20 | 12 | 8 | **40** |
| drilled, depth 1 (worker) | 20 | 12 | 8 | **40** |
| drilled, depth 2 (sub-agent) | 20 | 10 | 8 | **38** |

Drilling in costs **nothing**: `ChatSurface` disables the manager `detailQ` while
`navStack` is non-empty and `AgentChatView` runs exactly one query at the same
intervals, so the drilled view replaces a poll rather than adding one. The 10 vs
12 at depth 2 is one team poll's phase landing outside the window, not a saving.

---

## 4. Universal gates

Verbatim output in `gates-604.txt`.

| gate | result |
|---|---|
| `npx tsc --noEmit` in `forge-control` | clean |
| `npx tsc --noEmit` in `forge-control-web` | clean |
| `NODE_ENV=production pnpm build` in `forge-control-web` | green |
| `bash scripts/checks/dollar-sweep.sh` | PASS |
| every round-601/602/603 check script | ALL PASS |
| token purity over every file round 604 touched | **empty** — this round wrote no component |
| forbidden-file grep over `ec2c799..HEAD` | **empty** |
| `git diff ec2c799..HEAD -- '*/package.json'` (NFU8) | **empty** |
| `git status` scoped to `docs/plan/artifacts/phase600/` | **yes** |

---

## 5. Deviations from the round-604 brief

**1. Port 7786, and an isolated build directory.** `:7785`, `:7787`, `:7788` and
`:7789` are held by other rounds' live `next start` processes and `:7799` by a
phase-300 probe. This round moved DOWN to `:7786` as instructed and killed
nothing. The build goes to `/tmp/phase600-web` so no other round's `.next` is
touched.

**2. A shared `lib-604.cjs` instead of six copies of the harness.** Phase 500's
scripts each carried their own browser setup. At six protocols that stops paying:
the cookie handling, the chat opening and the injection have to behave
identically across protocols or their JSONs cannot be compared. `resolveChromium`
is still the verbatim copy the brief requires; every script still runs standalone
with `node <script>`.

**3. `oracle-604.ts`, a tsx sidecar.** `transcript-expand` has to compare a
collapsed row against "the tool-summary formatter's one-liner". Re-implementing
`summarizeTool` in a `.cjs` would test the re-implementation, so the oracle
imports the shipped modules and prints their answer as JSON. It is used **only**
for rendering contracts. `digest-honesty` never calls it — its numbers are
re-derived by its own arithmetic, which is what the brief asked for.

**4. Two of AgentChatView's resolvers are restated in the oracle, not imported.**
`findSubagentMeta` / `findSpawnFacts` are private to a `"use client"` React
module. The oracle uses the shipped `parseSubagentsV2` for the rollup half and
reads the spawn call straight off the wire for the other, in the same order and
with the same precedence (`AgentChatView.tsx:157-182`). What must not be
re-implemented is the *rendering*, and `roleLabel`/`modelDisplay` are the shipped
ones.

**5. `digest-honesty.cjs` uses two fixtures.** The brief names one ≥200-entry
session. That session cannot exercise the sub-agent roster, because no ≥200-entry
run in this database has a sub-agent (§6.3), so a second, smaller fixture covers
that half — reached by clicking, with no injection.

**6. `transcript-expand.cjs` uses two workers.** The brief asks for ≥10 tool rows
over ≥3 tools. The only worker that can prove conservation has 11 rows over 4
tools; a second worker adds 62 rows over 5 tools so the formatter is exercised at
volume rather than at the minimum.

**7. The `plandoc` capture is an offline render**, and `capture-600.cjs` shells
out to it so one command still produces all twelve PNGs. §3.5 has the argument.

**8. Non-regression outputs were moved into this directory.** `team-hover.cjs`,
`team-network.cjs` and `hover-cost.cjs` write beside themselves in `phase500/` and
`phase400/`; round 604's scope is `phase600/*` only. Same move round 504 made for
`rail-hover-round504.json`.

**9. No fix was made to application code.** §6.1 is a real cross-surface
inconsistency and §6.2 is a stale sentence in another round's README. Both are
application-code or another-round's-document changes, which an evidence round may
not make.

---

## 6. Findings (round 604)

### 6.1 The same sub-agent is `scout` in two places and `unknown` in a third

Measured, in `digest-honesty.json` → `cross_surface_finding`:

| surface | what it calls `toolu_01KAFV63…` | where it reads the role from |
|---|---|---|
| team panel row | **`scout`** | `foldSubagents` — rollup, else the spawn call's `input.subagent_type` (`agents-shared.ts:243-256`) |
| drilled header (round 603's strip) | **`scout`** | `findSpawnFacts` — same two sources, same order (`AgentChatView.tsx:157-182`) |
| story-so-far digest | **`unknown`** | `mergeSubagentMeta(metadata.subagents_v2, …)` — **the rollup only** (`story-digest.ts:228`) |

`subagents_v2` is empty on this run, as it is on almost every run a reader can
click today: round 601B measured 0 rollup entries on both operator chats
(`11dd264b`, `ece63bdb`) and 0 of 2477 / 0 of 1911 entries carrying a
`parent_tool_use_id`. Round 603 chose "unknown" deliberately — "a role the
executor has not stamped yet reads *unknown* rather than being dropped" — but the
executor *has* stamped it, in the spawn call's input, and the two other surfaces
read it from there. The digest is the only one that does not look.

The screenshot shows it plainly: `phase600-604-worker-dark.png` reads
`1 sub-agents (unknown)` in the digest, one line above a team panel listing
`sub-agent scout`.

Not a lie — the digest's own rule is honest about the source it consults, and it
is applied correctly — but it is a **surface disagreement about a fact both
surfaces have**, which is the class of confusion this whole project exists to
remove. `digest-honesty.cjs` records it as `verdict: "FINDING"` and deliberately
keeps it out of the pass/fail count, since the digest satisfies every claim it
makes about itself. Suggested repair (one source change in `story-digest.ts`'s
roster derivation, plus a case in `check-story-digest.ts`) left to the reviewer,
because an evidence round may not change application code.

> **FIXED in round 606** ([README-606.md](README-606.md)). The digest now reads
> the spawn call through the same `parseSpawnInput` the header uses, in the same
> order (rollup first). `check-story-digest.ts` gained a cross-surface section
> that imports the server's own `foldSubagents` and asserts the two name the
> same role on the same thread, so the disagreement cannot come back silently.
> One deliberate difference survives, in the DEFAULT rather than in a fact: with
> nothing to read the panel says `agent` and the digest says `unknown`. Both are
> pinned by a check.

### 6.2 Round 601B's README says a refresh "lands on the manager chat". It lands on TODAY.

`README-601b.md` §6 deviation 4 reads: "A refresh lands on the manager chat.
Memory-only by design." The first half is wrong and the second is right.
`DesktopApp.tsx:264` holds `surface` in `useState<Surface>("today")` and persists
it nowhere, so a reload lands on the **Today** surface; `ChatSurface` then
auto-opens the rail's *first* chat when CHAT is next clicked, which is whatever is
most recent, not the chat you were in.

The property that matters is intact and §3.1 proves it: the drilled frame does
not survive, nothing stale is restored, and the whole sequence raises zero console
errors. But a reviewer following 601B's sentence would expect to land back on the
fixture chat and would read a correct app as broken. A one-sentence correction in
`README-601b.md` is the repair; round 604 may not edit another round's document
any more than it may edit code, so it is recorded here.

> **FIXED in round 606.** `README-601b.md` §6 deviation 4 now states the real
> behaviour — a refresh lands on TODAY and restores no frame — and points back
> here for the measurement.

### 6.3 No ≥200-entry session in this database has a sub-agent

Every run in the fleet with ≥200 thread entries — six of them, 211 to 327 entries
— has **zero** Agent/Task spawns and an empty `subagents_v2`. The runs that do own
sub-agents are the operator chats (whose rows are inert by design) and one
72-entry architect worker. So the digest's sub-agent roster and its own/delegated
split cannot both be exercised on one live fixture, which is why §3.4 has two.

Not a defect. It is the shape of the data as of 2026-08-06 and it will shape round
605's re-run too, so a reviewer who finds `[roster]` pointing at a different,
larger run should treat that as the fleet having improved, not as the protocol
having drifted.

### 6.4 The strip's plan line reads `phase 0 → 100` on this fixture

Visible in `phase600-604-worker-{dark,light}.png`. The worker's team task carries
`round: 0`, and `planPosition(0)` is `{phase: 0, next: 100}` — arithmetic applied
faithfully to a round number that predates the waterfall numbering. The strip is
doing exactly what round 603 specified (`floor(round/100)*100`, no lookup, no
default) and `check-orientation.ts` covers the malformed cases. Recorded only
because a reader seeing "phase 0" in a screenshot could mistake it for a bug in
the derivation rather than a round number of 0 in the data.

---

## 7. Rounds 601A–603 — what came before

`README-601b.md` (nav stack + drill-in shells, 19 e2e assertions) and
`README-603.md` (orientation strip + digest, 68 new unit assertions, offline
both-theme captures) document the builds this round measures. `digest-gap.md` is
round 601A's measured list of what U23/U24 cannot derive from a stored thread —
the honest boundary of everything in §3.4.
