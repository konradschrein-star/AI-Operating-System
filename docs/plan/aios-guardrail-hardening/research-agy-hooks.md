# aios-guardrail-hardening — research: agy/Gemini pre-tool guard options and backstops

Round 0, task: "agy/Gemini pre-tool guard options and the backstops that need no agent
cooperation." Method: live `agy --help`/subcommand help, official Antigravity docs (web),
one controlled live probe of a `PreToolUse` deny hook in an isolated `/tmp` scratch
workspace, in-process classification of agy's own 24h transcript history, and read-only
`gh api` / crontab / log checks. No file outside this worktree's `docs/research/` or
`docs/plan/` was modified; the one live probe below is documented in full because it is a
real (if disposable) side effect.

## Finding 1 (corrects 00-findings.md P1-2's premise) — agy DOES have a native PreToolUse hook, and it works in exactly the mode gemini-runner.ts uses

`00-findings.md` states: *"agy has no hook mechanism (`/root/.gemini/settings.json` holds
only `{"security":{"auth":…}}`; `agy --help` offers `--sandbox` and nothing policy-shaped)."*
That is wrong, or at minimum incomplete — checked one file (`/root/.gemini/settings.json`,
which is a *different, unrelated* config than the one that matters) and missed the actual
mechanism entirely.

**Evidence — the CLI's own changelog names the mechanism.**
`/root/.gemini/antigravity-cli/cache/CHANGELOG.md` (installed CLI's bundled changelog,
read 2026-08-25) contains, among others:

> "Fixed workspace-local hooks defined in `<workspace>/.agents/hooks.json` not loading
> after trusting a folder by reloading hooks whenever workspaces change."

> "Fixed a bug where the `/hooks` command wrote configurations to
> `~/.gemini/antigravity-cli/hooks.json` instead of the shared `~/.gemini/config/hooks.json`,
> ensuring hooks remain synchronized between the TUI and the backend."

> "Improved hook ordering so hooks defined in `hooks.json` run before the built-in
> termination checks, which lets `PostInvocation` hooks observe the final invocation of a
> turn and lets `Stop` hooks run at all instead of sitting unreachable behind the built-ins."

Live check, this run: `agy -p "/hooks" --output-format json` (documented in the same
changelog as a zero-quota, read-only print-mode command) returned
`{"command":{"name":"hooks","data":{"hooks":[]}}}` — an empty list, because none is
configured today. Empty ≠ absent: the mechanism exists and is simply unused.

**Evidence — official docs (`https://antigravity.google/docs/hooks/`, fetched
2026-08-25, no visible version/date stamp on the page itself, so treat as "current for
whatever CLI build the fetch served").** Five events are documented:

> `PreToolUse` — "Fires before a tool is executed."
> `PostToolUse` — "Fires after a tool completes."
> `PreInvocation` — "Fires before the model is called."
> `PostInvocation` — "Fires immediately after each model invocation completes."
> `Stop` — "Fires when execution terminates."

Config file locations (same page, corroborated by
`https://atamel.dev/posts/2026/07-16_where_agy_hooks/`, a third-party post, fetched
2026-08-25): workspace-level `<workspace>/.agents/hooks.json`, global
`~/.gemini/config/hooks.json` — **not** `~/.gemini/settings.json` (the file the findings
doc checked) and **not** `~/.gemini/antigravity-cli/settings.json` (the file this run also
checked and found holds only `{"trustedWorkspaces": [...]}"`).

Exact schema, quoted from the docs fetch:
```json
{
  "my-linter-hook": {
    "PostToolUse": [
      { "matcher": "run_command", "hooks": [ { "type": "command", "command": "./scripts/lint.sh", "timeout": 10 } ] }
    ]
  },
  "safety-gate": {
    "enabled": false,
    "PreToolUse": [
      { "matcher": "run_command", "hooks": [ { "command": "./scripts/safety-check.sh" } ] }
    ]
  }
}
```
`PreToolUse` decision values, quoted: `"allow"` (auto-allow), `"deny"` (hard block
immediately), `"ask"` (prompt, respects "Always Allow"), `"force_ask"` (always prompt),
`"deny_unless_prior_grant"`. The `enabled` field "Defaults to `true`" per the docs — note
the docs' own canonical example ships `"enabled": false`, which is worth flagging as a
footgun for whoever copies it verbatim.

**Live probe — does `deny` actually block a real tool call in the exact mode
`gemini-runner.ts` uses (`-p`, `--dangerously-skip-permissions`, `--output-format json`)?**
Docs are silent on this interaction, so it was tested directly rather than assumed. Built
in an isolated scratch workspace, touching nothing under `/opt/forge-ai-os` or this
worktree:

```
/tmp/agy-hook-test/.agents/hooks.json:
{
  "research-probe-safety-gate": {
    "enabled": true,
    "PreToolUse": [
      { "matcher": "run_command",
        "hooks": [ { "type": "command", "command": "/tmp/agy-hook-test/scripts/deny-hook.sh" } ] }
    ]
  }
}

/tmp/agy-hook-test/scripts/deny-hook.sh:
#!/bin/bash
cat >> /tmp/agy-hook-test/hook-fired.log
echo '{"decision":"deny","reason":"research-probe-blocked-by-pretooluse-hook"}'
```

Run, mirroring `gemini-runner.ts:170-179` argv exactly:
```
cd /tmp/agy-hook-test && agy -p "Run the shell command: echo research-probe-canary-9f3a2b" \
  --model gemini-3.7-flash-high --output-format json \
  --dangerously-skip-permissions --add-dir /tmp/agy-hook-test
```

Result (verbatim):
```json
{"conversation_id":"35a203ac-3e70-4232-9620-dc0b8936f8af","status":"ERROR",
 "response":"The command execution was denied by a pre-tool hook:\n\n```\ntool call denied by pre-tool hook: research-probe-blocked-by-pretooluse-hook\n```\n",
 "error":"tool call denied by pre-tool hook: research-probe-blocked-by-pretooluse-hook", ...}
```
The canary string `research-probe-canary-9f3a2b` never appears anywhere in stdout — the
command did not run. `hook-fired.log` captured the exact stdin payload agy sends:
```json
{"artifactDirectoryPath":"/root/.gemini/antigravity-cli/brain/35a203ac-.../",
 "conversationId":"35a203ac-...","modelName":"gemini-3.7-flash-high","stepIdx":3,
 "toolCall":{"args":{"CommandLine":"echo research-probe-canary-9f3a2b",
 "Cwd":"/tmp/agy-hook-test","WaitMsBeforeAsync":1000,...},"name":"run_command"},
 "transcriptPath":"/root/.gemini/antigravity-cli/brain/.../transcript_full.jsonl",
 "workspacePaths":["/tmp/agy-hook-test"]}
```
Scratch dir removed after capture (`rm -rf /tmp/agy-hook-test`); `/tmp/` is a routine
prefix in the live classifier (`guard-autonomy.py:61 ROUTINE_PREFIXES`), so this cleanup
did not and could not trip the guard.

**Conclusion.** `PreToolUse` fires, in `-p` mode, under `--dangerously-skip-permissions`,
for the `run_command` tool, on the exact invocation pattern `gemini-runner.ts` uses, and
`deny` actually blocks — no execution, no output leak, an explicit denial string surfaces
in `response`. `toolCall.name` is `"run_command"` (not `"Bash"`); its `args.CommandLine`
and `args.Cwd` map directly onto `classify(cmd, cwd)`'s two parameters in
`guard-autonomy.py`. **A native hook — a small script registered in
`~/.gemini/config/hooks.json` that reads this stdin shape, calls the SAME
`classify()`/`strip_heredocs()` and the SAME `POST /api/autonomy/check`, and emits
`{"decision":"deny","reason":...}` or `{"decision":"allow"}` — is a straightforward,
low-effort fix, and a better one than the PATH-shim idea in Finding 2.** This is a build
recommendation, not something built here — no hooks.json was created outside the disposable
`/tmp` probe above.

Known reliability caveat, found via web search, not tested here: a third-party bug report
(`https://github.com/manaflow-ai/cmux/issues/5358`, GitHub issue, fetched 2026-08-25)
documents a case where a `PreToolUse` hook script that itself couldn't satisfy agy's
response contract caused **every** tool call to be denied (`invalid_args`), including with
a hook that just echoed `{}`. A community reply in the same thread notes Antigravity's own
bundled plugin "registers only `PostInvocation`, `PostToolUse`, `PreInvocation`, `Stop` —
no `PreToolUse`" — i.e. Google's own first-party plugin does not use this event, so it is
less trodden ground than `PostToolUse`. Whatever hook script gets written must be tested
against the exact stdin shape above and must always emit a well-formed `{"decision":...}`
object, never nothing and never a bare non-JSON line — an exception or a crash in the hook
script, if it prints nothing parseable, needs to be verified fail-open or fail-closed before
this ships (not verified in this research task; a build task's job).

A second, separate report on the same search (`discuss.ai.google.dev` forum thread, fetched
2026-08-25) states hooks are reported reliable in the CLI specifically — *"Fires on every
tool call, from the global registration. Full payload arrives on stdin"* — while the same
thread reports hooks **do not fire at all** in the Antigravity IDE/desktop app (2.0/2.1.1):
*"Zero hook invocations... silent non-engagement."* Not relevant to this fleet (agy here is
CLI-only, spawned via `child_process.spawn`, never the IDE), but worth recording in case
that changes.

## Finding 2 — the PATH-shim question, answered from the actual spawn code: not applicable, and there is a better option (Finding 1)

Read `forge-control/src/lib/gemini-runner.ts:229-236` (this worktree, current HEAD):
```
child = spawn(AGY_BIN, args, {
  cwd: opts.cwd,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
```
`AGY_BIN` is the literal path `/root/.local/bin/agy` (line 58). `gemini-runner.ts` does
**not** spawn `/bin/bash` or `/bin/sh` itself — it spawns the `agy` binary directly, once,
and `agy` is the process that subsequently decides internally how to execute the
`run_command` tool calls its own model turns request. This means:

- A PATH shim placed ahead of `/root/.local/bin` in `env.PATH` before this `spawn()` call
  would only intercept a shell that `agy` itself invokes by unqualified name (`bash`,
  `sh`) from *its own* child-process calls, IF agy resolves those through `$PATH` rather
  than an absolute path compiled into the binary or a bundled interpreter. This was not
  and could not be verified without agy's source (`agy` is a 206 MB single Go binary,
  `/root/.local/bin/agy`, no source available on this host) — it is a hypothesis about a
  closed binary's internals, not a measured fact, and the answer likely varies by Antigravity
  CLI version.
- Even if it worked, it would be strictly worse than Finding 1: fragile against an agy
  update that changes how it invokes a shell, invisible to `agy`'s own `/hooks` inspection
  command, and unable to see `toolCall.name`/structured args the way a real `PreToolUse`
  hook does — it would only ever see a flattened command line via inherited `env`, which is
  exactly what `guard-autonomy.py`'s classifier already parses today, so there is no
  precision gained for the added fragility.

**Recommendation: do not build the PATH shim. Finding 1's native hook is reachable,
documented, measured to work in the exact invocation mode this codebase uses, and does not
depend on undocumented behaviour of a closed binary.** (Not built here — this is a research
task; a build task's decision to make, informed by this finding.)

## Finding 3 — corpus measurement was structurally impossible from the named file; the real number, measured from agy's own transcripts

The task asked to count trips from `/opt/ai-os/scratch/guardrail-a2/commands-24h.jsonl`
filtered by `engine`. Checked first — that file has **1** row with
`engine == "gemini-3.7-flash-high"` out of 2,924, and that one row's `worker` field is
`"forge-executor"`, not an agy conversation:
```json
{"run_id":"d3c80e35-...","worker":"forge-executor","engine":"gemini-3.7-flash-high",
 "cwd":"/opt/forge-ai-os","command":"cd /opt/ai-os 2>/dev/null; ls; psql -U postgres -l 2>/dev/null | head -20", ...}
```
This is the executor's own Claude-Code-driven Bash tool call for a run whose *model field*
happens to be Gemini (bookkeeping metadata), not a command agy itself executed. **The reason
the corpus is nearly empty of Gemini commands is structural, not because Gemini runs make
few Bash calls**: `gemini-runner.ts`'s `onEvent` callback (read this run, lines 429-442)
only ever emits `type: "assistant_text"` — there is no `tool_use`/`tool_result` event for
what `agy` does internally. **forge-control's own event stream has zero visibility into
agy's tool calls, independent of any guard question.** That is arguably a more important
finding than the hook gap itself: Konrad's thread/chat view cannot show what a Gemini run's
agent actually ran, only its final text — the same gap the PreToolUse hook's audit trail
would incidentally close, since the hook payload IS a structured tool-call record with a
`transcriptPath`.

**Measured instead from agy's own local logs.** Every agy conversation writes
`/root/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl`,
containing every `tool_calls` entry with `name`/`args.CommandLine`/`args.Cwd` — exactly the
shape confirmed live in Finding 1's probe. Scanned all conversation directories with
`mtime` inside the last 24h (`os.path.getmtime` on the transcript file, script at
`/tmp/agy-corpus-scan.py`, deleted after the run — not committed, per the no-corpus-in-repo
rule), extracting every `run_command` call and classifying it in-process against the SAME
live `guard-autonomy.py` `classify()`/`strip_heredocs()` used everywhere else in this
project — zero network calls, zero `guardrail_trips` rows, per
`guard-hook-tests-never-hit-live-api.md`.

```
conversations scanned (mtime<24h): 107
run_command tool calls found:      1780
classifier trips:                  1
```

The one trip:
```
conv 00f02ee2-96b6-4409-860f-275f9ad3d964
cwd: /opt/ai-os/workspace/projects/6a6a16c6-5e17-4bef-99ee-337a82aec772
cmd: rm -rf scratch
verdict: ('fs.destructive', {'command': 'rm -rf scratch', 'targets': ['scratch']}, 'rm -rf scratch')
```
Under **today's live** classifier this trips (basename `scratch` is not in
`ROUTINE_BASENAMES`, and the live classifier doesn't resolve a relative target against
`cwd` at all). Under the **hardened** classifier `00-findings.md` P2-2 specifies (rule 2:
"relative target + `cwd` under a routine prefix ⇒ routine" — this cwd is strictly inside
`/opt/ai-os/workspace/projects/<uuid>/`, matching rule 3 too) this would be reclassified as
routine, same as the `…preview823` false positive already documented there. So the
*measured* gap, at current traffic and the current (unhardened) classifier, is **1 real
would-be-trip in 1,780 real Gemini tool calls over 24h (0.056%)** — comparable in shape and
rate to the Claude-side false-positive rate in `00-findings.md` P2-2 (10 trips / 2,924
calls, 0.34%), and the one Gemini trip found is itself argued-false-positive under the
already-planned hardening. **This does not mean the gap is small in consequence** — a
single unguarded `rm -rf`/`git push --force`/`DROP TABLE` is still a P1 if it lands on the
wrong path; it means the *measured hit rate* on real fleet traffic today is low, which is
evidence for prioritisation, not a reason to skip the fix.

Volume context: 1,780 Gemini `run_command` calls across 107 conversations in 24h is the
same order of magnitude as the 2,924 Claude Bash calls across 48 runs in the same period —
Gemini/agy is not a niche, low-traffic path; it is comparable in call volume to the guarded
engine.

## Finding 4 — backstops that need no agent cooperation

**(a) GitHub branch protection, `konradschrein-star/AI-Operating-System`.**
```
$ gh api repos/konradschrein-star/AI-Operating-System/branches/main/protection
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.",
 "documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection",
 "status":"403"}
```
This is **not** "unprotected, 404, flip it on" — it is a **plan limitation**. Confirmed:
```
$ gh api user --jq '{login, plan: .plan}'
{"login":"konradschrein-star","plan":{"collaborators":0,"name":"free","private_repos":10000,"space":976562499}}
$ gh api repos/konradschrein-star/AI-Operating-System --jq '{private, plan: .owner.type}'
{"plan":"User","private":true}
```
GitHub's branch-protection API (and the setting itself) is unavailable for **private**
repositories on the free plan; it is available on public repos regardless of plan, or on
any repo with GitHub Pro/Team/Enterprise. So the `gh api -X PUT` command the brief asked
for cannot be issued today and would 403 identically — there is nothing to run until
Konrad picks one of: upgrade to GitHub Pro (this account, ~$4/mo at time of writing per
GitHub's public pricing — not independently re-verified this run, treat as approximate),
make the repo public, or accept there is no server-side force-push guard here today.
**If/when the plan allows it**, the command a deploy task would run is:
```
gh api -X PUT repos/konradschrein-star/AI-Operating-System/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks:='null' \
  -F enforce_admins=true \
  -f required_pull_request_reviews:='null' \
  -f restrictions:='null' \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```
(minimal shape — blocks force-push and branch deletion on `main` without requiring PR
review or status checks, which would otherwise break the fleet's direct-push workflow;
Konrad's call whether to add review requirements later.)

**(b) `content-forge` remote — same result, same reason.**
```
$ cd /opt/content-forge && git remote -v
origin  git@github.com:konradschrein-star/content-forge.git
$ gh api repos/konradschrein-star/content-forge/branches/main/protection
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.", "status":"403"}
```
Identical plan-tier block. Same recommended command, target repo swapped, once the plan
question is resolved.

**(c) Nightly `pg-backup.sh` — confirmed running and succeeding.**
Crontab (`crontab -l`, this run):
```
20 3 * * * /opt/ai-os/scripts/pg-backup.sh >/dev/null 2>&1
```
`/var/log/pg-backup.log`, last three nights, all three databases (`content_forge`, `hcp`,
`ai_os`), all `ok`/`verify ... — restorable`/`run complete`:
```
[2026-08-25T03:20:21+02:00] ok   content_forge -> content_forge-20260825-032001.dump (128M)
[2026-08-25T03:20:21+02:00] ok   hcp -> hcp-20260825-032001.dump (312K)
[2026-08-25T03:20:21+02:00] ok   ai_os -> ai_os-20260825-032001.dump (276K)
[2026-08-25T03:20:21+02:00] verify content_forge — restorable
[2026-08-25T03:20:21+02:00] verify hcp — restorable
[2026-08-25T03:20:21+02:00] verify ai_os — restorable
[2026-08-25T03:20:21+02:00] run complete — all databases backed up
```
14-dump retention confirmed by the matching `prune` lines each night. This backstop is real
and current as of this morning's run — DB destruction (accidental or via an unguarded
Gemini `DROP TABLE`/`TRUNCATE`) is recoverable to within 24h, independent of the hook
question.

## Recommendation

Drop the "agy has no hook mechanism" premise from `00-findings.md` P1-2 — it does, it is
documented, and it was verified live to block a `run_command` call in the exact
`-p --dangerously-skip-permissions` mode `gemini-runner.ts` uses. The right fix is a native
`PreToolUse` hook registered in `~/.gemini/config/hooks.json` running the same
`classify()`/`strip_heredocs()`/`POST /api/autonomy/check` pattern `guard-autonomy.py`
already uses for Claude Code, mapping `toolCall.args.CommandLine`/`Cwd` onto the same two
parameters — not a PATH shim, which depends on unverifiable closed-binary internals for no
precision gain. Build it defensively against the one documented failure mode (a hook script
that can't satisfy agy's response contract denies *everything*): always emit a well-formed
`{"decision":...}` JSON object, verify the fail-open/fail-closed behaviour of a crashing or
slow hook script before shipping (this was not tested here), and register it in
`~/.gemini/config/hooks.json` (global) so it survives per-workspace `.agents/` differences —
the same `install-hooks.sh` T3/T8 already plans for Claude Code's account dirs is the
natural place to also drop this file. Measured urgency is moderate, not extreme: at current
traffic the classifier would have caught exactly one Gemini command in 24h (1,780 calls),
and that one is itself a documented-false-positive shape — but volume parity with the
Claude side (1,780 vs 2,924 calls/24h) means the exposure is not niche, and GitHub branch
protection is off the table on the current plan for both repos, so the hook is the only
near-term backstop for `main` on this box. The nightly `pg-backup.sh` is real and already
closes the "DB destroyed" tail risk regardless of what happens with the hook.

## Sources

- `/opt/ai-os/scripts/guard-autonomy.py` (live file, read + imported in-process, this run) — classifier under test.
- `/root/.gemini/antigravity-cli/cache/CHANGELOG.md` (installed CLI's bundled changelog, read 2026-08-25) — hook mechanism, `/hooks` command, `.agents/hooks.json` / `~/.gemini/config/hooks.json` locations, sandbox/permission history.
- `agy --help`, `agy mcp --help`, `agy plugin --help`, `agy install --help`, `agy -p "/hooks" --output-format json` — live CLI, this run, 2026-08-25.
- [Hooks | Google Antigravity Docs](https://antigravity.google/docs/hooks/) — official docs, fetched 2026-08-25, no page date shown.
- [Where does Antigravity look for Hooks? — Mete Atamel](https://atamel.dev/posts/2026/07-16_where_agy_hooks/) — third-party, dated 2026-07-16, fetched 2026-08-25.
- [Antigravity (agy): injected PreToolUse hook denies every tool call (invalid_args) — cmux issue #5358](https://github.com/manaflow-ai/cmux/issues/5358) — third-party bug report, fetched 2026-08-25.
- [Do Antigravity IDE / 2.0 actually execute plugin hooks — Google AI Developers Forum](https://discuss.ai.google.dev/t/do-antigravity-ide-2-0-actually-execute-plugin-hooks-pretooluse-posttooluse-or-is-that-cli-only-right-now/176814) — forum thread, fetched 2026-08-25.
- Live probe: `/tmp/agy-hook-test/` (created and destroyed this run, 2026-08-25) — see Finding 1 for full transcript.
- `forge-control/src/lib/gemini-runner.ts` (this worktree, HEAD) — spawn mechanics, `onEvent` shape.
- `/opt/ai-os/scratch/guardrail-a2/commands-24h.jsonl` (read only, per-project rule — never copied into the repo) — corpus structure check.
- `/root/.gemini/antigravity-cli/brain/*/​.system_generated/logs/transcript_full.jsonl` (107 conversation dirs, live host data, read this run) — real 24h Gemini tool-call corpus, scanned via disposable `/tmp/agy-corpus-scan.py` (deleted after use, not committed).
- `gh api repos/konradschrein-star/AI-Operating-System/branches/main/protection`, `gh api repos/konradschrein-star/content-forge/branches/main/protection`, `gh api user`, `gh api repos/konradschrein-star/AI-Operating-System` — live GitHub API, this run, 2026-08-25.
- `crontab -l`, `/var/log/pg-backup.log`, `/opt/ai-os/scripts/pg-backup.sh` — live host state, this run, 2026-08-25.
