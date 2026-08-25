#!/usr/bin/env bash
# check-ops-scripts.sh — verify the scripts/ops/ migration is internally
# consistent: every managed file is present with the right mode, every shell
# script parses, install-symlinks.sh's FILES list matches what actually lives
# in scripts/ops/, and safe-restart.sh still carries the two guards that were
# built and measured the hard way (self-exclusion, single-instance lock).
#
# This checks the REPO'S copies only. The one exception is the permission check
# below, which READS (never writes) the symlink at $TARGET_DIR to decide whether
# this checkout is the installed one — a single `readlink`, no mutation, safe
# from a build task under the worktree-only policy. Verifying the actual host
# install (symlinks in place, safe-restart.sh run against a real pm2 service)
# is still a deploy/verify-task job.
#
# Usage:  scripts/checks/check-ops-scripts.sh
# Env:    FORGE_OPS_TARGET_DIR — where install-symlinks.sh puts its symlinks.
#         Defaults to install-symlinks.sh's own TARGET_DIR (/opt/ai-os/scripts).
#         Overridden by scripts/checks/prove-ops-mode-bites.sh, which stands up
#         a scratch install so the mode assertion can be watched failing.
# Exit:   0 — every check passed
#         1 — something is missing, mismodes, or the guard logic regressed

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS="$REPO/scripts/ops"
TARGET_DIR="${FORGE_OPS_TARGET_DIR:-/opt/ai-os/scripts}"
fail=0

note() { echo "-- $*"; }
bad()  { echo "FAIL: $*" >&2; fail=1; }
skip() { echo "SKIP: $*"; }

# Managed files: the shell/canvas scripts + JSON payloads + the two docs.
# Kept as a literal list (not derived) so this check can tell an intentional
# addition from an accidental one — same reasoning as install-symlinks.sh's
# own FILES array, which this check cross-references below.
EXPECTED_EXEC=(
  safe-restart.sh claude-code-autoupdate.sh reap-orphan-agents.sh pg-backup.sh
  fleet-watchdog.sh fleet-pulse.sh stalled-projects.sh check-corpus-backup.sh
  check-vps2-backup.sh prune-corpus-offbox.sh agy-dropout-stopgap.sh canvas
  deploy-goal-mode.sh deploy-retier.sh rebuild-web.sh install-symlinks.sh
  guard-service-restart.py guard-autonomy.py guard-protected-paths.py
  test-guard-service-restart.py test-guard-autonomy.py test-guard-protected-paths.py
  install-hooks.sh
)
EXPECTED_NONEXEC=(
  goal-engine-v2.json goal-files-pane.json goal-manager-split.json
  goal-operator-visibility.json hooks.settings.json README.md
)

note "presence + permissions"
for f in "${EXPECTED_EXEC[@]}"; do
  p="$OPS/$f"
  if [ ! -f "$p" ]; then bad "missing: scripts/ops/$f"; continue; fi
  [ -x "$p" ] || bad "not executable: scripts/ops/$f"
done
for f in "${EXPECTED_NONEXEC[@]}"; do
  p="$OPS/$f"
  [ -f "$p" ] || bad "missing: scripts/ops/$f"
done

# check-vps2-backup.sh must stay tighter than the rest — it embeds VPS2's SSH
# monitor invocation. git can only round-trip 644/755, so an installer or a
# careless `chmod` regressing it to world-readable would be silent otherwise.
#
# WHERE THAT ASSERTION IS TRUE, AND WHERE IT CANNOT BE.
# A fresh `git clone` or `git worktree add` materialises this file as 755 —
# git stores 100755 and has no way to record 750. Asserting 750 unconditionally
# therefore made this check RED in EVERY checkout on the box, which mattered the
# moment round 1 wired it into scripts/checks/gates-808.sh: a latent assertion
# nobody ran became the shared suite's permanent `RED: 1` for every project,
# unrelated to any of their work (memory: inherited-assertion-newly-wired-is-
# not-inherited-red).
#
# The mode is only meaningful where install-symlinks.sh has been run, because
# that is what sets it: it symlinks $TARGET_DIR/<f> -> <repo>/scripts/ops/<f>
# and then chmods the REPO file to 750. So "the installed copy" and "this
# checkout" are the same inode exactly when the symlink resolves back here —
# that, not a hardcoded path, is the discriminator.
#
# This is location-awareness, not a softened assertion. On the installed
# checkout the check still demands 750 and still fails at 755; the failing
# transcript is scripts/checks/prove-ops-mode-bites.sh, which stands up a
# scratch $TARGET_DIR and watches it go red.
if [ -f "$OPS/check-vps2-backup.sh" ]; then
  mode="$(stat -c '%a' "$OPS/check-vps2-backup.sh")"
  link="$TARGET_DIR/check-vps2-backup.sh"
  if [ -L "$link" ] && [ "$(readlink -f "$link")" = "$(readlink -f "$OPS/check-vps2-backup.sh")" ]; then
    [ "$mode" = "750" ] || \
      bad "check-vps2-backup.sh mode is $mode, expected 750 — this checkout is the one installed at $TARGET_DIR; re-run scripts/ops/install-symlinks.sh"
  else
    skip "check-vps2-backup.sh mode is $mode — not asserting 750: $TARGET_DIR/check-vps2-backup.sh does not link back to this checkout, so nothing has ever set the mode here (git stores 100755 and cannot carry 750)"
  fi
fi

note "shell syntax"
for f in "${EXPECTED_EXEC[@]}"; do
  p="$OPS/$f"
  [ -f "$p" ] || continue
  head -n1 "$p" | grep -qE '^#!.*\b(bash|sh)$' || continue
  bash -n "$p" 2>/tmp/check-ops-scripts.$$.err || {
    bad "bash -n failed for scripts/ops/$f: $(cat /tmp/check-ops-scripts.$$.err)"
  }
  rm -f /tmp/check-ops-scripts.$$.err
done

note "python syntax"
for f in "${EXPECTED_EXEC[@]}"; do
  case "$f" in *.py) ;; *) continue ;; esac
  p="$OPS/$f"
  [ -f "$p" ] || continue
  python3 -m py_compile "$p" 2>/tmp/check-ops-scripts.$$.pyerr || \
    bad "py_compile failed for scripts/ops/$f: $(cat /tmp/check-ops-scripts.$$.pyerr)"
  rm -f /tmp/check-ops-scripts.$$.pyerr
done

note "install-symlinks.sh FILES list matches what's on disk"
if [ -f "$OPS/install-symlinks.sh" ]; then
  installer_files="$(sed -n '/^FILES=(/,/^)/p' "$OPS/install-symlinks.sh" | grep -oE '^\s*[A-Za-z0-9._-]+\s*$' | tr -d ' ' | sort)"
  # __pycache__ is generated, not managed: the three test suites import the
  # hooks under test with importlib and CPython drops bytecode next to them.
  # It is gitignored; excluding it here keeps a test run from turning this
  # check red as a side effect of having been run.
  disk_files="$(cd "$OPS" && ls -1 | grep -vE '^(install-symlinks\.sh|README\.md|__pycache__)$' | sort)"
  if [ "$installer_files" != "$disk_files" ]; then
    bad "install-symlinks.sh FILES array is out of sync with scripts/ops/ contents"
    diff <(echo "$installer_files") <(echo "$disk_files") >&2 || true
  fi
else
  bad "missing: scripts/ops/install-symlinks.sh"
fi

note "safe-restart.sh guard logic"
SR="$OPS/safe-restart.sh"
if [ -f "$SR" ]; then
  grep -q 'FORGE_RUN_UUID' "$SR" || bad "safe-restart.sh: no FORGE_RUN_UUID self-exclusion reference"
  grep -qE 'SVC.*!=.*forge-executor|forge-executor.*!=.*SVC' "$SR" || \
    bad "safe-restart.sh: self-exclusion does not appear scoped away from forge-executor"
  grep -q "SELF_EXCLUDE=" "$SR" || bad "safe-restart.sh: SELF_EXCLUDE variable not found"
  grep -qE 'flock -n -E 99' "$SR" || bad "safe-restart.sh: single-instance lock (flock -n -E 99) not found"
  grep -q 'SAFE_RESTART_LOCKED' "$SR" || bad "safe-restart.sh: re-exec lock guard SAFE_RESTART_LOCKED not found"
else
  bad "missing: scripts/ops/safe-restart.sh"
fi

note "hooks.settings.json is the canonical registration and matches the hooks on disk"
# Asserted against the PARSED object, never grepped. hooks.settings.json carries
# a `_comment` block that names all three scripts in prose, so a grep for
# 'guard-autonomy.py' passes whether or not the entry exists — the shared
# substring would make the check inert (memory: assertion-inert-shared-substring).
HS="$OPS/hooks.settings.json"
if [ -f "$HS" ]; then
  python3 - "$HS" "$OPS" <<'PYEOF' || bad "hooks.settings.json does not match the hooks on disk (see above)"
import json, os, sys
path, ops = sys.argv[1], sys.argv[2]
want = {
    "Bash": ["/opt/ai-os/scripts/guard-service-restart.py",
             "/opt/ai-os/scripts/guard-autonomy.py"],
    "Write|Edit|MultiEdit": ["/opt/ai-os/scripts/guard-protected-paths.py"],
}
try:
    doc = json.load(open(path))
except json.JSONDecodeError as exc:
    print(f"  hooks.settings.json is not valid JSON: {exc}"); sys.exit(1)

groups = doc.get("hooks", {}).get("PreToolUse")
if not isinstance(groups, list):
    print("  hooks.PreToolUse is missing or not a list"); sys.exit(1)

got = {}
for g in groups:
    got.setdefault(g.get("matcher"), []).extend(h.get("command") for h in g.get("hooks", []))

rc = 0
if got != want:
    print(f"  registration mismatch:\n    want {want}\n    got  {got}")
    rc = 1
# Every registered command must resolve to a file that actually exists in this
# directory. The live path is a symlink into here (install-symlinks.sh), so a
# hook registered under a name nothing ships is a hook that never runs.
for cmds in want.values():
    for c in cmds:
        local = os.path.join(ops, os.path.basename(c))
        if not os.path.isfile(local):
            print(f"  registered command has no file in scripts/ops/: {c}"); rc = 1
        elif not os.access(local, os.X_OK):
            print(f"  registered command is not executable: {c}"); rc = 1
sys.exit(rc)
PYEOF
else
  bad "missing: scripts/ops/hooks.settings.json"
fi

if [ "$fail" = 0 ]; then
  echo "PASS: scripts/ops/ is complete, modes are correct, syntax is clean, installer is in sync, safe-restart.sh guards are present, hook registration matches disk"
else
  echo "one or more checks FAILED — see above" >&2
fi
exit "$fail"
