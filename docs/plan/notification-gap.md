# notification-gap.md — what agent→operator traffic reaches `runs.thread`, and what dies

**Deliverable for R19** (`docs/plan/operator-visibility/01-requirements.md`), gated by
`03-quality.md` phase 4. Written round 1350.

**Status: OPEN — but far narrower than the corpus claimed.**
Two of the three agent→operator paths are fully covered today. One is not. The blanket
statement carried by 00-vision/02-architecture — *"agent completion payloads never reach
`runs.thread`"* — was **false as written** and is corrected in those files in the same
commit as this doc. What remains open is one specific payload: the harness's
**async task-completion notification**.

---

## 1. Provenance — read at, and how to detect drift

| | |
|---|---|
| Quotes read at | `fc49e35b1c72d20f7b2221666bcfd4c689eb5850` |
| Re-verified at | `b02aa6268777d0c42cd8e0ba01a6754c9213f967` — HEAD moved mid-task (two sibling commits in this shared worktree). Every cited range is **identical at both SHAs**; `git diff fc49e35 b02aa62` touches one cited file, `tool-summary.ts`, but not its cited lines 384–386. |
| Branch | `project/8ea0cc08` |
| Worktree state of quoted files | all nine cited files **clean** at `b02aa62` (`git status --porcelain` empty for each) |
| Read-only | every file below was opened read-only; `cc-runner.ts`, `executor.ts`, `run-control-rules.ts` are owned by **engine-v2-research-lane** |

Every quote below is **byte-identical** to its source range, machine-checked by extracting
each fenced block from this doc and diffing it against `sed -n 'S,Ep' <file>` — 9 of 9
blocks matched. To detect drift:

```sh
git diff b02aa6268777d0c42cd8e0ba01a6754c9213f967 -- \
  forge-control/src/lib/cc-runner.ts \
  forge-control/src/executor.ts \
  forge-control/src/db/runs.ts \
  forge-control/src/lib/run-control-rules.ts
```

Non-empty output means the line pins in this doc may be stale — re-derive them with
`grep -n` before trusting any `file:line` here. Per the standing citation rule
(`01-requirements.md:5-11`), every quote below is headed by its **stable symbol anchor**
first and its line pin second; if the pin rots, `grep` the symbol.

**How the previous pins rotted — and the useful thing that falls out of it.** R19 was
written against `cc-runner.ts:170–188` / `:417–429`. At `b02aa62`, `:170–188` is
`buildSystemPrompt`'s prompt text and `:417–429` is the idle-timeout kill logic. Neither
has anything to do with events.

But the round-600 chat fixture (`docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json`)
recorded the **verbatim snippet** the author quoted at `:417–429` — and it is
**character-for-character identical** to the block now at `:502–514`, machine-diffed. So
the engine code behind R19 has **not changed since round 600**; it moved down 85 lines
because ~332 lines were inserted above it (mostly `buildSystemPrompt` growth and the
idle-timeout rewrite).

That matters for the verdict: round 600's *code* analysis was sound and still holds. Only
its **line pins** rotted, and — as §2 shows — its **prose summary** was over-broad. The
gap it found is real; the sentence it wrote about the gap was not.

---

## 2. The three paths, and the verdict on each

| # | Path | Verdict |
|---|---|---|
| a1 | **Synchronous** in-process sub-agent (Agent tool, `run_in_background: false`) — final text arrives as the `tool_result` on the spawning `tool_use` | **COVERED** |
| a2 | **Async** in-process sub-agent — its own stream events (assistant text, tool calls) while it works | **COVERED**, inline, tagged `meta.parent_tool_use_id` |
| b | **Async task-completion notification** — the harness banner that says a background agent finished | **UNCOVERED — dies in `cc-runner.ts:502–514`** |
| c | Peer run messaging this run via `POST /api/runs/:id/message` | **COVERED** end to end: engine → thread → client renderer, with tests |

### 2a1. Synchronous sub-agent final text — COVERED

The CLI emits the sub-agent's final report as a `tool_result` block on a `user` event.
`cc-runner` forwards exactly that block shape:

`cc-runner.ts` — the `evt.type === "user"` branch of the stream-line handler (`:502-514` @ `b02aa62`)
```ts
      } else if (evt.type === "user") {
        const msg = evt.message as { content?: StreamBlock[] } | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "tool_result") {
            opts.onEvent({
              type: "tool_result",
              toolUseId: block.tool_use_id,
              text: blockContentToText(block.content),
              isError: block.is_error === true,
              parentToolUseId,
            });
          }
        }
```

`executor.ts` maps that event to a thread entry:

`executor.ts` — the `tool_result` branch of `onEvent` (`:982-986` @ `b02aa62`)
```ts
    } else if (e.type === "tool_result") {
      const entry = toolResultEntry(e);
      enqueue(() => appendThreadEntry(run.id, entry));
    }
  };
```

`executor.ts` — `toolResultEntry()` (`:800-817` @ `b02aa62`)
```ts
function toolResultEntry(e: CcEvent): ThreadEntry {
  let text = e.text ?? "";
  if (text.length > RESULT_PREVIEW_CHARS) {
    text = text.slice(0, RESULT_PREVIEW_CHARS) + `\n… [truncated]`;
  }
  return {
    role: "tool",
    content: text,
    ts: new Date().toISOString(),
    kind: "tool_result",
    meta: {
      tool_use_id: e.toolUseId,
      is_error: e.isError === true,
      ...(e.parentToolUseId
        ? { parent_tool_use_id: e.parentToolUseId }
        : {}),
    },
  };
```

**One lossy edge, not a gap:** the payload is truncated at `RESULT_PREVIEW_CHARS = 2_500`
(`executor.ts:772`) with a visible `… [truncated]` marker. Lossy but honest — the reader
is told. Not part of R19.

### 2a2. Async sub-agent's own work — COVERED, inline

Every stream event a Task sub-agent produces is stamped by the CLI with a top-level
`parent_tool_use_id`, and `cc-runner` lifts it onto **every** event it emits:

`cc-runner.ts` — the `parentToolUseId` lift (`:459-465` @ `b02aa62`)
```ts
      // parent_tool_use_id equal to the spawning Task tool_use_id. This
      // is the ONLY reliable way to attribute a stream event back to the
      // subagent that produced it (assistant blocks don't self-identify).
      const parentToolUseId =
        typeof evt.parent_tool_use_id === "string"
          ? evt.parent_tool_use_id
          : null;
```

Independently corroborated on real data by round 600, which built `subagent-slice.ts`
on this exact wire fact (`forge-control-web/app/desktop/chat/subagent-slice.ts:11-17`):
in run `3853c154-e07b-4378-9313-2b34f4a33342`, **196 of 285 thread entries belonged to
sub-agents**, inline in the parent's thread, tagged `meta.parent_tool_use_id`.

So an async sub-agent's *substance* — including its closing assistant text — **is** in
the thread. What is missing is only the harness's framing of it as a completion.

### 2b. The async task-completion notification — UNCOVERED

For an async spawn the `tool_result` on the Agent call is **only the launch
acknowledgement**, not the report. That is established fact in this corpus, from two
independent places:

- `docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md` — the entire artifact.
- `forge-control-web/app/desktop/chat/tool-summary.ts:384-386` — *"An async spawn returns
  the harness's `Async agent launched successfully…` banner"*.

The real completion is delivered by the harness as content injected into the parent's
**next user turn**. It is not a `tool_result` block. And `cc-runner`'s `user` handler,
quoted in full at §2a1 above, forwards **only** `block.type === "tool_result"`. There is
no `else`, no `default`, no log line: any other block type in a user message is dropped
on the floor, silently.

Even if that branch existed, there is nothing to emit — the event union is closed:

`cc-runner.ts` — the `CcEvent` union (`:234-235` @ `b02aa62`)
```ts
export interface CcEvent {
  type: "init" | "assistant_text" | "tool_call" | "tool_result";
```

And nothing downstream would know what to do with it. `executor.ts`'s `onEvent`
(`:952-991`) has exactly four branches — `init`, `assistant_text`, `tool_call`,
`tool_result` — and the persisted entry kind is a closed union too:

`db/runs.ts` — `ThreadEntry["kind"]` (`:52` @ `b02aa62`)
```ts
  kind?: "text" | "tool_call" | "tool_result" | "heartbeat" | "error" | "comms";
```

A grep of all of `forge-control/src` for `task-notification` / `task_notification` /
`Async agent launched` returns **zero hits**. The engine has no concept of this payload.

**Bounded claim — what is proved and what is not.** Proved from code: *if* the completion
notification is not a `tool_result` block, it is dropped at `cc-runner.ts:502-514` and
cannot be represented by `CcEvent` anyway. Not proved from this build sandbox: the exact
wire shape of the notification. The `ai_os` database reachable from a build task has
`select count(*) from runs` = **0** (it is not the live store), so no captured payload
could be inspected, and the worktree-only policy forbids reaching for the live one from a
build task. **The one live check worth doing:** confirm on a real async-spawning run that
no thread entry carries the completion banner. Everything else here stands on code.

### 2c. Peer run → this run via `POST /api/runs/:id/message` — COVERED

This is the path the steward raised as counter-evidence, and the steward was right. It is
complete, and it is the reason the old blanket claim was wrong.

`forge-control/src/routes/run-control.ts:214` → `commsEntries` → `toThreadEntry`
(`run-control.ts:149`) → `appendCommsEntry` → `runs.thread`.

`routes/run-control.ts` — the `commsEntries(...)` call in `POST /:id/message` (`:259-266` @ `b02aa62`)
```ts
  const { receiver, echo } = commsEntries({
    text,
    from,
    targetRunId: id,
    senderRunId: senderId,
    ts,
    senderRole: await runRole(senderId),
    targetRole: typeof run.metadata.role === "string" ? run.metadata.role : null,
```

`run-control-rules.ts` — the `receiver` literal in `commsEntries()` (`:491-498` @ `b02aa62`)
```ts
  const receiver: CommsThreadEntry = {
    // role "user" so BOTH prompt builders deliver it unchanged —
    // trailingUserBlock for resumed sessions, buildPromptFromThread for fresh.
    role: "user",
    content,
    ts: i.ts,
    kind: "comms",
    meta: {
```

Tested: `forge-control/src/lib/run-control-rules.test.ts:468+` (`describe("commsEntries")`)
asserts the receiver/echo role+kind contract and the `[message from …]` prefixes.

Rendered client-side as a direction-marked card, not an anonymous user bubble:

`AssistantThread.tsx` — `CommsMessage()` (`:147-151` @ `b02aa62`)
```tsx
function CommsMessage({ facts }: { facts: CommsFacts }) {
  const peers = useContext(PeerRolesContext);
  const fallbackRole = facts.peerRunId ? (peers.get(facts.peerRunId) ?? null) : null;
  const header = commsHeader(facts, fallbackRole);
  const { identity } = header;
```

dispatched from `AssistantThread.tsx:233-235` (`UserMessage`) and `:277-278`
(`AssistantMessage`, for the outbound echo), with identity/colour resolved in
`comms-identity.ts`.

**Consequence:** every worker report, manager instruction and Konrad message that crosses
runs is already in `runs.thread` and already renders with direction and author. That is
the majority of agent→operator traffic on this system by volume.

---

## 3. What a fix would take

Small, and entirely inside files this project may not touch. Four edits:

1. **`cc-runner.ts`** — widen the union at `:235`:
   `type: "init" | "assistant_text" | "tool_call" | "tool_result" | "task_notification"`.
2. **`cc-runner.ts`** — add one `else if` to the `user` branch at `:502-514`, alongside
   the `tool_result` check, that recognises the notification block and emits the new
   event (carrying `parentToolUseId`, already in scope at `:462`).
3. **`db/runs.ts:52`** — add `| "task_notification"` to `ThreadEntry["kind"]`. No
   migration: `thread` is `jsonb` (same free ride `"comms"` took, C21).
4. **`executor.ts`** — one more branch in `onEvent` (`:952-991`) → an entry builder beside
   `toolResultEntry` (`:800-817`).

The client needs **nothing**: phase 4's renderers were built so an unrecognised `kind`
falls through to a visible block rather than being dropped (R20). A `task_notification`
entry would show up the day the engine emits one.

**Ownership: `engine-v2-research-lane`.** All four files are theirs this cycle. This
project deliberately changed none of them.

---

## 4. Reconciliation of the requirement

Per the standing rule — never silently drop, never quietly pass:

- **R19 stays OPEN.** A real gap remains (§2b). The requirement is not retired, and the
  `03-quality.md` phase-4 gate clause is left exactly as written — it asserts this file
  exists and that its quotes match `cc-runner.ts` at the pinned lines, which is now true
  against §1's SHA.
- **The claim was over-broad and is corrected**, not quietly narrowed: `00-vision.md:48`
  and `02-architecture.md:187` said agent completion payloads *never* reach the thread.
  Paths a1, a2 and c disprove that. Those lines now carry the narrowed claim and the
  corrected pins, each with a one-line drift note.
- **Line pins corrected** in **four** places — `00-vision.md:48`, `01-requirements.md:107`,
  `02-architecture.md:187` and `02-architecture.md:49`: `417–429` → `502–514`,
  `170–188` → `234–235`. (`02-architecture.md:49`, in the §2.2 "facts that gate design"
  list, carried the same rotted pin and the same over-broad claim; it was missed by a
  first grep pass that truncated its output, and caught by re-running it. Recorded here
  because a gate that greps for the old pin should find the reason, not a survivor.)
- **Two stale references knowingly left in place**, both dated evidence artifacts outside
  this task's writable set. Rewriting evidence after the fact is worse than leaving it
  stale; noted here so the next reader who greps `417-429` finds the explanation rather
  than a contradiction:
  - `docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md:107` — cites `cc-runner.ts:417-429`.
  - `docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json` — the captured chat in
    which the original R19 pins were derived. It is **test data**, not prose, and it is
    the artifact that let §1 prove the code never changed. Editing it would corrupt a
    fixture that `check-subagent-slice.ts` and the phase-4 checks run against.
