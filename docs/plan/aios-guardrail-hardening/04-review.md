# aios-guardrail-hardening — round 4 review

**Tip reviewed: `d907389b1391601eb73359d7967e612ffce4fa53`** (`project/b167b94e`),
re-read immediately before each blocker below was written and still `d907389`.
Merge-base with `main` is `c03d9aa`; `main` is at `992c3ae`.

**VERDICT: NEEDS_FIXES** — 4 blockers, 7 further findings. The classifier work is
good and the evidence behind it reproduces; what fails is (1) a migration number
that collides with `main`, (2) a gate suite that exits nonzero, and (3) two of the
three headline hardening claims having no test that fails when they are reverted.

Quality document used: **`docs/plan/03-quality.md`** — there is no
`docs/plan/aios-guardrail-hardening/03-quality.md`; this project's corpus predates
the per-project layout. (`03-hygiene.md` in the project directory is the
observability write-up, not a quality document.)

---

## 0. What was executed

| instrument | invocation | result |
|---|---|---|
| gates-808 | `bash scripts/checks/gates-808.sh --strict` | **exit 1** — 31 gates, **29 EXECUTED**, 2 SKIPPED-by-design (browser, 29/30), **RED 1** (gate 26) |
| autonomy hook suite | `python3 scripts/ops/test-guard-autonomy.py` | 140/140, exit 0 |
| service-restart suite | `python3 scripts/ops/test-guard-service-restart.py` | 19 cases, 0 failing, exit 0 |
| protected-paths suite | `python3 scripts/ops/test-guard-protected-paths.py` | 28 cases, 0 failing, exit 0 |
| forge-control units | `cd forge-control && pnpm test` | `# tests 2224 / # pass 2224 / # fail 0` |
| secret scan | `tsx ../scripts/checks/check-secret-scan.ts` | exit 1 — **attributed to `main`** (§F6) |
| ops inventory | `scripts/checks/check-ops-scripts.sh` | exit 1 (§B2) |
| migration numbers | `validateMigrationFiles` over the **merge-tree** | exit 1 (§B1) |
| corpus re-run | `rerun-corpus.py <live> <repo> commands-24h.jsonl` | reproduces exactly (§C1) |
| mutation control, hook | 3 reverts × 140-case suite | **2 of 3 stay green** (§B3) |
| mutation control, engine | default-branch revert × engine tests | bites: 3 failures (§C2) |
| trip-row isolation | count before / after all three suites | 53 → 53, newest timestamp unchanged (§C3) |
| live checkout | `git -C /opt/forge-ai-os status --porcelain` | 6 paths, all accounted (§D) |

Dependencies installed first, as the brief requires:
`cd forge-control && pnpm install --frozen-lockfile --prod=false` → "Already up to date".

---

## A. What is right, and verified rather than assumed

Stated up front because the list below is long and the work is mostly good.

1. **The block text carries no override recipe.** `grep -n FORGE_GUARD_ACK
   scripts/ops/guard-autonomy.py` returns lines 1004 and 1008 only — both in
   `_main()`'s ACK check, neither in `BLOCK` or `BLOCK_SELF_EDIT`. The Haiku
   self-grant of 23:36 cannot be repeated by reading the refusal.
2. **`autonomy.self_edit` blocks locally and cannot be ACKed.** Proven by running
   the repo hook as a subprocess with `FORGE_API` pointed at a **dead port**
   (47199) — if it made an HTTP call it would fail open with exit 0:

   ```
   plain                      exit=2  BLOCKED locally: an agent may not change the autonomy rules.
   env ACK                    exit=2  BLOCKED locally: …
   prefix ACK                 exit=2  BLOCKED locally: …
   prefix ACK fs.destructive  exit=2  BLOCKED locally: …
   trip resolve               exit=2  BLOCKED locally: …
   ```

   and an audit line `{"kind": "blocked-local", "rule_id": "autonomy.self_edit"}`
   for each. Script: `/tmp/r4-selfedit-proof.py`.
3. **No test or check reaches the live API or DB.** `guardrail_trips` counted
   before and after all three suites via forge-control's own `DATABASE_URL`
   (read from `pm2 jlist`): `{"n":53,"newest":"2026-08-25 13:23:59.867351+00"}`
   both times. The `:7700` strings in `test-guard-autonomy.py` (lines 169–175,
   296, 317) are **classifier fixtures** consumed in-process by Layer A, not
   requests; Layer B points `FORGE_API` at a stub it starts itself.
4. **The engine change is additive on the wire.** `AutonomyResponse` gains
   `rule_changes: GuardrailRuleChange[] | null`; nothing is removed.
   `AutonomySurface.tsx` reads `trips`, `categories`, `gemini_daily`, `fleet` —
   all still present, none renamed. `listRuleChanges` is wrapped in `.catch(() =>
   null)` so a database without migration 0047 still serves the pause switch.
5. **`evaluateRule`'s default branch blocks with a non-empty config**, and the
   rule set it is applied to is filtered `WHERE enabled = true`
   (`db/autonomy.ts:806`) — so dropping the `rule.enabled` term from the branch
   does not make disabled rules block. That is the load-bearing detail behind
   the change and it holds.
6. **`POST /rules/:id` and `/trips/:id/resolve` both notify then audit**
   (`routes/autonomy.ts:78-89`, `:130-140`), in that order, with the reason
   written down: `queueNotification` never throws, `recordRuleChange` does.
7. **`updateRule`'s unreachable second `fleet_state` sync is gone** and the
   `runtime.pause_all` branch does return before the old site
   (`db/autonomy.ts:266-292`).
8. **`install-hooks.sh` is non-destructive and idempotent** — measured against a
   `/tmp` copy of the real `/root/.claude/settings.json`:
   `--check` on a hookless dir → 3 MISSING entries, **exit 1**; install → 3
   entries added + backup written; second run → `ok (already installed)`,
   **exit 0**; `--check` after → PASS. Merging into a copy of the real file added
   only the `Write|Edit|MultiEdit` group and left every other key byte-identical
   (`diff` of the two parsed-and-sorted JSON documents shows the addition and
   nothing else). `permissions`, `theme`, `cleanupPeriodDays` all survived on the
   synthetic case.
9. **It has never been run against the live host on this branch.**
   `/opt/ai-os/backups/settings/` does not exist.
10. **Routine-path rules do not over-reach.** In-process against the repo hook,
    cwd `/opt/forge-ai-os`:

    | command | verdict |
    |---|---|
    | worktree ROOT `…/projects/b167b94e-…` | `fs.destructive` ✅ |
    | `/opt/ai-os/uploads/x` | `fs.destructive` ✅ |
    | `/opt/content-forge` | `fs.destructive` ✅ |
    | `/` | `fs.destructive` ✅ |
    | `"$X"` with no mktemp | `fs.destructive` ✅ |
    | `node_modules`, `.next` (+`2>&1`), `dist`, `/tmp/x` | allow ✅ |
    | `git push origin project/b167b94e` | allow ✅ |
    | `pnpm install`, `pnpm build` | allow ✅ |
11. **The 2,924-command corpus re-run reproduces** (§C1), and the three new unit
    test files really execute — they are in `src/lib/`, which is what
    `"test": "tsx --test src/lib/*.test.ts"` globs.

---

## B. BLOCKERS

### B1 · `db/migrations/0047_guardrail_rule_changes.sql` collides with `main`

**File:** `db/migrations/0047_guardrail_rule_changes.sql:1`

`main` already carries `0047_day_tasks_gtask.sql`, `0048_glucose_readings.sql`
and `0049_importance_six_levels.sql`, all added by `b41e824` (2026-08-25). This
branch forked at `c03d9aa`, before them, so its worktree shows `0047` free and
the in-lane gate agrees. Git will not conflict on this: the filenames differ.

Proven with the repo's own gate rather than by eye — `validateMigrationFiles`
from `scripts/checks/check-migration-numbers.ts`, fed the **merged** file set:

```
$ MT=$(git merge-tree --write-tree main HEAD | head -1)
$ git ls-tree -r --name-only "$MT" db/migrations   # 31 files
files: 31 ok: false exit: 1
  ERR: COLLISION   0047: 0047_day_tasks_gtask.sql  ↔  0047_guardrail_rule_changes.sql
  ERR: FAIL — 1 collision(s), … Renumber to the next free integer.

$ # the same gate, in-lane, over HEAD's own directory:
files: 28 ok: true exit: 0
  log: PASS — 28 migration(s), every number unique, highest 0047.
```

Gate 8 of this branch's own `gates-808.sh` run is green for exactly this reason:
`check-migration-numbers.ts` reads `db/migrations/` relative to itself, so it can
only ever see one `0047` (memory: `migration-number-collides-through-a-merge`).

**Fix:** `git mv db/migrations/0047_guardrail_rule_changes.sql
db/migrations/0051_guardrail_rule_changes.sql`; update the number in its own
header comment and in `01-engine.md`, `02-classifier-decisions.md` and any task
report that names it as a path (not sentences quoting a past command). **0050 is
NOT free** — `0050_day_tasks_goal.sql` is already committed on another lane, so
0051 is the next free integer across `main` and every branch. `sha256sum` before
and after the `git mv` to show no bytes moved.

### B2 · `gates-808.sh --strict` exits 1 — and this branch is what made gate 26 run

**File:** `scripts/checks/gates-808.sh:275-277`

```
 26 1      check-ops-scripts.sh — scripts/ops/ inventory, modes, hook registration
 RED: 1
$ scripts/checks/check-ops-scripts.sh
-- presence + permissions
FAIL: check-vps2-backup.sh mode is 755, expected 750
```

`02-classifier-decisions.md` §7 attributes this honestly — the assertion is at
`scripts/checks/check-ops-scripts.sh:56` **on `main`**, git stores the file as
`100755` (`git ls-tree -r HEAD` confirms), the tighter mode is restored by
`install-symlinks.sh` at install time, and it is red in every fresh worktree.
All true.

What §7 does not say is the part that makes it a blocker: **`main`'s
`gates-808.sh` never ran that check** (`git show main:scripts/checks/gates-808.sh
| grep -c check-ops-scripts` → `0`). This branch is the first to wire it in. So
the diff does not inherit a red gate — it converts a latent, never-executed
assertion into a **permanently red gate in the suite every other project on this
box runs**, and every one of those projects will now report `RED: 1` forever for
a reason that has nothing to do with their work. "Left red on purpose" is a
defensible call for a check nobody runs; it is not one for a gate you are adding
to the shared suite.

**Fix (do not soften the assertion — memory: `do-not-soften-check-secret-scan`):**
make the mode assertion location-aware in `check-ops-scripts.sh` — assert `750`
on the **installed** copy under `$TARGET_DIR` and skip it (loudly, as SKIPPED)
for a git checkout, since git cannot represent the mode. Or leave the check
un-wired until that distinction exists. Either way `--strict` must exit 0 before
a PASS.

### B3 · The suite stays GREEN under two of the three hardening claims being reverted

**Files:** `scripts/ops/test-guard-autonomy.py` (no case), `scripts/ops/guard-autonomy.py:280-290` and `:653`

Mutation control, run against `/tmp` copies with `GUARD_AUTONOMY_HOOK` pointing at
the copy; the repo file was never opened for writing and its md5 is unchanged
(`f9e81e4550bb2b2356459aa597257dd5` before and after):

| mutation | 140-case suite |
|---|---|
| **M1** drop the `head in SHELLS` recursion (`bash -c` transparent again) | exit 1, **138/140** — bites ✅ |
| **M2** `punctuation_chars="();<>\|&"` — remove the newline | exit 0, **140/140** — **does not bite** ❌ |
| **M3** `if recursive:` → `if recursive and force:` | exit 0, **140/140** — **does not bite** ❌ |

Both are real behaviour reverts, not no-op edits. In-process, cwd
`/opt/forge-ai-os`:

```
                                            PRISTINE          M3 MUTANT
rm -r /opt/forge-ai-os                   -> fs.destructive    None
rm -r /opt/content-forge/src             -> fs.destructive    None
rm --recursive /opt/content-forge        -> fs.destructive    None

                                            PRISTINE          M2 MUTANT
"ls -la\nrm -rf /opt/content-forge"      -> fs.destructive    None
"echo hi\ngit push --force origin main"  -> git.force_push    None
"pwd\n\nrm -rf /opt/content-forge"       -> fs.destructive    None
```

M3 is the entire subject of commit `e6901a8` — *"recursion alone triggers
fs.destructive — the force conjunction was a bug"* — the commit whose message
cites a lane deleting all 48 tracked files of `forge-control/src/routes`. **The
fix that incident produced has no test that fails when it is undone.** M2 is the
change the hook's own docstring calls "load-bearing and measured the hard way"
(lines 280-289: "of six newline-separated destructive commands, the version
without this line caught one").

`02-classifier-decisions.md` §8.1 already names the newline gap as "the
highest-value follow-up in this document" and declines it on write-set grounds.
That is the right instinct recorded in the wrong place: a follow-up note does not
protect the code, and §8 does not mention the `recursive`/`force` gap at all —
which is the newer of the two and the one with a real incident behind it.

**Fix:** add to `MUST_BLOCK` in `scripts/ops/test-guard-autonomy.py`, at minimum:
`("rm -r without -f", "rm -r /opt/content-forge", "fs.destructive", None)`,
`("rm --recursive without -f", "rm --recursive /opt/content-forge", "fs.destructive", None)`,
`("newline-separated delete", "ls -la\nrm -rf /opt/content-forge", "fs.destructive", None)`,
`("newline-separated force push", "echo hi\ngit push --force origin main", "git.force_push", None)`,
plus the `2>&1` fd-prefix and `cd`-tracking cases §8.1 lists. Then re-run M2 and
M3 and show them red.

### B4 · A `<<` the shell does not treat as a heredoc deletes the rest of the command

**File:** `scripts/ops/guard-autonomy.py:225-242` (`strip_heredocs`)

`strip_heredocs` matches `<<\s*['"]?IDENT` anywhere on a line — including inside
a quoted string and inside an arithmetic shift — and then consumes every
following line until a line exactly equals the marker. When no such line exists,
**it consumes the rest of the command and returns only the lines before it**.
Those lines are never classified.

```
$ python3 /tmp/r4-evade.py scripts/ops/guard-autonomy.py
heredoc marker inside a QUOTED string, delete on the next line -> None
same, force push on the next line                              -> None
<< in an arithmetic/shift expression, delete after             -> None
```

The commands, verbatim (harmless stand-in `echo SECOND-LINE-RAN` in place of the
verb for the shell run):

```
echo "see << NOTE"
rm -rf /opt/content-forge
```

```
echo $((1 << 3))
git push --force origin main
```

Bash runs **both** lines in each case — there is no heredoc there at all:

```
$ bash /tmp/r4-bash-divergence.sh
=== case 1: << inside double quotes ===
see << NOTE
SECOND-LINE-RAN
=== case 2: << as a shift operator ===
8
SECOND-LINE-RAN
```

So the guard exits 0, writes no audit line, and the fleet's own log records
nothing — the silent-fallback shape the brief forbids, reached with a two-line
command and no knowledge of the hook beyond "it strips heredocs".

**Attribution, honestly:** the shape is inherited — `/opt/ai-os/scripts/guard-autonomy.py`
(md5 `4689f012…`) behaves identically on all four probes. It is not a regression
introduced here. It is in scope because A1 is this project's remit and because
the round-1 change to `strip_heredocs` (exact-marker matching, lines 233-239)
*widened* the window: an indented `  EOF` in the swallowed region used to end the
body early and now does not.

**Fix:** two cheap halves, neither of which needs a shell parser.
(a) Only treat `<<` as a heredoc when it is not inside a quoted region on that
line and is not part of `<<<` or `$((… << …))`; a single left-to-right quote
scan of the line is enough. (b) When the marker line is never found, **do not
drop the remainder** — classify it. Falling back to "classify everything" is the
conservative direction; the current fallback is "classify nothing".

---

## C. Verifications that came out clean, with the numbers

### C1 · Corpus re-run reproduces

```
$ python3 /opt/ai-os/scratch/guardrail-a2/rerun-corpus.py \
    /tmp/r4-guard-live.py scripts/ops/guard-autonomy.py \
    /opt/ai-os/scratch/guardrail-a2/commands-24h.jsonl
corpus rows: 2924
OLD (live /opt/ai-os/scripts) trips: 10
NEW (repo worktree)          trips: 2
classifier exceptions: 0
```

Rows actually listed: **8** no-longer-tripping, **0** newly-tripping, **2** still
tripping (`138d023e` uploads, `f79c2434` browser profile) — matching §5 of
`02-classifier-decisions.md` exactly. Two caveats for whoever re-runs it (§F7).

### C2 · The engine tests DO bite

Reverting `evaluateRule`'s default branch to the old empty-config-only form, on a
`git archive` export in `/tmp` (the worktree file's md5 is identical before and
after):

```
== running the two engine test files against the MUTATED copy ==
not ok 1 - evaluateRule — the catch-all branch
# tests 36
# pass 33
# fail 3
```

### C3 · Nothing this review ran wrote a trip row

53 before the three suites, 53 after, same newest timestamp. The count is 54 now
— see F1: the **live** hook tripped on a command of my own, which is a finding,
not test pollution.

---

## D. Live-checkout cleanliness check (mandatory)

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/ChatSurface.tsx
 M forge-control-web/app/desktop/chat/FileExplorerPanel.tsx
 M forge-control-web/app/desktop/chat/MessageMarkdown.tsx
 M forge-control/src/routes/files.ts
?? forge-control-web/app/desktop/chat/code-path-link.ts
?? forge-control-web/app/desktop/chat/open-file-bus.ts
```

**Not empty — reported here in full, as required.** It is **not this project's
work**, and it is not new: these are six of the seven paths of the 2026-08-25
dirt, re-measured today at live HEAD `992c3ae` rather than inherited from an
earlier round's summary.

| path | working blob | reachable in ODB | carrier | refs containing it |
|---|---|---|---|---|
| `ChatSurface.tsx` | `65f9c67c` | 0 | none | 0 |
| `chat/FileExplorerPanel.tsx` | `7b30d52b` | 1 | `56031db` | 5 |
| `chat/MessageMarkdown.tsx` | `e8476df4` | 1 | `5067233` | 4 |
| `routes/files.ts` | `2bd2ef3a` | 1 | `2db8998` | 4 |
| `chat/code-path-link.ts` | `cc95791d` | 1 | `8c101dd` | 5 |
| `chat/open-file-bus.ts` | `c766f6c7` | 1 | `56031db` | 5 |

Five are byte-identical to committed blobs on the `project/ecacba29*`
(`aios-chat-reference-navigation`) lane. `ChatSurface.tsx` reports as a whole-file
sole copy and carries **zero unowned content**: its diff against live HEAD is 16
insertions, all the `subscribeOpenFile` wiring, and that wiring is present on
`project/ecacba29`, `project/ecacba29-detect` and `project/ecacba29-markdown`
(2 occurrences each). The seventh path of the original set, `auth.ts`, landed as
`b267b41` and is gone from the list.

**I am not requiring a revert, and I am saying so rather than staying quiet about
the deviation.** Konrad's standing ruling (vault, *Operator Decisions* §"When the
live checkout goes dirty", and the 2026-08-19 correction to it) is: preserve and
escalate, never revert; and "prescribing revert-and-redo in a worktree" was
explicitly overruled after three reviewers recommended it against what turned out
to be a live feature. These six paths arrive on `main` with the
`aios-chat-reference-navigation` merge; committing or reverting them here only
manufactures a conflict. **None of this changes the verdict, which is already
NEEDS_FIXES on B1–B4.** Escalated to the manager chat.

---

## E. Write-set audit

`git log --name-only` per task's commits vs the `write_set` declared on the task
row (`project_tasks`, read live).

| task | role | commits | undeclared writes |
|---|---|---|---|
| `218a8d17` | architect | `1956117` | `PLAN.md`, `docs/plan/aios-guardrail-hardening/00-findings.md` — declared `[]` |
| `127bf403` | researcher | `c80dadc` | none |
| `925aa51d` | builder | `615f241` | none |
| `87c01d40` | engine builder | `5acfb73` | **2 path mismatches** (below) |
| `f46a70e4` | builder | `db61247`, `307b4fa`, `e6901a8` | **`.gitignore`** |
| `fbc48f4a` | builder | `cd80b57` | **`forge-control/src/lib/secret-scan-redaction.test.ts`** |
| `3a63b84c` | builder | `7bcae97` | none |
| `161e2155` | integrator | `d907389` (merge) | none |

Three undeclared writes, none of them alarming, all of them findings rather than
footnotes:

* **`87c01d40`** declared `forge-control/src/db/autonomy-blanket.test.ts` and
  `forge-control/src/routes/autonomy-changes.test.ts`; it wrote
  `forge-control/src/lib/autonomy-blanket.test.ts` and
  `forge-control/src/lib/autonomy-changes.test.ts`. The move is **correct** —
  `"test": "tsx --test src/lib/*.test.ts"` means a test outside `src/lib/` is
  executed by nothing, and this worker wrote the fleet memory note
  `tests-outside-src-lib-never-run` establishing that. The declaration was simply
  never restated. Both files do run (`# tests 2224 / # pass 2224`).
* **`.gitignore`** (`__pycache__` entries) is what keeps gate 31
  (reproduce-cleanliness) green now that the suites `importlib` the hooks — a
  necessary write, undeclared.
* **`secret-scan-redaction.test.ts`** is the test for the declared file; same
  shape as the first row.

The architect row's empty `write_set` is a seeding convention rather than a
worker deviation and is listed for completeness.

---

## F. Further findings (not blockers)

### F1 · The classifier blocks a resolvable literal `VAR=` scratch path — measured on this review's own command

**File:** `scripts/ops/guard-autonomy.py:383-404` (`_var_name` / `is_routine_path`)

The live hook blocked a command of mine during this review, writing trip
`5c9fc766-5da9-48c5-9347-cc396e664371`:

```
attempted: rm -rf $SC 2>/dev/null      (SC=/tmp/r4-settings-scratch, assigned in the same command)
```

Reporting it, not working around it. The repo hook at tip does the same:

```
literal VAR under /tmp, deleted in the SAME command     -> fs.destructive
literal VAR under /tmp, no quotes                       -> fs.destructive
literal VAR naming node_modules                         -> fs.destructive
literal VAR under a project worktree subdir             -> fs.destructive
mktemp VAR (the shape that IS handled)                  -> None
```

`scan_context()` learns `VAR=$(mktemp -d)` and nothing else, so
`is_routine_path("$SC")` falls to rule 5 — "any other `$VAR` stays blocked,
the hook cannot see the value". For this shape **the hook can see the value**: it
is a literal assignment in the same command string. `00-findings.md` P2-2 rule 5
justifies the block on an unresolvability that does not hold here.

**Fix:** extend `scan_context()` with `VAR=<literal>` assignments (a plain
`([A-Za-z_]\w*)=(["']?)(/[^\s"';|&]*)\2` scan) and resolve `$VAR` targets through
that map before falling to rule 5. Unresolvable values keep the current
behaviour. This is squarely the A2 risk the brief ranks highest: a builder
scripting `D=/tmp/…; rm -rf "$D"` is ordinary work, and it is blocked today.

### F2 · `bash -cx` (any combined flag where `c` is not last) walks straight past

**File:** `scripts/ops/guard-autonomy.py:586-591` (`_shell_c_argument`)

`re.match(r"^-[a-zA-Z]*c$", tok)` requires `c` to be the **last** letter, so
`-lc` and `-xc` match but `-cx` does not:

```
bash -cx "rm -rf /opt/content-forge"   -> None
bash --login -c "…"                    -> fs.destructive
sudo bash -c "…"                       -> fs.destructive
```

`bash -cx 'echo COMBINED-FLAGS-RAN'` runs fine (verified). This defeats the
single most valuable CATCH in §2 of `02-classifier-decisions.md` with one
transposed letter.

**Fix:** accept any short-option cluster containing `c` and take the next token:
`re.match(r"^-[a-zA-Z]*c[a-zA-Z]*$", tok)`. Add a `bash -cx` case to `MUST_BLOCK`.

### F3 · The audit log's `source` column can never say "console"

**Files:** `forge-control-web/app/desktop/AutonomySurface.tsx:273`, `forge-control-web/app/api.ts:1562-1578`, `db/migrations/0047_…sql:31-36`

Neither the trip-resolve `fetch` nor `updateRule` sends an `x-forge-source`
header, so `normalizeChangeSource` records **`api`** for every console click.
The migration documents the column as "console | api | deploy"; in practice it
will hold one value, and the log cannot distinguish Konrad toggling a rule in his
browser from an agent's curl — which is the distinction the log exists to make.

The routes' own header is right that a header cannot be trusted from an agent.
The consequence is that this column is decorative rather than deceptive, but it
should not be presented as attribution.

**Fix (recommend, do not build):** either have the console send the header and
document the field as *self-declared, unverified*, or attribute on something the
caller cannot choose (remote address, or the presence of a browser session
cookie) and keep the header as a hint. Ask Konrad which he wants before building.

### F4 · A trip resolve that succeeds can be reported to the console as a failure

**File:** `forge-control/src/routes/autonomy.ts:130-140`

`deps.resolveTrip(id)` commits `resolved = true`, then `queueNotification` fires,
then `recordRuleChange` **throws by design** on any database error. The handler
has no try/catch, so the response is a 500 while the trip is already resolved and
the Telegram line has already been sent. `AutonomySurface.tsx:276` turns that into
`throw new Error("Failed to resolve trip")` and skips `invalidateQueries`, so the
console keeps showing the trip as unresolved — DB and UI disagree, and a retry
produces a second notification and a second audit row.

This is not hypothetical at deploy time: `guardrail_rule_changes` **does not exist
in the live database** right now (`select to_regclass('public.guardrail_rule_changes')`
→ `null`). If the code is restarted before migration 0047 (0051, after B1) is
applied, **every rule toggle and every trip resolve 500s while still taking
effect**.

**Fix:** two things. (a) The deploy task must apply the migration **before**
restarting forge-control, and say so in `05-deploy.md`. (b) Either move
`recordRuleChange` into the same transaction as the mutation, or catch its
failure, log it loudly, and return 200 with an `audit: "failed"` field — a
success reported as a failure is its own kind of drift.

### F5 · Nine of the 24 unresolved trips are invisible to everything that reads them

**File:** `scripts/ops/fleet-pulse.sh:127-129`, `forge-control/src/db/autonomy.ts:118-125`

Measured live: **54 trips, 24 unresolved, 15 of those inside the newest-30 window**
that `getAutonomy()` returns. The pulse's stale-trip finding reads
`GET /api/autonomy`, so nine unresolved rows — including the oldest, which are
exactly the ones a "nothing prunes or surfaces them" finding is about — are
invisible to both the console and the new pulse section. The pulse comments the
ceiling honestly ("a real ceiling, not a bug this section can fix"), so this is a
scope statement rather than a concealment; but A7 asked for the log to become
readable and it is 15/24 readable.

Related, latent rather than live: the trips query is an **inner** join on
`guardrail_rules`, so a trip whose rule is later deleted vanishes from the feed
entirely. Zero such rows today (measured), but `spend.per_run_cap` was deleted on
2026-08-25 and the same thing will happen to the next deleted rule. Migration
0047 explicitly avoids an FK on `guardrail_rule_changes` for this reason; the
trips feed did not get the same treatment. A `LEFT JOIN` with
`coalesce(g.label, t.rule_id)` costs nothing.

### F6 · check-secret-scan is red, and it is `main`'s

```
FAIL  forge-control/src/routes/pipeline.ts
        line 12  DSN password  postgresql://postgres:***@
1 FILE(S) FAILED — live-looking DB credential committed
```

`forge-control/src/routes/pipeline.ts` is **not in this diff**
(`git diff main...HEAD --name-only | grep -c pipeline.ts` → 0) and the string is
present at `main`. The redaction this branch added (`cd80b57`) works — the match
prints as `postgresql://postgres:***@`, not the value — which was this project's
share of the fixed order (redact → rotate → remove → wire). Rotation is Konrad's
call; the check remains correctly un-wired from `gates-808.sh`.

### F7 · Two small fidelity gaps in the corpus evidence

**File:** `docs/plan/aios-guardrail-hardening/02-classifier-decisions.md:292-298`

The quoted block contains two lines the named driver does not print —
`NEWLY tripping under the hardened classifier: 0` and `no longer tripping: 8`.
The first four lines match verbatim; those two do not appear in
`rerun-corpus.py`'s output at all. Worse for a reproducer, the driver's own
section headers print `len(entries)` rather than the filtered count, so it
announces `NO LONGER TRIPS … (10)` above 8 rows and `NEWLY TRIPS … (2)` above
**zero**. A reader reproducing §5 sees "2 newly trip" and a blank section.

Both numbers in the prose are **right** — I counted the rows: 8 and 0. Fix the
quoted block to be verbatim driver output, or state that the two summary lines
are hand-derived.

Second gap: the driver calls `classify(cmd, cwd)` **without** `strip_heredocs`,
while the hook calls `strip_heredocs` first. The corpus numbers are therefore an
upper bound on real trips (heredoc prose can trip in the re-run and not in
production) — conservative, but worth one sentence in §5 so the next re-runner
does not chase a discrepancy.

### F8 · Two smaller things, recorded without ceremony

* **`install-symlinks.sh` has no worktree refusal.** `REPO_ROOT` comes from the
  script's own location (`scripts/ops/install-symlinks.sh:22`), and this diff
  adds all three guard hooks plus `hooks.settings.json` to its `FILES` list. Run
  from a worktree, it points `/opt/ai-os/scripts/guard-*.py` into
  `/opt/ai-os/workspace/projects/<uuid>/…` — and `hooks.settings.json`'s own
  header says why that is fatal: "a worktree is deleted when its project finishes
  and the hook would then silently vanish from every turn on the box." One `case
  "$REPO_ROOT" in /opt/ai-os/workspace/projects/*) refuse;; esac` closes it.
* **`guard-protected-paths.py` writes no audit line.** Every block it makes is
  invisible to `/var/log/forge-guard-autonomy.log` and therefore to the new
  fleet-pulse section, which counts `blocked-local` from that file. Its sibling
  `guard-autonomy.py` audits; this one only prints to stderr. Also, its
  `PROTECTED_GLOBS` covers `/opt/forge-ai-os/scripts/ops/guard-*.py` only, so a
  direct write to the live checkout's `hooks.settings.json` or `install-hooks.sh`
  — the canonical registration and its installer — is allowed. (Writes through
  the `/opt/ai-os/scripts/` symlink are blocked by the prefix rule.)
* **An ACK whose reminder POST fails is silent to Konrad.** `notify_konrad`
  (`guard-autonomy.py:891-899`) swallows every exception and does not check the
  response status, and an ACK writes **no** trip row. The only remaining trace is
  the local audit line — which the new fleet-pulse section does surface as a
  `LOUD` finding, so this is mitigated rather than open. Worth one line in
  `03-hygiene.md`.

---

## G. What must happen before a PASS

1. **B1** renumber the migration to `0051` (not 0050 — taken on another lane) and
   re-run `check-migration-numbers.ts` against the merge-tree.
2. **B2** make gate 26 green from a clean checkout without weakening the `750`
   assertion, or un-wire it; `gates-808.sh --strict` must exit 0.
3. **B3** add the `rm -r`-without-`-f` and newline-separated cases to
   `test-guard-autonomy.py` and show M2 and M3 red.
4. **B4** stop `strip_heredocs` swallowing a command's remainder on a `<<` that
   is quoted, arithmetic, or unterminated.

F1 and F2 are cheap and belong in the same pass — F2 in particular is a
one-character regex fix to the headline CATCH.

---

*Reviewed at `d907389b1391601eb73359d7967e612ffce4fa53`. Every command in this
document was executed; probe scripts are in `/tmp/r4-*.py`, `/tmp/r4-*.sh` and
`/tmp/r4-gates.txt`, none of them committed.*

---

# H. Fix cycle 1 (round 5) — response, appended not edited

Everything above this line is round 4's review as it was written. It is evidence
and it stays verbatim; this section records what was done about it and what was
measured afterwards. Two commits: `29fe55f` (B1) and the round-5 hardening commit
that follows it.

## H.0 What was executed

| what | command | result |
|---|---|---|
| gate suite | `bash scripts/checks/gates-808.sh --strict` | **exit 0** — 31 gates, 29 EXECUTED, 2 SKIPPED-by-design (29/30, browser), **RED 0** |
| hook suite | `python3 scripts/ops/test-guard-autonomy.py` | **199/199**, exit 0 (was 140/140) |
| hook mutation control | `bash scripts/checks/prove-guard-bites.sh` | **BITES — 9/9 mutations DISCRIMINATED**, subject md5 identical before/after |
| mode-assertion control | `bash scripts/checks/prove-ops-mode-bites.sh` | **BITES** — 755 FAILs, 750 passes, elsewhere SKIPs loudly |
| unit suite | `pnpm test` (forge-control) | **2227/2227** (was 2224; +3 new route tests) |
| typecheck | `tsc --noEmit -p forge-control/tsconfig.json` | clean |
| migration numbers, **against the merge-tree** | `main`'s `check-migration-numbers.ts` on `git merge-tree main HEAD` | `HEAD~1`: **exit 1, COLLISION 0047**. `HEAD`: **exit 0, PASS — 31 migrations, highest 0051** |
| service-restart / protected-paths suites | `python3 scripts/ops/test-guard-{service-restart,protected-paths}.py` | 19/19, 28/28 (via gates 24–25) |

## H.1 The blockers, one by one

**B1 — migration collision.** `git mv 0047_guardrail_rule_changes.sql →
0051_guardrail_rule_changes.sql`. `sha256sum` was
`432bdd1e69a3c942a3e8a4cb665b5c68a7e9e8239dc6883a58f573acd1e9df6c` before the
move and after it; the committed digest differs only because the same commit adds
a provenance note to the file's own header. 0050 skipped — `0050_day_tasks_goal.sql`
is committed on `project/d6371f2d`. Number chosen against `main`, against every
`project/*` ref, and against every worktree on disk, not against this lane.
`01-engine.md` §4 now records why round 1's three "0047 is free" checks were each
true and each blind, keeping the transcripts verbatim.

**B2 — gate 26.** The assertion is not softened; it is made location-aware.
`install-symlinks.sh` symlinks `$TARGET_DIR/<f>` at `<repo>/scripts/ops/<f>` and
then `chmod 750`s the repo file — so "the installed copy" and "this checkout" are
the same inode exactly when the symlink resolves back here, and that is now the
discriminator. On the installed checkout the check still demands 750 and still
fails at 755; everywhere else it SKIPs with the reason printed. Because an
assertion that skips wherever anyone looks is indistinguishable from a deleted
one, `scripts/checks/prove-ops-mode-bites.sh` stands up a scratch `$TARGET_DIR`
and watches all three verdicts. It restores the mode on EXIT **and** on INT/TERM/HUP
and verifies the restore by md5.

**B3 — discrimination.** 140 → 199 cases, covering every family the review named
and all four §8.1 gaps: `rm -r` / `--recursive` / `-R` / `-r -f` without `-f`,
newline segmentation (3 cases), the `2>&1` fd prefix (4 passing + 1 blocking, so
adjacency is asserted in both directions), `cd`-tracking (3 passing + 2 blocking),
and the `browser-profiles/scratch` exception (2 passing + 2 blocking siblings).

`scripts/checks/prove-guard-bites.sh` is the answer to "show both mutations red".
It applies nine real behaviour reverts to a **copy** of the hook — never the repo
file, md5 asserted unchanged across the run — points the suite at the copy via its
own documented `GUARD_AUTONOMY_HOOK` override, and requires each to turn it red.
It refuses to run at all if the unmutated suite is not green first.

| mutation | round 4 | round 5 |
|---|---|---|
| M1 `if recursive:` → `if recursive and force:` | 140/140 ❌ | **3 red** ✅ |
| M2 `punctuation_chars` loses the newline | 140/140 ❌ | **11 red** ✅ |
| M3 `heredoc_marker` ignores quoting/arithmetic | n/a | **3 red** ✅ |
| M4 unterminated heredoc swallows the remainder | n/a | **1 red** ✅ |
| M5 `SHELL_C_RE` anchors `c` to the end again | n/a | **1 red** ✅ |
| M6 stop resolving literal assignments | n/a | **11 red** ✅ |
| M7 drop the whole-statement requirement | n/a | **1 red** ✅ |
| M8 stop substituting `$$` / `$RANDOM` | n/a | **5 red** ✅ |
| M9 substitute *any* `$NAME`, not just digits | n/a | **2 red** ✅ |

M3 and M9 were **INERT on the first attempt** and are recorded as such rather
than quietly dropped, because each taught something the cases were missing:

* M3 was rescued by the *other* half of the B4 fix — keeping an unterminated
  remainder covers the accidental shapes on its own. The cases that separate them
  are the adversarial ones: a fake heredoc opener **plus a matching terminator
  line**, which hides everything between them from a classifier that reads `<<`
  without reading quote state.
* M9 was rescued because substituting `$HOME/x` yields the *relative* path `0/x`,
  which is still not routine. The case that separates them is `C=$X/dist` — an
  opaque variable followed by a routine basename, which rule 1 calls routine
  wherever it appears. That is the laundering shape and it now has its own test.

**B4 — `strip_heredocs`.** Split into `heredoc_marker()`, a left-to-right scan
tracking quote state and `$((` depth, plus the loop. `<<` inside a quoted region,
inside arithmetic, or written `<<<` no longer opens a body; the marker's quoting
must balance. And when the marker line never arrives, the remaining lines are
**kept and classified** rather than discarded — an unterminated heredoc is a
command bash itself rejects, so there is no legitimate shape being protected. The
prose cases the function exists for are still invisible (4 passing cases).

**B5 — `bash -cx`.** `^-[a-zA-Z]*c$` → `^-[a-zA-Z]*c[a-zA-Z]*$`. `--` still
cannot match, because `[a-zA-Z]` does not accept `-`. Three cases (`-cx`, `-xc`,
`-exc`).

**B6 — the literal `VAR=` false positive.** `scan_context()` learns literal
assignments, `is_routine_path()` resolves a bare `$SC` / `${SC}` through them
before rule 5. Deliberately narrow, each limit with its own MUST_BLOCK case: only
a **whole statement** counts (an env prefix expands from the caller's scope,
which this hook cannot see); a name assigned twice, or assigned anything opaque
anywhere in the command, is unresolvable; `${SC:-…}` is the variable through an
operator and is not resolved; there is no second hop.

**B7 — audit ordering.** The mutation's outcome is the status code; the audit's
outcome is a separate `audit: "ok" | "failed"` field carrying `audit_error`. A
404 keeps its 404 and writes neither row — asserted, so the field cannot be read
as "the change went through". The alternative the review offered (transact the
audit with the mutation) was **rejected on purpose**: it would let a broken audit
table block Konrad from turning a guardrail off, which is the one failure
direction this control plane must not have. `05-deploy.md` §0 states the
migration-before-restart order that keeps the window shut in the first place.

## H.2 F1 reproduced live, against this round's own work

The review's F1 (the guard blocking `rm -rf $SC` with `SC` assigned literally in
the same command, trip `5c9fc766`) **recurred during this round**, on the control
script for the `install-symlinks.sh` fix:

```
BLOCKED by the autonomy control plane: Destructive fs ops (fs.destructive)
  attempted: rm -rf $C
  trip:      9d5c8cdf-ca40-4053-8f0e-52278f45ab02
```

`C=/opt/ai-os/scratch/b167-installctl-$$`, assigned two words earlier.
`/opt/ai-os/scratch/` is a routine prefix; the only thing between that command and
the allowlist was the `$$`. It was reported and fixed, not worked around — the
control was re-run against a fixed literal path instead.

`$$` and `$RANDOM` are now substituted inside an otherwise-literal value, and the
argument that makes that a resolution rather than a hole is written into the hook:
both always expand to a run of **digits**, digits contain no `/` and cannot spell
`..`, so the substitution changes the spelling of exactly one path component and
cannot move the path into another tree. Every question `is_routine_path` asks is
about the tree, and no `ROUTINE_BASENAME` is a digit run, so the verdict is
identical for the real path and the substituted one — in **both** directions,
which M8 and M9 both assert.

## H.3 Also fixed: F8's first item, because `05-deploy.md` depends on it

`install-symlinks.sh` now refuses to run when `REPO_ROOT` is under
`/opt/ai-os/workspace/projects/`. Writing a deploy procedure that says "run
`install-symlinks.sh`" while the script would happily point every PreToolUse hook
at a directory that is deleted when the project finishes is handing someone a
loaded gun. Proved both ways: refuses from this worktree (exit 1, reason
printed), and the byte-identical copy under `/opt/ai-os/scratch/` proceeds to its
dry-run (`md5sum` equal on both).

## H.4 Not fixed, reported

* **F3** (`source` can never say `console`) — the review's own prescription is
  "ask Konrad which he wants before building". Asked in the manager chat; not
  built. The column is decorative today, not deceptive.
* **F5** (9 of 24 unresolved trips invisible; the trips feed inner-joins
  `guardrail_rules`, so a deleted rule takes its trips with it) — a behaviour
  change to the trips query, outside the seven blockers. Reported.
* **F6** (`check-secret-scan` red, `main`'s `pipeline.ts` DSN) — rotation is
  Konrad's call and its own window; only the redaction step is on this branch.
* **F8's** remaining two items (`guard-protected-paths.py` writes no audit line;
  an ACK whose reminder POST fails is silent) — both mitigated rather than open,
  per the review's own assessment. Recorded.

## H.5 Write-set

Declared: `docs/plan/aios-guardrail-hardening/04-review.md` — this file, the
reviewer's own document, which cannot be where a fix to seven code blockers goes.
**Every other file below is an undeclared write and is named here first.** The
declared set describes the round-4 REVIEW task; this is the round-5 FIX task and
the blockers name the files themselves.

| file | why it had to change | blocker |
|---|---|---|
| `db/migrations/0051_guardrail_rule_changes.sql` (was `0047_…`) | the rename IS the fix | B1 |
| `forge-control/src/db/autonomy.ts` | 4 comments naming migration 0047 | B1 |
| `forge-control/src/routes/autonomy.ts` | migration number; `auditOutcome` | B1, B7 |
| `forge-control/src/lib/autonomy-changes.test.ts` | the 500 assertion is now a 200 + `audit` assertion; 3 new tests | B7 |
| `scripts/ops/guard-autonomy.py` | the classifier fixes | B4, B5, B6 |
| `scripts/ops/test-guard-autonomy.py` | 140 → 199 cases | B3 |
| `scripts/ops/install-symlinks.sh` | worktree refusal | F8 |
| `scripts/checks/check-ops-scripts.sh` | location-aware mode assertion | B2 |
| `scripts/checks/prove-guard-bites.sh` (new) | "show both mutations red" | B3 |
| `scripts/checks/prove-ops-mode-bites.sh` (new) | the skipping assertion needs a control | B2 |
| `docs/plan/aios-guardrail-hardening/01-engine.md` | §4 renumber + why the old proof was blind | B1 |
| `docs/plan/aios-guardrail-hardening/02-classifier-decisions.md` | §8.1 closed | B3 |
| `docs/plan/aios-guardrail-hardening/05-deploy.md` (new) | "state it in `05-deploy.md`" | B7 |

Not touched: `/opt/forge-ai-os` (the live checkout), the live database, pm2, the
live hook at `/opt/ai-os/scripts/guard-autonomy.py`, and `guardrail_trips` — the
suites are in-process or point at a stub the test file starts itself, so this
round wrote no trip row except the one the live guard wrote **about** it (H.2).

---

# I. Fix cycle 2 (round 7) — response, appended not edited

Round 6's re-review returned NEEDS_FIXES with three blockers. All three are
closed below, each with the command that demonstrated the defect and the
command that demonstrates the fix. Tip fixed from: `8650693`.

## I.0 What was executed

| instrument | result |
|---|---|
| `python3 scripts/ops/test-guard-autonomy.py` | **246/246**, exit 0 (was 199/199) |
| the same suite against `git show 8650693:…guard-autonomy.py` | **5 Layer B cases RED**, incl. all three shapes the review named |
| `bash scripts/checks/prove-guard-bites.sh` | **BITES — 15/15 mutations DISCRIMINATED**, subject md5 unchanged |
| 24h corpus re-run, round-6 vs round-7 shipped conventions | 2 trips → **2 trips, 0 new, 0 dropped, 0 exceptions** |
| `strip_heredocs` old vs new over the same corpus | **0/2924 outputs differ** — the rewrite is behaviour-preserving |
| adversarial input fuzz (22 malformed/pathological commands) | **0 raised**; every return is `None` or a 3-tuple |
| `bash scripts/checks/gates-808.sh --strict` | see I.4 |

## I.1 Blocker 1 — a heredoc consumed by an interpreter

**Reproduced at `8650693` before touching anything**, in-process, cwd
`/opt/forge-ai-os`:

```
plain rm            -> fs.destructive
bash <<EOF          -> None
psql -U postgres <<EOF (DROP TABLE runs;)  -> None
python3 - <<'PY'    -> None
docker exec … psql <<EOF (TRUNCATE runs;)  -> None
```

Fixed by `heredoc_blocks()` / `heredoc_consumer()` / `heredoc_programs()` in
`scripts/ops/guard-autonomy.py`, and by moving heredoc sanitisation INTO
`classify()`. The full design argument, the narrowness table and the
false-positive measurement are in
[`02-classifier-decisions.md` §9](02-classifier-decisions.md).

The same five commands at HEAD:

```
bash <<EOF                    -> fs.destructive
sh <<'EOF'                    -> fs.destructive
psql -U postgres <<EOF        -> fs.destructive
docker exec … psql <<EOF      -> fs.destructive
python3 - <<'PY' (rmtree)     -> fs.destructive
cat <<'EOF' | bash            -> fs.destructive      (found while fixing)
cat <<'EOF' | psql -U postgres-> fs.destructive      (found while fixing)
```

**The instrument lesson is bigger than the bug.** The suite could not have
caught this at any number of cases, because `classify_case()` called
`classify(strip_heredocs(cmd))` — it stripped the body before handing it over,
exactly as `_main()` did, so Layer A was asserting on a **different function
from the one the hook contract runs**. 199 green cases and a total bypass were
consistent with each other. Layer A now passes the raw command; five Layer B
cases (real subprocess, stub API) assert the same shapes end to end, and those
are the ones that cannot drift from `_main()`.

## I.2 Blocker 2 — a subshell assignment is not an assignment

Verified in bash first, because the fix is only correct if bash agrees:

```
$ export SC=/opt/CALLER-VALUE
$ (SC=/tmp/x);       echo $SC   -> /opt/CALLER-VALUE
$ true | SC=/tmp/y;  echo $SC   -> /opt/CALLER-VALUE
$ { SC=/tmp/z; };    echo $SC   -> /tmp/z
$ SC=/tmp/w && true; echo $SC   -> /tmp/w
```

`LITERAL_ASSIGN_RE`'s boundary is now the separators after which bash runs the
next statement in the **current shell** — `^`, `;`, newline, `&`, `||` — with
`(`, `)`, a bare `|` and a trailing `&` refused. Five MUST_BLOCK cases, and the
round-5 shapes that must keep resolving (`^`, `&&`, `||`, newline, after a
backgrounded predecessor) are six MUST_PASS cases. M15 reverts both halves of
the boundary and turns 6 cases red; the mutation asserts the revert applied to
both, because a half-applied revert flips only one case and reads like a weak
assertion rather than a broken control.

## I.3 Blocker 3 — the stale count in `05-deploy.md`

Fixed, and fixed in the class rather than the instance: steps 5 and 6 now tell
the verifier to read **the exit code and the `N/N` equality**, not a number
copied out of a document that goes stale every cycle. Step 6 had the same
defect one line down (`7/7 mutations`, now 15) and is corrected the same way.
Step 6 also now warns that the script exceeds the default 2-minute Bash timeout
— it runs the whole suite once per mutation, ~4 minutes at 15.

## I.4 Found while fixing, reported not swept under

1. **Two mutation anchors had gone stale** (M4, M7) and named source this
   round moved or rewrote. `prove-guard-bites.sh` reported them as
   INCONCLUSIVE and exited 2 rather than passing 13 of 15 — the control
   catching its own rot is the behaviour that was designed in, and it is worth
   recording that it worked. Both re-anchored to the same behaviour.
2. **`MAX_DEPTH = 4` puts a cliff at five nested wrappers.** Five nested
   heredocs (or `bash -c` strings, which is the pre-existing form) are allowed.
   Not changed: any finite cap has a cliff, a "cap reached" refusal has no rule
   to hang on, and the measured workload is nowhere near it — over 2,924 real
   commands the recursion reaches depth 2 three times and 0 or 1 in the other
   2,921. **Pinned instead**, with the four-deep case in MUST_BLOCK and the
   five-deep case in MUST_PASS labelled `MAX_DEPTH PIN`, so raising the cap is
   a deliberate edit that turns a case red rather than a silent change.
3. **`02-classifier-decisions.md`'s REJECT table now carries the heredoc row it
   never had** — the round-6 review's point that the hole "appears nowhere in
   the rejected-catch table" was the correct diagnosis of how it survived three
   rounds: it was never a decision, so nobody re-examined it.

## I.5 One decision reversed, flagged for the manager

`python3 -c "shutil.rmtree(…)"` was a documented REJECT from round 0 and a
MUST_PASS case through round 6. It is now a CATCH, bounded to a **literal**
target judged by `is_routine_path()` — `rmtree(path)` and
`rmtree('node_modules')` still pass, and both are asserted. The reason it could
not stay rejected is I.1: once `python3 <<PY` bodies are classified, leaving the
`-c` spelling of the identical program allowed is a documented door. `node -e
"fs.rmSync(…)"` and the rest of the interpreter-body class remain rejected.
Reported to the manager chat rather than decided in silence.

## I.6 Write-set

**Declared write-set: empty — nothing was declared for this task.** Every file
below is therefore an undeclared write and is named here first, loudly.

| file | why it had to change | blocker |
|---|---|---|
| `scripts/ops/guard-autonomy.py` | the two classifier fixes | B1, B2 |
| `scripts/ops/test-guard-autonomy.py` | 199 → 246 cases; the harness's own pre-strip bug | B1, B2 |
| `scripts/checks/prove-guard-bites.sh` | 6 new mutations; M4/M7 re-anchored | B1, B2 |
| `docs/plan/aios-guardrail-hardening/05-deploy.md` | the stale counts | B3 |
| `docs/plan/aios-guardrail-hardening/02-classifier-decisions.md` | §9 + the REJECT table rows | B1 |
| `docs/plan/aios-guardrail-hardening/04-review.md` | this section | — |

Not touched: `/opt/forge-ai-os` (the live checkout), the live database, pm2,
the live hook at `/opt/ai-os/scripts/guard-autonomy.py`, `guardrail_trips`, and
`db/migrations/`. Layer A is in-process and Layer B points at a stub the test
file starts itself, so this round wrote no trip row and made no request to
`:7700`.

---

# Round 9 — fix cycle 3 (builder)

Feedback addressed: round 8's three blockers, in full. One further defect found
by this round's own sweep and fixed rather than filed.

## J.0 What was executed

| instrument | result |
|---|---|
| `python3 scripts/ops/test-guard-autonomy.py` | **313/313 passed**, exit 0 |
| the same suite against `a22d944` (`GUARD_AUTONOMY_HOOK=`) | **272/313 — 41 of the new cases RED**, which is the discrimination proof |
| `bash scripts/checks/prove-guard-bites.sh` | **BITES — 21/21 DISCRIMINATED**, subject md5 unchanged |
| corpus re-run, `a22d944` vs this tip, 2,924 rows | **2 → 2 trips; 0 new, 0 dropped, 0 exceptions** |
| corpus, redaction markers normalised | **0 heredoc-consumer verdicts change** (see J.4) |
| robustness sweep, 16 adversarial inputs | 0 raised; 15 under 0.4s; the 16th is J.3 |
| bash execution proof, 7 shapes | every constructed MUST_BLOCK shape really runs |

Nothing contacted `:7700`; nothing wrote a `guardrail_trips` row. Layer A and
the corpus driver call `classify()` in-process (pure — no HTTP, no audit line);
Layer B points at a stub the test file starts on an ephemeral port.

## J.1 Blocker 1 — a redirection before the `<<` (and its two neighbours)

Reproduced at `a22d944` first, in-process and end to end: **exit 0, zero API
calls, no audit line** on all nine wrapper shapes, and not scoped to
`fs.destructive` — the same wrapper defeated `git.force_push`, `comm.outbound`
and the *local* `autonomy.self_edit`. `<<EOF bash` and `bash <<< '…'` closed
with it. Full evidence and the fix's grammar: `02-classifier-decisions.md §10.1,
§10.3, §10.4`. `bash <<<` was **caught**, with its reasoning in §10.4 as round 8
required.

## J.2 Blocker 2 — the mirror false positive

`cat > /tmp/node <<'EOF'` blocked a prose note at `a22d944`; it passes now, with
its own MUST_PASS cases (`/tmp/node`, `note.md`, `/opt/ai-os/notes/bash`,
`2>/dev/null > note.md`, and the `bash deploy.sh &&` prefix). §9's narrowness
table now carries **both orderings of every shape** — the round-8 point that a
one-ordering table tests the spelling, not the grammar.

## J.3 Found while sweeping, fixed not filed — a quadratic in front of every Bash call

`scan_context()`'s mktemp regex, no left boundary, backtracking once per
character at every offset: **10.4s at 50k, 43.7s at 100k, >60s at 200k** — and
identical at `a22d944`, so inherited. The 2.5s HTTP ceiling does not bound it;
`classify()` runs before the request. Now 0.10s / 0.19s / 0.90s. Full write-up
`00-findings.md F3` and `02-classifier-decisions.md §10.5`.

Two structural consequences, both shipped:
- **Layer A2** — the suite's first assertion on a clock. 246 cases were green
  while the hook took 43s in front of the agent, because every one of them
  asserts a verdict.
- **M21** — the only mutation in `prove-guard-bites.sh` whose witness is the
  clock rather than a verdict.

## J.4 A measurement artefact, recorded because it looked like a regression

The first corpus run showed 6 rows changing consumer `db` → `prose`. All six are
`PGPASSWORD=<redacted> psql … <<'SQL'`, and `<redacted>` is **shell
punctuation** — to bash that literal is two redirections, so the new walker eats
`psql` as a target and is right to, about that string. With the marker
normalised: 0 verdicts change, trips 2 → 2. 89 corpus rows carry it. Written to
fleet memory as `corpus-redaction-marker-is-shell-punctuation`.

## J.5 Blocker 3 — the stale count

`05-deploy.md` steps 5 and 6 now carry **no expected count at all**. Round 7
replaced a stale number with a different stale number; the figure is deleted
rather than corrected, which was round 8's own second option.

## J.6 Write-set

**Declared write-set: empty — nothing was declared for this task.** Every file
below is therefore an undeclared write and is named here first, loudly.

| file | why it had to change | blocker |
|---|---|---|
| `scripts/ops/guard-autonomy.py` | the redirection-aware consumer walker, here-strings, the latency fix | B1, B2, J.3 |
| `scripts/ops/test-guard-autonomy.py` | 246 → 313 cases; the new **Layer A2** | B1, B2, J.3 |
| `scripts/checks/prove-guard-bites.sh` | M16–M21; M3/M10 re-anchored | B1, B2, J.3 |
| `docs/plan/aios-guardrail-hardening/05-deploy.md` | the stale count, deleted | B3 |
| `docs/plan/aios-guardrail-hardening/02-classifier-decisions.md` | §9 table both orderings; new §10 | B1, B2, J.3 |
| `docs/plan/aios-guardrail-hardening/00-findings.md` | the ranked round-9 findings | all |
| `docs/plan/aios-guardrail-hardening/04-review.md` | this section | — |

Same disposition as rounds 6 and 8: the empty `write_set` is the known engine
defect (`project-reconcile.ts:515` unions the gating reviewer's set, which is
also `[]`), not builder deviation. `prove-guard-bites.sh` again falls outside
the project's declared union and again was ordered explicitly — by round 4's
review, round 6's blocker 1, and round 8's blocker 1.

Not touched: `/opt/forge-ai-os` (the live checkout), the live database, pm2, the
live hook at `/opt/ai-os/scripts/guard-autonomy.py`, `guardrail_trips`,
`db/migrations/`.
