# Round 603 — OrientationStrip (U22) + story-so-far digest (U24)

Phase 600, `10-ui-v3-spec.md` Addendum + `13-ui-v3-architecture.md §8`. What
landed, how to re-run every gate, and the two places where the brief and the
data disagreed.

---

## 1. Files

| File | Status |
|---|---|
| `forge-control-web/app/desktop/chat/OrientationStrip.tsx` | new |
| `forge-control-web/app/desktop/chat/StorySoFar.tsx` | new |
| `forge-control-web/app/desktop/chat/AgentChatView.tsx` | modified (mounts both) |
| `scripts/checks/check-orientation.ts` | new — 68 assertions, plain tsx |
| `docs/plan/artifacts/phase600/capture-orientation.ts` | new — offline both-theme capture |

Nothing else. `AssistantThread.tsx`, `thread-mapping.ts`, `ChatSurface.tsx` and
`app/desktop/team/*` are byte-identical to `f3634d1` — `git status --porcelain`
lists no file matching the NFU5 forbidden set.

## 2. The one deviation from the brief, stated up front

The brief said to read `["chat-team", chatId]` with `useQuery` so react-query
dedupes into ChatTeamPanel's existing poll. **That is not reachable from this
file list.** The key is scoped by CHAT id; `AgentChatView` is handed
`frame`/`stack`/`live`/`onBack`/`backLabel` and nothing else, and the only place
`chatId` (`selId`) exists is `ChatSurface.tsx`, which this round must not touch.

So the strip OBSERVES the panel's query instead of declaring its own:

```ts
queryClient.getQueryCache().findAll({ queryKey: ["chat-team"], type: "active" })
```

`type: "active"` is react-query's own predicate for "at least one mounted
observer has this query enabled" — i.e. exactly "the team panel is open and
polling". The strip reads `state.data` off the query object and subscribes to
the cache for change notifications. **There is no fetcher in the file**, so the
requests-per-minute round 604 measures cannot move: the strip adds zero.

Two properties this bought that a `useQuery` would not have:

- **The tree is matched, not trusted.** `findTeamNode` only accepts a tree that
  actually contains this node — a session by run id, a sub-agent by
  `tool_use_id` **and** `parent_id`. A tree for another chat, or one fetched
  before this worker existed, cannot lend it a task title.
- **A query nobody is refreshing is not a value.** When the Team tab is closed
  `enabled` goes false, the query goes inactive, and the strip degrades to
  `team-not-polling` rather than rendering the response it happens to remember.
  That is NFU6 enforced by react-query's own bookkeeping.

The second deviation is smaller: the header's identity line (kind · role · model
· description) MOVED into the strip rather than being duplicated by it. The
601B e2e harness reads `[data-agent-role]` / `[data-agent-model]` document-wide;
there is still exactly one of each, and the header keeps what is genuinely
navigation (back button + crumbs).

## 3. What the strip renders, and from where

| Field | Source | Degrades to |
|---|---|---|
| kind (`session` / `sub-agent`) | `frame.subagentId !== undefined` | never — always known |
| role, model | `metadata.role` / `metadata.model_resolved`; for a sub-agent its `subagents_v2[]` entry, else its spawn call. Through `roleLabel` / `modelDisplay` | `—` |
| task title, round | `["chat-team"]` node's `task` | run description (marked as such), then `no title`; `round —` |
| `currently:` / `ended:` | `metadata.current_activity`; for a sub-agent its `latest_activity` | `not recorded` |
| plan position | `floor(task.round / 100) * 100`, `+100` for next | line omitted |

`ended:` rather than `currently:` for a settled node is Definition of Done #1 in
the strip: the executor freezes `current_activity` at settlement, and a frozen
activity announced in the present tense is the same lie as a growing timer.

**Every degraded state has a named, muted line** — `DegradeReason` is a closed
union of five and `check-orientation.ts` asserts each is reachable, has text,
and carries neither a task nor a plan. A node with no task gets no plan line at
all; there is nowhere in the file for an invented phase to come from.

## 4. What the digest renders

`StorySoFar` is a renderer over 601A's `deriveDigest`. No request, no query
hook, no model in the render path (`13 §8`'s explicit anti-goal) — the grep in
§5 is the gate, not a promise. Collapsed by default; absent entirely below
`DIGEST_MIN_ENTRIES` (50).

Three labelling decisions, all of them about not over-claiming:

- `error_count` reads **"tool errors"**, never "failures" — `digest-gap.md §4`
  measured all three on the reference run and all three were routine and
  recovered from; the run completed.
- A sub-agent slice shows **"all its own"** instead of the own/delegated split.
  Every entry in a slice carries `parent_tool_use_id` by construction, so
  `top_level_count` is 0 — "0 its own, 118 delegated" over a scout's own 118
  entries is a mislabel produced by a definition, not by the data.
  > **Superseded in round 606.** The reasoning was right and the mechanism was
  > wrong, in a way that made it fire on the wrong input. The drilled view does
  > not render a pure slice: it renders `subagentTranscript`, the sub-agent's
  > entries **plus the spawn/result envelope**, and those two are top-level, so
  > the label branched on `prose_scope` and picked the split anyway — printing
  > "2 its own, 118 delegated" for the same scout. `deriveDigest` is now *told*
  > the owner id and computes the split from it: the scout reads
  > **120 entries · all its own · 0 delegated**. "All its own" is now what the
  > arithmetic says rather than a label chosen to cover for it, and it steps
  > aside if a sub-agent ever does delegate. See [README-606.md](README-606.md).
- A sub-agent gets **no time line**. `synthesizeSubagentRun` hands it the
  parent's timestamps deliberately (an in-process Task call has no run row);
  restating them under the child's name would read as the child's duration.

The expanded footer names `docs/plan/artifacts/phase600/digest-gap.md` as
selectable text rather than a link: nothing serves repo docs to the browser
today (the doc endpoint is phase 700's), and an anchor that 404s is a worse
pointer than a path you can open.

## 5. Gates — every one of these was run

```bash
cd forge-control      && npx tsc --noEmit          # clean
cd forge-control-web  && npx tsc --noEmit          # clean
cd forge-control-web  && NODE_ENV=production pnpm build   # green, 9/9 pages

# zero hardcoded colour (NFU1) — exit 1, no output
grep -rnE '#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(' \
  app/desktop/chat/OrientationStrip.tsx \
  app/desktop/chat/StorySoFar.tsx \
  app/desktop/chat/AgentChatView.tsx

# no network in the digest — exit 1, no output
grep -n 'fetch\|useQuery' app/desktop/chat/StorySoFar.tsx

# NFU5 — no forbidden file in the working tree
git status --porcelain | grep -E \
  'AssistantThread|thread-mapping|ChatSurface|desktop/team/|FileExplorerPanel|VaultFileList|routes/files|project-tick|cc-runner|executor\.ts|db/projects'
```

Unit checks, all `ALL PASS` (run from `forge-control-web`, tsx from
`../forge-control/node_modules/.bin/tsx`):

```
check-orientation      ALL PASS — orientation strip derivation      (new, 68 assertions)
check-story-digest     ALL PASS — story-so-far digest
check-subagent-slice   ALL PASS — sub-agent slicing
check-tool-summary     ALL PASS — tool summary table
check-thread-mapping   ALL PASS — scoped thread mapping (U23)
check-nav-stack        ALL PASS — nav stack (U20/U21)
check-team-rows        ALL PASS — team row model
check-duration         ALL PASS — duration helpers
check-classify         ALL PASS — agent-kind classifier
```

`check-orientation.ts` covers the four things that can actually go wrong:
phase arithmetic (`601→600`, `700→800`, and `null` for `-1 / 1.5 / NaN /
Infinity`), node matching (the same `tool_use_id` under a different parent does
NOT match), every `DegradeReason`, and the four activity kinds from
`round-599-4d8679b2.md` §"Current Activity Taxonomy" — including the observed
trap where the executor puts the tool name in `text` as well, which must not
render "calling Bash — Bash". It finishes against the real 285-entry capture.

## 6. Both themes — offline, and every state

```bash
cd forge-control-web
../forge-control/node_modules/.bin/tsx ../docs/plan/artifacts/phase600/capture-orientation.ts
```

Writes `capture-orientation.html` plus four PNGs:
`phase600-orientation-{dark,light}.png`, `phase600-digest-{dark,light}.png`.

`capture-nav.cjs` (round 601B) drives the real surface, which needs a Next
server and an API pointed at the live database — out of bounds for a build
task, and useless here anyway: the strip's interesting states are the degraded
ones, which a live capture can only reach by breaking something live. So the
components render themselves to static HTML against the real `app/theme.css`
and `app/globals.css`, and chromium photographs both palettes. Seven strip
states (running, settled, sub-agent, and the four degraded ones) and three
digest states (collapsed, expanded, sub-agent scope) are on the record.

That is what `OrientationStripView` was split out for: the half holding the
react-query hook cannot render without a live QueryClient; the half that draws
pixels takes `PlanFacts` as a prop and renders anywhere.

The digest screenshots agree with `check-story-digest.ts` and `digest-gap.md`
number for number: 285 entries · 89 its own · 196 delegated · 136 tool calls ·
3 tool errors · 2 sub-agents (Explore); the scout's slice 118 · 58 · 1 · 0.

## 7. Layout budget

Header (back + crumbs) 1 line · strip 2 lines · digest 1 line collapsed. The
`Note` helper in `AgentChatView` gained a `tight` variant so the sub-agent slice
note is 7px/14px instead of 20px/28px — three stacked blocks at the old padding
would have pushed the transcript down the page, which is the one hard layout
rule U22 states.

## 8. Left for round 604

- Sample `currently:` twice ≥20s apart on a live worker and diff against
  `GET /api/chat/:id` — the strip is wired to the detail query's refetch, so the
  line moves when the metadata does, and nothing in it animates on its own.
- Re-derive every digest number independently.
- Requests/minute with the strip mounted vs `f3634d1`. The prediction is: no
  change. There is no fetcher in either new file.
