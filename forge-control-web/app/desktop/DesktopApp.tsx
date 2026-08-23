"use client";

/* `next/link` is gone from this file on purpose (round 1350): the SETTINGS
 * rail entry was its last user, and it now opens a surface instead of
 * navigating away. Nothing in the OS shell unmounts the OS any more. */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot, applyTheme } from "../tokens";
import { useThemeMode } from "../useThemeMode";
import {
  statusColor,
  tierColor,
  triedIconColor,
  decisionKindColor,
  loopColor,
  providerColor,
  liveStatColor,
  type InboxAction,
  type FleetWorker,
  type NeedsItem,
} from "../data";
import {
  fetchToday,
  fetchInbox,
  fetchInboxPreview,
  fetchLive,
  fetchControl,
  resolveInboxItem,
  clearAllInbox,
  freezeFleet,
  resumeFleet,
  emptyToday,
  emptyLive,
  emptyControl,
  type InboxPreview,
} from "../api";
import { MemorySurface } from "./MemorySurface";
import { ChatSurface } from "./ChatSurface";
import { SkillsSurface } from "./SkillsSurface";
import { PipelineSurface } from "./PipelineSurface";
import { AutonomySurface } from "./AutonomySurface";
import { AutomationSurface } from "./AutomationSurface";
import { MoneySurface } from "./MoneySurface";
import { SettingsSurface } from "./settings/SettingsSurface";
import { ProjectsSurface } from "./ProjectsSurface";
import { BusinessesSurface } from "./BusinessesSurface";
import { GoalsSurface } from "./GoalsSurface";
import { JournalSurface } from "./JournalSurface";
import { AgentActivity } from "./live/AgentActivity";
import { QuotaRow } from "./quota/QuotaRow";
import {
  ResizeHandle,
  useResizablePanel,
  usePersistentState,
  useNarrowViewport,
} from "./_ui/ResizableSplit";
import {
  SurfaceErrorBoundary,
  ErrorPanel,
  errorDetail,
} from "./_ui/SurfaceErrorBoundary";
import { ToastHost, toastError } from "./_ui/Toasts";
import {
  MOBILE_NAV_GROUPS,
  NAV,
  isSurface,
  type NavItem,
  type Surface,
} from "./nav-items";

/* Surfaces and the navigation model moved to ./nav-items in round 1873 — the
 * phone sheet below is a third consumer of the same list, and a list with three
 * readers does not live inside one of them. */

/* ════════════════════════════════════════════════════════════════════════════
 * The screens that do not exist — round 300 (R38, R39)
 *
 * WHAT THIS RECORD USED TO BE, AND WHY IT WAS A LIE TOLD IN CSS.
 * Until this round each entry carried a `title`, a `desc` and three or four
 * `items` — feature bullets — which `PlaceholderSurface` rendered as a tidy
 * bordered card. Konrad's report was that GOALS, JOURNAL, MAP and LIBRARY
 * "don't work quite yet", and that reading is exactly what a convincing
 * wireframe produces: a screen that looks like a feature which FAILED TO LOAD
 * rather than a feature NOBODY WROTE. Those two states must not look the same.
 *
 * So each entry now carries the three statements a person actually needs, and
 * `items` is gone rather than demoted — a feature list is the one thing on this
 * screen that can be misread as a live feature:
 *
 *   purpose     — what the screen would be FOR
 *   needs       — what it NEEDS in order to exist, named concretely: the route,
 *                 the table, the data source, and which of them already exist
 *   scheduling  — whether anyone is coming. "Coming soon" is a promise with no
 *                 owner and no date and is banned; for all five the truth is
 *                 that os-usable-for-work does not build them (00-vision.md §5)
 *
 * THE COPY IS NOT INVENTED HERE. Every claim below is quoted from B3a's
 * measured determination, docs/plan/artifacts/os-usable-for-work/phase3/
 * surface-determinations.md, so the screen and the document cannot drift.
 *
 * FIVE KEYS, NOT TEN. This record used to hold ten, five of which (chat,
 * pipeline, skills, memory, autonomy) were dead copy: those surfaces have been
 * BUILT for months and the render switch excluded them by name, so their
 * entries described a wireframe nothing could reach. They are deleted. The five
 * that remain are the five this branch actually renders.
 *
 * SEARCH IS NOT LIKE THE OTHER FOUR and must not say "not built": its backend
 * is built, mounted at index.ts:166 and answering live today (determinations
 * §5). Only its screen is missing, and there is no nav entry that reaches it.
 * Printing the same banner on it would replace one wrong label with another.
 *
 * ROUND 8: GOALS RETIRED FROM THIS RECORD. `main` (553fa38) shipped a real
 * `GoalsSurface` and Konrad used it the night of 2026-08-18 — the "not built
 * yet" determination this record made for it was true when B3a measured it and
 * is false now. It is gone from this record and from `NAV.unbuilt` in
 * ./nav-items (a change outside this file's original write-set, disclosed in
 * the round-8 commit). PHASE 7: the surfaces/main reconciliation merge brought
 * `main`'s `GoalsSurface` import and `surface === "goals" && <GoalsSurface />`
 * render line in — see the render switch below. FOUR KEYS remain here: journal,
 * map, library, search.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The keys this branch renders. `search` is in `SURFACES` but not in `NAV`;
 *  the other three (`journal`, `map`, `library`) are `NAV` entries carrying
 *  `unbuilt: true`. `goals` was a fourth until round 8 — see the note above. */
type PlaceholderKey = "map" | "library" | "search";

interface PlaceholderCopy {
  tag: string;
  /** `unbuilt` — nothing exists behind it. `unreachable` — the backend is live
   *  and only the screen is missing, which is a different defect and gets
   *  different words. Both share the warning treatment: the distinction this
   *  round is drawing is between "broken" and "never written", and both of
   *  these are the latter. The words carry the rest, which is the point. */
  state: "unbuilt" | "unreachable";
  /** The sentence a tired operator reads first. For every `unbuilt` entry it
   *  contains the literal words "not built yet" (R38). */
  headline: string;
  /** Why the screen is empty, said plainly enough that nobody reloads. */
  subhead: string;
  purpose: string;
  needs: string;
  scheduling: string;
}

const PLACEHOLDER_SURFACES: Record<PlaceholderKey, PlaceholderCopy> = {
  map: {
    tag: "MAP",
    state: "unbuilt",
    headline: "MAP is not built yet.",
    subhead:
      "Nothing failed to load here. This screen was never written, although three quarters of what it would show is already being measured elsewhere.",
    purpose:
      "An infrastructure inventory: what is running, on which host, behind which domain, writing to which volume, through which external provider.",
    needs:
      "A routes/map.ts aggregator and a MapSurface. Three of its four columns have live producers today — /api/pm2/list (24 processes, 19 online), /api/systemd/units (97 units) and /api/system/stats. Only domains has none: 19 nginx vhosts sit on disk and nothing parses them.",
    scheduling:
      "Nobody is working on it, and os-usable-for-work does not build it. The determination costs it at 1 round, 3 builders and no migration — but says it should be built only after this project's connection probes land, so the provider column reuses that status contract instead of forking a second one.",
  },
  library: {
    tag: "LIBRARY",
    state: "unbuilt",
    headline: "LIBRARY is not built yet.",
    subhead:
      "Nothing failed to load here, and this is not an empty grid. The screen was never written — the store behind it is not empty at all.",
    purpose:
      "The artefact store: what this OS itself produced — run screenshots, reports and generated outputs. The earlier copy promised scripts, voices, clips and templates; that is Content Forge's material and PIPELINE already owns it.",
    needs:
      "Only the screen. GET /api/uploads/index is mounted and answers over the artefact store in /opt/ai-os/uploads — more than 400 files when this screen was written (measured 2026-08-18; the store is live and every run adds to it, so read that as a floor and not as today's count). No new route, no table and no producer would have to be built — which is why this backing store was chosen over the four that were rejected.",
    scheduling:
      "Nobody is working on it, and os-usable-for-work does not build it. The artefact-store reading is a default taken on 2026-08-18 because the question went unanswered; your ruling overrides it, and overriding it is cheap while nothing is built. Costed at 1 round, 2 builders, no migration.",
  },
  search: {
    tag: "SEARCH",
    state: "unreachable",
    headline: "SEARCH has no screen — but its engine is live.",
    subhead:
      "This one is not like the others: the backend is built, mounted and answering queries today. Only the screen for it was never written. There is also no way to reach this page from the UI — no nav entry, no palette row, no shortcut — so you are seeing it because a stored value put you here.",
    purpose:
      "One query across the vault, runs, jobs, inbox items and decisions, returned as grouped hits with the engine that answered each group named on it.",
    needs:
      "Only a SearchSurface and one line in the nav list. GET /api/search is live: it returns grouped, source-tagged results, each row already carrying the surface and id to navigate to. Nothing consumes that payload.",
    scheduling:
      "Nobody is working on it, and os-usable-for-work does not build it. It is the cheapest screen left in this product — 1 round, 1 builder, no route work — and the only one whose deferral leaves working, paid-for code behind a door with no handle.",
  },
};

const isPlaceholderKey = (s: Surface): s is PlaceholderKey =>
  s in PLACEHOLDER_SURFACES;

/* ----------------------------------------------------------------------------
 * Inbox action button style (reused from mobile)
 * -------------------------------------------------------------------------- */
const actionStyle = (variant: InboxAction["variant"]): CSSProperties => {
  const base: CSSProperties = {
    fontSize: 11.5,
    borderRadius: 6,
    padding: "8px 14px",
    cursor: "pointer",
    userSelect: "none",
    display: "inline-flex",
    alignItems: "center",
  };
  switch (variant) {
    case "primary":
      return {
        ...base,
        color: tokens.accent,
        border: `1px solid ${tokens.accent}`,
        background: tokens.primaryActionBg,
      };
    case "ok":
      return {
        ...base,
        color: tokens.ok,
        border: `1px solid ${tokens.okActionBorder}`,
        background: tokens.okActionBg,
      };
    case "danger":
      return {
        ...base,
        color: tokens.bleed,
        border: `1px solid ${tokens.dangerActionBorder}`,
        background: tokens.dangerActionBg,
      };
    default:
      return {
        ...base,
        color: tokens.textMuted,
        border: `1px solid ${tokens.border}`,
        background: "transparent",
      };
  }
};

/* ----------------------------------------------------------------------------
 * Root
 * -------------------------------------------------------------------------- */
export function DesktopApp() {
  const [surface, setSurface] = usePersistentState<Surface>(
    "forge.desktop.surface",
    "today",
    isSurface,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  /** Phone-width, or a narrow window on a desktop. See `useNarrowViewport`. */
  const narrow = useNarrowViewport();

  // Nav rail width — draggable and remembered. 120 still shows the labels;
  // 360 is as wide as this rail can be without stealing the surface.
  const navRail = useResizablePanel({
    storageKey: "forge.layout.navRail",
    initial: 184,
    min: 120,
    max: 360,
  });

  const todayQ = useQuery({ queryKey: ["today"], queryFn: fetchToday });
  const inboxQ = useQuery({ queryKey: ["inbox"], queryFn: fetchInbox });
  const liveQ = useQuery({
    queryKey: ["live"],
    queryFn: fetchLive,
    enabled: surface === "live" || surface === "today",
    // The LIVE surface used to be a static snapshot — the audit (§2.3) called
    // it out as fetch-once and never refresh. Now that AgentActivity is
    // mounted at the top of it, poll while the surface is visible so the
    // provider pulse and Hermes ledger update at the same cadence users
    // already expect from the panel.
    refetchInterval: surface === "live" ? 15_000 : false,
  });
  const controlQ = useQuery({ queryKey: ["control"], queryFn: fetchControl });
  const qc = useQueryClient();

  // Global ⌘K / Ctrl+K toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isPalette = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isPalette) {
        e.preventDefault();
        setPaletteOpen((s) => !s);
        setPaletteQ("");
      } else if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fleetStatus = controlQ.data?.fleet.status ?? "running";
  const paused = fleetStatus === "paused";
  const inboxCount = inboxQ.data?.length ?? 0;
  const bleedCount = (inboxQ.data ?? []).filter(
    (i) => i.status === "BLEED",
  ).length;
  const stuckCount = (inboxQ.data ?? []).filter(
    (i) => i.status === "STUCK",
  ).length;

  const freezeM = useMutation({
    mutationFn: () => (paused ? resumeFleet("user") : freezeFleet("user")),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["control"] });
      qc.invalidateQueries({ queryKey: ["today"] });
    },
    // A freeze that silently didn't happen is the worst possible failure
    // in this app — the button would flip back and you'd assume the fleet
    // stopped.
    onError: (e) =>
      toastError(
        paused ? "Resume failed — fleet is still frozen." : "FREEZE FAILED — the fleet is still running.",
        e,
      ),
  });

  const clearNeedsM = useMutation({
    mutationFn: clearAllInbox,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
    },
    onError: (e) => toastError("Couldn't clear the inbox.", e),
  });

  const inboxBadges: Record<string, string> = {};
  if (inboxCount > 0) inboxBadges.inbox = String(inboxCount);
  if (bleedCount > 0) inboxBadges.live = `${bleedCount}!`;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: tokens.bgBody,
      }}
    >
      <TopNav
        surface={surface}
        narrow={narrow}
        onNav={setSurface}
        onPalette={() => {
          setPaletteOpen(true);
          setPaletteQ("");
        }}
        badges={inboxBadges}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Round 1871, finding 8: below 900px the nav rail and its handle are
            184 + 5 of the 390 pixels a phone has, and TopNav already carries
            every destination the rail does. So the rail goes and the surface
            gets the width. Nothing becomes unreachable — that was the bug. */}
        {!narrow && (
          <>
            <LeftRail
              surface={surface}
              onNav={setSurface}
              badges={inboxBadges}
              width={navRail.size}
            />
            <ResizeHandle
              {...navRail.handleProps}
              title="Resize navigation · double-click to reset"
            />
          </>
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            background: tokens.bgBody,
          }}
        >
          {/* One boundary around whichever surface is mounted. Keyed on the
              surface so navigating away from a broken pane clears its error
              instead of pinning it there for the session. */}
          <SurfaceErrorBoundary label={surface.toUpperCase()} resetKey={surface}>
          {surface === "today" &&
            (todayQ.isError ? (
              <ErrorPanel
                title="Today didn't load."
                detail={errorDetail(todayQ.error)}
                onRetry={() => void todayQ.refetch()}
              />
            ) : (
              <TodaySurface
                data={todayQ.data ?? emptyToday}
                inboxCount={inboxCount}
                onNav={setSurface}
                onClearNeeds={() => clearNeedsM.mutate()}
                clearingNeeds={clearNeedsM.isPending}
              />
            ))}
          {surface === "inbox" &&
            (inboxQ.isError ? (
              <ErrorPanel
                title="Inbox didn't load."
                detail={errorDetail(inboxQ.error)}
                onRetry={() => void inboxQ.refetch()}
              />
            ) : (
              <InboxSurface
                items={inboxQ.data ?? []}
                onResolve={(id, action_id, reason) =>
                  resolveInboxItem(id, {
                    resolved_by: "user",
                    action_id,
                    reason,
                  })
                    .then(() => {
                      qc.invalidateQueries({ queryKey: ["inbox"] });
                      qc.invalidateQueries({ queryKey: ["today"] });
                    })
                    .catch((e: unknown) => {
                      toastError("Couldn't resolve that inbox item.", e);
                    })
                }
              />
            ))}
          {/* `?? emptyLive` on its own rendered a dead backend as "no service
              degradation reported" — the single most misleading thing this
              console could say. Failure now looks like failure. */}
          {surface === "live" &&
            (liveQ.isError ? (
              <ErrorPanel
                title="Live status is unavailable — this is NOT an all-clear."
                detail={errorDetail(liveQ.error)}
                onRetry={() => void liveQ.refetch()}
              />
            ) : (
              <LiveSurface data={liveQ.data ?? emptyLive} />
            ))}
          {surface === "control" &&
            (controlQ.isError ? (
              <ErrorPanel
                title="Control didn't load — fleet state unknown."
                detail={errorDetail(controlQ.error)}
                onRetry={() => void controlQ.refetch()}
              />
            ) : (
              <ControlSurface
                data={controlQ.data ?? emptyControl}
                onFreeze={() => freezeM.mutate()}
              />
            ))}
          {surface === "tasks" && <ProjectsSurface />}
          {surface === "memory" && <MemorySurface />}
          {surface === "chat" && (
            <ChatSurface
              onNavigate={(s) => {
                // Slash navigation commands. SurfaceKey is a superset of
                // the local Surface union; only forward keys that match.
                if (
                  s === "today" ||
                  s === "inbox" ||
                  s === "live" ||
                  s === "control" ||
                  s === "memory" ||
                  s === "skills" ||
                  s === "pipeline" ||
                  s === "autonomy"
                ) {
                  setSurface(s);
                } else if (s === "chat") {
                  // already here
                }
              }}
            />
          )}
          {surface === "skills" && <SkillsSurface />}
          {surface === "pipeline" && <PipelineSurface />}
          {surface === "autonomy" && <AutonomySurface />}
          {surface === "automation" && <AutomationSurface />}
          {surface === "money" && <MoneySurface />}
          {surface === "settings" && <SettingsSurface />}
          {surface === "businesses" && <BusinessesSurface />}
          {/* Round 300, reconciled at the phase-7 surfaces/main merge. This
              branch used to read `surface in PLACEHOLDER_SURFACES` followed by
              seven `surface !== …` clauses, five of which named surfaces that
              have been built for months (memory, chat, skills, pipeline,
              autonomy) and two of which (automation, businesses) were never
              keys in that record at all. The exclusions existed to stop dead
              copy rendering over a working surface; that dead copy is now
              deleted, so the record IS the guard — `isPlaceholderKey` covers
              journal, map, library and search, and `goals` is not a member of
              `PlaceholderKey` (retired round 8), so the two lines below cannot
              double-render it. `surface === "goals" && <GoalsSurface />` is
              `main`'s 553fa38 line, carried forward unmodified — this merge is
              the integration that brings it in. */}
          {surface === "goals" && <GoalsSurface />}
          {surface === "journal" && <JournalSurface />}
          {isPlaceholderKey(surface) && (
            <PlaceholderSurface info={PLACEHOLDER_SURFACES[surface]} />
          )}
          </SurfaceErrorBoundary>
        </div>
      </div>
      <StatusBar
        bleedCount={bleedCount}
        stuckCount={stuckCount}
        fleetStatus={fleetStatus}
        onNav={setSurface}
        onPalette={() => {
          setPaletteOpen(true);
          setPaletteQ("");
        }}
      />
      {paletteOpen && (
        <CommandPalette
          q={paletteQ}
          onChange={setPaletteQ}
          onClose={() => setPaletteOpen(false)}
          onNav={(s) => {
            setSurface(s);
            setPaletteOpen(false);
          }}
        />
      )}
      <ToastHost />
    </div>
  );
}

/* ============================================================================
 * The nav marker for an unbuilt destination — round 300, R40
 *
 * So Konrad does not have to click a destination to find out nobody wrote it.
 *
 * ONE COMPONENT, THREE CALL SITES. The nav renders in three places — the top
 * strip, the phone sheet and the left rail — and round 1872 found 11 of 14
 * destinations unreachable at 390px precisely because the nav model lived in
 * two places. The MODEL is now single (`NAV.unbuilt` in ./nav-items); this is
 * the matching single rendering of it, so the three sites cannot drift into
 * three different markers.
 *
 * EVERY CALL IS GUARDED ON `n.unbuilt`, which is optional and set on exactly
 * three entries (four until round 8, which retired `goals` — see the note
 * above `PlaceholderKey` in the component above). A built entry renders no
 * extra node at all and is byte-identical to what it was before this round
 * (R43) — a marker on everything is a marker on nothing.
 *
 * TWO VARIANTS, BECAUSE THE TOP STRIP HAS NO ROOM AND THAT IS MEASURED.
 * The rail and the phone sheet are vertical lists with a `flex: 1` spacer, so a
 * word costs nothing there. The top strip is horizontal and ALREADY OVERFLOWS
 * before this round: at a 1280px window its content is 1,384px wide, and the
 * `forge` wordmark's right edge (77px) is past TODAY's left edge (36px) — the
 * brand block has collapsed and the search box on the right is cut. Measured on
 * this build by hiding the marker in the DOM and re-measuring: 1,384px without
 * it, 1,432px with the word. Only LIBRARY is affected — `journal` and `map`
 * (and `goals`, though it no longer carries the flag) are in the `recall`
 * group, which the strip does not render at all.
 *
 * Adding 48px to a strip that is already 104px over would push one more BUILT
 * destination off the right edge in the 1,384–1,432px band, and R43 forbids
 * changing behaviour for built surfaces. So the strip gets the same token, the
 * same data attribute and the same tooltip in 16px instead of 48px. The strip's
 * pre-existing overflow at 1280 is NOT this round's to fix and is reported as a
 * finding — see phase3/after-verification.md.
 * ========================================================================== */
function UnbuiltMark({
  surfaceKey,
  size,
  variant,
}: {
  surfaceKey: Surface;
  size: number;
  variant: "word" | "glyph";
}) {
  const title = "Not built yet — open it to read what it would take.";
  if (variant === "glyph") {
    return (
      <span
        data-nav-unbuilt={surfaceKey}
        className="ms"
        title={title}
        aria-label="not built yet"
        style={{ marginLeft: 5, fontSize: size, color: tokens.warn, flex: "none" }}
      >
        warning
      </span>
    );
  }
  return (
    <span
      data-nav-unbuilt={surfaceKey}
      className="mono"
      title={title}
      style={{
        marginLeft: 6,
        fontSize: size,
        letterSpacing: "0.06em",
        color: tokens.warn,
        flex: "none",
      }}
    >
      UNBUILT
    </span>
  );
}

/* ============================================================================
 * Top nav
 * ========================================================================== */
function TopNav({
  surface,
  onNav,
  onPalette,
  badges,
  narrow,
}: {
  surface: Surface;
  onNav: (s: Surface) => void;
  onPalette: () => void;
  badges: Record<string, string>;
  /** Phone width. Below it the horizontal strip cannot hold the destinations
   *  and is replaced by one button that opens all of them — see `MobileNav`. */
  narrow: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navStyle = (key: Surface): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    height: "100%",
    padding: "0 13px",
    fontSize: 12.5,
    cursor: "pointer",
    borderBottom: `1.5px solid ${surface === key ? tokens.accent : "transparent"}`,
    color: surface === key ? tokens.text : tokens.textMuted,
  });
  const groups: Array<NavItem["group"]> = ["operator", "work", "ai"];
  return (
    <div
      style={{
        height: 46,
        flex: "none",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        borderBottom: `1px solid ${tokens.borderSoft}`,
        background: tokens.bgBody,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          paddingRight: narrow ? 10 : 20,
          minWidth: 0,
        }}
      >
        <div
          style={{
            width: 11,
            height: 15,
            background: tokens.accent,
            borderRadius: 2,
            flex: "none",
          }}
        />
        <span
          className="mono"
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: "0.01em",
            color: tokens.textHi,
          }}
        >
          forge
        </span>
        {/* On a phone the strip below is gone, so the only thing that says where
            you ARE is this. It is the destination name, not a decoration. */}
        {narrow && (
          <span
            data-nav-current
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.06em",
              color: tokens.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {NAV.find((n) => n.key === surface)?.label ?? surface.toUpperCase()}
          </span>
        )}
      </div>
      {/* ROUND 1873, FINDING 3. This strip is 1,138px of destinations. At 390px
          it used to render anyway, inside a container with no scroll and no
          overflow affordance: TODAY, CHAT and PROJECTS were inside the viewport
          and the other eleven — LIVE, the panel this project is about, at x=914 —
          could not be reached by swipe, wheel or `window.scrollX`, because the
          shell root is `overflow: hidden` and the strip's `scrollWidth` equalled
          its `clientWidth`. Three of fourteen destinations reachable on a phone.
          Below 900px the strip is now replaced by one button that opens ALL of
          them, the four rail groups included — the rail is hidden at this width
          too (round 1871, finding 8), so a menu that only mirrored this strip
          would still have stranded GOALS, JOURNAL, MAP and SETTINGS. */}
      <div
        style={{
          display: narrow ? "none" : "flex",
          alignItems: "stretch",
          height: "100%",
        }}
      >
        {groups.map((g, gi) => (
          <Group key={g} divider={gi > 0}>
            {NAV.filter((n) => n.group === g).map((n) => (
              <div
                key={n.key}
                onClick={() => onNav(n.key)}
                className="mono"
                style={navStyle(n.key)}
              >
                {n.label}
                {n.unbuilt && (
                  <UnbuiltMark surfaceKey={n.key} size={13} variant="glyph" />
                )}
                {badges[n.key] && (
                  <span
                    style={{
                      marginLeft: 5,
                      color:
                        surface === n.key ? tokens.accent : tokens.textFaint,
                      fontSize: 11,
                    }}
                  >
                    {badges[n.key]}
                  </span>
                )}
              </div>
            ))}
          </Group>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div
        onClick={onPalette}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11.5,
          color: tokens.textMuted,
          border: `1px solid ${tokens.borderEmphasis}`,
          borderRadius: 7,
          padding: "6px 10px",
          cursor: "pointer",
          /* On a phone the words and the ⌘K hint go and the affordance becomes
             the icon: 172px of search box next to a menu button is how the strip
             ran out of room in the first place. */
          minWidth: narrow ? 0 : 172,
        }}
      >
        <span className="ms" style={{ fontSize: 14, color: tokens.textFaint }}>
          search
        </span>
        {!narrow && (
          <>
            <span style={{ color: tokens.textMuted2 }}>search everything</span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                color: tokens.textGhost,
                border: `1px solid ${tokens.borderEmphasis}`,
                borderRadius: 4,
                padding: "0 4px",
              }}
            >
              ⌘K
            </span>
          </>
        )}
      </div>
      <ThemeToggle />
      {narrow && (
        <button
          data-nav-menu
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
          aria-controls="forge-mobile-nav"
          title="All destinations"
          onClick={() => setMenuOpen((v) => !v)}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginLeft: 8,
            /* 44×44 — round 1874, finding 5: "The phone's menu button is smaller
               than everything it opens. The button is 34×34 while all 18
               destinations inside the sheet are a correct 44px." The one control
               that has to be hit before any of them can be was the only one
               below the thumb target. It fits: the bar is 46px and this button
               has no vertical margin. */
            width: 44,
            height: 44,
            flex: "none",
            borderRadius: 8,
            cursor: "pointer",
            color: menuOpen ? tokens.accent : tokens.textMuted,
            background: menuOpen ? tokens.primaryActionBg : "transparent",
            border: `1px solid ${menuOpen ? tokens.accent : tokens.borderEmphasis}`,
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>
            {menuOpen ? "close" : "menu"}
          </span>
        </button>
      )}
      {narrow && menuOpen && (
        <MobileNav
          surface={surface}
          badges={badges}
          onNav={(s) => {
            onNav(s);
            setMenuOpen(false);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Every destination, on a phone — round 1873, finding 3.
 *
 * A sheet under the top bar rather than a slide-out drawer: the shell is
 * `overflow: hidden` and 390px wide, so there is nothing to slide over and a
 * transform would only buy an animation. It lists the FOUR rail groups plus
 * SETTINGS — 18 destinations — because at this width the left rail is hidden
 * too, and a menu that mirrored only the top strip would have left GOALS,
 * JOURNAL, MAP and SETTINGS unreachable, which is the same bug one row down.
 *
 * Closes on Escape, on the backdrop, and on any choice. It does NOT trap focus:
 * that needs a focus-scope this app has no primitive for, and half a trap is
 * worse than none — the list is a flat set of buttons in DOM order, so a phone's
 * screen reader and a keyboard both walk it top to bottom.
 */
function MobileNav({
  surface,
  badges,
  onNav,
  onClose,
}: {
  surface: Surface;
  badges: Record<string, string>;
  onNav: (s: Surface) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* From the model, not from a copy of it: `mobileNavDestinations()` in
     ./nav-items is the same walk, and the check script compares its output
     against `NAV` so a fifth group cannot be added without landing here. */
  const groups = MOBILE_NAV_GROUPS.map((g) => ({
    label: g.label,
    items: NAV.filter((n) => n.group === g.group),
  }));

  return (
    <div
      data-nav-menu-backdrop
      onClick={onClose}
      style={{
        position: "fixed",
        top: 46,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 900,
        background: tokens.bgBody,
        overflowY: "auto",
      }}
    >
      <nav
        id="forge-mobile-nav"
        data-nav-menu-panel
        aria-label="All destinations"
        /* The sheet IS the backdrop's child and swallows the click that would
           close it — a tap on a destination must not also register as "close by
           backdrop" and race the navigation. */
        onClick={(e) => e.stopPropagation()}
        style={{ padding: "6px 0 40px" }}
      >
        {groups.map((g) => (
          <div key={g.label}>
            <div
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: "0.1em",
                color: tokens.textGhost,
                padding: "12px 18px 4px",
              }}
            >
              {g.label}
            </div>
            {g.items.map((n) => (
              <button
                key={n.key}
                data-nav-menu-item={n.key}
                type="button"
                aria-current={surface === n.key ? "page" : undefined}
                onClick={() => onNav(n.key)}
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                  /* 44px: a thumb target, not a mouse target. Every row in this
                     sheet is tappable at arm's length on a moving train, which
                     is where Konrad reads this thing. */
                  minHeight: 44,
                  padding: "0 18px",
                  fontSize: 13,
                  textAlign: "left",
                  cursor: "pointer",
                  color: surface === n.key ? tokens.text : tokens.textMuted,
                  background: surface === n.key ? tokens.selectedBg : "transparent",
                  border: "none",
                  borderLeft: `2px solid ${surface === n.key ? tokens.accent : "transparent"}`,
                }}
              >
                {n.label}
                {n.unbuilt && (
                  <UnbuiltMark surfaceKey={n.key} size={10} variant="word" />
                )}
                <span style={{ flex: 1 }} />
                {badges[n.key] && (
                  <span style={{ fontSize: 11, color: tokens.textFaint }}>
                    {badges[n.key]}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        <div
          style={{
            height: 1,
            background: tokens.borderDivider,
            margin: "14px 18px 0",
          }}
        />
        {/* Not in NAV — it never was; the desktop reaches it from the rail's
            own footer entry, which does not exist at this width. */}
        <button
          data-nav-menu-item="settings"
          type="button"
          aria-current={surface === "settings" ? "page" : undefined}
          onClick={() => onNav("settings")}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            minHeight: 44,
            padding: "0 18px",
            fontSize: 13,
            textAlign: "left",
            cursor: "pointer",
            color: surface === "settings" ? tokens.text : tokens.textMuted,
            background: surface === "settings" ? tokens.selectedBg : "transparent",
            border: "none",
            borderLeft: `2px solid ${surface === "settings" ? tokens.accent : "transparent"}`,
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>
            settings
          </span>
          SETTINGS
        </button>
      </nav>
    </div>
  );
}

/** Dark/light switch, deliberately beside the search box: Konrad works
 *  outdoors and in sunlight the dark palette is unreadable, so this has to be
 *  reachable without digging through settings. Persists to localStorage and is
 *  re-applied before first paint (see app/layout.tsx). */
function ThemeToggle() {
  // Reads what the pre-paint script already applied, so the icon matches
  // reality on mount instead of assuming dark. This used to be a local
  // useState + one-shot effect; it is now the shared hook so that the toggle
  // and every value-consumer of the theme (today `<Excalidraw theme>` in
  // CanvasPane) read the SAME source — the `data-theme` attribute — rather
  // than two copies that can drift apart.
  const mode = useThemeMode();

  // No local state to update: `applyTheme` writes the attribute and the hook's
  // observer turns that into the re-render, here and in the canvas alike.
  const flip = () => applyTheme(mode === "dark" ? "light" : "dark");

  return (
    <button
      onClick={flip}
      className="mono"
      title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginLeft: 8,
        width: 34,
        height: 34,
        borderRadius: 7,
        cursor: "pointer",
        color: tokens.textMuted,
        background: "transparent",
        border: `1px solid ${tokens.borderEmphasis}`,
      }}
    >
      <span className="ms" style={{ fontSize: 16 }}>
        {mode === "dark" ? "light_mode" : "dark_mode"}
      </span>
    </button>
  );
}

function Group({
  children,
  divider,
}: {
  children: React.ReactNode;
  divider?: boolean;
}) {
  return (
    <>
      {divider && (
        <div
          style={{
            alignSelf: "center",
            width: 1,
            height: 14,
            background: tokens.borderEmphasis,
            margin: "0 14px",
          }}
        />
      )}
      {children}
    </>
  );
}

/* ============================================================================
 * Left rail
 * ========================================================================== */
function LeftRail({
  surface,
  onNav,
  badges,
  width,
}: {
  surface: Surface;
  onNav: (s: Surface) => void;
  badges: Record<string, string>;
  /** Owned by DesktopApp's useResizablePanel — the adjacent ResizeHandle
   *  also supplies the hairline this nav used to draw itself. */
  width: number;
}) {
  const railStyle = (key: Surface): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    height: 31,
    padding: "0 16px",
    cursor: "pointer",
    borderLeft: `2px solid ${surface === key ? tokens.accent : "transparent"}`,
    background: surface === key ? tokens.selectedBg : "transparent",
    color: surface === key ? tokens.text : tokens.textMuted,
  });
  const railGroups: { items: NavItem[]; badged?: boolean }[] = [
    { items: NAV.filter((n) => n.group === "operator") },
    { items: NAV.filter((n) => n.group === "work") },
    { items: NAV.filter((n) => n.group === "ai") },
    { items: NAV.filter((n) => n.group === "recall") },
  ];
  return (
    <nav
      style={{
        width,
        flex: "none",
        background: tokens.bgBody,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
        {railGroups.map((g, i) => (
          <div key={i}>
            {g.items.map((n) => (
              <div
                key={n.key}
                onClick={() => onNav(n.key)}
                style={railStyle(n.key)}
              >
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {n.label}
                </span>
                {n.unbuilt && (
                  <UnbuiltMark surfaceKey={n.key} size={9} variant="word" />
                )}
                <span style={{ flex: 1 }} />
                {badges[n.key] && (
                  <span
                    className="mono"
                    style={{ fontSize: 10.5, color: tokens.textFaint }}
                  >
                    {badges[n.key]}
                  </span>
                )}
              </div>
            ))}
            {i < railGroups.length - 1 && (
              <div
                style={{
                  height: 1,
                  background: tokens.borderDivider,
                  margin: "9px 16px",
                }}
              />
            )}
          </div>
        ))}
        <div
          style={{
            height: 1,
            background: tokens.borderDivider,
            margin: "9px 16px",
          }}
        />
        {/* Round 1350: a surface, not a route. This was a `next/link` to
            /settings, which unmounted the entire OS — rail, live panel, open
            chat — to show a centred document with a "back to OS" link where
            the app had been. Konrad: settings must open without losing the
            shell. It is now the same button every other NAV entry is, and
            /settings survives only as a bookmarkable wrapper around the same
            ConnectionsPanel the surface mounts. */}
        <div onClick={() => onNav("settings")} style={railStyle("settings")}>
          <span className="ms" style={{ fontSize: 15, marginRight: 8 }}>
            settings
          </span>
          <span className="mono" style={{ fontSize: 11.5 }}>
            SETTINGS
          </span>
        </div>
        {/* Businesses used to be its own /businesses route with a Link here.
            Konrad's 2026-08-04 feedback: unmounting the whole OS to reach
            it was jarring. It's now a surface (WORK group in NAV), and this
            standalone rail link is deliberately gone — the top nav + the
            WORK section of this rail both already carry BUSINESSES. */}
      </div>
      <div
        style={{
          flex: "none",
          borderTop: `1px solid ${tokens.borderSoft}`,
          padding: "10px 18px",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: tokens.accent,
          }}
        />
        <span
          className="mono"
          style={{ fontSize: 11.5, color: tokens.textBody }}
        >
          konrad
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 10, color: tokens.textGhost }}
        >
          online
        </span>
      </div>
    </nav>
  );
}

/* ============================================================================
 * Status bar
 * ========================================================================== */
function StatusBar({
  bleedCount,
  stuckCount,
  fleetStatus,
  onNav,
  onPalette,
}: {
  bleedCount: number;
  stuckCount: number;
  fleetStatus: "running" | "paused";
  onNav: (s: Surface) => void;
  onPalette: () => void;
}) {
  const fleetColor = fleetStatus === "paused" ? tokens.warn : tokens.ok;
  return (
    <div
      className="mono"
      style={{
        height: 28,
        flex: "none",
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        borderTop: `1px solid ${tokens.borderSoft}`,
        background: tokens.bgBody,
        fontSize: 11,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: tokens.accent,
          marginRight: 7,
        }}
      />
      <span style={{ color: tokens.textSecondary }}>65.108.6.149</span>
      <Sep />
      <span style={{ color: tokens.textMuted }}>
        forge <span style={{ color: tokens.ok }}>●</span>
      </span>
      <span style={{ color: tokens.textMuted, marginLeft: 12 }}>
        hermes <span style={{ color: tokens.ok }}>●</span>
      </span>
      <span style={{ flex: 1 }} />
      {/* THE indicator row — 5h, 7d, the open chat's context, and the Gemini
          tally. Exactly one of these exists in the app (round 1876); the copy
          that used to sit above the composer is gone. */}
      <QuotaRow />
      <Sep />
      <span
        onClick={() => onNav("autonomy")}
        style={{
          cursor: "pointer",
          padding: "3px 8px",
          borderRadius: 5,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={dot(fleetColor, fleetStatus === "running")} />
        <span style={{ color: fleetColor }}>
          {fleetStatus === "paused" ? "frozen" : "auto"}
        </span>
      </span>
      <Sep />
      <span
        onClick={() => onNav("inbox")}
        style={{
          color: tokens.bleed,
          cursor: "pointer",
          padding: "3px 8px",
          borderRadius: 5,
        }}
      >
        {bleedCount} bleed
      </span>
      <span
        onClick={() => onNav("inbox")}
        style={{
          color: tokens.stuck,
          cursor: "pointer",
          padding: "3px 8px",
          borderRadius: 5,
        }}
      >
        {stuckCount} stuck
      </span>
      <Sep />
      <span
        onClick={onPalette}
        style={{ color: tokens.textFaint, cursor: "pointer" }}
      >
        ⌘K
      </span>
    </div>
  );
}
function Sep() {
  return (
    <span style={{ color: tokens.borderEmphasis, margin: "0 12px" }}>·</span>
  );
}

/* ============================================================================
 * Command palette
 * ========================================================================== */
function CommandPalette({
  q,
  onChange,
  onClose,
  onNav,
}: {
  q: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onNav: (s: Surface) => void;
}) {
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    return NAV.filter((n) => !term || n.label.toLowerCase().includes(term));
  }, [q]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        paddingTop: "13vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 620,
          maxWidth: "92vw",
          maxHeight: "62vh",
          background: "#0c0c0e",
          border: `1px solid ${tokens.borderEmphasis}`,
          borderRadius: 11,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "15px 17px",
            borderBottom: `1px solid ${tokens.border}`,
          }}
        >
          <span className="mono" style={{ fontSize: 15, color: tokens.accent }}>
            ›
          </span>
          <input
            autoFocus
            value={q}
            onChange={(e) => onChange(e.target.value)}
            placeholder="search runs, jobs, workers, skills, actions, pages…"
            className="mono"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: tokens.text,
              fontSize: 13.5,
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "2px 6px",
            }}
          >
            esc
          </span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          <div
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textGhost,
              letterSpacing: "0.12em",
              padding: "10px 17px 4px",
            }}
          >
            PAGES
          </div>
          {matches.map((n) => (
            <div
              key={n.key}
              onClick={() => onNav(n.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 17px",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 21,
                  height: 21,
                  borderRadius: 5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: tokens.borderDivider,
                  flex: "none",
                }}
              >
                <span
                  className="ms"
                  style={{ fontSize: 14, color: tokens.textLabel }}
                >
                  arrow_forward
                </span>
              </span>
              <span style={{ fontSize: 12.5, color: tokens.textLabel }}>
                {n.label.toLowerCase()}
              </span>
            </div>
          ))}
          {matches.length === 0 && (
            <div
              className="mono"
              style={{
                padding: "24px 17px",
                fontSize: 12,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              no matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Surfaces
 * ========================================================================== */

import type { TodayResponse, LiveResponse, ControlResponse } from "../api";
import type { InboxItem as InboxItemUi } from "../data";

function TodaySurface({
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

/* ----------------------------------------------------------------------------
 * Inbox — 2-column split. v1.6 phase 3 splits the detail pane into its own
 * InboxDetail component that fetches /api/inbox/:id/preview for video player
 * + scene thumbs + stats grid, and the action row supports Deny-with-reason
 * inline. The `key={sel.id}` on InboxDetail resets reason/state on switch.
 * -------------------------------------------------------------------------- */
function InboxSurface({
  items,
  onResolve,
}: {
  items: InboxItemUi[];
  onResolve: (id: string, action_id?: string, reason?: string) => void;
}) {
  const [selId, setSelId] = useState<string | null>(items[0]?.id ?? null);
  const sel = items.find((i) => i.id === selId) ?? items[0] ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{
          width: 360,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 15px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}>
            Inbox
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.accent,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "2px 7px",
            }}
          >
            {items.length} open
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{ fontSize: 10, color: tokens.textFaint }}
          >
            manager-filtered
          </span>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {items.length === 0 ? (
            <div
              className="mono"
              style={{
                padding: "48px 24px",
                fontSize: 11.5,
                color: tokens.textFaint,
                textAlign: "center",
                lineHeight: 1.8,
              }}
            >
              inbox zero.
              <br />
              the manager is handling everything else.
            </div>
          ) : (
            items.map((i) => {
              const color = statusColor(i.status);
              const seld = i.id === sel?.id;
              return (
                <div
                  key={i.id}
                  onClick={() => setSelId(i.id)}
                  style={{
                    padding: "12px 15px",
                    cursor: "pointer",
                    borderBottom: `1px solid ${tokens.borderDivider}`,
                    borderLeft: `2px solid ${seld ? color : "transparent"}`,
                    background: seld ? tokens.selectedBg : "transparent",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      className="mono"
                      style={{ fontSize: 9, color, letterSpacing: "0.06em" }}
                    >
                      {i.type}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: tokens.textFaint }}
                    >
                      {i.age}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: seld ? tokens.text : tokens.textLabel,
                      marginTop: 6,
                      lineHeight: 1.42,
                    }}
                  >
                    {i.title}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {sel ? (
          <InboxDetail
            key={sel.id}
            item={sel}
            onResolve={(action_id, reason) =>
              onResolve(sel.id, action_id, reason)
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/* InboxDetail — fetches the preview payload (job + video + scenes + stats)
 * for the selected item and renders the rich card. Falls back to the lean
 * header-only view when no related_job_id is set (the preview returns
 * `{ job: null, video: null }`).
 *
 * Deny opens an inline reason input; Approve / Ack / Resolve fire onResolve
 * immediately. The action_id comes from the inbox item's `actions[]` array
 * — backend resolveInbox honours `resolution.reason` for HCP relay. */
function InboxDetail({
  item,
  onResolve,
}: {
  item: InboxItemUi;
  onResolve: (action_id?: string, reason?: string) => void;
}) {
  const previewQ = useQuery({
    queryKey: ["inbox-preview", item.id],
    queryFn: () => fetchInboxPreview(item.id),
  });
  const [denyMode, setDenyMode] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div
      className="slidein"
      style={{ maxWidth: 920, padding: "24px 30px 48px" }}
    >
      {/* Header — type pill + age */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          marginBottom: 16,
        }}
      >
        <span style={dot(statusColor(item.status), item.status === "BLEED")} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: statusColor(item.status),
            letterSpacing: "0.1em",
          }}
        >
          {item.type}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 10, color: tokens.textFaint }}
        >
          {item.age}
        </span>
      </div>

      <div
        style={{
          fontSize: 21,
          fontWeight: 500,
          letterSpacing: "-0.01em",
          color: tokens.textHi,
          lineHeight: 1.34,
          marginBottom: 10,
        }}
      >
        {item.title}
      </div>

      <div
        style={{
          fontSize: 13.5,
          color: tokens.textSecondary,
          lineHeight: 1.62,
          marginBottom: 24,
          maxWidth: 720,
        }}
      >
        {item.ask}
      </div>

      <InboxRichPreview previewQ={previewQ} />

      {item.tried.length > 0 && (
        <>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
              marginBottom: 11,
              marginTop: 26,
            }}
          >
            MANAGER TRIED — {item.tried.length} attempts before escalating
          </div>
          <div
            style={{
              borderLeft: `1px solid ${tokens.borderEmphasis}`,
              paddingLeft: 14,
              marginBottom: 26,
            }}
          >
            {item.tried.map((t, j) => (
              <div
                key={j}
                style={{ display: "flex", gap: 9, padding: "4px 0" }}
              >
                <span
                  className="ms"
                  style={{
                    fontSize: 13,
                    color: triedIconColor(t.icon),
                    marginTop: 1,
                  }}
                >
                  {t.icon}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: tokens.textSecondary,
                    lineHeight: 1.55,
                  }}
                >
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Action row — Deny opens inline reason input. */}
      {denyMode ? (
        <div
          style={{
            display: "flex",
            gap: 9,
            alignItems: "stretch",
            flexWrap: "wrap",
            marginTop: 18,
          }}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why are you denying? (rides back to Hermes as APPROVAL_DECISION.body.reason)"
            rows={2}
            autoFocus
            style={{
              flex: "1 1 360px",
              minWidth: 240,
              resize: "vertical",
              background: tokens.bgCard,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 6,
              padding: "8px 11px",
              color: tokens.text,
              fontSize: 12,
              fontFamily: "Inter, system-ui",
              outline: "none",
            }}
          />
          <div
            className="mono"
            style={{ ...actionStyle("danger"), opacity: reason.trim() ? 1 : 0.5 }}
            onClick={() => {
              if (!reason.trim()) return;
              onResolve("deny", reason.trim());
            }}
          >
            Send deny
          </div>
          <div
            className="mono"
            style={actionStyle("neutral")}
            onClick={() => {
              setDenyMode(false);
              setReason("");
            }}
          >
            Cancel
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 9,
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 18,
          }}
        >
          {item.actions.map((a, j) => {
            const isDeny =
              a.variant === "danger" || a.action_id?.toLowerCase() === "deny";
            return (
              <div
                key={j}
                className="mono"
                style={actionStyle(a.variant)}
                onClick={() => {
                  if (isDeny) {
                    setDenyMode(true);
                    return;
                  }
                  onResolve(a.action_id);
                }}
              >
                {a.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* The video player + scene strip + stats grid that the preview endpoint
 * fills in for AWAITING_QC / AWAITING_IMAGE_QC items. */
function InboxRichPreview({
  previewQ,
}: {
  previewQ: { data: InboxPreview | undefined; isLoading: boolean };
}) {
  const p = previewQ.data;
  if (previewQ.isLoading) {
    return (
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: tokens.textFaint,
          padding: "20px 0",
        }}
      >
        loading preview…
      </div>
    );
  }
  if (!p) return null;
  if (!p.job) {
    // Inbox item without a related job — render nothing extra; the lean
    // header above is enough for escalations / anomalies.
    return null;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.45fr) minmax(220px, 1fr)",
        gap: 18,
        marginBottom: 8,
      }}
    >
      {/* Left: video + scene strip. Falls back to a "render in progress"
          placeholder when the job exists but the asset isn't ready yet. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minWidth: 0,
        }}
      >
        {p.video ? (
          <video
            controls
            preload="metadata"
            playsInline
            poster={p.video.poster_url ?? undefined}
            src={`/api/proxy${p.video.url}`}
            style={{
              width: "100%",
              maxHeight: 420,
              borderRadius: 10,
              background: "#000",
              border: `1px solid ${tokens.borderEmphasis}`,
            }}
          />
        ) : (
          <div
            className="mono"
            style={{
              padding: "30px 18px",
              fontSize: 11,
              color: tokens.textFaint,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 10,
              textAlign: "center",
            }}
          >
            no rendered asset for this job yet
          </div>
        )}
        {p.scenes.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              overflowX: "auto",
              paddingBottom: 4,
            }}
          >
            {p.scenes.map((s) => (
              <div
                key={s.index}
                title={s.sentence ?? `scene ${s.index}`}
                style={{
                  flex: "none",
                  width: 96,
                  height: 54,
                  borderRadius: 4,
                  border: `1px solid ${tokens.borderDivider}`,
                  background: s.thumb_url
                    ? `url(/api/proxy${s.thumb_url}) center/cover`
                    : tokens.bgCard,
                  position: "relative",
                }}
              >
                <span
                  className="mono"
                  style={{
                    position: "absolute",
                    bottom: 2,
                    right: 4,
                    fontSize: 8.5,
                    padding: "1px 4px",
                    background: "rgba(0,0,0,0.6)",
                    color: "#fff",
                    borderRadius: 3,
                  }}
                >
                  {s.index}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: stats grid. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          minWidth: 220,
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 10,
          padding: "10px 12px",
          alignSelf: "start",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            paddingBottom: 6,
            marginBottom: 6,
            borderBottom: `1px solid ${tokens.borderDivider}`,
          }}
        >
          {p.job.status}
        </div>
        {p.stats.map((s, j) => (
          <div
            key={j}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "3px 0",
              fontSize: 11.5,
              color: tokens.textBody,
            }}
          >
            <span style={{ color: tokens.textFaint }}>{s.label}</span>
            <span className="mono" style={{ color: tokens.textLabel }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Live
 * -------------------------------------------------------------------------- */
function LiveSurface({ data }: { data: LiveResponse }) {
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

/* ----------------------------------------------------------------------------
 * Control plane (HACP)
 * -------------------------------------------------------------------------- */
function ControlSurface({
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

/* ----------------------------------------------------------------------------
 * Placeholder — the honest NOT BUILT state (round 300, R38/R39)
 *
 * Written for one reader: a tired operator at 23:00 who has just clicked GOALS.
 * He must walk away knowing NOBODY WROTE THIS, not wondering whether the API is
 * down. Everything here serves that and nothing else:
 *
 *   · WARNING TREATMENT, not a neutral card. `tokens.warn` on
 *     `tokens.freezeBgWarn` inside `tokens.freezeBorderWarn` — the same visual
 *     language the console already uses for a state that needs attention. Every
 *     colour is a token; scripts/checks/no-raw-colours.cjs fails the build on a
 *     literal, and it is right to.
 *   · THE WORDS, in prose, first. "not built yet" is a sentence a person reads,
 *     not a badge and not an icon — a badge is what the last version's tidy card
 *     needed and did not have.
 *   · ABOVE THE FOLD. The old version opened with 64px of top padding and put
 *     its first real sentence below a 25px title; at a 1280×600 window the
 *     honest part of the message was a scroll away, which is the same as absent.
 *     The banner is now the first thing in the box, and the after-verification
 *     asserts its BOUNDING BOX lies inside the initial viewport at 1280×800 and
 *     at 1280×600 — presence in the DOM is not the test.
 *   · NO FEATURE BULLETS. The list of three or four crisp capabilities is the
 *     exact thing Konrad read as a feature that failed to load. It is deleted,
 *     not demoted.
 *   · The `live in this build: …` caption that used to close this component is
 *     also gone. It was hardcoded on 2026-06-21, named five of the fourteen
 *     surfaces that render real components today, and told the operator in
 *     ghost grey that MEMORY and PIPELINE were not live — on the one screen
 *     whose job is to say what is not live. A hand-maintained list of built
 *     surfaces is a second source of truth that rots; the per-surface treatment
 *     below replaces its whole purpose.
 * -------------------------------------------------------------------------- */
function PlaceholderSurface({ info }: { info: PlaceholderCopy }) {
  const sections: { label: string; body: string }[] = [
    { label: "WHAT IT WOULD BE FOR", body: info.purpose },
    { label: "WHAT IT NEEDS IN ORDER TO EXIST", body: info.needs },
    { label: "WHETHER ANYONE IS COMING", body: info.scheduling },
  ];
  return (
    <div
      className="slidein"
      style={{ maxWidth: 720, margin: "0 auto", padding: "26px 40px 56px" }}
    >
      {/* The surface's own identity, so a test can tell WHICH placeholder it is
          looking at. The app has exactly one route (`/desktop`) and the surface
          is React state persisted to localStorage, so a screenshot cannot be
          identified by its URL and `body.innerText` begins with the nav chrome,
          not with this. */}
      <div
        data-placeholder-tag={info.tag}
        className="mono"
        style={{
          fontSize: 11,
          color: tokens.warn,
          letterSpacing: "0.12em",
          marginBottom: 10,
        }}
      >
        {info.tag}
      </div>
      <div
        data-placeholder-banner={info.state}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 13,
          background: tokens.freezeBgWarn,
          border: `1px solid ${tokens.freezeBorderWarn}`,
          borderRadius: 8,
          padding: "16px 18px",
          marginBottom: 26,
        }}
      >
        <span
          className="ms"
          style={{ fontSize: 21, color: tokens.warn, flex: "none" }}
        >
          {info.state === "unbuilt" ? "warning" : "link_off"}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 19,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              lineHeight: 1.35,
              color: tokens.warn,
            }}
          >
            {info.headline}
          </div>
          <div
            style={{
              fontSize: 13,
              color: tokens.textBody,
              lineHeight: 1.6,
              marginTop: 7,
            }}
          >
            {info.subhead}
          </div>
        </div>
      </div>
      {sections.map((s) => (
        <div key={s.label} style={{ marginBottom: 20 }}>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.1em",
              color: tokens.textGhost,
              marginBottom: 6,
            }}
          >
            {s.label}
          </div>
          <div
            style={{ fontSize: 13.5, color: tokens.textBody, lineHeight: 1.6 }}
          >
            {s.body}
          </div>
        </div>
      ))}
      <div
        className="mono"
        style={{ fontSize: 11, color: tokens.textGhost, lineHeight: 1.6 }}
      >
        the evidence, the rejected alternatives and the cost estimate:
        docs/plan/artifacts/os-usable-for-work/phase3/surface-determinations.md
      </div>
    </div>
  );
}
