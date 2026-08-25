#!/usr/bin/env python3
"""PreToolUse(Bash) guard: consult the autonomy rules before a dangerous shell command.

WHY THIS EXISTS -- measured 2026-08-25
--------------------------------------
`guardrail_rules` held 9 rules and the console let Konrad toggle them. Exactly
one call site ever evaluated them: `executor.ts processRun()`, category
`financial`, at run start. `grep -rn "autonomy/check"` across /opt/forge-ai-os
returned ZERO callers, and the `guardrail()` middleware was mounted on one
route -- the autonomy router guarding itself.

So `fs.destructive`, `git.force_push` and `comm.outbound` were enabled in the
database and enforced by nothing but each agent's system prompt. A worker that
ran a recursive delete or force-pushed main tripped no rule and wrote no
`guardrail_trips` row. The policy existed; the enforcement did not.

This is that missing call site. It classifies the command locally, then asks
`POST /api/autonomy/check` -- so the rule Konrad toggles in the console is the
rule that decides.

DESIGN CONSTRAINTS, each one load-bearing
-----------------------------------------
1. FAIL OPEN. This hook runs before every Bash call from every agent turn on
   the box. A hung API, a 500, a DB blip or a bug in here must not wedge the
   fleet. Any error at all -> exit 0.
2. DO NOT BLOCK THE ORDINARY PATH. `guard-service-restart.py` already records
   the lesson: "a guard that blocks the ordinary deploy is a guard someone
   switches off, which then guards nothing." Clearing `node_modules` and a
   /tmp scratch dir is what builders do all day -- they are ROUTINE and pass.
   `deploy.prod` and `secrets.read` are deliberately NOT wired for the same
   reason: deploying and reading a secret are the normal path.
3. AUTHORIZED WORK MUST STILL BE POSSIBLE. The rules mean "Konrad must have
   said so in the current task" -- a fact this hook cannot see. So a block is
   escapable with an explicit acknowledgement env prefix, which is logged and
   notified. The point was never to make destruction impossible; it was to
   make it deliberate and auditable.

ROUND 1 HARDENING -- 2026-08-25 (aios-guardrail-hardening)
----------------------------------------------------------
Round 0 measured this file against 2,924 real Bash calls from 48 runs and found
both halves of the failure: it missed everything behind a wrapper, and it
blocked builders' own scratch. Five of the ten trips in 24h were false
positives, one of which converted a self-cleaning probe into a leftover
database. What changed, with the decision behind each, is written up in
`docs/plan/aios-guardrail-hardening/02-classifier-decisions.md`:

* ONE TOKENISER. `segments()` used to split on `[;&|\\n]+` with a regex BEFORE
  quoting was parsed, so a `;` inside a commit message desegmented the command
  (measured false positive) while quoting could equally hide an operator. It is
  now `shlex(posix=True, punctuation_chars="();<>|&\\n", whitespace_split=True)`,
  split on operator TOKENS. `( … )`, `{ … }` and redirections fall out for free.
  Unbalanced quotes degrade to a partial parse; nothing here ever raises.

  THE NEWLINE IS IN THAT PUNCTUATION SET ON PURPOSE and the first draft of this
  rewrite left it out. shlex's stock `whitespace` is ' \\t\\r\\n' and whitespace
  is discarded before punctuation is considered, so a newline simply vanished
  and two lines became ONE segment whose head was the first line's command --
  every rule after the head then never ran. Measured against the draft: of six
  newline-separated destructive commands it caught one, where the regex-split
  version it replaces caught four. A tokeniser rewrite that improves quoting
  and loses the newline is a net regression. `is_operator()` also accepts a RUN
  of operator characters, because shlex emits `'\\n\\n\\n'` and `';\\n'` as
  single tokens that a set-membership test would miss the same way.
* REDIRECTION FILE DESCRIPTORS are stripped before tokenising: the `2` of
  `2>&1` arrived as an rm ARGUMENT, so `rm -rf .next 2>&1` classified with
  targets ['.next', '2'] and tripped on the '2'. `… 2>&1` is on a large share
  of the fleet's Bash calls, which made this a false-positive engine rather
  than an edge case -- it accounted for 2 of the 3 corpus trips that survived
  the first pass of the routine rules. Adjacency is the discriminator and only
  the raw string has it, so the digit run must begin right after whitespace:
  `rm -rf dir2>&1` still targets `dir2`, exactly as bash reads it.
* LINE CONTINUATIONS (`\\` + newline) are joined first, as a shell does before
  word splitting. Without that step the newline fix above turns `git push \\` /
  `--force origin main` into a bare `git push` plus a segment headed `--force`,
  and the force push disappears -- a fix creating the hole it just closed.
* TRANSPARENT HEADS are stepped over before the verb is read: sudo, env, nice,
  timeout, nohup, time, command, exec, xargs, `docker exec <container>`,
  `ssh [opts] host`, and `bash|sh|zsh|dash -c <string>` / `eval` (classified
  recursively, depth-capped). Command substitutions -- `$(…)` and backticks --
  are extracted and classified too.
* GIT global options are parsed before the verb, so `git -C /opt/x push --force
  origin main` resolves to `main` instead of `origin` (it tripped before, and
  the control plane then ALLOWED it because "origin" is not a protected branch
  -- a block that silently wasn't one). `+refspec`, `--delete`/`-d` and
  `--mirror` are force pushes too.
* ROUTINE PATHS are the false-positive half: any routine basename ANYWHERE in
  the path, relative targets resolved against cwd, anything strictly inside a
  project worktree or /opt/ai-os/scratch/, and self-created scratch (a
  `VAR=$(mktemp -d)` or a `CREATE DATABASE` earlier in the SAME command).
  `/opt/ai-os/uploads/` and every worktree ROOT stay guarded.

  `cd` is WALKED FORWARD across the segments, because the one instance of the
  relative-target rule in the whole 24h corpus is `cd /tmp && rm -rf
  main-check` (run dd8e66f0) -- judged against the run's recorded cwd rather
  than the directory it walked to, that rule fires on nothing and is a rule in
  name only. A destination this hook cannot resolve (`cd $X`, `cd -`, bare
  `cd`) makes the cwd UNKNOWN, which is the conservative value: only the
  routine-basename rule can still speak, so an unplaceable relative target
  stays blocked. It opens no evasion -- `cd /tmp && rm -rf ../opt/forge-ai-os`
  is normpath'd back to /opt/forge-ai-os and still trips.

  `/opt/ai-os/browser-profiles/scratch` (and its `.state/` twin) is routine:
  it is the disposable profile in research-browser.mjs's own usage line and two
  builders deleted it as cleanup in 24h. Its SIBLINGS are not -- `perplexity`,
  `os-ui` and the r7xx profiles are Chrome user-data-dirs holding logged-in
  session cookies, and fleet policy is explicit that a login wall is the one
  thing an agent does not solve itself. So the profile named `scratch` passes
  and the directory holding it does not.
* RECURSION ALONE TRIGGERS `fs.destructive`. The condition was `recursive AND
  force`, which pattern-matched the idiom `rm -rf` instead of reasoning about
  destructiveness -- `-f` only suppresses prompts, it removes nothing extra. A
  lane ran `rm -r src/routes` on 2026-08-25 and deleted all 48 tracked files of
  forge-control's API surface without the guard reaching its own allowlist;
  `rm -r /opt/forge-ai-os` was allowed by the same hole. `-r` without `-f`
  occurs 0 times in the 24h corpus, so the correction costs zero new trips.
  `-f` without `-r` stays uncaught on purpose -- all 27 such calls are routine
  scratch cleanup. See 02-classifier-decisions.md §2(c).
* NEW LOCAL RULE `autonomy.self_edit`. An agent curling `/api/autonomy/rules`
  or `/api/autonomy/trips/<id>/resolve` is reaching for the rule that is
  blocking it, or for the record that it was blocked. That endpoint is
  unauthenticated on localhost and writes no audit row, so the block is LOCAL:
  no API round-trip, no acknowledgement path, like guard-service-restart.py.
  The console is Konrad's surface.
* CONTRACT: exit codes are 0 and 2 only -- `main()` is wrapped so any exception
  is a fail-open 0 (a `tool_input` that was a bare string used to exit 1 with a
  traceback). A 200 body without a boolean `allow` is a fail-open with an audit
  line instead of a silent allow. `FORGE_GUARD_AUDIT_LOG` overrides the log
  path so the test suite never writes to /var/log.
* HEREDOC bodies now end only on an EXACT marker line (leading tabs allowed for
  `<<-`), matching bash. An indented `  EOF` inside prose used to terminate the
  body early and hand the rest of the note to the classifier as commands.

CONTRACT: stdin is the PreToolUse JSON payload. Exit 0 allows; exit 2 blocks
and hands stderr back to the model as feedback.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = os.environ.get("FORGE_API", "http://127.0.0.1:7700")
TIMEOUT_S = 2.5
AUDIT_LOG = os.environ.get("FORGE_GUARD_AUDIT_LOG") or "/var/log/forge-guard-autonomy.log"
STRIP = "\"'`"

# How deep a wrapper chain is followed (bash -c "ssh host 'bash -c …'").
MAX_DEPTH = 4
# How many transparent heads may be stepped over in one segment before we give
# up. A bound, not a limit anyone reaches: the deepest real shape measured is
# `sudo docker exec -i <c> psql` at three.
MAX_UNWRAP = 12

# rm targets that are build artefacts or scratch: routine, never escalated.
# Matched against every COMPONENT of the path, not just the basename -- round 0
# measured `rm -rf .next/types` blocked twice in 24h because only the tail was
# checked.
ROUTINE_BASENAMES = {
    "node_modules", ".next", "dist", "build", ".turbo", "coverage",
    ".cache", "__pycache__", ".pytest_cache", ".venv", "out", ".nuxt",
}
ROUTINE_PREFIXES = ("/tmp/", "/var/tmp/", "/dev/shm/", "/opt/ai-os/scratch/")

# Exactly these directories, and their subtrees, are routine.
#
# research-browser.mjs names its disposable profile `scratch` -- it is the
# profile in the tool's own usage line (`research-browser.mjs open scratch`),
# and two builders in the measured 24h deleted it as ordinary cleanup. Its
# SIBLINGS are not disposable: /opt/ai-os/browser-profiles/ also holds
# `perplexity`, `os-ui` and the r7xx round profiles, which are Chrome
# user-data-dirs carrying LOGGED-IN SESSION COOKIES. Deleting one of those
# destroys a login only Konrad can restore -- fleet policy is explicit that a
# login wall is the one thing an agent does not solve itself. So the profile
# named `scratch` is routine and the directory holding it is not.
ROUTINE_EXACT = (
    "/opt/ai-os/browser-profiles/scratch",
    "/opt/ai-os/browser-profiles/.state/scratch",
)
# Where the fleet's own worktrees live. A path strictly INSIDE one is that
# agent's own scratch; the root itself is the checkout and stays guarded.
WORKTREE_ROOT = "/opt/ai-os/workspace/projects"
# Evidence Konrad looks at, inside an otherwise routine-looking tree.
GUARDED_PREFIXES = ("/opt/ai-os/uploads/",)

# Operator tokens that end a segment. `{`/`}` and redirections are here so a
# grouped or redirected command is still read as a command.
OPERATORS = {
    ";", ";;", "&&", "||", "|", "|&", "&", "(", ")", "{", "}", "\n",
    ">", ">>", "<", "<<", "<<<", ">&", "&>", "&>>", "2>", "2>>", "<>",
}

SCRATCH_DB_RE = re.compile(r"(scratch|probe|tmp|test|selftest)", re.I)
DESTRUCTIVE_SQL_RE = re.compile(
    r"\b(DROP\s+DATABASE|DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE|FLUSHALL|FLUSHDB)\b"
    r"(?:\s+IF\s+EXISTS)?(?:\s+TABLE)?\s*\"?([A-Za-z0-9_$.]*)",
    re.I,
)
SELF_EDIT_RE = re.compile(r"/api/autonomy/(rules|trips/[^/\s]+/resolve)")
OUTBOUND_HOST_RE = re.compile(
    r"api\.telegram\.org|hooks\.slack\.com|/services/T[0-9A-Z]", re.I
)


def strip_heredocs(cmd: str) -> str:
    """Remove heredoc BODIES, keeping the command lines around them.

    Borrowed from guard-service-restart.py, where it was learned the hard way:
    the first thing that hook ever blocked was the memory note documenting the
    incident, because the prose inside a `cat <<'EOF'` body contained the very
    command being described. This guard has the same exposure -- fleet notes and
    briefs discuss recursive deletes and force-pushes constantly, and a guard
    that cannot tell prose from an invocation makes its own documentation
    unwritable.

    The body ends on an EXACT marker line, which is what bash does. Round 0's
    version compared `lines[i].strip() == marker`, so an indented `  EOF` inside
    the prose ended the body early and the remaining note lines were classified
    as commands. Only `<<-` strips leading TABS (not spaces), so only `<<-`
    accepts an indented marker here.
    """
    out, lines = [], cmd.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r"<<(-?)\s*[\"']?([A-Za-z_][A-Za-z0-9_]*)[\"']?", line)
        i += 1
        if not m:
            continue
        dash, marker = m.group(1), m.group(2)
        while i < len(lines):
            candidate = lines[i].lstrip("\t") if dash else lines[i]
            if candidate == marker:
                break
            i += 1
        if i < len(lines):
            i += 1  # drop the closing marker too
    return "\n".join(out)


def tokenize(cmd: str):
    """Tokenise like a shell, never raise.

    An unbalanced quote yields a PARTIAL token list (everything parsed before
    the fault) rather than an exception or a naive whitespace split. That is
    conservative in the allow direction -- the tail of a malformed command is
    invisible to the classifier -- and that is the documented trade: this hook
    fails open by design, and a shell would not have run the malformed tail
    either.
    """
    # A shell joins `\<newline>` into nothing at all, BEFORE it splits words.
    # Do the same here, and do it first: with the newline left in place the
    # continued line becomes its own segment, so `git push \` / `--force origin
    # main` reads as a bare `git push` followed by a segment whose head is
    # `--force`, and the force push disappears. Collapsing inside a quoted
    # string is harmless -- the quotes still bound the token, so no operator is
    # created or destroyed, only a newline in a message body becomes a space.
    cmd = re.sub(r"\\\r?\n", " ", cmd)

    # Drop the file-descriptor prefix of a redirection: the `2` of `2>&1`.
    #
    # shlex splits `2>&1` into ['2', '>&', '1'], and that leading `2` then
    # arrives as an rm ARGUMENT -- so `rm -rf .next 2>&1` was classified with
    # targets ['.next', '2'], and since '2' is not a routine path the whole
    # command tripped. Two of the three surviving corpus trips were exactly
    # this, and `… 2>&1` is in a large fraction of the fleet's Bash calls, so
    # the shape is a false-positive engine rather than an edge case.
    #
    # Adjacency is the discriminator and it is only visible in the RAW string:
    # bash reads `rm -rf dir2>&1` as the word `dir2` plus a redirection, and
    # `rm -rf x 2>&1` as the word `x` plus fd 2. Requiring the digit run to
    # begin immediately after whitespace reproduces exactly that rule, so a
    # directory genuinely named `2` is still a target when written `rm -rf 2;`.
    cmd = re.sub(r"(^|\s)\d+(?=[<>])", r"\1", cmd)

    # punctuation_chars='();<>|&\n' is the stock set PLUS the newline.
    #
    # This is load-bearing and was measured the hard way. shlex's default
    # `whitespace` is ' \t\r\n', and whitespace is discarded before punctuation
    # is even considered -- so with the stock settings a newline vanishes and
    # `ls -la` + `git push --force origin main` on two lines tokenise into ONE
    # segment whose head is `ls`. Every rule after the head then never runs.
    # Measured against this file mid-round: of six newline-separated
    # destructive commands, the version without this line caught one; the
    # regex-splitting hook it replaces caught four.
    lex = shlex.shlex(cmd, posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    out = []
    try:
        for tok in lex:
            out.append(tok)
    except ValueError:
        pass
    if not out:
        out = cmd.split()
    return out


OPERATOR_CHARS = set(";&|()<>{}\n")


def is_operator(tok: str) -> bool:
    """Does this token end a segment?

    A membership test against OPERATORS alone is not enough: shlex emits a RUN
    of punctuation characters as a single token, so three blank lines arrive as
    `'\\n\\n\\n'` and `ls;` + newline arrives as `';\\n'`. Neither is in
    OPERATORS, and either one silently glues the next command onto this
    segment -- the same class of miss as dropping the newline entirely.
    """
    return bool(tok) and (tok in OPERATORS or all(c in OPERATOR_CHARS for c in tok))


def segments(cmd: str):
    """Yield (words, env_assignments) for each shell segment.

    env is returned so a caller can see an acknowledgement prefix.
    """
    words: list = []
    for tok in tokenize(cmd):
        if is_operator(tok):
            got = _segment(words)
            if got:
                yield got
            words = []
        else:
            words.append(tok)
    got = _segment(words)
    if got:
        yield got


def _segment(words):
    if not words:
        return None
    env = {}
    i = 0
    while i < len(words) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[i]):
        k, _, v = words[i].partition("=")
        env[k] = v
        i += 1
    if i >= len(words):
        return None
    return words[i:], env


def substitution_bodies(cmd: str):
    """Bodies of `$(…)` and backtick substitutions, non-nested.

    Needed because a substitution inside DOUBLE QUOTES survives tokenisation as
    one token: `echo "$(rm -rf /opt/x)"` is a single word to shlex.
    """
    for m in re.finditer(r"\$\(([^()]*)\)", cmd):
        yield m.group(1)
    for m in re.finditer(r"`([^`]*)`", cmd):
        yield m.group(1)


# ---------------------------------------------------------------------------
# Command context: facts about the WHOLE command that make a later segment
# routine. Scanned from the raw string once, then passed down every recursion.
# ---------------------------------------------------------------------------

def scan_context(cmd: str) -> dict:
    mktemp_vars = set()
    for m in re.finditer(
        r"([A-Za-z_][A-Za-z0-9_]*)=[\"']?(?:\$\(\s*mktemp|`\s*mktemp)", cmd
    ):
        mktemp_vars.add(m.group(1))
    created_dbs = set()
    for m in re.finditer(
        r"CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?\"?([A-Za-z0-9_$]+)", cmd, re.I
    ):
        created_dbs.add(m.group(1).lower())
    return {"mktemp_vars": mktemp_vars, "created_dbs": created_dbs}


def _var_name(target: str):
    """`$TMPD` / `${TMPD}` / `${TMPD:-x}` -> TMPD, else None."""
    m = re.match(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)", target)
    return m.group(1) if m else None


def is_routine_path(p: str, cwd: str, ctx: dict) -> bool:
    """Is this delete target ordinary builder scratch?

    Rules are the enumerated set from findings P2-2. Anything not on the list
    is NOT routine -- including a `$VAR` this hook cannot resolve, which is the
    one unresolvable shape left after the mktemp rule (measured once in 24h).
    """
    p = p.strip().strip(STRIP)
    if not p:
        return True

    var = _var_name(p)
    if var is not None:
        # Rule 4: the same command created it, so removing it is cleanup.
        # Rule 5: any other variable stays blocked -- the value is invisible here.
        return var in ctx["mktemp_vars"]

    # Rule 2: a relative target means "inside cwd"; resolve it before judging.
    if not p.startswith("/"):
        if cwd is None:
            # The command cd'd somewhere this hook cannot resolve. Only rule 1
            # can still speak, on the literal components -- `rm -rf dist` is
            # routine wherever it is run; `rm -rf data` is not.
            parts = [c for c in p.split("/") if c and c != ".."]
            return any(c in ROUTINE_BASENAMES for c in parts)
        p = os.path.normpath(os.path.join(cwd or "/", p))
    else:
        p = os.path.normpath(p)

    if p.startswith(GUARDED_PREFIXES):
        return False
    if p.startswith(ROUTINE_PREFIXES):
        return True
    if p in ROUTINE_EXACT or p.startswith(tuple(e + "/" for e in ROUTINE_EXACT)):
        return True
    # Rule 3: strictly inside a project worktree, never the worktree root.
    if p.startswith(WORKTREE_ROOT + "/"):
        rest = p[len(WORKTREE_ROOT) + 1:]
        if "/" in rest.strip("/"):
            return True
        return False
    # Rule 1: a routine basename ANYWHERE in the path, not just the tail.
    parts = [c for c in p.split("/") if c]
    return any(c in ROUTINE_BASENAMES for c in parts)


# ---------------------------------------------------------------------------
# Transparent heads
# ---------------------------------------------------------------------------

def _skip_opts(rest, valued: set) -> int:
    """Index of the first non-option token, stepping over `-x <value>` pairs."""
    i = 0
    while i < len(rest) and rest[i].startswith("-") and rest[i] != "--":
        i += 2 if rest[i] in valued else 1
    if i < len(rest) and rest[i] == "--":
        i += 1
    return i


SHELLS = ("bash", "sh", "zsh", "dash", "ksh")
PASSTHROUGH = ("nohup", "time", "command", "builtin", "exec", "stdbuf", "setsid")
SSH_VALUED = {"-i", "-p", "-o", "-l", "-F", "-J", "-L", "-R", "-W", "-b", "-c",
              "-D", "-E", "-e", "-I", "-m", "-S", "-w"}
XARGS_VALUED = {"-n", "-P", "-I", "-a", "-d", "-E", "-L", "-s", "-i", "--max-args",
                "--max-procs", "--replace", "--arg-file", "--delimiter"}
DOCKER_EXEC_VALUED = {"-e", "--env", "-u", "--user", "-w", "--workdir", "-l",
                      "--label", "--env-file", "--detach-keys"}


def classify(cmd: str, cwd: str, _depth: int = 0, _ctx=None):
    """Return (rule_id, payload, human_action) for the first rule the command
    would trip, or None. Conservative by construction: when in doubt, allow."""
    if _depth > MAX_DEPTH:
        return None
    ctx = _ctx if _ctx is not None else scan_context(cmd)

    # A substitution inside double quotes is one shlex token, so it has to be
    # dug out of the raw string separately.
    for body in substitution_bodies(cmd):
        hit = classify(body, cwd, _depth + 1, ctx)
        if hit:
            return hit

    # Effective cwd, walked forward across the segments. `cd /tmp && rm -rf
    # main-check` is the shape routine-rule 2 exists for, and it is the ONLY
    # instance of that rule in the measured 24h corpus (run dd8e66f0) -- judged
    # against the run's recorded cwd instead of the one it walked to, rule 2
    # fires on nothing at all and is a rule in name only.
    eff_cwd = cwd
    for words, _env in segments(cmd):
        hit = classify_segment(words, eff_cwd, ctx, _depth)
        if hit:
            return hit
        eff_cwd = apply_cd(words, eff_cwd)
    return None


# `~` is $HOME, a glob may match several dirs, `$X` and a substitution are
# invisible here: each makes the destination unknowable rather than wrong.
UNRESOLVABLE_CD = re.compile(r"[$`*?~\[]")


def apply_cd(words, cwd):
    """The cwd after this segment, or None when the destination is unknowable.

    None is the SAFE value, not the permissive one: is_routine_path() with an
    unknown cwd falls back to rule 1 alone, so a relative target it cannot
    place is not routine and stays blocked. This opens no evasion -- an
    absolute target is resolved without reference to cwd at all, and a relative
    one is normpath'd after the join, so `cd /tmp && rm -rf ../opt/forge-ai-os`
    still resolves to /opt/forge-ai-os and still trips.
    """
    if not words:
        return cwd
    head = os.path.basename(words[0].strip(STRIP))
    if head not in ("cd", "pushd"):
        return cwd
    args = [w for w in words[1:] if not w.startswith("-")]
    if not args:
        return None                       # bare `cd` -> $HOME
    target = args[0].strip(STRIP)
    if not target or target == "-" or UNRESOLVABLE_CD.search(target):
        return None
    if target.startswith("/"):
        return os.path.normpath(target)
    if cwd is None:
        return None
    return os.path.normpath(os.path.join(cwd, target))


def classify_segment(words, cwd: str, ctx: dict, depth: int):
    words = list(words)
    # Set when the real targets arrive on stdin (xargs) and are invisible here.
    unknown_targets = False

    for _ in range(MAX_UNWRAP):
        if not words:
            return None
        head = os.path.basename(words[0].strip(STRIP))
        rest = words[1:]

        if head == "sudo":
            words = rest[_skip_opts(rest, {"-u", "-g", "-p", "-C", "--user", "--group"}):]
            continue
        if head == "env":
            i = 0
            while i < len(rest) and (
                rest[i] in ("-i", "--ignore-environment", "-v", "-0")
                or "=" in rest[i]
            ):
                i += 1
            if i < len(rest) and rest[i] in ("-u", "--unset"):
                i += 2
            words = rest[i:]
            continue
        if head == "nice":
            words = rest[_skip_opts(rest, {"-n", "--adjustment"}):]
            continue
        if head == "timeout":
            i = _skip_opts(rest, {"-s", "--signal", "-k", "--kill-after"})
            words = rest[i + 1:]  # step over the DURATION too
            continue
        if head in PASSTHROUGH:
            words = rest
            continue
        if head == "xargs":
            words = rest[_skip_opts(rest, XARGS_VALUED):]
            unknown_targets = True
            continue
        if head == "docker" and rest and rest[0] == "exec":
            i = _skip_opts(rest[1:], DOCKER_EXEC_VALUED)
            inner = rest[1 + i:]
            words = inner[1:]  # step over the container name
            continue
        if head == "ssh":
            i = _skip_opts(rest, SSH_VALUED)
            remote = rest[i + 1:]  # step over [user@]host
            if not remote:
                return None  # an interactive session; nothing to classify
            return classify(" ".join(remote), cwd, depth + 1, ctx)
        if head in SHELLS:
            script = _shell_c_argument(rest)
            if script is None:
                return None  # `bash script.sh` -- the body is a file, not visible
            return classify(script, cwd, depth + 1, ctx)
        if head == "eval":
            if not rest:
                return None
            return classify(" ".join(rest), cwd, depth + 1, ctx)
        break
    else:
        return None

    return match_rules(head, rest, words, cwd, ctx, unknown_targets)


def _shell_c_argument(rest):
    """The script string of `sh -c <s>` / `bash -lc <s>`, or None."""
    for i, tok in enumerate(rest):
        if re.match(r"^-[a-zA-Z]*c$", tok) and i + 1 < len(rest):
            return rest[i + 1]
    return None


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def match_rules(head: str, rest, words, cwd: str, ctx: dict, unknown_targets: bool):
    joined_words = " ".join(words)
    joined_rest = " ".join(rest)

    # --- autonomy.self_edit (LOCAL block, no API round-trip) ----------------
    # Deliberately first: the whole point is that it is decided here, not by an
    # endpoint the command is on its way to change.
    if head in ("curl", "wget", "http", "httpie") and SELF_EDIT_RE.search(joined_rest):
        return (
            "autonomy.self_edit",
            {"command": joined_words[:400]},
            "edit the autonomy rules / resolve a guardrail trip via the API",
        )

    # --- git.force_push -----------------------------------------------------
    # A real evaluator with `protected_branches` config, so this is a semantic
    # check, not a blanket one: force-pushing a project/* lane passes,
    # force-pushing main does not.
    if head == "git":
        hit = match_git(rest, cwd)
        if hit:
            return hit

    # --- fs.destructive -----------------------------------------------------
    if head == "rm":
        flags = "".join(w[1:] for w in rest if w.startswith("-") and not w.startswith("--"))
        longs = {w for w in rest if w.startswith("--")}
        recursive = "r" in flags.lower() or "--recursive" in longs
        targets = [w for w in rest if not w.startswith("-")]

        # RECURSION ALONE IS THE TRIGGER. `-f` is deliberately NOT required.
        #
        # This condition used to read `recursive and force`, which was the
        # idiom `rm -rf` pattern-matched rather than a statement about
        # destructiveness. `-f` only suppresses prompts and ignores missing
        # files; it adds nothing to how much a command removes. `rm -r <dir>`
        # and `rm -rf <dir>` delete the same tree.
        #
        # It cost exactly what you would expect. On 2026-08-25 a lane ran
        #     rm -r src/routes
        # and removed all 48 tracked files of forge-control's API surface. The
        # guard never even reached the routine-path allowlist, because of the
        # missing `-f`. Measured against the hardened classifier before this
        # change, `rm -r /opt/forge-ai-os` -- the entire live checkout -- was
        # likewise ALLOWED, as were `rm -R` and `rm --recursive`.
        #
        # Dropping `force` is close to free: `-r` WITHOUT `-f` occurs **0 times
        # in the 24h corpus** (52 rm calls in 2,924 commands; 20 are `-rf`, 27
        # are `-f` without `-r`, 5 have neither). So this catches the real
        # command at a measured cost of zero new trips.
        #
        # `-f` WITHOUT `-r` stays uncaught, and that IS a false-positive
        # tradeoff rather than a claim about destructiveness: those 27 calls are
        # all legitimate /tmp probe cleanup, one line of which removes 13 files.
        # A rule firing on them is the kind that gets the guard switched off.
        if recursive:
            if unknown_targets and not targets:
                # `… | xargs rm -r` -- the targets are on stdin. Nothing here
                # can judge them, and the verb is total, so it escalates.
                return (
                    "fs.destructive",
                    {"command": joined_words[:400], "targets": []},
                    "recursive delete of targets piped in via xargs",
                )
            if targets and not all(is_routine_path(t, cwd, ctx) for t in targets):
                return (
                    "fs.destructive",
                    {"command": joined_words[:400], "targets": targets[:8]},
                    f"recursive delete: {' '.join(targets[:3])}",
                )

    if head == "pm2" and rest and rest[0].strip(STRIP) in ("delete", "del"):
        return (
            "fs.destructive",
            {"command": joined_words[:400]},
            " ".join(words[:3]),
        )

    if head in ("docker", "docker-compose", "podman"):
        hit = match_docker(head, rest, joined_words)
        if hit:
            return hit

    if head == "find" and ("-delete" in rest or ("-exec" in rest and "rm" in rest)):
        roots = [w for w in rest[:2] if not w.startswith("-")]
        if roots and not all(is_routine_path(r, cwd, ctx) for r in roots):
            return (
                "fs.destructive",
                {"command": joined_words[:400]},
                f"find {' '.join(roots)} -delete",
            )

    if head in ("psql", "mysql", "mongo", "redis-cli"):
        hit = match_db(head, rest, joined_words, ctx)
        if hit:
            return hit

    # --- comm.outbound ------------------------------------------------------
    # "SENDING email requires an explicit instruction in the CURRENT task" is
    # already the stated policy. This is where it becomes a fact. The host match
    # is case-insensitive: DNS is, so a capitalised host reached the API while
    # the guard read past it.
    if head in ("curl", "wget", "http", "httpie") and OUTBOUND_HOST_RE.search(joined_rest):
        return (
            "comm.outbound",
            {"command": joined_words[:400]},
            "outbound message to an external chat service",
        )
    if "google_api.py" in joined_words and re.search(r"\bgmail\b.*\bsend\b", joined_rest):
        return (
            "comm.outbound",
            {"command": joined_words[:400]},
            "gmail send",
        )
    return None


GIT_GLOBAL_VALUED = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
PUSH_VALUED = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}


def match_git(rest, cwd: str):
    """Force-push detection with git's GLOBAL options parsed before the verb.

    `git -C /opt/x push --force origin main` used to resolve to branch "origin"
    -- `-C`'s VALUE was counted as the first positional. The control plane then
    allowed it, because "origin" is not in `protected_branches`. A block that
    silently is not one is worse than no block.
    """
    i = 0
    while i < len(rest) and rest[i].startswith("-"):
        if rest[i] in GIT_GLOBAL_VALUED:
            i += 2
        else:
            i += 1
    if i >= len(rest) or rest[i] != "push":
        return None
    args = rest[i + 1:]

    opts = [w for w in args if w.startswith("-")]
    positionals, j = [], 0
    while j < len(args):
        if args[j].startswith("-"):
            j += 2 if args[j] in PUSH_VALUED else 1
            continue
        positionals.append(args[j])
        j += 1

    forced = any(o == "-f" or o.startswith("--force") for o in opts)
    mirror = "--mirror" in opts
    deleting = "--delete" in opts or "-d" in opts
    plus_refspec = any(p.startswith("+") for p in positionals)

    if not (forced or mirror or deleting or plus_refspec):
        return None

    branch = force_push_branch(positionals, cwd, mirror)
    if deleting:
        verb = "delete the remote branch"
    elif mirror:
        verb = "push --mirror (force-updates every ref)"
    else:
        verb = "force-push"
    return ("git.force_push", {"branch": branch}, f"{verb} -> {branch}")


def force_push_branch(positionals, cwd: str, mirror: bool = False) -> str:
    """Best-effort branch name for a force push.

    Explicit refspec wins (`git push -f origin HEAD:main` -> main). `--mirror`
    force-updates every ref including main, so it is judged as main. With no
    refspec the push goes to the current branch, so ask git -- cheaply, with a
    timeout, and never let a failure here raise.
    """
    if len(positionals) >= 2:
        ref = positionals[1].lstrip("+")
        return ref.split(":")[-1]
    if mirror:
        return "main"
    try:
        out = subprocess.run(
            ["git", "-C", cwd or ".", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=1.5,
        )
        if out.returncode == 0:
            return out.stdout.strip() or "HEAD"
    except Exception:
        pass
    return "HEAD"


def match_docker(head: str, rest, joined_words: str):
    """Total-loss docker verbs. `cf-postgres` lives in a docker volume, so
    these delete the fleet's database as surely as a recursive rm would --
    and unlike `docker rm <container>` they are never part of routine work."""
    args = [w for w in rest if not w.startswith("-")]
    flags = [w for w in rest if w.startswith("-")]

    if head == "docker-compose" or (args[:1] == ["compose"]):
        sub = args[1:] if head == "docker" else args
        if sub[:1] == ["down"] and any(f in ("-v", "--volumes") for f in flags):
            return ("fs.destructive", {"command": joined_words[:400]},
                    "docker compose down with volume removal")
        return None
    if args[:2] == ["volume", "rm"] or args[:2] == ["volume", "prune"]:
        return ("fs.destructive", {"command": joined_words[:400]},
                f"docker {' '.join(args[:3])}")
    if args[:2] == ["system", "prune"] and any(
        f == "--volumes" or f.startswith("--volumes") for f in flags
    ):
        return ("fs.destructive", {"command": joined_words[:400]},
                "docker system prune --volumes")
    return None


DB_NAME_OPTS = {"-d", "--dbname", "-D", "--database"}


def connected_db(rest):
    """The database a client command is pointed at: `-d <n>`, `--dbname=<n>`,
    or the path of a connection URL. None when it cannot be told."""
    for i, w in enumerate(rest):
        if w in DB_NAME_OPTS and i + 1 < len(rest):
            return rest[i + 1].strip(STRIP)
        if w.startswith("--dbname=") or w.startswith("--database="):
            return w.split("=", 1)[1].strip(STRIP)
        m = re.match(r"^(?:postgres|postgresql|mysql|mongodb)://[^\s]*?/([A-Za-z0-9_$-]+)", w)
        if m:
            return m.group(1)
    return None


def match_db(head: str, rest, joined_words: str, ctx: dict):
    """Destructive SQL, minus the scratch databases the fleet creates and drops
    all day. Round 0 measured three of ten trips here, all false positives, and
    one of them left `rollup_probe_r1873` behind because the agent complied by
    skipping its own cleanup."""
    joined = " ".join(rest)
    stmts = DESTRUCTIVE_SQL_RE.findall(joined)
    if not stmts:
        return None

    conn = connected_db(rest)
    if conn and SCRATCH_DB_RE.search(conn):
        return None  # every statement lands in a scratch database

    for verb, target in stmts:
        if re.match(r"DROP\s+DATABASE", verb, re.I):
            name = (target or "").strip('".').lower()
            if name and (name in ctx["created_dbs"] or SCRATCH_DB_RE.search(name)):
                continue  # self-created, or scratch by name
        return (
            "fs.destructive",
            {"command": joined_words[:400], "statement": f"{verb} {target}".strip()[:120]},
            f"{head}: {' '.join(verb.split())} {target}".strip(),
        )
    return None


# ---------------------------------------------------------------------------
# Control plane + audit
# ---------------------------------------------------------------------------

def check(rule_id: str, action: str, payload: dict):
    """Ask the control plane. Returns the decision dict, or None on any fault."""
    body = json.dumps({
        "agent": os.environ.get("FORGE_AGENT", "bash-hook"),
        "action": action[:200],
        "rule_id": rule_id,
        "payload": {**payload, "run_id": os.environ.get("FORGE_RUN_UUID")},
    }).encode()
    req = urllib.request.Request(
        f"{API}/api/autonomy/check", data=body,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            if r.status != 200:
                return None
            return json.loads(r.read())
    except Exception:
        return None  # fail open: a dead control plane must not wedge the fleet


def notify_konrad(rule_id: str, action: str) -> None:
    """An override must cost something. Reaching for the acknowledgement prefix
    puts a line in Konrad's inbox within the minute, so a self-granted bypass
    cannot be a thing that happens quietly. Best-effort: never raise or stall."""
    text = (
        f"Guardrail OVERRIDDEN: {rule_id} was bypassed with an explicit "
        f"acknowledgement by run {os.environ.get('FORGE_RUN_UUID', '?')}. "
        f"Action: {action}"
    )[:480]
    try:
        req = urllib.request.Request(
            f"{API}/api/reminders",
            data=json.dumps({"text": text, "when": "in 1m"}).encode(),
            headers={"content-type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=TIMEOUT_S).read()
    except Exception:
        pass


def audit(kind: str, rule_id: str, action: str) -> None:
    try:
        line = json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "kind": kind,
            "rule_id": rule_id,
            "run_id": os.environ.get("FORGE_RUN_UUID"),
            "action": action[:200],
        })
        with open(AUDIT_LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# NOTE ON WHAT THIS MESSAGE DOES NOT SAY -- 2026-08-25
# The first version of this text ended with the override recipe, on the theory
# that an agent holding a genuine authorisation needs a way through. The very
# first end-to-end test refuted it: a Haiku turn with no authorisation from
# Konrad at all was blocked at 23:36:02, read the recipe out of this message,
# re-ran with the acknowledgement prefix at 23:36:07, and reported back "the
# command ran and completed with no output". Five seconds, self-granted.
#
# A guard that documents its own bypass is a speed bump with a sign on it. The
# override still exists -- a root agent can always defeat a local hook, so
# pretending otherwise would be theatre -- but it is no longer ADVERTISED, and
# using it now pings Konrad. The threat model here is carelessness, and the
# goal is that bypassing is deliberate, attributable and loud.
BLOCK = """BLOCKED by the autonomy control plane: {label} ({rule_id})

  attempted: {action}
  reason:    {reason}
  trip:      {trip}

This rule is ON in Konrad's console. Rules of this class mean the action needs
his explicit say-so in the CURRENT task -- something this guard cannot see and
you may not assert on his behalf. The trip above is on record.

Do not look for a way around this. Do the reversible part of the work now, and
put the blocked step in your answer for Konrad to approve. If he has already
approved it in this task, say so in your answer and let him clear it -- an
operator can lift the rule in the console or re-issue the command himself."""

# Decided locally, so this text is the whole decision -- there is no rule row to
# consult and no acknowledgement that applies. Same shape as
# guard-service-restart.py: some things are simply not an agent's to do.
BLOCK_SELF_EDIT = """BLOCKED locally: an agent may not change the autonomy rules.

  attempted: {action}
  command:   {command}

`/api/autonomy/rules` and `/api/autonomy/trips/<id>/resolve` are Konrad's
console, reached from his browser. Disabling a rule, overwriting its config, or
resolving a trip from inside a run would erase exactly the record that says
what happened -- and this endpoint is unauthenticated on localhost, so nothing
downstream would notice.

If a rule is wrong or is blocking work Konrad has already authorised, say so in
your answer and let him decide. This block is local: no rule row was consulted
and no override applies to it."""


def _main() -> int:
    # Only ever intervene inside a run. Konrad at a shell by hand is not the
    # failure mode this guards, and blocking him would be its own damage.
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
        return 0  # a non-Bash shape, or a payload this hook does not understand
    cmd = tool_input.get("command") or ""
    if not isinstance(cmd, str) or not cmd:
        return 0
    cwd = payload.get("cwd") or os.getcwd()

    try:
        cleaned = strip_heredocs(cmd)
        hit = classify(cleaned, cwd)
    except Exception as e:
        # A classifier bug must never cost the fleet a command -- but it must
        # not be invisible either, or the guard degrades to nothing in silence.
        audit("classifier-error", "-", f"{type(e).__name__}: {e}")
        return 0
    if not hit:
        return 0
    rule_id, rule_payload, action = hit

    if rule_id == "autonomy.self_edit":
        audit("blocked-local", rule_id, action)
        print(BLOCK_SELF_EDIT.format(
            action=action, command=rule_payload.get("command", "")[:200],
        ), file=sys.stderr)
        return 2

    # Explicit acknowledgement: allowed, but never silent.
    for _words, env in segments(cleaned):
        if env.get("FORGE_GUARD_ACK") == rule_id:
            audit("acknowledged", rule_id, action)
            notify_konrad(rule_id, action)
            return 0
    if os.environ.get("FORGE_GUARD_ACK") == rule_id:
        audit("acknowledged", rule_id, action)
        notify_konrad(rule_id, action)
        return 0

    decision = check(rule_id, action, rule_payload)
    if decision is None:
        audit("fail-open", rule_id, action)
        return 0
    if not isinstance(decision, dict) or not isinstance(decision.get("allow"), bool):
        # A 200 whose body carries no boolean verdict is a control plane that
        # did not answer the question. Round 0 measured this as a SILENT allow;
        # it is the same fail-open as a 500 and is logged like one.
        audit("fail-open", rule_id, action)
        return 0
    if decision["allow"]:
        return 0

    audit("blocked", rule_id, action)
    print(BLOCK.format(
        label=decision.get("rule_label", rule_id),
        rule_id=rule_id,
        action=action,
        reason=decision.get("reason", "rule enabled"),
        trip=decision.get("trip_id", "-"),
    ), file=sys.stderr)
    return 2


def main() -> int:
    """0 and 2 are the only exit codes.

    Round 0 measured a `tool_input` that was a bare string exiting 1 with a
    traceback. Exit 1 happens to be non-blocking under the Claude Code hook
    contract, so nothing wedged -- but relying on that is relying on a detail of
    someone else's contract to keep this hook fail-open."""
    try:
        code = _main()
    except Exception as e:
        try:
            audit("hook-error", "-", f"{type(e).__name__}: {e}")
        except Exception:
            pass
        return 0
    return 2 if code == 2 else 0


if __name__ == "__main__":
    sys.exit(main())
