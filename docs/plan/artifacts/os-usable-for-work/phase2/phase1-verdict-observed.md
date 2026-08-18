# Phase 1's gating verdict, as observed — and the state of its three blockers at HEAD

**Task:** `B2a` (phase 2, workstream `vault`) · **Observed:** 2026-08-18T23:35Z – 23:38Z
**Observed at HEAD:** `c0615ae` (`git rev-parse HEAD`)
**This is a report. B2a fixes nothing and changed no source file.**

---

## TL;DR — the answer the rest of phase 2 needs

> **The verdict was `NEEDS_FIXES`. All three blockers are CLOSED at HEAD.**
> They were closed by a fix cycle that ran *after* the gate, in two commits (`698c230`, `c0615ae`).
> **B2d may wire an editor to `PUT /api/vault/file`.** The write path no longer loses an
> acknowledged edit under concurrency.

The phase-2 plan (`phases/phase2-plan.md` §0, written at `583cd3f`) states that `R1-gate` "is **still
`pending`**. It has not issued a verdict". **That is now stale.** The gate ran, issued a verdict, and a
fix cycle closed everything it raised. Nothing in this file contradicts the planner — it recorded the
truth at the moment it was written; three commits have landed since.

---

## 1. The verdict R1-gate actually issued

The brief hedged that `phase1/gate-verdict.md` might not exist. **It does exist** — 34 711 bytes,
committed as `01fa802`:

```bash
$ ls -la docs/plan/artifacts/os-usable-for-work/phase1/gate-verdict.md
-rw-r--r-- 1 root root 34711 Aug 19 00:15 docs/plan/artifacts/os-usable-for-work/phase1/gate-verdict.md

$ grep -n "VERDICT" docs/plan/artifacts/os-usable-for-work/phase1/gate-verdict.md
669:VERDICT: NEEDS_FIXES
```

The file is not taken on trust. It was corroborated against the reviewer's own transcript, because a
committed artefact is a *claim about* a verdict and the parser reads the run.

### 1.1 The transcript, and the instance check that had to come first

`runs` exists in two Postgres instances reachable from this box, with an **identical column list**, so
a query against the wrong one answers `0 rows` rather than erroring:

```bash
$ psql "$AI_OS_DATABASE_URL" -At -c "select count(*) from runs;"     # 127.0.0.1:5434/ai_os
0
$ psql "$DATABASE_URL" -At -c "select count(*) from runs;"           # 127.0.0.1:5432/content_forge
791
```

`runs` for this fleet live in **`content_forge` on :5432**. There is no `task_id` column; the task id
is in `metadata`:

```bash
$ psql "$DATABASE_URL" -At -F'|' -c "select id, status, left(title,70), metadata->>'task_id' \
    from runs where metadata->>'task_id'='10c93694-676f-429b-a2f1-7b54e323893d';"
e7d99a1b-9aa5-499f-9d5e-1618f0cccc0f|completed|os-usable-for-work · R1-gate — phase 1 gating reviewer: vault write pa|10c93694-676f-429b-a2f1-7b54e323893d
```

One row, `status = completed`, title names R1-gate, `metadata.task_id` echoes the task id asked for.
That is the row.

### 1.2 The verdict line, verbatim, from the message the parser reads

The engine's own instruction inside that thread states the rule: *"The parser reads only the LAST
assistant message, by design (first-match parsing used to read reviewers' rehearsals instead of their
verdicts)."* Grepping the whole thread is therefore the wrong instrument — it returns **11 distinct
`VERDICT…` strings**, including `VERDICT: PASS` three times, every one of them from the brief's own
boilerplate rather than from the reviewer. The last assistant message is message **144 of 144**
(index 143):

```bash
$ psql "$DATABASE_URL" -At -c "select thread::jsonb from runs \
    where id='e7d99a1b-9aa5-499f-9d5e-1618f0cccc0f';" > /tmp/r1gate-thread.json
$ python3 -c "import json; t=json.load(open('/tmp/r1gate-thread.json')); \
  a=[i for i,m in enumerate(t) if m.get('role')=='assistant']; \
  s=t[a[-1]]['content']; \
  print([l for l in s.splitlines() if 'VERDICT' in l])"
['No GitHub push: that step is gated on `VERDICT: PASS`.', 'VERDICT: NEEDS_FIXES']
```

**The verdict line, verbatim:**

```
VERDICT: NEEDS_FIXES
```

It sits at line 23 of a 28-line message — *not* on the last line. The same message opens:

> `**Tip reviewed:** 583cd3f1469f2c092c727b45521ebad5fca685f5. Verdict committed at 01fa802 as`
> `docs/plan/artifacts/os-usable-for-work/phase1/gate-verdict.md.`

So the committed artefact and the transcript agree on both the verdict and the tip. There is no
divergence to adjudicate.

---

## 2. Are B-1, B-2 and B-3 still live at HEAD?

**No. All three are closed.** Verified by reading `forge-control/src/lib/vault.ts` at HEAD (`c0615ae`,
755 lines), not by trusting the fix cycle's own report. Commit attribution is from `git blame` plus
`git show <commit> -- forge-control/src/lib/vault.ts`.

| # | Blocker (R1-gate's words) | Site it was raised at | State at HEAD |
|---|---|---|---|
| **B-1** | Two concurrent `PUT`s lose an acknowledged edit, no snapshot | `lib/vault.ts:380-413` | **FIXED by `698c230`** |
| **B-2** | `appendToDailyNote` read failure ≠ ENOENT replaces the note with the empty template | `lib/vault.ts:163` | **FIXED by `698c230`** |
| **B-3** | Crash during `appendToDailyNote`'s write truncates the note | `lib/vault.ts:170` | **FIXED by `698c230`** |

One sentence each, with the line at HEAD that closes it:

- **B-1 — fixed by `698c230`.** `serialiseOnPath()` is defined at `lib/vault.ts:588` and
  `writeVaultFile` now runs its read–compare–snapshot–write critical section inside it
  (`lib/vault.ts:676`), and the snapshot filename carries `randomBytes(4)` (`lib/vault.ts:541`) so two
  writers in the same millisecond can no longer collide on the name.
- **B-2 — fixed by `698c230`.** `appendToDailyNote`'s read `catch` rethrows anything that is not
  `ENOENT` at `lib/vault.ts:317` (`if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;`), so
  an EIO on an existing note is an error rather than a licence to write the empty template over it.
- **B-3 — fixed by `698c230`.** The append's write goes through `atomicWrite()` at `lib/vault.ts:324`
  (defined `:229`: temp file in the same directory → `writeFile` → `fsync` → `close` → `rename`), so
  the destination is never opened `O_TRUNC` and a crash cannot leave a strict prefix.

`git blame` attributes lines 306/317/324 to `c0615ae` because that commit **re-indented** them when it
wrapped the body in `serialiseOnPath`. The semantics arrived in `698c230`; `git show 698c230` contains
both `- await fs.writeFile(abs, next, "utf8")` → `+ await atomicWrite({` and the added
`+ if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;`.

### 2.1 A fourth loss path, closed after the gate and not on the gate's list

`c0615ae` closed a defect **R1-gate did not name**: `appendToDailyNote` was itself a read-modify-write
sitting *outside* the queue that B-1's fix had just introduced. Its commit subject records the
measurement — *"9 of 10 acknowledged captures were being lost"*. At HEAD it enters the same queue
(`lib/vault.ts:306`). This matters to phase 2 because `POST /api/vault/append` is the **mobile Capture**
path and remains the only writer the surface can reach today.

### 2.2 The one disclosed deviation, so a re-check does not re-raise it

R1-gate worded B-3's closure condition as *"no `writeFile(abs…)` anywhere in the module"*. Taken
literally that condition is **not met at HEAD**, and deliberately so — two `fs.writeFile(abs, …)` calls
survive, both opened `"wx"`:

- `lib/vault.ts:354` — `createNote()`. `"wx"` fails with `EEXIST` if the file exists, so it replaces
  nothing and can truncate nothing.
- `lib/vault.ts:547` — `snapshotBeforeWrite()`. `"wx"` is what stops a snapshot overwriting another
  snapshot.

Routing either through `atomicWrite()` would *remove* the create-exclusive guarantee and make the
module less safe. The deviation is already disclosed and pinned by the fix cycle at
`phase1/fix-cycle-1-vault-write.md` §6 (lines 266–320), which exists precisely so that a later agent
"finishing" the literal instruction is caught by a red test. **The substantive property R6 asks for —
no existing note is ever opened `O_TRUNC` — holds at HEAD.** Do not re-open this.

---

## 3. `git log --oneline 1b6fa9a..HEAD`

```
c0615ae fix(os-usable-for-work/phase 1, R1-fix-2): serialise appendToDailyNote — 9 of 10 acknowledged captures were being lost
c171d1f verify(os-usable-for-work/phase 1, R1-fix re-check): all four blockers independently closed; one wording deviation disclosed and pinned
698c230 fix(os-usable-for-work/phase 1, R1-fix): close 3 blockers, the symlink escape and 4 folded findings
01fa802 gate(os-usable-for-work/phase 1, R1-gate): NEEDS_FIXES — the PUT verb loses an acknowledged edit under concurrency
583cd3f plan(os-usable-for-work/phase 2, round 200): memory surface truth — and the proving test R31 names cannot discriminate
```

Read top-down that is the whole story: the planner wrote phase 2 against a pending gate; the gate then
returned `NEEDS_FIXES`; a fix cycle closed it; a re-review confirmed it independently; a second fix
closed the sibling race the first one exposed.

---

## 4. What this changes for the rest of phase 2

- **B2d is unblocked on the safety question.** The `PUT` verb is serialised per resolved path and
  snapshots before it writes. Wire the editor.
- **`R1-gate` itself remains `NEEDS_FIXES`.** A `NEEDS_FIXES` seeds no fix cycle automatically and the
  gate does not re-run itself; the phase-1 re-review (`31836b84`) is the row that adjudicates whether
  the fixes discharge it. B2a does not speak for it.
- **The phase-2 plan's §0 is stale, not wrong.** Anyone reading `phase2-plan.md` §0 and concluding
  "the blockers sit at HEAD" would be reading a fact that expired three commits ago.
- The phase-1 planner's `B1e` (`6c6fb2c8`) is still `blocked` (retired as a duplicate) and must not
  appear in any `depends_on`.
