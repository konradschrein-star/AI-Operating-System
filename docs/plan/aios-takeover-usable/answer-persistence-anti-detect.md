# Persistence vs. anti-detect — the answer to Konrad (2026-08-26)

**A stable profile name is the whole fix, and it costs nothing.** No VM, no Dolphin
Anty, no Multilogin.

## What is already true

- `scripts/research-browser.mjs:1750` runs real Chrome with
  `chromium.launchPersistentContext(profileDir(profile))` on
  `/opt/ai-os/browser-profiles/<profile>`. Cookies and site data survive every run.
- The defect is naming: `<profile>` is a mandatory positional with no default
  (`parseArgs`, l.2123–2131), and the prompt every builder reads says
  `open scratch --url …` (`forge-control/src/lib/project-tick.ts:754`). Each run
  therefore creates a fresh directory nothing will open again.

## What is on disk (measured 2026-08-26 00:5xZ, sqlite over copies, no values read)

| profile | cookies | logins | hosts |
|---|---|---|---|
| os-ui | 17 | 0 | github.com, google.com |
| perplexity | 4 | 0 | perplexity.ai |
| r3-takeover | 5 | 0 | google.com |
| r5proof | 5 | 0 | google.com |
| r704-loginwall | 7 | 0 | github.com |
| r705-review | 3 | 0 | os.schreinercontentsystems.com, perplexity.ai |
| scratch | 0 | 0 | — |
| smoke-r701 | 0 | 0 | — |

`Default/Login Data` is empty in all eight. Nothing valuable is trapped in the
throwaways; they are still not deleted without an explicit instruction.

## Why the tools he named solve a different problem

Dolphin Anty and Multilogin are anti-detect browsers: they rewrite canvas, WebGL,
font, timezone and TLS fingerprints so a site cannot link many accounts to one
machine. That is fingerprint evasion. Persistence is "the same cookies next time",
which the stack has. A real VM is persistence plus a hypervisor tax; Xvfb plus a
persistent Chrome profile already is a persistent desktop.

The only fingerprint block recorded anywhere in the vault is Google's
`PUBLIC_ERROR_UNUSUAL_ACTIVITY` on raw/nodriver minting
(`90_AI_OS/Self-Mint Veo - Technical Learnings.md`), and the remedy recorded there
is a genuine headful browser — which is what this stack runs. No `auth.json` or
supervisor log under `/opt/ai-os/browser-profiles/.state/` shows a captcha,
challenge or block.

## What changed, in the names that shipped

- `scripts/research-browser.mjs`: the `[profile]` positional is optional and defaults to
  **`konrad-main`** (`RESEARCH_BROWSER_DEFAULT_PROFILE` overrides). A name not yet on disk
  is refused unless it is the default, a service key, or given with **`--throwaway`** —
  which writes the marker `<profile>/.throwaway` so a disposable directory says what it is.
  Every directory already on disk keeps working under its old name.
- The prompt corpus (`forge-control/src/lib/project-tick.ts`, `BROWSER_FIRST`) quotes
  `open --url <URL> --label <…>` with no profile, names `--throwaway` as the opt-in, and
  names `close` as the signal that ends a takeover session. `docs/tools/research-browser.md`
  §3, §4.1 and §7.3 carry the same three facts.
- Nothing is deleted. The six throwaway directories (`r3-takeover`, `r5proof`,
  `r704-loginwall`, `r705-review`, `scratch`, `smoke-r701`) stay until Konrad says otherwise;
  `scripts/ops/guard-autonomy.py` already treats only `scratch` as a routine deletion target
  and guards every sibling, `konrad-main` included.

## Your choice on the existing `os-ui` profile (default stands if you say nothing)

- **C — fresh `konrad-main` (recommended, the default).** Log in once per service over the
  takeover. Reason: separation, not tidiness. `os-ui` is the profile agent runs use to
  screenshot the console — live on `:126` right now. If your Google/GitHub logins lived in
  it, every future screenshot run would drive a browser carrying your authenticated session.
- **A — make `os-ui` the default** (`RESEARCH_BROWSER_DEFAULT_PROFILE=os-ui`): saves the
  logins you have there (17 cookies, 0 saved passwords) at the cost of the separation above.
- **B — rename `os-ui` to `konrad-main` after `close os-ui`**: the only option that kills a
  live session, for 17 cookies.

## When to revisit

Adopt an anti-detect tool only with a named site, a screenshot of the block, and the
profile it happened to. Until then the durable profile (`konrad-main` by default,
`--throwaway` for disposable work) is the fix.
