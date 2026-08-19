# Phase 3, fix cycle 1 — the four findings, answered one at a time

**Round:** 3 · **workstream:** `surfaces` · **branch:** `project/7851068b-surfaces`
**Started from tip:** `0361c4a` (the round-2 gate commit) · **reviewed tip was** `08a5ce6`
**Evidence transcript:** `gates-phase3.txt` beside this file. **Shots:** `gate-goals.png`,
`gate-library.png`, `gate-nav-390.png`, and `/opt/ai-os/uploads/71d8d606113f/`.

Two of the four findings are fixed in code here. Two cannot be executed by a build task in
this lane, and saying so plainly is the honest answer rather than reaching outside the
worktree to make a checklist go green. Both are escalated, both are handed on with the exact
correction written out. A fifth thing turned up while running the gates and is filed at the
bottom.

---

## Finding 3 — the `/signin` diagnostic was unreachable · **FIXED**

**The reviewer's prescription was to swap `verify-phase3.cjs:331` and `:332`. I did not do
that, because it breaks the harness.** `assertPastTheWall()` does two jobs: it checks the URL
is not `/signin`, and it then asserts the shell actually mounted. That second check was a
`locator(…).count()` — instantaneous, no waiting. It only ever worked because the call site
did the waiting for it, on the line above. Swap the two lines and the mount check fires
against a page that has had no time to render, and every call site starts failing with
`the desktop shell did not mount` on a perfectly healthy page. That is the same class of
wrong signpost the file's own docstring says it exists to prevent.

**What the finding is actually about is order: the wall must be decided before anything waits
on the DOM.** So the wait moved *inside* the function, below the URL check, and a timeout on
it is re-thrown as the "did not mount" diagnostic it always meant:

```js
async function assertPastTheWall(page, where, mountSelector, timeoutMs = 30_000) {
  const url = page.url();
  if (/\/signin/.test(url)) { throw new Error(/* the salt paragraph */); }
  try {
    await page.waitForSelector(mountSelector, { timeout: timeoutMs, state: "visible" });
  } catch (err) {
    throw new Error(`[${where}] no visible "${mountSelector}" at ${url} after ${timeoutMs}ms …`);
  }
}
```

**The defect was at three call sites, not the one named.** `:331` (initial load, every
viewport), `:496` (the `search` reload) and `:550` (the phone sheet) all had a
`waitForSelector` above the assertion. All three now call `assertPastTheWall` alone; the
phone sheet passes `15_000` to keep the timeout it had. The docstring carries a paragraph
saying why the order is load-bearing, so the next edit does not quietly undo it.

**Proven, both branches** (`gates-phase3.txt` Part 6):

| control | before | after |
|---|---|---|
| garbage cookie → the salt paragraph | generic `Timeout 30000ms … locator('nav')` after 30 s | the salt paragraph, `exit 1`, **1 s** |
| bogus mount selector → the mount diagnostic | reachable | still reachable — `no visible "nav#this-element-does-not-exist" … after 4000ms` |

The second control is not decoration. Folding the wait into the function could have made the
mount branch dead code, which would have been a new defect hiding behind a fixed one. It was
proven against a copy in `/tmp`, so the real harness was never edited to test itself.

**The harness still passes:** `ALL PASS — 76 assertions`, `VERIFY_EXIT=0`, at 1280×800,
1280×600 and 390×844. Same count as round 2 — the refactor changed no assertion.

---

## Finding 4 — `DesktopApp.tsx:182` shipped a live count in the present tense · **FIXED**

The reviewer counted 488 where the copy said 423. I counted **503** an hour later. The figure
was rotting faster than the round that wrote it.

- **was:** "GET /api/uploads/index is mounted and answering right now over 423 files in /opt/ai-os/uploads."
- **now:** "GET /api/uploads/index is mounted and answers over the artefact store in /opt/ai-os/uploads — more than 400 files when this screen was written (measured 2026-08-18; the store is live and every run adds to it, so read that as a floor and not as today's count)."

Dated, floored, and explicit that it is a floor. `403 → 488 → 503` all satisfy "more than
400", and the store only grows, so the sentence does not rot. The claim it supports — that
LIBRARY needs no new route — is untouched and still true.

**Proven against what is served, not against the source file** (`gates-phase3.txt` Part 7):
rebuilt from this worktree (`BUILD_ID X7kY007mygqP7FcjEn6bM`, moved from `525l6EwUGhuS5cwlFiZrA`),
the served HTML carries that BUILD_ID, and `grep -rl "423 files" .next/` returns three hits
**all inside `.next/cache/webpack/`** — none in any served chunk. `grep -rl` for the new
sentence returns four, and R38's `is not built yet` sentinel still returns seven. The rendered
result is `gate-library.png`.

---

## Finding 1 — `/opt/forge-ai-os` is dirty · **NOT FIXED. ESCALATED. Read this before ruling it a stall.**

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx      (+85 / −1)
```

The reviewer's fix was "revert it, or commit it there deliberately". **Both are actions on the
live checkout, and a build task in this fleet may not take either.** The worktree-only policy
is explicit: `/opt/forge-ai-os` must never be edited, patched or "just quickly fixed" during a
build phase. I did not touch it. Its state is bit-identical to what the reviewer described —
same single file, sha256 `47e0634a…`.

**And "revert it" is worse than a policy violation here — it is a destructive act on the only
copy of the change.** I looked:

```
$ git -C /opt/forge-ai-os log --oneline --all -- …/AssistantThread.tsx
ed601ff  fix(round1875) …        ← none of these is the windowing fix
c6d7971  fix(round1873) …
f6f66a0  fix(round1871) …
…
$ git grep -l WINDOW_STEP <every local branch> -- …/AssistantThread.tsx
(no output)
```

**The chat-windowing fix exists in no commit on any branch.** The dirty working copy is the
only place it exists, and it is the fix Konrad is using right now — the project brief names it
as already done ("the chat-scroll freeze was already fixed by windowing, 2026-08-18"). A
`git checkout --` there deletes it, regresses the live chat, and needs an explicit instruction
that nobody has given.

**What I did instead:** saved it, so no ruling can lose it.
`live-checkout-dirt-AssistantThread.patch` in this directory — 121 lines, straight
`git -C /opt/forge-ai-os diff` output, `git apply`-able onto a branch by whoever owns lane 5.

**Escalated** to the manager chat (run `bfd1283a`) with the three options as a control block,
and to reminders in case the chat is not read. **My default if nobody rules: defer to the
deploy phase**, which has both the authority and a detached procedure for touching
`/opt/forge-ai-os`. The options put to Konrad:

1. commit it in place, owner lane 5 (E1) — keeps the fix live, done by the deploy phase;
2. revert and have lane 5 rebuild it on a branch from the saved patch — gets it reviewed, the
   live chat regresses until that lands;
3. defer to deploy.

**For the re-check:** this finding is not closeable by this lane at this phase. Closing it
requires either Konrad's ruling or the deploy task's authority. The evidence, the patch and
the escalation are all here; the action is not mine to take.

---

## Finding 2 — an undeclared path in B3b's `write_set` · **NOT FIXED. No verb exists. Handed to integration with the exact correction.**

The reviewer already routed this one: *"No fix cycle; fold into the integration task (N8)."*
I confirmed why it cannot be done from here — **the engine has no PATCH on a task row**:

```
$ grep -nE '^\s*r\.(get|post|patch|put|delete)\(' forge-control/src/routes/projects.ts
167  r.get("/board")      180  r.get("/")        185  r.post("/")
239  r.get("/:id")        379  r.post("/:id/tasks")
765  r.post("/:id/unwedge")   812  r.post("/:id/status")
```

`POST /:id/tasks` creates; nothing updates. The only remaining path is a direct write to the
live database, which a build task is forbidden to make. So here is the correction, exact,
ready to apply:

- **task** `43395201-0507-4d69-aeec-f6b191cc0af4` (B3b, role `builder`, status `done`)
- **field** `write_set` — currently **11** entries, verified via `GET /api/projects/7851068b-…`
- **add** `docs/plan/artifacts/os-usable-for-work/phase3/after-phone-sheet.png` → **12**

Every other declared path is present and written; nothing else is missing.

---

## New, found while running the gates — **gate 18 is flaky whenever two lanes run at once**

Not a finding against phase 3's diff. It is a finding against the gate, and it will hit every
lane of this project, so it is filed rather than smoothed over.

```
bash scripts/checks/gates-808.sh --strict                                  → RED: 1  (gate 18)
USAGE_FOLD_DB=r1354_sampler_surfaces bash scripts/checks/gates-808.sh --strict → RED: 0
cd forge-control && tsx ../scripts/checks/check-usage-fold.ts   (alone, unchanged, no override)
                                                                           → ALL PASS
```

**The mechanism is in the source, not inferred from the flake.** `check-usage-fold.ts:106`
defaults its scratch database to the single fixed name `r1354_sampler`, and `:279` issues
`TRUNCATE runs, spend_log, usage_hourly` between fixtures. Five lanes of this project run
their gates concurrently on this host. Two of them inside that check at the same time truncate
each other's fixtures mid-assertion — which is exactly the six-failure shape observed. This
lane's diff touches no SQL, no route and no `forge-control` file, so it cannot reach that gate
by any path.

**The fix is one line per lane** — the escape hatch already exists:
`USAGE_FOLD_DB=r1354_sampler_<lane>`. Better still, default it to something lane-unique inside
the check so nobody has to remember. Until then, a red gate 18 in a concurrent project means
"another lane was in the same scratch database", and re-running it alone is the way to tell
that apart from a real failure.

---

## The command block, this round

```
cd forge-control      && pnpm install --frozen-lockfile --prod=false   → Already up to date, 885ms, pnpm 9.15.9
                         node_modules/.bin/{tsc,tsx} present            (neither '- typescript' nor '+ typescript' printed)
cd forge-control-web  && pnpm install --frozen-lockfile --prod=false   → Already up to date, 985ms
                         typescript 5.7.2 · next 15.1.3 · next-auth 5.0.0-beta.25   (verified positively)
cd forge-control      && npx tsc --noEmit                              → EXIT=0
cd forge-control-web  && npx tsc --noEmit                              → EXIT=0
cd forge-control      && pnpm test          → tests 1293, pass 1293, fail 0   → EXIT=0
bash scripts/checks/gates-808.sh --strict   → 25 gates, 23 executed, 2 skipped-by-design, RED 1 (gate 18 — above)
USAGE_FOLD_DB=… same command                → RED 0
node scripts/checks/no-raw-colours.cjs      → PASS — 222 literals, 0 unlisted   → EXIT=0
tsx scripts/checks/check-phase3-placeholders.ts → ALL PASS — phase 3 placeholders (R40)  → EXIT=0
tsx scripts/checks/check-r1873-fixes.ts         → ALL PASS — round 1873 fixes            → EXIT=0
verify-phase3.cjs (authed, 3 viewports)         → ALL PASS — 76 assertions               → EXIT=0
verify-phase3.cjs (garbage cookie, control)     → the salt paragraph, exit 1, 1 s
```

Gate 17 — the briefed known-red — is green here again (`ALL PASS — 92/92 pins`).

## Write-set

Declared: `gate-goals.png`, `gate-library.png`, `gate-nav-390.png`, `gate-verdict.md`,
`gates-phase3.txt` — all five written. **Three files were written outside it and are declared
loudly in the final report:** `forge-control-web/app/desktop/DesktopApp.tsx` (finding 4),
`docs/plan/artifacts/os-usable-for-work/phase3/verify-phase3.cjs` (finding 3), and
`docs/plan/artifacts/os-usable-for-work/phase3/live-checkout-dirt-AssistantThread.patch`
(finding 1's rescue copy). The first two are the literal subjects of two of the four findings
this round exists to fix, and both are declared on the parent phase row
(`43395201-…`) — this row inherited the round-2 reviewer's gate write-set, which contains no
source file at all, so no fix cycle could ever have satisfied it as written.
