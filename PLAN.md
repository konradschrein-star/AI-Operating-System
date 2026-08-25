# aios-guardrail-hardening — plan (round 0)

**Goal.** The PreToolUse(Bash) guard wired on 2026-08-25 must be under version control,
tested against real fleet commands, closed to the quiet bypasses found in
`docs/plan/aios-guardrail-hardening/00-findings.md`, and readable by Konrad when it fires.

## Recommendation

Keep the architecture exactly as it is — a local classifier that asks the control plane,
failing open — and fix the four things that make it a speed bump today:

1. **Close the quiet door next to the loud one.** The ACK path pings Konrad; the
   rule-toggle endpoint, the config-poisoning branch and trip self-resolve do not. Engine:
   `enabled` means blocked whatever the config says; every rule change and trip resolve
   writes `guardrail_rule_changes` and queues a Telegram line. Hook: an agent's curl at
   `/api/autonomy/rules` or `/trips/*/resolve` is a local hard block — the console is
   Konrad's surface.
2. **One tokeniser, transparent wrappers, real paths.** `shlex` with `punctuation_chars`
   replaces the regex split; `bash -c`/`sh -c`/`eval`/`xargs`/`nice`/`timeout`/`nohup`/
   `docker exec`/`ssh <host>` are stepped through; git global options are parsed so
   `git -C … push --force origin main` resolves to `main`, not `origin`; `+refspec`,
   `--delete`, `--mirror`, `pm2 del`, docker volume verbs are added. Interpreter bodies,
   redirections, `mv`, `git reset --hard` are rejected on purpose and written down.
3. **Stop blocking the builder's own scratch.** Five of ten trips in 24h were false
   positives and one left a scratch database behind. Routine = any routine path
   *component*, relative targets under a routine cwd, inside-own-worktree paths,
   `/opt/ai-os/scratch/`, self-created `mktemp -d`/`CREATE DATABASE` scratch, and
   scratch-named databases. `/opt/ai-os/uploads/` and every worktree *root* stay guarded.
4. **Make the audit log a thing someone reads.** `fleet-pulse.sh` gains a guardrail
   section (trips, fail-opens, ACKs, hook registration per enabled account); logrotate
   for the hook log; `agent` attributed by run role.

Plus what the findings make unavoidable: the hooks move into `scripts/ops/` behind the
existing `install-symlinks.sh` pattern; the `/tmp` harness becomes
`scripts/ops/test-guard-autonomy.py` (in-process classifier matrix + stub-API contract
tests, never the live API) and a `gates-808.sh` line; an `install-hooks.sh` registers the
hooks in every enabled `claude_accounts.config_dir`, because Claude Code reads
`settings.json` from `CLAUDE_CONFIG_DIR` and today only `/root/.claude` carries them.
A narrow PreToolUse(Write|Edit|MultiEdit) hook protects the guard's own live files and
`settings.json` — the one non-Bash tool path a blocked agent would reach for first.

## What owns state · what dispatches · what fails how · how Konrad sees it

- State: `guardrail_rules` (Konrad's console) and `guardrail_trips` +
  `guardrail_rule_changes` (append-only) in `content_forge`; the hook owns nothing.
- Dispatch: Claude Code invokes both hooks in parallel before every Bash call of every
  claude-code run; `agy` runs are **not covered** (research task decides what is possible;
  GitHub branch protection on `main` is the recommended backstop regardless).
- Failure: the hook fails open on every path (measured, table in the findings), logs
  `fail-open`, and the pulse counts those lines — a control plane under load no longer
  fails open in silence. Exit codes are 0/2 only.
- Visibility: block → the agent's stderr and a trip row; ACK/rule change/trip resolve →
  Telegram within a minute + inbox row; fleet pulse → daily counts and a registration check.

## Rejected alternatives

- Enforce inside forge-control instead of a hook — the API never sees a Bash command.
- Block Write/Edit broadly (`/opt/forge-ai-os/**`) — a design decision for Konrad; asked
  in the manager chat, default is the guard's own files only.
- Inspect `python -c`/`node -e`/`psql -f` bodies — unbounded, and the false positives would
  get the guard switched off, which the brief ranks as the larger risk.
- Reintroduce any spend rule — forbidden by the brief.
- A separate `guardrail_changes` UI surface — out of scope; the API field is additive.

## Task graph

```
T1 researcher  agy/Gemini hook options + backstops                 depends []           junior   main
T2 builder     test-guard-autonomy.py (RED on evasions at HEAD)     depends []           junior   main
T5 builder     engine: default-branch, rule-change audit + ping     depends []           standard engine
T3 builder     hooks into scripts/ops + hardened classifier +
               guard-protected-paths + install-hooks + gate line    depends [T2]         standard main
T6 builder     fleet-pulse guardrail section + logrotate            depends [T3]         junior   main
T5i builder    integrate engine → main (stop on conflict)           depends [T5,T6]      junior   main
T7 reviewer    whole diff: claims checked, tests proven to bite     depends [T1,T2,T3,T5,T5i,T6]  standard
T8 builder     deploy: symlinks, hooks in every account dir,
               migration, forge-control restart, live verify,
               resolve stale test trips                             depends [T7]         standard main
```

Evidence for every claim above: `docs/plan/aios-guardrail-hardening/00-findings.md`.
