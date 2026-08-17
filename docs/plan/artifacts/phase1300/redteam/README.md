# Round 1305 — RED TEAM against round 1302's memoization, payload trim and selector delete

Brief: `docs/plan/operator-visibility/03-quality.md` §5 — attack, don't check.
Everything below was executed. Raw output is committed beside this file
unfiltered: `stale-ui-1305.out`, `dom-1305.out`, `/tmp/rt1305-out/dom-1305.json`
copied here as `dom-1305.json`.

## The rig — named, because r808 says a number without its rig is worthless

| | |
|---|---|
| worktree API | **fresh** `scripts/checks/serve-v3-7798.ts` on **:7796**, started 04:03:40 from HEAD `5062ca4` |
| web | isolated copy `/tmp/rt1305-web` (rsync, symlinked node_modules), `next build` with `FORGE_CONTROL_URL=http://127.0.0.1:7796`, `next start -p 7799` |
| never touched | production, `/opt/forge-ai-os`, `forge-control-web/.next`, ports 7791/7793/7794/7795/7798 (other rounds) |

`forge-control-web/.next` was **not** rebuilt in place. `git status --short`
after every run shows only this directory.

**:7798 IS STALE — see finding F2.** It still serves `task.id`. Every number
here comes from :7796.

## What was attacked, and what happened

| # | Attack | Result |
|---|---|---|
| 1 | **Stale UI after memoization** — 16 single-field mutations through `replaceEqualDeep` (react-query's own structural-sharing function) on the real 114-node payload, plus a DOM-level `page.route()` rewrite between polls | **HELD.** 56/56 assertions. Every mutated row got a new wrapper and the new value; every unrelated wrapper was reused |
| 2 | **Windowing** | **NOT SHIPPED.** `ChatTeamPanel.tsx:432` renders `rows.map(...)` unwindowed. DOM census = 114 rows = 114 nodes, exactly, before and after a fast scroll to the bottom and back. No spacers, no lost rows, no duplicate ids, depths byte-identical |
| 3 | Rapid cross-surface hover | **NOT RUN** — see "not run", below |
| 4 | Live SSE streaming | **NOT RUN** — see "not run", below |
| 5 | **60+ row panel, and the edge states** | **HELD.** 114 rows. `data-team-state` = `ready` → `empty` → `ready` under intercepted payloads, never blank, always with copy. Dismiss → `1 hidden · show` → restore returns all 114 at the original depth. ✕ keyboard-reachable (`:focus-within` → opacity 1) in **both themes** |
| 6 | **Does the sweep actually hover rows?** | **BROKEN — F1** |
| 7 | **Attack the measurement** | Mixed: F2, F3. Poll cadence unchanged (`TEAM_POLL_MS = 6_000`, no `refetchInterval` in the diff). Instrument temp-path hygiene holds |
| 8 | **Payload trim over-reach** | **HELD.** Only `task.id` was removed. No reader anywhere in `forge-control-web/app/`, `scripts/checks/`, or any instrument's `jq`; the only hits are the docs that record the removal. `tsc` clean in both repos |

### Not run, and why

Attacks 3 and 4 (rapid cross-surface hover for 30 s; the same on top of a live
SSE stream) were **not executed**. Hover-as-cause is closed by the brief, the
ambient floor on this VPS is 50–60 ms long tasks with the pointer parked, and a
number produced by the sweep would inherit **F1** — the sweep cannot prove it
hovered rows. Running it before F1 is fixed would manufacture exactly the kind
of evidence this round exists to catch. Stated here rather than quietly skipped.

---

## F1 — `hoverProbesAllPassed: true` does not mean the sweep hovered a row

`docs/plan/artifacts/phase1290/hover/hover-1291.cjs:234`

```js
pass: Boolean(sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML"),
```

`teamRowHovered` is computed one line above (`:225`) and **is not in `pass`**.
A swept coordinate that lands on any non-body element — a plan-Kanban card, a
header, a gap between rows after a reflow — passes.

It is not hypothetical. In the committed artifact
`docs/plan/artifacts/phase1290/hover/hover-1291.json`, on the **team** surface:

```
run1/team cross=5  teamRow=true  pass=true   (5 pairs)
run1/team cross=40 teamRow=FALSE pass=true   (5 pairs)   ← hovered "Phase 2 review — kind truth (R7-R11…"
run1/team cross=90 teamRow=true  pass=true   (5 pairs)
run2/team cross=40 teamRow=FALSE pass=true   (5 pairs)
```

10 of 10 pairs. `hoverProbesAllPassed` is `true` for every one of those runs.
Reproduced live on the shipped build in `dom-1305.out` run 1: box 0,
`teamRowHovered: false`, `pass: true`.

**Fix:** put `teamRowHovered` (and the rail's equivalent row selector) into
`pass`, per surface. Then correct any prose that cites `hoverProbesAllPassed`
as proof the sweep hit rows.

## F2 — the `:7798` harness every round is told is "ALREADY UP" is 12 h stale

`docs/plan/artifacts/phase1290/hover/README.md` §7 step A:

> `# A) worktree API on :7798 — ALREADY UP.`

The process holding :7798 started **2026-08-16 16:10:39**, hours before round
1302's commits. It still ships the field round 1302 deleted:

```
$ curl -s 127.0.0.1:7798/api/chat/bfd1283a-…/team | jq '.workers[0].task'
{ "id": "4a896cc1-…", "round": 0, "role": "architect", … }     ← task.id, still there

$ curl -s 127.0.0.1:7796/api/chat/bfd1283a-…/team | jq '.workers[0].task'
{ "round": 0, "role": "architect", … }                          ← fresh, from the same worktree
```

Round 1302's own AFTER artifact (`payload/team-payload-after.json`) has **no**
`task.id`, so the builders did use a fresh server — their evidence stands. The
hazard is forward: the reproduce block tells the next round to trust a server it
did not start.

**Fix:** §7 step A must verify freshness, not liveness — e.g.
`curl -s :7798/api/chat/$CHAT/team | jq -e '.workers[0].task|has("id")|not'`, or
start a private instance with `SERVE_V3_PORT`.

## F3 — `buildShaUnderTest` cannot answer "did they measure what they shipped"

`payload/lattice-1302.json` records `buildShaUnderTest = b3bd80f` for run1/run2
(01:24Z / 01:28Z). `b3bd80f` is the *research* commit; the fix landed as
`92aeb0f` at 01:39Z. The field's own `shaNote` admits it: *"git rev-parse HEAD
of the worktree that was rsynced and built; not a hash of the build output."*
With uncommitted work in the tree — the normal case — the recorded SHA names a
build that was never measured.

Nothing here is proven wrong: the AFTER payload artifact demonstrably came from
trimmed code, and this round re-verified the trim end to end on HEAD. But the
provenance field does not carry the weight the artifacts lean on it for.

**Fix:** record `git status --porcelain` (or a hash of the rsynced tree) beside
`buildShaUnderTest`.

---

## Reproduce

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# fresh worktree API on a free port (ss -ltn first)
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
(cd forge-control && SERVE_V3_PORT=7796 nohup ./node_modules/.bin/tsx \
   ../scripts/checks/serve-v3-7798.ts > /tmp/rt1305-api.log 2>&1 &)

# attack 1 — no browser needed
TEAM_API=http://127.0.0.1:7796 npx tsx docs/plan/artifacts/phase1300/redteam/stale-ui-1305.ts

# attacks 2/5/6 — isolated build, never forge-control-web/.next
rm -rf /tmp/rt1305-web && mkdir -p /tmp/rt1305-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/rt1305-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/rt1305-web/node_modules
(cd /tmp/rt1305-web && FORGE_CONTROL_URL=http://127.0.0.1:7796 NODE_ENV=production \
   ./node_modules/.bin/next build)
# cookie: hover/README.md §7 step C, then
(cd /tmp/rt1305-web && AUTH_URL=http://127.0.0.1:7799 FORGE_CONTROL_URL=http://127.0.0.1:7796 \
   AUTH_SECRET="$AUTH_SECRET" ./node_modules/.bin/next start -p 7799 &)

export FORGE_SESSION_COOKIE="$(cat /tmp/rt1305-cookie.txt)"
RT_BASE_URL=http://127.0.0.1:7799 RT_API_URL=http://127.0.0.1:7796 \
  node docs/plan/artifacts/phase1300/redteam/dom-1305.cjs
```

Both scripts write only to `/tmp/rt1305-out` unless `RT_OUT` says otherwise.
`git status --short` after a full reproduce shows nothing under `docs/plan/`
modified.

## Instrument self-corrections, recorded rather than hidden

Two assertions in the first draft of each script failed for the script's own
reasons, not the app's. Both are named here because a red team that quietly
edits its instrument until it goes green is doing the thing it was sent to find.

1. `stale-ui-1305.ts` picked its mutation target as "first node with a task and
   a parent" — which is the already-`completed` manager. `status → "completed"`
   on a completed node is a no-op, `replaceEqualDeep` returns the identical
   object, and the wrapper is correctly reused. Fixed by requiring
   `!n.settled`, and the same trap caught `task.role → "reviewer"` on a node
   whose role already was `reviewer`.
2. `dom-1305.cjs` first asserted keyboard reach on the **last** row, whose ✕ is
   `disabled` by design (`TeamRow.tsx:543` — a running row's ✕ is terminate,
   and terminate is capability-gated). A disabled button is unfocusable by HTML
   rule, not by defect. Fixed to target the last row with an enabled ✕. It also
   swept boxes below the fold; those hover nothing, and hover-1291's probe
   correctly reports `pass: false` for them — that failure mode it does catch.
