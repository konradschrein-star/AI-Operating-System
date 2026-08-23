"use client";

import { tokens, dot } from "../tokens";
import { tierColor, providerColor, liveStatColor } from "../data";
import type { LiveResponse } from "../api";
import { AgentActivity } from "./live/AgentActivity";

export function LiveSurface({ data }: { data: LiveResponse }) {
  return (
    <div className="slidein" style={{ padding: "16px 20px 36px" }}>
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: tokens.textHi,
          marginBottom: 12,
        }}
      >
        Live · The Machine
      </div>

      {/* AgentActivity is the answer to "what are my agents doing right now?".
          It lived buried in the chat side panel; here it's promoted to the
          top of the surface labelled LIVE, which for months showed only the
          Hermes worker ledger. The Hermes/provider strip below stays — it's
          the machine-level pulse this surface was originally designed for. */}
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          marginBottom: 16,
          maxHeight: 380,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <AgentActivity />
      </div>

      <div style={{ display: "flex", gap: 9, marginBottom: 15 }}>
        {data.stats.map((s, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "11px 13px",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
              }}
            >
              {s.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 19,
                fontWeight: 500,
                color: liveStatColor(s.tone),
                marginTop: 7,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 9,
            }}
          >
            DEGRADATION · per service
          </div>
          {data.degradation.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 20,
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              no service degradation reported.
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
              {data.degradation.map((d, i) => {
                const color = tierColor(d.tier);
                const isLast = i === data.degradation.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 15px",
                      borderBottom: isLast
                        ? "none"
                        : `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        className="mono"
                        style={{ fontSize: 11.5, color: tokens.textLabel }}
                      >
                        {d.svc}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 9.5,
                          color: tokens.textFaint,
                          marginTop: 2,
                        }}
                      >
                        {d.why}
                      </div>
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color,
                        border: `1px solid ${tokens.border}`,
                        borderRadius: 5,
                        padding: "3px 8px",
                      }}
                    >
                      {d.tier}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 9,
            }}
          >
            PROVIDER PULSE
          </div>
          {data.providers.length === 0 ? (
            <div
              className="mono"
              style={{
                background: tokens.bgCard,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 8,
                padding: 20,
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              no providers configured.
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
              {data.providers.map((p, i) => {
                const color = providerColor(p.status);
                const isLast = i === data.providers.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 15px",
                      borderBottom: isLast
                        ? "none"
                        : `1px solid ${tokens.borderDivider}`,
                    }}
                  >
                    <span style={dot(color, p.status !== "ok")} />
                    <span
                      className="mono"
                      style={{ fontSize: 11.5, color: tokens.textLabel }}
                    >
                      {p.name}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10, color }}>
                      {p.badge}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
