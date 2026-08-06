# Phase 700 (plan zone + plan-doc reader) — artifacts

Rounds 701–702 built it; **round 703 is the evidence round**. Every number in
this directory was produced by a script committed beside it, against a build of
this worktree, and §2 is enough for a reviewer to re-run all of it.

Round 703 changed **no application code**. The only files it added are in this
directory — `gates-703.txt` §5 shows `git diff --name-only ec2c799..HEAD`
touching no forbidden file, and the phase's application diff is unchanged from
round 702's.

Three things in this file are deliberately loud, because they are the places a
reader could be misled:

- **The NFU2 hover instrument was wrong on its first run and is now different
  from phase 500's.** Why, and why the new one is not a weaker gate, is
  [§3.4](#34-nfu2-hover-non-regression--pass).
- **One universal gate is RED** — `api-diff.sh`. It is red on main too, and the
  diagnosis is in [§5](#5-open-items-not-fixed-here).
- **The brief's "no hits" grep returns one hit.** It is a comment. `graph-mapping.md`
  §5 reports it exactly, and the two stricter greps that carry the real claim.

---

## 1. What each file is

### Round 703 protocols

| File | Protocol | Verdict | Proves |
|---|---|---|---|
| `count-agreement.cjs` → `count-agreement.json` | U25 three-way agreement | **PASS** 10/10 | rail badge, panel bar and the live database all read **55/66**, captured inside a **137 ms** span, each leg timestamped at both ends |
| `nav-walk-700.cjs` → `nav-walk-700.json` | U26 click-through + error path | **PASS** 30/30 | Kanban blocks == endpoint blocks; a `docs[]` click renders real `<h1>`/`<h2>` markdown; back never re-scopes the panel; a bogus doc shows **the server's own sentence** and back still works |
| `hover-700.cjs` → `hover-700.json` | NFU2, 14 §"Hover non-regression" | **PASS** 16/16 | 227 pointer crossings over **all 161** panel targets cost **0** commits attributable to the pointer, 0 non-clock DOM mutations, 0 layout shift |
| `network-700.cjs` → `network-700.json` + `network-700.har` | NFU3, 14 §"Poll budget" | **PASS** 11/11 | the two zone polls cost exactly **16.0 req/min** against the pre-v3 slot's **24.8**; **0** zone requests while collapsed and **0** on the Files tab |
| `capture-700.cjs` → `capture-700.json` + 10 PNGs | both-theme evidence | **PASS** 13/13 | five views × dark and light at 1440×900, each with its sampled background colour recorded |

### Round 703 documents

| File | Contents |
|---|---|
| `graph-mapping.md` | **the U27 acceptance artifact** — the shipped `PlanNode`, the Kanban and graph projections side by side, the 10-line React-Flow adapter, the honest `deps` semantics with its measured 2 133-edge cost, and the no-graph-library grep |
| `gates-703.txt` | every universal gate and its verbatim output, including the one red gate and its diagnosis |
| `README.md` | this file |
| `lib-703.cjs` | the harness every protocol above shares (browser, cookie, chat opening, assertion shape) |

### Carried over from rounds 701–702

| File | What it is |
|---|---|
| `linkage-701.md` | the `origin_chat_id` write that made this chat reach its own project, and the endpoint proof |
| `ground-truth-701.json` | the 51/66 baseline `count-agreement.cjs` diffs against |
| `kanban-702.cjs` / `.json`, `README-702.md` | round 702's own 16/16 build-time proof and its design notes |
| `phase700-702-*.png` | round 702's three shots (superseded by the ten `phase700-703-*` ones) |

Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules`
and chromium resolved from `/root/.cache/ms-playwright` — `resolveChromium`
copied verbatim from `scripts/checks/frozen-dom.cjs:30-58`. It is not, and must
not become, a dependency of either repo (NFU8).

---

## 2. Reproducing

Both traps from `docs/plan/artifacts/phase1/REPRODUCE.md` still apply: the proxy
target is baked at **build** time, and `/desktop` is behind GitHub OAuth so a
session cookie has to be minted.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7798. NEVER boot forge-control/src/index.ts on any port —
#    it starts the cron tick, the Telegram bridge and the vault sync against the
#    LIVE database and the LIVE bot token (linkage-701.md §7). Skip if it is up:
curl -s 127.0.0.1:7798/api/health || \
  (cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# B) build the web app AGAINST that harness, into an ISOLATED copy. Never
#    rebuild forge-control-web/.next here — other rounds' `next start`
#    processes are serving out of it.
rm -rf /tmp/phase700-web && mkdir -p /tmp/phase700-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase700-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase700-web/node_modules
cd /tmp/phase700-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u    # → 127.0.0.1:7798

# C) mint the session cookie — from inside the copy
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase700 round703 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 300 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-703.txt && rm mint-cookie.mjs

# D) serve the copy on :7809. AUTH_URL must match the port and AUTH_SECRET must
#    be in the SERVER's env, not just the minting subshell (MissingSecret
#    otherwise). If :7809 is taken, move up — never kill another round's server.
AUTH_URL=http://127.0.0.1:7809 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7809 &

# E) run every protocol from the WORKTREE (not the /tmp copy) against that server
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)"

node docs/plan/artifacts/phase700/count-agreement.cjs      # ~30s
node docs/plan/artifacts/phase700/nav-walk-700.cjs         # ~60s
node docs/plan/artifacts/phase700/hover-700.cjs            # ~70s
node docs/plan/artifacts/phase700/network-700.cjs          # ~4min (3 x 60s windows)
node docs/plan/artifacts/phase700/capture-700.cjs          # ~60s

# F) gates LAST — the plain build re-bakes :7700 into forge-control-web/.next,
#    so ALL browser evidence must be captured before this point.
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
bash scripts/checks/dollar-sweep.sh
git diff --name-only ec2c799..HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|FileExplorerPanel|VaultFileList|routes/files'
grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' forge-control-web/app/desktop/team/
bash scripts/checks/api-diff.sh --control                  # ← RED, see §5
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts)
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts)
```

Every protocol resolves its fixture chat **by title fragment at run time**
(`"Okay when I click the file section"` → `bfd1283a…`); no uuid is hard-coded,
and a missing fixture is a named error rather than a silent skip.

Two protocols use a `--control`-style default port that may be occupied. Nothing
in this round kills another process; `:7799` was held throughout by another
round's `/tmp/phase300-secrets-probe.ts`, so the web server went to `:7809`
instead — the same rule round 702 followed.

---

## 3. Results

### 3.1 Three-way count agreement (U25) — **PASS**

`count-agreement.json`, captured 2026-08-06T01:36:32Z, span **137 ms**.

| leg | computation | process | done / total |
|---|---|---|---|
| rail badge | `count(t.*) FILTER (WHERE t.status='done')` in SQL (`chat-linkage.ts`) | worktree API :7798 | **55 / 66** |
| panel bar | `planProgress()` over `PlanNode[]` in the browser (`planStore.ts`) | rendered DOM | **55 / 66** |
| ground truth | `tasks[]` counted in the protocol itself | **LIVE :7700**, read-only GET | **55 / 66** |
| plan endpoint | (leg 2's input, for completeness) | worktree API :7798 | 55 / 66 |

The rendered rail string and the rendered panel string are compared as
**strings** too, in the same `evaluate` — not just the numbers behind them.

**Why the timestamps matter.** This project's own task statuses move while the
round runs: 51/66 at round 701, 54/66 at 702, 55/66 here. Each leg records
`started_at`/`finished_at`, and the whole capture records its span, so a
reviewer can tell a stale sample from a real disagreement. The DOM read is taken
first (it is the slow leg) and the three HTTP legs fire together in one
`Promise.all` immediately after, which is what keeps the span to 137 ms. A
mismatch still exits non-zero — the span is context, not an excuse.

**Drift vs round 701** (`ground-truth-701.json`, 01:08:50Z): +4 done, total
unchanged, entirely inside block 700 (`1/7 → 5/7`). No new phase blocks. The
protocol asserts only that the done count is **monotonic** — tasks completing is
expected churn, tasks un-completing would be a real finding.

### 3.2 U26 click-through and its error path — **PASS** (30/30)

`nav-walk-700.json`.

| step | assertion | result |
|---|---|---|
| open | the 16 Kanban blocks equal the endpoint's 16 blocks, each with its own done/total, **in order** | PASS |
| open | the 12 doc links equal the endpoint's `docs[]` | PASS |
| open | the chat's own run is a row in its team tree, kind `operator` | PASS |
| click | `[data-plan-doc-view][data-doc-state="ready"]` carries `16-ui-v3-graph-research.md` | PASS |
| click | the body contains a real `<h1>` **element** whose text is the document's own first heading, read from the raw markdown at run time; 7 headings, 6 paragraphs | PASS |
| back | the doc view closes, the composer returns, both zones stay `ready` | PASS |
| back | **the panel never re-scoped** — the operator row is still this chat, and no team row was lost (67 → 67, 0 gained) | PASS |
| error | a bogus doc name renders **`no such plan document: zz-no-such-plan-doc-703.md`** — byte-equal to the server's own `{error}` body, fetched in the same run | PASS |
| error | no markdown is rendered in the error state, the back button survives, and back works out of it | PASS |

**The structural assertion is the point.** "Non-empty text" would pass on a 404
body pasted into a `<div>`. What is asserted is that `MessageMarkdown` produced
a heading **element** of the tag the source's own `#`-run implies, carrying the
source's own words — the expected value is read from the endpoint's raw
markdown at run time, so it cannot go stale with the corpus.

**The one interception, declared.** The zone only renders names the server
listed — deliberately, so a click can never open nothing. To reach the error
path, `nav-walk-700.cjs` routes `GET /api/proxy/chat/:id/plan` and appends one
bogus name to `docs[]`. `/plan/doc` is **not** intercepted: the 404 and its
sentence are the real server's, produced by the real containment code. The route
is installed for that step only and removed after. `capture-700.cjs` declares
and uses the identical interception for the error screenshot.

### 3.3 The round-702 wiring gap — **there was none**

Round 703's brief opens with "if round 702's PlanDocView task wrote
`plandoc-wiring-gap.md`, close that gap now". **That file was never written, and
no gap exists.** The click-through was already complete end to end:

- `ChatSurface.openPlanDoc` pushes the `plandoc` frame (ChatSurface.tsx:347) and
  is threaded to the zone as `SidePanel onOpenDoc` (ChatSurface.tsx:899);
- `PlanDocView` needs the chat id and gets it **without a prop**, by observing
  the one active `["chat","linkage",selId]` query in the react-query cache
  (PlanDocView.tsx:`useOpenChatId`) — the seam `README-702.md` flagged was
  closed by the other task itself, using OrientationStrip's existing idiom.

§3.2's 30 assertions are the proof that this works on real data, which is what
the brief actually wanted. **No code was changed to achieve it.**

### 3.4 NFU2 hover non-regression — **PASS**

`hover-700.json`. Viewport 1440×900. Panel census: **67 team rows, 16 phase
cards, 66 task chips, 12 doc links = 161 targets.**

| window | 10 s | commits | attributed | **unattributed** | non-clock DOM mutations | shadow |
|---|---|---|---|---|---|---|
| 1 · idle, pointer parked | ✓ | 11 | 11 | **0** | 0 | 38.3 % |
| 2 · scroll only, pointer parked | ✓ | 12 | 12 | **0** | 0 | 27.6 % |
| 3 · **hover sweep, 100 crossings** | ✓ | 11 | 11 | **0** | 0 | 36.8 % |
| 4 · coverage, 127 crossings, all 161 targets | 7.7 s | 9 | 9 | **0** | 0 | 41.4 % |

Layout shift under the pointer: **none** — every row/card/chip's
`getBoundingClientRect()` is byte-identical hovered and not.

**This protocol is deliberately different from phase 500's, and it is stricter,
not looser.** `team-hover.cjs` gated on `hover.commits − idle.commits === 0`:
two windows, subtract. With a 5 s team poll and a 15 s plan poll now running
together, "2 polls in one window, 3 in the other" is a coin flip, and a coin
flip dressed as a gate fails honest builds and passes on the retry. So this
script does not subtract — it **attributes**. Every commit is timestamped, and
so are the two things that legitimately commit without a pointer:

- **polls** — `fetch` is wrapped at both ends, catching react-query's
  `isFetching` transition and the state write after `.json()`;
- **timers** — `setInterval` is wrapped so every callback invocation is stamped.

**The first run of this script FAILED, and the failure was the instrument, not
the app.** The idle window showed 5 unattributable commits at ~1 Hz and 10
`characterData` mutations. The cause is `tickStore.ts`: ONE 1 Hz clock for the
whole app, consumed only by the leaf `LiveTime` span of a row that is still
running (`[data-working-cell][data-frozen="false"]`, TeamRow.tsx:261). A running
row's elapsed time **must** move once a second — that is U16, the thing phase
500 shipped — so calling it a hover regression would have been a false positive.
The idle window exists precisely to catch that, and it did. Both the commit
attributor and the mutation classifier now know about the clock, and the
mutation gate counts only mutations **outside** a live working cell.

**Does attributing away commits make the gate vacuous?** No, and the script
proves it rather than claiming it: `attribution_shadow_pct` is the union of
every poll and timer window as a fraction of the measurement window, and it is
asserted to stay under 40 %. Roughly two thirds of every window is unshadowed,
against ~100 pointer crossings. The 77-commit rail storm phase 400 measured
would put ~90 % of its commits outside every shadow. The instrument cannot hide
one.

The mechanism behind the zero is checkable by grep, not by trust:

```console
$ grep -rn "onScroll\|onMouseEnter\|onMouseOver\|onPointerEnter\|onMouseLeave\|useState.*[Hh]over" \
    forge-control-web/app/desktop/team/ forge-control-web/app/desktop/chat/PlanDocView.tsx
NO HITS
```

Affordances are `.team-row:hover` / `.plan-doc-link:hover` in `app/globals.css`;
every explanation is a native `title`, which the browser draws without mounting
anything; `PhaseCard` is `memo`ized and `onOpenDoc` is an empty-deps
`useCallback` over a ref, so a `ChatSurface` re-render cannot change the
identity memoized cards hold.

### 3.5 NFU3 poll budget — **PASS**

`network-700.json`, `network-700.har` (201 entries). Three 60 s windows, SSE
aborted to match every baseline in this corpus.

| endpoint | pre-v3 baseline | phase 500 (one zone) | **phase 700 (two zones)** |
|---|---|---|---|
| `/agents` | 15.20 | 0 | 0 |
| `/projects/board` | 9.60 | 0 | 0 |
| `/projects/managers` | 7.20 | 0 | 0 |
| `/chat/:id/team` | 0 | 12.00 | **12.00** |
| `/chat/:id/plan` | 0 | 0 | **4.00** |
| **the panel slot** | **24.80** | 12.00 | **16.00** |

The claim in `PlanKanban.tsx`'s header holds exactly: **16.0 req/min against
24.8**. Two polls either way; lower rate now.

| window | total/min | zone requests |
|---|---|---|
| panel visible, Team tab | 43.0 | 16.0/min |
| panel **collapsed** | 28.0 | **0** |
| **Files tab** open | 28.0 | **0** |

Both silences are proven, and they are genuinely different code paths:
`visible` is `!collapsed && tab === "team"`, and the mount is conditional on the
same facts, so each state stops both polls twice over — by `enabled: false` and
by there being no observer at all. The protocol also asserts that
`[data-team-panel]` and `[data-plan-kanban]` are **absent from the DOM** on the
Files tab, not merely hidden.

**A correction to the brief:** it says to compare against "phase 500's recorded
baseline HAR". There is no baseline HAR anywhere in this corpus —
`find docs/plan/artifacts -name '*.har'` returned nothing before this round.
Phases 400/500/600 recorded per-request JSON logs, not HARs. Rather than
substitute a different file and call it the HAR, this round records a real one
(`network-700.har`) **and** compares against the actual recorded baselines,
named by file in the JSON: `phase400/managers-network-baseline.json` for the
pre-v3 slot and `phase500/team-network-after.json` for the one-zone panel.

### 3.6 Screenshots — **PASS** (10 PNGs)

`capture-700.json`. 1440×900, `phase700-703-<view>-<theme>.png`.

| view | what it shows |
|---|---|
| `surface` | the whole chat surface, both zones populated (67 team rows, 16 cards, 66 chips, 55/66) |
| `kanban` | the plan zone close-up |
| `card` | the zone scrolled to blocks **500 / 600 / 700**, chips visible |
| `plandoc` | `16-ui-v3-graph-research.md` rendered, 7 headings |
| `docerror` | the error state carrying the server's sentence |

Each shot samples `getComputedStyle(document.body).backgroundColor` and the JSON
carries it: dark `rgb(0, 0, 0)`, light `rgb(247, 247, 245)`, asserted to differ
per view. Theme is switched via `document.documentElement.dataset.theme`, the
app's actual mechanism (`app/theme.css:85`, `app/tokens.ts:103`).

**On "a phase card expanded/scrolled":** there is no expand affordance on a
phase card and this round did not add one — `PhaseCard` always renders every
chip in its block. View 3 is the *scrolled* half of that phrase, named `card`
and described as such rather than dressed up as an interaction that does not
exist.

---

## 4. What this phase did **not** establish

Named here rather than left for a reviewer to discover.

**`doc_path` never matches on this corpus, so the phase→doc link is untested on
real data.** `matchPhaseDoc` links a block to a file only when a digit run in
the filename equals the block's round number. This corpus is numbered by
document position (`00-`…`16-`), so **not one of the 16 blocks carries
`doc_path`** — measured across all 16 in `linkage-701.md` §6 and re-confirmed
this round. Every click-through assertion in §3.2 therefore exercises the flat
`docs[]` list, which is the only live path here. The `doc_path` branch in
`PhaseCard` is real code that **no test in this phase has ever executed against
a populated value**. It would take a plan doc named `700-*.md` to prove it, and
creating one would be writing a fixture into a live project's workspace from a
build task.

**The nav stack is memory-only.** `navStack` is React state in `ChatSurface`;
there is no URL, no history entry, no `localStorage`. A browser reload drops you
back at the manager chat, and the browser's own Back button does not pop a plan
doc — only the in-app `[data-nav-back]` control does. Nothing in this phase
tested reload survivability, because there is nothing to survive it. That is a
design fact carried forward from phase 600's nav-stack round, not a regression.

**Sub-agent and worker rows were not the subject.** The team zone appears in
every capture as a neighbour that must not move, and it does not. Its own
contract is phase 500/600's evidence, re-run there, not here.

**One project, one chat.** Every protocol runs against `bfd1283a…` → project
`8ea0cc08…`. A second linked project does not exist in this database
(`4120f785` was deliberately left unlinked, `linkage-701.md` §2), so
"link_ambiguous" and multi-project behaviour are untested by this round.

**The counts are a snapshot of a moving project.** 55/66 is true at
01:36:32Z. It was 51/66 at round 701 and will be higher when a reviewer reads
this. What is proven is *agreement*, not a particular number.

---

## 5. Open items — **not** fixed here

Round 703 is an evidence round with no application-code deliverable; these are
recorded with enough precision to act on, and left.

**(a) `api-diff.sh --control` is RED — and it is red on main too.**
The failing block is `agents — declared additive field(s) NOT PRESENT in the
current capture` for `agent_kind`, `cron_name`, `project_id`, `role`, `settled`,
`settled_at`, `subagents.[].description`, `subagents.[].ended_at`. Diagnosis,
with the proof in `gates-703.txt` §7:

- phase 700 touched **no** `forge-control` file
  (`git diff --name-only 951ecde~1..HEAD -- forge-control/` is empty), so it
  cannot have moved the read-side API;
- the same fields are absent from **live :7700**, which runs main;
- the same fields **are** present in this very run through the project-scoped
  fixture (`agents-project` reports them as `ADD`), so the code emits them.

`/api/agents` unfiltered currently returns 60 rows, none of which is a project
worker or a cron agent and none of which has a sub-agent — so no row in that
fixture can carry those fields. The script says so itself: *"the field is
unreachable through this fixture — the gate proves nothing about it."* The fleet
population churned since the baseline was pinned (60 rows gone, 60 new).
**Action:** re-pin `docs/plan/artifacts/phase300/baseline/` against a fixture
that includes a project worker. That is a read-side-API decision and belongs to
a briefed round.

**(b) A hardcoded colour in `ChatSurface.tsx:1481` — `rgba(79, 176, 196, 0.06)`.**
Pre-existing: `git blame` dates it 2026-07-02, five weeks before this project's
phase base, and it is not in the phase-700 diff. Phase 700's change to that file
is the `openPlanDoc` callback and one prop, which introduce no colour. The
`app/desktop/team/` directory — every file the plan zone owns — is completely
clean (`gates-703.txt` §6).

**(c) A real light-mode defect, found while shooting §3.6, outside this phase's
files.** `DesktopApp.tsx:676` sets the **active left-nav item's background** to
a literal `#141417`:

```ts
background: surface === key ? "#141417" : "transparent",
```

It does not flip with the theme, so in light mode the selected nav row renders
as a black bar — visible in `phase700-703-surface-light.png` under `INBOX`,
sampled at `rgb(20, 20, 23)` in **both** themes. `MemorySurface.tsx:207` and
`:233` carry the same literal for the same purpose. This is worth naming because
Konrad's own words opening this project were "they still don't work in light
mode". It is **not** a phase-700 file and no deliverable of this round covers
it; fixing it needs a briefed round with the token-purity gate pointed at
`app/desktop/`.

---

## 6. Gate summary

Full verbatim output in `gates-703.txt`.

| # | gate | result |
|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | **exit 0** |
| 2 | `npx tsc --noEmit` — forge-control-web | **exit 0** |
| 3 | `NODE_ENV=production pnpm build` — forge-control-web | **exit 0** |
| 4 | `scripts/checks/dollar-sweep.sh` | **PASS** — every primary-gate hit allowlisted |
| 5 | forbidden-file diff over `ec2c799..HEAD` | **PASS** — grep exit 1, no forbidden file touched |
| 6 | token purity over every file phase 700 touched | **PASS** — `app/desktop/team/` grep exit 1; one pre-existing hit outside the phase's diff, §5(b) |
| 7 | `api-diff.sh --control` | **RED** — same on main, diagnosed in §5(a) |
| 8 | `check-plan-store.ts` | **exit 0** — 16/16 |
| 8 | `check-team-rows.ts` | **exit 0** |
