/**
 * Design tokens extracted verbatim from design/Forge Mobile.dc.html.
 * Do not invent new colors here — if you need a new token, add it to the design first.
 */
export const tokens = {
  // surfaces
  bgBody: "#000",
  bgTabBar: "#08080a",
  bgCard: "#0b0b0c",
  bgGutter: "#0c0c0e",

  // borders
  border: "#1c1c1f",
  borderSoft: "#161617",
  borderDivider: "#141416",
  borderEmphasis: "#222226",

  // text
  text: "#ededee",
  textHi: "#f4f4f5",
  textSoft: "#e4e4e6",
  textLabel: "#cacad0",
  textBody: "#b8b8be",
  textSecondary: "#9a9aa0",
  textMuted: "#8a8a90",
  textMuted2: "#6a6a70",
  textFaint: "#56565c",
  textGhost: "#48484e",

  // accent
  accent: "#5b8def",

  // status
  ok: "#57a06b",
  bleed: "#cf6360",
  stuck: "#c07ad0",
  warn: "#d8c24a",
  info: "#4fb0c4",
  decide: "#9b8cf0",

  // tinted status surfaces (used in control card / action chips)
  freezeBgOk: "#0a0f0b",
  freezeBgWarn: "#140e08",
  freezeBorderOk: "#1c2a20",
  freezeBorderWarn: "#3a2a1f",
  primaryActionBg: "#0e1320",
  okActionBg: "#0c130e",
  okActionBorder: "#2a3a2e",
  dangerActionBg: "#130c0c",
  dangerActionBorder: "#2a1f1f",
  invariantBg: "#0b0908",
  invariantBorder: "#2a1f1f",
} as const;

export type StatusColor =
  | typeof tokens.ok
  | typeof tokens.bleed
  | typeof tokens.stuck
  | typeof tokens.warn
  | typeof tokens.info
  | typeof tokens.decide
  | typeof tokens.accent;

export const dot = (color: string, animate = false): React.CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: "50%",
  flex: "none",
  background: color,
  ...(animate ? { animation: "pulse 2s infinite" } : {}),
});
