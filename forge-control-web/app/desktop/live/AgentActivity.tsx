"use client";

/**
 * Live agent activity — what every agent is doing, for how long, and at what cost.
 *
 * The panel makes two DIFFERENT concurrency systems legible at once:
 *
 *   System B — "workers" (kind: "run"). forge-control spawns a SEPARATE
 *   `claude` process per task, tracked in Postgres. These survive session
 *   cycles and are what the fleet actually is. Rendered as top-level rows.
 *
 *   System A — "threads" (kind: "subagent"). A single `claude` process spawns
 *   Task-tool agents (architect/planner/builder/…) INSIDE itself. They share
 *   the parent's process and die with it. Rendered nested under their parent,
 *   with a tree rail, because that containment is the whole point: if the
 *   parent dies, everything indented under it dies too.
 *
 * That distinction is not cosmetic — it explains why an in-process subagent
 * vanishes on a timeout while a fleet run keeps going.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens, dot } from "../../tokens";
import { fetchAgents, type AgentRow, type AgentUsage, type CurrentActivity } from "./agentsApi";

const STATUS_COLOR: Record<string, string> = {
  running: tokens.accent,
  queued: tokens.textMuted,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

/** 1h 04m / 12m 30s / 45s — the readout you actually want while watching. */
function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function activityLabel(act: CurrentActivity | null): string {
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? act.kind;
  if (act.kind === "tool_result") return "← result";
  if (act.kind === "text" && act.text) return act.text.slice(0, 60);
  return act.kind;
}

function compactNum(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cache reads are the bulk of a long agent turn and are ~10% the price of
 *  fresh input — showing them separately stops the total looking alarming. */
function tokenLine(u: AgentUsage | undefined): string {
  if (!u) return "";
  const cached = u.cache_read_input_tokens ?? 0;
  const parts = [
    `↓${compactNum(u.input_tokens ?? 0)}`,
    `↑${compactNum(u.output_tokens ?? 0)}`,
  ];
  if (cached) parts.push(`⚡${compactNum(cached)}`);
  return parts.join("  ");
}

function AgentLine({ a, depth = 0 }: { a: AgentRow; depth?: number }) {
  const isSub = a.kind === "subagent";
  const live = a.status === "running";

  // Tick locally so elapsed counts up between the 4s polls instead of
  // freezing — a frozen timer reads as "hung" even when it isn't.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const started = a.started_at
    ? new Date(a.started_at.replace(" ", "T").replace(/\+00$/, "Z")).getTime()
    : NaN;
  const elapsed = live && Number.isFinite(started) ? now - started : a.elapsed_ms;

  const usage = live && a.usage_running ? a.usage_running : a.usage_total;
  const toks = tokenLine(usage);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          padding: "5px 6px",
          paddingLeft: 6 + depth * 14,
          borderRadius: 6,
          position: "relative",
        }}
      >
        {/* Tree rail: makes "this agent lives inside that one" unmistakable. */}
        {depth > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: depth * 14 - 6,
              top: 0,
              bottom: 0,
              width: 1,
              background: tokens.border,
            }}
          />
        )}
        <span style={{ ...dot(STATUS_COLOR[a.status] ?? tokens.textFaint, live), alignSelf: "center" }} />
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: isSub ? tokens.textMuted : tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={a.title}
        >
          {isSub && (
            <span style={{ color: tokens.decide, marginRight: 5 }}>
              {a.model ?? "task"}
            </span>
          )}
          {a.title}
        </span>
        <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, flex: "none" }}>
          {humanDuration(elapsed)}
        </span>
      </div>

      {/* Second line: the numbers Konrad asked for — runtime is above, this is
          spend + tokens + what it's touching right now. */}
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: `0 6px 5px ${6 + depth * 14 + 14}px`,
        }}
      >
        {toks && <span>{toks}</span>}
        {a.spent_usd > 0 && <span>${a.spent_usd.toFixed(2)}</span>}
        {!isSub && a.effort && <span>{a.effort}</span>}
        {!isSub && a.model && (
          <span style={{ color: tokens.textMuted }}>{a.model}</span>
        )}
        {activityLabel(a.current_activity) && (
          <span
            style={{
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={activityLabel(a.current_activity)}
          >
            {activityLabel(a.current_activity)}
          </span>
        )}
      </div>

      {a.subagents?.map((s) => (
        <AgentLine key={s.id} a={s} depth={depth + 1} />
      ))}
    </div>
  );
}

export function AgentActivity() {
  const q = useQuery({
    queryKey: ["agents", "activity"],
    queryFn: fetchAgents,
    refetchInterval: 4_000,
  });

  const agents = q.data?.agents ?? [];
  const s = q.data?.summary;
  const active = agents.filter(
    (a) => a.status === "running" || a.status === "queued",
  );
  const recent = agents.filter(
    (a) => a.status !== "running" && a.status !== "queued",
  );

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
        }}
      >
        <span style={{ color: s?.running ? tokens.accent : tokens.textFaint }}>
          {s?.running ?? 0} running
        </span>
        {!!s?.active_subagents && <span>{s.active_subagents} subagents</span>}
        {!!s?.queued && <span>{s.queued} queued</span>}
        {!!s?.stuck && <span style={{ color: tokens.stuck }}>{s.stuck} stuck</span>}
        <span style={{ flex: 1 }} />
        {!!s?.spent_usd_last_hour && <span>${s.spent_usd_last_hour.toFixed(2)}/h</span>}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 4px 8px" }}>
        {q.isLoading && (
          <div className="mono" style={{ padding: 16, fontSize: 10.5, color: tokens.textFaint }}>
            loading agents…
          </div>
        )}
        {q.isError && (
          <div className="mono" style={{ padding: 16, fontSize: 10.5, color: tokens.bleed }}>
            {(q.error as Error).message}
          </div>
        )}
        {!q.isLoading && !agents.length && (
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
            no agents have run yet
          </div>
        )}

        {active.map((a) => (
          <AgentLine key={a.id} a={a} />
        ))}

        {!!recent.length && (
          <>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textGhost,
                letterSpacing: "0.08em",
                padding: "10px 6px 4px",
              }}
            >
              RECENT
            </div>
            {recent.slice(0, 12).map((a) => (
              <AgentLine key={a.id} a={a} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

export default AgentActivity;
