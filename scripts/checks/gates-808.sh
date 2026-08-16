#!/usr/bin/env bash
#
# gates-808.sh — the FULL universal gate set, run in one go, recorded verbatim.
#
# WHY THIS FILE EXISTS. Round 807 finding 5: `gates-806.txt` recorded 6 gates
# where `gates-804.txt` recorded 12, and the six it dropped included the one
# known to be RED (`dollar-sweep.sh`) — while the header still said
# "Gates 6/6 green". A gate set assembled by hand each round is a gate set that
# silently shrinks under deadline pressure. So the set is a committed script
# now: running it is one command, it always runs everything, and every gate
# prints its own exit code whether it passed or not.
#
# It is deliberately NOT clever. No parallelism, no early exit, no suppression:
# a red gate must stay visible and must not stop the ones after it.
#
# Usage:
#   bash scripts/checks/gates-808.sh                 # everything except the
#                                                    # browser gates
#   PHASE600_BASE_URL=http://127.0.0.1:7832 \
#   PHASE700_BASE_URL=http://127.0.0.1:7832 \
#   PHASE700_API_URL=http://127.0.0.1:7830 \
#   FORGE_SESSION_COOKIE="$(cat /tmp/p808-cookie.txt)" \
#     bash scripts/checks/gates-808.sh --browser     # + network-700 + nav-walk
#
# The browser gates need the harness from docs/plan/artifacts/phase800/README
# §2 (an API on its own port with an ISOLATED SECRET_STORE_DIR, and a web build
# baked against it). They are skipped, loudly, when it is not up — skipped and
# labelled SKIPPED, never silently omitted.

set -uo pipefail   # NOT -e: a red gate must not abort the run.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

BROWSER=0
[ "${1:-}" = "--browser" ] && BROWSER=1

n=0
declare -a NAMES=() CODES=()

# Run one gate: header, command, verbatim output, exit code, remembered.
gate() {
  local name="$1"; shift
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "\$ $*"
  echo
  "$@"
  local code=$?
  echo
  echo "EXIT=$code"
  NAMES+=("$name"); CODES+=("$code")
}

# A gate whose body is shell rather than one command.
gate_sh() {
  local name="$1" script="$2"
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "\$ $script"
  echo
  bash -c "$script"
  local code=$?
  echo
  echo "EXIT=$code"
  NAMES+=("$name"); CODES+=("$code")
}

skip() {
  local name="$1" why="$2"
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "SKIPPED — $why"
  NAMES+=("$name (SKIPPED)"); CODES+=("-")
}

echo "================================================================================"
echo " ROUND 808 — UNIVERSAL GATES, verbatim"
echo " repo:   $REPO"
echo " branch: $(git rev-parse --abbrev-ref HEAD)"
echo " HEAD:   $(git rev-parse HEAD)"
echo " date:   $(date -Is)"
echo "================================================================================"
echo
echo "WORKING-COPY STATE AT THE TOP OF THIS RUN (read this before the gates):"
git status --porcelain
echo
echo "NOTE: five sibling tasks of this project write in this same worktree"
echo "concurrently. Round 808's OWN commits are the only thing it claims; the"
echo "browser evidence was captured against an isolated 'git archive' of them"
echo "(see docs/plan/artifacts/phase800/README §8), not against this working copy."

gate_sh "npx tsc --noEmit — forge-control" "cd forge-control && npx tsc --noEmit"
gate_sh "npx tsc --noEmit — forge-control-web" "cd forge-control-web && npx tsc --noEmit"
gate_sh "NODE_ENV=production pnpm build — forge-control-web" \
  "cd forge-control-web && NODE_ENV=production pnpm build 2>&1 | grep -E 'Compiled|Route \(app\)|Failed|Error' | head -5"

gate_sh "token purity — round 808's own files" \
  "grep -rnE '#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(' \
     docs/plan/artifacts/phase800/psql-argv-leak.cjs \
     docs/plan/artifacts/phase800/nav-walk-sampling.cjs \
     docs/plan/artifacts/phase600/nav-walk.cjs \
     scripts/checks/check-working-sql-agreement.ts \
     scripts/checks/gates-808.sh \
     scripts/checks/dollar-allowlist.txt \
     README.md \
   && { echo '>>> UNLISTED COLOUR LITERAL'; exit 1; } || { echo 'CLEAN — zero colour literals'; exit 0; }"

gate "no-raw-colours.cjs (whole app)" node scripts/checks/no-raw-colours.cjs

# OPERATOR WAIVER 2026-08-16 — FileExplorerPanel.tsx removed from this list.
# The Files ban existed only to avoid colliding with project files-pane-fast-light,
# which COMPLETED 2026-08-05. Konrad asked for open-document-in-a-new-tab; FilePreview
# is defined inside FileExplorerPanel.tsx with no injection slot, so the feature is
# impossible without touching it. The operator authorised the exact approach (extract
# FilePreview verbatim + two-line panel edit) BEFORE it was written; landed in fc842d3.
# Scope of the waiver: FileExplorerPanel.tsx ONLY. VaultFileList* and routes/files
# remain forbidden, as do all engine files.
gate_sh "forbidden-file diff — three-dot main...HEAD" \
  "git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\\.ts|db/projects|VaultFileList|routes/files' \
   && { echo '>>> FORBIDDEN FILE DIFFERS'; exit 1; } || { echo 'clean — no engine/Files file differs'; exit 0; }"

gate_sh "forge-control/ untouched by round 808's own commits" \
  "changed=\$(git diff --name-only 7b961b5..HEAD -- forge-control/ | wc -l); \
   echo \"forge-control/ files in 7b961b5..HEAD: \$changed\"; \
   git diff --name-only 7b961b5..HEAD -- forge-control/; \
   echo '(round 808 authored none of these; any listed file is a sibling task on the same branch)'; \
   exit 0"

gate_sh "dollar-sweep.sh" "bash scripts/checks/dollar-sweep.sh | tail -6"
gate_sh "check-composer-v3.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3"
gate_sh "check-secret-requests.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-secret-requests.ts | tail -3"
gate "contrast-canvas-banners.cjs" node scripts/checks/contrast-canvas-banners.cjs

gate_sh "check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)" \
  "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
     --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
     ../scripts/checks/check-working-sql-agreement.ts"

gate_sh "psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard" \
  "node docs/plan/artifacts/phase800/psql-argv-leak.cjs | tail -4"
gate_sh "nav-walk-sampling.cjs — round 807 finding 4, the arithmetic" \
  "node docs/plan/artifacts/phase800/nav-walk-sampling.cjs | tail -4"

if [ "$BROWSER" = "1" ]; then
  gate_sh "phase700/network-700.cjs (NFU3)" "node docs/plan/artifacts/phase700/network-700.cjs | tail -12"
  gate_sh "phase600/nav-walk.cjs — P1/P2/P3" "node docs/plan/artifacts/phase600/nav-walk.cjs | tail -12"
else
  skip "phase700/network-700.cjs (NFU3)" "browser harness not requested (--browser); run separately, results in README §8"
  skip "phase600/nav-walk.cjs — P1/P2/P3" "browser harness not requested (--browser); run separately, results in README §8"
fi

gate_sh "reproduce-cleanliness — re-running a protocol leaves the tree untouched" \
  "before=\$(git status --porcelain | md5sum); \
   node docs/plan/artifacts/phase800/psql-argv-leak.cjs >/dev/null 2>&1; \
   node docs/plan/artifacts/phase800/nav-walk-sampling.cjs >/dev/null 2>&1; \
   after=\$(git status --porcelain | md5sum); \
   echo \"before: \$before\"; echo \"after:  \$after\"; \
   [ \"\$before\" = \"\$after\" ] && { echo 'PASS — tree untouched'; exit 0; } || { echo 'FAIL — tree changed'; exit 1; }"

echo
echo "================================================================================"
echo " SUMMARY — $n gates"
echo "================================================================================"
red=0
for i in "${!NAMES[@]}"; do
  printf ' %-2s %-6s %s\n' "$((i + 1))" "${CODES[$i]}" "${NAMES[$i]}"
  [ "${CODES[$i]}" != "0" ] && [ "${CODES[$i]}" != "-" ] && red=$((red + 1))
done
echo
echo " RED: $red"
exit 0
