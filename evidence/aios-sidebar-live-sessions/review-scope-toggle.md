# Review — sidebar scope toggle (round 4, workstream `toggle`)

**Tip reviewed: `cc8e46e6cb19e930454ebb9932130d690b93e9d1`** (branch `project/fb3b5fb2-toggle`,
worktree `/opt/ai-os/workspace/projects/fb3b5fb2-…--toggle`, working tree clean).
Merge base with `project/fb3b5fb2`: `2b4b3eb9a1517d277c9ad637af4731e462e3e7e9`.
Re-read immediately before the blocker below, 2026-08-25T05:50:22Z — HEAD had not moved.

**VERDICT: NEEDS_FIXES** — and the one blocker is **not in this diff**. The scope-toggle
increment itself is good work: all eight briefed claims hold against the code, the gate
suite is green at this tip, and both instruments discriminate under mutation. The blocker
is the mandatory live-checkout cleanliness check, which is red for reasons the `toggle`
builder neither caused nor can fix.

---

## Quality document used

`docs/plan/03-quality.md` (the pre-per-project layout). **`docs/plan/aios-sidebar-live-sessions/`
does not exist** — I checked both paths.

## Gate suite — EXECUTED

`scripts/checks/gates-808.sh --strict`, run by me at `cc8e46e`, whole 520-line log read
(not `tail -6`; log at `/tmp/gates-toggle-review.log`).

**28 gates registered · 26 EXECUTED · 2 SKIPPED-by-design · RED 0.**

```
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      check-migration-numbers.ts
 9  0      dollar-sweep.sh
 10 0      check-composer-v3.ts
 11 0      check-secret-requests.ts
 12 0      contrast-canvas-banners.cjs
 13 0      check-working-sql-agreement.ts — standalone typecheck
 14 0      check-stop-affordance.tsx
 15 0      check-dismiss-peek.tsx
 16 0      check-team-rows.ts
 17 0      check-team-confirm.ts
 18 0      check-live-sessions.ts
 19 0      check-deep-link.ts
 20 0      verify-notification-gap-pins.mjs
 21 0      check-usage-fold.ts — against a real Postgres
 22 0      check-usage-fold.ts — standalone typecheck
 23 0      pnpm test — forge-control unit suite
 24 0      psql-argv-leak.cjs
 25 0      nav-walk-sampling.cjs
 26 -      phase700/network-700.cjs (NFU3) (SKIPPED — browser harness not requested)
 27 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED — browser harness not requested)
 28 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 0
```

Preceded by `pnpm install --frozen-lockfile --prod=false` in **both** `forge-control/` and
`forge-control-web/` (both "Already up to date"; `tsx`/`tsc` present, so no silent
`--prod` prune).

Gates 26/27 are skipped by the suite's own `--browser` switch, not by me. No allowlist was
touched; nothing was widened.

## The two named checks, run directly

```
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts
  → 34 passed, 0 failed · check-sidebar-scope: PASS   (exit 0)

cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
    --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts
  → ALL PASS — check-chat-delta suite                 (exit 0)
```

### Mutation-tested by me, not taken on the builder's word

Two mutations applied to the worktree, run, then restored; `git status --porcelain` empty
afterwards.

| Mutation | Result |
|---|---|
| `pollBudget.ts:94` `SIDEBAR_AGENTS_POLL_MS` `8_000 → 4_000` | check-sidebar-scope **3 FAIL**; check-chat-delta **5 FAIL**, including `flipping to everything-running does not raise the surface's request rate` and `the sidebar's fleet feed is strictly slower than /live's` |
| `sidebar-scope.ts:45` `SIDEBAR_SCOPE_DEFAULT → "everything-running"` | check-sidebar-scope **19 passed, 15 failed → FAIL**; check-chat-delta **2 FAIL** (`the default scope is the non-polling one`, `so the default scope's degraded total carries no fleet term`) |

The builder's claim of "15 of 34 red" reproduces exactly. These instruments bite.

---

## The eight briefed claims

**1. Default is "this chat"; unknown value falls back to it. — HOLDS.**
`sidebar-scope.ts:45` `SIDEBAR_SCOPE_DEFAULT = "this-chat"`. The production read path is
`usePersistentState` (`_ui/ResizableSplit.tsx:386-419`): `JSON.parse` in a `try`, then
`isValid(parsed)` — on a throw or a failed guard it never calls `setValue`, so the state
stays at `initial`. `isSidebarScope` (`sidebar-scope.ts:71`) is a two-string equality, so
`"fleet"`, the bare word, `null`, `42`, an object and case drift all resolve to the
default. Fresh profile (`raw === null`): `usePersistentState` returns early, default. The
asymmetry the module's own comment names — unknown never means `everything-running` — is
structurally guaranteed, not just asserted. Driver assertion 12 exercises it end-to-end in
a real browser.

**2. Toggle off costs EXACTLY ZERO requests to `/api/agents`. — HOLDS, twice over.**
`ChatSurface.tsx:455` mounts `<AgentActivity>` only inside the
`scope === "everything-running"` branch, so in the default scope the component does not
exist. And `ChatSurface.tsx:291` computes
`fleetEnabled = !collapsed && tab === "team" && scopePolls(scope)`, passed as `enabled`;
`AgentActivity.tsx:826-827` sets `enabled` and `refetchInterval: enabled ? pollMs : false`,
so `enabled:false` kills both the interval and the fetch-on-mount. Evidence table agrees:
`/api/proxy/agents` **0 / 120 s** in `this chat`, **15 / 120 s** (7.5 req/min, exactly the
8 s constant) in `everything running`. I checked the whole component for a second poll:
`grep` finds one `useQuery` (`:823`); the only `setInterval` is the 1 s local clock tick
(`:302`, no I/O); the three `useEffect`s are an arm-timeout and two document listeners.
`useDismissals`/`useDismissalsLoaded` share one query with `staleTime: Infinity`,
`gcTime: Infinity`, `refetchOnWindowFocus: false` and no `refetchInterval`
(`team/dismissals.ts:121-129`) — a one-off already warm from `ChatTeamPanel`, which is why
it does not appear in the fleet-scope table (15+12+6+4+1 = 38 = the stated total).

**3. "Everything running" mounts the existing `<AgentActivity />`. — HOLDS.**
`ChatSurface.tsx:455` mounts the same component `LiveSurface.tsx:727` mounts, with no
`projectId` (so `GET /api/agents` is unfiltered) and exactly two props, `pollMs` and
`enabled`. No forked view, no duplicated row renderer. This is what the vault addendum
(lines 88-94) requires verbatim.

**4. `refetchInterval: 4_000` moved into `pollBudget.ts`; the instrument sees it. — HOLDS.**
`pollBudget.ts:94` `AGENTS_POLL_MS = 4_000` and `:95` region `SIDEBAR_AGENTS_POLL_MS = 8_000`;
`AgentActivity.tsx:113` imports the former as its default. `check-chat-delta.ts:470-471`
pins both to literals; `:531-533` and `:583-593` add the `everything running` mode into
the req/min sum and print it. See finding 2 below for the one thing that is *not* true of
that instrument.

**5. The ceiling question is answered in the open; `/live` unchanged. — HOLDS.**
The commit message says it in as many words: *"The ceiling was NOT re-argued."* The route
taken is the first of the two the plan allowed — the sidebar polls slower (8 s / 7.5 req/min)
than `/live` (4 s / 15 req/min), so the swap is net **−0.5 req/min** (32 → 31.5 degraded)
rather than net +7. The check states the counterfactual rather than hiding it
(`wouldBeDegradedAtLiveRateReqPerMin` = 39) and asserts both
`SIDEBAR_AGENTS_POLL_MS > AGENTS_POLL_MS` and
`totalFleetScopeDegradedReqPerMin <= totalDegradedReqPerMin`.
`/live`: `LiveSurface.tsx:727` is `<AgentActivity />` with no props, the file is **not** in
the write_set and **not** in the diff, and `pollMs` defaults to `AGENTS_POLL_MS = 4_000` —
byte-for-byte the previous literal. `/live`'s behaviour is unchanged.

**6. Scope only, not a second chat selector. — HOLDS.**
The toggle's entire state is one `SidebarScope` union of two members. Nothing in the diff
reads, writes or offers `forge.chat.selected`; `chatId` is threaded unchanged and is
simply not passed in the fleet branch. `SIDEBAR_SCOPES` is deliberately closed at two, and
the module's header records why a third value would be the thing v3 rejected. Consistent
with the vault addendum's "the right side still has no independent selector for *which
chat* it is showing".

**7. Evidence. — HOLDS. I read the pixels myself.**
All five PNGs and the panel dump exist at
`/opt/ai-os/uploads/8834241eda81/20260825T051426Z-*`, sizes 437-501 KB, mtimes 07:22-07:24.
I read three back with the Read tool:

- `-01-this-chat-dark.png` — `this chat` segment active (accent border/fill),
  `everything running` inactive; LIVE SESSIONS / TEAM / PLAN below; an `agy` badge on a
  `gemini-3.7-flash-high` session. Panel at its 260 px width.
- `-02-everything-running-dark.png` — the point of the mode, and it lands: rows from
  **twelve distinct projects** (aios-chat-list-etag, aios-sidebar-live-sessions,
  aios-verification-that-bites, aios-journal-thoughts-stats, aios-guardrail-hardening,
  aios-browser-takeover-live, zz-tierpin-verify, connect-clis-from-settings,
  aios-library-and-map, aios-devenv-and-cli, aios-excalidraw-to-plans,
  aios-chat-reference-navigation), with role, model, elapsed, token delta and sub-agent
  nesting, at the wider 420 px. Comfortably more than one project.
- `-03-…-after-reload-dark.png` — still `everything running` after `page.reload()`, and the
  elapsed columns have advanced (48s→52s, 5m 42s→5m 46s), which is what makes it a real
  second load rather than a re-saved frame.

**Provenance of the pixels is sound.** The evidence document states the page was served by
a `next build`/`next start` of *this worktree* on `127.0.0.1:7743`, with the driver
asserting `page.url() === "http://127.0.0.1:7743/desktop"` — the **origin**, not a
`.endsWith("/desktop")`, which is the exact trap that would have passed on the live console
after the unauth 307. `/api/chat/*` came from a GET-only throwaway probe on `:7742`
mounting only this worktree's chat router, and its identity is proved positively (`:7742`
returns `engine`/`activity` on every node; deployed `:7700` returns neither) rather than by
a bare status code. No `.env.local` was written. `/opt/forge-ai-os` was not built.

**8. Tests assert behaviour, not fixtures. — HOLDS.**
`check-sidebar-scope.ts` compares every expectation against a **literal** — `"this-chat"`,
`'"everything-running"'`, `"forge.layout.chat.sidebarScope"`, `4_000`, `8_000`, `7.5` —
never against a constant re-imported from the subject. The one place it imports the subject
is as the *actual*, which is the correct direction. `check-chat-delta.ts` §5a pins each
period to a literal **and** §5b sums the imported values, so both drift directions are
covered — the header explains precisely why one without the other is inert. My two
mutations confirm neither check would pass on an unfixed build.

## Write-set audit

Declared on task row `ffd72985-a841-40df-8b69-b76a9b2b3f55` (builder, workstream `toggle`),
restated in the report. Compared against `git log --name-only 2b4b3eb..HEAD`:

| declared | touched |
|---|---|
| `forge-control-web/app/desktop/ChatSurface.tsx` | ✓ |
| `forge-control-web/app/desktop/team/sidebar-scope.ts` | ✓ |
| `forge-control-web/app/desktop/chat/pollBudget.ts` | ✓ |
| `forge-control-web/app/desktop/live/AgentActivity.tsx` | ✓ |
| `scripts/checks/check-sidebar-scope.ts` | ✓ |
| `scripts/checks/check-chat-delta.ts` | ✓ |
| `evidence/aios-sidebar-live-sessions/scope-toggle.md` | ✓ |

**7 declared, 7 touched, zero undeclared writes.** Exact match. `ChatTeamPanel.tsx`,
`TeamRow.tsx`, `PlanKanban.tsx`, `LiveSurface.tsx` and `gates-808.sh` are untouched, so the
sibling lane's files were not trespassed on.

---

## BLOCKER

### 1. The live checkout `/opt/forge-ai-os` is dirty — and one of the seven is a SOLE COPY

Mandatory check, executed 2026-08-25T05:50:22Z (re-run immediately before writing this,
after the code review was complete):

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/ChatSurface.tsx
 M forge-control-web/app/desktop/chat/FileExplorerPanel.tsx
 M forge-control-web/app/desktop/chat/MessageMarkdown.tsx
 M forge-control-web/auth.ts
 M forge-control/src/routes/files.ts
?? forge-control-web/app/desktop/chat/code-path-link.ts
?? forge-control-web/app/desktop/chat/open-file-bus.ts
```

(live checkout on `main`, HEAD `259778b`.)

Per `live-checkout-dirty-protocol` I established provenance **before** prescribing anything —
one `git hash-object` + `git log --all --find-object` per path, run by me, not inherited:

| path | blob committed anywhere? |
|---|---|
| `forge-control-web/app/desktop/chat/code-path-link.ts` | yes — `8c101dd` |
| `forge-control-web/app/desktop/chat/open-file-bus.ts` | yes — `27ab8d5` |
| `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx` | yes — `27ab8d5` |
| `forge-control-web/app/desktop/chat/MessageMarkdown.tsx` | yes — `5067233` |
| `forge-control/src/routes/files.ts` | yes — `2db8998` |
| `forge-control-web/app/desktop/ChatSurface.tsx` | blob in no commit, but the change is a 16-line `subscribeOpenFile` effect belonging to the `chat-ref-nav` lanes |
| **`forge-control-web/auth.ts`** | **NO — sole copy** |

`auth.ts` adds `issuer: "https://github.com/login/oauth"` to the GitHub provider: GitHub
turned on RFC 9207, `oauth4webapi` inside `@auth/core` validates the callback `iss` against
the plain-OAuth2 default, and every **new** sign-in dies with an opaque `Configuration`
error until this line exists. `git log --all -S 'https://github.com/login/oauth'` returns
exactly one commit, `2f1d89a` — which is the sibling reviewer's own **prose** describing the
fix, not the code. The working tree is still the only copy of something serving Konrad's
logins.

**The fix — and it is NOT "revert and redo in the worktree".**
- Do **not** revert, discard or `git stash` any of the seven. Konrad's standing ruling
  (`AI OS/Operator Decisions.md`, 2026-08-18, corrected 2026-08-19) is that the dangerous
  verb is *discard*, not *commit*; reverting `auth.ts` destroys sign-in for the whole box.
- The six duplicates resolve themselves when the `chat-ref-nav` lanes merge.
- `forge-control-web/auth.ts` needs a **commit-in-place task with a named owner**, a
  declared policy bypass, and the review debt booked against the lane that owns the file.

**Attribution, and why this should cost one cheap cycle and not a rebuild.** None of these
seven paths is in the `toggle` builder's write_set, and the worktree-only policy forbids
that builder from touching `/opt/forge-ai-os` at all — so there is nothing for a `toggle`
fix cycle to *do*. The same dirt is already blocker 1 of the main-lane round-4 review
(`2f1d89a`, 2026-08-25 07:27), whose fix cycle (`6c0a0031`) is running now. **This blocker
is a duplicate of one already owned.** Once the commit-in-place lands, the correct
`toggle`-lane action is a re-check of this one line, not a re-implementation of anything in
the diff above.

---

## FINDINGS (non-blocking)

### 2. Neither instrument that carries the request budget is executed by anything

`scripts/checks/check-chat-delta.ts` and `scripts/checks/check-sidebar-scope.ts` are both
LIVE-ORPHANs. Resolved against the repo's closed runner set (`gates-808.sh`, `guard.sh`,
`preflight-deploy.sh`, `instrument-manifest.txt`, `test-guard-discrimination.sh`, and the
four `package.json`s; there is no `.github/workflows`):

```
=== check-chat-delta.ts    → no hit in command position
=== check-sidebar-scope.ts → no hit in command position
=== check-live-sessions.ts → gates-808.sh:213-214   (wired)
```

The builder disclosed the second of these honestly and named the exact `gate_sh` line to
add. It did **not** disclose the first, and the evidence document reads as though
`check-chat-delta.ts` is a live instrument. It is not: it was already orphaned before this
diff, so this is not a regression introduced here — but the sentence "a budget whose
instrument cannot see the outlay is not a budget" now has a second half. The instrument
*sees* the outlay and still never *fires*. Note also that `instrument-manifest.txt`
compiles every file in `scripts/checks/` — compiling is not running, and grepping a name
out of that manifest is the mistake to avoid here.

**Fix (for the integration task, which owns `gates-808.sh` — outside this write_set),**
beside the round-2 `check-live-sessions` entry at `gates-808.sh:213`:

```sh
gate_sh "check-sidebar-scope.ts — default scope, round-trip, unknown-value fallback" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts | tail -2"
gate_sh "check-chat-delta.ts — delta contract + the chat surface's req/min budget" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts | tail -2"
```

## SUGGESTIONS (not findings)

### 3. `readSidebarScope` / `writeSidebarScope` are not on the production path

`sidebar-scope.ts:84` and `:99` are called by `check-sidebar-scope.ts` and by nothing else —
`ChatSurface.tsx:248-252` reads the key through `usePersistentState`, which does its own
`JSON.parse` + guard. The two implementations are presently equivalent (I compared them line
by line, including the `JSON.parse("")` throw path), and the load-bearing pieces — the
guard and the default — *are* shared, which is why mutation B turned the fallback cases red
and why claim 1 genuinely holds. But if `usePersistentState`'s parse ever changed, section 3
of the check would stay green over a broken surface. Either have the component call
`readSidebarScope`, or add a one-line comment at `:84` recording that these exist for the
check and that the browser assertion (driver case 12) is what covers the real path.

### 4. `!collapsed` in `fleetEnabled` is unreachable

`ChatSurface.tsx:291`. The `if (collapsed) return …` guard sits above the mount, so the
conjunct can never be false where it is read. Harmless and arguably defensive; noted only so
a future reader does not mistake it for a live condition.

### 5. Observation, not a defect in this diff

The default-scope screenshot shows the PROJECT picker's third chip row clipped where the
`LIVE SESSIONS` divider begins. That is `ChatTeamPanel.tsx`, another workstream's file and
another reviewer's scope — recorded here only so it is not read as introduced by the toggle.

---

## Summary

The scope-toggle increment is correct, measured and honestly reported: the default is the
cheap one, the cheap one costs a real zero, the expensive one reuses `/live`'s own component,
the budget literal came out of the component and into the file that governs it, the ceiling
decision is stated rather than assumed, `/live` is untouched, the write_set is exact, the
gate suite is green at `cc8e46e`, and both instruments go red under mutation. The blocker is
the live checkout's seven dirty paths — one of which is the sole copy of a fix serving
production sign-in — which belongs to a commit-in-place owner and to the main lane's
already-running fix cycle, not to a rebuild of this diff.

**VERDICT: NEEDS_FIXES** (one blocker, item 1; it is not in this diff and is already owned)
