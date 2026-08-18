VERDICT: NEEDS_FIXES

# Phase 6 gating review — round 1354

Gates used: **`docs/plan/operator-visibility/03-quality.md`** (the per-project layout; it
exists, so it is the one that binds). `docs/plan/03-quality.md` also exists and is the
older project-wide corpus — read, not used as the gate.

One criterion fails: **A4 in the chat team panel**. Everything else passes, including the
hover non-regression Konrad measures. The failure is a one-line label/verb mismatch whose
blast radius *this phase widened*, and it is fixable without touching anything else.

---

## Live-checkout cleanliness (mandatory)

```
$ git -C /opt/forge-ai-os status --porcelain
[END live status]
```

**Empty.** Nothing was hot-applied into the live checkout. PASS.

---

## Per-criterion verdicts

| # | Verdict | The command that justified it |
|---|---|---|
| A1 | **PASS** (deviation named below) | Playwright against the worktree build on :7861. `/live`: 4 settled rows carry `[data-live-x]`, 3 running rows carry none. Team panel: 15 settled rows carry `[data-team-x]` titled *"Hide this row…"*; the 1 running row's ✕ is titled *"Terminate this agent — click again to confirm"*. |
| A2 | **PASS** | `POST :7798/api/agents/dismissals {"id":"aaaaaaaa-…-00000000000a"}` against seeded scratch DB `scratch1354` → `{"dismissed":["aaaaaaaa…","bbbbbbbb…","dddddddd…"]}`. Three running descendants (`cccccccc` running worker, `eeeeeeee` running child of a settled worker, `ffffffff` running child of the manager) were **not** hidden; the settled grandchild `dddddddd` **under a running parent** was. |
| A3 | **PASS** | Dismissed on :7861, then a **fully cold chromium context** (new browser, no profile). `localStorage` read back as `[]` and the row was still hidden, with `1 dismissed · show` still in the header. `grep -rn localStorage app/desktop/team app/desktop/live` → only comments; no client store exists. |
| A4 | **FAIL (team panel)** / PASS (/live) | See finding 1. `/live`: `1 dismissed · show` → peeked row + `[data-live-restore]`, restore returns it. Team panel: clicking `N hidden · show` took rows 15 → 16 and `GET /api/agents/dismissals` → `{"node_ids":[],"count":0}`. It restores everything; it does not peek. |
| A5 | **PASS** | `db/migrations/0041_ui_dismissals.sql` is `CREATE TABLE IF NOT EXISTS ui_dismissals` + one index. No `ALTER TABLE runs`, no FK to `runs`. After the A2 cascade, `select id,status,title from runs` returned all 7 seeded rows with unchanged statuses. `grep -nE "DELETE FROM\|UPDATE \|ALTER \|DROP "` over the phase's files: 3 hits, all against `ui_dismissals`, zero against `runs`. |
| A6 | **PASS** | `npx tsx scripts/checks/check-browser-shots.ts` → ALL PASS. In the transcript: `[data-browser-shots]` renders collapsed as `📷 1 image … ▸`, expands to `[data-shot-strip]` with a real `<img>` (`naturalWidth 524`). In `/live`: camera indicator on the run with shots, click → strip of 2 images from `/api/proxy/uploads/cb270ce22cab/…`, both `naturalWidth 1600` (they actually loaded). Both themes captured. |
| A7 | **PASS** | `git diff main -- forge-control-web/app/desktop/chat/rehype-forge-allowlist.ts` → **0 bytes**. `img` still becomes `imageMarker()` text at line 268-269; the emitted tree contains no `img`. Every `src` on the page comes from `shotSrc()` over validated 12-hex + filename. |
| A8 | **PASS** | `docs/plan/artifacts/phase1350/browser-visibility.md` §3 states plainly that only the research lane is instructed to write to `/opt/ai-os/uploads/$FORGE_RUN_ID`, names the uncovered cases (the operator itself, builders using `playwright-skill` → `/tmp`), and says the fix lives in `cc-runner.ts` / `project-tick.ts`, which this project may not edit. No claim of full coverage. |

---

## Hover non-regression — the one Konrad measures

**Static check.** `git diff main -- forge-control-web/` grepped for
`onMouseEnter|onMouseOver|onMouseLeave|onPointerEnter|onPointerOver`: **two hits, both
inside comments** (`AgentActivity.tsx:49`, `BrowserShots.tsx:25`), zero handlers added.
`TeamRow.tsx`, `ChatTeamPanel.tsx`, `live/AgentActivity.tsx` contain no pointer handler and
no `useState` driving hover. The ✕ reveal is the CSS `.live-row` / `.team-row` rule; the
control slot is mounted on every row at fixed width, so revealing it lays out nothing.
**No new JS hover state on a row.** PASS.

**Probe as briefed.** `node docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs` →
**14/14 PASS**, exit 0. Stated precisely: this probe is a *synthetic-page gate on the row-
membership assertion itself* — its own header says it "does not need the app, a build, a
cookie or a server". It proves the sweep's probe rejects a non-row. **It does not measure
hover cost against the app**, so the brief's "run it against the worktree harness" is not
something the file can do. Rather than redefine the criterion, the actual cost instrument
was run as well — the existing one, not a new one.

**Cost sweep — `docs/plan/artifacts/phase1290/hover/hover-1291.cjs`, unmodified**, against
the worktree production build on :7861 talking to the worktree API on :7798.
Interleaved idle/hover windows, 5 pairs per surface, as the standing rule requires.

```
rail: 10 rows targeted
  pair 1: idle lt=3 (max 63ms) | hover lt=4 (max 67ms, 148 crossings) | attributable +1
  pair 2: idle lt=2 (max 55ms) | hover lt=4 (max 62ms, 147 crossings) | attributable +2
  pair 3: idle lt=3 (max 63ms) | hover lt=2 (max 59ms, 149 crossings) | attributable -1
  pair 4: idle lt=3 (max 61ms) | hover lt=3 (max 77ms, 147 crossings) | attributable  0
  pair 5: idle lt=2 (max 76ms) | hover lt=2 (max 72ms, 147 crossings) | attributable  0
team: 12 rows targeted
  pair 1: idle lt=3 (max 54ms) | hover lt=2 (max 64ms, 147 crossings) | attributable -1
  pair 2: idle lt=1 (max 50ms) | hover lt=4 (max 61ms, 145 crossings) | attributable +3
  pair 3: idle lt=2 (max 69ms) | hover lt=0 (max  0ms, 149 crossings) | attributable -2
  pair 4: idle lt=3 (max 66ms) | hover lt=1 (max 61ms, 149 crossings) | attributable -2
  pair 5: idle lt=2 (max 82ms) | hover lt=2 (max 63ms, 148 crossings) | attributable  0

errors: 0
rail: median attributable long tasks >50ms = 0   (idle floor [3,2,3,3,2]; hover [4,4,2,3,2])
rail: hover probes 25/25 passed on .chat-row
team: median attributable long tasks >50ms = -1  (idle floor [3,1,2,3,2]; hover [2,4,0,1,2])
team: hover probes 25/25 passed on [data-team-row]
load average during the session: 4.19 – 8.30 on 16 cores
```

**Measured idle floor on this box: 1–3 long tasks per 10 s window, worst single idle task
50–82 ms.** That is the ambient noise the standing rule warns about, and it is larger than
every hover delta observed (−2 … +3). **No delta smaller than the floor is reported here as
an effect.** Clause (a) of §4 holds: median attributable long tasks >50 ms is 0 on the rail
and −1 on the team panel — zero cost attributable to hovering, on both surfaces, with
**25/25 valid row probes on each**. Phase 6 did not regress hover.

*Disclosure — the first sweep attempt.* Against :7862 (same build, pointed at live :7700)
the run printed `SWEEP INVALID — rail: 22/25 probes on a row`. The three misses name their
own cause: `onto="Couldn't load your chats."` — the chat list failed to load in that pair,
so the pointer landed on an error panel. That is a harness data-load failure on my side,
not a code finding; the run above replaces it and is valid on both surfaces. The invalid
run's numbers (`rail median 0`, `team median -1`, `team 25/25`) agree with it.

---

## Commands run, with results

```
$ cd forge-control && npx tsc --noEmit && npm test
TSC_EXIT=0
# tests 855  # suites 165  # pass 855  # fail 0  # cancelled 0  # skipped 0  # todo 0

$ cd forge-control-web && npx tsc --noEmit && npm run build
TSC_EXIT=0
BUILD_EXIT=0        ✓ Compiled successfully · Route (app) table printed

$ npx tsx scripts/checks/check-browser-shots.ts
ALL PASS — browser-shot extraction

$ node scripts/checks/no-raw-colours.cjs        # as gates-808.sh:133 invokes it
no-raw-colours: PASS — 222 literal(s) across 14 file(s), all accounted for
                (176 legitimate, 46 known debt, 0 unlisted)   EXIT=0

$ tsx check-team-rows / check-thread-mapping / check-tool-summary / check-duration
ALL PASS (4/4)

$ bash scripts/checks/gates-808.sh              # 17 gates
16 green, 2 skipped (browser gates, not requested), 1 RED → gate 3.
Gate 3 investigated and DISMISSED as my own artifact: `NODE_ENV=production pnpm build`
piped through grep exited 1 on a stale `.next` left by my two earlier concurrent builds
("Error occurred prerendering page /404 … pages-manifest.json"). After `rm -rf .next`:
  $ bash -c "set -o pipefail; NODE_ENV=production pnpm build 2>&1 | grep -E '…' | head -5"
  ✓ Compiled successfully / Route (app) …            GATE3_CLEAN_EXIT=0
Not a code defect.
```

### curl matrix against :7798 (worktree routers, scratch DB `scratch1354`)

```
GET    /api/agents/dismissals                    200 {"node_ids":[],"count":0}
POST   /api/agents/dismissals {id:manager}       200 {"dismissed":[3 settled ids]}
POST   … same again (idempotency)                200 identical set
POST   {"id":123}                                400 {"error":"id must be a string"}
POST   {"id":"  "}                               400 {"error":"id must not be empty"}
POST   {"id":"a"×201}                            400 {"error":"id must be at most 200 characters"}
POST   {"cascade":"yes"}                         400 {"error":"cascade must be a boolean"}
POST   malformed JSON body                       400 {"error":"invalid JSON body", …}
POST   {"id":"toolu_01ABCdef"}                   200 {"dismissed":["toolu_01ABCdef"]}   kind='subagent'
DELETE /api/agents/dismissals/<never-hidden>     200 {"restored":[]}       (documented: state, not 404)
DELETE /api/agents/dismissals/<hidden id>        200 {"restored":["bbbbbbbb-…"]}
DELETE /api/agents/dismissals                    200 {"restored":3}

GET    /api/uploads/index                        200 {"runs":[{id,count,latest_ts}…]}
GET    /api/uploads/aabbccddeeff/shots           200 {"id":…,"shots":[…]}
GET    /api/uploads/ZZZZ/shots                   400 {"error":"bad id"}
GET    /api/uploads/AABBCCDDEEFF/shots           400 {"error":"bad id"}   (case gate holds)
GET    /api/uploads/aaaaaaaaaaaa/shots           404 {"error":"not found"}
GET    /api/uploads/aabbccddeeff/missing.png     404 {"error":"not found"}
GET    /api/uploads/aabbccddeeff/..%2F..%2Fetc%2Fpasswd
                                                 404 {"error":"not found"}   traversal blocked by safeName()
```

Error paths are **loud, not silent**: with a deliberately broken `DATABASE_URL` the routes
answered `500 {"error":"dismissals: list failed","step":"list","message":"SASL: …"}` — never
a 200 with an empty set. That is the policy this project asks for, honoured.

### Scope

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|FileExplorerPanel|routes/files'
  clean — none of the forbidden files differ
$ git diff --stat main -- forge-control-web/app/desktop/chat/rehype-forge-allowlist.ts
  (empty)
```

Phase-6 commits (`314b4aa..HEAD`) touch 63 files, all inside the declared set: chat
transcript rendering, live/team panels, `routes/agents.ts` + `lib/dismissals.ts` +
`lib/uploads-index.ts`, migration 0041, the settings/integrations lane, and check scripts.

### Both themes

Verified from the builders' `browser-ui/` and `dismissal-ui/` PNGs **and independently**:
`/live` dark + light, team panel dark + light, transcript screenshot block collapsed and
expanded in both, `/live` shot strip in both. Tokens hold; no hardcoded colour appears; the
raw-colour gate agrees.

---

## Findings

### 1. BLOCKER (A4) — the team panel's "N hidden · show" is a global wipe wearing a peek's label

`forge-control-web/app/desktop/team/ChatTeamPanel.tsx:554-573`

The button is labelled `{hiddenCount} hidden · show` (:573) and its `onClick` is
`restoreAll` (:556) — which issues `DELETE /api/agents/dismissals`, deleting **every row of
`ui_dismissals`**, for every project and both surfaces.

**Failure scenario, executed.** Team panel open on chat `bfd1283a…`, 16 rows. I dismissed
one settled row → 15 rows, label `1 hidden · show`. Clicked it. Rows went to **16** and
`GET /api/agents/dismissals` returned `{"node_ids":[],"count":0}` — the 11 unrelated
dismissals I had made from `/live` moments earlier were gone too. No confirm, no undo, no
peek. In Konrad's use: a week of accumulated dismissals across projects, wiped by one click
on a control that says "show".

This is not purely inherited. On `main` `restoreAll` cleared one chat's localStorage key;
**this phase made the store global and server-side**, so the same unchanged line now has a
fleet-wide blast radius. `/live` got the correct affordance in the same phase
(`AgentActivity.tsx:704, 787-806`: `setPeek` toggle → `DISMISSED` section → per-row
`[data-live-restore]`), which is exactly what A4 describes. The team panel did not.

**Fix.** Give `ChatTeamPanel` the `/live` affordance: `hidden` rows kept out of the main
list, a `peek` boolean, a `DISMISSED` group rendering them muted with a per-row restore
(`restore(id)`, already exported by `useDismissals`). Keep `restoreAll` if wanted, but
behind its own explicitly-labelled control ("restore all") — never behind the word "show".
Mirroring `AgentActivity.tsx:770-915` is the whole change.

### 2. Non-blocking — one glyph, two verbs, on adjacent rows

`forge-control-web/app/desktop/team/TeamRow.tsx:568-613`

In the team panel a settled row's ✕ hides; a running row's ✕ **terminates the agent**
(`title="Terminate this agent — click again to confirm"`), and since round 1353 flipped
`capabilities.control_plane.terminate` it is enabled rather than greyed. A1 as written says
a running row has no X. **I accept the deviation in writing:** it is a different, pre-
existing, capability-gated verb behind a two-click arm ("sure?"), the builder disclosed it
unprompted in `dismissal-ui/README.md`, and failing phase 6 over it would be re-litigating
a control Konrad already approved. Worth Konrad's eye at some point that the two verbs share
a glyph on adjacent rows; not a reason to hold this phase.

### 3. Non-blocking observation — dismissed rows still spend the `LIMIT 60` budget

`forge-control/src/routes/agents.ts:135-168`

`fetchActiveRows` LEFT JOINs `ui_dismissals` without filtering (deliberate, and correct — the
panel needs the hidden rows to count them), but `LIMIT 60` is applied before the client hides
anything. Dismiss 60 recent rows and the RECENT section empties. Bounded in practice: the
`ORDER BY` puts `running/paused/stuck/queued` first, so live work can never be squeezed out —
only history. Worth a line in the round's notes, not a fix this cycle.

---

## What the deploy phase must know

`VERDICT: NEEDS_FIXES` on line 1 — round 1355 must not deploy. When finding 1 is fixed, the
deploy phase must still apply `db/migrations/0041_ui_dismissals.sql` to `content_forge`
**before** restarting forge-control: `/api/agents` and `/api/chat/:id/team` LEFT JOIN
`ui_dismissals`, so a restart against a database without that table 500s every agents query.
The migration file's own header says so; it is repeated here because it is the one ordering
constraint in this phase that a deploy can get wrong.

Review harness left behind (nothing in the repo, nothing live touched): scratch database
`scratch1354` on 127.0.0.1:**5434** (the local cluster, not the app's 5432), worktree routers
on :7798, worktree web builds on :7861/:7862, `/tmp/r1354-*`. Dropping a database is a
destructive op and was not briefed, so `scratch1354` is left in place; nothing reads it.
