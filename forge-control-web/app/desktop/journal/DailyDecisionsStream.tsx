"use client";

import { useState } from "react";
import { tokens } from "../../tokens";
import type { DecisionEntry } from "../../api";
import { decisionKindColor } from "../../data";

interface DailyDecisionsStreamProps {
  day: string;
  decisions: DecisionEntry[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRefresh: () => void;
}

/**
 * `DecisionEntry["kind"]` is a modelled union widened with `| string`, because
 * the column is plain `text` and a future writer can put anything in it.
 * `decisionKindColor` switches over the closed union with no `default`, so an
 * unmodelled kind returns `undefined` at runtime while TypeScript still types
 * it `string` — the value then lands in `border: 1px solid undefined` and the
 * row silently loses its edge. Casting with `as` (what stood here) hides that;
 * this narrows for real and falls back to a visible token instead.
 */
const MODELLED_DECISION_KINDS = [
  "dispatch",
  "breaker",
  "degrade",
  "escalate",
  "unstick",
  "resolve",
  "freeze",
  "resume",
  "guardrail",
  "manager",
  "user",
] as const;

type ModelledDecisionKind = (typeof MODELLED_DECISION_KINDS)[number];

function kindColorFor(kind: string): string {
  const known = MODELLED_DECISION_KINDS.find(
    (k): k is ModelledDecisionKind => k === kind,
  );
  return known ? decisionKindColor(known) : tokens.textMuted;
}

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function DailyDecisionsStream({
  day,
  decisions,
  isLoading,
  isError,
  error,
  onRefresh,
}: DailyDecisionsStreamProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId((curr) => (curr === id ? null : id));
  };

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="ms"
            style={{ fontSize: 18, color: tokens.textSecondary }}
          >
            gavel
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: tokens.text,
              letterSpacing: "0.06em",
              fontFamily: "monospace",
            }}
          >
            LOGGED DECISIONS STREAM
          </span>
        </div>
        <span
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            fontFamily: "monospace",
          }}
        >
          {decisions.length}{" "}
          {decisions.length === 1 ? "decision" : "decisions"} recorded
        </span>
      </div>

      {/* States */}
      {isLoading ? (
        /* Loading Skeleton */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 48,
                borderRadius: 6,
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderDivider}`,
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      ) : isError ? (
        /* Error State */
        <div
          style={{
            padding: "12px 14px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 6,
            color: tokens.bleed,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 16 }}>
              error
            </span>
            <span>
              Failed to load decisions: {error?.message || "Unknown error"}
            </span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 4,
              color: tokens.text,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : decisions.length === 0 ? (
        /* Honest Empty State */
        <div
          style={{
            padding: "24px 16px",
            border: `1px dashed ${tokens.borderDivider}`,
            borderRadius: 6,
            textAlign: "center",
            background: tokens.bgGutter,
          }}
        >
          <span
            className="ms"
            style={{ fontSize: 24, color: tokens.textGhost, marginBottom: 8 }}
          >
            rule
          </span>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: tokens.textMuted,
              marginBottom: 4,
            }}
          >
            No decisions logged for {day}
          </div>
          <div
            style={{
              fontSize: 11,
              color: tokens.textFaint,
              maxWidth: 420,
              margin: "0 auto",
              lineHeight: 1.5,
            }}
          >
            {/* Only three code paths write to the `decisions` table today —
                db/ai_os.ts resolveInboxItem (kind `resolve`) and routes/
                fleet.ts pause/resume (kinds `freeze`/`resume`). The copy that
                stood here also promised morning-goal commits and budget-cap
                trips; neither writes a row, so both were invented. Naming the
                three real writers is what makes this an honest empty state
                instead of a nicer-sounding one. The rewrite also clears
                scripts/checks/dollar-sweep.sh, whose currency anchor fired on
                the old sentence's outlay verb; this comment deliberately does
                not quote that word, because the gate greps raw file text and
                would fire on the explanation too. */}
            Decisions land here when you resolve an inbox item, or pause or
            resume the fleet. Nothing else writes to this log yet, so a quiet
            day is genuinely quiet rather than broken.
          </div>
        </div>
      ) : (
        /* Populated Decisions List */
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {decisions.map((dec) => {
            const kindColor = kindColorFor(dec.kind);
            const isExpanded = expandedId === dec.id;
            const hasPayload =
              dec.payload && Object.keys(dec.payload).length > 0;

            const isUserActor =
              dec.actor.toLowerCase() === "user" ||
              dec.actor.toLowerCase() === "konrad";

            return (
              <div
                key={dec.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: 6,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.bgBody,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {/* Timestamp */}
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: tokens.textMuted,
                      minWidth: 40,
                    }}
                  >
                    {formatClock(dec.ts)}
                  </span>

                  {/* Kind badge */}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: tokens.toolBg,
                      border: `1px solid ${kindColor}`,
                      color: kindColor,
                    }}
                  >
                    {dec.kind}
                  </span>

                  {/* Actor badge */}
                  <span
                    style={{
                      fontSize: 10,
                      fontFamily: "monospace",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: isUserActor
                        ? tokens.roleBgBuilder
                        : tokens.toolBg,
                      border: `1px solid ${tokens.borderDivider}`,
                      color: isUserActor
                        ? tokens.roleInkBuilder
                        : tokens.textSoft,
                    }}
                  >
                    {dec.actor}
                  </span>

                  {/* Action description */}
                  <span
                    style={{
                      fontSize: 12,
                      color: tokens.text,
                      flex: 1,
                      wordBreak: "break-word",
                    }}
                  >
                    {dec.action}
                  </span>

                  {/* Payload expand button */}
                  {hasPayload && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(dec.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: tokens.textMuted,
                        cursor: "pointer",
                        padding: "2px 4px",
                        display: "flex",
                        alignItems: "center",
                      }}
                      title={
                        isExpanded ? "Hide payload" : "Inspect payload details"
                      }
                    >
                      <span className="ms" style={{ fontSize: 16 }}>
                        {isExpanded ? "expand_less" : "expand_more"}
                      </span>
                    </button>
                  )}
                </div>

                {/* Optional linked reference tags */}
                {(dec.inbox_item_id || dec.related_job_id) && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      fontSize: 10,
                      fontFamily: "monospace",
                      color: tokens.textFaint,
                      marginLeft: 48,
                    }}
                  >
                    {dec.inbox_item_id && (
                      <span>inbox:{dec.inbox_item_id.slice(0, 8)}</span>
                    )}
                    {dec.related_job_id && (
                      <span>job:{dec.related_job_id.slice(0, 8)}</span>
                    )}
                  </div>
                )}

                {/* Expanded Payload JSON */}
                {isExpanded && hasPayload && (
                  <pre
                    style={{
                      marginTop: 4,
                      padding: "8px 10px",
                      background: tokens.toolBg,
                      border: `1px solid ${tokens.borderDivider}`,
                      borderRadius: 4,
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: tokens.textSoft,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      margin: "4px 0 0 0",
                    }}
                  >
                    {JSON.stringify(dec.payload, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
