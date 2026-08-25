#!/usr/bin/env bash
# Refuse to merge a project branch that carries paths belonging to another
# lane. Read-only: prints the merge scope, checks it, exits 0 or 1. It never
# merges, never checks out, never writes.
#
# WHY THIS EXISTS. Round 3's review of aios-stuck-run-is-not-a-failed-task
# found the LIVE checkout /opt/forge-ai-os dirty with six paths
# (forge-control-web/app/desktop/ChatSurface.tsx, .../chat/FileExplorerPanel.tsx,
# .../chat/MessageMarkdown.tsx, .../chat/code-path-link.ts,
# .../chat/open-file-bus.ts, forge-control/src/routes/files.ts). All six belong
# to aios-chat-reference-navigation (project/ecacba29*) and land with THAT
# lane's merge. The correct action is not "revert" — reverting manufactures a
# conflict, and ChatSurface.tsx would lose main's committed pagination thunk,
# because that file is main's thunk PLUS the lane's wiring, a combination that
# exists on no ref. The correct action is that this project's merge must not
# contain them, which is a checkable fact about `git diff base...head`, so
# check it instead of promising it.
#
# THE THREE-DOT RANGE IS LOAD-BEARING. `base...head` is the diff from the
# MERGE BASE to head — what this branch adds. `base..head` (two dots) would
# also list everything main gained since the branch forked and would refuse a
# perfectly clean branch. See docs/ops/recover-stuck-capped-tasks.md.
#
# Usage:
#   assert-merge-scope.sh BASE HEAD REFUSED_PATTERN [REFUSED_PATTERN ...]
#
#   BASE, HEAD        any two git revisions; the scope checked is BASE...HEAD.
#   REFUSED_PATTERN   an extended-regex (grep -E) matched against each path in
#                     the scope. One or more required — a run with no patterns
#                     could not fail and is refused as a usage error rather
#                     than reported as a pass.
#
# Exit codes:
#   0  scope clean — no path matched any refused pattern
#   1  at least one path matched (each printed with the pattern that caught it)
#   2  usage error, or a revision git cannot resolve
#
# Example (this project's deploy gate):
#   scripts/ops/assert-merge-scope.sh main HEAD \
#     'forge-control-web/' 'forge-control/src/routes/files\.ts'

set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

usage() {
  echo "usage: $0 BASE HEAD REFUSED_PATTERN [REFUSED_PATTERN ...]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage

BASE="$1"; shift
HEAD_REV="$1"; shift

for rev in "$BASE" "$HEAD_REV"; do
  if ! git rev-parse --verify --quiet "$rev^{commit}" >/dev/null; then
    echo "FATAL: cannot resolve revision '$rev' — wrong worktree, or the ref does not exist" >&2
    exit 2
  fi
done

MERGE_BASE="$(git merge-base "$BASE" "$HEAD_REV")"
echo "merge scope: ${BASE}...${HEAD_REV}  (merge base ${MERGE_BASE})"

# `|| true` because grep-less empty output is not an error here, but an empty
# scope IS worth saying out loud: a diff of nothing is either an already-merged
# branch or the wrong pair of revisions, and silently passing it would be the
# gate reporting success for a run that checked nothing.
SCOPE="$(git diff --name-only "${BASE}...${HEAD_REV}")"
if [ -z "$SCOPE" ]; then
  echo "NOTE: scope is EMPTY — ${HEAD_REV} adds no path over ${BASE}."
  echo "      Either it is already merged (check: git merge-base --is-ancestor ${HEAD_REV} ${BASE})"
  echo "      or these are the wrong revisions. Nothing to refuse; not treated as a failure."
  echo "SCOPE CLEAN — 0 paths, 0 refused"
  exit 0
fi

echo "$SCOPE" | sed 's/^/  /'
echo "paths in scope: $(printf '%s\n' "$SCOPE" | wc -l)"

FOUND=0
for pattern in "$@"; do
  # -- before the pattern so a pattern beginning with '-' is not read as a flag.
  hits="$(printf '%s\n' "$SCOPE" | grep -E -- "$pattern" || true)"
  if [ -n "$hits" ]; then
    FOUND=1
    echo ">>> REFUSED by pattern: ${pattern}"
    printf '%s\n' "$hits" | sed 's/^/      /'
  fi
done

if [ "$FOUND" -ne 0 ]; then
  cat >&2 <<'EOF'

MERGE REFUSED. The scope above carries at least one path this branch does not own.
Do NOT "fix" this by reverting those files — they belong to another lane and land
with that lane's merge; reverting manufactures a conflict and can drop work that
exists on no other ref. Either the wrong branch is checked out, or a path was
committed here by mistake. Stop and report the paths verbatim.
EOF
  exit 1
fi

echo "SCOPE CLEAN — no path matched any of the $# refused pattern(s)"
exit 0
