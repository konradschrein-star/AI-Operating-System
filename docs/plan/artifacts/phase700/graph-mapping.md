# graph-mapping.md — U27's acceptance artifact

**The claim under test:** the plan store shipped in phase 700 is already the
shape a graph view consumes, so a future `PlanGraphView` is a render swap, not
a rewrite. This document demonstrates that against the code as shipped —
everything below is copied out of the worktree, not paraphrased from
`16-ui-v3-graph-research.md`, and where the two disagree the shipped code wins
and the disagreement is named.

Round 703, branch `project/8ea0cc08`. Measurements against the fixture chat
`bfd1283a-b71b-4f35-b577-7d09aad803f2` → project `8ea0cc08…`, 66 tasks.

---

## 1. The node type, as shipped

Verbatim from `forge-control-web/app/desktop/team/planStore.ts:36-44`:

```ts
export type PlanNode = {
  id: string;
  title: string;
  status: string;
  round: number;
  role: string;
  deps: string[];
  meta: { tier?: string; run_id?: string };
};
```

**One deliberate departure from `16-ui-v3-graph-research.md` §1, which the memo
does not record.** The memo sketches

```ts
status: "pending" | "ready" | "running" | "done" | "failed" | "blocked"
```

and the shipped type is a plain `string`. The reason is in the file's own
comment (planStore.ts:26-35): the DB's CHECK constraint admits those six values
*today* (`db/migrations/0030_coding_projects.sql:44`), a migration can widen it
tomorrow, and a union forces an unrecognised value through a `default:` branch
into a neighbouring bucket — `"skipped"` quietly rendered as `"pending"`, and a
count that silently stops matching the rail badge. NFU6 says an unknown status
must reach the screen as its own literal. The widening is what makes that
non-negotiable rather than merely intended.

Everything a graph view needs is present and typed: an id, a label, a status to
colour by, and an edge list. `meta.run_id` is in the U27 contract and is
**optional and unset today** — `PLAN_TASKS_SQL` has no `run_id` column
(`forge-control/src/routes/chat.ts`), so the wire does not carry one. It is
declared rather than faked; the day the server adds the column, one line in
`toPlanNodes` fills it and no consumer changes.

Two supporting types, same file:

```ts
export interface PlanEdge {          // planStore.ts:59-62
  source: string;
  target: string;
}

export interface PlanPhaseGroup {    // planStore.ts:48-57 (abridged: comments elided)
  round_base: number;
  title?: string;
  doc_path?: string;
  nodes: PlanNode[];
  done: number;
  total: number;
}
```

---

## 2. The two projections, side by side

Both are exported from `planStore.ts` today. Both are pure, take `PlanNode[]`,
and neither knows the other exists. This is the whole of U27's structural
claim, and it is 3 lines against 25.

### Kanban projection — `groupPlanPhases`, planStore.ts:205-231

**Note the signature.** The brief calls it `groupPlanPhases(nodes)`; the shipped
function is **`groupPlanPhases(nodes, res)`** — it takes the wire response as a
second argument. That is not a wart, it is the honesty rule: `round_base`,
`title` and `doc_path` are *the server's decisions* and are read off
`res.phases`, never re-derived. A client that re-derived `doc_path` would
eventually disagree with `matchPhaseDoc` and 404 in the reader's face.
Membership, on the other hand, is driven by the nodes, so no node can fall out
of the panel.

```ts
export function groupPlanPhases(nodes: PlanNode[], res: PlanResponse): PlanPhaseGroup[] {
  const wire = new Map<number, PlanPhase>();
  for (const phase of res.phases) wire.set(phase.round_base, phase);

  const groups = new Map<number, PlanPhaseGroup>();
  for (const node of nodes) {
    const base = phaseBase(node.round);
    let group = groups.get(base);
    if (!group) {
      const source = wire.get(base);
      group = { round_base: source ? source.round_base : base, nodes: [], done: 0, total: 0 };
      if (source?.title !== undefined) group.title = source.title;
      if (source?.doc_path !== undefined) group.doc_path = source.doc_path;
      groups.set(base, group);
    }
    group.nodes.push(node);
    group.total += 1;
    if (node.status === DONE) group.done += 1;
  }

  return [...groups.values()].sort((a, b) => a.round_base - b.round_base);
}
```

### Graph projection — `planEdges`, planStore.ts:260-262

```ts
export function planEdges(nodes: PlanNode[]): PlanEdge[] {
  return nodes.flatMap((n) => n.deps.map((d) => ({ source: d, target: n.id })));
}
```

An edge points **dep → dependent**, so it reads in the direction work flows.
`planEdges` is exported and covered by `scripts/checks/check-plan-store.ts`
even though nothing renders it — an unexercised claim is not a proven one, and
this document would otherwise be asserting that untested code is graph-ready.

The third projection, for completeness, is the progress bar
(`planProgress`, planStore.ts:245-249) — it is what makes the panel's x/y
byte-equal to the rail badge, proved this round in `count-agreement.json`.

---

## 3. What a `PlanGraphView` would add — and what it would not change

### Would add

| Thing | Detail |
|---|---|
| `@xyflow/react` | the renderer. **A new runtime dependency, so NFU8 justification is required AT THAT TIME** — not pre-granted by this document. |
| `elkjs` | layered layout (`elk.layered`, direction `RIGHT`). Also NFU8. |
| `PlanGraphView.tsx` | a sibling of `PlanKanban.tsx` in `app/desktop/team/`. |
| a toggle | two buttons in the zone header, beside the existing `PLAN` label and x/y. |

### Would NOT change

- **`planStore.ts`** — no new export, no changed signature, no new field. The
  graph consumes `PlanNode[]` and `planEdges(nodes)` exactly as they stand.
- **`planApi.ts`** — no new fetcher, no widened response type.
- **the endpoint** — `GET /api/chat/:id/plan` is unchanged. No second endpoint,
  no `?include=graph`.
- **`PlanKanban.tsx`'s own body** — the toggle sits in the zone that mounts
  both; the Kanban does not learn that a graph exists.
- **the poll budget** — the graph reads the same `["chat-plan", chatId]` query.
  Two views, one cache entry, still 4 req/min (`network-700.json`).

### The adapter, in full

This is the entire translation layer. If it needed more than this, the claim in
§2 would be false:

```tsx
// PlanGraphView.tsx — the whole of the store→React-Flow translation.
import { ReactFlow } from "@xyflow/react";
import { planEdges, statusTokenName, type PlanNode } from "./planStore";

const STATUS_COLOR = { /* the SAME record PlanKanban.tsx already holds */ };

export function PlanGraphView({ nodes }: { nodes: PlanNode[] }) {
  const rfNodes = nodes.map((n) => ({
    id: n.id,
    data: { label: n.title },
    position: { x: 0, y: 0 },                       // elkjs overwrites these
    style: { borderColor: STATUS_COLOR[statusTokenName(n.status)] },
  }));
  const rfEdges = planEdges(nodes).map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
  }));
  return <ReactFlow nodes={rfNodes} edges={rfEdges} fitView />;
}
```

Ten lines of substance. `position: {x: 0, y: 0}` is a placeholder that `elkjs`
replaces before first paint — React Flow requires the key to exist, and the
layout engine is what decides where a node actually goes. `statusTokenName` is
already exported and already returns a token NAME, so the graph inherits the
panel's colour language without choosing a colour of its own — same split
`PlanKanban.tsx` and `TeamRow.tsx` use.

**Not shipped this phase.** Nothing above exists in the worktree; it is written
here so that "the store is consumed unchanged" is demonstrated rather than
asserted.

---

## 4. What `deps` actually means today — the honest version

`deps` is **"every task in a strictly lower round"**. Not per-task dependencies.
The server builds it in `forge-control/src/routes/chat.ts:734-776`:

```ts
/** ids of every task in a strictly lower round than the cursor. */   // chat.ts:737
const lower: string[] = [];
...
    if (currentRound !== null && row.round !== currentRound) {
      lower.push(...pending);
      pending = [];
    }
...
      deps: [...lower],                                               // chat.ts:769
```

So the graph this produces is a **coarse round-to-round DAG**: every task in
round N depends on every task in every round below N. Siblings within one round
are correctly *not* linked to each other (`pending` only joins `lower` when the
round changes), which is the one real piece of structure it does carry.

### What that costs, measured on this project

| | value |
|---|---|
| tasks | 66 |
| distinct rounds | 57 |
| edges from `planEdges` | **2 133** |
| edges per task | 32.3 |
| fattest node | round 1750 (`tester`), **65 deps** — every other task in the plan |

2 133 edges over 66 nodes is a near-complete DAG. It is *correct* — round 703
genuinely cannot start before round 702 finished — but it is almost entirely
transitive: a layered layout would draw a hairball, and 65 arrows into one node
carry no more information than one arrow from the round below it.

### What improves when the engine records true per-task deps

**The shape does not change. Only the edge count does.**

- `PlanNode.deps` stays `string[]`.
- `planEdges` stays three lines and is not touched.
- `PlanGraphView` in §3 is not touched.
- The Kanban does not read `deps` at all, so it is unaffected either way.
- The edge count collapses from ~2 133 toward the order of the round count
  (~57 in a chain, more with real fan-out), and the layered layout becomes
  legible without a transitive-reduction pass in the client.

That is the precise sense in which the store is "graph-ready ahead of the
engine": the client already models the thing correctly, and the improvement is
entirely upstream. Any client-side transitive reduction would be a workaround
for a server-side approximation, and is deliberately **not** written.

---

## 5. No graph library was added this phase — the grep, reported accurately

The brief predicts this command returns no hits. **It returns one**, and
reporting it as clean would be the exact kind of unearned green this phase
exists to prevent:

```console
$ grep -rn 'xyflow\|elkjs\|dagre\|reactflow' forge-control-web/package.json forge-control-web/app
forge-control-web/app/desktop/team/planStore.ts:17: *  NO NEW RUNTIME DEPENDENCY (NFU8). `@xyflow/react` and `elkjs` are
$ echo $?
0
```

The single hit is **a comment in `planStore.ts`'s header declaring that these
libraries are not added**. There is no import, no dependency entry, no
`node_modules` requirement. The stricter greps that carry the actual claim:

```console
$ grep -rn 'xyflow\|elkjs\|dagre\|reactflow' forge-control-web/package.json
$ echo $?
1
$ grep -rnE "from ['\"](@?xyflow|elkjs|dagre|reactflow)" forge-control-web/app
$ echo $?
1
```

Both empty. `package.json` names neither library, and nothing in `app/` imports
either one. Verbatim console output for all three is in `gates-703.txt`.
