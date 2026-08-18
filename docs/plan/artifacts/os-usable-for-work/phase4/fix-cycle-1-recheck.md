# Phase 4 — FIX CYCLE 1, ROUND-5 PASS (re-check of the round-4 fix)

**Workstream** `connections` · branch `project/7851068b-connections`
**Task row** `afbdeafc-3cfd-44d2-a003-dc56ef9f2306` (round 5, `Fix cycle 1 · connections`)
**Tip inherited** `6a1fa33`. **Round-4 fix commits already present**: `04c79b1`, `dc7bd5a`,
`e0a721f`, `6a1fa33`.

This round was seeded with the *same* R4-gate feedback the round-4 fix cycle had already worked
(`d692f37a`, status `done`). HEAD was therefore past the reviewed tip before this pass began. The
standing rule for that situation is **verify the work, do not rebuild it** — so this document is an
adjudication of what was already committed, plus the two things that were still open.

**Headline: one of the three blockers was still open at `6a1fa33`, and it was open in the exact way
the reviewer predicted.**

---

## 1. WRITE-SET — DECLARED vs ACTUAL, LOUDLY

**Declared write-set for this task:**

| # | Path |
|---|---|
| 1 | `docs/plan/artifacts/os-usable-for-work/phase4/gate-report.md` |
| 2 | `docs/plan/artifacts/os-usable-for-work/phase4/gates-phase4.txt` |

Those are the **R4-gate reviewer's** two output files (`9a1ac46f`, round 4) — this row inherited its
parent's declaration, which is what a fix-cycle row does. The declaration is not merely wrong, it is
**actively hostile**: satisfying it literally would mean writing over the gate report that contains
the blockers being fixed, and over the gate transcript that is the evidence for them. Both are
append-only history. **Neither was modified, and that is deliberate.**

Every file below is therefore an undeclared write **by construction**. Enumerated rather than buried:

| File | Why it had to change |
|---|---|
| `phase4/fix-cycle-1-report.md` | **Blocker 2, still open.** Its §6 pasted the canary proof verbatim, which put three credential-shaped strings back into the corpus and left `check-secret-scan.ts` exiting 1. Reworded to a re-runnable recipe. Its "ALL PASS — 914 tracked files" line was also corrected: true when written, false one commit later. |
| `phase4/fix-cycle-1-recheck.md` | This file. |
| `phase4/gates-round5.txt` | The `gates-808.sh --strict` transcript at this pass's tip, verbatim. |
| `phase4/r5-panel-agy-github-mounted.png`, `phase4/r5-panel-unknown-amber.png` | Fresh browser proof of blocker 1 **at the true tip** — see §3 for why the committed round-4 shots did not cover it. Copied out of `/opt/ai-os/uploads` (N7). |
| `docs/plan/os-usable-for-work/04-phases.md` | §10, the finding in §4 below: what `write_set` actually is, and why the round-4 pass's refusal to amend the rows is upheld rather than overturned. |

`git diff --name-only 6a1fa33..HEAD | sort` prints exactly these paths and nothing else.

Nothing outside this worktree was written. `/opt/forge-ai-os` was read once (its `.env.local`, for
`AUTH_SECRET`, to mint a throwaway cookie) and never edited. `pm2 restart` was never run.

---

## 2. BLOCKER 2 — STILL OPEN AT `6a1fa33`, AND CLOSED HERE

The reviewer's blocker 2 ended with a one-line instruction: **"Do not fix it by quoting it again."**

The round-4 pass fixed the checker correctly (an anchored `^\*+$` in `SAFE_MARKERS`, scoped to the
token, never to a file) — and then wrote a report whose §6 quoted its own canary output verbatim:

```
$ tsx scripts/checks/check-secret-scan.ts        # at 6a1fa33, before this pass
FAIL  docs/plan/artifacts/os-usable-for-work/phase4/fix-cycle-1-report.md
        DSN password: <a live-looking 14-char password>
        DSN password: <abc, three asterisks, def>
        PGPASSWORD=<a bare unmarked word>
1 FILE(S) FAILED — live-looking DB credential committed
EXIT=1
```

The round-4 report's claim of `ALL PASS — 914 tracked files` was **not dishonest, it was stale**: the
scan ran before the report became a tracked file, so the measurement could not see the paste that
falsified it. This is the self-referential shape this fleet has been bitten by before — a checker
that names its own forbidden strings.

**Fixed by rewording, per the reviewer's first option**, and *not* by adding markers: whitelisting
`S3cr3tLiveP4ss` would blunt the exact demonstration the paragraph exists to make. Two further
rounds of the same trap had to be walked out on the way:

1. the replacement recipe's `printf` **format string** was itself DSN-shaped — scheme, colon,
   placeholder, `@` — so the captured password was the bare placeholder token, which carries no
   safe marker → still red. The scheme is now a shell variable (`$S`), so no DSN shape survives in
   the format string.
2. the format string still spelled the shell variable's name immediately followed by `=` and a
   placeholder → still red for the same reason. That name is now passed as a printf *argument*
   instead of being written into the format.

**And this document walked into it a third time**, describing rounds 1 and 2 by quoting the two
format strings — which is why the two paragraphs above name the shapes in words and quote neither.
The lesson generalises past this file: a checker that scans the whole corpus will scan the prose
written *about* it, so a defect report on a pattern-matcher must describe its patterns, never
reproduce them.

Measured at the working tree after the fix:

```
ALL PASS — 916 tracked files carry no unlabelled DB credential
EXIT=0
```

**The loosening was re-verified, not re-asserted.** The canary was rebuilt in a throwaway
`git clone --shared` at `6a1fa33` with the literals assembled in the shell, and all three shapes are
still caught — the real-looking password, the `abc***def` that proves the anchor works, and the bare
`PGPASSWORD`. The recipe is now committed in the report so the next reader re-runs it instead of
trusting a paste. The recipe printed in that document was **extracted from the document and executed
verbatim** by this pass; it reproduces.

---

## 3. BLOCKER 1 — CLOSED, AND RE-PROVED AT THE TIP

`AgyCard` and `GitHubCard` are mounted:

```
forge-control-web/app/desktop/settings/ConnectionsPanel.tsx:273:  <AgyCard onFacts={setAgy} />
forge-control-web/app/desktop/settings/ConnectionsPanel.tsx:286:  <GitHubCard onFacts={setGithub} />
```

**Why the committed round-4 browser proof was not sufficient.** The screenshots
`r4fix-panel-*.png` were committed in `04c79b1`. `dc7bd5a` then edited `ConnectionsPanel.tsx`
again — it hoisted the summary and re-gated the R58 verbatim-error box on the *rendered* state. The
mounts survive that change untouched, but a screenshot taken one commit before the last edit to the
file it depicts is not evidence about the tip. Re-taken here.

**The instrument kills the defect** (`check-settings-surface.tsx` §3). Mutation applied in the
worktree, run, restored by hash:

```
MUTATION: both card mounts deleted from ConnectionsPanel.tsx
  FAIL the agy card body is mounted under its row
  FAIL the GitHub card body is mounted under its row
2 FAILURE(S)
sha256 before 379a12c3…67511f · after restore 379a12c3…67511f · RESTORED-IDENTICAL
```

Note the row-id assertions alone do **not** discriminate — the five `data-connection-row` ids render
from summaries whether or not a card is mounted. The two `data-agy-card` / `data-github-card`
assertions are the ones carrying the weight, which is why the check asserts bodies and not just rows.

**Browser proof at the tip**, against the real `/settings` surface behind the real auth wall. The
stack was rebuilt from the recipe committed at `browser-harness-phase4.cjs:36-91`
(`/tmp/b4c-serve.ts` survived; the scratch DB, the fixture dirs and the cookie did not):

```
anonymous            307 → http://127.0.0.1:7743/signin
with minted cookie   200
routes-manifest.json  http://127.0.0.1:7742      (and nothing else — the rebuild is bound to the
                                                  throwaway API, not to live :7700)
BUILD_ID             XSOc4WJ13tAnPbzeZogmP

--- surface /settings ---
rows:  claude:arved, claude:claude-worker-legacy, google, gemini-key, gemini-ultra, agy, github
cards: google, agy, github

b4c-after:   12/12 assertions passed   PASS
b4c-unknown: 10/10 assertions passed   PASS
```

The pre-existing build in the worktree proxied to **live :7700** — the trap the harness header warns
about in capitals. It was rebuilt with `FORGE_CONTROL_URL=http://127.0.0.1:7742` and the manifest
re-checked before a single assertion was believed.

Screenshots: `r5-panel-agy-github-mounted.png` — both rows present, and the Ultra row and the `agy`
row now carry the *same* probe age and the *same* binary path (`probed 1 min ago`,
`/root/.local/bin/agy models exited 0 and listed 7 models`), so the two rows about one binary can no
longer contradict each other. `r5-panel-unknown-amber.png` — with every sidecar cleared, all three
outside-service rows go amber, chip colour compared against the resolved `--fg-warn` token by
computed style (`rgb(216, 194, 74)`), and the Ultra row's action reads *"Press Probe to run the CLI
and see what it says"*.

That last string is the gate's **"not charged against phase 4, but you should know"** note — the row
that told Konrad to install software already installed. It is gone from the surface, in a browser,
at this tip.

---

## 4. BLOCKER 3 — DOCUMENT DISCLOSURE DONE; THE ROW AMENDMENT IS *REFUSED*, WITH A REASON

The reviewer asked for two things. The second is done: `04-phases.md` §10 carries a table naming
commit, file, declaring owner and what actually happened, for all three undeclared writes, plus the
`agy-flow.md` → `agy-flow-affordance.md` naming drift.

The first — *"amend the task rows to match what was written"* — **has not been done, and this pass
recommends against it.** Three measured reasons:

1. **There is no API for it.** `forge-control/src/routes/projects.ts` exposes `POST /:id/tasks`,
   `POST /:id/unwedge`, `POST /:id/status` and the two GETs. There is no PATCH/PUT for a task row.
   The only path is a raw `UPDATE` against `project_tasks` — hand-editing a ledger, which is the
   move that produced the waiver-list double-decrement this fleet already paid for once.
2. **`write_set` is not an audit field, it is the scheduler's file-contention lock.**
   `task-graph.ts:749` refuses to promote a candidate whose `write_set` intersects that of a
   **running** task. All three rows are `done`. Amending them is therefore **scheduling-inert** — it
   buys nothing operationally and changes only the record.
3. **The record is the whole point.** `04-phases.md:257` already states it: *"Recorded here rather
   than amended away, because the point of a write-set is that a violation is visible afterwards."*
   Amending the rows would leave the phase doc saying a collision occurred and the ledger saying
   every write was declared — the two artefacts disagreeing, with the machine-readable one wrong.

This is a policy call about how audit ledgers are corrected, and everything downstream inherits it,
so it was **escalated to Konrad rather than decided unilaterally** (manager chat, run
`bfd1283a`). The default, taken here and reversible in one `UPDATE` if he rules the other way: keep
the rows as they were written and keep the disclosure in the phase record.

---

## 5. FOLD-INS (N8) — ALL THREE PRESENT

| Fold-in | Where | Verified |
|---|---|---|
| the `connected` + `identity:null` fixture hole | `check-connection-states.ts` §5b | `ALL PASS — 4 integrations × {null, fresh-ok, fresh-fail, stale, connected-with-no-identity}`; the fixture is named in the suite's own summary line |
| `agy` exit 0 with no output classified as SIGNED IN | `connection-status.ts:604-618` | now a recorded failure carrying what was seen; four tests including both boundary directions, plus one asserting the contradictory `"(exit 0 but no output)"` placeholder is unreachable |
| `04-phases.md` deliverable named `agy-flow.md`, shipped as `agy-flow-affordance.md` | `04-phases.md:266` | recorded under **Deliverable naming** |

---

## 6. WHAT WAS RUN, THIS PASS

| Instrument | Result |
|---|---|
| `tsc --noEmit` — forge-control | clean |
| `tsc --noEmit` — forge-control-web | clean |
| `pnpm test` — forge-control unit suite | **1365 pass, 0 fail** (249 suites) |
| `check-secret-scan.ts` | **ALL PASS — 916 tracked files** (was `EXIT=1`, 1 file, at `6a1fa33`) |
| `check-connection-states.ts` | ALL PASS |
| `check-quota-row.ts` | ALL PASS |
| `check-settings-surface.tsx` | PASS |
| `check-integrations.tsx` | PASS |
| `browser-harness-phase4.cjs b4c-after` @ `/settings` | 12/12 PASS |
| `browser-harness-phase4.cjs b4c-unknown` @ `/settings` | 10/10 PASS |
| canary rebuild in a throwaway clone | all three credential shapes still caught |
| `gates-808.sh --strict` | see `phase4/gates-round5.txt` and §7 |

Mutation kill, in the worktree, restored by hash: both card mounts deleted →
`check-settings-surface.tsx` 2 FAILURES → restored, sha256 identical.

**An operator error worth recording**, because it looks exactly like a broken instrument: run without
the gate's `--tsconfig ../tsconfig.checks.json`, both `.tsx` checks die with
`Cannot find module 'react-dom/server'` — Node resolves from the *script's* directory, not the cwd,
and `scripts/` has no `node_modules`. The gate's own invocation
(`cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json …`)
is not optional. Nothing was wrong with the checks.

---

## 7. WHAT IS LEFT

- **Nothing is deployed.** Every measurement was taken out of this worktree: a throwaway API on
  :7742 with all three stores redirected to `/tmp/b4c-*` fixtures (the harness refuses to boot
  otherwise), and a `next start` on :7743 rebuilt against it. Both were killed by port-resolved PID
  afterwards; both ports verified clear.
- **The live registry was never mutated.** `/tmp/b4c-serve.ts` proxies `/api/accounts` to :7700
  GET-only and answers any other verb with a 405.
- **The `agy` sidecar still does not exist on the live box**, so after deploy every connection reads
  UNKNOWN until the first re-check tick. That is the correct first state, and it is the second
  screenshot.
- **The task-row amendment in §4 is Konrad's call**, asked and not blocked on.
