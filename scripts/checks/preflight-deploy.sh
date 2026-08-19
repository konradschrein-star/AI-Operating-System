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
# C1 — every lane's final verdict is PASS (reads runs.thread in content_forge),
#      judged on the highest-round reviewer that has ACTUALLY RUN — see the
#      selection note above check_c1
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

# The run this script is executing inside, if any. Every forge run exports it.
# C1 refuses to read a verdict out of its OWN caller's run — see check_c1.
SELF_RUN_ID="${FORGE_RUN_UUID:-}"

# Run statuses that mean "this reviewer has not finished speaking yet". Anything
# outside this set is terminal: a reviewer that ended without a VERDICT line is
# a real fault and must FAIL C1, never be skipped.
C1_IN_FLIGHT_RE='^(queued|running|pending|starting|resuming)$'

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

# The lifecycle status of the run a reviewer row points at. Used ONLY to tell a
# reviewer that has not spoken yet from one that ended without speaking.
c1_run_status() {
  local run_id="$1"
  if [[ ! "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "BAD_RUN_ID"
    return 0
  fi
  local out
  if ! out="$(PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -Atc \
      "select status from runs where id='${run_id}'" 2>"$TMPDIR/c1-psql-err.log")"; then
    echo "DB_ERROR: $(cat "$TMPDIR/c1-psql-err.log")"
    return 0
  fi
  if [ -z "$out" ]; then
    echo "NO_SUCH_RUN"
  else
    echo "$out"
  fi
}

# ── C1's selection, rewritten at round 15 (fix cycle 1) ──────────────────────
#
# The original took `sort_by(.round) | last` over each workstream's live
# reviewer rows. For the `main` workstream that is ALWAYS a reviewer scheduled
# strictly AFTER whoever is running this script — phase 7 is
# builder(13) → pre-deploy gate(14) → fix cycle(15) → re-review(16) → deploy →
# post-deploy GATE(18) — so C1 asserted the future and could not be satisfied at
# any of the three points the script is meant to run:
#
#   at the pre-deploy gate  — the later gate is `pending`, run_id null  → FAIL
#   at the deploy task      — same row, still pending                   → FAIL
#   at the post-deploy gate — it has a run_id but, being the caller, has
#                             emitted no `VERDICT:` assistant message, so the
#                             verdict query returns no rows              → FAIL
#
# The rule now: walk each workstream's reviewer rows from the highest round
# down, SKIP the ones that cannot possibly hold a verdict yet, and judge the
# first round-band that can. Every skip is printed with its reason, and the
# number of skipped rows rides along on a green C1, so a PASS is never read as
# "every reviewer row was checked".
#
# Three skip reasons, and nothing else is ever skipped:
#   1. run_id is null           — the row has never run
#   2. run_id == FORGE_RUN_UUID — it is THIS script's own caller; a gate that
#                                 reads its own verdict judges itself
#   3. no verdict yet AND the run is still in flight (see C1_IN_FLIGHT_RE)
#
# What this deliberately does NOT do:
#   • a reviewer whose run has ENDED without a `VERDICT:` line is judged, and
#     fails as `unparseable` — a crashed reviewer must still block a deploy
#   • a workstream where every row was skipped fails as `no-completed-reviewer`
#   • the whole round-band is judged, not one arbitrary row of it: `main` really
#     does carry two round-6 reviewers, and `sort_by | last` picked between them
#     on nothing better than array order
#
# The teeth are intact: an unrun re-review seeded after a NEEDS_FIXES is skipped
# by rule 1, which leaves that NEEDS_FIXES row as the newest RUN one, so it
# still blocks. Forced-failure fixture for all of it:
# scripts/checks/fixtures/preflight-c1-fixture.sh
check_c1() {
  echo "### C1 — every lane's final verdict is PASS ###"
  local project_json="$TMPDIR/project.json"
  if ! curl -sf -m 15 "$API_BASE/api/projects/$PROJECT_ID" -o "$project_json"; then
    fail_check "C1 — could not fetch $API_BASE/api/projects/$PROJECT_ID (project tasks)"
    return
  fi
  if [ -n "$SELF_RUN_ID" ]; then
    echo "  (caller run $SELF_RUN_ID — reviewer rows pointing at it are skipped, never judged)"
  else
    echo "  (FORGE_RUN_UUID is unset — no caller run to exclude)"
  fi

  local bad_lanes=()
  local skipped_total=0
  local ws rows row task_id round title status run_id verdict run_status
  local judged_round judged_any
  for ws in "${ALL_WORKSTREAMS[@]}"; do
    rows="$(jq -c --arg ws "$ws" '
      [.tasks[] | select(.workstream == $ws and .role == "reviewer")
       | select(((.title | startswith("[MERGED")) or (.title | startswith("[FOLDED")) or (.title | startswith("[RETIRED"))) | not)
       | {id, round, title, status, run_id}]
      | sort_by(.round) | reverse | .[]
    ' "$project_json")"

    if [ -z "$rows" ]; then
      echo "  $ws: no reviewer task (every reviewer row is [MERGED]/[FOLDED]/[RETIRED], or none exists)"
      bad_lanes+=("$ws=no-reviewer")
      continue
    fi

    judged_round=""
    judged_any=0
    while IFS= read -r row; do
      [ -z "$row" ] && continue
      task_id="$(jq -r '.id' <<<"$row")"
      round="$(jq -r '.round' <<<"$row")"
      title="$(jq -r '.title' <<<"$row")"
      status="$(jq -r '.status' <<<"$row")"
      run_id="$(jq -r '.run_id' <<<"$row")"

      # Judge one whole round-band, then stop descending.
      if [ "$judged_any" -eq 1 ] && [ "$round" != "$judged_round" ]; then
        break
      fi

      if [ "$run_id" = "null" ] || [ -z "$run_id" ]; then
        echo "  $ws: SKIP round $round (task $task_id, status=$status) — never run, no run_id ('$title')"
        skipped_total=$((skipped_total + 1))
        continue
      fi

      if [ -n "$SELF_RUN_ID" ] && [ "$run_id" = "$SELF_RUN_ID" ]; then
        echo "  $ws: SKIP round $round (task $task_id, run $run_id) — this is the caller's own run, C1 does not judge itself ('$title')"
        skipped_total=$((skipped_total + 1))
        continue
      fi

      verdict="$(c1_fetch_verdict "$task_id")"
      if [ -z "$verdict" ]; then
        run_status="$(c1_run_status "$run_id")"
        if [[ "$run_status" =~ $C1_IN_FLIGHT_RE ]]; then
          echo "  $ws: SKIP round $round (task $task_id, run $run_id) — reviewer still in flight (run status=$run_status), no VERDICT yet ('$title')"
          skipped_total=$((skipped_total + 1))
          continue
        fi
        echo "  $ws: no VERDICT in a run that is no longer in flight (round $round, task $task_id, run status=$run_status) — a reviewer that ended without a verdict blocks the deploy ('$title')"
        bad_lanes+=("$ws=unparseable")
        judged_round="$round"
        judged_any=1
        continue
      fi

      judged_round="$round"
      judged_any=1
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
    done <<<"$rows"

    if [ "$judged_any" -eq 0 ]; then
      echo "  $ws: every reviewer row was skipped — no reviewer has ever produced a verdict for this workstream"
      bad_lanes+=("$ws=no-completed-reviewer")
    fi
  done

  if [ ${#bad_lanes[@]} -eq 0 ]; then
    pass_check "C1 — every lane's final verdict is PASS (${ALL_WORKSTREAMS[*]}); $skipped_total reviewer row(s) skipped as not-yet-run/in-flight/self, listed above — this is NOT 'every row checked'"
  else
    fail_check "C1 — every lane's final verdict is PASS: ${bad_lanes[*]} ($skipped_total row(s) skipped)"
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

  /* ── SHAPE 2, added round 13: Promise<SomeInterface> ──────────────────────
   *
   * Phase 1's B1c replaced `Promise<Record<NoteCategory | "all", number>>` with
   * a named interface carrying one labelled field per figure — that IS
   * requirement R15 ("every top-level integer key must state its unit and its
   * source"), and it is what removed the bare `all` key behind Konrad's "it's
   * zero and not eight". So the union shape below is not wrong, it is simply no
   * longer the only shape this route can legitimately have.
   *
   * Tried FIRST, because a `Record<…>` return also matches `Promise<X>` if you
   * are careless with the pattern. The interface may live in another module —
   * `MemoryCounts` is declared in lib/index-health.ts and imported into
   * db/memory.ts — so the import is followed the same way `fnName`'s was.
   * Anything ambiguous BAILS; a field set this cannot resolve must never
   * degrade into an empty set, because an empty `emitted` makes every access a
   * violation and an empty `accessed` makes the check vacuously green. */
  const ifaceRe = new RegExp(
    `function\\s+${fnName}\\s*\\([^)]*?\\)\\s*:\\s*Promise<\\s*([A-Za-z_]\\w*)\\s*>`,
    "s",
  );
  const ifaceMatch = modSrc.match(ifaceRe);
  if (ifaceMatch) {
    const ifaceName = ifaceMatch[1];
    let ifaceSrc = modSrc;
    if (!new RegExp(`(?:export\\s+)?interface\\s+${ifaceName}\\s*{`).test(modSrc)) {
      let ifaceSpec = null;
      const impRe = /import\s*{([^}]*)}\s*from\s*["']([^"']+)["']/gs;
      let im;
      while ((im = impRe.exec(modSrc))) {
        const names = im[1]
          .split(",")
          .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
          .filter(Boolean);
        if (names.includes(ifaceName)) {
          ifaceSpec = im[2];
          break;
        }
      }
      if (!ifaceSpec) bail(`${fnName} returns Promise<${ifaceName}>, but ${ifaceName} is neither declared in ${modFile} nor imported into it`);
      const ifaceFile = path.resolve(path.dirname(modFile), ifaceSpec);
      if (!fs.existsSync(ifaceFile)) bail(`resolved module ${ifaceFile} for ${ifaceName} does not exist`);
      ifaceSrc = fs.readFileSync(ifaceFile, "utf8");
    }
    const bodyRe = new RegExp(`(?:export\\s+)?interface\\s+${ifaceName}\\s*{([\\s\\S]*?)\\n}`);
    const bodyMatch = ifaceSrc.match(bodyRe);
    if (!bodyMatch) bail(`could not read the body of interface ${ifaceName}`);
    /* TOP-LEVEL members only — exactly two spaces of indent. `excluded: {
     * excalidraw: number; … }` nests its own keys at four, and those are NOT
     * fields of `counts`; admitting them would excuse `counts.excalidraw`. */
    const ifaceFields = new Set(
      [...bodyMatch[1].matchAll(/^ {2}([A-Za-z_]\w*)\??\s*:/gm)].map((x) => x[1]),
    );
    if (ifaceFields.size === 0) bail(`interface ${ifaceName} yielded no top-level fields — the parse is wrong, refusing to report an empty emitted set`);
    return ifaceFields;
  }

  const fnRe = new RegExp(
    `function\\s+${fnName}\\s*\\([^)]*\\)\\s*:\\s*Promise<Record<([^,]+),\\s*number>>`,
    "s",
  );
  const fnMatch = modSrc.match(fnRe);
  if (!fnMatch) bail(`could not find a typed "Promise<Record<X, number>>" or "Promise<SomeInterface>" return for ${fnName} in ${modFile}`);
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

/**
 * Strip comments before looking for accesses. Round 13, and this one is not
 * cosmetic: phase 2 documented the fixed defect IN THE SURFACE, so
 * MemorySurface.tsx now contains the sentences
 *
 *     Until 2026-08-19 this rendered `${counts.all ?? 0} notes`.
 *     They read `counts[c.key] ?? 0` against an envelope whose keys were …
 *
 * inside a JSX comment and a doc block. Read as code they make C5 report a
 * violation on `all` — the very key R15 removed — and then BAIL trying to
 * resolve `counts[c.key]` against an array literal that no longer exists. A
 * check that fails because someone explained the bug it was watching for is a
 * check nobody will keep.
 *
 * Only `/* … *\/` blocks and whole-line `//` comments are removed. A trailing
 * `//` is deliberately NOT stripped, because that cannot be done safely without
 * a real lexer and the failure would be silent — it could eat a `//` inside a
 * string literal and with it a genuine access.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function extractAccessedFields(surfaceSrcRaw) {
  const surfaceSrc = stripComments(surfaceSrcRaw);
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

# Run the gate when EXECUTED; only define the functions when SOURCED. The
# fixture harness sources this file so it can drive check_c1 in isolation
# against THE REAL SCRIPT rather than a patched copy — a shadow copy of a gate
# is a gate nobody has tested. The condition is deliberately BASH_SOURCE vs $0
# and not an environment variable: no env var can make an executed
# preflight-deploy.sh exit 0 without running its checks.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
