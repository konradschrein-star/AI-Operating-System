# Phase 3 GATE — A3.1–A3.6, R25–R30, R33, and every red-team finding adjudicated

**Tip reviewed:** `3b907002380d6b107138a9dddfbe6059cdf688c0`, branch `project/b7ab4c57`.
Re-read immediately before the blocker below was written (`git rev-parse HEAD`,
after every measurement) — **unchanged**. Every claim in this document is made
against that sha.

**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
— the per-project layout. `docs/plan/03-quality.md` also exists (376 lines, the
parent corpus); **both paths were checked**, and the per-project one governs this
project. Its §3 "Phase 3 gate" block, §5 and §7 are what is executed below.

**What this gate did NOT do:** it did not read the builder's transcript for a
result. Every command below was run by this reviewer in this worktree, and every
output is this run's, not a quotation. Where a red-team measurement is upheld it
was **re-measured independently**, with a control, before the verdict was
written.

**Rules observed.** No instrument, app file or config was edited. Every mutation
was applied, measured, and reverted with `git checkout --`, with
`git status --porcelain` shown after each. One server was started and killed.
The single file written by this task is this one — matching its declared
`write_set` exactly.

---

## 0. Dependencies, before any gate

`NODE_ENV=production` is exported into this run, so the bare
`--frozen-lockfile` form would prune `tsx` and `typescript` and exit 0 while
doing it. Both installs were run with `--prod=false`:

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 883ms using pnpm v9.15.9
web exit=0

$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 694ms using pnpm v9.15.9
ctl exit=0
```

---

## A3.1 — all 42 subjects green under the phase-1 profile — **PASS**

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"

check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 3b907002380d6b107138a9dddfbe6059cdf688c0
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.CmQPB3ER8k

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-plan-api.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-plan-store.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-project-metadata.ts         exit 0, 0 diagnostics
  PASS scripts/checks/check-quota-row.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-r1871-chat.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-r1873-fixes.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-r1875-fixes.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-run-control-client.ts       exit 0, 0 diagnostics
  PASS scripts/checks/check-screenshot-render-shapes.ts exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-events.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-requests.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-scan.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-story-digest.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-subagent-slice.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-task-api.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
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
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 147s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT=0
```

**03-quality.md §1 question 3 — is the coverage number the real one?** The three
numbers must agree, and they do:

```
$ ls scripts/checks/*.ts scripts/checks/*.tsx | wc -l
42
```

`subjects found 42` = `subjects compiled 42` = `ls … | wc -l` 42. Coverage is a
fact here, not a claim.

**§1 question 1 — did it pass, or did it never run?** The final verdict line and
`EXIT=0` are both present, and the run is 147s of real compilation with 42
per-subject verdicts between them. Not a truncated `set -e` abort.

---

## A3.2 — the five runnable instruments, and the server — **PASS**

### The five under `tsx`

```
$ cd forge-control-web
$ for f in check-orientation.ts check-team-confirm.ts check-team-rows.ts check-dismiss-peek.tsx check-stop-affordance.tsx; do
    ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/$f; echo "$f exit=$?"; done

===== check-orientation.ts =====
PASS  …of kind assistant_text
PASS  …rendered as 'writing'
PASS  …whose detail is the architect's own words, verbatim
PASS  …and it carries the timestamp the executor stamped

ALL PASS — orientation strip derivation
check-orientation.ts exit=0
===== check-team-confirm.ts =====
PASS  exactly at the arm window, still a confirm
PASS  a clock that ran backwards lands on the safe side
PASS  32 sub-floor click streams, restore-alls issued
PASS  two deliberate clicks restore exactly once

ALL PASS — team confirm machine
check-team-confirm.ts exit=0
===== check-team-rows.ts =====
PASS  12_345 → '12.3k'
PASS  204_700 → '205k'
PASS  1_200_000 → '1.20M'
PASS  12_300_000 → '12.3M'

ALL PASS — team row model
check-team-rows.ts exit=0
===== check-dismiss-peek.tsx =====
PASS  the sentence still says dismissing never deletes
PASS  …and the two readings differ
PASS  the /live reading names the chat team panel
PASS  the team panel's reading names the Live panel

ALL PASS — dismissal peek affordance
check-dismiss-peek.tsx exit=0
===== check-stop-affordance.tsx =====
PASS  …and says why, without blaming the engine

── tokens only (NFU1: both themes) ──────────────────────────
PASS  no colour literal in the rendered row

ALL PASS — stop affordance
check-stop-affordance.tsx exit=0
```

All five exit 0 with the exact `ALL PASS` lines the acceptance criterion names.

### `serve-sse-808.ts` — started by this reviewer, not accepted on a claim

The store was pointed away from Konrad's real credentials, per the file's own
header rule:

```
$ set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ export SECRET_STORE_DIR=/tmp/p808-store-gate3
$ cd forge-control && SERVE_SSE_PORT=7845 ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts

[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
[serve-sse-808] SECRET_STORE_DIR=/tmp/p808-store-gate3

$ ss -ltnp | grep 7845
LISTEN 0      511        127.0.0.1:7845       0.0.0.0:*    users:(("node",pid=4016989,fd=31))
```

**The bind line was observed AND the socket confirmed in `ss`** — this is not a
timeout read as success. Then all three paths the file exists to serve:

```
=== 1. MOUNTED SSE ROUTE: GET /api/secrets/events ===
HTTP/1.1 200 OK
cache-control: no-cache
connection: keep-alive
content-type: text/event-stream
transfer-encoding: chunked
Date: Tue, 18 Aug 2026 12:57:48 GMT

$ timeout 8 curl -sS -N http://127.0.0.1:7845/api/secrets/events > /tmp/sse-body.txt
curl-exit=124 (124=timeout, which is what a LIVE stream produces)
62 /tmp/sse-body.txt
event: hello
data: {"rev":0,"ts":1787057879605}
retry: 15000

=== 2. MOUNTED JSON ROUTE: GET /api/capabilities ===
http=200 ct=application/json
{"control_plane":{"message_into_session":true,"resume_finished":true,"subagent_message":false,"stop":true,"terminate":true}}

=== 3. STREAMING PASS-THROUGH TO :7700: GET /api/health ===
http=200 ct=application/json
{"ok":true,"service":"forge-control","version":"0.1.0","uptime_seconds":27614,"timestamp":"2026-08-18T12:57:54.116Z"}
```

Real SSE frames on the wire (`event: hello`), a mounted JSON route, and a live
proxy hop to :7700. Killed afterwards:

```
$ ss -ltn | grep -c ':7845'
0
$ pgrep -af 'serve.sse.808'
no server process
```

The reject clause "**`serve-sse-808.ts` typechecks but does not bind**" does not
apply: it typechecks (A3.1), it binds, and it streams.

### R27 — no surviving deep path

```
$ grep -n 'node_modules/hono' scripts/checks/serve-sse-808.ts
61:import { Hono } from "../../forge-control/node_modules/hono";

$ grep -n 'dist/index.js\|@hono/node-server' scripts/checks/serve-sse-808.ts
18: * built on `@hono/node-server` — the adapter forge-control's own index.ts uses,
52: * than tidy. They used to end in `/dist/index.js`, which reaches the same
60:import { serve } from "../../forge-control/node_modules/@hono/node-server";
```

Both specifiers name the package directory. The only two `dist/index.js`
occurrences left in the file are in the header comment explaining why they were
removed — no import carries one. R27 met.

---

## A3.3 — the six R29 breakage transcripts — **PASS**

`evidence/instruments-still-detect.md`, produced at sha
`5823302a8d9d78a59a99be0f6241d779e691e56f`. Structural audit of all six against
03-quality.md §5's five steps:

| # | Instrument | steps 1–5 | `git status --porcelain` shown | exit codes shown | mutation on the SUBJECT (app/src), not the instrument |
|---|---|---|---|---|---|
| 1 | `check-orientation.ts` | all present | yes | 3 | yes — `chat/OrientationStrip.tsx` |
| 2 | `check-team-confirm.ts` | all present | yes | 3 | yes — `team/confirm.ts` |
| 3 | `check-team-rows.ts` | all present | yes | 3 | yes — `team/teamRows.ts` |
| 4 | `check-dismiss-peek.tsx` | all present | yes | 3 | yes — `team/peek.ts` |
| 5 | `check-stop-affordance.tsx` | all present | yes | 3 | yes — `team/TeamRow.tsx` |
| 6 | `serve-sse-808.ts` | all present | yes (×2) | 3 | yes — `forge-control/src/routes/chat.ts` |

No transcript breaks the instrument instead of its subject; no transcript is
missing a step. Every mutation is a **behavioural** regression, not a type error
— which is the point: an instrument that only noticed a broken type would have
passed all six.

### Two reproduced by this reviewer, line for line

I deliberately took **#3 and #4** — the two the red team did **not** spot-check
(it took 1, 2 and 5). Between the two reviews, five of the six transcripts have
now been reproduced independently of the process that wrote them, and #6 was
independently re-established by starting the server myself (A3.2 above).

**Control 3 — `check-team-rows.ts` → `teamRows.ts`, U16's frozen truth:**

```
--- STEP 1: green before anything is touched ---
exit=0
ALL PASS — team row model

--- STEP 2: the mutation, on the SUBJECT ---
$ perl -0pi -e 's/  if \(row\.node\.settled\) return base;\n//' forge-control-web/app/desktop/team/teamRows.ts
 forge-control-web/app/desktop/team/teamRows.ts | 1 -
 1 file changed, 1 deletion(-)
@@ -387,5 +387,4 @@ export function interpolatedWorkingMs(
   const base = row.displayWorkingMs;
   if (base === null) return null;
-  if (row.node.settled) return base;
   if (!Number.isFinite(responseNow) || !Number.isFinite(nowMs)) return base;

--- STEP 3: the instrument against the broken subject ---
exit=1
FAIL  settled row at t+30s is IDENTICAL (U16 frozen truth)
FAIL  …and identical to itself, not merely close
FAIL  settled row six hours later is still identical
FAIL  a measured 0 survives as 0, not null
4 FAILURE(S) — team row model

--- STEP 4: revert ---
$ git checkout -- forge-control-web/app/desktop/team/teamRows.ts
$ git status --porcelain
(only the untracked phase3-redteam.md, which predates this task)

--- STEP 5: green again ---
exit=0
ALL PASS — team row model

$ diff /tmp/r29c3-step1.txt /tmp/r29c3-step5.txt
IDENTICAL
```

Matches the transcript's claim exactly: exit 1, **4 FAILURES**, the same four
sentences in the same order.

**Control 4 — `check-dismiss-peek.tsx` → `peek.ts`, the toggle label:**

```
--- STEP 1 --- exit=0  ALL PASS — dismissal peek affordance
--- STEP 2 ---
@@ -37,3 +37,3 @@ export const DISMISSED_GROUP_LABEL = "DISMISSED";
 export function dismissedToggleLabel(hiddenRowCount: number, peeking: boolean): string {
-  return `${hiddenRowCount} dismissed · ${peeking ? "hide" : "show"}`;
+  return `${hiddenRowCount} hidden · ${peeking ? "hide" : "show"}`;
 }
--- STEP 3 --- exit=1
FAIL  the toggle label reads the same on both
FAIL  …and flips to hide when open
2 FAILURE(S) — dismissal peek affordance
--- STEP 4 --- git checkout -- …/peek.ts ; git status --porcelain → clean
--- STEP 5 --- exit=0  ALL PASS — dismissal peek affordance ; step1 == step5 IDENTICAL
```

Matches the transcript's claim exactly: exit 1, **2 FAILURES**, same sentences.

---

## A3.4 — P-A suppression grep — **PASS**

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
    | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)' \
    && echo "FAIL: suppression introduced" || echo "ok: no suppressions"
ok: no suppressions (grep exit=1)
```

**Empty, as A3.4 requires.** The pathspec is the scoped `*.ts`/`*.tsx` form —
the unscoped one reports the gate's own `.sh` prose as five suppressions
(03-quality.md §3), and a directive inside a shell script suppresses nothing.

**R28's amendment: the eleven shapes, five of which a regex misses.** A grep is
not sufficient here, so every added line was READ for any directive shape,
including the JSDoc forms:

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' | grep -E '^\+' \
    | grep -inE '@ts-|ts-nocheck|ts-ignore|ts-expect|\bany\b|as unknown'
113:+ * (`dist/types/index.d.ts` for hono) — so `Hono` came out as `any` (TS7016) and
```

**One hit, and it is prose.** `serve-sse-808.ts`'s header comment explaining that
`Hono` *used to* resolve as `any` before the fix. It is not an annotation, not a
cast, and not a directive: no `/** @ts-ignore */`, no `/**@ts-ignore*/`, no
`/** @ts-expect-error */`, no `@ts-nocheck` in any of the eleven shapes, appears
on a single added line in this branch. The gate's own parser-based scan agrees
independently — `suppressions 0` in the A3.1 census, produced by asking tsc's
`commentDirectives`/`checkJsDirective` rather than by matching text.

**P-B — dependency footprint (NF8, S7):**

```
$ git diff --name-only main...HEAD -- '**/package.json' '**/pnpm-lock.yaml' 'package.json' 'pnpm-lock.yaml'
(empty)
```

---

## A3.5 — confinement (R30) — **PASS**

```
$ git diff --name-only main...HEAD
docs/plan/scripts-checks-typecheck-gate/00-vision.md
docs/plan/scripts-checks-typecheck-gate/01-requirements.md
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/03-quality.md
docs/plan/scripts-checks-typecheck-gate/04-phases.md
docs/plan/scripts-checks-typecheck-gate/evidence/census-A-current-gate-options.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-B-root-paths-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-C-root-paths-plus-react-types.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-E-web-extends-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1-round3.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle2.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-redteam.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
docs/plan/scripts-checks-typecheck-gate/evidence/residual-errors-profile-G.txt
docs/plan/scripts-checks-typecheck-gate/evidence/round0-probes.md
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-orientation.ts
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
scripts/checks/serve-sse-808.ts
tsconfig.checks-instruments.json
tsconfig.checks.json

$ git diff --name-only main...HEAD | grep -E '^(forge-control-web/app/|forge-control/src/)'
ok: nothing under forge-control-web/app/ or forge-control/src/
```

Re-run at the tip immediately before this verdict was written. Every temporary
R29/red-team mutation into app code was reverted; none reached the committed
diff. The tree is clean at the end of this task apart from the untracked
`phase3-redteam.md`, which is the red team's own deliverable and predates it.

---

## A3.6 — every repaired fixture is a value the wire contract permits — **PASS**

Checked by reading **both** the fixture and the type it claims to instantiate,
and in every case the **producer** as well — 03-quality.md §7 asks whether the
system can actually produce the value, which the union alone cannot answer.

| Fixture | Type definition, read | Producer, read | Verdict |
|---|---|---|---|
| `check-team-rows.ts:95` `hidesRows: 1` | `teamRows.ts:41` — `hidesRows: number`, **required** | `teamRows.ts:194-199` — `cascadeRowCount = Math.max(1, visibleSubtreeSize(...))`, so **1 is the only value a childless node yields** | producible |
| `check-team-confirm.ts:221` `hidesRows: 1` | `confirm.ts:136` — `XClickInput.hidesRows: number`; doc-comment: "1 is a leaf; anything more is a cascade" | same | producible |
| `check-dismiss-peek.tsx:135`, `check-stop-affordance.tsx:130` `hidesRows: 1` | same | same — both fixtures are `subagents: []` | producible |
| `check-dismiss-peek.tsx:110`, `check-stop-affordance.tsx:104` `working_ms_source: "thread"` | `teamApi.ts:37` — `WorkingMsSource = "thread" \| "rollup"`; `teamApi.ts:90` — `working_ms_source: WorkingMsSource \| null` | `chat.ts:555` — `working_ms_source: timing ? "thread" : null` for **every run node**; `"rollup"` reachable only from `subagentWorkingTime` (`chat.ts:476-494`), the sub-agent path | producible, and **the only** value a leaf worker run can carry |
| `check-orientation.ts:135/139/142` `kind: "operator" \| "worker" \| "subagent"` | `teamApi.ts:30` — `TeamNodeKind = AgentKind \| "subagent"`; `live/agentsApi.ts:60` — `AgentKind = "operator" \| "worker" \| "cron" \| "unknown"` | `chat.ts:548` — `kind: run.agent_kind` | producible |

The old values were not: `"run"` was never a member of `WorkingMsSource`, and
`"operator_chat"` / `"project_worker"` were never members of `TeamNodeKind`.
Each is the exact failure §7 names. **The boundary the values sit against**
(`confirm.ts:165-174`) was read too:

```ts
export function needsConfirm(i: DismissScope): boolean {
  if (!i.settled) return true;            // terminate — always
  if (i.widerReach === true) return true; // hides rows it cannot count
  return i.hidesRows > 1;                 // a cascade of hides
}
```

This confirms the builder's own claim at `check-team-confirm.ts:213-220`: the
`!settled` guard fires first, so no `hidesRows` value can flip a branch in the
running-row replay stream. That claim is correct and correctly reasoned.

---

## The reject clauses, read line by line

**"any fix widens a type, casts, or DELETES AN ASSERTION"** — I read **every**
removed line across the six instruments:

```
$ for f in <the six>; do git diff main...HEAD -U0 -- scripts/checks/$f | grep -E '^-[^-]'; done
-  manager: node({ id: "manager-run", kind: "operator_chat" }),
-      kind: "project_worker",
-    node({ id: RUN_B, kind: "project_worker", role: "builder" }),
-    working_ms_source: "run",
-  return { node: n, depth: 1, parentDescription: "operator chat", displayWorkingMs: n.working_ms };
-    working_ms_source: "run",
-  return { node: n, depth: 1, parentDescription: "operator chat", displayWorkingMs: n.working_ms };
- * pnpm gives index.ts; only the specifier is spelled differently. */
-import { serve } from "../../forge-control/node_modules/@hono/node-server/dist/index.js";
-import { Hono } from "../../forge-control/node_modules/hono/dist/index.js";
```

Ten lines: three illegal `kind` literals, two illegal `working_ms_source`
literals, two `row()` one-liners re-expanded to the same shape plus the required
field, two import specifiers, one comment terminator. **Zero `check(...)` calls
removed. Zero assertions removed. Zero expectations weakened. No `as`, no `any`,
no widened annotation anywhere in the added lines.** Not tripped.

**"any file under `forge-control-web/app/**` or `forge-control/src/**` appears
in the committed diff"** — none does (A3.5). Not tripped.

**"`serve-sse-808.ts` typechecks but does not bind"** — it binds and streams
(A3.2). Not tripped.

### D3.3 — the commit messages

`git log --format=%B main..HEAD -- scripts/checks/`, read in full:

- **Family B (`77c430c`)** names R26's outcome explicitly — *"R26 OUTCOME: (1) —
  the literals map onto current names and the assertions hold"* — and states why
  outcome 2 was considered and rejected (the kind-reading assertions are not
  vacuous; R29 transcript 1 proves it).
- **Family A (`6bdd24a`)** names the `WorkingMsSource` member and why:
  *"MEMBER CHOSEN: 'thread', in both. Not because it compiles — both do — but
  because a run node cannot carry anything else"*, with the producer cited.
- It names each `hidesRows` value and which branch it exercises, **including
  where the honest answer is "none"**: *"WHICH BRANCH IT EXERCISES: none, and
  that is the finding … Measured, not assumed: with `hidesRows: 165` the file
  still prints ALL PASS."*

D3.3 is met. One note, not a blocker: families A and C do not restate R26's
three-outcome taxonomy per file, because R26 scopes that taxonomy to
`check-orientation.ts`. The substance D3.3 wants — is the assertion preserved,
rewritten, or retired — is answered per file. Worth tightening in the same
follow-up as blocker 1, not worth a separate cycle.

---

## The family-B question, adjudicated (R26, R33, brief A1)

**Was it answered, plainly, in the commit message and the record? YES — and
answered well.** The required sentence is not a green tick; it is three
paragraphs of `77c430c` and a 24-line block at `check-orientation.ts:150-173`,
both saying the same thing:

> Three assertions read `kind`, all through ONE predicate: `findTeamNode`
> (`OrientationStrip.tsx:237-249`) discriminates on `kind === "subagent"` and
> nothing else. … So the coverage is one bit: subagent, or not. NO assertion in
> this file distinguishes "operator" from "worker" from "cron" from "unknown",
> and none would have failed had the manager been declared a cron.

That is R26's outcome (1) with the honest caveat attached, and it is exactly the
answer 04-phases asks for. Per the brief this is an **ACCEPTABLE and valuable
outcome**: the instrument's coverage of `kind` is smaller than the union it
types against, that is now on the record in the file itself, and the builder
correctly declined to invent an assertion about a distinction
`OrientationStrip` does not make.

**Caveat on the record's completeness, measured by me — see adjudication of
red-team finding 2 below:** the note is right about the fixture and slightly
overstated about the subject. Two of the three `kind` reads in `findTeamNode`
can be deleted outright with this instrument green.

**One gap I could not close, and I state it rather than assert either way:**
04-phases says the answer goes "in the commit message **and the task record**".
The commit message and the instrument source carry it in full. The task record
as exposed by `GET /api/projects/b7ab4c57-…` has no report field on the task row
at all (`KEYS: id, project_id, round, role, title, brief, status, run_id,
fix_cycle, tier, attempt, chain_key, depends_on, workstream, write_set,
graph_frozen, created_at, updated_at`), and `GET /api/runs/<run_id>` returns no
JSON. That is a limitation of the endpoint, not evidence of a builder omission,
and R26's own **Verify** clause asks only for the commit message — which is
present and complete. Not counted against the phase.

---

## WRITE-SET AUDIT — **PASS, zero undeclared writes**

Declared on the task row (`GET /api/projects/b7ab4c57-…`, round 0, builder,
"Phase 3 — fix the six red instruments at the source (families A, B, C)"),
`strict_write_sets: true` on the project:

```
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-orientation.ts
scripts/checks/serve-sse-808.ts
docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md
```

Actually touched — `git show --name-only` over that task's four commits:

```
6bdd24a  scripts/checks/check-dismiss-peek.tsx
         scripts/checks/check-stop-affordance.tsx
         scripts/checks/check-team-confirm.ts
         scripts/checks/check-team-rows.ts
77c430c  scripts/checks/check-orientation.ts
5823302  scripts/checks/serve-sse-808.ts
3b90700  docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md
```

**Seven declared, seven touched, exact match. Zero undeclared writes, zero
declared-but-unwritten.** The red team's own write_set
(`evidence/phase3-redteam.md`) and mine (`evidence/phase3-gate.md`) are likewise
exactly one file each, and each wrote exactly that file.

---

## THE GATE SUITE — 25 gates, 23 EXECUTED, 2 SKIPPED-by-design, 1 RED

**This project ships a gate suite under `scripts/checks/`: `gates-808.sh`, and it
takes `--strict`.** I ran it with `--strict`, which is the invocation my brief
requires. (The red team declined to run it, on the argument that it belongs to
the 808 UI lane and is not named by this project's quality document. That is a
defensible reading of provenance but the wrong disposition: `gates-808.sh` is the
repo's universal gate set, it runs against `main...HEAD` of *this* branch, and a
suite skipped on a provenance argument is precisely the "gate set assembled by
hand each round" its own header exists to prevent. I ran it. This divergence is
recorded here deliberately.)

```
$ bash scripts/checks/gates-808.sh --strict ; echo "GATES_EXIT=$?"

 ROUND 808 — UNIVERSAL GATES, verbatim
 repo:   /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
 branch: project/b7ab4c57
 HEAD:   3b907002380d6b107138a9dddfbe6059cdf688c0
 date:   2026-08-18T15:01:48+02:00

  1  0      npx tsc --noEmit — forge-control
  2  0      npx tsc --noEmit — forge-control-web
  3  0      NODE_ENV=production pnpm build — forge-control-web
  4  0      token purity — round 808's own files
  5  0      no-raw-colours.cjs (whole app)
  6  0      forbidden-file diff — three-dot main...HEAD
  7  0      forge-control/ untouched by round 808's own commits
  8  0      dollar-sweep.sh
  9  0      check-composer-v3.ts
  10 0      check-secret-requests.ts
  11 0      contrast-canvas-banners.cjs
  12 0      check-working-sql-agreement.ts — standalone typecheck
  13 0      check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does
  14 0      check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces
  15 0      check-team-rows.ts — flatten, hiddenRows, frozen time
  16 0      check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)
  17 1      verify-notification-gap-pins.mjs — fenced quotes + prose pins
  18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
  19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
  20 0      pnpm test — forge-control unit suite
  21 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
  22 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
  23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
  24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
  25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 1
GATES_EXIT=1
```

**EXECUTED: 23. SKIPPED-by-design: 2** (gates 23–24, the browser harness, not
requested via `--browser`; skipped loudly and labelled, never silently omitted).
**RED: 1** — gate 17.

Gate 17 detail:

```
########## GATE 17 — verify-notification-gap-pins.mjs — fenced quotes + prose pins ##########
$ node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs | tail -2
8 FAILURE(S) — 78/78 pins in docs/plan/notification-gap.md classified (11 fenced quotes, 12 prose, 4 live, 7 cross-doc, 25 repeat, 19 historical).
EXIT=1
```

**Gate 17 is pre-existing and not attributable to phase 3**, verified rather than
assumed:

```
$ git diff --name-only main...HEAD | grep -E 'notification-gap|verify-notification'
ok: neither verify-notification-gap-pins.mjs nor docs/plan/notification-gap.md is in git diff main...HEAD
```

Neither its checker nor its subject document appears in this branch's committed
diff, and round 4 of this project recorded the identical result
(`b221648`: "23 executed, 2 skipped by design, 1 red — gate 17, re-confirmed
pre-existing"). It is a red gate in a document this project does not own.

Under the standing rule "a nonzero exit BLOCKS the PASS", this is recorded as
blocker 2 below — **with its true attribution**, and explicitly **not** as a
phase-3 regression. I did not widen, allowlist or skip it to make the suite
green; a gate made to pass by widening is worth less than one left honestly red.

**Gate suite for THIS project's own instrument** —
`check-instrument-typecheck.sh` takes no flags (`--help` documents none), so it
was run with its documented invocation and is reported in full under A3.1: exit
0, 42/42.

---

## LIVE-CHECKOUT CLEANLINESS CHECK

```
$ git -C /opt/forge-ai-os status --porcelain
[live-checkout status: end of output]
```

**Empty.** No output at all — nothing was hot-applied into the live checkout.
This is the only passing result and it is what was observed. **PASS.**

---

## RED-TEAM ADJUDICATION

`evidence/phase3-redteam.md` read in full. Each numbered finding is adjudicated
below. **No finding is left unadjudicated.** Every UPHELD verdict rests on a
measurement I took myself, with a control, not on the red team's transcript.

| # | Red team's severity | **My adjudication** | Ground |
|---|---|---|---|
| 1 | BLOCKER | **UPHELD — BLOCKER** | reproduced independently, both halves, plus a positive control |
| 2 | NOTE | **UPHELD — NOTE** (fold into the same follow-up) | reproduced independently, with the control that distinguishes it |
| 3 | NOTE | **UPHELD — NOTE, no code change required** | reproduced independently; recorded here, which is the fix it asks for |

### Finding 1 — **UPHELD as a BLOCKER**

**Re-measured by me, at tip `3b90700`, not read from the red team's file.**

Half one — the fixture is inert across the `needsConfirm` boundary:

```
=== FLIP hidesRows ACROSS THE BOUNDARY (confirm.ts:173, `> 1`) ===
check-dismiss-peek.tsx:135     hidesRows=0 -> ALL PASS  exit=0
                               hidesRows=2 -> ALL PASS  exit=0
                               hidesRows=5 -> ALL PASS  exit=0
check-stop-affordance.tsx:130  hidesRows=0 -> ALL PASS  exit=0
                               hidesRows=2 -> ALL PASS  exit=0
                               hidesRows=5 -> ALL PASS  exit=0

=== POSITIVE CONTROL — the SAME flip at a pre-existing site on main ===
check-team-confirm.ts:87 TODAY hidesRows=2 -> 2 FAILURE(S)  exit=1
```

The control matters: it proves my mutation method detects a real dependency when
one exists, so the six `ALL PASS` results above are inertness, not a broken
harness.

Half two — the **subject** can be broken and neither instrument notices:

```
$ perl -0pi -e 's/  return i\.hidesRows > 1; …/  return i.hidesRows >= 1; …/' forge-control-web/app/desktop/team/confirm.ts
@@ -173 +173 @@
-  return i.hidesRows > 1; // a cascade of hides
+  return i.hidesRows >= 1; // a cascade of hides

check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
check-team-confirm.ts          3 FAILURE(S) — team confirm machine      exit=1
check-team-rows.ts             ALL PASS — team row model                exit=0
check-orientation.ts           ALL PASS — orientation strip derivation  exit=0
check-r1873-fixes.ts           2 FAILURE(S) — round 1873 fixes          exit=1

$ git checkout -- forge-control-web/app/desktop/team/confirm.ts ; git status --porcelain → clean
```

That mutation makes every settled leaf ✕ demand a two-click confirm — the exact
"confirm in front of a one-row, reversible, undoable action" that
`confirm.ts:44-47` says trains people to click through confirms. **The two files
whose new comments claim to assert this behaviour do not detect it.**

Root cause, read not guessed. `dismissTitle` (`confirm.ts:244-263`) builds
`undo` — the string containing `"dismissed · show"` — once, and appends it to
**all three** return branches. `check-dismiss-peek.tsx:193` matches
`.includes("dismissed · show")`, a substring shared by every branch, so it is
true at every value of `hidesRows`. And `check-stop-affordance.tsx` mentions
`data-x-confirms` exactly once in the whole file — at line 121, **inside the new
comment**; it appears in no assertion:

```
$ grep -n 'data-team-x\|data-x-confirms\|data-x-hides' scripts/checks/check-stop-affordance.tsx
121:   * (`data-x-confirms={needsConfirm(scope)}` in TeamRow.tsx): at 1 a settled
```

**Why this is a phase-3 BLOCKER, stated precisely, since the brief asks for the
distinction and not for ambiguity.**

It is **not** a blocker on the "deleted an assertion" ground, and I say so
plainly: `hidesRows` was *absent* from both fixtures on `main` — that absence is
the type error this phase repaired — so there was no prior assertion to delete
and **no coverage was lost**. The inertness of the field, and the shared-substring
weakness in `check-dismiss-peek.tsx:193`, are **pre-existing limits this phase
merely exposed**.

It **is** a blocker because of what this phase newly *wrote*. The two comment
blocks at `check-dismiss-peek.tsx:123-130` and `check-stop-affordance.tsx:117-125`
are phase-3 artifacts, and they assert behavioural coverage that measurement
refutes — a claim of the form "this value is load-bearing for that assertion"
where the value is provably inert. 03-quality.md §2.1 states the standard for
exactly this: *"A comment that claims a line is load-bearing, and is never
checked, decays into folklore."* §9 states the failure the whole corpus is
written against: instruments that claimed more than they checked, reviewed by
people who ran them and saw them pass. **A false coverage claim, written into
the instrument at the point where the next maintainer will read it, reproduces
that failure one level up.**

The asymmetry inside the builder's own work is what settles it. At
`check-team-confirm.ts:213-220` the builder *measured* the inertness
(`hidesRows: 165`, still ALL PASS), *stated* it, and gave the mechanism — and
that is a correct fix, correctly reasoned, honestly documented. At the two `.tsx`
sites it asserted the opposite without measuring. The right wording already
exists in the tree, twenty lines away in a sibling file. The gap between them is
the defect.

**Concretely, what goes wrong if this ships.** An engineer changes the
one-click/two-click boundary, runs the two checks whose names say "affordance",
reads their new comments as confirmation that the boundary is covered here, sees
`ALL PASS`, and ships. **Mitigating, and it shapes the fix rather than excusing
it:** the behaviour is not unguarded fleet-wide — `check-team-confirm.ts` (3
failures) and `check-r1873-fixes.ts` (2 failures) both catch the regression, as
my transcript above shows. This is a defect in the **record**, not a hole in the
**coverage**, which is why the fix is cheap and why it is the only thing standing
between this phase and a PASS.

**The smallest change that clears it** — comments and record only; **do not
change the values**, `1` is correct at both sites and correctly derived:

1. `scripts/checks/check-dismiss-peek.tsx:123-130` — keep the first half (why
   `1` is the only value `cascadeRowCount` can produce for a childless node).
   Replace the second half — the claim that `1` is what *"the ✕ names the
   affordance that brings the row back"* is asserting about — with the measured
   truth: `hidesRows` is **inert in this file** (measured 0, 1, 2, 5 — all
   `ALL PASS`), because `check-dismiss-peek.tsx:193` matches
   `"dismissed · show"`, a substring `dismissTitle` appends to all three of its
   branches (`confirm.ts:245-247`); the one-click/two-click boundary is asserted
   by `check-team-confirm.ts:87/89` and `check-r1873-fixes.ts:259-268`, not here.
2. `scripts/checks/check-stop-affordance.tsx:117-125` — same treatment. Note in
   particular that this file never reads `data-team-x`, `data-x-confirms` or
   `data-x-hides` in any assertion; the only occurrence is the comment itself.
3. Model the wording on `check-team-confirm.ts:213-220`, which does this exact
   job and does it well.
4. Amend the `6bdd24a` paragraph beginning *"check-dismiss-peek.tsx:115 and
   check-stop-affordance.tsx:111 — … and here it IS behavioural"* the same way:
   a follow-up commit message or an addendum in `instruments-still-detect.md`.
   **Not a rewrite of history.**

### Finding 2 — **UPHELD as a NOTE**, fold into the same follow-up

Re-measured by me on the subject, with the control that distinguishes it:

```
(a) OrientationStrip.tsx:237 — delete the guard `node.kind !== "subagent" &&`
    -      if (node.kind !== "subagent" && node.id === runId) return node;
    +      if (node.id === runId) return node;
      -> ALL PASS — orientation strip derivation  exit=0     ← NOT covered

(b) OrientationStrip.tsx:243 — delete `sub.kind === "subagent" &&`
    -        sub.kind === "subagent" &&
      -> ALL PASS — orientation strip derivation  exit=0     ← NOT covered

(c) CONTROL: OrientationStrip.tsx:249 — delete `sub.kind !== "subagent" &&`
    -      if (subagentId === undefined && sub.kind !== "subagent" && sub.id === runId) {
    +      if (subagentId === undefined && sub.id === runId) {
      -> 1 FAILURE(S) — orientation strip derivation  exit=1  ← covered

$ git checkout -- …/OrientationStrip.tsx ; git status --porcelain → clean
```

The red team is right, and its own framing is right too: this **refines** a
finding the builder got substantially correct. The note's headline —
*"the coverage is one bit: subagent, or not"* — is **true**. Its three bullets
describe the necessity of `kind` for the **fixture** (true: sweeping the fixture
across the union does flip outcomes) and read as if they described the necessity
of the **subject's guards** (not true for two of three). That is imprecision, not
a false headline, and R26 outcome (1) stands unchanged.

**NOTE, not a blocker.** Fix: one sentence added to the note at
`check-orientation.ts:157-166` — of the three `kind` reads in `findTeamNode`,
only `:249` is covered by an assertion that flips; `:237` and `:243` can be
deleted with this instrument green. **No new assertion is required** — inventing
one is outside phase 3's scope, and the note's own closing sentence
("Recorded, not fixed") already sets the right precedent.

### Finding 3 — **UPHELD as a NOTE, no code change required**

Re-measured by me:

```
check-dismiss-peek.tsx:110     working_ms_source "thread" -> "rollup"  -> ALL PASS  exit=0
check-stop-affordance.tsx:104  working_ms_source "thread" -> "rollup"  -> ALL PASS  exit=0
```

`working_ms_source` is never read by either instrument, at any legal value.
**This is not a defect in the fix.** A3.6's standard is that a fixture must be a
value the system can actually produce, and `"thread"` meets it against the
producer, not merely against the union (`chat.ts:555` ships
`timing ? "thread" : null` for every run node; `"rollup"` is reachable only from
`subagentWorkingTime` on the sub-agent path, and both fixtures are `kind:
"worker"` with `subagents: []`). The field's inertness is the pre-existing scope
of two files whose names — "dismissal peek affordance", "stop affordance" — do
not claim to cover working-time provenance.

The fix the red team asks for is *"one line in the phase-3 gate record so a later
reader does not mistake a repaired fixture field for a covered one"*. **This
paragraph is that line.** Nothing further is required. Behaviour that remains
uncovered, named for the record: the panel's obligation to render a `"rollup"`
working time visibly less precise than a `"thread"` one (13 §4, §9), and its
obligation never to render `null` as `"0s"` (NFU6).

### The red team's non-findings, checked rather than accepted

Its sections C (the `row()` default flattened no caller), H (no assertion
deleted) and I (write-set exact) each report a **failed** attack. I re-derived
all three independently — C by reading the five call sites and the spread order
at `check-team-rows.ts:95-98`, H by reading every removed line myself (above),
I by running `git show --name-only` against the declared write_set myself
(above). All three hold. A red team that reports its failed attacks as failures
is doing the job; I record that it did.

---

## ACCEPTANCE CRITERIA — SUMMARY

| Criterion | Verdict |
|---|---|
| **A3.1** all 42 subjects green under the phase-1 profile | **PASS** — 42/42, uncovered 0, suppressions 0, fidelity 0, exit 0 |
| **A3.2** five instruments `ALL PASS` under tsx; `serve-sse-808.ts` binds and proxies | **PASS** — five exit 0 with their exact lines; server bound on :7845 (confirmed in `ss`), real SSE frames on the wire, JSON route and proxy hop both 200, killed afterwards; R27 grep clean |
| **A3.3** six R29 breakage transcripts, five steps each | **PASS** — all six complete, every mutation on the SUBJECT; #3 and #4 reproduced by me line for line |
| **A3.4** P-A suppression grep empty | **PASS** — empty; eleven-shape read finds only one prose mention of `any` in a comment; gate's parser-based scan agrees at `suppressions 0` |
| **A3.5** nothing committed under `forge-control-web/app/` or `forge-control/src/` | **PASS** — re-run at the tip; clean |
| **A3.6** every repaired fixture is a value the wire contract permits | **PASS** — each checked against its type **and its producer** |
| Reject: widening / cast / deleted assertion | **not tripped** — all ten removed lines read |
| Reject: app file in the committed diff | **not tripped** |
| Reject: typechecks but does not bind | **not tripped** |
| D3.3 commit messages | **PASS** in substance (one tightening noted) |
| Family B question (R26/R33/A1) answered plainly | **PASS** — answered in `77c430c` and in the file itself; refined by finding 2 |
| Write-set audit | **PASS** — 7 declared, 7 touched, zero undeclared |
| Live-checkout cleanliness | **PASS** — empty |
| Gate suite `gates-808.sh --strict` | **RED** — 23 executed, 2 skipped by design, **1 red (gate 17, pre-existing)**, `GATES_EXIT=1` |

**Every acceptance criterion of the phase-3 gate is met.** The phase fails on a
different axis: what it wrote into the record about two of the six fixes.

---

## BLOCKERS

**1. `scripts/checks/check-dismiss-peek.tsx:123-130` and
`scripts/checks/check-stop-affordance.tsx:117-125`** — the two new comment blocks
claim behavioural coverage that measurement refutes, in the two files where the
next maintainer will read it, and the claim is restated in `6bdd24a`.
*Smallest change:* keep the values (`1` is correct at both sites); replace the
second half of each comment with the measured truth — `hidesRows` is inert in
this file (0/1/2/5 all `ALL PASS`), `1` is chosen because `cascadeRowCount`
cannot produce anything else for a childless node, and the one-click/two-click
boundary is asserted by `check-team-confirm.ts:87/89` and
`check-r1873-fixes.ts:259-268`, not here. Model the wording on
`check-team-confirm.ts:213-220`. Amend the `6bdd24a` paragraph by addendum, not
by rewriting history. Fold in finding 2's one sentence at
`check-orientation.ts:157-166` while the file is open.

**2. `docs/plan/notification-gap.md` (checker
`docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`)** — gate 17 of
`gates-808.sh --strict` is RED, 8 failures over 78 pins, `GATES_EXIT=1`, and the
standing rule is that a nonzero suite exit blocks a PASS.
**Attribution, stated so it is not mistaken for a phase-3 regression:** neither
the checker nor its subject document appears in `git diff --name-only
main...HEAD`; this is pre-existing and outside phase 3's write-set, and round 4
recorded the identical result. *Smallest change:* it is not phase 3's to fix.
Either the project that owns `notification-gap.md` repairs the 8 pins, or the
corpus records an explicit, **sentence-scoped** waiver naming those pins — never
a file-level or token-level allowlist, and never silence. I did not widen the
gate to clear it.

---

VERDICT: FAIL
