# Phase 4 — GATE REPORT (R4-gate)

**Workstream** `connections` · branch `project/7851068b-connections`
**Tip reviewed:** `c792b3a533330af47320b75a616a9bd712a7a61c` (`git rev-parse HEAD`, re-read at
2026-08-18T22:09:54Z immediately before the blockers below were written; unchanged from the tip I
started on).
**Merge-base:** `3f98e67114a8a1fd12fced068e2238b51c766462` (`git merge-base project/7851068b HEAD`).
**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` — the **per-project** path.
Both candidate paths exist (`docs/plan/03-quality.md`, 28127 bytes, is the legacy fleet-wide one);
I read both and gated against the per-project one, which is the layout this corpus was planned under.

**VERDICT: NEEDS_FIXES.** Three blockers, listed in §7. The engineering in this phase is genuinely
strong — the invariant work is layered, the persistence proof carries a real control, and the twelve
assertions are differential rather than inert. It fails on delivery, not on craft: two of its six
requirements never reach a surface Konrad can open.

---

## 1. Adjudication of the red-team report (R4-red, `c792b3a`) — every attack, in writing

The instruction is to adjudicate **every** attack. I re-ran the load-bearing ones rather than
accepting the claim.

### ATTACK 1 — "a status renders positive without a probe" → **UPHELD as reported (HELD for the four, BROKEN for the fifth row)**

I confirm the core claim independently. `check-connection-states.ts` passes at HEAD (§3), and its
assertions are *differential* — each prints `separates X from Y  [holds on <fixture>, fails on
<other>]`, which is the shape that survives the inert-assertion failure mode this fleet has been bitten
by. That is the right instrument and it is wired correctly.

The report's own mutation table (M1–M5, S1–S3) is the strongest evidence in it: 7 of 8 mutations were
killed, and it discloses the one that survived rather than burying it. I did not re-run the eight
mutations — the check's differential output is independent evidence for the same property, and the
report's method (`git archive` into `/tmp`, never the worktree, restore-by-sha256) is sound.

**Sub-finding 1 (medium) — the `connected` + `identity: null` fixture hole: ADJUDICATED VALID.**
Verified in the subject: `classifyAgyProbe()` returns `identity: null` on success
(`forge-control/src/lib/connection-status.ts:599-606`), and the unit suite even asserts this —
`ok 2 - identity stays null — 'agy models' never names an account`. So the *normal* agy success path
carries a null identity, while `check-connection-states.ts:147` hands the agy CONNECTED fixture an
identity string agy can never produce. The fixture is unfaithful to the subject. Real, correctly
diagnosed, **not a blocker** — it is a gap in test coverage, not a defect on screen, and N8 says a
two-sentence fix folds into an existing task.

**Sub-finding 2 (high) — the Google AI Ultra row (`FINDING 2`): ADJUDICATED VALID, BUT NOT A PHASE-4
BLOCKER.** I verified every link of this chain myself rather than taking it:

```
$ PID=$(ss -lptn 'sport = :7700' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); echo $PID
1679556
$ tr '\0' '\n' < /proc/1679556/environ | grep ^PATH=
PATH=/usr/bin:/usr/local/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
$ tr '\0' '\n' < /proc/1679556/environ | grep ^PATH= | grep -c "/root/.local/bin"
0
$ env -i /root/.local/bin/agy --version < /dev/null
1.1.14
```

(Note: I measured pid **1679556**; the red-team measured **1903420**. forge-control has been restarted
by something else between the two readings. The conclusion is identical and the discrepancy is in the
PID only — I record it because a number quoted without its tree-state is how this fleet gets bitten.)

`agyOnPath()` (`forge-control/src/routes/usage.ts:134`) resolves `agy` against the *forge-control
process's* `PATH`, which pm2 populates without sourcing `.bashrc`. So `cli_installed` is false, the
`auth_note` at `usage.ts:167` becomes "Antigravity CLI (agy) is not installed on this box", and
`ultraConnection()` (`connections.ts:616-643`) renders it verbatim. It is a false statement on screen,
and the remedy it prints tells Konrad to install software that is already installed.

**Why it is not a phase-4 blocker, established by measurement, not by charity:**

```
$ git diff --name-only 3f98e67...HEAD | grep -c "routes/usage.ts"
0
$ git diff 3f98e67...HEAD -- forge-control-web/app/desktop/settings/ConnectionsPanel.tsx \
    | grep -nE "^[+-].*ultraConnection"
(no output — the row is not added, removed or modified by this phase)
$ git log --oneline --diff-filter=A -- .../ConnectionsPanel.tsx | tail -1
4f6cd31 fix(round1876): one indicator row, one query, one cadence — …
```

The row predates the merge-base and this phase did not touch it. It also does not breach **R57**, whose
text is "no connection may render a **positive** state without a `checked_at`" — the Ultra row renders
`absent` / NOT CONNECTED, a *false negative*. R57 is not violated. Booked as inherited debt for the
integration/next phase, with the fix the red-team proposes (derive from `access(AGY_BIN, X_OK)` and the
persisted probe record, as `routes/integrations.ts:834` already does) — which is correct and which I
endorse.

**Sub-finding 3 (medium) — `agy` exit 0 with no output reads SIGNED IN: ADJUDICATED VALID.** Verified
in the subject at `connection-status.ts:600-607`: `outcome.code === 0` sets `ok: true` unconditionally,
and the detail string falls back to the literal `"(exit 0 but no output)"`. A chip that says SIGNED IN
above a line admitting it saw no output is the exact self-contradiction this phase was convened to
abolish. Currently unreachable — the real `agy models` prints 7 models — so it is a latent defect, not
a live one. **Not a blocker**; fold the fix (require non-empty stdout for `ok: true`) into the fix cycle.

### ATTACK 2 — "a secret reaches a log, URL, chat message or artefact" → **UPHELD, and I found it UNDERSTATED**

The substance holds: I found **no credential value** anywhere. But the report's arithmetic on
`check-secret-scan.ts` is now wrong, and wrong in the unsafe direction.

I established the baseline myself rather than accepting "baseline 6". My first attempt is worth
recording because it is this project's own subject — an instrument that lied:

```
$ git archive 3f98e67 | tar -x -C /tmp/gate-baseline-tree
$ cd /tmp/gate-baseline-tree && tsx scripts/checks/check-secret-scan.ts ; echo $?
Error: Command failed: git ls-files
fatal: not a git repository (or any of the parent directories): .git
1
```

`git archive` drops `.git`, and the check enumerates via `git ls-files`. That **EXIT=1** is the harness
dying, and taken at face value it reads as "the baseline is red too" — the exact wrong conclusion. Re-run
against a real clone:

```
$ git clone -q --no-checkout --shared <worktree> /tmp/gate-baseline-clone
$ cd /tmp/gate-baseline-clone && git checkout -q 3f98e67 && git rev-parse HEAD
3f98e67114a8a1fd12fced068e2238b51c766462
$ tsx scripts/checks/check-secret-scan.ts ; echo $?
6 FILE(S) FAILED — live-looking DB credential committed
1
```

**Baseline = 6 files (already red at the merge-base). HEAD = 8.** Phase 4 added **two**, not one:

| # | File | Commit | Task |
|---|---|---|---|
| 1 | `phase4/executor-auth-determination.md:55` | `3d915c0` | B4a |
| 2 | `phase4/red-team-report.md:235` | `c792b3a` | **R4-red itself** |

The report could not have disclosed the second — it *is* the second, created by the act of quoting the
first. Both are the author's own three-asterisk redaction in a connection-string-shaped sentence,
tripping `DSN_RE` (`check-secret-scan.ts:55`) whose `SAFE_MARKERS` does not recognise that marker. I
confirmed the redacted segment is literally three asterisks and carries no credential:

```
$ grep -oE "ai_os_app:.{1,4}@" docs/plan/artifacts/os-usable-for-work/phase4/*.md | sort -u
docs/…/executor-auth-determination.md:ai_os_app:<three asterisks>@
docs/…/red-team-report.md:ai_os_app:<three asterisks>@
```

**I reproduce neither the DSN-shaped string nor a pattern that resembles one, and my first draft got
this wrong** — worth recording, because it is the defect measuring itself. The draft quoted its own
search pattern, `"postgres…://ai_os_app:[^@]*@"`, and `DSN_RE`
(`check-secret-scan.ts:55`) read the `[^` before the `@` as a password segment. That made *this report*
the **ninth** red. The fix is the one I prescribe in Blocker 2: stop being connection-string-shaped —
not widen the gate. Note also that `SAFE_MARKERS` (`:51`) already accepts angle brackets, so
`<three asterisks>` is recognised as a placeholder; three literal asterisks are not. That is exactly
the one-token allowance Blocker 2 asks for.

So: **no secret leaked — ATTACK 2's substance is upheld** — but a named security gate goes from 6 red
to 8 red on this phase's watch, and my brief's rule is no new red versus baseline. **Blocker 2.**

### ATTACK 3 — "an integration reports connected when its token is revoked" → **UPHELD**

Nine forced-failure scenarios, each carrying the verbatim upstream status and body; the fake token
absent from every persisted detail; clock-drift and deleted/corrupted-sidecar cases included, with a
corrupt store throwing rather than degrading to a state. That is the right adversarial shape, and R58
is satisfied. I re-ran the unit suite that covers this layer: **1354 pass, 0 fail** (§3).

I also credit the report for recording a methodological error against itself (a `Date.now()` captured
at module load, producing `0s in the future` on every render). An adversarial reviewer that discloses
its own broken instrument is doing the job.

### The report's §5 structural finding → **UPHELD, and it is my primary blocker**

See §2.

### The report's §4.4 write-set audit → **UPHELD, verified independently against the task rows**

See §4.

---

## 2. BLOCKER 1 — `AgyCard` and `GitHubCard` are on no surface; R54 and R56 are undelivered

Write-sets are DECLARED on the task row, so this gate is satisfiable by construction. The mount claim
I verified directly:

```
$ grep -rn "<AgyCard\|<GitHubCard" forge-control-web/app/
>>> STILL NOT MOUNTED <<<          # re-run at 2026-08-18T22:09:54Z against HEAD c792b3a

$ grep -nE "<Row|summary=\{|<[A-Z][A-Za-z]+Card" .../ConnectionsPanel.tsx
183: <Row  184: summary={googleConnection(google)}   188: <GoogleCard onFacts={setGoogle} />
195: <Row  196: summary={geminiKeyConnection(        204: <GeminiCard onFacts={setGemini} />
206: <Row  207: summary={ultraConnection(quota.data?.gemini)}
314: <Row  316: summary={claudeConnection(a, serving === a.slug)}   331: <AccountCard
```

`ConnectionsPanel.tsx` mounts exactly four rows: Google, the Gemini API key, Google AI Ultra, and the
Claude accounts. There is **no `agy` row and no GitHub row**. `AgyCard` (`integrationCards.tsx:1152`)
and `GitHubCard` (`:1341`) are exported and referenced only inside their own module and by
`scripts/checks/check-integrations.tsx` — never by a rendered surface.

The consequence against the requirements I gate:

- **R54** — "the `agy` settings affordance surfaces the login step Konrad must perform… and afterwards
  verifies by running a real `agy` command". Not reachable.
- **R56** — "GitHub connection status is verified by a real call to `GET /user`, showing the login it
  returns and the scopes… Assert the rendered status names the GitHub login and at least one scope."
  Not reachable, and additionally not satisfiable today: no secret named `github-pat` exists, so the row
  would render ABSENT even once mounted. `resolveGithubToken()` (`connection-status.ts:1043`)
  deliberately refuses to guess between `github-pat-konrad` and `github-pat-shane`. That refusal is
  **correct** and I endorse it — but it means C4 needs Konrad to store the PAT under the canonical name
  through the secure panel before R56 can go green.

This is the project's own defect class turned on itself. The brief's Lane 2 rule is that an unbuilt
surface must **say so on screen** rather than render as though it were absent; here two *built,
correct, tested* integrations are invisible, which reads to Konrad exactly like "not built".

**Credit where it is due, and it matters for how this is fixed:** B4c did **not** conceal this. It is
recorded as a counted, run-failing blocker in `browser-harness-phase4.cjs:540-566` with the reason —
*"no mount point — ConnectionsPanel.tsx belongs to B4a and B4c may not write it"* — and the proof
screenshot is honestly captioned "B4c proof mount — Throwaway page", not Settings. B4c obeyed the
file-ownership rule in `04-phases.md` ("two builders in one workstream may not declare the same file")
and escalated instead of racing. **The task did the right thing; the phase plan left the last two
inches unowned.** That is a planning gap, not misconduct, and the fix belongs to one owner.

## 3. The acceptance criteria, each run by me

| Criterion (04-phases.md Phase 4 / my brief) | Result |
|---|---|
| **S9** — every connection carries `checked_at`; null renders UNKNOWN, never green | **PASS** — by running the fixtures, not by reading a claim (below) |
| The **twelve** state assertions (4 integrations × 3 states) | **PASS** — `ALL PASS`, EXIT=0, differential form |
| `agy` spawns under `env -i` | **PASS** — re-run myself, with its control |
| Google status survives a restart | **PASS** — a real process death between two reads of the same `checked_at` |
| No secret in any diff, transcript or artefact | **PASS** on secrets; **but** see Blocker 2 (gate red count) |
| R44 determination exists, names table/db/PORT 5434/file/function, committed BEFORE implementation | **PASS** — `git log` order verified |

**The twelve assertions** — `cd forge-control-web && tsx --tsconfig ../tsconfig.checks.json
../scripts/checks/check-connection-states.ts`:

```
  ok   github: "state is unknown" separates never-checked from freshly-ok  [holds on github.never, fails on github.ok]
  ok   github: "state is connected" separates freshly-ok from never-checked  [holds on github.ok, fails on github.never]
  ok   github: "state is broken" separates a failed probe from a successful one  [holds on github.fail, fails on github.ok]
  ok   github: "carries the verbatim upstream text" separates broken from ok  [holds on github.fail, fails on github.ok]
  … (google, agy, gemini likewise) …
§8 a corrupt record is an ERROR, not a state (N1)
  ok   an unparseable checked_at throws, naming the value
  ok   a non-positive interval throws rather than dividing by it
  ok   a checked_at in the future renders UNKNOWN, not a very fresh CONNECTED
  ok   …and it strips the identity with it
  ok   an absent substrate renders NOT CONNECTED, not BROKEN
ALL PASS — phase 4 connection states (4 integrations × {null, fresh-ok, fresh-fail, stale}, R50/R51/R57/R58)
EXIT=0
```

Each line names the fixture it holds on **and** the one it fails on. That is what makes S9 measured
rather than asserted, and it is the single best thing in this phase.

**`agy` under `env -i`** — re-run by me, not read:

```
$ tsx --test forge-control/src/lib/connection-status.test.ts
ok 1 - AGY_BIN is absolute
ok 3 - agy spawns under env -i, proving the absolute path is what carries it
ok 5 - a bare `agy` under env -i fails with ENOENT — the control for the test above

$ env -i /bin/sh -c 'agy --version'      → /bin/sh: 1: agy: not found
$ env -i /root/.local/bin/agy --version  → 1.1.14
```

The suite ships its own **control** (a bare `agy` must fail), which is what stops the positive test
from being vacuous. R52 holds.

**Google persistence (R48)** — I re-read `google-persistence-proof.md` for the thing the criterion
actually demands, a process death between two reads of the *same* `checked_at`:

- §3 instance A, `pid=1196509`, probes → writes `checked_at 2026-08-18T20:07:51.991Z`
- §4 `$ kill 1196509` → `instance A is dead (pid 1196509 gone)`; new instance `pid=1198193`
- §4 after restart → `"checked_at": "2026-08-18T20:07:51.991Z"` — the same timestamp, read by a
  process that never held it in memory

and, decisively, a **CONTROL at the old code** (`f8f12e8`, port 7743): same probe, same kill, and
`last_check = null`. A proof that only shows the new code passing cannot distinguish a real guarantee
from an inert test; this one shows the old code failing the identical procedure. That is the standard
this project asks for and it is met.

Live forge-control was never restarted: §2 and §6 record the same listening PID before and after.

**R44 ordering** — `git log --name-only 3f98e67..HEAD` (oldest last):

```
3d915c0 docs(phase 4/B4a): executor-auth determination …   ← determination
f8f12e8 feat(phase 4/B4a): Claude accounts carry the age …  ← implementation
```

The determination commit precedes the implementation commit. It names `ai_os.claude_accounts`,
port **5434** (explicitly not the `content_forge` instance on 5432), `listAccounts()` in
`db/claude-accounts.ts`, and `classifyCredential()` in `lib/account-health.ts`. **PASS.**

## 4. Write-set audit (mandatory gate) — three undeclared writes, CONFIRMED

Declared write-sets pulled from the task rows via `GET /api/projects/7851068b-…`, compared against
`git log --name-only` per task. Not reconstructed from briefs.

| Task | Declared | Actually touched | Undeclared |
|---|---|---|---|
| **B4a** `9e69a827` (`3d915c0`,`f8f12e8`) | 11 | 11 | **none** ✅ |
| **B4b** `4af468bb` (`343a65e`) | 6 | 7 | **`scripts/checks/check-integrations.tsx`** |
| **B4c** `a7cd509f` (`5b36eba`) | 10 | 12 | **`phase4/browser-harness-phase4.cjs`**, **`phase4/b4c-after-settings-surface.png`** |
| **R4-red** `61d91352` (`c792b3a`) | 1 | 1 | **none** ✅ |

The consequential one is `check-integrations.tsx`: **declared by B4c, written by both B4b and B4c** —
precisely the two-builders-one-file collision `04-phases.md` Phase 4 forbids, and the rule the same
document invokes to justify B4b's exclusive ownership of `routes/integrations.ts`. `browser-harness-
phase4.cjs` is declared by **B4a** and rewritten by B4c, the same collision in the artefact directory.

The *content* of all three writes is legitimate and in-lane. **The declaration is what failed**, and
none of the three is disclosed anywhere — this project's `04-phases.md` has no §10 disclosure section.
An undeclared write is a finding, not a footnote. **Blocker 3.**

## 5. Gate suite — EXECUTED, with counts

The repo **does** ship a gate suite: `scripts/checks/gates-808.sh`. Run with `--strict` and a
600000 ms timeout. Full transcript committed verbatim at `phase4/gates-phase4.txt` (373 lines).

**25 gates declared · 23 EXECUTED · 2 SKIPPED-by-design · 0 RED · SUITE EXIT=0.**

```
 1  0  npx tsc --noEmit — forge-control            13 0  check-stop-affordance.tsx
 2  0  npx tsc --noEmit — forge-control-web        14 0  check-dismiss-peek.tsx
 3  0  NODE_ENV=production pnpm build — web        15 0  check-team-rows.ts
 4  0  token purity — round 808's own files        16 0  check-team-confirm.ts
 5  0  no-raw-colours.cjs (whole app)              17 0  verify-notification-gap-pins.mjs
 6  0  forbidden-file diff — main...HEAD           18 0  check-usage-fold.ts — real Postgres
 7  0  forge-control/ untouched by 808's commits   19 0  check-usage-fold.ts — standalone typecheck
 8  0  dollar-sweep.sh                             20 0  pnpm test — forge-control unit suite
 9  0  check-composer-v3.ts                        21 0  psql-argv-leak.cjs
 10 0  check-secret-requests.ts                    22 0  nav-walk-sampling.cjs
 11 0  contrast-canvas-banners.cjs                 23 -  phase700/network-700.cjs   (SKIPPED)
 12 0  check-working-sql-agreement.ts              24 -  phase600/nav-walk.cjs      (SKIPPED)
                                                   25 0  reproduce-cleanliness
 RED: 0        SUITE EXIT=0
```

The two SKIPPED are the browser harnesses, skipped by design absent `--browser` — declared by the
suite, not silently dropped.

**Gates-baseline: ABSENT, stated explicitly.**
`docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt` does not exist in this worktree —
phase 1 builds it in the `vault` workstream, whose commits I never see. As instructed I therefore
saved my own full output to `phase4/gates-phase4.txt` and adjudicated by hand. With **0 RED** there is
no red to attribute, so the baseline's absence costs nothing here.

**Gate 17** — recorded in `03-quality.md` §3.1 as a known pre-existing red — is **green (EXIT=0)** at
HEAD. The pre-existing red is superseded, not suppressed.

**Gate 6 (`forbidden-file diff`, which trips on `db/projects`) — adjudicated in writing, as required:**
it passed, and it passed honestly, not vacuously.

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
clean — no engine/Files file differs                       EXIT=0
$ git diff --name-only 3f98e67...HEAD | grep -c "db/projects"
0
```

This phase touched no forbidden file, so there is no red to accept or to fail. Nothing was widened.

### The mandated command block, run verbatim

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
   Lockfile is up to date, resolution step is skipped
   Already up to date
$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
   Lockfile is up to date, resolution step is skipped
   Already up to date
$ cd ../forge-control && npx tsc --noEmit          → EXIT=0
$ cd ../forge-control-web && npx tsc --noEmit      → EXIT=0
$ cd ../forge-control && pnpm test                 → # tests 1354  # pass 1354  # fail 0  (248 suites)  EXIT=0
$ cd .. && bash scripts/checks/gates-808.sh --strict → RED: 0   SUITE EXIT=0
```

Both installs reported **no `- typescript`** removal, and I verified the binaries rather than trusting
the wording — `tsc` and `tsx` present in `forge-control/node_modules/.bin` and `forge-control-web/
node_modules/.bin`. R84's tell is clean.

### The other named checks

| Check | Result |
|---|---|
| `check-connection-states.ts` | **ALL PASS** · EXIT=0 |
| `check-quota-row.ts` | **ALL PASS** · EXIT=0 |
| `check-settings-surface.tsx` | **PASS** · EXIT=0 |
| `check-integrations.tsx` | **PASS** · EXIT=0 |
| `no-raw-colours.cjs` (design tokens) | **PASS** — 222 literals, 176 legitimate, 46 known debt, **0 unlisted** |
| **`check-secret-scan.ts`** | **EXIT=1 — 8 files; baseline 6. TWO new. Blocker 2.** |

**Design tokens, additionally checked against the diff itself** (the phase gate is any `#rrggbb` /
`rgba()` / `hsla()` literal in a UI diff):

```
$ git diff 3f98e67...HEAD -- 'forge-control-web/**/*.tsx' 'forge-control-web/**/*.ts' \
    | grep -nE '^\+.*(#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\()'
(no output)
```

Zero raw colour literals added. Every colour resolves through `tokens` / `HEALTH_STYLE`. **PASS.**

## 6. N1, N4 and the live checkout

**N1 — hard errors, no silent fallback: HOLDS.** No `catch {}` returning a default in the diff (the one
grep hit is a comment *quoting* the rule). Two `??` candidates, each adjudicated by reading the
surrounding code rather than by pattern:

- `ConnectionsPanel.tsx:277` `(registry.data?.accounts ?? [])` — **not** masking a failed call. A load
  failure renders `registry.error` verbatim in its own danger-styled block (`:130-146`), and the
  "no accounts" empty state is gated behind `registry.data &&` (`:290`). A failure and an empty list
  are visually distinct. Acceptable.
- `integrationCards.tsx:957` `account?.scopes.length ?? 0` — unreachable when it could lie:
  `googleConnection()` returns before using `scopeCount` whenever `f.hasAccount === false`
  (`connections.ts:457`), and the value is decoration on an already-decided `summary.state`. Acceptable.

No status degrades to `ok` or `connected` on error anywhere in the diff.

**N4 — worktree-only: HOLDS.**

```
$ git diff --name-only 3f98e67...HEAD | grep -c "src/index.ts"            → 0
$ git diff --name-only 3f98e67...HEAD | grep -E "DesktopApp.tsx|nav-items.ts" | wc -l → 0
```

`forge-control/src/index.ts` untouched; the `surfaces`-lane files untouched. The only `/opt/forge-ai-os`
strings in `git log -p` are prose and one documented **read** of `.env.local`, which is permitted.

**Live-checkout cleanliness — executed, and it has a timeline worth recording.**

```
$ git -C /opt/forge-ai-os status --porcelain          # 2026-08-18T22:06:13Z
 M forge-control-web/app/api.ts
 M forge-control-web/app/desktop/ChatSurface.tsx
 M forge-control-web/app/desktop/chat/slash-registry.ts
 M forge-control/src/routes/chat.ts

$ git -C /opt/forge-ai-os status --porcelain          # 2026-08-18T22:09:54Z
(empty)
```

I found the live checkout **dirty**, and followed the standing protocol rather than the reflex:

1. **Was it the sole copy?** `git log --all -S 'POST /api/chat/:id/compact'` and `-S 'compactChat'`
   both returned nothing — at 22:06 it was in no commit on any branch, so yes.
2. **Preserved** as a git-apply-able patch outside the repo (adding no undeclared write of my own):
   `/opt/ai-os/uploads/$FORGE_RUN_ID/live-checkout-dirty-20260818T2206Z.patch`, 195 lines,
   sha256 `a037bd94fbdc71c9c649eaa26b79679f50c287c73a8b27c752a4d5566c2fc64a`.
3. **Never reverted, stashed or discarded** — the dangerous verb is discard, not commit.
4. By 22:09:54Z the tree was clean because its owner **committed** it:
   `91f6b28 feat(chat): /compact — archive the thread, then keep only the newest 60 entries`.
   Verified preserved: `git log --all -S 'POST /api/chat/:id/compact'` now hits `91f6b28`.

**This is not charged against phase 4, and the check passes at verdict time.** The four files are a
chat-compaction feature; this phase touched none of them
(`git diff --name-only 3f98e67...HEAD | grep -cE "chat.ts|api\.ts|ChatSurface|slash-registry"` → `0`),
and the work was committed by its owner, not lost. Recording the transient rather than either
suppressing it or blocking on it: an empty result at 22:09 with no note would have been a true
statement that concealed a real event.

## 7. The blockers — what is broken, and what would close it

| # | Sev | File:line | Problem | What closes it |
|---|---|---|---|---|
| **1** | **high** | `forge-control-web/app/desktop/settings/ConnectionsPanel.tsx` (after `:207`) | `AgyCard` (`integrationCards.tsx:1152`) and `GitHubCard` (`:1341`) are exported and mounted nowhere. R54 and R56 are unreachable on the surface Konrad opens. | Two `<Row summary={agyConnection(...)}><AgyCard/></Row>` / `<Row summary={githubConnection(...)}><GitHubCard/></Row>` blocks, plus threading `recheck_interval_ms` from `GET /api/integrations/connections`. **One owner** — the file is B4a's; do not race two tasks on it. |
| **2** | med | `phase4/executor-auth-determination.md:55`, `phase4/red-team-report.md:235` | `check-secret-scan.ts` EXIT=1 with 8 files against a baseline of 6 — two new reds on this phase's watch. Neither is a credential (verified: the segment is literally three asterisks). | Reword both lines so they are not connection-string-shaped, **or** add that marker to `SAFE_MARKERS` scoped to the exact token — never to the file or the directory, so a real credential elsewhere in the same file still fails. Do not fix it by quoting it again. |
| **3** | med | B4b `343a65e`, B4c `5b36eba` | Three undeclared writes; `check-integrations.tsx` written by two builders, the collision `04-phases.md` forbids. | Amend the task rows' declared write-sets to match what was written, and disclose the two-builder overlap in the phase record. Content needs no change. |

**Fold into the fix cycle, do not seed rounds for (N8):** the `connected`+`identity:null` fixture hole
(`check-connection-states.ts:147`); the `agy` exit-0-no-output classification
(`connection-status.ts:600`); the deliverable named `phase4/agy-flow.md` in `04-phases.md` shipped as
`agy-flow-affordance.md`.

**Booked as inherited debt, not chargeable here:** the Google AI Ultra row (`usage.ts:134,167`) — real,
high-impact, pre-existing, and in a file no phase-4 task declared.

## 8. What is genuinely good, and should survive the fix cycle

Stated because a NEEDS_FIXES that reads as a condemnation gets the wrong thing rewritten.

- **The twelve assertions are differential.** Every line names the fixture it holds on and the one it
  fails on. That is the antidote to the inert-assertion failure this fleet keeps re-learning.
- **The persistence proof carries a control at the old code.** It shows `f8f12e8` failing the identical
  kill-and-reread procedure. Without that, the proof would not distinguish a guarantee from a tautology.
- **The `env -i` test ships its control** — a bare `agy` must fail with ENOENT.
- **R57 is enforced in three independent layers** (`effectiveHealth()`, `renderSafeAccount()`,
  `claudeConnection()`), and the red-team killed 7 of 8 mutations against them.
- **`resolveGithubToken()` refuses to guess** between two similarly-named secrets and says so. That is
  the correct call and it should not be "fixed" into a heuristic.
- **B4c escalated instead of racing** on a file it did not own, and captioned its proof screenshot
  honestly as a throwaway page. Blocker 1 exists because the plan left those two inches unowned, not
  because a builder cut a corner.

---

*Gate run against tip `c792b3a533330af47320b75a616a9bd712a7a61c`, HEAD re-read at 2026-08-18T22:09:54Z
and unchanged. Every number above carries the command that produced it (N10).*
