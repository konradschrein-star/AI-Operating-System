# U31 — what opening the canvas costs (BEFORE baseline, round 801)

Round 801 measures. Round 803 fixes. Nothing in this directory changes
application code, and `git status --porcelain` after this round contains only
files under `docs/plan/artifacts/phase800/`.

**Verdict up front: the gate is exceeded.** Opening the canvas on a chat that
remembers a drawing — which is every open after the first — costs **193–205 ms
of main-thread scripting over 580–691 ms of wall clock** before the editor is on
screen, against U31's 100 ms scripting gate. The pane's own frame is cheap
(**19–29 ms** scripting, 48–64 ms wall) and is not the problem. The prime
suspect named in the brief — chunk fetch of the Excalidraw bundle — is **real
but second**: with all 1.08 MB of chunks already in the HTTP cache the open
still costs **102–106 ms scripting over 532–536 ms wall**, so removing the
network entirely does not clear the gate. The largest single line item is
**layout, not script**: `Layout` alone is 149–160 ms of self time over 11
passes.

| | measured |
|---|---|
| baseline | `31385c91adf66ed9562c4af045acdd802d124e32` (committed HEAD, `git archive`d to `/tmp/phase800-canvas-before`) |
| served on | `http://127.0.0.1:7811` — isolated `next build` + `next start`, `FORGE_CONTROL_URL=http://127.0.0.1:7798` |
| API | worktree harness `scripts/checks/serve-v3-7798.ts` on `:7798`. `forge-control/src/index.ts` was never booted; forge-executor was never touched |
| viewport | 1440×900 (`14-ui-v3-quality.md`) |
| protocol | `canvas-open.cjs`, 4 scenarios × 6 open/close cycles = 48 measured toggles per run |
| runs attached | `canvas-open-before.json` (run A), `canvas-open-before-run2.json` (run B) — independent, same verdict |
| checks | 18/18 PASS in run A, run B, and the run-C rerun |

---

## 1. What was measured, and how

The click is a real Chromium input event on the real `CANVAS` button
(`ChatSurface.tsx:838`) in a real production build. Per cycle the page emits
`performance.mark`s — `click`, `dom`, `paint`, and where the editor mounts
`excdom` / `excpaint` — from an inert `MutationObserver` installed with
`addInitScript`. `paint` is stamped in a **double** `requestAnimationFrame`
after the node enters the DOM, so it is the frame that showed it, not the frame
it was scheduled in.

Those marks land in the CDP trace as `blink.user_timing` events, in the same
clock as everything else, so the interval needs no conversion. Inside it, on
`CrRendererMain`, the protocol computes **self time** per event (own duration
minus direct children, so nesting is never double-counted) and buckets it by
the `EVENT_BUCKET` map at the top of `canvas-open.cjs` — the map is in the
source so it can be argued with rather than trusted. Unbucketed self time is
reported as `other_ms` and is asserted never to dominate a cycle; if the map
were missing something, that check would say so.

Hashed chunk filenames are resolved against the build directory, so
"chunk N is X KB" is read off disk rather than inferred.

### The two honest readings of "open"

`ChatSurface.tsx:883` mounts `<CanvasPane>` on toggle, but `CanvasPane.tsx:627-646`
only renders `<Excalidraw>` once **both** a `path` and the loaded scene exist.
`path` lives in `localStorage["forge.canvasByRun"]` per chat
(`ChatSurface.tsx:367-392`). So "opening the canvas" is two different events,
and both are reported:

- **Reading A — pane paint.** click → the frame showing `<CanvasPane>` and its
  chrome. What U31 most literally names.
- **Reading B — editor paint.** click → the frame showing the Excalidraw
  editor. What "the canvas is open" means to Konrad on every open after he has
  picked a drawing once.

Reporting only A would let a fix round declare victory over a frame that was
never slow. Reporting only B would overstate the first-ever open on a fresh
chat, which genuinely is fast.

### Scenarios

| | drawing remembered | HTTP cache | what it isolates |
|---|---|---|---|
| **S1 empty** | no | fresh (empty) | first-ever open — the editor never mounts |
| **S2 drawing** | yes | fresh (empty) | the steady state, cold network |
| **S3 drawing-nocache** | yes | `Network.setCacheDisabled(true)` | "your number is just a cold cache" |
| **S4 drawing-reload** | yes | **warm** — canvas opened once, closed, page reloaded | warm bytes, cold module graph |

S4 is the load-bearing one and it had to be repaired mid-round: its first
version reloaded the page without ever having opened the canvas, so nothing was
in the cache and it was S2 with an extra navigation, reporting identical
numbers. It now opens the canvas, waits for the editor, closes it, *then*
reloads — and `check("S4's measured cold open served the Excalidraw chunks from
the HTTP cache")` fails loudly if that ever stops being true.

---

## 2. The numbers

Run A / run B. "cold" is cycle 1, reported on its own throughout — the first
open is the one Konrad feels, and averaging it away is the one thing this round
was told not to do. "warm" is the mean of cycles 2–6.

### Reading A — click → pane paint

| scenario | cold scripting | cold wall | cold longest task | warm scripting (mean) | warm wall (mean) |
|---|---|---|---|---|---|
| S1 empty | 28.6 / 21.2 ms | 60.1 / 48.5 ms | 56.0 / 41.9 ms | 19.7 / 24.7 ms | 48.7 / 58.2 ms |
| S2 drawing | 28.9 / 21.9 ms | 63.5 / 49.6 ms | 57.2 / 44.2 ms | 26.6 / 23.9 ms | 58.4 / 56.0 ms |
| S3 drawing-nocache | 22.1 / 22.6 ms | 50.7 / 48.6 ms | 45.8 / 42.5 ms | 22.6 / 23.2 ms | 53.9 / 56.6 ms |
| S4 drawing-reload | 20.0 / 19.4 ms | 48.1 / 48.4 ms | 42.1 / 42.7 ms | 29.2 / 25.3 ms | 62.9 / 57.7 ms |

**Under the gate everywhere.** Worst cold figure across both runs is 28.9 ms
against 100 ms. Nothing here needs fixing.

### Reading B — click → editor paint (S1 has no editor)

| scenario | cold scripting | cold wall | cold editor-in-DOM | warm scripting (mean) | warm wall (mean) |
|---|---|---|---|---|---|
| S2 drawing | **200.6 / 192.7 ms** | **691 / 633 ms** | 500 / 448 ms | 59.3 / 62.0 ms | 134 / 141 ms |
| S3 drawing-nocache | **198.0 / 205.2 ms** | **580 / 653 ms** | 471 / 479 ms | 59.8 / 61.6 ms | 135 / 136 ms |
| S4 drawing-reload | **105.8 / 101.6 ms** | **536 / 532 ms** | 428 / 418 ms | 60.0 / 56.5 ms | 136 / 132 ms |

**Gate exceeded on every drawing scenario, cold** — including S4, where every
byte was already on disk. Warm opens land at ~57–62 ms scripting — under the
gate, but on a 132–141 ms wall clock, every single toggle.

### Close

Close is cheap and uninteresting, which is worth stating rather than omitting:
**18.7–25.8 ms scripting, 43.6–53.8 ms wall**, consistent across all four
scenarios and both runs. Closing unmounts the pane; nothing is re-fetched or
re-evaluated.

---

## 3. Ranked candidate causes, with the evidence for each

Ordered by how much of the cold editor open each one accounts for. All figures
are self time on `CrRendererMain` inside click → editor paint, run A.

### 1. Layout and style recalculation on Excalidraw's mount — 214–242 ms rendering, of which `Layout` alone is 149–160 ms

```
S2 cold, click → editor paint      run A (691 ms span, 494 ms busy) / run B (633 ms span, 452 ms busy):
   Layout             159.52 ms (11 events)  /  149.01 ms (11 events)   rendering
   FunctionCall       111.87 ms (99 events)  /  100.00 ms (104 events)  scripting
   EvaluateScript      87.54 ms  (9 events)  /   91.64 ms  (9 events)   scripting
   UpdateLayoutTree    42.16 ms (17 events)  /   28.74 ms (17 events)   rendering
   PrePaint            35.45 ms (14 events)  /   31.98 ms (14 events)   rendering
   Paint               18.04 ms  (7 events)  /   13.47 ms  (8 events)   painting
```

`Layout` is the **largest single line item in the trace**, larger than the
bundle evaluate, and it survives caching: S4, with every byte on disk, still
spends **135 / 153 ms** in rendering. Eleven layout passes for one component
mount is the shape of repeated forced reflow, and the document is carrying
144 KB of Excalidraw CSS (see cause 4) while it happens.

**Evidence quality: strong for the cost, circumstantial for the mechanism.**
The bucket totals and event counts are measured. *Which* code forces those
layouts is not — that needs a `disabled-by-default-devtools.timeline.invalidationTracking`
pass or a `ProfileCall` sample, which this round did not run. Round 803 should
confirm before optimising, and should not assume the CSS is the culprit merely
because it is large.

### 2. One-time evaluation of the Excalidraw bundle — 87.5–91.6 ms `EvaluateScript`, ~86–91 ms of it in one 431 KB chunk

```
S2 cold  evaluate_by_script:  964a6e64.e133deccbfc7f328.js   85.92 / 90.95 ms   (431 KB on disk, 149 KB on the wire)
S4 warm  evaluate_by_script:  8850.52fff5e1f4cd84a5.js        8.82 /  9.36 ms   (156 KB on disk, 0 B — HTTP cache)
                              964a6e64.e133deccbfc7f328.js     4.43 /  4.39 ms
                              91fe18bf.b868f42d76d92326.js     4.09 /  4.38 ms
```

Three excalidraw-bearing chunks are fetched on the click path, **1,106,804
bytes on disk / 352,562 bytes on the wire**:

| chunk | disk | wire (cold) | wire (S4, cached) |
|---|---|---|---|
| `91fe18bf.b868f42d76d92326.js` | 504,966 B | 146,091 B | 0 B |
| `964a6e64.e133deccbfc7f328.js` | 441,653 B | 148,600 B | 0 B |
| `8850.52fff5e1f4cd84a5.js` | 160,185 B | 57,871 B | 0 B |

Cold evaluation is ~86–91 ms in a **single task**; after the reload V8's code
cache cuts the same work to 4–9 ms, and `v8.produceCache` (10.5 ms) is visible
in the S4 trace writing it. This is the brief's prime suspect and it is real —
but it is a one-time cost that the browser already largely solves for itself,
and eliminating it entirely still leaves S4's 536 ms.

**Evidence quality: strong.** Named chunk, size read off disk, evaluate time
from `EvaluateScript`'s own `args.data.url`.

### 3. The bundle download is serialised behind an API read that has nothing to do with it — ~80 ms of dead time

```
                     GET /canvas/file finishes → first Excalidraw chunk requested
S2 cold   run A:            90.48 ms          →          93.00 ms      (+2.5 ms)
          run B:            75.46 ms          →          77.72 ms      (+2.3 ms)
S3 cold   run A:            77.84 ms          →          80.03 ms      (+2.2 ms)
          run B:            77.04 ms          →          79.15 ms      (+2.1 ms)
S4 cold   run A:            76.87 ms          →          78.82 ms      (+2.0 ms)
          run B:            69.74 ms          →          71.62 ms      (+1.9 ms)
```

The chunk request is issued **1.9–2.5 ms after the scene fetch resolves, in all
six cold measurements**, because `CanvasPane.tsx:627-646` only renders `<Excalidraw>` once
`initial` is set, and `initial` is set by `load()` after `getCanvas()` returns
(`CanvasPane.tsx:145-166`). `next/dynamic` starts fetching when the component
first renders — so 350 KB of download waits on a 550-byte JSON read.

Nothing about the bundle depends on the scene. The two could overlap
completely, or the import could be started on the click (or on hover, or at
idle after the chat opens) rather than after the fetch.

**Evidence quality: strong, and it is the cleanest win available.** The
ordering reproduces in all three drawing scenarios in both runs, and the
mechanism is readable in the source rather than inferred.

### 4. 144 KB of Excalidraw CSS on every `/desktop` load, whether or not the canvas is ever opened

`008289500c38878d.css` is **144,615 bytes** and contains 1,230 occurrences of
`excalidraw`; it is the editor's stylesheet. It loads on page load in **all
four scenarios — including S1, where the editor never mounts.** The cause is
`CanvasPane.tsx:32` importing `@excalidraw/excalidraw/index.css` at module
scope while `ChatSurface.tsx:60` imports `CanvasPane` *statically*, so the CSS
is welded to the desktop bundle even though the component itself is dynamic.

For completeness: `9366-f9f6042ab0bd63c8.js` (27,409 B) also loads at page load
and mentions excalidraw — that is `CanvasPane` itself plus the dynamic-import
wrapper, which is expected.

**This is explicitly NOT on the click path** and does not contribute to the
numbers in §2. It is recorded because it is a real cost paid by every desktop
visitor and because the live stylesheet is a plausible contributor to cause 1.

### 5. Excalidraw's own lazy chunks and fonts on the tail — ~120 ms of the wall clock, almost no scripting

```
S2 cold (run A), after the main bundle lands:
    5038.b7f2bffb116a9e13.js    sent 397.1 ms  finished 406.8 ms   1,160 B
    6212.03e7521fb24efea0.js    sent 399.3 ms  finished 453.9 ms   1,429 B
    Assistant-Regular.woff2     sent 474.7 ms  finished 602.8 ms  20,532 B
    Assistant-Bold.woff2        sent 474.9 ms  finished 602.2 ms  20,680 B
    Assistant-Medium.woff2      sent 475.2 ms  finished 602.5 ms  20,620 B
                              editor node in DOM 499.6 ms
                                  editor painted 691.3 ms
```

Excalidraw chain-loads several small chunks and then three fonts (61 KB) after
its own code runs. The editor node is in the DOM at ~500 ms but does not paint
until ~691 ms. Of the 691 ms span, 494 ms is main-thread busy, so roughly
200 ms is waiting.

**Evidence quality: strong for the timings, weak for the causal claim.** That
the fonts finish 148 ms before the paint does not prove they blocked it. Round
803 should not chase this before causes 1 and 3.

---

## 4. Answering the objections in advance

**"Your number is just a cold cache."** No. S4 opens the canvas, closes it,
reloads the page, and then measures — all three chunks are served from the HTTP
cache with **0 bytes on the wire** (asserted by a check, not claimed), and V8's
code cache cuts evaluation of the big chunk from 86–91 ms to ~4 ms. The cold
open still costs **105.8 / 101.6 ms scripting over 536 / 532 ms wall** and is
still over the gate. S3 disables the cache outright and lands within noise of
S2. Network is worth roughly 100–150 ms of wall and ~90 ms of scripting; it is
not the gate.

**"You measured a huge drawing."** The opposite. The fixture is
`Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md` — **531 bytes, zero
elements**, deliberately the smallest real canvas in the vault, so the figure
is the cost of the *editor* rather than of somebody's 500 KB scene. Every real
drawing is worse. `GET /canvas/file` returns 551 bytes on the wire.

**"It's the first open only."** Warm opens are 56.5–62 ms scripting — under the
gate — but still **132–141 ms of wall clock** every single time the pane is
toggled, because closing unmounts the component and re-opening remounts the
entire editor from scratch.

**"You measured a build someone was editing."** The measured tree is
`git archive HEAD` at `31385c91` into `/tmp/phase800-canvas-before`, built and
served in isolation on `:7811`. The worktree's own `forge-control-web/.next` was
never rebuilt.

Two other builders were working in this worktree during round 801 and both
landed while these measurements were running — `206323d` (composer autogrow +
effort ramp, U28/U29/U32) and `f9d5c23` (secret-request data layer, U30). The
archive was taken before either, so neither could reach the measured build, and
`31385c91` is now a clean **ancestor** of the branch tip rather than a detached
claim. For the avoidance of doubt:

```
$ git diff --name-only 31385c9..HEAD | grep -i canvas
(no matches)
```

Neither commit touches `CanvasPane.tsx`, `ChatSurface.tsx`'s canvas toggle, or
any canvas route. `206323d` does touch `ChatSurface.tsx` (composer autogrow),
which is why the archive rather than the working copy is the thing that was
built.

---

## 5. Three things this artifact must disclose

**The surface never settles.** The brief asks to wait for no in-flight fetches
before driving the button. On this surface that state is not reachable: the
chat detail, agents, team, plan and canvas-intent pollers fire on
3 s/4 s/6 s/20 s/30 s timers and `longest_quiet_ms` was **0 in every scenario of
both runs** — the in-flight count never hit zero for a measurable window. The
cycles ran anyway, and each cycle's own `requests[]` shows exactly what was in
flight during it. `settle` is recorded as an object rather than a boolean so
this is visible instead of asserted away.

**One scenario writes to the vault, and it has to.** `CanvasPane.tsx:263-269`
flushes on unmount, and Excalidraw marks the scene dirty while loading it, so
each close writes the drawing back. Measuring the canvas 24 times wrote Konrad's
real vault file 24 times in an early run, once returning `409 Conflict` when two
writes raced. S1–S3 now answer the `PUT /canvas/file` locally and write nothing.

S4 **cannot**, because enabling routing in Playwright disables the browser's
HTTP cache — the exact thing S4 exists to measure. (Re-asserting
`Network.setCacheDisabled:false` over CDP after the route is registered does not
win it back; measured, chunks still came over the wire on reload.) So S4 runs
unrouted and its unmount flushes reach the vault. The protocol therefore reads
the drawing before and after the whole run and asserts the **scene is
byte-identical** — only the mtime moves, which is what re-saving an unchanged
scene does. `check("the fixture drawing's SCENE is byte-identical after the
run")` passes in both runs.

**A 404 every 3 s — and what it turned out to mean.** `GET /api/proxy/canvas/intent`
404s on every scenario, because `CanvasPane.tsx:233-259` at this branch's HEAD
polls it unconditionally. `/api/canvas` is not one of the routers the `:7798`
harness mounts, so those reads were proxied to live `:7700`, which runs `main` —
and **`main` has already deleted that endpoint**, replacing the pane's polling
with SSE (`60dfda5` "canvas: live push — pane subscribes to the SSE change
stream"). The 404 is a real client/server mismatch on this branch, not a broken
fixture. It is outside every measured interval (first fire is 3 s after mount)
and is recorded in each scenario's `failed_requests`.

---

## 5a. This branch is behind `main` on CanvasPane — and the causes survive it

`60dfda5` is **not** an ancestor of `31385c91`. `main` has moved ahead on the
exact component this round measured:

| | this branch (`31385c91`) | `main` |
|---|---|---|
| `GET /canvas/intent` 3 s poll | present | **gone** |
| `listCanvases()` 4 s poll | present | **gone** (SSE) |
| `EventSource` / `canvas/events` | absent | present |
| `CanvasPane.tsx` | 659 lines | 746 lines |

Round 803 must **merge `main` first and re-baseline**, or it will optimise a
component that no longer exists.

What does *not* change: all four ranked causes are still present in `main`'s
`CanvasPane.tsx`, verified line by line —

- `import "@excalidraw/excalidraw/index.css"` at module scope — `main:37`
  (cause 4)
- `dynamic(… , { ssr: false })` — `main:25,42` (cause 2)
- `initial ? <Excalidraw …>` — `main:732-733`, so the bundle still cannot start
  loading until `getCanvas()` has resolved (cause 3)
- `import { CanvasPane } from "./CanvasPane"` — static, `ChatSurface main:50`
  (cause 4)

`main`'s change is to the **pollers**, which fire 3–4 s after mount and are
outside every interval measured here. The open path itself is untouched, so the
ranked causes and their ordering carry over. The absolute numbers will move and
must be re-measured against the merged tree.

---

## 6. Reproducing

The runnable recipe is the comment block at the top of `canvas-open.cjs` —
ports, cookie minting, isolated build, and the `--write` convention. It is kept
there rather than here so the script and its instructions cannot drift apart.

Non-destructive by default: without `--write` the protocol writes to
`/tmp/phase800-out`, prints the `diff -u` line against the committed copy, and
leaves `git status --porcelain` empty. Round 801 recorded with `--write`.

```bash
# run A (the committed baseline)
node docs/plan/artifacts/phase800/canvas-open.cjs --write

# run B (the reproducibility leg)
PHASE800_OUT_FILE=canvas-open-before-run2.json \
  node docs/plan/artifacts/phase800/canvas-open.cjs --write
```

Both runs: **18/18 checks PASS, same verdict.** Because the two runs record
`generated_at` and per-cycle timings, `diff` between them is expected to be
non-empty; what must agree is `gate.exceeded_on_any_reading`, which does.

### The third run — verifying the instructions, not the number

A **run C** was then executed from the recipe above **without** `--write`, as a
reviewer would run it, to prove two things at once:

- the protocol re-runs from its own written instructions and reaches the same
  verdict a third time — **18/18 PASS, `GATE EXCEEDED`**, cold editor open
  224.7 ms scripting over 713.5 ms wall (reading A 31.6 ms, under gate);
- the rerun is genuinely non-destructive. It wrote `/tmp/phase800-out/canvas-open-before.json`
  and printed the `diff -u` line; `git status --porcelain docs/plan/artifacts/phase800/*.json`
  showed both committed JSONs unmodified.

Run C's absolute numbers run ~10 % higher than A and B and are **not** offered
as a third measurement: it was deliberately run while two `tsc --noEmit` jobs
and two unrelated VMs were loading the box (load average 3.9). That it still
lands on the same side of the gate by a factor of two is the point — the verdict
does not depend on a quiet machine.

---

## 7. What round 803 inherits

The gate is exceeded on reading B. In descending order of expected return:

1. **Stop serialising the bundle behind the scene fetch** (cause 3). ~80 ms,
   mechanically obvious, no behaviour change.
2. **Find out what forces eleven layout passes on mount** (cause 1). Largest
   single cost, and the only one that survives every form of caching — but
   diagnose it before optimising; this round proved the cost, not the mechanism.
3. **Consider keeping the pane mounted and hidden across toggles.** Warm opens
   still pay 132–141 ms of wall clock because close unmounts the whole editor.
4. **Split the 144 KB stylesheet off the desktop critical path** (cause 4).
   Not a click-path win; a page-load win for every visitor who never draws.

Before any of that: **merge `main`** (§5a) and re-record a baseline against the
merged tree. `main` has already rewritten this component's polling, and an
AFTER number taken against a different CanvasPane than the BEFORE is not a
comparison.

Whatever 803 changes, the AFTER run must name its baseline sha explicitly and
report cold and warm separately, or the comparison is not one.
