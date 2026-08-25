# 03 — Guardrail hygiene: the pulse reads the audit log, and it gets rotated

Round 2 of `aios-guardrail-hardening`, task "fleet-pulse guardrail section:
trips, fail-opens, ACKs, hook registration; logrotate for the hook log."
Companion to [`00-findings.md`](00-findings.md) P3-2 ("`guardrail_trips` is
written and never read; attribution is thin") and P3-1 (fail-open holds on
every path, but a control-plane-under-load run is a single log line nobody
reads).

Write-set: `scripts/ops/fleet-pulse.sh`, `deploy/logrotate.d/forge-guard-autonomy`,
this file. No file outside that set was touched by this task.

---

## What changed in `fleet-pulse.sh`

A third section, `── 3. guardrails ──`, inserted after the watchdog-liveness
check and before the combined findings summary log line so its output is
counted there too. Four checks, all **read-only**:

**3a — unresolved trips older than 24h.** `GET $API/autonomy` (the same API
base the reminders POST already uses), filtered to `resolved == false` and
`ts` older than now-24h, grouped by `rule_id`. Finding text matches the
brief's example shape exactly:

```
guardrails: 3 unresolved trips >24h (fs.destructive ×2, git.force_push ×1)
```

Caveat, stated because it is a real ceiling and not a bug this section can
fix: `getAutonomy()` (`forge-control/src/db/autonomy.ts:98-106`) queries
`ORDER BY t.created_at DESC LIMIT 30` — the endpoint hands back only the
newest 30 trips, period. A stale trip pushed past that window by 30 newer
ones is invisible to this check exactly as it is invisible to the console
itself. This section is read-only against that endpoint by design (the
brief: never resolve a trip, never touch the API beyond a GET), so widening
the limit is a `db/autonomy.ts` change outside this task's write-set, worth
flagging if the trip volume ever grows enough to matter.

**3b — loud lines (ACK / local block).** The hook's own audit log
(`/var/log/forge-guard-autonomy.log`, overridable via `FORGE_GUARD_AUDIT_LOG`
for tests, matching the hook's own override) is scanned once for `kind` in
`{"acknowledged", "blocked-local"}` within the last 24h, quoting `rule_id`
and `run_id` per the brief. An ACK already pings Konrad within the minute
(`notify_konrad`, verified working in round 0 — 00-findings.md "Verified,
not a finding" §A6) — this is the part that survives after that Telegram
line scrolls off.

**3c — fail-open storm.** Same one-pass scan counts `kind == "fail-open"` in
the last 24h; `>= 3` is a finding ("control plane unreachable from the
hook"). Below 3 it is not silent — see the always-logged baseline below.

**3d — hook registration.** Calls `"$REPO_SCRIPTS/install-hooks.sh" --check`
(no args — the account list comes from `claude_accounts`, exactly the
production path) and treats a non-zero exit as a finding quoting its output,
truncated to 220 chars. `--check` never writes by its own contract (verified
by reading `install-hooks.sh`'s check-mode branch: it prints `MISSING
entries` and exits 1, no file touched), so this call is safe from a
read-only detector the same way `stalled-projects.sh`'s own `psql` calls
already are.

**Always logged, never alerted.** One line per run, regardless of findings:

```
guardrails: 24h counts — blocked=N fail-open=N acknowledged=N (audit log: PATH)
```

`blocked-local` is deliberately excluded from this triplet (the brief names
exactly `blocked/fail-open/acknowledged`); it is covered by 3b instead.

## Dry-run proof

Scratch audit log (`/tmp/fleet-pulse-guard-test.log`, hand-made JSON lines,
never committed) built to exercise every branch in one pass:

| line | kind | age | should count? |
|---|---|---|---|
| 1 | blocked | 30h (outside window) | no — proves the window |
| 2 | blocked | 2h | yes |
| 3 | fail-open | 1h | yes |
| 4 | fail-open | 1h | yes |
| 5 | fail-open | 10m | yes |
| 6 | acknowledged | 1h | yes |
| 7 | blocked-local | 10m | yes |
| 8 | (not valid JSON) | — | skipped, not counted, no crash |
| 9 | acknowledged | ~31h (outside window) | no — second window proof |

Run: `FORGE_GUARD_AUDIT_LOG=/tmp/fleet-pulse-guard-test.log bash
scripts/ops/fleet-pulse.sh --dry-run --force`. Output (guardrail lines only;
the stall findings that follow them are real live rows from
`stalled-projects.sh`, unrelated to this task):

```
guardrails: 2 ack/local-block line(s) in 24h (acknowledged fs.destructive run=test-run-ack1,blocked-local autonomy.self_edit run=test-run-local1)
guardrails: 3 fail-open in 24h (control plane unreachable from the hook)
guardrails: install-hooks.sh --check failed — config dirs from claude_accounts (enabled): /root/.claude  == /root/.claude MISSING entries:   - PreToolUse[Write|Edit|MultiEdit] /opt/ai-os/scripts/guard-protected-paths.py  one or more config dirs FAILED — see above
```

**Ordering fix made during this task.** The alert body previews only the
first 4 lines of the combined `findings` string (the 500-char reminder
cap). The first version of this section appended guardrail findings AFTER
the stall findings; against the real live stall backlog above (8 lines),
`head -4` swallowed all three guardrail lines from the Telegram preview
entirely — they were still counted in "N finding(s)" and still fully
visible in the log and the non-alert echo, but invisible in the one place
Konrad actually reads first. Fixed by putting `guard_findings` FIRST when
building `findings` (`findings="$guard_findings${findings:+$'\n'$findings}"`).
Re-run after the fix, `--dry-run --force` body:

```
🩺 Fleet pulse: 12 finding(s).
guardrails: 2 ack/local-block line(s) in 24h (acknowledged fs.destructive run=test-run-ack1,blocked-local auto
guardrails: 3 fail-open in 24h (control plane unreachable from the hook)
guardrails: install-hooks.sh --check failed — config dirs from claude_accounts (enabled): /root/.claude  ==
BLOCKED or PAUSED while holding open work :: zz-tierpin-verify|paused|1

Stalls: /opt/ai-os/scripts/stalled-projects.sh · Guardrails: /var/log/fleet-pulse.log
```

All three guardrail lines now lead the preview; the stall backlog fills the
remaining budget instead of crowding guardrails out.

The always-logged baseline for that same run, read back from
`/var/log/fleet-pulse.log`:

```
[2026-08-25T07:58:20+02:00] guardrails: 24h counts — blocked=1 fail-open=3 acknowledged=1 (audit log: /tmp/fleet-pulse-guard-test.log)
```

`blocked=1` and `acknowledged=1` (not 2) is the window proof: line 1 (30h
old) and line 9 (31h old) were correctly excluded from both the daily count
and the 3b finding, while lines within 24h were counted. `fail-open=3`
correctly triggered 3c (`>= 3`). Re-run against an emptied scratch log
(`: > /tmp/fleet-pulse-guard-empty.log`) produced **no** 3a/3b/3c findings
and a baseline of `blocked=0 fail-open=0 acknowledged=0` — the checks are
silent when there is nothing to report, not silent by construction.

3d fired in **both** runs above, against the real live `/root/.claude/settings.json`
— confirmed by reading that file directly:

```
$ python3 -c "import json; print(json.load(open('/root/.claude/settings.json'))['hooks'])"
{'PreToolUse': [{'matcher': 'Bash', 'hooks': [
  {'type': 'command', 'command': '/opt/ai-os/scripts/guard-service-restart.py'},
  {'type': 'command', 'command': '/opt/ai-os/scripts/guard-autonomy.py'}]}]}
```

No `PreToolUse[Write|Edit|MultiEdit]` entry for `guard-protected-paths.py`
exists on the live host today. **This is a genuine, current gap** — the
Write/Edit protected-paths hook this project's plan calls for
(`docs/plan/aios-guardrail-hardening/PLAN.md` §"Plus what the findings make
unavoidable") has not been installed on `/root/.claude` yet. It is not a
test artefact: 3d's own logic queries `claude_accounts` and reads the real
`settings.json`, exactly as it will in production. Not this task's write-set
to fix — flagged for the deploy task (T8), which owns running
`install-hooks.sh` for real.

**3a** produced no finding against live data, and this was checked rather
than assumed: `GET /api/autonomy` today returns exactly 30 trips (the `LIMIT
30` cap, measured live — `curl -s $API/autonomy | python3 -c '...'` printed
`total trips returned: 30`), every unresolved one of them under 6.3h old.
This is the caveat above made concrete, not a coincidence: round 0's own
findings record 12 unresolved rows total, 9 of them pre-existing
`spend.daily_cap`/`runtime.pause_all`/probe rows from 06-19 — genuinely
stale by any measure, and by construction NOT among the 30 newest once 21+
more recent trips (round 0 and round 1's own test rows, resolved) exist
ahead of them in `ORDER BY created_at DESC`. `GET /api/autonomy` cannot see
them, so neither can this section — the console itself has the identical
blind spot. The parsing/grouping logic itself was proven directly against
synthetic JSON shaped exactly like the endpoint's response (3 unresolved
>24h across two rule_ids, 1 resolved excluded, 1 recent excluded):

```
$ echo '{"trips":[
    {"rule_id":"fs.destructive","ts":"2026-08-23 05:58:04.123456+00","resolved":false},
    {"rule_id":"fs.destructive","ts":"2026-08-23 06:00:00+00","resolved":false},
    {"rule_id":"git.force_push","ts":"2026-08-23 07:00:00+00","resolved":false},
    {"rule_id":"fs.destructive","ts":"2026-08-25T05:00:00+00:00","resolved":false},
    {"rule_id":"fs.destructive","ts":"2026-08-23 05:00:00+00","resolved":true}
  ]}' | python3 -c '<the 3a parsing block, verbatim>' "$(date +%s)"
guardrails: 3 unresolved trips >24h (fs.destructive ×2, git.force_push ×1)
```

Both `timestamptz::text` shapes Postgres can emit (space-separated with a
`+00` offset, and the ISO `T`-separated form) parse correctly — the
`.replace(" ", "T", 1)` normalisation before `datetime.fromisoformat` handles
both, confirmed with `python3 -c` against both literal strings before this
was wired into the script.

Non-forced dedup was not re-derived here — it is unchanged code (the hash
computation, `STATE` file, 6h re-alert floor) and this task did not touch
it; the new guardrail findings simply flow into the same `findings` string
those mechanics already consume. The one wording fix made:
`"%s stall finding(s)"` in the alert text was renamed to `"%s finding(s)"`,
because after this change the count can include guardrail findings that are
not stalls — the old text would have mislabeled a guardrail-only alert.

## `deploy/logrotate.d/forge-guard-autonomy`

```
/var/log/forge-guard-autonomy.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` (not `create` + a reload signal): `guard-autonomy.py`'s
`audit()` opens the log with a bare `open(AUDIT_LOG, "a")` **per call** — no
long-lived file handle, no daemon to send a signal to. A `create`-style
rotate (rename current log aside, create a fresh empty file at the same
path) needs a process to notice the rename and reopen — nothing here plays
that role, so it is the wrong tool for a process with no persistent handle.
`copytruncate` needs no coordination at all: it copies the log out, then
truncates the SAME inode in place, so every `open(AUDIT_LOG, "a")` call —
before, during or after rotation — keeps appending to the one file that
exists the whole time.

Validated with `logrotate -d` (debug mode, no state mutated) against this
file directly:

```
$ logrotate -d deploy/logrotate.d/forge-guard-autonomy 2>&1 | grep -A4 forge-guard-autonomy.log
rotating pattern: /var/log/forge-guard-autonomy.log  weekly (8 rotations)
empty log files are not rotated, old logs are removed
considering log /var/log/forge-guard-autonomy.log
Creating new state
  log does not need rotating (log has already been rotated)
```

The stanza parses and applies to the right path with the right cadence.
Installing it into `/etc/logrotate.d/forge-guard-autonomy` is the deploy
task's job — this build task never writes there, per the worktree-only
policy.

## Konrad's decision, not dropped, not this task's to make

`00-findings.md` P2-2 records 11+ leftover scratch databases the classifier's
false positives left behind before the routine-path rules were hardened
(`cf_probe_*`, `hcp_scratch_*`, `r963_scratch_*`, `rev1353_scratch`,
`rollup_probe_r1873`, `fleet_selftest`, and others). This task did not touch
any database and does not resolve, drop, or otherwise act on those rows or
those databases — restating the finding's own framing (00-findings.md
recommendation §3: "Drop the eleven leftover scratch databases once the
classifier stops creating more") so it does not silently fall off the
project's radar between round 0 and whatever round finally closes it.
