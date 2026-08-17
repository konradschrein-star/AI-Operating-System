# 04 — R19 closed on live evidence, and the pin verifier's blind spot

**Round 1863, step 3b of 4.** Runs in parallel with 3a (production acceptance). Touched
files: `docs/plan/notification-gap.md`, `docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`,
this artifact. `03-quality.md` **not touched** — nothing was retired, so its gate clause
stands byte-for-byte.

---

## 0. Headline

| Obligation | Outcome |
|---|---|
| A — wire shape from the live DB | **OBSERVED.** Payload captured; absence from `runs.thread` measured, not inferred. |
| B — engine emits **and** client renders | Engine: **NO** (live-confirmed). Client: **YES** (proved on the real payload). Recipe: **two false statements found and corrected.** |
| C.1 — verifier covers every pin | **11 → 72**, with the denominator printed. Two negative controls. |
| C.2 — corrections table restored | **Already correct at HEAD** (round 1355 did it). Re-verified against three SHAs; attribution confirmed, evidence added. |
| C.3 — widen the drift command | Was **9 files, short by 5**. Now **14**, and pass 3 checks the documentary ones by content. |
| R19 verdict | **Deliverable discharged. Gap OPEN and confirmed.** These are two things; the corpus had run them together since round 1350. |
| Declared NOT VERIFIABLE AS WRITTEN | The raw stream-json *block type*. See §2.4. |

**One correction to the task brief, load-bearing enough to state up front.** The brief said
"the builder role's tool list contains no Task, so ONLY architect runs can spawn
sub-agents — do not waste time querying builder/reviewer runs." **That is false.** This
builder run holds the `Agent` tool and used it; builder run `97143435` carries 100
sub-agent entries and `bd177d82` carries a genuine async launch ack. Had I followed the
brief's hunting instruction I would have skipped the only instrument that could answer the
question — a builder run, namely this one.

---

## 1. Path discrepancy, stated so nobody greps for the wrong file

The brief names `scripts/checks/verify-notification-gap-pins.mjs`. **That file does not
exist.** The verifier lives at `docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`
and always has (created in `7f51843`, round 1353). Edited in place; no file was moved.

---

## 2. Obligation A — the wire shape, from the live database

**DSN.** `DATABASE_URL` read from `pm2 env 16` (forge-control) →
`postgresql://postgres:***@127.0.0.1:5432/content_forge`. **596 runs**, 57,745 thread
entries. Read-only throughout; the only writes to that database during this task are the
executor's ordinary appends to this run's own thread.

### 2.1 Method — the run is the instrument

No such run existed to be *found*: no run in the corpus carries a completion entry (that
being the finding). The brief permits triggering one, and forbids manufacturing a synthetic
row. So neither was done. Instead: **a builder run is itself a Claude Code session whose
thread `executor.ts` persists as it streams.** This run — `07e59e8e-7acf-4077-a10b-53ed900631cf`
— spawned one real async sub-agent (`scout`, haiku, one `git log` command), received its
completion notification in-context, and then read its own `runs.thread` back out of the
live DB. Real harness, real `cc-runner`, real executor, real database, nothing fabricated.

### 2.2 What landed in `runs.thread`

| idx | role / kind | meta | what |
|---|---|---|---|
| 45 | `tool` / `tool_call` | `tool_use_id: toolu_019chfnXfiuBjZAJTi5fkoL5` | the `Agent` spawn |
| 46 | `tool` / `tool_result` | same `tool_use_id` | **launch ack only** |
| 47 | `tool` / `tool_call` | `parent_tool_use_id: toolu_019chf…` | sub-agent's Bash call |
| 48 | `tool` / `tool_result` | `parent_tool_use_id: …` | its output |
| 49 | `assistant` / `text` | `parent_tool_use_id: …` | sub-agent's final text |
| — | — | — | **the completion notification: NOTHING** |

Raw JSON of entry 49, verbatim from `runs.thread` (`jsonb_pretty`), redaction: none needed:

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

Raw JSON of entry 46 — the ack, which §2b had only ever cited second-hand:

```json
{
  "ts": "2026-08-17T07:41:23.188Z",
  "kind": "tool_result",
  "meta": { "is_error": false, "tool_use_id": "toolu_019chfnXfiuBjZAJTi5fkoL5" },
  "role": "tool",
  "content": "Async agent launched successfully. …\nagentId: a56e564fcc6b6c94d …\nThe agent is working in the background. You will be notified automatically when it completes. …"
}
```

### 2.3 The payload that never became an entry

Delivered to this run's context at `07:41:27Z`, four seconds after the spawn:

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

### 2.4 What this settles, and the one thing it does not

1. **Not a `tool_result` block.** Proved by negative space, and the proof is tight because
   both links are unconditional: `cc-runner`'s `user` branch forwards **every**
   `tool_result` block with no filter on tool, id or size, and `appendThreadEntry`
   (`executor.ts:484-493`) is a bare `thread = thread || $2::jsonb` with **no dedup**. Had
   it been a `tool_result`, an entry would exist. **Nine further entries were appended
   after index 49**, so this is absence, not flush lag.
2. **`CcEvent` cannot represent it** — the union is `init | assistant_text | tool_call |
   tool_result`, and this is a structured record with eight fields.
3. **It carries the spawning `tool_use_id`** — byte-identical to entry 45's. The engine has
   the join key, so §3's "bind it to the row that spawned it" is implementable.
4. **`role`/`kind` are not applicable** — it never reaches the layer where a `ThreadEntry`
   gets a role. The question presumes an entry that does not exist.

**NOT VERIFIABLE AS WRITTEN — declared, not passed:** the raw **stream-json block type**.
Point 1 proves what it is *not*; it does not prove what it *is*. That requires reading
`cc-runner`'s stdin, which is engine territory this project may not enter. Measured
instead: the delivered payload, its eight fields, its join key, and its total absence from
the thread. Left open for the engine lane to record when it adds the `else` branch.

### 2.5 Census — not one unlucky run

At `2026-08-17 07:53:17+00`: **596 runs, 57,745 entries**, and the complete `(role, kind)`
set across all of them is nine pairs —

```
tool/tool_call 25025   tool/tool_result 25026   assistant/text 6535   user/text 772
user/comms 132         agent/comms 115          system/error 101      system/text 24
system/stuck_notice 15
```

**No notification kind exists anywhere.** **17** runs carry a genuine launch ack — **63
acks**, up to **11 in one run** (`a86cf7b3`), 8 in `6528014e` — and not one of those 63
spawns left a completion entry. Every apparent corpus hit for `task-notification` /
`agent_completed` is a run that was *editing this document* or probing the mapper.

---

## 3. Obligation B — end to end, and two false statements in the recipe

Round 1352's reviewer blocked this doc for telling the receiving lane something false that
it would act on. **The same class of defect was still present, twice.** Neither was the one
the brief predicted — §3's client claim had already been made true in round 1353, and the
`check-thread-mapping.ts` "R20 ON THE TOOL ROLE" section still passes at HEAD.

### 3.1 Engine emits? **NO** — live-confirmed (§2).

### 3.2 Client renders? **YES** — and now on the real payload

Round 1353 proved it with a synthetic string. Re-proved here by feeding the **live-captured
notification** through `mapThreadView`, in both shapes §3 offers:

```
── shape A — §3 item 4 read literally: role "tool", new kind "task_notification" ─
PASS  the live notification payload is visible in the rendered messages
PASS  it is NOT counted silent (base 0 → 0)
PASS  no message was lost (base 1 → 1)
PASS  MEASURED: it does NOT attach to the Agent row — it renders as a loose text part
      → 2 part(s): tool-call, text — collapsible=false

── shape B — §3's "arguably better": a tool_result bound to the spawning Agent call ─
PASS  the live notification payload is visible in the rendered messages
PASS  it is NOT counted silent (base 0 → 0)
PASS  no message was lost (base 1 → 1)
PASS  MEASURED: it does NOT attach to the Agent row — it renders as a loose text part
      → 2 part(s): tool-call, text — collapsible=false

ALL PASS — 8 assertions over 2 candidate emission shapes, on the live-captured payload
```

Probe kept at `/tmp/r19-live-payload-probe.ts`, **not committed**: `scripts/checks/` is
outside this round's writable set. Run from `forge-control-web/` with
`../forge-control/node_modules/.bin/tsx`.

### 3.3 FALSE STATEMENT 1 — "only the second is collapsible"

§3 told the engine lane: *"a `tool_result` bound to the spawning Agent call's
`tool_use_id` would attach to the existing Agent row … Either shape works; only the second
is collapsible."*

**Neither shape is collapsible.** `thread-mapping.ts:334-353` binds a `tool_result` by
searching backwards for a tool-call part with **`part.result === undefined`** — and that
slot is already filled by the launch ack, delivered on the *same* `tool_use_id` seconds
earlier. The second result matches nothing, falls through to the orphan branch at `:351`,
and degrades to the same loose text part as shape A. Measured above, both shapes.

An engine implementer who chose shape B *for its collapsibility* would have written the
extra binding code and got shape A's rendering. Corrected in §3 with the measurement.

**Escalated, not decided:** making shape B collapsible is a **client** change, and it
requires choosing what the Agent row shows once it has two results — replace the ack,
append below it, or ack-then-outcome. That is an interaction decision for Konrad. Flagged
to the manager; the doc says so rather than picking one.

### 3.4 FALSE STATEMENT 2 — the addressee

§3 was addressed to **`engine-v2-research-lane`** from round 1350 until now. Against
`GET /api/projects`: that project is **`done`**. The recipe has been addressed to a closed
lane for five rounds — the likeliest reason four one-line edits have sat undone.

Corrected to **`engine-task-graph` (`8c591d6c`)**, which owns the engine files this cycle.
**And stated rather than glossed: that project is `paused`, not active.** The four edits
need it resumed or a successor lane. "Someone owns it" was exactly the assumption that
failed here, so the doc no longer makes it.

The stale addressee also survives in `00-vision.md:48`, `01-requirements.md:107` and
`02-architecture.md:187` — **outside this round's writable set**, listed in §3 so the
correction is not lost.

---

## 4. Obligation C — the verifier, and repairing the record

### 4.1 C.2 — the corrections table was already right; verified, not taken on trust

The brief states that `notification-gap.md:251` currently maps `POST /:id/message` to
`run-control.ts:149` and `toThreadEntry` to `:214`. **That premise is stale.** The
inversion was introduced by round 1353 and **withdrawn by round 1355 (`b3ba3a9`)**. Line
251 of the current file is in §2b and carries no such mapping.

Verified against the tree before writing anything, as instructed:

```sh
for ref in HEAD main 91b0fa7; do
  git show $ref:forge-control/src/routes/run-control.ts |
    grep -n 'function toThreadEntry\|r.post("/:id/message"'
done
# 149:function toThreadEntry(e: CommsThreadEntry): ThreadEntry {
# 214:r.post("/:id/message", async (c) => {          ← identical at all three refs
git log --oneline main..HEAD -- forge-control/src/routes/run-control.ts   # (no output)
```

**Round 1350 was correct.** The file has never been touched on this branch. The table
already records this, with both rows marked VERIFIED and round 1353 named as the source of
the error. Nothing was restored because nothing needed restoring; the three-SHA evidence
was **added** to §1 so the next round does not have to re-derive it, and the attribution is
now backed by a command rather than by a previous round's say-so.

### 4.2 C.3 — the sixth pin, and the drift command

`AssistantThread.tsx:147-151` → `:149-153`: **already corrected** at round 1353 and passing.
Verified by pass 1.

The drift command was **not** complete at nine files, as round 1353 claimed — it was short
by five: `run-control-rules.test.ts` (pinned by §2c) and the four documentary targets
`00-vision.md`, `01-requirements.md`, `02-architecture.md`,
`ended-at-is-a-launch-ack.md` (pinned by §4). **Now fourteen**, and pass 3 checks the four
documentary pins by *content* rather than trusting a human to read a diff.

### 4.3 C.1 — the verifier: 11 → 72, with a denominator

The old script printed `11 fenced + 12 prose` and disclaimed, in prose, that this was not
every pin. **That disclaimer was the defect, not the mitigation** — a count whose
denominator lives in a comment is a count nobody checks. The instrument was not *wrong*, it
was *partial*, and partial coverage was reported as a full pass.

The script now runs five passes. Passes 1–2 are unchanged. New:

- **Pass 3, cross-document pins** — the lines pinned in sibling planning files, checked by
  content against a declared `expect`.
- **Pass 4, `LINE_RULES`** — one rule per document line carrying a pin passes 1–3 do not
  own, each token given an explicit disposition:
  - `live` — a first-class claim, path + `expect`, exactly like a prose pin;
  - `repeat` — names the `path:line` another pass proved, and asserts **both** that the key
    was actually proved **and** that this token's start line equals it, so a restatement
    cannot outlive its primary;
  - `historical` — a number recorded *because* it rotted; nothing to resolve, but `why` is
    mandatory so a live claim cannot be parked here to dodge checking.
- **Pass 5, the inventory** — tokenises the whole document (`path.ext:NNN` and bare
  `` `:NNN` ``, fenced or not, hyphen **or en-dash** — the doc uses both, and treating
  `:502–514` as a different pin from `:502-514` is precisely the blind spot being removed)
  and asserts passes 1–4 consumed every token. **An unclassified pin is a hard failure.**

```
ALL PASS — 72/72 pins in docs/plan/notification-gap.md classified
           (11 fenced quotes, 12 prose, 4 live, 7 cross-doc, 25 repeat, 13 historical).
Denominator = every `path.ext:NNN` and every bare `:NNN` citation in the doc, fenced or
not. Outside it: pins carrying no line number, and other documents' pins into this one.
```

**72 > 11, so the extension worked.** Of the 72: **34 are resolved directly against a tree**
(11 fenced + 12 prose + 4 live + 7 cross-doc), **25 more are repeats bound to one of those
34** and fail with it, and **13 are declared historical** with written reasons — pins that
exist precisely because they rotted, where there is nothing left to resolve.

Denominators, in order, since that is the whole point: round 1353's script printed
`ALL PASS — 11/11` while the document held **64** pins. Round 1355 added the prose table
and printed `11 fenced + 12 prose` — **23 of 64**, honestly disclaimed in a comment nobody
reads. It is now **72 of 72**. The document grew by eight pins this round (this round's own
edits), which is why 64 became 72 — the denominator is derived from the document, never
declared, so it cannot be gamed by adding pins.

**Deliberately outside the denominator**, named so the next `ALL PASS` is read correctly:
pins carrying no line number at all (a bare filename, a symbol, a SHA), and *other*
documents' pins into this one. This script audits this document's outbound pins.

### 4.4 Negative controls — two, because a count without one is a claim

| control | expected | observed |
|---|---|---|
| Append `` `executor.ts:1` `` + bare `` `:4242` `` | orphans named, exit 1 | `1 FAILURE(S) — 72/74 classified`, both orphans printed with line + surrounding text, **EXIT=1** |
| Renumber the one fenced `db/runs.ts` pin `:52`→`:53` | quote fails **and both restatements fail with it** | `3 FAILURE(S)` — the quote, plus `:347` and `:426` "was never verified by another half", **EXIT=1** |

Both reverted; baseline re-confirmed `ALL PASS — 72/72`.

The second control is the one that matters: it shows `repeat` is a real edge in a
dependency graph, not a synonym for "exempt".

### 4.5 A defect the extension found in itself

First run of pass 5 reported `59/64` with **five unclassified pins** — including
`AssistantThread.tsx:279-281` and both copies of `executor.ts:952-986`, which two rounds of
careful hand-checking had walked straight past. It also exposed an ordering bug in my own
rule evaluation (a `repeat` declared above its primary failed for reasons internal to the
table). Fixed structurally — rules are resolved first, then evaluated in two phases,
proofs before repeats, with output re-sorted into document order — rather than by
hand-ordering the table, which would have re-created the same trap for the next editor.

---

## 5. Verification run

| what | result |
|---|---|
| `node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs` | `ALL PASS — 72/72`, EXIT=0 |
| Negative control 1 (orphan pins) | EXIT=1, `72/74`, orphans named |
| Negative control 2 (renumber primary) | EXIT=1, 3 failures incl. both repeats |
| `check-thread-mapping.ts` "R20 ON THE TOOL ROLE" | all PASS, EXIT=0 |
| Live-payload probe, 2 shapes × 4 assertions | `ALL PASS — 8 assertions` |
| Live DB, read-only | 596 runs; census + raw entries as quoted |
| `npx tsc --noEmit` | **not run, and here is why:** this round changed two files, `.md` and `.mjs`. No TypeScript was touched, added, or deleted. Running it would measure round 1862's tree, not this round's change. 3a (production acceptance) owns that gate. |

---

## 6. What the next round inherits

1. **The gap is real, confirmed, and unowned.** Four one-line edits in `cc-runner.ts` ×2,
   `db/runs.ts`, `executor.ts`. Owner `engine-task-graph` (`8c591d6c`) is **paused**.
   Someone has to resume it or reassign the files — this round could only correct the
   address, not deliver the letter.
2. **Open interaction decision for Konrad:** should a completion attach to the Agent row it
   came from (collapsible), and if so, what does that row show once it holds both the
   launch ack and the outcome? Today neither emission shape is collapsible. Defaulting to
   "leave as loose text" until he says otherwise.
3. **Three sibling files still name a closed lane** — `00-vision.md:48`,
   `01-requirements.md:107`, `02-architecture.md:187`.
4. **The brief's role/tool premise is wrong** and will mislead the next agent that inherits
   it: builders hold the `Agent` tool.
