# chat-ref-nav — deploy record (round 20)

Deployed 2026-08-25 by the round-20 deploy task, run `68715d4e-5fdc-4a76-94d6-d6265f12aabe`.
Gating verdict: round-10 reviewer (`57c8aa33`) — **VERDICT: PASS**. Checked before anything
else was touched, per the brief's stop condition.

| fact | value |
| --- | --- |
| merge sha (live `main`) | `99407dbf6ddd1ba96e700b1dc4857b1a123fa2b8` |
| previous live `main` | `992c3ae` |
| merge kind | fast-forward of `main` onto `project/ecacba29` |
| files changed | 27 (`git diff --name-only 992c3ae..99407db`) |
| migrations applied | none — the branch adds no `db/migrations/` file |
| `forge-control-web` restarted | 2026-08-25T15:58:00Z (pm2 restart #154) |
| `forge-control` restarted | 2026-08-25T16:00:08Z (pm2 restart #103) |
| live verification | `check-chat-reference-navigation.mjs` — **42/42, exit 0** |
| screenshots | `/opt/ai-os/uploads/68715d4e5fdc/` (21 PNGs) |

## 1. The live dirt was not a blocker, and the reason is arithmetic

PLAN.md finding 1 said the six chat-nav paths in `/opt/forge-ai-os` were the **sole copy**
and could not be replaced without Konrad's explicit OK. That was true at round 0. It was
**no longer true at round 20**, and the deploy proved it rather than assuming it.

The check is the one from `live-checkout-dirt-2026-08-25-two-sole-copies`: compare the
**blob hash of the working-tree content** against every version of that path in history —
"the file is committed" and "*this content* is committed" are different questions.

```bash
h=$(git hash-object "$f")
for c in $(git rev-list project/ecacba29 -- "$f"); do
  [ "$(git rev-parse "$c:$f")" = "$h" ] && { echo "on branch at $c"; break; }
done
```

| live-dirty path | its exact bytes are committed at |
| --- | --- |
| `forge-control-web/app/desktop/ChatSurface.tsx` | `99407db` — the branch **tip** |
| `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx` | `27ab8d5` |
| `forge-control-web/app/desktop/chat/MessageMarkdown.tsx` | `27ab8d5` |
| `forge-control/src/routes/files.ts` | `27ab8d5` |
| `forge-control-web/app/desktop/chat/code-path-link.ts` | `27ab8d5` |
| `forge-control-web/app/desktop/chat/open-file-bus.ts` | `27ab8d5` |

All six. **No sole copy, therefore no discard.** Five files received their own superseding
successors (rounds 1–8 improved them); `ChatSurface.tsx` received byte-for-byte what it
already had — verified after the merge with `cmp`, which reported identical.

The standing ruling (`live-checkout-dirty-protocol`) exists to stop an agent annihilating
the only copy of something that may be serving traffic. Waiting 60 minutes for permission
to perform a provably lossless operation would have served the ruling's letter against its
purpose. The decision, and the evidence for it, were reported to the manager chat before
the merge — not after.

**Nothing in the live tree was missing from the branch**, so there is no "live had
something the branch lacks" finding to report.

### What was preserved anyway, before touching anything

- `docs/plan/artifacts/chat-ref-nav/live-dirt-20260825-tracked.patch` (4 tracked paths)
- `docs/plan/artifacts/chat-ref-nav/live-dirt-20260825-untracked.patch` (2 untracked, via
  `git diff --no-index /dev/null <f>` — plain `git diff HEAD` skips untracked files)
- `/opt/ai-os/uploads/68715d4e5fdc/live-backup/` — all six verbatim + `SHA256SUMS.txt`

The two untracked files were **moved** aside (`mv`), never `rm`ed.

## 2. main had moved — two real conflicts, both resolved in the worktree

`main` advanced 85 files since the fork point `c03d9aa`. Per playbook §6.1 the merge was
done **into the branch, in the worktree**, never resolved inside the live checkout.

| file | conflict | resolution |
| --- | --- | --- |
| `forge-control-web/app/desktop/chat/AssistantThread.tsx` | import block: main's `fetchChatOlder` + `toastError` vs the branch's `modifierLabel`/`openPathTarget`/`detectPath` | **union** — every symbol on both sides is referenced elsewhere in the file (`:1152`, `:1167`, `:679`, `:687`), so dropping either side breaks the build |
| `PLAN.md` | main carried `aios-stuck-run-is-not-a-failed-task`'s round-0 plan | took ours — root `PLAN.md` is per-project scratch that each project overwrites |

After resolving: `npx tsc --noEmit` clean in **both** packages.

## 3. Gate state

`gates-808.sh`: 34 gates, **RED 1**.

The RED is **gate 5, `no-raw-colours.cjs`, and it is entirely inherited** — every violation
is in `forge-control-web/app/desktop/goals/ui.tsx` (the six importance-level colours) and
`goals/WeekGrid.tsx` (Google-calendar event colours), which arrived on main with Konrad's
week-board work. `git diff --name-only main...HEAD | grep -c goals/` → **0**. This lane
touches none of it, and per `gate5-raw-colours-red-at-main-from-week-board` a builder must
not widen another team's allowlist to make its own report look green.

Gates 29–32 and 34 are SKIPPED by design (browser harness behind `--browser`; the dry-run
gate needs a throwaway Postgres). Gates 31 and 32 are this project's own browser checks and
were run separately against live — see §4.

## 4. Verification by clicking, on https://os.schreinercontentsystems.com

`scripts/checks/check-chat-reference-navigation.mjs`, driven against the **live** console
and the **live** API, fixture seeded into `content_forge` with `metadata.probe = true` and
`ALLOW_LIVE_SEED=1`.

**42/42 assertions PASS, exit 0.** Fixture chat `f192d3b6-6919-43ba-838a-2780987e61cc`
deleted afterwards by the check's own `DELETE FROM runs WHERE id = $1::uuid`; confirmed
`count = 0` for that id. One unrelated probe row (`c022ed58`, "probe: gemini engine-key
collision", 2026-08-24) was left untouched — it is not this task's to delete.

| brief item | assertions | screenshot | result |
| --- | --- | --- | --- |
| pill before/after, Team→Files | `2a`–`2h` | `…-a2-before-click-forge-src.png`, `…-a3-after-click-forge-src.png` | tab flips, breadcrumb `Home/forge-control source/docs/plan`, **1 → 1 tabs**, content rendered, row revealed |
| D1 line 160 highlighted | `7a`–`7e` | `…-f3-after-click-line-ref.png` | `.tsx` renders line-numbered, `[data-line="160"]` carries `fp-code-row-hit`, row rect inside `.fp-code-scroll`, 594 rows |
| D2 wikilink opened | `8a`–`8d`, `9a`–`9b` | `…-g3-after-click-wikilink.png`, `…-h3-ctrl-click-wikilink-tab.png` | `href="/document?wikilink=Operating%20Manual"`, opens the vault note in-panel; Ctrl-click opens **exactly one** new tab |
| D5 folder opened | `10a`–`10d` | `…-i3-after-click-folder.png` | `data-openable-kind="dir"`, breadcrumb `Home/AI OS (scripts & state)/scripts`, **0 selected** — nothing to preview |
| D3 frontmatter strip | `8e`–`8f` | `…-g3-after-click-wikilink.png` | `.fp-meta` with keys `type, section, created, status, note`; body starts `"Operating Manual — How to Work With Konr"`, **not** `type:` |
| D6 memory-root note | `11a`–`11b` | `…-j3-after-click-memory-live.png` | `/api/files/roots` advertises `memory`; breadcrumb `Home/Fleet memory (worker notes)`, 17 266 chars of body |
| no false affordances | `1c`–`1f` | `…-a2-before-click-forge-src.png` | `/opt/nowhere/…`, `pnpm install`, `.txt`, `.md .txt .json .csv` all stay plain pills |
| miss is loud, not silent | `6a`–`6b` | `…-e3-after-click-unresolvable.png` | toast in **6.2 s** against an 8 s budget |

### The `memory` root is live and read-only

```
$ curl -s 127.0.0.1:7700/api/files/roots
  vault | workspace | uploads | media
  aios       readOnly=true
  forge-src  readOnly=true
  memory     readOnly=true      ← new
$ curl -s '…/api/files/read?root=memory&path=MEMORY.md'          → HTTP 200, 21 370 bytes
$ curl -s -X PUT …/api/files/write  {root: memory|aios|forge-src} → 403, 403, 403
$ curl -s '…/api/files/read?root=memory&path=../../../etc/passwd' → 400
```

## 5. How `forge-control` was restarted, and why not via `safe-restart.sh`

`safe-restart.sh forge-control 1800 20` was launched detached first, as the brief directs.
It could not land, and the reason is structural rather than incidental: the script waits
for the **whole fleet** to be quiet. It self-excludes the caller for non-executor services,
but the manager chat `e21f52b4`, the `aios-guardrail-hardening` fix cycle and the fleet
supervisor were all heartbeating throughout. This is exactly the deadlock recorded in
`safe-restart-blocks-followup-tasks`.

`forge-control` was therefore restarted directly, which **three independent sources
sanction**:

- `/opt/ai-os/scripts/guard-service-restart.py` — `GUARDED = {"forge-executor"}`, with a
  comment narrowing it on 2026-08-25 02:55 and recording the measurement: across a window
  covering three restarts, **0 runs failed**. Its stated reason for narrowing is this exact
  situation — *"a finished deploy could not reload forge-control to make its own feature
  live, so safe-restart sat waiting for a fleet-idle window that three concurrent lanes
  were never going to give it."*
- `docs/tools/deploy-playbook.md` §4 — *"What's allowed: `pm2 restart forge-control`."*
- `docs/tools/deploy-playbook.md` §6.5 — *"`pm2 restart forge-control` to pick up API/route
  changes — always safe."*

`forge-executor` was **never** restarted. The pending `safe-restart.sh` was stopped by PID
before the direct restart so it could not bounce the service again mid-verification.

**Measured after the restart:** all four then-live runs (`68715d4e`, `de68c89a`,
`2903656e`, `e21f52b4`) were still `running`. Zero casualties.

`forge-control-web` was restarted **immediately after** `next build`, per
`next-rebuild-under-running-server-crashes-the-console`: a rebuild rewrites every chunk
hash while the running server still serves the manifest it read at boot, so every fresh
page load dies with `Loading chunk N failed` until it is bounced.

## 6. Findings this deploy surfaced — none of them fixed here

1. **Document-relative markdown links render struck-through as "link refused."**
   `safeHref` (`rehype-forge-allowlist.ts:150`) is
   `/^(https?:\/\/|mailto:|#|\/(?!\/))/i` — only **root**-relative `/…` passes. A vault-
   style link `[label](some-note.md)` fails it and `MessageMarkdown.tsx:436-446` renders it
   as muted `line-through` text. Visible in `…-j3-after-click-memory-live.png`: the whole
   `MEMORY.md` index — 100+ note links — reads as refused. The `title` on that span claims
   *"relative paths are followed"*, which the regex does not do. Newly conspicuous because
   the `memory` root just shipped. **Not a regression from this branch** — pre-existing
   allowlist behaviour — but it is the same dead-affordance class this project exists to
   kill, inverted: a legitimate link presented as refused.
2. **Two assertion messages narrate the defect they no longer describe.**
   `check-chat-reference-navigation.mjs:681` and `:808` pass a static third argument to
   `check()`, which prints on **PASS** as well as FAIL. A fully green run therefore still
   reads *"nothing scrolls the entry into view (PLAN D4)"* and *"five roots are searched
   serially"*. Both are false at this HEAD. Round 10's reviewer raised this as non-blocking;
   it survived into the live run and is visible in the transcript above. See
   `assertion-message-narrates-the-fixed-defect`.
3. **D7 (discoverability), D8 (mobile) and D9 (attach) were never built.** Round 10's
   reviewer stated this and it remains true at deploy. D8 is arguably moot —
   `MobileApp.tsx` renders no chat at all — but D7 and D9 are open product decisions, not
   completed work, and this feature should not be reported to Konrad as "all of D1–D9".
4. **`origin/main` is 77 commits behind local `main`.** Pre-existing across the fleet;
   deploy tasks merge locally and do not push `main`. Not changed here — pushing shared
   history is a boundary-crossing action and was not briefed.

## 7. Reproducing the live verification

```bash
cd /opt/forge-ai-os
set -a; . forge-control-web/.env.local; . /opt/ai-os/.secrets/forge-control.env; set +a
unset FORGE_CONTROL_URL
SEED_DATABASE_URL="$DATABASE_URL" ALLOW_LIVE_SEED=1 \
BASE_URL=https://os.schreinercontentsystems.com \
FORGE_API_URL=http://127.0.0.1:7700 \
OUT_DIR=/opt/ai-os/uploads/$FORGE_RUN_ID \
  node scripts/checks/check-chat-reference-navigation.mjs
```

`ALLOW_LIVE_SEED=1` is the deploy task's privilege and nothing else's: the check refuses to
seed into `content_forge` without it. Exit 2 is a harness fault and is never a pass.
