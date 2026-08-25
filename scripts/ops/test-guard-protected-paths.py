#!/usr/bin/env python3
"""Block/allow matrix for guard-protected-paths.py.

The hook under test is the sibling file in THIS directory, resolved from
`__file__` -- never `/opt/ai-os/scripts/guard-protected-paths.py`, which is the
live install and would test HEAD-live rather than this worktree (memory:
tsx-tsconfig-shadow-tree, guard-hook-tests-never-hit-live-api).

Nothing here writes to a protected path. The hook only ever READS the payload
and resolves the path, so a case is proven by the exit code alone: the matrix
asserts what the hook would have decided, and no case has to create -- or
threaten -- a real file under /root/.claude or /opt/ai-os/scripts. The symlink
cases build their links inside a scratch directory under /tmp that this file
creates and removes.

Both halves matter and the ALLOW half matters more. A hook that blocks the
memory notes every worker is told to write, or the worktree copy this project
exists to make agents edit, is a hook someone deletes from settings.json --
which is the failure this whole layer is guarding against.

CONTRACT: stdin is the PreToolUse JSON payload; exit 0 allows, exit 2 blocks.
"""
import json
import os
import shutil
import subprocess
import sys

HOOK = os.environ.get("GUARD_PROTECTED_PATHS_HOOK") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "guard-protected-paths.py"
)
REPO_OPS = os.path.dirname(os.path.abspath(__file__))
SCRATCH = f"/tmp/guard-protected-paths-test.{os.getpid()}"
BLOCK, ALLOW = 2, 0

failures = 0
cases = 0


def run(path, in_run=True, key="file_path", raw_payload=None):
    env = dict(os.environ)
    if in_run:
        env["FORGE_RUN_UUID"] = "protected-paths-test"
    else:
        env.pop("FORGE_RUN_UUID", None)
    if raw_payload is None:
        stdin = json.dumps({"tool_input": {key: path}, "tool_name": "Write"})
    else:
        stdin = raw_payload
    return subprocess.run([sys.executable, HOOK], input=stdin, text=True,
                          capture_output=True, env=env)


def case(want, path, label, **kw):
    global failures, cases
    p = run(path, **kw)
    ok = p.returncode == want
    # A block must say where to go instead, or the agent has nowhere to put the
    # work and the next thing it reaches for is the thing this hook prevents.
    if ok and want == BLOCK and "worktree" not in p.stderr:
        ok = False
        label += "  [stderr names no worktree alternative]"
    failures += not ok
    cases += 1
    print(f"  {'OK  ' if ok else 'FAIL'}  exit={p.returncode} want={want}  {label}")


def main() -> int:
    global failures, cases
    if not os.path.isfile(HOOK):
        print(f"guard-protected-paths hook not found at {HOOK}", file=sys.stderr)
        return 1

    os.makedirs(SCRATCH, exist_ok=True)
    try:
        # --- MUST BLOCK: Claude Code's configuration ------------------------
        case(BLOCK, "/root/.claude/settings.json", "settings.json (the hook registration itself)")
        case(BLOCK, "/root/.claude/settings.local.json", "settings.local.json")
        case(BLOCK, "/root/.claude/CLAUDE.md", "CLAUDE.md (Konrad's global instructions)")
        case(BLOCK, "/root/.claude/agents/builder.md", "an agent definition")

        # --- MUST BLOCK: the live host scripts ------------------------------
        case(BLOCK, "/opt/ai-os/scripts/guard-autonomy.py", "the live guard hook")
        case(BLOCK, "/opt/ai-os/scripts/guard-service-restart.py", "the live restart guard")
        case(BLOCK, "/opt/ai-os/scripts/safe-restart.sh", "a live ops script")
        case(BLOCK, "/opt/ai-os/scripts/../scripts/guard-autonomy.py",
             "the same file reached through a '..' segment")

        # --- MUST BLOCK: the guard files by their live-checkout real path ----
        case(BLOCK, "/opt/forge-ai-os/scripts/ops/guard-autonomy.py",
             "live checkout copy of the guard (glob rule)")
        case(BLOCK, "/opt/forge-ai-os/scripts/ops/guard-protected-paths.py",
             "live checkout copy of THIS hook")

        # --- MUST BLOCK: through a symlink ----------------------------------
        link_scripts = os.path.join(SCRATCH, "scripts-link")
        if not os.path.lexists(link_scripts):
            os.symlink("/opt/ai-os/scripts", link_scripts)
        case(BLOCK, os.path.join(link_scripts, "fleet-pulse.sh"),
             "symlinked directory into /opt/ai-os/scripts")

        link_claude = os.path.join(SCRATCH, "claude-link")
        if not os.path.lexists(link_claude):
            os.symlink("/root/.claude", link_claude)
        case(BLOCK, os.path.join(link_claude, "settings.json"),
             "symlinked directory into /root/.claude")

        # --- MUST BLOCK: NotebookEdit's differently-named field --------------
        case(BLOCK, "/opt/ai-os/scripts/notes.ipynb", "notebook_path field", key="notebook_path")

        # --- MUST PASS: the memory notes every worker is told to write -------
        case(ALLOW, "/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md",
             "a fleet memory index under /root/.claude/projects/")
        case(ALLOW, "/root/.claude/projects/-opt-forge-ai-os/memory/some-note.md",
             "a new fleet memory note")
        case(ALLOW, os.path.join(link_claude, "projects/-opt-forge-ai-os/memory/x.md"),
             "the same memory note reached through a symlink")

        # --- MUST PASS: the worktree copies this project exists to create ----
        case(ALLOW, os.path.join(REPO_OPS, "guard-autonomy.py"),
             "THE WORKTREE COPY of the guard -- the file agents are sent to")
        case(ALLOW, os.path.join(REPO_OPS, "install-hooks.sh"), "a worktree ops script")

        # --- MUST PASS: narrow by design ------------------------------------
        # The live checkout is protected by policy, not by this hook. Widening
        # it to /opt/forge-ai-os/** was put to Konrad and left at the default.
        case(ALLOW, "/opt/forge-ai-os/scripts/ops/safe-restart.sh",
             "live checkout, NOT a guard file (glob is narrow)")
        case(ALLOW, "/opt/forge-ai-os/scripts/ops/README.md",
             "live checkout ops README (proves the glob is not 'anything in ops/')")
        case(ALLOW, "/opt/forge-ai-os/forge-control/src/index.ts",
             "live checkout source file")
        case(ALLOW, os.path.join(SCRATCH, "ordinary.txt"), "an ordinary /tmp file")
        case(ALLOW, "/opt/ai-os/uploads/abc/shot.png", "an upload")

        # --- MUST PASS: outside a run, and on every malformed payload -------
        case(ALLOW, "/root/.claude/settings.json",
             "same protected path OUTSIDE a run (Konrad's own shell)", in_run=False)

        p = run(None, raw_payload="not json")
        ok = p.returncode == ALLOW
        failures += not ok
        cases += 1
        print(f"  {'OK  ' if ok else 'FAIL'}  exit={p.returncode} want={ALLOW}  stdin is not JSON")

        p = run(None, raw_payload=json.dumps({"tool_input": "/root/.claude/settings.json"}))
        ok = p.returncode == ALLOW
        failures += not ok
        cases += 1
        print(f"  {'OK  ' if ok else 'FAIL'}  exit={p.returncode} want={ALLOW}  tool_input is a bare string")

        p = run(None, raw_payload=json.dumps({"tool_input": {"content": "x"}}))
        ok = p.returncode == ALLOW
        failures += not ok
        cases += 1
        print(f"  {'OK  ' if ok else 'FAIL'}  exit={p.returncode} want={ALLOW}  payload carries no path at all")

        p = run(None, raw_payload="")
        ok = p.returncode == ALLOW
        failures += not ok
        cases += 1
        print(f"  {'OK  ' if ok else 'FAIL'}  exit={p.returncode} want={ALLOW}  empty stdin")
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)

    print(f"\n  {cases} cases, {failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
