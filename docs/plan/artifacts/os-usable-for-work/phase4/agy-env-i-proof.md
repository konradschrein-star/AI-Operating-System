# B4b — R52 proof: `agy` under a scrubbed environment, and the stdin trap that nearly shipped

**Phase 4 · workstream `connections` · requirement R52 (plus R58 for the probe's error surface)**
**Run 2026-08-18. Every transcript verbatim; every number carries its command (N10).**

Built on `phase0/S-A-agy-flow.md`, which established the flow. This document adds **one fact S-A could
not have found**, because it only appears when the CLI is spawned from a server process rather than a
shell — and it would have shipped a settings panel that freezes for fifteen seconds on every load.

---

## 1. R52's stated risk, and its proof

> A bare `agy` is spawned and fails with ENOENT under pm2, whose non-interactive shell does not read
> `.bashrc`. **This has bitten before.**

One named constant, `lib/connection-status.ts`:

```ts
export const AGY_BIN = "/root/.local/bin/agy";
```

Every invocation goes through it. Asserted by test, and the assertion sits next to the value.

**One definition, and nothing spawns a bare name:**

```
$ grep -rn "AGY_BIN = " forge-control/src --include=*.ts
forge-control/src/lib/connection-status.ts:434:export const AGY_BIN = "/root/.local/bin/agy";

$ grep -rnE '(spawn|execFile|execSync|exec)\(\s*"agy"' forge-control/src --include=*.ts
(no output — nothing spawns a bare `agy`)
```

**A reviewer grepping for `"agy"` will find four hits. None of them is a spawn**, and they are listed
here so the grep does not have to be re-litigated:

```
$ grep -rn '"agy"' forge-control/src --include=*.ts | grep -v '\.test\.ts'
forge-control/src/lib/connection-status.ts:1026:export const CONNECTION_IDS = ["google", "agy", "github"] as const;
forge-control/src/lib/connection-status.ts:1117:  results.push(await one("agy", () => probeAgy()));
forge-control/src/routes/integrations.ts:556:const AGY_ID = "agy";
forge-control/src/routes/usage.ts:137:    if (await exists(join(dir, "agy"))) return true;
```

The first three are the **connection id** — a record filename and a route segment, never a command.
The fourth is pre-existing and belongs to `routes/usage.ts`, which this task does not own: it is a
`PATH` scan (`agyOnPath()`) that only ever calls `access()` on a joined path to answer "is it
installed", and spawns nothing. `routes/integrations.ts` imports `AGY_BIN` and interpolates it; it
never writes the binary's name itself.

### 1.1 The `env -i` control pair

```
    ok 3 - agy spawns under env -i, proving the absolute path is what carries it
    ok 5 - a bare `agy` under env -i fails with ENOENT — the control for the test above
```

Both are **integration tests against the real binary**, in `src/lib/connection-status.test.ts`, run by
`pnpm test`. `execFile`/`spawn` with `env: {}` is the programmatic equivalent of `env -i`: no `PATH`,
no `HOME`, nothing. A test that only passes in an interactive shell proves nothing about pm2, which
does not read `.bashrc`.

**Neither test skips.** If `/root/.local/bin/agy` is removed, test 3 fails with
`spawning /root/.local/bin/agy with an empty environment failed at the OS level (ENOENT) — the
absolute-path contract is broken`. A silent skip would report green for a thing nobody checked (N1).

Test 5 is the *control*: it asserts that a bare `agy` still **does** fail under a scrubbed environment.
Without it, test 3 would keep passing even if `PATH` were somehow being inherited, and would then be
proving nothing. S-A §3 measured the same pair by hand:

```
$ env -i /root/.local/bin/agy --help | head -5     → EXIT=0
$ env -i agy --help                                 → env: 'agy': No such file or directory, EXIT=127
```

---

## 2. The probe is `models`, and never `-p`

From S-A §5, re-measured today:

```
$ cd /tmp && ( time timeout 30 /root/.local/bin/agy models ) 2>&1 | tail -6
Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.

real	0m0.323s
user	0m0.158s
sys	0m0.086s
```

**0.323s**, exit 1, the exact signed-out string S-A recorded one version earlier. `agy -p` opens a
60-second OAuth wait and must never be spawned from a route; a unit test asserts the argv:

```
    ok 2 - the probe is `models` and never `-p` — `-p` opens a 60s OAuth wait
```

---

## 3. THE FINDING — `agy models` hangs forever when its stdin is a pipe

S-A measured `agy models` from a shell. The probe runs it from Node. Those are not the same thing, and
the difference is fifteen seconds per settings-panel load.

### 3.1 First measurement — the obvious implementation, and it hangs

The first draft of `runCommand()` used `execFile`, whose default `stdio` gives the child an open pipe
on fd 0. Running the new test suite:

```
# tests 50
# pass 48
# fail 2
# duration_ms 20506.536543
```

```
not ok 3 - agy spawns under env -i, proving the absolute path is what carries it
  duration_ms: 20020.018266
  error: 'the process never exited normally'
```

Twenty seconds, then killed by the timeout. S-A measured 0.32s.

### 3.2 Isolating it — `/tmp/agy-envi-probe.mjs`

Three environments, `execFile`, 20s timeout:

```
$ node /tmp/agy-envi-probe.mjs
{ "label": "env:{} models",       "ms": 20038, "signal": "SIGTERM", "killed": true,
  "stderr": "ERROR: logging before google.Init: E0818 22:04:08 … $HOME is not defined\n" }
{ "label": "env:{HOME} models",   "ms": 20036, "signal": "SIGTERM", "killed": true, "stderr": "" }
{ "label": "inherit models",      "ms": 20035, "signal": "SIGTERM", "killed": true, "stderr": "" }
```

**All three hang, including the fully inherited environment.** So it is not `PATH`, not `HOME`, not
`SSH_CONNECTION`, and not the keyring-vs-file token store S-A §4 investigated. The one thing every
Node spawn shares and the shell does not is fd 0.

### 3.3 The cause, isolated — `/tmp/agy-spawn-probe.mjs`

Identical command, identical environment, `stdio[0]` the only variable:

```
$ node /tmp/agy-spawn-probe.mjs
  [stdio ignore/pipe/pipe] close fired at 372ms code=1
{"label":"stdio ignore/pipe/pipe","event":"exit","ms":372,"code":1,"signal":null,
 "se":"Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n"}
{"label":"stdio pipe/pipe/pipe","event":"TIMEOUT","ms":12003}
  [stdio pipe/pipe/pipe] close fired at 12016ms code=null
```

| `stdio[0]` | outcome | time |
|---|---|---|
| `"pipe"` (node's default, and `execFile`'s) | still running, SIGKILLed | 12003 ms / 20038 ms |
| `"ignore"` (`/dev/null`) | exit 1, with the real answer | **372 ms** |

**Why.** `agy`'s auth path is `"Or, paste the authorization code here and press Enter:"` (S-A §2) — it
opens stdin and reads. A pipe that nobody ever writes to and nobody ever closes never yields EOF, so
the CLI waits. A shell hands it a terminal or `/dev/null`; `execFile` hands it a pipe.

**What this would have cost.** `agy models` is called from `GET /api/integrations/agy`'s probe button
*and* from the 15-minute cron re-check. With the obvious implementation, every one of those calls
blocks for the full `AGY_PROBE_TIMEOUT_MS` (15s) and then reports a timeout — a probe that S-A measured
at a third of a second. The failure would have looked like "agy is slow", not like "we spawned it
wrong", which is exactly the kind of misdiagnosis this lane exists to prevent.

### 3.4 The fix, and the regression guard

`runCommand()` uses `spawn` with `stdio: ["ignore", "pipe", "pipe"]`, resolves on `close` (not `exit`,
which can fire before the last stdout chunk is read), and separates the OS-level `errno` from the
process's `code` — `execFile` reports "binary missing" and "exited 1" through the same `err.code`
field, as a string in one case and a number in the other.

```
    ok 4 - the probe ANSWERS rather than hanging — stdin must be /dev/null
```

That test spawns the real binary and fails if it takes more than 5s or comes back killed by a signal.
The suite's own wall-clock is the coarse tell:

```
before the fix:  # duration_ms 20506.536543   (48 pass, 2 fail)
after the fix:   # duration_ms   922.098921   (51 pass, 0 fail)
```

### 3.5 Confirmed end to end, through the HTTP route

```
$ time curl -s -X POST http://127.0.0.1:7742/api/integrations/agy/probe
{
  "status": {
    "id": "agy",
    "state": "broken",
    "identity": null,
    "checked_at": "2026-08-18T20:08:22.030Z",
    "detail": "/root/.local/bin/agy models exited 1 — nobody has completed the paste-a-code sign-in on this box.\n\nSTDERR: Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.",
    "action": "Sign in at a terminal on this box: run `/root/.local/bin/agy`, open the printed Google URL in a browser, and paste the authorization code back into the terminal within 60 seconds. There is no login subcommand and no browser flow this OS can drive for you."
  },
  "flow": {
    "binary": "/root/.local/bin/agy",
    "probe_command": "/root/.local/bin/agy models",
    "signin_command": "/root/.local/bin/agy",
    "flow": "PKCE authorization-code, not device-code. agy prints a Google consent URL, waits 60 seconds, and asks for an authorization code to be pasted back into the terminal.",
    "paste_prompt": "Or, paste the authorization code here and press Enter:",
    "window_seconds": 60,
    "why_no_button": "redirect_uri is https://antigravity.google/oauth-callback, not localhost, so no local listener can catch the callback — a human reads the code off Google's page and types it into the terminal. Observed in phase0/S-A-agy-flow.md §2."
  }
}

real	0m0.357s
```

**0.357 s end to end**, against 0.323 s from a bare shell — the route adds ~34 ms. The upstream's own
stderr is carried verbatim (R58); it is not replaced with "agy is not connected".

---

## 4. The state of `agy` on this box, for the record

**Installed, and NOT signed in.** `agy models` exits 1 with *"Please sign in to view available
models."* — the same answer S-A got on 2026-08-18 at 21:13 and this task got at 22:08, one hour apart.

**Nothing this OS builds can complete that login.** S-A §2 established why, and nothing here changes
it: the flow is PKCE with `redirect_uri=https://antigravity.google/oauth-callback`, so no local
listener can catch the callback; the CLI prints a URL, waits 60 seconds, and asks a human to paste an
authorization code back into the terminal. There is no `login` subcommand to drive and no device code
to display. The affordance therefore **shows the exact command and states plainly that Konrad must run
it**, which is what R54's fail condition ("the UI reports connected on the strength of a file
existing") demands. It is `agyFlow()` in `routes/integrations.ts`, and every field in it is something
S-A observed rather than something a device-code flow usually does.

The corresponding blocker is on Konrad's reminders, since the manager chat run
`bfd1283a-b71b-4f35-b577-7d09aad803f2` is in state `failed` and refuses `POST /message`.

---

## 5. Classification — every branch tested

`classifyAgyProbe()` is pure and takes a `CommandOutcome`, so all six branches are covered without
needing six different broken CLIs:

```
    ok 1 - exit 0 with a model list is ok, and the list head is the detail
    ok 2 - identity stays null — `agy models` never names an account
    ok 3 - the signed-out answer is a RECORDED failure carrying stderr verbatim (R58)
    ok 4 - an UNKNOWN non-zero exit is not reported as a missing login
    ok 5 - ENOENT is reported as a missing binary, not as a missing login
    ok 6 - a timeout kill is not silently an exit code
```

Two distinctions worth naming:

* **`identity` is null, always.** `agy models` prints a model list and says nothing about the
  signed-in account. Manufacturing an address from configuration would be the same lie R50 deletes
  from the Google path.
* **An unknown non-zero exit is not "you are signed out".** The classification keys off the exit
  code, and only the *explanation* mentions the `"Please sign in"` marker — so a wording change
  upstream can never turn a CLI fault into a missing login, nor a missing login into "connected".

---

## 6. Command index

| § | Command |
|---|---|
| 1 | `grep -rn "AGY_BIN = " forge-control/src --include=*.ts` · `grep -rnE '(spawn\|execFile\|execSync\|exec)\(\s*"agy"' forge-control/src --include=*.ts` · `grep -rn '"agy"' forge-control/src --include=*.ts \| grep -v '\.test\.ts'` |
| 1.1 | `pnpm test` (or `tsx --test --test-name-pattern 'agy\|absolute\|probe ANSWERS\|bare' src/lib/connection-status.test.ts`) |
| 2 | `cd /tmp && ( time timeout 30 /root/.local/bin/agy models )` |
| 3.2 | `node /tmp/agy-envi-probe.mjs` |
| 3.3 | `node /tmp/agy-spawn-probe.mjs` |
| 3.5 | `time curl -s -X POST http://127.0.0.1:7742/api/integrations/agy/probe` |
