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

## When to revisit

Adopt an anti-detect tool only with a named site, a screenshot of the block, and the
profile it happened to. Until then the durable profile (`konrad-main` by default,
`--throwaway` for disposable work) is the fix.
