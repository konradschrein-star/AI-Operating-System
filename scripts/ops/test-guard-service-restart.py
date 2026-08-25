#!/usr/bin/env python3
"""Discrimination matrix for guard-service-restart.py.

Lives in a file rather than inline in a Bash command on purpose: the cases ARE
strings like "pm2 restart forge-executor", so any shell command containing them
is itself blocked by the guard under test. That is the guard working, but it
makes the test unrunnable inline. Invoking `python3 <this file>` keeps the
Bash command clean while the payloads stay honest.

GUARD resolves to the sibling file in this directory (scripts/ops/guard-
service-restart.py) so this always tests the repo copy, never the live
/opt/ai-os/scripts/guard-service-restart.py (memory: guard-hook-tests-never-
hit-live-api -- testing the live path tests HEAD-live, not this worktree's
work). That sibling file does not exist in this repo at this round yet (it
ships alongside guard-autonomy.py in a later round), so GUARD_SERVICE_RESTART_HOOK
overrides it to a /tmp COPY of the live file for this round's own run:

    cp /opt/ai-os/scripts/guard-service-restart.py /tmp/guard-service-restart-under-test.py
    chmod +x /tmp/guard-service-restart-under-test.py
    GUARD_SERVICE_RESTART_HOOK=/tmp/guard-service-restart-under-test.py \\
      python3 scripts/ops/test-guard-service-restart.py
"""
import json
import os
import subprocess
import sys

GUARD = os.environ.get("GUARD_SERVICE_RESTART_HOOK") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "guard-service-restart.py"
)
BLOCK, ALLOW = 2, 0

HEREDOC_PROSE = 'cat > /tmp/n.md <<"EOF"\nNever run pm2 restart forge-executor.\npm2 kill is worse.\nEOF'
HEREDOC_THEN_REAL = 'cat > /tmp/n.md <<"EOF"\njust notes\nEOF\npm2 restart forge-executor'

CASES = [
    (BLOCK, "pm2 restart forge-executor", "restart executor"),
    (ALLOW, "pm2 restart forge-control --update-env", "restart control (API, owns no turns)"),
    (BLOCK, "pm2 reload forge-executor", "reload executor"),
    (ALLOW, "pm2 delete forge-control", "delete control"),
    (BLOCK, "pm2 stop forge-executor", "stop executor"),
    (BLOCK, "pm2 kill", "pm2 kill (whole daemon)"),
    (BLOCK, "sudo pm2 restart forge-executor", "via sudo"),
    (BLOCK, "cd /tmp && pm2 restart forge-executor", "chained after &&"),
    (BLOCK, "/usr/bin/pm2 restart forge-executor", "absolute path to pm2"),
    (BLOCK, HEREDOC_THEN_REAL, "heredoc, THEN a real restart"),
    (ALLOW, "pm2 restart forge-control-web", "restart forge-control-web"),
    (ALLOW, "pm2 restart forge-control-web --update-env", "…web with a flag"),
    (ALLOW, "pm2 list", "pm2 list"),
    (ALLOW, "pm2 logs forge-executor --nostream", "read executor logs"),
    (ALLOW, "echo pm2 restart forge-executor", "merely echoing it"),
    (ALLOW, "pm2 restart reelforge", "an unrelated service"),
    (ALLOW, HEREDOC_PROSE, "heredoc PROSE about the command"),
    (ALLOW, "git commit -m 'do not pm2 restart forge-executor'", "quoted in a commit msg"),
]


def run(cmd: str, in_run: bool) -> int:
    env = dict(os.environ)
    if in_run:
        env["FORGE_RUN_UUID"] = "test-uuid"
    else:
        env.pop("FORGE_RUN_UUID", None)
    p = subprocess.run(
        [GUARD],
        input=json.dumps({"tool_input": {"command": cmd}}),
        text=True,
        capture_output=True,
        env=env,
    )
    return p.returncode


def main() -> int:
    if not os.path.isfile(GUARD):
        print(
            f"guard-service-restart hook not found at {GUARD}\n"
            "This repo does not carry it yet at this round -- set GUARD_SERVICE_RESTART_HOOK "
            "to a /tmp COPY of /opt/ai-os/scripts/guard-service-restart.py (never the live path).",
            file=sys.stderr,
        )
        return 1

    failures = 0
    for want, cmd, label in CASES:
        got = run(cmd, in_run=True)
        ok = got == want
        failures += not ok
        print(f"  {'OK  ' if ok else 'FAIL'}  exit={got} want={want}  {label}")

    # The guard must never fire for a human at a shell.
    got = run("pm2 restart forge-executor", in_run=False)
    ok = got == ALLOW
    failures += not ok
    print(f"  {'OK  ' if ok else 'FAIL'}  exit={got} want={ALLOW}  same command OUTSIDE a run")

    print(f"\n  {len(CASES) + 1} cases, {failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
