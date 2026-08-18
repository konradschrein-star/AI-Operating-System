# Round 1350 — dismissal in the UI (client half)

Phase 6 item 1. Round 1351 shipped `ui_dismissals` and the four
`/api/agents/dismissals` routes (`../dismissal-api.md`); this round moves the
web app onto them and gives the **/live panel** the affordance it never had.

## What changed

| file | change |
|---|---|
| `forge-control-web/app/desktop/team/dismissals.ts` | localStorage store **deleted**; `useDismissals` is now server-backed and GLOBAL. Same four-member contract (`dismissed`/`dismiss`/`restore`/`restoreAll`), so ChatTeamPanel's call site is unchanged. The set lives in one react-query cache entry (`["ui-dismissals"]`) shared by both surfaces. Optimistic write → POST `cascade:true` → adopt the server's id list; on failure the row comes back and a toast carries the server's own reason (NFU6). New exports: `useDismissalsLoaded()`, `seededDismissals()`. |
| `forge-control-web/app/desktop/team/ChatTeamPanel.tsx` | hides by `seededDismissals(loaded, serverSet, payloadIds)` — the tree's own `dismissed_at` fields seed the frames before the GET answers, and the server set is the only authority afterwards. `flattenTeam` still cascades the subtree locally for instant feedback; "N hidden · show" unchanged. |
| `forge-control-web/app/desktop/live/AgentActivity.tsx` | **new**: a ✕ on every SETTLED top-level row (never on a running one), dismissed rows hidden, an `N dismissed · show` toggle in the panel header that peeks them back muted with a per-row ↺. Sub-agents dismissed elsewhere stay hidden here too. |
| `forge-control-web/app/desktop/live/agentsApi.ts` | the four dismissal calls (`fetchDismissals`, `postDismissal`, `deleteDismissal`, `deleteAllDismissals`), each throwing with the server's `error`/`message`; `dismissed_at?` on `AgentRow`. |
| `forge-control-web/app/desktop/team/teamApi.ts` | `dismissed_at` on `TeamNode` (the field the server already ships). |
| `forge-control-web/app/globals.css` | `.live-row` / `.live-row-controls` — the CSS-only reveal, byte-for-byte the bargain `.chat-row` and `.team-row` already make. |
| `scripts/checks/check-team-rows.ts`, `check-orientation.ts` | `dismissed_at: null` in the two `TeamNode` factories. |

**No JS hover state was added.** There is no `onMouseEnter`, no
`onMouseLeave` and no hover `useState` in either panel directory — the ✕ is
mounted in every row at all times inside a fixed-width slot and revealed by one
opacity rule. Peeking is a single toggle on the PANEL, not a per-row flag.

## Gates

```
forge-control-web $ npx tsc --noEmit                    → clean (no output)
forge-control-web $ NODE_ENV=production npm run build   → 12 routes, no errors
repo             $ node scripts/checks/no-raw-colours.cjs
                   PASS — 222 literal(s) across 14 file(s), all accounted for
                   (176 legitimate, 46 known debt, 0 unlisted)
forge-control    $ npx tsc --noEmit                     → clean
forge-control    $ tsx ../scripts/checks/check-team-rows.ts   → ALL PASS
forge-control    $ tsx ../scripts/checks/check-orientation.ts → ALL PASS
```

## Behavioural proof — `capture-1350.cjs`, 52 assertions, 0 failures

Both surfaces × both themes, against a real browser and a real API. Nothing is
stubbed and no route is intercepted.

```
──────── dark ────────                         ──────── light ────────
live · a settled row offers ✕                  (identical set, both themes)
live · nothing dismissed yet
live · the row is gone from the list
live · header offers the way back
live · the server holds it (not localStorage)
live · still hidden after a hard reload
live · and the panel still says so
live · still hidden in a brand-new context
live · peeking reveals it, with a restore control     peeked row opacity 0.55
live · the toggle flips to hide
live · restored into the list
live · and the toggle is gone
live · the server forgot it too
live · the manager takes its settled workers with it  3 rows gone in 500ms,
                                                      server cascade size 3
live · no running row carries a ✕                     4 running rows inspected
team · tree is ready / nothing hidden yet
team · one fewer row
team · "N hidden · show" appears
team · the server holds it                            (id derived from the API,
team · still hidden after a hard reload                not read off the DOM)
team · and still offers the way back
team · still hidden in a brand-new context
team · "show" brings every row back
team · and the label is gone
team · the server is empty again

ALL PASS — dismissal UI
```

**The reload proof is the strong form.** Each surface is reloaded in the same
tab (new document, new JS heap — the panel re-derives everything) *and*
re-opened in a **fresh browser context**, which shares no storage with the one
that made the dismissal. A localStorage store passes the first and fails the
second; this one passes both, and `GET /api/agents/dismissals` is asserted
directly against the database in between.

**The cascade is proved in one frame, not by a poll.** The Live panel is read
500 ms after the click — well inside its 4 s poll — and the operator chat's two
settled project workers are already gone while the RUNNING one stays. That is
the POST's returned id list being applied to local state, which is the property
the brief asked for.

Screenshots (1440×1000): `live-{dark,light}-{1-before,2-dismissed,3-after-reload,4-peek,5-restored,6-manager-cascade}.png`,
`team-{dark,light}-{1-before,2-dismissed,3-after-reload,4-restored}.png`.
Full JSON: `capture-1350.json`.

## Harness — how to reproduce

Production was READ (a row copy) and never written. `content_forge` has no
`ui_dismissals` table at all yet (migration 0041 is a deploy step), so a write
against it was not merely avoided, it was impossible.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) scratch database: schema clone of content_forge + migration 0041, then a
#    COPY of the last two days of `runs` plus `projects`/`project_tasks`.
psql "${DATABASE_URL%/content_forge}/postgres" -c "CREATE DATABASE forge_dismiss_ui_1350"
PROBE="${DATABASE_URL%/content_forge}/forge_dismiss_ui_1350"
pg_dump -s "$DATABASE_URL" | psql -q "$PROBE"
psql -q "$PROBE" -f db/migrations/0041_ui_dismissals.sql
psql "$DATABASE_URL" -c "\copy (SELECT * FROM runs WHERE updated_at > now() - interval '2 days') TO '/tmp/r1350-runs.csv' CSV"
psql "$PROBE"        -c "\copy runs FROM '/tmp/r1350-runs.csv' CSV"          # + projects, project_tasks

#    plus four seeded rows, because the real recent window happens to contain
#    no settled operator chat and no parent/child pair, so the CASCADE would
#    have been untestable: one operator chat (worker='forge-executor',
#    completed), a project whose metadata.origin_chat_id names it, and three
#    workers — builder completed, reviewer failed, planner RUNNING.

# B) the worktree API on :7860, pointed at the scratch db. Routers only —
#    never forge-control/src/index.ts, so no cron/telegram/vault tick.
export SECRET_STORE_DIR=/tmp/r1350-store; mkdir -p "$SECRET_STORE_DIR"
export DATABASE_URL="$PROBE"
(cd forge-control && SERVE_V3_PORT=7860 ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# C) an ISOLATED production build of this worktree baked against :7860, so
#    forge-control-web/.next is never repointed. Cookie minted exactly as
#    phase800/README §2 step C does.
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/r1350-web/
ln -s "$PWD/forge-control-web/node_modules" /tmp/r1350-web/node_modules
(cd /tmp/r1350-web && FORGE_CONTROL_URL=http://127.0.0.1:7860 NODE_ENV=production ./node_modules/.bin/next build)
AUTH_URL=http://127.0.0.1:7861 FORGE_CONTROL_URL=http://127.0.0.1:7860 AUTH_SECRET="$AUTH_SECRET" \
  (cd /tmp/r1350-web && ./node_modules/.bin/next start -p 7861 &)

# D) the walk
R1350_BASE_URL=http://127.0.0.1:7861 R1350_API_URL=http://127.0.0.1:7860 \
FORGE_SESSION_COOKIE="$(cat /tmp/r1350-cookie.txt)" \
  node docs/plan/artifacts/phase1350/dismissal-ui/capture-1350.cjs
```

The scratch database is left in place — dropping one is a destructive op and
was not briefed. It is `forge_dismiss_ui_1350` on 127.0.0.1:5432 and nothing
reads it.

## Two things a reviewer should know

* **`/api/capabilities` now answers `terminate: true`** on this branch (the
  engine lane shipped the control plane). So in the team panel a RUNNING row's
  ✕ is *enabled* and arms a terminate. The first version of this capture
  clicked "the last enabled ✕", armed a terminate and proved nothing; the
  script now selects the dismiss ✕ by its title. Anyone writing a protocol
  against that panel should do the same.
* **A failed `GET /api/agents/dismissals` un-hides every row**, loudly, with a
  toast naming the reason — rather than keeping rows hidden on the strength of
  a request that never succeeded. That is deliberate (NFU6) and it is the one
  visible difference from the localStorage behaviour it replaces.
