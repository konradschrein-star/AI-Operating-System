# 16 — Graph-Engineering Research Memo (Kanban now, graph later)

Scope: informs U27 (graph-ready store) and the reserved future graph-toggle phase (rounds 1200+). Research performed 2026-08-05 (web scout, sources at bottom). One deliberate deviation from industry practice: **cost/$ per node is a standard agent-monitoring metric everywhere else; it is banned here by the spec** — tokens are our currency.

## 1. The consensus data model

Every surveyed system (LangGraph/LangSmith, OpenAI Agents SDK, CrewAI, AgentOps) converges on the same shape: tasks/agents as nodes with a status enum and a dependency edge list; monitoring views are pure projections of that one structure.

Adopted store type (the actual contract for U27):

```ts
type PlanNode = {
  id: string                    // task id
  title: string
  status: "pending" | "ready" | "running" | "done" | "failed" | "blocked"
  round: number                 // engine ordering key
  role: string                  // architect/planner/builder/reviewer/scout/researcher
  deps: string[]                // task ids this node waits on
  meta: { tier?: string; run_id?: string }
}
```

- **Kanban projection:** group by phase block (`floor(round/100)*100`), chips colored by `status`. Sort within a column by round then role.
- **Graph projection (later):** nodes as-is; `edges = nodes.flatMap(n => n.deps.map(d => ({source: d, target: n.id})))`. No reshaping, no second store — the toggle is a render swap. This is the whole point of U27.
- Today's engine semantics give coarse edges (round N+1 depends on all of round ≤ N). The shape doesn't care — when the engine ever records true per-task deps, `deps` gets richer and both views improve without a UI rewrite.

## 2. Per-node metrics (industry standard, filtered by our spec)

OpenTelemetry's GenAI semantic conventions and every major dashboard settle on: duration, input tokens, output tokens, status/error, and cost. We adopt the first four; cost is excluded (spec law). Optional high-signal extras seen in the wild: tool-call count, eval/feedback score. Our team tree (U15) already carries duration-as-working-time + token totals + status — i.e., v3's team zone is a standard agent-monitoring node view minus dollars, which validates the U4 node shape.

## 3. Rendering library (for the FUTURE toggle — do not add now)

Recommendation when the time comes: **`@xyflow/react` (React Flow v12+) with ELK.js layout**.
- React Flow: ~38k stars, MIT, actively maintained, React 19 compatible, ~50–80KB min+gzip — the boring default for interactive node views in a Next app.
- Layout: ELK.js over dagre — dagre is effectively unmaintained (2025); ELK is active, handles layered/hierarchical DAGs well at our scale (10–100 nodes, trivial for either).
- Alternatives rejected: vis-network (imperative, non-React idiom), hand-rolled SVG (fine for a static DAG, loses pan/zoom/selection for free), mermaid (render-only, no interactivity).

## 4. Kanban↔graph duality — established pattern

The dual-view pattern (same task set as status columns AND dependency DAG) is standard in workflow tooling (Airflow's grid vs graph view is the canonical example; LangSmith's run table vs trace tree is the agent-world analog). The requirement that makes it cheap is exactly one rule: **views never own data; they project a shared node/edge store.** Phase 700's acceptance criterion (a written mapping note + the store type in code) enforces this rule now, so the toggle later is a leaf component, not a migration.

## 5. What the future graph phase would add (recorded so nobody re-researches)

- `@xyflow/react` + `elkjs` deps (with NFU8 justification), a `PlanGraphView` sibling of `PlanKanban` over the same store, toggle in the zone header.
- Node chrome: status color (tokens), role glyph, working-time + token badge on hover — same row grammar as TeamTree so the org chart and the task graph read as one language.
- Live overlay: `meta.run_id` joins a plan node to its running agent (team endpoint), giving the "agent-graph monitoring with per-node metrics" view Konrad referenced.

## Sources

- LangGraph per-node metrics: c-sharpcorner.com/article/tracking-metrics-for-individual-nodes-in-langgraph/
- LangSmith dashboards: docs.langchain.com/langsmith/dashboards
- OpenAI Agents SDK visualization: openai.github.io/openai-agents-python/visualization/
- React Flow: github.com/xyflow/xyflow; layouting: reactflow.dev/learn/layouting/layouting
- ELK vs dagre: github.com/xyflow/xyflow/discussions/1786; npmtrends.com/dagre-vs-dagre-layout-vs-elkjs
- OpenTelemetry GenAI observability: opentelemetry.io/blog/2026/genai-observability/
- Agent observability guide: braintrust.dev/articles/agent-observability-complete-guide-2026
- CrewAI + OTel: signoz.io/docs/crewai-observability/
