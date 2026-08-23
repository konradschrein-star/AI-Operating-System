"use client";

/**
 * v1.6 Tier-2 phase 4 — Automation Surface (Scheduled Routines + Inbound Webhooks).
 *
 * Provides a unified operator control plane for:
 * 1. Scheduled Routines (Cron) — autonomous background loops evaluated in Berlin time (Europe/Berlin).
 * 2. Inbound Webhooks — HMAC-authenticated external triggers with secret management and simulator.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  previewCron,
  triggerScheduleRun,
  type Webhook,
  type CronSchedule,
  type CreateWebhookResult,
} from "../api";
import { jumpToRun, openSettings, type NavigateTo } from "./deep-link";

type Tab = "cron" | "webhooks";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

const CARD_BORDER = `1px solid ${tokens.border}`;
const CARD_STYLE: React.CSSProperties = {
  background: tokens.bgCard,
  border: CARD_BORDER,
  borderRadius: 8,
  padding: 16,
};

/* ----------------------------------------------------------------------------
 * Helpers & Timezone Formatter (Europe/Berlin)
 * -------------------------------------------------------------------------- */

function formatInBerlin(iso: string | null | undefined): string {
  if (!iso) return "never";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d) + " Berlin"
    );
  } catch {
    return iso;
  }
}

function humanizeCountdown(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) return "—";
    const now = Date.now();
    const diffSec = Math.floor((target - now) / 1000);
    if (diffSec <= 0) return "due now / next tick";
    if (diffSec < 60) return `in ${diffSec}s`;
    if (diffSec < 3600) return `in ${Math.floor(diffSec / 60)}m ${diffSec % 60}s`;
    if (diffSec < 86400) {
      const h = Math.floor(diffSec / 3600);
      const m = Math.floor((diffSec % 3600) / 60);
      return `in ${h}h ${m}m`;
    }
    const d = Math.floor(diffSec / 86400);
    const h = Math.floor((diffSec % 86400) / 3600);
    return `in ${d}d ${h}h`;
  } catch {
    return "—";
  }
}

function humanizeCron(expr: string): string {
  const clean = expr.trim();
  if (clean === "0 7 * * *") return "Daily at 07:00 (Berlin)";
  if (clean === "30 21 * * *") return "Daily at 21:30 (Berlin)";
  if (clean === "0 9 * * 1-5") return "Weekdays at 09:00 (Berlin)";
  if (clean === "0 18 * * 0") return "Sundays at 18:00 (Berlin)";
  if (clean === "15 * * * *") return "Hourly at minute :15";
  if (clean === "*/15 * * * *") return "Every 15 minutes";
  if (clean === "*/5 * * * *") return "Every 5 minutes";
  if (clean === "0 0 1 * *") return "Monthly on 1st at 00:00 (Berlin)";
  if (clean === "0 12 * * 0") return "Sundays at 12:00 (Berlin)";

  const dailyMatch = clean.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (dailyMatch) {
    const min = dailyMatch[1].padStart(2, "0");
    const hour = dailyMatch[2].padStart(2, "0");
    return `Daily at ${hour}:${min} (Berlin)`;
  }
  const weekdayMatch = clean.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+1-5$/);
  if (weekdayMatch) {
    const min = weekdayMatch[1].padStart(2, "0");
    const hour = weekdayMatch[2].padStart(2, "0");
    return `Weekdays at ${hour}:${min} (Berlin)`;
  }
  const stepMatch = clean.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (stepMatch) {
    return `Every ${stepMatch[1]} minutes`;
  }
  const hourlyMatch = clean.match(/^(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (hourlyMatch) {
    return `Hourly at :${hourlyMatch[1].padStart(2, "0")}`;
  }
  return clean;
}

function renderTemplatePreview(
  template: string,
  jsonStr: string,
): { rendered: string; error?: string } {
  let parsed: Record<string, unknown> = {};
  try {
    if (jsonStr.trim()) {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    }
  } catch (e) {
    return {
      rendered: template,
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    let out = template;
    out = out.replace(/\{\{\s*body\s*\}\}/g, JSON.stringify(parsed, null, 2));
    out = out.replace(
      /\{\{\s*body\.([\w.-]+)\s*\}\}/g,
      (_m, pathStr: string) => {
        let cur: unknown = parsed;
        for (const part of pathStr.split(".")) {
          if (
            cur &&
            typeof cur === "object" &&
            part in (cur as Record<string, unknown>)
          ) {
            cur = (cur as Record<string, unknown>)[part];
          } else {
            return "";
          }
        }
        return typeof cur === "string" ? cur : JSON.stringify(cur);
      },
    );
    return { rendered: out };
  } catch (e) {
    return {
      rendered: template,
      error: `Render error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ----------------------------------------------------------------------------
 * Presets and Model / Worker Options
 * -------------------------------------------------------------------------- */

const SCHEDULE_PRESETS = [
  {
    id: "morning",
    label: "Daily Morning (07:00 Berlin)",
    expr: "0 7 * * *",
    name: "mentor-morning",
    desc: "Morning mentor check-in: scoreboard, commitments, calendar blocker.",
    template:
      "You are Konrad's mentor. Run morning check-in:\n1. Review yesterday's scoreboard and note streak.\n2. Propose 1-3 needle-mover commitments.\n3. Block deep work time slots on calendar.\n4. Send punchy brief to phone.",
    model: "claude-sonnet-5",
    worker: "mentor",
    notify: "always",
  },
  {
    id: "evening",
    label: "Daily Evening Debrief (21:30 Berlin)",
    expr: "30 21 * * *",
    name: "mentor-evening",
    desc: "Evening debrief: score commitments, evaluate said-vs-done, roll plan forward.",
    template:
      "You are Konrad's mentor. Run evening debrief:\n1. Close today out: score commitments and record streak metrics.\n2. Roll unfinished items forward.\n3. Formulate tomorrow's plan with 3 focus goals.\n4. Leave uncommitted for Konrad's morning review.",
    model: "claude-sonnet-5",
    worker: "mentor",
    notify: "always",
  },
  {
    id: "standup",
    label: "Weekday Standup (09:00 Berlin)",
    expr: "0 9 * * 1-5",
    name: "daily-standup",
    desc: "Weekday morning engineering standup: active projects, blocked tasks, today's goals.",
    template:
      "Run weekday engineering standup:\n1. Scan active projects and tasks in progress.\n2. Check for stuck workers or failed background jobs.\n3. Provide concise 3-bullet priority briefing.",
    model: "gemini-3.7-flash-high",
    worker: "operator",
    notify: "on-error",
  },
  {
    id: "weekly",
    label: "Sunday Review (18:00 Berlin)",
    expr: "0 18 * * 0",
    name: "weekly-review",
    desc: "Sunday evening weekly review: aggregate habit rates, ship cadence, weekly plan.",
    template:
      "Run Sunday weekly review:\n1. Review past 7 days output cadence and habit fulfilment.\n2. Flag open loops and stale backlog candidates.\n3. Outline focus priorities for the upcoming week.",
    model: "claude-sonnet-5",
    worker: "mentor",
    notify: "always",
  },
  {
    id: "watchdog",
    label: "Hourly Watchdog (minute :15)",
    expr: "15 * * * *",
    name: "forge-watchdog",
    desc: "Hourly background health monitor for content forge and ai-os workers.",
    template:
      "Run system watchdog check:\n1. Check database pools, pm2 worker statuses, and queue latency.\n2. Alert only on persistent degradation or critical error states.",
    model: "gemini-3.7-flash-high",
    worker: "watchdog",
    notify: "on-error",
  },
  {
    id: "frequent",
    label: "Every 15 Minutes",
    expr: "*/15 * * * *",
    name: "queue-monitor",
    desc: "Frequent queue & worker tick monitor.",
    template: "Inspect pending run queues and report anomalies.",
    model: "gemini-3.7-flash-high",
    worker: "watchdog",
    notify: "silent",
  },
] as const;

const MODEL_OPTIONS = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-opus-5", label: "Claude Opus 5" },
  { value: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High Budget)" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

const WORKER_OPTIONS = [
  { value: "mentor", label: "Mentor" },
  { value: "operator", label: "Operator" },
  { value: "watchdog", label: "Forge Watchdog" },
  { value: "architect", label: "Architect" },
  { value: "builder", label: "Builder" },
  { value: "scout", label: "Scout" },
  { value: "default", label: "Default" },
] as const;

const NOTIFY_OPTIONS = [
  { value: "always", label: "Telegram: Always push summary" },
  { value: "on-error", label: "Telegram: Push only on error" },
  { value: "silent", label: "Silent / Inbox only" },
] as const;

/* ----------------------------------------------------------------------------
 * Main Component
 * -------------------------------------------------------------------------- */

/** `onNav` is the shell's surface switcher, threaded down to every "open this
 *  run in chat" affordance and to the Connections pointer in the banner. It is
 *  REQUIRED: until round 5 those links were plain anchors pointing at
 *  `/desktop?surface=…` and did nothing at all, because this console is one
 *  route whose surface is React state and nothing reads the query string (see
 *  ./deep-link for the whole story). The dead attribute is described here
 *  rather than quoted, because check-deep-link.ts greps these two files for it
 *  and a checker that matches its own documentation is a checker that fails
 *  when someone explains it better. */
export function AutomationSurface({ onNav }: { onNav: NavigateTo }) {
  // Requirement 1: Switch default tab to CRON (Scheduled Routines)
  const [tab, setTab] = useState<Tab>("cron");

  const cronQuery = useQuery({ queryKey: ["cron"], queryFn: fetchSchedules });
  const webhooksQuery = useQuery({
    queryKey: ["webhooks"],
    queryFn: fetchWebhooks,
  });

  const cronCount = cronQuery.data?.length ?? 0;
  const webhooksCount = webhooksQuery.data?.length ?? 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Requirement 2: Header context banner */}
      <HeaderContextBanner onNav={onNav} />

      {/* Top Tab Bar Rail */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 16px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          alignItems: "center",
          background: tokens.bgTabBar,
        }}
      >
        <TabBtn
          label={`SCHEDULED ROUTINES (${cronCount})`}
          active={tab === "cron"}
          onClick={() => setTab("cron")}
        />
        <TabBtn
          label={`INBOUND WEBHOOKS (${webhooksCount})`}
          active={tab === "webhooks"}
          onClick={() => setTab("webhooks")}
        />
        <div
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: tokens.textMuted,
            letterSpacing: "0.08em",
          }}
          className="mono"
        >
          v1.6 · TIER-2 · AUTOMATION
        </div>
      </div>

      {/* Main Surface Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
        {tab === "cron" ? (
          <ScheduledRoutinesPanel onNav={onNav} />
        ) : (
          <InboundWebhooksPanel onNav={onNav} />
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Header Context Banner
 * -------------------------------------------------------------------------- */

function HeaderContextBanner({ onNav }: { onNav: NavigateTo }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        background: tokens.bgCard,
        borderBottom: `1px solid ${tokens.borderSoft}`,
        fontSize: 12,
        color: tokens.textMuted,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: tokens.accent, fontWeight: 600 }}>ℹ</span>
        <span>
          Looking for external API credentials & accounts? Manage Connected
          Services in{" "}
          {/* SettingsSurface keeps its open section in a plain `useState` with
              no storage key, so there is nothing to pre-select — this lands on
              the settings index with CONNECTIONS one row away, and the label
              says so rather than promising a tab. */}
          <button
            type="button"
            onClick={() => openSettings(onNav)}
            style={{
              font: "inherit",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: tokens.accent,
              textDecoration: "underline",
              fontWeight: 500,
            }}
          >
            Settings &rarr; Connections
          </button>
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: "transparent",
          border: "none",
          color: tokens.textGhost,
          fontSize: 14,
          cursor: "pointer",
          padding: "2px 6px",
        }}
        title="Dismiss banner"
      >
        ✕
      </button>
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="mono"
      style={{
        background: active ? tokens.primaryActionBg : "transparent",
        border: `1px solid ${active ? tokens.accent : tokens.borderSoft}`,
        color: active ? tokens.textHi : tokens.textBody,
        padding: "6px 14px",
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: "0.08em",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      {label}
    </button>
  );
}

/* ============================================================================
 * Scheduled Routines Panel (Cron)
 * ========================================================================== */

function ScheduledRoutinesPanel({ onNav }: { onNav: NavigateTo }) {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ["cron"], queryFn: fetchSchedules });

  const [modalState, setModalState] = useState<{
    open: boolean;
    schedule?: CronSchedule;
  }>({ open: false });

  const [triggeredRun, setTriggeredRun] = useState<{
    name: string;
    run_id: string;
  } | null>(null);

  const schedules = listQ.data ?? [];

  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        gridTemplateColumns: "1fr 380px",
        alignItems: "start",
      }}
    >
      <div>
        <SectionHeader
          title="SCHEDULED ROUTINES"
          subtitle="Autonomous cron loops evaluated in Berlin Time (Europe/Berlin). Ticked in-process every 15s."
          right={
            <button
              style={createBtn}
              onClick={() => setModalState({ open: true })}
            >
              + new routine
            </button>
          }
        />

        {/* Trigger feedback toast banner */}
        {triggeredRun && (
          <div
            style={{
              ...CARD_STYLE,
              marginBottom: 12,
              background: tokens.okActionBg,
              borderColor: tokens.okActionBorder,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ fontSize: 12, color: tokens.textHi }}>
              ✓ Routine <strong>{triggeredRun.name}</strong> triggered! Run ID:{" "}
              <button
                type="button"
                onClick={() => jumpToRun(triggeredRun.run_id, onNav)}
                title={`Open run ${triggeredRun.run_id} in chat`}
                style={{
                  font: "inherit",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: tokens.accent,
                  fontWeight: 600,
                  textDecoration: "underline",
                  marginLeft: 4,
                }}
              >
                {triggeredRun.run_id.slice(0, 8)} &rarr; Open in Chat
              </button>
            </div>
            <button
              style={{
                background: "transparent",
                border: "none",
                color: tokens.textMuted,
                cursor: "pointer",
              }}
              onClick={() => setTriggeredRun(null)}
            >
              ✕
            </button>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 12,
          }}
        >
          {/* State 1: Loading */}
          {listQ.isLoading && (
            <>
              <SkeletonRoutineCard />
              <SkeletonRoutineCard />
            </>
          )}

          {/* State 2: Error */}
          {listQ.error && (
            <div
              style={{
                ...CARD_STYLE,
                borderColor: tokens.dangerActionBorder,
                background: tokens.dangerActionBg,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: tokens.bleed,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                Failed to load scheduled routines
              </div>
              <div style={{ fontSize: 12, color: tokens.textMuted }}>
                {(listQ.error as Error).message}
              </div>
              <button
                style={{ ...secondaryBtn, marginTop: 10 }}
                onClick={() => listQ.refetch()}
              >
                Retry
              </button>
            </div>
          )}

          {/* State 3: Empty */}
          {!listQ.isLoading && !listQ.error && schedules.length === 0 && (
            <EmptyHint
              title="No Scheduled Routines Configured"
              text="No automated routines are set up yet. Create one to schedule morning mentor briefings, evening debriefs, standups, or hourly system watchdogs in Berlin time."
              actionLabel="+ Create First Routine"
              onAction={() => setModalState({ open: true })}
            />
          )}

          {/* State 4: Populated */}
          {!listQ.isLoading &&
            !listQ.error &&
            schedules.map((s) => (
              <RoutineCard
                key={s.id}
                s={s}
                onNav={onNav}
                onEdit={() => setModalState({ open: true, schedule: s })}
                onTriggered={(run_id) =>
                  setTriggeredRun({ name: s.name, run_id })
                }
                onChange={() => qc.invalidateQueries({ queryKey: ["cron"] })}
              />
            ))}
        </div>
      </div>

      {/* Right Column: Informational Sidebar */}
      <SidePanel
        title="ROUTINE EXECUTION CONTRACT"
        lines={[
          "Timezone: Europe/Berlin (CEST/CET).",
          "Engine: In-process 15-second tick with SKIP LOCKED.",
          "",
          "Core Operating Routines:",
          "• mentor-morning: 07:00 daily check-in & calendar blocker.",
          "• mentor-evening: 21:30 daily debrief & tomorrow plan.",
          "• daily-standup: 09:00 weekday engineering priority sync.",
          "• forge-watchdog: Hourly health checks & queue alerts.",
          "",
          "Tip: Click [Run Now] to test any routine immediately without waiting for clock time.",
        ]}
      />

      {/* Create & Edit Modal */}
      {modalState.open && (
        <ScheduleModal
          schedule={modalState.schedule}
          onClose={() => setModalState({ open: false })}
          onSaved={() => {
            setModalState({ open: false });
            qc.invalidateQueries({ queryKey: ["cron"] });
          }}
        />
      )}
    </div>
  );
}

function RoutineCard({
  s,
  onEdit,
  onTriggered,
  onChange,
  onNav,
}: {
  s: CronSchedule;
  onEdit: () => void;
  onTriggered: (run_id: string) => void;
  onChange: () => void;
  onNav: NavigateTo;
}) {
  const [busy, setBusy] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  /* Bound to a local so the click handler closes over a `string` and not a
     nullable property — TypeScript drops a property narrowing inside a
     callback, and `!` would hide exactly the case worth checking. */
  const lastRunId = s.last_run_id;

  const toggle = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await updateSchedule(s.id, { enabled: !s.enabled });
      onChange();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRunNow = async () => {
    setTriggering(true);
    setActionErr(null);
    try {
      const res = await triggerScheduleRun(s.id);
      if (res.ok && res.run_id) {
        onTriggered(res.run_id);
        onChange();
      }
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete routine "${s.name}"? This schedule will stop executing permanently.`,
      )
    )
      return;
    setBusy(true);
    setActionErr(null);
    try {
      await deleteSchedule(s.id);
      onChange();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const model = (s.run_metadata?.model as string) ?? "default";
  const worker = s.worker_label ?? (s.run_metadata?.kind as string) ?? "default";
  const notify = (s.run_metadata?.notify as string) ?? "silent";

  return (
    <div style={CARD_STYLE}>
      {/* Header Row */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: tokens.textHi, fontWeight: 600 }}>
            {s.name}
          </span>
          <span style={{ fontSize: 12, color: tokens.textMuted }}>
            {humanizeCron(s.cron_expr)}
          </span>
          <code
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              background: tokens.bgGutter,
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {s.cron_expr}
          </code>
        </div>

        <div
          style={{
            fontSize: 10,
            color: s.enabled ? tokens.ok : tokens.textGhost,
            letterSpacing: "0.08em",
            fontWeight: 600,
          }}
          className="mono"
        >
          {s.enabled ? "● ACTIVE" : "○ PAUSED"}
        </div>
      </div>

      {/* Description */}
      {s.description && (
        <div style={{ fontSize: 12, color: tokens.textMuted, marginTop: 6 }}>
          {s.description}
        </div>
      )}

      {/* Metadata Badges */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginTop: 8,
          fontSize: 11,
        }}
      >
        <Badge label="Model" value={model} color={tokens.accent} />
        <Badge label="Worker" value={worker} color={tokens.info} />
        <Badge
          label="Notify"
          value={
            notify === "always"
              ? "Telegram (Always)"
              : notify === "on-error"
                ? "Telegram (Error only)"
                : "Silent"
          }
          color={notify === "always" ? tokens.ok : tokens.textMuted}
        />
        {s.title_template && (
          <Badge label="Title" value={s.title_template} color={tokens.textFaint} />
        )}
      </div>

      {/* Timing & Traceability Bar */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${tokens.borderSoft}`,
          fontSize: 11,
          color: tokens.textMuted2,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span>
          Next:{" "}
          <strong style={{ color: tokens.textHi }}>
            {formatInBerlin(s.next_run_at)}
          </strong>{" "}
          ({humanizeCountdown(s.next_run_at)})
        </span>
        <span>·</span>
        <span>{s.total_fires} total fires</span>
        <span>·</span>
        <span>Last: {formatInBerlin(s.last_run_at)}</span>
        {lastRunId && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={() => jumpToRun(lastRunId, onNav)}
              title={`Open run ${lastRunId} in chat`}
              style={{
                font: "inherit",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: tokens.accent,
                textDecoration: "underline",
                fontWeight: 500,
              }}
            >
              Last Run #{lastRunId.slice(0, 8)} &rarr;
            </button>
          </>
        )}
      </div>

      {/* Error Alert */}
      {s.last_error && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 10px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 4,
            fontSize: 11,
            color: tokens.bleed,
          }}
        >
          Last error: {s.last_error}
        </div>
      )}

      {actionErr && (
        <div style={{ marginTop: 6, fontSize: 11, color: tokens.bleed }}>
          Action failed: {actionErr}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          style={primaryActionBtn(triggering)}
          disabled={triggering || busy}
          onClick={handleRunNow}
          title="Trigger routine immediately in the background"
        >
          {triggering ? "triggering…" : "▶ run now"}
        </button>
        <button
          style={secondaryBtn}
          disabled={busy || triggering}
          onClick={onEdit}
        >
          edit routine
        </button>
        <button
          style={secondaryBtn}
          disabled={busy || triggering}
          onClick={toggle}
        >
          {s.enabled ? "pause" : "resume"}
        </button>
        <button
          style={{ ...secondaryBtn, color: tokens.bleed }}
          disabled={busy || triggering}
          onClick={remove}
        >
          delete
        </button>
      </div>
    </div>
  );
}

function Badge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: tokens.bgGutter,
        border: `1px solid ${tokens.borderSoft}`,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <span style={{ color: tokens.textFaint }}>{label}:</span>
      <span style={{ color, fontWeight: 500 }}>{value}</span>
    </span>
  );
}

/* ----------------------------------------------------------------------------
 * Schedule Create & Edit Modal
 * -------------------------------------------------------------------------- */

function ScheduleModal({
  schedule,
  onClose,
  onSaved,
}: {
  schedule?: CronSchedule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(schedule);

  const [name, setName] = useState(schedule?.name ?? "");
  const [description, setDescription] = useState(schedule?.description ?? "");
  const [cronExpr, setCronExpr] = useState(
    schedule?.cron_expr ?? "0 7 * * *",
  );
  const [promptTemplate, setPromptTemplate] = useState(
    schedule?.prompt_template ??
      "You are Konrad's mentor. Run morning check-in.",
  );
  const [titleTemplate, setTitleTemplate] = useState(
    schedule?.title_template ?? "",
  );
  const [workerLabel, setWorkerLabel] = useState(
    schedule?.worker_label ?? "mentor",
  );
  const [model, setModel] = useState(
    (schedule?.run_metadata?.model as string) ?? "claude-sonnet-5",
  );
  const [notify, setNotify] = useState(
    (schedule?.run_metadata?.notify as string) ?? "always",
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);

  const [previewFires, setPreviewFires] = useState<string[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleApplyPreset = (presetId: string) => {
    const p = SCHEDULE_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    if (!name || name.startsWith("mentor-") || name.startsWith("daily-")) {
      setName(p.name);
    }
    setDescription(p.desc);
    setCronExpr(p.expr);
    setPromptTemplate(p.template);
    setModel(p.model);
    setWorkerLabel(p.worker);
    setNotify(p.notify);
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreviewErr(null);
    try {
      const fires = await previewCron(cronExpr.trim(), 5);
      setPreviewFires(fires);
    } catch (e) {
      setPreviewErr((e as Error).message);
      setPreviewFires(null);
    } finally {
      setPreviewing(false);
    }
  };

  const mut = useMutation({
    mutationFn: async () => {
      const run_metadata: Record<string, unknown> = {
        model,
        notify,
        kind: workerLabel,
      };

      if (isEdit && schedule) {
        return updateSchedule(schedule.id, {
          name: name.trim(),
          description: description.trim() || null,
          cron_expr: cronExpr.trim(),
          prompt_template: promptTemplate.trim(),
          title_template: titleTemplate.trim() || null,
          worker_label: workerLabel.trim() || null,
          enabled,
          run_metadata,
        });
      } else {
        return createSchedule({
          name: name.trim(),
          description: description.trim() || null,
          cron_expr: cronExpr.trim(),
          prompt_template: promptTemplate.trim(),
          title_template: titleTemplate.trim() || null,
          worker_label: workerLabel.trim() || null,
          enabled,
          run_metadata,
        });
      }
    },
    onSuccess: () => {
      onSaved();
    },
    onError: (e: Error) => {
      setErr(e.message);
    },
  });

  return (
    <div style={modalOverlay}>
      <div style={modalBox}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            paddingBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: tokens.textHi }}>
              {isEdit
                ? `EDIT ROUTINE: ${schedule?.name}`
                : "NEW SCHEDULED ROUTINE"}
            </h3>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
              Time-based autonomous background trigger evaluated in Europe/Berlin
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {/* Preset Selector (Creation mode) */}
        {!isEdit && (
          <Field label="Schedule Presets" hint="Quickly populate standard operating routines">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleApplyPreset(p.id)}
                  style={{
                    background: tokens.bgGutter,
                    border: `1px solid ${tokens.borderSoft}`,
                    color: tokens.textBody,
                    padding: "4px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
        )}

        {/* Form Fields */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Routine Name (slug-friendly)" hint="e.g. mentor-morning, forge-watchdog">
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="mentor-evening"
            />
          </Field>

          <Field label="Cron Expression" hint="5-field expression (Europe/Berlin)">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="30 21 * * *"
              />
              <button
                type="button"
                style={{ ...secondaryBtn, whiteSpace: "nowrap" }}
                onClick={handlePreview}
                disabled={previewing || !cronExpr.trim()}
              >
                {previewing ? "…" : "preview"}
              </button>
            </div>
          </Field>
        </div>

        {/* Cron Live Preview */}
        {previewFires && (
          <div
            style={{
              padding: 10,
              background: tokens.bgGutter,
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            <div
              style={{
                color: tokens.accent,
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              Next 5 executions in Berlin Time:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: tokens.textMuted }}>
              {previewFires.map((f, i) => (
                <li key={i}>{formatInBerlin(f)}</li>
              ))}
            </ul>
          </div>
        )}
        {previewErr && (
          <div style={{ fontSize: 11, color: tokens.bleed }}>
            Cron error: {previewErr}
          </div>
        )}

        <Field label="Description" hint="Summary of what this routine accomplishes">
          <input
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Evening debrief: score commitments and prepare tomorrow plan."
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Model Selection">
            <select
              style={selectStyle}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Worker / Persona">
            <select
              style={selectStyle}
              value={workerLabel}
              onChange={(e) => setWorkerLabel(e.target.value)}
            >
              {WORKER_OPTIONS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Notification Policy">
            <select
              style={selectStyle}
              value={notify}
              onChange={(e) => setNotify(e.target.value)}
            >
              {NOTIFY_OPTIONS.map((n) => (
                <option key={n.value} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Title Template (optional)"
          hint="Run title format, e.g. mentor: evening debrief"
        >
          <input
            style={inputStyle}
            value={titleTemplate}
            onChange={(e) => setTitleTemplate(e.target.value)}
            placeholder="mentor: evening debrief"
          />
        </Field>

        <Field
          label="Prompt Template"
          hint="Instructions provided to the model when the routine fires."
        >
          <textarea
            style={{
              ...inputStyle,
              minHeight: 120,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: "1.4",
            }}
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
          />
        </Field>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            id="routine-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ accentColor: tokens.accent, width: 16, height: 16 }}
          />
          <label
            htmlFor="routine-enabled"
            style={{ fontSize: 12, color: tokens.textHi, cursor: "pointer" }}
          >
            Enable routine immediately upon saving
          </label>
        </div>

        {err && <div style={{ fontSize: 12, color: tokens.bleed }}>{err}</div>}

        {/* Modal Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            borderTop: `1px solid ${tokens.borderSoft}`,
            paddingTop: 12,
          }}
        >
          <button style={secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={primaryBtn(mut.isPending)}
            disabled={
              mut.isPending ||
              !name.trim() ||
              !cronExpr.trim() ||
              !promptTemplate.trim()
            }
            onClick={() => {
              setErr(null);
              mut.mutate();
            }}
          >
            {mut.isPending
              ? "Saving…"
              : isEdit
                ? "Save Changes"
                : "Create Routine"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Inbound Webhooks Panel
 * ========================================================================== */

function InboundWebhooksPanel({ onNav }: { onNav: NavigateTo }) {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ["webhooks"],
    queryFn: fetchWebhooks,
  });

  const [modalState, setModalState] = useState<{
    open: boolean;
    webhook?: Webhook;
  }>({ open: false });

  const [simulatorState, setSimulatorState] = useState<{
    open: boolean;
    webhook?: Webhook;
  }>({ open: false });

  // Requirement 5: Display and copy full raw secret returned on creation without rotation hack
  const [createdSecretBanner, setCreatedSecretBanner] = useState<{
    slug: string;
    name: string;
    secret: string;
  } | null>(null);

  const [copiedSecret, setCopiedSecret] = useState(false);

  const webhooks = listQ.data ?? [];

  const handleCopySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 16,
        gridTemplateColumns: "1fr 380px",
        alignItems: "start",
      }}
    >
      <div>
        <SectionHeader
          title="INBOUND WEBHOOKS"
          subtitle="External services POST JSON to /webhooks/in/<slug> with HMAC-SHA256 signature → spawns a run."
          right={
            <button
              style={createBtn}
              onClick={() => setModalState({ open: true })}
            >
              + new webhook
            </button>
          }
        />

        {/* Raw Secret Copy Banner (Shown once on creation) */}
        {createdSecretBanner && (
          <div
            style={{
              ...CARD_STYLE,
              marginBottom: 14,
              background: tokens.okActionBg,
              borderColor: tokens.okActionBorder,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: tokens.textHi,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                }}
              >
                ★ WEBHOOK CREATED: {createdSecretBanner.name} (/webhooks/in/
                {createdSecretBanner.slug})
              </div>
              <button
                onClick={() => setCreatedSecretBanner(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: tokens.textMuted,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                ✕ Dismiss
              </button>
            </div>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 8 }}>
              Copy your full raw secret now. For security, it will never be
              returned again by GET /api/webhooks:
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: tokens.bgGutter,
                padding: "8px 10px",
                borderRadius: 6,
                border: `1px solid ${tokens.borderSoft}`,
              }}
            >
              <code
                style={{
                  fontSize: 11,
                  color: tokens.textHi,
                  wordBreak: "break-all",
                  flex: 1,
                }}
              >
                {createdSecretBanner.secret}
              </code>
              <button
                style={{
                  ...secondaryBtn,
                  background: tokens.primaryActionBg,
                  color: tokens.textHi,
                }}
                onClick={() => handleCopySecret(createdSecretBanner.secret)}
              >
                {copiedSecret ? "✓ Copied!" : "Copy Secret"}
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 12,
          }}
        >
          {/* State 1: Loading */}
          {listQ.isLoading && (
            <>
              <SkeletonWebhookCard />
              <SkeletonWebhookCard />
            </>
          )}

          {/* State 2: Error */}
          {listQ.error && (
            <div
              style={{
                ...CARD_STYLE,
                borderColor: tokens.dangerActionBorder,
                background: tokens.dangerActionBg,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: tokens.bleed,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                Failed to load webhooks
              </div>
              <div style={{ fontSize: 12, color: tokens.textMuted }}>
                {(listQ.error as Error).message}
              </div>
              <button
                style={{ ...secondaryBtn, marginTop: 10 }}
                onClick={() => listQ.refetch()}
              >
                Retry
              </button>
            </div>
          )}

          {/* State 3: Empty */}
          {!listQ.isLoading && !listQ.error && webhooks.length === 0 && (
            <EmptyHint
              title="No Inbound Webhooks Registered"
              text="The webhook listener is active at /webhooks/in/<slug>. Create a webhook with a custom slug and prompt template to trigger autonomous agent runs from GitHub, Stripe, or external alert systems."
              actionLabel="+ Create First Webhook"
              onAction={() => setModalState({ open: true })}
            />
          )}

          {/* State 4: Populated */}
          {!listQ.isLoading &&
            !listQ.error &&
            webhooks.map((w) => (
              <WebhookCard
                key={w.id}
                w={w}
                onNav={onNav}
                onEdit={() => setModalState({ open: true, webhook: w })}
                onOpenSimulator={() =>
                  setSimulatorState({ open: true, webhook: w })
                }
                onChange={() => qc.invalidateQueries({ queryKey: ["webhooks"] })}
              />
            ))}
        </div>
      </div>

      {/* Right Column: Webhook Instructions */}
      <SidePanel
        title="HOW INBOUND WEBHOOKS WORK"
        lines={[
          "1. Register a webhook slug + prompt template with {{ body.field }} tags.",
          "2. Store the unmasked 32-byte secret in your external sending service.",
          "3. Sign the POST payload body with HMAC-SHA256.",
          "4. Include header:",
          "   X-Forge-Signature: sha256=<hex-digest>",
          "   (or GitHub standard X-Hub-Signature-256)",
          "5. The server validates the signature, renders the prompt, and queues a run.",
        ]}
      />

      {/* Webhook Create / Edit Modal */}
      {modalState.open && (
        <WebhookModal
          webhook={modalState.webhook}
          onClose={() => setModalState({ open: false })}
          onCreated={(res) => {
            setModalState({ open: false });
            qc.invalidateQueries({ queryKey: ["webhooks"] });
            const secret = res.raw_secret ?? res.secret_once;
            if (secret) {
              setCreatedSecretBanner({
                slug: res.slug,
                name: res.name,
                secret,
              });
            }
          }}
          onUpdated={() => {
            setModalState({ open: false });
            qc.invalidateQueries({ queryKey: ["webhooks"] });
          }}
        />
      )}

      {/* Webhook Payload Simulator Drawer */}
      {simulatorState.open && simulatorState.webhook && (
        <WebhookSimulatorModal
          webhook={simulatorState.webhook}
          onClose={() => setSimulatorState({ open: false })}
        />
      )}
    </div>
  );
}

function WebhookCard({
  w,
  onEdit,
  onOpenSimulator,
  onChange,
  onNav,
}: {
  w: Webhook;
  onEdit: () => void;
  onOpenSimulator: () => void;
  onChange: () => void;
  onNav: NavigateTo;
}) {
  const [busy, setBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  /* Same reason as RoutineCard's: a local binding, not a `!`. */
  const lastRunId = w.last_run_id;

  const fullPath = `/webhooks/in/${w.slug}`;

  const handleCopyUrl = async () => {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      await navigator.clipboard.writeText(`${origin}${fullPath}`);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // ignore
    }
  };

  const toggle = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      await updateWebhook(w.id, { enabled: !w.enabled });
      onChange();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (
      !confirm(
        `Rotate secret for "${w.name}"? External systems using the old secret will fail HMAC validation immediately.`,
      )
    )
      return;
    setBusy(true);
    setActionErr(null);
    try {
      const fresh = await rotateWebhookSecret(w.id);
      setRevealedSecret(fresh);
      onChange();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete webhook "${w.name}"? Calls to ${fullPath} will return 404.`,
      )
    )
      return;
    setBusy(true);
    setActionErr(null);
    try {
      await deleteWebhook(w.id);
      onChange();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={CARD_STYLE}>
      {/* Header Row */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: tokens.textHi, fontWeight: 600 }}>
            {w.name}
          </span>
          <code
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              background: tokens.bgGutter,
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            {fullPath}
          </code>
          <button
            onClick={handleCopyUrl}
            style={{
              background: "transparent",
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 4,
              color: tokens.textMuted,
              fontSize: 10,
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            {copiedUrl ? "✓ Copied" : "Copy URL"}
          </button>
        </div>

        <div
          style={{
            fontSize: 10,
            color: w.enabled ? tokens.ok : tokens.textGhost,
            letterSpacing: "0.08em",
            fontWeight: 600,
          }}
          className="mono"
        >
          {w.enabled ? "● ENABLED" : "○ DISABLED"}
        </div>
      </div>

      {/* Description */}
      {w.description && (
        <div style={{ fontSize: 12, color: tokens.textMuted, marginTop: 6 }}>
          {w.description}
        </div>
      )}

      {/* Stats and metadata bar */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${tokens.borderSoft}`,
          fontSize: 11,
          color: tokens.textMuted2,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span>{w.total_calls} calls</span>
        <span>·</span>
        <span>Last called: {formatInBerlin(w.last_called_at)}</span>
        <span>·</span>
        <span>Secret: {w.secret_preview}</span>
        {w.worker_label && (
          <>
            <span>·</span>
            <span>Worker: {w.worker_label}</span>
          </>
        )}
        {lastRunId && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={() => jumpToRun(lastRunId, onNav)}
              title={`Open run ${lastRunId} in chat`}
              style={{
                font: "inherit",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: tokens.accent,
                textDecoration: "underline",
                fontWeight: 500,
              }}
            >
              Last Run #{lastRunId.slice(0, 8)} &rarr;
            </button>
          </>
        )}
      </div>

      {/* Last error */}
      {w.last_error && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 10px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 4,
            fontSize: 11,
            color: tokens.bleed,
          }}
        >
          Last error: {w.last_error}
        </div>
      )}

      {/* Rotated Secret Banner */}
      {revealedSecret && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            border: `1px solid ${tokens.okActionBorder}`,
            background: tokens.okActionBg,
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: tokens.textLabel,
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            ROTATED SECRET (copy now — shown once):
          </div>
          <code
            style={{
              fontSize: 11,
              color: tokens.textHi,
              wordBreak: "break-all",
            }}
          >
            {revealedSecret}
          </code>
        </div>
      )}

      {actionErr && (
        <div style={{ marginTop: 6, fontSize: 11, color: tokens.bleed }}>
          Action failed: {actionErr}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={primaryActionBtn(false)} onClick={onOpenSimulator}>
          ⚡ test simulator
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onEdit}>
          edit webhook
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={rotate}>
          rotate secret
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={toggle}>
          {w.enabled ? "disable" : "enable"}
        </button>
        <button
          style={{ ...secondaryBtn, color: tokens.bleed }}
          disabled={busy}
          onClick={remove}
        >
          delete
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Webhook Create & Edit Modal
 * -------------------------------------------------------------------------- */

function WebhookModal({
  webhook,
  onClose,
  onCreated,
  onUpdated,
}: {
  webhook?: Webhook;
  onClose: () => void;
  onCreated: (res: CreateWebhookResult) => void;
  onUpdated: () => void;
}) {
  const isEdit = Boolean(webhook);

  const [slug, setSlug] = useState(webhook?.slug ?? "");
  const [name, setName] = useState(webhook?.name ?? "");
  const [description, setDescription] = useState(webhook?.description ?? "");
  const [workerLabel, setWorkerLabel] = useState(webhook?.worker_label ?? "");
  const [titleTemplate, setTitleTemplate] = useState(
    webhook?.title_template ?? "",
  );
  const [promptTemplate, setPromptTemplate] = useState(
    webhook?.prompt_template ??
      "Inbound webhook received for {{ body.event }}:\n{{ body }}",
  );
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      if (isEdit && webhook) {
        return updateWebhook(webhook.id, {
          name: name.trim(),
          description: description.trim() || null,
          prompt_template: promptTemplate.trim(),
          title_template: titleTemplate.trim() || null,
          worker_label: workerLabel.trim() || null,
          enabled,
        });
      } else {
        return createWebhook({
          slug: slug.trim().toLowerCase(),
          name: name.trim(),
          description: description.trim() || null,
          prompt_template: promptTemplate.trim(),
          title_template: titleTemplate.trim() || null,
          worker_label: workerLabel.trim() || null,
          enabled,
        });
      }
    },
    onSuccess: (res) => {
      if (isEdit) {
        onUpdated();
      } else {
        onCreated(res as CreateWebhookResult);
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  const slugValid = isEdit || SLUG_RE.test(slug.trim().toLowerCase());

  return (
    <div style={modalOverlay}>
      <div style={modalBox}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            paddingBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: tokens.textHi }}>
              {isEdit ? `EDIT WEBHOOK: ${webhook?.name}` : "NEW INBOUND WEBHOOK"}
            </h3>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
              Receive signed JSON payloads and trigger automated runs
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field
            label="Slug (URL Path Segment)"
            hint={
              isEdit
                ? "Slug cannot be changed after creation"
                : "Lowercase, digits, dashes (3–64 chars)"
            }
          >
            <input
              style={{
                ...inputStyle,
                fontFamily: "var(--font-mono)",
                opacity: isEdit ? 0.6 : 1,
              }}
              disabled={isEdit}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="github-push"
            />
            {!isEdit && slug && !SLUG_RE.test(slug.trim().toLowerCase()) && (
              <div style={errText}>Invalid slug format.</div>
            )}
          </Field>

          <Field label="Display Name">
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="GitHub Push Alert"
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Receives git push and dispatch events from repository webhooks."
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Worker Label (optional)" hint="e.g. builder, operator, watchdog">
            <input
              style={inputStyle}
              value={workerLabel}
              onChange={(e) => setWorkerLabel(e.target.value)}
              placeholder="builder"
            />
          </Field>

          <Field label="Title Template (optional)" hint="e.g. webhook: {{ body.action }}">
            <input
              style={inputStyle}
              value={titleTemplate}
              onChange={(e) => setTitleTemplate(e.target.value)}
              placeholder="webhook: {{ body.repository.name }}"
            />
          </Field>
        </div>

        <Field
          label="Prompt Template"
          hint="{{ body.field }} or {{ body }} slots are substituted from inbound JSON."
        >
          <textarea
            style={{
              ...inputStyle,
              minHeight: 120,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: "1.4",
            }}
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
          />
        </Field>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            id="webhook-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ accentColor: tokens.accent, width: 16, height: 16 }}
          />
          <label
            htmlFor="webhook-enabled"
            style={{ fontSize: 12, color: tokens.textHi, cursor: "pointer" }}
          >
            Enable webhook receiver immediately upon saving
          </label>
        </div>

        {err && <div style={{ fontSize: 12, color: tokens.bleed }}>{err}</div>}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            borderTop: `1px solid ${tokens.borderSoft}`,
            paddingTop: 12,
          }}
        >
          <button style={secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={primaryBtn(mut.isPending)}
            disabled={
              mut.isPending || !slugValid || !name.trim() || !promptTemplate.trim()
            }
            onClick={() => {
              setErr(null);
              mut.mutate();
            }}
          >
            {mut.isPending
              ? "Saving…"
              : isEdit
                ? "Save Changes"
                : "Create Webhook"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Webhook Simulator Drawer / Modal (Requirement 5)
 * -------------------------------------------------------------------------- */

function WebhookSimulatorModal({
  webhook,
  onClose,
}: {
  webhook: Webhook;
  onClose: () => void;
}) {
  const [samplePayload, setSamplePayload] = useState(
    JSON.stringify(
      {
        event: "push",
        repository: { name: "content-forge", branch: "main" },
        pusher: { name: "konrad" },
        message: "feat: add autonomous routine triggers",
      },
      null,
      2,
    ),
  );

  const preview = useMemo(() => {
    return renderTemplatePreview(webhook.prompt_template, samplePayload);
  }, [webhook.prompt_template, samplePayload]);

  const [copiedCurl, setCopiedCurl] = useState(false);

  const sampleCurl = `curl -X POST "http://127.0.0.1:7700/webhooks/in/${webhook.slug}" \\
  -H "Content-Type: application/json" \\
  -H "X-Forge-Signature: sha256=<compute-hmac-sha256-with-secret>" \\
  -d '${samplePayload.replace(/'/g, "'\\''")}'`;

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(sampleCurl);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalBox, maxWidth: 720 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            paddingBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: tokens.textHi }}>
              ⚡ TEST PAYLOAD SIMULATOR: {webhook.name}
            </h3>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
              Simulate template substitution for <code>/webhooks/in/{webhook.slug}</code>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textMuted,
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {/* Left: Input Payload */}
          <Field
            label="Inbound Test JSON Payload"
            hint="Paste sample JSON body to verify template variable replacement."
          >
            <textarea
              style={{
                ...inputStyle,
                minHeight: 180,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: "1.35",
              }}
              value={samplePayload}
              onChange={(e) => setSamplePayload(e.target.value)}
            />
            {preview.error && (
              <div style={{ fontSize: 11, color: tokens.bleed, marginTop: 4 }}>
                {preview.error}
              </div>
            )}
          </Field>

          {/* Right: Rendered Prompt Output */}
          <Field
            label="Rendered Agent Prompt Output"
            hint="This is the exact prompt passed to the agent run."
          >
            <div
              style={{
                background: tokens.bgGutter,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 6,
                padding: "8px 10px",
                minHeight: 180,
                maxHeight: 240,
                overflow: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: tokens.textHi,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {preview.rendered || (
                <span style={{ color: tokens.textGhost }}>Empty prompt template</span>
              )}
            </div>
          </Field>
        </div>

        {/* cURL Example */}
        <Field label="Terminal Dispatch Command (cURL)">
          <div
            style={{
              position: "relative",
              background: tokens.bgGutter,
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 6,
              padding: 10,
            }}
          >
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                color: tokens.textMuted,
                fontFamily: "var(--font-mono)",
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {sampleCurl}
            </pre>
            <button
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                ...secondaryBtn,
                background: tokens.bgCard,
              }}
              onClick={handleCopyCurl}
            >
              {copiedCurl ? "✓ Copied" : "Copy cURL"}
            </button>
          </div>
        </Field>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            borderTop: `1px solid ${tokens.borderSoft}`,
            paddingTop: 12,
          }}
        >
          <button style={secondaryBtn} onClick={onClose}>
            Close Simulator
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Skeletons & Shared UI Primitives
 * -------------------------------------------------------------------------- */

function SkeletonRoutineCard() {
  return (
    <div style={{ ...CARD_STYLE, opacity: 0.5 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
        <div
          style={{
            width: 140,
            height: 16,
            background: tokens.borderSoft,
            borderRadius: 4,
          }}
        />
        <div
          style={{
            width: 100,
            height: 16,
            background: tokens.borderSoft,
            borderRadius: 4,
          }}
        />
      </div>
      <div
        style={{
          width: "70%",
          height: 12,
          background: tokens.borderSoft,
          borderRadius: 4,
          marginBottom: 12,
        }}
      />
      <div
        style={{
          width: 80,
          height: 24,
          background: tokens.borderSoft,
          borderRadius: 4,
        }}
      />
    </div>
  );
}

function SkeletonWebhookCard() {
  return (
    <div style={{ ...CARD_STYLE, opacity: 0.5 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
        <div
          style={{
            width: 120,
            height: 16,
            background: tokens.borderSoft,
            borderRadius: 4,
          }}
        />
        <div
          style={{
            width: 160,
            height: 16,
            background: tokens.borderSoft,
            borderRadius: 4,
          }}
        />
      </div>
      <div
        style={{
          width: "60%",
          height: 12,
          background: tokens.borderSoft,
          borderRadius: 4,
        }}
      />
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 8,
      }}
    >
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 13, color: tokens.textBody, marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
      {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
    </div>
  );
}

function SidePanel({
  title,
  lines,
  mono,
}: {
  title: string;
  lines: string[];
  mono?: boolean;
}) {
  return (
    <div
      style={{
        ...CARD_STYLE,
        height: "fit-content",
        position: "sticky",
        top: 0,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.textFaint,
          letterSpacing: "0.1em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {lines.map((l, i) => (
        <div
          key={i}
          className={mono ? "mono" : undefined}
          style={{
            fontSize: mono ? 11 : 12,
            color: tokens.textMuted,
            marginBottom: 4,
            whiteSpace: "pre-wrap",
          }}
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.textFaint,
          letterSpacing: "0.1em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: 11, color: tokens.textMuted2, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function EmptyHint({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title?: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        ...CARD_STYLE,
        textAlign: "center",
        padding: "32px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      {title && (
        <div style={{ fontSize: 14, color: tokens.textHi, fontWeight: 600 }}>
          {title}
        </div>
      )}
      <div style={{ fontSize: 12, color: tokens.textMuted, maxWidth: 480 }}>
        {text}
      </div>
      {actionLabel && onAction && (
        <button
          style={{ ...createBtn, marginTop: 8 }}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Styles
 * -------------------------------------------------------------------------- */

const createBtn: React.CSSProperties = {
  background: tokens.primaryActionBg,
  border: `1px solid ${tokens.accent}`,
  color: tokens.textHi,
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: tokens.bgGutter,
  border: `1px solid ${tokens.border}`,
  color: tokens.textHi,
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  background: tokens.bgGutter,
  border: `1px solid ${tokens.border}`,
  color: tokens.textHi,
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box",
};

const primaryBtn = (busy: boolean): React.CSSProperties => ({
  background: busy ? tokens.borderSoft : tokens.primaryActionBg,
  border: `1px solid ${tokens.accent}`,
  color: tokens.textHi,
  padding: "8px 16px",
  borderRadius: 6,
  fontSize: 12,
  cursor: busy ? "wait" : "pointer",
  fontWeight: 500,
});

const primaryActionBtn = (busy: boolean): React.CSSProperties => ({
  background: busy ? tokens.borderSoft : tokens.primaryActionBg,
  border: `1px solid ${tokens.accent}`,
  color: tokens.textHi,
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 11,
  cursor: busy ? "wait" : "pointer",
  fontWeight: 500,
});

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${tokens.borderSoft}`,
  color: tokens.textBody,
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 11,
  cursor: "pointer",
};

const errText: React.CSSProperties = {
  fontSize: 11,
  color: tokens.bleed,
  marginTop: 4,
};

const modalOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: tokens.overlay,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const modalBox: React.CSSProperties = {
  background: tokens.bgCard,
  border: `1px solid ${tokens.borderEmphasis}`,
  borderRadius: 8,
  padding: 20,
  maxWidth: 640,
  width: "100%",
  maxHeight: "90vh",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxShadow: `0 8px 32px ${tokens.overlay}`,
};

