# scripts/ops — host operational scripts, under version control

Everything here used to live only at `/opt/ai-os/scripts/` on the VPS: no git
history, no review, no rollback except a hand-made `.bak-*` copy next to the
file it backs up. `safe-restart.sh` — the script every deploy waits on before
touching a live pm2 service, specifically so a restart never kills an
in-flight agent turn — was edited on 2026-08-23 (self-exclusion, so a calling
run's own heartbeat no longer makes its idle gate unpassable) with the only
record of that change being `/opt/ai-os/backups/scripts/safe-restart.sh.2026-08-23-self-exclude`.
This directory is that history from now on.

## Layout

| File | Purpose |
|---|---|
| `safe-restart.sh` | Waits for `runs` to go idle, then `pm2 restart`s a service — never force-kills a live turn. Single-instance-locked (`flock`); excludes the calling run's own heartbeat from the idle check for every service except `forge-executor`, since that one hosts the caller. |
| `claude-code-autoupdate.sh` | Daily: pulls the latest global Claude Code install so `forge-executor`/`claude-pool` spawn the newest CLI. |
| `reap-orphan-agents.sh` | Every 5 min: kills duplicate `claude --resume <session>` processes left behind by a killed turn, keeping the newest. |
| `pg-backup.sh` | Nightly logical backup of every database the AI OS depends on. |
| `fleet-watchdog.sh` | Every 10 min: unwedges projects blocked by transient run failures (usage walls, guardrail trips, session deaths). Zero-token, capped by the engine's own retry limit. |
| `stalled-projects.sh` | Finds projects that silently stopped announcing progress. |
| `check-corpus-backup.sh` | Runs on VPS1: watches VPS2's 6-hourly JSON corpus backup, alerts on failure or staleness. |
| `check-vps2-backup.sh` | Runs on VPS1: watches VPS2's nightly full backup the same way. Mode `750` — tighter than its siblings — restored by `install-symlinks.sh` on every install since git cannot store that bit. |
| `prune-corpus-offbox.sh` | Prunes the off-box corpus mirror VPS2 pushes (VPS2 never deletes on push; deletion authority lives here, deliberately). |
| `agy-dropout-stopgap.sh` | Temporary stopgap for a task-dropout bug; delete once the permanent fix is confirmed live. |
| `canvas` | CLI (Node) for scripted edits to Konrad's Excalidraw canvas via `forge-control`'s patch API. |
| `deploy-goal-mode.sh`, `deploy-retier.sh` | One-shot deploy scripts from past rounds; kept for the record, safe to delete once their payload has long since shipped. |
| `rebuild-web.sh` | Rebuilds + redeploys `forge-control-web` detached from the calling turn, so an interrupted turn can't leave `.next` half-written. |
| `goal-*.json` | Seed payloads the deploy scripts above POST to forge-control. |
| `install-symlinks.sh` | Installs `/opt/ai-os/scripts/<name>` as a symlink into this directory — see below. |

## Why symlinks, not a move-and-forget

Several of these scripts hardcode `/opt/ai-os/scripts/...` as an absolute
path — to call a sibling (`deploy-goal-mode.sh` runs
`/opt/ai-os/scripts/safe-restart.sh forge-executor ...`) or to read one of the
JSON seed files. Every system cron entry that fires these
(`/etc/cron.d/corpus-backup-check`, `corpus-backup-prune`, `vps2-backup-check`,
plus the four in root's plain crontab) also hardcodes that path. Rewriting
every one of those references was rejected in favor of the option that
touches nothing: keep `/opt/ai-os/scripts/<name>` resolvable, by symlinking it
to this repo's copy.

## Installing

```
scripts/ops/install-symlinks.sh            # install (or repair) the symlinks
scripts/ops/install-symlinks.sh --dry-run  # show what would change, no writes
```

For every managed file:
- Already a correct symlink → left alone (idempotent).
- A symlink pointing somewhere else → replaced.
- A real file → backed up to `/opt/ai-os/backups/scripts/<name>.<UTC-stamp>-preinstall`
  before being replaced with the symlink. Nothing is ever deleted outright.
- Missing → a new symlink is created.

This has been exercised against a scratch sandbox directory (never against
the real `/opt/ai-os/scripts`) covering a fresh install over a mix of a real
file, a stale symlink, and a missing entry; a second, no-op run to confirm
idempotency; and `--dry-run` making no changes. Running it against the real
host — and re-verifying `safe-restart.sh` against a harmless pm2 service
afterwards, as the project brief asks — is a deploy/verify-task step, not a
build-task one: this repo's worktree-only policy reserves live-host changes
for a task explicitly briefed as deploy or verify.

## Checking

`scripts/checks/check-ops-scripts.sh` verifies the repo's own copies: every
file present with the right mode, every shell script parses,
`install-symlinks.sh`'s file list matches what's actually in this directory,
and `safe-restart.sh` still carries its self-exclusion and single-instance
guards. It never touches `/opt/ai-os/scripts` or any live service.
