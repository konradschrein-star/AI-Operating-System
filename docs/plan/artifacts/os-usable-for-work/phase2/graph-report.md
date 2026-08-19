# The wikilink graph, photographed in three states — R36 and R35's live half

**Task:** round 11, fix cycle 1, workstream `vault` · **Executed:** 2026-08-19T02:29Z – 02:33Z
**Closes:** R2-gate's two blockers · **Requirements demonstrated:** R33, R35, R36, N7
**Predecessor:** `editor-browser-proof.md` §8, which named R35's live case *unproven rather than
claimed*. This document is that case, run.

> Nothing here read or wrote the live `hcp` database or `/opt/obsidian-vault`. §1 is the recipe that
> guarantees it, and §5 is the check that it held.

---

## 1. Why a scratch database, and how it was made faithful

R35's empty state cannot be photographed against a vault with 292 nodes in it, and the honest way to
force it is to change the **data**, not the component. `wikilinkGraph()` reads exactly one table:

```sql
SELECT vault_path, topic, links FROM knowledge_note WHERE created_by = 'vault-sync' ORDER BY vault_path
```

So the flip is one `UPDATE` on `links` — and it must not touch the real table. A **per-run scratch
database** carries the copy (`shared-scratch-db-two-failure-faces`: name it per run or two concurrent
gate runs deadlock or, worse, quietly answer each other's arithmetic):

```bash
psql .../postgres -c "CREATE DATABASE hcp_scratch_r11_0e8590da950a"
pg_dump -d hcp -t public.knowledge_note --no-owner --no-privileges | psql .../hcp_scratch_r11_0e8590da950a
psql ... -c "ALTER TABLE knowledge_note ADD COLUMN links_backup text[]"
psql ... -c "UPDATE knowledge_note SET links_backup = links"     # the way back, before the way there
```

**The copy is faithful, and that is asserted rather than assumed** — the graph it produces is
identical to the one the live database produces, node for node:

| | live `hcp` (round 10, `editor-browser-proof.md` §8) | scratch copy (this round) |
|---|---|---|
| nodes | 292 | 292 |
| edges | 624 | 624 |
| notes scanned | 288 | 288 |
| notes carrying links | 122 | 122 |
| unresolved targets | 128 | 128 |
| self-links dropped | 1 | 1 |

A scratch database that produced a *different* graph would make every measurement below unreadable —
this table is what rules that out.

The throwaway forge-control is round 10's (`/tmp/b2d-server.mts`, two routers on a bare Hono app —
never `tsx src/index.ts`, which starts the cron, Telegram and vault-sync ticks against live state),
started on **:7797** with `HCP_DATABASE_URL` pointed at the scratch database and
`OBSIDIAN_VAULT_DIR=/tmp/b2d/obsidian-vault`. The web app was **REBUILT** against it —
`next.config.mjs` bakes the `/api/proxy/*` target at `pnpm build` time, so setting the variable at
`next start` changes nothing (`next-proxy-rewrite-baked-at-build`) — and the bake was verified, not
assumed:

```
$ cd forge-control-web && FORGE_CONTROL_URL=http://127.0.0.1:7797 NODE_ENV=production pnpm build
$ grep -o 'http://127.0.0.1:7797' .next/routes-manifest.json | head -1
http://127.0.0.1:7797
```

`next start -p 7798`, cookie minted by `phase1/browser-harness.mjs --cookie-out` (`HARNESS_EXIT=0`,
`ok=true`), driven by `/tmp/b2c-drive.mjs` with `/tmp/r11-graph-proof.mjs` (`DRIVER_EXIT=0`). The
driver re-asserts the `/signin` wall itself and screenshots nothing past a failed wall check.

---

## 2. Three states, one session, one build

The single most useful thing an empty state can do is fail to appear. A panel that renders
unconditionally photographs exactly like a correctly-keyed one, so the run walks the data through
three states **without rebuilding, restarting or reloading anything but the page** — the component
binary is byte-identical across all three, and the only variable is the `links` column.

| # | `knowledge_note` state | rows / with links | rail | empty panel | shot |
|---|---|---|---|---|---|
| 1 | as copied | 288 / 122 | `292 nodes drawn · 624 edges drawn` | **absent** | `graph-after.png` |
| 2 | `UPDATE … SET links = '{}'` | 288 / 0 | `0 nodes drawn · 0 edges drawn` | **present** | `graph-empty-state.png` |
| 3 | `UPDATE … SET links = links_backup` | 288 / 122 | `292 nodes drawn · 624 edges drawn` | **absent** | — (asserted, not shot) |

State 3 is not decoration: without it, state 2 is consistent with an empty state that latches on and
never clears. `292 → 0 → 292` is the assertion that closes that reading.

Every row above is a `must()` in the driver script — `ASSERTION FAILED` throws and the run exits
non-zero. The three that passed, verbatim from `/tmp/r11-proof.json`:

```
PASS — R36 — 292 nodes drawn · 624 edges drawn, no empty panel
PASS — R35 — empty panel rendered with the server's reason, 0 nodes drawn
PASS — R35 both directions — 292 → 0 → 292 nodes drawn
```

---

## 3. R36 — the populated graph (`graph-after.png`)

Assertions, each independently able to fail:

| assertion | result |
|---|---|
| a WebGL canvas is mounted — the scene draws | `true` |
| the rail renders labelled counts | `292 nodes drawn · 624 edges drawn` / `288 notes scanned · 122 notes carrying links` / `128 unresolved targets · 1 self-links dropped` |
| **R36** — nodes drawn clears the requirement's ≥ 100 bar | `292` |
| **R33** — the rail names its source table verbatim | `source: knowledge_note.links · measured at 2026-08-19T02:32:18.185Z` |
| **the empty panel is ABSENT while a graph exists** | `empty_panel: false` |

The last row is R35's negative control taken at the same instant as R36's positive one.

**R34 is visible in the image**: the amber cluster at the top right is the flat-amber class the
unresolved targets are drawn in — 128 nodes that notes link to and no note answers. They are kept in
the graph on purpose; dropping them would shrink it by 44% while looking perfectly healthy.

---

## 4. R35 — the empty state (`graph-empty-state.png`)

The panel's text is the **server's**, not the component's. The component renders `data.empty_reason`
and has a visible fallback for the case where the server sends none — asserted **not** to have fired,
because a fallback that renders is a contract violation dressed as an empty state:

| assertion | result |
|---|---|
| the empty state renders instead of a black rectangle | `NO GRAPH TO DRAW — AND THIS IS WHY` |
| the panel carries the server's `empty_reason` | present in `body.innerText` (quoted below) |
| the reason names the **rows found** | `288 vault-sync rows scanned` |
| the reason names **what refills the column** | `syncVaultNotes()` |
| the component's contract-violation fallback did NOT render | `contract_fallback: false` |
| the rail agrees with the panel | `0 nodes drawn · 0 edges drawn` |

As rendered:

> read hcp.knowledge_note.links: 288 vault-sync rows scanned, 0 carried a wikilink, 0 self-link(s)
> dropped — no renderable node. hcp.knowledge_note.links is refilled by syncVaultNotes() in
> forge-control/src/db/memory.ts on the 5-minute vault-sync tick (lib/vault-sync-tick.ts); a vault
> whose notes contain no [[wikilinks]] yields an empty graph and that is not an error.
> content_forge.knowledge_triples is NOT read by this endpoint any more.

**This is the state that used to ship as a black rectangle.** The keying is on
`data.nodes.length === 0`, not on the truthiness of `data` — a response object describing nothing is
still truthy (`truthy-zero-object-hides-empty-state`), which is exactly how an empty state gets
skipped. State 2 of §2 is the proof the key is the length and not the object.

---

## 5. Blast radius — what this run could and could not reach

| | check | result |
|---|---|---|
| live `hcp` database | the flip target is asserted in the driver before the first `UPDATE`: `/hcp_scratch_r11_/` matches and `/\/hcp$/` does not | assertion passed; every `UPDATE` ran on the scratch copy |
| live vault | `grep -c` for this round's and round 10's proof markers in `/opt/obsidian-vault/AI OS/Session State - 2026-08-19.md` | `0`; mtime still `2026-08-18 23:48:14 UTC`, unchanged since before round 10 |
| live checkout (N4) | `git -C /opt/forge-ai-os status --porcelain` | empty |
| live forge-control | nothing was restarted; the throwaway ran on :7797 and was killed **by PID from `ss -lntp`**, never `pkill -f` (`pkill-pattern-matches-own-shell`: the pattern matches the tool's own command line and takes the shell with it) | both ports free afterwards |

The scratch database `hcp_scratch_r11_0e8590da950a` is **left in place**, restored to its populated
state by the driver's `finally` block. Dropping a database is a destructive verb and this task carries
no instruction for one; the name carries the run id, so it is unambiguous which run owns it.

---

## 6. What is still not proven from this worktree

Carried forward from `editor-browser-proof.md` §9, unchanged by this round, for phase 7:

1. The graph on **Konrad's** machine. Every measurement here is a headless Chromium on the VPS.
2. Interaction — orbit, zoom and node picking are not exercised; the picked-node panel's text is read
   from the source, not from a click.
3. The empty state as Konrad would ever actually reach it. The only way to get there in production is
   a vault whose notes carry no wikilinks, or a `syncVaultNotes()` that stopped refilling the column —
   the forced version above proves the surface tells the truth when it happens, not that it will.
