#!/usr/bin/env python3
"""PreToolUse(Write|Edit|MultiEdit) guard: the hook layer is not an agent's to edit.

WHY THIS EXISTS -- 2026-08-25 (aios-guardrail-hardening, finding A5)
--------------------------------------------------------------------
`guard-autonomy.py` and `guard-service-restart.py` are PreToolUse hooks on the
**Bash** tool only. Write, Edit and MultiEdit bypass them completely, and a
file can be destroyed with Write (`content: ""`) exactly as effectively as with
a recursive delete. That gap matters most for one narrow set of files: the
guards themselves and the settings file that registers them.

The threat model is the one the 2026-08-25 Haiku incident established. That
turn was blocked, read the override recipe out of the refusal, and used it
within five seconds. It did not reason its way to disabling the guard -- but
the shortest path from "I am blocked" to "I am not blocked" is one Edit to the
hook, or one Edit to `settings.json` deleting the registration. Nothing stood
in front of either.

So this hook is deliberately NARROW. It is not a general write-protection
scheme for `/opt/forge-ai-os/**` -- that was proposed, put to Konrad in the
manager chat, and left at the default of the guard's own files only, because a
broad rule blocks ordinary builder work and a guard that blocks ordinary work
gets switched off (`guard-service-restart.py`'s own docstring records the
lesson). Three protected sets, all of them things a worktree copy exists for:

1. `/root/.claude/` -- `settings.json` and `settings.local.json` register the
   hooks; `CLAUDE.md` is Konrad's global instruction file. EXCEPT
   `/root/.claude/projects/`, where the fleet's memory notes live and every
   agent is explicitly told to write.
2. `/opt/ai-os/scripts/` -- the live host scripts, which after
   `install-symlinks.sh` are symlinks into the repo. Editing through the
   symlink writes the live checkout, which the worktree-only policy forbids.
3. `/opt/forge-ai-os/scripts/ops/guard-*.py` -- the same files reached by their
   real path rather than through the symlink. Without this the whole guard is
   one `realpath` away from being edited anyway.

BOTH THE LITERAL PATH AND ITS REALPATH ARE CHECKED, and that is not belt-and-
braces -- the first version of this hook compared only the realpath and its own
matrix caught it. `/opt/ai-os/scripts/safe-restart.sh` is ALREADY a symlink to
`/opt/forge-ai-os/scripts/ops/safe-restart.sh`, so resolving it moves the path
OUT of protected set 2 and the write sails through. This project installs the
guard hooks the same way, so a realpath-only rule would have quietly protected
set 2 down to nothing on the very deploy that ships it. Checking both directions
also closes the other one: a symlink pointing INTO a protected directory.

CONTRACT: stdin is the PreToolUse JSON payload; the path is
`tool_input.file_path` (Write/Edit/MultiEdit) or `tool_input.notebook_path`
(NotebookEdit). Exit 0 allows; exit 2 blocks and hands stderr to the model.
Any error at all -> exit 0: like every hook on this box, it fails open.
"""
import fnmatch
import json
import os
import sys

# Whole subtrees an agent may not write. Compared against the realpath.
PROTECTED_PREFIXES = (
    "/root/.claude/",
    "/opt/ai-os/scripts/",
)
# Carved back out of the above: the fleet's own memory notes. Every worker's
# system prompt tells it to write here, so protecting it would break the one
# mechanism that carries knowledge between runs.
EXEMPT_PREFIXES = (
    "/root/.claude/projects/",
)
# The guard files by their real repo path, for when the symlink is bypassed.
PROTECTED_GLOBS = (
    "/opt/forge-ai-os/scripts/ops/guard-*.py",
)

BLOCK = """BLOCKED locally: {what} is not an agent's file to edit.

  attempted: {path}
  resolved:  {real}

{advice}

This is a local decision -- no rule row was consulted and no override applies.
If the guard layer genuinely needs to change, change it in the worktree, commit
it, and let a task briefed as DEPLOY install it. Editing the live copy from a
build task is exactly what the worktree-only policy exists to prevent, and
editing it from a run that has just been blocked is the thing this hook is for.
"""


def resolve(path: str) -> str:
    try:
        return os.path.realpath(path)
    except Exception:
        return path


def candidates(path: str):
    """Every name this write reaches the filesystem under.

    Three of them, because two are not enough:

    * the LITERAL path -- `/opt/ai-os/scripts/safe-restart.sh` is a symlink into
      the live checkout, so resolving it moves it out of protected set 2;
    * the path with only its PARENT resolved -- a symlink to the protected
      DIRECTORY (`/tmp/x/link -> /opt/ai-os/scripts`) leaves both the literal
      path and the fully-resolved path outside the set, and the write still
      lands on a live ops script;
    * the fully resolved REALPATH -- the file reached by its own real name.

    A relative path is made absolute against THIS PROCESS's cwd, which is the
    agent's cwd only by convention -- Write/Edit hand over absolute paths in
    practice. A relative path that guesses wrong fails open, like everything
    else here.
    """
    try:
        literal = os.path.normpath(os.path.abspath(path))
    except Exception:
        return [path]
    parent, base = os.path.split(literal)
    out = [literal]
    for p in (os.path.join(resolve(parent), base), resolve(literal)):
        if p not in out:
            out.append(p)
    return out


def _judge(p: str, name: str):
    for glob in PROTECTED_GLOBS:
        if fnmatch.fnmatch(p, glob):
            return (
                "the live checkout's copy of a guard hook",
                f"Edit your worktree's copy instead: <your-worktree>/scripts/ops/{name}",
            )
    if p.startswith(EXEMPT_PREFIXES):
        return None
    for prefix in PROTECTED_PREFIXES:
        if not p.startswith(prefix):
            continue
        if prefix == "/root/.claude/":
            return (
                "Claude Code's own configuration",
                "Hook registration is generated, not hand-edited: the canonical "
                "entries live in scripts/ops/hooks.settings.json and are merged "
                "into every account's settings.json by scripts/ops/install-hooks.sh. "
                "Change those in your worktree.",
            )
        return (
            "a live host operations script",
            f"Edit your worktree's copy instead: <your-worktree>/scripts/ops/{name} "
            "(/opt/ai-os/scripts/ is symlinked to it by scripts/ops/install-symlinks.sh).",
        )
    return None


def verdict(path: str):
    """(what, advice) when the write must be blocked, else None.

    Blocked if EITHER the literal path or its realpath lands in a protected
    set. The exemption is per-candidate, so a symlink sitting under
    /root/.claude/projects/ cannot launder a write into /root/.claude itself.
    """
    name = os.path.basename(resolve(path))
    for p in candidates(path):
        hit = _judge(p, name)
        if hit:
            return hit
    return None


def _main() -> int:
    # Konrad at his own keyboard is not what this guards.
    if not os.environ.get("FORGE_RUN_UUID"):
        return 0
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(path, str) or not path:
        return 0

    hit = verdict(path)
    if not hit:
        return 0
    what, advice = hit
    print(BLOCK.format(what=what, path=path, real=resolve(path), advice=advice),
          file=sys.stderr)
    return 2


def main() -> int:
    """0 and 2 are the only exit codes; anything unexpected is a fail-open 0."""
    try:
        return 2 if _main() == 2 else 0
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
