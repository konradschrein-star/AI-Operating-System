# `subagent.ended_at` is a launch acknowledgement, not a completion stamp

**Round 102 (phase 1b), 2026-08-05. Documented deviation from the task's stated helper contract, with the evidence that forced it.**

## What the contract said

The phase-1b task specified, verbatim:

```
export function subagentElapsedMs(s: SubagentRow, now: number): number | null
  started = parseTs(s.started_at); if (!finite) return null
  1. s.status === "running"           -> Math.max(0, now - started)
  2. finite(parseTs(s.ended_at))      -> Math.max(0, ended - started)
  3. finite(parseTs(s.updated_at))    -> Math.max(0, updated - started)
  4. otherwise                        -> null
```

Rule 2 before rule 3 assumes `ended_at` is when the sub-agent finished. Round 101 put the field on the wire on that assumption (R3), reading it out of `metadata.subagents_v2[]` without checking the arithmetic it implies.

## What the data says

Implemented literally, every done sub-agent on screen rendered **`0s`**:

```
PASS  [ACTIVE] subagent-done  Read   0s | 0s | 0s
PASS  [ACTIVE] subagent-done  Bash   0s | 0s | 0s
PASS  [RECENT] subagent-done  # Recon Report — Desktop chat transcript rende   0s | 0s | 0s
PASS  [RECENT] subagent-done  # Data layer feeding the Live agent-activity p   0s | 0s | 0s
```

`ended_at − started_at` is 10–40 **milliseconds** for every sub-agent in the system:

```
$ curl -s http://127.0.0.1:7798/api/agents | …
done  started=2026-08-05T07:23:26.096Z  ended=2026-08-05T07:23:26.125Z  updated=2026-08-05T07:31:34.953Z  evt=131  desc=Builder: fleet redesign steps 1–6
done  started=2026-08-05T06:47:12.533Z  ended=2026-08-05T06:47:12.565Z  updated=2026-08-05T06:53:09.635Z  evt=118  desc=Recon chat Bash block rendering
done  started=2026-08-05T06:47:23.666Z  ended=2026-08-05T06:47:23.678Z  updated=2026-08-05T06:51:58.943Z  evt=78   desc=Recon agents API and runs schema
done  started=2026-08-04T23:03:48.624Z  ended=2026-08-04T23:03:48.652Z  updated=2026-08-04T23:05:24.470Z  evt=42   desc=Recon forge-control API
```

A sub-agent that emitted 118 events cannot have run for 32 ms.

## The mechanism, traced end to end

Thread of run `3853c154-e07b-4378-9313-2b34f4a33342`, following one spawn:

```
$ psql "$DATABASE_URL" -Atc "SELECT … WHERE tool_use_id LIKE 'toolu_014raMUrJcAi%' OR parent_tool_use_id LIKE 'toolu_014raMUrJcAi%' ORDER BY ts"

2026-08-05T06:47:12.533Z  tool_call    parent=none              id=toolu_014raMUrJc    ← Agent spawn
2026-08-05T06:47:12.565Z  tool_result  parent=none              id=toolu_014raMUrJc    ← "launched" ack, +32ms
2026-08-05T06:47:14.127Z  text         parent=toolu_014raMUrJc                         ← the sub-agent starts working
2026-08-05T06:47:16.003Z  tool_call    parent=toolu_014raMUrJc  id=toolu_011WDEvtV6
2026-08-05T06:47:16.050Z  tool_result  parent=toolu_014raMUrJc  id=toolu_011WDEvtV6
…
last event under that parent: 2026-08-05T06:53:09.636Z                                  ← 5m 57s after the spawn
```

`forge-control/src/lib/run-rollup.ts:222-229` (read-only; engine file, not touched):

```ts
} else if (e.type === "tool_result") {
  if (!parent && typeof e.toolUseId === "string") {
    // Result for a Task spawn — mark that subagent done.
    const sub = s.subagents.get(e.toolUseId);
    if (sub && sub.status === "running") {
      sub.status = "done";
      sub.ended_at = ts;
      sub.updated_at = ts;
    }
```

For an **asynchronous** agent spawn the tool_result is the launch acknowledgement, so the rollup marks the sub-agent `done` and stamps `ended_at` at t+32ms. The sub-agent's real events keep arriving under `parent_tool_use_id` for the next six minutes and push `updated_at` forward (`:211`, `:240`, `:250`), but the `sub.status === "running"` guard means the status and `ended_at` are never revisited.

So, in today's data:

| field | meaning in practice |
|---|---|
| `started_at` | when the spawn was issued — correct |
| `ended_at` | when the launch was acknowledged — **not** the end of the work |
| `updated_at` | timestamp of the last event observed under the sub-agent — the honest end of its work, and frozen once the sub-agent stops emitting |
| `status: "done"` | "the spawn call returned", not "the agent finished" |

Round 101's commit message read the same phenomenon backwards — it described those trailing events as "late events arriving under a stale parent_tool_use_id" pushing `updated_at` past the true end. The thread above shows they are the sub-agent's own work, arriving in order.

## What round 102 shipped instead

```ts
const settledAt = Math.max(finite(ended) ? ended : -Infinity,
                           finite(updated) ? updated : -Infinity);
return Number.isFinite(settledAt) ? Math.max(0, settledAt - started) : null;
```

The later of the two stamps. Properties:

- **Never derives from `now`** — the invariant this phase exists to enforce (R5) holds absolutely; the anti-tick unit cases call the helper with clocks six hours apart and assert identical output.
- **Preserves the specified behaviour where the spec's assumption holds.** For a synchronous spawn the result arrives after the work, so `updated_at ≤ ended_at` and the max picks `ended_at` — exactly rule 2. Unit case: `done, ended=+47s, updated=+30s → 47s`.
- **Declines to repeat the engine's error where it does not.** Launch-ack case: `ended=+0.032s, updated=+357s → 357s`.
- **Both null / unusable → `null` → "—"** (rule 4), unchanged.

Following the contract literally would have replaced Konrad's complaint ("elapsed times are still growing even though they are done") with a different falsehood ("every sub-agent took 0s"), which fails definition-of-done #1 on its own terms. The deviation is one `Math.max`, it is strictly a superset of the contract, and it is confined to the file the contract names.

## What is still wrong, and who owns it

The panel's sub-agent **status dot** is still wrong for async spawns: a sub-agent that is actively working shows the hollow "done" dot from ~30 ms after spawn. This helper cannot fix that — the fix belongs in `run-rollup.ts`, which is engine-internal and outside this phase's declared file scope. Two candidate fixes, for whoever picks it up:

1. Recognise the async launch ack (its result text is the `Async agent launched successfully…` form) and leave the sub-agent `running`, settling it on the completion notification instead. Blocked on the same gap R19 documents: completion payloads never reach the thread (`cc-runner.ts:417-429`).
2. Treat "no events under this parent for N seconds" as settled, stamping `ended_at` from the last event — i.e. make `ended_at` mean what `updated_at` already means here, and drop the launch-ack stamp.

Until then `updated_at` is the best available truth for a finished sub-agent, and this helper uses it.

A knock-on for phase 2 (kind truth, R9): the sub-agent `status` field should not be presented as authoritative "finished/working" state in the redesigned row until the rollup is fixed. Flagged here so the phase-2 planner sees it.
