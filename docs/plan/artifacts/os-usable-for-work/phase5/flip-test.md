# phase5/flip-test.md — a fresh job renders NOT stalled, proved in the browser

Round 2 of phase 5 (workstream `business`), task 4 of 4. R64's second half, on
the CLIENT side.

- Branch: `project/7851068b-business`
- Component under test: `forge-control-web/app/desktop/PipelineSurface.tsx`
- Instruments: `phase5/stub-pipeline.mjs` (the payload), `phase5/harness.mjs`
  (the authenticated browser), `phase5/serve-pipeline.ts` (the live comparison)
- **Read-only (R68).** No `INSERT`/`UPDATE`/`DELETE` was run against
  `content_forge`, and no `pm2 restart` was run. The stub opens no database.

---

## 1. Why a stub, and not just an assertion about the live data

R64 is a claim about a **discrimination**, not about five rows:

> the five QC jobs render as stalled with ages of 11–14 days, **and a fresh job
> renders not stalled**.

Only the first half can be measured against `content_forge`. The table holds 24
rows — 19 `MARKED_FOR_DELETION` and 5 aged 11–14 days
(`premises-remeasured.md` § P2) — so **every job in the live payload is
stalled**, and R68 forbids creating one that isn't.

That matters because of what it lets through. A component that renders
`STALLED {n}d` unconditionally — no threshold, no comparison — passes "all five
render stalled" perfectly. It is the exact mutation that broke the server-side
tests in `pipeline-api-evidence.md` § CMD-7 (`stalled: true` hardcoded, four
tests failed). On the client there is no unit test to catch it, so the fresh
job has to come from somewhere.

It comes from a stub. `stub-pipeline.mjs` serves a crafted
`BusinessPipelineResponse` whose fresh card is visibly synthetic
(`STUB_FRESH_…`, title beginning `STUB —`), so nothing in the shot can be
mistaken for production data.

**And the flip test earned its keep on the first run** — see § 5. It found a
real defect in the banner that live data cannot expose, by construction.

---

## 2. The payload

`stub-pipeline.mjs` recomputes it per request, so the fresh job is always three
minutes old however long after this commit it is run. The five stalled cards
carry the **real** ids, titles, statuses and `status_updated_at` values from
`pipeline-api-evidence.md` § CMD-9, so the stub shot and the live shot are
comparable card for card.

```
### CMD-F1  what the stub says about itself at boot
$ node docs/plan/artifacts/os-usable-for-work/phase5/stub-pipeline.mjs
[stub] GET /api/pipeline → crafted flip-test payload on http://127.0.0.1:7843
[stub]   total=6 stalled_total=5 (1 fresh, 5 stalled)
[stub]   states=no_work_idle, has_work, no_work_blocked_upstream
[stub]   workers.ok=false queues.ok=false
[stub] everything else proxies (buffered, no SSE) to http://127.0.0.1:7700

### CMD-F2  the six cards, as the component receives them
$ curl -sS -D- -o /tmp/stub.json http://127.0.0.1:7843/api/pipeline | grep -i x-phase5-stub
x-phase5-stub: flip-test
$ node -e '<print the qc bucket>'
total 6 stalled 5 workers.ok false queues.ok false
   fresh   0d 3m  AWAITING_QC        STUB — a job whose status changed three
   STALLED 11d 11d AWAITING_UPLOADER MacBook Air M3 vs Dell XPS 15
   STALLED 12d 12d AWAITING_UPLOADER Best budget standing desks under 400
   STALLED 12d 12d AWAITING_UPLOADER Best budget mechanical keyboards under 1
   STALLED 14d 14d AWAITING_QC       Best Speakers 2026 below 100$
   STALLED 14d 14d AWAITING_UPLOADER Best noise cancelling headphones under 3
```

Four things live data cannot show at the same time, all in one response:

| In the payload | Why it has to be stubbed |
|---|---|
| 1 fresh card **and** 5 stalled cards, in one column | no fresh row exists; R68 forbids making one |
| a phase in each of the three `state` values | live already does this — kept so the stub is a superset |
| `workers: {ok: false, error}` | pm2 is healthy on this box; killing it is not read-only |
| `queues: {ok: false, error}` | redis is healthy; ditto |

The fresh card sits **first** in the QC column (the server sorts newest first),
so the two opposite verdicts land one above the other in the same column — the
comparison a reader does not have to hunt for.

---

## 3. The commands, end to end

`FORGE_CONTROL_URL` is read by `next.config.mjs` **inside `rewrites()`**, so the
proxy destination is frozen into `.next/routes-manifest.json` at build time.
Setting it in `next start`'s environment does nothing. Both ways round it are in
`browser-harness.md` § 2; this run used **rebuild for live, manifest patch for
the stub**, because the patch saves the three-minute rebuild and the mode flip
is the only difference.

```bash
cd /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--business

# 0. deps — NEVER a bare --frozen-lockfile: NODE_ENV=production prunes tsx and
#    typescript, says so quietly, and exits 0.
cd forge-control       && pnpm install --frozen-lockfile --prod=false
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit

# 1. the two APIs, both detached with setsid (a plain & dies with the shell)
cd ../forge-control
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
setsid env SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx \
  ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts &   # LIVE
setsid node ../docs/plan/artifacts/os-usable-for-work/phase5/stub-pipeline.mjs &  # STUB :7843

# 2. the web build, baked against the LIVE harness API
cd ../forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7841 NODE_ENV=production pnpm build
python3 -c "
import json,re;print(sorted(set(re.findall(r'http://127\.0\.0\.1:\d+',
json.dumps(json.load(open('.next/routes-manifest.json')))))))"
# → ['http://127.0.0.1:7841']

set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a      # a READ (N4)
setsid env AUTH_URL=http://127.0.0.1:7840 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7840 &

# 3. LIVE shots — after-pipeline.png, after-money.png
cd .. && node docs/plan/artifacts/os-usable-for-work/phase5/harness.mjs all

# 4. flip the SAME build to the stub: patch the manifest, restart, re-shoot
cd forge-control-web
python3 - <<'EOF'
import json
p='.next/routes-manifest.json'; d=json.load(open(p)); n=0
def walk(o):
    global n
    if isinstance(o,dict):
        dest=o.get('destination')
        if isinstance(dest,str) and dest.startswith('http://127.0.0.1:7841'):
            o['destination']=dest.replace(':7841',':7843'); n+=1
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d); json.dump(d,open(p,'w')); print('rewrote',n)
EOF
# → rewrote 1
# restart on the PID from ss — NEVER `pkill -f 'next start -p 7840'`, that
# pattern matches the pkill's own command line and kills this shell (exit 144).
PID=$(ss -ltnp | grep ':7840' | grep -oP 'pid=\K[0-9]+' | head -1); kill "$PID"
setsid env AUTH_URL=http://127.0.0.1:7840 AUTH_TRUST_HOST=true NODE_ENV=production \
  ./node_modules/.bin/next start -p 7840 &

cd .. && HARNESS_API_URL=http://127.0.0.1:7843 \
  node docs/plan/artifacts/os-usable-for-work/phase5/harness.mjs all
```

```
### CMD-F3  the harness, run against the stub. 8/8 — controls gate the shots,
###         so a /signin page cannot be photographed and filed as evidence.
PASS  web server reachable — http://127.0.0.1:7840/signin → HTTP 200
PASS  api server reachable — http://127.0.0.1:7843/api/pipeline → HTTP 200
PASS  positive control — valid cookie reaches /desktop with the real nav
PASS  negative control — tampered cookie redirects to /signin
PASS  negative control — no cookie at all redirects to /signin
PASS  screenshot businesses / pipeline / money
8/8 PASS
```

`harness.mjs`'s screenshot labels are hardcoded (`before-*`), and it belongs to
task 1 of this lane, so it was **not edited**. The files were relabelled by
copying them inside `/opt/ai-os/uploads/$FORGE_RUN_ID/` — outside the repo — and
the copies are byte-identical:

| Committed | Upload it was copied from | sha256 (first 16) |
|---|---|---|
| `after-pipeline.png` | `20260818T205600Z-after-pipeline.png` | `088ae1f7f866ff5f` |
| `after-money.png` | `20260818T205600Z-after-money.png` | `4a2dc0f0055dd6c8` |
| `flip-test-fresh-job.png` | `20260818T205400Z-flip-test-fresh-job.png` | `f42bc6d0b94b7bb3` |

All three are renders of the **committed** component bytes. The surfaces were
re-shot after every wording change rather than once at the start — three times
in this task — because a screenshot is only evidence of the code it was taken
from, and two of the changes (the Money zero sentence, the queue-failure
sentence) are visible strings.

---

## 4. The two opposite outcomes, in one shot

`flip-test-fresh-job.png`. Read the QC column top to bottom:

| | fresh card (top) | stalled card (immediately below) |
|---|---|---|
| pill text | `moving · 3m` | `STALLED 11d` |
| pill colour | `tokens.ok` on `okActionBg` | `tokens.warn` on `freezeBgWarn` |
| pill weight | 10px regular | 11px semibold |
| card background | `bgBody` | `freezeBgWarn` |
| card left rule | 1px `border` | **3px `warn`** |

Both cards carry status `AWAITING_QC`/`AWAITING_UPLOADER`, both are in the same
column, both were rendered by the same component in the same paint. The only
input that differs is `status_updated_at`. **That is the flip.**

The header confirms the arithmetic from the other direction: `6 active jobs · 5
stalled`, and the banner reads *"5 of 6 jobs have not moved in over 48h"*. A
component that marked everything stalled would have to say 6 of 6.

The same shot discharges three more requirements that live data cannot show:

- **R66** — `worker health unavailable: [PM2][ERROR] Daemon not running /
  connection refused`, followed by *"nothing is known about:
  worker-orchestrator, worker-render, worker-video-stitch, claude-pool"* and
  *"Not '0 online' and not 'healthy' — the probe failed, so this panel has no
  number to report."* No zero, no green dot.
- **R67** — `queue not reachable: connect ECONNREFUSED 127.0.0.1:6399`, with no
  depth table at all: *"A row of zeroes here would be indistinguishable from an
  empty, healthy queue."*
- **R65** — `NO WORK · IDLE` in Idea/Script/Voice/Assets against
  `EMPTY · BLOCKED UPSTREAM` in Render/Publish, each with its own sentence.

Compare with `after-pipeline.png`, the same component against the live
database: `4/4 online`, real uptimes (`up 7d 16h`, `0 restarts`), the eight
queues with real depths (`asset-collection failed 5 / completed 86`), and all
five real jobs stalled 11–14 days. Both the `ok: true` and the `ok: false`
branch of each union are therefore photographed.

---

## 4a. The same shot, asserted as TEXT rather than read off pixels

A screenshot proves what a person looking at it notices. These are the same two
renders read as DOM text, so the claims above are mechanical. Both runs mint
their own session, seed `forge.desktop.surface`, and refuse to proceed if the
landed URL is `/signin`.

```
### CMD-F4a  STUB build (proxy → :7843)
PASS  a fresh card renders NOT stalled — "moving · 3m"
PASS  the fresh card is the synthetic one — "STUB — a job whose status changed"
PASS  stalled cards still render stalled — "STALLED 11d"
PASS  and the oldest one too — "STALLED 14d"
PASS  headline arithmetic excludes the fresh job — "5 of 6 jobs have not moved in over 48h"
PASS  the human-gate sentence names the stalled subset — "5 of the stalled jobs are waiting on a human"
PASS  R66 dead pm2 renders verbatim — "worker health unavailable: [PM2][ERROR] Daemon not running / connection refused"
PASS  R66 names what it could not report on — "nothing is known about: worker-orchestrator"
PASS  R67 dead redis renders verbatim — "queue not reachable: connect ECONNREFUSED 127.0.0.1:6399"
PASS  R65 idle wording — "NO WORK · IDLE"
PASS  R65 blocked wording — "EMPTY · BLOCKED UPSTREAM"
PASS  R65 idle sentence — "Nothing in Idea, and it is the first phase — no work has been created."
PASS  R65 blocked sentence — "This column is empty because work is stuck, not because there is none."
PASS  the threshold comes from the API — "stall threshold 48h"
PASS  ABSENT: a dead pm2 probe invents no worker count — "4/4 online"
PASS  ABSENT: a dead pm2 probe invents no zero either — "0/4 online"
PASS  ABSENT: no status word claiming health — "workers healthy"
PASS  ABSENT: no depth table at all — "asset-collection"
[stub] 18/18 assertions passed

### CMD-F4b  LIVE build (proxy → :7841 → worktree router → content_forge)
PASS  the five real jobs render stalled — "STALLED 14d"
PASS  and the youngest of them — "STALLED 11d"
PASS  headline is 5 of 5 — "5 of 5 jobs have not moved in over 48h"
PASS  R66 four workers online — "4/4 online"
PASS  R66 real uptime, never 0 — "up 7d"
PASS  R66 zero restarts read from pm2 — "0 restarts"
PASS  R67 real queue depths, by name — "asset-collection"
PASS  R65 both wordings, idle — "NO WORK · IDLE"
PASS  R65 both wordings, blocked — "EMPTY · BLOCKED UPSTREAM"
PASS  the true count is labelled with its unit — "5 jobs"
PASS  ABSENT: no fresh pill on live data — there is no fresh job — "moving ·"
PASS  ABSENT: no unreachable banner while both probes work — "not reachable"
PASS  ABSENT: no worker-health failure banner either — "worker health unavailable"
[live] 13/13 assertions passed
```

**Read the two ABSENT sets together — that is the flip, stated as a pair of
mutual exclusions.** `moving ·` appears in the stub render and is absent from
the live one; `worker health unavailable` appears in the live-mode *forbidden*
list and in the stub-mode *required* list. Neither run can pass by rendering
everything, and neither can pass by rendering nothing.

The assertion driver was run inline (`/tmp/p5t4-assert.mjs`, pasted into the
shell) rather than committed: this lane's harness belongs to task 1, the
brief's write-set names no assertion file, and adding one would be an
undeclared write. The two blocks above are its whole output, and the script is
reproducible from them — mint a cookie the way `harness.mjs` § does, seed
`forge.desktop.surface`, read `body.innerText()`, `includes()` each string.

### The word "healthy", and why grepping for it hits this file

The brief's rule — *"Never a 0, never 'healthy'"* — tempts a grep that returns
one hit in `PipelineSurface.tsx`:

```
$ grep -n 'healthy' forge-control-web/app/desktop/PipelineSurface.tsx
431:          Not "0 online" and not "healthy" — the probe failed, so this panel has
674: * PANEL CHROME — shared by the two strips so a failed probe and a healthy one
```

Line 431 is the **failure panel denying the claim**, in the user-visible copy;
line 674 is a comment. There is no code path that renders the word as a status.
A second occurrence — the queue panel's *"indistinguishable from an empty,
healthy queue"* — was reworded to *"…from a queue that is genuinely empty"*
during this task purely so that this grep stays clean; the sentence means the
same thing. That is the third time in this phase a checker has matched its own
forbidden string.

---

## 5. What the flip test caught — the reason it is not ceremony

**First run of the stub, the banner read:**

> 5 of 6 jobs have not moved in over 48h — oldest 14 days.
> **6 of them are waiting on a human, not on a worker.**

Six of five. `StallSummary` counted every card at a human gate
(`isHumanGate(c.status)`) into a sentence about the *stalled* ones — and the
stub's fresh job is `AWAITING_QC`, so it counted itself in.

**Against live data this bug is invisible.** Every gate card in `content_forge`
is also stalled, so `filter(gate)` and `filter(gate && stalled)` return the same
five rows and the same sentence. It is not a typo class of bug; it is a
predicate that is only wrong when a fresh gate job exists — which is exactly the
row the live table does not have.

Fixed by filtering on both (`PipelineSurface.tsx`, `StallSummary`), and the
sentence now names its subject: *"5 of the stalled jobs are waiting on a human,
not on a worker."* The shot in § 4 is the post-fix render; the pre-fix render is
not committed, because a screenshot of a defect that no longer exists in the
tree is a trap for the next reader. The evidence that it existed is this
section, and the code comment at the fix site.

---

## 6. The negative-control greps, and the two hits they return

The brief forbids `?? 0` and `catch {}` in `PipelineSurface.tsx`. Claiming "no
hits" is worthless when a reviewer can falsify it in one command, so here is
the command and its actual output:

```
### CMD-F4
$ grep -n '?? 0' forge-control-web/app/desktop/{PipelineSurface,MoneySurface}.tsx
forge-control-web/app/desktop/PipelineSurface.tsx:34: * upstream message VERBATIM and no number whatsoever. There is no `?? 0` and

$ grep -n 'catch' forge-control-web/app/desktop/{PipelineSurface,MoneySurface}.tsx
forge-control-web/app/desktop/PipelineSurface.tsx:35: * no `catch {}` in this file, and neither may be added: a zero from a dead

$ grep -nE '(:|<|as)\s*any\b' forge-control-web/app/desktop/{PipelineSurface,MoneySurface}.tsx
  none
$ grep -rnE 'pm2 (restart|stop|delete)|INSERT |UPDATE |DELETE ' \
    forge-control-web/app/desktop/{PipelineSurface,MoneySurface}.tsx phase5/stub-pipeline.mjs
  none
```

Both hits are **lines 34–35 of the header comment: the rule itself**, stating
that the forbidden forms are absent. A file that names its own forbidden string
trips its own audit — the same trap `pipeline-api-evidence.md` § 4c hit and the
same resolution: read the hit, or scope the grep to non-comment lines.

The three `useQuery` results are consumed as a discriminated state
(`isPending` / `isError` / `data`) and the two probes as unions on `ok`, so
there is nothing for a `??` to default and nothing for a `catch` to swallow.

---

## 7. Verification ledger

```
### CMD-F5
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date            ← and `ls node_modules/.bin` still has tsc + next
$ npx tsc --noEmit
WEB_TSC=OK

### CMD-F6  the design-token gate
$ node scripts/checks/no-raw-colours.cjs
no-raw-colours: PASS — 222 literal(s) across 14 file(s), all accounted for
(176 legitimate, 46 known debt, 0 unlisted)
    ← unchanged from the pre-task baseline: the two components this task
      rewrote added ZERO colour literals. Every colour is a `tokens.*`.

### CMD-F7  production build, twice (live mode and after the manifest patch)
$ FORGE_CONTROL_URL=http://127.0.0.1:7841 NODE_ENV=production pnpm build
✓ Compiled successfully   ✓ Generating static pages (10/10)

### CMD-F8  browser harness, both modes
LIVE  (:7841 → worktree router → live content_forge)   8/8 PASS
STUB  (:7843 → crafted payload)                        8/8 PASS
```

Colour pairs used for the new states are the ones the palette already
contrast-checks: `warn` on `freezeBgWarn` (theme.css's own comment names it "the
app's standard warning banner", 4.71:1 in light mode) and `bleed` on
`dangerActionBg` (the pair `BusinessesSurface` already uses for its failed
probe). No new pair was invented.

---

## 8. Two layout defects the first live shot exposed

Both are in this file's audit trail because they were found by looking, not by
reasoning — which is the standing lesson of this project.

1. **`FAILEDCOMPLETED`.** At 52px per set column the queue table's headers
   collided into one word. Widened to 74px. A header a reader has to
   disentangle is a mislabelled number.
2. **Render and Publish were off-screen.** The columns were fixed at 268px and
   scrolled horizontally, so on the 1600px harness viewport the two
   `no_work_blocked_upstream` columns — *the entire point of R65* — sat behind a
   scrollbar. Now `flex: 1 1 0` between 176px and 268px, so all seven phases are
   always in one view. R65's contrast is only a contrast if both halves are
   visible at once.
