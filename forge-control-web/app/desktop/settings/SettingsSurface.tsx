"use client";

/**
 * SettingsSurface — settings INSIDE the shell.
 *
 * Direct navigation to CONNECTIONS by default (no Depth 0 empty void),
 * instant switching between CONNECTIONS, SECRETS, and USAGE & QUOTA
 * in the left sub-rail.
 */

import { useCallback, useMemo, useState, type CSSProperties, type JSX } from "react";
import { tokens } from "../../tokens";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { UsagePanel } from "./UsagePanel";

export type SectionKey = "connections" | "secrets" | "usage";

interface Section {
  key: SectionKey;
  label: string;
  icon: string;
  blurb: string;
  body: () => JSX.Element;
}

const SECTIONS: readonly Section[] = [
  {
    key: "connections",
    label: "CONNECTIONS",
    icon: "account_circle",
    blurb:
      "Every account this OS holds — Claude, Google, Gemini, GitHub — with live probing and connection controls.",
    body: () => <ConnectionsPanel />,
  },
  {
    key: "secrets",
    label: "SECRETS",
    icon: "key",
    blurb: "Encrypted credentials store (AES-256-GCM). Add, reveal, rotate, and manage secrets securely.",
    body: () => <SecretsPanel />,
  },
  {
    key: "usage",
    label: "USAGE & QUOTA",
    icon: "monitoring",
    blurb: "Subscription quota meters, token spend history, and EUR pricing.",
    body: () => <UsagePanel />,
  },
];

export function frameKey(section: SectionKey | null): string {
  return section === null ? "index" : `section:${section}`;
}

const SURFACE_CSS = `
[data-settings-surface] .settings-section-row {
  transition: background-color 0.12s ease, color 0.12s ease;
}
[data-settings-surface] .settings-section-row:hover,
[data-settings-surface] .settings-section-row:focus-visible {
  background: ${tokens.rowHover};
  color: ${tokens.text};
}
@media (prefers-reduced-motion: reduce) {
  [data-settings-surface] .settings-section-row {
    transition: none;
  }
}
`;

export function SettingsSurface(): JSX.Element {
  const [section, setSection] = useState<SectionKey>("connections");

  const open = useCallback((key: SectionKey) => setSection(key), []);

  const current = useMemo(
    () => SECTIONS.find((s) => s.key === section) ?? SECTIONS[0],
    [section],
  );

  return (
    <div
      data-settings-surface
      data-settings-section={section}
      style={{ display: "flex", height: "100%", minHeight: 0 }}
    >
      <style>{SURFACE_CSS}</style>

      {/* Section list — the surface's own rail. Always visible for instant switching */}
      <div
        style={{
          width: 184,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 0",
        }}
      >
        <div
          className="mono"
          style={{
            padding: "0 16px 8px",
            fontSize: 11,
            letterSpacing: "0.08em",
            color: tokens.textLabel,
            fontWeight: 600,
          }}
        >
          SETTINGS
        </div>
        <div
          style={{
            height: 1,
            background: tokens.borderDivider,
            margin: "0 16px 8px",
          }}
        />
        {SECTIONS.map((s) => {
          const active = section === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => open(s.key)}
              className="mono settings-section-row"
              style={rowStyle(active)}
            >
              <span
                className="ms"
                style={{
                  fontSize: 15,
                  marginRight: 8,
                  color: active ? tokens.accent : tokens.textMuted,
                }}
              >
                {s.icon}
              </span>
              {s.label}
            </button>
          );
        })}
      </div>

      {/* The active section view */}
      <div
        key={frameKey(section)}
        className="nav-drill"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 18px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
              flex: 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <span
                className="mono"
                style={{
                  flex: "none",
                  fontSize: 10,
                  letterSpacing: "0.05em",
                  color: tokens.textLabel,
                  fontWeight: 600,
                }}
              >
                {current.label}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: tokens.textHi,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {current.blurb}
              </span>
            </div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textGhost, letterSpacing: "0.03em" }}
            >
              settings › {current.key}
            </div>
          </div>
        </div>

        <div
          className="scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "16px 18px 36px",
          }}
        >
          {current.body()}
        </div>
      </div>
    </div>
  );
}

function rowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: 32,
    padding: "0 16px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11.5,
    borderLeft: `2px solid ${active ? tokens.accent : "transparent"}`,
    borderTop: "none",
    borderRight: "none",
    borderBottom: "none",
    background: active ? tokens.selectedBg : "transparent",
    color: active ? tokens.text : tokens.textMuted,
  };
}
