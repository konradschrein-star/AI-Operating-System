# Round 902 — fix cycle 1 on round 900's screenshot convention

Round 901's reviewer returned `VERDICT: NEEDS_FIXES` with three findings against
the inherited round-900 change. All three are addressed here. The review's own
executed gate block ran green (typecheck 0, 1289/1289 tests, every corpus and
instrument check exit 0), so nothing below re-litigates the delivery mechanism —
the funnel, the derived role set and the cost accounting were all confirmed. The
findings are about what the delivered text SAYS.

**Write set** (declared, per standing rule 5):

```
forge-control/src/lib/project-tick.ts                     SCREENSHOT_CONVENTION + its doc-comment
forge-control/src/lib/project-tick.test.ts                B5_BUDGETS + the round-900 suite
forge-control/src/lib/cc-runner.ts                        buildSystemPrompt's `- Screenshots:` bullet + doc-comment
forge-control/src/lib/cc-runner.test.ts                   the round-900 cross-check suite
scripts/checks/check-screenshot-render-shapes.ts          NEW instrument
scripts/checks/instrument-manifest.txt                    the new instrument's entry
docs/plan/03-quality.md                                   T16 (finding 2) + new §1.3
docs/plan/engine-task-graph/03-quality.md                 §2.2 table row, §4 gate block line
docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md   this file
```

> **Superseded by `docs/plan/scripts-checks-typecheck-gate/`, round 500 — the
> `instrument-manifest.txt` line only.** That write is a true record of round
> 902: the file was an inclusion list then and a new instrument had to be
> entered in it. It is a waiver ledger now, holding zero entries, and
> `check-screenshot-render-shapes.ts` is covered by glob without being named
> anywhere. A round-902-shaped write-set today would not contain that line.

The two `03-quality.md` files are in the write set because of the rule round 900
itself added to `GRAPH_GUIDE` and then did not apply to its own work: *a round
that moves a constant the corpus quotes owes the documents quoting it a place in
its write set.* That omission is finding 2.

---

## Finding 1 — the prompts promised a rendering the renderer does not do

**The claim, round 900:** "The desktop chat renders every shot under that
directory inline" (`SCREENSHOT_CONVENTION`, and the `- Screenshots:` bullet in
`buildSystemPrompt`).

**What the renderer does:** `extractBrowserShots`
(`forge-control-web/app/desktop/chat/browser-shots.ts`) matches two payload
shapes and no others — a `Read` tool_call whose `file_path` is under
`/opt/ai-os/uploads/<12hex>/`, and a `Bash` tool_result carrying a JSON
`"url": "/api/uploads/<12hex>/<name>"` MEMBER. Writing a PNG into the directory
is neither. The shot is not lost — `RunShotsIndicator` lists it on a Team/Live
row via `GET /api/uploads/:id/shots` — but it is one click away on another
surface, and the populations round 900 was written for (builders, scouts and
testers saving BY HAND, plus the operator's own runs) got nothing inline.

**Executed, not argued.** The proof is now a committed, re-runnable instrument
rather than a transcript pasted into a document:
`scripts/checks/check-screenshot-render-shapes.ts`. It prints the resolved
absolute path and sha256 of every module it imported before any verdict, so a
reader can tell which bytes answered.

```
$ cd forge-control-web && npx tsx ../scripts/checks/check-screenshot-render-shapes.ts
check-screenshot-render-shapes.ts — round 902, review finding 1

PROVENANCE
  this check      : …/scripts/checks/check-screenshot-render-shapes.ts
  this check sha  : 34eb627b44a68128f9d671e19ffe4e2d960d3070044fe49f265a63d374c89c22
  imported        : …/forge-control-web/app/desktop/chat/browser-shots.ts
     sha256       : ef17ff2eaa198ec2fbb4bfd3960ef5d5ed0e1318589866fa51ae8069fbb8f574
  imported        : …/forge-control/src/lib/project-tick.ts
  imported        : …/forge-control/src/lib/cc-runner.ts
  node            : v22.22.2

── payload shapes → inline refs ─────────────────────────────
PASS  A. the agent READS the shot back after saving it                    → 1 ref
PASS  B. a Bash result echoing the BARE /api/uploads URL as text          → 0 refs
PASS  C. a Bash result carrying a JSON "url" member                       → 1 ref
PASS  D. mcp__playwright__browser_take_screenshot straight to the dir     → 0 refs
PASS  E. the playwright-skill's script copying its /tmp shot in (silent)  → 0 refs
PASS  F. a Read of a correctly-placed but UNSTAMPED name                  → 1 ref
PASS  G. a Bash result merely mentioning /api/uploads in prose            → 0 refs
…
ALL PASS — 16 checks
EXIT=0
```

(The abbreviated lines above are the case labels; the script prints each one
with the reason it is in the table. `…` elides §2 and §3, both PASS.)

**The fix.** Both constants now name the ACTION that makes the promise true —
save it, then **Read the file back** — and state the fallback honestly: inline
when the transcript shows a Read of the path or a printed `"url"` member,
otherwise under the run's camera indicator in the Team and Live panels.

**A deviation from the review's prescribed wording, and why.** Finding 1 offered
two equal alternatives: "`Read` the file back **or** print its
`/api/uploads/$FORGE_RUN_ID/<name>` URL, the shape `URL_MEMBER_RE` matches."
Case **B** is that second alternative, executed: **0 refs.** `URL_MEMBER_RE` is
`/"url"\s*:\s*"\/api\/uploads\/…/` — it matches the quoted JSON MEMBER, which is
what `research-browser.mjs` prints, not a URL in a sentence. An agent told to
"print the URL" would print a bare line and see nothing render. Prescribing it
would have rebuilt this very defect one round later, so the prompts prescribe
the Read and mention the `"url"` member only as what `research-browser.mjs`
already emits on its own behalf. Reported to the manager chat when found.

## Finding 3 — `<stamp>` was never defined

Until round 900 the only writers were tools that stamp themselves. Round 900
told four roles and every manager-chat run to save by hand, while leaving
`<stamp>` undefined. `parseShotName` — both copies, `uploads-index.ts` and
`browser-shots.ts`, each keyed on `\d{8}T\d{6}Z` — yields `ts: null` for
`settings-dark.png`; the shot still serves and still lists, but it sorts last in
`newestFirst` and shows no clock in `shotClock`. Case **F** and §2 of the check
above measure exactly that difference (`2026-08-18T09:30:00Z` vs `null`).

Both prompts now state: `<stamp>` is compact UTC ISO-8601 (e.g.
`20260818T093000Z`), `<label>` is lowercase `[a-z0-9-]` — the same format
`agents/researcher.md` already documents for the tools' own naming, so the
hand-saved and tool-saved names sort together in one list. The example literal
is asserted in the round-900 suite as the review asked, and in the cc-runner
cross-check, because a format clause that cannot be copied is not a format
clause.

## Finding 2 — the corpus described a gate that no longer exists

`docs/plan/03-quality.md` §2 item **T16** still said the screenshot convention
is asserted literally as
`/opt/ai-os/uploads/$FORGE_RUN_ID/<timestamp>-<label>.png` inside
`RESEARCH_INSTRUMENTS`. Round 900 moved that literal to `SCREENSHOT_CONVENTION`,
respelled it `<stamp>`, and deleted the assertion — leaving a stale pin that
reads exactly like a live one. No gate catches it: `check-instrument-identity.py`
scans only `docs/plan/engine-task-graph/`.

Amended in the style that document already uses for its own amendments: the T16
bullet now claims only the **URL half**, carries the pointer
**"T16's on-disk screenshot half AMENDED at R900, recorded at R902 — see §1.3"**,
and a new **§1.3** states what moved, where each half is asserted now, and that
the replacement assertion (against the researcher's BUILT prompt) is strictly
stronger than the constant-only one it retired.

A sweep for other rot from the same move, run at this round:
`grep -rn "<timestamp>-<label>"` over the tree returns `agents/researcher.md`
(its own convention for the tools' self-naming, whose format the new clause
matches — not stale) and §1.3's own quotation of the retirement. Nothing else.

---

## Measurements

| | before (r900) | after (r902) |
|---|---|---|
| `SCREENSHOT_CONVENTION` | 555 chars | **1056** |
| its enforced budget (`B5_BUDGETS`) | 650 | **1100** |
| `buildSystemPrompt`'s `- Screenshots:` bullet | 425 | **818** |
| `buildSystemPrompt(true)` total | 8287 | **8680** |
| NF7 `maximalPlannerPrompt()` | 12227 | **12227 — unchanged** |

NF7 is unchanged because `SCREENSHOT_CONVENTION` rides `drivesBrowser`, which
the planner branch never satisfies. That is not a claim resting on this
sentence: NF7's ledger assertion is EXACT, not a bound — an unattributed
character fails it with its own size — so `pnpm test` passing is the check.

**The budget was RAISED, and that needs its own paragraph** because the failure
message on that very assertion forbids widening a budget to make one's own work
green. That prohibition stands and is not what happened here. 650 was a budget
no CORRECT version of this constant could satisfy: the shortest text that states
the directory, the read-back action, the honest fallback and the stamp format is
1056 characters. Shrinking to fit would mean deleting one of those four true
statements — paying for the budget with the defect. That is the unsatisfiable
gate of standing rule 2, and rule 2's remedy is to amend it *where it is
enforced, in the same commit, with the reasoning inline* — which is what the
comment above `B5_BUDGETS` now does. The new number is the measurement plus 44,
the same tight margin the other rows carry, so the next sentence added here
trips the gate and has to argue for itself.

The cc-runner bullet's +393 characters land on EVERY spawn, including
architect/planner/reviewer runs that never drive a browser, because
`buildSystemPrompt` is `--append-system-prompt` unconditionally. Kept
deliberately: a manager-chat run has no role branching to condition on, so
either every spawn carries a true instruction or the operator's own screenshots
keep landing where nobody sees them. ~100 tokens against 8680 characters.

---

## What would have made this round's instruments report a pass wrongly

**(a) Tests that grep the CONSTANT while `withPolicy()` quietly stopped
delivering it.** Closed structurally: the new
`round 902 — the built prompt names the action…` case runs over
`buildPrompt(task({role}), project)` for all four browser roles on both a
repo-backed and a scratch project, so it fails on a constant that is correct but
undelivered.

**(b) A negative assertion satisfied vacuously.** "The false claim is gone"
passes trivially against a constant that stopped mentioning rendering at all —
or against an empty one. Paired with a positive in the same test (the
replacement clause must be present), and `B5_BUDGETS`'s existing `length > 200`
positive control covers the empty case.

**(c) A pass never observed failing.** Three deliberate mutations were run and
watched go red, then reverted; `git status --porcelain` was clean afterwards and
both suites returned to green.

| mutation | expected | observed |
|---|---|---|
| M1 — the read-back clause reworded away in `SCREENSHOT_CONVENTION` | the built-prompt case and the needle table fail; the cc-runner cross-check fails | project-tick **2 fail** (`not ok round 902 — the built prompt names the action…`), cc-runner **1 fail** |
| M2 — the false round-900 sentence put back | the negative case fails in both files | project-tick **2 fail** (the negative case, plus `B5_BUDGETS` — the restored sentence pushed the constant past 1100, so the tightened budget bit too), cc-runner **1 fail** |
| M3 — only the cc-runner bullet drifts back, project-tick left correct | the cross-check catches one-sided drift | cc-runner **2 fail**; project-tick unaffected, which is the point |

**(d) A shadow tree — measuring one checkout while reporting another.** The
character counts were taken by importing the constants from this worktree by
absolute path through `tsx`; the new check prints the resolved path and sha256
of all three modules it imports. `SCREENSHOT_CONVENTION` at 555 characters does
not exist on this branch any more, so a stale import cannot produce 1056.

**(e) A new instrument that escapes the gate it belongs to — superseded by
`docs/plan/scripts-checks-typecheck-gate/`, round 500.**
`check-screenshot-render-shapes.ts` is in `instrument-manifest.txt`, so
`check-instrument-typecheck.sh` compiles it (7/7, exit 0) and its manifest guard
would fail by name if it were not listed. It is also added to §4's reviewer
block and §2.2's table — an instrument nobody runs proves nothing.

> **SUPERSEDED.** The paragraph above records how coverage was obtained at
> round 902 and is no longer how it works. `check-instrument-typecheck.sh`
> enumerates every `.ts`/`.tsx` under `scripts/checks/` by glob at run time, so
> **this instrument is covered by glob and lists nothing**; the manifest guard
> is retired and `instrument-manifest.txt` is a waiver ledger holding zero
> entries. Listing a file there today would EXCUSE its failure, not obtain its
> coverage. The control's *point* survives intact and is stronger — a new
> instrument cannot escape the gate by being new, and it no longer depends on
> anyone remembering to write it down. Measured at round 500: 42 subjects
> found, 42 compiled, exit 0.
