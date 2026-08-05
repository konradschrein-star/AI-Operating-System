# Phase 2b artifacts — kind truth in the Live panel (R8–R11)

Regenerate everything here with one command (see `kind-dom.cjs`'s header for
the environment; both REPRODUCE.md traps apply — the proxy target is baked at
**build** time and `/desktop` needs a minted session cookie):

```bash
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
  node docs/plan/artifacts/phase2/kind-dom.cjs
```

## What each file is, and how real it is

| File | Data | Shows |
|---|---|---|
| `live-dark.png` / `live-light.png` | **real**, live server, request scoped to `?project_id=8ea0cc08…` | architect / planner / builder / reviewer worker rows and two real done sub-agent lines under the architect run |
| `live-global-dark.png` / `live-global-light.png` | **real**, live server, unscoped | what the LIVE destination renders today: 60/60 worker rows |
| `kinds-fixture-dark.png` / `kinds-fixture-light.png` | **synthetic** (a fulfilled `/api/proxy/agents` payload) | one row of each kind — operator, worker + nested sub-agent, cron, unclassified |

The scoping in the first pair is not a fixture: the URL is rewritten to add
`project_id`, the response comes from the live API, and it is exactly the
request `ChatSurface`'s Live tab makes natively (`AgentActivity` takes a
`projectId` prop). It exists because two projects are churning, so the
unscoped 24h × LIMIT-60 feed is entirely workers and the panel's 12-row RECENT
slice never reaches a run that carries sub-agents.

The fixture pair exists because two of the four kinds have nothing to render
against. In the 24h window: **72 worker runs, 5 operator chats, 0 crons, 0
unclassified** — and the 5 operator chats rank below the LIMIT-60 cut. Showing
those badges required a synthetic payload; saying so is cheaper than implying
coverage that the live feed cannot give.

## Two deliberate deviations from the plan's suggestions

1. **`↳ sub` is `tokens.textMuted2`, not `tokens.textGhost`.** In the light
   palette `textGhost` is `#a6a6ae` — roughly 2.5:1 against the card, which
   made the one marker that answers Konrad's question ("is this a sub-agent or
   a whole session?") the faintest thing in the row. Muted2 is still visibly
   subordinate to the description next to it. Compare `live-light.png`.
2. **`operator` and `builder` share `tokens.accent`.** Suggested colours put
   both on accent and there is no seventh distinct status token to spend. The
   badge WORD is the primary signal and differs ("operator" vs "worker"); the
   colour is a secondary cue and is not unique across the seven kinds/roles by
   design. Visible in `kinds-fixture-*.png`.

## Note on `scripts/checks/frozen-dom.cjs`

It samples the **unscoped** panel and fails loudly when no done sub-agent line
is on screen — a deliberate anti-vacuous-pass guard (REPRODUCE.md). With the
current feed that guard fires: all 12 settled cells are frozen and the live
counter-check passes, but there is no sub-agent row to test R5 against.

```
found: 0 settled-in-ACTIVE, 12 settled-in-RECENT, 0 done sub-agents, 2 live runs
FAIL: no done sub-agent line on screen — cannot prove R5
  PASS  [RECENT] run-settled  … 12/12 cells byte-identical across 3 samples / 12s
  PASS  counter-check: at least one LIVE run duration advanced
```

`kind-dom.cjs` therefore re-proves R5 on the scoped panel, where two real done
sub-agents exist:

```
── R5 re-check on the scoped panel (3 samples / 12s) ────────
  PASS  done sub-agent 0: 5m 57s  |  5m 57s  |  5m 57s
  PASS  done sub-agent 1: 4m 35s  |  4m 35s  |  4m 35s
```

This is a data-availability condition, not a regression: the duration cells'
`title` strings — `running for this long`, `total run time`, `total subagent
run time` — are untouched by phase 2b, which is what frozen-dom classifies on.

## R10 lineage — the strings, dumped from the live DOM

```
worker row   title = "project worker · builder · project 8ea0cc08 · model claude-opus-5 · run 9a937009"
sub-agent    title = "in-process sub-agent of \"operator-visibility · Plan: operator-visibility\" (fable-5) · role Explore · model claude-opus-5 · started 2026-08-05T06:47:12.533Z"
cron         title = "cron weekly-review · model claude-haiku-4-5-20251001 · run cccccccc"     (fixture)
operator     title = "operator chat (full Claude Code session) · model claude-fable-5 · run aaaaaaaa"  (fixture)
unknown      title = "unclassified run · worker skylab-producer · run dddddddd"                (fixture)
```

Lineage sits on each row's container element (`div[data-agent-kind]`) as a
native `title`. There is no hover state anywhere in `app/desktop/live/` —
`grep -rn 'onMouseEnter\|onMouseOver\|onMouseLeave' forge-control-web/app/desktop/live/`
returns nothing. Titles carry the **raw** model id, not the display form: the
badge column is where brevity belongs, the tooltip is where a greppable id
does.
