# Fix cycle 2 — the unqueued append (round 6, vault lane)

Reviewer: *Re-review after fix cycle 1 · vault*, tip `698c230`, verdict **NEEDS_FIXES**.
Four points. One is a code blocker, two are folds, one is not this lane's to touch.

Base commit for everything below: `c171d1f` (round 5's re-check), worktree clean at start.

---

## 1. Blocker 1 — `appendToDailyNote` loses acknowledged captures

### 1.1 Reproduced first, from the pre-fix tree

The reviewer's numbers were not taken on trust. `/tmp/r6-vault/probe-append-race.mts` builds a throwaway
vault under `os.tmpdir()`, points `OBSIDIAN_VAULT_DIR` at it, imports the module under test **by absolute
path** (so which tree is being measured is an argument, not an assumption), fires N concurrent
`appendToDailyNote` calls at one daily note, and counts the timestamped bullets that survive.

Against `c171d1f`, the tree as the reviewer left it:

```
 2 concurrent appendToDailyNote → ok:2  rejected:0,  1 line(s) on disk, LOST 1, snapshots 0
 5 concurrent appendToDailyNote → ok:5  rejected:0,  1 line(s) on disk, LOST 4, snapshots 0
10 concurrent appendToDailyNote → ok:10 rejected:0,  1 line(s) on disk, LOST 9, snapshots 0
```

Identical to the reviewer's table, including the zero in the snapshot column. That zero is what makes
this a data-loss defect rather than a nuisance: the verb takes no snapshot — correctly, because when it
works it replaces nothing — so a capture lost this way has nowhere to be recovered from. Ten callers
were told `{ok:true}`; one line exists.

### 1.2 The fix

`forge-control/src/lib/vault.ts` — the read, the splice and the `atomicWrite` now run inside
`serialiseOnPath(abs, …)`, the per-path queue already in the file and already used by `writeVaultFile`'s
steps 4–7. Exactly the prescription: "wrap the body from the `fs.readFile` through the `atomicWrite`".

What deliberately stays **outside** the queue: the `text` trim and its refusal, `nowParts()`, the path
resolution and the `mkdir`. None of them touches the note's bytes, and keeping `time` outside means the
stamp records when the capture was made rather than when the queue reached it — the serial case is
byte-for-byte unchanged.

`createNote` was left alone and needs no queue: `wx` makes the kernel the arbiter.

### 1.3 The same probe, same command, against the fixed tree

```
 2 concurrent appendToDailyNote → ok:2  rejected:0,  2 line(s) on disk, LOST 0, snapshots 0
 5 concurrent appendToDailyNote → ok:5  rejected:0,  5 line(s) on disk, LOST 0, snapshots 0
10 concurrent appendToDailyNote → ok:10 rejected:0, 10 line(s) on disk, LOST 0, snapshots 0
```

### 1.4 The proving tests, and the mutation that proves *them*

Four tests in `forge-control/src/lib/vault.test.ts`, in a new describe block that stashes and restores
today's daily note the way the R11 block does:

| Test | What it asserts |
|---|---|
| `10 concurrent captures → 10 acknowledgements AND 10 lines on disk` | every acknowledged text appears **exactly once**; the note grew by exactly one line per capture; the seed content is still underneath; all ten report `created:false` |
| `the create branch is entered ONCE, not once per concurrent caller` | the other side of the ENOENT boundary — exactly one of five concurrent callers may report `created:true`, and all five texts are on disk |
| `an append racing an EDIT of the same note shares one queue` | both verbs key on the same resolved path. Either the edit ran first (its bytes are on disk and the append is spliced into them) or the append ran first (the edit's compare-and-swap sees the appended bytes and raises `VaultConflictError`). In **both** branches the acknowledged capture is on disk and nothing unacknowledged is |
| `the queue drains after a burst of appends` | `pendingVaultWrites()` is 0 afterwards — the append verb writes into the same `Map`, so it inherits the same leak risk |

An assertion that passes before and after the fix proves nothing, so the wrapper was removed again by
mechanical mutation (`return serialiseOnPath(abs, async () => {` → `return (async () => {`, and its
closing `});` → `})();`), the suite re-run, and the file restored and **verified by sha256** —
`05bd9c0ca5f1347d315f9eb0a650554136648af9435028b84eaef632b65ba003` before and after.

```
not ok 1 - 10 concurrent captures → 10 acknowledgements AND 10 lines on disk
not ok 2 - the create branch is entered ONCE, not once per concurrent caller
not ok 3 - an append racing an EDIT of the same note shares one queue
    ok 4 - the queue drains after a burst of appends
# tests 65 / pass 62 / fail 3
```

**Disclosed honestly: test 4 does not discriminate.** It is green against the mutant, because a burst of
unqueued appends also leaves the `Map` empty — it never enters it. It is a leak guard, not a race guard,
and it is kept for the same reason `writeVaultFile` has one. Tests 1–3 are the flip.

### 1.5 The claims the fix commit is allowed to make

The reviewer's blocker was as much about the header as the race: `vault.ts:14-18` and `:23-24` promised
something the module did not hold. Both were rewritten to say what is now measured, and the
`serialiseOnPath` doc comment records why the append verb was missed the first time. The residual is
named rather than buried: the queue keys on the **lexical** absolute path, so one note reachable under
two in-vault names would take two queues. `find /opt/obsidian-vault -type l` → **0**, so it is
theoretical today; it sits in the header's "what is NOT claimed" list beside the cross-process window.

---

## 2. Fold — `03-quality.md:146-148` contradicted `04-phases.md §10.1`

The phase-1 reviewer was still instructed to confirm `appendToDailyNote` / `createNote` / `readDailyNote`
are byte-identical to `main` — a criterion §10.1 had already ruled an exception to, and which this round
falsifies a third time. Amended: `createNote` must still be byte-identical; the other two may differ
**only** in the three enumerated ways, and any other change is still a finding. The exception's
justification is stated in the same place, so the next reader does not have to reconstruct it.

## 3. Fold — `routes/vault.ts:184` cited three stale line numbers

`lib/vault.ts:353, :359, :372` were `:612`, `:621`, `:635` by the time the reviewer read them, and would
have been stale again after this commit. Repinning buys one round; the guards are **named** instead —
the path/`.md` refusal, the empty-body refusal, the `base_sha256` refusal — and the stale pins are quoted
in the comment so the change is legible as a repair rather than a rewrite.

## 4. Not this lane's — `/opt/forge-ai-os` is dirty

Confirmed and left alone. The worktree-only policy forbids this workstream touching the live checkout,
and it has no authority over that work. Two observations the manager needs and the review did not have:

- The tree **changed between the review and this round**. `docs/SPEC-DAILY-SURFACE.md`,
  `docs/evening-planner-prompt.md`, `db/migrations/0042_daily_system.sql`, `GoalsStats.tsx` and
  `mint-session.mjs` are gone; `docs/superseded/` is new. Live HEAD is still `91f6b28` on `main`.
- So it is not an abandoned dirty tree — someone is **actively editing it now**. "Revert to clean"
  handed to the wrong agent destroys work in flight. Whoever owns the Goals build should move it into a
  worktree themselves, and phase 7 must not deploy across it.

Reported to the manager chat.

---

## 5. Verification

| What | Result |
|---|---|
| `pnpm install --frozen-lockfile --prod=false` (both packages) | "Already up to date"; `tsc` and `tsx` present in `node_modules/.bin` |
| `npx tsc --noEmit`, `forge-control` | **exit 0** |
| `npx tsc --noEmit`, `forge-control-web` | **exit 0** |
| `pnpm test` (`forge-control`) | **1413 / 1413**, 0 fail |
| `bash scripts/checks/gates-808.sh --strict` | 25 gates, 23 executed, 2 skipped-by-design (browser, `--browser` not requested), **RED 0, exit 0** |
| mutation control on the new tests | 3 of 4 flip red; file restored, sha256 identical before and after |

### 5.1 Two numbers a re-check will otherwise query

**The suite count moved 1409 → 1413, not 1408 → 1412.** The re-review recorded 1408 at its own tip
`698c230`; round 5's re-check commit `c171d1f` then added the one test §10.3 discloses (the §6.1 `wx`
deviation pin). Measured, not reasoned: `HEAD`'s `vault.test.ts` restored over the working copy and the
suite re-run gives **1409**, the working copy gives **1413**, and the delta is exactly the four tests
§1.4 lists. The test file was restored from a copy and checked by sha256
(`1acb68b232ee49fa91801f56afcc7475e23a02048cd4ea681430efbc0e512047`).

**Gate 18 was RED on the first full run and green on the two after it.** Gate 18 is
`check-usage-fold.ts` against a real Postgres, and its output on the first run carried
`NOTICE: relation "runs" already exists, skipping` — the signature of two gate runs meeting in one
scratch database. `ps aux | grep -c "[g]ates-808.sh"` showed **7** other gate runs live on this box at
the time, from the other lanes. Re-run serially the gate reports `ALL PASS — usage fold (scratch db:
r1354_sampler)`, exit 0, twice. The red is contention, not this lane's diff — no file this commit
touches is reachable from that gate. Recorded rather than quietly re-run until green.
