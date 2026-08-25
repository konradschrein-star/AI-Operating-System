#!/usr/bin/env python3
"""Discrimination matrix + exit-code contract for guard-autonomy.py.

Ported from the lost /tmp/guard_test.py harness (24 cases, hit the LIVE API,
see docs/plan/aios-guardrail-hardening/00-findings.md P2-3) plus every
evasion/false-positive decision recorded in that findings doc's P2-1, P2-2 and
P3-1 sections. This is round 0: the hardening builder (round 1) makes the
cases below green. AT THIS HEAD MANY ARE EXPECTED RED — that is the point of
the task, not a bug in the test. Do not soften, skip, or xfail a case to make
it pass; a case that is red here and green after hardening is the evidence
that hardening did something.

WHY GUARD_AUTONOMY_HOOK EXISTS
-------------------------------
The hook under test must be the REPO copy (scripts/ops/guard-autonomy.py),
resolved relative to this file's own directory -- never the live
/opt/ai-os/scripts/guard-autonomy.py, which would test HEAD-live instead of
this worktree (memory: tsx-tsconfig-shadow-tree, guard-hook-tests-never-hit-
live-api). At THIS round's HEAD that repo file does not exist yet (round 1
adds it), so this harness also accepts GUARD_AUTONOMY_HOOK=<path> pointing at
a throwaway copy, e.g.:

    cp /opt/ai-os/scripts/guard-autonomy.py /tmp/guard-under-test.py
    GUARD_AUTONOMY_HOOK=/tmp/guard-under-test.py python3 scripts/ops/test-guard-autonomy.py

Never point it at the live path directly -- always a /tmp COPY.

WHY THIS NEVER TALKS TO :7700
-------------------------------
The live hook calls the LIVE POST /api/autonomy/check. Piping payloads
through the real path writes a real guardrail_trips row per blocked case --
22 of 42 rows in that table were test noise before this was learned
(memory: guard-hook-tests-never-hit-live-api). Layer A below imports the
hook's classify()/strip_heredocs() in-process (zero network). Layer B runs
the hook as a real subprocess but points FORGE_API at a local stub HTTP
server this file starts itself, never at :7700.

CONTRACT UNDER TEST: stdin is the PreToolUse JSON payload; exit 0 allows,
exit 2 blocks and prints to stderr for the model to read.
"""
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HOOK_PATH = os.environ.get("GUARD_AUTONOMY_HOOK") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "guard-autonomy.py"
)
DEFAULT_CWD = "/opt/forge-ai-os"

if not os.path.isfile(HOOK_PATH):
    print(
        f"guard-autonomy hook not found at {HOOK_PATH}\n"
        "This repo does not carry it yet at this round -- set GUARD_AUTONOMY_HOOK to "
        "a /tmp COPY of /opt/ai-os/scripts/guard-autonomy.py (never the live path).",
        file=sys.stderr,
    )
    sys.exit(1)

_spec = importlib.util.spec_from_file_location("guard_autonomy_under_test", HOOK_PATH)
g = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(g)

failures = []
total = 0


def record(ok: bool, label: str):
    global total
    total += 1
    if not ok:
        failures.append(label)
    print(f"  {'OK  ' if ok else 'RED '}  {label}")


# ============================================================================
# Layer A -- in-process classifier matrix. Zero network, zero guardrail_trips
# rows. Each case: (label, cmd, cwd, expected_rule_id_or_None, payload_check)
# ============================================================================

def branch_is(expected):
    def check(payload):
        return payload.get("branch") == expected
    return check


def classify_case(label, cmd, expect, cwd=DEFAULT_CWD, payload_check=None):
    try:
        hit = g.classify(g.strip_heredocs(cmd), cwd)
    except Exception as e:  # a classifier exception is itself a finding
        record(False, f"{label} -- classify raised {e!r}")
        return
    got_rule = hit[0] if hit else None
    ok = got_rule == expect
    if ok and payload_check is not None:
        ok = hit is not None and payload_check(hit[1])
    record(ok, f"{label}  (cmd={cmd[:60]!r} cwd={cwd} expect={expect} got={got_rule})")


# --- MUST_BLOCK ------------------------------------------------------------
# The original 24-case block set (re-derived; the exact strings are gone with
# /tmp/guard_test.py) plus every CATCH line from findings P2-1.

MUST_BLOCK = [
    # -- original 24-case core, reproduced --
    ("force-push main (no refspec)", "git push --force origin main", "git.force_push", None),
    ("force-push HEAD:main", "git push --force origin HEAD:main", "git.force_push", None),
    ("force-with-lease main", "git push --force-with-lease origin main", "git.force_push", None),
    ("rm -rf real target", "rm -rf /opt/content-forge", "fs.destructive", None),
    ("rm -rf mixed targets, one non-routine", "rm -rf /opt/x /tmp/y", "fs.destructive", None),
    ("pm2 delete", "pm2 delete forge-control", "fs.destructive", None),
    ("psql DROP TABLE", "psql -U postgres -c 'DROP TABLE runs'", "fs.destructive", None),
    ("redis-cli FLUSHALL", "redis-cli FLUSHALL", "fs.destructive", None),
    ("telegram curl", "curl -X POST https://api.telegram.org/bot1/sendMessage -d text=hi", "comm.outbound", None),
    ("slack webhook", "curl https://hooks.slack.com/services/T000/B000/xxx -d text=hi", "comm.outbound", None),
    ("gmail send", "python3 google_api.py gmail send --to a@b.c", "comm.outbound", None),

    # -- P2-1 CATCH: wrapper heads the classifier must recurse into --
    ('bash -c "rm -rf /opt/x"', 'bash -c "rm -rf /opt/x"', "fs.destructive", None),
    ("sh -lc 'rm -rf /opt/x'", "sh -lc 'rm -rf /opt/x'", "fs.destructive", None),
    ('eval "rm -rf /opt/x"', 'eval "rm -rf /opt/x"', "fs.destructive", None),
    ("echo | xargs rm -rf", "echo /opt/x | xargs rm -rf", "fs.destructive", None),
    ("( rm -rf /opt/x )", "( rm -rf /opt/x )", "fs.destructive", None),
    ("{ rm -rf /opt/x; }", "{ rm -rf /opt/x; }", "fs.destructive", None),
    ("$(...) command substitution", "ls $(rm -rf /opt/x)", "fs.destructive", None),
    ("`...` command substitution", "ls `rm -rf /opt/x`", "fs.destructive", None),
    ("nice wrapper", "nice rm -rf /opt/x", "fs.destructive", None),
    ("timeout wrapper", "timeout 30 rm -rf /opt/x", "fs.destructive", None),
    ("nohup wrapper", "nohup rm -rf /opt/x &", "fs.destructive", None),
    ("time wrapper", "time rm -rf /opt/x", "fs.destructive", None),
    ("command wrapper", "command rm -rf /opt/x", "fs.destructive", None),
    ("exec wrapper", "exec rm -rf /opt/x", "fs.destructive", None),

    # -- P2-1 CATCH: git global-option parsing --
    ("git -C <path> push --force -> branch must be main, not 'origin'",
     "git -C /opt/x push --force origin main", "git.force_push", branch_is("main")),
    ("+refspec force push", "git push origin +main", "git.force_push", None),
    ("git push --delete main", "git push origin --delete main", "git.force_push", None),
    ("git push -d main", "git push -d origin main", "git.force_push", None),
    ("git push --mirror", "git push --mirror origin", "git.force_push", None),

    # -- P2-1 CATCH: docker exec into psql --
    ("docker exec psql DROP TABLE", "docker exec -i cf-postgres psql -U postgres -c 'DROP TABLE runs'", "fs.destructive", None),
    ("docker exec psql TRUNCATE", "docker exec -i cf-postgres psql -U postgres -c 'TRUNCATE runs'", "fs.destructive", None),

    # -- P2-1 CATCH: ssh to a remote host --
    ("ssh quoted remote rm -rf", "ssh root@167.233.145.218 'rm -rf /opt/x'", "fs.destructive", None),
    ("ssh -i key remote rm -rf", "ssh -i k root@vps2 rm -rf /opt/x", "fs.destructive", None),

    # -- P2-1 CATCH: docker volume total-loss verbs --
    ("docker compose down -v", "docker compose down -v", "fs.destructive", None),
    ("docker volume rm", "docker volume rm cf_pg", "fs.destructive", None),
    ("docker system prune --volumes", "docker system prune -af --volumes", "fs.destructive", None),

    # -- P2-1 CATCH: pm2 del alias --
    ("pm2 del alias", "pm2 del forge-control", "fs.destructive", None),

    # -- P2-1 CATCH: case-insensitive telegram host --
    ("uppercase telegram host", "curl -X POST https://API.TELEGRAM.ORG/bot1/sendMessage", "comm.outbound", None),

    # -- P1-1: the guard's own control-plane endpoints must be a LOCAL hard
    # block (no API round-trip) -- an agent must not be able to curl its way
    # to disabling or erasing the rule that is currently blocking it.
    ("self-edit: disable a rule",
     "curl -sX POST http://127.0.0.1:7700/api/autonomy/rules/fs.destructive -H 'content-type: application/json' -d '{\"enabled\":false}'",
     "autonomy.self_edit", None),
    ("self-edit: poison a rule's config",
     "curl -sX POST http://127.0.0.1:7700/api/autonomy/rules/fs.destructive -H 'content-type: application/json' -d '{\"config\":{\"note\":\"x\"}}'",
     "autonomy.self_edit", None),
    ("self-edit: resolve a trip",
     "curl -sX POST http://127.0.0.1:7700/api/autonomy/trips/abc123/resolve",
     "autonomy.self_edit", None),
]

# -- P2-2: the false-positive that fooled a real run into shell-quoting past
# the guard, then went quiet. `;` inside a quoted commit message must not be
# treated as a segment operator.
MUST_BLOCK.append((
    "quoted ';' inside -m must not desegment (this one is a REAL rm -rf, must still trip)",
    "git commit -am 'chore: cleanup'; rm -rf /opt/x",
    "fs.destructive", None,
))

# ---------------------------------------------------------------------------
# ROUND 5 -- the mutation-discrimination set.
#
# The round-4 review reverted two of this branch's three hardening changes and
# the 140-case suite stayed 140/140 green. A suite that cannot tell the patched
# subject from the unpatched one is not evidence that the patch does anything
# (memory: prove-it-bites-is-the-mutation-control, assertion-inert-shared-
# substring). Every case below is chosen so that ONE named revert turns it red;
# the reverts and their transcripts are scripts/checks/prove-guard-bites.sh.
#
# `/opt/content-forge` is deliberate as the target: it is a real tree on this
# box, so a case that "blocks" it is asserting on the shape the guard exists
# for, not on a path that happens to be missing from ROUTINE_BASENAMES.
# ---------------------------------------------------------------------------

MUST_BLOCK += [
    # -- discriminates `if recursive:` from `if recursive and force:` (e6901a8).
    # `rm -r src/routes` removed 48 tracked files on 2026-08-25 past the guard.
    ("rm -r without -f (the 48-file incident's exact shape)",
     "rm -r /opt/content-forge", "fs.destructive", None),
    ("rm --recursive without -f", "rm --recursive /opt/content-forge", "fs.destructive", None),
    ("rm -r -f split flags", "rm -r -f /opt/content-forge", "fs.destructive", None),
    ("rm -R uppercase", "rm -R /opt/content-forge", "fs.destructive", None),

    # -- discriminates the newline in shlex punctuation_chars (guard-autonomy.py
    # tokenize()). Without it a newline is whitespace, both lines become ONE
    # segment whose head is `ls`/`echo`, and every rule after the head is dead.
    ("newline segmentation: second line is the destructive one",
     "ls -la\nrm -rf /opt/content-forge", "fs.destructive", None),
    ("newline segmentation: second line is the force push",
     "echo hi\ngit push --force origin main", "git.force_push", None),
    ("newline segmentation: three lines, the last one trips",
     "cd /opt\nls\nrm -rf /opt/content-forge", "fs.destructive", None),

    # -- B4: strip_heredocs must not treat a quoted / arithmetic / here-string
    # `<<` as a heredoc introducer. Each of these ran BOTH lines in bash and
    # classified as None before round 5: exit 0, no audit line, no trip row.
    ('`<<` inside a quoted string is not a heredoc',
     'echo "see << NOTE"\nrm -rf /opt/content-forge', "fs.destructive", None),
    ("arithmetic left shift is not a heredoc",
     "echo $((1 << 3))\ngit push --force origin main", "git.force_push", None),
    ("a here-STRING has no body to skip",
     'cat <<< "$s"\nrm -rf /opt/content-forge', "fs.destructive", None),
    ("an UNTERMINATED heredoc must not swallow the rest of the command",
     "cat <<EOF\nrm -rf /opt/content-forge", "fs.destructive", None),
    ("`<<` in single quotes is not a heredoc either",
     "echo 'a << b'\nrm -rf /opt/content-forge", "fs.destructive", None),

    # …and the same three shapes WITH a matching terminator line, which is the
    # adversarial version rather than the accidental one: a fake heredoc opener
    # plus a marker line hides everything between them from a classifier that
    # reads `<<` without reading quote state. These are the cases that separate
    # the two halves of the B4 fix — keeping an unterminated remainder rescues
    # the accidental shapes on its own, and rescues none of these.
    ("fake heredoc opener in double quotes + a real terminator line",
     'echo "x << EOF"\nrm -rf /opt/content-forge\nEOF', "fs.destructive", None),
    ("arithmetic shift whose operand doubles as a terminator line",
     "N=$((1 << SHIFT))\nrm -rf /opt/content-forge\nSHIFT", "fs.destructive", None),
    ("here-string whose word doubles as a terminator line",
     'grep -q x <<< "tok"\ngit push --force origin main\ntok', "git.force_push", None),

    # -- B5: `-c` anywhere in a short-option cluster, not only at its end.
    ('bash -cx (the transposition that defeated the wrapper CATCH)',
     'bash -cx "rm -rf /opt/x"', "fs.destructive", None),
    ('bash -xc', 'bash -xc "rm -rf /opt/x"', "fs.destructive", None),
    ('sh -exc', 'sh -exc "rm -rf /opt/x"', "fs.destructive", None),

    # -- B6 must not become an evasion. A resolvable literal is judged on its
    # VALUE, so a literal naming a real tree still blocks, and the shapes this
    # hook cannot order or see are still refused.
    ("literal assignment naming a REAL tree still blocks",
     "SC=/opt/content-forge; rm -rf $SC", "fs.destructive", None),
    ("a variable assigned twice is unresolvable, not the first value",
     "SC=/tmp/a; SC=/opt/content-forge; rm -rf $SC", "fs.destructive", None),
    ("an ENV PREFIX is not a shell variable -- $SC comes from the caller",
     "SC=/tmp/safe rm -rf $SC", "fs.destructive", None),
    ("${SC:-…} is the variable through an operator, not the variable",
     "SC=/tmp/x; rm -rf ${SC:-/opt/content-forge}", "fs.destructive", None),
    ("a literal that is itself a variable gets no second hop",
     'SC="$OTHER"; rm -rf $SC', "fs.destructive", None),

    # -- the sharp edge of the `$$` substitution, and the reason it is limited to
    # the two tokens that are GUARANTEED to be digits. An opaque `$X` followed by
    # a routine basename is the laundering shape: substitute any expansion and
    # `$X/dist` becomes a path whose components include `dist`, which rule 1
    # calls routine wherever it appears -- so `X=/opt/content-forge` in the
    # caller's environment would walk straight through.
    ("an opaque variable followed by a routine basename must NOT resolve",
     "C=$X/dist; rm -rf $C", "fs.destructive", None),
    ("…the same with node_modules",
     "C=$BUILD/node_modules; rm -rf $C", "fs.destructive", None),

    # -- cd-tracking must not become an escape hatch: a relative target is
    # normpath'd AFTER the join, so `..` walks back out of the routine tree.
    ("cd /tmp then delete back out through ..",
     "cd /tmp && rm -rf ../opt/content-forge", "fs.destructive", None),
    ("cd into a worktree then delete the worktree ROOT by relative path",
     "cd /opt/ai-os/workspace/projects && rm -rf b167b94e-b335-4767-a3d1-1b43fd72a3dc",
     "fs.destructive", None),

    # -- the browser-profiles exception is EXACT: the siblings hold logged-in
    # session cookies only Konrad can restore.
    ("browser-profiles/perplexity is NOT the scratch profile",
     "rm -rf /opt/ai-os/browser-profiles/perplexity", "fs.destructive", None),
    ("the browser-profiles DIRECTORY itself is not routine",
     "rm -rf /opt/ai-os/browser-profiles", "fs.destructive", None),
]


# --- MUST_PASS ---------------------------------------------------------------
# The false-positive side -- the bigger risk per the brief. Every entry here
# is either a routine-path decision from findings P2-2, a rejected-on-purpose
# gap from P2-1 (asserted PASS and documented), or ordinary corpus-derived
# fleet traffic.

MUST_PASS = [
    # -- P2-2 rule 1: routine basename anywhere in the path, not just the tail --
    ("rm -rf node_modules", "rm -rf node_modules", None, None),
    ("rm -rf .next", "rm -rf .next", None, None),
    ("rm -rf dist", "rm -rf dist", None, None),
    ("rm -rf apps/web/.next", "rm -rf apps/web/.next", None, None),
    ("rm -rf /tmp/x", "rm -rf /tmp/x", None, None),
    ("rm -rf /var/tmp/x", "rm -rf /var/tmp/x", None, None),
    ("rm -rf .next/types (component, not just tail)", "rm -rf .next/types", None, None),

    # -- P2-2 rule 2: relative target + routine cwd --
    ("rm -rf main-check under cwd=/tmp", "rm -rf main-check", None, "/tmp"),

    # -- P2-2 rule 3: inside-own-worktree passes, worktree ROOT stays guarded --
    ("rm -rf inside own worktree (subdir)",
     "rm -rf /opt/ai-os/workspace/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc/streampreview823",
     None, None),
    ("rm -rf worktree ROOT must still BLOCK",
     "rm -rf /opt/ai-os/workspace/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc",
     "fs.destructive", None),
    ("rm -rf /opt/ai-os/scratch/foo passes", "rm -rf /opt/ai-os/scratch/foo", None, None),
    ("rm -rf /opt/ai-os/uploads/abc still BLOCKS", "rm -rf /opt/ai-os/uploads/abc", "fs.destructive", None),

    # -- P2-2 rule 4: self-created scratch (mktemp) and self-created scratch DB --
    ("mktemp'd dir removed in the same command",
     'TMPD=$(mktemp -d) && cp -r foo "$TMPD" && rm -rf "$TMPD"', None, None),
    ("bare $VAR target (not self-created) still BLOCKS",
     'rm -rf "$SOMEVAR"', "fs.destructive", None),
    ("CREATE then DROP the same scratch DB in one command",
     'psql -U postgres -c "CREATE DATABASE probe_$$" && psql -d postgres -c "DROP DATABASE probe_$$"',
     None, None),
    ("DROP TABLE against a scratch-named db",
     "psql -d rollup_probe_r1873 -c 'DROP TABLE runs'", None, None),
    ("DROP TABLE against the real db still BLOCKS",
     "psql -d content_forge -c 'DROP TABLE runs'", "fs.destructive", None),

    # -- git: force-push to a non-protected lane is a classifier trip (the
    # payload identifies the branch; the control plane, not the classifier,
    # is what allows it) -- assert the payload, not just that it trips.
    ("force-push to a project/* lane -- payload branch asserted",
     "git push --force origin project/abc", "git.force_push", branch_is("project/abc")),
    ("plain push to main, no force", "git push origin main", None, None),

    # -- rejected on purpose, worktree-local recovery moves --
    ("git reset --hard && git clean -fdx", "git reset --hard && git clean -fdx", None, None),
    ("git stash drop", "git stash drop", None, None),
    ("git branch -D", "git branch -D project/xyz", None, None),
    ("rm -f (no recurse)", "rm -f file.txt", None, None),

    # -- ordinary builder lifecycle --
    ("pnpm install", "pnpm install", None, None),
    ("pnpm install --frozen-lockfile --prod=false", "pnpm install --frozen-lockfile --prod=false", None, None),
    ("next build", "next build", None, None),
    ("pnpm run clean", "pnpm run clean", None, None),

    # -- discussed, not run --
    ("echo of an rm -rf string", "echo 'rm -rf /opt/x'", None, None),
    ("grep for an rm -rf string", "grep -rn 'rm -rf /opt/x' .", None, None),
    ("quoted ';' operator inside a commit message (RED today -- P2-2 structural bug)",
     "git commit -m 'chore: drop scratch; rm -rf /opt/x no longer needed'", None, None),
    ("heredoc prose about the command",
     'cat <<\'EOF\' > n.md\nNever run rm -rf /opt/x.\nEOF', None, None),
    ("heredoc body with an INDENTED '  EOF' line then leaked prose (RED today -- P3-2)",
     "cat <<'EOF' > n.md\n  EOF\nrm -rf /opt/y\nEOF", None, None),

    # -- P2-1 REJECT: documented gaps, deliberately never caught --
    ("REJECT: alias expansion (non-interactive bash doesn't expand aliases)",
     "alias r=rm; r -rf /opt/x", None, None),
    ("REJECT: python3 -c shutil.rmtree (interpreter body, unbounded)",
     'python3 -c "import shutil; shutil.rmtree(\'/opt/x\')"', None, None),
    ("REJECT: truncate -s0", "truncate -s0 /opt/content-forge/.env", None, None),
    ("REJECT: > redirection over a real file", "> /opt/content-forge/.env", None, None),
    ("REJECT: dd of=", "dd if=/dev/zero of=/opt/x bs=1M count=1", None, None),
    ("REJECT: mv as destruction (can't distinguish from rename)",
     "mv /opt/content-forge /tmp/gone", None, None),
    ("REJECT: rsync --delete", "rsync -a --delete /empty/ /opt/x/", None, None),
    ("REJECT: DELETE FROM (routine, has WHERE in practice)",
     "psql -U postgres -c 'DELETE FROM runs'", None, None),
    ("REJECT: DROP INDEX (legitimate migration verb)",
     "psql -U postgres -c 'DROP INDEX foo'", None, None),
    ("REJECT: redis-cli --eval", "redis-cli --eval x.lua", None, None),
    ("REJECT: $T-carried host for telegram", "T=api.telegram.org; curl -X POST https://$T/bot1/sendMessage", None, None),

    # -- >=40 corpus-derived routine shapes: the 30 most common heads in the
    # 24h corpus, synthesised (never pasted from commands-24h.jsonl). --
    ("cd", "cd /opt/content-forge", None, None),
    ("grep", "grep -rn 'TODO' src/", None, None),
    ("git status", "git status", None, None),
    ("git log", "git log --oneline -10", None, None),
    ("git diff", "git diff --stat HEAD~1", None, None),
    ("git diff staged", "git diff --cached", None, None),
    ("git add", "git add -A", None, None),
    ("git commit clean message", "git commit -m 'fix: typo in README'", None, None),
    ("git push ordinary lane", "git push origin project/b167b94e", None, None),
    ("git checkout branch", "git checkout -b project/foo", None, None),
    ("git fetch", "git fetch origin", None, None),
    ("git worktree list", "git worktree list", None, None),
    ("ls", "ls -la /opt/ai-os/scripts", None, None),
    ("sed print range", "sed -n '1,20p' file.ts", None, None),
    ("cat", "cat package.json", None, None),
    ("find without -delete", "find . -name '*.ts' -not -path '*/node_modules/*'", None, None),
    ("curl to local control plane", "curl -s http://127.0.0.1:7700/api/today", None, None),
    ("wc", "wc -l scripts/ops/fleet-pulse.sh", None, None),
    ("python3 script (not shutil/gmail)", "python3 scripts/check_something.py --verbose", None, None),
    ("pnpm typecheck", "pnpm run typecheck", None, None),
    ("pnpm test", "pnpm test", None, None),
    ("npx tsc", "npx tsc --noEmit", None, None),
    ("psql SELECT", "psql -U postgres -d content_forge -c 'SELECT count(*) FROM runs'", None, None),
    ("psql \\dt", "psql -U postgres -d content_forge -c '\\dt'", None, None),
    ("docker ps", "docker ps", None, None),
    ("docker logs", "docker logs cf-postgres --tail 50", None, None),
    ("mkdir -p", "mkdir -p /opt/ai-os/scratch/foo", None, None),
    ("cp", "cp -r src dist-backup", None, None),
    ("mv within worktree", "mv old-name.ts new-name.ts", None, None),
    ("chmod +x on a script", "chmod +x scripts/ops/fleet-pulse.sh", None, None),
    ("touch", "touch scripts/ops/README.md", None, None),
    ("diff", "diff a.ts b.ts", None, None),
    ("head", "head -50 CHANGELOG.md", None, None),
    ("tail -f a log", "tail -f /var/log/forge-guard-autonomy.log", None, None),
    ("env inspection", "env | grep FORGE", None, None),
    ("which", "which pnpm", None, None),
    ("node version check", "node --version", None, None),
    ("curl GET to reelforge health", "curl -s http://127.0.0.1:7700/api/pipeline", None, None),
    ("pm2 list", "pm2 list", None, None),
    ("pm2 logs (read only)", "pm2 logs forge-control --nostream", None, None),
]

# ---------------------------------------------------------------------------
# ROUND 5 -- the false-positive side of the same four rules. 02-classifier-
# decisions.md §8.1 named these as the highest-value follow-up in the document
# and they were still uncovered at the round-4 review.
#
# This half matters more than the MUST_BLOCK half. A guard that blocks ordinary
# builder work gets switched off and then guards nothing; `2>&1` alone appears
# in a large fraction of the fleet's Bash calls, and two of the three surviving
# corpus trips were that shape.
# ---------------------------------------------------------------------------

MUST_PASS += [
    # -- the `2>&1` fd prefix. shlex splits it into ['2','>&','1'], so the `2`
    # used to arrive as an rm ARGUMENT and, not being a routine path, tripped.
    ("rm -rf .next 2>&1", "rm -rf .next 2>&1", None, None),
    ("rm -rf node_modules 2>/dev/null", "rm -rf node_modules 2>/dev/null", None, None),
    ("rm -rf dist >/dev/null 2>&1", "rm -rf dist >/dev/null 2>&1", None, None),
    ("pnpm install 2>&1 | tail -5", "pnpm install 2>&1 | tail -5", None, None),
    # …and adjacency is still the discriminator: a directory genuinely NAMED `2`
    # is a target, because bash reads `dir2>&1` as the word `dir2`.
    ("a directory whose name ENDS in a digit is still a target",
     "rm -rf /opt/content-forge2>&1", "fs.destructive", None),

    # -- cd-tracking. Judged against the cwd the command WALKS to, not the one
    # the run was recorded in; without it rule 2 fires on nothing at all.
    ("cd /tmp && rm -rf main-check", "cd /tmp && rm -rf main-check", None, None),
    ("cd into own worktree then rm a subdir",
     "cd /opt/ai-os/workspace/projects/b167b94e-b335-4767-a3d1-1b43fd72a3dc && rm -rf probe823",
     None, None),
    ("cd /opt/ai-os/scratch; rm -rf a scratch child",
     "cd /opt/ai-os/scratch && rm -rf run-1234", None, None),

    # -- B6: a literal assigned in the same command is judged on its VALUE.
    # The live guard blocked this shape on 2026-08-25 (trip 5c9fc766) while the
    # value `/tmp/…` was plainly visible two words earlier.
    ("SC=/tmp/…; rm -rf $SC (trip 5c9fc766's exact shape)",
     "SC=/tmp/guard-probe-r5; rm -rf $SC", None, None),
    ('double-quoted literal, quoted use', 'SC="/tmp/guard-probe-r5"; rm -rf "$SC"', None, None),
    ("single-quoted literal", "SC='/tmp/guard-probe-r5'; rm -rf \"$SC\"", None, None),
    ("${SC} brace form", "SC=/tmp/guard-probe-r5; rm -rf ${SC}", None, None),
    ("assignment after && still resolves",
     "cd /opt && SC=/tmp/guard-probe-r5; rm -rf $SC", None, None),
    ("literal node_modules path via a variable",
     "D=/opt/content-forge/node_modules; rm -rf $D", None, None),

    # -- the `$$` / $RANDOM scratch-dir idiom. Found by the live guard blocking
    # THIS round's own control script (trip 9d5c8cdf): the routine prefix was
    # /opt/ai-os/scratch/ and the only thing in the way was the pid token. Both
    # tokens always expand to digits, so they change one path component's
    # spelling and never the tree.
    ("C=/opt/ai-os/scratch/…-$$ ; rm -rf $C (trip 9d5c8cdf's exact shape)",
     "C=/opt/ai-os/scratch/b167-installctl-$$; rm -rf $C", None, None),
    ("$$ in /tmp", "T=/tmp/probe-$$; rm -rf $T", None, None),
    ("$RANDOM in /tmp", "T=/tmp/probe-$RANDOM; rm -rf $T", None, None),
    ("${RANDOM} brace form", "T=/tmp/probe-${RANDOM}; rm -rf $T", None, None),
    ("$$ inside double quotes", 'T="/tmp/probe-$$"; rm -rf "$T"', None, None),
    # …and the verdict is preserved in the OTHER direction too: a pid token in a
    # non-routine tree resolves to a non-routine path and still blocks.
    ("$$ does not launder a real tree",
     "C=/opt/content-forge-$$; rm -rf $C", "fs.destructive", None),
    ("$$ does not launder the worktree ROOT",
     "C=/opt/ai-os/workspace/projects/$$; rm -rf $C", "fs.destructive", None),
    # …and no OTHER expansion is resolved: only these two tokens are digits.
    ("$HOME is not a digit token", "C=$HOME/x; rm -rf $C", "fs.destructive", None),
    ("a command substitution in the value is not literal",
     'C="$(cat /tmp/where)"; rm -rf $C', "fs.destructive", None),

    # -- the browser-profiles/scratch exception itself.
    ("research-browser's disposable scratch profile",
     "rm -rf /opt/ai-os/browser-profiles/scratch", None, None),
    ("…and its .state sibling", "rm -rf /opt/ai-os/browser-profiles/.state/scratch", None, None),

    # -- heredoc prose must STILL be invisible after the B4 tightening. This is
    # the reason strip_heredocs exists: fleet notes discuss these commands
    # constantly and a guard that cannot tell prose from an invocation makes its
    # own documentation unwritable.
    ("heredoc prose naming a recursive delete",
     "cat <<'EOF' > note.md\nNever run rm -rf /opt/content-forge here.\nEOF", None, None),
    ("heredoc prose naming a force push",
     "cat <<'EOF' > note.md\ngit push --force origin main is forbidden.\nEOF", None, None),
    ("<<- tab-indented marker still ends the body",
     "cat <<-'EOF' > note.md\nrm -rf /opt/content-forge\n\tEOF", None, None),
    ("a here-string carrying prose is not classified as a command",
     'grep -q x <<< "rm -rf /opt/content-forge"', None, None),
    ("arithmetic shift on its own", "echo $((1 << 3))", None, None),
]


def run_layer_a():
    print("\n== Layer A: in-process classifier matrix (zero network) ==\n")
    print(f"-- MUST_BLOCK ({len(MUST_BLOCK)} cases) --")
    for label, cmd, expect, payload_check in MUST_BLOCK:
        classify_case(label, cmd, expect, payload_check=payload_check)
    print(f"\n-- MUST_PASS ({len(MUST_PASS)} cases) --")
    for entry in MUST_PASS:
        label, cmd, expect, cwd = entry
        classify_case(label, cmd, expect, cwd=cwd or DEFAULT_CWD)


# ============================================================================
# Layer B -- subprocess exit-code contract against a local stub API. Never
# touches :7700. Pattern ported from /opt/ai-os/scratch/guardrail-a1/stub.py,
# extended to also serve POST /api/reminders and record bodies (needed for
# the ACK-notification case).
# ============================================================================

class _State:
    def __init__(self):
        self.mode = "allow"      # allow | block | noallow | 500 | garbage | pause
        self.delay = 0
        self.autonomy_calls = []
        self.reminders = []


class _Handler(BaseHTTPRequestHandler):
    state: _State = None

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {"_raw": raw.decode(errors="replace")}
        st = type(self).state
        if self.path.startswith("/api/reminders"):
            st.reminders.append(body)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if self.path.startswith("/api/autonomy/check"):
            st.autonomy_calls.append(body)
            if st.delay:
                time.sleep(st.delay)
            if st.mode == "500":
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"boom")
                return
            if st.mode == "garbage":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"<html>")
                return
            if st.mode == "noallow":
                out = {"weird": 1}
            elif st.mode == "block":
                out = {"allow": False, "blocked_by": "fs.destructive", "rule_label": "Destructive fs ops",
                       "reason": "stub", "trip_id": "stub-1"}
            else:
                out = {"allow": True}
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(out).encode())
            return
        self.send_response(404)
        self.end_headers()


class Stub:
    def __init__(self):
        self.state = _State()
        handler = type("H", (_Handler,), {"state": self.state})
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def run_hook(stdin_text, env_extra, api_url, timeout=10):
    env = dict(os.environ)
    env.pop("FORGE_GUARD_ACK", None)
    env["FORGE_API"] = api_url
    env.update(env_extra)
    start = time.monotonic()
    p = subprocess.run(
        [sys.executable, HOOK_PATH], input=stdin_text, text=True,
        capture_output=True, env=env, timeout=timeout,
    )
    elapsed = time.monotonic() - start
    return p, elapsed


def stdin_for(cmd):
    return json.dumps({"tool_input": {"command": cmd}, "cwd": DEFAULT_CWD})


def read_audit_lines(path):
    if not os.path.isfile(path):
        return []
    with open(path) as f:
        out = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
        return out


def b_case(label, ok):
    record(ok, f"[B] {label}")


def run_layer_b():
    print("\n== Layer B: subprocess exit-code contract (local stub, never :7700) ==\n")

    # B1: allow:false -> exit 2, correct stderr, no advertised bypass recipe.
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b1"}, stub.url)
    stub.stop()
    b_case("allow:false -> exit 2",
           p.returncode == 2 and "BLOCKED by the autonomy control plane" in p.stderr
           and "FORGE_GUARD_ACK" not in p.stderr)

    # B2: allow:true -> exit 0.
    stub = Stub(); stub.state.mode = "allow"
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b2"}, stub.url)
    stub.stop()
    b_case("allow:true -> exit 0", p.returncode == 0)

    # B3: malformed 200 (no "allow" key) -> exit 0 AND a fail-open audit line
    # in the file FORGE_GUARD_AUDIT_LOG points at. RED today: the hook has no
    # audit call for this branch at all, and even if it did, AUDIT_LOG is a
    # hardcoded /var/log path this test must never read directly.
    stub = Stub(); stub.state.mode = "noallow"
    audit_file = "/tmp/guard-autonomy-test-audit-b3.log"
    if os.path.exists(audit_file):
        os.remove(audit_file)
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"),
                     {"FORGE_RUN_UUID": "b3", "FORGE_GUARD_AUDIT_LOG": audit_file}, stub.url)
    stub.stop()
    lines = read_audit_lines(audit_file)
    b_case("malformed 200 ({'weird':1}) -> exit 0 + fail-open audit line (RED today)",
           p.returncode == 0 and any(l.get("kind") == "fail-open" for l in lines))

    # B4: HTTP 500 -> exit 0 (fail open).
    stub = Stub(); stub.state.mode = "500"
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b4"}, stub.url)
    stub.stop()
    b_case("HTTP 500 -> exit 0", p.returncode == 0)

    # B5: 200 + non-JSON body -> exit 0 (fail open).
    stub = Stub(); stub.state.mode = "garbage"
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b5"}, stub.url)
    stub.stop()
    b_case("200 + <html> body -> exit 0", p.returncode == 0)

    # B6: stub sleeps 4s -> hook's own 2.5s HTTP ceiling must still return 0
    # well inside the 3.5s slack this test allows.
    stub = Stub(); stub.state.mode = "allow"; stub.state.delay = 4
    p, elapsed = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b6"}, stub.url)
    stub.stop()
    b_case(f"stub sleeps 4s -> exit 0 within 3.5s (took {elapsed:.2f}s)",
           p.returncode == 0 and elapsed < 3.5)

    # B7: dead port -> exit 0 (connection refused, fail open).
    probe = HTTPServer(("127.0.0.1", 0), _Handler)
    dead_port = probe.server_address[1]
    probe.server_close()
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"), {"FORGE_RUN_UUID": "b7"},
                     f"http://127.0.0.1:{dead_port}")
    b_case("dead port -> exit 0", p.returncode == 0)

    # B8: no FORGE_RUN_UUID -> exit 0 AND the stub is never contacted.
    stub = Stub(); stub.state.mode = "block"
    env = dict(os.environ)
    env.pop("FORGE_RUN_UUID", None)
    env.pop("FORGE_GUARD_ACK", None)
    env["FORGE_API"] = stub.url
    p = subprocess.run([sys.executable, HOOK_PATH], input=stdin_for("rm -rf /opt/x"),
                        text=True, capture_output=True, env=env, timeout=10)
    stub.stop()
    b_case("no FORGE_RUN_UUID -> exit 0, stub never contacted",
           p.returncode == 0 and len(stub.state.autonomy_calls) == 0)

    # B9: stdin is not JSON -> exit 0.
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook("not json", {"FORGE_RUN_UUID": "b9"}, stub.url)
    stub.stop()
    b_case("stdin 'not json' -> exit 0", p.returncode == 0)

    # B10: empty stdin -> exit 0.
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook("", {"FORGE_RUN_UUID": "b10"}, stub.url)
    stub.stop()
    b_case("empty stdin -> exit 0", p.returncode == 0)

    # B11: tool_input is a STRING, not a dict -> exit 0. RED today: the hook
    # calls .get("command") on a string outside any try/except and dies with
    # a traceback (exit 1), per findings P3-1.
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook(json.dumps({"tool_input": "rm -rf /opt/x"}), {"FORGE_RUN_UUID": "b11"}, stub.url)
    stub.stop()
    b_case("tool_input as a bare string -> exit 0 (RED today: exits 1)", p.returncode == 0)

    # B12: FORGE_GUARD_ACK prefix acknowledges a real trip -> exit 0 AND the
    # stub's /api/reminders received a POST whose text starts "Guardrail
    # OVERRIDDEN" (the loud-door fix from the 23:36 Haiku incident).
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook(stdin_for("FORGE_GUARD_ACK=fs.destructive rm -rf /opt/x"),
                     {"FORGE_RUN_UUID": "b12"}, stub.url)
    stub.stop()
    b_case("ACK prefix -> exit 0 + reminder text starts 'Guardrail OVERRIDDEN'",
           p.returncode == 0 and len(stub.state.reminders) == 1
           and stub.state.reminders[0].get("text", "").startswith("Guardrail OVERRIDDEN"))

    # B13: ACK for the WRONG rule id still blocks.
    stub = Stub(); stub.state.mode = "block"
    p, _ = run_hook(stdin_for("FORGE_GUARD_ACK=git.force_push rm -rf /opt/x"),
                     {"FORGE_RUN_UUID": "b13"}, stub.url)
    stub.stop()
    b_case("wrong-rule ACK -> still exit 2", p.returncode == 2)

    # B14: FORGE_GUARD_AUDIT_LOG redirects the audit log for a real block.
    # RED today: AUDIT_LOG is a hardcoded /var/log constant, the env var is
    # never read, so the redirect file stays empty. Never read /var/log
    # directly to "make this pass" -- that is exactly the softening this
    # project forbids.
    stub = Stub(); stub.state.mode = "block"
    audit_file = "/tmp/guard-autonomy-test-audit-b14.log"
    if os.path.exists(audit_file):
        os.remove(audit_file)
    p, _ = run_hook(stdin_for("rm -rf /opt/a3-probe-target"),
                     {"FORGE_RUN_UUID": "b14", "FORGE_GUARD_AUDIT_LOG": audit_file}, stub.url)
    stub.stop()
    lines = read_audit_lines(audit_file)
    b_case("FORGE_GUARD_AUDIT_LOG honoured for a real block (RED today)",
           p.returncode == 2 and any(l.get("kind") == "blocked" for l in lines))

    for f in ("/tmp/guard-autonomy-test-audit-b3.log", "/tmp/guard-autonomy-test-audit-b14.log"):
        if os.path.exists(f):
            os.remove(f)


def main() -> int:
    print(f"guard-autonomy hook under test: {HOOK_PATH}")
    run_layer_a()
    run_layer_b()
    print(f"\n{total - len(failures)}/{total} passed")
    if failures:
        print(f"\n{len(failures)} RED case(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
