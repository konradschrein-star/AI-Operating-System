#!/usr/bin/env bash
# Recover a project_tasks row that is stuck at the attempt cap (status=failed,
# attempt >= MAX_TASK_ATTEMPTS) whose work is VERIFIABLY COMPLETE and
# committed in its worktree. Marks it 'done' without re-running it.
#
# WHY THIS EXISTS, NOT retry: POST /api/tasks/:id/retry and
# POST /api/projects/:id/unwedge only move failed/blocked -> ready, i.e. they
# RE-RUN the work. If the work already landed, retrying redoes it and
# re-spends the money — this fleet has 7 recorded instances of exactly that
# "already done" redispatch defect. There is no API route that marks a task
# done; this script's one write is the SQL that does.
#
# Full runbook, one command per step, worked examples for the 5 rows this
# was built for: docs/ops/recover-stuck-capped-tasks.md — READ THAT FIRST.
#
# DRY-RUN BY DEFAULT. Without --apply this prints exactly what it would run
# (the read checks, the SQL, the curl) and exits 0 having written nothing.
# --apply re-runs every check immediately before each write and refuses that
# id, and only that id, if any check fails.
#
# Usage:
#   recover-stuck-task.sh [--apply] TASK_ID:COMMIT_SHA[:drift] ...
#
#   TASK_ID      project_tasks.id (uuid). The ONLY rows this invocation may
#                touch are the ids named on the command line — there is no
#                "all" mode and no wildcard.
#   COMMIT_SHA   the commit YOU have already read and confirmed (by eye, per
#                the runbook) carries a subject matching the task's title.
#                This script does not judge English — it only checks that the
#                sha you name is an ancestor of the task's own worktree HEAD.
#   :drift       optional third field, literally the word "drift". Pass it
#                ONLY after you have manually confirmed, per the runbook, that
#                every write_set path missing verbatim is one of the two named
#                benign drifts (a test file consolidated into
#                forge-control/src/lib/*.test.ts, or a migration renumbered —
#                checked by name, never by number). Without it, ANY write_set
#                path missing verbatim refuses that row. This script never
#                auto-detects drift; it only records that a human did.
#
# A row whose role is 'reviewer' is refused unconditionally, with no flag to
# override it: a reviewer's output is a verdict, not a commit, and marking a
# NEEDS_FIXES verdict 'done' silently converts it into a pass and seeds no fix
# chain. See docs/ops/recover-stuck-capped-tasks.md for what to do instead.
#
# Never DELETEs or TRUNCATEs anything. Never touches pm2 or the executor.

set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

usage() {
  echo "usage: $0 [--apply] TASK_ID:COMMIT_SHA[:drift] ..." >&2
  exit 1
}

[ "$#" -eq 0 ] && usage

APPLY=0
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
  shift
fi
[ "$#" -eq 0 ] && usage

# Credentials live in the secrets env file (password rotates); never hardcode,
# never echo. Same loading pattern as scripts/ops/safe-restart.sh.
set -a; source /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
export PGPASSWORD="${PGPASSWORD:-${DB_PASSWORD:-}}"
if [ -z "$PGPASSWORD" ] && [ -n "${DATABASE_URL:-}" ]; then
  PGPASSWORD="$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-z+]+://[^:]+:([^@]+)@.*$|\1|')"
  export PGPASSWORD
fi
PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -v ON_ERROR_STOP=1)
API="http://127.0.0.1:7700"

# forge-control/src/db/projects.ts:1828 — the same cap /api/tasks/:id/retry
# enforces. Mirrored here, not queried, so this check works even if the row's
# own accounting is wrong; kept in sync by hand if that constant ever moves.
MAX_TASK_ATTEMPTS=2

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
SHA_RE='^[0-9a-f]{7,40}$'

overall_fail=0

verify_and_maybe_write() {
  local spec="$1" id sha third drift
  id="${spec%%:*}"
  local rest="${spec#*:}"
  if [ "$rest" = "$spec" ]; then
    echo "REFUSE ${spec} — missing :COMMIT_SHA (format is TASK_ID:COMMIT_SHA[:drift])"
    overall_fail=1; return
  fi
  sha="${rest%%:*}"
  third="${rest#*:}"
  drift=no
  [ "$third" != "$sha" ] && [ "$third" = "drift" ] && drift=yes

  if [[ ! "$id" =~ $UUID_RE ]]; then
    echo "REFUSE ${spec} — '${id}' is not a task uuid"
    overall_fail=1; return
  fi
  if [[ ! "$sha" =~ $SHA_RE ]]; then
    echo "REFUSE ${spec} — '${sha}' is not a git sha"
    overall_fail=1; return
  fi

  echo "── ${id}  commit=${sha}  drift-ack=${drift} ────────────────────────────"

  # 1. Read the row. (No DELETE/TRUNCATE/UPDATE anywhere before the guarded
  #    write at the bottom of this function.)
  local row=""
  if ! row="$("${PSQL[@]}" -tAF'|' -c \
      "SELECT project_id, title, status, attempt, role, workstream, array_to_string(write_set, ',') FROM project_tasks WHERE id='${id}'" 2>&1)"; then
    echo "REFUSE ${id} — could not read task row: ${row}"
    overall_fail=1; return
  fi
  if [ -z "$row" ]; then
    echo "REFUSE ${id} — no project_tasks row with that id"
    overall_fail=1; return
  fi
  local project_id title status attempt role workstream write_set_csv
  IFS='|' read -r project_id title status attempt role workstream write_set_csv <<<"$row"
  echo "   title:      ${title}"
  echo "   status:     ${status}   attempt: ${attempt}   role: ${role}   workstream: ${workstream}"

  # 2. A verdict-role row is never marked done by this script. No override.
  if [ "$role" = "reviewer" ]; then
    echo "REFUSE ${id} — role=reviewer. A reviewer's output is a VERDICT, not a"
    echo "        commit. Marking it 'done' silently turns NEEDS_FIXES into a"
    echo "        pass and seeds no fix chain. See docs/ops/recover-stuck-capped-tasks.md"
    echo "        (\"When the recovered row is a reviewer\") for the real fix."
    overall_fail=1; return
  fi

  if [ "$status" != "failed" ]; then
    echo "REFUSE ${id} — status is '${status}', not 'failed' (moved under us — re-check by hand)"
    overall_fail=1; return
  fi
  if [ "$attempt" -lt "$MAX_TASK_ATTEMPTS" ]; then
    echo "REFUSE ${id} — attempt=${attempt} < MAX_TASK_ATTEMPTS=${MAX_TASK_ATTEMPTS}; this row hasn't hit the cap, POST /api/tasks/${id}/retry is the right tool"
    overall_fail=1; return
  fi

  local workspace_dir=""
  if ! workspace_dir="$("${PSQL[@]}" -tAF'|' -c "SELECT workspace_dir FROM projects WHERE id='${project_id}'" 2>&1)"; then
    echo "REFUSE ${id} — could not read project ${project_id}: ${workspace_dir}"
    overall_fail=1; return
  fi
  if [ -z "$workspace_dir" ]; then
    echo "REFUSE ${id} — project ${project_id} has no workspace_dir"
    overall_fail=1; return
  fi

  # A workstream other than 'main' forks its OWN worktree at first dispatch,
  # named "<workspace_dir>--<workstream>" (project-tick.ts resolveTaskWorkspace
  # / provisionWorkstream). projects.workspace_dir only ever tracks the MAIN
  # branch's checkout. Checking workspace_dir for a lane task silently checks
  # the wrong tree — it can show a clean status and an unrelated log and still
  # be missing every file the task actually wrote. Measured live 2026-08-25 on
  # 325616b9 (workstream=api-journal): the base dir was missing 12 of 13
  # write_set paths; the lane dir "...--api-journal" had all of them.
  local worktree
  if [ "$workstream" = "main" ] || [ -z "$workstream" ]; then
    worktree="$workspace_dir"
  else
    worktree="${workspace_dir}--${workstream}"
  fi

  if ! git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1; then
    echo "REFUSE ${id} — no git worktree at ${worktree}"
    overall_fail=1; return
  fi
  echo "   worktree:   ${worktree}"

  # 3. Clean tree, and the named commit really is in ITS history.
  local dirty
  dirty="$(git -C "$worktree" status --porcelain || true)"
  if [ -n "$dirty" ]; then
    echo "REFUSE ${id} — worktree is DIRTY:"
    echo "$dirty" | sed 's/^/     /'
    overall_fail=1; return
  fi
  if ! git -C "$worktree" merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    echo "REFUSE ${id} — ${sha} is not an ancestor of ${worktree}'s HEAD"
    overall_fail=1; return
  fi
  echo "   git status --porcelain: (empty)"
  echo "   git log --oneline -8:"
  git -C "$worktree" log --oneline -8 | sed 's/^/     /'

  # 4. Every declared write_set path must exist BY NAME in the worktree.
  local -a paths=() missing=()
  IFS=',' read -r -a paths <<<"$write_set_csv"
  for p in "${paths[@]}"; do
    [ -z "$p" ] && continue
    [ -e "${worktree}/${p}" ] || missing+=("$p")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "   write_set paths NOT found verbatim (${#missing[@]}/${#paths[@]}):"
    printf '     %s\n' "${missing[@]}"
    if [ "$drift" != yes ]; then
      echo "REFUSE ${id} — missing paths above and :drift was not passed."
      echo "        Check each by NAME (renumbered migration, or a test moved"
      echo "        into forge-control/src/lib/*.test.ts — the runner glob only"
      echo "        reaches src/lib) THEN re-run with TASK_ID:${sha}:drift."
      overall_fail=1; return
    fi
    echo "   :drift acknowledged — proceeding on the operator's confirmation."
  else
    echo "   write_set: all ${#paths[@]} declared paths present verbatim."
  fi

  local sql="UPDATE project_tasks SET status='done', updated_at=now() WHERE id='${id}' AND status='failed' RETURNING id, status;"
  echo "   would run:"
  echo "     ${sql}"
  echo "     curl -sX POST ${API}/api/projects/${project_id}/status -H 'content-type: application/json' -d '{\"status\":\"active\"}'"

  if [ "$APPLY" -ne 1 ]; then
    echo "   (dry-run — nothing written)"
    return
  fi

  # --apply: re-verify immediately before writing. A row can move under us
  # between the read above and this line.
  echo "   --apply: re-verifying at write time..."
  local fresh=""
  if ! fresh="$("${PSQL[@]}" -tAF'|' -c "SELECT status, role FROM project_tasks WHERE id='${id}'" 2>&1)"; then
    echo "REFUSE ${id} at write time — could not re-read row: ${fresh}"
    overall_fail=1; return
  fi
  local fresh_status fresh_role
  IFS='|' read -r fresh_status fresh_role <<<"$fresh"
  if [ "$fresh_role" = "reviewer" ] || [ "$fresh_status" != "failed" ]; then
    echo "REFUSE ${id} at write time — now status=${fresh_status} role=${fresh_role} (changed since dry-run)"
    overall_fail=1; return
  fi
  local dirty2
  dirty2="$(git -C "$worktree" status --porcelain || true)"
  if [ -n "$dirty2" ]; then
    echo "REFUSE ${id} at write time — worktree went dirty since dry-run"
    overall_fail=1; return
  fi

  echo "   WRITING:"
  "${PSQL[@]}" -c "$sql"
  curl -sX POST "${API}/api/projects/${project_id}/status" \
    -H 'content-type: application/json' \
    -d '{"status":"active"}'
  echo
}

for spec in "$@"; do
  verify_and_maybe_write "$spec"
  echo
done

exit "$overall_fail"
