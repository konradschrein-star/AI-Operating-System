/**
 * nav-items.ts — the surface list and the navigation model, in one place.
 *
 * It lived inside DesktopApp.tsx until round 1873, which needed it in three
 * consumers instead of two: the top strip, the left rail, and the new phone
 * sheet (`MobileNav`). The move is what makes the sheet's COVERAGE assertable —
 * round 1872's tester found 11 of 14 destinations unreachable at 390px, and the
 * cause was not a bug in a component but a list that existed in two places: the
 * top strip renders three of the four groups, the rail renders four plus
 * SETTINGS, and below 900px the rail is hidden. A menu written against the strip
 * would have stranded GOALS, JOURNAL, MAP and SETTINGS all over again.
 *
 * `MOBILE_NAV_GROUPS` is therefore the sheet's own contract, and
 * `mobileNavDestinations()` is what `scripts/checks/check-r1873-fixes.ts`
 * compares against `NAV` + settings: add a group to the model and forget the
 * sheet, and that check fails instead of a customer finding it on a train.
 *
 * No React in this file, deliberately — a check script that imports it must not
 * pull in @assistant-ui, three.js and Excalidraw to read a list of 17 strings.
 */

export type Surface =
  | "today"
  | "inbox"
  | "chat"
  | "tasks"
  | "pipeline"
  | "library"
  | "money"
  | "businesses"
  | "skills"
  | "memory"
  | "live"
  | "control"
  | "autonomy"
  | "automation"
  | "goals"
  | "journal"
  | "map"
  | "search"
  | "settings";

/* ── Reload keeps your place (round 1871, finding 7) ──────────────────────────
 *
 * The customer test: "F5 while reading a worker transcript returns to TODAY —
 * chat, worker and scroll all gone, URL still `/desktop`." All of it was
 * `useState` in a single-route app, so a refresh was a cold start of a console
 * you had spent a minute navigating into.
 *
 * The surface is restored here; ChatSurface restores the open chat and the
 * drill-in stack on the same mechanism (`forge.chat.*`). Scroll position is
 * deliberately NOT restored — the transcript's height depends on a poll that
 * has not landed yet at mount, so a restored offset would land in the wrong
 * place and read as a bug rather than as a courtesy.
 *
 * localStorage rather than the URL. The URL is the honest home for this and
 * `/desktop?surface=chat&chat=<id>` is where it should end up — but the app
 * has exactly one route today and every surface, panel and rail reads its
 * state from React, so routing is a redesign, not a fix. This restores the
 * place in one line per piece of state and does not stand in the way of that.
 */
export const SURFACES: readonly Surface[] = [
  "today", "inbox", "chat", "tasks", "pipeline", "library", "money",
  "businesses", "skills", "memory", "live", "control", "autonomy",
  "automation", "goals", "journal", "map", "search", "settings",
];

export const isSurface = (v: unknown): v is Surface =>
  typeof v === "string" && (SURFACES as readonly string[]).includes(v);

export interface NavItem {
  key: Surface;
  label: string;
  badge?: string;
  group: "operator" | "work" | "ai" | "recall";
  /* ── Round 300, R40: the nav says which destinations are not built ─────────
   *
   * Konrad read GOALS, JOURNAL, MAP and LIBRARY as "don't work quite yet",
   * because clicking any of them rendered a tidy card with three or four
   * feature bullets — a feature that failed to load, not a feature nobody
   * wrote. The surface now says so in words (`PlaceholderSurface`), and this
   * flag is what stops him having to click to find out.
   *
   * OPTIONAL, and `true` is its only value: a built entry carries no field at
   * all, so every render site guards on it and a built row is byte-identical
   * to what it was before this flag existed (R43). A marker on everything is a
   * marker on nothing — `scripts/checks/check-phase3-placeholders.ts` asserts
   * the set is exactly the three, and asserts that a BUILT key wrongly flagged
   * would be caught.
   *
   * Evidence for each — no route, no table, no data module:
   * docs/plan/artifacts/os-usable-for-work/phase3/surface-determinations.md.
   * `search` is deliberately absent: it is not a NAV entry, and its backend is
   * built and live (§5 of that document), so it is a different defect.
   *
   * ROUND 8: GOALS retired from this flag. It was one of the original four —
   * `main` (553fa38) shipped a real `GoalsSurface` and Konrad used it the
   * night of 2026-08-18, so the determination this flag made for it is now
   * false. `journal`, `library` and `map` are still genuinely unbuilt; this is
   * not licence to clear them too. See DesktopApp.tsx's `PlaceholderKey` note
   * for the render-side half of this change. */
  unbuilt?: true;
}

export const NAV: NavItem[] = [
  { key: "today", label: "TODAY", group: "operator" },
  { key: "inbox", label: "INBOX", group: "operator" },
  { key: "chat", label: "CHAT", group: "operator" },
  { key: "tasks", label: "PROJECTS", group: "work" },
  { key: "pipeline", label: "PIPELINE", group: "work" },
  { key: "library", label: "LIBRARY", group: "work", unbuilt: true },
  { key: "money", label: "MONEY", group: "work" },
  { key: "businesses", label: "BUSINESSES", group: "work" },
  { key: "skills", label: "SKILLS", group: "ai" },
  { key: "memory", label: "MEMORY", group: "ai" },
  { key: "live", label: "LIVE", group: "ai" },
  { key: "control", label: "CONTROL", group: "ai" },
  { key: "autonomy", label: "AUTONOMY", group: "ai" },
  { key: "automation", label: "AUTOMATION", group: "ai" },
  { key: "goals", label: "GOALS/TASKS", group: "recall" },
  { key: "journal", label: "JOURNAL", group: "recall", unbuilt: true },
  { key: "map", label: "MAP", group: "recall", unbuilt: true },
];

/** The unbuilt destinations, read off the model rather than listed a second
 *  time. Takes the list as an argument so a check can run the SAME derivation
 *  over a doctored copy and prove the derivation actually discriminates — an
 *  assertion that passes at every fixture value proves nothing. */
export function unbuiltNavKeys(items: readonly NavItem[] = NAV): Surface[] {
  return items.filter((n) => n.unbuilt === true).map((n) => n.key);
}

/** The four, as a set, for render sites and check scripts. */
export const UNBUILT_NAV_KEYS: readonly Surface[] = unbuiltNavKeys();


/** The four groups, in the order every surface renders them. The rail has always
 *  used exactly this order; the phone sheet reads it from here rather than
 *  writing its own copy. */
export const NAV_GROUPS: readonly NavItem["group"][] = [
  "operator",
  "work",
  "ai",
  "recall",
];

/** The groups the phone sheet renders, with the headings it prints. ALL of them:
 *  at phone width the left rail is not mounted, so this sheet is the only way to
 *  reach anything (round 1873, finding 3). */
export const MOBILE_NAV_GROUPS: readonly { label: string; group: NavItem["group"] }[] = [
  { label: "OPERATOR", group: "operator" },
  { label: "WORK", group: "work" },
  { label: "AI", group: "ai" },
  { label: "RECALL", group: "recall" },
];

/** SETTINGS is not in `NAV` and never was — the desktop reaches it from the
 *  rail's own footer entry, which does not exist at phone width. The sheet
 *  renders it explicitly, so it is named explicitly here. */
export const MOBILE_EXTRA_DESTINATIONS: readonly Surface[] = ["settings"];

/** Every destination the phone sheet can actually reach. The claim
 *  `scripts/checks/check-r1873-fixes.ts` asserts against `NAV`. */
export function mobileNavDestinations(): Surface[] {
  const out: Surface[] = [];
  for (const g of MOBILE_NAV_GROUPS) {
    for (const item of NAV) if (item.group === g.group) out.push(item.key);
  }
  return [...out, ...MOBILE_EXTRA_DESTINATIONS];
}
