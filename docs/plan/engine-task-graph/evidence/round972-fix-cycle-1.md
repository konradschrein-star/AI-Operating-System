# Round 972, fix cycle 1 — `/compact` and the archive guarantee

Round 971's reviewer returned NEEDS_FIXES on the shipped `/compact` route
(`91f6b28`), four findings. This is the transcript: what was measured, what was
mutated to prove the measurement, and what the round wrote that it did not
declare.

---

## 0. The subject was not in this worktree

`91f6b28` is on `main`; `git merge-base --is-ancestor 91f6b28 HEAD` answered
**NO**. The route this fix cycle exists to fix did not exist here.

A cherry-pick was rejected: it would leave `main` and this lane holding the same
route with different blob ancestry, and the integration merge could resolve to
two `r.post("/:id/compact")` registrations. `main` was merged instead
(`37cc974`), so the fix sits on top of the real commit and integration is a
fast-forward of the fix alone.

Two conflicts, both in NF7's prompt-budget ledger, both resolved by keeping BOTH
lanes' rows — the merged prompt carries both texts, so the exactness assertion
("every character spent since the 5A tip is attributed to a round that declared
it") only balances with all four rows present. It does balance; that is the proof
the resolution is right rather than merely plausible.

**The BUDGET arithmetic, and the six characters it exposed.** Base 3050. This
lane widened by 650 (round 822's reservation, spent by 962) → 3700, headroom 38.
`main` widened by 547 (round 974) → 3597, headroom 0. Sum of widenings = 4247 —
**six short**. Both lanes had drawn on the same 44 characters of base headroom,
this lane 6 and `main` 44, which is 50 claims on a pool of 44. Neither could see
it alone. Measured: BASELINE 9221, prompt 13474, so the true cap is **4253** with
headroom 0. Widened by six, buying nothing, stated at the constant. No lane's
ledger row was adjusted to hide it.

---

## 1. Finding 1 — the lost-update race (HIGH). Fixed and proved.

**The defect.** `getRun()` → snapshot `thread` → archive that snapshot →
`UPDATE runs SET thread = $2::jsonb`. Read-modify-write, no lock, no status
check. Every other thread writer in the codebase is an atomic append — measured,
not asserted:

```
$ grep -rn "SET thread\|thread = " src/ --include=*.ts | grep -v test
src/db/runs.ts:338:         SET thread = thread || $2::jsonb,
src/db/runs.ts:344:         SET thread = thread || $2::jsonb,
src/db/runs.ts:565:            thread = thread || $3::jsonb,
src/db/runs.ts:725:  const sets = ["thread = thread || $2::jsonb"];
src/executor.ts:369:  const threadConcat = entry ? `thread = thread || $2::jsonb,` : "";
src/executor.ts:487:        SET thread = thread || $2::jsonb,
src/routes/chat.ts:1720:        SET thread = $2::jsonb,      <-- the only one
```

**The fix.** The body moved to `lib/thread-compaction.ts` and the read, the
archive write and the overwrite happen inside one transaction holding
`SELECT thread ... FOR UPDATE`. A concurrent append blocks; when the transaction
commits, READ COMMITTED makes the waiting `UPDATE` re-read and append to the
compacted thread, so the in-flight entry lands after the marker.

Two timeouts guard the lock rather than trusting it: `lock_timeout` bounds how
long the route WAITS for the row, and `idle_in_transaction_session_timeout`
bounds how long it HOLDS the row while idle — and the file write is exactly such
an idle window, so a wedged disk kills the transaction instead of blocking every
live append to the chat forever.

**Why not a single atomic statement** (the operator asked). The truncation alone
is expressible in SQL. The ARCHIVE is a file, and a file cannot join a SQL
statement — so a single-statement truncation would keep the concurrent append
alive in the row while the archive, written from a read that is no longer
authoritative, silently would not contain it, and `dropped` would be off by the
same amount. That trades unrecoverable loss for an archive that quietly
disagrees with what it replaced. **Not equivalent**, and that is why it was not
taken.

**Why not refuse when `status = 'running'`** (the reviewer's second option). It
refuses the case Konrad actually has: he types `/compact` when a long turn has
filled the window, which is when the run is running. That is fixing the route
into uselessness.

### The harness — `src/db/compact-race.test.ts`

Real Postgres, two contending sessions, the compaction held open inside its
archive write while a real `thread = thread || $2::jsonb` is issued from another
pool. The question asked is not "is the entry in the thread" but:

> **is the appended entry in the union of (live thread ∪ archive file)?**

An entry in NEITHER is unrecoverable loss. That is the guarantee, as a set.

```
$ SCRATCH_DATABASE_URL=... tsx src/db/compact-race.test.ts
CASE 1  the retired unlocked path — must LOSE the live append
  ok   case1 the append really executed (rowcount)              = 1
  ok   case1 the append completed INSIDE the window             append@..776 compact@..270
  ok   case1 entry is GONE from the live thread
  ok   case1 entry is GONE from the archive too
  ok   case1 THE DEFECT REPRODUCES: present in neither
CASE 2  the shipped compactRunThread() — must KEEP the live append
  ok   case2 entry SURVIVES in the live thread
  ok   case2 THE GUARANTEE HOLDS: present in the union
  ok   case2 thread is marker + keep + the appended entry       = 62
  ok   case2 the appended entry is LAST — it landed after the compaction
CASE 3  the append BLOCKED on the row lock — ordering, not luck
  ok   case3 under the lock the append finishes AFTER the commit
  ok   case3 control: unlocked, it finished BEFORE the commit
CASE 4  same transaction with FOR UPDATE deleted — must go RED again
  ok   case4 WITHOUT the lock the entry is lost again
...
assertions run 31 / expected 31, failed 0
ALL PASS
```

**RED BEFORE, GREEN AFTER, against the SHIPPED function — not a replica.** The
`FOR UPDATE` clause was deleted from `lib/thread-compaction.ts` itself and the
same harness re-run:

```
sha256 BEFORE mutation: ccf0c9199d9430dae1c022be97567476398e822de292d867091ece721d7bb307
-      `SELECT thread FROM runs WHERE id = $1 FOR UPDATE`,
+      `SELECT thread FROM runs WHERE id = $1`,

  FAIL case2 entry SURVIVES in the live thread
  FAIL case2 THE GUARANTEE HOLDS: present in the union
  FAIL case2 thread is marker + keep + the appended entry       expected [62] got [61]
  FAIL case2 the appended entry is LAST                         seeded entry 199
  FAIL case3 under the lock the append finishes AFTER the commit
  assertions run 31 / expected 31, failed 5

sha256 AFTER restore : ccf0c9199d9430dae1c022be97567476398e822de292d867091ece721d7bb307
RESTORE VERIFIED — identical to pre-mutation
HARNESS_EXIT=0  (ALL PASS)
```

Restored by **copy and sha256 comparison**, never by `git checkout --`: the file
is untracked at that point, so `checkout` would have deleted it rather than
reverting the mutation.

**What would make this instrument report a pass wrongly** is answered in the
file's header — an append that never ran (rowcount asserted), a window too
narrow to race (case 1 asserts the loss actually happens), probes that miss
(31/31 counted, a short run exits 1), the wrong database (scratch guard, runs
before any pool opens), a stale schema (per-process, dropped both ends), and
archives written into the real backup directory (every case passes an explicit
temp `dir`; the production constant is never touched).

Two instrument defects were found and fixed while building it: an `assertEq`
that printed a 60 KB "ok" line, and a `search_path` set from a `connect` hook
whose `client.query()` was not awaited — a pooled client could have issued its
first statement before the search_path landed. It is now a connection option,
and the table's schema is asserted to be the per-process one before any case
runs.

---

## 2. Finding 2 — the `keep` clamp (MEDIUM). Fixed.

`Math.min(400, Math.max(10, Number(body.keep ?? 60)))` yields NaN for
non-numeric input, and NaN defeats a Math.min/Math.max clamp because both return
NaN. `resolveKeep()` checks finiteness BEFORE the clamp and truncates to an
integer.

20 table-driven cases in `lib/thread-compaction.test.ts`, plus a control that
re-states the OLD expression verbatim and asserts it really did produce NaN for
`"abc"`, `{}`, `[1,2]` and literal `NaN` — without it the whole block would pass
on both trees and prove nothing.

---

## 3. Finding 3 — the marker's vault note (LOW). Fixed.

Verified on 2026-08-19: `/opt/obsidian-vault/AI OS/` holds
`Session State - 2026-08-18.md` and `Session State - 2026-08-19.md`, and no
undated `Session State.md`. `Operator Decisions.md` resolves exactly.

Creating an empty `Session State.md` to make the old sentence true was rejected —
a note nobody writes to goes stale the day it is created. The marker names the
PATTERN and says the undated note does not exist.

The test pins the absence of `"AI OS/Session State"` **including both quotes**,
because the corrected text contains that phrase as a prefix of
`"AI OS/Session State - YYYY-MM-DD"`; an unquoted needle would pass on the defect
and the fix alike.

---

## 4. Finding 4 — retention (LOW, disclosed). Implemented, with the numbers
escalated.

Nothing pruned `/opt/ai-os/backups/threads`. Measured 2026-08-19: **4.5 MB
across 5 files** — the reviewer counted 3 the same evening, so it grew during the
review.

`pruneThreadArchives()` runs after the commit, and its failures are RETURNED in
the response rather than thrown: the compaction is already durable and failing to
tidy up must not turn that into a 500.

One invariant holds regardless of how the thresholds are tuned:

> **the newest `keepNewestPerRun` archives of every run are never deleted.**

The floor is applied FIRST; age and size only choose among what is left. Defaults
`{ keepNewestPerRun: 3, maxAgeDays: 30, maxTotalBytes: 2 GiB }` — a **preference
call the brief did not make**, so it is escalated to Konrad in the manager chat
with these as the stated default.

The decision function is pure and separately tested: a run with one archive keeps
it forever under both an age-only and a size-only policy; a directory made
entirely of exempt archives is left alone over cap rather than breaking the
floor; and a control asserts the age rule alone deletes nothing in the
all-young case, which is why there are two rules.

**Archive format unchanged** — `JSON.stringify(thread)`, `<runId>-<stamp>.json`.
The parser is tested against the two real filenames on disk.

---

## 5. Gates — and two that could not have been passed as documented

`gates-808.sh --strict`, per `03-quality.md` §4's own invocation:
**25 gates, 23 executed, 2 skipped-by-design, RED: 0, exit 0.**

Getting there required amending two gates where they are enforced.

### Gate 6 — the allow list was stale, and had been since `af3cba6`

`af3cba6` (round 972's OWN first commit) created
`forge-control/src/db/projects.test.ts`, which matches gate 6's ban pattern
`db/projects` verbatim, and declared it in neither `03-quality.md`'s allow list
nor `04-phases.md` §10. Measured before amending:

```
PATHS MATCHING THE BAN (4)
  FORBIDDEN  forge-control/src/db/projects.test.ts
>>> FORBIDDEN FILE DIFFERS — 1 path(s) ...
GATE6_EXIT=1
```

So the suite could not exit 0 on this branch at any sha from `af3cba6` onward.
This is case 11 of `check-forbidden-file-diff.sh` ("matching is exact, so
`db/projects.ts` does not permit `db/projects.test.ts`") firing on the live diff
instead of on a fixture. Closed in one commit: the fourth allow-list entry in
**both** copies in `03-quality.md`, the §10 row that buys it, and
`PROJECT_ALLOW` in the control suite.

The control suite's case 13 now discriminates on the new entry —
`the live diff is clean under the declared list, and refused with
'forge-control/src/db/projects.test.ts' removed` — and case 3 was widened to
exercise all four entries, so no entry sits in the list unmeasured. **14/14,
exit 0.**

### Gate 17 — the merge rotted 20 pins in another project's document

`verify-notification-gap-pins.mjs` was **ALL PASS 92/92 at `af3cba6`** and **20
FAILURES at `37cc974`**. Measured at both tips in throwaway worktrees, so the
merge is the cause and not a coincidence of timing.

Nobody on this branch edited a pinned file. `main` moved underneath: `6a9406d`
added 4 lines to `buildSystemPrompt` in `cc-runner.ts` (+4 to five pins) and
`1e0330b` added one import to `AssistantThread.tsx` (+1 to three). **Neither
author could have run this verifier — it does not exist on `main`.** Two lanes,
one file, and the gate only meets the change at the merge. That is a structural
finding about how this fleet's doc gates and its merges interact, not a typo.

Re-anchored per the document's own convention: the `ed601ff` and `9b960ef`
correction tables **keep their numbers**, their now-columns are reclassified
`historical`, and a fourth table records the round-972 drift with the live
values. A "Now" column that silently acquires a later tree's numbers claims that
tree held them — the rot the script exists to catch, wearing the costume of a
fix.

The narrative paragraph then failed the gate on its own two insertion-point
citations (`:205`, `:33`) — the mechanism working, exactly as the document warns
that describing a control registers pins like any other prose. Registered as
historical. Final: **ALL PASS — 110/110**, and §1's self-reported count was
re-measured from 92 to 110 rather than left to rot.

### Gate 8 — red on `main`, and now allowlisted narrowly

`forge-control-web/app/desktop/goals/ui.tsx:440` — `toFixed(2)` building an SVG
polyline coordinate pair, in a file `553fa38` put on `main`. **Not in this
lane's diff** (`git diff --name-only main...HEAD | grep -c goals/ui.tsx` → 0) and
identically red on `main` at `9c3f63a`, measured in a throwaway worktree.

Allowlisted with a pattern anchored on the coordinate pair, not the file. Proved
narrow rather than claimed:

```
probe: appended `const label = \`$${amount.toFixed(2)}\`;` to that file
MUTATED_EXIT=1   FAIL forge-control-web/app/desktop/goals/ui.tsx:471
sha AFTER == sha BEFORE   RESTORE VERIFIED
RESTORED_EXIT=0
```

---

## 6. Everything else that was run

| what | result |
|---|---|
| `pnpm install --frozen-lockfile --prod=false` | tsc + tsx present, not pruned |
| `npx tsc --noEmit` (forge-control) | exit 0 |
| `pnpm test` (hermetic suite) | **1378/1378 pass, 0 fail** |
| `tsx --test src/lib/project-tick.test.ts` | 152/152 after the merge resolution |
| `tsx --test src/lib/thread-compaction.test.ts` | 39/39 |
| `tsx src/db/compact-race.test.ts` | 31/31, exit 0 |
| `gates-808.sh --strict` | RED: 0, exit 0 |

`project-reconcile.test.ts` is inside the 1378 and was **not modified**.

**Leftover scratch databases**, per `03-quality.md` §4's own instruction to
accept them and say so: `forge_r972_compact` (this round's race harness),
`usage_fold_2543152`, `usage_fold_2568458`, `usage_fold_2576608` (three gate-18
runs). `forge_r972_lanecap` and `usage_fold_r965_2059007` predate this round.
None was dropped — dropping a database is a destructive operation and this task
carried no instruction to perform one.

**Nothing was deployed.** `/opt/forge-ai-os` was not written. The executor was
not restarted. `8ea0cc08` was not touched.
