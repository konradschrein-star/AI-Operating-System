"use client";

import { tokens, dot } from "../tokens";
import { statusColor, type FleetWorker, type NeedsItem } from "../data";
import type { TodayResponse } from "../api";
import type { Surface } from "./nav-items";

export function TodaySurface({
  data,
  inboxCount,
  onNav,
  onClearNeeds,
  clearingNeeds,
}: {
  data: TodayResponse;
  inboxCount: number;
  onNav: (s: Surface) => void;
  onClearNeeds: () => void;
  clearingNeeds: boolean;
}) {
  return (
    <div
      className="slidein"
      style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 40px 64px" }}
    >
      <div
        style={{
          fontSize: 26,
          lineHeight: 1.4,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          marginBottom: 32,
          color: tokens.textHi,
        }}
      >
        {data.greeting}
      </div>

      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.textFaint,
          letterSpacing: "0.12em",
          marginBottom: 12,
        }}
      >
        OPEN INBOX
      </div>
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 36,
        }}
      >
        {inboxCount === 0 ? (
          <span
            className="mono"
            style={{ fontSize: 12, color: tokens.textFaint }}
          >
            inbox zero — manager is handling everything else.
          </span>
        ) : (
          <span
            onClick={() => onNav("inbox")}
            className="mono"
            style={{ fontSize: 13, color: tokens.accent, cursor: "pointer" }}
          >
            {inboxCount} open · open inbox →
          </span>
        )}
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 28 }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 12,
            }}
          >
            FLEET
          </div>
          {data.fleet.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 20,
                fontSize: 12,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              no workers reporting in.
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
              {data.fleet.map((w: FleetWorker, i: number) => {
                const color = statusColor(w.status);
                const animate = w.status !== "idle";
                const isLast = i === data.fleet.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "11px 15px",
                      borderBottom: isLast
                        ? "none"
                        : `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    <span style={dot(color, animate)} />
                    <span
                      className="mono"
                      style={{ fontSize: 12, color: tokens.textLabel }}
                    >
                      {w.name}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10.5, color }}>
                      {w.state}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.textFaint,
                letterSpacing: "0.12em",
              }}
            >
              NEEDS YOU
            </div>
            <span style={{ flex: 1 }} />
            {inboxCount > 0 && (
              <div
                onClick={() => !clearingNeeds && onClearNeeds()}
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: clearingNeeds ? tokens.textFaint : tokens.textMuted,
                  cursor: clearingNeeds ? "default" : "pointer",
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 5,
                  padding: "3px 8px",
                }}
              >
                {clearingNeeds ? "clearing…" : "clear all"}
              </div>
            )}
          </div>
          {data.needs.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 20,
                fontSize: 12,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              nothing waiting on you.
            </div>
          ) : (
            data.needs.map((n: NeedsItem, i: number) => {
              const color = statusColor(n.status);
              return (
                <div
                  key={i}
                  onClick={() => onNav("inbox")}
                  style={{
                    background: tokens.bgCard,
                    border: `1px solid ${tokens.border}`,
                    borderLeft: `2px solid ${color}`,
                    borderRadius: 12,
                    padding: "13px 15px",
                    marginBottom: 9,
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color, letterSpacing: "0.06em" }}
                    >
                      {n.type}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: tokens.textFaint }}
                    >
                      {n.age}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: tokens.textSoft,
                      lineHeight: 1.4,
                      marginTop: 7,
                    }}
                  >
                    {n.title}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
