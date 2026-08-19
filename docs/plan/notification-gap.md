# notification-gap.md — what agent→operator traffic reaches `runs.thread`, and what dies

**Deliverable for R19** (`docs/plan/operator-visibility/01-requirements.md`), gated by
`docs/plan/operator-visibility/03-quality.md` phase 4. Written round 1350; §1 re-pinned and
§3's client claim corrected in round 1353, from round 1352's review; §2c's pins restored in
round 1355, from round 1354's review; **closed on live evidence in round 1863**.

**Status: the DELIVERABLE is discharged. The GAP is OPEN and confirmed.** (§4 separates the
two; they had been run together since round 1350.)

Two of the three agent→operator paths are fully covered today. One is not. The blanket
statement carried by 00-vision/02-architecture — *"agent completion payloads never reach
`runs.thread`"* — was **false as written** and is corrected in those files. What remains
open is one specific payload: the harness's **async task-completion notification** — and as
of round 1863 that is no longer an inference from reading `cc-runner.ts`. It was measured
against the live database, with the payload captured and its absence proved (§2b-live).

---

## 1. Provenance — read at, and how to detect drift

| | |
|---|---|
| Quotes read at | `fc49e35b1c72d20f7b2221666bcfd4c689eb5850` |
| Re-verified at | `b02aa6268777d0c42cd8e0ba01a6754c9213f967` — HEAD moved mid-task (two sibling commits in this shared worktree). Every cited range is **identical at both SHAs**; `git diff fc49e35 b02aa62` touches one cited file, `tool-summary.ts`, but not its cited lines 384–386. |
| **Re-pinned at** | **`852b089ce67b212d8a0503ff711ae9a8ce9e4f8e`** (round 1353), corrected again at round 1355. **Four** pins were wrong, all four rotted — see the correction table below. Round 1353 also reported two §2c pins as "transposed"; that correction was itself wrong and is withdrawn (the rows are kept, marked VERIFIED, so the next reader does not re-make it). **Every pin in this document was re-resolved against the tree, not only the ones the review named**, and all are current at this SHA. |
| Branch | `project/8ea0cc08` |
| Worktree state of quoted files | all nine cited files **clean** at `852b089` (`git status --porcelain` empty for each) |
| Read-only | every file below was opened read-only; `cc-runner.ts`, `executor.ts`, `run-control-rules.ts` are owned by **engine-v2-research-lane** |

Every quote below is **byte-identical** to its source range. Round 1350 checked that by
hand; round 1352's reviewer checked it by hand again and found a pin that had rotted
underneath it. A claim re-verified by hand every round is a claim that will eventually be
verified by nobody — so from round 1353 **the check is a script**:

```sh
node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
```

It runs in five passes, and the fifth — added round 1863 — is the one that makes the
other four's numbers mean something:

1. **Fenced quotes.** Every pinned heading in this file, read out of the working tree and
   diffed. **11.** An unmapped file name is a hard error and finding zero quotes is a
   failure, so this half cannot pass vacuously.
2. **Prose pins** (`PROSE_PINS` in the script). The `file:line` citations that appear in
   running text with no fence under them. Each is checked twice over: the doc must still
   bind that number to the *claim* it carries, and the line must still hold the symbol.
   **12.**
3. **Cross-document pins.** The lines this doc pins in `00-vision.md`,
   `01-requirements.md`, `02-architecture.md` and the phase-1 artifact. They rot exactly
   like code pins and nothing was watching them until round 1863. **7.**
4. **Live pins, repeats and historical pins** (`LINE_RULES`). Everything else: §3's recipe
   pins, the corrections table's was/now columns, §1's own rot narrative, §4's
   reconciliation list. A *repeat* names the `path:line` another pass verified and fails
   with it, so restating a pin can no longer outlive the pin. A *historical* pin — a number
   recorded because it rotted — carries a mandatory written reason. **4 live + 32 repeats
   + 44 historical.**
5. **The inventory.** The script tokenises the whole document — every `path.ext:NNN` and
   every bare `` `:NNN` ``, fenced or not, hyphen or en-dash — and asserts passes 1–4
   consumed all of them. **An unclassified pin is a hard failure, not a skip.**

Current result: **`ALL PASS — 110/110 pins classified`**, and 110 is the denominator, printed
next to the count. (It was 64 before round 1863's edits added eight more, 78 after round
1875 recorded a drift event, 92 after round 6 recorded the next one, and 110 after round
972 recorded the fourth — the denominator is derived from the document, not declared, so it
moves with the document. Round 972's +18 is its correction table's sixteen numbers plus the
two insertion points its narrative cites; recording a drift always costs pins, which is the
mechanism working and not an overhead to be trimmed. That is also
why this paragraph read `72/72` while the script printed `78/78`: round 1875's own
correction table added six pins and it updated the table but not this sentence — counted,
not assumed, by running the tokeniser over the document at `ed25c4f` and `0bfe05c`. The
script's number is the one to trust; this line is now re-measured against it.)

Pass 5 exists because of two specific failures, one of each kind. Round 1353 swapped §2c's
two pins onto each other's symbols; both numbers were still real lines in the file, so the
script — which then only saw fenced quotes — printed `ALL PASS — 11/11` with a wrong pin
four lines below a passing one. Round 1355 answered that with a hand-registered prose
table, and the summary then read `11 fenced + 12 prose`. That was honest but still
partial, and **partial coverage reported as a full pass is the defect**: `11/11` cannot
distinguish *checked everything* from *checked everything I could see*. It was in fact
23 of the 64 pins the document then held. The remaining 41 — including every number in the
corrections table that had just been so carefully argued over — were watched by nothing at
all.

Verified by negative control, in three directions, re-measured at round 6's baseline rather
than carried over from the previous round's text. The orphan control — append
`` `executor.ts:1` `` and a bare `` `:4242` `` to this file — exits 1 with `92/94
classified` and both orphans named by line.

The primary control — renumber the one fenced `db/runs.ts` pin from `:52` to `:53` — exits
1 with **four** failures: once for the quote itself, once for each of the three places the
doc restates that pin (§3's recipe item 3, §4's reconciliation list, and the sentence
above, which now restates it too). It was **three** before this round, and the extra one is
the mechanism working: describing a control in prose registers a repeat like any other
restatement. A repeat cannot outlive its primary.

Round 6 added the third control, aimed at its own repair rather than at the script's older
claims. Renumber the freshly re-pinned §2a1 quote from `:537-549` to `:534-545` and the
script exits 1 with **six** failures — the quote, plus every place this document restates
that pin: §1's rot narrative, §2's verdict table, the round-6 correction table, §3's recipe
item 2, and this paragraph. The five `cc-runner.ts` registrations added below are
load-bearing, measured, not assumed.

The script deliberately does **not** check the SHA — it verifies quotes against the tree
as it stands. Whether this doc's pins are still *current* is the other half, and that is
what this command answers:

```sh
git diff 852b089ce67b212d8a0503ff711ae9a8ce9e4f8e -- \
  forge-control/src/lib/cc-runner.ts \
  forge-control/src/executor.ts \
  forge-control/src/db/runs.ts \
  forge-control/src/lib/run-control-rules.ts \
  forge-control/src/lib/run-control-rules.test.ts \
  forge-control/src/routes/run-control.ts \
  forge-control-web/app/desktop/chat/AssistantThread.tsx \
  forge-control-web/app/desktop/chat/thread-mapping.ts \
  forge-control-web/app/desktop/chat/tool-summary.ts \
  forge-control-web/app/desktop/chat/subagent-slice.ts \
  docs/plan/operator-visibility/00-vision.md \
  docs/plan/operator-visibility/01-requirements.md \
  docs/plan/operator-visibility/02-architecture.md \
  docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md
```

Non-empty output means the line pins in this doc may be stale — re-derive them with
`grep -n` before trusting any `file:line` here. Per the standing citation rule
(`01-requirements.md:5-11`), every quote below is headed by its **stable symbol anchor**
first and its line pin second; if the pin rots, `grep` the symbol.

**Round 1352's reviewer caught this command watching the wrong half of the corpus, and
was right.** It listed only the four engine files, so the three *client* files this doc
cites — `AssistantThread.tsx`, `tool-summary.ts`, `subagent-slice.ts` — could rot
unwatched, and one of them promptly did: sibling commit `0938385` (browser shots),
landing in this shared worktree after the doc's own commit `91b0fa7`, inserted two lines
into `AssistantThread.tsx` above every pin this doc holds on it.

Round 1353 widened it to nine files and **it was still short by five**: the test file §2c
pins (`run-control-rules.test.ts`), the three sibling planning docs §4 pins, and the
phase-1 artifact §4 pins. The same defect, one layer out — an instrument that watches most
of its subject reports a clean bill for the part it cannot see. The command above now
lists **all fourteen** files this document pins, and pass 3 of the verifier checks the
four documentary ones by content rather than trusting the diff to be read.

Rather than correct only the three pins the review named, **every pin in this file was
re-resolved** — which turned up two more the review had not looked at:

| Pin | Was | Now (`852b089`) | Cause |
|---|---|---|---|
| `AssistantThread.tsx` `CommsMessage()` | `:147-151` | `:149-153` | `0938385`, +2 lines above |
| `AssistantThread.tsx` `UserMessage` dispatch | `:233-235` | `:235-237` | same |
| `AssistantThread.tsx` `AssistantMessage` dispatch | `:277-278` | `:279-281` | same |

**Round 1875 found the same three pins rotted again — the second drift event on this exact
file, not `0938385` this time but rounds 1871/1873/1875 landing directly in this project's
own worktree.** Re-resolved the same way, against `ed601ff`:

| Pin | Was (`852b089`) | Now (`ed601ff`) | Cause |
|---|---|---|---|
| `AssistantThread.tsx` `CommsMessage()` | `:149-153` | `:158-162` | rounds 1871/1873/1875, +9 lines above; `fallbackRole` also renamed to `peer` (same binding, `commsHeader(facts, peer)`) |
| `AssistantThread.tsx` `UserMessage` dispatch | `:235-237` | `:331-333` | same three rounds, +96 lines above |
| `AssistantThread.tsx` `AssistantMessage` dispatch | `:279-281` | `:375-376` | same three rounds, +96 lines above; the cited span narrows to the two functional lines (`useCommsFacts()` call + dispatch) because a two-line comment now sits between the function signature and them |
| `tool-summary.ts` "Async agent launched" banner note | `:384-386` | `:406-409` | `852b089`, this round's own `EMPTY_GIST` edit above it |
| §2c `POST /:id/message` | `:214` | `:214` | **VERIFIED, unchanged.** Round 1353 "corrected" this to `:149`; that was the error, and it is reverted. |
| §2c `toThreadEntry` | `:149` | `:149` | **VERIFIED, unchanged.** Same withdrawn correction, the other half. |
| `subagent-slice.ts` the inline-entries fact | `:11-17` | `:11-17` | unchanged |

**The third drift event, found by a different project's phase gate — and this time on the
other file, every `cc-runner.ts` pin in this document at once.** Not a review that went
looking: `scripts-checks-typecheck-gate` (branch `project/b7ab4c57`, round 6) ran
`gates-808.sh --strict` and this verifier came back `8 FAILURE(S)`, red on `main` as well
as on the branch. Cause:
rounds 900 and 902 (`7464f4c`, +14 lines; `9b960ef`, +17) grew `buildSystemPrompt`'s
prompt text with the screenshot convention, inserting **31 net lines above every pin this
document holds on `cc-runner.ts`** and none between them — so all five moved by exactly
+31 and the quoted bodies are byte-identical at the new offsets, machine-diffed, not
re-read. Re-resolved against `9b960ef` (the tip of `main`, and the last commit to touch
the file):

| Pin | Was (`852b089`) | Now (`9b960ef`) | Cause |
|---|---|---|---|
| `cc-runner.ts` §2a1 the `evt.type === "user"` branch | `:502-514` | `:533-545` | rounds 900/902, +31 lines above; body unchanged |
| `cc-runner.ts` §2a2 the `parentToolUseId` lift | `:459-465` | `:490-496` | same, +31; body unchanged |
| `cc-runner.ts` §3 the `CcEvent` union | `:234-235` | `:265-266` | same, +31; body unchanged |
| §3 recipe item 2 — the `parentToolUseId` binding in scope | `:462` | `:493` | same, +31 |
| §3 recipe item 1 — the `CcEvent` `type` field to widen | `:235` | `:266` | same, +31 |

The 852b089 numbers above are kept as the historical record, not overwritten — same
treatment round 1875 gave `AssistantThread.tsx`. Note what did **not** change: §2b's
verdict, the round-600 fixture argument at §1, and the `170–188` → `234–235` correction in
§4, which record where these lines *were* and are correct as history. The gap this
document reports is untouched; only its coordinates moved.

**The fourth drift event — BOTH files at once, and the first one caused by a merge rather
than by an edit.** Found the same way as the third: `engine-task-graph` (branch
`project/8c591d6c`, round 972 fix cycle 1) ran `gates-808.sh --strict` and this verifier
came back `20 FAILURE(S)`. It was `ALL PASS — 92/92` at that branch's pre-merge tip
`af3cba6` and red at `37cc974`, measured at both, so the merge is the cause and not a
coincidence of timing.

Cause, and it is a shape worth naming: **nobody edited a pinned file on this branch.**
`main` moved underneath. Two upstream commits inserted lines above every pin this document
holds — `6a9406d` added 4 lines to `buildSystemPrompt` in `cc-runner.ts` (at old `:205`,
so `+4` to all five cc-runner pins) and `1e0330b` added one import line to
`AssistantThread.tsx` (at old `:33`, so `+1` to all three, its other insertions all sitting
*below* them). Neither commit's author could have seen this verifier: it does not exist on
`main`, so `main` has never run it. Two lanes, one file, and the gate only meets the change
at the merge.

Bodies unchanged, machine-diffed at both offsets, not re-read. Re-resolved against
`37cc974` (this branch's merge commit — the tree in which the new numbers are correct):

| Pin | Was (`ed601ff`/`9b960ef`) | Now (`37cc974`) | Cause |
|---|---|---|---|
| `AssistantThread.tsx` `CommsMessage()` | `:158-162` | `:159-163` | `1e0330b`, +1 line above; body unchanged |
| `AssistantThread.tsx` `UserMessage` dispatch | `:331-333` | `:332-334` | same, +1; body unchanged |
| `AssistantThread.tsx` `AssistantMessage` dispatch | `:375-376` | `:376-377` | same, +1; body unchanged |
| `cc-runner.ts` §2a1 the `evt.type === "user"` branch | `:533-545` | `:537-549` | `6a9406d`, +4 lines above; body unchanged |
| `cc-runner.ts` §2a2 the `parentToolUseId` lift | `:490-496` | `:494-500` | same, +4; body unchanged |
| `cc-runner.ts` §3 the `CcEvent` union | `:265-266` | `:269-270` | same, +4; body unchanged |
| §3 recipe item 2 — the `parentToolUseId` binding in scope | `:493` | `:497` | same, +4 |
| §3 recipe item 1 — the `CcEvent` `type` field to widen | `:266` | `:270` | same, +4 |

The `ed601ff` and `9b960ef` tables above are kept and **were not overwritten** — the same
treatment rounds 1875 and 6 gave their predecessors. A "Now" column that silently acquires
a later tree's numbers claims that tree held them, which is the rot this document exists to
catch, wearing the costume of a fix. §2b's verdict and the gap itself are untouched; only
the coordinates moved, for the fourth time.

**The withdrawn correction, recorded rather than deleted (round 1354's review, finding 1).**
Round 1353 reported the two §2c pins as transposed since round 1350 and swapped them. They
were not transposed. The tree says, at `main`, at `91b0fa7` and at `852b089` alike —
`run-control.ts` has never been touched on this branch:

```sh
git -C . grep -n 'function toThreadEntry\|r.post("/:id/message"' -- forge-control/src/routes/run-control.ts
# 149:function toThreadEntry(e: CommsThreadEntry): ThreadEntry {
# 214:r.post("/:id/message", async (c) => {
```

Round 1350's original mapping — route at `:214`, serializer at `:149` — was right, and the
"correction" made this document wrong in the exact place it was boasting about accuracy.
Both numbers are back where they started. The rows above stay in the table, marked
VERIFIED, because an empty row invites the same swap next round.

**Re-verified independently at round 1863**, because a corrections table that blames the
wrong round is worse than no table and this one had already been rewritten twice:

```sh
for ref in HEAD main 91b0fa7; do
  git show $ref:forge-control/src/routes/run-control.ts |
    grep -n 'function toThreadEntry\|r.post("/:id/message"'
done
# 149:function toThreadEntry(...)   214:r.post("/:id/message", ...)   — identical at all three
git log --oneline main..HEAD -- forge-control/src/routes/run-control.ts   # (no output)
```

The file has never been touched on this branch. **Round 1350 was correct; the inversion was
introduced by round 1353 and withdrawn by round 1355.** Attribution stands as written above
— this round changed nothing in that table except to confirm it against the tree.

Three lessons, all mechanical rather than editorial. **A drift command must list every file
the document cites** — the one file it omitted is the one that moved. **A rotted pin and a
wrong pin fail identically for the reader**, which is why the verifier script now exists.
And **an unrequested correction needs the same evidence as the defect it claims to fix**:
the four rotted pins were each proved by a `git diff` naming the commit that moved them;
the transposition was asserted from reading, against a file that had not changed, and it
survived into a commit whose message said every pin had been re-resolved. The verifier
would not have caught it either — these two are unfenced prose pins, so they sat four lines
below a passing quote inside an `ALL PASS — 11/11` run. That hole is closed: the script now
carries an explicit prose-pin table (§1's `PROSE_PINS`), and its SCOPE comment states what
it does and does not cover.

**How the previous pins rotted — and the useful thing that falls out of it.** R19 was
written against `cc-runner.ts:170–188` / `:417–429`. At `b02aa62`, `:170–188` is
`buildSystemPrompt`'s prompt text and `:417–429` is the idle-timeout kill logic. Neither
has anything to do with events.

But the round-600 chat fixture (`docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json`)
recorded the **verbatim snippet** the author quoted at `:417–429` — and it is
**character-for-character identical** to the block now at `:537–549`, machine-diffed. So
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
| b | **Async task-completion notification** — the harness banner that says a background agent finished | **UNCOVERED — dies in `cc-runner.ts:537–549`. Confirmed on the live database round 1863, not inferred: see §2b-live.** |
| c | Peer run messaging this run via `POST /api/runs/:id/message` | **COVERED** end to end: engine → thread → client renderer, with tests |

### 2a1. Synchronous sub-agent final text — COVERED

The CLI emits the sub-agent's final report as a `tool_result` block on a `user` event.
`cc-runner` forwards exactly that block shape:

`cc-runner.ts` — the `evt.type === "user"` branch of the stream-line handler (`:537-549` @ `9b960ef`)
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

`executor.ts` — the `tool_result` branch of `onEvent` (`:982-986` @ `852b089`)
```ts
    } else if (e.type === "tool_result") {
      const entry = toolResultEntry(e);
      enqueue(() => appendThreadEntry(run.id, entry));
    }
  };
```

`executor.ts` — `toolResultEntry()` (`:800-817` @ `852b089`)
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

`cc-runner.ts` — the `parentToolUseId` lift (`:494-500` @ `9b960ef`)
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
- `forge-control-web/app/desktop/chat/tool-summary.ts:406-409` (@ `852b089`) — *"An async
  spawn returns the harness's `Async agent launched successfully…` banner"*.

The real completion is delivered by the harness as content injected into the parent's
**next user turn**. It is not a `tool_result` block. And `cc-runner`'s `user` handler,
quoted in full at §2a1 above, forwards **only** `block.type === "tool_result"`. There is
no `else`, no `default`, no log line: any other block type in a user message is dropped
on the floor, silently.

Even if that branch existed, there is nothing to emit — the event union is closed:

`cc-runner.ts` — the `CcEvent` union (`:269-270` @ `9b960ef`)
```ts
export interface CcEvent {
  type: "init" | "assistant_text" | "tool_call" | "tool_result";
```

And nothing downstream would know what to do with it. `executor.ts`'s `onEvent`
(`:952-986` @ `852b089`) has exactly four branches — `init`, `assistant_text`, `tool_call`,
`tool_result` — and the persisted entry kind is a closed union too:

`db/runs.ts` — `ThreadEntry["kind"]` (`:52` @ `852b089`)
```ts
  kind?: "text" | "tool_call" | "tool_result" | "heartbeat" | "error" | "comms";
```

A grep of all of `forge-control/src` for `task-notification` / `task_notification` /
`Async agent launched` returns **zero hits**. The engine has no concept of this payload.

### 2b-live. The wire shape, observed (round 1863)

Rounds 1350–1355 could only bound this claim: *if* the notification is not a `tool_result`
block it is dropped, but the sandbox `ai_os` DB had `select count(*) from runs` = 0 and
worktree policy barred the live one. Round 1863 was the first task briefed against the live
store (`content_forge` on `127.0.0.1:5432`, DSN read from `pm2 env` of `forge-control`).
**The check no longer stands on code.**

**Method — the instrument is the run itself.** A builder run *is* a Claude Code session
whose thread is persisted by `executor.ts` as it streams. So run
`07e59e8e-7acf-4077-a10b-53ed900631cf` (this document's own round-1863 run) spawned one
real async sub-agent, received its completion notification in-context, and then read its
own `runs.thread` back out of the live database. Nothing was fabricated and nothing was
written: the only writes are the executor's ordinary appends.

The spawn produced exactly three kinds of entry, and the notification is not among them:

| thread idx | role / kind | `meta` | what it is |
|---|---|---|---|
| 45 | `tool` / `tool_call` | `tool_use_id: toolu_019chfnXfiuBjZAJTi5fkoL5` | the `Agent` spawn |
| 46 | `tool` / `tool_result` | same `tool_use_id` | **the launch ack only** — `"Async agent launched successfully…"` |
| 47–49 | `tool`,`tool`,`assistant` | `parent_tool_use_id: toolu_019chf…` | the sub-agent's own work, inline (§2a2, live-confirmed) |
| — | — | — | **the completion notification: no entry at all** |

The raw entry the sub-agent's closing text produced, verbatim from `runs.thread`:

```json
{
  "ts": "2026-08-17T07:41:27.545Z",
  "kind": "text",
  "meta": {
    "model": "claude-haiku-4-5-20251001",
    "usage": { "input_tokens": 8, "output_tokens": 4,
               "cache_read_input_tokens": 8201, "cache_creation_input_tokens": 258 },
    "provider": "claude-code",
    "parent_tool_use_id": "toolu_019chfnXfiuBjZAJTi5fkoL5"
  },
  "role": "assistant",
  "content": "091e05c docs(round1862): deploy — the rebuild that proved which bytes are being served"
}
```

**And the payload that never became an entry**, captured from the receiving run's own
context at `07:41:27Z`, four seconds after the spawn:

```xml
<task-notification>
<task-id>a56e564fcc6b6c94d</task-id>
<tool-use-id>toolu_019chfnXfiuBjZAJTi5fkoL5</tool-use-id>
<output-file>/tmp/claude-0/…/tasks/a56e564fcc6b6c94d.output</output-file>
<status>completed</status>
<summary>Agent "Wire-shape probe subject" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children
of its own. …the same task-id may notify more than once.</note>
<result>091e05c docs(round1862): deploy — the rebuild that proved which bytes are being served</result>
<usage><subagent_tokens>8481</subagent_tokens><tool_uses>1</tool_uses><duration_ms>4378</duration_ms></usage>
</task-notification>
```

**Four things are now settled, and one deliberately is not.**

1. **It is not a `tool_result` block.** This is the question rounds 1350–1355 could not
   answer, and it is answered by *negative space*, rigorously: `cc-runner`'s `user` branch
   (§2a1) forwards **every** `tool_result` block unconditionally — no filter on tool, id or
   size — and `appendThreadEntry` (`executor.ts:484-493`) is a bare
   `thread = thread || $2::jsonb` with no dedup. Had the notification been a `tool_result`,
   an entry would exist. Nine further entries were appended to this run after index 49, so
   this is absence, not flush lag.
2. **`CcEvent` cannot represent it.** Unchanged from the code reading, now with the payload
   in hand: the union is `init | assistant_text | tool_call | tool_result`, and this is a
   structured record with eight fields, not a text blob.
3. **It carries the spawning `tool_use_id`.** `<tool-use-id>` is byte-identical to the
   `Agent` call's `meta.tool_use_id`. §3's second emission shape — bind the completion to
   the row that spawned it — is therefore *implementable*; the engine has the join key.
4. **`role`/`kind` are not applicable.** The notification never reaches the layer where a
   `ThreadEntry` gets a role. Asking "what role does it arrive with" presumes an entry that
   does not exist.

Not settled, and left unsettled rather than guessed: the raw **stream-json block type** the
CLI emits. Fact 1 proves it is not `tool_result`; it does not prove *what* it is. That
requires reading `cc-runner`'s stdin, which is engine territory this project may not enter.
The engine lane will see it the moment it adds the `else` branch item 2 asks for, and
should record it there.

**Census, to show this is not one unlucky run.** At `2026-08-17 07:53:17+00` the live store
held **596** runs and **57,745** thread entries, and the complete set of `(role, kind)`
pairs across every one of them is:

```
tool/tool_call 25025   tool/tool_result 25026   assistant/text 6535   user/text 772
user/comms 132         agent/comms 115          system/error 101      system/text 24
system/stuck_notice 15
```

**Nine pairs. No notification kind exists anywhere in the corpus.** (The entry count drifts
upward between queries because the measuring run is itself one of the 596 — quoted with a
timestamp for that reason.) **17** runs carry a genuine launch ack — 63 acks in total, up
to **11 in a single run** (`a86cf7b3`) and 8 in `6528014e` — and not one of those 63 spawns
left a completion entry behind. Every apparent hit for `task-notification` or
`agent_completed` in the corpus is a run that was *editing this document* or probing the
mapper; there are no false positives left after excluding those.

### 2c. Peer run → this run via `POST /api/runs/:id/message` — COVERED

This is the path the steward raised as counter-evidence, and the steward was right. It is
complete, and it is the reason the old blanket claim was wrong.

`POST /:id/message` (`run-control.ts:214` @ `852b089`) → `commsEntries` → `toThreadEntry`
(`run-control.ts:149` @ `852b089`) → `appendCommsEntry` → `runs.thread`.

`routes/run-control.ts` — the `commsEntries(...)` call in `POST /:id/message` (`:259-266` @ `852b089`)
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

`run-control-rules.ts` — the `receiver` literal in `commsEntries()` (`:491-498` @ `852b089`)
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

`AssistantThread.tsx` — `CommsMessage()` (`:159-163` @ `ed601ff`)
```tsx
function CommsMessage({ facts }: { facts: CommsFacts }) {
  const peers = useContext(PeerRolesContext);
  const peer = facts.peerRunId ? (peers.get(facts.peerRunId) ?? null) : null;
  const header = commsHeader(facts, peer);
  const { identity } = header;
```

dispatched from `AssistantThread.tsx:332-334` (`UserMessage`) and `:376-377`
(`AssistantMessage`, for the outbound echo) @ `ed601ff`, with identity/colour resolved in
`comms-identity.ts`.

**Consequence:** every worker report, manager instruction and Konrad message that crosses
runs is already in `runs.thread` and already renders with direction and author. That is
the majority of agent→operator traffic on this system by volume.

---

## 3. What a fix would take

Small, and entirely inside files this project may not touch. Four edits:

1. **`cc-runner.ts`** — widen the union at `:270`:
   `type: "init" | "assistant_text" | "tool_call" | "tool_result" | "task_notification"`.
2. **`cc-runner.ts`** — add one `else if` to the `user` branch at `:537-549`, alongside
   the `tool_result` check, that recognises the notification block and emits the new
   event (carrying `parentToolUseId`, already in scope at `:497`).
3. **`db/runs.ts:52`** — add `| "task_notification"` to `ThreadEntry["kind"]`. No
   migration: `thread` is `jsonb` (same free ride `"comms"` took, C21).
4. **`executor.ts`** — one more branch in `onEvent` (`:952-986` @ `852b089`) → an entry builder beside
   `toolResultEntry` (`:800-817`).

### 3a. The client — what round 1352 got wrong, and what round 1353 did about it

**The sentence that used to stand here was false, and it was the one sentence of this
document the receiving lane would act on.** It read: *"The client needs **nothing**:
phase 4's renderers were built so an unrecognised `kind` falls through to a visible block
rather than being dropped (R20). A `task_notification` entry would show up the day the
engine emits one."*

R20 (`01-requirements.md:112-113`) did **not** hold on the `role: "tool"` path. Item 4
above says to build the entry beside `toolResultEntry`, and `toolResultEntry` returns
`role: "tool"` (`executor.ts:806`). At `b02aa62` the mapper's final branch for that role
was an unconditional `silent++` with the comment *"the walk has never rendered these and
this round does not change that"* — correct about the kinds it named, wrong as a
catch-all. An implementer following item 4 verbatim would have written the notification
into `runs.thread`, watched it disappear, and had this document's word that no client
change was needed. Round 1352's reviewer probed it and got `rendered=false, silent=1`.

**The fix taken was (a): the client was changed, so that the claim is now true.** It is
this project's own file, so weakening the recipe was the wrong trade — a spec that says
"and also edit the client" is a spec with a second thing to get wrong.

`thread-mapping.ts` — `SILENT_TOOL_KINDS` (`:158-165` @ `852b089`)
```ts
const SILENT_TOOL_KINDS: ReadonlySet<string> = new Set([
  "heartbeat",
  "continue_marker",
  "error",
  "stuck_notice",
  "text",
  "",
]);
```

`thread-mapping.ts` — the walk's final branch (`:375-380` @ `852b089`)
```ts
    if (SILENT_TOOL_KINDS.has(e.kind ?? "")) {
      silent++;
      return;
    }
    if (content.trim()) openParts.push({ type: "text", text: content });
    else silent++;
```

The distinction is **deliberate-vs-unknown**, not known-vs-all. A kind on the whitelist is
skipped on purpose and still counted into `coverage.silent`; anything the client has never
heard of degrades to a visible text part, exactly as an orphaned `tool_result` already
does. Every kind on the wire today is on the whitelist, so output on all existing threads
is byte-identical — `check-thread-mapping.ts`'s "the default did not move" table and the
285-entry real-fixture conservation table both still pass.

**Evidence, not assertion.** `scripts/checks/check-thread-mapping.ts` gained a section
"R20 ON THE TOOL ROLE", run with
`cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-thread-mapping.ts`:

```
── R20 ON THE TOOL ROLE: an UNKNOWN kind renders (round 1353) ─
PASS  an unknown kind produces one assistant message
PASS  …carrying its payload verbatim
PASS  …and is NOT counted silent
PASS  …conservation holds
PASS  …and for kind "agent_completed" too
PASS  …and for kind "some_kind_nobody_has_written_yet" too
PASS  an unknown kind with no content is silent — never a blank bubble
PASS  …and produces no message
PASS  deliberate silence kept: tool/heartbeat renders nothing
PASS  deliberate silence kept: tool/continue_marker renders nothing
PASS  deliberate silence kept: tool/error renders nothing
PASS  deliberate silence kept: tool/stuck_notice renders nothing
PASS  deliberate silence kept: tool/text renders nothing
PASS  deliberate silence kept: tool/(no kind) renders nothing
```

The test builds its `task_notification` entry with a **cast**, deliberately, because the
client's `ThreadEntry["kind"]` union does *not* contain it and must not have to: the
engine lane widens `db/runs.ts:52`, and the client renders the payload with no
coordinated type change on this side. That is the only thing "the client needs nothing"
can honestly mean, and it is now executable rather than asserted.

**So, for the receiving lane, precisely:**

- The four edits above are the whole fix. **No fifth edit.**
- The entry may carry `role: "tool"` — `toolResultEntry`'s shape, item 4's natural
  reading — and it will render. It will render on `assistant`, `system` and `user` too.
- It renders as a **plain text part inside the assistant turn**, carrying `content`
  verbatim. It does *not* get the collapsible tool-block treatment.
- **CORRECTED ROUND 1863 — the sentence that used to follow was false, and it was the
  other sentence of this document a receiving lane would act on.** It read: *"a
  `tool_result` bound to the spawning Agent call's `tool_use_id` would attach to the
  existing Agent row … Either shape works; only the second is collapsible."* **Neither
  shape is collapsible.** The binding loop at `thread-mapping.ts:334-353` searches
  backwards for a tool-call part with **`part.result === undefined`**, and by the time the
  completion arrives that slot is already filled — by the launch ack, which the harness
  delivers on the *same* `tool_use_id` seconds earlier (§2b-live, entries 45→46). The
  second `tool_result` therefore matches nothing, falls through to the orphan branch at
  `:351`, and degrades to **the same loose text part as shape A**.

  Measured, not read, on the live-captured payload of §2b-live, both shapes through
  `mapThreadView`: `2 part(s): tool-call, text — collapsible=false`, silent count
  unchanged, payload verbatim in both. So: **pick either shape on its merits; neither buys
  you the collapsible row today.** If the collapsible row is what the operator wants, that
  is a **client** change — deciding what the Agent row displays once it has two results
  (replace the ack, append below it, or show ack-then-outcome) — and it is an interaction
  decision for Konrad, not something the engine lane can obtain by choosing an emission
  shape. Flagged to the manager round 1863; **not silently chosen here.**
- `content` must be non-empty. An entry with blank content is counted `silent` on purpose —
  the client will not draw an empty bubble.

**Ownership: `engine-task-graph` (`8c591d6c`) — corrected round 1863.**

This recipe was addressed to `engine-v2-research-lane` from round 1350 until now. That
project is **`done`** (verified against `GET /api/projects`), so §3 has spent five rounds
addressed to a lane that had closed. *A recipe addressed to nobody is a recipe nobody
executes* — which is the likeliest reason four one-line edits have sat here undone.

`cc-runner.ts`, `executor.ts`, `db/runs.ts` and the engine prompts belong to
**`engine-task-graph`** this cycle. Note for whoever routes this: that project is
currently **`paused`**, not active — so the four edits need it resumed, or a successor lane
that inherits the engine files. Stated rather than assumed, because "someone owns it" was
exactly the assumption that failed here.

The same stale addressee survives in three files this round could not write —
`00-vision.md:48` ("the engine-v2 lane"), `01-requirements.md:107` and
`02-architecture.md:187` ("engine-v2-research-lane"). Whoever next holds those files
should correct them; they are listed here so the correction is not lost.

This project deliberately changed none of the four engine files; the one file it did
change, `thread-mapping.ts`, is its own.

---

## 4. Reconciliation of the requirement

Per the standing rule — never silently drop, never quietly pass:

- **R19: the DELIVERABLE is discharged; the GAP stays OPEN. Two different things, and
  conflating them is what kept this entry ambiguous for five rounds.**

  R19 (`01-requirements.md:107`) asks for a document that states *exactly what is missing,
  where it dies, what a fix would take, and why it is out of scope here*, and says in its
  own words **"No code change for this item."** Every one of those four is now established
  on **live evidence** rather than inference (§2b-live): the payload is captured, its
  absence from `runs.thread` is measured against a 596-run census, the recipe is corrected
  in the two places it was wrong, and the owner is named and reachable. The last
  unverifiable element — the wire shape — was the only thing round 1355 could not reach,
  and it is reached. **As a deliverable, R19 is met.**

  **The gap itself is not closed and this round did not close it.** The engine still drops
  the notification; the four edits in §3 are unwritten; they belong to a paused lane. R19
  never asked this project to fix that, so the gap is carried as an open engine item, not
  as an open R19.

  **Assessed end to end, both halves, per round 1352's standing lesson** — "the four edits
  exist" is not closure:
  - **Engine emits?** **NO.** Live-confirmed today, not read from source.
  - **Client renders, if the engine ever emits?** **YES**, and now proved against the
    *actual* payload rather than a synthetic string — both candidate emission shapes,
    through `mapThreadView`: payload verbatim, not counted silent, no message lost.
    Round 1353's client fix holds.
  - **Recipe correct?** **It was not.** Two false statements found and corrected: the
    collapsibility claim (§3) and the addressee (§3). Both were sentences a receiving lane
    would have acted on.

  **The `03-quality.md` phase-4 gate clause is left byte-for-byte as written, and it
  passes on its own terms** — it asserts this file exists and that its quoted code matches
  `cc-runner.ts` at the pinned lines. It does, and now 64 pins are checked rather than 11.
  Nothing was retired, nothing was softened, and the clause was not reinterpreted to make
  it passable.

- **NOT VERIFIABLE AS WRITTEN — one item, declared rather than quietly passed.** The raw
  stream-json *block type* of the notification. §2b-live proves it is **not** a
  `tool_result` (negative-space proof: forwarding is unconditional and appends do not
  dedup, so an entry would exist). It does not prove what the block positively *is* —
  that needs `cc-runner`'s stdin, which is engine territory. Measured instead: the
  delivered payload, its eight fields, its `tool_use_id` join key, and its total absence
  from the thread. Left open for the engine lane to record when it adds the `else` branch.
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
- **One correction is WITHDRAWN, not quietly deleted** (round 1355, from round 1354's
  review). Round 1353 reported §2c's two pins as transposed since round 1350 and swapped
  them; they had been right at every SHA, and the swap made them wrong. Both are back on
  round 1350's mapping, the correction table keeps the rows marked VERIFIED, and the
  verifier now covers prose pins so the next such claim has to be made against a check
  rather than against a reading. The general lesson is in §1: an unrequested correction
  needs the same evidence as the defect it claims to fix.
- **R20 was cited for something it did not cover, and the gap is closed rather than
  reworded** (round 1353, from round 1352's review). §3's old closing sentence asserted
  R20 held for `role: "tool"`; `thread-mapping.ts`'s catch-all `silent++` was an explicit,
  commented exception to it, and the reviewer's probe returned `rendered=false`. The
  citation is not softened and the recipe is not lengthened: the client was changed so
  that R20 is true on that path, with an executable table as the evidence (§3a). R20
  itself needs no amendment — it always said what it should; the code did not honour it.
- **Two stale references knowingly left in place**, both dated evidence artifacts outside
  this task's writable set. Rewriting evidence after the fact is worse than leaving it
  stale; noted here so the next reader who greps `417-429` finds the explanation rather
  than a contradiction:
  - `docs/plan/artifacts/phase1/ended-at-is-a-launch-ack.md:107` — cites `cc-runner.ts:417-429`.
  - `docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json` — the captured chat in
    which the original R19 pins were derived. It is **test data**, not prose, and it is
    the artifact that let §1 prove the code never changed. Editing it would corrupt a
    fixture that `check-subagent-slice.ts` and the phase-4 checks run against.
