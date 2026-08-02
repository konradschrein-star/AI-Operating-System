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
import {
  fetchAgents,
  type AgentRow,
  type AgentUsage,
  type CurrentActivity,
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

/** 1h 04m / 12m 30s / 45s — the readout you actually want while watching. */
function humanDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
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
  if ((act.kind === "text" || act.kind === "assistant_text") && act.text) return act.text.slice(0, 60);
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

/** Parse the two timestamp shapes the API hands out: Postgres
 *  "2026-07-30 09:12:34.567+00" and ISO 8601. */
function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return new Date(ts.replace(" ", "T").replace(/\+00$/, "Z")).getTime();
}

/** Tick every second while `live` — so elapsed counts up between 4s polls
 *  instead of freezing. Shared between both row components. */
function useLiveTick(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

function AgentRunLine({ a }: { a: AgentRow }) {
  const live = a.status === "running";
  const now = useLiveTick(live);

  const started = parseTs(a.started_at);
  const elapsed =
    live && Number.isFinite(started)
      ? now - started
      : a.elapsed_ms; // may be null while queued — humanDuration handles it

  const usage = live && a.usage_running ? a.usage_running : a.usage_total;
  const toks = tokenLine(usage);
  const label = activityLabel(a.current_activity);

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          padding: "5px 6px",
          borderRadius: 6,
        }}
      >
        <span style={{ ...dot(STATUS_COLOR[a.status] ?? tokens.textFaint, live), alignSelf: "center" }} />
        <span
          className="mono"
          style={{
            fontSize: 11,
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
        {/* Clock glyph + tooltip: a bare "23m" in a corner is a riddle. */}
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textFaint, flex: "none" }}
          title={live ? "running for this long" : "total run time"}
        >
          ⏱ {humanDuration(elapsed)}
        </span>
      </div>

      {/* Second line: spend + tokens + current tool activity — the numbers
          Konrad asked for. */}
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: "0 6px 5px 20px",
        }}
      >
        {toks && <span>{toks}</span>}
        {a.spent_usd > 0 && <span>${a.spent_usd.toFixed(2)}</span>}
        {a.effort && <span>{a.effort}</span>}
        {a.model && <span style={{ color: tokens.textMuted }}>{a.model}</span>}
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
        <SubagentLine key={s.tool_use_id} s={s} depth={1} />
      ))}
    </div>
  );
}

function SubagentLine({ s, depth }: { s: SubagentRow; depth: number }) {
  const live = s.status === "running";
  const now = useLiveTick(live);

  const started = parseTs(s.started_at);
  const updated = parseTs(s.updated_at);
  const elapsed = Number.isFinite(started)
    ? (live ? now : Number.isFinite(updated) ? updated : now) - started
    : NaN;

  const toks = tokenLine(s.usage);
  const act = s.latest_activity;
  const label = act
    ? act.kind === "tool_call"
      ? act.tool ?? act.kind
      : act.kind === "tool_result"
        ? "← result"
        : act.text
          ? act.text.slice(0, 60)
          : act.kind
    : "";
  const statusColor = live ? tokens.accent : tokens.ok;

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          padding: "5px 6px",
          paddingLeft: 6 + depth * 14,
          borderRadius: 6,
        }}
      >
        {/* Tree rail — makes containment visible: if the parent run dies,
            every subagent nested under it dies with it. */}
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
        <span style={{ ...dot(statusColor, live), alignSelf: "center" }} />
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={s.role}
        >
          <span style={{ color: tokens.decide, marginRight: 5 }}>
            {s.model ?? "task"}
          </span>
          {s.role}
        </span>
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textFaint, flex: "none" }}
          title="how long this subagent has been running"
        >
          ⏱ {humanDuration(elapsed)}
        </span>
      </div>

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
        {s.event_count > 0 && <span>{s.event_count} evt</span>}
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

export function AgentActivity() {
  const q = useQuery({
    queryKey: ["agents", "activity"],
    queryFn: fetchAgents,
    refetchInterval: 4_000,
  });

  const agents = q.data?.agents ?? [];
  const s = q.data?.summary;
  const ACTIVE_STATUSES = new Set(["running", "queued", "stuck", "paused"]);
  const active = agents.filter((a) => ACTIVE_STATUSES.has(a.status));
  const recent = agents.filter((a) => !ACTIVE_STATUSES.has(a.status));

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
            no agents have run yet
          </div>
        )}

        {active.map((a) => (
          <AgentRunLine key={a.id} a={a} />
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
              <AgentRunLine key={a.id} a={a} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

export default AgentActivity;
