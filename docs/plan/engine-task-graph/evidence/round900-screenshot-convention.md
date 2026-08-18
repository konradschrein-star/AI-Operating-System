# Round 900 — screenshot convention reaches every browser-driving role, F-E verified, GRAPH_GUIDE gets round 244's follow-up

Inherited from operator-visibility phase 6 (r1350 planner, 2026-08-17), re-routed
here because closing it means editing `project-tick.ts` / `cc-runner.ts` —
engine internals this project owns this cycle. Also closes: verification of
round 242's F-E (tester `BROWSER_FIRST`), and round 244's own follow-up finding
on the COMPANION FILES clause.

---

## 1. The screenshot convention — what was missing, what closes it

**Source of the gap:** `docs/plan/artifacts/phase1350/browser-visibility.md` §3
(operator-visibility's worktree, branch `project/8ea0cc08`, commit range around
`0938385`). That project shipped the UI that renders a screenshot inline the
moment it lands under `/opt/ai-os/uploads/$FORGE_RUN_ID/` — matched off the
real `Bash` tool_result / `Read` tool_call in the transcript, nothing markdown,
nothing new served. But **only `scripts/research-browser.mjs`**, reached from
the researcher's `RESEARCH_INSTRUMENTS` block, was ever instructed to write
there. Two populations took screenshots nobody could ever see:

1. Builders/reviewers using the `playwright-skill`, which writes to `/tmp` by
   design — unreachable from the Console, garbage-collected before Konrad can
   look.
2. The operator's own manager-chat runs — no `project-tick.ts` prompt reaches
   these at all; their whole prompt is `cc-runner.ts`'s `buildSystemPrompt()`.

> **AMENDED AT ROUND 902 (fix cycle 1) — read this first.** Round 901's review
> found the text below making a claim that is false: the desktop chat does NOT
> render every shot under the directory inline. The numbers in this document are
> the round-900 measurements and stay as the record of that round;
> `SCREENSHOT_CONVENTION` is now **1056 characters against a budget of 1100**,
> names the read-back action, states the fallback surface honestly and defines
> `<stamp>`. See `evidence/round902-screenshot-convention-fixes.md` and
> `scripts/checks/check-screenshot-render-shapes.ts`.

**The fix, in two files, one convention:**

- `forge-control/src/lib/project-tick.ts` — new exported constant
  `SCREENSHOT_CONVENTION` (555 characters, budget 650 — both superseded at round
  902, see the note above), delivered through
  `withPolicy()`'s existing `drivesBrowser` predicate — the SAME test that
  already selects `BROWSER_CONTROL_SAFETY` (B4, round 240). No second
  hand-written role list: a role gains this the moment its branch carries
  `BROWSER_FIRST` or `RESEARCH_INSTRUMENTS`. Today that set is exactly
  `{builder, researcher, scout, tester}` — asserted equal to B4's own
  `EXPECTED_BROWSER_ROLES` in `project-tick.test.ts` ("round 900 —
  SCREENSHOT_CONVENTION reaches exactly the same derived role set as B4"), so
  the two blocks cannot silently diverge.
- The researcher's own `RESEARCH_INSTRUMENTS` block is trimmed: the on-disk
  DIRECTORY pattern moved out (now owned solely by `SCREENSHOT_CONVENTION`);
  only the researcher-specific half stays — citing the shot's URL in the
  committed research doc, which no other role produces.
- `forge-control/src/lib/cc-runner.ts`'s `buildSystemPrompt()` — the system
  prompt appended to **every** `runClaudeCode` spawn, project task or manager
  chat alike — gets one new bullet under "Your arms and hands" stating the
  same directory. This is the fix for population 2 (the operator itself);
  `project-tick.ts` cannot reach a manager-chat run because manager chats
  never call `buildPrompt()`.

**Verified by evidence, not code-reading**, per this project's standing rule:

```
$ cd forge-control && npx tsx --test src/lib/project-tick.test.ts src/lib/cc-runner.test.ts
# tests 158 (149 + 9)  pass 158  fail 0
$ npx tsc --noEmit
(clean)
```

The new tests build the actual prompt through `buildPrompt()`/`buildSystemPrompt()`
for every role and assert the convention lands where a role would really read
it (positive over `{builder, researcher, scout, tester}`, negative over the
complement, both on a repo-backed and a scratch project) — the shape this
file's own header names as the only defence against "the assertion greps the
constant instead of the built prompt."

A live-run screenshot walk (a real builder task taking a shot and it landing
under its run's uploads directory, served by `uploads.ts`) is explicitly
**deploy/verify work**, per WORKTREE-ONLY POLICY: this round built and tested
in the worktree only. The deploy/verify task inherits that check.

## 2. F-E (round 242) — verified present and single, not re-done

The brief flagged a stale re-route: F-E ("add `BROWSER_FIRST` to the tester
branch") was already landed at `7af2968` before the scope-cut message arrived.
Verified here rather than redone:

```
$ grep -c 'BROWSER_FIRST' forge-control/src/lib/project-tick.ts
10   (1 export, 5 doc-comment mentions incl. round 900's new ones, 1 in
     withPolicy()'s drivesBrowser test, and exactly 3 literal ${BROWSER_FIRST}
     interpolations — one each in the scout, tester and builder branches)
```

The tester's `${BROWSER_FIRST}` sits at the line immediately following the
F-E comment block ("F-E, round 242. The tester was the one browser-driving
role outside withPolicy()'s derived set...") — present, and exactly once.
`project-tick.test.ts`'s existing B4 suite ("the derivation and the membership
agree") already asserts `tester` is in `EXPECTED_BROWSER_ROLES`; nothing here
needed to change that suite, only confirm it.

## 3. GRAPH_GUIDE — round 244's follow-up on the COMPANION FILES clause

Round 244's root cause, restated in its own words: round 242's write_set was
two code files; the two documents quoting its moved constants were owned by
nobody, so the constants moved and the corpus did not, and three consecutive
reviews read the stale numbers as fresh — a stale pin looks exactly like a
live one. Round 244's diagnosis of *why*: the prompt asks for a write_set of
"every file it will write," and a planner reads that as source files.

**Placement, per round 244's own instruction — at the definition, not the
COMPANION FILES prose.** `GRAPH_GUIDE`'s `"write_set"` bullet
(`project-tick.ts`) now ends:

> If a round moves a constant the corpus quotes, the documents quoting it
> belong in that round's write_set.

**Budget, measured before and after** (the tool the brief named,
`scripts/checks/measure-prompt-baseline.sh`, **does not exist in this
checkout or anywhere in this repo's history** — `git log --all -- '**/measure-
prompt-baseline.sh'` is empty. That is a stale pin in the brief itself,
reported per this project's own standing rule ("a pin you cannot resolve is a
finding you report, not a footnote you quietly reinterpret"), not silently
reinterpreted. The actual mechanism — and the one round 244 itself used — is
`project-tick.test.ts`'s own NF7 block, run via `npx tsx --test`):

```
before (round 244's committed state): maximalPlannerPrompt().length = 12121
after (this round's one-sentence add): maximalPlannerPrompt().length = 12227
delta                                                                 = 106
sentence's own .length                                                = 106   (match — nothing else moved)
cap (BASELINE 9221 + BUDGET 3050)                                    = 12271
headroom before                                                       = 150
headroom after                                                        = 44
```

Fits. `LEDGER` in `project-tick.test.ts`'s NF7 suite gets a new row (round
900, spent 106, reserved 106) and the delivery-control test gets a new
assertion that `GRAPH_GUIDE` still contains the sentence verbatim — the same
shape every prior round's row uses, so a future edit that drops the sentence
or drifts its cost fails there rather than silently.

`SCREENSHOT_CONVENTION` and the trimmed `RESEARCH_INSTRUMENTS` cost this
specific measurement **nothing**: both ride `drivesBrowser`, and the planner
branch (the only one `maximalPlannerPrompt()` measures) carries neither
`BROWSER_FIRST` nor `RESEARCH_INSTRUMENTS` — exactly the argument that already
protected B4's cost at round 240.

## 4. Write-set, as declared

`forge-control/src/lib/project-tick.ts`, `project-tick.test.ts`,
`forge-control/src/lib/cc-runner.ts`, `cc-runner.test.ts`, and this evidence
file (companion-files rule applied to itself: this file quotes the exact
sentence and the exact measured numbers, so it is in-scope for this round's
own write_set).

## 5. Verified

```
cd forge-control
npx tsc --noEmit                                          -> clean
npx tsx --test src/lib/*.test.ts                           -> 1289 pass, 0 fail (239 suites)
npx tsx --test src/lib/cc-runner.test.ts                   -> 9 pass, 0 fail (run standalone too — the
                                                                round-900 describe block is new)
python3 ../scripts/checks/check-r20-census.py               -> PASS, exit 0
bash ../scripts/checks/check-instrument-typecheck.sh        -> PASS, exit 0 (no scripts/checks/*.ts touched)
```

## 6. Not done this round (scope discipline, explicit)

- No new upload/screenshot API — `routes/uploads.ts` is unchanged.
- `rehype-forge-allowlist.ts` is unchanged (markdown images stay inert).
- No live-run verification against a deployed executor — WORKTREE-ONLY POLICY;
  this project's operator-visibility sibling (`8ea0cc08`) is live with runs in
  flight and this diff touches executor-loaded code (`project-tick.ts`,
  `cc-runner.ts`). Deploy is a separate, explicitly-briefed task per this
  project's brief.
