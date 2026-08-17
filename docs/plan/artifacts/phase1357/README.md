# Round 1357 — the shared sentence that stopped being true when it was shared

Round 1356's re-review returned **NEEDS_FIXES** on three points: one regression
the previous fix cycle introduced on its own initiative, one gate that had
already been fixed by the time the review landed, and one incomplete
disclosure. This is the evidence for all three, in the reviewer's order.

---

## Finding 1 (blocking) — `DISMISSED_TOGGLE_TITLE` named the panel it was rendered in

**The defect.** Round 1356 was told to stop the chat team panel's
`N hidden · show` control from silently calling `restoreAll`. It fixed that,
and it went further: it hoisted the affordance's whole vocabulary into
`app/desktop/team/peek.ts` so the two surfaces could not drift again. That was
the right instinct — for every string except one.

The toggle's tooltip is not a label. Its job is to answer a question the
operator cannot answer by looking: *where else does this dismissal apply?* It
does that by naming a panel. So it is the one string in `peek.ts` that MUST
read differently on the two surfaces, and the extraction gave both of them the
chat panel's wording:

```
the set is shared with the Live panel.
```

Rendered in `AgentActivity.tsx:792` — which **is** the Live panel. Konrad
hovers it in `/live` to find out where his dismissals reach, and learns that
they reach the panel he is standing in. Before the extraction
(`git show b3995f3:forge-control-web/app/desktop/live/AgentActivity.tsx`, line
793) that file carried its own correct string: `"…shared with the chat team
panel."` A true sentence was replaced by a vacuous one, on the single control
that round existed to stop lying.

### The fix — the surface is a parameter

`forge-control-web/app/desktop/team/peek.ts`:

```ts
export const DISMISSAL_SURFACES = {
  live: "the Live panel",
  team: "the chat team panel",
} as const;

export type DismissalSurfaceName =
  (typeof DISMISSAL_SURFACES)[keyof typeof DISMISSAL_SURFACES];

export function dismissedToggleTitle(otherSurface: DismissalSurfaceName): string {
  return (
    "Show the rows dismissed from this panel. Dismissing hides a row; it never " +
    `deletes anything, and the set is shared with ${otherSurface}.`
  );
}
```

Each panel passes the OTHER one:

| Rendered in | Call | Reads |
|---|---|---|
| `live/AgentActivity.tsx:796` | `dismissedToggleTitle(DISMISSAL_SURFACES.team)` | `…shared with the chat team panel.` |
| `team/ChatTeamPanel.tsx:696` | `dismissedToggleTitle(DISMISSAL_SURFACES.live)` | `…shared with the Live panel.` |

The union type means a third surface cannot be named by a typo; `tsc` rejects
anything that is not one of the two panels that actually share the store.

`restoreAllTitle()` now builds its "elsewhere" from `DISMISSAL_SURFACES.live`
too. That one is *correctly* fixed — `ChatTeamPanel.tsx` is its only caller, so
the panel it names as elsewhere can only ever be `/live` — but reading the name
from the same constant stops the two sentences drifting apart in wording.

### The check, and the negative control that proves it works

`scripts/checks/check-dismiss-peek.tsx` gained a fourth section. It does not
assert on the constant — the defect was in *which argument each panel passes*,
and only the JSX carries that. So it slices each toggle out of its file by its
`data-` attribute, reads the argument out with a regex, and resolves it:

```
── the tooltip names the OTHER panel ────────────────────────
PASS  /live: its toggle's title comes from dismissedToggleTitle()
PASS  /live: …passing the other surface
PASS  /live: …and never naming itself — THE round-1356 regression
PASS  /live: hand-writes no copy of the sentence
PASS  team panel: its toggle's title comes from dismissedToggleTitle()
PASS  team panel: …passing the other surface
PASS  team panel: …and never naming itself — THE round-1356 regression
PASS  team panel: hand-writes no copy of the sentence
PASS  the sentence still says dismissing never deletes
PASS  …and the two readings differ
PASS  the /live reading names the chat team panel
PASS  the team panel's reading names the Live panel

ALL PASS — dismissal peek affordance
```

A check that has never been seen to fail is not evidence. So the exact defect
was re-introduced and the check re-run:

```
$ sed -i 's/dismissedToggleTitle(DISMISSAL_SURFACES.team)/dismissedToggleTitle(DISMISSAL_SURFACES.live)/' \
    forge-control-web/app/desktop/live/AgentActivity.tsx
$ tsx ../scripts/checks/check-dismiss-peek.tsx | tail -1
2 FAILURE(S) — dismissal peek affordance
NEGATIVE_EXIT=1
```

Two, not one: `…passing the other surface` and `…and never naming itself` both
fire, from opposite directions. The file was restored from a copy taken before
the edit and `git diff --stat` confirmed only the intended six-line change
remained.

The "hand-writes no copy of the sentence" assertion is anchored on the
tooltip's own clause (`the set is shared with`) rather than on the word
*shared*. Both files legitimately say **in prose comments** that the dismissal
store is shared with the other panel (`AgentActivity.tsx:40,690`), and a check
that forbade that would be forbidding the truth. The first draft of this
assertion did exactly that and failed on those two comment lines; it was
narrowed rather than the comments deleted.

---

## Finding 2 (blocking) — gate 8 `dollar-sweep.sh` RED at `8c0f9f6`

**Already closed at HEAD, one commit after the reviewed one.** The review was
run against `8c0f9f6`. `1c0c23e` — round 1356's own commit, landed after the
review started — extends `scripts/checks/dollar-allowlist.txt:41` from

```
usd|USD|eur_per_usd|€|shadow|spent
```

to

```
usd|USD|eur_per_usd|€|shadow|spent|spend_log
```

with the reason the file's format expects: the two additions are header
comments naming the **source table** the bucket's turn count comes from, not a
rendered amount. The reason line explicitly records that the bare word `spend`
is still not allowlisted in `UsagePanel.tsx`, so a real spend value arriving in
that file still fails the gate — which is narrower than the reviewer's
suggested fix and keeps the gate's teeth.

Re-recorded at this round's HEAD, in a clean detached checkout:

```
primary gate: 95 hit(s), all allowlisted.
dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.
DOLLAR=0
```

And the whole battery under the flag the script's own footer requires:

```
$ bash scripts/checks/gates-808.sh --strict
 RED: 0
GATES=0
```

All 25 gates: 22 green, 2 documented SKIPs (23, 24), 0 red.

---

## Finding 3 (non-blocking) — the disclosure listed three scripts and there were four

`docs/plan/artifacts/phase1355/README.md` now says **four**, and the list is no
longer hand-assembled: it is the full output of
`grep -rn "data-team-restore" docs scripts`, minus this phase's own scripts and
`scripts/checks/`, both of which are already on the new contract. The addition:

* `../phase1300/redteam/dom-1305.cjs:252-254` — A7 does
  `page.locator("[data-team-restore]").first()` and asserts `/^\s*1 hidden/` on
  its text. That is the old footer contract exactly; under the new one the
  selector resolves to a per-row `↺` that does not exist until the operator
  peeks and carries a glyph rather than a count.

`phase500/dismiss-persist.cjs`'s line list was also completed (205, 208, 240,
243, 248, 250, 253, 263, 264 — the original note gave three of nine). And one
mention the sweep turned up that is *not* a script: `phase500/README.md:306`
records `[data-team-restore] appears reading "1 hidden · show" | ok` in a
results table. It is a true account of what phase 500 saw and stays as written;
the README now says so rather than leaving a reader to wonder why it was
skipped.

---

## Everything that was run

Isolated **detached** checkout of this round's HEAD (`git worktree add
--detach`, `node_modules` symlinked, source untouched). Not optional this time:
the first two `next build` runs in the shared project worktree died on
`ENOENT … pages-manifest.json` and `… _not-found/page.js.nft.json`, and `ps`
showed a sibling task's `next build` (pid 2000503) writing the same `.next`
concurrently. Nothing was wrong with the code; two builds were clobbering one
output directory.

| Check | Result |
|---|---|
| `forge-control && npx tsc --noEmit` | `TSC_API=0` |
| `forge-control-web && npx tsc --noEmit` | `TSC_WEB=0` |
| `forge-control-web && NODE_ENV=production next build` | `BUILD=0` |
| `gates-808.sh --strict` (25 gates) | `RED: 0`, `GATES=0` |
| `dollar-sweep.sh` (gate 8) | `PASS — 95 hits, all allowlisted` |
| `check-dismiss-peek.tsx` (gate 14) | `ALL PASS` |
| `check-dismiss-peek.tsx`, defect re-introduced | `2 FAILURE(S)`, exit 1 |
| `pnpm test` — forge-control (gate 20) | `0` |
| `no-raw-colours.cjs` (gate 5) | `0` |
| forbidden-file diff `main...HEAD` (gate 6) | `0` |
| `check-thread-mapping.ts` | `ALL PASS — scoped thread mapping (U23)` |
| `check-tool-summary.ts` | `ALL PASS — tool summary table` |
| `check-subagent-slice.ts` | `ALL PASS — sub-agent slicing` |
| `check-story-digest.ts` | `ALL PASS — story-so-far digest` |
| `check-chat-rich.tsx` | `PASS — 222/222 assertions` |

The temporary worktree was removed afterwards.

**Both themes:** the change is one tooltip string and one type. It renders no
colour, and gate 5 (`no-raw-colours.cjs`, whole app) is green — the same
evidence round 1355's theme pass rested on. No new capture was warranted for a
sentence.
