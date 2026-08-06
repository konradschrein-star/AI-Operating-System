# Round 606 — fix cycle 1 for round 605's review

Four defects, all four fixed, none of them requiring new plumbing. Two were
application bugs in the story-so-far digest, one was a doc comment that
described the opposite of its own code, one was a stale sentence in round 601B's
README. Nothing outside those four areas changed behaviour.

`/opt/forge-ai-os` was never opened. No pm2 service was touched. No live
endpoint and no live database was read: everything below runs out of this
worktree against the phase's committed fixture.

---

## 1. What changed

| File | Change |
|---|---|
| `forge-control-web/app/desktop/chat/subagent-slice.ts` | `parseSpawnInput` (the one client reader of a spawn's `input`), `spawnRoles` (spawn id → declared role), and `subagentTranscript` (moved here from `AgentChatView`). `spawnToolUseIds` is now `spawnRoles`' key set, so the two cannot drift. |
| `forge-control-web/app/desktop/chat/story-digest.ts` | `deriveDigest(run, thread, ownerToolUseId?)`. The owner is **told**, not inferred; own-vs-delegated and the roster are computed from it; roles fall back to the spawn call; new `owner_tool_use_id` field. |
| `forge-control-web/app/desktop/chat/StorySoFar.tsx` | `scope` is now the discriminated union `StoryScope`, so a sub-agent block cannot be rendered without the id it needs. Count tooltips rewritten to match the new definitions. |
| `forge-control-web/app/desktop/chat/AgentChatView.tsx` | Passes the scope union; imports the moved/shared helpers; the `subagentRunStatus` doc comment now describes what the code does. |
| `scripts/checks/check-story-digest.ts` | Real `subagentTranscript` input on the fixture; owner-threading section; role-fallback section; cross-surface section importing the server's own `foldSubagents`. |
| `scripts/checks/check-subagent-slice.ts` | Coverage for `parseSpawnInput`, `spawnRoles`, `subagentTranscript`, and `sliceOwnerId`'s blind spot. |
| `docs/plan/artifacts/phase600/capture-orientation.ts` | The sub-agent capture now renders the input the app renders (`subagentTranscript`), not a hand-cut pure slice. PNGs regenerated, both themes. |
| `README-601b.md`, `README-603.md`, `README.md` | The three stale/superseded sentences, corrected in place with a pointer to the measurement. |

---

## 2. Defect 1 — a sub-agent was its own sub-agent

`AgentChatView` renders `subagentTranscript`: the sub-agent's own entries **plus
the spawn `tool_call` and its `tool_result`**. Those two carry
`meta.tool_use_id === owner` and **no** `parent_tool_use_id`, so they are
top-level entries. `sliceOwnerId` returns null on any thread with a top-level
entry, so the digest concluded "this is a whole run", counted the envelope as
the agent's own work, counted the agent's own 118 steps as delegated, and found
the agent's own spawn call in its roster.

Measured on the phase's committed fixture, run `3853c154`, sub-agent
`toolu_014raMUrJcAiXV61BerokrjN`:

| | before (round 605) | after (round 606) |
|---|---|---|
| `prose_scope` | `top-level` | `slice` |
| `owner_tool_use_id` | — (field did not exist) | `toolu_014raMUrJcAiXV61BerokrjN` |
| `top_level_count` / `subagent_entry_count` | **2 / 118** | **120 / 0** |
| `subagent_count` | **1** | **0** |
| `subagent_roles` | **`Explore`** (itself) | *(empty)* |
| rendered WORK row | `120 entries · 2 its own · 118 delegated · … · 1 sub-agents` | `120 entries · all its own · 59 tool calls · 1 tool errors · 0 sub-agents` |

The fix is one parameter. `deriveDigest`'s third argument is the owner id;
`StorySoFar` gets it from `scope`, whose subagent variant now *requires* it. The
inference path survives for a caller that hands over a pure slice and nothing
else, and `sliceOwnerId`'s doc comment names its blind spot explicitly.

Both readings are pinned by checks, including the wrong one — `check-story-digest.ts`
asserts the `[blind spot]` numbers on the real fixture, so the reason the
parameter exists cannot be refactored away by accident.

Round 605 also asked why the old unit check passed. It validated
`subagentEntries` output — a *pure* slice, which the product never renders. It
now calls `subagentTranscript`, the shipped function, imported from the module
the shipped view imports it from.

## 3. Defect 2 — "unknown" where two other surfaces said "scout"

`story-digest.ts` read roles from `metadata.subagents_v2` only. The team panel
(`agents-shared.ts:243`) and the drilled header (`AgentChatView.tsx:157`) read
the rollup **and** the spawn call's `input.subagent_type`. `subagents_v2` is
empty on almost every run a reader can click, so the digest was the only surface
that came up empty.

The digest now reads the same two sources in the same order. All three go
through one function, `subagent-slice.parseSpawnInput` — `AgentChatView`'s
private copy of it is gone.

A comment cannot hold that property, so `check-story-digest.ts` gained a
cross-surface section that imports the **server's own** `foldSubagents` (a pure
module: no pool, no route) and asserts panel and digest name the same role on
the same thread object. One difference survives on purpose, in the default
rather than in a fact: with nothing to read the panel says `agent` so a row has
a word, and the digest says `unknown` so a roster does not assert a role nobody
stamped. Both are asserted.

**Finding, new this round: `meta.input` is stored truncated at 1500 characters.**
Both Agent calls in the committed fixture are cut mid-string, so `JSON.parse`
throws and no role can be read from them — which is why the fixture's roles come
from its rollup and why this fix cannot be demonstrated *on that fixture*. It is
not a divergence: every surface calls `JSON.parse` on the same truncated string
and every surface fails identically, so they still agree. The digest does not
regex a role out of a broken payload to look better than the panel. Covered by
`check-subagent-slice.ts` ("a TRUNCATED input is nulls") and
`check-story-digest.ts` ("a truncated input JSON yields 'unknown', never a
guess"). If a later round wants the role out of a truncated input, the repair
belongs in whatever truncates it, or in all three readers at once.

## 4. Defect 3 — a doc comment that said the opposite of its code

`AgentChatView.subagentRunStatus`'s comment claimed "Unknown resolves to
settled"; the code returns `spawnDone ? "completed" : "running"`. The code is
right — the spawn's own `tool_result` is the better witness when the rollup is
silent — and the comment now says so, including the case the function genuinely
cannot settle (no rollup status and no result yet reads `running`, correct while
the parent is alive, wrong if the parent has itself settled) and round 605's
measurement of it: 0 of 58 settled runs reach that branch today. No code change.

## 5. Defect 4 — "a refresh lands on the manager chat"

It lands on TODAY. `DesktopApp.tsx:264` holds `surface` in
`useState<Surface>("today")` and persists it nowhere. `README-601b.md` §6
deviation 4 now says that, keeps the memory-only rationale that was always
correct, and points at §6.2 of the round-604 README for the measurement.

`README-603.md`'s "all its own" bullet was stale for the same underlying reason
as defect 1 and is marked superseded in place.

---

## 6. Verification — every command, from this worktree

```bash
cd forge-control-web
../forge-control/node_modules/.bin/tsx ../scripts/checks/check-story-digest.ts     # ALL PASS
../forge-control/node_modules/.bin/tsx ../scripts/checks/check-subagent-slice.ts   # ALL PASS
for f in ../scripts/checks/check-*.ts; do ../forge-control/node_modules/.bin/tsx "$f"; done   # 13/13 ALL PASS

cd forge-control      && npx tsc --noEmit                  # clean
cd forge-control-web  && npx tsc --noEmit                  # clean
cd forge-control-web  && NODE_ENV=production pnpm build    # green, 9/9 pages

# the two check scripts also typecheck standalone under --strict, which no
# tsconfig covers (both repos' includes stop at their own root):
cd forge-control-web && npx tsc --noEmit --strict --skipLibCheck --target es2022 \
  --module preserve --moduleResolution bundler --allowImportingTsExtensions --jsx preserve \
  ../scripts/checks/check-story-digest.ts ../scripts/checks/check-subagent-slice.ts

# both themes, offline (no server, no database, local chromium):
cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
  ../docs/plan/artifacts/phase600/capture-orientation.ts
```

`phase600-digest-dark.png` / `phase600-digest-light.png` are regenerated. The
third case in each is the sub-agent block, now over the real transcript, reading
`120 entries · all its own · 59 tool calls · 1 tool errors · 0 sub-agents` in
both palettes. No colour literal was added anywhere in this round; every value
touched is a token.

Round 604's own PNGs, JSON and numbers are untouched — they are that round's
measurement of the code as it stood, and overwriting them would erase the
evidence that these defects were real.
