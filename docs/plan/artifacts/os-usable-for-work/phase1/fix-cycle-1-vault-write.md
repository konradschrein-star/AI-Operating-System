# Round 100, fix cycle 1 — the three blockers and the folded findings

**Answers:** `docs/plan/artifacts/os-usable-for-work/phase1/red-team-vault-write.md` (R1-red,
committed `1b6fa9a`), gate verdict `01fa802` NEEDS_FIXES.
**Tree fixed:** `project/7851068b-vault`, on top of `01fa802`.
**Method, non-negotiable:** every defect was **reproduced against the committed tree first**, then
fixed, then the identical harness re-run. Both transcripts are below, unabridged. Nothing was
"fixed" that was not first observed failing.

**Isolation.** Every measurement ran against a fixture vault under `os.tmpdir()` with
`OBSIDIAN_VAULT_DIR` and `VAULT_SNAPSHOT_DIR` set per run. `/opt/obsidian-vault` was never opened for
writing. `/opt/forge-ai-os` was never touched. Harness: `/tmp/fix1/repro.mts` and `/tmp/fix1/f3.mts`,
throwaway; the assertions that survive are in the committed test files.

---

## 1. Verdict table

| # | Defect | Fix | Proven by |
|---|---|---|---|
| **B-1** | two concurrent PUTs both pass CAS on one base; the second destroys the first, which returned 200 | `serialiseOnPath()` — a promise chain keyed on the resolved absolute path, around steps 4–7 | §2 run 1–5, and `vault.test.ts` "two PUTs on the same base" |
| **B-2** | a bare `catch` reads every read failure as ENOENT and writes the empty template over the note | `if (code !== "ENOENT") throw e` | §2, and "a read failure that is not ENOENT THROWS" |
| **B-3** | the append opens the destination `O_TRUNC`; a crash leaves a strict prefix, no snapshot | `atomicWrite()` extracted and used by **both** verbs | §2, and "the append is atomic" |
| **F-1** | `path.resolve()` is lexical — a symlink inside the vault reads and writes outside it | `realpath` of the deepest existing ancestor, containment re-asserted, in `resolveOrRefuse` | §2, and 5 symlink tests |
| **F-2** | a zero-width-only body is accepted and blanks a note | the `^\s*$` test runs over a copy with `[\u200B-\u200D\u2060\uFEFF]` stripped | §2, and 8 invisible-body tests |
| **F-3** | two edits inside one millisecond collide on the snapshot name; the second, valid, edit 500s | 8 hex of randomness in the snapshot filename | §2, and "two edits inside ONE millisecond" |
| **F-5** | a 409 serialises the whole note — 256 MB, 3.2 s, +224 MB RSS | 8 MiB cap at the route layer, **announced** via `current_content_truncated` + `current_bytes` | 2 route tests, incl. the surrogate-pair boundary |
| **F-6** | a crash leaves an orphan `.tmp-` in the vault forever | `sweepOrphanTempFiles()` — this module's own name shape, older than an hour, after a successful write | "an hour-old orphan goes; a fresh one, a note and a look-alike stay" |
| **F-4** | `02-architecture.md` §1.2 asserts two things that are not true | both sentences quoted and corrected in place | §1.2, "Concurrency" |
| **N-2** | `readDailyNote` swallows every read error → "no daily note today" | same ENOENT-only guard | "readDailyNote reports content: null ONLY for ENOENT" |
| **vault.ts:10** | the module-wide claim "NO CONTENT THIS MODULE EVER REMOVES IS UNRECOVERABLE", which B-2 and B-3 falsified | replaced by a per-verb statement **plus an explicit "what is NOT claimed" list** | the header itself |

Not fixed, deliberately: **N-1** (an absolute vault path appears in a 500 body) — cosmetic on an
authenticated surface, and scrubbing it would remove the diagnostic that R20 exists to preserve.
**F-7** (snapshot retention) — a policy decision, not a defect; the coupling to disk exhaustion is now
in the module header, and B-3 (which it armed) is closed regardless.

---

## 2. Before and after, same harness, same machine

`before` is the tree at `01fa802`; `after` is the fixed tree. Only the module under test changed
between the two runs.

### BEFORE — `tsx /tmp/fix1/repro.mts` against `01fa802`

```
=== B-1 concurrent PUTs (5 runs) ===
run 1: acked=2 [200 sha=ba1fcdf13c10 | 200 sha=12f23b528d8c] snapshots=2 LOST-ACKNOWLEDGED-CONTENT=true
run 2: acked=1 [200 sha=a1ab812b5be0 | ERR Error: vault snapshot failed for Notes/b1-2.md at /tmp/repro-snaps-] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 3: acked=1 [200 sha=b5f5fcdb228a | ERR Error: vault snapshot failed for Notes/b1-3.md at /tmp/repro-snaps-] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 4: acked=1 [200 sha=cf9d25acd3ec | ERR Error: vault snapshot failed for Notes/b1-4.md at /tmp/repro-snaps-] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 5: acked=2 [200 sha=6844cfe2c166 | 200 sha=6af88a5882f1] snapshots=2 LOST-ACKNOWLEDGED-CONTENT=true
=== B-2 non-ENOENT read failure in appendToDailyNote ===
before=4245B after=76B  RESOLVED {"path":"Daily/2026-08-19.md","created":true}
  DESTROYED=4169B  snapshots-taken=0  RECOVERABLE=false
=== B-3 appendToDailyNote opens the destination with O_TRUNC ===
original=40000048B  SMALLEST SIZE OBSERVED ON DISK DURING THE APPEND=0B  truncation-window=true  snapshots-taken=0
=== F-1 symlink escape ===
  GET Notes/leak.md -> 200 content="TOP SECRET, outside the vault\n"
  PUT escape/secret.md -> 200; /tmp/repro-outside-QXa4ZI/secret.md now = "OVERWRITTEN FROM INSIDE THE VAULT\n"
=== F-2 zero-width-only body ===
  ZWSP U+200B: ACCEPTED 200 bytes=3 — note now blank in Obsidian
  ZWNJ U+200C: ACCEPTED 200 bytes=3 — note now blank in Obsidian
  WJ U+2060: ACCEPTED 200 bytes=3 — note now blank in Obsidian
  BOM U+FEFF: refused (VaultRefusedError)
=== F-3 two edits inside one millisecond ===
  0/20 valid second edits refused with a 500 "snapshot failed"
```

`tsx /tmp/fix1/f3.mts` — F-3 with the clock frozen, which is the only way to make the collision
deterministic (the 0/20 above is a real-clock run in which no two edits landed inside one millisecond;
the collision is nevertheless visible in B-1 runs 2–4 above, where it is how the interleaving
manifested):

```
edit 1: 200
edit 2: ERROR -> vault snapshot failed for Notes/f3.md at /tmp/repro-f3s-kmc1Us/store/2026-08-19/Notes__f3.md.1755600000000.md — THE NOTE
  note on disk still: "# f3\n\nedit B\n" (a VALID edit was refused)
```

### AFTER — the identical harness against the fixed tree

```
=== B-1 concurrent PUTs (5 runs) ===
run 1: acked=1 [200 sha=ba1fcdf13c10 | ERR VaultConflictError: vault note changed on disk since it was read (current sha256] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 2: acked=1 [200 sha=a1ab812b5be0 | ERR VaultConflictError: vault note changed on disk since it was read (current sha256] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 3: acked=1 [200 sha=b5f5fcdb228a | ERR VaultConflictError: vault note changed on disk since it was read (current sha256] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 4: acked=1 [200 sha=cf9d25acd3ec | ERR VaultConflictError: vault note changed on disk since it was read (current sha256] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
run 5: acked=1 [200 sha=6844cfe2c166 | ERR VaultConflictError: vault note changed on disk since it was read (current sha256] snapshots=1 LOST-ACKNOWLEDGED-CONTENT=false
=== B-2 non-ENOENT read failure in appendToDailyNote ===
before=4245B after=4245B  THREW EIO: simulated read failure
  DESTROYED=0B  snapshots-taken=0  RECOVERABLE=false
=== B-3 appendToDailyNote opens the destination with O_TRUNC ===
original=40000048B  SMALLEST SIZE OBSERVED ON DISK DURING THE APPEND=40000048B  truncation-window=false  snapshots-taken=0
=== F-1 symlink escape ===
  GET Notes/leak.md -> REFUSED vault path escapes the vault through a symlink: No
  PUT escape/secret.md -> REFUSED vault path escapes the vault through a symlink: es
=== F-2 zero-width-only body ===
  ZWSP U+200B: refused (VaultRefusedError)
  ZWNJ U+200C: refused (VaultRefusedError)
  WJ U+2060: refused (VaultRefusedError)
  BOM U+FEFF: refused (VaultRefusedError)
=== F-3 two edits inside one millisecond ===
  0/20 valid second edits refused with a 500 "snapshot failed"
```

```
edit 1: 200
edit 2: 200
```

**Reading the "after" numbers honestly, because two of them look wrong at a glance:**

- **B-2, `RECOVERABLE=false` and `snapshots-taken=0`.** Correct, and it is the *good* outcome: nothing
  was replaced, so there was nothing to snapshot. The number that carries the fix is
  `before=4245B after=4245B DESTROYED=0B` with the call **throwing** instead of resolving `ok:true`.
- **B-3, `snapshots-taken=0`.** `appendToDailyNote` still takes no snapshot, and still should not:
  it removes nothing. What changed is `SMALLEST SIZE OBSERVED ON DISK = 40000048B` — the destination
  is never opened for truncation, so there is no window in which a crash can leave a prefix. The
  poller samples the destination every millisecond for the whole call; before the fix it caught it at
  **0 bytes**.
- **B-1, the identical winning sha in both runs.** The fixture content is derived from the run index,
  so the winner's hash is reproducible. The difference is `acked=2 → acked=1` and
  `LOST-ACKNOWLEDGED-CONTENT=true → false` in the runs that lost content.
- **F-3, `0/20` in both.** That line is a real-clock probe and it fired in neither run; the frozen
  clock below it is the discriminating measurement, and it moved from a 500 to a 200.

---

## 3. The committed regression tests, and proof they discriminate

A test that passes on the broken code proves nothing. Every new assertion was run against the
**pre-fix** `lib/vault.ts` and `routes/vault.ts` — restored from `git show HEAD:…` into the worktree,
run, then restored from a byte-copy and verified by `sha256sum -c`:

```
--- running the NEW tests against PRE-FIX lib+routes ---
    not ok 3 - the 409 body is capped, and the cap is ANNOUNCED, not silent
    not ok 4 - the 409 cap never cuts a surrogate pair in half
    not ok 1 - the pre-write bytes are recoverable, outside the vault
    not ok 2 - two edits inside ONE millisecond both snapshot and both land
    not ok 2 - by source inspection: NO verb in the module opens a destination O_TRUNC
    not ok 1 - two PUTs on the same base: one 200, one 409, and nothing acknowledged is lost
    not ok 4 - the chain map is drained, not grown one entry per note edited
    not ok 1 - GET through a file symlink pointing outside is refused
    not ok 2 - PUT through a directory symlink is refused and the outside file is untouched
    not ok 3 - PUT to a not-yet-existing path THROUGH a directory symlink is refused too
    not ok 1 - U+200B zero-width space only is refused
    not ok 2 - U+200C zero-width non-joiner only is refused
    not ok 3 - U+200D zero-width joiner only is refused
    not ok 4 - U+2060 word joiner only is refused
    not ok 6 - zero-width mixed with real whitespace only is refused
    not ok 8 - the refusal names which kind of blank it was
    not ok 1 - an hour-old orphan goes; a fresh one, a note and a look-alike stay
    not ok 5 - a read failure that is not ENOENT THROWS; the note is byte-identical
    not ok 6 - readDailyNote reports content: null ONLY for ENOENT
    not ok 7 - the append is atomic: a failed rename leaves the note byte-identical
# tests 82
# pass 62
# fail 20
--- restored, verifying ---
/tmp/fix1/keep/routes-vault.ts: OK
/tmp/fix1/keep/vault.ts: OK
```

**20 fail on the old code, 0 fail on the new.** Three of the new cases pass in *both* directions, on
purpose, and they are the flips that stop the others being vacuous:

- `U+FEFF byte-order mark only is refused` — JS `\s` already covers U+FEFF, so this one was never
  broken. It is in the table to prove the table is not simply "everything is refused now".
- `a zero-width character INSIDE real prose is content and is written verbatim` — the strip happens on
  a **copy**, for the blank test only. If the body itself were stripped, this would fail.
- `the queue is PER PATH` and `a rejected write does not wedge its path` — a single global lock, or a
  chain built with `.then(work)` alone, would pass B-1's test and fail these.

The source-inspection test was rewritten rather than patched. R1-red showed the old one sliced the
module down to `writeVaultFile`'s body and then used the literal `await fs.writeFile(abs, next,
"utf8")` — which *was* line 170, inside `appendToDailyNote` — as its own negative control. The
counterexample was the code the assertion had been scoped away from. R6 is a property of the module,
so the subject is now the whole module: every direct write to a destination must carry `flag: "wx"`,
and the only non-exclusive write path is `atomicWrite`, which reaches the destination by `rename`
alone. `fs.rename(` still appears exactly once in the module.

---

## 4. Gates

`scripts/checks/gates-808.sh --strict`, `timeout 900`, from this worktree, run **serially on the
final tree** — an earlier run overlapped the doc edits and is discarded rather than quoted.
`pnpm install --frozen-lockfile --prod=false` was run first (`tsc` and `tsx` both present in
`node_modules/.bin` afterwards — the tell that the production prune did not eat them).

```
================================================================================
 SUMMARY — 25 gates
================================================================================
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
 12 0      check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)
 13 0      check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does
 14 0      check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces
 15 0      check-team-rows.ts — flatten, hiddenRows, frozen time
 16 0      check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
 22 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 0
EXIT=0
```

23 EXECUTED, 2 SKIPPED-by-design (the browser gates; `--browser` was not requested), **RED 0** —
identical to the baseline R1-red recorded, so this fix cycle introduced no new red.

`pnpm test` — the forge-control unit suite:

```
# tests 1408
# pass 1408
# fail 0
```

1 384 before this fix cycle, 1 408 after: **24 new assertions**, of which 20 are proven-discriminating
above and 4 are the flips.

`tsc --noEmit` — exit 0, no output.

---

## 5. What a later reader should not have to rediscover

- **The `Map<string, Promise<unknown>>` must chain with `.then(work, work)`, not `.then(work)`.** The
  second form continues only on success, so the first 409 on a note wedges that note for the life of
  the process. There is a test for exactly this.
- **The tail stored in the Map must be a promise that cannot reject.** It is awaited by the next
  writer *and* by nobody else; an unhandled rejection on it takes the process down.
- **The Map entry is deleted only by the writer that is still the current tail.** Deleting
  unconditionally races a writer that has already replaced it.
- **The realpath check resolves the deepest existing ancestor, not the file.** A PUT to a note that
  does not exist yet must still be checkable, and `realpath` on a missing file is ENOENT.
- **The vault root is realpath'd too.** If `OBSIDIAN_VAULT_DIR` is ever a symlink, comparing a real
  path against a lexical root refuses every legitimate note in the vault.
- **`appendToDailyNote` and `createNote` keep the lexical guard only.** The realpath layer guards the
  two new verbs, which is what R9 covers and what the reviewer prescribed. Those two verbs address
  fixed configured directories rather than a caller-supplied path; this is stated in the module header
  rather than left for the next reviewer to find.
