# r950 — teaching the operator and the fleet to emit `forge:ui`

Round 808 shipped the renderer, the closed schema and the security property, and
put the format in **no agent prompt**. Nothing emitted a control, so the feature
was unreachable. This round writes the format into the prompts.

## 1. The gate: the renderer had to be live FIRST

Emitting these blocks before the renderer exists prints raw fenced JSON into
Konrad's chat, which is worse than not having the feature. So this was checked
before a line was written, and it is the reason the round was allowed to proceed.

| Check | Result |
|---|---|
| `/opt/forge-ai-os` branch | `main` @ `0b84b8f` |
| `git merge-base --is-ancestor a55d01a HEAD` | **YES** — the r808 renderer commit is in main |
| `.next/BUILD_ID` mtime | `2026-08-16 23:35:43` — after `a55d01a` (`22:44:08`) |
| running `next-server` (pid 453960) start | `Sun Aug 16 23:36:06 2026` — after that build |
| `curl :7701/_next/static/chunks/4436-964b459536a207f6.js` | **HTTP 200**, 283 617 bytes |
| that served chunk contains | `forge:ui`, `unterminated forge:ui block`, `options exceeds`, `id has illegal characters` |

The renderer is not merely committed — the bytes the browser downloads contain
the fence scanner and the validator's own reason strings.

## 2. What changed

- **`forge-control/src/lib/cc-runner.ts`** — `buildSystemPrompt()` gains the
  OPERATOR section: both variants worked through, when to reach for one, and the
  explicit "do not decorate ordinary answers with controls / never more than a
  handful of options". Every cap is transcribed field for field from
  `rich-blocks.ts`'s `LIMITS`. `buildSystemPrompt` is now exported so the check
  can test the shipped string instead of a copy that would drift from it.
- **`forge-control/src/lib/project-tick.ts`** — the fleet section, added to
  `MANAGER_COMMS()` rather than `withPolicy()`. See §3.
- **`scripts/checks/check-ui-prompt.ts`** — the gate, 55 assertions.

## 3. Why the fleet text is in `MANAGER_COMMS()`, not `withPolicy()`

The task said to use `withPolicy()` **only if** worker reports render through the
same component, and to verify rather than assume. Verified — and the truth is
finer than the binary the question assumed. Traced on the deployed tree:

| Surface | Path | Result |
|---|---|---|
| Worker report in the **manager chat** | `meta.comms` → `CommsMessage` → `CommsText` → `RichMessage`, and `ManagerThread` is the one caller supplying `RichActions` (`{insertDraft, openSecret}`) | **LIVE control** |
| Worker's **own drilled view** | `AgentChatView` → `AssistantThread` with **no** `actions` prop | renders **disabled**, "read-only here" |
| A **reminder** (`POST /api/reminders`) | plain `user` message, no `meta.comms` → `UserText`, which is literally `return <>{text}</>` | **raw fenced JSON** |

So a worker's block is live in exactly one channel: a report into the manager
chat. `withPolicy()` also wraps **scratch projects with no manager chat at all**,
where a control block has no live surface whatsoever. Gating the format on the
same linkage that gates the channel it renders in is the only placement that
cannot teach a worker to emit a block nobody can click. The prompt text says this
outright, so a worker does not put one in a reminder.

## 4. The check — `scripts/checks/check-ui-prompt.ts`

Plain `tsx`, table-driven, `process.exit(1)` on mismatch (same shape as
`check-chat-rich.tsx`; vitest is forbidden by NFU8). It imports the **real**
prompt builders and the **real** validator — no re-pasted copies.

```
forge-control/node_modules/.bin/tsx scripts/checks/check-ui-prompt.ts
```

- **§1** Every worked example in every shipped prompt (`buildSystemPrompt(true)`,
  `buildSystemPrompt(false)`, `MANAGER_COMMS(…, "builder")`,
  `MANAGER_COMMS(…, "reviewer")`) is run through `splitRichSegments` — the same
  function the transcript calls. Each must yield exactly `[choice, secret]` and
  **zero** invalid segments.
- **§2** The numbers the prose quotes are asserted against `LIMITS`, and both
  character classes are asserted **by behaviour** against `parseUiBlock` rather
  than by re-declaring the regexes. Move a cap in `rich-blocks.ts` and this turns
  red instead of leaving a stale bound in the prompt.
- **§3** A hand-written block of the documented shape parses (including the
  documented bare-string option, which must label itself and carry a null hint).
- **§3b** Eleven near misses are refused — unknown kind, no kind, no options,
  empty options, 13 options, option missing `value`, oversize `label`, secret
  with no name, `multiple` as a string, a JSON array, and non-JSON.
- **§3c** The four-space-indent trap: `FENCE` allows at most three leading
  spaces, so an indented example teaches a block that never becomes one. Asserted
  both ways. **This is why both prompts put their fences at column 0.**

**Result: `PASS 55/55 assertions`, exit 0.**

### Negative controls — the check can actually fail

A gate that cannot go red proves nothing, so it was broken on purpose twice and
restored from a backup copy each time:

| Injected fault | Result |
|---|---|
| `"name":"OPENAI_API_KEY"` → `"OPENAI API KEY"` (space is outside `[A-Za-z0-9._-]`) | **FAIL 49/55**, exit **1** |
| `MANAGER_COMMS` fence indented four spaces | builder prompt yields **0 blocks**, **exit 1** |

## 5. Other gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (forge-control) | exit 0 |
| `npx tsc --noEmit` (forge-control-web) | exit 0 |
| `npm test` (forge-control) | **804/804 pass**, 0 fail |
| `pnpm build` (forge-control-web) | exit 0 |

## 6. NOT DONE, and why — the executor restart

Step 4 of the task said to commit and then launch the detached safe-restart.
**It was deliberately not launched.**

`deploy-playbook.md:146` specifies that command as *"the exact command to run
**after merging**"*, and its step 6 follows step 3 ("merge the work branch to
main"). The executor loads `cc-runner.ts` and `project-tick.ts` from the live
checkout `/opt/forge-ai-os`, which is on `main`:

```
$ git merge-base --is-ancestor 44bea88 main   # -> NO
$ grep -c "forge:ui" /opt/forge-ai-os/forge-control/src/lib/cc-runner.ts
0
```

Restarting now would reload **byte-identical code**, consume the 12-hour idle
window for nothing, and leave a false record that r950 is live. The restart
belongs to the deploy task, **after** reviewer PASS and the merge to main — at
which point it is the correct and necessary final step, because these two files
are executor-loaded and will not take effect without it.

`forge-executor` was not touched.
