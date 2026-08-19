# agy — what the settings affordance can honestly be, and why it is not a button

**Phase 4 · B4c · 2026-08-18 · requirements R52, R53, R54**

R54 offers two acceptable outcomes: a browser test through the flow, **or** "a recorded blocker
naming exactly what he must do". This is the second one, and it is the second one on evidence, not
on effort. What follows is the reasoning, the three designs that were considered and rejected, and
the exact shape that shipped.

Every fact below comes from `docs/plan/artifacts/os-usable-for-work/phase0/S-A-agy-flow.md`, the
scout report R53 mandates — observed at a terminal on this box, not assumed from how CLI logins
usually work. Section numbers in parentheses are that document's.

---

## 1. The four facts that decide it

| Fact | Value | Where it was observed |
|---|---|---|
| Is there a `login` / `auth` subcommand? | **No.** Both fall through to top-level `--help` and exit 0 | S-A §1 — every subcommand's own `--help` checked |
| What kind of flow? | **PKCE authorization-code**, not device-code (`code_challenge` + `code_challenge_method=S256` in the URL) | S-A §2 |
| Where does the callback go? | `redirect_uri=https://antigravity.google/oauth-callback` — **not localhost** | S-A §2 |
| How long is the window? | **60 seconds, hard-coded** ("Waiting for authentication (timeout 60s)..."), on a **single-use** challenge | S-A §2 |

And the prompt the human sees, verbatim (S-A §2):

```
Or, paste the authorization code here and press Enter:
```

Two of those four are individually fatal to a browser affordance, and they are fatal for different
reasons. That matters: fixing either one alone would not rescue the design.

---

## 2. Why each candidate design fails

### Rejected — a "Connect" button that starts the flow and a text box that accepts the code

This is the shape the brief warns against, and it fails on **process identity**. `agy` reads the
pasted code from the **stdin of the process that printed the URL**. That process is the one holding
the `code_verifier` for that single-use `code_challenge`; the value only means anything to that
process, in that 60-second window.

For a browser box to work, forge-control would have to keep an `agy` child process alive with an
open stdin pipe across two HTTP requests — spawn it on "Connect", hold it, then write the pasted
bytes into it on "Submit". That is a stateful child process pinned to a UI session, in a route
handler, holding a credential exchange open. It is buildable and it is a bad idea in a way that
would not be visible in a diff: the process outlives the request, nothing owns its lifetime, and a
reload or a second tab starts a second one racing for the same terminal-shaped resource.

### Rejected — a "Connect" button that shows the URL, with a paste box wired to a second endpoint

The same problem, minus the pretence of a session, plus a **timing** problem that finishes it off.
Sixty seconds is the entire budget for: render the URL, Konrad opens it, Google renders consent
(`prompt=consent` forces the screen **every time** — S-A §2), he grants it, Google renders the code
page, he selects and copies the code, switches back, pastes, submits. The challenge is single-use,
so a miss is not a retry — it is a new URL and a new 60 seconds.

An affordance whose success depends on a human beating a 60-second clock across four page loads is
an affordance that will fail most of the time, and every failure will look like a broken OS rather
than like an expired challenge.

### Rejected — infer "connected" from a credential file appearing under `/root/.gemini/antigravity-cli`

This is the specific lie R54 names: *"The UI reports 'connected' on the strength of a file
existing."* It is also unbuildable as specified — S-A §4 could not pin the filename, because the
path is assembled at runtime via `filepath.Join(appDataDir, …)` inside a 206 MB stripped binary.
So it would be a guess at a path, feeding a guess at a state.

Worse, S-A §4 overturned the assumption a previous round built infrastructure on: `agy` logs
`Using file-based token storage because SSH session detected` on **100 % of the 13 log files on this
box**, so the `gnome-keyring` service round-1350 built (`agy-keyring.service`, still running) is
very likely load-bearing for nothing in production. Any file-presence heuristic would have been
watching the wrong location.

---

## 3. What shipped

`AgyCard` in `forge-control-web/app/desktop/settings/integrationCards.tsx`. Three things, and it
refuses to imply a fourth:

1. **The state**, from the real probe, through exactly the same rules as the other three
   connections — `checked_at === null` is UNKNOWN in amber, a result older than 3× the re-check
   interval is UNKNOWN, and a failure prints the upstream's own words (R57, R51, R58).

2. **The blocker, on screen**, in the card itself rather than only in this file:

   > This login cannot be completed from this browser, and the card will not pretend otherwise.

   followed by the numbered steps, with `signin_command` and `paste_prompt` rendered **verbatim from
   the API** (`agyFlow()` in `routes/integrations.ts`) rather than retyped here — so what the screen
   says and what the terminal will say cannot drift apart.

3. **Verify**, which runs the real probe and shows its real output.

### The probe is `agy models`, and that choice is load-bearing

S-A §5 measured it: exit 0 with a model list when authenticated, exit 1 with
`Error: Please sign in to view available models.` when not, in **0.32 s**. Crucially, its internal
trace is `not authenticated, trying silent auth` → `silent auth failed` → **stop**. Unlike `agy -p`,
it does **not** open the 60-second OAuth wait. A settings panel that could hang for a minute on a
status read is a settings panel that will.

### The binary path is absolute, in one constant

`AGY_BIN = "/root/.local/bin/agy"` (`forge-control/src/lib/connection-status.ts`). S-A §3 proved
both directions: the absolute path works under `env -i` with no environment at all, and bare `agy`
fails `No such file or directory` because `agy install` appends the PATH export to `.bashrc`,
`.profile` and `.bash_profile` — none of which pm2 sources. A bare spawn fails under pm2 and works
perfectly when a human tests it over SSH, which is the worst possible combination.

---

## 4. The blocker, stated as R54 requires

> **What Konrad must do, and no agent can do for him.**
>
> At a terminal on this box (65.108.6.149):
>
> 1. Run `/root/.local/bin/agy` — the absolute path; `agy` alone is not on `PATH` for
>    non-interactive shells.
> 2. Open the Google consent URL it prints, in any browser, and grant consent.
> 3. Copy the authorization code Google shows and paste it back at the CLI's own prompt
>    (`Or, paste the authorization code here and press Enter:`) **within 60 seconds**. If it times
>    out, run the command again — the challenge is single-use and the old URL is dead.
> 4. Open Settings → Connections and press **Verify** on the agy card. It runs
>    `/root/.local/bin/agy models` and shows what the CLI actually said.
>
> Nothing in this OS can perform steps 1–3. `redirect_uri` is
> `https://antigravity.google/oauth-callback`, so no local listener catches the callback, and the
> code must reach the stdin of the process that printed the URL.

**One thing to record while doing it, at no cost** (S-A §4's open question): immediately before and
after the login, run

```bash
find /root/.gemini -type f -newer /root/.gemini/antigravity-cli/last_check.timestamp
```

Whatever file appears is the real credential file. Static analysis could not isolate it from the
binary's string table, and this resolves it exactly. It is not needed for anything that shipped —
the state comes from the probe's exit code, never from a file — but it closes the one unknown left
in the scout report.

---

## 5. What would change this decision

Only one of these, and none is in this project's scope:

- `agy` gains a real device-code flow (a short code, a polling endpoint, a window longer than 60
  seconds). Then a browser affordance is honest and easy.
- `agy` gains a `login --code <code>` subcommand that completes a challenge a **previous** process
  started, persisting the verifier itself. Then the two-request shape stops needing a pinned child
  process.
- `redirect_uri` becomes a localhost URL. Then forge-control can catch the callback and the human
  never handles a code at all.

Until one of those is true, a Connect button on this card is a button that leads to a shut door —
the same mistake, in the same file, that the round-1302 research already forbade for Google AI
Ultra. The card's header block records that parallel so the next person to reach for a button reads
it first.
