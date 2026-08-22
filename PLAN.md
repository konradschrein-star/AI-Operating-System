# PLAN — connect-clis-from-settings

Project fbfdf435 · branch project/fbfdf435 · architect round 0 · 2026-08-22

## 0. Recommendation, in one paragraph

Build ONE pty-backed login broker in forge-control (`src/lib/cli-auth/`) that owns a
tmux session per provider on a DEDICATED tmux socket (`tmux -L forge-cli-auth`) with
`remain-on-exit on`, so the CLI runs with NO shell behind it: when it exits the pane
stays readable (`#{pane_dead}=1`, final screen intact) and can never become a bash
prompt that swallows a pasted code. Verified on this box (tmux 3.4) during planning.
Three provider definitions (`agy`, `gemini-cli`, `claude`) are DATA — binary, args,
env, URL regex, prompt string, success/failure/expiry markers, `window_seconds`,
probe function — and the engine is the same code path for all three. Routes live at
`/api/integrations/cli-auth/*` as a sub-router mounted from `routes/integrations.ts`.
The code arrives only in a POST body, goes to the pane through a 0600 temp file via
`load-buffer` + `paste-buffer -d`, the file is `shred -u`'d, and every string that
leaves the lib after the paste is passed through `scrub(text, code)` first.
`connected` is produced ONLY by the existing probe (`probeAgy`, a new
`probeGeminiCli`, `probeAccount`) writing a `ConnectionRecord` with `checked_at` —
so the panel's R57 invariant (unprobed = amber) holds with zero new renderer code.
The web side adds a `CliAuthConnect` control inside each connectable row's expanded
body, reusing the panel's `Banner`/`btn()`/`CommandBlock` pieces.

Rejected alternatives (one line each):
- `exec bash` behind the CLI (the operator's scripts): keeps the pane but turns it into
  a shell — that is exactly how a code was pasted into bash on 2026-08-19.
- node-pty / a PTY in-process: no tmux dependency, but untested here, a native module
  under pm2, and loses the operator's ability to `tmux attach` to see what happened.
- A localhost callback listener + SSH tunnel: impossible — redirect_uris are
  `codeassist.google.com/authcode` and `antigravity.google/oauth-callback`.
- Putting the code in the secret store and polling it (authcode-feed.sh): one more
  place the code rests on disk, and it needs a second process; the broker pastes
  synchronously from the request handler instead.
- A second status shape for "connecting": the panel already has
  `state·identity·checked_at·detail·action`; the broker's GET reuses `detail`/`action`
  words and adds only what a live session needs.

## 1. What exists (read, not remembered)

- `forge-control/src/routes/integrations.ts` — GET `/agy|/google|/github|/gemini|/connections`,
  POST `/agy/probe`. Every status comes from `buildConnectionStatus()` /
  `absentConnectionStatus()` in `lib/connection-status.ts`; records persist at
  `/opt/ai-os/.secrets/status/<id>.json` (`FORGE_CONNECTION_STATUS_DIR`). `AGY_ACTIONS.broken`
  currently tells Konrad to sign in at a terminal — that sentence must change.
- `lib/connection-status.ts` exports `runCommand(bin,args,{timeoutMs,env})` which already
  spawns with `stdio ["ignore","pipe","pipe"]` and resolves on close — REUSE it for every
  probe and every tmux invocation that is not a long-lived pane. `AGY_BIN` lives there
  (line ~435) with `access(X_OK)`. No `CLAUDE_BIN`/`GEMINI_BIN` constants exist yet.
- `routes/accounts.ts` + `db/claude-accounts.ts` (`claude_accounts` table, ai_os DB) +
  `lib/accounts.ts` (`probeAccount`, `createAccount`). POST `/api/accounts` creates a row and
  probes it. `reauth_command` = `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai`.
- Web: `app/api-connections.ts` (`ROOT = "/api/proxy/integrations"`), `settings/connections.ts`
  (`summaryFromStatus`, the ONE renderer; `ConnectionSummary.action` is a string),
  `ConnectionsPanel.tsx` (`Row` head is a single `<button>` — NOTHING interactive may be
  nested in it; the body is kept mounted and hidden), `integrationCards.tsx`
  (`Banner`, `btn()`, `Chip`, `CardHead`, `CommandBlock`, `StateChip`, `AgyCard` with
  `data-agy-verify`), `accountRegistry.tsx` (`useAccountRegistry().create()`).
- There is NO Gemini CLI row today. `GET /gemini` is the API KEY. A `gemini-cli`
  connection id must be added end to end (status record, probe, row) or there is
  nothing to put a Connect button on.
- `/root/ai-os/gemini/{auth.sh,agy-login.sh,agy-watch.sh,authcode-feed.sh}`: the proven
  primitives are `capture-pane -p -J` + grep for the live prompt, `load-buffer`/`paste-buffer`,
  `shred -u`. Keep the log line format of `state/authcode-feed.log`:
  `HH:MM:SS [<session>/<name>] <message>`. DEFECT TO NOT COPY: `authcode-feed.sh` logs
  `pane now: <last pane line>` 8 s after the paste — the pane echoes the code (verified:
  pasted `abc` shows as `Enter the code: abc`), so that line can log the code.
- Binaries (absolute): `/root/.local/bin/agy` 1.1.18, `/usr/bin/gemini` 0.55.1 (symlink
  into node_modules), `/usr/bin/claude` 2.1.239 (symlink), `/usr/bin/tmux` 3.4,
  `/usr/bin/shred`. pm2's PATH has none of `/root/.local/bin`.
- Browser proof recipe that works on this repo: `docs/plan/artifacts/phase1871/README.md`
  (worktree `next build` with `FORGE_CONTROL_URL=<throwaway api>`, `next start -p 7780`,
  NextAuth cookie minted with salt = cookie name, `FORGE_SESSION_COOKIE`). Single-router
  throwaway API pattern: `scripts/checks/serve-v3-7798.ts`.
- Unit tests: `forge-control/package.json` → `tsx --test src/lib/*.test.ts` (TOP-LEVEL
  glob: a test under `src/lib/cli-auth/` does NOT run; put tests at `src/lib/cli-auth*.test.ts`).
- Gate suite: `scripts/checks/gates-808.sh`, `gate "<name>" <cmd>` helper at line 53.

## 2. Ownership (the four questions)

| question | answer |
|---|---|
| what owns state | `lib/cli-auth/session.ts`: an in-memory `Map<provider, Session>` (ONE live session per provider, replaced on every start) + the tmux server `-L forge-cli-auth` as the source of truth for "is the CLI still asking". Durable outcome state is NOT here: it is the existing `ConnectionRecord` written by the probe. |
| what dispatches work | The HTTP handlers, synchronously: `start` spawns the tmux session and polls the pane for the URL; `code` pastes and polls the pane to a terminal outcome, then runs the probe, then answers. No queue, no cron. |
| what happens on failure | Every failure is a state (`failed`/`expired`) with the CLI's own last lines (scrubbed) in `detail`, or an HTTP 5xx when THE BROKER could not do its job (tmux missing, shred missing, pane unreadable). Nothing is retried silently. A forge-control restart loses the in-memory map; GET then reports an orphan tmux session as `failed` "broker restarted — press Relaunch", and `start` kills it. |
| how Konrad sees it broke | The row he is already looking at: chip + `detail` verbatim, plus the `cli-auth.log` line. The probe after success is the same probe the row renders, so a lie is structurally impossible. |

## 3. The broker — `forge-control/src/lib/cli-auth/`

### 3.1 `src/lib/cli-paths.ts` (NEW, shared — the single place a CLI path is written)

```ts
export const AGY_BIN    = "/root/.local/bin/agy";      // MUST equal connection-status.AGY_BIN (test asserts)
export const GEMINI_BIN = "/usr/bin/gemini";
export const CLAUDE_BIN = "/usr/bin/claude";
export const TMUX_BIN   = "/usr/bin/tmux";
export const SHRED_BIN  = "/usr/bin/shred";
/** true | false | null — null when the errno is neither ENOENT nor EACCES (cannot decide). */
export async function binPresent(bin: string): Promise<boolean | null>;
```
B2 makes `connection-status.ts` import `AGY_BIN` from here (one constant, two importers).

### 3.2 `src/lib/cli-auth/types.ts`

```ts
export type CliAuthProvider = "agy" | "gemini-cli" | "claude";
export type CliAuthState =
  "idle" | "starting" | "awaiting_code" | "exchanging" | "connected" | "expired" | "failed";

export interface ProviderDef {
  id: CliAuthProvider;
  bin: string;                       // from cli-paths
  args: readonly string[];
  env: (input: StartInput) => NodeJS.ProcessEnv;   // e.g. NO_BROWSER=true, CLAUDE_CONFIG_DIR
  cwd: string;                       // a scratch dir, never the repo
  urlRegex: RegExp;                  // first match on the joined pane = the URL
  prompt: string;                    // substring that means "asking for the code NOW"
  successMarkers: readonly string[]; // pane substrings meaning the exchange succeeded
  failureMarkers: readonly string[]; // pane substrings meaning the code was rejected
  expiryMarkers: readonly string[];  // e.g. "timed out"
  window_seconds: number | null;     // measured by research; null = no expiry observed
  exchangeTimeoutMs: number;         // how long to wait after paste before calling it failed
  probe: (input: StartInput) => Promise<ConnectionRecord>;   // the EXISTING probe
  onConnected?: (input: StartInput, rec: ConnectionRecord) => Promise<void>; // claude: registry row
}

export interface StartInput { slug?: string; config_dir?: string }   // claude only

export interface CliAuthStatus {          // GET shape — SAME words as a connection row
  provider: CliAuthProvider;
  state: CliAuthState;
  session_id: string | null;
  url: string | null;                     // ONLY while state === "awaiting_code"; null otherwise, always
  prompt: string | null;
  window_seconds: number | null;
  started_at: string | null;
  expires_at: string | null;              // started_at + window, or null
  detail: string;                         // human, scrubbed, verbatim CLI tail where useful
  action: string;                         // the exact next click, in the panel's voice
  probe: ConnectionRecord | null;         // set only after a post-success probe ran
}
```

### 3.3 `src/lib/cli-auth/tmux.ts` — the only file that spells `tmux`

- Socket: every call is `TMUX_BIN -L forge-cli-auth …` via `runCommand` (5 s timeout).
- `startPane(name, bin, args, env, cwd)`:
  `new-session -d -s <name> -x 240 -y 50 -c <cwd> -e K=V… -- <bin> <args…> \; set-option -t <name> remain-on-exit on`
  (one tmux invocation, so the option is set before the process can exit). NO shell,
  NO `exec bash`. `-e` sets env per session (tmux ≥3.2); the pane command is `bin` directly.
- `capture(name)` → `capture-pane -p -J -S - -E - -t <name>` joined lines.
- `paneState(name)` → `display-message -p -t <name> '#{pane_dead} #{pane_dead_status}'`
  (status may lag `pane_dead` by a tick — re-read once; treat empty as unknown, never 0).
- `pasteFile(name, path)` → `load-buffer -b <rand> <path>` then `paste-buffer -d -b <rand> -t <name>`
  then `send-keys -t <name> Enter`. `-d` deletes the buffer; `list-buffers` is asserted
  empty afterwards (test + runtime check → 500 if a buffer survived).
- `kill(name)` → `kill-session -t <name>`; `exists(name)` → `has-session` (used ONLY to
  decide whether to kill/orphan-report, NEVER as "alive").
- Session names: `cli-auth-<provider>` (claude: `cli-auth-claude-<slug>`).

### 3.4 `src/lib/cli-auth/session.ts` — the state machine

```
start(provider, input)
  ├ binPresent(bin) !== true  → throw BrokerError(503, "<bin> not executable")
  ├ kill any existing session for provider (fresh PKCE: the old url is dead by construction)
  ├ startPane(); state=starting; session_id = randomUUID()
  ├ poll capture() every 250 ms ≤ 20 s for urlRegex
  │    ├ match     → state=awaiting_code, url, started_at, expires_at
  │    ├ pane dead → state=failed, detail = scrubbed tail (12 lines)
  │    └ 20 s     → state=failed, detail="no URL within 20 s", pane tail
  └ returns CliAuthStatus  (POST /start → 200 with it; 503 on BrokerError)

status(provider)                         — pure read, ALWAYS re-inspects the pane:
  ├ no record & no tmux session          → idle
  ├ no record & tmux session exists      → failed "broker restarted; press Relaunch" (orphan)
  ├ awaiting_code & pane shows expiryMarker or now > expires_at+grace(5 s) → expired (url:=null)
  ├ awaiting_code & pane dead            → failed (url:=null)
  └ otherwise the stored state

submitCode(provider, session_id, code)
  ├ session_id !== live.session_id      → 409 {state, detail:"that url is stale; relaunch"}  ← PKCE rule IN CODE
  ├ status() !== awaiting_code           → 409 with the real status (expired/failed/idle)
  ├ capture() must contain def.prompt NOW, else 409 "CLI is not asking" (tmux-has-session trap)
  ├ code: trim, reject if /\s/ or length ∉ [8, 2048] → 400 (never echo it)
  ├ mkdtemp(0700) + writeFile(0600) → pasteFile → shred -u (spawn SHRED_BIN) → rmdir
  ├ state=exchanging; poll capture() every 300 ms ≤ exchangeTimeoutMs:
  │    successMarker → run def.probe(); probe.ok ? connected (+onConnected) : failed
  │                    detail="CLI reported success but the probe says: <probe.detail>"
  │    failureMarker | pane dead with non-zero status → failed, detail = scrubbed tail
  │    expiryMarker  → expired
  │    timeout       → failed "no verdict within N s", scrubbed tail
  ├ on connected/expired/failed: kill the tmux session (nothing left to read; the
  │   scrubbed tail is already in detail)
  └ returns the REAL outcome CliAuthStatus

cancel(provider) → kill session, state=idle
```
- `scrub(text, code)` = `text.split(code).join("<code>")`, applied to every `detail`,
  every log line, every thrown message AFTER the code exists. The `code` variable lives
  only inside `submitCode`; it is never stored on the Session object.
- Hard lifetime: a session older than 15 min is killed by `status()` → `expired`.
- Log: `/opt/ai-os/state/cli-auth.log` (dir from `CLI_AUTH_STATE_DIR`), format
  `HH:MM:SS [cli-auth-<provider>/<session_id8>] <message>`, messages fixed strings:
  `started`, `url shown`, `code delivered (<n> bytes, redacted)`, `connected as <identity>`,
  `failed: <scrubbed tail first line>`, `expired`, `cancelled`. Never a pane dump.

### 3.5 `src/lib/cli-auth/providers.ts` — filled by research (§6), defaults below

| field | agy | gemini-cli | claude |
|---|---|---|---|
| bin/args | `AGY_BIN -p "Reply with exactly: OK"` | `GEMINI_BIN` (bare TUI) | `CLAUDE_BIN auth login --claudeai` |
| env | inherit + `PATH+=/root/.local/bin` | `NO_BROWSER=true`, unset `GEMINI_API_KEY`,`GOOGLE_API_KEY` | `CLAUDE_CONFIG_DIR=<config_dir>` |
| urlRegex | `https://accounts\.google\.com/o/oauth2\S+` | same | research (claude.ai/oauth/authorize…) |
| prompt | `paste the authorization code here and press Enter` | `Enter the authorization code:` | research |
| window_seconds | 60 (re-measure) | research (null if none within the observation cap) | research |
| probe | `probeAgy()` | `probeGeminiCli()` (NEW, B2) | `probeAccount(row)` after `createAccount` or on the existing row |
| onConnected | — | — | create/refresh `claude_accounts` row (slug, config_dir); `login_email` stays null (configuration, not probe) |

`probeGeminiCli` (B2, in `connection-status.ts`, id `gemini-cli`, persisted like agy):
research decides the cheapest command that fails clean when signed out and yields an
identity when signed in. Default if research finds nothing better: `GEMINI_BIN -p "Reply
with exactly: OK" --output-format json` with `timeoutMs 90_000`, identity = the active
email read from `~/.gemini/google_accounts.json` ONLY when the call succeeded (the call is
the proof, the file supplies the name; `detail` says so). A timeout is `unknown`, not broken.

## 4. Routes — `src/routes/cli-auth.ts`, mounted `r.route("/cli-auth", cliAuth)` inside integrations.ts

| verb | path | body | answer |
|---|---|---|---|
| GET | `/cli-auth` | — | `{ providers: CliAuthStatus[] }` all three (claude: one per live session, plus `{provider:"claude", state:"idle"}`) |
| GET | `/cli-auth/:provider` | — | `CliAuthStatus` (claude: `?slug=`) |
| POST | `/cli-auth/:provider/start` | claude: `{slug, config_dir}` (config_dir absolute, slug `/^[a-z0-9][a-z0-9-]{0,39}$/`) | `CliAuthStatus` 200; 400 bad input; 503 BrokerError; 409 if another session for this provider is `exchanging` |
| POST | `/cli-auth/:provider/code` | `{session_id, code}` (claude: `+slug`) | `CliAuthStatus` with the REAL terminal state; 400/409 as §3.4 |
| POST | `/cli-auth/:provider/cancel` | claude: `{slug}` | `CliAuthStatus` idle |

Provider param not in the three → 404 `{error}`. Bodies > 16 KiB → 413 (the code is ≤ 2 KiB).
No `code` field is ever read from a query string. Hono's request logger in index.ts logs
method+path only — the builder verifies it does not log bodies.

Also in B3: `GET /gemini-cli`, `POST /gemini-cli/probe`, and `gemini-cli` in `/connections`
(same three-function pattern as agy). Wording: `AGY_ACTIONS.broken` and the new
`GEMINI_CLI_ACTIONS.{broken,absent-with-binary}` say "Expand this row and press Connect —
a Google page shows a code, paste it back here (60 s window for agy)". Google's own row and
GitHub are untouched.

## 5. Web — workstream `web`

Files: `app/api-connections.ts` (+ `CliAuthStatus` type mirror, `startCliAuth`,
`readCliAuth`, `submitCliAuthCode`, `cancelCliAuth` — bodies JSON, never query strings),
`settings/connections.ts` (+ `GEMINI_CLI_COPY`, `geminiCliConnection()` through
`summaryFromStatus`, no other rule changes), `settings/CliAuthConnect.tsx` (NEW),
`settings/integrationCards.tsx` (+ `GeminiCliCard` modelled on `AgyCard`, with
`data-gemini-cli-*` markers; `AgyCard` and `GeminiCliCard` render `<CliAuthConnect>` at the
top of the card when the row is not `connected`), `ConnectionsPanel.tsx` (+ the
`gemini-cli` Row under the GEMINI group; `AddAccount` gains a "Sign in here" path that
renders `<CliAuthConnect provider="claude" slug dir>` in place of STEP 1, keeping the
manual command below it as the fallback; `AccountCard` broken state gets the same control
with the row's `config_dir`).

`CliAuthConnect` behaviour (pinned — do not redesign):
1. Button `Connect` (`data-cli-auth-connect=<provider>`). On click, SYNCHRONOUSLY
   `const tab = window.open("", "_blank")` (popup blockers allow it inside the click),
   then POST start; on `awaiting_code` set `tab.location = url`; on anything else
   `tab.close()` and show `detail` in a `Banner tone="bad"`.
2. State `awaiting_code`: URL in a `CommandBlock`-style copyable box
   (`data-cli-auth-url`), a countdown `expires in 42 s` when `window_seconds` is set,
   one `<input data-cli-auth-code type="password" autoComplete="off">`, `Submit code`,
   `Cancel`. Poll GET every 2 s while `awaiting_code|exchanging`; stop otherwise.
3. `exchanging`: input disabled, "checking with <provider>…".
4. `connected`: `Banner tone="ok"` with `probe.identity`/`detail`; call the card's
   existing refresh (`onFacts` path / `registry.load`) so the ROW chip re-renders from the
   persisted record — the control never paints the chip itself.
5. `expired` / `failed`: `Banner tone="bad"` with `detail` VERBATIM, button `Relaunch`
   (`data-cli-auth-relaunch`) which is step 1 again — and the old URL box is gone (server
   returns `url:null`; the client also clears it).
6. Any fetch rejection → the same `Banner tone="bad"` with the verbatim error. No
   "submitted" toast exists anywhere.
No new tokens, no new design language; `btn()`, `Banner`, `input()` from the panel.

## 6. Research (all depends_on [], workstream main, tier junior) — measured, written to `docs/plan/cli-auth/evidence-<provider>.md`

Each researcher uses the tmux recipe in §3.3 by hand (`tmux -L forge-cli-auth-research`),
records exact prompt strings, the URL regex that matched, `window_seconds` (wall clock from
URL shown to expiry marker, or "no expiry within N min" with the capture), what the CLI
prints for a deliberately WRONG code (verbatim), the exit status via `pane_dead_status`,
and the cheapest signed-out probe. Nobody completes a Google/Anthropic sign-in. Gemini's
observation cap: 45 min. Kill your sessions when done.

## 7. Tests and checks

- `src/lib/cli-auth.test.ts` (B1): drives the engine against
  `scripts/checks/fixtures/cli-auth-mock.sh` (a bash CLI: prints a URL with a random
  nonce, prompts `Enter the authorization code: `, accepts only `MOCK-OK`, exits 2 on
  anything else, prints `timed out` after `MOCK_WINDOW` s). Cases: url state; wrong code →
  failed with verbatim tail; right code → `connected` ONLY when the injected probe returns
  ok (and `failed` when the probe says no even though the CLI succeeded); expiry →
  `expired` + url null + a relaunch yields a DIFFERENT url and the old session_id is 409;
  no tmux buffer survives; the CANARY check — paste `CANARY-<uuid>` and assert the string
  appears in NO response field, NOT in cli-auth.log, NOT in `list-buffers`, NOT on disk
  under the temp dir. The mock provider is registered ONLY when `CLI_AUTH_MOCK_BIN` is set.
- `scripts/checks/check-cli-auth-code-leak.ts` (B4): static scan of
  `src/lib/cli-auth/**`, `src/lib/cli-paths.ts`, `src/routes/cli-auth.ts` for (a) any
  `console.*`/`log(`/`appendFile(` call whose argument expression mentions `code`,
  (b) `send-keys` with anything but a literal `Enter`, (c) `c.req.query(` anywhere,
  (d) `detail:`/`message:` assignments inside `submitCode` not wrapped in `scrub(`,
  (e) `JSON.stringify(session)`; plus it RUNS the canary case above. Registered in
  `gates-808.sh` with `gate`. Per `do-not-soften-check-secret-scan`: the check's own
  forbidden strings live in variables, never in prose the check then reads.
- `scripts/checks/check-cli-auth-panel.mjs` (B7): Playwright against a throwaway stack per
  phase1871 README — throwaway forge-control from THIS worktree on a spare port (mount
  `accounts`, `integrations` only), `FORGE_CONTROL_URL` baked into a worktree `next build`,
  `FORGE_CONNECTION_STATUS_DIR` pointed at a temp dir so no live record is touched.
  Drives the REAL agy row with the REAL agy binary (no sign-in is completed): Connect →
  shot `url-state`; submit `WRONG-CODE-<uuid>` → shot `wrong-code-failed` (banner shows
  agy's verbatim words); Connect again → wait past `window_seconds` → shot `expired`;
  Relaunch → assert the new URL ≠ the old → shot `relaunched`. Shots to
  `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png`, then Read back. Traps already
  filed: `waitUntil:"commit"`, `__Secure-` cookie needs `secure:true`, rebuild with the
  default URL before finishing, viewport height not fullPage.

## 8. Task graph (seeded by the architect; ids in the forge-control project)

```
R1 researcher gemini-cli   []                main  junior
R2 researcher agy          []                main  junior
R3 researcher claude       []                main  junior
B1 builder    engine       []                main  standard   cli-paths.ts, cli-auth/{types,tmux,session,log,index}.ts, cli-auth.test.ts, fixtures/cli-auth-mock.sh
B2 builder    providers    [R1,R2,R3,B1]     main  standard   cli-auth/providers.ts, connection-status.ts, cli-auth-providers.test.ts
B3 builder    routes       [B2]              main  standard   routes/cli-auth.ts, routes/integrations.ts
B4 builder    leak check   [B3]              main  junior     check-cli-auth-code-leak.ts, gates-808.sh
B5 builder    web          []                web   standard   api-connections.ts, connections.ts, CliAuthConnect.tsx, integrationCards.tsx, ConnectionsPanel.tsx, check-connection-states.ts, check-quota-row.ts
B6 builder    integrate web→main [B5,B4]     main  junior     (B5's write_set; STOP on conflict)
B7 builder    browser proof [B6]             main  standard   check-cli-auth-panel.mjs, docs/plan/cli-auth/README.md
B8 reviewer   whole diff   [B1..B7]          main  standard
```

## 9. Decisions the brief did not make (reported to the manager chat)

- The Connect control sits at the TOP of the expanded card, not on the row head: the head
  is one `<button>` and nested interactive content is invalid HTML. The head's `action`
  sentence says "expand this row and press Connect".
- A `gemini-cli` connection is a NEW row (status id `gemini-cli`, under the GEMINI group),
  distinct from the API-key row.
- `window.open` is called synchronously in the click and re-targeted after the POST.
- Sessions are in-memory; a forge-control restart mid-login is reported as `failed`
  with a Relaunch, never resumed.
