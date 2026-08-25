#!/usr/bin/env bash
# install-hooks.sh — register the PreToolUse guard hooks in every Claude CLI
# identity the fleet spawns, idempotently and without clobbering anything else
# in that identity's settings.json.
#
# WHY THIS EXISTS. Hook registration is per CLAUDE_CONFIG_DIR. On 2026-08-25 the
# guards were wired by hand into /root/.claude/settings.json — one file, one
# account. `claude_accounts` holds the config_dir of every identity the executor
# may spawn under, and an enabled account whose settings.json lacks these
# entries runs COMPLETELY UNGUARDED while looking, from the outside, exactly
# like a guarded one. A guard that is installed by hand is a guard that is
# installed on some of the boxes some of the time. This script is the answer:
# one command, run from the deploy phase, that makes the registration a fact
# about the account list rather than about whoever last remembered.
#
# The canonical hook entries live in scripts/ops/hooks.settings.json (the
# `hooks` key). This script never invents them.
#
# NON-DESTRUCTIVE BY CONSTRUCTION:
#   - every other key in the target settings.json is preserved verbatim
#     (permissions, theme, cleanupPeriodDays, statusLine, whatever else);
#   - a hook entry this script did not add is never removed — merging only
#     ever appends missing entries;
#   - the file is backed up to /opt/ai-os/backups/settings/<UTC-stamp>/ before
#     a single byte is written;
#   - a second run over an already-installed dir writes nothing at all.
#
# Usage:
#   scripts/ops/install-hooks.sh                      # every ENABLED account
#   scripts/ops/install-hooks.sh /tmp/fake/.claude    # explicit dirs
#   scripts/ops/install-hooks.sh --check              # audit only, exit 1 if
#                                                     # any dir is missing an
#                                                     # entry. Writes nothing.
#   scripts/ops/install-hooks.sh --dry-run            # print the diff, no writes
#
# Exit: 0 — installed / already installed / dry-run printed
#       1 — --check found a dir missing an entry, or an install failed
#
# NEVER run this against the real host from a build task. The worktree-only
# policy reserves live-host writes for a task briefed as deploy or verify;
# build tasks exercise it against a scratch dir under /tmp.

set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$SCRIPT_DIR/hooks.settings.json"
BACKUP_ROOT="${FORGE_SETTINGS_BACKUP_DIR:-/opt/ai-os/backups/settings}"

MODE=install          # install | check | dry-run
declare -a DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE=check;   shift ;;
    --dry-run) MODE=dry-run; shift ;;
    -h|--help) sed -n '1,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)        echo "unknown flag: $1" >&2; exit 1 ;;
    *)         DIRS+=("$1"); shift ;;
  esac
done

[ -f "$CANONICAL" ] || { echo "FATAL: canonical hook file missing: $CANONICAL" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Which config dirs?
#
# No positional args => ask the database. AI_OS_DATABASE_URL is not in this
# shell's environment; it lives in forge-control's pm2 env, which is readable
# without any credential of our own (memory: db-url-recoverable-from-pm2-jlist —
# "no credentials" is never a valid skip).
#
# If that lookup fails we fall back to /root/.claude ALONE and say so loudly on
# stderr. A silent fallback here would be the exact failure this script exists
# to prevent: it would report success having guarded one account out of N.
# ---------------------------------------------------------------------------
if [ "${#DIRS[@]}" -eq 0 ]; then
  db_url="$(pm2 jlist 2>/dev/null \
    | python3 -c 'import json,sys
try:
    apps = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in apps:
    if a.get("name") == "forge-control":
        print(a.get("pm2_env", {}).get("AI_OS_DATABASE_URL", ""))
        break' 2>/dev/null)"

  rows=""
  if [ -n "$db_url" ]; then
    rows="$(psql "$db_url" -tAc \
      "SELECT config_dir FROM claude_accounts WHERE enabled ORDER BY priority, slug" 2>/dev/null)"
  fi

  if [ -n "$rows" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && DIRS+=("$line")
    done <<< "$rows"
    echo "config dirs from claude_accounts (enabled): ${DIRS[*]}"
  else
    echo "WARNING: could not read claude_accounts (AI_OS_DATABASE_URL from pm2 jlist" >&2
    echo "WARNING: was empty or psql failed). FALLING BACK to /root/.claude ALONE." >&2
    echo "WARNING: any OTHER enabled account is NOT covered by this run." >&2
    DIRS=(/root/.claude)
  fi
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
fail=0

for dir in "${DIRS[@]}"; do
  echo
  echo "== $dir"
  MODE="$MODE" STAMP="$STAMP" BACKUP_ROOT="$BACKUP_ROOT" \
  python3 - "$CANONICAL" "$dir" <<'PYEOF'
import difflib
import json
import os
import sys

canonical_path, config_dir = sys.argv[1], sys.argv[2]
mode = os.environ["MODE"]
stamp = os.environ["STAMP"]
backup_root = os.environ["BACKUP_ROOT"]

settings_path = os.path.join(config_dir, "settings.json")

with open(canonical_path) as fh:
    canonical = json.load(fh)["hooks"]

# Read the target. A missing file is a legitimate fresh install; a CORRUPT one
# is not something to paper over — refuse rather than overwrite a file we
# cannot understand, because overwriting it would silently drop the account's
# permissions block.
if os.path.exists(settings_path):
    with open(settings_path) as fh:
        raw_before = fh.read()
    try:
        current = json.loads(raw_before) if raw_before.strip() else {}
    except json.JSONDecodeError as exc:
        print(f"FAIL: {settings_path} is not valid JSON ({exc}) — refusing to touch it")
        sys.exit(1)
    if not isinstance(current, dict):
        print(f"FAIL: {settings_path} is valid JSON but not an object — refusing to touch it")
        sys.exit(1)
else:
    raw_before = ""
    current = {}

merged = json.loads(json.dumps(current))   # deep copy; `current` stays the "before"
missing = []

hooks = merged.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print(f"FAIL: {settings_path} has a `hooks` key that is not an object — refusing to touch it")
    sys.exit(1)

for event, want_groups in canonical.items():
    have_groups = hooks.setdefault(event, [])
    if not isinstance(have_groups, list):
        print(f"FAIL: hooks.{event} is not a list in {settings_path} — refusing to touch it")
        sys.exit(1)

    for want in want_groups:
        matcher = want["matcher"]
        group = next(
            (g for g in have_groups
             if isinstance(g, dict) and g.get("matcher") == matcher),
            None,
        )
        if group is None:
            # Whole matcher absent: append it wholesale.
            missing += [f"{event}[{matcher}] {h['command']}" for h in want["hooks"]]
            have_groups.append(json.loads(json.dumps(want)))
            continue

        entries = group.setdefault("hooks", [])
        if not isinstance(entries, list):
            print(f"FAIL: hooks.{event}[{matcher}].hooks is not a list — refusing to touch it")
            sys.exit(1)

        # Compare on the command string only. Someone may legitimately have
        # added `timeout` or other fields to an entry we installed earlier;
        # that is their edit and we leave it alone.
        have_cmds = {e.get("command") for e in entries if isinstance(e, dict)}
        for h in want["hooks"]:
            if h["command"] not in have_cmds:
                missing.append(f"{event}[{matcher}] {h['command']}")
                entries.append(json.loads(json.dumps(h)))

# json.dumps of the same object graph is a stable rendering, so "no textual
# diff" is a real no-op check and not an artefact of key ordering.
after = json.dumps(merged, indent=2) + "\n"
before_pretty = (json.dumps(current, indent=2) + "\n") if current else ""

if not missing:
    print("ok (already installed): every canonical hook entry present")
    sys.exit(0)

print("MISSING entries:")
for m in missing:
    print(f"  - {m}")

if mode == "check":
    sys.exit(1)

if mode == "dry-run":
    diff = difflib.unified_diff(
        before_pretty.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"{settings_path} (current)",
        tofile=f"{settings_path} (after install)",
    )
    sys.stdout.writelines(diff)
    print("dry-run: nothing written")
    sys.exit(0)

# --- write path -------------------------------------------------------------
os.makedirs(config_dir, exist_ok=True)
if raw_before:
    backup_dir = os.path.join(backup_root, stamp)
    os.makedirs(backup_dir, exist_ok=True)
    # Two accounts both ending in `.claude/settings.json` must not collide in
    # one backup dir, so the whole path is flattened into the filename.
    flat = config_dir.strip("/").replace("/", "_") + ".settings.json"
    backup_path = os.path.join(backup_dir, flat)
    with open(backup_path, "w") as fh:
        fh.write(raw_before)
    print(f"backed up: {settings_path} -> {backup_path}")

tmp_path = settings_path + ".install-hooks.tmp"
with open(tmp_path, "w") as fh:
    fh.write(after)
os.replace(tmp_path, settings_path)     # atomic: never a half-written settings.json
print(f"installed: {settings_path} ({len(missing)} entr{'y' if len(missing) == 1 else 'ies'} added)")
PYEOF
  rc=$?
  [ "$rc" -ne 0 ] && fail=1
done

echo
if [ "$fail" = 0 ]; then
  case "$MODE" in
    check)   echo "PASS: every config dir carries every canonical hook entry" ;;
    dry-run) echo "dry-run complete — nothing was written" ;;
    *)       echo "PASS: hooks installed / already present in ${#DIRS[@]} config dir(s)" ;;
  esac
else
  echo "one or more config dirs FAILED — see above" >&2
fi
exit "$fail"
