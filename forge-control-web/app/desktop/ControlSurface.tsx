"use client";

import { tokens, dot } from "../tokens";
import { loopColor, decisionKindColor } from "../data";
import type { ControlResponse } from "../api";

/* ----------------------------------------------------------------------------
 * Control plane (HACP)
 * -------------------------------------------------------------------------- */
export function ControlSurface({
  data,
  onFreeze,
}: {
  data: ControlResponse;
  onFreeze: () => void;
}) {
  const paused = data.fleet.status === "paused";
  return (
    <div
      className="slidein"
      style={{ display: "flex", height: "100%", minHeight: 0 }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "18px 22px 48px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
            Control Plane
          </span>
          <span
            className="mono"
            style={{ fontSize: 10, color: tokens.textFaint }}
          >
            HACP · nested multi-speed feedback loops
          </span>
        </div>
        <div
          className="mono"
          style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 20 }}
        >
          control-theory governor. fast loops protect; slow loops adapt. nothing
          acts outside the invariant engine.
        </div>

        <div
          onClick={onFreeze}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            border: `1.5px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
            background: paused ? tokens.freezeBgWarn : tokens.freezeBgOk,
            borderRadius: 12,
            padding: "16px 20px",
            maxWidth: 780,
            marginBottom: 24,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <span
            className="ms"
            style={{ fontSize: 28, color: paused ? tokens.warn : tokens.ok }}
          >
            {paused ? "ac_unit" : "bolt"}
          </span>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 15,
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
                marginTop: 3,
              }}
            >
              {paused
                ? "Every worker is held. No new dispatch until you resume."
                : "Dispatching autonomously within your trust levels and policies."}
            </div>
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 8,
              padding: "8px 18px",
              color: paused ? tokens.freezeBgOk : tokens.freezeBgWarn,
              background: paused ? tokens.ok : tokens.warn,
            }}
          >
            {paused ? "Resume fleet" : "FREEZE ALL"}
          </div>
        </div>

        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 10,
          }}
        >
          FEEDBACK LOOPS — fastest → slowest
        </div>
        {data.loops.length === 0 ? (
          <div
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 9,
              padding: 20,
              fontSize: 11,
              color: tokens.textFaint,
              textAlign: "center",
              maxWidth: 780,
              marginBottom: 26,
            }}
          >
            no loops fired yet.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginBottom: 26,
              maxWidth: 780,
            }}
          >
            {data.loops.map((l, i) => {
              const color = loopColor(l.tone);
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 12,
                    background: tokens.bgCard,
                    border: `1px solid ${tokens.border}`,
                    borderRadius: 9,
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{ width: 4, background: color, borderRadius: 2 }}
                  />
                  <div style={{ width: 118, flex: "none" }}>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 7 }}
                    >
                      <span className="mono" style={{ fontSize: 13, color }}>
                        {l.id}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: tokens.textMuted }}
                      >
                        {l.cadence}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: tokens.textLabel,
                        marginTop: 3,
                      }}
                    >
                      {l.name}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }} />
                  <div style={{ width: 96, flex: "none", textAlign: "right" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        justifyContent: "flex-end",
                      }}
                    >
                      <span
                        style={dot(
                          color,
                          l.tone === "error" || l.tone === "warn",
                        )}
                      />
                      <span
                        className="mono"
                        style={{ fontSize: 10, color: tokens.textLabel }}
                      >
                        {l.last}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          width: 340,
          flex: "none",
          borderLeft: `1px solid ${tokens.borderSoft}`,
          overflowY: "auto",
          padding: "18px 18px 48px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginBottom: 10,
          }}
        >
          <span className="ms" style={{ fontSize: 15, color: tokens.bleed }}>
            lock
          </span>
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
            }}
          >
            INVARIANT ENGINE
          </span>
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textGhost,
            marginBottom: 11,
            lineHeight: 1.5,
          }}
        >
          {data.invariant.sub}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            margin: "26px 0 5px",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
            }}
          >
            DECISION LOG
          </span>
          <span style={dot(tokens.ok, true)} />
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textGhost,
            marginBottom: 11,
            lineHeight: 1.5,
          }}
        >
          append-only · immutable · every autonomous action records why
        </div>
        {data.decisionLog.length === 0 ? (
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
            nothing decided yet.
          </div>
        ) : (
          <div
            style={{
              borderLeft: `1px solid ${tokens.border}`,
              paddingLeft: 13,
            }}
          >
            {data.decisionLog.map((d, i) => (
              <div
                key={i}
                style={{
                  padding: "8px 0",
                  borderBottom:
                    i === data.decisionLog.length - 1
                      ? "none"
                      : `1px solid ${tokens.bgGutter}`,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "baseline", gap: 8 }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 9, color: tokens.textGhost }}
                  >
                    {d.ts}
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: decisionKindColor(d.kind) }}
                  >
                    {d.kind}
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: tokens.textLabel,
                    margin: "3px 0 0 46px",
                    lineHeight: 1.45,
                  }}
                >
                  {d.action}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
