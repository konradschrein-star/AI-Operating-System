# S-A — the real `agy` login flow, observed not assumed (round 399)

Status: **observed, not completed.** No login was finished; no Google credential was ever entered.
Prior art at `docs/research/round-1350-antigravity-cli-install.md` (in `/opt/forge-ai-os`, this
project's own earlier scout) already nailed the install, the keyring persistence bug and the
`agy models` probe — cited below rather than re-derived. This round adds one thing that prior
round did not know: **on this box the keyring path it built is bypassed on every real invocation**,
because `agy` detects an SSH session and switches to file-based token storage instead. That is the
one fact Phase 4 must not build against the old assumption.

Version drift since round-1350: **agy is now 1.1.13 → 1.1.14** (self-updated in the background,
confirmed by `agy --version`). Binary is still `/root/.local/bin/agy`, still 206MB stripped ELF.

## 1. `agy --help` — verbatim

```
$ /root/.local/bin/agy --help
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  -i                              Short alias for --prompt-interactive
  --json-schema                   Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --project                       Project ID for the current CLI session
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  agent           List available agents
  agents          List available agents
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  update          Update CLI
```

**There is no `login`, `auth` or `logout` subcommand.** `agy login --help` and `agy auth --help`
both fall through silently to the top-level `--help` text above, exit 0 — `login`/`auth` are not
recognised tokens, they are simply not there to recognise. Confirmed with every listed subcommand's
own `--help` (`agent`, `agents`, `changelog`, `install`, `models`, `plugin`, `plugins`, `update`) —
none of them mention auth either. `install` only "Configure[s] environment paths and shell settings"
(PATH + alias wiring), nothing credential-related.

Authentication is **implicit**: it triggers the first time any command needs a signed-in call.

## 2. Attempting a login — exact prompts, exact URL shape, exact stopping point

```
$ /root/.local/bin/agy -p "say hi"
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=SliCtZXVAEGgTCK-A6v6EAbsCx0SoIEpx2igX9Pm6CA&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode+openid&state=j8-PP_KWY--4DD2RAHnhmA

Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:

Error: authentication interrupted.
Error: authentication failed or timed out
```
(`EXIT=124` — that exit code is my own `timeout 20` cutting the process early, not `agy`'s.
Re-run without an external timeout, letting `agy` hit its own 60s budget, with
`--output-format json` layered on top, produces the identical prompt on stderr followed by this
envelope on stdout:)

```json
{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}
```

**Confirmed facts about the flow itself:**
- It is a **PKCE authorization-code flow**, not a device-code flow. `code_challenge` +
  `code_challenge_method=S256` are in the URL; there is no short device code to display and no
  polling of a device-token endpoint.
- `redirect_uri=https://antigravity.google/oauth-callback` — **not** a `localhost` redirect, so no
  local HTTP listener catches the callback automatically. The browser lands on a Google-hosted page
  that (per round-1350, §5 step 6) displays an **alphanumeric authorization code** for the human to
  copy.
- The CLI's own prompt is the paste-back path: **"Or, paste the authorization code here and press
  Enter"** — a human must read that code off the browser page and type/paste it into the terminal.
- **Client ID**: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
  (stable across both my attempt today and round-1350's — same OAuth client).
- **Scopes requested**: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
  `experimentsandconfigs`, `aicode`, `openid`. `prompt=consent` forces the consent screen every time.
- **Timeout window: 60 seconds**, hard-coded ("Waiting for authentication (timeout 60s)..."). The
  `code_challenge` (hence the URL) is single-use and tied to that one 60s window — round-1350's dead
  example URL and my two URLs above all differ per attempt, confirming this.
- I stopped at exactly this point both times — the prompt asking for a pasted code — and let it
  time out. No code was ever fetched from a browser, no consent was ever granted, no credential
  was entered.

## 3. `agy` is not on PATH for a scrubbed environment — proved

```
$ env -i /root/.local/bin/agy --help | head -5
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
EXIT=0

$ env -i agy --help
env: ‘agy’: No such file or directory
EXIT=127
```

Absolute path works with **zero environment** (no `HOME`, no `PATH`, nothing) — confirms `agy`
resolves its own state via `$HOME`-independent defaults or its own internal fallback, not via
inherited shell env for basic invocation. The bare command name fails exactly as the brief
predicted: PATH is appended to `.bashrc`, `.profile`, `.bash_profile` by `agy install` (verified
present at `~/.bashrc:133`, `~/.profile:18`, `~/.bash_profile:5` — all `export
PATH="/root/.local/bin:$PATH"`), none of which pm2 (or any non-login, non-interactive shell)
sources. **Phase 4's shell-out must call the absolute path
`/root/.local/bin/agy`, never bare `agy`.**

## 4. Where the credential lives — mechanism confirmed, exact file NOT pinned (see below)

**This corrects round-1350, it does not repeat it.** Round-1350 built a whole
`gnome-keyring`/D-Bus persistence layer (`agy-keyring.service`, systemd `--user`, enabled, `Linger
=yes`) on the premise that `agy` **only** has a keyring-backed store with no file fallback. That
service is still running today —

```
$ systemctl --user is-enabled agy-keyring.service   →  enabled
$ systemctl --user is-active  agy-keyring.service    →  active
$ systemctl --user status agy-keyring.service
● agy-keyring.service - Unlock gnome-keyring login collection for Antigravity CLI (agy) token persistence
     Loaded: loaded (/root/.config/systemd/user/agy-keyring.service; enabled; preset: enabled)
     Active: active (running) since Mon 2026-08-17 06:37:17 CEST; 1 day 14h ago
   Main PID: 1554099 (gnome-keyring-d)
$ ls -la /root/.local/share/keyrings/
-rw-------  1 root root  105 Aug 17 06:37 login.keyring
-rw-------  1 root root  207 Aug 17 06:30 user.keystore
```

— but **every single `agy` invocation logged on this box, across two calendar days and 13 separate
log files, hits this line first**:

```
composite_token_storage.go:123: Using file-based token storage because SSH session detected
```

grep across `/root/.gemini/antigravity-cli/log/*.log` (13 files, 2026-08-17 through 2026-08-18)
shows this line in **100% of them**, including every command I ran today. The trigger is
`$SSH_CONNECTION` (`77.23.254.43 41855 65.108.6.149 22` in my shell) — `composite_token_storage.go`
is Google's own `codeassistclient.NewCompositeTokenStorage`, which picks between
`codeassistclient.(*fileTokenStorage)` and the `zalando/go-keyring` D-Bus path (both symbols exist
in the binary, confirmed via `strings`). **Under an SSH-flavoured environment it takes the file
path, full stop — the elaborate keyring unlock in round-1350 never gets exercised in practice on
this box.**

This matters for Phase 4 because **pm2 workers on this box inherit the same SSH env**: I checked a
live pm2-managed worker process directly —

```
$ tr '\0' '\n' < /proc/943309/environ | grep -i ssh
SSH_CONNECTION=77.23.254.43 41855 65.108.6.149 22
SSH_CLIENT=77.23.254.43 41855 22
```

— so if forge-executor shells out to `agy` the same way, it too will hit the file-token path, not
the keyring `agy-keyring.service` exists to serve. **Do not assume the keyring service is what
makes Konrad's login persist. It may well be irrelevant to the production path.**

**What I could not pin today, honestly:** the exact on-disk filename for the file-token store.
`strings` on the binary surfaces the Go symbol names (`auth.(*cliFileTokenStorage).SaveToken`,
`codeassistclient.NewFileTokenStorage`, etc.) but the literal path is built at runtime via
`filepath.Join(appDataDir, ...)` with a short constant I could not isolate cleanly from the binary's
string table (206MB, no separators after Google's obfuscation of literal joins). `appDataDir` itself
is known — logged explicitly on every run: `CLI app data directory: /root/.gemini/antigravity-cli`
— so the file (once it exists) is somewhere under that tree. Right now, pre-login, nothing new has
been written there (`find /root/.gemini -newer .../installation_id` returns nothing my attempts
touched) — consistent with "no login was completed."

**Recommended way to nail it, for whoever runs Konrad's real login (not this task):**
`find /root/.gemini -type f -newer /root/.gemini/antigravity-cli/last_check.timestamp` immediately
before and after the real login. Whatever file appears is the credential file. Costs nothing, is
exact, and does not require reading the binary any further.

## 5. The non-interactive auth probe Phase 4 needs

`agy models` **is** that probe — cheap, fast, scriptable, already validated twice (round-1350 and
today, one version apart):

```
$ time /root/.local/bin/agy models
Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.
real  0m0.320s
EXIT=1
```

- **Exit 0 + a model list printed → authenticated.**
- **Exit 1 + "Please sign in..." → not authenticated.** Confirmed fast (0.32s) — it does not wait
  the 60s OAuth window; the client already knows it has no valid token before making a network call,
  so this is cheap enough to run on every settings-panel refresh.
- Internal log trace for this exact path (`printmode.go`): `not authenticated, trying silent auth`
  → `silent auth failed` → **does not** trigger interactive OAuth for `models` specifically (unlike
  `-p`, which does) — `models` fails clean and fast rather than opening a 60s wait. This is the
  detail that makes it safe to call from a status probe: it will never hang a settings page for 60
  seconds.
- `agy --version` (`1.1.14`, exit 0) works with **no auth at all** — useless as an auth probe, only
  useful for the version badge.

## 6. Answers to the brief's five questions, condensed

1. **Verbatim `--help` output** — §1 above, plus every subcommand's own `--help` checked; none
   mention login.
2. **Login attempt, exact prompts/URL/paste behaviour, stop point** — §2. PKCE flow, external
   (non-localhost) redirect, 60s window, human pastes an authorization code shown on
   `antigravity.google/oauth-callback`. Stopped at the paste prompt both times, twice, deliberately.
3. **`env -i` proof** — §3. Absolute path works under a fully scrubbed env; bare `agy` does not
   (`No such file or directory`, PATH-only fix, confirmed in `.bashrc`/`.profile`/`.bash_profile`).
4. **Where the profile/credential lives** — §4. Mechanism: `composite_token_storage.go` picks
   file-based storage whenever an SSH session is detected (100% of observed runs on this box, and
   confirmed present in at least one live pm2 worker's environment too) — the keyring
   (`agy-keyring.service`, still healthy) is very likely NOT what will hold Konrad's production
   token. Exact filename unresolved by static analysis; resolve by `find -newer` diffing
   `/root/.gemini` around the real login, which costs nothing.
5. **Non-interactive auth-proof command** — §5. `agy models`: exit 0 = authenticated (with model
   list), exit 1 = not, ~0.3s, never blocks on the 60s OAuth wait. This is Phase 4's real probe.

## 7. What this changes for Phase 4 (R53) planning

- Build the settings affordance exactly as round-1350 §6 sketched (no login button — the flow needs
  a human pasting a code into a terminal; show the copyable `ssh` + `agy` command instead) — that
  sketch is unaffected by today's finding.
- **Do not gate the "connected" health line on `agy-keyring.service` being active.** That service
  may be entirely load-bearing for nothing in production, given the SSH-detection bypass. If a
  health indicator is wanted, key it off `agy models`' exit code only, as round-1350 already
  recommended for the main badge — do not add a second, possibly-irrelevant keyring check on top.
- When Konrad actually runs the real login (his step, not an agent's), have that task run the
  `find -newer` diff from §4 to record the true credential file path before Phase 4 build closes —
  cheap, and it removes the one unresolved unknown in this report.
