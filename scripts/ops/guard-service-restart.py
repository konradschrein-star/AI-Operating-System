#!/usr/bin/env python3
"""PreToolUse(Bash) guard: an agent turn may not restart the process that owns it.

THE INCIDENT THIS EXISTS FOR — 2026-08-25 00:16:47
---------------------------------------------------
Something restarted forge-control and forge-executor one second apart. Four
in-flight runs died in the same instant:

    run 2ef126b7 (an operator turn)       failed: claude-code exit 0:
    run ecf244a5 (Konrad's new chat)      failed: claude-code exit 0:
    run a5b13a04 (Konrad's Gemini chat)   failed: agy returned status ERROR
    run 23d63b3c (the lane's UI builder)  failed: agy returned status ERROR

`claude-code exit 0` with no output IS the signature: pm2 restarts the
executor, kills its children, and each child's turn ends mid-sentence looking
like a clean exit. Konrad saw two of his chats die with no stated reason.

This has been in fleet memory since 2026-07-30 (never-restart-own-executor.md)
and it happened anyway, because a note only helps the agent that reads it. This
is the same rule expressed where it cannot be skipped.

WHAT IT DOES
    Blocks `pm2 restart|reload|stop|delete <forge-executor|forge-control>` and
    bare `pm2 kill` when the caller is inside a run (FORGE_RUN_UUID set), and
    points at safe-restart.sh instead. Everything else passes through.

    forge-control-web is NOT guarded: it owns no agent turns, and restarting it
    is the normal way to deploy the UI. An earlier regex version blocked it by
    accident — "forge-control" matches inside "forge-control-web" because the
    hyphen is a word boundary — and a guard that blocks the ordinary deploy is
    a guard someone switches off, which then guards nothing.

CONTRACT: stdin is the PreToolUse JSON payload. Exit 0 allows; exit 2 blocks
and hands stderr back to the model as feedback.
"""
import json
import os
import re
import sys

# ONLY the executor. It owns agent turns: pm2 kills its children, so restarting
# it ends every run in flight — that is the 2026-08-25 02:16 incident above.
#
# NARROWED 2026-08-25 02:55. This set also held "forge-control", and that was
# wrong. forge-control is the API; it hosts no agent turns, and the note
# safe-restart-when-idle has said since 2026-07-30 that it can be restarted
# directly at any time. Measured before narrowing — across the window covering
# THREE restarts (forge-control 02:37, forge-control-web 02:01 and 02:10):
#
#     failed runs in that window: 0
#     one run even COMPLETED 26s after forge-control bounced
#
# The over-broad guard had a real cost: a finished deploy could not reload
# forge-control to make its own feature live, so safe-restart sat waiting for a
# fleet-idle window that three concurrent lanes were never going to give it. A
# guard that blocks legitimate work gets worked around, and then it guards
# nothing.
GUARDED = {"forge-executor"}  # NOT forge-control, NOT forge-control-web
VERBS = {"restart", "reload", "stop", "delete"}
STRIP = "\"'`"

MESSAGE = """BLOCKED: restarting forge-executor/forge-control from inside a run kills that
run — and every other run in flight with it. On 2026-08-25 this exact command
ended four turns at once, two of them Konrad's live chats, each surfacing to
him as an unexplained "Executor failed: claude-code exit 0".

pm2 kills the executor's children, so your own turn dies mid-sentence and the
work you were about to report goes with it.

Deploy it the way that outlives your turn instead — this waits for the fleet to
go quiet, then restarts:

  setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 7200 45 \\
    /opt/forge-ai-os/forge-control/ecosystem.config.cjs >/dev/null 2>&1 </dev/null &

Progress lands in /var/log/forge-safe-restart.log. If you need the change live
before you can report on it, say so in your answer and let Konrad decide — do
not force it.

(forge-control-web is not guarded; restart it freely.)"""


def strip_heredocs(cmd: str) -> str:
    """Remove heredoc BODIES, keeping the command lines around them.

    Writing about this rule trips it otherwise, which is not hypothetical: the
    very first thing the live hook blocked was the memory note documenting the
    incident, because the prose contained the words `pm2 restart ...` and
    `pm2 kill` inside a `cat > note.md <<'EOF'` body. Docs, commit messages and
    fleet notes discuss these commands constantly; a guard that cannot tell
    prose from an invocation would make them unwritable.
    """
    out, lines = [], cmd.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r"<<-?\s*[\"']?([A-Za-z_][A-Za-z0-9_]*)[\"']?", line)
        i += 1
        if not m:
            continue
        marker = m.group(1)
        while i < len(lines) and lines[i].strip() != marker:
            i += 1
        if i < len(lines):
            i += 1  # drop the closing marker too
    return "\n".join(out)


def guarded_invocation(cmd: str) -> bool:
    """True if `cmd` contains a pm2 call that would kill the run's own engine.

    Token-exact rather than a substring search, so `pm2 restart
    forge-control-web` and `echo pm2 restart forge-executor` both pass.
    """
    for seg in re.split(r"[;&|\n]+", strip_heredocs(cmd)):
        words = seg.split()
        if not words:
            continue
        # Step over leading env assignments and sudo/env so that
        # `sudo pm2 restart forge-executor` still counts.
        i = 0
        while i < len(words) and ("=" in words[i] or words[i] in ("sudo", "env")):
            i += 1
        if i >= len(words):
            continue
        tok = words[i]
        # A backticked token is being quoted, not run: `pm2 kill` in prose.
        if tok.startswith("`") or tok.startswith("'") or tok.startswith('"'):
            continue
        if os.path.basename(tok.strip(STRIP)) != "pm2":
            continue
        rest = [w for w in words[i + 1:] if not w.startswith("-")]
        if not rest:
            continue
        verb = rest[0].strip(STRIP)
        targets = {w.strip(STRIP) for w in rest[1:]}
        # `pm2 kill` names no target and takes the whole daemon with it.
        if verb == "kill":
            return True
        if verb in VERBS and (targets & GUARDED):
            return True
    return False


def main() -> int:
    # Only ever intervene inside a run. An operator at a shell by hand is not
    # the failure mode, and blocking them would be its own kind of damage.
    if not os.environ.get("FORGE_RUN_UUID"):
        return 0
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # unparseable payload is not this guard's business
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    if cmd and guarded_invocation(cmd):
        print(MESSAGE, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
