# Surfaces ↔ main reconciliation — round 9

Workstream `surfaces`, worktree `7851068b-…--surfaces`, branch
`project/7851068b-surfaces`. Task: reconcile the two files that still
conflicted with `main` before phase 7 integration.

## 1. Probe before

```
$ git log --oneline -1 main
9c3f63a merge: cheaper verification — review only what can break, Sonnet by default

$ git merge-tree --write-tree --name-only main project/7851068b-surfaces
ba136898372cdda7f0787244a64894361b7e5b0a
forge-control-web/app/desktop/DesktopApp.tsx
forge-control-web/app/desktop/nav-items.ts

Auto-merging forge-control-web/app/desktop/DesktopApp.tsx
CONFLICT (content): Merge conflict in forge-control-web/app/desktop/DesktopApp.tsx
Auto-merging forge-control-web/app/desktop/nav-items.ts
CONFLICT (content): Merge conflict in forge-control-web/app/desktop/nav-items.ts
exit=1
```

Still exit 1, still exactly the two files the phase-7 planner measured. My
sibling task 434457f3 ("GOALS is built — retire the stale determination") had
already run and touched `DesktopApp.tsx` (its declared file), but did not
touch `nav-items.ts` — so the merge was not resolved by it. Proceeding to
merge as the owning lane.

## 2. What was actually conflicting, and why

`main` never has the `unbuilt` marker concept at all — `NavItem.unbuilt`,
`unbuiltNavKeys()`, `UNBUILT_NAV_KEYS` are round-300 additions that exist only
on this branch. `main`'s only change near these lines is `553fa38`
("Goals/Tasks daily surface — commit the work that was already live"), which:

- shipped a real `GoalsSurface` component and wired
  `surface === "goals" && <GoalsSurface />` into `DesktopApp.tsx`'s render
  switch,
- renamed the nav label for `goals` from `"GOALS"` to `"GOALS/TASKS"` — the
  name used consistently across `GoalsSurface.tsx`, `docs/spec-daily-goals.md`,
  `goals/ui.tsx` and `goals/quick-add.test.ts`'s own doc comments, and
- left `DesktopApp.tsx`'s pre-round-300 `PLACEHOLDER_SURFACES` object
  untouched — the old ten-entry version, five of whose keys (`chat`,
  `pipeline`, `skills`, `memory`, `autonomy`) describe surfaces that have been
  built for months, gated behind seven `surface !== …` exclusion clauses.

This lane's round-300 rewrite (commit `08a5ce6`) replaced that ten-entry
object with a four-entry one (`journal`, `map`, `library`, `search`) driven by
the new `PlaceholderKey` type and `isPlaceholderKey()` guard, and round 8
(`742a34c`) retired `goals` from the `unbuilt` flag in `nav-items.ts` and from
the placeholder record — but had no `GoalsSurface` in this worktree to render
in its place, since that component only ever existed on `main`.

## 3. Resolution, per surface

**GOALS — `main` wins, unmodified.**
`nav-items.ts`: kept `main`'s `{ key: "goals", label: "GOALS/TASKS", group:
"recall" }` (no `unbuilt` flag) — the label main renamed to match the shipped
feature's name everywhere else in the codebase.
`DesktopApp.tsx`: kept `main`'s `{surface === "goals" && <GoalsSurface />}`
render line verbatim, placed immediately before the `isPlaceholderKey(surface)`
block. No conflict is possible between the two: `PlaceholderKey` is
`"journal" | "map" | "library" | "search"` and never included `"goals"`, so
the two clauses cannot both fire for the same surface.

**JOURNAL, MAP — this lane wins, unmodified.**
`nav-items.ts`: kept `{ key: "journal", …, unbuilt: true }` and
`{ key: "map", …, unbuilt: true }` — both are still genuinely unbuilt
(phase 3, R37–R43); `main` never marked them because `main` has no `unbuilt`
concept, not because it disagreed.

**LIBRARY — this lane wins (not itself in conflict, but the record it lives in
was).** `DesktopApp.tsx`'s `PLACEHOLDER_SURFACES`: kept this lane's round-300
four-entry version (with the honest `library` copy describing the artefact
store, `state: "unbuilt"`) and discarded `main`'s stale ten-entry version
entirely — `main`'s five now-built keys (`chat`, `pipeline`, `skills`,
`memory`, `autonomy`) were dead copy that round 300 had already reasoned
about and deleted for exactly this reason.

**Infrastructure — this lane's, kept in full.** `unbuiltNavKeys()`,
`UNBUILT_NAV_KEYS`, the `unbuilt?: true` field and its doc comment on
`NavItem` all came only from this branch; `main` had nothing to contribute
here and nothing was discarded.

## 4. §10 — Undeclared writes

**`forge-control-web/app/desktop/DesktopApp.tsx`** — declared as sibling task
434457f3's file, not this task's. It was force-touched because the merge put
conflict markers directly in it (it's one of the two files the phase-7
planner measured as conflicting) and a merge commit cannot land with
unresolved markers in either conflicting path. Changes made, beyond marker
removal:

1. Resolved the `PLACEHOLDER_SURFACES` conflict (line ~74–222 pre-merge): kept
   this lane's round-300 four-entry record, discarded `main`'s stale
   ten-entry one. Mechanical — no new prose, just picked a side.
2. Resolved the render-switch conflict (line ~492–519 pre-merge): combined
   `main`'s `{surface === "goals" && <GoalsSurface />}` line with this lane's
   `isPlaceholderKey(surface)` block, and rewrote the two comments that
   preceded each side (the "Round 300" comment above the render switch, and
   the "ROUND 8: GOALS RETIRED" comment above `PlaceholderKey`) because both
   asserted, in prose, that "this branch has no GoalsSurface to import" and
   that the integration merge would bring it in later — false the moment this
   merge landed it. Left factually wrong comments in a file I was already
   touching read as worse than fixing them in the same commit.

No other file in `DesktopApp.tsx` was touched — everything else in the merge
commit's diff for this file is `main`'s own non-conflicting hunks (new
imports, `GoalsSurface` import line, unrelated additions from `main`'s other
7 commits), applied by git's automatic merge, not authored by this task.

**Everything else in the merge commit's file list** (`db/migrations/
0042_daily_goals.sql`, `docs/spec-daily-goals.md`, `forge-control/src/db/
daily.ts`, the `goals/` component tree, etc. — 26 files) is `main`'s own
`553fa38` commit, brought in by git's non-conflicting auto-merge. None of it
was authored, edited, or reviewed by this task; it is `main`'s content
arriving because `main` was merged in, not an undeclared write.

## 5. Probe after

```
$ git merge-tree --write-tree --name-only main project/7851068b-surfaces
405e6799c2889486a1c27afa4254be819089c284

$ echo exit=$?
exit=0
```

Single line of output (the resulting tree SHA), no conflicting paths listed.

## 6. Proof — check-phase3-placeholders.ts, including the negative control

Real run, from `forge-control/`:

```
$ ./node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
    ../scripts/checks/check-phase3-placeholders.ts
...
ALL PASS — phase 3 placeholders (R40)
```

Includes `§1a: the flip: GOALS re-marked unbuilt is caught` — PASS on all four
of its assertions, run against the real (merged) `NAV`.

Negative control, run separately, against a scratch copy of the check with
`EXPECTED_UNBUILT` changed to re-include `"goals"` (i.e. simulating "the
determination was never retired") while the real, merged `GoalsSurface` still
exists in `NAV`/`DesktopApp.tsx`:

```
$ sed -i 's/\["journal", "library", "map"\]/["goals", "journal", "library", "map"]/' \
    /tmp/negctl-check.ts   # scratch copy, not committed
$ cp /tmp/negctl-check.ts scripts/checks/check-phase3-placeholders.ts
$ ./node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
    ../scripts/checks/check-phase3-placeholders.ts
FAIL  NAV marks exactly journal, library, map
        expected ["goals","journal","library","map"]
        actual   ["journal","library","map"]
FAIL  …and LIBRARY, the one Konrad called empty
        expected ["library"]
        actual   ["goals","library"]
... (7 FAILURE(S) total)
7 FAILURE(S) — phase 3 placeholders (R40)
```

The check fails loudly the moment "goals" is asserted as unbuilt while
`GoalsSurface` exists — the guard is not vacuous. The file was restored
immediately after with `git checkout -- scripts/checks/check-phase3-
placeholders.ts` (confirmed clean, zero diff) and the real check re-run to
confirm `ALL PASS` before committing.

## 7. Proof — typecheck

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 914ms using pnpm v9.15.9
$ ls node_modules/.bin/tsc && echo "tsc present"
node_modules/.bin/tsc
tsc present
$ npx tsc --noEmit
(no output — clean)
```

`typescript`/`tsc` present throughout (the pruning failure mode this fleet has
been bitten by before did not occur — `pnpm install` reported "Already up to
date" honestly, not falsely, and `tsc` resolved).

## 8. Commit

```
823db93 merge(phase7): reconcile surfaces with main — GOALS wins, JOURNAL/MAP/LIBRARY stay unbuilt
Merge: 742a34c 9c3f63a
```

## 9. Write-set

Declared: `forge-control-web/app/desktop/nav-items.ts`,
`docs/plan/artifacts/os-usable-for-work/phase7/surfaces-main-reconciliation.md`.

Undeclared, disclosed above (§4): `forge-control-web/app/desktop/DesktopApp.tsx`
— forced by the merge, sibling task 434457f3's declared file, two
conflict-marker resolutions plus two comment corrections, no other changes.

All remaining files touched by the merge commit are `main`'s own `553fa38`
content, applied by git's automatic (non-conflicting) merge — not authored by
this task.
