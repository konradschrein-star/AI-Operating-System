# R1-gate — phase 1 gating verdict: vault write path and index truth

**Project:** `os-usable-for-work` · phase 1 · workstream `vault`
**Reviewer:** R1-gate (the single gating reviewer for this phase)
**Date:** 2026-08-19

## The tip reviewed

```
worktree   : /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--vault
branch     : project/7851068b-vault
HEAD       : 583cd3f1469f2c092c727b45521ebad5fca685f5
merge-base : 3f98e67114a8a1fd12fced068e2238b51c766462  (with project/7851068b)
git status : clean (empty --porcelain) at the start and at the end of this review
```

HEAD was re-read immediately before each blocker below was written; it had **not** moved
(`583cd3f` both times). Note that `583cd3f` is a *phase-2 planner* commit
(`phases/phase2-plan.md`); the last phase-1 commit is `1b6fa9a` (R1-red). Every claim in this
document is made against `583cd3f`.

Phase-1 commits reviewed: `2488ab8` (B1d) · `160fb0b` (B1a) · `5685654` (B1c) · `9a4beeb` (B1b) ·
`1b6fa9a` (R1-red).

**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` (the per-project layout).
Both paths exist — `docs/plan/03-quality.md` is the repo-wide predecessor and is *also* present;
the per-project one governs this project and is what §1.2 (fixture rule), §2.1, §3.4 (the loss
standard) and §4 were read from. The repo-wide gate suite named there,
`scripts/checks/gates-808.sh`, is the suite run below.

---

## 1. The universal block, verbatim

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 870ms using pnpm v9.15.9
  (exit 0)

$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 897ms using pnpm v9.15.9
  (exit 0)

  DEPENDENCY TELL: neither install printed a '+ typescript' or '- typescript' line —
  both said 'Already up to date', i.e. nothing was added and NOTHING WAS REMOVED.
  Positive proof the devDependencies survived, taken in the same run:
### tsc presence: forge-control
-rwxr-xr-x 1 root root 1544 Aug 19 00:05 forge-control/node_modules/.bin/tsc
-rwxr-xr-x 1 root root 1478 Aug 19 00:05 forge-control/node_modules/.bin/tsx
### tsc presence: forge-control-web
-rwxr-xr-x 1 root root 1576 Aug 19 00:05 forge-control-web/node_modules/.bin/tsc

$ cd ../forge-control && npx tsc --noEmit
  (no output)  EXIT=0
$ cd ../forge-control-web && npx tsc --noEmit
  (no output)  EXIT=0

$ cd ../forge-control && pnpm test        # tsx --test src/lib/*.test.ts
  type: 'suite'
  ...
1..276
# tests 1384
# suites 257
# pass 1384
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5575.594151
### STEP5 EXIT=0

$ cd .. && bash scripts/checks/gates-808.sh --strict
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
### GATES EXIT=0
```

**Gate suite:** `scripts/checks/gates-808.sh --strict` (the documented `--strict` invocation).
**25 gates · 23 EXECUTED · 2 SKIPPED-by-design · RED 0 · exit 0.**
The 2 skips are gates 23 and 24, the browser gates, which the suite skips unless `--browser` is
passed. Nothing stopped running silently: 23 `EXIT=` lines plus 2 `SKIPPED` lines = 25.

---

## 2. Baseline comparison — S13, "no NEW red"

Reference: `docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`, captured by B1d at
`9d63480` (2026-08-18T19:28:21Z), i.e. on the tree **before** this phase's code.

| # | Gate | Baseline (9d63480) | HEAD (583cd3f) | Δ |
|---|---|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | 0 | 0 | — |
| 2 | `npx tsc --noEmit` — forge-control-web | 0 | 0 | — |
| 3 | `NODE_ENV=production pnpm build` — forge-control-web | 0 | 0 | — |
| 4 | token purity — round 808's own files | 0 | 0 | — |
| 5 | `no-raw-colours.cjs` (whole app) | 0 | 0 | — |
| 6 | **forbidden-file diff — three-dot `main...HEAD`** | 0 | **0** | — |
| 7 | forge-control/ untouched by round 808's own commits | 0 | 0 | — |
| 8 | `dollar-sweep.sh` | 0 | 0 | — |
| 9 | `check-composer-v3.ts` | 0 | 0 | — |
| 10 | `check-secret-requests.ts` | 0 | 0 | — |
| 11 | `contrast-canvas-banners.cjs` | 0 | 0 | — |
| 12 | `check-working-sql-agreement.ts` — standalone typecheck | 0 | 0 | — |
| 13 | `check-stop-affordance.tsx` | 0 | 0 | — |
| 14 | `check-dismiss-peek.tsx` | 0 | 0 | — |
| 15 | `check-team-rows.ts` | 0 | 0 | — |
| 16 | `check-team-confirm.ts` | 0 | 0 | — |
| 17 | `verify-notification-gap-pins.mjs` | 0 | 0 | — |
| 18 | `check-usage-fold.ts` — against a real Postgres | 0 | 0 | — |
| 19 | `check-usage-fold.ts` — standalone typecheck | 0 | 0 | — |
| 20 | **`pnpm test` — forge-control unit suite** | 0 | 0 | — |
| 21 | `psql-argv-leak.cjs` | 0 | 0 | — |
| 22 | `nav-walk-sampling.cjs` | 0 | 0 | — |
| 23 | `phase700/network-700.cjs` | SKIPPED | SKIPPED | — |
| 24 | `phase600/nav-walk.cjs` | SKIPPED | SKIPPED | — |
| 25 | `reproduce-cleanliness` | 0 | 0 | — |
| | **RED** | **0** | **0** | **NO NEW RED** |

**Gate 17** is briefed as a "KNOWN PRE-EXISTING RED". It is **green in both runs** (92/92 pins
classified). The brief's note is superseded by the tree; nothing was widened to achieve it.

**Gate 6, the `forbidden-file diff`, did NOT trip** and therefore needs no adjudication. Confirmed
independently:

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
(no matches — exit 1)
```

Phase 1 touched none of those patterns.

---

## 3. Every mandated check, with its evidence

### 1. S1–S4 and S6, run by me against a TEMP FIXTURE VAULT

`/opt/obsidian-vault` was never opened for writing by anything in this review. Fixture vault
`/tmp/gate-vault-bSD7ki`, snapshot store `/tmp/gate-snap-MbNIzy`, both `mkdtemp`, with
`OBSIDIAN_VAULT_DIR` and `VAULT_SNAPSHOT_DIR` set before importing the router.

```
=== S1 round trip byte-identical ===
GET status 200 sha match sha256sum: true content identical: true
PUT status 200 {"ok":true,"path":"Notes/a.md","sha256":"08af27aa1f90…","bytes":55,…}
S1 RESULT: re-GET === PUT bytes: true | disk === PUT bytes: true | sha stable: true

=== S2 stale base → 409, current content, file unchanged ===
status 409 | has current_sha256: true | has current_content: true
current_content === on-disk oob: true
S2 RESULT: file unchanged on disk: true | status is 409: true

=== S3 empty body → 400, file unchanged ===
 content=""        -> 400 unchanged=true :: empty content refused: a zero-length body would erase Notes/a.md
 content="   \n\n" -> 400 unchanged=true :: empty content refused: a whitespace-only body would erase Notes/a.md
 content=" \t "    -> 400 unchanged=true :: empty content refused: a whitespace-only body would erase Notes/a.md

=== S4 prior content readable from snapshot store ===
PUT status 200 snapshot: /tmp/gate-snap-MbNIzy/2026-08-19/Notes__a.md.1787090817186.md
S4 RESULT: snapshot === PRIOR content: true | snapshot is OUTSIDE the vault: true
```

The S1 PUT body deliberately carried CRLF, a non-ASCII `ü`, and no trailing newline: the round trip
is byte-identical through all three.

**S6** — `index-health` returns the three-way reconciliation with a reason on every discrepancy.
Driven through the pure half against a synthetic vault (the I/O half needs both live databases,
which a build task may not touch):

```
CONTROL (every absence explained):  unexplained_count = 0
   stale_row_file_missing   Coach/log.md          :: embedding rows survive; km-indexer.js never prunes
   excluded_extension       Draw.excalidraw.md    :: km-indexer.js:29 EXCLUDED_EXTENSIONS
   empty_file               Empty.md              :: 0 bytes
   frontmatter_only         Front.md              :: 57 bytes, frontmatter only
every discrepancy carries a non-empty reason AND detail: true
```

**S1 PASS · S2 PASS · S3 PASS · S4 PASS · S6 PASS.**

### 2. Existing exports byte-identical

Each function sliced to its own closing brace at `main` and at `HEAD` and hashed:

```
appendToDailyNote    BYTE-IDENTICAL main->HEAD: True   (812 bytes)
createNote           BYTE-IDENTICAL main->HEAD: True   (918 bytes)
readDailyNote        BYTE-IDENTICAL main->HEAD: True   (366 bytes)
resolveInVault@main  b7d6c83c5ef2067e
resolveInVault@HEAD  b7d6c83c5ef2067e          <- identical
VAULT_DIR  both refs: const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
```

No refactor of `resolveInVault` or `VAULT_DIR`. The header-comment rewrite is the expected and
allowed change. **PASS.**

### 3. No delete verb

```
$ grep -n "\.delete\|unlink\|rename(" forge-control/src/routes/vault.ts
(no output — exit 1)
```

In `lib/vault.ts`, `fs.rename(` appears exactly once, at `:413`, the atomic temp-file swap; `fs.rm`
appears once at `:416`, and it removes only `tmpAbs` — a temp file this function created moments
earlier — on the failure path. No route removes, renames or moves a note. **PASS.**

### 4. Guard reuse

`resolveOrRefuse` (`lib/vault.ts:261`) *calls* `resolveInVault(rel)` at `:267` and adds only the
`.md` restriction. Both new verbs go through it (`readVaultFile:301`, `writeVaultFile:353`). The
traversal / dot-segment logic is not duplicated anywhere. **PASS.**

### 5. The fixture rule

```
$ grep -rn "/opt/obsidian-vault" src/lib/vault.test.ts src/lib/vault-fixture.ts \
       src/lib/vault-routes.test.ts src/lib/memory-index-health.test.ts
(no output — exit 1)
```

**PASS.**

### 6. The tests actually run

`pnpm test` is `tsx --test src/lib/*.test.ts`. All three new files live in `src/lib/` and match.
Each appeared in the run with its own count:

| File | Tests | Fail |
|---|---|---|
| `src/lib/vault.test.ts` | 38 | 0 |
| `src/lib/vault-routes.test.ts` | 20 | 0 |
| `src/lib/memory-index-health.test.ts` | 33 | 0 |
| whole suite | **1384** (257 suites) | **0** |

**PASS.**

### 7. The assertions can fail

Four boundary mutations of the *subject*, each run against the relevant suite, then restored and
re-hashed. Pre-mutation anchors: `vault.ts ee4336ece190b61f…`, `index-health.ts 685ec464f2c1b987…`.

| # | Mutation | Suite | Control | Mutated |
|---|---|---|---|---|
| 1 | R7 boundary — `if (content === "" \|\| /^\s*$/…)` → `if (content === "")`, i.e. whitespace-only accepted | vault.test.ts / vault-routes.test.ts | 38 pass / 20 pass | **37 pass, 1 fail / 19 pass, 1 fail** |
| 2 | R4/R5 — snapshot made best-effort (`.catch(() => "skipped")`) | vault.test.ts | 38 pass | **37 pass, 1 fail** |
| 3 | R13 boundary — `empty_file` threshold `bytes === 0` → `bytes < 1024` | memory-index-health.test.ts | 33 pass | **28 pass, 5 fail** |
| 4 | R15 envelope — `COUNTS_INTEGER_KEY_RULE` widened to admit a bare `all` | memory-index-health.test.ts | 33 pass | **31 pass, 2 fail** |

Every verdict flipped. These are not assertions over a clause every branch shares. Restore
verified byte-for-byte against the pre-mutation hashes; `git status --porcelain` empty afterwards.
**PASS.**

### 8. index-health derives, never hardcodes

No literal `15` / `10` / `1` / `284` / `259` drives any classification — the only occurrences of
those numbers in `index-health.ts` are at lines 17, 18, 19 and 313, all inside the header/doc
comments. Every `detail` string is built from the facts handed in (`${f.bytes} bytes …`).

`unexplained` flips 0 → 1 across the boundary. Same input set, one field changed — a normal
900-byte note with a body loses its embedding row:

```
FLIPPED: unexplained_count = 1
   unexplained  Notes/real.md :: 900 bytes with a non-empty body, on disk, no rows in
                                 content_forge.knowledge_embeddings and no deliberate exclusion applies
```

`reconcile()` additionally **throws** `IndexHealthInputError` rather than defaulting when the
`frontmatter_only` branch is reached with an unmeasured `hasBody` — a guessed body would be a
fabricated reason. **PASS.**

### 9. Prune is explicit-only

```
$ grep -rn "pruneStaleEmbeddingRows" --include=*.ts --include=*.tsx . | grep -v node_modules
./forge-control/src/db/memory.ts:511:export async function pruneStaleEmbeddingRows(   <- the definition
./forge-control/src/routes/memory.ts:15:  pruneStaleEmbeddingRows,                    <- the import
./forge-control/src/routes/memory.ts:107:    const { pruned, count } = await …        <- THE ONE CALL SITE
./forge-control/src/lib/memory-index-health.test.ts:578,596                           <- the test that asserts it
```

Exactly one call site, in `POST /index-health/prune`, gated by `confirm !== true → 400`. No tick,
no startup path, no read path. The candidate list is **recomputed server-side** from
`stalePaths(health)` and never taken from the client, so a hostile path list cannot reach a DELETE.
**PASS.**

### 10. N1/R20 — hard errors, no silent fallback

Grep of the added lines for `catch {`, `?? 0`, `|| []` in `forge-control/src`:

- `index-health.ts:511` — `bytes: onDisk?.bytes ?? 0`. **Not a swallowed error.** It is a
  placeholder for a path that is *not on disk* (the stale-row direction), where `bytes` is
  documented as meaningless and is never read by the branch that classifies it. The one branch that
  *does* need a measured value throws instead of defaulting.
- `index-health.ts:605` — `out[folder] = (out[folder] ?? 0) + 1`. A tally accumulator, not a query
  fallback.
- No `catch {` and no `|| []` was added anywhere in the diff.

`routes/vault.ts`: every catch carries the upstream message and a status — 400 for
`VaultRefusedError`, 404 for ENOENT on GET, 409 for `VaultConflictError` **with the current
content**, 500 with `describe(e)` otherwise. `PUT` deliberately does **not** use the
`.catch(() => ({}))` body idiom the three legacy handlers use.
`routes/memory.ts`: `index-health` and its prune both return 500 **with the message** and never
degrade to zeros.

**PASS at the route layer and in the new lib code. NOT PASS in `lib/vault.ts:163` — see BLOCKER 2.**

### 11. Counts envelope

`COUNTS_INTEGER_KEY_RULE = /^(vault|agent|embedded|excluded|stale)_/` is enforced structurally by
`offendingCountKeys()`, and mutation 4 above proves that enforcement is live. `all` is gone from the
counts payload. The only surviving `all` is `source: "vault" | "agent" | "all"` — a *string scope
label*, not an integer, and not a smuggled union count. `folder_rule` is emitted alongside
`folder_counts` and states the derivation verbatim.

**B1c's declared handoff is written down**, in the commit message of `5685654` *and* in
`index-reconciliation.md` §3 under a "⚠️ HANDOFF TO PHASE 2 — DECLARED, NOT FIXED" heading naming
`MemorySurface.tsx:176`, plus `app/api.ts:468` as the reason it fails at runtime rather than at
typecheck. And the file was **not touched**:

```
$ git diff --name-only main...HEAD -- forge-control-web/
(empty)
```

**PASS.**

### 12. R17 — the category-chip removal reason is in the commit message

`5685654` carries it in full: `inferCategory()` matched frontmatter tags named
`rule`/`pref`/`person`/`project`/`fact`; the vault's real tags are `recurring`, `wasted-lease`,
`inbox_triage`, `gmail`, `mcp`, `oauth-scope`, and only 65 of 284 notes carry any tag at all — so
five of six chips were structurally incapable of a non-zero number. Replaced by `folder_counts`.
**PASS.**

### 13. The artefacts exist and are honest

| Artefact | State |
|---|---|
| `gates-baseline.txt` | 530 lines, verbatim, header records commit/branch/time/command, **every one of the 25 gates listed with its status**, plus a self-derived fidelity hash anchored on the body's first banner line rather than a byte offset |
| `typecheck-baseline.txt` | present |
| `browser-harness.md` + `.mjs` | present; the `/signin` assertion is at `.mjs:361` (`assertPastAuthWall`) and `--keep-going` explicitly does not downgrade it |
| `harness-proof.png` | **opened.** Shows an authenticated `/desktop`: "Good evening, Konrad.", the full nav, the fleet rail, three reminder cards, `konrad · online`. **Not the login page.** |
| `reproduce-before.md` | present |
| `index-reconciliation.md` | present, carries the phase-2 handoff |
| `red-team-vault-write.md` | present |

**PASS.**

### 14. The harness runs — I executed it myself

Compliant path: a throwaway `next start` on port **7781** launched **from this worktree** against
the `.next` that gate 3 built (`BUILD_ID 4YQam-HN9gENa45BUqDqy`), with `AUTH_SECRET` **exported**
(64 chars, read from the live `.env.local` — a read, N4-permitted). The wall was confirmed up
before testing anything, or the negative control would have been inert:

```
$ curl -s -o /dev/null -w "status=%{http_code} redirect=%{redirect_url}\n" http://127.0.0.1:7781/desktop
status=307 redirect=http://127.0.0.1:7781/signin
```

| Run | Salt | Landed | ok | Exit |
|---|---|---|---|---|
| A | `plain` (correct for an http base) | `/desktop`, HTTP 200, title "forge" | `true` | **0** |
| B | `secure` (wrong) **+ `--keep-going`** | `/signin` | `false` | **2** |
| C | `plain`, `--path /signin` | `/signin` | `false` | **2** |

Run A's screenshot is at
`/opt/ai-os/uploads/e7d99a1b9aa5/20260819T001500Z-gate-harness-authenticated.png`, read back
inline: the authenticated desktop, "Working late, Konrad.", 50 open inbox items, live reminders.
Run B proves `--keep-going` does **not** soften the assertion. The harness is sound and lanes 2–6
can inherit it. The throwaway server was stopped afterwards (pid killed by port lookup, not
`pkill -f`). **PASS.**

### 15. The red team's verdict — adjudicated

`red-team-vault-write.md` raised **3 BLOCKERS**. No commit landed after it (`1b6fa9a` is the
red-team report; `583cd3f` is a phase-2 plan). **None is closed.** I reproduced two of them
independently at `583cd3f`, from scripts I wrote myself, against my own temp fixtures — see the
blocker list below. B-3 I confirm by source inspection at HEAD.

### 16. Write-set discipline

Declared write-sets read from the **task rows** via `GET /api/projects/7851068b-…`, compared against
`git show --name-only` over each task's commits:

| Task | Declared | Touched | |
|---|---|---|---|
| B1d `2488ab8` | 6 paths under `phase1/` | the same 6 | ✅ |
| B1a `160fb0b` | `lib/vault.ts`, `lib/vault.test.ts`, `lib/vault-fixture.ts` | the same 3 | ✅ |
| B1c `5685654` | `db/memory.ts`, `routes/memory.ts`, `lib/index-health.ts`, `lib/memory-index-health.test.ts`, `index-reconciliation.md` | the same 5 | ✅ |
| B1b `9a4beeb` | `routes/vault.ts`, `lib/vault-routes.test.ts` | the same 2 | ✅ |
| R1-red `1b6fa9a` | `red-team-vault-write.md` | the same 1 | ✅ |

**No undeclared writes.** And the forbidden set is absent from `main...HEAD`:
`forge-control/src/index.ts` — absent. `package.json` / `pnpm-lock.yaml` — absent, no dependency was
added. No new route file: `routes/vault.ts` and `routes/memory.ts` both pre-existed.
`MemorySurface.tsx` — absent. **PASS.**

`583cd3f` (`phases/phase2-plan.md`) is on this branch but belongs to phase 2's planner, not to a
phase-1 task; it is outside phase 1's write-sets by design and touches no code.

### 17. N4 — no write path to `/opt/forge-ai-os`

Every occurrence of that path in the diff is a **read** (`. …/.env.local`, `DEFAULT_ENV_FILE`, prose
in the corpus). No `writeFile`/`mkdir`/`appendFile`/`rm`/redirect targets it:

```
$ git diff main...HEAD | grep -nE "writeFile|mkdir|appendFile|rm -|unlink|> */opt/forge-ai-os" | grep forge-ai-os
(no output — exit 1)
```

My own transcript likewise only ever read `/opt/forge-ai-os/forge-control-web/.env.local`. **PASS.**

### 18. The standing question — does anything display a value the operator cannot trace?

No. Every integer in the counts envelope carries a prefix naming its unit and source table; every
discrepancy carries both a `reason` and a `detail` string built from the measurement; `folder_rule`
ships the derivation in the payload; `measured_at` timestamps the reconciliation. This phase is,
on this axis, the best-instrumented work in the corpus. **PASS.**

### Live-checkout cleanliness (mandatory)

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/slash-registry.ts
 M forge-control/src/routes/chat.ts
```

**at the start of this review.** Re-run at the end: **empty**. The two files were not reverted —
they were **committed directly onto `main` in the live checkout** while this review ran:

```
$ git -C /opt/forge-ai-os reflog show main
91f6b28 main@{0}: commit: feat(chat): /compact — archive the thread, then keep only the newest 60 entries
1e0330b main@{1}: commit: fix(chat): window the rendered thread — only the newest 60 messages mount
22967d6 main@{2}: merge project/b7ab4c57: Fast-forward
```

Recorded as a finding (F-8) below. It is **not** this lane's work and touches none of phase 1's
files, so it does not change what phase 1 built.

---

## The blockers

### BLOCKER 1 — `forge-control/src/lib/vault.ts:383-413` — two concurrent PUTs lose an acknowledged edit, unrecoverably (R4/R5, 02-architecture §1.2)

**Reproduced by me at `583cd3f`**, `/tmp/gate-repro/b1.mts`, driving the real Hono router over a
temp fixture vault, six runs:

```
run 0: A=200 B=500 | disk="KONRAD paragraph run0" | UNRECOVERABLE_LOST=0
run 1: A=200 B=200 | disk="second save run1"      | UNRECOVERABLE_LOST=1 -> "# Note\n\nKONRAD paragraph run1\n"
run 2: A=200 B=500 | ...
…
SUMMARY over 6 runs: runs with an ACKNOWLEDGED-200 edit that is neither on disk
nor in ANY snapshot = 1; runs with a 500 = 5
```

Every step of read → compare → snapshot → rename is `await`ed, so two concurrent HTTP requests
interleave. Both read the same bytes, both pass CAS against the same `base_sha256`, both snapshot
*the same pre-state*, and both rename. §1.2's premise — "single-process Node, so the sequence is
not interleaved with another request in this process" — is false, and the snapshot store does not
cover this case because it holds the pre-state, not the first writer's content.

**Failure scenario:** Konrad's editor autosaves while he presses ⌘S, or he double-clicks Save, or
the surface retries a slow request. Both PUTs return `200 {ok:true}`. His paragraph is on disk for
milliseconds and then gone — not on disk, and in no snapshot. He was told it saved.

The other five runs are the same defect wearing the other face: the same-millisecond snapshot
filename collides under `wx` and the second edit dies with a 500 the UI has no retry story for. So
today the PUT verb under any concurrency returns **either a silent lost edit or a 500**, selected by
timing.

**What "closed" looks like:** an in-process serialisation point keyed on the resolved absolute path
— a `Map<string, Promise<unknown>>` chain around the body of `writeVaultFile`, ~10 lines. It needs
no on-disk state, so it is not the lock file §1.2 rejected. Add a random suffix to the snapshot
filename (as `:404` already does for the temp file) to close the collision. A test that fires N
concurrent PUTs at one path and asserts every 200 is either on disk or in a snapshot.

### BLOCKER 2 — `forge-control/src/lib/vault.ts:163` — a bare `catch` replaces the daily note with an empty template and reports success (R20/N1)

**Reproduced by me at `583cd3f`**, `/tmp/gate-repro/b2.mts`:

```
daily note BEFORE: 5276 bytes, 209 lines
read fails with EIO → appendToDailyNote RESOLVED, threw? NO, returned {"path":"Daily/2026-08-19.md","created":true}
daily note AFTER: 76 bytes   |   BYTES DESTROYED: 5200
snapshot store entries: 0 — EMPTY, UNRECOVERABLE
```

```ts
try   { content = await fs.readFile(abs, "utf8"); }
catch { content = DAILY_TEMPLATE(date); created = true; }   // <- EVERY error, not just ENOENT
…
await fs.writeFile(abs, next, "utf8");                       // writes the template OVER the real note
```

Any non-ENOENT read failure — EIO from a failing disk, ENOMEM (forge-control is one process that
also runs the cron tick, the vault sync and Telegram delivery), `ERR_FS_FILE_TOO_LARGE` — is treated
as "today's note does not exist yet". R20 names this verbatim: *the vault verbs hard-error, no
`catch {}` that returns a default*, and `POST /api/vault/append` is a vault verb reached through
this function.

**Line 163 is pre-existing code this diff did not modify**, and R11 asks for identical behaviour.
I am blocking on it anyway, and this is my adjudication of the R11/R20 tension the red team
escalated: commit `160fb0b` added a **new, module-wide, load-bearing claim** at `vault.ts:10` —
`NO CONTENT THIS MODULE EVER REMOVES IS UNRECOVERABLE` — and at `:13`, "All three are mandatory;
none is optional, best-effort, or skippable". That sentence is the entire justification for giving
up the append-only contract, and it is demonstrably false. Shipping a false safety claim is worse
than shipping none, because the claim is what the next agent will trust.

**RULING:** take the fix. R11 exists to protect append-or-create *semantics*, not to preserve a
data-destroying fallback; a path that destroys a note and returns `created: true` is not behaviour
R11 was written to defend. Record the exception in the phases document in the same commit.

**What "closed" looks like:** rethrow anything whose `code` is not `ENOENT`, exactly as
`writeVaultFile:385` already does in the same file; a test that injects EIO on the read and asserts
the call throws with the note byte-identical; the R11 exception recorded.

### BLOCKER 3 — `forge-control/src/lib/vault.ts:170` — the append is a non-atomic in-place write, so a crash truncates the note (R6)

`await fs.writeFile(abs, next, "utf8")` opens the destination with `O_TRUNC`. For the duration of
the write the note is a prefix of itself on disk, with no temp file and no snapshot behind it. R6's
"fails when" names this exactly: *an in-place write exists, so a crash mid-write truncates a note*.
The red team demonstrated it on a 43 MB note (30 MB lost, survivor a strict prefix, snapshot store
empty); I confirm the site is unchanged at `583cd3f`.

**The test that should have caught this is scoped away from it** — and this is the part worth
naming, because it is the fleet's recurring instrument failure. `vault.test.ts:417` slices `CODE` to
the body of `writeVaultFile` alone, then uses the string literal `'await fs.writeFile(abs, next,
"utf8")'` as its negative control to prove the regex is live. That literal **is line 170**. The
counterexample is used to validate the assertion while being excluded from the assertion's subject.
The test is honest about its stated scope; the module header at `:10` is not.

**What "closed" looks like:** extract `:404-413` into a private `atomicWrite(abs, content)` and call
it from both `appendToDailyNote` and `writeVaultFile`. The bytes that land are unchanged, so R11's
byte-level characterisation test (`vault.test.ts:581`, `:600`) still passes — this fix is
R11-neutral. Then widen the source-inspection test's subject from `writeVaultFile` to the whole
module, with a fresh negative control that is not itself a live defect.

---

## Findings folded into existing task briefs (N8 — not fix cycles)

- **F-1 (security, fold into B1a).** `resolveInVault:67` is lexical: `path.resolve()` does not
  resolve symlinks, so a symlink planted in the vault escapes it for **both** the new GET and the
  new PUT — and forge-control runs as **root**. The red team demonstrated `ln -s /etc/hostname
  $VAULT/leak.md` → `GET /api/vault/file?path=leak.md` returns the file, and a symlinked directory
  → `PUT` overwriting a file outside the vault. The vault holds **0 symlinks today** (verified:
  `find /opt/obsidian-vault -type l | wc -l` → 0), and content stays recoverable because the
  snapshot is taken before every write, so this is a finding and not a blocker. But the guard's
  stated guarantee (R9: "traversal rejected") does not hold, and the new verbs are what turned a
  create-only guard into an arbitrary-read/arbitrary-overwrite guard. **Fix:** `await
  fs.realpath(path.dirname(abs))` and re-assert containment in `resolveOrRefuse` — two lines,
  covers GET and PUT together.
- **F-2 (fold into B1a).** `vault.ts:365` — `\s` does not cover U+200B/200C/200D/2060, so a
  zero-width-space-only body is accepted and blanks the note. Strip
  `/[\u200B-\u200D\u2060\uFEFF]/g` from a copy before the `^\s*$` test.
- **F-3 (fold into the BLOCKER 1 fix).** Same-millisecond snapshot filename collision → 500. I
  reproduced this in **5 of 6** runs, so it is the *dominant* concurrency outcome, not an edge case.
- **F-4 (fold into B1a, doc).** `02-architecture.md` §1.2 states two things that are false: the
  single-process non-interleaving premise (root cause of BLOCKER 1), and "the snapshot makes the
  worst case recoverable". Say what is true instead: *the pre-edit state is always recoverable; a
  third-party write that lands inside the window is not.*
- **F-5 (fold into B1b).** A 409 serialises the whole note — 256 MB body, 3.2 s stall, on the
  process that also runs the cron tick and Telegram delivery. Cap `current_content` and add
  `current_content_truncated: true`.
- **F-6 (fold into B1a).** A crash during the temp write leaves an orphan `*.tmp-*` in the vault.
  Sweep or document.
- **F-7 (fold into B1a, doc).** The snapshot store has no retention; a full disk arms BLOCKER 3.
  Retention can stay a later decision, the coupling should be in the header.
- **N-1.** A NUL-containing or 5000-char path 500s with the **absolute** vault path in the body.
  Path disclosure on an authenticated surface; cosmetic, worth a scrub.
- **N-2.** `readDailyNote:214` swallows every read error and returns `content: null`, so a transient
  EIO renders as "no daily note today". Read-only, no loss — same R20 smell as BLOCKER 2.

## F-8 — the live checkout was hot-applied (not this lane)

`git -C /opt/forge-ai-os status --porcelain` was **not empty** when this review began:

```
 M forge-control-web/app/desktop/chat/slash-registry.ts
 M forge-control/src/routes/chat.ts
```

Those edits were then committed **directly onto `main` in the live checkout** as `91f6b28`
(`feat(chat): /compact …`), preceded by `1e0330b` (`fix(chat): window the rendered thread …`). Both
are chat-compaction work, unrelated to `os-usable-for-work` and touching none of phase 1's files.
The worktree-only policy was nevertheless broken by whoever did it. **Required:** that work be
re-done in a worktree and reach `main` through a gating reviewer, per N9. It changes nothing about
phase 1's code and it is not attributable to any phase-1 task.

---

## What phase 1 got right

Worth stating, because the verdict below is not a judgement on the quality of the work. The PUT
verb held against every input attack in the red team's list and every one I re-ran: 62 hostile
bodies, bases, paths and transports refused with the note byte-identical afterwards, both ENOSPC
sites, and an unwritable snapshot destination that root cannot defeat. The snapshot is genuinely
load-bearing. `index-health` is the most honest instrument in this corpus — it derives everything,
throws rather than guessing, and refuses to classify without a measurement. The counts envelope is
structurally enforced and the enforcement is provably live. The write-set discipline is exact. The
harness works and is inheritable. Four boundary mutations flipped four verdicts. The failure here
is concentrated in one place: **concurrency and the two pre-existing loss paths that the new module
header now positively asserts cannot exist.**

---

## For phase 2's planner

A `NEEDS_FIXES` seeds no fix cycle: these three blockers sit at `583cd3f` and travel into phase 2.
In priority order, each already carries its file, line, requirement id and definition of closed:

1. `forge-control/src/lib/vault.ts:383-413` — serialise `writeVaultFile` per resolved path; random
   suffix on the snapshot name. **R4/R5**, 02-architecture §1.2. Closed = N concurrent PUTs to one
   path, every 200 recoverable from disk or a snapshot, asserted by a test.
2. `forge-control/src/lib/vault.ts:163` — rethrow non-ENOENT. **R20/N1**. Closed = an injected EIO
   throws with the note byte-identical, and the R11 exception is recorded in the phases document in
   the same commit.
3. `forge-control/src/lib/vault.ts:170` — route through a shared `atomicWrite()`. **R6**. Closed =
   no `writeFile(abs…)` anywhere in the module, and the source-inspection test's subject widened
   past `writeVaultFile` with a negative control that is not a live defect.
4. Fold F-1 (symlink escape, root) into whichever task reopens `lib/vault.ts` — it is two lines and
   the new verbs are what made it reachable.

Phase 2 must also honour the declared handoff: `MemorySurface.tsx:176` renders `counts.all` which no
longer exists, and `app/api.ts:468` types it without validating, so it fails at runtime rather than
at typecheck. Nothing deploys before phase 7, so no live surface is broken in the meantime.

---

VERDICT: NEEDS_FIXES
