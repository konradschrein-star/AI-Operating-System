# phase5/fix-cycle-1.md — the four findings of the phase-5 gate, closed

Round 4 of phase 5, workstream `business`. Answers `phase5/GATE-review.md`'s
**NEEDS_FIXES** verdict, item by item, at the tip it reviewed
(`f4fa30c` + the review commit `570cde6`).

The gate's deeper finding is the one worth reading first, because it explains
all four: **no phase-5 builder ran the suite after the product code landed.**
The blocker was introduced in round 2, survived rounds 3 and 4's planning, and
was found red by the reviewer. This round therefore records the suite run as
evidence rather than as a claim, and does it *after* the last edit, not before.

---

## Summary

| # | Finding | File | Status |
|---|---|---|---|
| 1 | gate 8 `dollar-sweep.sh` red at HEAD (**blocker**) | `scripts/checks/dollar-allowlist.txt` | fixed, `RED: 0`, anchoring proven by a control mutation |
| 2 | `restarts` falls back to `0` under a "NEVER 0" comment | `forge-control/src/lib/pipeline-health.ts:317` | `number \| null`, 3 new unit tests + a browser shot |
| 3 | comment says `pm2 list`, code runs `pm2 jlist` | `forge-control/src/db/pipeline.ts:378` | comment now names the verb the code runs |
| 4 | two elided command blocks carry numbers with no runnable command (N10) | `phase5/premises-remeasured.md` | four placeholders filled + a fifth missing prompt line |

---

## F1 — the blocker: gate 8

`git blame` puts both offenders in `c94b10d` (round 2), and **neither line was
changed**: both are spec-faithful business facts R63 requires on screen.

| Line | Content | Fires on | Why it stays |
|---|---|---|---|
| `businesses-inventory.ts:467` | `…and who signs off on spend.` | `\bspen[dt]` | The `qualified` stage's criterion (spec §3.2 L263). "Spend" is the **prospect's** budget authority — who at the target company approves a purchase — not a figure this OS renders. |
| `businesses-inventory.ts:592` | `Pricing is locked in code at $197 / $497 / $2,497 one-time…` | `\$[0-9]` | The Axtrelis arm's state (spec §2.2 L211). **Konrad's own product's price list**, quoted from his spec. U11 forbids rendering what the fleet costs him; it does not forbid quoting what his product charges. |

Rewording a business fact so a grep stays quiet would put a fiction in front of
Konrad. Two allowlist rows were added instead, each anchored to its own
sentence — `signs off on spend` and `\$197 / \$497 / \$2,497`, never a bare
`\$[0-9]` and never the file alone. Prose table updated in
`docs/plan/artifacts/phase400/dollar-allowlist.md` (which also now records that
the `.txt` has run ahead of it since round 402 — eight entries from rounds
1351–1876 are documented only as comments inside the `.txt`).

```
### CMD-F1a — the gate, before and after
$ bash scripts/checks/dollar-sweep.sh ; echo "EXIT=$?"       # before
FAIL    forge-control-web/app/desktop/businesses-inventory.ts:467
FAIL    forge-control-web/app/desktop/businesses-inventory.ts:592
EXIT=1
$ bash scripts/checks/dollar-sweep.sh ; echo "EXIT=$?"       # after
dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.
EXIT=0                                            # 131 hits, all allowlisted
```

**Anchored, and proven so by breaking it.** A listed file must still be a swept
file, so the claim was measured rather than asserted — one new, *different*
dollar was appended to the now-listed file and the gate still failed:

```
### CMD-F1b — the control mutation
$ printf '\n// CONTROL MUTATION (round 4, reverted immediately): const price = "$99 / month";\n' \
    >> forge-control-web/app/desktop/businesses-inventory.ts
$ bash scripts/checks/dollar-sweep.sh ; echo "EXIT=$?"
FAIL    forge-control-web/app/desktop/businesses-inventory.ts:612
        // CONTROL MUTATION (round 4, reverted immediately): const price = "$99 / month";
        → no allowlist entry covers this hit
EXIT=1
$ # restored from a pre-mutation copy — sha256 identical before and after:
$ sha256sum forge-control-web/app/desktop/businesses-inventory.ts
01177934c9dc93ac39b95767121d76f42aa258fbdb48d6143a095c5c3c6cae45
$ bash scripts/checks/dollar-sweep.sh >/dev/null ; echo "EXIT=$?"
EXIT=0
$ git status --porcelain forge-control-web/app/desktop/businesses-inventory.ts
(no output — the file is untouched by this round)
```

---

## F2 — `restarts` could claim a zero pm2 never gave it

`pipeline-health.ts:317` read `… ? restarts : 0`, two lines below a `uptime_ms`
that goes `null` for the same missing data, under a comment reading *"NEVER 0:
a zero uptime reads as 'just restarted', which is the opposite of 'not
running'."* The same argument applies one field down and had not been applied:
`0 restarts` is a **claim** about a worker's whole life, and the surface
rendered it for a number pm2 never reported.

Changed to `number | null` in the parser (`pipeline-health.ts`), on the wire
type (`api-business.ts`), and in the renderer (`PipelineSurface.tsx`, new
`formatRestarts()` mirroring the existing `formatUptime()`). The gate's own
prescribed wording — *"restarts not reported", exactly as uptime already does*
— was checked against the neighbouring string before being copied: `formatUptime`
returns `"no start time reported"`, so the two now read as one family.

**Three unit tests**, and the last one is the point — it stops the fix from
eating the honest zero:

```
### CMD-F2a
$ cd forge-control && pnpm test
# tests 1350
# pass  1350
# fail  0
```

- `a missing restart_time reports null, NEVER 0` — deletes the key from the
  fixture rather than overriding it, because `proc()`'s default supplies `0`,
  which is the value under test. Also asserts the worker is otherwise healthy:
  missing **data** and a missing **worker** must not collapse into one rendering.
- `a non-numeric restart_time reports null, not a coerced 0`.
- `a real 0 from pm2 is still 0 — null and 0 are different answers`.

**And a browser proof, because the unit tests cannot see the screen.** A
`number | null` reaching a template literal renders the four characters `null`,
which is worse than the `0` it replaced — so the rendering is the half that has
to be photographed. `restarts-null-shot.mjs` + `restarts-null-stub.json` serve a
fixture carrying **all three answers in one column**, so one screenshot
separates them and no assertion is inert:

```
### CMD-F2b
$ PIPELINE_STUB_FILE=…/restarts-null-stub.json SERVE_PIPELINE_PORT=7842 tsx …/serve-pipeline.ts
$ cd forge-control-web && FORGE_CONTROL_URL=http://127.0.0.1:7842 NODE_ENV=production next build
  BUILD_ID=iXPchAFMx6sfYHK2O50zG
  routes-manifest proxy targets: ['http://127.0.0.1:7842']
$ AUTH_URL=http://127.0.0.1:7840 AUTH_TRUST_HOST=true next start -p 7840
$ node docs/plan/artifacts/os-usable-for-work/phase5/restarts-null-shot.mjs
PASS  stub serves the three-answer fixture — [["worker-orchestrator",0],["worker-render",null],["worker-video-stitch",3],["claude-pool",null]]
PASS  the null worker says so in words
PASS  the honest zero survives
PASS  the warn path still fires
PASS  no raw `null restarts` reached the DOM
PASS  it appears exactly twice — once per null worker, not once per row — n=2
SHOT: /opt/ai-os/uploads/1de93fee81a3/20260818T221531Z-pipeline-restarts-not-reported.png
6/6 PASS
```

Committed to this directory as **`fix1-restarts-not-reported.png`** (§4.6 — a
browser claim carries a screenshot in the artefact directory, not only in the
run's upload folder). What the WORKERS panel reads in it, top to bottom:

```
worker-orchestrator  online    up 7d 16h                 0 restarts
worker-render        online    up 7d 16h                 restarts not reported
worker-video-stitch  online    up 7d 16h                 3 restarts      (warn tone)
claude-pool          stopped   up no start time reported restarts not reported
```

A fixture with only the null case would have passed against a component that
printed "restarts not reported" for every row; the `0` and the `3` are
load-bearing, and the `n === 2` count is what proves it is per-worker.

---

## F3 — the comment an auditor greps

`db/pipeline.ts:378` claimed *"`pm2 list` is the ONLY pm2 verb used"* directly
above `await run("pm2 jlist", 5000)`. Under R68 ("no restart, ever") that
comment is exactly what an auditor greps for, and it named a verb the code does
not run. Rewritten to name `pm2 jlist`, say it is the JSON form of `pm2 list`,
say why (`parsePm2Jlist` needs a machine-readable answer, not a table to
scrape), and keep the R68 statement. `grep -rn "pm2 list"` over
`forge-control/src`, `forge-control-web/app` and `phase5/` now returns that one
line and no other stale claim.

---

## F4 — five numbers with no runnable command

`premises-remeasured.md` opens by claiming *"Every number here carries the
command that produced it (N10)"* and then elided four `psql` invocations to
placeholders, with a fifth result set carrying no `$` prompt at all:

| Line | Was | Now |
|---|---|---|
| CMD-B | `"<the surface WHERE clause, no LIMIT>"` | the two-`-c` form: `WHERE status <> 'MARKED_FOR_DELETION'` grouped, then `count(*) AS rows_matching_where` |
| CMD-B | `"<ages>"` | `left(id::text,8)`, status, `status_updated_at`, `now() - status_updated_at AS age`, `ORDER BY status_updated_at` |
| CMD-C | `"<R70 30-day figure, verbatim from the brief>"` | the `FILTER (WHERE provider <> 'claude-code')` / `= 'claude-code'` / `COUNT(*)` triple over `spend_log`, 30 days |
| CMD-C | `"<spend_log all-time by provider>"` | `GROUP BY provider` with count, `sum(amount_eur)`, `min/max(created_at)` |
| CMD-C | *(no prompt line at all)* | the `ledger_entries` `GROUP BY direction` command that produced the `out \| 172 \| 176.07` row |

`money-keep-cost.md`'s CMD-M1/CMD-M2 are the model, as the gate asked, and the
same filters over the same tables an hour later are literally those commands —
their output has the same shape and larger `claude-code` figures, which is § P3a's
finding, not a discrepancy.

**The outputs were not re-measured and are unchanged.** They are round 0's, at
the timestamps already stated. `spend_log` grows continuously and this project's
own runs write to it (§ P3a), so re-running today returns bigger numbers, not a
correction — silently refreshing them would have destroyed the drift finding the
document exists to record. A `> Round 4 amendment` note at the head of the file
says exactly this, and names the one placeholder deliberately left standing:
CMD-A's `<bucket dump>`, a `node -e` **formatter** for the preceding `curl`,
which is itself the runnable command and the actual source of those numbers.

---

## Verification — the whole mandated block, run after the last edit

```
### CMD-V
$ cd forge-control      && pnpm install --frozen-lockfile --prod=false   # Already up to date
$ npx tsc --version && npx tsc --noEmit                                  # 5.9.3, EXIT=0
$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false # Already up to date
$ npx tsc --version && npx tsc --noEmit                                  # 5.7.2, EXIT=0
$ cd ../forge-control && pnpm test                                       # 1350/1350, 0 fail
$ bash scripts/checks/gates-808.sh --strict                              # RED: 0
```

Neither install printed a `± typescript` line — `Already up to date`, no package
delta — and `npx tsc --version` was run in both packages before the typechecks,
so the `--prod=false` pruning trap (a bare `--frozen-lockfile` under
`NODE_ENV=production` removes `typescript`, exits 0, and says "Already up to
date") is excluded by measurement rather than by assumption.

The gate suite was run **serially, on a tree with no experiment in it** — the F1
control mutation had already been reverted and sha256-verified, so gate 20's
`pnpm test` and gate 3's production build saw only committed work. `RED: 0`,
`EXECUTED 23`, `SKIPPED 2` (gates 23 and 24, the `--browser` harness, skipped by
design without that flag). Gate 8 is now `0`; gate 17 is green 92/92.

## Files this round touched

| File | Why |
|---|---|
| `scripts/checks/dollar-allowlist.txt` | **F1**, the blocker |
| `docs/plan/artifacts/phase400/dollar-allowlist.md` | **F1**, the prose form the gate asked be updated |
| `forge-control/src/lib/pipeline-health.ts` | **F2** |
| `forge-control/src/lib/pipeline-health.test.ts` | **F2**, three new tests |
| `forge-control-web/app/api-business.ts` | **F2**, the wire type — `number \| null` is not optional here, the renderer consumes it |
| `forge-control-web/app/desktop/PipelineSurface.tsx` | **F2**, `formatRestarts()` and the tone guard |
| `forge-control/src/db/pipeline.ts` | **F3** |
| `docs/plan/artifacts/os-usable-for-work/phase5/premises-remeasured.md` | **F4** |
| `docs/plan/artifacts/os-usable-for-work/phase5/restarts-null-shot.mjs` | **F2**, the browser proof (new) |
| `docs/plan/artifacts/os-usable-for-work/phase5/restarts-null-stub.json` | **F2**, its fixture (new) |
| `docs/plan/artifacts/os-usable-for-work/phase5/fix1-restarts-not-reported.png` | **F2**, the shot itself (new) |
| `docs/plan/artifacts/os-usable-for-work/phase5/fix-cycle-1.md` | this file (new) |

**Nothing in `/opt/forge-ai-os` was written.** `AUTH_SECRET` was *read* from
`/opt/forge-ai-os/forge-control-web/.env.local` to mint a cookie for 127.0.0.1,
which N4 permits and which is what every phase-5 measurement has done. No
`pm2 restart`. No write to any database — the browser proof runs entirely
against a stub file (`x-phase5-harness: stub`, asserted by the script before it
opens a browser, so a stale live server on that port fails loudly rather than
being photographed).
