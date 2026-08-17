/**
 * ROUND 1305 RED TEAM — attack 1: stale UI after memoization.
 *
 * The claim under attack: round 1302's `TeamRowCache` + `sameRow` (teamRows.ts)
 * let `memo(TeamRowView)` bail out, and no field the panel renders is missing
 * from the identity key. `sameRow` compares `node` by POINTER — so the whole
 * claim rests on react-query's structural sharing giving a mutated node a NEW
 * object identity. If it ever reuses an object whose contents changed, the row
 * is frozen at yesterday's truth and nothing on screen says so.
 *
 * This runs the REAL 114-node /team payload of chat bfd1283a through
 * `replaceEqualDeep` — the exact function @tanstack/react-query uses for
 * structural sharing — mutating one rendered field at a time, then through the
 * real `flattenTeam` with a shared cache, and asserts:
 *
 *   (a) the mutated row's wrapper is a NEW object   → memo re-renders it
 *   (b) every OTHER wrapper is the SAME object      → memo bails the rest out
 *
 * (a) failing is a stale-UI defect. (b) failing is only a lost optimisation.
 *
 * Run: npx tsx docs/plan/artifacts/phase1300/redteam/stale-ui-1305.ts
 * Needs the worktree API harness on :7798 (docs/plan/artifacts/phase1290/hover/README.md §7 step A).
 */

import { replaceEqualDeep } from "../../../../../forge-control-web/node_modules/.pnpm/@tanstack+query-core@5.62.7/node_modules/@tanstack/query-core";
import {
  createTeamRowCache,
  flattenTeam,
} from "../../../../../forge-control-web/app/desktop/team/teamRows";
import type {
  TeamNode,
  TeamResponse,
} from "../../../../../forge-control-web/app/desktop/team/teamApi";

const API = process.env.TEAM_API ?? "http://127.0.0.1:7798";
const CHAT = process.env.TEAM_CHAT ?? "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const NONE: ReadonlySet<string> = new Set();

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(got)}, want ${String(want)})`}`);
}

/** Every node in the tree, in the panel's own flatten order. */
function walk(res: TeamResponse): TeamNode[] {
  const out: TeamNode[] = [];
  const push = (n: TeamNode) => {
    out.push(n);
    for (const s of n.subagents) push(s);
  };
  push(res.manager);
  for (const w of res.workers) push(w);
  return out;
}

/** A structural clone with ONE node's field rewritten — the shape a poll takes
 *  when exactly one thing on screen changed. */
function mutate(res: TeamResponse, id: string, patch: (n: TeamNode) => TeamNode): TeamResponse {
  const map = (n: TeamNode): TeamNode => {
    const next = { ...n, subagents: n.subagents.map(map) };
    return n.id === id ? patch(next) : next;
  };
  return { ...res, manager: map(res.manager), workers: res.workers.map(map) };
}

async function main() {
  const res: TeamResponse = await (await fetch(`${API}/api/chat/${CHAT}/team`)).json();
  const nodes = walk(res);
  console.log(`tree: ${nodes.length} nodes, ${res.workers.length} workers, complete=${res.complete}\n`);

  /* A RUNNING worker with a task — the row whose truth actually moves between
     polls. Picking a settled node here would make every mutation a no-op and
     the test would pass by accident (round 1305's first draft did exactly that:
     `status: "completed"` on an already-completed node → replaceEqualDeep
     returns the identical object → same wrapper, correctly). */
  const target =
    nodes.find((n) => !n.settled && n.task !== null && n.parent_id !== null) ??
    nodes.find((n) => !n.settled) ??
    nodes[1];
  const sub = nodes.find((n) => n.kind === "subagent") ?? nodes[nodes.length - 1];
  console.log(`target: ${target.id} status=${target.status} settled=${target.settled} subagents=${target.subagents.length}`);
  console.log(`sub:    ${sub.id} kind=${sub.kind} parent=${sub.parent_id}\n`);

  /* Rows that are ALLOWED to change wrapper when `id` changes: the node itself,
     its ancestors (structural sharing hands a changed child's parents new
     identity — conservative, never stale) and, for a description change, its
     children (whose `parentDescription` really did move). */
  const related = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    const mark = (n: TeamNode, chain: string[]): void => {
      const here = [...chain, n.id];
      if (n.id === id) { for (const a of here) out.add(a); for (const c of n.subagents) out.add(c.id); }
      for (const c of n.subagents) mark(c, here);
    };
    mark(res.manager, []);
    for (const w of res.workers) mark(w, [res.manager.id]);
    return out;
  };

  const MUTATIONS: Array<[string, string, (n: TeamNode) => TeamNode]> = [
    ["status running → completed", target.id, (n) => ({ ...n, status: "completed", settled: true })],
    ["task title changed", target.id, (n) => ({ ...n, task: n.task ? { ...n.task, title: "RED TEAM 1305" } : null })],
    ["task status changed", target.id, (n) => ({ ...n, task: n.task ? { ...n.task, status: "review" } : null })],
    ["task round changed", target.id, (n) => ({ ...n, task: n.task ? { ...n.task, round: 9999 } : null })],
    ["task role changed", target.id, (n) => ({ ...n, task: n.task ? { ...n.task, role: "scout" } : null })],
    ["token count moved", target.id, (n) => ({ ...n, tokens: { ...n.tokens, output: n.tokens.output + 1, total: n.tokens.total + 1 } })],
    ["working_ms advanced", target.id, (n) => ({ ...n, working_ms: (n.working_ms ?? 0) + 1000 })],
    ["working_ms_source thread → rollup", target.id, (n) => ({ ...n, working_ms_source: "rollup" })],
    ["model changed", target.id, (n) => ({ ...n, model: "claude-haiku-4-5-20251001" })],
    ["description changed", target.id, (n) => ({ ...n, description: "RED TEAM 1305 description" })],
    ["role changed", target.id, (n) => ({ ...n, role: "scout" })],
    ["kind changed", target.id, (n) => ({ ...n, kind: "subagent" })],
    ["started_at changed", target.id, (n) => ({ ...n, started_at: "2020-01-01T00:00:00.000Z" })],
    ["settled flipped", target.id, (n) => ({ ...n, settled: !n.settled })],
    ["subagent row: working_ms advanced", sub.id, (n) => ({ ...n, working_ms: (n.working_ms ?? 0) + 500 })],
    ["subagent row: status changed", sub.id, (n) => ({ ...n, status: "failed", settled: true })],
  ];

  console.log("── one field moves; does its row's wrapper move with it? ──────");
  for (const [label, id, patch] of MUTATIONS) {
    const cache = createTeamRowCache();
    const before = flattenTeam(res, NONE, cache).rows;
    /* THE POINT: the next poll's body goes through structural sharing exactly as
       react-query does it, so unchanged subtrees come back as the OLD objects. */
    const shared = replaceEqualDeep(res, mutate(res, id, patch)) as TeamResponse;
    const after = flattenTeam(shared, NONE, cache).rows;

    const i = before.findIndex((r) => r.node.id === id);
    check(`${label} → mutated row is a NEW wrapper`, after[i] === before[i], false);
    /* THE STALENESS ASSERTION, said the other way round: the row's node now
       carries the new value, so what renders is the new value. */
    check(`${label} → the new wrapper carries the mutation`, after[i].node === before[i].node, false);
    const kin = related(id);
    const unrelatedReused = after.every((r, j) => kin.has(r.node.id) || r === before[j]);
    check(`${label} → every UNRELATED wrapper reused`, unrelatedReused, true);
  }

  console.log("\n── structural change: a worker appears / disappears ───────────");
  {
    const cache = createTeamRowCache();
    const before = flattenTeam(res, NONE, cache).rows;
    const gone: TeamResponse = { ...res, workers: res.workers.slice(1) };
    const afterGone = flattenTeam(replaceEqualDeep(res, gone) as TeamResponse, NONE, cache).rows;
    check("worker removed → row count drops", afterGone.length < before.length, true);
    check(
      "worker removed → no wrapper of the removed subtree survives",
      afterGone.some((r) => r.node.id === res.workers[0].id),
      false,
    );
    const back = flattenTeam(replaceEqualDeep(gone, res) as TeamResponse, NONE, cache).rows;
    check("worker reappears → row count restored", back.length, before.length);
    check("worker reappears → it renders (fresh wrapper, not a ghost)", back[1].node.id, before[1].node.id);
  }

  console.log("\n── the cache does not survive a moved row ─────────────────────");
  {
    /* Same node id at a DIFFERENT depth — a subagent re-parented, or the same run
       appearing under another worker. If depth were not in the key the row would
       render at yesterday's indentation. */
    const cache = createTeamRowCache();
    const before = flattenTeam(res, NONE, cache).rows;
    const i = before.findIndex((r) => r.depth > 1);
    const moved = structuredClone(res) as TeamResponse;
    /* promote every subagent of worker 0 to a worker: same nodes, new depth */
    const w0 = moved.workers[0];
    const promoted = w0.subagents;
    w0.subagents = [];
    moved.workers = [w0, ...promoted, ...moved.workers.slice(1)];
    const after = flattenTeam(moved, NONE, cache).rows;
    const movedIds = new Set(promoted.map((n) => n.id));
    const wrong = after.filter((r) => movedIds.has(r.node.id) && r.depth !== 1);
    check("re-parented rows all render at their NEW depth", wrong.length, 0);
    check("no re-parented row kept its old wrapper", after.some((r) => movedIds.has(r.node.id) && before.includes(r)), false);
    void i;
  }

  console.log("\n── degraded response after a good one (complete:false) ────────");
  {
    const cache = createTeamRowCache();
    const good = flattenTeam(res, NONE, cache).rows;
    const degraded: TeamResponse = {
      ...res,
      complete: false,
      errors: ["timing"],
      manager: { ...res.manager, working_ms: null, working_ms_source: null },
    };
    const after = flattenTeam(replaceEqualDeep(res, degraded) as TeamResponse, NONE, cache).rows;
    check("degraded manager row is a NEW wrapper", after[0] === good[0], false);
    check("degraded manager row carries the null working_ms", after[0].node.working_ms, null);
  }

  console.log(failures === 0 ? "\nHELD — no stale wrapper found" : `\n${failures} BREAK(S)`);
  process.exitCode = failures === 0 ? 0 : 1;

}

void main();
