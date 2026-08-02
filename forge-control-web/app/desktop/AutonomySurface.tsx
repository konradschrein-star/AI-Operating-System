"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchAutonomy,
  updateRule,
  freezeFleet,
  resumeFleet,
  type GuardrailRule,
  type GuardrailTrip,
} from "../api";

const CATEGORY_COLOR: Record<string, string> = {
  financial: tokens.warn,
  destructive: tokens.bleed,
  communication: tokens.info,
  security: tokens.decide,
  deployment: tokens.accent,
  custom: tokens.textMuted,
};

function humanAge(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AutonomySurface() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["autonomy"],
    queryFn: fetchAutonomy,
    refetchInterval: 8000,
  });
  const [cat, setCat] = useState<string | null>(null);

  const ruleM = useMutation({
    mutationFn: (input: {
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }) => updateRule(input.id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy"] }),
  });
  const freezeM = useMutation({
    mutationFn: () =>
      q.data?.fleet.status === "paused"
        ? resumeFleet("user")
        : freezeFleet("user"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy"] }),
  });

  const filtered = useMemo<GuardrailRule[]>(() => {
    const all = q.data?.rules ?? [];
    return cat ? all.filter((r) => r.category === cat) : all;
  }, [q.data, cat]);

  const paused = q.data?.fleet.status === "paused";

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Category rail */}
      <div
        style={{
          width: 200,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "12px 0",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            padding: "0 16px 8px",
          }}
        >
          GUARDRAILS
        </div>
        <CatItem
          label="ALL"
          count={q.data?.rules.length ?? 0}
          active={!cat}
          onClick={() => setCat(null)}
        />
        {q.data?.categories.map((c) => (
          <CatItem
            key={c.key}
            label={c.label}
            count={c.count}
            active={cat === c.key}
            onClick={() => setCat(c.key)}
            color={CATEGORY_COLOR[c.key]}
          />
        ))}
      </div>

      {/* Rules list */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "16px 20px 32px",
        }}
      >
        {/* Fleet pause hero */}
        <div
          onClick={() => freezeM.mutate()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            border: `1.5px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
            background: paused ? tokens.freezeBgWarn : tokens.freezeBgOk,
            borderRadius: 12,
            padding: "14px 18px",
            marginBottom: 22,
            cursor: "pointer",
          }}
        >
          <span
            className="ms"
            style={{ fontSize: 26, color: paused ? tokens.warn : tokens.ok }}
          >
            {paused ? "ac_unit" : "bolt"}
          </span>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: paused ? tokens.warn : tokens.ok,
              }}
            >
              {paused ? "Fleet is FROZEN" : "Fleet is running"}
            </div>
            <div
              style={{
                fontSize: 12,
                color: tokens.textSecondary,
                marginTop: 2,
              }}
            >
              {paused
                ? "No new dispatch until you resume."
                : "Dispatching within current policies."}
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 7,
              padding: "7px 14px",
              color: paused ? tokens.freezeBgOk : tokens.freezeBgWarn,
              background: paused ? tokens.ok : tokens.warn,
            }}
          >
            {paused ? "Resume" : "FREEZE"}
          </div>
        </div>

        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          POLICIES — {filtered.length} {cat ?? "all"}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginBottom: 26,
          }}
        >
          {filtered.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onToggle={() =>
                ruleM.mutate({ id: rule.id, enabled: !rule.enabled })
              }
            />
          ))}
        </div>

        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          RECENT TRIPS
        </div>
        {(q.data?.trips.length ?? 0) === 0 ? (
          <div
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 8,
              padding: 18,
              fontSize: 11,
              color: tokens.textFaint,
              textAlign: "center",
            }}
          >
            no trips logged — nothing has hit the guardrails yet.
          </div>
        ) : (
          <div
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {q.data?.trips.map((t, i, arr) => (
              <TripRow key={t.id} trip={t} isLast={i === arr.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  onToggle,
}: {
  rule: GuardrailRule;
  onToggle: () => void;
}) {
  const color = CATEGORY_COLOR[rule.category] ?? tokens.textMuted;
  const cfgKeys = Object.keys(rule.config ?? {});
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${rule.enabled ? tokens.border : tokens.borderDivider}`,
        borderLeft: `3px solid ${rule.enabled ? color : tokens.borderDivider}`,
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        opacity: rule.enabled ? 1 : 0.6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {rule.category}
          </span>
          <span
            className="mono"
            style={{ fontSize: 10, color: tokens.textFaint }}
          >
            · {rule.id}
          </span>
          {rule.builtin && (
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.textFaint,
                border: `1px solid ${tokens.borderDivider}`,
                borderRadius: 4,
                padding: "0 5px",
              }}
            >
              builtin
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 13,
            color: tokens.textHi,
            marginTop: 4,
            fontWeight: 500,
          }}
        >
          {rule.label}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: tokens.textSecondary,
            marginTop: 3,
            lineHeight: 1.5,
          }}
        >
          {rule.description}
        </div>
        {cfgKeys.length > 0 && (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textMuted,
              marginTop: 6,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {cfgKeys.map((k) => (
              <span key={k}>
                <span style={{ color: tokens.textFaint }}>{k}=</span>
                {JSON.stringify(rule.config[k])}
              </span>
            ))}
          </div>
        )}
      </div>
      <Toggle on={rule.enabled} onClick={onToggle} color={color} />
    </div>
  );
}

function TripRow({ trip, isLast }: { trip: GuardrailTrip; isLast: boolean }) {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: isLast ? "none" : `1px solid ${tokens.borderDivider}`,
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={dot(trip.resolved ? tokens.ok : tokens.bleed)} />
        <span className="mono" style={{ fontSize: 10, color: tokens.textHi }}>
          {trip.rule_label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textFaint }}
        >
          {humanAge(trip.ts)} · {trip.agent}
        </span>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: tokens.textSecondary,
          lineHeight: 1.5,
          marginLeft: 14,
        }}
      >
        {trip.attempted_action}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  color,
}: {
  on: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 38,
        height: 21,
        background: on ? color : tokens.border,
        borderRadius: 11,
        position: "relative",
        cursor: "pointer",
        transition: "background 0.15s",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 19 : 2,
          width: 17,
          height: 17,
          borderRadius: "50%",
          background: tokens.text,
          transition: "left 0.15s",
        }}
      />
    </div>
  );
}

function CatItem({
  label,
  count,
  active,
  onClick,
  color,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        padding: "7px 16px",
        cursor: "pointer",
        borderLeft: `2px solid ${active ? (color ?? tokens.accent) : "transparent"}`,
        background: active ? tokens.selectedBg : "transparent",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: active ? tokens.text : tokens.textMuted,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
        {count}
      </span>
    </div>
  );
}
