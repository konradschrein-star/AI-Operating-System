#!/usr/bin/env bash
# git-sync-branch.sh — publish a worktree's current branch to origin, with an optional
# idempotent pull request. Deliberately boring: plain push only, every failure is loud,
# nothing is ever retried or escalated. If origin rejects the push, that is the caller's
# problem to resolve by hand — this helper never rewrites remote history.
#
# usage: scripts/git-sync-branch.sh <worktree-dir> [--pr "<title>"] [--base <branch>] [--project <project-id>]
#
# exit codes:
#   0  branch pushed (and PR created, or already present)
#   1  push rejected, or a gh pr operation failed — git/gh stderr reaches the caller intact
#   2  bad arguments, not a git worktree, or detached HEAD
#   3  no origin remote
#   4  gh not authenticated
set -euo pipefail

self="git-sync-branch.sh"

usage() {
  cat >&2 <<'USAGE'
usage: git-sync-branch.sh <worktree-dir> [--pr "<title>"] [--base <branch>] [--project <project-id>]

  <worktree-dir>    existing git worktree whose current branch is pushed to origin
  --pr "<title>"    open a pull request with this title if none exists for the branch
  --base <branch>   pull request base branch (default: main)
  --project <id>    forge-control project id, named in the pull request body

exit: 0 ok | 1 push/pr failed | 2 bad args | 3 no origin remote | 4 gh not authenticated
USAGE
}

dir=""
want_pr=0
pr_title=""
base="main"
project_id=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pr)
      [ $# -ge 2 ] || { echo "$self: --pr needs a title" >&2; usage; exit 2; }
      want_pr=1
      pr_title="$2"
      shift 2
      ;;
    --base)
      [ $# -ge 2 ] || { echo "$self: --base needs a branch name" >&2; usage; exit 2; }
      base="$2"
      shift 2
      ;;
    --project)
      [ $# -ge 2 ] || { echo "$self: --project needs a project id" >&2; usage; exit 2; }
      project_id="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 2
      ;;
    -*)
      echo "$self: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      [ -z "$dir" ] || { echo "$self: unexpected extra argument: $1" >&2; usage; exit 2; }
      dir="$1"
      shift
      ;;
  esac
done

# 1. arguments must name a real git worktree
if [ -z "$dir" ]; then
  echo "$self: missing <worktree-dir>" >&2
  usage
  exit 2
fi
if [ ! -d "$dir" ]; then
  echo "$self: not a directory: $dir" >&2
  usage
  exit 2
fi
if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$self: not a git worktree: $dir" >&2
  usage
  exit 2
fi
if [ "$want_pr" -eq 1 ] && [ -z "$pr_title" ]; then
  echo "$self: --pr title must not be empty" >&2
  usage
  exit 2
fi

# 2. origin must exist — the caller decides whether a missing remote matters
if ! origin_url="$(git -C "$dir" remote get-url origin 2>/dev/null)"; then
  echo "$self: no origin remote in $dir" >&2
  exit 3
fi

# 3. gh must be installed and authenticated (checked even without --pr, so a caller
#    scripting the PR path never discovers the problem halfway through)
if ! command -v gh >/dev/null 2>&1; then
  echo "$self: gh not authenticated: the gh CLI is not on PATH" >&2
  exit 4
fi
if ! (cd "$dir" && gh auth status >/dev/null 2>&1); then
  echo "$self: gh not authenticated: 'gh auth status' failed in $dir" >&2
  exit 4
fi

# 4. resolve the branch — a detached HEAD has nothing to publish
branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "HEAD" ]; then
  echo "$self: detached HEAD in $dir — check out a branch before syncing" >&2
  exit 2
fi

# 5. plain push only. git's own stderr is passed through untouched on rejection.
echo "$self: pushing $branch to $origin_url" >&2
if ! git -C "$dir" push origin HEAD; then
  echo "$self: push of $branch to $origin_url was rejected (see git's output above); resolve it by hand — this helper does not retry" >&2
  exit 1
fi

echo "pushed-branch: $branch"
echo "origin-url: $origin_url"

# 6. optional, idempotent pull request
if [ "$want_pr" -eq 1 ]; then
  if [ -n "$project_id" ]; then
    pr_body="Opened by scripts/git-sync-branch.sh for forge-control project ${project_id}. Branch \`${branch}\` was pushed to origin."
  else
    pr_body="Branch \`${branch}\` was pushed by scripts/git-sync-branch.sh."
  fi

  if ! existing_pr="$(cd "$dir" && gh pr list --head "$branch" --json number,url --jq '.[0].url // empty')"; then
    echo "$self: 'gh pr list --head $branch' failed (see gh's output above)" >&2
    exit 1
  fi
  if [ -n "$existing_pr" ]; then
    echo "pr-existing: $existing_pr"
    exit 0
  fi

  if ! pr_url="$(cd "$dir" && gh pr create --base "$base" --head "$branch" --title "$pr_title" --body "$pr_body")"; then
    echo "$self: 'gh pr create' for $branch onto $base failed (see gh's output above)" >&2
    exit 1
  fi
  echo "pr-created: $pr_url"
fi

exit 0
