"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { tokens } from "../../tokens";
import {
  fetchSchedules,
  updateSchedule,
  type CronSchedule,
} from "../../api";

const MENTOR_EVENING_ID = "90577448-93f4-41dd-a991-14885c74644c";

function formatNextFire(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function parseScheduleTime(cronExpr: string): string {
  // e.g. "30 21 * * *" -> "21:30"
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length >= 2) {
    const min = parts[0].padStart(2, "0");
    const hour = parts[1].padStart(2, "0");
    if (!Number.isNaN(Number(min)) && !Number.isNaN(Number(hour))) {
      return `${hour}:${min} CEST`;
    }
  }
  return cronExpr;
}

export interface MentorCronSwitchProps {
  scheduleId?: string;
  onScheduleToggled?: (enabled: boolean) => void;
}

export function MentorCronSwitch({
  scheduleId = MENTOR_EVENING_ID,
  onScheduleToggled,
}: MentorCronSwitchProps) {
  const queryClient = useQueryClient();
  const [optimisticError, setOptimisticError] = useState<string | null>(null);

  const {
    data: schedules,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<CronSchedule[], Error>({
    queryKey: ["cron-schedules"],
    queryFn: fetchSchedules,
    staleTime: 10_000,
  });

  const schedule = schedules?.find(
    (s) => s.id === scheduleId || s.name === "mentor-evening",
  );

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      setOptimisticError(null);
      return updateSchedule(id, { enabled });
    },
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["cron-schedules"] });
      const previousSchedules = queryClient.getQueryData<CronSchedule[]>([
        "cron-schedules",
      ]);

      if (previousSchedules) {
        queryClient.setQueryData<CronSchedule[]>(
          ["cron-schedules"],
          previousSchedules.map((s) => (s.id === id ? { ...s, enabled } : s)),
        );
      }

      return { previousSchedules };
    },
    onError: (err, _vars, context) => {
      if (context?.previousSchedules) {
        queryClient.setQueryData(
          ["cron-schedules"],
          context.previousSchedules,
        );
      }
      setOptimisticError(err instanceof Error ? err.message : String(err));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["cron-schedules"] });
    },
    onSuccess: (updated) => {
      onScheduleToggled?.(updated.enabled);
    },
  });

  // State 1: Loading
  if (isLoading) {
    return (
      <div
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px",
          borderRadius: 16,
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderDivider}`,
          fontSize: 11,
          color: tokens.textMuted,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: tokens.textGhost,
            animation: "pulse 1.5s infinite ease-in-out",
          }}
        />
        <span>Checking cron…</span>
      </div>
    );
  }

  // State 2: Query Error
  if (isError) {
    return (
      <div
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px",
          borderRadius: 16,
          background: tokens.dangerActionBg,
          border: `1px solid ${tokens.dangerActionBorder}`,
          fontSize: 11,
          color: tokens.bleed,
        }}
      >
        <span>Cron error</span>
        <button
          type="button"
          onClick={() => refetch()}
          style={{
            background: "none",
            border: "none",
            color: tokens.bleed,
            textDecoration: "underline",
            cursor: "pointer",
            padding: 0,
            fontSize: 10,
          }}
        >
          retry
        </button>
      </div>
    );
  }

  // State 3: Empty / Not Found
  if (!schedule) {
    return (
      <div
        className="mono"
        title={`Looked for schedule id ${scheduleId} or name mentor-evening`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px",
          borderRadius: 16,
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderDivider}`,
          fontSize: 11,
          color: tokens.textMuted,
        }}
      >
        <span style={{ color: tokens.warn }}>○</span>
        <span>mentor-evening cron missing</span>
      </div>
    );
  }

  // State 4: Populated
  const isEnabled = schedule.enabled;
  const isPending = toggleMutation.isPending;
  const timeLabel = parseScheduleTime(schedule.cron_expr);
  const nextFireFormatted = formatNextFire(schedule.next_run_at);

  const handleToggle = () => {
    if (isPending) return;
    toggleMutation.mutate({
      id: schedule.id,
      enabled: !isEnabled,
    });
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 16,
          background: isEnabled ? tokens.okActionBg : tokens.bgCard,
          border: `1px solid ${isEnabled ? tokens.okActionBorder : tokens.borderDivider}`,
          fontSize: 11,
          color: isEnabled ? tokens.ok : tokens.textMuted,
          transition: "all 0.15s ease",
        }}
      >
        <span
          style={{
            color: isEnabled ? tokens.ok : tokens.textGhost,
            fontWeight: 700,
            fontSize: 10,
          }}
        >
          {isEnabled ? "●" : "○"}
        </span>
        <span style={{ fontWeight: 600 }}>
          {isEnabled ? `Debrief Armed (${timeLabel})` : "Debrief Disarmed"}
        </span>
        {isEnabled && nextFireFormatted && (
          <span
            style={{
              fontSize: 10,
              color: tokens.textSecondary,
              marginLeft: 2,
            }}
            title={`Next run: ${schedule.next_run_at}`}
          >
            · next {nextFireFormatted}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        title={
          isEnabled
            ? `Click to disable ${schedule.name} cron schedule`
            : `Click to arm ${schedule.name} cron schedule`
        }
        aria-label={isEnabled ? "Disable mentor cron" : "Enable mentor cron"}
        style={{
          position: "relative",
          width: 34,
          height: 18,
          borderRadius: 10,
          background: isEnabled ? tokens.accent : tokens.borderEmphasis,
          border: "none",
          padding: 0,
          cursor: isPending ? "not-allowed" : "pointer",
          opacity: isPending ? 0.6 : 1,
          transition: "background 0.2s ease, opacity 0.2s ease",
          outline: "none",
          display: "flex",
          alignItems: "center",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: isEnabled ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: tokens.bgBody,
            transition: "left 0.2s ease",
            // A hairline ring, not a drop shadow. The literal that stood here
            // ("0 1px 3px rgba(0,0,0,0.2)") failed no-raw-colours.cjs, and it
            // was also inert where it was needed most: in dark mode the knob
            // is #000 on a #222226 track when the cron is disarmed, and a
            // black shadow adds nothing to a black knob. textGhost resolves
            // to #48484e dark / #a6a6ae light, so the ring separates the knob
            // from BOTH track colours (accent when armed, borderEmphasis when
            // disarmed) in BOTH palettes.
            boxShadow: `0 0 0 1px ${tokens.textGhost}`,
          }}
        />
      </button>

      {optimisticError && (
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.bleed,
          }}
          title={optimisticError}
        >
          Toggle failed: {optimisticError}
        </span>
      )}
    </div>
  );
}
