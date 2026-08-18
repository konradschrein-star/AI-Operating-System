"use client";

/**
 * SettingsSurface — settings INSIDE the shell (round 1350).
 *
 * ── What it replaces ──────────────────────────────────────────────────────
 * Until this round the rail's SETTINGS entry was a `next/link` to `/settings`
 * (DesktopApp.tsx:815 at git b02aa62). Clicking it unmounted the entire OS —
 * top nav, rail, live panel, open chat — and replaced it with a centred
 * document that had a "← BACK TO OS" link where the app used to be. Konrad:
 * settings must open without losing the app shell, and "the interface seems a
 * bit weird". A page that evicts the application to show you a checkbox is
 * where that weirdness came from.
 *
 * Settings is now a surface like CHAT or MONEY: middle column only, rails
 * intact, the OS still around it.
 *
 * ── The navigation model ─────────────────────────────────────────────────
 * Two levels, deliberately the SAME two the chat surface has:
 *
 *   depth 0  the settings index — what settings there are, one line each.
 *   depth 1  one section, alone. CONNECTIONS / SECRETS / USAGE.
 *
 * Round 1876 merged ACCOUNTS and INTEGRATIONS into CONNECTIONS. Konrad could
 * not tell from either where an account gets wired in ("the settings are still
 * a bit confusing, especially with connecting accounts"), and the split was
 * the reason: a Claude login and a Google consent are the same kind of thing
 * to the person connecting them, and they sat in different sections that each
 * explained neither. See ConnectionsPanel.tsx.
 *
 * The left-hand section list is always visible so a lateral move (accounts →
 * usage) is one click, and the body is keyed on `frameKey` so the `.nav-drill`
 * entry animation replays on every level change — descending, climbing, or
 * moving sideways. That is the idiom `frameKey()` in chat/nav-stack.ts
 * established and the mechanism `ChatSurface` uses at its keyed container
 * (ChatSurface.tsx:1017); back is the very same exported `BackButton` the
 * worker-chat views use, not a second back button that drifts from it.
 *
 * Nothing new lands in app/globals.css: `.nav-drill` and `.nav-back` already
 * exist, already respect `prefers-reduced-motion`, and already cost nothing
 * but transform and opacity (NFU8). No animation dependency is added.
 *
 * ── No React hover state (NFU2) ──────────────────────────────────────────
 * The section rows and index cards get their pointer affordance from the
 * scoped stylesheet below, exactly like `.chat-row` and `.team-row` do in
 * globals.css. Hover here must not re-render anything — a hover that costs a
 * render is the bug the rest of this project is busy deleting. Every colour in
 * that stylesheet is a `tokens.*` reference, i.e. a `var(--fg-…)`, so both
 * themes keep working and no hex literal exists in this file (NFU1).
 */

import { useCallback, useMemo, useState, type CSSProperties, type JSX } from "react";
import { tokens } from "../../tokens";
import { BackButton } from "../chat/AgentChatView";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { UsagePanel } from "./UsagePanel";

type SectionKey = "connections" | "secrets" | "usage";

interface Section {
  key: SectionKey;
  /** Rail-style label — the vocabulary the left nav already speaks. */
  label: string;
  /** Material symbol, same `.ms` class the rail's settings glyph uses. */
  icon: string;
  /** One line. It is the whole content of the index card, so it has to say
   *  what the section is FOR, not restate its name. */
  blurb: string;
  /** Rendered under the section header once drilled in. */
  body: () => JSX.Element;
}

const SECTIONS: readonly Section[] = [
  {
    key: "connections",
    label: "CONNECTIONS",
    icon: "account_circle",
    blurb:
      "Every account this OS holds — Claude, Google, Gemini — with its state and how to wire it in.",
    body: () => <ConnectionsPanel />,
  },
  {
    key: "secrets",
    label: "SECRETS",
    icon: "key",
    blurb: "Credentials the fleet holds. Reveal, mark collected, delete.",
    body: () => <SecretsPanel />,
  },
  {
    key: "usage",
    label: "USAGE",
    icon: "monitoring",
    blurb: "Tokens and spend — the one place in this UI money numbers belong.",
    body: () => <UsagePanel />,
  },
];

/** The label the back button climbs to. There is exactly one level above a
 *  section, so this is a constant rather than a stack — but it is the same
 *  word the index header uses, so the button never promises a destination
 *  that is titled something else. */
const INDEX_LABEL = "settings";

/** Same contract as `frameKey()` in chat/nav-stack.ts: a key that changes
 *  when, and only when, the thing being LOOKED AT changes. Re-renders from a
 *  poll inside a panel must not replay the drill animation.
 *
 *  Exported for `scripts/checks/check-settings-surface.tsx` alone — there is
 *  no DOM in this repo's check harness, so the drill contract is asserted on
 *  the function that drives it rather than on a click. */
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
[data-settings-surface] .settings-index-card {
  transition: border-color 0.12s ease, background-color 0.12s ease;
}
[data-settings-surface] .settings-index-card:hover,
[data-settings-surface] .settings-index-card:focus-visible {
  border-color: ${tokens.borderEmphasis};
  background: ${tokens.rowHover};
}
@media (prefers-reduced-motion: reduce) {
  [data-settings-surface] .settings-section-row,
  [data-settings-surface] .settings-index-card {
    transition: none;
  }
}
`;

export function SettingsSurface(): JSX.Element {
  const [section, setSection] = useState<SectionKey | null>(null);

  const open = useCallback((key: SectionKey) => setSection(key), []);
  const back = useCallback(() => setSection(null), []);

  const current = useMemo(
    () => SECTIONS.find((s) => s.key === section) ?? null,
    [section],
  );

  return (
    <div
      data-settings-surface
      data-settings-section={section ?? "index"}
      style={{ display: "flex", height: "100%", minHeight: 0 }}
    >
      <style>{SURFACE_CSS}</style>

      {/* Section list — the surface's own rail. Always visible: one click
          between sections, and the shape of settings stays readable while you
          are inside one of them. */}
      <div
        style={{
          width: 178,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 0",
        }}
      >
        <button
          type="button"
          onClick={back}
          className="mono settings-section-row"
          style={{
            ...rowStyle(section === null),
            letterSpacing: "0.06em",
            color: section === null ? tokens.text : tokens.textFaint,
          }}
        >
          SETTINGS
        </button>
        <div
          style={{
            height: 1,
            background: tokens.borderDivider,
            margin: "9px 16px",
          }}
        />
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => open(s.key)}
            className="mono settings-section-row"
            style={rowStyle(section === s.key)}
          >
            <span className="ms" style={{ fontSize: 14, marginRight: 8 }}>
              {s.icon}
            </span>
            {s.label}
          </button>
        ))}
      </div>

      {/* The drilled view. Keyed on the frame so `.nav-drill` replays exactly
          once per navigation and never on a panel's own refetch. */}
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
            padding: "10px 14px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          {current !== null && <BackButton label={INDEX_LABEL} onClick={back} />}
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
                  fontSize: 9.5,
                  letterSpacing: "0.04em",
                  color: tokens.textLabel,
                }}
              >
                {current === null ? "SETTINGS" : current.label}
              </span>
              <span
                style={{
                  fontSize: 13.5,
                  color: tokens.textHi,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {current === null
                  ? "How this machine is configured"
                  : current.blurb}
              </span>
            </div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textGhost, letterSpacing: "0.03em" }}
            >
              {current === null
                ? `${SECTIONS.length} sections · also at /settings`
                : `settings › ${current.label.toLowerCase()}`}
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
          {current === null ? (
            <SettingsIndex onOpen={open} />
          ) : (
            current.body()
          )}
        </div>
      </div>
    </div>
  );
}

/** Depth 0. Not decoration: it is the only view that answers "what can I
 *  configure here", which the old page never did — it opened straight into
 *  the account registry and left the rest of settings undiscoverable. */
function SettingsIndex({ onOpen }: { onOpen: (key: SectionKey) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(248px, 1fr))",
        gap: 12,
        maxWidth: 860,
      }}
    >
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onOpen(s.key)}
          className="settings-index-card"
          style={{
            textAlign: "left",
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
            padding: "14px 16px",
            cursor: "pointer",
            color: tokens.text,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 16, color: tokens.accent }}>
              {s.icon}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11, letterSpacing: "0.05em", color: tokens.textLabel }}
            >
              {s.label}
            </span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 12, color: tokens.textGhost }}>
              ›
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: tokens.textSoft, lineHeight: 1.5 }}>
            {s.blurb}
          </div>
        </button>
      ))}
    </div>
  );
}

/** The rail row look, borrowed wholesale from `LeftRail.railStyle` in
 *  DesktopApp.tsx so the surface's nav reads as the same furniture one level
 *  down, rather than a second design system. */
function rowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: 31,
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
