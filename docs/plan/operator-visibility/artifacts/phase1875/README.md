# Round 1875 — fix cycle 3, and the evidence for each of round 1874's five findings

## Where this ran

| Component | Where |
|---|---|
| forge-control-web | **worktree** `npm run build` (exit 0) → `next start -p 7844` |
| forge-control API | **worktree** routers via `scripts/checks/serve-v3-7798.ts`, `SERVE_V3_PORT=7842` |
| database | the real `content_forge`, **reads only** |

No pm2 service was started, stopped or restarted. `/opt/forge-ai-os` was never edited.
Every browser run stubs dismissal writes at the route boundary and blocks every
run-control verb (`guardRunControl` / `stubDismissalWrites` in `lib.cjs`), so no row
of Konrad's was hidden and no run was touched.

**One trap worth recording for the next round.** `next.config.mjs`'s `/api/proxy/:path*`
rewrite destination is baked into `.next/routes-manifest.json` **at build time**. A
`next start` with `FORGE_CONTROL_URL=…7842` in the environment still proxies to
whatever the BUILD saw — so the first pass of `f1` was measuring the worktree UI
against the LIVE `:7700` API, which has no `/api/agents/peers` and answered
`400 {"error":"invalid run id"}` from its `/:id` handler. Everything below was
re-run against a build made with `FORGE_CONTROL_URL=http://127.0.0.1:7842`.

## The five findings

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | 28 of 128 comms cards read `◂ c8bc5ffa unknown role`, no tooltip | **fixed** | `f1.json`, `f1b.json`, `01`, `01b`, `01c` |
| 2 | toast said "180 rows hidden", tray said "21 dismissed" | **fixed** | `f2-f3.json`, `04`, `05` |
| 3 | an armed ✕ ignored Escape and outside clicks | **fixed** | `f2-f3.json`, `02`, `03` |
| 4 | every sub-agent tooltip ended `· id toolu_01 ·` | **fixed** | `f4-f5.json`, `06` |
| 5 | the phone's menu button was 34×34 | **fixed** | `f4-f5.json`, `07`, `08` |

### 1 — every card names its sender, and the counterfactual says by how much

`GET /api/agents/peers?ids=…` (new, `forge-control/src/routes/agents.ts`) answers
"who are these run ids" for the ids a transcript still cannot name; `ManagerThread`
asks **once**, keyed by the id set, `staleTime: Infinity`.

* **0 of 131** cards read "unknown role" (was 28 of 128). The three the tester quoted
  now read `Plan phase 800: composer v3 … · planner`, `Composer autogrow + effort
  color ramp (U28, U29, U32) · builder`, `Secret-request data layer + SecretField
  answer mode (U30 part 1) · builder`.
* **131 of 131** cards carry a `title` **on the card element** — the attribute the
  tester read and found empty. It holds the full name, which the 190px header line
  ellipsises.
* **One request** on open, **0 more in the next 14 s**: a lookup, not a poll.
* **The counterfactual** (`f1b`, the same page with `/agents/peers` refused 500):
  **28 of 131** cards go unnamed, and they are the same peers — `c8bc5ffa`,
  `4e842cc8`, `e69ea9a8`, `f6a2ee75`. With the lookup: **0 of 131**.

**Why the tester saw 28 and a naive re-test sees none.** The team tree can only name
the peers of the project it is currently showing. His panel was on
`engine-task-graph` (visible in his own `48-light-chat-real.png`); with the panel on
`operator-visibility` the tree happens to cover them. So the bug was real and is
*display-state dependent* — which is exactly why the fix cannot live in the tree.
`f1` therefore proves it the hard way: it switches the panel to the other project,
leaves the tree with 25 rows and no operator-visibility peer in it, and the cards stay
named (`01b`).

### 2 — one gesture, two numbers, both stated

`hideToastText` (`team/confirm.ts`) with `rowsHiddenBy` (`team/teamRows.ts`,
`live/agentsApi.ts`), counted by the same walk the tray's own label counts with.

* stubbed cascade of **180** ids of which **21** are rows in this tree →
  toast: `21 rows hidden here · 180 in total, the rest this project's finished runs on
  other panels — undo restores all 180`; tray: `21 dismissed · show` (`05`).
* the undo still posts **180 of 180** ids.
* the tray's tooltip now says which number it is ("the rows THIS panel is
  withholding … which is why a cascade's toast can name a larger number").

**A bug found while measuring it**: reading the tree from the ref *inside* the
dismiss callback describes the panel AFTER the optimistic hide, so the difference was
always 0 and the toast said "all of them elsewhere in the fleet" beside a tray that had
just grown. The tree is now snapshotted at the click. First measurement of it is in this
directory's history; the fixed reading is `04`/`05`.

### 3 — the way out, and the sentence that says so

* one click still arms; the strip now reads `… ✕ again to confirm · esc or click away
  cancels`.
* **Escape** → `data-confirm="idle"`, 169 rows before and after, 0 dismissal writes.
* **a click in the transcript** → `data-confirm="idle"`, same.
* both panels (`ChatTeamPanel`, `AgentActivity`) mount the two listeners **only while
  something is armed**, and a pointerdown on a ✕ is left to the machine so the confirm
  still costs two clicks and not three.

### 4 — two sub-agents can be told apart

`app/desktop/short-id.ts` — one rule, imported by the team rows, the Live rows, the
comms cards, the breadcrumb and the dismissal toasts. It strips `toolu_` plus **at most
two** version digits: a greedy `\d*` would have eaten the body's own leading digit and
shortened two ids by different amounts.

7 sub-agent rows, 7 distinct tooltips, none of them `toolu_01`:
`4raMUrJc 2sWh2xag AeuQskZP CaVhCxZ9 U21ApZZJ 4exr6WEC 9chfnXfi` — including the two
the tester quoted as identical (`toolu_014exr6W…`, `toolu_019chfnX…`).

### 5 — the button is as big as what it opens

`44×44` (was 34×34), inside a 46px bar that did not grow, no horizontal overflow, all
**18** destinations still 44px. `07`, `08`.

## Neighbours re-walked (`n1.json`, `09`, `10`, `11`)

* **DoD 1** — 168 settled team durations byte-identical across the whole run.
* **DoD 2** — 169 of 169 rows classified, every one carrying a lineage tooltip.
* **DoD 3** — hover: **2** long tasks over 3×2.6 s of continuous row hovering vs **4**
  in the idle control; a hover event is handled in **0.06 ms avg / 0.3 ms max**.
  Typing: **4.56 ms/key** avg, p95 12 ms, 70 real keystrokes (round 1874's own method
  and its <20 ms threshold; its headline 2.77 ms came from the same harness).
* **Both themes** — `data-theme=light`, body `rgb(247,247,245)`, 131 comms cards with
  role ink `rgb(28,115,133)`. NB the captured PNG of the light theme looks dark on this
  box; round 1874's own `48-light-chat-real.png` has the identical property, so it is a
  headless-capture artefact, not a rendering regression.

## Checks

`scripts/checks/check-r1875-fixes.ts` — 60 assertions over the pure cores of findings
1–5 (`ALL PASS`). Every other check script in `scripts/checks/` still passes;
`check-dismiss-peek.tsx` was updated where it pinned the exact tray tooltip, which this
round extends (both properties it exists for — each panel names the OTHER surface, the
two readings differ — are asserted unchanged).

`npx tsc --noEmit` clean in **both** repos; `npm run build` exit 0.

## Two gates that were already RED, and are not this round's

`bash scripts/checks/gates-808.sh` → `RED: 2`, both pre-existing at `c6d7971`:

* **8 `dollar-sweep.sh`** — two prose hits landed by rounds 1871/1873 and never
  allowlisted: `TeamRow.tsx` ("token spend was never recorded for this sub-agent") and
  `nav-items.ts` (a header comment). Verified present in `git show HEAD:` for both files.
* **17 `verify-notification-gap-pins.mjs`** — doc pins under `docs/plan/`, untouched
  here.

`check-secret-scan.ts` also fails on two phase1860 docs; the "credential" it matches is
that document's own `postgresql://postgres:***@` **mask** — a false positive in the
scanner, not a committed secret.
