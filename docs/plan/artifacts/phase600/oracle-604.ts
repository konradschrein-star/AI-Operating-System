/**
 * oracle-604.ts — what the SHIPPED derivation says the screen should read.
 *
 * `transcript-expand.cjs` has to compare a collapsed tool row against "the
 * tool-summary formatter's one-liner". Re-implementing `summarizeTool` in the
 * protocol would test the re-implementation, so this sidecar imports the real
 * modules — `thread-mapping.ts` and `tool-summary.ts`, the same files the bundle
 * runs — and prints their answer as JSON for a `.cjs` to consume.
 *
 * IT IS NOT USED FOR NUMBERS THAT MUST BE INDEPENDENT. `digest-honesty.cjs`
 * re-derives every digest count from the API payload with its own arithmetic and
 * never asks this file, because a digest checked against `deriveDigest` would be
 * checking `deriveDigest` against itself. This oracle answers exactly two kinds
 * of question:
 *
 *   1. what the RENDERING CONTRACT is — the collapsed one-liner, the order of
 *      tool-call parts, the fold counts (`summaries`);
 *   2. what the label helpers turn a wire value into (`identity`) — the raw
 *      value from `/api/agents` is reported beside it so a reader can see both.
 *
 * Byte-completeness is not asked of this file either: `transcript-expand.cjs`
 * diffs the rendered <pre> against `meta.input` / the tool_result `content` it
 * fetched from the API itself.
 *
 * Run (from forge-control-web, so the app's node_modules resolve):
 *   ../forge-control/node_modules/.bin/tsx ../docs/plan/artifacts/phase600/oracle-604.ts \
 *     summaries <runId> [apiBase]
 *   … identity <runId> [subagentId] [apiBase]
 */

import type { RunDetail, ThreadEntry } from "../../../../forge-control-web/app/api.ts";
import {
  mapThreadView,
  type ToolCallPart,
} from "../../../../forge-control-web/app/desktop/chat/thread-mapping.ts";
import { summarizeTool } from "../../../../forge-control-web/app/desktop/chat/tool-summary.ts";
import {
  modelDisplay,
  roleLabel,
} from "../../../../forge-control-web/app/desktop/live/agentsApi.ts";
import {
  parseSubagentsV2,
  type SubagentMeta,
} from "../../../../forge-control-web/app/desktop/chat/subagent-slice.ts";

const API = process.env.PHASE600_API_URL ?? "http://127.0.0.1:7798";

async function fetchRun(runId: string, base: string): Promise<RunDetail> {
  const r = await fetch(`${base}/api/chat/${runId}`);
  if (!r.ok) throw new Error(`GET ${base}/api/chat/${runId} → ${r.status}`);
  const body = (await r.json()) as { run?: RunDetail };
  if (!body.run) throw new Error(`GET /api/chat/${runId} returned no "run"`);
  return body.run;
}

function isToolCall(p: unknown): p is ToolCallPart {
  return (
    p !== null &&
    typeof p === "object" &&
    (p as { type?: unknown }).type === "tool-call"
  );
}

/** Every tool-call part of a view, in the order the transcript renders them. */
function partsOf(thread: ThreadEntry[], scope: "top-level" | "subagent", subagentId?: string) {
  const view = mapThreadView(
    thread,
    scope === "subagent" && subagentId !== undefined
      ? { scope: { kind: "subagent", subagentId } }
      : { scope: { kind: "top-level" } },
  );
  const parts: ToolCallPart[] = [];
  for (const m of view.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (isToolCall(p)) parts.push(p);
  }
  return { view, parts };
}

async function summaries(runId: string, base: string): Promise<unknown> {
  const run = await fetchRun(runId, base);
  const { view, parts } = partsOf(run.thread, "top-level");
  return {
    run_id: run.id,
    status: run.status,
    thread_length: run.thread.length,
    coverage: view.coverage,
    /* Every folded sub-agent, with the count the spawn row's chip shows. */
    folds: parts
      .filter((p) => p.subagent !== undefined)
      .map((p) => ({
        subagent_id: p.subagent!.subagentId,
        event_count: p.subagent!.eventCount,
      })),
    tool_rows: parts.map((p, i) => {
      const s = summarizeTool(
        p.toolName,
        p.argsText,
        typeof p.result === "string" ? p.result : p.result === undefined ? null : String(p.result),
        p.isError === true,
      );
      return {
        index: i,
        tool_use_id: p.toolCallId ?? null,
        tool: p.toolName,
        label: s.label,
        gist: s.gist,
        outcome: s.outcome,
        tone: s.tone,
        /** The one-liner as the row renders it: label, gist, [chip], → outcome. */
        collapsed: `${s.label} ${s.gist}${
          p.subagent === undefined
            ? ""
            : ` ${p.subagent.eventCount === 0 ? "no inline events" : `${p.subagent.eventCount} event${p.subagent.eventCount === 1 ? "" : "s"}`}`
        } → ${s.outcome}`,
        args_len: (p.argsText ?? "").length,
        result_len: typeof p.result === "string" ? p.result.length : null,
        pending: p.result === undefined,
      };
    }),
  };
}

async function subagentView(runId: string, subagentId: string, base: string): Promise<unknown> {
  const run = await fetchRun(runId, base);
  const { view } = partsOf(run.thread, "subagent", subagentId);
  return { run_id: run.id, subagent_id: subagentId, coverage: view.coverage };
}

async function identity(runId: string, subagentId: string | null, base: string): Promise<unknown> {
  const run = await fetchRun(runId, base);
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (subagentId === null) {
    const role = typeof meta.role === "string" ? meta.role : null;
    const model =
      typeof meta.model_resolved === "string"
        ? meta.model_resolved
        : typeof meta.model === "string"
          ? meta.model
          : null;
    return {
      kind: "session",
      raw: { role, model },
      rendered: { role: roleLabel(role), model: modelDisplay(model) },
      title: run.title ?? null,
    };
  }
  /* AgentChatView's two resolvers (`findSubagentMeta` / `findSpawnFacts`) are
   * private to that component — a "use client" React module this sidecar has no
   * business importing. Their SOURCES are not private: the rollup is read with
   * the shipped `parseSubagentsV2`, and the spawn call is read straight off the
   * wire here, in the same order and with the same precedence
   * (`meta.spawns_subagent_role` over `input.subagent_type`,
   * AgentChatView.tsx:157-182). Reading the wire is what an oracle is for; what
   * must not be re-implemented is the RENDERING, and `roleLabel`/`modelDisplay`
   * below are the shipped ones. */
  const sub: SubagentMeta | null =
    parseSubagentsV2((run.metadata as Record<string, unknown> | null)?.subagents_v2).find(
      (s) => s.tool_use_id === subagentId,
    ) ?? null;

  let spawnFound = false;
  let spawnRole: string | null = null;
  let spawnModel: string | null = null;
  let spawnDescription: string | null = null;
  for (const e of run.thread) {
    const meta = e.meta as Record<string, unknown> | undefined;
    if (!meta || meta.tool_use_id !== subagentId) continue;
    if (e.kind === "tool_call" && (meta.tool === "Agent" || meta.tool === "Task")) {
      spawnFound = true;
      let inputRole: string | null = null;
      let inputDescription: string | null = null;
      if (typeof meta.input === "string" && meta.input !== "") {
        try {
          const parsed: unknown = JSON.parse(meta.input);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const o = parsed as Record<string, unknown>;
            inputRole = typeof o.subagent_type === "string" && o.subagent_type ? o.subagent_type : null;
            inputDescription =
              typeof o.description === "string" && o.description ? o.description : null;
          }
        } catch {
          /* an unparsable input yields nulls rather than a guess */
        }
      }
      spawnRole =
        typeof meta.spawns_subagent_role === "string" && meta.spawns_subagent_role
          ? meta.spawns_subagent_role
          : inputRole;
      spawnModel = typeof meta.model === "string" && meta.model ? meta.model : null;
      spawnDescription = inputDescription;
    }
  }

  const role = sub?.role ?? spawnRole;
  const model = sub?.model ?? spawnModel;
  return {
    kind: "subagent",
    source: sub !== null ? "subagents_v2" : spawnFound ? "spawn_call" : "neither",
    raw: { role, model },
    rendered: { role: roleLabel(role), model: modelDisplay(model) },
    description: sub?.description ?? spawnDescription,
  };
}

async function main(): Promise<void> {
  const [cmd, a, b, c] = process.argv.slice(2);
  const base = (cmd === "identity" ? c : b) ?? API;
  if (cmd === "summaries") {
    console.log(JSON.stringify(await summaries(a, base), null, 2));
    return;
  }
  if (cmd === "subagent") {
    console.log(JSON.stringify(await subagentView(a, b, process.argv[5] ?? API), null, 2));
    return;
  }
  if (cmd === "identity") {
    console.log(
      JSON.stringify(await identity(a, b === undefined || b === "" ? null : b, base), null, 2),
    );
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(cmd)} — expected summaries|subagent|identity`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
