# activity-truth — what `current_activity` actually holds, and for how long

**Written in round 5 (fix cycle 1), 2026-08-25, against round-4 review finding 3.**

Round 0 declared this file in its `write_set`, finished `done`, and never wrote it. The
number it published — *"60.8% of live wall-clock in `tool_result`, replayed over 321 runs /
66 h of thread"* — was quoted in three source files as the sole justification for the
`run-rollup.ts` change in `3e63a45`, with no artefact in the repo behind it. `done` does not
verify a declared write-set (`done-never-verifies-the-declared-write-set.md`), so nothing
caught it.

This document does not quote round 0. **It re-derives the measurement from scratch**, states
the method precisely enough to re-run, and reports where round 0's figure came from and why
it is not reproducible as a single number.

---

## 1. The instrument

`forge-control/scripts/replay-activity.mts` — committed with this document, runnable:

```bash
cd forge-control
REPLAY_DSN='postgresql://…@127.0.0.1:5432/content_forge' npx tsx scripts/replay-activity.mts
# optional: REPLAY_DAYS=7 (default)
```

It refuses to run without `REPLAY_DSN` rather than defaulting to a database — the module it
measures does default, and that default is production.

**It is read-only.** One `SELECT id, thread FROM runs WHERE created_at > now() - '7 days'`.
No write, no `UPDATE`, no schema touch.

## 2. The method

`ingestEvent` moves `currentActivity` on exactly three event types, and only for **parent**
events (`parentToolUseId` absent). The replay mirrors that state machine over `runs.thread`:

| thread row | parent state emitted |
|---|---|
| `kind:"tool_call"`, no `meta.parent_tool_use_id` | `tool_call` + the tool's name |
| `kind:"tool_result"`, no `meta.parent_tool_use_id` | `tool_result` + the answering tool, resolved through a replica of the `pendingTools` map (same `PENDING_TOOL_CAP` = 64, same insertion-order eviction) |
| `kind:"text"`, `role:"assistant"` | `assistant_text` |
| `comms`, `error`, `system` text, and **every subagent event** | *nothing* — `ingestEvent` never sees these, so the parent state does not move |

A state is **held from its own `ts` until the next state-changing event's `ts`**. That gap is
the weight. Two exclusions, because "live wall-clock" is meant to mean *the agent was
working*:

- an interval containing a `role:"user"` row is dropped — the run was parked waiting for a
  human (141 intervals, 0.26%);
- an interval longer than the **gap cap** is dropped — a queue stall, an executor restart, or
  a run sitting between turns.

**The gap cap is the whole ballgame, and round 0 never published which one it used.** So this
document reports four, and lets the reader see the figure's stability instead of trusting one
choice.

## 3. Raw counts — measured 2026-08-25 05:41:48 UTC

Corpus: `content_forge.runs`, last 7 days.

```
runs with a thread                    : 566
runs contributing ≥1 state interval   : 338
state intervals                       : 54 675
  dropped as parked (user turn inside):    141
```

| gap cap | intervals kept | live wall-clock | **`tool_result`** | `tool_call` | `assistant_text` |
|---|---|---|---|---|---|
| 60 s | 53 598 | 60.3 h | **75.3%** (45.4 h, n=24 437) | 13.7% (8.3 h) | 11.0% (6.6 h) |
| 120 s | 54 129 | 72.1 h | **68.3%** (49.2 h, n=24 611) | 19.9% (14.3 h) | 11.8% (8.5 h) |
| 300 s | 54 450 | 86.3 h | **58.8%** (50.7 h, n=24 645) | 29.5% (25.5 h) | 11.7% (10.1 h) |
| uncapped | 54 534 | 257.0 h | 19.7% (50.7 h) | 11.9% (30.6 h) | **68.4%** (175.7 h) |

Re-run three times over eight minutes: the corpus grew by ~60 intervals (it is a live
database) and **every percentage moved by less than 0.1 pp**.

## 4. What this says about the 60.8% figure

**Round 0's number is not reproducible as a single number, because it is a function of a cap
it never published.** 60.8% falls between the 300 s row (58.8%) and the 120 s row (68.3%).
The corpus corroborates well — round 0 said 321 runs / 66 h, this replay finds 338 runs and
60.3–86.3 h depending on the cap, a day later. It was a real measurement. It was just quoted
with a false precision that nobody could check.

**The claim the code actually rests on survives all of it.** Under every cap that means
"the agent was working" — 60 s, 120 s, 300 s — `tool_result` is the single largest state, at
**58.8% to 75.3%**, and never below a majority-adjacent share. `activityLabel`
(`live/AgentActivity.tsx:165`) returns `""` for `tool_result` outright, so a column headed
*what it is doing right now* would be **blank for the majority of the time it is looked at**.
That is the defect `3e63a45` fixed, and it does not depend on which cap you pick.

**The uncapped row is the trap, and it is worth naming.** Uncapped, `assistant_text` takes
68.4% — but that is one long tail per run: the final assistant message before a run sits idle
for hours still counts as "the agent is writing" until the next event, which may never come.
Uncapped is not a measure of live work; it is a measure of how long runs sit around. Anyone
re-deriving this and getting ~20% for `tool_result` has forgotten the cap.

## 5. The `pendingTools` resolution rate

Same replay, same corpus — how often the map can actually name the answering tool:

```
parent tool_results replayed  : 24 701
resolved to a tool name       : 24 700
unresolved (would print null) :      1   (0.0040%)
```

So the fix is not merely directionally right, it is essentially total: **one parent
`tool_result` in 24 701 falls back to `null`**, and that one is the honest answer (its
`tool_call` is not in the thread — an executor restart mid-run, the case the module header
documents). This independently reproduces round 0's "23 205 / 23 206", one day later on a
larger corpus.

Covered by `forge-control/src/lib/run-rollup.test.ts` §1–§3, which mutation-testing confirms
fails against the pre-`3e63a45` behaviour.

## 6. The 68.4% staleness figure — provenance, NOT re-derived here

`LiveSessionsStrip.tsx` cites a **different** number: `current_activity` is stale on **68.4%
of polls**. That is not this replay. It came from round 0 / T3's live poll instrument — 379
poll samples over 6 runs, of which 108 could be compared against the thread's own event log;
70 of those 108 served `tool_call` while the true state was `tool_result`. Cause:
`maybeFlush` is called only from `ingestEvent` and throttles to one write per 2 s, with no
timer — so a `tool_result` landing inside the throttle window is followed by seconds of model
thinking during which no event arrives, and the DB keeps serving the `tool_call`.

**This document does not re-verify that figure.** Reproducing it requires polling the live
API over a live run, which is a deploy/verify activity, not a build one. It is recorded in
fleet memory as `rollup-serves-stale-activity-68-percent.md`. Treat it as *measured once,
by one instrument, not independently reproduced* — which is exactly why the strip's UI
shows the activity's **age** next to the label rather than trusting the label alone.

Note also the coincidence, so nobody mistakes one for the other: the uncapped
`assistant_text` share in §3 is also 68.4%. Unrelated measurement, unrelated corpus.

## 7. What the code now cites

Three comments quoted the bare "60.8%". All three were corrected in this round to state the
range with its cap, and to name **this document** as the source:

- `forge-control/src/lib/run-rollup.ts` (the `tool_result` branch)
- `forge-control-web/app/desktop/team/liveSessions.ts` (`KIND_PHRASE`)
- `forge-control-web/app/desktop/team/LiveSessionsStrip.tsx` (the staleness/age comment)
