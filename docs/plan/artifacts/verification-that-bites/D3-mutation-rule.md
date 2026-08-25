# D3 — the mutation rule, made cheap

`scripts/checks/prove-it-bites.sh`, and the seven controls run against it.

**The rule this project leaves behind.** A check that has never been observed
failing is a decoration. Every task that ships a check ships the transcript of
that check failing on a named mutation, restore proven by hash.

That rule was already being followed by hand, three times in two days, by three
different workers — the tool-block browser check, the guardrail-engine matrix
re-run against a scratch copy of the old code, and round 0 of this project on
`guard.sh`'s forbidden-file guard (PLAN.md §F2). Each cost an afternoon and each
produced a differently-shaped transcript. This is that transcript made
repeatable. One line:

```
bash scripts/checks/prove-it-bites.sh \
  --subject forge-control-web/app/desktop/chat/useAutogrow.ts \
  --mutation 'sed -i "s/measuredPx > maxPx/measuredPx >= maxPx/" "$SUBJECT"' \
  --check 'cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3' \
  --expect-fail
```

## The contract, in seven steps

The script prints each step, so the transcript IS the evidence — there is
nothing to summarise afterwards and no summary to be wrong.

| step | what it does | why it exists |
|---|---|---|
| 1 | refuses to start if `git status --porcelain -- <subject>` is non-empty (**exit 2**) | a restore proven against already-modified bytes proves nothing |
| 2 | records `md5sum <subject>` and copies it to `/tmp` | the copy is the manual restore after a SIGKILL |
| 3 | runs the check UNMUTATED; **exit 3** if it is already non-zero | you cannot demonstrate that a red check bites — this is the control that stops a pre-existing RED being reported as proof of a new assertion |
| 4 | applies the mutation, prints the resulting diff verbatim | so a reader can see exactly what was broken |
| 5 | runs the check MUTATED, records exit code and the last 20 lines | |
| 6 | restores and **proves the restore by hash**; **exit 4** on mismatch | a restore nobody has watched fail is a restore nobody knows is broken |
| 7 | VERDICT: `BITES` / `INERT` / `INCONCLUSIVE` | no third outcome, no silent fallback |

`BITES` (exit 0) requires all three: unmutated exit == 0, every mutation drove
the check non-zero, and md5 before == md5 after. `INERT` is exit 5, and the two
`INCONCLUSIVE` cases are exit 4 (restore failed) and exit 6 (a check run hit the
timeout — a hang exits non-zero and would otherwise read as a bite).

Restore is on a `trap ... EXIT`, never `ERR`: bash does not inherit an ERR trap
into functions or subshells without `set -E`, so an ERR trap here would silently
not fire from inside a helper (memory note `err-trap-not-inherited-by-functions`).
Control (e) below is that trap watched firing under a real `kill`.

With N mutations, each is applied to the **pristine** subject, measured and
restored before the next, and step 7 reports per mutation which
**DISCRIMINATED** and which did not. That distinction is the whole of model 2:
it is the difference between a control and regression coverage. Control (d) is
a run where one of each landed in the same table.

---

## (a) POSITIVE CONTROL — a check known to bite prints BITES

Subject `forge-control-web/app/desktop/chat/useAutogrow.ts`, check =
**gates-808.sh gate 10** (`check-composer-v3.ts`) run exactly as the suite runs
it, pipe included. Two mutations, each against a claim the check's own header
makes: mutation 1 flips the cap boundary from `>` to `>=` (claim 2, "the cap
boundary is closed on the correct side"), mutation 2 deletes the lower clamp
(claim 1, "an empty composer clamps to EXACTLY minPx").

```
$ bash scripts/checks/prove-it-bites.sh \
    --subject forge-control-web/app/desktop/chat/useAutogrow.ts \
    --mutation 'sed -i "s/measuredPx > maxPx/measuredPx >= maxPx/" "$SUBJECT"' \
    --mutation 'sed -i "s/Math.min(Math.max(measuredPx, minPx), maxPx)/Math.min(measuredPx, maxPx)/" "$SUBJECT"' \
    --check 'cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3' \
    --expect-fail --tail 3
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control-web/app/desktop/chat/useAutogrow.ts
check       : cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
mutations   : 2
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control-web/app/desktop/chat/useAutogrow.ts
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  md5sum forge-control-web/app/desktop/chat/useAutogrow.ts
  BEFORE : 0ebc8ac297956d25e873f91d774ee7b2
  backup : /tmp/prove-it-bites-backup.38QLbB  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of unmutated output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | OK — 9 clamp cases + ramp table clean
--------------------------------------------------------------------------
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 2 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | sed -i "s/measuredPx > maxPx/measuredPx >= maxPx/" "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control-web/app/desktop/chat/useAutogrow.ts b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | index 0d892f5..d0c8393 100644
  | --- a/forge-control-web/app/desktop/chat/useAutogrow.ts
  | +++ b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | @@ -69,7 +69,7 @@ export function clampAutogrow(
  |      throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  |    }
  |    const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  | -  return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
  | +  return { height, overflowY: measuredPx >= maxPx ? "auto" : "hidden" };
  |  }
  |  
  |  /** Font/box metrics of the textarea, read once and cached. */
--------------------------------------------------------------------------
  md5 while mutated: 9cdb32df9ba2b9b9838856f6f44d4e0c

STEP 5.1 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of mutated/1 output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | 1 FAILURE(S)
--------------------------------------------------------------------------
  exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 4.2 — apply mutation 2 of 2 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | sed -i "s/Math.min(Math.max(measuredPx, minPx), maxPx)/Math.min(measuredPx, maxPx)/" "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control-web/app/desktop/chat/useAutogrow.ts b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | index 0d892f5..78c926b 100644
  | --- a/forge-control-web/app/desktop/chat/useAutogrow.ts
  | +++ b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | @@ -68,7 +68,7 @@ export function clampAutogrow(
  |    if (maxPx < minPx) {
  |      throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  |    }
  | -  const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  | +  const height = Math.min(measuredPx, maxPx);
  |    return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
  |  }
  |  
--------------------------------------------------------------------------
  md5 while mutated: 7c14147ffcbea8c79d457049c91d826e

STEP 5.2 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of mutated/2 output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | 3 FAILURE(S)
--------------------------------------------------------------------------
  exit code (mutated/2): 1

STEP 6.2 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   1            DISCRIMINATED          argv
  2   1            DISCRIMINATED          argv

VERDICT: BITES — unmutated exit 0, 2/2 mutation(s) drove it non-zero, subject restored (md5 0ebc8ac297956d25e873f91d774ee7b2).
HARNESS EXIT=0
```

Gate 10 bites, on both claims, and the subject came back byte-identical twice.

---

## (b) NEGATIVE CONTROL — gates-808.sh gate 7 prints INERT

`scripts/checks/gates-808.sh:167`, "forge-control/ untouched by round 808's own
commits", ends in a literal `exit 0`. If this harness printed BITES on that, the
harness would itself be a decoration.

The gate body is **extracted from the suite by name**, not hand-copied — a
hand-copy would be testing my transcription rather than the gate:

```
gate_sh() { bash -c "set -o pipefail; $2"; }
source <(awk "/^gate_sh .forge-control. untouched by round 808/,/exit 0.$/" scripts/checks/gates-808.sh)
```

The mutation is the one the gate's own sentence forbids: modify a file under
`forge-control/`.

```
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control/src/lib/account-health.ts
check       : gate_sh() { bash -c "set -o pipefail; $2"; }; source <(awk "/^gate_sh .forge-control. untouched by round 808/,/exit 0.$/" scripts/checks/gates-808.sh)
mutations   : 1
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control/src/lib/account-health.ts
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  md5sum forge-control/src/lib/account-health.ts
  BEFORE : c8f975be07ebe19f6ca361654a71abc7
  backup : /tmp/prove-it-bites-backup.oQqRan  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ gate_sh() { bash -c "set -o pipefail; $2"; }; source <(awk "/^gate_sh .forge-control. untouched by round 808/,/exit 0.$/" scripts/checks/gates-808.sh)
  last 6 lines of unmutated output:
--------------------------------------------------------------------------
  | forge-control/src/routes/uploads.ts
  | forge-control/src/routes/usage.ts
  | forge-control/src/routes/vault.ts
  | forge-control/src/routes/webhooks.ts
  | forge-control/src/services/skills-curator.ts
  | (round 808 authored none of these; any listed file is a sibling task on the same branch)
--------------------------------------------------------------------------
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 1 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | printf "\n// MUTATION PROBE — a forge-control/ file that gate 7 claims is untouched\n" >> "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control/src/lib/account-health.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control/src/lib/account-health.ts b/forge-control/src/lib/account-health.ts
  | index 7eb38af..08bdb69 100644
  | --- a/forge-control/src/lib/account-health.ts
  | +++ b/forge-control/src/lib/account-health.ts
  | @@ -318,3 +318,5 @@ export function pickFailoverAccount(
  |    const ranked = rankAccounts(accounts).filter((a) => a.slug !== failedSlug);
  |    return ranked[0] ?? null;
  |  }
  | +
  | +// MUTATION PROBE — a forge-control/ file that gate 7 claims is untouched
--------------------------------------------------------------------------
  md5 while mutated: 89d17adf44db9992868bd7f96735835a

STEP 5.1 — check MUTATED
  $ gate_sh() { bash -c "set -o pipefail; $2"; }; source <(awk "/^gate_sh .forge-control. untouched by round 808/,/exit 0.$/" scripts/checks/gates-808.sh)
  last 6 lines of mutated/1 output:
--------------------------------------------------------------------------
  | forge-control/src/routes/uploads.ts
  | forge-control/src/routes/usage.ts
  | forge-control/src/routes/vault.ts
  | forge-control/src/routes/webhooks.ts
  | forge-control/src/services/skills-curator.ts
  | (round 808 authored none of these; any listed file is a sibling task on the same branch)
--------------------------------------------------------------------------
  exit code (mutated/1): 0

STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : c8f975be07ebe19f6ca361654a71abc7
  md5 AFTER    : c8f975be07ebe19f6ca361654a71abc7
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   0            did NOT discriminate   argv

VERDICT: INERT — the check stayed GREEN under mutation(s): 1
  The check does not observe what those mutations changed. That is the finding.
  Do NOT close it by weakening the mutation; either the check is a decoration or
  the mutation missed the property it protects — say which, with this transcript.
HARNESS EXIT=5
```

**INERT, exit 5.** Note what the unmutated run printed on its way to exit 0: the
gate listed the forge-control files that differ and asserted they do not exist
in the same breath. Round 0 measured 179 of them (PLAN.md §F3). Two separate
reasons it cannot fail — the `exit 0`, and a subject frozen to commits, which no
working-tree mutation can reach at all.

---

## (c) SELF-SABOTAGE CONTROL — the restore step, watched failing

Step 6 is the only part of this script whose failure would be silent and would
corrupt the tree of whoever ran it. So it gets broken on purpose. The sabotage is
one line: make `restore_subject` do nothing.

```
### (c.1) harness hash before sabotage
74e6fd223234d01593aae56f7598ccc0  scripts/checks/prove-it-bites.sh

### (c.2) sabotage the restore step so it silently does nothing
--- /tmp/pib.orig	2026-08-25 07:44:52.446024217 +0200
+++ scripts/checks/prove-it-bites.sh	2026-08-25 07:46:12.273768298 +0200
@@ -165,7 +165,7 @@
 
 restore_subject() {
   case "$RESTORE_MODE" in
-    git)  git checkout -- "$SUBJECT" ;;
+    git)  true ;;  # SABOTAGED: restore does nothing
     copy) cp -p "$BACKUP" "$SUBJECT" ;;
     *)    echo "  restore mode was never set — cannot restore" >&2; return 1 ;;
   esac

### (c.3) the positive control's invocation, run with the sabotaged restore
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control-web/app/desktop/chat/useAutogrow.ts
check       : cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
mutations   : 1
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control-web/app/desktop/chat/useAutogrow.ts
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  md5sum forge-control-web/app/desktop/chat/useAutogrow.ts
  BEFORE : 0ebc8ac297956d25e873f91d774ee7b2
  backup : /tmp/prove-it-bites-backup.Jp94ow  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of unmutated output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | OK — 9 clamp cases + ramp table clean
--------------------------------------------------------------------------
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 1 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | sed -i "s/measuredPx > maxPx/measuredPx >= maxPx/" "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control-web/app/desktop/chat/useAutogrow.ts b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | index 0d892f5..d0c8393 100644
  | --- a/forge-control-web/app/desktop/chat/useAutogrow.ts
  | +++ b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | @@ -69,7 +69,7 @@ export function clampAutogrow(
  |      throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  |    }
  |    const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  | -  return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
  | +  return { height, overflowY: measuredPx >= maxPx ? "auto" : "hidden" };
  |  }
  |  
  |  /** Font/box metrics of the textarea, read once and cached. */
--------------------------------------------------------------------------
  md5 while mutated: 9cdb32df9ba2b9b9838856f6f44d4e0c

STEP 5.1 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of mutated/1 output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | 1 FAILURE(S)
--------------------------------------------------------------------------
  exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 9cdb32df9ba2b9b9838856f6f44d4e0c
  RESTORE FAILED — the subject was NOT returned to its pre-mutation bytes.

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   1            DISCRIMINATED          argv

VERDICT: INCONCLUSIVE — restore FAILED after mutation 1; hashes printed at STEP 6.1.
  The measurement above cannot be trusted: the subject is not back to its
  pre-mutation bytes and every later run would start from mutated code.

TRAP (EXIT) — the run ended with forge-control-web/app/desktop/chat/useAutogrow.ts still mutated. Restoring.
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 9cdb32df9ba2b9b9838856f6f44d4e0c
  RESTORE FAILED — the subject was NOT returned to its pre-mutation bytes.

VERDICT: INCONCLUSIVE — restore failed during cleanup. Backup kept at /tmp/prove-it-bites-backup.Jp94ow
HARNESS EXIT=4

### (c.4) the sabotaged run left the subject mutated — this is what a broken restore looks like
 M forge-control-web/app/desktop/chat/useAutogrow.ts
9cdb32df9ba2b9b9838856f6f44d4e0c  forge-control-web/app/desktop/chat/useAutogrow.ts

### (c.5) repair the subject by hand
0ebc8ac297956d25e873f91d774ee7b2  forge-control-web/app/desktop/chat/useAutogrow.ts

### (c.6) repair the harness, prove the repair by hash against (c.1)
74e6fd223234d01593aae56f7598ccc0  scripts/checks/prove-it-bites.sh

### (c.7) the SAME invocation again, repaired harness
STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   1            DISCRIMINATED          argv

VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored (md5 0ebc8ac297956d25e873f91d774ee7b2).
HARNESS EXIT=0
```

The harness hash in (c.1)/(c.6) is the md5 of the file this doc ships with — so
a reader can `md5sum scripts/checks/prove-it-bites.sh` and confirm this
transcript was produced by the committed bytes rather than by some earlier draft.

Exit **4**, both hashes named, and the run reported INCONCLUSIVE rather than
reporting the (perfectly real) DISCRIMINATED result it had just measured — a
measurement taken with a broken restore cannot be trusted, because every later
run would start from mutated code. Note the EXIT trap then tried the restore a
second time and failed loudly again, rather than exiting quietly. After repair,
the same invocation prints BITES with matching hashes.

---

## (d) The per-mutation distinction, on a real gate — and a real coverage gap

Same subject and check as (a), but mutation 1 deletes the `minPx`/`maxPx` arms of
`clampAutogrow`'s finiteness guard, leaving only the `measuredPx` arm.

```
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control-web/app/desktop/chat/useAutogrow.ts
check       : cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
mutations   : 2
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control-web/app/desktop/chat/useAutogrow.ts
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  md5sum forge-control-web/app/desktop/chat/useAutogrow.ts
  BEFORE : 0ebc8ac297956d25e873f91d774ee7b2
  backup : /tmp/prove-it-bites-backup.C7ysiT  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of unmutated output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | OK — 9 clamp cases + ramp table clean
--------------------------------------------------------------------------
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 2 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | sed -i "s/ || !Number.isFinite(minPx) || !Number.isFinite(maxPx)//" "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control-web/app/desktop/chat/useAutogrow.ts b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | index 0d892f5..2d4313e 100644
  | --- a/forge-control-web/app/desktop/chat/useAutogrow.ts
  | +++ b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | @@ -60,7 +60,7 @@ export function clampAutogrow(
  |    minPx: number,
  |    maxPx: number,
  |  ): AutogrowSize {
  | -  if (!Number.isFinite(measuredPx) || !Number.isFinite(minPx) || !Number.isFinite(maxPx)) {
  | +  if (!Number.isFinite(measuredPx)) {
  |      throw new Error(
  |        `clampAutogrow: non-finite input (measuredPx=${measuredPx}, minPx=${minPx}, maxPx=${maxPx})`,
  |      );
--------------------------------------------------------------------------
  md5 while mutated: 71f2dfdb5da45635fbc20180929afde7

STEP 5.1 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of mutated/1 output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | OK — 9 clamp cases + ramp table clean
--------------------------------------------------------------------------
  exit code (mutated/1): 0

STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 4.2 — apply mutation 2 of 2 (source: argv)
  mutation:
--------------------------------------------------------------------------
  | sed -i "s/measuredPx > maxPx/measuredPx >= maxPx/" "$SUBJECT"
--------------------------------------------------------------------------
  $ git diff -- forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | diff --git a/forge-control-web/app/desktop/chat/useAutogrow.ts b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | index 0d892f5..d0c8393 100644
  | --- a/forge-control-web/app/desktop/chat/useAutogrow.ts
  | +++ b/forge-control-web/app/desktop/chat/useAutogrow.ts
  | @@ -69,7 +69,7 @@ export function clampAutogrow(
  |      throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  |    }
  |    const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  | -  return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
  | +  return { height, overflowY: measuredPx >= maxPx ? "auto" : "hidden" };
  |  }
  |  
  |  /** Font/box metrics of the textarea, read once and cached. */
--------------------------------------------------------------------------
  md5 while mutated: 9cdb32df9ba2b9b9838856f6f44d4e0c

STEP 5.2 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3
  last 3 lines of mutated/2 output:
--------------------------------------------------------------------------
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | 1 FAILURE(S)
--------------------------------------------------------------------------
  exit code (mutated/2): 1

STEP 6.2 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   0            did NOT discriminate   argv
  2   1            DISCRIMINATED          argv

VERDICT: INERT — the check stayed GREEN under mutation(s): 1
  The check does not observe what those mutations changed. That is the finding.
  Do NOT close it by weakening the mutation; either the check is a decoration or
  the mutation missed the property it protects — say which, with this transcript.
HARNESS EXIT=5
```

Mutation 2 discriminated; **mutation 1 did not**. That is a finding against gate
10, not against the mutation: `check-composer-v3.ts` tests `clampAutogrow(NaN,
MIN_PX, MAX_PX)` and never tests a non-finite *bound*, so two thirds of that
guard can be deleted with the gate still green. The remedy is a case in the
gate, not a softer mutation.

---

## (e) The EXIT trap, watched firing under a real kill

The brief asks for the trap to be tested by killing a run mid-flight. It was —
and the first attempt found a defect in this script, described under FINDINGS
below. This is the run against the fixed version: a check that sleeps 40s, a
SIGTERM delivered while the run is parked inside the mutated window.

```
### (e) trap test — SIGTERM to a run parked inside the MUTATED window
baseline: c8f975be07ebe19f6ca361654a71abc7  forge-control/src/lib/account-health.ts
[1]+  Done                    setsid bash scripts/checks/prove-it-bites.sh --subject "$SUBJ" --mutation 'printf "\n// MUTATION PROBE\n" >> "$SUBJECT"' --check 'sleep 40; ! grep -q "MUTATION PROBE" forge-control/src/lib/account-health.ts' --expect-fail --tail 3 > /tmp/pib-trap.txt 2>&1

$ ps -eo pid,etimes,args | grep -F 'checks/prove-it-bites.sh --subject'   (NOT pgrep -f: it matches this very shell)
1542247      50 bash scripts/checks/prove-it-bites.sh --subject forge-control/src/lib/account-health.ts --mutation printf "\n// MUTATION PROBE\n" >> "$SUBJECT" --check sleep 40; ! grep -q "MUTATION PROBE" forge-control/src/lib/account-health.ts --expect-fail --tail 3
1549735       0 grep -F checks/prove-it-bites.sh --subject

harness pid = 1542247 (verified above by full argv; killed by PID, never by pattern)
subject at the moment of the kill:
 M forge-control/src/lib/account-health.ts
$ kill -TERM 1542247
process after the signal:
  (gone)

--- tail of the interrupted run's transcript ---
--------------------------------------------------------------------------
  md5 while mutated: c5dec5738241a8d06435068ad221d86a

STEP 5.1 — check MUTATED
  $ sleep 40; ! grep -q "MUTATION PROBE" forge-control/src/lib/account-health.ts

TRAP (EXIT) — killing the still-running check (pid 1548312)

TRAP (EXIT) — the run ended with forge-control/src/lib/account-health.ts still mutated. Restoring.
  restore mode : git
  md5 BEFORE   : c8f975be07ebe19f6ca361654a71abc7
  md5 AFTER    : c8f975be07ebe19f6ca361654a71abc7
  restore verified by hash

--- subject state after the kill ---
(nothing printed above = restored)
c8f975be07ebe19f6ca361654a71abc7  forge-control/src/lib/account-health.ts
```

The orphaned check is killed FIRST, then the subject is restored and the restore
hash-verified — that order matters, because a restore landing underneath a check
still reading the mutated file is a race with no upside. The PID was read from `ps` and verified by full argv before
signalling: `pgrep -f prove-it-bites` matches the shell running the test itself,
and killing that is exactly what happened on the first attempt (memory note
`pkill-pattern-matches-own-shell`).

**SIGKILL cannot be trapped.** After a `kill -9` the subject stays mutated; the
backup path printed at STEP 2 is the manual restore, which is why that path is
printed on every run rather than only on failure.

---

## (f) The two refusals

```
### REFUSAL 1 — dirty subject, exit 2
 M forge-control/src/lib/account-health.ts
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control/src/lib/account-health.ts
check       : true
mutations   : 1
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control/src/lib/account-health.ts
  [ M forge-control/src/lib/account-health.ts]
  tracked by git: 1

HARD ERROR — subject is dirty: forge-control/src/lib/account-health.ts
  Commit, revert or stash it first. A restore proven against already-modified
  bytes proves nothing about the mutation this run applies.
HARNESS EXIT=2
(restored by hand: c8f975be07ebe19f6ca361654a71abc7)

### REFUSAL 2 — the check is ALREADY RED, exit 3
==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control-web/app/desktop/chat/useAutogrow.ts
check       : node scripts/checks/no-raw-colours.cjs
mutations   : 1
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control-web/app/desktop/chat/useAutogrow.ts
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  md5sum forge-control-web/app/desktop/chat/useAutogrow.ts
  BEFORE : 0ebc8ac297956d25e873f91d774ee7b2
  backup : /tmp/prove-it-bites-backup.zc0vIL  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ node scripts/checks/no-raw-colours.cjs
  last 4 lines of unmutated output:
--------------------------------------------------------------------------
  | 
  | Use a token from forge-control-web/app/tokens.ts. If the value genuinely cannot go
  | through the cascade (WebGL, <canvas> 2D, image export, a palette definition),
  | add a FILE<TAB>ERE<TAB>REASON line to scripts/checks/raw-colour-allowlist.txt.
--------------------------------------------------------------------------
  exit code (unmutated): 1

HARD ERROR — the check was ALREADY FAILING before any mutation (exit 1).
  You cannot demonstrate that a red check bites: every mutated run would also be
  red, and the run would read as proof of an assertion that was never exercised.
  Fix or attribute the pre-existing RED first, then re-run this control.
HARNESS EXIT=3
```

Refusal 2 is not hypothetical. Gate 5 (`no-raw-colours.cjs`) is RED at this tip,
inherited from `b41e824`'s week-board palette (memory note
`gate5-raw-colours-red-at-main-from-week-board`) — so a worker adding a colour
assertion today would get a red mutated run and could report it as proof of an
assertion that was never exercised. The harness refuses instead.

---

## (g) `--mutation-file` and `--subject-copy`

A python, marker-anchored deletion of a whole guard block — the shape the
`unreachable-guard-needs-its-own-control` note calls for, cutting on a marker and
never on line numbers — with the restore forced through the byte-exact `/tmp`
copy rather than `git checkout --`.

```
$ cat /tmp/mutate-delete-inverted-guard.py
#!/usr/bin/env python3
# Marker-anchored deletion of a whole guard block — NOT a line range.
# (memory note unreachable-guard-needs-its-own-control: cut on a marker, never
#  on line numbers, or the mutation silently cuts the wrong thing after a reflow.)
import os, sys
path = os.environ["SUBJECT"]
src = open(path).read()
block = """  if (maxPx < minPx) {
    throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  }
"""
if block not in src:
    sys.exit("mutation anchor not found — refusing to cut blind")
open(path, "w").write(src.replace(block, "", 1))
print("deleted the inverted-bounds guard block (%d bytes)" % len(block))

==========================================================================
prove-it-bites — mutation control
==========================================================================
repo        : /opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--mutation
subject     : forge-control-web/app/desktop/chat/useAutogrow.ts
check       : cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -4
mutations   : 1
expectation : --expect-fail (mutated run MUST exit non-zero)
timeout     : 600s per check run

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- forge-control-web/app/desktop/chat/useAutogrow.ts
  []
  tracked by git: 1
  restore mode  : copy

STEP 2 — baseline hash
  md5sum forge-control-web/app/desktop/chat/useAutogrow.ts
  BEFORE : 0ebc8ac297956d25e873f91d774ee7b2
  backup : /tmp/prove-it-bites-backup.5Yo3df  (the manual restore if this run is SIGKILLed)

STEP 3 — check UNMUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -4
  last 4 lines of unmutated output:
--------------------------------------------------------------------------
  | PASS  effortRamp('') falls to the calm rung
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | OK — 9 clamp cases + ramp table clean
--------------------------------------------------------------------------
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 1 (source: file:/tmp/mutate-delete-inverted-guard.py)
  mutation:
--------------------------------------------------------------------------
  | #!/usr/bin/env python3
  | # Marker-anchored deletion of a whole guard block — NOT a line range.
  | # (memory note unreachable-guard-needs-its-own-control: cut on a marker, never
  | #  on line numbers, or the mutation silently cuts the wrong thing after a reflow.)
  | import os, sys
  | path = os.environ["SUBJECT"]
  | src = open(path).read()
  | block = """  if (maxPx < minPx) {
  |     throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  |   }
  | """
  | if block not in src:
  |     sys.exit("mutation anchor not found — refusing to cut blind")
  | open(path, "w").write(src.replace(block, "", 1))
  | print("deleted the inverted-bounds guard block (%d bytes)" % len(block))
--------------------------------------------------------------------------
deleted the inverted-bounds guard block (109 bytes)
  $ diff -u /tmp/prove-it-bites-backup.5Yo3df forge-control-web/app/desktop/chat/useAutogrow.ts
--------------------------------------------------------------------------
  | --- /tmp/prove-it-bites-backup.5Yo3df	2026-08-25 07:46:10.233749335 +0200
  | +++ forge-control-web/app/desktop/chat/useAutogrow.ts	2026-08-25 07:46:11.455760695 +0200
  | @@ -65,9 +65,6 @@
  |        `clampAutogrow: non-finite input (measuredPx=${measuredPx}, minPx=${minPx}, maxPx=${maxPx})`,
  |      );
  |    }
  | -  if (maxPx < minPx) {
  | -    throw new Error(`clampAutogrow: maxPx (${maxPx}) is below minPx (${minPx})`);
  | -  }
  |    const height = Math.min(Math.max(measuredPx, minPx), maxPx);
  |    return { height, overflowY: measuredPx > maxPx ? "auto" : "hidden" };
  |  }
--------------------------------------------------------------------------
  md5 while mutated: 91401624193399fd3699b7a5f2c24142

STEP 5.1 — check MUTATED
  $ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -4
  last 4 lines of mutated/1 output:
--------------------------------------------------------------------------
  | PASS  effortRamp('') falls to the calm rung
  | PASS  an unknown level still falls to the calm rung rather than throwing
  | 
  | 1 FAILURE(S)
--------------------------------------------------------------------------
  exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  restore mode : copy
  md5 BEFORE   : 0ebc8ac297956d25e873f91d774ee7b2
  md5 AFTER    : 0ebc8ac297956d25e873f91d774ee7b2
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   1            DISCRIMINATED          file:/tmp/mutate-delete-inverted-guard.py

VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored (md5 0ebc8ac297956d25e873f91d774ee7b2).
HARNESS EXIT=0
```

`--subject-copy` is REQUIRED for an untracked or ignored subject, where
`git checkout --` cannot restore anything; it is also the safe mode when the
mutation deletes a first layer, or the file itself. In copy mode the diff is
printed as `diff -u <backup> <subject>` and labelled as such.

---

## FINDINGS

1. **This harness's own first version lost a subject to SIGHUP.** Measured: a
   detached run took an untrapped SIGHUP mid-check, bash died WITHOUT running the
   EXIT trap (it runs an EXIT trap when it exits because of a *trapped* signal and
   skips it entirely otherwise), and `forge-control/src/lib/account-health.ts` was
   left mutated with the transcript stopped at STEP 5.1. Fixed two ways: `trap
   'exit 129' HUP`, and the check is now backgrounded and `wait`ed rather than run
   in the foreground, because bash defers a trapped signal until the current
   foreground command returns — a TERM during a 20-minute check would otherwise
   not restore anything until that check finished.
2. **`--mutation-file` ran a python file through bash.** `import os, sys` was
   executed as a shell command and answered by ImageMagick's `import`, which then
   failed against a missing X server. A mutation that misfires is not a control,
   and it failed in the direction that leaves the subject half-edited. Fixed: a
   `#!` line is honoured and the file is run by that interpreter.
3. **Gate 10 (`check-composer-v3.ts`) does not observe two thirds of
   `clampAutogrow`'s finiteness guard** — control (d), exit 5. Real gap, cheap fix,
   belongs to whoever owns that gate.
4. **Gate 7 cannot fail** — control (b), and it is worse than the `exit 0` alone
   suggests: its subject is a commit range, so no working-tree mutation can reach
   it either. Reported, not fixed: PLAN.md §F3 reserves that repair, and this
   project's brief forbids editing `gates-808.sh` from this lane.
5. **Gate 5 is RED at this tip**, inherited from `b41e824`. Not caused by this
   work, and not softened by it.

## WHAT THIS DOES NOT PROVE

A `BITES` verdict says the check observes *the mutation that was named* — nothing
more. It cannot tell you the mutation was the interesting one, and a mutation
chosen to be easy is the mutation-testing version of a fixture chosen to compile
(memory note `assertion-inert-shared-substring`). Mutate the claim the check's
own header makes, as (a) does; if you cannot construct a mutation that breaks
the property, that is itself the finding.

It also proves nothing about a check nothing runs. `prove-it-bites.sh` shows a
check CAN fail; the execution registry (PLAN.md §F1: 41 of 74 artefacts invoked
by nothing) is the separate question of whether anything ever asks it.
