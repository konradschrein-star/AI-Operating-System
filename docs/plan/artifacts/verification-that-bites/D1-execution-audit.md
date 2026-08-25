# D1 — execution audit: every check/gate/test artefact vs what actually invokes it

Project `aios-verification-that-bites`, round 0, task D1. Report only — nothing was
wired in, nothing was softened. All commands below were re-run in this worktree
(`project/169903ec-audit`) on 2026-08-25.

## Headline, before the table of 244

**`scripts/checks/check-browser-takeover-ticket.ts` guards the one route in this
repo reachable from the public internet without a NextAuth session** —
`location /api/browser-takeover/ws/` proxies straight to forge-control on
`127.0.0.1:7700`, bypassing the Next process and its auth wall entirely, to a
live Chrome instance that can hold Konrad's logged-in Google and Perplexity
sessions. **Its guard does not run automatically.** It is invoked only from
`docs/plan/aios-browser-takeover-live/deploy.md:41` (and cross-referenced at
`:51` for the secret-scan half of the same guarantee) — a deploy runbook that,
as of this audit, has not yet been executed (`deploy.md:4`: *"Nothing in this
project has been installed"*). That makes it neither a wired gate nor a true
orphan: it is **PROCEDURE-INVOKED** — it fires only if a human reads the
runbook and chooses to run it, which is the same failure shape as a memory
note nobody read. (This reclassification came from the manager's independent
check of this exact file, because it was the highest-consequence item on the
first pass; verified here against the live doc before accepting it — see the
PROCEDURE-INVOKED section below for the full citation and the re-scan it
triggered across all 44 other LIVE-ORPHAN `scripts/checks/` files.)

## Method

1. **Close the runner set first.** A gate that "runs" only inside a script nothing
   else calls is not running. So before classifying a single subject, the set of
   things capable of executing a check was proven closed:

   ```
   $ ls .github                                    # No such file or directory
   $ git ls-files | grep -iE 'makefile|\.ya?ml$'    # 3 hits, all pnpm-lock.yaml — not runners
   $ crontab -l                                     # see §"scripts/ops" below — real entries, none call scripts/checks/
   $ ls /etc/cron.d/                                # certbot, corpus-backup-*, e2scrub_all, ktv2-reclassify, sysstat, vps2-backup-check
   $ pm2 jlist | … names+exec_path+cwd              # forge-control, forge-control-web, forge-executor,
                                                     # knowledge-indexer-watch, km-chat-backfill, km-resume-watcher —
                                                     # none exec scripts/checks/*
   ```

   So the closed runner set for `scripts/checks/**` and `docs/plan/artifacts/**` is
   exactly: `scripts/checks/gates-808.sh`, `scripts/checks/guard.sh`,
   `scripts/checks/preflight-deploy.sh` (its own C1–C5 body),
   `scripts/checks/test-guard-discrimination.sh`, `scripts/checks/check-instrument-typecheck.sh`
   (compiles, does not execute — see below), the four `package.json` files, and —
   separately — `crontab -l` + `/etc/cron.d/*` for `scripts/ops/`. Nothing else in
   this repo can run a check.

2. **Execution vs prose.** A `git grep` hit for a filename is not an invocation —
   comments, doc tables and evidence reports mention scripts constantly. Only a
   reference in a runner **in command position** counts. Worked example, from this
   round: `git grep -n check-secret-scan -- docs/**/*.md` returns five hits in
   `docs/plan/artifacts/os-usable-for-work/phase4/fix-cycle-1-recheck.md` — table
   cells and prose narrating a past round's fix, e.g. *"`check-secret-scan.ts` is
   CORRECT and must not be softened"*. None of those are commands a runner
   executes; they are a report **about** a command someone once ran by hand. They
   were correctly excluded. Compare: `grep_-n_"check-composer-v3.ts"_scripts/checks/gates-808.sh:176`
   — `gate_sh "check-composer-v3.ts" "cd forge-control && ./node_modules/.bin/tsx
   ../scripts/checks/check-composer-v3.ts | tail -3"` — that *is* command position,
   inside the one script every gate run actually executes.

3. **COMPILED-BY ≠ INVOKED-BY.** `scripts/checks/check-instrument-typecheck.sh`
   globs `scripts/checks/**/*.ts` and `**/*.tsx` (52 of the 72 files in the
   directory) and type-checks every one of them through
   `tsconfig.checks-instruments.json`, itself run only from `guard.sh --full`
   (`guard.sh:194-200`). Its own header says why this exists: *"`scripts/checks/*.ts`
   is compiled by NOTHING [else]… the code the fleet uses to VERIFY itself is the
   least-verified code in the repo."* Compiling proves a subject has no type
   error. It proves nothing about whether the subject's assertions ever run, what
   input they run against, or whether anyone reads their output. Every `.ts`/`.tsx`
   file below carries `check-instrument-typecheck.sh (glob)` in its COMPILED-BY
   column regardless of which INVOKED-BY bucket it lands in — a `.sh`/`.cjs`/`.py`
   file is typed `N/A` there, it is outside this gate's globs entirely.

4. **Buckets.** LIVE-WIRED (a runner executes it, file:line given) · LIVE-ORPHAN
   (subject still exists and matters, nothing executes the check) · SPENT
   (one-shot verification of a settled historical round) · NOT-A-CHECK
   (harness/server/fixture) · PROCEDURE-INVOKED (a *current* human/deploy doc
   instructs running it — historical round-evidence reports, and a completed
   project's own planning corpus, past-tense-recording what a round already
   did, do not count for this; only a doc that is still telling someone to run
   the check *going forward* does). This last bucket is materially weaker than
   LIVE-WIRED (a runner fires unconditionally; a doc fires only if a human
   reads it and chooses to act) and materially stronger than LIVE-ORPHAN
   (nothing at all points at it). It sits between the two, and it is easy to
   miss: a naive `git grep` for a check's filename returns the same shape of
   hit whether the reference is a live instruction or a settled report, so
   every doc hit for every LIVE-ORPHAN candidate was re-examined for this
   round — see "PROCEDURE-INVOKED, and the re-scan it forced" below.

## The closed runner set, in full

| Runner | What it runs |
|---|---|
| `scripts/checks/gates-808.sh` | 24 numbered gates, verbatim, always all 24 (2 SKIPPED without `--browser`). The universal suite — governs every project in the repo, not just "round 808" (fleet memory `gates-808-is-the-repo-suite`, re-confirmed live). |
| `scripts/checks/guard.sh` | Its own phases 0–2 (node version, devDeps-on-disk, `no-raw-colours.cjs`, `dollar-sweep.sh`, forbidden-file diff, `tsc` ×2) plus, only under `--full`: `check-instrument-typecheck.sh` and `gates-808.sh --strict` — it does not re-list gates-808's gates, it *delegates* (guard.sh:218-226, explicitly to avoid a second hand-maintained list). |
| `scripts/checks/preflight-deploy.sh` | Its own C1–C5, sourced-vs-executed guarded by `BASH_SOURCE[0]` = `$0` (preflight-deploy.sh:589). See finding below — this one is a runner in form but an orphan in fact. |
| `scripts/checks/test-guard-discrimination.sh` | Drives `guard.sh --fast --json` six times, mutation-testing three of guard.sh's own checks. Invoked by `package.json:guard:test`. |
| `scripts/checks/check-instrument-typecheck.sh` | Compiles (not executes) every `.ts`/`.tsx` under `scripts/checks/**`. Invoked by `guard.sh` under `--full` only. |
| `package.json` (root) | `guard` → `guard.sh --fast --strict`; `guard:full` → `guard.sh --full --strict`; `guard:test` → `test-guard-discrimination.sh`. |
| `forge-control/package.json` | `test` → `tsx --test src/lib/*.test.ts` — **non-recursive, one directory only.** Invoked by `gates-808.sh:255`. |
| `forge-control-web/package.json`, `forge-control-mcp/package.json` | `typecheck`/`build`/`lint` only — no check-suite entry points. |
| `crontab -l` + `/etc/cron.d/*` | The only path into `scripts/ops/`. See its own section below — this is a genuinely separate runner class from everything above, and it matters: it caught a live failure today. |

No `.github/`, no Makefile, no other YAML, no other pm2 process, no other cron
source. This set is exhaustive for the repo as it stands on 2026-08-25.

## scripts/checks/ — 72 files, four/five-bucket table

72 = 52 `.ts`/`.tsx` (all COMPILED-BY `check-instrument-typecheck.sh`) + 14 `.sh` +
5 `.cjs` + 1 `.py`. Bucket totals: **17 LIVE-WIRED, 44 LIVE-ORPHAN, 5 SPENT,
2 PROCEDURE-INVOKED, 4 NOT-A-CHECK.**

### LIVE-WIRED (17)

| path | invoked_by | compiled_by |
|---|---|---|
| scripts/checks/gates-808.sh | `package.json:guard:full` → `guard.sh` → `gates-808.sh --strict` | N/A |
| scripts/checks/guard.sh | `package.json:guard`, `guard:full` | N/A |
| scripts/checks/test-guard-discrimination.sh | `package.json:guard:test` | N/A |
| scripts/checks/check-instrument-typecheck.sh | `guard.sh:196-197` (under `--full`) | N/A |
| scripts/checks/check-migration-numbers.ts | `gates-808.sh:174` | check-instrument-typecheck.sh (glob) |
| scripts/checks/dollar-sweep.sh | `gates-808.sh:175`, `guard.sh:152` | N/A |
| scripts/checks/check-composer-v3.ts | `gates-808.sh:176` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-secret-requests.ts | `gates-808.sh:177` — **the name-twin that hides the check-secret-scan.ts gap** | check-instrument-typecheck.sh (glob) |
| scripts/checks/contrast-canvas-banners.cjs | `gates-808.sh:178` | N/A |
| scripts/checks/check-working-sql-agreement.ts | `gates-808.sh:180-183` (standalone typecheck) | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-stop-affordance.tsx | `gates-808.sh:190-192` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-dismiss-peek.tsx | `gates-808.sh:199-201` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-team-rows.ts | `gates-808.sh:203-204` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-team-confirm.ts | `gates-808.sh:206-207` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-deep-link.ts | `gates-808.sh:215-217` | check-instrument-typecheck.sh (glob) |
| scripts/checks/check-usage-fold.ts | `gates-808.sh:243-244` (conditional on `DATABASE_URL`, call site exists unconditionally — same treatment as the `--browser` gates) and `:250-253` (standalone typecheck) | check-instrument-typecheck.sh (glob) |
| scripts/checks/no-raw-colours.cjs | `gates-808.sh:133`, `guard.sh:148` | N/A |

`docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`,
`docs/plan/artifacts/phase800/psql-argv-leak.cjs`,
`docs/plan/artifacts/phase800/nav-walk-sampling.cjs`,
`docs/plan/artifacts/phase700/network-700.cjs`,
`docs/plan/artifacts/phase600/nav-walk.cjs` are also LIVE-WIRED, from
`docs/plan/artifacts/` — see that section.

### PROCEDURE-INVOKED (2), and the re-scan it forced

**`scripts/checks/verify-control-plane.sh`** — `docs/tools/run-control.md` (current
tool doc, last touched 2026-08-06, not inside the historical
`docs/plan/artifacts/**` corpus) §11 "How to verify", verbatim: *"The one command
is **`scripts/checks/verify-control-plane.sh`**"*, followed by four literal
invocation lines (`run-control.md:756-761`). A *current*, general doc instructing
a human to run it repeatedly, not a settled round's own evidence trail. Note:
`forge-control/src/lib/verify-control-plane-script.test.ts` also references this
file, but only reads its source text as a string to assert a shell-scripting
convention (`verify-control-plane-script.test.ts:27`) — it never executes the
script, so this does not upgrade to LIVE-WIRED.

**`scripts/checks/check-browser-takeover-ticket.ts`** — `docs/plan/aios-browser-takeover-live/deploy.md:41`
(the invocation, inside step 0's preconditions: `cd forge-control-web && …tsx
…/scripts/checks/check-browser-takeover-ticket.ts`) and `:51` (cross-referenced
for the secret-scan guarantee: *"No file in git contains its value, and none
ever may — `scripts/checks/check-browser-takeover-ticket.ts` §7 scans every
tracked file"*). See the headline above for why this is the single most
important line in this report. **Caught by the manager, not by this operator's
first pass** — flagged here as a process gap, not just a data gap: this file's
own header makes the strongest security claim of any artefact in the whole
audit, and it was still initially miscategorised as LIVE-ORPHAN because the
first pass's doc-grep was scoped to `docs/plan/artifacts/**` and
`docs/plan/*/evidence/**` only, which correctly excludes settled round
corpora but also, without a second check, silently excludes a *live, pending*
deploy runbook living one directory shallower. That gap forced a full re-scan.

**The re-scan, and why the other 44 LIVE-ORPHAN `scripts/checks/` files hold.**
Every one of the 44 remaining LIVE-ORPHAN filenames was grepped again, this
time across ALL of `docs/**/*.md` excluding only `docs/plan/artifacts/**`,
`docs/research/**` and `docs/plan/*/evidence/**` — a deliberately wider net
than the first pass. 30 of the 44 turned up at least one hit outside that
exclusion set (`check-classify.ts`, `check-duration.ts`, `check-close-gate.ts`,
`check-scheduler-sql.sh`, `check-task-api.ts`, `check-workstream-e2e.sh`,
`check-plan-store.ts` and 23 more), every one of them inside a completed
project's own **planning corpus** — `docs/plan/engine-task-graph/0{0-4}-*.md`,
`docs/plan/operator-visibility/0{3-4}-*.md` and `1{2,4-5}-*.md`,
`docs/plan/scripts-checks-typecheck-gate/0{0-4}-*.md`,
`docs/plan/os-usable-for-work/04-phases.md`, `docs/plan/notification-gap.md`,
`docs/plan/evidence/r950-forge-ui-prompt.md` — and every hit reads in the
**past tense**, recording what a round already built and already ran (e.g.
`aios-browser-stream-viewer/measurement.md:177`: *"`check-browser-stream-viewer.ts`
— **65/65 assertions PASS**"*, a result, not an instruction). None of these
projects has a pending, not-yet-executed deploy step the way
`aios-browser-takeover-live` does — confirmed by listing every `deploy*.md` /
`runbook*.md` in the repo (`git ls-files 'docs/plan/**/deploy*.md'
'docs/plan/**/runbook*.md'`): the only hits outside `docs/plan/artifacts/**`
and `docs/tools/*.md` are `docs/plan/aios-browser-takeover-live/deploy.md`
itself and three settled evidence-dir deploy reports
(`docs/plan/evidence/{cp4,p6,p7}-deploy.md`,
`docs/plan/engine-task-graph/evidence/phase8-deploy*.md`,
`docs/plan/scripts-checks-typecheck-gate/evidence/phase6-deploy.md`,
`docs/plan/operator-visibility/artifacts/phase1860/02-deploy.md`), all of
which record deploys that already happened. So the 44 remaining LIVE-ORPHAN
classifications stand, but on a re-checked basis now, not the original
narrower one.

### SPENT (5)

| path | why |
|---|---|
| scripts/checks/check-r1871-chat.ts | Round-numbered one-shot verification of round 1870's findings; shipped and settled. |
| scripts/checks/check-r1873-fixes.ts | Round-numbered one-shot verification of round 1872's six findings (the brief's own example of this bucket). |
| scripts/checks/check-r1875-fixes.ts | Same contract as check-r1873-fixes.ts, one round later; its own text says so. |
| scripts/checks/check-r20-census.py | Round-numbered one-shot census tied to a reviewer gate already discharged (the brief's own example). |
| scripts/checks/check-r69-straddle.sh | Self-declared: "REOPENED AND CLOSED IN ROUND 242" — an A/B experiment whose decision (R71 `graph_frozen`) already shipped. |

### NOT-A-CHECK (4)

`serve-agents-7798.ts`, `serve-quota-7799.ts`, `serve-sse-808.ts`,
`serve-v3-7798.ts` — HTTP servers other harnesses point browsers at; none contain
a pass/fail verdict of their own.

### LIVE-ORPHAN (44) — the finding bucket, ordered by strength of self-claim

Every row below: subject still on disk (`git ls-files <path>` proven), nothing in
the closed runner set names the check, no live/pending doc invokes it either
(see the re-scan above), and the check's own header argues its invariant still
matters. Full proof commands are in the TSV; the strongest self-descriptions,
verbatim:

1. **`check-connection-states.ts`** — *"THE TEST THAT DECIDES PHASE 4."*
2. **`check-secret-scan.ts`** — repo-wide committed-credential scanner. Already a
   known, separately-tracked finding (fleet memory `do-not-soften-check-secret-scan`);
   re-confirmed here, `grep -c check-secret-scan scripts/checks/gates-808.sh` → `0`.
   Per this project's hard constraint, **not wired in during this round** — the
   fix order is redact → rotate → remove the literal → wire in, and redaction is
   seeded on a different project (`aios-guardrail-hardening`).
3. **`check-chat-rich.tsx`** — asserts "NOTHING CAN FETCH" from a rendered chat
   message (no live `src`/`srcset`/`<link rel=preload>`) — the one guarantee a
   sibling round-807 check could not make.
4. **`check-integrations.tsx`** — asserts the Google/Gemini API key "appears in no
   response body from any of the four endpoints — including the failure bodies,
   including an upstream body that echoes it back."
5. **`check-typing-memo.ts`** — *"the fix is one `memo()` plus two
   `useCallback`s — an edit any future round could undo in four keystrokes without
   a single test going red."* A regression exactly this cheap to reintroduce, with
   nothing watching for it.
6. **`check-quota-row.ts`** — a duplication-prevention rule
   (`quotaQuery.ts:23` documents it as enforced by this very script) with no
   automated enforcer behind it.
7. **`check-ui-prompt.ts`** — protects the exact failure mode Konrad would see:
   *"the agent emits a block, validation rejects it, and Konrad gets a visible
   'unreadable control block' in his chat where a button should have been."*
8. **`check-run-control-client.ts`** — argues, in its own header, for its
   continued necessity even after a browser proof exists elsewhere: *"The
   script's VALUE is undiminished… a browser can only produce the answers the
   engine chooses to give it."*
9. **`check-ops-scripts.sh`** — guards `scripts/ops/safe-restart.sh`, which the
    *current* `docs/tools/deploy-playbook.md` documents operators invoking
    directly against production pm2 services. The check that verifies
    `scripts/ops/`'s own internal consistency (permissions, the
    `install-symlinks.sh` FILES list matching disk) is referenced nowhere except
    one line of prose in `scripts/ops/README.md:69` — it is itself an orphan,
    auditing a directory whose real safety net turned out to be `crontab -l`
    (see below), not this script.
10. **`contrast-nav-rail.cjs`, `contrast-role-tints.cjs`** — the name-twin pair
    the brief asked to confirm. `contrast-canvas-banners.cjs` is
    LIVE-WIRED (`gates-808.sh:178`); these two protect the LeftRail's
    selected-row contrast and the nine chat-role tint colours, respectively, in
    both themes, and neither has a call site anywhere. Same shape as
    `check-secret-requests.ts`/`check-secret-scan.ts`: a name that reads as
    covered because a sibling with a similar name is.
11. The remaining 34 — `api-diff.sh`, `check-await-seed.sh`, `check-browser-shots.ts`,
    `check-browser-stream-viewer.ts`, `check-chat-delta.ts`,
    `check-chat-pagination-browser.ts`, `check-chat-rail-payload.ts`,
    `check-classify.ts`, `check-close-gate.ts`, `check-duration.ts`,
    `check-fix-chain-graph.ts`, `check-gemini-tally.ts`, `check-migration-0040.sh`,
    `check-nav-stack.ts`, `check-orientation.ts`, `check-phase3-placeholders.ts`,
    `check-plan-api.ts`, `check-plan-store.ts`, `check-project-metadata.ts`,
    `check-scheduler-sql.sh`, `check-screenshot-render-shapes.ts`,
    `check-secret-events.ts`, `check-settings-surface.tsx`, `check-story-digest.ts`,
    `check-subagent-slice.ts`, `check-task-api.ts`, `check-thread-mapping.ts`,
    `check-tool-summary.ts`, `check-uploads-payload.ts`, `check-working-time.ts`,
    `check-workstream-e2e.sh`, `frozen-dom.cjs`, `preflight-deploy.sh` — each a
    unit/behavioural/browser check for a still-shipping surface (route, DB
    helper, React component, migration, or scheduler SQL), each with its subject
    file proven present in the TSV, each invoked by nothing.

**`preflight-deploy.sh` deserves its own note, not just a table row.** Its header
claims runner status — *"Both the deploy task and the phase-7 gating reviewer run
this"* — and every invocation `git grep` finds is real: `bash
scripts/checks/preflight-deploy.sh` really was executed, repeatedly, with
transcripts, inside `docs/plan/artifacts/os-usable-for-work/phase7/*.md`. But
every one of those is the **completed** `os-usable-for-work` project's own
historical evidence trail — that project's phase 7 shipped (`deploy-report.md`
records a successful deploy). The current, general deploy runbook,
`docs/tools/deploy-playbook.md` (262 lines), **does not mention
`preflight-deploy.sh` at all** — checked with `grep -n preflight
docs/tools/deploy-playbook.md`, zero hits. Worse: three of its five checks (C1,
C3, C4) have the specific project id `7851068b` and branch name
`project/7851068b` hardcoded (`preflight-deploy.sh:30-34`) — they cannot
meaningfully judge any *other* project's deploy even if invoked. C2 (live
checkout clean) and C5 (the `MemorySurface`/`routes/memory.ts` field-agreement
self-testing comparator) are still general, still correct, and still guard real
invariants — `forge-control/src/routes/memory.ts` and
`forge-control-web/app/desktop/MemorySurface.tsx` both still exist. So this file
is not simply orphaned; it is a **live-general two-fifths (C2, C5) fused to a
spent three-fifths (C1, C3, C4)**, wearing a header that still claims universal
"deploy task" status. Classified LIVE-ORPHAN per the brief's own tie-break rule
("prove it by quoting the doc that invokes it… or reclassify LIVE-ORPHAN" — no
qualifying current doc was found), with this hybrid nature flagged for whoever
picks it up next: a naive re-wire would resurrect three permanently-failing
project-specific checks alongside two good ones.

**Generalise this one, because it will recur.** A dormant check is not
automatically safe to switch back on just because its subject file still
exists — it may be dormant *because it rotted*: written against one project's
specific IDs, one round's specific schema, one branch name that no longer
means what it meant. Flipping it back on then doesn't restore coverage, it
resurrects the rot as new noise on unrelated work. D2 (can-it-fail) and any
future re-wiring task should carry a column next to "would this check even
run" for **"if it ran, would it pass against today's tree for reasons that
have nothing to do with today's tree"** — `preflight-deploy.sh`'s C1/C3/C4 are
the worked example: they would not merely fail to help, they would fail
*unconditionally*, on every future project, forever, because `PROJECT_ID` and
`BASE_BRANCH` are literals from a project that shipped weeks ago.

## docs/plan/artifacts/**/*.cjs, *.mjs — 77 files

(The brief's own text said "85" — that was this operator's miscount when drafting
the sub-agent brief; `git ls-files 'docs/plan/artifacts/**/*.cjs'
'docs/plan/artifacts/**/*.mjs'` returns 77, independently confirmed twice.)

**5 LIVE-WIRED, 0 LIVE-ORPHAN, 53 SPENT, 19 NOT-A-CHECK.** (The sub-agent that
produced this batch reported its own summary line as "55 SPENT, 17 NOT-A-CHECK" —
a hand recount of its own 77-row table gives 53/19; corrected here, and it is the
table, reproduced in full in the TSV, that this report and the TSV both encode.)

### LIVE-WIRED (5)

| path | invoked_by |
|---|---|
| docs/plan/artifacts/phase800/psql-argv-leak.cjs | `gates-808.sh:258` (always) + `:271-277` ("reproduce-cleanliness" re-run) |
| docs/plan/artifacts/phase800/nav-walk-sampling.cjs | `gates-808.sh:260` (always) + `:271-277` |
| docs/plan/artifacts/phase700/network-700.cjs | `gates-808.sh:264` — call site exists, gated behind `--browser` |
| docs/plan/artifacts/phase600/nav-walk.cjs | `gates-808.sh:265` — same, `--browser`-gated |
| docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs | `gates-808.sh:219-220` (always) |

### 0 LIVE-ORPHAN

Every one of the other 72 files was read (header docblock at minimum; `assert(`/
`PASS`/`FAIL`/`process.exit` grepped where the header alone didn't settle it) and
is round- or phase-numbered evidence for a specific, already-shipped finding —
`phase1290`, `phase1300/fix-1305`, `phase1355`, `phase1871`, `phase1873`,
`phase900` step-3/4, `os-usable-for-work/phase1` through `phase7`, etc. None
targets a still-open, currently-uncovered invariant the way the `scripts/checks/`
orphans above do. This is a real, checked negative, not an assumption: 77 files
sampled, 0 found guarding a live-and-uncovered surface. See the TSV for the
per-file bucket and one-line reason.

### SPENT (53) / NOT-A-CHECK (19)

Full 77-row breakdown in the TSV. The distinguishing test applied per file:
does the script assert pass/fail on a finding and exit non-zero on failure
(→ SPENT, its round is over but it once had teeth), or does it only capture
screenshots/measurements for a human to eyeball or diff by hand, with no
verdict of its own (→ NOT-A-CHECK)? Several files named `capture-*.cjs`/
`*-shot.cjs` turned out to hold real assertions on closer read (e.g.
`phase1350/dismissal-ui/capture-1350.cjs` asserts dismissal survives a hard
reload) and were classified SPENT rather than NOT-A-CHECK on that basis — name
pattern alone was not trusted.

## test.ts / test.tsx — the glob, measured exactly

`forge-control/package.json:test` is `tsx --test src/lib/*.test.ts` —
**non-recursive**, one literal directory. `git ls-files | grep -E
'\.(test|spec)\.(ts|tsx|js)$'` returns 75 files:

- 72 under `forge-control/src/lib/*.test.ts`, all **direct children** of
  `src/lib/` (verified: `git ls-files 'forge-control/src/lib/*.test.ts' | grep -v
  '^forge-control/src/lib/[^/]*\.test\.ts$'` → empty) — every one of these **is**
  captured by the glob and **is** LIVE-WIRED via `gates-808.sh:255`
  (`pnpm test — forge-control unit suite`).
- 3 are NOT captured — LIVE-ORPHAN: `forge-control-web/app/desktop/goals/quick-add.test.ts`,
  `forge-control-web/app/desktop/map/mapTree.test.ts`,
  `forge-control-web/app/desktop/spend-skew.test.ts`. A different package
  (`forge-control-web/package.json` has no `test` script at all), so these three
  have never run under any command in this repo.

**One correction to the brief's own illustrative claim.** The brief cites *"a test
under `src/routes/` or `src/db/` passes standalone and is never executed"* and
names `check-await-seed.sh`... no — names `src/lib/vault-routes.test.ts` as *"a
silent workaround"* already in place for this. Both parts are independently
confirmed: `vault-routes.test.ts`'s own header states exactly this, verbatim —
*"WHY A ROUTE TEST LIVES IN src/lib/. `pnpm test` runs `tsx --test
src/lib/*.test.ts` and nothing else — a test file under `src/routes/` DOES NOT
RUN, it merely looks like coverage. Until the test script grows a second glob,
this is where a route test has to sit to be executed at all."* But: as of this
commit, **there are currently zero tracked (or untracked — checked with a
filesystem `find`, not just `git ls-files`) `*.test.ts`/`*.spec.ts` files under
`forge-control/src/routes/` or `forge-control/src/db/`.** The specific dead files
the brief's evidence item 4 describes are not present at HEAD; either they were
already migrated into `src/lib/` (the `vault-routes.test.ts` pattern, generalised)
or never existed as tracked files. The underlying defect — the glob is one
directory wide and would silently swallow any future `src/routes/*.test.ts` — is
real and unfixed; the specific instance is not currently live. D4 should verify
this glob's width directly rather than hunting for files that (right now) are not
there.

## scripts/ops/ and scripts/deploy/ — verification vs action, and a live catch

The brief's own runner-closure list does not cover `scripts/ops/`; its execution
path is exclusively `crontab -l` and `/etc/cron.d/*` on the live box, resolved via
symlinks installed by `scripts/ops/install-symlinks.sh` (`/opt/ai-os/scripts/<name>`
→ `/opt/forge-ai-os/scripts/ops/<name>`, the live checkout, confirmed with `ls -la
/opt/ai-os/scripts/`).

| path | bucket | invoked_by |
|---|---|---|
| scripts/ops/check-corpus-backup.sh | LIVE-WIRED (verification) | `/etc/cron.d/corpus-backup-check:5` — `50 5,11,17,23 * * *` |
| scripts/ops/check-vps2-backup.sh | LIVE-WIRED (verification) | `/etc/cron.d/vps2-backup-check:5` — `40 5 * * *` |
| scripts/ops/prune-corpus-offbox.sh | LIVE-WIRED (action) | `/etc/cron.d/corpus-backup-prune:5` — `25 4 * * *` |
| scripts/ops/pg-backup.sh | LIVE-WIRED (action) | `crontab -l` — `20 3 * * *` |
| scripts/ops/reap-orphan-agents.sh | LIVE-WIRED (action) | `crontab -l` — `*/5 * * * *` |
| scripts/ops/claude-code-autoupdate.sh | LIVE-WIRED (action) | `crontab -l` — `17 4 * * *` |
| scripts/ops/fleet-watchdog.sh | LIVE-WIRED (verification+repair) | `crontab -l` — `*/10 * * * *` |
| scripts/ops/fleet-pulse.sh | LIVE-WIRED (verification, escalates) | `crontab -l` — `*/30 * * * *`; internally shells out to `stalled-projects.sh` at `fleet-pulse.sh:81` |
| scripts/ops/stalled-projects.sh | LIVE-WIRED (indirect) | `fleet-pulse.sh:81`, which is itself cron-wired |
| scripts/ops/safe-restart.sh | NOT-A-CHECK (action) | PROCEDURE-INVOKED: `docs/tools/deploy-playbook.md`, `docs/plan/00-vision.md:28,39`, `docs/plan/01-requirements.md:89,222` all instruct running it via `setsid nohup … &` |
| scripts/ops/rebuild-web.sh | NOT-A-CHECK (action) | PROCEDURE-INVOKED: `docs/spec-daily-goals.md:317` |
| scripts/ops/install-symlinks.sh | NOT-A-CHECK (setup action) | not itself scheduled; its FILES list is nominally cross-checked by the orphaned `check-ops-scripts.sh` above |
| scripts/ops/agy-dropout-stopgap.sh | NOT-A-CHECK (temporary remediation) | symlinked (`/opt/ai-os/scripts/agy-dropout-stopgap.sh`) but not present in `crontab -l` or `/etc/cron.d`; own header says "delete this once you have confirmed R870 is live" (2026-08-23) — status of that confirmation not established by this audit |
| scripts/ops/deploy-goal-mode.sh | SPENT | one-shot, 2026-08-05, header: "safe to delete after the night" |
| scripts/ops/deploy-retier.sh | SPENT | one-shot, 2026-08-05, same disposability note |
| scripts/deploy/await-and-seed.sh | NOT-A-CHECK (action) | invoked ad hoc by specific deploy tasks (docs/plan/engine-task-graph/03-quality.md:429, historical phase 8D mechanism); reusable pattern, not itself scheduled |
| scripts/deploy/payload-*.json (3 files) | NOT-A-CHECK (fixture) | data consumed by the above |
| scripts/ops/canvas | NOT-A-CHECK | a CLI utility ("draw on Konrad's Excalidraw surface from the shell"), no `.ts`/`.sh`/`.cjs`/`.py`/`.mjs` extension — **this audit's own SUBJECTS filter (§(a): `ls … \| grep -E '\.(ts\|tsx\|sh\|cjs\|py\|mjs)$'`) missed it on the first pass**; caught only by a second, unfiltered `git ls-files scripts/ops` read. Recorded here as a small instance of the audit's own method needing a second look, not just the repo's. |

**This section caught something live, today.** The current `crontab -l` output
carries this comment, dated by its own text to today:

> `# AI OS fleet pulse (restored 2026-08-25). fleet-watchdog.sh's own header has`
> `# claimed "every 10 min via system cron" since 2026-08-05, but the entry was`
> `# absent from this crontab, /etc/cron.d and systemd timers; its log's last line`
> `# was 2026-08-19 00:20. stalled-projects.sh had never been scheduled at all.`

That is exactly this project's failure class, caught independently and fixed
hours before this audit ran: a verification script whose own header claimed
active cron coverage was, for six days, wired into nothing — discovered the same
way this D1 audit finds everything else, by refusing to trust the header and
checking the actual scheduler.

**Scope note, not a finding to chase further here.** This project's brief is
`scripts/checks/**`; cron/`/etc/cron.d` is included in this report only because
`scripts/ops/` has no other execution path and the brief's own closed-runner-set
proof requires checking it. But the discovery above makes a broader point worth
naming and then leaving alone: **cron is a second registry of verification
scripts, running this repo's checks by a completely different mechanism than
`gates-808.sh`/`guard.sh`, with no owner watching whether an entry silently
falls out of it.** The August-19-to-August-25 gap on `fleet-watchdog.sh` is proof
that mechanism rots exactly like the gate suite does, undetected for the same
reason (nothing watches the watcher). This is out-of-scope-but-found: D1 does
not expand into a full cron audit, so it does not vanish from this report and it
does not get chased further inside this task either.

## Known instances — re-measured, not trusted from the brief

| instance | brief expected | measured |
|---|---|---|
| `check-secret-scan.ts` in `gates-808.sh` | 0 | `grep -c check-secret-scan scripts/checks/gates-808.sh` → **0**, confirmed |
| `check-browser-takeover-ticket.ts` | orphan candidate | **PROCEDURE-INVOKED**, not orphan — `docs/plan/aios-browser-takeover-live/deploy.md:41,51`, a not-yet-executed deploy runbook; see headline at top of this doc |
| `verify-control-plane.sh` | orphan candidate | **PROCEDURE-INVOKED**, not orphan — `docs/tools/run-control.md:756-761`, current doc |
| `api-diff.sh` | orphan candidate | LIVE-ORPHAN, confirmed — phase-300 baseline still on disk, diff never re-run |
| `contrast-nav-rail.cjs` | name-twin orphan | LIVE-ORPHAN, confirmed |
| `contrast-role-tints.cjs` | name-twin orphan | LIVE-ORPHAN, confirmed |
| `contrast-canvas-banners.cjs` IS gate 6 | — | it **is** wired (`gates-808.sh:178`), but it is gate **12** of 24 in the current numbering (`no-raw-colours.cjs` is gate 5, three tsc/build gates and one token-purity gate precede it) — the brief's "gate 6" label is stale against the current script; reported as measured, not corrected silently. |

## Summary

| bucket | scripts/checks | docs/plan/artifacts cjs/mjs | scripts/ops + scripts/deploy | test.ts/tsx |
|---|---:|---:|---:|---:|
| LIVE-WIRED | 17 | 5 | 9 (4 action, 5 verification/detector) | 72 |
| LIVE-ORPHAN | 44 | 0 | 0 | 3 |
| SPENT | 5 | 53 | 2 | 0 |
| PROCEDURE-INVOKED | 2 | 0 | 0 (2 more are NOT-A-CHECK actions invoked by a current doc — see table) | 0 |
| NOT-A-CHECK | 4 | 19 | 9 | 0 |
| **total** | **72** | **77** | **20** | **75** |

(**244 artefacts audited in total**, cross-checked against the TSV's own row count.
The docs/plan/artifacts SPENT/NOT-A-CHECK split corrects the sub-agent's own summary
line, which added to 55/17 — a hand recount of its 77-row table gives 53/19; the
table itself, not its summary sentence, is the source of truth and is what the TSV
encodes.)

Item 1 of the brief's evidence (`check-secret-scan.ts`) is one instance of a
44-wide LIVE-ORPHAN class in `scripts/checks/` alone, sitting next to a
security-route gate one notch less severe than orphaned —
`check-browser-takeover-ticket.ts` guards the repo's one unauthenticated public
route but is at least invoked by a (not-yet-run) deploy runbook, PROCEDURE-INVOKED
rather than pure LIVE-ORPHAN — and two more name-twins beyond the one already
known (`contrast-nav-rail.cjs`/`contrast-role-tints.cjs` vs
`contrast-canvas-banners.cjs`, matching `check-secret-requests.ts` vs
`check-secret-scan.ts`). D2 (can-it-fail) should prioritise the LIVE-ORPHAN set
in order of self-claimed severity above, and treat both PROCEDURE-INVOKED
entries as a distinct, second-priority tier — weaker than orphan-severity
alone would suggest, since a human-run path exists, but not to be waved
through as "covered" either. D3 (mutation rule) has two working models already
in this repo to generalise from — `test-guard-discrimination.sh`'s
inject/assert-RED/remove/assert-GREEN pattern, and
`check-instrument-typecheck.sh`'s own step-9b canaries (make the compiler fail
twice and succeed once before trusting any verdict).
