/**
 * Design tokens, originally extracted verbatim from design/Forge Mobile.dc.html.
 *
 * Each token is a reference to a CSS custom property rather than a literal hex
 * value, so the whole UI switches between dark and light at runtime — Konrad
 * uses this console outdoors, where the dark palette is unreadable. Both
 * palettes live in app/theme.css. Nothing at the ~1150 call sites changes:
 * `background: tokens.bgCard` still works, it just resolves through the
 * cascade now.
 *
 * Caveat: these are strings like "var(--fg-bgCard)", NOT parseable colours.
 * Anything needing a real hex — WebGL/three.js, <canvas> 2D, image export —
 * must carry its own palette or call resolveToken(). MemoryGraph3D already
 * carries its own colours, which is why converting these was safe.
 *
 * theme.css MUST be imported (see app/layout.tsx). Without it every var is
 * undefined and the entire UI renders colourless — that regression has bitten
 * this file once already.
 *
 * New token: add the variable to BOTH palettes in theme.css, then map it here.
 */
const v = (name: string) => `var(--fg-${name})`;

export const tokens = {
  // surfaces
  bgBody: v("bgBody"),
  bgTabBar: v("bgTabBar"),
  bgCard: v("bgCard"),
  bgGutter: v("bgGutter"),

  // borders
  border: v("border"),
  borderSoft: v("borderSoft"),
  borderDivider: v("borderDivider"),
  borderEmphasis: v("borderEmphasis"),

  // text
  text: v("text"),
  textHi: v("textHi"),
  textSoft: v("textSoft"),
  textLabel: v("textLabel"),
  textBody: v("textBody"),
  textSecondary: v("textSecondary"),
  textMuted: v("textMuted"),
  textMuted2: v("textMuted2"),
  textFaint: v("textFaint"),
  textGhost: v("textGhost"),

  // accent
  accent: v("accent"),
  /** Text/icon colour that sits ON `accent`. Near-black in dark, white in
   *  light — the two themes need opposite ink, so a literal is always wrong in
   *  one of them. Use this for any label on an accent-filled button. */
  accentInk: v("accentInk"),

  // status
  ok: v("ok"),
  bleed: v("bleed"),
  stuck: v("stuck"),
  warn: v("warn"),
  info: v("info"),
  decide: v("decide"),

  // tinted status surfaces (control card / action chips)
  freezeBgOk: v("freezeBgOk"),
  freezeBgWarn: v("freezeBgWarn"),
  freezeBorderOk: v("freezeBorderOk"),
  freezeBorderWarn: v("freezeBorderWarn"),
  primaryActionBg: v("primaryActionBg"),
  okActionBg: v("okActionBg"),
  okActionBorder: v("okActionBorder"),
  dangerActionBg: v("dangerActionBg"),
  dangerActionBorder: v("dangerActionBorder"),
  invariantBg: v("invariantBg"),
  invariantBorder: v("invariantBorder"),

  // chrome that must differ per theme but isn't in the original design
  inputBg: v("inputBg"),
  overlay: v("overlay"),
  /** Selected list row / tool-call block — see theme.css. */
  selectedBg: v("selectedBg"),
  rowHover: v("rowHover"),
  rowSelected: v("rowSelected"),
  toolBg: v("toolBg"),
  scrollbar: v("scrollbar"),
  /** Drop-shadow colours. Compose them into the offsets you need:
   *  `boxShadow: \`0 1px 2px ${tokens.shadowSm}\``. Light mode gets a cooler,
   *  weaker slate — plain black at dark-mode strength reads as dirt on a
   *  paper-coloured card. */
  shadowSm: v("shadowSm"),
  shadowMd: v("shadowMd"),

  /* Chat transcript role identities (round 808). Two per role: `roleBg*` is
   * the message card's tint, `roleInk*` is its header line and left rule.
   * Both palettes live in theme.css, where the ink is a var() pointing at the
   * status token agentsApi's ROLE_TOKEN already assigns that role — so this
   * is a second NAME for one colour, never a second colour.
   *
   * Consumed through `app/desktop/chat/comms-identity.ts`, which is the only
   * module that maps a role string onto these; do not index them by hand. */
  roleBgArchitect: v("roleBgArchitect"),
  roleBgPlanner: v("roleBgPlanner"),
  roleBgBuilder: v("roleBgBuilder"),
  roleBgReviewer: v("roleBgReviewer"),
  roleBgResearcher: v("roleBgResearcher"),
  roleBgScout: v("roleBgScout"),
  roleBgSteward: v("roleBgSteward"),
  roleBgTester: v("roleBgTester"),
  roleBgUnknown: v("roleBgUnknown"),

  roleInkArchitect: v("roleInkArchitect"),
  roleInkPlanner: v("roleInkPlanner"),
  roleInkBuilder: v("roleInkBuilder"),
  roleInkReviewer: v("roleInkReviewer"),
  roleInkResearcher: v("roleInkResearcher"),
  roleInkScout: v("roleInkScout"),
  roleInkSteward: v("roleInkSteward"),
  roleInkTester: v("roleInkTester"),
  roleInkUnknown: v("roleInkUnknown"),
} as const;

/** Resolve a token to its computed hex/rgb — for the few consumers that can't
 *  take a var() string (canvas 2D, WebGL, generated images). Browser-only. */
export function resolveToken(token: string): string {
  if (typeof window === "undefined") return "#000";
  const name = token.replace(/^var\(|\)$/g, "").trim();
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "forge.theme";

/** Apply a theme and persist it. Kept here so the toggle, the pre-paint inline
 *  script in layout.tsx, and any future per-user setting all agree on the same
 *  contract (attribute name + storage key). */
export function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* private mode — the theme just won't persist */
  }
}

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
