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
| `guard-service-restart.py` | PreToolUse(Bash) hook. Blocks a `pm2 restart`/`stop` of a live service from inside a run — locally, without any API call — and points at `safe-restart.sh` instead. |
| `guard-autonomy.py` | PreToolUse(Bash) hook. Classifies the command (`fs.destructive`, `git.force_push`, `comm.outbound`) and asks `POST /api/autonomy/check` whether this run may do it. Also carries one purely-local rule, `autonomy.self_edit`. |
| `guard-protected-paths.py` | PreToolUse(`Write`\|`Edit`\|`MultiEdit`) hook. The Bash hooks cannot see a `Write` — an agent can overwrite `settings.json` with the Write tool exactly as effectively as with `rm`. Blocks writes under `/root/.claude/` (except `projects/`, which agents legitimately write), `/opt/ai-os/scripts/`, and any path resolving to a `guard-*.py` in this directory. |
| `test-guard-*.py` | The three hooks' test suites. Classifier assertions run **in-process** (`importlib`); the exit-code contract runs against a **local stub HTTP server**. Neither ever touches `:7700` — every blocked case against the live API would insert a real `guardrail_trips` row. |
| `hooks.settings.json` | The canonical `hooks` object: which hook is registered against which tool matcher. Source of truth for `install-hooks.sh`. |
| `install-hooks.sh` | Merges those entries into every enabled account's `settings.json` — see below. |
| `install-symlinks.sh` | Installs `/opt/ai-os/scripts/<name>` as a symlink into this directory — see below. |

## The hook files, and why they are here

The three `guard-*.py` hooks were the **last two plain files left in
`/opt/ai-os/scripts`** after round 0 of this migration —
`guard-service-restart.py` and `guard-autonomy.py` sat there untracked, with
`guard-protected-paths.py` not yet written. Every other file in that directory
had become a symlink into git; those two had not, for the ordinary reason: they
were added later, by hand, at 23:00 on 2026-08-25, in the middle of wiring the
enforcement layer.

That is a worse gap than it was for the rest. These files run **before every
Bash call made by every agent on this box**. A change to `guard-autonomy.py`'s
classifier is a change to what the entire fleet is permitted to do, and until
now such a change had no diff, no review, no history, and no way back except a
`.bak-*` file next to it. The specific failure this project exists to fix —
v1's block message printed the `FORGE_GUARD_ACK` override recipe, and a Haiku
turn with no authorisation read it out of the refusal and self-granted five
seconds later — was found and fixed by hand-editing an untracked file. Nobody
could have reviewed that fix, because there was nothing to review.

They are under git now. The live paths keep working because
`install-symlinks.sh` points `/opt/ai-os/scripts/guard-*.py` back here, exactly
as it does for `safe-restart.sh`.

## Registering the hooks

Hook registration is **per `CLAUDE_CONFIG_DIR`**. A second enabled account whose
`settings.json` lacks these entries runs completely unguarded while looking,
from the outside, exactly like a guarded one — so the account list is read from
`claude_accounts` rather than assumed to be `/root/.claude`.

```
scripts/ops/install-hooks.sh              # every ENABLED account
scripts/ops/install-hooks.sh --check      # audit only; exit 1 if any dir is
                                          # missing an entry. Writes nothing.
scripts/ops/install-hooks.sh --dry-run    # print the diff, write nothing
scripts/ops/install-hooks.sh <dir>...     # explicit dirs (how it is tested)
```

Merging only ever **appends** a missing entry. Every other key in the target
file is preserved, a hook this script did not add is never removed, the file is
backed up to `/opt/ai-os/backups/settings/<UTC-stamp>/` before a byte is
written, and the write itself is an atomic `os.replace` so an interrupted run
cannot leave a half-written `settings.json`. A `settings.json` that does not
parse is refused outright rather than overwritten — overwriting it would
silently discard that account's `permissions` block.

Exercised against a scratch sandbox under `/tmp` (never `/root/.claude`):
`--check` red on two hookless dirs → `--dry-run` printing the diff and writing
nothing → install over a fresh dir, a dir carrying real `permissions`/`theme`
keys, and a dir whose `Bash` matcher already held a foreign hook → second run
byte-identical (idempotent) → `--check` green → the foreign hook still first in
its matcher, `permissions`/`theme` unchanged → a corrupt `settings.json`
refused with exit 1 and left untouched. Running it against the real host is a
deploy-task step, not a build-task one.

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
file present with the right mode, every shell script parses, every Python hook
compiles, `install-symlinks.sh`'s file list matches what's actually in this
directory, `safe-restart.sh` still carries its self-exclusion and
single-instance guards, and `hooks.settings.json` registers exactly the three
hooks that exist on disk and are executable. It never touches
`/opt/ai-os/scripts` or any live service.

That last assertion is made against the **parsed** JSON, never grepped:
`hooks.settings.json` names all three scripts in its own `_comment` block, so a
`grep guard-autonomy.py` over the file passes whether or not the registration
entry exists. A check that cannot fail is worse than one that is absent.

The three hook suites run the same way and are wired into
`scripts/checks/gates-808.sh`:

```
python3 scripts/ops/test-guard-autonomy.py
python3 scripts/ops/test-guard-service-restart.py
python3 scripts/ops/test-guard-protected-paths.py
```

**Known inherited RED.** `check-ops-scripts.sh` asserts
`check-vps2-backup.sh` is mode `750`. git stores it as `100755` — the mode is
restored by `install-symlinks.sh` at install time and cannot survive a
checkout, so this check is red in every fresh worktree and has been since it
was written (round 0, `95136f4`). It is left red on purpose: the assertion is
correct about the installed host copy, and softening it to accept `755` would
delete the only thing watching that file's permissions.
