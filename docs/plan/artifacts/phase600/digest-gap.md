# Phase 600 — what U23/U24 cannot derive from existing data

**Round:** 601A · derivation core
**Written because:** U24 and the round-601A brief both say that anything genuinely
underivable must be *named here*, not closed with new plumbing. Everything below is
measured against the captured fixture
`docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json` — the architect run
`3853c154-e07b-4378-9313-2b34f4a33342`, 285 entries, 136 tool calls, 2 sub-agents —
plus the four runs the round-599 scout inventoried.

Nothing in this document is a request to build. Each item names the gap, what the
UI does instead, and where the missing data would have to come from if Konrad ever
decides it is worth the engine change.

---

## 1. The "raw payload" behind a tool call is already clipped at the source

**The gap.** U23 promises a collapsed summary "expandable to the raw payload". The
thread does not hold the raw payload. The executor stores a clipped copy:

| Field | Observed limit | Marker |
|---|---|---|
| `meta.input` (tool arguments) | 1500 characters + `…` | none — the JSON simply ends mid-value |
| tool_result `content` | ~2500 characters | ` … [truncated]` appended |

Measured on the fixture: `max(len(meta.input)) = 1501`, hit by **10 of 136** tool
calls; `max(len(result.content)) = 2514`, with 49 results at or above 2000 chars.
The 10 clipped inputs are exactly the interesting ones — both `Agent` spawns (their
prompts are kilobytes) and every `Write` (the file content is the argument).

**Consequence, stated plainly.** "Expand" in round 602 means *expand to everything
the thread holds*, which for large calls is a prefix. A UI that says "raw payload"
without qualification would be claiming completeness it does not have.

**What round 601A did instead of plumbing.** `tool-summary.ts` gained
`salvageArgs()` / `parseArgsWithSource()`: when `JSON.parse` fails on a clipped
prefix, the leading top-level `"key": scalar` pairs are recovered by a sticky scan
that stops at the first value it cannot read whole. That is what turns entry 4 from
a useless `{"description":"Recon chat…` into `spawn Explore · Recon chat Bash block
rendering`. Two guards keep it honest:

- the scan never descends into a nested object, so it can never report an inner
  object's `file_path` as the call's own;
- `FormatterInput.argsSource` is `"salvaged"` for these, and the `Write`/`Edit` rows
  refuse to state a size when it is set — the length of a clip is not the length of
  a file. They say `written` / `edited` rather than a confident wrong number.

**Where the full payload would have to come from.** The executor's event-write path
(`forge-control/src/lib/cc-runner.ts` / `executor.ts`) does the clipping before the
row is stored. There is no second copy anywhere — not in the DB, not on disk. Only
an engine change writes it, and those files are frozen for this cycle (NFU5, and
`engine-v2-research-lane` owns them). **Recommendation: leave it.** 1500 characters
of arguments is enough to understand a call; storing full Write payloads would
multiply thread sizes (already 150KB–1.2MB) for a view nobody reads twice.
Round 602 should label the expanded view honestly — "payload stored clipped by the
executor" when `argsSource === "salvaged"` — rather than implying it is complete.

---

## 2. A running run's elapsed time is deliberately NOT derived

**Not a data gap — a design line.** `deriveDigest` returns `elapsed_ms: null` and
`elapsed_frozen: false` for any run that is not `completed`/`failed`/`cancelled`.
A pure function cannot read a clock without becoming impure and, worse, without
re-introducing exactly the defect Definition of Done #1 forbids (numbers that grow
after the work stopped).

`started_at` is passed through so the renderer can tick a live run in a single leaf
component — the phase-500 `FrozenTime` / `useTick` split, unchanged. Settled runs get
a frozen `completed_at − started_at` that is byte-identical at any clock.

---

## 3. U24 fields that no derivation can honestly produce

The round-599 scout listed four; the fixture confirms all four and adds two.

| Missing | Why it cannot be derived | Where it would come from |
|---|---|---|
| **Causality** — which tool call caused which error | the thread has order, not causation; an error can trail its cause by many entries | an LLM pass (explicitly rejected, `13 §8`) or executor-side annotation |
| **Branching** — "tried A, abandoned it, did B" | abandonment is intent; the thread only shows sequence | the agent saying so in its own prose (see below) |
| **Quality** — is the work sound | a judgment, not a count | the reviewer round, which already exists |
| **External context** — why it took so long, what it blocked | never entered the run | Konrad, or the plan doc |
| **Per-entry cost/token attribution** | `meta.usage` appears on assistant entries only (12 of 285 here); tool entries carry none, so "tokens spent on the Bash phase" is not computable | executor instrumentation (frozen) |
| **Plan position** — "phase 500 of 15-ui-v3-phases; next 600" (U22) | not in the run at all: no round, no phase, no task id in `metadata` | the U6 plan endpoint (`GET /api/chat/:id/plan`), which already exists — this is a join, not a gap. U22's strip must fetch it; the digest does not invent it |

**The honest workaround for causality and branching is already in the spec** and
costs nothing: the digest surfaces the last three assistant prose turns verbatim.
When a builder ends with "fixed A by doing X, then fixed B when A's approach broke",
the digest carries that sentence. The narrative comes from the agent that lived it,
not from a summarizer guessing at one. On the fixture, `outcome` is the architect's
own closing report — which is exactly the paragraph a human would have written.

---

## 4. Counts the digest reports, and what they do NOT mean

Stated here so round 602 does not label them wrong.

- `error_count` counts entries flagged `meta.is_error` plus `kind: "error"` entries —
  **3** on the fixture. That is "tool calls that returned an error", not "problems".
  All three were routine and recovered from in the next turn: a `which` probe exiting
  2, one malformed SQL query, and the harness refusing a `Write` before a `Read`. The
  run completed successfully. A label like "3 failures" would be a lie; "3 tool
  errors" is true.
- `tool_call_count` (**136**) spans the whole thread, sub-agents included. The split
  is available: `top_level_count` **89** vs `subagent_entry_count` **196**.
- `subagent_roles` reads `metadata.subagents_v2[].role`, which is the `subagent_type`
  the parent passed to `Agent` — on the fixture both scouts are `"Explore"`, not
  `"scout"`. The panel shows what was actually spawned, not the tier vocabulary.
- A sub-agent spawned seconds ago has no `subagents_v2` row yet; it is still counted
  (from its `Agent` tool_call) and its role reads `"unknown"` rather than being
  guessed.

---

## 5. One thing that turned out NOT to be a gap

The round-599 scout flagged a risk that sub-agent transcripts might need a separate
fetch. They do not, and there is nothing to fetch: sub-agent entries are inline in
the parent's thread, tagged `meta.parent_tool_use_id`. `subagentEntries()` slices
them out and `deriveDigest(run, slice)` produces a sub-agent's own digest from the
same payload — 118 entries for the first scout, its closing "# Recon Report…" and
all. No endpoint, no run row, no plumbing.
