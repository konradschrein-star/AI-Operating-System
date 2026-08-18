# Projects click lag — the BEFORE measurement

**Phase 6, task A. Artefacts only: no source file was changed.** Requirements R71, R72; cross-cutting
N3, N7, N10.

Raw output: `projects-lag-before.json` (unfiltered, every window, every request, every long task).
Script: `measure-projects-lag.cjs`. Harness: `browser-harness-perf.md` — a local copy of the
`02-architecture.md §0.2` recipe, because `phase1/browser-harness.md` did not exist when this ran.
Screenshots: `projects-board-before.png` (142 cards at live scale), `projects-detail-before.png`.

Measured 2026-08-18T20:06:12Z, 3 repetitions × 5 windows, each paired with an idle window of the same
length. Live scale at the time: **142 board cards** (`preflight.cardsAtStart`, counted two independent
ways that agreed), 1,400 DOM nodes on the board, 6 running tasks — one of which was this task's own run.

---

## 1. The verdict

> ### The dominant cause is the 6-second board poll's PAYLOAD, not the render.
>
> **`GET /api/projects/board` returns 1,843,144 bytes and the board renders 34,834 of them — 1.9%.**
> **88.2% of the payload is the `brief` column, which nothing on the board reads.** At a 6 s interval
> that is **9,320,340 decoded bytes per 30 idle seconds** — measured, three times, against **0 bytes**
> for the same 30 s on the TODAY surface of the same app in the same tab.

The runner-up — 142 unwindowed `TaskCard`s — **lost by a factor of ~270 on bytes and is imperceptible
on time**: the whole board mounts in **one React commit of 12.4 ms** (median of 12.4 / 15.3 / 9.9) and
adds 1,170 DOM nodes. §3 gives the full ranking.

**And the honest counterweight, which changes what task C should do (§5): there is no perceptible click
lag on this box at this scale.** Every interaction measured completed in **1–10 ms**, and the entire
7-minute run produced **one** long task, of 59 ms. The payload is the dominant cause of the lag that
exists — the cold entry into the surface, §2.4 — and it is the only quantity that is out of proportion
by orders of magnitude. It is not, on this hardware, producing a freeze.

---

## 2. The numbers, each with what produced it

Every figure below is either a field of `projects-lag-before.json` (path given) or the output of the
command quoted under it (N10).

### 2.1 The payload — the dominant number

```bash
curl -s http://127.0.0.1:7700/api/projects/board -o /tmp/board2.json
python3 -c "
import json
d=json.load(open('/tmp/board2.json')); t=d['tasks']
tot=len(open('/tmp/board2.json','rb').read())
rows=sorted(((k,sum(len(json.dumps(x.get(k))) for x in t)) for k in {k for x in t for k in x}),
            key=lambda r:-r[1])
print('tasks',len(t),'bytes',tot)
for k,s in rows[:4]: print(f'  {k:12s} {s:9d} B {100*s/tot:5.1f}%')
rendered=['status','round','fix_cycle','title','project_name','updated_at','id','role','run_id','project_id']
print('  rendered subset:', sum(s for k,s in rows if k in rendered))"
```

```
tasks 142 bytes 1843202
  brief          1625090 B  88.2%
  depends_on      148406 B   8.1%
  write_set        16976 B   0.9%
  title             9686 B   0.5%
  rendered subset: 34834
```

`TaskCard` (`ProjectsSurface.tsx:476`) reads exactly `task.status`, `task.round`,
`task.fix_cycle`, `task.title`, `task.project_name`, `task.updated_at` — plus `id`/`role`/`run_id` for
keys and selection. It never touches `brief`, `depends_on`, `write_set`, `chain_key`, `graph_frozen`,
`tier` or `attempt`. Across the whole file `brief` is read **once**, at `ProjectsSurface.tsx:806`,
inside `TaskDetail`, and only for a task that has no run yet — one string, of one selected task.

The payload is produced by `listActiveTasks()` (`forge-control/src/db/projects.ts:334`), which selects
`TASK_COLS_PT` — every column — with no `LIMIT` and no column projection.

### 2.2 What that costs per 30 idle seconds — W4, the window that isolates the polls

`summary.w4` in the JSON. W4 is 30 s on the Projects board with **no interaction at all**; its paired
floor is 30 s on TODAY, whose queries carry no `refetchInterval` (`DesktopApp.tsx:258`, and `:263`
polls only when the surface is `live`) — the same page, the same React tree, the same React Query
client, with this surface's polls switched off.

| per 30 s window | idle on TODAY | idle on Projects board | attributable |
|---|---|---|---|
| requests | 0 / 0 / 1 | 7 / 8 / 7 | +7 |
| **decoded bytes** | 0 / 0 / 736 | **9,320,340 / 9,321,075 / 9,320,340** | **+9,320,340** |
| wire bytes (gzip) | 0 / 0 / 1,022 | 2,635,364 / 2,636,400 / 2,635,374 | +2,635,364 |
| React commits | 0 / 0 / 2 | 3 / 5 / 3 | +3 |
| React commit ms (fiber `actualDuration`) | — / — / 0.3 | 13.3 / 9.9 / 10.4 | +10.4 |
| script ms *(renderer-wide CDP aggregate)* | 1 / 1 / 2 | 35 / 27 / 26 | +25 |
| long tasks | 0 | 0 | 0 |
| DOM nodes | 230 → 230 | 1,400 → 1,400 | 0 |

The 7 requests are 5 board fetches (6 s interval, `ProjectsSurface.tsx:77`) + 2 projects fetches (15 s
interval, `:82`, 52,310 B each):

```
5 × 1,843,144  +  2 × 52,310  =  9,320,340        measured: 9,320,340
```

**The arithmetic closes to the byte**, which is how we know the trace is complete and nothing is being
attributed to a window it did not happen in.

Sustained: **311 KB/s decoded, 88 KB/s over the wire, forever, while the operator does nothing.**

### 2.3 What it costs the CPU — and the honest limit of that claim

Only ~25 ms of renderer-wide script time per 30 s, and **zero long tasks**. So on *this* box the
payload is not a main-thread problem. Two caveats, both load-bearing:

* `scriptRendererWideMs` is Chrome's `Performance.getMetrics` `ScriptDuration` delta — a
  **renderer-wide aggregate**, labelled as such everywhere in the JSON and here. It is not a component
  number. (The per-commit numbers in this document *are* component numbers: fiber `actualDuration`
  from a `next build --profile` bundle, `preflight.reactProfilingBuild: true`.)
* This is a **16-core Hetzner VPS talking to itself over loopback**, `loadavg 8.43` at the time
  (`host.loadavg`). Konrad's laptop over the WAN is a different machine on a different link. The
  transfer cost extrapolates as arithmetic, not as measurement: 518,791 gzipped bytes every 6 s is
  0.4 s per fetch on a 10 Mbit/s link and **4.2 s per fetch on 1 Mbit/s — longer than the poll interval
  that triggers it.**

Server-side generation is not the bottleneck and was checked so it could be ruled out:

```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w 'ttfb %{time_starttransfer}s size %{size_download}\n' \
  http://127.0.0.1:7700/api/projects/board; done
# ttfb 0.051195s size 1798710   ttfb 0.038010s   ttfb 0.031093s   ttfb 0.031779s   ttfb 0.034358s
```

31–52 ms to build and serve 1.8 MB. Postgres and the serializer are fine; the payload is the problem.

### 2.4 The click that actually waits: cold entry into the surface

This is the path that matches Konrad's words, and it is the payload's clearest cost in time:

| entering Projects | time to first card | requests | source |
|---|---|---|---|
| **cold** (first entry, empty React Query cache) | **192 ms** | 1 board fetch | `preflight.firstBoardReadyMs` |
| **warm** (W1, cache already populated by the 6 s poll) | **3–4 ms** | **0** | `summary.w1.medians.timeToReadyMs` |

A 48–64× difference, and its entire content is one 1,843,144-byte fetch. (The earlier 4-window run of
the same script measured 172 ms for the same cold path — two samples, both ≈180 ms. Polling
granularity is ~55 ms, so treat these as ±one tick.)

Warm entry costs **zero** requests because the poll has already filled the cache — which is the one
genuine service the 6 s interval performs, and §5 says what to do about that.

### 2.5 The render, measured — the runner-up

`summary.w1`, `summary.w2`, `summary.w3`. Commit durations are React's own per-commit
`actualDuration`, summed per window.

| window | React commits | commit ms (3 reps) | DOM nodes | time to ready | long tasks |
|---|---|---|---|---|---|
| **W1** navigate into Projects (mounts 142 cards) | 1 / 1 / 1 | **12.4 / 15.3 / 9.9** | 230 → **1,400** | 4 / 4 / 3 ms | 0 |
| **W2** click a task card (opens detail) | 3 / 3 / 4 | 31.4 / 17.2 / 34.3 | 1,400 → 331–392 | 2 / 5 / 10 ms | 0 / 0 / 1 (59 ms) |
| **W3** toggle board → floor | 8 / 6 / 5 | 5.9 / 4.1 / 4.7 | 1,400 → 364 | 2 / 2 / 1 ms | 0 |

`longtaskSupported` is `true` in every window, so the zeros mean *no long task*, not *not measured*.

### 2.6 The 3 s per-running-task chat poll — W5, and it is not what the suspect list assumed

W5 is 30 s idle in floor view with **6 `FloorTile`s** (`floorTiles: 6` recorded in-window), each of
which `00-vision.md §2.7` predicts will fetch its full chat thread every 3 s:

| per 30 s in floor view | rep 1 | rep 2 | rep 3 |
|---|---|---|---|
| decoded bytes | **0** | **0** | **0** |
| React commits | 17 | 19 | 8 |
| React commit ms | 3.6 | 5.6 | 2.3 |

**Zero.** Because the SSE stream connects, `useRunEvents` flips `live` true, and `refetchInterval`
becomes 20 s rather than 3 s (`ProjectsSurface.tsx:597`). The updates arrive as `append` frames on the
already-open stream, and the 8–19 React commits they cause cost 2.3–5.6 ms in total. The 3 s figure in
`00-vision.md §2.7` is a correct reading of the code's *fallback* branch; it is not what the surface
does when the stream is up.

### 2.7 One number in this file is a harness artefact — say so before anyone quotes it

In floor view, every ordinary request in W5 stalled for **25.8 s** (25,855 / 25,828 / 25,842 ms for
`/api/proxy/projects/board`, against a 109 ms median everywhere else). Deterministic, 3/3, within
27 ms. The cause is that the 6 `EventSource` streams occupy the browser's entire per-origin
**HTTP/1.1** pool of 6 sockets, and the throwaway harness is plain http.

**It does not reach Konrad.** Production negotiates HTTP/2, which multiplexes:

```bash
curl -sI --max-time 15 https://os.schreinercontentsystems.com/signin -o /dev/null -w '%{http_version}\n'
#   2
```

Recorded here because it is exactly the kind of number that gets lifted out of a JSON file into a
conclusion. Detail and consequences for task C in `browser-harness-perf.md §9`.

---

## 3. The ranking (R72)

**1 — DOMINANT · the 6 s board poll's payload.** 1,843,144 decoded / 518,791 gzipped bytes per fetch,
**88.2% of it the `brief` column that no card renders** (1.9% of the payload is what the board shows);
**9,320,340 decoded bytes per 30 idle seconds** against 0 on TODAY; the cold entry into the surface is
gated on exactly one of these and takes 192 ms against 3–4 ms warm. It wins on every axis that was
measured — bytes, requests, and the only user-visible wait — and it wins by two to three orders of
magnitude.

**2 — RUNNER-UP · 142 unwindowed `TaskCard`s (`ProjectsSurface.tsx:421`, `:468`).** *Why it lost:* the
entire board mounts in **one React commit of 12.4 ms** and the full board is **1,400 DOM nodes**. There
is no long task in any W1. The `AssistantThread.tsx` analogy does not transfer — that fix removed a
2,200-row mount; this is 142 cards, two orders of magnitude less DOM, and it is already cheap. Adding
a windowing library here would buy ~12 ms once per navigation, at the cost of a dependency and a
regression surface. **It is the fix that would have been shipped on the analogy, and the measurement
says not to.**

**3 — the 3 s per-running-task chat poll (`:597`, `:703`).** *Why it lost:* measured at **0 bytes over
30 s** with 6 tiles open, 3/3 reps, because SSE holds and the interval is 20 s, not 3 s (§2.6). It is
a real cost only when SSE is unavailable — and then it is severe (§4).

**4 — the 15 s projects poll (`:82`).** 52,310 B, twice per 30 s. 1.1% of the board's traffic. Real,
and not worth a commit of its own.

**5 — `listActiveTasks()` has no `LIMIT` (`db/projects.ts:334`).** Named as a suspect, and it *is* the
mechanism behind #1 — but the missing `LIMIT` is not the expensive part. 142 rows is nothing; 142 rows
**× every column including a 39,597-byte `brief`** is everything. A `LIMIT` alone would cap a number
that is not the problem and would silently drop cards off the board. The fix is column projection.

---

## 4. A finding that is not in the ranking: the surface has no backoff

Three runs of this script died because the throwaway server was killed under them
(`browser-harness-perf.md §7` — the killer is outside this run, not the app). What the client did next
is a real observation, and it was reproduced **four times, at exactly 164 requests per 30 s**:

> With `/api/proxy/*` unreachable, the Projects surface in floor view issues **164 requests per 30 s —
> 5.5 per second** — and does not back off. Six `EventSource` streams reconnect on the browser's
> default schedule, `live` stays false so all six chat queries drop to their 3 s interval, and the 6 s
> board poll and 15 s projects poll continue underneath.

This is a degradation-behaviour defect, not a lag cause, and it is **out of scope for task C** as
briefed. It is recorded here because it is measured, reproducible, and would otherwise have to be
rediscovered. It is also the reason `measure-projects-lag.cjs` now writes `*.partial.json` on failure:
the first time it happened, all evidence was lost.

---

## 5. What this means for task C

**Fix #1 and only #1.** Column-project the board query.

* `listActiveTasks()` (`forge-control/src/db/projects.ts:334`) should select the columns the board
  renders and drop `brief` — the single change removes 88.2% of the payload. `depends_on` (8.1%) is
  also unread by `ProjectsSurface.tsx`; check the graph/DAG consumers before dropping it, because
  `ProjectTaskWithProject` is hand-mirrored in `forge-control-web/app/api.ts:1292` and other surfaces
  share the type.
* `TaskDetail` needs `brief` for one task with no run (`ProjectsSurface.tsx:806`). That is a
  fetch-on-select, not a field on 142 cards.
* Expect roughly 1,843,144 → ~220,000 bytes per fetch, and 9.3 MB → ~1.1 MB per 30 idle seconds.

**Do NOT window the board.** The measurement refutes it: one commit, 12.4 ms, 1,400 DOM nodes. Shipping
`@tanstack/react-virtual` here on the strength of the `AssistantThread` analogy would add a dependency
and a regression surface to save 12 ms, and would ship a false conclusion alongside it.

**Do not simply lengthen the 6 s interval either.** It is what makes warm entry into the surface cost
zero requests and 3–4 ms (§2.4). Making the payload small is strictly better than making it rare.

**Re-run this exact script, unchanged, with `RUN_LABEL=after`.** The comparison is only valid if the
shape is identical — which is why the repetition count and window durations are hardcoded and only the
label and the port are parameters. When reading the after run: W1–W4 are comparable; W5's *durations*
are HTTP/1.1 harness numbers (§2.7) and its *byte counts* are the real quantity.

---

## 6. The anti-lying checks, and what they caught

All three are fatal in the script; all three fired at least once during development, which is why they
are worth their lines.

1. **Not `/signin`.** Asserted immediately after the first navigation, with an error naming the **salt**
   as first suspect rather than the secret (`03-quality.md`; `02-architecture.md §0.2`). Verified in
   both directions with curl before any measurement ran: 307 → `/signin` without the cookie, 200 with
   it (`browser-harness-perf.md §5`).
2. **≥ 100 task cards before any window.** `preflight.cardsAtStart.total = 142`, counted two
   independent ways — by walking each column's scroll body, and by computed-style signature — which
   **agreed** (`agree: true`). A measurement of an empty board is worse than no measurement.
3. **React commit counter > 0 after W1.** `preflight.reactProfilingBuild: true`,
   `renderersInjected: 1`, and 1 commit in every W1. **This one caught a real bug in this harness:**
   `Page.addScriptToEvaluateOnNewDocument` accepts the call and returns an identifier while silently
   never running the script unless `Page.enable` is sent first. Without the check, every commit count
   in this report would have been a zero reading as *"React did no work"* rather than
   *"the hook never attached"* — which is precisely the conclusion that would have justified windowing.

A fourth discipline, added after it bit: a run that ends with a dead server is not a measurement.
`curl` the server before and after; both must be 200 (`browser-harness-perf.md §7`).

---

## 7. Reproduction

Full recipe in `browser-harness-perf.md §10`. In one line, given a built and served worktree:

```bash
RUN_LABEL=before PORT=7786 FORGE_SESSION_COOKIE="$(cat /tmp/p6-cookie.txt)" \
  node docs/plan/artifacts/os-usable-for-work/phase6/measure-projects-lag.cjs --commit-artifact
```

≈ 8 minutes. Writes `projects-lag-<label>.json` beside the script.
