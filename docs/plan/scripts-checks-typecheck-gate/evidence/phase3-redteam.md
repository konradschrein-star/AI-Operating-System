# Phase 3 RED TEAM — did the six fixes preserve the assertions, or merely satisfy the compiler?

**Tip reviewed:** `3b907002380d6b107138a9dddfbe6059cdf688c0` (branch `project/b7ab4c57`).
Re-read immediately before the blocker below was written — unchanged.

**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
(the per-project layout). `docs/plan/03-quality.md` also exists; both paths were
checked, and the per-project one governs this project — its §3 "Phase 3 gate"
block is the one executed in §G below.

**Briefs carried:** A1 (family B, R33 mandatory) and A3 (all six), verbatim from
03-quality.md §6.

**Rules observed:** no instrument, app file or config was edited. Every mutation
below was applied, measured, and reverted with `git checkout --`, and
`git status --porcelain` is shown empty after each. One server was started and
killed. The single file written by this review is this one.

**Dependencies, before any gate:**

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 871ms using pnpm v9.15.9

$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 688ms using pnpm v9.15.9
```

**Baseline, before any mutation** — the invocation is phase 1's, verbatim:

```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/<f>

check-orientation.ts       exit=0   ALL PASS — orientation strip derivation
check-dismiss-peek.tsx     exit=0   ALL PASS — dismissal peek affordance
check-stop-affordance.tsx  exit=0   ALL PASS — stop affordance
check-team-confirm.ts      exit=0   ALL PASS — team confirm machine
check-team-rows.ts         exit=0   ALL PASS — team row model
```

---

## A. BRIEF A1 — is `kind` inert in `check-orientation.ts`?

### A.1 The attack: mutate the fixture's `kind` to each of the five legal members

Three fixture sites carry a `kind`: the manager (`check-orientation.ts:135`), the
worker `RUN_A` (`:139`), and the sub-agent `SUB` (`:142`). Each was swept
through all five members of `TeamNodeKind` independently.

**Command** (one `sed` per member, re-running the instrument each time, reverted
with `git checkout --` after each sweep):

```bash
for k in operator worker cron unknown subagent; do
  sed -i "135s/kind: \"[a-z_]*\"/kind: \"$k\"/" scripts/checks/check-orientation.ts
  (cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts)
done
```

**Full output — manager, line 135:**

```
  manager: node({ id: "manager-run", kind: "operator" }),
  manager kind=operator -> exit=0 | final line: ALL PASS — orientation strip derivation
  manager: node({ id: "manager-run", kind: "worker" }),
  manager kind=worker -> exit=0 | final line: ALL PASS — orientation strip derivation
  manager: node({ id: "manager-run", kind: "cron" }),
  manager kind=cron -> exit=0 | final line: ALL PASS — orientation strip derivation
  manager: node({ id: "manager-run", kind: "unknown" }),
  manager kind=unknown -> exit=0 | final line: ALL PASS — orientation strip derivation
  manager: node({ id: "manager-run", kind: "subagent" }),
  manager kind=subagent -> exit=1 | final line: 1 FAILURE(S) — orientation strip derivation
```

**Full output — worker `RUN_A`, line 139:**

```
  RUN_A kind=operator -> exit=0 | ALL PASS — orientation strip derivation
  RUN_A kind=worker   -> exit=0 | ALL PASS — orientation strip derivation
  RUN_A kind=cron     -> exit=0 | ALL PASS — orientation strip derivation
  RUN_A kind=unknown  -> exit=0 | ALL PASS — orientation strip derivation
  RUN_A kind=subagent -> exit=1 | 6 FAILURE(S) — orientation strip derivation
```

**Full output — sub-agent `SUB`, line 142:**

```
  SUB kind=operator -> exit=1 | 2 FAILURE(S) — orientation strip derivation
  SUB kind=worker   -> exit=1 | 2 FAILURE(S) — orientation strip derivation
  SUB kind=cron     -> exit=1 | 2 FAILURE(S) — orientation strip derivation
  SUB kind=unknown  -> exit=1 | 2 FAILURE(S) — orientation strip derivation
  SUB kind=subagent -> exit=0 | ALL PASS — orientation strip derivation
```

```
$ git status --porcelain
(empty)
```

**Verdict — A.1: the builder's finding is CONFIRMED, and now measured rather
than argued.** `kind` carries exactly **one bit** in this instrument: *subagent,
or not*. No assertion in the file distinguishes `operator` from `worker` from
`cron` from `unknown`; all four are interchangeable at every one of the three
fixture sites. The pre-fix literals `"operator_chat"` and `"project_worker"`
were non-members, and — because a non-member is also not `"subagent"` — they
landed on the same side of the only distinction the file makes. That is the
complete explanation for why this instrument printed `ALL PASS` for months over
a type that never existed, and why it prints it identically after the repair.

R26 outcome **1** is the honest outcome and the commit claims it correctly; the
coverage limitation is stated plainly in `check-orientation.ts:150-173` rather
than hidden behind the green tick. That is the right call.

### A.2 The attack: break the derivation the check is NAMED for, and establish independently that it FAILS

R26's verify clause makes this the reviewer's job, not the builder's. Three
mutations of `forge-control-web/app/desktop/chat/OrientationStrip.tsx`, all mine
except where noted.

**A.2.a — the phase arithmetic (mine).** `floor` → `ceil` at
`OrientationStrip.tsx:214`:

```
$ perl -0pi -e 's/  const phase = Math\.floor\(round \/ 100\) \* 100;/  const phase = Math.ceil(round \/ 100) * 100;/' forge-control-web/app/desktop/chat/OrientationStrip.tsx
-  const phase = Math.floor(round / 100) * 100;
+  const phase = Math.ceil(round / 100) * 100;

$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts
FAIL  round 601 → phase 600→700
FAIL  round 603 → phase 600→700
FAIL  round 699 → phase 600→700
FAIL  round 42 → phase 0→100
FAIL  …and derives phase 600 from round 601
FAIL  …with 700 next
6 FAILURE(S) — orientation strip derivation
exit=1
```

**A.2.b — the nested sub-agent guard (mine).** Delete `sub.kind !== "subagent"`
from the run branch at `OrientationStrip.tsx:249`:

```
-      if (subagentId === undefined && sub.kind !== "subagent" && sub.id === runId) {
+      if (subagentId === undefined && sub.id === runId) {

FAIL  a run id is never satisfied by a sub-agent whose id happens to equal it
1 FAILURE(S) — orientation strip derivation
exit=1
```

**A.2.c — the root-level guard (mine). THIS ONE SURVIVES.** Delete
`node.kind !== "subagent"` from the roots loop at `OrientationStrip.tsx:237`:

```
-      if (node.kind !== "subagent" && node.id === runId) return node;
+      if (node.id === runId) return node;

ALL PASS — orientation strip derivation
exit=0
```

**A.2.d — the sub-agent branch's positive guard (mine). THIS ONE SURVIVES TOO.**
Delete `sub.kind === "subagent" &&` from the conjunction at
`OrientationStrip.tsx:243`:

```
-        sub.kind === "subagent" &&

ALL PASS — orientation strip derivation
exit=0
```

```
$ git status --porcelain
(empty)
```

**Verdict — A.2: the fixed instrument DOES fail when the derivation it is named
for is broken (A.2.a, A.2.b), established independently of the builder. But two
of the three `kind` predicates in the subject are mutation-uncovered.** See
finding 2. The instrument's `kind` coverage is one bit on the FIXTURE side and
one predicate out of three on the SUBJECT side.

---

## B. ATTACK 1 — `hidesRows` is behavioural. Flip it across the boundary.

`confirm.ts:170-173`: `needsConfirm` returns `i.hidesRows > 1` for a settled,
non-`widerReach` row — `<= 1` is the one-click path, `> 1` is the two-click
confirm machine. Every `hidesRows` value the builder introduced was flipped
across that boundary and back.

### B.1 `check-dismiss-peek.tsx:135` — INERT

```
$ sed -i "135s/hidesRows: [0-9]*,/hidesRows: <v>,/" scripts/checks/check-dismiss-peek.tsx
  hidesRows=2 -> exit=0 | ALL PASS — dismissal peek affordance
  hidesRows=0 -> exit=0 | ALL PASS — dismissal peek affordance
  hidesRows=5 -> exit=0 | ALL PASS — dismissal peek affordance
```

### B.2 `check-stop-affordance.tsx:130` — INERT

```
  hidesRows=2 -> exit=0 | ALL PASS — stop affordance
  hidesRows=0 -> exit=0 | ALL PASS — stop affordance
  hidesRows=5 -> exit=0 | ALL PASS — stop affordance
```

### B.3 `check-team-confirm.ts:221` (the sustained stream) — INERT, and the builder says so

```
  hidesRows=165 -> exit=0 | ALL PASS — team confirm machine
  hidesRows=0   -> exit=0 | ALL PASS — team confirm machine
  hidesRows=2   -> exit=0 | ALL PASS — team confirm machine
```

The comment at `:213-220` states this outright, gives the mechanism
(`needsConfirm` returns true on `!settled` at `confirm.ts:171` before it ever
reads `hidesRows`), and cites the same 165 measurement I reproduced above. That
is a correct fix, correctly reasoned, and honestly documented. **Not a finding.**

### B.4 `check-team-rows.ts:95` (the new default) — INERT within this file's scope

```
  default hidesRows=2   -> exit=0 | ALL PASS — team row model
  default hidesRows=0   -> exit=0 | ALL PASS — team row model
  default hidesRows=165 -> exit=0 | ALL PASS — team row model
```

### B.5 CONTROL — the boundary IS covered, elsewhere in the same file

`TODAY`/`LATER` at `check-team-confirm.ts:87` and `:89` are pre-existing (on
`main`, not the builder's). Flipping either across the boundary fails:

```
const TODAY = { canTerminate: false, hidesRows: 2 } as const;
  -> exit=1 | FAIL  X on a settled row dismisses immediately
             FAIL  …even while another row is armed
             2 FAILURE(S) — team confirm machine

const LATER = { canTerminate: true, hidesRows: 2 } as const;
  -> exit=1 | FAIL  …and capabilities are irrelevant to it (nothing leaves the browser)
             1 FAILURE(S) — team confirm machine
```

(`check-team-confirm.ts:446`, also pre-existing, is inert at 0 and 2.)

```
$ git status --porcelain
(empty)
```

**Verdict — B: `hidesRows` is inert at all four sites the builder introduced.**
At `check-team-confirm.ts:221` and `check-team-rows.ts:95` this is correctly
diagnosed and stated in the source. At `check-dismiss-peek.tsx:135` and
`check-stop-affordance.tsx:130` the accompanying comments claim the opposite.
See finding 1, and §F for the measured consequence.

---

## C. ATTACK 2 — did the `row()` default in `check-team-rows.ts` flatten a caller?

**Command and full output:**

```
$ grep -n 'row(' scripts/checks/check-team-rows.ts
83:function row(over: Partial<TeamRow> & { node: TeamNode }): TeamRow {
520:  const settled = row({ node: node({ id: "s", settled: true, working_ms: 130_000 }) });
533:  const running = row({
564:  const settledNull = row({
567:  const runningNull = row({
592:  const zero = row({ node: node({ id: "z", settled: true, working_ms: 0 }) });
```

Five call sites. None passes `hidesRows`. The default sits at `:95`, **before**
the `...over` spread at `:97`, so a caller that later means a cascade still
wins. Flipping the default to 0, 2 and 165 changes no outcome (§B.4) because the
section these rows feed is `interpolatedWorkingMs`, which reads
`displayWorkingMs` and `node.settled`.

**Verdict — C: NO assertion was deleted or flattened.** The builder's claim
("no call site does today, which is why this default overrides no assertion") is
independently verified correct, including the reason it gives for preferring a
default over a tightened parameter type. Attack failed. **Not a finding.**

---

## D. ATTACK 3 — `working_ms_source`: swap to the other legal member

### D.1 The mutation

```
$ sed -i "<L>s/working_ms_source: .*,/working_ms_source: <v>,/" scripts/checks/<f>

check-dismiss-peek.tsx:110     "rollup" -> exit=0 | ALL PASS — dismissal peek affordance
check-dismiss-peek.tsx:110     null     -> exit=0 | ALL PASS — dismissal peek affordance
check-stop-affordance.tsx:104  "rollup" -> exit=0 | ALL PASS — stop affordance
check-stop-affordance.tsx:104  null     -> exit=0 | ALL PASS — stop affordance
```

A source-wide grep confirms why: outside the two comment blocks the builder
added, **neither instrument mentions `working_ms_source` at all.** The field is
never read. It is inert against every value in the union and against `null`.

### D.2 Is `"thread"` the member a leaf worker node can actually carry?

Read directly, not taken from the commit message:

- `teamApi.ts:37` — `export type WorkingMsSource = "thread" | "rollup";`
- `forge-control/src/routes/chat.ts:555` —
  `working_ms_source: timing ? "thread" : null,` — this is `teamNodeFromRun`,
  the RUN-node path.
- `forge-control/src/routes/chat.ts:476-494` — `subagentWorkingTime`, which is
  the ONLY producer of `"rollup"`, and it is reached only from the sub-agent
  branch (`chat.ts:520-541`, where `kind` is hard-coded `"subagent"`).

Both fixtures are `kind: "worker"`, `subagents: []`, `working_ms: 252_000`.
A run node with a non-null `working_ms` therefore has exactly one permitted
source, and it is `"thread"`.

**Verdict — D: the member chosen is the one the system actually emits — verified
against the producer, not the union.** The fixture is now a value the wire
contract permits AND the system emits, which is the standard 03-quality.md §7
sets. The attack on the choice failed. The attack on its coverage succeeded:
see finding 3.

---

## E. ATTACK 4 — `serve-sse-808.ts`: compiling is not running

### E.1 No surviving `/dist/index.js` in either specifier

```
$ grep -n 'node_modules' scripts/checks/serve-sse-808.ts
60:import { serve } from "../../forge-control/node_modules/@hono/node-server";
61:import { Hono } from "../../forge-control/node_modules/hono";

$ grep -n 'dist/index.js' scripts/checks/serve-sse-808.ts
52: * than tidy. They used to end in `/dist/index.js`, which reaches the same
```

The one remaining occurrence is inside the header prose explaining the repair —
not an import. Both specifiers name the package directory.

### E.2 Parameter `c` got its type FROM the import, not from an annotation

`serve-sse-808.ts:101` reads `app.all("*", async (c) => {` — no annotation
anywhere in the file. To prove `c` is genuinely typed rather than silently
`any`, I planted a canary that only errors if `c.req.url` is `string`:

```
$ sed -i "101a\\  const _canary: number = c.req.url; void _canary;" scripts/checks/serve-sse-808.ts
$ bash scripts/checks/check-instrument-typecheck.sh

  FAIL scripts/checks/serve-sse-808.ts                  exit 2
         scripts/checks/serve-sse-808.ts(102,9): error TS2322: Type 'string' is not assignable to type 'number'.
  subjects found 42   subjects compiled 42   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
check-instrument-typecheck.sh FAILED — 1 type failure(s), ...

$ git checkout -- scripts/checks/serve-sse-808.ts
$ git status --porcelain
(empty)
```

`c.req.url` resolves to `string`. The types come from the package's `types`
field, exactly as the fix intends. (This run doubles as an independent negative
control for the gate itself: it goes red on a real type error in a real
subject.)

### E.3 The server, started and driven by me

```
$ cd forge-control && SERVE_SSE_PORT=7845 ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts &
[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
[serve-sse-808] SECRET_STORE_DIR=(default — REAL STORE, stop)

$ ss -ltnp | grep 7845
LISTEN 0  511  127.0.0.1:7845  0.0.0.0:*  users:(("node",pid=3977785,fd=31))
```

Bind line observed. All three paths the harness exists to serve, exercised:

```
=== 1. a plain proxied GET (pass-through to :7700) ===
$ curl -s -w 'http=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:7845/api/today
http=200 bytes=1062
{"date":"Tuesday 18 August","greeting":"Good afternoon, Konrad.","chips":[{"label":"6 to ship",...

=== 2. a WORKTREE-ROUTER GET (mounted locally, not proxied) ===
$ curl -s -w 'http=%{http_code} bytes=%{size_download}\n' http://127.0.0.1:7845/api/capabilities
http=200 bytes=124
{"control_plane":{"message_into_session":true,"resume_finished":true,"subagent_message":false,"stop":true,"terminate":true}}

=== 3. SSE through the proxy, 6s ===
$ timeout 6 curl -sN -H 'accept: text/event-stream' "http://127.0.0.1:7845/api/chat/<run>/events"
curl_exit=124
bytes=162975
event: snapshot
data: {"run":{"id":"07aea574-c927-42c3-ad68-c240af39913c","title":"scripts-checks-typecheck-gate · Phase 3 RED TEAM …

$ kill $SERVER; ss -ltn | grep 7845
port 7845 free — server killed
```

`curl_exit=124` is the 6s timeout killing a stream that was still open —
162,975 bytes of SSE delivered, no `arrayBuffer()` buffering, no truncation.

**Verdict — E: family C's fix is correct at the compiler AND at runtime.** The
attack — "a specifier that satisfies tsc but breaks Node's resolver" — failed.
Server binds, mounts, proxies, streams, dies on signal, releases the port.

**Note, not a finding against this phase:** my run printed
`SECRET_STORE_DIR=(default — REAL STORE, stop)`. I issued only GETs against
`/api/today`, `/api/capabilities` and an SSE read, so nothing was written. The
builder's own transcript (`instruments-still-detect.md` control 6) sets
`SECRET_STORE_DIR=/tmp/p808-store` before starting, which is the correct
hygiene; the warning is pre-existing harness behaviour, unchanged by this diff.

---

## F. ATTACK 5 — the R29 transcripts: reproduce, do not trust

### F.1 The sha pin

`instruments-still-detect.md:4` pins `5823302a8d9d78a59a99be0f6241d779e691e56f`.
That is `HEAD~1`. The only commit between it and HEAD is `3b90700`, which adds
that evidence file and nothing else:

```
$ git show --name-only --format="%H %s" HEAD
3b907002380d6b107138a9dddfbe6059cdf688c0 docs(…phase 3, D3.2): the six R29 breakage controls…
docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md

$ git diff --stat 5823302a8d9d78a59a99be0f6241d779e691e56f HEAD -- scripts/ forge-control-web/ forge-control/ tsconfig.checks.json tsconfig.checks-instruments.json
(empty)
```

**The pinned sha names a tree whose instruments and subjects are byte-identical
to HEAD's.** The pin is valid.

### F.2 Spot-check 1 — transcript #1 (`check-orientation.ts`), reproduced verbatim

```
$ perl -0pi -e 's/        sub\.id === subagentId &&\n        sub\.parent_id === runId\n/        sub.id === subagentId\n/' \
    forge-control-web/app/desktop/chat/OrientationStrip.tsx
 forge-control-web/app/desktop/chat/OrientationStrip.tsx | 3 +--
 1 file changed, 1 insertion(+), 2 deletions(-)

$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts
FAIL  the SAME sub-agent id under a DIFFERENT parent does not match
1 FAILURE(S) — orientation strip derivation
exit=1

$ git checkout -- forge-control-web/app/desktop/chat/OrientationStrip.tsx
$ git status --porcelain
(empty)
```

Transcript's summary row: *"exit 1, 1 FAILURE — 'the SAME sub-agent id under a
DIFFERENT parent does not match'"*. **Identical.**

### F.3 Spot-check 2 — transcript #2 (`check-team-confirm.ts`), line for line

```
$ perl -0pi -e 's/export const MIN_CONFIRM_MS = 500;/export const MIN_CONFIRM_MS = 150;/' \
    forge-control-web/app/desktop/team/confirm.ts

$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-confirm.ts
exit=1
```

| transcript (`instruments-still-detect.md:469-560`) | my run |
|---|---|
| `FAIL  confirm floor is 500ms — the platform multi-click window` | identical |
| `FAIL  499ms is still too fast` | identical |
| `FAIL  8 clicks 350ms apart (rage-click) → terminates` | identical |
| `FAIL  6 clicks 499ms apart → terminates` | identical |
| `FAIL  32 sub-floor click streams, restore-alls issued` | identical |
| `5 FAILURE(S) — team confirm machine` | identical |
| `exit=1` | identical |

**Line for line, in order. Nothing was described rather than run.**

### F.4 Spot-check 3 — transcript #5 (`check-stop-affordance.tsx`)

```
$ perl -0pi -e 's/            disabled=\{stopBlock !== null\}/            disabled={false}/' \
    forge-control-web/app/desktop/team/TeamRow.tsx

FAIL  canStop=true settled=true → disabled
FAIL  canStop=false settled=false → disabled
FAIL  canStop=false settled=true → disabled
FAIL  a COMPLETED row with stop:true renders a DISABLED ⏸
4 FAILURE(S) — stop affordance
exit=1

$ git status --porcelain     # after revert
(empty)
```

Transcript's summary row: *"exit 1, 4 FAILURES — incl. 'a COMPLETED row with
stop:true renders a DISABLED ⏸'"*. **Identical.**

### F.5 Every mutation breaks the SUBJECT, and every control shows an empty revert

The six mutations target `OrientationStrip.tsx`, `confirm.ts`, `teamRows.ts`,
`peek.ts`, `TeamRow.tsx` and `forge-control/src/routes/chat.ts` — app code in
every case, never an instrument. All six step-4 blocks are present and empty:

```
$ grep -n -A2 '^\$ git checkout -- ' docs/plan/…/instruments-still-detect.md
267:$ git checkout -- forge-control-web/app/desktop/chat/OrientationStrip.tsx
268-$ git status --porcelain
269-(empty above = the tree is exactly as committed)
561:$ git checkout -- forge-control-web/app/desktop/team/confirm.ts        … (empty)
948:$ git checkout -- forge-control-web/app/desktop/team/teamRows.ts       … (empty)
1289:$ git checkout -- forge-control-web/app/desktop/team/peek.ts          … (empty)
1488:$ git checkout -- forge-control-web/app/desktop/team/TeamRow.tsx      … (empty)
1611:$ git checkout -- forge-control/src/routes/chat.ts                    … (empty)
```

**Verdict — F: three of six transcripts reproduced independently, all three
identical to the recorded output. The sha pin is valid. The transcripts were
run, not written.** Attack failed.

### F.6 THE ATTACK THAT LANDED — the regression the two tsx instruments claim to catch

The claims at `check-dismiss-peek.tsx:125-128` and
`check-stop-affordance.tsx:119-123` name a specific behaviour: that at
`hidesRows: 1` the settled row's ✕ is the ONE-CLICK dismissal, and that this is
what the assertions are about. The regression that would break it is
`needsConfirm` demanding a confirm for a settled leaf — the exact anti-pattern
`confirm.ts:44-47` says "trains people to click through confirms". I mutated
`confirm.ts:173`:

```
$ perl -0pi -e 's/  return i\.hidesRows > 1; \/\/ a cascade of hides/  return i.hidesRows >= 1; \/\/ a cascade of hides/' \
    forge-control-web/app/desktop/team/confirm.ts
-  return i.hidesRows > 1; // a cascade of hides
+  return i.hidesRows >= 1; // a cascade of hides

  check-dismiss-peek.tsx         exit=0  ALL PASS — dismissal peek affordance
  check-stop-affordance.tsx      exit=0  ALL PASS — stop affordance
  check-team-confirm.ts          exit=1  3 FAILURE(S) — team confirm machine
  check-team-rows.ts             exit=0  ALL PASS — team row model
  check-orientation.ts           exit=0  ALL PASS — orientation strip derivation
  check-r1873-fixes.ts           exit=1  2 FAILURE(S) — round 1873 fixes

$ git checkout -- forge-control-web/app/desktop/team/confirm.ts
$ git status --porcelain
(empty)
```

**The behaviour IS caught — by `check-team-confirm.ts` and
`check-r1873-fixes.ts`, neither of which this phase touched. It is NOT caught by
the two instruments whose new comments say they catch it.** See finding 1.

Root cause, read rather than guessed. The `check-dismiss-peek.tsx:191-195`
assertion is:

```ts
check(
  "the ✕ names the affordance that brings the row back",
  (attr(tag(html, "data-team-x") ?? "", "title") ?? "").includes("dismissed · show"),
  true,
);
```

and `dismissTitle` (`confirm.ts:244-264`) opens with

```ts
const undo =
  "Reversible: the toast offers an undo of exactly this gesture, and every " +
  "hidden row stays listed under “N dismissed · show”.";
```

which is appended to **all three** of its return branches. The substring the
assertion matches survives every value of `hidesRows`. And
`check-stop-affordance.tsx:233-252` reads only `data-team-stop` — `disabled`,
`title`, `cursor`, `data-stop-blocked`, and `decideStopClick`. It never reads
`data-team-x`, `data-x-confirms` or `data-x-hides` at all.

---

## G. ATTACK 6 — suppression sweep, both directions

### G.1 The P-A grep, verbatim from 03-quality.md §3

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
    | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)' \
    && echo "FAIL: suppression introduced" || echo "ok: no suppressions"
ok: no suppressions
```

### G.2 By eye, for R28's eleven shapes — including the five the round-2 regex missed

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' | grep -E '^\+' \
    | grep -nE 'ts-nocheck|ts-ignore|ts-expect-error'
NONE — zero directive shapes on added lines
```

A wider sweep for `any`, `unknown`, `as`, `satisfies`, `@type`, `eslint-disable`,
`<any>` and non-null `!` over the added lines returns ten hits, **all ten of
which are prose inside the new comment blocks** — e.g. `` so `Hono` came out as
`any` (TS7016) ``, and `` `kind` is a `TeamNodeKind`: "operator" | "worker" ``.
No `/** @ts-ignore */`, no `/**@ts-ignore*/`, no JSDoc form of any directive, no
`@ts-expect-error` on a preceding line. Read, not merely grepped.

### G.3 The gate's own parser-based scan agrees

```
SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error
```

### G.4 P-B — the dependency footprint

```
$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'
(empty)
```

**Verdict — G: clean, in both directions. Attack failed.**

---

## H. ATTACK 7 — deleted assertions

```
$ git diff main...HEAD -- scripts/checks/check-orientation.ts scripts/checks/check-dismiss-peek.tsx \
    scripts/checks/check-stop-affordance.tsx scripts/checks/check-team-confirm.ts \
    scripts/checks/check-team-rows.ts scripts/checks/serve-sse-808.ts | grep -E '^-' | grep -v '^---'

-    working_ms_source: "run",
-  return { node: n, depth: 1, parentDescription: "operator chat", displayWorkingMs: n.working_ms };
-  manager: node({ id: "manager-run", kind: "operator_chat" }),
-      kind: "project_worker",
-    node({ id: RUN_B, kind: "project_worker", role: "builder" }),
-    working_ms_source: "run",
-  return { node: n, depth: 1, parentDescription: "operator chat", displayWorkingMs: n.working_ms };
- * pnpm gives index.ts; only the specifier is spelled differently. */
-import { serve } from "../../forge-control/node_modules/@hono/node-server/dist/index.js";
-import { Hono } from "../../forge-control/node_modules/hono/dist/index.js";
```

Ten removed lines across all six instruments: four fixture literals, two `row()`
one-liners replaced by multi-line returns of the same shape plus `hidesRows`,
two import specifiers, and one comment terminator. **Zero `check(...)` calls
removed. Zero assertions removed. Zero expectations weakened.**

(The other removals in `git diff main...HEAD -- scripts/checks/` belong to
`check-instrument-typecheck.sh`, which is phase 2's write_set, not phase 3's.)

**Verdict — H: no assertion was deleted. Attack failed.**

---

## I. WRITE-SET AUDIT

Declared on the task row (`GET /api/projects/b7ab4c57-…`, round 0, builder,
"Phase 3 — fix the six red instruments at the source (families A, B, C)"):

```
['scripts/checks/check-team-confirm.ts', 'scripts/checks/check-team-rows.ts',
 'scripts/checks/check-dismiss-peek.tsx', 'scripts/checks/check-stop-affordance.tsx',
 'scripts/checks/check-orientation.ts', 'scripts/checks/serve-sse-808.ts',
 'docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md']
```

Actually touched, `git log --name-only` over that task's four commits:

```
### 6bdd24a  fix(…family A)
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
### 77c430c  fix(…family B)
scripts/checks/check-orientation.ts
### 5823302  fix(…family C)
scripts/checks/serve-sse-808.ts
### 3b90700  docs(…D3.2)
docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md
```

**Seven declared, seven touched, exact match. Zero undeclared writes.** This
also satisfies R30 and the phase-3 gate's rejection clause "any file under
`forge-control-web/app/**` or `forge-control/src/**` appears in the diff" — none
does.

---

## J. THE GATE SUITE

**This project ships a gate suite: `scripts/checks/check-instrument-typecheck.sh`**
(universal gate item 9, and the first line of 03-quality.md's Phase 3 gate
block). It takes **no `--strict` flag** — `--help` documents no flags at all —
so it was run with its documented invocation, `bash scripts/checks/check-instrument-typecheck.sh`.
`scripts/checks/gates-808.sh` exists in the same directory but belongs to a
different project (the 808 UI lane) and is not named by this project's quality
document; it was not run.

```
$ bash scripts/checks/check-instrument-typecheck.sh
GATE EXIT=0

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts …*.tsx …*.mts …*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  git HEAD         : 3b907002380d6b107138a9dddfbe6059cdf688c0
  git branch       : project/b7ab4c57
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2
  node             : v22.22.2
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation

  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

  … PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
    PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
    PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
    PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
    PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
    PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
    PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
    PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
    PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
    PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
    PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
    PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
    PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0
  missing 0   uncovered 0   suppressions 0
  wall clock       : 145s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**GATES EXECUTED: 42 typecheck subjects + 4 self-canaries + coverage + suppression
scan + fidelity + census = 1 suite, exit 0. RED: 0. SKIPPED-by-design: 0.**
Plus P-A (ok), P-B (empty), and the five-instrument tsx block:

```
check-orientation.ts       exit=0  ALL PASS — orientation strip derivation
check-team-confirm.ts      exit=0  ALL PASS — team confirm machine
check-team-rows.ts         exit=0  ALL PASS — team row model
check-dismiss-peek.tsx     exit=0  ALL PASS — dismissal peek affordance
check-stop-affordance.tsx  exit=0  ALL PASS — stop affordance
```

The gate was run at HEAD `3b907002380d6b107138a9dddfbe6059cdf688c0`, and HEAD
was re-read after every mutation and immediately before this verdict — unchanged
throughout.

---

## K. LIVE-CHECKOUT CLEANLINESS CHECK

```
$ git -C /opt/forge-ai-os status --porcelain
(no output)
```

Empty. Nothing was hot-applied into the live checkout. Run before this verdict
was written, and re-run at the end of the review — empty both times.

Worktree, at the end of every mutation and at the end of this review:

```
$ git status --porcelain
(no output)
```

---

## VERDICT

**VERDICT: NEEDS_FIXES — one BLOCKER, two NOTEs, at tip
`3b907002380d6b107138a9dddfbe6059cdf688c0`.**

Every acceptance criterion of the phase-3 gate is met: 42/42 green, all five
instruments `ALL PASS`, `serve-sse-808.ts` binds and streams 162,975 bytes of
real SSE, six R29 transcripts present and three reproduced identically, zero
suppressions, zero deleted assertions, zero undeclared writes, nothing touched
outside `scripts/checks/`. **Four of the six fixes preserved the assertion; two
satisfied the compiler with a correct value and then recorded a justification
that measurement refutes.** The blocker is that recorded justification, not the
value — and this project exists precisely because instruments that claim more
than they check survive for months.

---

## FINDINGS

### 1. BLOCKER — `check-dismiss-peek.tsx:123-130` and `check-stop-affordance.tsx:117-125`: the comments claim behavioural coverage that measurement refutes, in the two files where the next maintainer will read it

**Files/lines.**
- `scripts/checks/check-dismiss-peek.tsx:125-128` (the comment on `hidesRows` at `:135`)
- `scripts/checks/check-stop-affordance.tsx:119-123` (the comment on `hidesRows` at `:130`)
- restated in commit `6bdd24a`, the paragraph beginning "check-dismiss-peek.tsx:115 and check-stop-affordance.tsx:111 — … and here it IS behavioural."

**The claims.** `check-dismiss-peek.tsx:125-128`: *"at 1 the ✕ is the one-click,
undoable dismissal … which is what 'the ✕ names the affordance that brings the
row back' is asserting about. Anything above 1 would render the two-click
cascade ✕."* `check-stop-affordance.tsx:119-123`: *"the ✕ beside it does
(`data-x-confirms={needsConfirm(scope)}`): at 1 a settled row's ✕ is the
one-click dismissal and a running row's ✕ is the capability-gated terminate —
the two states the CASES table walks."*

**Failure scenario, measured (§B.1, §B.2, §F.6).** Set
`check-dismiss-peek.tsx:135` or `check-stop-affordance.tsx:130` to `0`, `2` or
`5` — across the `confirm.ts:173` boundary in both directions — and both
instruments print `ALL PASS`, exit 0. Then break the subject itself:
`confirm.ts:173`, `return i.hidesRows > 1` → `>= 1`, which makes every settled
leaf ✕ demand a two-click confirm — the exact "confirm in front of a one-row,
reversible, undoable action" that `confirm.ts:44-47` says trains people to click
through confirms. Both instruments print `ALL PASS`, exit 0.

**Root cause, read not guessed.** `check-dismiss-peek.tsx:193` matches
`.includes("dismissed · show")`, and that substring lives in the shared `undo`
clause at `confirm.ts:245-247` which `dismissTitle` appends to **all three** of
its return branches — so it cannot distinguish them.
`check-stop-affordance.tsx:233-252` reads only `data-team-stop`; it never reads
`data-team-x`, `data-x-confirms` or `data-x-hides`.

**The behaviour that would go undetected, named:** the one-click/two-click
distinction on a settled row's ✕ — `data-x-confirms` flipping from `false` to
`true`, and `dismissTitle` switching from *"Hide this row. Nothing else goes
with it."* to *"Hide this row and the N settled rows under it … Click twice to
confirm."* Neither instrument can see it, at any value.

**Mitigating, and it should shape the fix.** The behaviour is not unguarded
fleet-wide: `check-team-confirm.ts:87/89` (3 failures) and
`check-r1873-fixes.ts:259-268` (2 failures) both catch the `>= 1` regression
(§F.6). This is a defect in the *record*, not a hole in the *coverage* — which
is why the fix is cheap.

**Fix.** Do not change the values — `1` is correct at both sites and correctly
derived from `cascadeRowCount` (`teamRows.ts:194-198`), independently confirmed
against `check-r1873-fixes.ts:139`. Replace the two comment blocks' second half
with what is true and measured: that `hidesRows` is **inert in this file** —
measured at 0, 1, 2 and 5, all `ALL PASS` — that `1` is chosen because it is the
only value `cascadeRowCount` can produce for a childless node, and that the
one-click/two-click boundary is asserted by `check-team-confirm.ts:87/89` and
`check-r1873-fixes.ts:259-268`, not here. Model the wording on
`check-team-confirm.ts:213-220`, which does exactly this and does it well. Amend
the `6bdd24a` paragraph in the phase record the same way (a follow-up commit
message or an addendum in `instruments-still-detect.md` — not a rewrite of
history).

### 2. NOTE — `check-orientation.ts:150-173`: the coverage note is right about the fixture and incomplete about the subject; two of the three `kind` predicates in `findTeamNode` are mutation-uncovered

**File/line.** `scripts/checks/check-orientation.ts:157-166`, the three-bullet
inventory; subject `forge-control-web/app/desktop/chat/OrientationStrip.tsx:237`
and `:243`.

**Failure scenario, measured (§A.2.c, §A.2.d).** Delete `node.kind !== "subagent"`
from `OrientationStrip.tsx:237` — `ALL PASS`, exit 0. Delete
`sub.kind === "subagent" &&` from `OrientationStrip.tsx:243` — `ALL PASS`, exit 0.
Only `sub.kind !== "subagent"` at `:249` is covered (§A.2.b, 1 failure). The
note's first bullet says the "found by tool_use_id under its parent" assertion
*"needs `sub.kind === "subagent"` to be true, or the sub-agent branch never
matches"* — true of the FIXTURE (my §A.1c sweep fails at all four non-subagent
members) but not of the SUBJECT's guard, which can be deleted outright.

**Behaviour that would go undetected, named:** a sub-agent appearing in a roots
position, or a non-sub-agent nested in `subagents[]`, being matched as a run —
the mis-attribution `findTeamNode`'s own comment exists to prevent — provided it
comes in via `:237` or `:243` rather than `:249`.

**Fix.** One sentence added to the note: of the three `kind` reads in
`findTeamNode`, only `:249` is covered by an assertion that flips; `:237` and
`:243` can be deleted with this instrument green. No new assertion is required —
inventing one is outside phase 3's scope, and the note's own closing sentence
("Recorded, not fixed") already sets the right precedent. This is a refinement
of a finding the builder got substantially right, and R26 outcome 1 stands.

### 3. NOTE — `check-dismiss-peek.tsx:110` and `check-stop-affordance.tsx:104`: `working_ms_source` is never read by either instrument

**Failure scenario, measured (§D.1).** Swap `"thread"` → `"rollup"` or `null` in
either file: `ALL PASS`, exit 0, at every value. Outside the two new comment
blocks, neither instrument mentions the field.

**Behaviour that would go undetected, named:** the panel's obligation to render
a `"rollup"` working time visibly less precise than a `"thread"` one (13 §4, §9),
and its obligation never to render `null` as `"0s"` (NFU6). Neither instrument
covers either, and their names — "dismissal peek affordance", "stop affordance"
— do not claim to; this is the pre-existing scope of the files, not a loss
caused by this phase.

**Not a defect in the fix.** `"thread"` is verified correct against the producer,
not merely against the union: `chat.ts:555` ships `timing ? "thread" : null` for
every RUN node, `"rollup"` is reachable only from `subagentWorkingTime`
(`chat.ts:476-494`) on the sub-agent path, and both fixtures are `kind: "worker"`
with `subagents: []` and `working_ms: 252_000`. 03-quality.md §7's standard —
"a fixture must be a value the system can actually produce" — is met.

**Fix.** Recording only; no change required. Worth one line in the phase-3 gate
record so a later reader does not mistake a repaired fixture field for a covered
one.
