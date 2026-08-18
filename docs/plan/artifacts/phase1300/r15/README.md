# R15 click-through — round 1303, on the POST-fix build

**Build under test: `92aeb0ff953efca5f67bc9d6146c5d2db3b95a9b`** (worktree HEAD after
round 1302's fixes). The SHA is stamped in the `meta` block of every JSON here, so
no artifact can be read against the wrong build. **No application code changed in
this round** — `git diff --name-only` over round 1303 is this directory plus
`docs/plan/perf/after.md`.

R15 (`docs/plan/operator-visibility/01-requirements.md`, requirement **R15**):

> Chat rail still: selects on click, shows ✕ close affordance on hover, marks
> selected row, updates status dots live. Side-panel task list still opens runs.

Round 1292 evidenced the **✕ half** and correctly refused to claim the rest
(`docs/plan/perf/after.md` §3.2). This round drives the other four in a real
browser, one committed artifact per assertion.

## Verdict: all four assertions PASS. R15 is CLOSED.

| # | assertion | verdict | artifact |
|---|---|---|---|
| A1 | row click **selects** | **PASS** | `a1-select.json`, `a1-select-{light,dark}.png` |
| A2 | the selected row is **marked**, and exactly one is | **PASS** | `a2-marked.json`, `a2-marked-{light,dark}.png` |
| A3 | status dots are **live** | **PASS** | `a3-live-transition.json`, `a3-live-running-{light,dark}.png` (+ `a3-dots.json`, `a3-dots-{light,dark}.png` for the static half) |
| A4 | the side panel **opens the run** — worker path | **PASS** | `a4-open-worker.json`, `a4-open-worker-{light,dark}.png` |
| A4 | …and the sub-agent path | **PASS** | `a4-open-subagent.json`, `a4-open-subagent-{light,dark}.png` |
| — | the ✕ on hover (round 1292, unchanged) | PASS | `docs/plan/artifacts/phase400/rail-hover-dark.png`, `phase400/rail-shot.cjs` |

Every screenshot exists in **both themes** (`documentElement.dataset.theme`).
Viewport 1440×900.

## What each assertion actually asserts

**A1 — the observable is the request the app fires for the open chat, not the
pixels.** `SidePanel` gets `chatId={selId}` and fetches
`GET /api/proxy/chat/:id/team`; `ChatSurface`'s detail query is keyed
`["chat","run",selId]` and fetches `GET /api/proxy/chat/:id`. Both are keyed on
`selId`, so a change in the id *is* a change in the open chat.
Measured: open chat moved `bfd1283a…` → `e178d084…`, matching `runs[1].id` from the
same list query the rail renders. The middle surface's text changed with it
(recorded in the artifact as corroboration, not as the assertion).

**A2 — computed styles, before and after, on every row.** A row is counted as
marked only when the 2 px left border is actually *painted*: a `transparent`
border is still 2 px wide, so width alone proves nothing. Measured on the clicked
row: `border-left-color` `rgba(0,0,0,0)` → `rgb(87,160,107)`, `background`
`rgba(0,0,0,0)` → `rgb(16,16,19)`, title `rgb(202,202,208)` (`tokens.textLabel`) →
`rgb(237,237,238)` (`tokens.text`). Marked row indexes: `[0]` before → `[1]` after —
**exactly one**, and it is the row that was clicked.

**A3 — a real transition, produced by using the product.** The main pass found no
running chat at all (`a3-dots.json`: 7 rows, all `completed`, 0 pulsing — the rail
header reads `running 0 … completed 7`), so it recorded that honestly as PARTIAL
rather than claiming liveness. The transition was then obtained the legitimate way:
round 1303's **required manager report** was posted through the app's own endpoint,
`POST /api/runs/:id/message`, which put the manager chat back to work.
`a3-live-transition.json` captures both edges, sampled every 2 s:

| t | row 0 | dot colour | dot animation |
|---|---|---|---|
| +28.1 s | completed → **running** | `rgb(87,160,107)` → `rgb(91,141,239)` | `none` → **`pulse`** |
| +39.5 s | **running** → completed | `rgb(91,141,239)` → `rgb(87,160,107)` | **`pulse`** → `none` |

Colour tracked the status text in every sample; no settled row ever carried the
pulse. **Nothing was written to the `runs` table by hand and no transition was
simulated** — the poster is deliberately *not* the script, so a reproduce cannot
spam the manager chat. The static pass additionally corroborates the
running/settled split across the 112 side-panel rows (1 running node with `pulse`,
111 settled with none).

**A4 — both paths through `onOpenNode`, because they are different code.**
`AgentChatView` renders `data-agent-chat-view` with `data-run-id={frame.runId}` and
`data-subagent-id`. A worker resolves to `{runId: node.id}`; a sub-agent resolves to
`{runId: node.parent_id, subagentId: node.id}` (its id is a `tool_use_id`, not a run
id). Measured: the worker row opened `data-run-id=3853c154…`, `data-subagent-id=""`;
the sub-agent row opened the *same* run sliced to
`data-subagent-id=toolu_014raMUrJcAiXV61BerokrjN`.

**The windowing regression risk named in the brief does not exist:** round 1302 did
**not** ship windowing (commit `92aeb0f`, L3 — it would have removed the
keyboard-reachable ✕ from rows outside the visible slice, which R15 protects). All
112 team rows are in the DOM; the artifacts record `team_rows_in_dom`.

## Reproducing

Recipe: `docs/plan/artifacts/phase1290/hover/README.md` §7 steps A–E, with the copy
at `/tmp/phase1303-web` and the port moved to **7793**. Occupied ports at the time
of writing: 7700, 7701, 7791, 7793 (this round), 7798, 7811, 7814, 7815, 7817 —
**check `ss -ltn` before binding and never kill another round's process.**

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# A) worktree API on :7798 — already up. Never boot forge-control/src/index.ts.
curl -s 127.0.0.1:7798/api/health

# B) build the web app AGAINST that harness, into an ISOLATED copy.
#    Never rebuild forge-control-web/.next in place — other rounds serve from it.
rm -rf /tmp/phase1303-web && mkdir -p /tmp/phase1303-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase1303-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase1303-web/node_modules
cd /tmp/phase1303-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the session cookie (read-only source of the live env file)
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase1303 r15 click-through",
  email: "check@localhost", sub: "check" }, secret: process.env.AUTH_SECRET,
  salt: name, maxAge: 60 * 240 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-phase1303.txt && rm mint-cookie.mjs

# D) serve the copy on :7793
ss -ltn | grep -E ':779[0-9]' || true
AUTH_URL=http://127.0.0.1:7793 FORGE_CONTROL_URL=http://127.0.0.1:7798 \
  AUTH_SECRET="$AUTH_SECRET" ./node_modules/.bin/next start -p 7793 &

# E) drive it from the WORKTREE. Output goes to /tmp/r15-out; the committed
#    artifacts are NOT touched unless you pass --commit-artifact.
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1303.txt)"
export R15_BUILD_SHA="$(git rev-parse HEAD)"
node ./docs/plan/artifacts/phase1300/r15/r15-clickthrough.cjs          # A1, A2, A3-static, A4

# A3's live half. Start the watch, then — from another shell, once it prints
# WATCH START — post a real operator message to the manager chat. The script
# never posts: a reproduce must not spam the chat.
R15_MODE=a3watch R15_WATCH_MS=300000 \
  node ./docs/plan/artifacts/phase1300/r15/r15-clickthrough.cjs

# F) no-regression gates (this round changed no code, so they are a sanity check)
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit)
git status --short
```

Playwright comes from `/opt/hermes-workspace/node_modules/playwright` with chromium
out of `/root/.cache/ms-playwright` — the corpus's standing pattern, so neither repo
gains a dependency.

## Citations in this file

**Cite by identity, not by position.** Requirements are cited as
"`01-requirements.md`, requirement **R15**" and sections by heading, never as
`file.md:75`. A line-number citation is correct only until someone inserts a line
above it, and this corpus broke one such citation within a single round of writing
it (round 1301 pushed R15's heading from :75 to :76 and `after.md` was left
pointing at the wrong line). Line numbers are used only for *code*, where the SHA
in `meta.build_sha` pins them.
