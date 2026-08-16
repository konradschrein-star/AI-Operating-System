# P5 sweep B — docs/tools/* re-aligned with shipped CLIs

Round 501. Audits `docs/tools/gemini-qa.md`, `docs/tools/perplexity.md`, and
`docs/tools/deploy-playbook.md` against `scripts/gemini-qa.mjs`, `scripts/perplexity.mjs`,
`forge-control/src/lib/project-tick.ts`, `docs/plan/04-phases.md`, `scripts/git-sync-branch.sh`,
and `/opt/ai-os/scripts/safe-restart.sh` (read directly, not paraphrased). Commits under review:
`cd161a2` (R404 fix cycle 1, perplexity) and `bc0b3fa` (R405 fix cycle 2, both CLIs).

**Headline finding: both target docs were already re-synced by the commits themselves.**
`cd161a2` and `bc0b3fa` each edited `docs/tools/gemini-qa.md` and `docs/tools/perplexity.md` in
the same commit as the code fix (see `git show --stat` for both). Every behavior those commits
changed — the citation hard-error, the stdout-first `--out` rule, the `writeSync`-drain fix, the
directory pre-flight — was already reflected in the docs at the start of this task. This sweep
verified that field by field rather than assuming the commit messages were accurate.

## Method

1. `node scripts/gemini-qa.mjs --help` and `node scripts/perplexity.mjs --help`, captured live.
2. Read both scripts end to end (679 / 550 lines) — every flag in `parseArgs`, every constant
   (`DEFAULT_MODEL`, exit codes, poll timeout, `VIDEO_MIME`, `RUBRIC_SCHEMA`, `PRESETS`,
   `DEFAULT_MAX_STEPS`/`DEFAULT_MAX_TOOL_CALLS`/`DEFAULT_MAX_RESULTS`/`MAX_RESULTS_CAP`).
3. Read `git show cd161a2` and `git show bc0b3fa` in full.
4. Cross-checked every error-path transcript in both docs against
   `docs/plan/evidence/p4-gemini-errorpaths.md` and `docs/plan/evidence/p4-perplexity-errorpaths.md`
   byte for byte.
5. Grepped `project-tick.ts`, `docs/plan/04-phases.md`, and `deploy-playbook.md` side by side for
   the `safe-restart.sh` invocation string.
6. Read `/opt/ai-os/scripts/safe-restart.sh` and `scripts/git-sync-branch.sh` directly and checked
   every behavioral claim `deploy-playbook.md` makes about them (poll interval, stability count,
   SQL query, exit codes, force-free guarantee).
7. Checked live state where the docs make point-in-time claims: `whoami` (root), `node --version`
   (v22.22.2), `ls /opt/ai-os/.secrets/store/` (no gemini/perplexity key), and
   `GET /api/reminders` for both queued reminder IDs (both still `pending`).

## `docs/tools/gemini-qa.md`

| Claim | Reality | Action |
|---|---|---|
| Usage line, all 3 flags + `--help`, defaults | Matches `parseArgs`/`USAGE` exactly | none |
| Default model `gemini-omni-flash` | `DEFAULT_MODEL` constant | none |
| Key resolution order (env, then secret-store file), exit 2 wording | Matches `resolveApiKey()` verbatim | none |
| Exit codes 0/1/2/3 and their triggers | Matches `die()`/`dieHttp()` call sites | none |
| §5.1 `--out` pre-flight + stdout-first + exit-3-not-1 on write failure | Matches `assertOutWritable()` + main's `writeOut(rendered)` before `writeFileSync` | none |
| §5.1 `writeSync`-on-raw-fd, >64 KiB pipe safety, test ref `gemini-qa-cli.test.ts` block `R405-2` | File exists; `describe("R405-2 large payloads survive process.exit() on a pipe", ...)` present at line 240 | none |
| §6 rubric schema, field by field (`verdict`, `confidence`, `hook`, `pacing`, `audio`, `visual`, `factual`, `top_fixes`, `summary`, all nested shapes and enums) | Matches `RUBRIC_SCHEMA` exactly, including `factual` having no top-level `score` | none |
| §7 cost math (~$0.0087/s, ~$5 for 10 min) and the "do not use $0.10/s" correction | Not in code (external pricing data); the correction itself is what `cd161a2` added to this file and to `docs/research/round-399-41e8757d.md` — present and intact | none |
| §8 error-path transcripts (missing key, invalid key × URL, invalid key × local file) | Byte-for-byte match against `docs/plan/evidence/p4-gemini-errorpaths.md` §4–6 | none |
| §8 R406 `--out /tmp` directory rejection, 27ms, no network | Matches evidence file's "R406" section and `assertOutWritable()`'s directory-shape check | none |
| §9 key status: no key on box, reminder `c88f6e19-...` pending | `ls /opt/ai-os/.secrets/store/` confirms absent; `GET /api/reminders` confirms `status: pending` | none |
| Test file path `forge-control/src/lib/gemini-qa-cli.test.ts` | Exists, 12394 bytes | none |

**Verification check (per task instructions):** every flag named in the doc (`--model`, `--out`,
`--prompt-extra`, `--help`/`-h`) appears in `parseArgs`'s `takesValue` set or its explicit checks;
every flag `parseArgs` accepts appears in the doc. No doc-only or code-only flag. **Result: clean.**

## `docs/tools/perplexity.md`

| Claim | Reality | Action |
|---|---|---|
| `ask`/`search` mode split, endpoints (`/v1/agent`, `/search`) | Matches `AGENT_URL`/`SEARCH_URL` | none |
| `ask` flags table (`--model`, `--preset`, `--instructions`, `--max-steps`, `--max-tool-calls`, `--no-force-search`, `--out`) with defaults | Matches `parseArgs`'s `switch` and `DEFAULT_MODEL`/`DEFAULT_MAX_STEPS`/`DEFAULT_MAX_TOOL_CALLS` | none |
| `search` flags table (`--max-results`, `--out`), cap 20 | Matches `DEFAULT_MAX_RESULTS`/`MAX_RESULTS_CAP` | none |
| `--max-tool-calls 0` requires `--no-force-search` | Matches the `usageError` guard combining `opts.maxToolCalls === 0 && opts.forceSearch` | none |
| Key resolution order + exit 2 wording | Matches `resolveApiKey()` verbatim | none |
| Exit codes 0/1/2/3 and triggers, including the `search_results.results`-not-an-array case | Matches `apiError`/`outputError`/`usageError` call sites | none |
| §5 `--out` pre-flight + stdout-first + exit-3-not-1, "runs as root so W_OK is near-no-op" | Matches `assertOutWritable()`/`emit()`; root confirmed live (`whoami` → root) | none |
| §5 test ref `perplexity-cli.test.ts` blocks `R405-2`/`R405-3` | File exists; both `describe()` blocks present | none |
| §6 `ask` response shape, `citations` derived not vendor-supplied, `[]`-vs-hard-error split for unreadable `results`, test ref `§R404-1` | Matches `extractAnswer`/`extractCitations`/`extractSearchResults`; `describe("R404-1 extractSearchResults", ...)` present at line 118 | none |
| §6 `search` response shape, `results` vs `search_results` acceptance | Matches `runSearch()` | none |
| §7 Agent API deprecation facts, no `sonar-pro` slug, preset→model mapping | Not re-verified against the vendor this round (out of scope: unrelated to `cd161a2`/`bc0b3fa`); matches script's `PRESETS` array and `DEFAULT_MODEL` | none |
| §8 HTTP-200-on-failure, strict-whitelist body construction | Matches `runAsk()`'s `status` branch and `buildAskBody()`'s explicit field list | none |
| §10 error-path transcripts (missing key ×2 modes, invalid key ×2 endpoints, 3× usage errors, unwritable `--out`) | Byte-for-byte match against `docs/plan/evidence/p4-perplexity-errorpaths.md` | none |
| §12 key status: no key on box, reminder `4c4532af-...` pending | Confirmed absent / `status: pending` | none |
| Test file path `forge-control/src/lib/perplexity-cli.test.ts` | Exists, 15535 bytes | none |

**Verification check:** every flag in the doc's `ask`/`search` tables matches a `case` in
`parseArgs`'s `switch`, and every `case` (`--model`, `--preset`, `--instructions`, `--max-steps`,
`--max-tool-calls`, `--no-force-search`, `--max-results`, `--out`) is documented, correctly scoped
to its mode (`askOnly`/`searchOnly`). No doc-only or code-only flag. **Result: clean.**

## `docs/tools/deploy-playbook.md`

The safe-restart command (`setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45
>> /tmp/safe-restart.log 2>&1 &`) matches character for character across all three sources:
`project-tick.ts:328` (inside `DEPLOY_GUIDE`), `docs/plan/04-phases.md:113`, and
`deploy-playbook.md:149`/`:244`.

`safe-restart.sh`'s documented internals (15s poll, 2 consecutive quiet polls, the exact
`last_heartbeat_at` SQL query, DB-unreachable handling, exit 0/1/2 meanings, log paths) were
checked against `/opt/ai-os/scripts/safe-restart.sh` line by line — all accurate, no drift.
`git-sync-branch.sh`'s exit-code table and the force-free guarantee (`grep -c -- "--force"` → `0`)
were re-run and match the doc.

**Real drift found, not from the two target commits:** the doc's citations of `project-tick.ts`
line numbers for `WORKTREE_POLICY`, `REVIEWER_LIVE_CHECK`, `DEPLOY_GUIDE`, `GITHUB_PUSH_GUIDE`,
`buildPrompt()`, and the `withPolicy()` wrapper had drifted — the file grew between when this doc
was written and now (unrelated to `cd161a2`/`bc0b3fa`, which never touch `project-tick.ts`). Fixed:

| Symbol | Doc said | Actually at |
|---|---|---|
| `WORKTREE_POLICY` | `:164-177` | `:288-302` |
| `REVIEWER_LIVE_CHECK` | `:183-193` | `:307-316` |
| `DEPLOY_GUIDE` | `:197-215` | `:321-336` |
| `DEPLOY_GUIDE`'s restart-command line | `:203` | `:328` |
| `GITHUB_PUSH_GUIDE` | `:217-225` | `:341-349` |
| `buildPrompt()` | `:227` | `:351` |
| `withPolicy()` wrapper | `:233-236` | `:360-361` |

`workspace.ts` citations (`REPO_PATHS` at `:13-16`, `liveCheckoutPath` at `:29-31`) were checked
too and are still accurate — not touched.

## For round 502

Nothing. No code defect was found in either script or in `project-tick.ts` during this sweep —
every discrepancy found was a doc-side line-number citation, already fixed above.

## Verification statement

For each of the two CLI docs: every flag the doc documents exists in the script's argument
parser, and every flag the parser accepts is documented, confirmed by direct comparison above
(not by inspection of `--help` text alone — the `switch`/`takesValue` logic was read directly).
Both docs' error-path transcripts, test-file references, and rubric/response-shape claims were
checked against the shipped code and the round-401 evidence transcripts, not against each other.
`deploy-playbook.md`'s safe-restart command and `safe-restart.sh`'s internals were checked against
the live script at `/opt/ai-os/scripts/safe-restart.sh` (outside this worktree, read-only,
untouched). No `pnpm install` / `tsc` / `pnpm test` was run in this task per the brief's
constraint (a sibling task shares this worktree); this sweep was zero-dependency `node`/`git`/`grep`
only, as instructed.

---

## Resolution (round 502)

Round 501's text above is untouched; this section is appended only.

**This audit's `## For round 502` list was empty — "Nothing".** Per the round-502 task's
step 7, an empty list is not licence to idle: the load-bearing claims were independently
re-verified rather than taken on trust. Second pair of eyes, run this round:

| Claim re-checked | Method | Result |
|---|---|---|
| Gate green | `cd forge-control && pnpm install --prod=false && npx tsc --noEmit && pnpm test` | `TSC_EXIT=0`, no output; **167 tests / 167 pass / 0 fail / 36 suites**. Matches the round-500 baseline and sweep A §5 exactly. |
| N2 boundary | `git diff --name-only main...HEAD \| grep -E '^forge-control-web/\|^forge-control/src/routes/agents\.ts$'` | `GREP_EXIT=1`, no output. Clean. |
| `gemini-qa.mjs` `--help` vs `docs/tools/gemini-qa.md` | live `--help`, flags extracted and sorted, diffed against the doc's flags | `--help --model --out --prompt-extra` in both directions. `--import` appears in the doc as prose, not as a flag — as this audit already stated. **Clean.** |
| `perplexity.mjs` `--help` vs `docs/tools/perplexity.md` | same method | `--instructions --max-results --max-steps --max-tool-calls --model --no-force-search --out --preset` in both directions. **Clean.** |
| `deploy-playbook.md`'s corrected `project-tick.ts` line citations | `grep -n` for the four prompt constants in the live file | `WORKTREE_POLICY:288`, `REVIEWER_LIVE_CHECK:307`, `DEPLOY_GUIDE:321`, `GITHUB_PUSH_GUIDE:341`, `withPolicy` wrapper `:361`. Matches this audit's correction table line for line. **No drift reintroduced.** |

**Nothing to fix, and nothing was changed in `docs/tools/**` this round.** The
`deploy-playbook.md` modification this audit's sibling task had open at sweep time
(sweep A §1) has since been committed at `2913377`; `git status --porcelain` in the
worktree is clean.

Round 502's nine must-fix items all came from sweep A
(`docs/plan/evidence/p5-integration-sweep.md`); their closures are recorded in that
file's own `## Resolution (round 502)` section. None of them touched `docs/tools/**`,
so this audit's conclusions stand unamended.
