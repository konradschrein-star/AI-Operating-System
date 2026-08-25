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
#                                                    # + chat-reference-navigation
#
#   bash scripts/checks/gates-808.sh --strict         # same run, but exit
#     nonzero if RED>0 — see the note above the final exit for why this is a
#     separate flag rather than the default. Composes with --browser in
#     either order: `--strict --browser` and `--browser --strict` both work.
#
# The browser gates need the harness from docs/plan/artifacts/phase800/README
# §2 (an API on its own port with an ISOLATED SECRET_STORE_DIR, and a web build
# baked against it). They are skipped, loudly, when it is not up — skipped and
# labelled SKIPPED, never silently omitted.

set -uo pipefail   # NOT -e: a red gate must not abort the run.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

BROWSER=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --browser) BROWSER=1 ;;
    --strict) STRICT=1 ;;
  esac
done

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
#
# `set -o pipefail` is not decoration — without it this helper LIED. Round
# 1353's review, finding 2: gate 8 runs `bash scripts/checks/dollar-sweep.sh |
# tail -6`, the sweep exited 1, and the pipeline reported `tail`'s status — so a
# RED gate printed EXIT=0 and the summary line said "RED: 0". Gates 9, 10, 15
# and 16 pipe the same way and were swallowing the same way. Every gate here
# exists to fail loudly; one that cannot fail is worse than one that is absent,
# because it is counted in the total.
gate_sh() {
  local name="$1" script="$2"
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "\$ $script"
  echo
  # Set inside `bash -c`, not on this shell: the gate body is the only thing
  # whose pipelines this may change.
  bash -c "set -o pipefail; $script"
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
#
# OPERATOR WAIVER 2026-08-23 — the REST of the Files reservation is released.
# The clause above states the ban's entire purpose: avoiding a collision with
# project files-pane-fast-light. Verified in the projects table today — that
# project is `done`, closed 2026-08-05, eighteen days ago. The 2026-08-16 waiver
# released only FileExplorerPanel.tsx because that was all that was needed then,
# not because the rest still had a reason.
#
# aios-library-and-map's brief then explicitly ordered a builder to EXTEND
# forge-control/src/routes/files.ts ("find it, read it, extend it rather than
# starting a second one"), and it did, in ad35016. The gate had therefore become
# unsatisfiable by any correct execution of an authorised brief: it could only be
# passed by disobeying the brief, or by a builder widening the gate — and a
# builder widening a gate is forbidden. That is a toll, not evidence.
#
# RELEASED: routes/files, VaultFileList*.
# STILL FORBIDDEN, for a live reason rather than an expired reservation:
# project-tick, cc-runner, executor.ts, db/projects — the scheduler and the run
# engine, where one careless edit breaks every lane at once. Those stay banned,
# and an authorised edit to them is recorded here the same way this one is.
gate_sh "forbidden-file diff — three-dot main...HEAD" \
  "git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\\.ts|db/projects' \
   && { echo '>>> FORBIDDEN FILE DIFFERS'; exit 1; } || { echo 'clean — no engine/Files file differs'; exit 0; }"

gate_sh "forge-control/ untouched by round 808's own commits" \
  "changed=\$(git diff --name-only 7b961b5..HEAD -- forge-control/ | wc -l); \
   echo \"forge-control/ files in 7b961b5..HEAD: \$changed\"; \
   git diff --name-only 7b961b5..HEAD -- forge-control/; \
   echo '(round 808 authored none of these; any listed file is a sibling task on the same branch)'; \
   exit 0"

gate_sh "check-migration-numbers.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-migration-numbers.ts | tail -3"
gate_sh "dollar-sweep.sh" "bash scripts/checks/dollar-sweep.sh | tail -6"
gate_sh "check-composer-v3.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3"
gate_sh "check-secret-requests.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-secret-requests.ts | tail -3"
gate "contrast-canvas-banners.cjs" node scripts/checks/contrast-canvas-banners.cjs

gate_sh "check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)" \
  "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
     --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
     ../scripts/checks/check-working-sql-agreement.ts"

# ── Round 1354's two new checks ────────────────────────────────────────────
# Both are here rather than in a runbook because round 1353's review found the
# two defects they cover by driving a browser and by reading live SQL — work no
# reviewer should have to repeat by hand to learn the same thing twice.

gate_sh "check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx | tail -3"

# ── Round 1355's checks ────────────────────────────────────────────────────
# A4: a control labelled "N hidden · show" whose onClick was `restoreAll`.
# Both halves of that defect — the missing peek in the markup, and the label
# bound to the wrong verb — are asserted; 25 of these assertions fail against
# round 1354's code (docs/plan/artifacts/phase1355/README.md §2).
gate_sh "check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-dismiss-peek.tsx | tail -3"

gate_sh "check-team-rows.ts — flatten, hiddenRows, frozen time" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts | tail -2"

gate_sh "check-code-path-link.ts — detectPath: what's an openable file pill" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-code-path-link.ts | tail -3"

gate_sh "check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-confirm.ts | tail -2"

# ── aios-autonomy-automation round 5 ───────────────────────────────────────
# Five "View Run in Chat" / "Settings → Connections" affordances shipped as
# `<a>` elements pointing at a query string this one-route console has never
# read. They typechecked, they built, and they navigated nowhere. The check
# asserts the replacement (localStorage + the shell's onNav) AND greps the two
# surfaces so the dead form cannot come back.
gate_sh "check-deep-link.ts — cross-surface navigation actually navigates" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-deep-link.ts | tail -3"

gate_sh "verify-notification-gap-pins.mjs — fenced quotes + prose pins" \
  "node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs | tail -2"

# Needs a Postgres SERVER. It creates its own scratch database and issues no
# statement against the one named in DATABASE_URL — but with no DSN at all there
# is nothing to connect to, so it is SKIPPED rather than reported as passing.
#
# DO NOT SET `USAGE_FOLD_DB` HERE, and this is the reason.
#
# `os-usable-for-work` round-4 review, finding F4: the check used to default its
# scratch database to the fixed name `r1354_sampler`. Five lanes run this suite
# concurrently, and two runs sharing one scratch database `TRUNCATE` the same
# three tables mid-assertion — a RED with nothing to say about the code, or
# worse, silently wrong arithmetic. Round 3's first attempt fixed it HERE, by
# exporting `USAGE_FOLD_DB=r1354_sampler_$$`. That protects this caller and
# nobody else: the check's own header tells operators to run it directly with no
# such variable, and an override cannot fix a default.
#
# So the check now names its own database per process (`r1354_sampler_p<pid>_
# <rand>`) and drops it on both exit paths whenever it chose the name itself.
# Passing a name from here would pin that guarantee to this one call site again
# AND stop this gate from ever exercising the default — the very thing that has
# to stay right. Left unset on purpose, so this gate is the default's canary.
if [ -n "${DATABASE_URL:-}" ]; then
  gate_sh "check-usage-fold.ts — hourly token fold, against a real Postgres" \
    "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-usage-fold.ts | tail -3"
else
  skip "check-usage-fold.ts — hourly token fold" \
    "DATABASE_URL is unset; this gate needs a Postgres server to build its scratch db on"
fi

gate_sh "check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)" \
  "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
     --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
     ../scripts/checks/check-usage-fold.ts"

gate_sh "pnpm test — forge-control unit suite" \
  "cd forge-control && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"

gate_sh "psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard" \
  "node docs/plan/artifacts/phase800/psql-argv-leak.cjs | tail -4"
gate_sh "nav-walk-sampling.cjs — round 807 finding 4, the arithmetic" \
  "node docs/plan/artifacts/phase800/nav-walk-sampling.cjs | tail -4"

if [ "$BROWSER" = "1" ]; then
  gate_sh "phase700/network-700.cjs (NFU3)" "node docs/plan/artifacts/phase700/network-700.cjs | tail -12"
  gate_sh "phase600/nav-walk.cjs — P1/P2/P3" "node docs/plan/artifacts/phase600/nav-walk.cjs | tail -12"
  # Chat reference navigation: clicks a path pill FROM THE TEAM TAB and asserts
  # the tab flip, the breadcrumbs, the selected row, the rendered content and a
  # tab count that stays at one. Every bug this feature has shipped was wiring
  # between components that each worked alone — invisible to tsc, to
  # check-code-path-link.ts and to a grep of the bundle. It needs its own stack
  # (a probe forge-control on a scratch database + a console built against it):
  # docs/plan/artifacts/chat-ref-nav/README.md.
  gate_sh "check-chat-reference-navigation.mjs — click a path pill, panel opens the file" \
    "node scripts/checks/check-chat-reference-navigation.mjs | tail -30"
else
  skip "phase700/network-700.cjs (NFU3)" "browser harness not requested (--browser); run separately, results in README §8"
  skip "phase600/nav-walk.cjs — P1/P2/P3" "browser harness not requested (--browser); run separately, results in README §8"
  skip "check-chat-reference-navigation.mjs — click a path pill, panel opens the file" \
    "browser harness not requested (--browser); run separately, recipe in docs/plan/artifacts/chat-ref-nav/README.md"
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

# THIS SCRIPT IS A RECORDER, NOT A GATEKEEPER. It exits 0 even when RED>0, on
# purpose: an exit code that went nonzero on the first red gate is exactly the
# failure mode this file was built to avoid (see the header — a red gate must
# stay visible and must not stop the ones after it, and by the same logic it
# must not cut short whatever invoked this script either). The RED count above
# and each gate's own EXIT= line are the truth; read them.
#
# Anything that GATES A DECISION — CI, a deploy step, a reviewer's pass/fail —
# must invoke this script with --strict, which runs every gate exactly as
# above and then exits nonzero if RED>0. Do not gate on the bare exit code of
# a non-strict run; it is always 0.
if [ "$STRICT" = "1" ]; then
  exit $([ "$red" -eq 0 ] && echo 0 || echo 1)
fi
exit 0
