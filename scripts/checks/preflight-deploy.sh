#!/usr/bin/env bash
#
# preflight-deploy.sh — the ONE executable gate deciding whether phase 7 of
# os-usable-for-work may deploy. Read-only: writes, merges, restarts and
# installs are never performed by this script.
#
# Operator's phase-7 precondition, verbatim: "put the 'is every lane's final
# verdict PASS?' check in as an executable gate, not as prose a human is
# trusted to read." A NEEDS_FIXES sat `running` for 21 hours because a human
# was trusted to read a verdict — this script exists so nobody has to.
#
# Usage: bash scripts/checks/preflight-deploy.sh   (no arguments)
# Exit 0 only if C1-C5 all PASS. Both the deploy task and the phase-7 gating
# reviewer run this; a non-zero exit means the deploy does not happen.
#
# C1 — every lane's final verdict is PASS (reads runs.thread in content_forge)
# C2 — the live checkout (/opt/forge-ai-os) is clean
# C3 — no lane branch has unmerged work into project/7851068b
# C4 — the merge (main <- project/7851068b) is conflict-free (probe only)
# C5 — MemorySurface.tsx cannot render "0 notes" from a field routes/memory.ts
#      does not emit (real field-name comparison, with an inline self-test)

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PROJECT_ID="7851068b-32d7-469b-b42f-f5e3c1d9e83a"
LIVE_CHECKOUT="/opt/forge-ai-os"
BASE_BRANCH="project/7851068b"
LANE_WORKSTREAMS=(vault surfaces connections business perf)
ALL_WORKSTREAMS=(vault surfaces connections business perf main)
API_BASE="${FORGE_CONTROL_API:-http://127.0.0.1:7700}"

PG_HOST="${PGHOST:-127.0.0.1}"
PG_PORT="${PGPORT:-5432}"
PG_USER="${PGUSER:-postgres}"
PG_DB="${PGDATABASE:-content_forge}"
PG_PASSWORD="${PGPASSWORD:-90d4iBxMYP6m3DYrsP1fjSSU7uWDVE}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass_check() { echo "PASS — $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail_check() { echo "FAIL — $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

hr() { printf -- '----------------------------------------\n'; }

# ---------------------------------------------------------------------------
# C1 — every lane's final verdict is PASS
# ---------------------------------------------------------------------------
c1_fetch_verdict() {
  local task_id="$1"
  if [[ ! "$task_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "BAD_TASK_ID"
    return 0
  fi
  local sql
  sql="select substring(e->>'content' from 'VERDICT: [A-Z_]+')
    from runs r, jsonb_array_elements(r.thread) with ordinality a(e,o)
    where (r.metadata->>'task_id')='${task_id}' and e->>'role'='assistant'
      and e->>'content' ~ 'VERDICT: ' order by o desc limit 1"
  local out
  if ! out="$(PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -Atc "$sql" 2>"$TMPDIR/c1-psql-err.log")"; then
    echo "DB_ERROR: $(cat "$TMPDIR/c1-psql-err.log")"
    return 0
  fi
  echo "$out"
}

check_c1() {
  echo "### C1 — every lane's final verdict is PASS ###"
  local project_json="$TMPDIR/project.json"
  if ! curl -sf -m 15 "$API_BASE/api/projects/$PROJECT_ID" -o "$project_json"; then
    fail_check "C1 — could not fetch $API_BASE/api/projects/$PROJECT_ID (project tasks)"
    return
  fi

  local bad_lanes=()
  local ws task task_id round title status run_id verdict
  for ws in "${ALL_WORKSTREAMS[@]}"; do
    task="$(jq --arg ws "$ws" '
      [.tasks[] | select(.workstream == $ws and .role == "reviewer")
       | select(((.title | startswith("[MERGED")) or (.title | startswith("[FOLDED")) or (.title | startswith("[RETIRED"))) | not)]
      | sort_by(.round) | last
    ' "$project_json")"

    if [ "$task" = "null" ]; then
      echo "  $ws: no reviewer task (every reviewer row is [MERGED]/[FOLDED]/[RETIRED], or none exists)"
      bad_lanes+=("$ws=no-reviewer")
      continue
    fi

    task_id="$(jq -r '.id' <<<"$task")"
    round="$(jq -r '.round' <<<"$task")"
    title="$(jq -r '.title' <<<"$task")"
    status="$(jq -r '.status' <<<"$task")"
    run_id="$(jq -r '.run_id' <<<"$task")"

    if [ "$run_id" = "null" ] || [ -z "$run_id" ]; then
      echo "  $ws: highest reviewer is round $round (task $task_id, status=$status) — no run_id yet, so no verdict exists ('$title')"
      bad_lanes+=("$ws=not-yet-run")
      continue
    fi

    verdict="$(c1_fetch_verdict "$task_id")"
    case "$verdict" in
      "VERDICT: PASS")
        echo "  $ws: PASS (round $round, task $task_id)"
        ;;
      "VERDICT: NEEDS_FIXES")
        echo "  $ws: NEEDS_FIXES (round $round, task $task_id, '$title')"
        bad_lanes+=("$ws=NEEDS_FIXES")
        ;;
      DB_ERROR:*)
        echo "  $ws: could not read the runs DB for task $task_id — $verdict"
        bad_lanes+=("$ws=db-error")
        ;;
      *)
        echo "  $ws: no parseable VERDICT in run for task $task_id (round $round) — got '$verdict'"
        bad_lanes+=("$ws=unparseable")
        ;;
    esac
  done

  if [ ${#bad_lanes[@]} -eq 0 ]; then
    pass_check "C1 — every lane's final verdict is PASS (${ALL_WORKSTREAMS[*]})"
  else
    fail_check "C1 — every lane's final verdict is PASS: ${bad_lanes[*]}"
  fi
}

# ---------------------------------------------------------------------------
# C2 — the live checkout is clean
# ---------------------------------------------------------------------------
check_c2() {
  echo "### C2 — live checkout ($LIVE_CHECKOUT) is clean ###"
  if [ ! -d "$LIVE_CHECKOUT/.git" ]; then
    fail_check "C2 — $LIVE_CHECKOUT is not a git checkout (no .git)"
    return
  fi
  local dirty
  dirty="$(git -C "$LIVE_CHECKOUT" status --porcelain)"
  if [ -z "$dirty" ]; then
    local head
    head="$(git -C "$LIVE_CHECKOUT" rev-parse --short HEAD)"
    pass_check "C2 — $LIVE_CHECKOUT is clean at $(git -C "$LIVE_CHECKOUT" rev-parse --abbrev-ref HEAD)=$head"
  else
    echo "$dirty" | sed 's/^/  /'
    echo "  (archive of prior dirt, if any, lives at /opt/ai-os/backups/live-dirty/ — never discard; escalate)"
    fail_check "C2 — $LIVE_CHECKOUT has uncommitted changes, see paths above"
  fi
}

# ---------------------------------------------------------------------------
# C3 — no lane branch has unmerged work
# ---------------------------------------------------------------------------
check_c3() {
  echo "### C3 — no lane branch has unmerged work into $BASE_BRANCH ###"
  local lane branch count
  local unmerged=()
  for lane in "${LANE_WORKSTREAMS[@]}"; do
    branch="${BASE_BRANCH}-${lane}"
    if ! git rev-parse --verify "$branch" >/dev/null 2>&1; then
      echo "  $lane: FAIL — branch $branch does not exist"
      unmerged+=("$lane=missing-branch")
      continue
    fi
    count="$(git rev-list --count "${BASE_BRANCH}..${branch}")"
    echo "  $lane ($branch): $count commit(s) not yet in $BASE_BRANCH"
    if [ "$count" -ne 0 ]; then
      unmerged+=("$lane=$count")
    fi
  done

  if [ ${#unmerged[@]} -eq 0 ]; then
    pass_check "C3 — no lane branch has unmerged work"
  else
    fail_check "C3 — lanes with unmerged commits: ${unmerged[*]}"
  fi
}

# ---------------------------------------------------------------------------
# C4 — the merge is conflict-free before it is attempted
# ---------------------------------------------------------------------------
check_c4() {
  echo "### C4 — merge-tree probe: main <- $BASE_BRANCH ###"
  if ! git rev-parse --verify main >/dev/null 2>&1; then
    fail_check "C4 — local ref 'main' does not exist in this checkout"
    return
  fi
  local out rc
  set +e
  out="$(git merge-tree --write-tree --name-only main "$BASE_BRANCH" 2>&1)"
  rc=$?
  set -e
  echo "$out" | sed 's/^/  /'
  if [ "$rc" -eq 0 ]; then
    pass_check "C4 — merge-tree probe is conflict-free (tree $(echo "$out" | head -1))"
  else
    fail_check "C4 — merge-tree probe reports conflicts (exit $rc), paths above"
  fi
}

# ---------------------------------------------------------------------------
# C5 — the memory surface will not render "0 notes"
# ---------------------------------------------------------------------------
check_c5() {
  echo "### C5 — MemorySurface reads no field routes/memory.ts does not emit ###"
  local routes_file="$REPO/forge-control/src/routes/memory.ts"
  local surface_file="$REPO/forge-control-web/app/desktop/MemorySurface.tsx"
  if [ ! -f "$routes_file" ] || [ ! -f "$surface_file" ]; then
    fail_check "C5 — expected source file missing ($routes_file or $surface_file)"
    return
  fi

  local checker="$TMPDIR/c5-check.cjs"
  cat >"$checker" <<'NODE_EOF'
const fs = require("fs");
const path = require("path");

const routesFile = process.argv[2];
const surfaceFile = process.argv[3];

function bail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

function extractEmittedFields(routesSrc, routesDir) {
  const routeMatch = routesSrc.match(/["']\/counts["'][^;]*?await\s+(\w+)\(/s);
  if (!routeMatch) bail("could not find the /counts route handler");
  const fnName = routeMatch[1];

  const importRe = /import\s*{([^}]*)}\s*from\s*["']([^"']+)["']/gs;
  let modSpec = null;
  let m;
  while ((m = importRe.exec(routesSrc))) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
      .filter(Boolean);
    if (names.includes(fnName)) {
      modSpec = m[2];
      break;
    }
  }
  if (!modSpec) bail(`could not find an import bringing ${fnName} into scope`);
  let modFile = path.resolve(routesDir, modSpec);
  if (!fs.existsSync(modFile)) bail(`resolved module ${modFile} does not exist`);
  const modSrc = fs.readFileSync(modFile, "utf8");

  const fnRe = new RegExp(
    `function\\s+${fnName}\\s*\\([^)]*\\)\\s*:\\s*Promise<Record<([^,]+),\\s*number>>`,
    "s",
  );
  const fnMatch = modSrc.match(fnRe);
  if (!fnMatch) bail(`could not find a typed "Promise<Record<X, number>>" return for ${fnName} in ${modFile}`);
  const unionExpr = fnMatch[1].trim();

  const fields = new Set();
  for (const member of unionExpr.split("|").map((s) => s.trim())) {
    const lit = member.match(/^["'](.+)["']$/);
    if (lit) {
      fields.add(lit[1]);
      continue;
    }
    const typeRe = new RegExp(`type\\s+${member}\\s*=([^;]+);`, "s");
    const typeMatch = modSrc.match(typeRe);
    if (!typeMatch) bail(`could not resolve type alias ${member} referenced by ${fnName}'s return type`);
    const lits = [...typeMatch[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    if (lits.length === 0) bail(`type alias ${member} has no string-literal members`);
    lits.forEach((l) => fields.add(l));
  }
  return fields;
}

function extractAccessedFields(surfaceSrc) {
  const fields = new Set();
  for (const m of surfaceSrc.matchAll(/\bcounts\.(\w+)/g)) fields.add(m[1]);

  const bracketExprs = [...surfaceSrc.matchAll(/\bcounts\[([^\]]+)\]/g)].map((m) => m[1].trim());
  for (const expr of bracketExprs) {
    const pm = expr.match(/^(\w+)\.(\w+)$/);
    if (!pm) bail(`counts[${expr}] is not a simple <param>.<prop> access — extend the checker before trusting this file`);
    const [, param, prop] = pm;
    const mapRe = new RegExp(`(\\w+)\\.map\\(\\s*\\(${param}\\)\\s*=>`);
    const mm = mapRe.exec(surfaceSrc);
    if (!mm) bail(`could not find "<ARRAY>.map((${param}) => ...)" to resolve counts[${expr}]`);
    const arrName = mm[1];
    const arrRe = new RegExp(`const\\s+${arrName}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\n\\];`);
    const arrMatch = surfaceSrc.match(arrRe);
    if (!arrMatch) bail(`could not find the array literal for ${arrName} to resolve counts[${expr}]`);
    const propRe = new RegExp(`${prop}\\s*:\\s*["']([^"']+)["']`, "g");
    const vals = [...arrMatch[1].matchAll(propRe)].map((x) => x[1]);
    if (vals.length === 0) bail(`array ${arrName} has no "${prop}: ..." entries to resolve counts[${expr}]`);
    vals.forEach((v) => fields.add(v));
  }
  return fields;
}

const routesSrc = fs.readFileSync(routesFile, "utf8");
const surfaceSrc = fs.readFileSync(surfaceFile, "utf8");

const emitted = extractEmittedFields(routesSrc, path.dirname(routesFile));
const accessed = extractAccessedFields(surfaceSrc);
const violations = [...accessed].filter((f) => !emitted.has(f));

// Inline self-test: a bogus dot-access field must be caught by the SAME
// comparator that just ran the real check. If this ever fails, the
// comparator is inert and C5's PASS above cannot be trusted.
const selfTestSrc = surfaceSrc + '\nconst __c5_selftest__ = counts.__bogusField99__;\n';
const selfTestAccessed = extractAccessedFields(selfTestSrc);
const selfTestViolations = [...selfTestAccessed].filter((f) => !emitted.has(f));
const selfTestOk = selfTestViolations.includes("__bogusField99__");

process.stdout.write(
  JSON.stringify({
    emitted: [...emitted].sort(),
    accessed: [...accessed].sort(),
    violations,
    selfTestOk,
    selfTestViolations,
  }),
);
NODE_EOF

  local result_json rc
  set +e
  result_json="$(node "$checker" "$routes_file" "$surface_file" 2>"$TMPDIR/c5-node-err.log")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    fail_check "C5 — could not analyze field names: $(cat "$TMPDIR/c5-node-err.log")"
    return
  fi

  local emitted accessed violations self_test_ok
  emitted="$(jq -r '.emitted | join(", ")' <<<"$result_json")"
  accessed="$(jq -r '.accessed | join(", ")' <<<"$result_json")"
  violations="$(jq -r '.violations | join(", ")' <<<"$result_json")"
  self_test_ok="$(jq -r '.selfTestOk' <<<"$result_json")"

  echo "  emitted (routes/memory.ts -> noteCounts): $emitted"
  echo "  accessed (MemorySurface.tsx): $accessed"
  echo "  self-test (bogus field __bogusField99__ must be caught): selfTestOk=$self_test_ok"

  if [ "$self_test_ok" != "true" ]; then
    fail_check "C5 — the field-name comparator's own self-test did not catch a bogus field; the comparison is inert, do not trust its PASS"
    return
  fi

  if [ -n "$violations" ]; then
    fail_check "C5 — MemorySurface.tsx reads field(s) routes/memory.ts does not emit: $violations"
  else
    pass_check "C5 — MemorySurface.tsx reads no field routes/memory.ts does not emit, and the comparator's self-test passed"
  fi
}

# ---------------------------------------------------------------------------
main() {
  hr
  check_c1
  hr
  check_c2
  hr
  check_c3
  hr
  check_c4
  hr
  check_c5
  hr
  echo "SUMMARY: $((PASS_COUNT + FAIL_COUNT)) checks — $PASS_COUNT PASS, $FAIL_COUNT FAIL"
  hr
  if [ "$FAIL_COUNT" -eq 0 ]; then
    echo "PREFLIGHT: PASS — phase 7 may deploy"
    exit 0
  else
    echo "PREFLIGHT: FAIL — phase 7 may NOT deploy"
    exit 1
  fi
}

main "$@"
