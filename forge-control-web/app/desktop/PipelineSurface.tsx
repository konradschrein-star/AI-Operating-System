"use client";

import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchPipeline, type PipelinePhase, type PipelineCard } from "../api";

const PHASE_COLOR: Record<string, string> = {
  idea: tokens.info,
  script: tokens.accent,
  voice: tokens.decide,
  assets: tokens.warn,
  qc: tokens.stuck,
  render: tokens.accent,
  publish: tokens.ok,
  other: tokens.textMuted,
};

export function PipelineSurface() {
  const q = useQuery({
    queryKey: ["pipeline"],
    queryFn: fetchPipeline,
    refetchInterval: 10_000,
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "12px 22px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Pipeline
        </span>
        <span
          className="mono"
          style={{ fontSize: 11, color: tokens.textFaint }}
        >
          ~40 statuses → 7 phases · {q.data?.total ?? 0} active jobs
        </span>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 14,
          display: "flex",
          gap: 12,
          alignItems: "stretch",
        }}
      >
        {q.isLoading && (
          <div
            className="mono"
            style={{ fontSize: 11, color: tokens.textFaint, padding: 16 }}
          >
            loading pipeline…
          </div>
        )}
        {q.data?.phases.map((p) => (
          <PhaseColumn key={p.key} phase={p} />
        ))}
      </div>
    </div>
  );
}

function PhaseColumn({ phase }: { phase: PipelinePhase }) {
  const color = PHASE_COLOR[phase.key] ?? tokens.textMuted;
  return (
    <div
      style={{
        width: 260,
        flex: "none",
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: "100%",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 4,
              height: 14,
              background: color,
              borderRadius: 2,
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.textHi }}>
            {phase.label}
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "1px 6px",
            }}
          >
            {phase.count}
          </span>
        </div>
        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {phase.description}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {phase.cards.length === 0 ? (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textFaint,
              textAlign: "center",
              padding: 16,
            }}
          >
            empty
          </div>
        ) : (
          phase.cards.map((c) => <JobCard key={c.id} card={c} color={color} />)
        )}
      </div>
    </div>
  );
}

function JobCard({ card, color }: { card: PipelineCard; color: string }) {
  return (
    <div
      style={{
        background: tokens.bgBody,
        border: `1px solid ${tokens.border}`,
        borderRadius: 7,
        padding: "9px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          className="mono"
          style={{
            fontSize: 9,
            color,
            letterSpacing: "0.06em",
          }}
        >
          {card.status}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textFaint }}
        >
          {card.age}
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          color: tokens.textSoft,
          lineHeight: 1.4,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {card.title}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: tokens.textMuted,
          display: "flex",
          gap: 8,
        }}
      >
        <span>{card.format}</span>
        <span style={{ color: tokens.textFaint }}>·</span>
        <span>{card.channel}</span>
      </div>
    </div>
  );
}
