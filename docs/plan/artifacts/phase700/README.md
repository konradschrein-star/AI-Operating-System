# Phase 700 (plan zone + plan-doc reader) — artifacts

Rounds 701–702 built it; **round 703 was the evidence round**; **round 705 is
the fix round for round 704's review**. Every number in this directory was
produced by a script committed beside it, against a build of this worktree, and
§2 is enough for a reviewer to re-run all of it.

## 0. Round 705 — what round 704 found and what changed

Round 704's verdict was NEEDS_FIXES on four points. All four are addressed
below; the two blocking ones were a real regression and an instrument that could
not see it.

| # | round 704 finding | what round 705 did | evidence |
|---|---|---|---|
| **1** | the 15 s plan poll pushed the chat surface to **43–44 req/min**, breaking `phase600/nav-walk.cjs:310` (P3, ≤ 40/min) | **the build was moved back under the ceiling, the ceiling was not moved.** Team poll 5 s → **6 s**, plan poll 15 s → **30 s** (`ChatTeamPanel.tsx:91`, `PlanKanban.tsx:77`) | `nav-walk-p3-705.json` — P3 rerun on this build: **40 / 40 / 40** at rest, depth 1, depth 2. Panel slot **12/min**, down from 16 |
| **2** | `network-700.cjs` only `note()`d `total_per_minute`, so it reported PASS over a regression printed in its own output | the total is a **`check()`** now, against phase 500's recorded figure read out of its own committed JSON — the same 40 that P3 gates on | `network-700.json`: *"whole-surface total <= phase 500's recorded total (40/min)"* → **39 ≤ 40**. 11 checks → **13** |
| **3** | `hover-700.cjs:418`'s `attribution_shadow_pct < 40` failed on rerun (40.8 % vs the recorded 38.3 %), so 16/16 was not reproducible | the fitted constant is gone. A **ceiling argued from the storm it must not hide** (< 60 %) plus a **bound derived from each run's own poll load**, asserted on all three gated windows instead of two | `shadow-repro-705.json` — **three consecutive runs, 20/20 each**. 9 gated windows span 37.7–44.4 %; **five of them would have failed the old 40** |
| **4** | every protocol wrote back into `docs/plan/artifacts/`, so following §2 dirtied git and destroyed the record being reviewed | a rerun is **non-destructive by default**: it writes to `/tmp/phase{500,600,700}-out`, prints the `diff` line, and only re-records in place with an explicit **`--write`** | run any protocol without `--write` and `git status --porcelain` stays empty — round 705 proved this for `phase600/nav-walk.cjs` and `phase500/team-frozen.cjs` before touching anything |

Round 704's finding **5** — `DesktopApp.tsx:676`'s `#141417` active-nav
background, which does not flip with the theme — is untouched, as round 704
agreed it should be. It blames to 2026-08-02, outside this phase's diff, and it
needs its own briefed round. It is still described in [§5(c)](#5-open-items--not-fixed-here).

**Two corrections to round 703's own README while re-recording**: it reported
`nav-walk-700` as 30/30 and `capture-700` as 13/13. Both were miscounts of runs
that were otherwise fine — the committed JSONs carried **33** and **12** checks
then and carry the identical check *sets* now (verified by diffing the check
names against `git show HEAD:…`). The tables in §1 and §3 now say 33 and 12.

Round 703 changed **no application code**; round 705 changed exactly three
lines of it — two poll intervals and one stale comment — for the reason in
finding 1 above. Everything else round 705 touched is a protocol or this file.
No forbidden file is in the diff (§6, gate 5), and `forge-control/` is still
untouched by the whole phase.

**Every JSON and PNG in this directory was re-recorded by round 705** against a
build of the 6 s / 30 s sources, so no number here is left over from the build
round 704 reviewed. Where a figure moved because this project's own plan moved
underneath it (57/68 done, up from 55/66), the protocol's timestamps say so.

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
| `count-agreement.cjs` → `count-agreement.json` | U25 three-way agreement | **PASS** 10/10 | rail badge, panel bar and the live database all read **57/68**, captured inside a **142 ms** span, each leg timestamped at both ends |
| `nav-walk-700.cjs` → `nav-walk-700.json` | U26 click-through + error path | **PASS** 33/33 | Kanban blocks == endpoint blocks; a `docs[]` click renders real `<h1>`/`<h2>` markdown; back never re-scopes the panel; a bogus doc shows **the server's own sentence** and back still works |
| `hover-700.cjs` → `hover-700.json` | NFU2, 14 §"Hover non-regression" | **PASS** 20/20 | 231 pointer crossings over **all 165** panel targets cost **0** commits attributable to the pointer, 0 non-clock DOM mutations, 0 layout shift |
| `network-700.cjs` → `network-700.json` + `network-700.har` | NFU3, 14 §"Poll budget" | **PASS** 13/13 | the two zone polls cost **12.0 req/min** against the pre-v3 slot's **24.8**, and the whole surface **39 ≤ 40**; **0** zone requests while collapsed and **0** on the Files tab |
| `capture-700.cjs` → `capture-700.json` + 10 PNGs | both-theme evidence | **PASS** 12/12 | five views × dark and light at 1440×900, each with its sampled background colour recorded |

### Round 705 protocols and documents

| File | Protocol | Verdict | Proves |
|---|---|---|---|
| `nav-walk-p3-705.json` | `phase600/nav-walk.cjs` rerun against this build | **PASS** 38/38 | the gate round 704 caught failing: **40 / 40 / 40** req/min at rest, depth 1 and depth 2. Produced by phase 600's own unmodified assertions, not a new script written to agree with the fix |
| `shadow-repro-705.json` | three consecutive `hover-700.cjs` runs | **PASS** ×3 | the NFU2 instrument now reproduces: 20/20 every time, 9 gated windows between 37.7 % and 44.4 % shadow against a 60 % ceiling |
| `gates-705.txt` | every universal gate, verbatim, plus §10 — the md5 of `git status --porcelain` before and after running four protocols the documented way. **Identical.** That is finding 4, proven rather than described |

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
| `kanban-702.cjs` / `.json`, `README-702.md` | round 702's build-time proof (17/17, re-recorded by round 705) and its design notes |
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

# E) run every protocol from the WORKTREE (not the /tmp copy) against that server.
#    ROUND 705: these are NON-DESTRUCTIVE. Each writes its verdict to
#    /tmp/phase700-out/ and prints the `diff -u` line against the committed
#    copy; `git status --porcelain` stays EMPTY. Round 704 had to
#    `git checkout -- docs/plan/artifacts/` three times because they used to
#    overwrite the record being reviewed. Add `--write` (or PHASE700_WRITE=1)
#    only to deliberately RE-RECORD, which is what a fix round does.
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)"
export PHASE700_BASE_URL=http://127.0.0.1:7809          # the port D actually took

node docs/plan/artifacts/phase700/count-agreement.cjs      # ~30s
node docs/plan/artifacts/phase700/nav-walk-700.cjs         # ~60s
node docs/plan/artifacts/phase700/hover-700.cjs            # ~70s
node docs/plan/artifacts/phase700/network-700.cjs          # ~4min (3 x 60s windows)
node docs/plan/artifacts/phase700/capture-700.cjs          # ~60s
node docs/plan/artifacts/phase700/kanban-702.cjs           # ~40s

# E2) the two gates from earlier phases that round 700 had to keep intact.
#     nav-walk.cjs is the one round 704 caught failing; P3 is the assertion.
#     Same non-destructive rule, own /tmp dir per phase.
PHASE600_BASE_URL=$PHASE700_BASE_URL node docs/plan/artifacts/phase600/nav-walk.cjs   # ~4min
TEAM_BASE_URL=$PHASE700_BASE_URL     node docs/plan/artifacts/phase500/team-frozen.cjs # ~60s

git status --porcelain        # ← MUST be empty after all of the above

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
| rail badge | `count(t.*) FILTER (WHERE t.status='done')` in SQL (`chat-linkage.ts`) | worktree API :7798 | **57 / 68** |
| panel bar | `planProgress()` over `PlanNode[]` in the browser (`planStore.ts`) | rendered DOM | **57 / 68** |
| ground truth | `tasks[]` counted in the protocol itself | **LIVE :7700**, read-only GET | **57 / 68** |
| plan endpoint | (leg 2's input, for completeness) | worktree API :7798 | 57 / 68 |

The rendered rail string and the rendered panel string are compared as
**strings** too, in the same `evaluate` — not just the numbers behind them.

**Why the timestamps matter.** This project's own task statuses move while the
round runs: 51/66 at round 701, 54/66 at 702, 55/66 at round 703, 57/68 here.
Each leg records
`started_at`/`finished_at`, and the whole capture records its span, so a
reviewer can tell a stale sample from a real disagreement. The DOM read is taken
first (it is the slow leg) and the three HTTP legs fire together in one
`Promise.all` immediately after, which is what keeps the span to 142 ms. A
mismatch still exits non-zero — the span is context, not an excuse.

**Drift vs round 701** (`ground-truth-701.json`, 01:08:50Z): +6 done, +2 total,
entirely inside block 700 — round 705's own two tasks are among them. No new
phase blocks. The
protocol asserts only that the done count is **monotonic** — tasks completing is
expected churn, tasks un-completing would be a real finding.

### 3.2 U26 click-through and its error path — **PASS** (33/33)

`nav-walk-700.json`.

| step | assertion | result |
|---|---|---|
| open | the 16 Kanban blocks equal the endpoint's 16 blocks, each with its own done/total, **in order** | PASS |
| open | the 12 doc links equal the endpoint's `docs[]` | PASS |
| open | the chat's own run is a row in its team tree, kind `operator` | PASS |
| click | `[data-plan-doc-view][data-doc-state="ready"]` carries `16-ui-v3-graph-research.md` | PASS |
| click | the body contains a real `<h1>` **element** whose text is the document's own first heading, read from the raw markdown at run time; 7 headings, 6 paragraphs | PASS |
| back | the doc view closes, the composer returns, both zones stay `ready` | PASS |
| back | **the panel never re-scoped** — the operator row is still this chat, and no team row was lost (69 → 69, 0 gained) | PASS |
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

§3.2's 33 assertions are the proof that this works on real data, which is what
the brief actually wanted. **No code was changed to achieve it.**

### 3.4 NFU2 hover non-regression — **PASS**

`hover-700.json`. Viewport 1440×900. Panel census: **69 team rows, 16 phase
cards, 68 task chips, 12 doc links = 165 targets.**

| window | 10 s | commits | attributed | **unattributed** | non-clock DOM mutations | shadow |
|---|---|---|---|---|---|---|
| 1 · idle, pointer parked | ✓ | 12 | 12 | **0** | 0 | 41.1 % |
| 2 · scroll only, pointer parked | ✓ | 12 | 12 | **0** | 0 | 38.6 % |
| 3 · **hover sweep, 100 crossings** | ✓ | 11 | 11 | **0** | 0 | 38.2 % |
| 4 · coverage, 131 crossings, all 165 targets | 7.9 s | 10 | 10 | **0** | 0 | 43.9 % |

Layout shift under the pointer: **none** — every row/card/chip's
`getBoundingClientRect()` is byte-identical hovered and not.

**This protocol is deliberately different from phase 500's, and it is stricter,
not looser.** `team-hover.cjs` gated on `hover.commits − idle.commits === 0`:
two windows, subtract. With a 6 s team poll and a 30 s plan poll now running
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
asserted — on all three windows that carry a commit gate, idle, hover *and*
coverage.

**Round 705 rebuilt that assertion, because round 704 was right about it.**
The threshold was a bare `< 40`, a number reverse-engineered from one
measurement. Round 704 reran the protocol on the same build and got 40.8 %:
15/16, non-zero exit. Round 705's first rerun got **41.1 %** and would have
failed it a third time. A gate that fails an honest build on the retry is the
"coin flip dressed as a gate" this very section criticises phase 500 for, one
layer up — the criticism was correct and the replacement was not.

What replaced it is two assertions, one absolute and one derived:

- **CEILING — shadow < 60 %,** argued from the thing the gate exists to catch
  rather than fitted to a run. Phase 400 measured the one re-render storm this
  project actually shipped: 77 commits in a 10 s window. Storm commits track
  pointer movement, which is spread across the window, so a shadow covering
  fraction *s* hides roughly *s* of them. At the 43.9 % measured above, **43 of
  those 77 commits are still in the open**, and `commits_unattributed` is gated
  at zero — any one of them fails it loudly. The instrument only goes blind near
  total coverage. Every window's JSON now carries
  `reference_storm_commits_still_exposed` so this is arithmetic a reviewer can
  check, not a claim they have to accept.
- **DERIVED — shadow ≤ the sum of the attribution windows this run actually
  opened,** clipped to the measurement window. A union of intervals can never
  exceed their sum, so this is the instrument auditing its own arithmetic
  against the poll load it observed instead of an assumed one: a broken interval
  merge, a mis-clipped `armed` stamp, or a lead/tail widened by a later edit all
  fail here. Measured 41.1 % against a 51.4 % budget.

**And it reproduces now — measured, not asserted.** `shadow-repro-705.json`
records three consecutive runs of the same build: **20/20 each time**. Across
the nine gated windows the shadow spans 37.7 % – 44.4 %, which is 15.6 pp of
headroom under the ceiling — and **five of those nine would have failed the old
40**. That spread is the natural variance of poll phasing; it was always there,
and the old threshold sat inside it.

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

`network-700.json`, `network-700.har` (197 entries). Three 60 s windows, SSE
aborted to match every baseline in this corpus.

| endpoint | pre-v3 baseline | phase 500 (one zone) | round 703 (15 s plan) | **round 705 (6 s / 30 s)** |
|---|---|---|---|---|
| `/agents` | 15.20 | 0 | 0 | 0 |
| `/projects/board` | 9.60 | 0 | 0 | 0 |
| `/projects/managers` | 7.20 | 0 | 0 | 0 |
| `/chat/:id/team` | 0 | 12.00 | 12.00 | **10.00** |
| `/chat/:id/plan` | 0 | 0 | 4.00 | **2.00** |
| **the panel slot** | **24.80** | 12.00 | 16.00 | **12.00** |
| **the WHOLE surface** | — | **40.00** | **43.00** ❌ | **39.00** ✅ |

**The last row is the one round 703 reported and never checked, and it is why
round 704 blocked this phase.** The panel-slot claim was true — 16.0 against
24.8 — while the number that a committed gate actually constrained had gone from
40 to 43. `network-700.cjs` printed both figures side by side in a `note()` and
compared neither. §3.5 then quoted the flattering one.

Two things changed. The **build** was moved back under the ceiling: team poll
5 s → 6 s, plan poll 15 s → 30 s, which is arithmetically exact (28 req/min
outside the panel + 10 + 2 = 40). The **instrument** learned to see it: the
whole-surface total is now a `check()` against phase 500's recorded 40, read out
of `phase500/team-network-after.json` — the same file and the same number
`phase600/nav-walk.cjs:310` gates on, so the two cannot drift apart silently
again. Measured this round: **39 ≤ 40**.

The ceiling was not amended. Had it needed to be, the fix would have had to move
`nav-walk.cjs:310` *and* NFU3 together, with sign-off — which is what round 704
demanded and what the alternative would have been.

| window | total/min | zone requests |
|---|---|---|
| panel visible, Team tab | 39.0 | 12.0/min |
| panel **collapsed** | 28.0 | **0** |
| **Files tab** open | 28.0 | **0** |

And independently, phase 600's own unmodified walk on this build
(`nav-walk-p3-705.json`): **40 / 40 / 40** req/min at rest, drilled to depth 1
and drilled to depth 2 — P1, P2 and **P3 all PASS**. That file is phase 600's
assertions judging phase 700's build, not a new script written to agree with the
fix.

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
| `surface` | the whole chat surface, both zones populated (69 team rows, 16 cards, 68 chips, 57/68) |
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

**The counts are a snapshot of a moving project.** 57/68 is true at
02:40:21Z. It was 51/66 at round 701, 55/66 at round 703, and will be higher
when a reviewer reads this. What is proven is *agreement*, not a particular
number.

**Round 705's own limits, stated in the same spirit.**

- **The 6 s team poll was not re-justified from scratch.** Phase 500 measured
  and committed 5 s; round 705 moved it to 6 s because the panel's total had to
  come back under 40 req/min and the plan poll alone could not get there (30 s
  saves only 2 req/min of the 3–4 that were over). Whether 6 s is the *right*
  refresh cadence for a live team tree is a product question nobody has asked.
  What is measured is that the tree still ticks correctly at it —
  `phase500/team-frozen.cjs` part B, re-run on this build: 1/1 running row
  ticks, 20 settled rows frozen.
- **The whole-surface ceiling is still phase 500's 40, which was itself a
  recorded observation rather than a designed budget.** Phase 500's own declared
  cap was `caps.total_per_minute: 52`; round 704 noted the tension and round 705
  did not resolve it. It took the *stricter* of the two, because that is the one
  a committed assertion enforces. Formally reconciling NFU3's text, phase 500's
  `caps` and `nav-walk.cjs:310` is a one-round docs job that nobody has briefed.
- **`network-700.cjs` now gates the total for the CHAT surface only.** Other
  surfaces (Live, Projects, Money) have their own polls and no equivalent
  assertion. Nothing in this project claims they do.
- **The shadow ceiling is argued, not derived from first principles.** The 60 %
  line comes from a storm-visibility argument over one measured storm (phase
  400's 77 commits). A pathological regression that committed *only* inside poll
  windows would still hide — but such a thing would be a poll-driven re-render,
  which is exactly what the attributor is supposed to excuse.

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

Round 703's verbatim output is in `gates-703.txt`; **round 705 re-ran every one
of these and its output is in `gates-705.txt`.** The table below is round 705's.

| # | gate | result |
|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | **exit 0** |
| 2 | `npx tsc --noEmit` — forge-control-web | **exit 0** |
| 3 | `NODE_ENV=production next build` — forge-control-web | **exit 0** ¹ |
| 4 | `scripts/checks/dollar-sweep.sh` | **PASS** — exit 0, every primary-gate hit allowlisted |
| 5 | forbidden-file diff, committed **and** working tree | **PASS** — both greps exit 1 |
| 6 | token purity — `app/desktop/team/` and every line round 705 added | **PASS** — both greps exit 1; the pre-existing hits outside the phase's diff are §5(b)/(c) |
| 7 | `forge-control/` diff, committed and working tree | **PASS** — both empty, the engine lane's files are untouched |
| 8 | `check-plan-store.ts` | **exit 0** |
| 9 | `check-team-rows.ts` | **exit 0** |
| 10 | **reproduce-cleanliness** (round 704 finding 4) | **PASS** — `git status --porcelain` md5-identical before and after four protocols run the documented way |
| 11 | `api-diff.sh --control` | **RED** — identical failure to rounds 703/704, on a phase that touched no `forge-control` file (gate 7). Diagnosed in §5(a) |

¹ Built from an rsync'd identical-source copy at `/tmp/rev705-build`, **not** in
place: pids 1882801 and 1882827 are live `next-server` processes whose cwd is
`forge-control-web/`. Same command, same sources — round 704 used this method
for the same reason.
