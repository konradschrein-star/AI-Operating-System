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
 * Row shape, deliberately imitating Claude Code's own task bar:
 *
 *   ● claude-fable-5   Rework Live agent panel        36m 52s · ↓ 204.7k
 *     ○ architect      Isolation + orchestration       4m 12s · ↓ 12.3k
 *
 *   type name in muted colour · title primary truncated · right-aligned
 *   live age + downloaded-token count. One shared 1-second tick drives
 *   every visible row (the previous per-row setInterval scaled with row
 *   count and was flagged by the UI audit §2.2a as a re-render source).
 */

import { useEffect, useMemo, useState } from "react";
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
 *  where the real spend signal lives (cache reads are ~10% the price of
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

function subagentActivityLabel(s: SubagentRow): string {
  const act = s.latest_activity;
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? "";
  if (act.kind === "tool_result") return "";
  if (act.text) return act.text.slice(0, 80);
  return "";
}

/** Parse the two timestamp shapes the API hands out: Postgres
 *  "2026-07-30 09:12:34.567+00" and ISO 8601. */
function parseTs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return new Date(ts.replace(" ", "T").replace(/\+00$/, "Z")).getTime();
}

/** Single 1s tick shared across every visible row. This replaces the
 *  per-row useLiveTick / setInterval pair — with ~10 running rows plus
 *  subagents that was 20+ timers each firing setState every second. */
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

function AgentRunLine({ a, now }: RowProps) {
  const live = a.status === "running";
  const started = parseTs(a.started_at);
  const elapsed =
    live && Number.isFinite(started) ? now - started : a.elapsed_ms;

  // Live usage during the current turn is more useful than the aggregated
  // total, which resets on session restart and lags by a full assistant
  // message. Fall back to total when we're not mid-turn.
  const usage = live && a.usage_running ? a.usage_running : a.usage_total;
  const tokensIn = downloadedTokens(usage);
  const label = activityLabel(a.current_activity);
  const statusColor = STATUS_COLOR[a.status] ?? tokens.textFaint;
  const nameColor = live ? tokens.textMuted : tokens.textFaint;

  return (
    <div>
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
        <span
          className="mono"
          style={{
            color: nameColor,
            flex: "none",
            whiteSpace: "nowrap",
          }}
          title={a.worker ?? "run"}
        >
          {a.model ?? "run"}
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

      {/* Second line: only shown when there's real information to add —
          spend, effort, or what the parent tool is doing this second. */}
      {(a.spent_usd > 0 || a.effort || label) && (
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
          {a.spent_usd > 0 && <span>${a.spent_usd.toFixed(2)}</span>}
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
      )}

      {a.subagents?.map((s) => (
        <SubagentLine key={s.tool_use_id} s={s} now={now} />
      ))}
    </div>
  );
}

function SubagentLine({ s, now }: { s: SubagentRow; now: number }) {
  const live = s.status === "running";
  const started = parseTs(s.started_at);
  const updated = parseTs(s.updated_at);
  const elapsed = Number.isFinite(started)
    ? (live ? now : Number.isFinite(updated) ? updated : now) - started
    : NaN;
  const statusColor = live ? tokens.accent : tokens.ok;
  const tokensIn = downloadedTokens(s.usage);
  const label = subagentActivityLabel(s);
  const nameColor = live ? tokens.textMuted : tokens.textFaint;
  const roleColor = live ? tokens.textHi : tokens.text;

  return (
    <div>
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
        <span
          className="mono"
          style={{
            color: nameColor,
            flex: "none",
            whiteSpace: "nowrap",
          }}
          title={s.model ?? "task"}
        >
          {s.role}
        </span>
        <span
          className="mono"
          style={{
            color: roleColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={label || s.role}
        >
          {label || s.role}
        </span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title="how long this subagent has been running"
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
    </div>
  );
}

export function AgentActivity() {
  const q = useQuery({
    queryKey: ["agents", "activity"],
    queryFn: fetchAgents,
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
        <span style={{ color: s?.running ? tokens.accent : tokens.textFaint }}>
          {s?.running ?? 0} running
        </span>
        {!!s?.active_subagents && <span>{s.active_subagents} subagents</span>}
        {!!s?.queued && <span>{s.queued} queued</span>}
        {!!s?.stuck && (
          <span style={{ color: tokens.stuck }}>{s.stuck} stuck</span>
        )}
        <span style={{ flex: 1 }} />
        {!!s?.spent_usd_last_hour && (
          <span>${s.spent_usd_last_hour.toFixed(2)}/h</span>
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
            no agent activity in the last 24h
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
