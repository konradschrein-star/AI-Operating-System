"use client";

/**
 * Live agent activity — modelled on the Claude Code CLI's own task bar.
 *
 * Two concurrency systems, one dense monospace list:
 *
 *   System B — "workers" (kind: "run"). forge-control spawns a SEPARATE
 *   `claude` process per task, tracked in Postgres. These survive session
 *   cycles and are what the fleet actually is. Rendered as top-level rows.
 *
 *   System A — "threads" (kind: "subagent"). A single `claude` process spawns
 *   Task-tool agents (architect/planner/builder/…) INSIDE itself. They share
 *   the parent's process and die with it. Rendered nested under their parent
 *   with a filled/hollow dot: filled dot = running, hollow = done/queued.
 *
 * That distinction is not cosmetic — it explains why an in-process subagent
 * vanishes on a timeout while a fleet run keeps going.
 *
 * Row shape, deliberately imitating Claude Code's own task bar — two lines:
 * WHAT it is doing on top, WHAT IT IS underneath.
 *
 *   ● operator  Rework Live agent panel              36m 52s · ↓ 204.7k
 *       chat  fable-5  Bash
 *   ● worker    Phase 2b: kind badge + role           4m 12s · ↓ 88.1k
 *       builder  opus-5  Edit
 *     ○ ↳ sub   Recon chat Bash block rendering       1m 47s · ↓ 132.1k
 *         Explore  opus-5  Grep
 *
 *   kind badge in its role's colour · title primary truncated ·
 *   right-aligned live age + downloaded-token count; role/schedule, model,
 *   effort and current tool on the faint second line. One shared 1-second
 *   tick drives every visible row (the previous per-row setInterval scaled
 *   with row count and was flagged by the UI audit §2.2a as a re-render
 *   source). Lineage is a native `title` on each row container — no hover
 *   state anywhere in this directory, by design (R10).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens, dot } from "../../tokens";
import {
  agentKindOf,
  fetchAgents,
  isModelAlias,
  modelDisplay,
  roleLabel,
  roleTokenName,
  runElapsedMs,
  subagentElapsedMs,
  type AgentKind,
  type AgentRow,
  type AgentUsage,
  type CurrentActivity,
  type RoleTokenName,
  type SubagentRow,
} from "./agentsApi";

const STATUS_COLOR: Record<string, string> = {
  running: tokens.accent,
  queued: tokens.textMuted,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "queued",
  "stuck",
  "paused",
]);

/** 1h 04m / 12m 30s / 45s — Claude Code's own format, no clock glyph.
 *  Length-bounded so the right column never wobbles as it counts. */
function humanDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 204.7k / 1.2M / 987 — same rounding rules as the Claude Code bar. */
function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 10 ? k.toFixed(1) : k.toFixed(k < 100 ? 1 : 0)}k`;
  }
  const M = n / 1_000_000;
  return `${M < 10 ? M.toFixed(2) : M.toFixed(1)}M`;
}

/** "Downloaded" tokens = input + cache_read. That's what the CLI's own bar
 *  reports: the total context the model consumed on this turn, which is
 *  where the real magnitude lives (cache reads are ~10% the price of
 *  fresh input but often 90% of the count). */
function downloadedTokens(u: AgentUsage | undefined | null): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Best short label for what the agent is doing right now — tool name for a
 *  call, first slice of assistant text for a message, empty otherwise. */
function activityLabel(act: CurrentActivity | null): string {
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? "";
  if (act.kind === "tool_result") return "";
  if (act.text) return act.text.slice(0, 80);
  return "";
}

/* ── Kind grammar, rendering half ─────────────────────────────────────────
 *
 * agentsApi.ts decides WHAT a row is and which token NAME its role wears
 * (that module stays React-free and token-free so the check script can import
 * it). This is the only place a name becomes a colour.
 */

const ROLE_COLOR: Record<RoleTokenName, string> = {
  decide: tokens.decide,
  info: tokens.info,
  accent: tokens.accent,
  warn: tokens.warn,
  textMuted2: tokens.textMuted2,
  ok: tokens.ok,
  textMuted: tokens.textMuted,
};

function roleColor(role: string | null | undefined): string {
  return ROLE_COLOR[roleTokenName(role)];
}

/** The badge is the row's one-word answer to "what is this?".
 *  `unknown` wears `warn` deliberately — an unclassified run is a fact about
 *  the fleet, not a rendering hole to be smoothed over. */
function kindColor(kind: AgentKind, role: string | null | undefined): string {
  switch (kind) {
    case "operator":
      return tokens.accent;
    case "worker":
      return roleColor(role);
    case "cron":
      return tokens.textMuted;
    case "unknown":
      return tokens.warn;
  }
}

/** Second-line qualifier: which role, which schedule, or — for an
 *  unclassified row — the worker identity that failed to classify, because
 *  that is the one datum that explains why it says "unknown". */
function kindDetail(a: AgentRow, kind: AgentKind): string {
  switch (kind) {
    case "operator":
      return "chat";
    case "worker":
      return roleLabel(a.role);
    case "cron":
      return a.cron_name ?? "unnamed schedule";
    case "unknown":
      return a.worker ?? "no worker";
  }
}

function kindDetailColor(kind: AgentKind, role: string | null | undefined): string {
  return kind === "worker" ? roleColor(role) : tokens.textFaint;
}

/** First 8 chars of a UUID — enough to grep the database with, short enough
 *  to read inside a native tooltip. */
function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "none";
}

/** Lineage, R10 — composed at render time into a NATIVE `title`. No hover
 *  state, no portal, no tooltip component: those are what phase 3 is cleaning
 *  up, and this panel must not add more of them.
 *
 *  Titles carry the RAW model id, not `modelDisplay`. The badge column is
 *  where brevity belongs; the tooltip is the diagnostic surface, and
 *  `claude-haiku-4-5-20251001` is what you paste into a query. */
function lineageTitle(a: AgentRow, kind: AgentKind): string {
  const model = a.model ?? "—";
  const run = short(a.id);
  switch (kind) {
    case "operator":
      return `operator chat (full Claude Code session) · model ${model} · run ${run}`;
    case "worker": {
      const base = `project worker · ${a.role ?? "no role"} · project ${short(
        a.project_id,
      )} · model ${model} · run ${run}`;
      return a.parent_run_id ? `${base} · child of ${short(a.parent_run_id)}` : base;
    }
    case "cron":
      return `cron ${a.cron_name ?? "unnamed"} · model ${model} · run ${run}`;
    case "unknown":
      return `unclassified run · worker ${a.worker ?? "none"} · run ${run}`;
  }
}

/** The line Konrad asked for: is this a whole Claude Code session, or a Task
 *  agent living inside one? Parent title and parent model arrive as primitive
 *  props so this stays a pure string function and the child never reads the
 *  parent row object. */
function subagentLineageTitle(
  s: SubagentRow,
  parentTitle: string,
  parentModel: string,
): string {
  return (
    `in-process sub-agent of "${parentTitle}" (${parentModel}) · ` +
    `role ${s.role} · model ${s.model ?? "—"} · started ${s.started_at}`
  );
}

function subagentActivityLabel(s: SubagentRow): string {
  const act = s.latest_activity;
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? "";
  if (act.kind === "tool_result") return "";
  if (act.text) return act.text.slice(0, 80);
  return "";
}

/** Single 1s tick shared across every visible row. This replaces the
 *  per-row useLiveTick / setInterval pair — with ~10 running rows plus
 *  subagents that was 20+ timers each firing setState every second.
 *
 *  This is the one legitimate `Date.now()` left in this file: it is the
 *  clock, not duration math. Every duration is derived in agentsApi.ts. */
function useSharedClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

interface RowProps {
  a: AgentRow;
  now: number;
}

/** Width of the kind column. Fixed so the titles line up down the list and
 *  nothing wobbles as rows change kind between polls; `minWidth` rather than
 *  `width` so a long cron name can spill rather than be clipped. */
const KIND_COL = 52;

/** Aliases render fainter than resolved ids — the colour IS the statement
 *  that we know less about this row's model (R8). */
function modelColor(model: string | null | undefined): string {
  return isModelAlias(model) ? tokens.textGhost : tokens.textFaint;
}

function AgentRunLine({ a, now }: RowProps) {
  const live = a.status === "running";
  const elapsed = runElapsedMs(a, now);

  // Live usage during the current turn is more useful than the aggregated
  // total, which resets on session restart and lags by a full assistant
  // message. Fall back to total when we're not mid-turn.
  const usage = live && a.usage_running ? a.usage_running : a.usage_total;
  const tokensIn = downloadedTokens(usage);
  const label = activityLabel(a.current_activity);
  const statusColor = STATUS_COLOR[a.status] ?? tokens.textFaint;
  const kind = agentKindOf(a);
  const lineage = lineageTitle(a, kind);
  const model = modelDisplay(a.model);

  return (
    // Lineage lives on the row container (02-architecture §4.3): every part of
    // the row that does not state something more specific — the dot, the
    // badge, the second line, the padding — answers "what is this and whose
    // child is it?" on hover, with zero JS.
    <div title={lineage} data-agent-kind={kind}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "3px 8px",
          fontSize: 11,
        }}
      >
        {/* Filled dot = live/running, hollow = anything else — this is the
            one glyph difference from the Claude Code bar. */}
        <span
          style={{
            ...dot(statusColor, live),
            alignSelf: "center",
            ...(live ? {} : { background: "transparent", border: `1px solid ${statusColor}` }),
          }}
        />
        {/* Kind badge. This slot used to hold the raw model id, which said
            nothing about what the row WAS — the model moved to the second
            line, where it now sits next to the role it ran. */}
        <span
          className="mono"
          style={{
            color: kindColor(kind, a.role),
            flex: "none",
            minWidth: KIND_COL,
            whiteSpace: "nowrap",
            fontSize: 9.5,
            letterSpacing: "0.04em",
          }}
        >
          {kind}
        </span>
        <span
          className="mono"
          style={{
            color: tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={a.title}
        >
          {a.title}
        </span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title={live ? "running for this long" : "total run time"}
        >
          {humanDuration(elapsed)}
        </span>
        <span style={{ color: tokens.textGhost, flex: "none" }}>·</span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title="downloaded tokens (input + cache read)"
        >
          ↓ {humanTokens(tokensIn)}
        </span>
      </div>

      {/* Second line, now unconditional: role/schedule and model are facts
          about every row, not extras. It used to appear only when there was
          effort or activity to report, which is exactly when a quiet
          row is hardest to identify. */}
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: "0 8px 4px 24px",
        }}
      >
        <span
          style={{
            color: kindDetailColor(kind, a.role),
            flex: "none",
            whiteSpace: "nowrap",
          }}
        >
          {kindDetail(a, kind)}
        </span>
        <span style={{ color: modelColor(a.model), flex: "none", whiteSpace: "nowrap" }}>
          {model}
        </span>
        {a.effort && <span>{a.effort}</span>}
        {label && (
          <span
            style={{
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={label}
          >
            {label}
          </span>
        )}
      </div>

      {a.subagents?.map((s) => (
        <SubagentLine
          key={s.tool_use_id}
          s={s}
          now={now}
          parentTitle={a.title}
          parentModel={model}
        />
      ))}
    </div>
  );
}

function SubagentLine({
  s,
  now,
  parentTitle,
  parentModel,
}: {
  s: SubagentRow;
  now: number;
  /** Primitives, not the parent row: the lineage string is built here but the
   *  child must not be able to read — or re-render on — the parent object. */
  parentTitle: string;
  parentModel: string;
}) {
  const live = s.status === "running";
  const elapsed = subagentElapsedMs(s, now);
  const statusColor = live ? tokens.accent : tokens.ok;
  const tokensIn = downloadedTokens(s.usage);
  const label = subagentActivityLabel(s);
  const titleColor = live ? tokens.textHi : tokens.text;
  // What the sub-agent was SENT to do beats what it happens to be touching
  // this second: "Recon chat Bash block rendering" identifies a sub-agent,
  // "Bash" does not. Activity keeps the title attribute and the second line.
  const rowTitle = s.description || label || s.role;

  return (
    <div
      title={subagentLineageTitle(s, parentTitle, parentModel)}
      data-agent-kind="subagent"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "2px 8px 2px 20px",
          fontSize: 11,
        }}
      >
        <span
          style={{
            ...dot(statusColor, live),
            alignSelf: "center",
            ...(live ? {} : { background: "transparent", border: `1px solid ${statusColor}` }),
          }}
        />
        {/* Sits in the same column as the top-level kind badge and says the
            opposite thing: this row is NOT its own Claude Code session, it is
            a Task agent inside the process one line above.

            `textMuted2`, not the `textGhost` the plan suggested: in the light
            palette ghost sits around 2.5:1 against the card, which made the
            one marker that answers Konrad's actual question the faintest
            thing in the row. Muted2 is still visibly subordinate to the
            description beside it — see docs/plan/artifacts/phase2/README.md. */}
        <span
          className="mono"
          style={{
            color: tokens.textMuted2,
            flex: "none",
            minWidth: KIND_COL - 12,
            whiteSpace: "nowrap",
            fontSize: 9.5,
            letterSpacing: "0.04em",
          }}
        >
          ↳ sub
        </span>
        <span
          className="mono"
          style={{
            color: titleColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={label || undefined}
        >
          {rowTitle}
        </span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title={live ? "running for this long" : "total subagent run time"}
        >
          {humanDuration(elapsed)}
        </span>
        <span style={{ color: tokens.textGhost, flex: "none" }}>·</span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title="downloaded tokens (input + cache read)"
        >
          ↓ {humanTokens(tokensIn)}
        </span>
      </div>

      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: "0 8px 3px 36px",
        }}
      >
        <span
          style={{ color: roleColor(s.role), flex: "none", whiteSpace: "nowrap" }}
        >
          {roleLabel(s.role)}
        </span>
        <span style={{ color: modelColor(s.model), flex: "none", whiteSpace: "nowrap" }}>
          {modelDisplay(s.model)}
        </span>
        {label && (
          <span
            style={{
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={label}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentActivity({
  projectId,
  groupName,
}: {
  projectId?: string;
  groupName?: string;
} = {}) {
  const q = useQuery({
    queryKey: ["agents", "activity", projectId ?? null],
    queryFn: () => fetchAgents(projectId),
    refetchInterval: 4_000,
  });

  const agents = useMemo(() => q.data?.agents ?? [], [q.data]);
  const s = q.data?.summary;

  // Memoised partition — the audit flagged these as unmemoised filter+Set()
  // allocations that fired on every one-second useLiveTick tick.
  const { active, recent } = useMemo(() => {
    const active: AgentRow[] = [];
    const recent: AgentRow[] = [];
    for (const a of agents) {
      if (ACTIVE_STATUSES.has(a.status)) active.push(a);
      else recent.push(a);
    }
    return { active, recent };
  }, [agents]);

  // Only tick the clock when SOMETHING can be counting up. Kills the timer
  // entirely when the panel is idle (empty state / all recent).
  const anyRunning = useMemo(() => {
    if (active.some((a) => a.status === "running")) return true;
    for (const a of active) {
      if (a.subagents?.some((sa) => sa.status === "running")) return true;
    }
    return false;
  }, [active]);
  const now = useSharedClock(anyRunning);

  return (
    <>
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          fontSize: 10,
          color: tokens.textFaint,
          flexWrap: "wrap",
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        {groupName && (
          <span
            style={{
              color: tokens.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 120,
            }}
            title={groupName}
          >
            {groupName}
          </span>
        )}
        <span style={{ color: s?.running ? tokens.accent : tokens.textFaint }}>
          {s?.running ?? 0} running
        </span>
        {!!s?.active_subagents && <span>{s.active_subagents} subagents</span>}
        {!!s?.queued && <span>{s.queued} queued</span>}
        {!!s?.stuck && (
          <span style={{ color: tokens.stuck }}>{s.stuck} stuck</span>
        )}
        <span style={{ flex: 1 }} />
        {!!(s?.tokens_out_last_hour || s?.tokens_in_last_hour) && (
          <span title="tokens generated / read in the last hour">
            ↑ {humanTokens(s.tokens_out_last_hour)} ↓{" "}
            {humanTokens(s.tokens_in_last_hour)} /h
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 8px" }}>
        {q.isLoading && (
          <div
            className="mono"
            style={{ padding: 16, fontSize: 10.5, color: tokens.textFaint }}
          >
            loading agents…
          </div>
        )}
        {q.isError && (
          <div
            className="mono"
            style={{ padding: 16, fontSize: 10.5, color: tokens.bleed }}
          >
            {(q.error as Error).message}
          </div>
        )}
        {!q.isLoading && !q.isError && !agents.length && (
          <div
            className="mono"
            style={{
              padding: "24px 8px",
              fontSize: 10.5,
              color: tokens.textFaint,
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            {projectId
              ? "No active project group"
              : "no agent activity in the last 24h"}
          </div>
        )}

        {active.map((a) => (
          <AgentRunLine key={a.id} a={a} now={now} />
        ))}

        {!!recent.length && (
          <>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textGhost,
                letterSpacing: "0.08em",
                padding: "10px 8px 4px",
              }}
            >
              RECENT
            </div>
            {recent.slice(0, 12).map((a) => (
              <AgentRunLine key={a.id} a={a} now={now} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

export default AgentActivity;
