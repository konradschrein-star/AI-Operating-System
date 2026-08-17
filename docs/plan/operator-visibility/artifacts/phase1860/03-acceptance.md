# Round 1863 — Production acceptance, by hand, in a real browser (step 3a of 4)

Ran 2026-08-17, 07:38–08:10 UTC (09:38–10:10 local).

**Target: PRODUCTION ONLY.** `http://127.0.0.1:7701` (pm2 `forge-control-web`, pid 2108274)
and `http://127.0.0.1:7700` (pm2 `forge-control`, pid 2061337). No worktree next-server was
started. `:7799` and the other three `/tmp` harnesses were never opened — the entire point of
this round is that harness-green and production-green diverged, so nothing here is measured
against a harness.

Gate read first: `docs/plan/operator-visibility/artifacts/phase1860/02-deploy.md`. Its verdict
is **DEPLOYED AND VERIFIED** — web rebuilt at BUILD_ID `_BZ1j6SB83vj36B_yxlTW`, served bytes
proven to be that build, forge-executor untouched at 0 restarts. The deploy did not stop, so
this acceptance proceeded.

Parity of what I read to what is deployed: live `/opt/forge-ai-os` `main` = `3706160`; this
worktree branch is one commit ahead (`091e05c`, the deploy document) and that commit carries
**no code**. Every code file quoted below is byte-identical to what pm2 is serving.

**Screenshots: `/opt/ai-os/uploads/dbb65f80ce12/` — 45 PNGs, index in §6.**

---

## Verdict table

| # | Item | Verdict |
|---|---|---|
| 1 | Konrad's settings click, hand-checked, both themes | **PASS** |
| 2 | Frozen elapsed — wire (two curls) and DOM (two screenshots) | **PASS**, with one caveat recorded |
| 3 | `/api/capabilities` — five keys | **PASS** |
| 4 | Both themes, every surface a deferred phase touched | **PASS with 3 findings** |
| 5 | Noise-floor discipline | **PASS** — no timing number is reported as an effect |

Four findings are recorded in §5. **None of them is a regression in this project's own work**
and none blocks the deploy. Fixing them belongs to a fix cycle, not to this task.

---

## §0. The auth recipe every earlier round used does not work against production

Worth writing down before the evidence, because it cost the first twenty minutes and will cost
the next agent the same.

Production `AUTH_URL` is `https://os.schreinercontentsystems.com`, so auth.js uses **secure
cookies**: the session cookie is named `__Secure-authjs.session-token`, and in auth.js v5 the
cookie name is also the **JWE salt**. Every prior round's mint script
(`/tmp/mint-cookie.mjs`, `frozen-dom.cjs`'s documented recipe) salts with
`authjs.session-token`, which is correct for the http harnesses those rounds used and is
rejected by production:

```
$ for N in "__Secure-authjs.session-token" "authjs.session-token" \
           "next-auth.session-token" "__Secure-next-auth.session-token"; do
    curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: $N=$TOKEN_SALTED_authjs" \
      http://127.0.0.1:7701/desktop
  done
307      307      307      307        <-- all four, with the old salt

$ # re-minted with salt = "__Secure-authjs.session-token"
$ curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Cookie: __Secure-authjs.session-token=$TOKEN" http://127.0.0.1:7701/desktop
200
```

The 307 goes to `https://os.schreinercontentsystems.com/signin` and looks exactly like "your
token expired". It is not — it is the wrong salt. Mint for production with:

```js
await encode({ token: {...}, secret: process.env.AUTH_SECRET,
               salt: "__Secure-authjs.session-token", maxAge: 60*300 })
```

and hand it to Playwright as `{ name: "__Secure-authjs.session-token", domain: "127.0.0.1",
secure: true }` — `secure: false` is rejected by CDP for a `__Secure-` prefixed name with
`Protocol error (Storage.setCookies): Invalid cookie fields`.

No login wall was hit and no credential was entered. Scripts used:
`/tmp/r1863-accept.cjs`, `/tmp/r1863-probe2.cjs`, `/tmp/r1863-probe3.cjs`,
`/tmp/r1863-frozen-dom.cjs`, `/tmp/r1863-contrast.cjs`.

---

## §1. Konrad's own complaint, hand-checked — **PASS**

> "please rework the settings panel so that if I click on it the sidebar doesn't disappear all
> of a sudden."

A code reading is not acceptance here, so this is a real Chrome, on the deployed build, with a
chat open, clicking the thing he clicks.

**Sequence, both themes:** open `/desktop` → click `CHAT` in the top nav → the last-open chat
mounts (`bfd1283a`, "Okay when I click the file section…") → screenshot → **click SETTINGS in
the left rail** → screenshot → click `CHAT` again → screenshot.

### After the click, measured in the DOM

| assertion | dark | light |
|---|---|---|
| left rail element still has a non-zero box | **true** | **true** |
| all 18 rail nav labels still present (`railLabelsMissing`) | **`[]`** | **`[]`** |
| brand header (`forge`) still mounted | **true** | **true** |
| footer identity (`konrad`) still mounted | **true** | **true** |
| `location.pathname` | **`/desktop`** | **`/desktop`** |
| `[data-settings-surface]` present | **true** | **true** |
| settings sections rendered | `["index"]` → ACCOUNTS / SECRETS / USAGE / INTEGRATIONS | same |
| rail left edge (px) | 0 | 0 |

### The open chat is not lost

`[data-run-id]` before the click and after returning from SETTINGS is the **same run id** in
both themes — the check `the same chat is still open after returning from SETTINGS` compares
the two attribute values directly and passed twice.

### THE RAIL DOES NOT VANISH ON THE DEPLOYED BUILD.

Konrad was describing the pre-`1350` behaviour, where SETTINGS was a `next/link` to `/settings`
that unmounted the whole OS. The deployed build renders it as a surface: top nav, left rail,
footer and route all survive; only the content column changes. His complaint is closed against
the thing he actually touches.

**One honest qualification, so nobody is surprised.** The brief's phrase "the live panel is
STILL THERE" does not hold literally and should not: while the settings surface is open the
right-hand team panel is **not** rendered (`teamPanel: false`). That is true of every non-chat
surface — TODAY, LIVE, PROJECTS all replace the content column the same way — and it is not
what Konrad complained about. He said *sidebar*, and the sidebar is the left rail, which stays.
Recorded as behaviour, not as a defect.

**Screenshots** (all under `/opt/ai-os/uploads/dbb65f80ce12/`):

| what | file |
|---|---|
| before click, chat open, dark | `settings-before-click-dark.png` |
| before click, chat open, light | `settings-before-click-light.png` |
| after click, dark | `settings-after-click-dark.png` |
| after click, light | `settings-after-click-light.png` |
| chat restored after returning, dark | `chat-restored-dark.png` |
| chat restored after returning, light | `chat-restored-light.png` |

---

## §2. Frozen elapsed — **PASS**

Two independent claims, deliberately proven separately: **the wire** being frozen and **the
DOM** being frozen are different statements.

### 2a. Wire — `/api/chat/bfd1283a-…/team`, two curls 45 s apart

```
T0_WALL=2026-08-17T07:39:16.928Z   bytes=10090
T1_WALL=2026-08-17T07:40:02.042Z   bytes=10090     (gap 45.11 s)
```

Every one of the **17** nodes is settled, and every settled node's `working_ms` is
byte-identical across the two samples:

| node id | section | role | status | working_ms t0 | working_ms t1 | Δ | verdict |
|---|---|---|---|---|---|---|---|
| `bfd1283a-b71b-4f35-b577-7d09aad803f2` | manager | — | completed | 10588991 | 10588991 | 0 | FROZEN-OK |
| `4702dd4b-dcb3-4975-904c-76bc3547a1db` | worker | architect | completed | 1311143 | 1311143 | 0 | FROZEN-OK |
| `0bab20d0-c950-43bf-a277-69b39e10cd27` | worker | builder | completed | 395390 | 395390 | 0 | FROZEN-OK |
| `ecc74b0f-695a-45be-a36d-6c24537941c7` | worker | builder | completed | 312414 | 312414 | 0 | FROZEN-OK |
| `3f273fd2-c3af-4c14-80e7-eae5d4cfed14` | worker | builder | completed | 359577 | 359577 | 0 | FROZEN-OK |
| `6e043044-bbc5-46ab-a9be-6f0ef5c23389` | worker | builder | completed | 822380 | 822380 | 0 | FROZEN-OK |
| `2c6e45d5-db81-4ff8-ac68-fcf98c579e75` | worker | builder | completed | 916220 | 916220 | 0 | FROZEN-OK |
| `f6838a8c-670d-4e15-81fa-55232d93fa9a` | worker | builder | completed | 475529 | 475529 | 0 | FROZEN-OK |
| `a3eb31ea-6350-468c-8974-dc139e7ce953` | worker | builder | completed | 226592 | 226592 | 0 | FROZEN-OK |
| `c87d2349-e775-4c97-b472-e3c84617e43c` | worker | builder | completed | 614442 | 614442 | 0 | FROZEN-OK |
| `ad37034a-57dc-47f3-b586-e6fb8ccafbfb` | worker | builder | completed | 579606 | 579606 | 0 | FROZEN-OK |
| `f1773e99-952e-458c-8079-8800e0ff70df` | worker | builder | completed | 477328 | 477328 | 0 | FROZEN-OK |
| `b3e225fd-58fc-4849-b364-efd2d94f99b6` | worker | planner | completed | 378718 | 378718 | 0 | FROZEN-OK |
| `d521ff04-a4f0-415b-85dd-9bcdf1d17734` | worker | planner | completed | 683520 | 683520 | 0 | FROZEN-OK |
| `fd6a1cba-b5cc-4cfe-9c1e-194b533b5152` | worker | reviewer | completed | 691725 | 691725 | 0 | FROZEN-OK |
| `f924fd72-b8a9-4f20-95ae-1970989f3db2` | worker | reviewer | completed | 421437 | 421437 | 0 | FROZEN-OK |
| `dd8e3131-57ad-4f9b-a77e-a7aa43cdf8a8` | worker | scout | completed | 178137 | 178137 | 0 | FROZEN-OK |

**settled frozen 17 / settled ticked 0 / live advanced 0.**

**Caveat, stated plainly rather than reinterpreted:** this team had **no running node at
07:39**, so this sample alone does not prove the clock ticks. The brief anticipated exactly
that. The live half is therefore proven twice below — once on `/api/agents` (2b) and once on
this same team panel in the DOM at 08:00 (2c), by which time the manager row was running again.

### 2b. Wire — `/api/agents`, two curls 48 s apart (the live half)

```
now t0 = 2026-08-17T07:41:34.602Z
now t1 = 2026-08-17T07:42:22.634Z     (gap 48.032 s)
61 nodes in each sample, none appearing or vanishing
```

- **58 settled run rows compared → 58 byte-identical `elapsed_ms`, 0 ticked.**
- **2 running run rows, both ADVANCED:**

| run | role | elapsed_ms t0 | elapsed_ms t1 | Δ |
|---|---|---|---|---|
| `07e59e8e-7acf-4077-a10b-53ed900631cf` | builder | 196377 | 244409 | **+48032 ms** |
| `dbb65f80-ce12-41ab-bcdd-6fa2d3778d02` | builder | 196403 | 244435 | **+48032 ms** |

Both deltas equal the wall gap to the millisecond. The settled rows did not move; the live rows
moved by exactly the elapsed time. **The clock ticks, and only for live rows.**

- 1 sub-agent node present in both samples (`toolu_019chfnX`, role scout, status `done`), its
  `ended_at` identical across the pair.

### 2c. DOM — the same claim with my eyes, both panels, 50 s apart

Script: `/tmp/r1863-frozen-dom.cjs`. Duration cells are keyed by the row's own identity —
`.live-row`'s `title` (which ends in `run <8hex>`) on the Live panel, and
`[data-team-row]`'s `data-node-id` on the team panel — not by DOM order.

**Live panel, 07:59:40.596Z → 08:00:30.705Z (50 s)** — `frozen-live-t0-dark.png` /
`frozen-live-t1-dark.png`:

| run | clock the render claims | t0 | t1 | verdict |
|---|---|---|---|---|
| `07e59e8e` | running for this long | 21m 21s | 22m 12s | **LIVE-ADVANCED** |
| `dbb65f80` | running for this long | 21m 21s | 22m 12s | **LIVE-ADVANCED** |
| `07e59e8e` (sub) | total subagent run time | 4s | 4s | FROZEN-OK |
| `ab176b64` | total run time | 6m 06s | 6m 06s | FROZEN-OK |
| `858fddb2` | total run time | 6m 50s | 6m 50s | FROZEN-OK |
| `80b95c79` | total run time | 7m 11s | 7m 11s | FROZEN-OK |
| `c79b3289` | total run time | 5m 30s | 5m 30s | FROZEN-OK |
| `92681c10` | total run time | 9m 37s | 9m 37s | FROZEN-OK |
| `7f35bdf8` | total run time | 15m 58s | 15m 58s | FROZEN-OK |
| `e3d64583` | total run time | 16m 52s | 16m 52s | FROZEN-OK |
| `d0c78bc1` | total run time | 12m 10s | 12m 10s | FROZEN-OK |
| `9774b692` | total run time | 18m 33s | 18m 33s | FROZEN-OK |
| `02139695` | total run time | 39m 16s | 39m 16s | FROZEN-OK |
| `b8b2b9b8` | total run time | 13m 02s | 13m 02s | FROZEN-OK |
| `fc1046ed` | total run time | 1m 16s | 1m 16s | FROZEN-OK |

`frozenOK=13  TICKED=0  advanced=2  gone=0`. The two live cells moved 21m21s → 22m12s = **51 s**
against a 50.1 s gap (one 1 s tick boundary), the 13 settled cells did not change by a character.

**Team panel, 08:00:38.885Z → 08:01:29.015Z (50 s)** — `frozen-team-t0-dark.png` /
`frozen-team-t1-dark.png`:

| node (`data-node-id`, in full) | clock | t0 | t1 | verdict |
|---|---|---|---|---|
| `bfd1283a-b71b-4f35-b577-7d09aad803f2` | working time, still running | 2h 57m | 2h 58m | **LIVE-ADVANCED** |
| `4702dd4b-dcb3-4975-904c-76bc3547a1db` | frozen at settle | 21m 51s | 21m 51s | FROZEN-OK |
| `b3e225fd-58fc-4849-b364-efd2d94f99b6` | frozen at settle | 6m 18s | 6m 18s | FROZEN-OK |
| `dd8e3131-57ad-4f9b-a77e-a7aa43cdf8a8` | frozen at settle | 2m 58s | 2m 58s | FROZEN-OK |
| `ecc74b0f-695a-45be-a36d-6c24537941c7` | frozen at settle | 5m 12s | 5m 12s | FROZEN-OK |
| `0bab20d0-c950-43bf-a277-69b39e10cd27` | frozen at settle | 6m 35s | 6m 35s | FROZEN-OK |
| `3f273fd2-c3af-4c14-80e7-eae5d4cfed14` | frozen at settle | 5m 59s | 5m 59s | FROZEN-OK |
| `f6838a8c-670d-4e15-81fa-55232d93fa9a` | frozen at settle | 7m 55s | 7m 55s | FROZEN-OK |
| `ad37034a-57dc-47f3-b586-e6fb8ccafbfb` | frozen at settle | 9m 39s | 9m 39s | FROZEN-OK |
| `a3eb31ea-6350-468c-8974-dc139e7ce953` | frozen at settle | 3m 46s | 3m 46s | FROZEN-OK |
| `fd6a1cba-b5cc-4cfe-9c1e-194b533b5152` | frozen at settle | 11m 31s | 11m 31s | FROZEN-OK |
| `2c6e45d5-db81-4ff8-ac68-fcf98c579e75` | frozen at settle | 15m 16s | 15m 16s | FROZEN-OK |
| `f924fd72-b8a9-4f20-95ae-1970989f3db2` | frozen at settle | 7m 01s | 7m 01s | FROZEN-OK |
| `d521ff04-a4f0-415b-85dd-9bcdf1d17734` | frozen at settle | 11m 23s | 11m 23s | FROZEN-OK |
| `f1773e99-952e-458c-8079-8800e0ff70df` | frozen at settle | 7m 57s | 7m 57s | FROZEN-OK |
| `c87d2349-e775-4c97-b472-e3c84617e43c` | frozen at settle | 10m 14s | 10m 14s | FROZEN-OK |
| `6e043044-bbc5-46ab-a9be-6f0ef5c23389` | frozen at settle | 13m 42s | 13m 42s | FROZEN-OK |

`frozenOK=16  TICKED=0  advanced=1  gone=0`. The manager row was running again by 08:00, which
is what fills the gap §2a left open: **the live half is proven on the team panel too.**

The settled numbers on the wire are frozen, and the settled numbers on screen are frozen. Both
claims are now evidenced independently.

**Note on the first pass, so the record is honest.** My first DOM collector keyed cells by an
ancestor walk that returned the first matching descendant `title`, which printed `run 07e59e8e`
for every settled Live row, and it missed the team panel entirely because team duration cells
carry their own titles (`frozen at settle: …`), not the Live panel's three. The pairing was
still sound (it fell back to cell index, and no row settled inside the window) but the printed
identity column was wrong, so the whole measurement was redone with `closest()` against the real
row attributes. The tables above are from the corrected run; `accept-log.txt` retains the first
one for comparison.

---

## §3. Capabilities on the deployed build — **PASS**

```
$ curl -s http://127.0.0.1:7700/api/capabilities
{"control_plane":{"message_into_session":true,"resume_finished":true,"subagent_message":false,"stop":true,"terminate":true}}
```

Exactly five keys, exactly as specified: `message_into_session` **true**, `resume_finished`
**true**, `stop` **true**, `terminate` **true**, `subagent_message` **false**. Confirmed.

`message_into_session` was **not** re-proved — r1352 proved it on the running executor (up since
2026-08-11, five days after the pending-input handshake landed in `48931bd`): 10/10 base, 11/11
`--running`, a 202 `{queued:true, delivery:next-turn}` into a `status=running` target, corroborated
by fleet run `38f3a5c5`. No restart was performed and none is owed.

`subagent_message` false was **not** re-investigated. Recorded as instructed: the builder role's
tool list contains no Task, so only architect can spawn sub-agents, by design.

**resume_finished — the UI affordance is DELIBERATELY DEFERRED, and Konrad should learn it here
rather than by clicking for something that is not there.** The engine capability is real
(`POST /api/runs/:id/resume-chat` → 202, proof row `project/4120f785` r1203). The UI has exactly
one path to it — the `/resume-run` slash command in the operator chat composer — and that command
refuses anything whose status is not `stuck` (`slash-registry.ts:163`: *"resume only valid on
stuck"*). There is no affordance anywhere for resuming a **completed** run, and a worker's
`AgentChatView` has no composer at all, so the command cannot even be typed there.

### One factual correction the next subagent_message round will want

The rationale comment in `capabilities.ts` says *"nothing has populated `runs.metadata.subagents_v2`
… since 2026-08-05, so no running parent holds a live sub-agent id."* **That stopped being true
today.** Run `07e59e8e` (the parallel R19 task) populated it for the first time:

```
$ psql -tAc "select id, status, jsonb_array_length(metadata->'subagents_v2') from runs
             where started_at > now() - interval '6 hours' and metadata ? 'subagents_v2'
             order by 3 desc limit 3;"
07e59e8e-7acf-4077-a10b-53ed900631cf|completed|1
712abd3e-157d-4b50-a3b3-2e8dfd6bef85|completed|0
7f35bdf8-5a82-4515-b7b5-b47e9f9ff2ea|completed|0
```

The entry is `{role: scout, model: claude-haiku-4-5-20251001, tool_use_id: toolu_019chfnXfiuBjZAJTi5fkoL5,
status: done}` — it ended 15 ms after it started and its parent has since completed, so it is
**still not a live relay target** and the flag stays correctly false. But the address space is no
longer permanently empty, and a future proof round no longer needs a hand-written DB row: it needs
a Task-tool sub-agent that lives long enough to be addressed. I did not spend further time on it,
per the brief.

---

## §4. Both themes, every surface any deferred phase touched — **PASS with 3 findings**

Every surface below was captured dark **and** light on the deployed build and looked at with my
own eyes. Findings are in §5.

| surface | dark | light |
|---|---|---|
| Live panel — kind badges, role labels, model | `live-panel-dark.png`, `live-surface-dark.png` | `live-panel-light.png`, `live-surface-light.png` |
| team panel | `team-panel-dark.png` | `team-panel-light.png` |
| operator chat transcript with a comms block | `chat-transcript-comms-dark.png`, `comms-in-card-dark.png` | `chat-transcript-comms-light.png`, `comms-in-card-light.png` |
| comms block, outbound direction | `chat-comms-outbound-dark.png`, `comms-out-card-dark.png` | `chat-comms-outbound-light.png`, `comms-out-card-light.png` |
| a Bash tool row, for the consistency comparison | `chat-tool-row-dark.png` | `chat-tool-row-light.png` |
| settings surface | `settings-surface-dark.png`, `settings-index-dark.png` | `settings-surface-light.png`, `settings-index-light.png` |
| usage / context gauge | `context-gauge-dark.png` | `context-gauge-light.png` |
| dismissal `N dismissed · show` | `dismissal-affordance-dark.png`, `dismissal-peek-dark.png`, `dismissal-peek-scrolled-dark.png`, `dismissal-peeked-row-dark.png` | same four, `-light` |

### 4a. Live panel — the org chart reads

Every row is classified on screen and in its hover title. Read straight off the deployed DOM:

```
worker  operator-visibility · R19 closed on live evidence…      12m 53s  ↓ 162k
  builder  opus-5  high  Bash
  ↳ sub   Wire-shape probe subject                                  4s   ↓ 8.2k
     scout  haiku-4-5  091e05c docs(round1862): deploy — …
worker  operator-visibility · Production acceptance: …         12m 53s  ↓ 116k
  builder  opus-5  high  Bash
RECENT
worker  operator-visibility · Deploy: rebuild forge-control-web…  6m 06s ↓ 1.02M
  builder  opus-5  high  Deployed and verified. …
```

Hover titles carry the lineage, verbatim from production:

- `project worker · builder · project 8ea0cc08 · model claude-opus-5 · run 07e59e8e`
- `in-process sub-agent of "operator-visibility · R19 closed on live evidence or precisely open,
  and the pin verifier's blind spot" (opus-5) · role scout · model claude-haiku-4-5-20251001 ·
  started 2026-08-17T07:41:23.173Z`

A full session and an in-process sub-agent are distinguishable at a glance (`worker` vs `↳ sub`),
the role is printed and tinted (builder / scout / planner / reviewer), and the model is on every
row (`opus-5`, `haiku-4-5`, `sonnet-5`). A stranger can read the org chart. Roles observed across
the two panels: architect, planner, builder, reviewer, scout, steward, researcher.

### 4b. The dismissal affordance — round-tripped, and production left as found

There were **zero** dismissals in production (`{"node_ids":[],"count":0}`), so the affordance was
correctly absent. To see it I dismissed one settled row via its own ✕, photographed the affordance,
peeked, and restored it — using only the panel's own controls.

```
affordance label:  1 dismissed · show
affordance title:  Show the rows dismissed from this panel. Dismissing hides a row;
                   it never deletes anything, and the set is shared with the chat team panel.
peeked label:      1 dismissed · hide
dismissals after restore: {"node_ids":[],"count":0}      (twice, once per theme)
```

The tooltip is the round-1357 corrected string — it names **the chat team panel** as the other
surface, not "/live shares with /live". Fix cycle 3 is live and reads correctly on the deployed
build.

Where the peeked row lands, measured because the first screenshot looked like the peek did
nothing: the row **is** rendered (`peekedRowsInDom: 1`, muted, with a restore glyph) at viewport
top **786**, while the panel's scroller occupies **124 … 472** (`clientHeight 348`,
`scrollHeight 709`, `scrollTop 0`). It is inside the 380 px-max scroll container, below the fold —
not missing. `dismissal-peek-scrolled-*.png` and `dismissal-peeked-row-*.png` show it scrolled into
view in both themes. **Not a defect.**

**Production state was restored to `count: 0` after each theme's run and verified by curl.**

### 4c. Agent comms in the chat transcript — census over all 111 cards

Both directions exist and render, so DoD 4's data claim holds; the two gaps are in §5.

Konrad's manager chat (`bfd1283a`), identical in both themes:

```
commsCards: 111
byDirection: { in: 111 }                        <-- zero outbound, see F2
byRoleAttr:  { builder: 52, reviewer: 15, planner: 9, architect: 3,
               researcher: 2, scout: 1, steward: 1, "(empty)": 28 }
printedUnknownRole: 28                          <-- see F1
commsCardsWithCollapseGlyph: 0                  <-- see F3
toolRows: 441      toolRowsWithCollapseGlyph: 441
firstCommsHeaderTitle: "◂ from worker · unknown role · c8bc5ffa"
firstCommsChars: 906     longestCommsChars: 3125
```

The outbound half rendered from the one place that has the data — the
`control-plane verify - sender` chat:

```
commsCards: 2      byDirection: { out: 1, in: 1 }
firstCommsHeaderTitle: "▸ to worker · unknown role · 59459708"
card text: "▸ TO WORKER UNKNOWN ROLE 59459708 4h step2 hello from worker"
```

Direction marker (`◂` / `▸`), actor, role, short run id and age are all on the header line; the
payload is the sanitised rich renderer, left-aligned full-width with a 3 px rule in the role's
colour. `chat-transcript-comms-light.png` is the clearest single frame: a comms card sitting in
the transcript directly above three collapsed `Bash … done ▸` rows.

### 4d. Token check with my eyes, then with a photometer

Nothing invisible, nothing that fails in one theme and works in the other, no hardcoded colour
visible in either. Rather than assert "looks fine", I measured the computed colours the browser
actually painted on the comms header, both themes, and computed WCAG ratios
(`/tmp/r1863-contrast.cjs`, `contrast-log.txt`):

| element | token | dark | light | AA small (4.5) |
|---|---|---|---|---|
| direction marker `◂` / `▸` | identity ink | **5.12** | **4.65** | passes both |
| `from worker` | identity ink | 5.12 | 4.65 | passes both |
| `unknown role` (600 wt) | identity ink | 5.12 | 4.65 | passes both |
| short run id `c8bc5ffa` | identity ink | 5.12 | 4.65 | passes both |
| age stamp `17h` | `textFaint` | **2.41** | **2.82** | **fails both** |
| Bash row `Bash` label | accent | 7.86 | 4.14 | light marginal |
| Bash row payload preview | `textFaint`-ish | 3.68 | 3.59 | below 4.5, both |
| Bash row `done ▸` | `textFaint` | **2.71** | **2.82** | **fails both** |

My eye said the light-theme direction arrow was the faint one. **The measurement says otherwise**
— the arrow is comfortably above AA in both themes; the faint elements are the `textFaint` age
stamp and the pre-existing Bash row's `done ▸` status word, at essentially identical ratios. See
F4. Scope note: the six cards sampled were the oldest in the transcript and all carry the
`(empty)` / unknown-role identity, so the role-tinted inks (builder green, reviewer purple, …)
were **not** measured — I do not generalise the numbers to them.

---

## §5. Findings

None of these is a regression introduced by this project's own rounds; none blocks the deploy.
Fixing them belongs to a fix cycle.

### F1 — Konrad's manager chat team panel shows **another project's** org chart

`/api/chat/bfd1283a-…/team` returns `project: 8c591d6c` (**engine-task-graph**, status `paused`)
with `link_ambiguous: true`. It should be — two projects claim that chat:

```
$ psql -tAc "select id, name, status, created_at from projects
             where metadata->>'origin_chat_id'='bfd1283a-…' order by created_at;"
8ea0cc08-…|operator-visibility|active|2026-08-05 06:46:34+00
8c591d6c-…|engine-task-graph  |paused|2026-08-17 03:12:13+00
```

`resolveChatProject` documents "newest wins", so the resolution is **by design and not a bug**.
The *consequence* is the finding: the 16 worker rows in Konrad's team panel are engine-task-graph's
completed workers, and the two builders actually running for operator-visibility (this task and
R19) are **absent from the team panel of the chat that started them**. The UI is honest about it —
an `ambiguous link` chip in the chat header and `linkage ambiguous` at the top of the team panel,
both visible in `team-panel-*.png` — but honest is not the same as useful.

This also causes half of F2: `ManagerThread` fills the peer-role map from that same
`["chat-team", chatId]` cache, so peers belonging to operator-visibility cannot resolve there.
Only **16 of the 93** distinct comms peer ids intersect the team the panel resolved.

### F2 — 28 of 111 comms cards print "unknown role"

83 of the 111 resolve a role from the server-side `peer_role` stamp round 808 added; the remaining
28 predate it, and their fallback — the team-panel cache — cannot help them for the F1 reason.
They render as `◂ FROM WORKER **UNKNOWN ROLE** c8bc5ffa`. Confirmed on the wire:

```
comms_entries=111  with_peer_role=83  dir_in=111  dir_out=0
```

The card behaves as designed (`comms-identity.ts` prefers "unknown role" to inventing one). The
gap is that the one available fallback resolves against the wrong project.

### F3 — comms cards are **not collapsible**, which DoD 4 asked for in as many words

DoD 4: *"render as first-class collapsible blocks in the transcript — direction marker + agent
name + one-line preview, expandable to the full payload — visually consistent with how Bash tool
blocks render."*

Delivered: a first-class card with the direction marker and the agent name — but **always fully
expanded**. `CommsMessage` (`AssistantThread.tsx:149`) has no `useState`, no `▸`/`▾` control and no
`maxHeight`; it renders `MessagePrimitive.Parts` unconditionally. Measured on production:

- `commsCardsWithCollapseGlyph: 0` of 111; `toolRowsWithCollapseGlyph: 441` of 441.
- clicking a card's header changes its text length **912 → 912** in both themes.
- the longest card renders **3125 characters** inline; 111 such cards sit in this transcript.

So the "one-line preview, expandable" half of DoD 4 is **NOT VERIFIABLE AS WRITTEN — it is not
implemented**. What I measured instead is above. My own item 4 — *"showing an Agent/SendMessage
comms block expanded"* — is satisfiable precisely because the card is permanently expanded, and
those screenshots are real; I am not reinterpreting DoD 4 to make it pass. The likely reason is
visible in the code's own comment: round 808 was steered by a later request ("pls colorcode the
messages from the builders … so I can faster distinguish"), and colour-coding replaced folding
without the earlier criterion being retired.

### F4 — `textFaint` at 9.5–10.5 px is below WCAG 3.0 in **both** themes

Measured, not eyeballed: the comms age stamp reads **2.41** (dark) / **2.82** (light), and the
pre-existing Bash row's `done ▸` reads **2.71** / **2.82**. These are legitimate design tokens,
so the zero-hardcoded-colours rule is not violated and no grep would ever flag them — but the
token is too faint at these sizes, identically on the new comms cards and on tool rows that
shipped long before this project. A decision for Konrad, not a bug to file blind.

---

## §6. Screenshot index — `/opt/ai-os/uploads/dbb65f80ce12/`

45 PNGs, 6.1 MB. Konrad reads these without logging in.

**Item 1 — the settings click**
```
/opt/ai-os/uploads/dbb65f80ce12/settings-before-click-dark.png
/opt/ai-os/uploads/dbb65f80ce12/settings-before-click-light.png
/opt/ai-os/uploads/dbb65f80ce12/settings-after-click-dark.png
/opt/ai-os/uploads/dbb65f80ce12/settings-after-click-light.png
/opt/ai-os/uploads/dbb65f80ce12/chat-restored-dark.png
/opt/ai-os/uploads/dbb65f80ce12/chat-restored-light.png
```

**Item 2 — frozen elapsed on screen**
```
/opt/ai-os/uploads/dbb65f80ce12/frozen-live-t0-dark.png
/opt/ai-os/uploads/dbb65f80ce12/frozen-live-t1-dark.png
/opt/ai-os/uploads/dbb65f80ce12/frozen-team-t0-dark.png
/opt/ai-os/uploads/dbb65f80ce12/frozen-team-t1-dark.png
```

**Item 4 — Live panel**
```
/opt/ai-os/uploads/dbb65f80ce12/live-panel-dark.png
/opt/ai-os/uploads/dbb65f80ce12/live-panel-light.png
/opt/ai-os/uploads/dbb65f80ce12/live-surface-dark.png
/opt/ai-os/uploads/dbb65f80ce12/live-surface-light.png
```

**Item 4 — team panel**
```
/opt/ai-os/uploads/dbb65f80ce12/team-panel-dark.png
/opt/ai-os/uploads/dbb65f80ce12/team-panel-light.png
```

**Item 4 — comms blocks (inbound, outbound, and a Bash row to compare against)**
```
/opt/ai-os/uploads/dbb65f80ce12/chat-transcript-comms-dark.png
/opt/ai-os/uploads/dbb65f80ce12/chat-transcript-comms-light.png
/opt/ai-os/uploads/dbb65f80ce12/comms-in-card-dark.png
/opt/ai-os/uploads/dbb65f80ce12/comms-in-card-light.png
/opt/ai-os/uploads/dbb65f80ce12/chat-comms-expanded-dark.png
/opt/ai-os/uploads/dbb65f80ce12/chat-comms-expanded-light.png
/opt/ai-os/uploads/dbb65f80ce12/chat-comms-outbound-dark.png
/opt/ai-os/uploads/dbb65f80ce12/chat-comms-outbound-light.png
/opt/ai-os/uploads/dbb65f80ce12/comms-out-card-dark.png
/opt/ai-os/uploads/dbb65f80ce12/comms-out-card-light.png
/opt/ai-os/uploads/dbb65f80ce12/chat-tool-row-dark.png
/opt/ai-os/uploads/dbb65f80ce12/chat-tool-row-light.png
```

**Item 4 — settings surface**
```
/opt/ai-os/uploads/dbb65f80ce12/settings-surface-dark.png
/opt/ai-os/uploads/dbb65f80ce12/settings-surface-light.png
/opt/ai-os/uploads/dbb65f80ce12/settings-index-dark.png
/opt/ai-os/uploads/dbb65f80ce12/settings-index-light.png
```

**Item 4 — usage / context gauge**
```
/opt/ai-os/uploads/dbb65f80ce12/context-gauge-dark.png     (ctx 42%)
/opt/ai-os/uploads/dbb65f80ce12/context-gauge-light.png
```

**Item 4 — dismissal affordance**
```
/opt/ai-os/uploads/dbb65f80ce12/dismissal-affordance-dark.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-affordance-light.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peek-dark.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peek-light.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peek-scrolled-dark.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peek-scrolled-light.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peeked-row-dark.png
/opt/ai-os/uploads/dbb65f80ce12/dismissal-peeked-row-light.png
```

**Recon (kept for the record — the frames that established the selectors)**
```
/opt/ai-os/uploads/dbb65f80ce12/recon-desktop-dark.png
/opt/ai-os/uploads/dbb65f80ce12/recon-chat-dark.png
/opt/ai-os/uploads/dbb65f80ce12/recon-live-dark.png
```

**Machine-readable logs, same directory**
```
accept-log.txt      every PASS/FAIL and every DOM fact from the main run
frozen-dom-log.txt  the corrected §2c tables
probe2-log.txt      the comms census and the peeked-row geometry
contrast-log.txt    every measured colour and WCAG ratio
```

---

## §7. Noise floor discipline — **PASS**

This VPS emits ambient 50–60 ms long tasks at rest; idle windows on this box have carried 59 ms,
52 ms and 50 ms with the pointer parked. **No timing delta is reported anywhere in this document
as an effect.** The hover sweep was not re-run — those numbers live in `docs/plan/perf/after.md`
and step 4 of this phase reports them. The only durations printed here are the app's own elapsed
values (§2), which are seconds-to-hours and are being compared for *equality*, not for effect
size; and the four `curl`/DOM sample gaps (45.1 s, 48.0 s, 50.1 s, 50.1 s), which are wall clocks,
not measurements of the app.

---

## §8. What this task did NOT do

- **No pm2 process restarted.** `forge-control-web` restarts stayed 5, `forge-control` 29,
  `forge-executor` **0** with pid 2276472 and `up_since 2026-08-11T04:39:56.273Z` unchanged.
- **No code edited.** Only this document was written. `npx tsc --noEmit` re-run in both repos at
  this commit as a guard: `forge-control` exit 0, `forge-control-web` exit 0. `pnpm build` was
  not re-run — no source file moved since round 1862 built it, and that build's route table and
  BUILD_ID are recorded in `02-deploy.md` §4c.
- **No worktree next-server started, no `:7799`/`:7791`/`:7792`/`:7793` opened.** The four stale
  harnesses `02-deploy.md` §7b listed were left running and untouched.
- **No R19 file touched.** That task owns `docs/` and `scripts/` for step 3b; this document and
  the screenshots under `/opt/ai-os/uploads/dbb65f80ce12/` are the whole of my output.
- **Nothing deleted or truncated.** The one piece of production state I changed — a single UI
  dismissal — was made with the panel's own ✕, reversed with the panel's own restore, and
  verified back at `count: 0` by curl, twice.
- **No defect fixed.** F1–F4 are reported, not repaired; that is a fix cycle's job.
