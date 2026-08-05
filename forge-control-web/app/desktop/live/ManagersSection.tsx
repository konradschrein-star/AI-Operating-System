"use client";

import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchManagers, type Manager } from "./agentsApi";

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 10 ? k.toFixed(1) : k < 100 ? k.toFixed(1) : k.toFixed(0)}k`;
  }
  const M = n / 1_000_000;
  return `${M < 10 ? M.toFixed(2) : M.toFixed(1)}M`;
}

const MANAGER_STATUS_COLOR: Record<string, string> = {
  active: tokens.ok,
  blocked: tokens.warn,
};

function managerStatusColor(s: string): string {
  return MANAGER_STATUS_COLOR[s] ?? tokens.textFaint;
}

export function ManagersSection({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (projectId: string) => void;
}) {
  const q = useQuery({
    queryKey: ["projects", "managers"],
    queryFn: fetchManagers,
    refetchInterval: 8_000,
  });

  const managers: Manager[] = q.data?.managers ?? [];

  return (
    <div
      style={{
        flex: "none",
        borderBottom: `1px solid ${tokens.borderSoft}`,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: tokens.textGhost,
          letterSpacing: "0.1em",
          padding: "8px 14px 4px",
        }}
      >
        MANAGERS
      </div>

      {q.isError && (
        <div
          className="mono"
          style={{
            padding: "6px 14px 10px",
            fontSize: 10.5,
            color: tokens.bleed,
          }}
        >
          managers unavailable: {(q.error as Error).message}
        </div>
      )}

      {!q.isError && !q.isLoading && managers.length === 0 && (
        <div
          className="mono"
          style={{
            padding: "6px 14px 10px",
            fontSize: 10.5,
            color: tokens.textFaint,
          }}
        >
          no active projects
        </div>
      )}

      {managers.map((m: Manager) => {
        const sel = m.project_id === selectedId;
        const sColor = managerStatusColor(m.status);
        const totalTokens = (m.tokens_in ?? 0) + (m.tokens_out ?? 0);
        return (
          <div
            key={m.project_id}
            onClick={() => onSelect(m.project_id)}
            style={{
              padding: "7px 14px",
              cursor: "pointer",
              borderLeft: `2px solid ${sel ? sColor : "transparent"}`,
              background: sel ? tokens.selectedBg : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  color: sel ? tokens.textHi : tokens.textLabel,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={m.name}
              >
                {m.name}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  color: sColor,
                  border: `1px solid ${sColor}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                  flex: "none",
                  letterSpacing: "0.05em",
                }}
              >
                {m.status}
              </span>
            </div>
            <div
              className="mono"
              style={{
                display: "flex",
                gap: 8,
                marginTop: 3,
                fontSize: 9.5,
                color: tokens.textFaint,
              }}
            >
              <span>
                {m.tasks_done}/{m.tasks_total} tasks
              </span>
              <span style={{ color: tokens.textGhost }}>·</span>
              {m.spent_usd > 0 ? (
                <span>${m.spent_usd.toFixed(2)}</span>
              ) : (
                <span>↓ {fmtTokens(totalTokens)}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
