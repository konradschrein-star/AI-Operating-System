# Round 1350 — Antigravity CLI (`agy`): installed, proven ready, NOT logged in

Status: **INSTALLED AND READY.** One paste-a-code login by Konrad is the only remaining step.
No login was performed. No terms were accepted. No OAuth token was read, copied or reused.

> The brief cited `docs/research/round-1350-6e6151d7.md` as prior art. **That file does not exist** —
> not in this worktree, not in `/opt/forge-ai-os`, nowhere on the box (`find / -name 'round-1350*'`
> returns nothing). Every claim below was therefore re-derived from primary sources, and the
> premise held up: `agy` is real and Google-hosted.

---

## 1. Install — exact commands and resolved version

Official documented method (<https://antigravity.google/docs/cli/install>):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

I did **not** blind-pipe to bash. I downloaded and read the installer first:

```bash
curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh
sha256sum /tmp/agy-install.sh
#   ee1ea43ce4e9e56356c4ab6dad907ef357ae4bdfcaadb682735909fb57c9c640
bash /tmp/agy-install.sh
```

Installer audit (7354 bytes, `content-type: application/x-sh`, `server: Google Frontend`): resolves a
per-platform manifest, downloads the tarball, **verifies SHA512 against the manifest and aborts on
mismatch**, extracts to `$HOME/.local/bin/agy`, then runs `agy install` to append PATH to shell
profiles. No sudo, no secondary pipe-to-shell, no credential handling.

| Item | Value |
|---|---|
| Version | **1.1.13** |
| Binary | `/root/.local/bin/agy` (206 MB, ELF 64-bit PIE, stripped) |
| Binary SHA256 | `416b197e4b38c797c8661098f0af2bb4e1323ffe3c286d5e9b6408cf7d7ee920` |
| Manifest | `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json` |
| Payload | `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.13-6057583128215552/linux-x64/cli_linux_x64.tar.gz` |
| Config home | `/root/.gemini/antigravity-cli/` |

`agy install` appended `export PATH="/root/.local/bin:$PATH"` to `.bashrc`, `.zshrc`,
`.bash_profile` and `.profile`. It self-updates in the background on normal runs.

> The installer prints lines prefixed `ERROR: logging before google.Init:`. These are **glog noise,
> not failures** — the records are `I` (INFO) severity written to stderr. Installation exit code was 0.

## 2. Unauthenticated state — reported cleanly

```
$ agy --version
1.1.13                                                          # exit 0

$ agy models
Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.
                                                                # exit 1
```

`agy models` is the clean, scriptable auth probe: **exit 0 = authenticated, exit 1 = not**.
The internal log states the path explicitly:

```
printmode.go:440] Print mode: not authenticated, trying silent auth
printmode.go:446] Print mode: silent auth failed
printmode.go:463] Print mode: triggering interactive OAuth
```

Nothing about the unauthenticated state is confusing or ambiguous. The install is sound.

## 3. THE BLOCKER I FOUND AND FIXED — token persistence

**This is the part that would have wasted Konrad's login.**

`agy` stores its OAuth token via `zalando/go-keyring` (`codeassistclient.KeyringTokenStorage`),
which talks to the D-Bus Secret Service and has **no file fallback**. On this box:

- `gnome-keyring-daemon` was not running; the `default` and `login` aliases both resolved to `/`
  (nonexistent). The only collection was the **in-memory `session`** keyring, which dies on restart.
- A store attempt failed: `Object does not exist at path "/org/freedesktop/secrets/collection/login"`.
- gnome-keyring normally creates that collection only through the **gcr GUI prompter**, which cannot
  run headlessly — reproduced in a clean `dbus-run-session`:
  `(gcr-prompter): Gtk-WARNING: cannot open display:` → `org.gnome.keyring.SystemPrompter failed`.

**Consequence had this shipped unfixed:** Konrad completes the browser login, it appears to succeed,
the token then fails to persist — and *every* subsequent `agy` run demands a fresh browser login.
"One-time login" would have been false.

**Fix.** The `--login` path (the one PAM uses) needs no prompter and accepts a **non-empty**
passphrase on stdin. Both flags must be in a *single* invocation — splitting them into two calls
leaves the collection locked (`Cannot create an item in a locked collection`, verified).

- `/root/.local/bin/agy-keyring-unlock.sh` — creates + unlocks the login collection.
- `/root/.config/agy-keyring.pass` — random 32-byte passphrase, mode `0600`, root-only.
- `systemd --user` unit `agy-keyring.service`, **enabled**; root has `Linger=yes` so it starts at boot.

Verified round-trip, including across a daemon restart:

```
default -> /org/freedesktop/secrets/collection/login     # persistent, was "/"
secret-tool store ... ; secret-tool lookup ...  -> forge-persist-1350   (exit 0)
kill <daemon>; ./agy-keyring-unlock.sh; secret-tool lookup -> forge-persist-1350   (exit 0)
```

Probe keys were deleted afterwards; the collection is now empty (0 items), clean for Konrad's token.

*Security note, Konrad's call:* the keyring passphrase sits in a `0600` root-only file. On a
single-tenant box this adds no exposure beyond what root already has — root can read the token
either way — but it does mean the keyring is not protected against an attacker who is already root.

## 4. Headless invocation — quoted from `agy --help`, not from a webpage

```
  --json-schema                   Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --model                         Model for the current CLI session
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  agent           List available agents
  models          List available models
  update          Update CLI
```

Note there is **no `login`/`auth`/`logout` subcommand** — auth triggers implicitly on first use, and
`/logout` is a slash command *inside* the interactive session.

**Result envelope** (observed, `--output-format json`) — auth failure, exit code **1**:

```json
{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out",
 "duration_seconds":0,"num_turns":0,
 "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}
```

So a failure is machine-detectable on `status == "ERROR"` plus a populated `error`, with a `usage`
block present on success. Quota exhaustion surfaces as gRPC `RESOURCE_EXHAUSTED` (the binary also
carries `image generation quota exceeded, try again later`).

## 5. Konrad's login — numbered, for a tired person at a terminal

Everything is installed. **Do this once.** Have the browser open *before* you start — print mode
gives you only a 60-second window.

1. SSH in and make sure the keyring is up (it is enabled at boot; this is the belt-and-braces check):
   ```bash
   ssh root@65.108.6.149
   systemctl --user start agy-keyring.service
   ```
2. Start the sign-in. The documented path is the bare command, which opens the TUI:
   ```bash
   agy
   ```
   If you would rather stay non-interactive, `agy -p "hello" --output-format json` triggers the same
   flow — but it **hard-fails after 60 seconds**, so only use it with the browser already open.
3. It prints a block like this (your URL will differ — the one below is dead, it is PKCE-bound to an
   expired attempt, so **you must use the URL your own terminal prints**):
   ```
   Authentication required. Please visit the URL to log in:
     https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-...
   Waiting for authentication (timeout 60s)...
   Or, paste the authorization code here and press Enter:
   ```
4. Copy that URL into your local browser. Sign in as **konrad.schrein@gmail.com** (the Ultra 20x account).
5. Google shows a consent screen (the URL carries `prompt=consent`). It requests: `cloud-platform`,
   `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, **`aicode`**, `openid`.
   Read it and accept it yourself — **I deliberately did not accept anything on your behalf.**
6. The browser lands on `https://antigravity.google/oauth-callback` and shows an **alphanumeric
   authorization code**.
7. Paste that code into the still-waiting SSH prompt and press Enter.
8. Confirm it took:
   ```bash
   agy models          # exit 0 and a model list = signed in
   ```
9. Confirm the token actually persisted (this is the bit that was broken before):
   ```bash
   systemctl --user restart agy-keyring.service && agy models
   ```
   Still exit 0 → the credential survived, and you never have to do this again.

**Where the credential lands:** the gnome-keyring login collection, on disk at
`/root/.local/share/keyrings/login.keyring` (mode `0600`, root-only), reached through the D-Bus
Secret Service. Not a plaintext JSON file. `agy` reads it itself — nothing in this repo reads it.

If step 5 shows wording that looks like a *new* legal agreement rather than an OAuth scope consent,
stop and tell me the exact text.

## 6. Settings → Integrations panel — SKETCH ONLY, not built

Nothing was built. This is the contract a future round should implement.

**"Connected" is derived from `agy models`** — exit 0 = connected, exit 1 = not. There is no auth
API; shell out to the binary and read the exit code. Cache it (~60s); it is a network call.

*Unauthenticated state*
- Row: **Antigravity CLI (Gemini / Ultra 20x)** · badge `Not connected` · `v1.1.13` · path to binary.
- Body: "Requires a one-time sign-in on the server." Show the exact `ssh` + `agy` command, copyable.
- Explicitly **no login button.** The flow needs a human pasting a code into a terminal; a button
  that cannot complete the loop is a lie. Link to the instructions in §5 instead.
- Health line for the keyring: `systemctl --user is-active agy-keyring.service`. If that is dead,
  warn *before* he logs in — that is precisely the failure mode fixed in §3.

*Authenticated state*
- Badge `Connected`, plus the account email and the tier if surfaced (`entitlement.userTier`).
- Last-checked timestamp; a "Re-check" action that re-runs the probe.
- Disconnect is `/logout` inside `agy` — again, surface the command, do not fake a button.

**On the usage bar Konrad asked for — it is not possible, and here is why.**
`agy` exposes **no quota or usage surface**. The binary has no `/usage`, `/quota`, `/stats` or
`/limits` command, and no remaining-quota field anywhere in `--help` or the JSON envelope. The only
quota-shaped strings are failure-time gRPC codes (`RESOURCE_EXHAUSTED`, `image generation quota
exceeded`). Quota becomes observable **only at the moment you are already out of it.**

The `usage` block in the JSON envelope reports *tokens for that one invocation* — input, output,
thinking, cache-read, total. That supports a **cumulative "tokens we have spent through agy" counter**
that we compute ourselves by summing our own invocations. It does **not** support a
"X% of your Ultra quota remaining" gauge, because Google never tells the CLI the denominator.

Recommendation: render the self-tallied token counter, labelled honestly as our own usage, and a
short note that Google does not expose the subscription quota. An empty or invented gauge is worse
than the truthful absence.

*Secondary credential path worth knowing:* the 1.1.13 changelog documents `GEMINI_API_KEY` support —
"the CLI can run against the Gemini API directly without signing in" via `modelProvider: "gemini"`.
That is **metered API billing, not the Ultra subscription**, so it is not a substitute for the login
above. It does mean the Gemini API key already in the secret store (commit 18b9464) could drive `agy`
if a paid fallback is ever wanted. Konrad's call, not this task's.

## 7. Constraints honoured

- Shelled out to `agy` only. **The OAuth token was never lifted, read, copied or reused** — there is
  no token yet, and nothing here will ever read one. `jetski_state.pbtxt` was inspected for
  *onboarding* state only; it holds no credential.
- `/opt/gemini-pool-api` **untouched**.
- No login, no consent, no terms accepted. The onboarding entries auto-written by the installer
  (`MANAGER_WELCOME`, `USAGE_MODE`, `AGENT_CONFIGURATION`, `ADD_WORKSPACE`) are UI-tour steps, **not
  legal acceptance** — checked explicitly.
- `libsecret-tools` was installed (additive) to test the Secret Service. Nothing was deleted.
</content>
