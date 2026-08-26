#!/usr/bin/env bash
# check-ops-scripts.sh — verify the scripts/ops/ migration is internally
# consistent: every managed file is present with the right mode, every shell
# script parses, install-symlinks.sh's FILES list matches what actually lives
# in scripts/ops/, and safe-restart.sh still carries the two guards that were
# built and measured the hard way (self-exclusion, single-instance lock).
#
# This checks the REPO'S copies only, with two READ-ONLY exceptions at
# $TARGET_DIR: the permission check `readlink`s one symlink to decide whether
# this checkout is the installed one, and the reverse-inventory check `find`s
# the directory for regular files nothing manages. Both read, neither writes —
# safe from a build task under the worktree-only policy. Verifying the actual
# host install (symlinks in place, safe-restart.sh run against a real pm2
# service) is still a deploy/verify-task job.
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
  install-hooks.sh assert-merge-scope.sh recover-stuck-task.sh
  next-build-drift-watchdog.sh usage-ceiling-throttle.sh verify-gemini-dispatch.sh
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

note "nothing unmanaged is living in $TARGET_DIR (reverse direction)"
# The parity check above is one-directional: repo -> installer. It cannot see a
# script that exists ONLY at $TARGET_DIR and in no commit on any branch, which
# is the more dangerous direction — that file is backed up by nothing, and if
# cron runs it, it is load-bearing.
#
# It was not hypothetical. On 2026-08-26 this directory held three real files
# tracked nowhere: next-build-drift-watchdog.sh (cron */3), usage-ceiling-
# throttle.sh (cron */2) and verify-gemini-dispatch.sh. Two of them ran every
# few minutes for a day while the check that exists to catch exactly this
# reported PASS, because nobody had ever asked the question in this direction.
#
# WHY THIS ONE IS NOT LOCATION-GATED, unlike the 750 mode assertion above.
# That assertion is FALSE BY CONSTRUCTION in a checkout install-symlinks.sh has
# never run against — git cannot store 750, so demanding it there asserts
# something git made impossible. This question is EQUALLY TRUE from any
# checkout: "is $TARGET_DIR holding a regular file that FILES does not manage"
# has the same answer whoever asks it, because FILES is the same array in every
# checkout of this repo. Gating it on "am I the installed copy" would make it
# fire only from /opt/forge-ai-os, where nobody runs the gate suite — an
# assertion nobody reaches (memory: unreachable-guard-needs-its-own-control).
#
# The cost accepted knowingly: a new unmanaged file on the box turns this gate
# red for EVERY lane, not just the one that put it there. That is the intended
# signal and the fix is two lines (copy into scripts/ops/, add to FILES), not a
# reason to soften. A lane that forked before someone else's FILES addition
# sees the ordinary stale-merge-base red — resolve it with `git merge-tree`
# (memory: inherited-gate-red-may-be-a-stale-allowlist), do not delete the
# assertion.
if [ ! -d "$TARGET_DIR" ]; then
  skip "no $TARGET_DIR on this host — install-symlinks.sh has never run here, so there is no installed inventory to compare against"
elif [ -f "$OPS/install-symlinks.sh" ]; then
  managed="$(sed -n '/^FILES=(/,/^)/p' "$OPS/install-symlinks.sh" | grep -oE '^\s*[A-Za-z0-9._-]+\s*$' | tr -d ' ' | sort)"
  # -type f is the whole discriminator: an installed entry is a SYMLINK, so a
  # regular file here is either a pre-install leftover or something someone
  # dropped by hand. Directories (__pycache__) are not scripts and cannot be
  # symlink targets of this installer.
  #
  # Backups are the one legitimate regular file. install-symlinks.sh writes its
  # own to /opt/ai-os/backups/scripts/<f>.<stamp>-preinstall, but operators have
  # made them in place by hand (check-vps2-backup.sh.bak-20260806-premonitorkey,
  # safe-restart.sh.bak-20260818). Allow the suffix, not arbitrary names, so a
  # dropped script still has to be named like a backup to hide here.
  unmanaged=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.bak-*|*-preinstall|*.bak) continue ;;
    esac
    printf '%s\n' "$managed" | grep -qxF "$f" || unmanaged="$unmanaged $f"
  done <<< "$(find "$TARGET_DIR" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort)"
  if [ -n "$unmanaged" ]; then
    bad "unmanaged regular file(s) in $TARGET_DIR — present on this box but in no commit, so backed up by nothing:$unmanaged"
    echo "       fix: copy each into scripts/ops/, add it to install-symlinks.sh FILES, then re-run install-symlinks.sh from the live checkout" >&2
  fi
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
