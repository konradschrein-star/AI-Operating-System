# Phase 500 (right panel v3) — evidence harness

Round 501b. This round writes **only** the four measurement scripts below and
this README. It does not build the Team panel (round 502) and does not
measure anything — every results table in this file is a stub for round 504
to fill in once the panel exists. Nothing here should be read as a claim
about the panel's behavior.

The scripts are proven two ways, both against the CURRENT (panel-less) build:

1. `node --check <script>.cjs` — all four pass.
2. Each script run against the current build fails with a clear
   `no [data-team-panel] found …` message and a non-zero exit — not a stack
   trace, not a silent PASS. Transcript in [§3 Anti-vacuous-pass proof](#3-anti-vacuous-pass-proof-round-501b).

## 1. What each file is

| File | Protocol | Measures |
|---|---|---|
| `team-frozen.cjs` | U16, 14 §"Frozen-time truth" | samples every row's `[data-working-cell]`/`[data-tokens-cell]` at t and t+12s; settled rows must be byte-identical and carry `data-frozen="true"`; at least one running row must change (anti-vacuous-pass guard — else `SKIPPED-NO-RUNNING`) |
| `team-hover.cjs` | NFU2, 14 §"Hover non-regression" | clone of `phase400/hover-cost.cjs`'s commit/mutation counters, retargeted at `[data-team-scroll] [data-team-row]` (>=20 rows), plus a layout-shift assertion (`getBoundingClientRect()` before/during hover, copied from `phase400/rail-shot.cjs`) |
| `team-network.cjs` | NFU3, 14 §"Poll budget" | 75s network capture with the panel visible, then 75s collapsed; diffs `per_minute` against `phase400/managers-network-after.json` (52 req/min baseline) automatically; fails on budget or leakage while collapsed |
| `capture-team.cjs` | U-various, both-theme evidence | 7 states × 2 themes = 14 screenshots: ready, ambiguous (thread_scan), unlinked, empty, error, hover, armed |

None of these touch `forge-control/` or `forge-control-web/` — verified by
`git status --short` in [§4](#4-verification-commands-run-this-round).

## 2. How to reproduce

Same harness as `phase400/README.md` §2 (worktree API on :7798, proxy target
baked at build time, session cookie minted separately). Repeated here in full
because round 501b found ports `:7789`/`:7788` already held by another
round's live processes — **do not kill them**; this round used `:7787`
instead, with an isolated build directory so the shared `.next` build those
processes were serving was never touched.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7798 (NEVER boot forge-control/src/index.ts, never pm2).
#    Skip this step if another round's :7798 is already up — check first:
#    curl -s 127.0.0.1:7798/api/health
(cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# B) build the web app AGAINST the harness, into an ISOLATED copy — the round
#    501b discovery: if another round's `next start` is already serving from
#    forge-control-web/.next in place, rebuilding it there mid-serve corrupts
#    their session. Copy the tree (symlink node_modules, it's 900MB+) and
#    build in the copy instead. This is the same pattern phase400 used for
#    its pre-phase baseline (`/tmp/hover-before`), just applied proactively.
rm -rf /tmp/phase500-web
mkdir -p /tmp/phase500-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase500-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase500-web/node_modules
cd /tmp/phase500-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the session cookie (/desktop is behind OAuth) — from inside the copy
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase500 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 120 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-phase500.txt && rm mint-cookie.mjs

# D) serve the copy — port 7787 (7789/7788 were live with another round;
#    move further, e.g. 7786/7785, if 7787 is also taken by the time you run
#    this). AUTH_SECRET must be exported into the server's own env, not just
#    the cookie-minting subshell — MissingSecret otherwise.
AUTH_URL=http://127.0.0.1:7787 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7787 &

# E) run scripts from the WORKTREE (not the /tmp copy) against that server
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase500.txt)"
export TEAM_BASE_URL=http://127.0.0.1:7787
```

Playwright is required from `/opt/hermes-workspace/node_modules` by absolute
path; chromium is resolved from `/root/.cache/ms-playwright` via
`resolveChromium()`, copied verbatim from `scripts/checks/frozen-dom.cjs:30-58`
in every script. Never a dependency of either repo (NFU8) — verified in
[§4](#4-verification-commands-run-this-round).

### One command per script

```bash
node docs/plan/artifacts/phase500/team-frozen.cjs
node docs/plan/artifacts/phase500/team-hover.cjs
node docs/plan/artifacts/phase500/team-network.cjs
node docs/plan/artifacts/phase500/capture-team.cjs
```

Each accepts overrides via env vars (`TEAM_CHAT_TEXT`, `TEAM_CHAT_READY`,
`TEAM_CHAT_AMBIGUOUS`, `TEAM_CHAT_UNLINKED`, `TEAM_HOVER_LABEL`,
`TEAM_WATCH_LABEL`, `TEAM_WATCH_SECONDS`, `ABORT_SSE` — see each file's header
comment for the full list). For a hover before/after comparison, point
`TEAM_BASE_URL` at two different builds with different `TEAM_HOVER_LABEL`
values, same pattern as `phase400/hover-cost.cjs`.

## 3. Fixture chats (verified via curl against :7798, 2026-08-05)

| Chat | link_source | project | workers | Used as |
|---|---|---|---|---|
| `c0de0304-0000-4000-8000-000000000304` | `metadata` | `4d3291c4…` (done) | 2 | ready |
| `11dd264b-f173-44d7-ada4-f1eb39fb4abd` | `thread_scan`, ambiguous | `1d574922…` (paused) | 11 | ambiguous, thread_scan marker |
| `bfd1283a-b71b-4f35-b577-7d09aad803f2` | `null` | `null` | 0 | unlinked |
| `00000000-0000-0000-0000-000000000000` | — | — | — | 404 (used by `capture-team.cjs`'s error case, and directly curlable) |
| any non-UUID string | — | — | — | 400 |

**Fixture drift from the round-501b brief.** The brief names
`bfd1283a-b71b-4f35-b577-7d09aad803f2` as "backfilled origin_chat_id, owns
THIS project (many workers)". Curled directly today it returns
`"project": null, "workers": []` — the same unlinked state
`phase400/README.md` §3 documented for it in round 403. Nothing in this
worktree re-ran the backfill in between; the brief's description reflects an
intent that was checked-and-not-done in round 403
(`phase400/linkage-dryrun.txt`: zero scan candidates in that chat), not a
current fact. This round used it as the **unlinked** fixture instead, and
picked `c0de0304…` (real project link, small tree) for the **ready** case.
Re-verify with `curl -s 127.0.0.1:7798/api/chat/<id>/team | head -c 400`
before round 504 trusts any of these — a live database changes under you.

**No "empty" fixture exists in live data** (a chat linked to a project with
zero workers). Same finding phase400's round403 made for the `0/0 tasks`
badge case. `capture-team.cjs`'s `empty` case fakes the `/team` response
client-side via `page.route`, exactly as `phase400/rail-zero-fixture.cjs`
faked `0/0 tasks` — labelled `"data": "synthetic"` in `capture-team.json`.
The `error` case, by contrast, rewrites the outgoing request to the nonsense
UUID above and lets the real backend answer 404 — a real error, not a fake.

## 4. Verification commands run this round

```
$ node --check team-frozen.cjs && node --check team-hover.cjs \
    && node --check team-network.cjs && node --check capture-team.cjs
(all four: no output = OK)

$ grep -rn "playwright" forge-control/package.json forge-control-web/package.json
(empty)

$ git status --short
?? docs/plan/artifacts/phase500/
```

## 5. Anti-vacuous-pass proof (round 501b)

Each script run against the current build (no Team panel exists yet — round
502 builds it) via the harness in §2, `TEAM_BASE_URL=http://127.0.0.1:7787`:

```
$ node team-frozen.cjs
FAIL: no [data-team-panel] found in the DOM within 15000ms at http://127.0.0.1:7787
  (chat "Okay this session is very important") — the Team panel does not
  exist yet, or the chat text did not match a rail row
exit 1

$ node team-hover.cjs
FAIL: no [data-team-panel] found in the DOM within 15000ms at http://127.0.0.1:7787
  (chat "Okay this session is very important") — the Team panel does not
  exist yet, or the chat text did not match a rail row
exit 1

$ node team-network.cjs
FAIL: no [data-team-panel] found in the DOM within 15000ms at http://127.0.0.1:7787
  (chat "phase300 round-304 linkage fixture") — the Team panel does not exist
  yet, or the chat text did not match a rail row
exit 1

$ node capture-team.cjs
FAIL: ready: no [data-team-panel] found in the DOM within 15000ms — the Team
  panel does not exist yet
FAIL: ambiguous: no [data-team-panel] found in the DOM within 15000ms — …
FAIL: unlinked: no [data-team-panel] found in the DOM within 15000ms — …
FAIL: empty: no [data-team-panel] found in the DOM within 15000ms — …
FAIL: error: no [data-team-panel] found in the DOM within 15000ms — …
FAIL: hover: no [data-team-panel] found in the DOM within 15000ms — …
FAIL: armed: no [data-team-panel] found in the DOM within 15000ms — …
CAPTURE-TEAM: FAIL (0/7 cases)
exit 1
```

Clean one-line diagnostics, non-zero exit, no stack trace, no silent PASS —
exactly what a script measuring a panel that does not exist yet must produce.

**A real bug this proof caught and fixed**: all four scripts originally called
`browser.close()` only on the success path. The first live run of
`team-frozen.cjs` against this same build printed the correct FAIL message
but then hung — Playwright's browser process kept the event loop alive, so
Node never exited on its own and the run had to be killed by an external
timeout. Every script's `main()` now wraps its browser-using body in
`try { … } finally { await browser.close(); }` so `browser.close()` runs on
every exit path, error included. Re-run after the fix: clean exit, no hang,
confirmed above.

## 6. Results (round 504 fills this)

<!-- round 504 fills this -->

### Frozen-time truth (`team-frozen.cjs`)

<!-- round 504 fills this -->

### Hover non-regression (`team-hover.cjs`)

<!-- round 504 fills this -->

### Poll budget (`team-network.cjs`)

<!-- round 504 fills this -->

### Screenshots (`capture-team.cjs`)

<!-- round 504 fills this -->
