# Round 1871 — fix cycle 1, against round 1870's customer test

Twelve findings came back from the tester. All twelve are addressed below, each
with what was actually wrong, what changed, and the measurement or the browser
run that proves it. Two of them turned out not to be defects in the code; both
say so and show the evidence rather than shipping a change for appearances.

Everything here was produced from **the worktree**, never from `/opt/forge-ai-os`:

| Component | Where it ran |
|---|---|
| forge-control-web | worktree build, `next start -p 7780` |
| forge-control | worktree routers via `scripts/checks/serve-v3-7798.ts` on `:7781` |
| database | the real `content_forge`, read-only |

`:7780`'s `/api/proxy` rewrite was repointed at `:7781` for the run (Next bakes
`rewrites()` into `.next/routes-manifest.json`, so it was patched in place after
the build). No pm2 service was started, stopped or restarted.

---

## 1. Composer / typing lag — **bad** → fixed, 24× faster

**What it was.** `ChatThread` owns the composer's `draft` state and renders
`<ManagerThread>`, which is the whole transcript. Every keystroke therefore
re-rendered 118 comms cards and 451 tool rows in order to change one
`<textarea>`'s value. The chat-list search box did the same thing one level up.

**What changed.** `ManagerThread` is `memo`ised, and the two callbacks
`ChatSurface` passes it (`onInsertDraft`, `onOpenSecret`) were hoisted out of
inline arrows into `useCallback`s with empty dependency arrays — the memo is
worthless without that, so both halves are asserted by
`scripts/checks/check-typing-memo.ts`. Finding 2's collapsed cards compound it:
a collapsed card renders no markdown at all.

**Measured** — `typing-1871.cjs`, 3 interleaved idle/typing pairs per surface,
60 keystrokes per window, same page, same session, same transcript on both runs
(118 comms cards / 451 tool rows / 17 team rows, recorded in both JSONs):

| surface | before ms/key | after ms/key | before long tasks | after long tasks | before blocked ms | after blocked ms |
|---|---|---|---|---|---|---|
| **composer** | **79.12** | **3.27** | 24, 11, 9 | 0, 0, 0 | 1291, 575, 534 | 0, 0, 0 |
| **chat-list search** | **68.95** | **4.90** | 18, 7, 22 | 0, 0, 0 | 1041, 432, 1201 | 0, 0, 0 |
| bare `<textarea>` control | 1.05 | 1.00 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

The control moved 0.05 ms/key across the two runs, which is what says the
instrument did not change under the measurement. Zero long tasks in every
typing window after; the *idle* windows now report more (0–3) than the typing
windows do.

Raw: `typing-1871.before.json`, `typing-1871.after.json` — every window, every
long task, `os.loadavg()` around every pair, and `allKeystrokesLanded: true`
on all six surface-runs (a window whose keys did not arrive is fatal to the
script, not a footnote).

## 2. Agent comms were a wall of text — **bad** → fixed

117 cards, **0** collapse controls, full payload always expanded, peer rendered
as a raw uuid plus "unknown role". Now: collapsed by default, one line each —
`◂` + the peer's **name** + a 120-character preview + age + `▸` — expanding to
the full payload plus the short run id. Same grammar and the same caret glyph as
the Bash rows it sits beside.

The name comes from the team panel's already-polled cache (`buildPeerRoles` now
carries `description` as well as `role`); it falls back role → short id → actor,
never to nothing. Browser run: **118/118 cards carry a toggle, 118/118 show `▸`,
0 open by default, clicking opens exactly one.** The first card's collapsed line
reads `◂ Plan phase 800: composer v3 + two-way secrets + canvas perf planner
Phase 800 planned (rounds 801-805…` where it used to read `◂ FROM WORKER UNKNOWN
ROLE c8bc5ffa`.

## 3. The chat showed another project's team — **bad** → fixed

Chat `bfd1283a` owns two projects: `operator-visibility` (active, 5 Aug) and
`engine-task-graph` (paused, 17 Aug). `resolveChatProject` took the newest, so
the chat running operator-visibility rendered engine-task-graph's 17 workers.

Two changes. `rankCandidates` orders by **liveness first** (running → dormant →
finished → abandoned), with newest-first demoted to the tie-break inside a tier;
and every candidate now ships on the wire so the panel offers a **switcher**
instead of a nine-pixel apology. `?project_id=` overrides the default on
`/team`, `/plan` and `/plan/doc`, validated against that chat's own candidates —
a foreign id is a 400, never a silent fallback.

Verified: default is now `operator-visibility · active`; `engine-task-graph ·
paused` is one click away; `?project_id=<unrelated uuid>` → **400** naming the
ids it would have accepted.

> **Decision Konrad has not answered yet.** Ranking active-before-newest is my
> call; the brief did not cover it. Asked at 08:58 via `/api/reminders`. If he
> prefers newest-always, `STATUS_RANK` in `chat-linkage.ts` is the one edit.

## 4. Kanban phases were not clickable — **bad** → fixed

`[data-plan-phase]` had `cursor: auto` and no handler. Now the phase header is a
real button and the task chips are too, and they do **different** things because
they are different objects:

- a **phase** with a corpus document opens it; a phase without one expands and
  says so in words. `matchPhaseDoc` also learned the corpus's actual numbering
  (block `N*100` ↔ the document whose *leading* number is `N`), which took this
  chat's project from **0 of 14 blocks linked to 6**.
- a **task** expands to its full untruncated title plus round, role, tier,
  status and prerequisite count. There is no per-task markdown in any corpus in
  this database, so a task click that opened one would have to invent it.

Verified: both `cursor: pointer`; clicking a phase opened `00-vision.md` in the
reader; clicking a task rendered `Plan: operator-visibility round 0 · architect
· done · tier flagship · no prerequisites`.

## 5. Sub-agent rows were blank — **bad** → fixed

Not missing data — a **parsing failure**. `meta.input` on a Task/Agent spawn is
the tool's JSON arguments, and the executor stores it clipped at 1500
characters; `prompt` is routinely longer, so `JSON.parse` threw and the catch
dropped the role and the description. Measured on chat `11dd264b`: six of seven
inputs are exactly 1501 chars, the seventh is 1203 and parses — which is exactly
why one row said `scout` and six said `agent`.

`readSpawnField` parses when the payload is whole and scans the surviving prefix
when it is not, accepting only a value it saw *close*. Same chat, over the wire:

| | live `:7700` | worktree `:7781` |
|---|---|---|
| roles | `agent` ×6, `scout` | `architect`, `builder`, `scout`, `scout`, `architect`, `scout`, `builder` |
| descriptions | `None` ×7 | "Research planning/brainstorm flow", "Build agent-activity visualization", … |

Where a number genuinely is not recoverable the row now says so instead of
lying: `tokens_measured: false` renders **`n/a`**, not `0`, and a null model
renders **`model n/a`** with a tooltip explaining that an unpinned sub-agent's
model is chosen inside the CLI process and never written to the transcript.
The spawn's own `tool_result` is deliberately *not* used as a settle stamp —
all seven land 6–120 ms after their call because the executor acks the spawn,
so it would report four minutes of work as 11 ms.

## 6. Raw Node error in the plan panel — **bad** → fixed

Side by side, same chat, same moment:

```
:7700  plan docs unreadable at /opt/ai-os/workspace/projects/0ecb3bd5-…/docs/plan:
       ENOENT: no such file or directory, scandir '/opt/ai-os/…/docs/plan'

:7781  p8-s1b-pass-race-smoke has no plan-docs directory yet — its planning corpus
       has not been written, or the worktree moved. The phases below are read from
       the database and are unaffected.
```

The fs text is not lost: it moved to `error_detail` and renders as the line's
tooltip.

## 7. Reload lost everything — **bad** → fixed

The surface, the open chat and the drill-in stack now persist. Every value is
validated on read — a chat id that is not a uuid and a nav frame that does not
typecheck are discarded rather than fed to a fetch — and the stack is stored
*with* the chat it belongs to, so it is dropped rather than reattached to a
different conversation.

Verified by an actual F5 while drilled into a worker: `surface="chat"`,
`selected="bfd1283a-…"`, drill-in restored.

**Not restored: scroll position.** The transcript's height depends on a poll
that has not landed at mount, so a restored offset would land in the wrong place
and read as a bug rather than a courtesy.

**The URL is still `/desktop`.** That is the honest home for this state and
`/desktop?surface=chat&chat=<id>` is where it belongs, but the app has one route
and every surface reads its state from React — routing is a redesign, not a fix
cycle. Recorded as an open item, not quietly closed.

## 8. No phone layout — **bad** → fixed

`app/page.tsx` picks `MobileApp` from the User-Agent, so a real phone was never
in this state; `/desktop` renders the desktop shell whatever the device, and
that shell is three fixed columns — 184 + ~200 + 260 — inside an
`overflow: hidden` box. At 390px the right two were laid out past the edge with
nothing to scroll to.

Below 900px: the nav rail goes (TopNav already carries every destination), the
chat surface shows **one** of list/thread with a `← chats` button back, the side
panel collapses to its edge strip, and the composer row wraps under a
full-width textarea.

Two further bugs surfaced *while verifying this one*, both fixed:
- the surface auto-selected the newest chat on arrival, so a phone landed inside
  a thread and never saw the list. Suppressed when narrow.
- the composer's four `flex: none` controls squeezed the textarea to **56px** of
  390. With the wrap it measures **320px**.

Verified at 390×844: 17/17 chat rows fully inside the viewport,
`document.scrollWidth === 390` (nothing clipped), composer `l=18 r=338 w=320`,
back-control present.

## 9. "Hover eats the numbers" — **paper-cut, not reproducible**

The controls are in a fixed-width slot on line 1 and revealed by opacity alone;
the tokens and time cells are on line 2. Instrumented on a live row:

```
before hover   tokens "866k"  time "15m 49s"   both visible
after  hover   tokens "866k"  time "15m 49s"   both visible
```

`05-team-hover-dark.png` cropped and enlarged shows the same thing: the hovered
planner row still reads `329k  6m 18s` underneath its `⏸ ✕`. The controls sit
*above* the numbers, which is likely what was read as replacing them. **No code
was changed for this finding** — a change here would have been decoration over a
correct implementation.

## 10. Machinery leaking into prose — **paper-cut** → fixed

Two separate leaks.

`{"queued":true,"delivery":"next-turn","echo":true}` is
`POST /api/runs/:id/message`'s 202 body, appended to the thread as assistant
text. It renders as a one-line **receipt** now — "message queued · will be
delivered on the agent's next turn · echoed into this transcript" — expanding to
the verbatim JSON. The detector is deliberately narrow (whole message parses as
one flat object, ≤8 keys, at least one from a closed control vocabulary): 9
must-refuse cases are asserted, including prose that merely *mentions* an
envelope, because a false positive here swallows something an agent said.

`sub-agent toolu_01` named nothing — `toolu_01` is the Anthropic id prefix, so
every sub-agent produced the identical crumb. Frames now carry a caller-supplied
label (the row's own description), and the id fallback drops the prefix.
`check-nav-stack.ts` asserted the old string; it now asserts the new one and
that two sub-agents of one run get different crumbs.

## 11. Two different effort controls — **paper-cut** → fixed

The in-chat composer had the U29 colour ramp; the new-chat surface had a plain
native `<select>` with a different vocabulary ("high effort" vs "high"). One
control now, the ramp, in both places.

`max` is offered. It was **always** accepted by the engine — `EFFORT_LEVELS` in
`cc-runner.ts` has held all five since it was written — and was reachable from
the API and from Telegram but not from Konrad's own console.

There was no sixth hue hotter than `bleed`, so `xhigh` and `max` share the hot
end. `check-composer-v3.ts` no longer asserts "every rung distinct" (which was
only satisfiable at four rungs); it asserts what the ramp actually has to keep —
monotonic, ≥4 distinct values, and the single repeat at the hot end.

Verified: `["low","medium","high","xhigh","max"]` as chips, **0** `<select>`
elements on the new-chat surface.

## 12. Confirmation is backwards — **paper-cut** → addressed, not inverted

The asymmetry is correct and the labelling was not. A dismissal is reversible;
`restore all` issues `DELETE /api/agents/dismissals`, which drops **every**
dismissal on the machine — other projects, the Live panel, rows hidden a week
ago — and forty individual decisions cannot be reconstructed.

Two happened to be the machine's whole count that day, which is why `restore all
2?` read as harmless. So the scope is in the **label** now, not only the
tooltip: `restore all 2 everywhere?`. And a dismissal toasts the way back at the
moment of the click, which is what was missing — a confirm dialogue would put
friction on the cheap, undoable direction.

---

## Both themes

`themes-1871.cjs` probes the computed colours of every surface this round
touched, in both themes. All flip correctly (comms toggle `rgb(237,237,238)` →
`rgb(23,23,26)`; project chip `rgb(91,141,239)` → `rgb(44,98,212)`).
Contrast on the interactive controls: **4.78–17.95**. Screenshots
`theme-dark.png` / `theme-light.png`.

The tokens and model cells measure 2.88 (dark) / 2.95 (light). Those are the
pre-existing `textFaint` / `textGhost` tokens this panel uses for de-emphasised
metadata throughout; this round changed *which* of the two an unmeasured cell
wears, not the tokens. Flagged as pre-existing, not introduced here.

`no-raw-colours.cjs`: PASS — 222 literals, 0 unlisted.

## Reproduce

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# 1. the worktree API on a spare port (routers only — never boot index.ts)
cd forge-control
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
SERVE_V3_PORT=7781 SECRET_STORE_DIR=/tmp/r1871-store \
  ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &

# 2. the worktree web build on another
cd ../forge-control-web && npm run build
python3 - <<'EOF'
import json; p='.next/routes-manifest.json'; d=json.load(open(p))
def walk(o):
    if isinstance(o,dict):
        if o.get('destination','').startswith('http://127.0.0.1:7700'):
            o['destination']=o['destination'].replace(':7700',':7781')
        [walk(v) for v in o.values()]
    elif isinstance(o,list): [walk(v) for v in o]
walk(d); json.dump(d,open(p,'w'))
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
AUTH_URL=http://127.0.0.1:7780 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7780 &

# 3. a session cookie (read-only source of the live env file)
node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
  token:{name:"r1871",email:"check@localhost",sub:"check"},
  secret:process.env.AUTH_SECRET,salt:"authjs.session-token",maxAge:14400})))' \
  > /tmp/session-cookie-1871.txt

# 4. the two measurements
cd .. && export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-1871.txt)"
TYPING_BASE_URL=http://127.0.0.1:7780 TYPING_RUN_LABEL=after \
  node docs/plan/artifacts/phase1871/typing-1871.cjs
node docs/plan/artifacts/phase1871/verify-1871.cjs   # 26 browser checks
node docs/plan/artifacts/phase1871/themes-1871.cjs   # both themes
```

## Gates

| Gate | Result |
|---|---|
| `forge-control` `npx tsc --noEmit` | clean |
| `forge-control-web` `npx tsc --noEmit` | clean |
| `forge-control-web` `npm run build` | exit 0, `BUILD_ID` FepW1zgRFwyKSFSiEfHYq |
| `forge-control` `tsx --test src/lib/r1871-subagent-recovery.test.ts` | 23/23 |
| `check-r1871-chat.ts` (new) | 43/43 |
| `check-typing-memo.ts` (new) | ALL PASS |
| `check-nav-stack.ts` | ALL PASS (5 new assertions) |
| `check-composer-v3.ts` | ALL PASS (ramp rule restated) |
| `check-dismiss-peek.tsx` | ALL PASS (1 new assertion) |
| `check-chat-rich.tsx` | 222/222 |
| `check-team-rows` / `plan-store` / `thread-mapping` / `subagent-slice` / `team-confirm` / `tool-summary` / `story-digest` / `orientation` | ALL PASS |
| `no-raw-colours.cjs` | PASS, 0 unlisted |
| `verify-1871.cjs` (browser, all 12 findings) | 26/26 |

## Open items

1. **The ranking decision** (finding 3) is mine, not Konrad's — asked, not yet
   answered. Default shipped; one constant to change.
2. **Deep links are still not in the URL** (finding 7). State survives a reload
   via `localStorage`; it is not shareable and not back-button-navigable.
3. **A sub-agent's model and token spend remain unrecoverable** on the
   thread-fallback path (finding 5). The row says `n/a` and says why. Making
   them recoverable means the executor stamping `meta.parent_tool_use_id` on
   sub-agent entries — engine work, owned by another lane this cycle.
4. **Faint metadata cells** measure ~2.9 contrast in both themes. Pre-existing,
   untouched here, worth a token decision of its own.
