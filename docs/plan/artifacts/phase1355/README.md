# Round 1355 — fix cycle 2

Two reviews landed on round 1354. This round closes both.

| # | Source | Item | State |
|---|---|---|---|
| A4 | Review phase 6 (`../phase1350/VERDICT.md`) | team panel's "N hidden · show" invokes `restoreAll` — a fleet-wide wipe with no peek, confirm or undo | **fixed**, §1–§3 |
| 1 | Re-review of fix cycle 1 | `notification-gap.md:251` — §2c's two pins swapped onto each other's symbols | **fixed**, §4 |
| 2 | Re-review of fix cycle 1 | `:254-257` — the parenthetical claiming round 1350 transposed them | **deleted**, §4 |
| 3 | Re-review of fix cycle 1 | `:80-81` / `:22` — "never right, at any SHA" and "Six pins were wrong" | **corrected**, §4 |
| 4 | Re-review of fix cycle 1 | the verifier's SCOPE comment says nothing about prose pins | **fixed, and the hole closed**, §5 |

---

## 1. A4 — what the control now is

The defect, in the reviewer's words: *"`ChatTeamPanel.tsx:556,573` labels
`restoreAll` as 'N hidden · show'. I clicked it — rows 15→16 and the server set
went to `count:0`, wiping the 11 unrelated dismissals I'd made in /live moments
before."*

One control did three jobs badly. It is now three controls that each do one:

| control | attribute | what it does |
|---|---|---|
| `N dismissed · show` / `· hide` | `data-team-dismissed-toggle` | toggles the peek. **Writes nothing.** |
| `↺` on each peeked row | `data-team-restore="<node_id>"` | `restore(id)` — that row and its subtree |
| `restore all` → `restore all N?` | `data-team-restore-all` | `restoreAll()`, behind a two-click confirm, visible only while peeking, naming the GLOBAL id count it will delete |

A peeked row that is hidden only because an ANCESTOR was dismissed gets no
control at all — a `↳` marker (`data-team-hidden-with-parent`) with the reason
in its title. Deleting its own dismissal would leave it hidden under the parent,
and a control that changes nothing on screen is the silent no-op NFU6 forbids.
Restore the parent and the child reappears as a dismissed root wearing its own
`↺`; the nested dismissal is hidden, never lost.

This is `/live`'s affordance (`AgentActivity.tsx:770-915`), and the mirroring is
structural rather than copied: both surfaces now render from
`forge-control-web/app/desktop/team/peek.ts` — the toggle label, the group
heading, the fade, the row titles. `check-dismiss-peek.tsx` asserts that neither
file contains a hand-written copy of the label.

### Files

| file | change |
|---|---|
| `forge-control-web/app/desktop/team/peek.ts` | **new.** The shared vocabulary. Pure, no React, no colour. |
| `…/team/confirm.ts` | `decideRestoreAllClick` — restore-all's two-click machine, on the same `ARM_WINDOW_MS`/`MIN_CONFIRM_MS` constants as the ✕. |
| `…/team/teamRows.ts` | `FlatTeam.hiddenRows: HiddenTeamRow[]` — the rows the walk withheld, at their tree depths, with `restorable` marking the subtree roots. `hiddenRows.length === hiddenCount`, always. |
| `…/team/TeamRow.tsx` | the peeked variant: faded (`opacity 0.55`), `data-team-peeked`, `↺` in place of ⏸/✕, controls not hover-gated. Props are a discriminated union — `peeked: true` **requires** `restorable` and `onRestore` at compile time. |
| `…/team/ChatTeamPanel.tsx` | `peek` state, the DISMISSED group, the three-control footer, `handleRestore` on the same ref discipline as the other handlers (so memoised rows still bail out). |
| `…/live/AgentActivity.tsx` | reads its strings from `./peek` instead of holding its own copies. No behaviour change. |
| `…/team/dismissals.ts` | header: `restore` vs `restoreAll` are not interchangeable, and why. |
| `forge-control/src/routes/{agents,agents-shared,chat}.ts` | **comments only** — four references to the old `"N hidden · show"` label. No code, no behaviour. |

### The type-level half, demonstrated

A scratch file under `forge-control-web/app` (written, compiled, deleted):

```
__union_probe.tsx(6,4): error TS2322: … is missing the following properties
  from type '{ peeked: true; restorable: boolean; onRestore: (nodeId: string) => void; }':
  restorable, onRestore
__union_probe.tsx(10,4): error TS2322: … Property 'peeked' is missing … but required
```

A half-configured peek row does not compile. There is no runtime fallback and
no defaulted no-op behind it.

---

## 2. A4 — evidence

### 2a. `scripts/checks/check-dismiss-peek.tsx` — 52 assertions

Two halves, because the defect had two halves that could each be right while
the pair was wrong:

* **the markup** — `TeamRowView` rendered through `renderToStaticMarkup` in all
  three states, attributes read out of the HTML (same method as
  `check-stop-affordance.tsx`);
* **the wiring** — which handler sits behind which label. React serialises no
  `onClick` and neither repo has a DOM (NFU8 forbids adding one), so each
  control's JSX element is sliced out of the source by its `data-` attribute and
  asserted on: *the peek toggle may not mention `restoreAll`*, and `restoreAll()`
  may be called only from the control that names itself.

**Proven to fail on the pre-fix code**, in a shadow tree — the worktree was not
touched. `forge-control-web/app` copied, round 1354's `ChatTeamPanel.tsx`,
`TeamRow.tsx` and `AgentActivity.tsx` restored from `b3995f3` over the copy,
everything else symlinked:

```
$ cd /tmp/peek-shadow-1355/forge-control-web && tsx … check-dismiss-peek.tsx
25 FAILURE(S) — dismissal peek affordance          exit 1
  … FAIL  the footer renders a peek toggle
  … FAIL  …and a separately-labelled restore-all
  … FAIL  carries a restore control
  … FAIL  team panel imports the shared peek vocabulary
$ cd <worktree>/forge-control-web && tsx … check-dismiss-peek.tsx
ALL PASS — dismissal peek affordance               exit 0
```

### 2b. `capture-1355.cjs` — 48 assertions in a real browser, both themes

The reviewer found A4 by clicking. So does this. The walk makes an **unrelated
dismissal in /live first** — the bystander, standing in for the eleven the
reviewer lost — then clicks the team panel's control and asserts the bystander
survives.

```
PASS  dark · the /live bystander is on the server
PASS  dark · the footer says "dismissed · show", not "hidden"       "1 dismissed · show"
PASS  dark · restore-all is NOT reachable before peeking
PASS  dark · clicking "show" does NOT restore anything on the server   ← THE finding
PASS  dark · …the bystander in particular survives it                  ← THE finding
PASS  dark · the dismissed row is shown as PEEKED, not returned to the tree
PASS  dark · under a DISMISSED heading
PASS  dark · with its own restore control
PASS  dark · the peeked row is faded                                   opacity 0.55
PASS  dark · ↺ returns that row to the tree
PASS  dark · …and only that one: the bystander is still hidden
PASS  dark · restore-all says what it does                             "restore all"
PASS  dark · …and warns that it crosses panels
PASS  dark · one click only ARMS it                                    "restore all 2?"
PASS  dark · …the server is untouched
PASS  dark · a click under the confirm floor is swallowed
PASS  dark · a deliberate second click clears everything
(identical set in light)
ALL PASS — team panel dismissal peek
```

Round 1354's numbers for the same two clicks, from `../phase1350/VERDICT.md`:
rows 15 → 16, `GET /api/agents/dismissals` → `{"count":0}`. That measurement is
**the reviewer's, not this round's** — reproducing it would have meant a second
production build of the old tree, and the shadow run in §2a already fails the
same claims from the same code. Said plainly rather than implied.

Screenshots (1440×1000, both themes):
`team-{dark,light}-{1-before,2-dismissed,3-peek,4-restored,5-restore-all-armed,6-restore-all-done}.png`.
Full JSON: `capture-1355.json`.

### 2c. Both themes, measured — `theme-contrast-1355.cjs`

Screenshots show a theme; they do not verify one. The light PNGs here are
genuinely light (body `rgb(247,247,245)`, pixel-probed out of the file), and on
top of that every new control's **computed** colour was read out of the running
page and scored:

```
── dark  (surface rgb(0,0,0)) ──
  OK   peek row ↺          rgb(138,138,144)  contrast 6.12 × opacity 0.55 → 3.82
  OK   dismissed toggle    rgb(138,138,144)  contrast 6.12
  OK   restore all (ARMED) rgb(207,99,96)    contrast 5.61
  OK   DISMISSED heading   rgb(72,72,78)     contrast 2.31
── light (surface rgb(247,247,245)) ──
  OK   peek row ↺          rgb(108,108,116)  contrast 4.85 × opacity 0.55 → 3.12
  OK   dismissed toggle    rgb(108,108,116)  contrast 4.85
  OK   restore all (ARMED) rgb(178,60,57)    contrast 5.44
  OK   DISMISSED heading   rgb(166,166,174)  contrast 2.25
ALL LEGIBLE — round 1355 controls, both themes
```

The peeked row's ↺ is scored at its **effective** contrast, opacity folded in: a
fade that makes a control unreadable is not a fade, it is a hide.

### 2d. Unit checks

* `check-team-rows.ts` — 25 new assertions on `hiddenRows`: list length equals
  the label's count in every case, depths preserved, only subtree roots
  restorable, a nested dismissal neither double-counts nor offers a dead
  control, and **the wrapper cache is untouched by peeking** (its claim is "these
  are the rendered rows", and round 1302's memo measurement is written against
  exactly that set).
* `check-team-confirm.ts` — restore-all's machine, including the click-stream
  attack that beat the ✕ in round 505: 32 sub-floor bursts (3–200 clicks at
  0/1/20/30/33/120/350/499 ms), **0** restore-alls, while two deliberate clicks
  800 ms apart fire exactly once.

### 2e. Hover — unchanged, and checked

No JS hover handler was added. The peeked row's controls are *less* hover-gated
than a normal row's (they are always visible inside a list the operator
summoned), and peeking is one boolean on the panel, not a flag per row.

```
$ grep -rn 'onMouseEnter\|onMouseLeave\|onPointerEnter' \
    forge-control-web/app/desktop/team forge-control-web/app/desktop/live
AgentActivity.tsx:49: * … Any onMouseEnter in this file would be the regression …
```
One hit, and it is the comment forbidding the thing. No handler.

---

## 3. A4 — the harness

Production was neither read nor written. The API harness runs against
`forge_dismiss_ui_1350`, the scratch database round 1350 built (schema clone of
content_forge + migration 0041 + two days of copied `runs`). Ports moved to
7870/7871 so nothing collides with another round's server.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
export SECRET_STORE_DIR=/tmp/r1355-store; mkdir -p "$SECRET_STORE_DIR"
export DATABASE_URL="${DATABASE_URL%/content_forge}/forge_dismiss_ui_1350"
(cd forge-control && SERVE_V3_PORT=7870 ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)
curl -s 127.0.0.1:7870/api/secrets     # → {"secrets":[]}   ← store isolation, verified

rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/r1355-web/
ln -s "$PWD/forge-control-web/node_modules" /tmp/r1355-web/node_modules
(cd /tmp/r1355-web && FORGE_CONTROL_URL=http://127.0.0.1:7870 NODE_ENV=production ./node_modules/.bin/next build)
grep -o '127.0.0.1:78[0-9][0-9]' /tmp/r1355-web/.next/routes-manifest.json | sort -u   # → 127.0.0.1:7870
# cookie: phase800/README §2 step C, into /tmp/r1355-cookie.txt
AUTH_URL=http://127.0.0.1:7871 FORGE_CONTROL_URL=http://127.0.0.1:7870 AUTH_SECRET="$AUTH_SECRET" \
  (cd /tmp/r1355-web && ./node_modules/.bin/next start -p 7871 &)

R1355_BASE_URL=http://127.0.0.1:7871 R1355_API_URL=http://127.0.0.1:7870 \
FORGE_SESSION_COOKIE="$(cat /tmp/r1355-cookie.txt)" \
  node docs/plan/artifacts/phase1355/capture-1355.cjs
node docs/plan/artifacts/phase1355/theme-contrast-1355.cjs
```

Both servers were stopped after the capture. The scratch database is left in
place — dropping one is a destructive op and was not briefed.

### One thing a reviewer should know

`data-team-restore` **changed meaning**. It used to mark the single restore-all
button; it now marks a peeked row's own `↺` and carries that row's node id.
**Four** dated capture scripts read it under the old meaning and will not pass
as-written against this build — they are historical evidence and were left
untouched, so this is the note rather than an edit. The list below is the full
output of `grep -rn "data-team-restore" docs scripts`, minus this phase's own
scripts and `scripts/checks/`, both of which are on the new contract:

* `../phase500/dismiss-persist.cjs:205,208,240,243,248,250,253,263,264` — expects `textContent === "1 hidden · show"`, clicks it as the global restore, and asserts it disappears when the set empties.
* `../phase500/fixes-506.cjs:453,479,528,539` — clicks it to restore.
* `../phase1350/dismissal-ui/capture-1350.cjs:189,397` — same.
* `../phase1300/redteam/dom-1305.cjs:252-254` — **round 1356's review caught this one missing from the list.** A7 does `page.locator("[data-team-restore]").first()` and asserts `/^\s*1 hidden/` on its text: the old footer contract exactly. Under the new one that selector resolves to a per-row `↺` that does not exist until the operator peeks, and which carries a glyph rather than a count — so A7 breaks at the `innerText` assertion.

One more mention is a *record*, not a script: `../phase500/README.md:306` has the
row "`[data-team-restore]` appears reading `1 hidden · show` | ok" in its results
table. It is a true account of what phase 500 saw and stays as written.

The current contract is `[data-team-dismissed-toggle]` to peek,
`[data-team-restore="<id>"]` per row, `[data-team-restore-all]` for the global
verb — the same shape `/live` uses.

---

## 4. Items 1–3 — the withdrawn correction

`grep` says what the tree holds, and it has never changed on this branch:

```
$ grep -n 'function toThreadEntry\|r.post("/:id/message"' forge-control/src/routes/run-control.ts
149:function toThreadEntry(e: CommsThreadEntry): ThreadEntry {
214:r.post("/:id/message", async (c) => {
$ git log --oneline main..HEAD -- forge-control/src/routes/run-control.ts
(no commits)
```

Round 1350's mapping — route at `:214`, serializer at `:149` — was right at
every SHA. Round 1353 "corrected" it into being wrong. Changes:

* `notification-gap.md:251-252` — pins swapped back.
* `:254-257` — the parenthetical asserting a round-1350 transposition: **deleted**.
* `:80-81` — the two correction rows now read **VERIFIED, unchanged**, with the
  withdrawn claim named. Kept rather than dropped: an empty row invites the same
  swap next round.
* `:22` — "Six pins were wrong" → "**Four** pins were wrong, all four rotted",
  plus a sentence recording that the fifth and sixth were a mistaken correction.
* The "Two lessons" paragraph, which built on the false claim, is now three, and
  the third is the actual lesson: **an unrequested correction needs the same
  evidence as the defect it claims to fix.** The four rotted pins each came with
  a `git diff` naming the commit that moved them; the transposition was asserted
  from reading, against a file that had not changed.
* §4 gains a bullet recording the withdrawal — the corpus rule is never silently
  drop, never quietly pass, and that cuts both ways.

---

## 5. Item 4 — the verifier, and the hole it had

The SCOPE comment now states the limitation the review asked for. It also
stopped being a limitation, because documenting it alone would have left the
next `ALL PASS — 11/11` just as misreadable:

**`PROSE_PINS`** — twelve `file:line` citations that live in running prose with
no fence under them (§2c's two, §3's four, and six more). Each is checked three
ways:

1. `cite` — the doc must still contain that citation string, so renumbering a
   pin without registering it fails loudly instead of drifting out of coverage;
2. `bind` — **the doc must bind that number to the claim it carries.** This is
   the field that catches round 1353's defect and `cite` alone cannot: both
   numbers appeared in the wrong version of §2c too, just wearing each other's
   labels;
3. `expect` — the cited line must still hold the symbol.

Demonstrated, against the doc as it stood at `b3995f3` (shadow tree, worktree
untouched):

```
FAIL  §2c `run-control.ts:214` → the POST /:id/message route handler
        contains `run-control.ts:214`, but not bound to this claim
FAIL  §2c `run-control.ts:149` → toThreadEntry, the comms-entry serializer
2 FAILURE(S) — 11 fenced quotes + 10 prose pins            exit 1
```

At HEAD: `ALL PASS — 11 fenced quotes + 12 prose pins … (NOT every pin in the
doc — see SCOPE at the top of this file)`. The summary line now names both
counts and its own limits, so `ALL PASS` cannot be read as "every pin checked".
What remains uncovered is listed in the SCOPE comment: prose pins not in the
table, cross-document pins, and §1's deliberately historical pins at old SHAs.

---

## 6. Gates

```
scripts/checks/gates-808.sh                       25 gates, RED: 0
  tsc — forge-control                             0
  tsc — forge-control-web                         0
  NODE_ENV=production pnpm build                  0   (12 routes)
  no-raw-colours.cjs (whole app)                  PASS — 0 unlisted
  forbidden-file diff (main...HEAD)               clean
  dollar-sweep.sh                                 0
  check-dismiss-peek.tsx            (new gate)    ALL PASS — 52
  check-team-rows.ts                (new gate)    ALL PASS
  check-team-confirm.ts             (new gate)    ALL PASS
  verify-notification-gap-pins.mjs  (new gate)    ALL PASS — 11 + 12
  check-stop-affordance.tsx                       ALL PASS — 23
  check-usage-fold.ts (real Postgres)             ALL PASS
  pnpm test — forge-control                       856/856
  browser gates (network-700, nav-walk)           SKIPPED — harness not up
```

Raw-colour grep over every file this round touched: zero hits.
