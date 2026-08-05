"use client";

import Link from "next/link";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot, applyTheme, type ThemeMode } from "../tokens";
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
  fetchQuota,
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
import { ProjectsSurface } from "./ProjectsSurface";
import { BusinessesSurface } from "./BusinessesSurface";
import { AgentActivity } from "./live/AgentActivity";

/* ----------------------------------------------------------------------------
 * Surface keys — match the design's surface routing
 * -------------------------------------------------------------------------- */
type Surface =
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

interface NavItem {
  key: Surface;
  label: string;
  badge?: string;
  group: "operator" | "work" | "ai" | "recall";
}

const NAV: NavItem[] = [
  { key: "today", label: "TODAY", group: "operator" },
  { key: "inbox", label: "INBOX", group: "operator" },
  { key: "chat", label: "CHAT", group: "operator" },
  { key: "tasks", label: "PROJECTS", group: "work" },
  { key: "pipeline", label: "PIPELINE", group: "work" },
  { key: "library", label: "LIBRARY", group: "work" },
  { key: "money", label: "MONEY", group: "work" },
  { key: "businesses", label: "BUSINESSES", group: "work" },
  { key: "skills", label: "SKILLS", group: "ai" },
  { key: "memory", label: "MEMORY", group: "ai" },
  { key: "live", label: "LIVE", group: "ai" },
  { key: "control", label: "CONTROL", group: "ai" },
  { key: "autonomy", label: "AUTONOMY", group: "ai" },
  { key: "automation", label: "AUTOMATION", group: "ai" },
  { key: "goals", label: "GOALS", group: "recall" },
  { key: "journal", label: "JOURNAL", group: "recall" },
  { key: "map", label: "MAP", group: "recall" },
];

const PLACEHOLDER_SURFACES: Record<
  string,
  {
    tag: string;
    title: string;
    desc: string;
    items: { icon: string; label: string }[];
  }
> = {
  chat: {
    tag: "CHAT",
    title: "Conversations with the fleet",
    desc: "Run-aware threads. Each conversation can dispatch runs, call tools, invoke skills, and watch state — with inter-agent messages rendered inline.",
    items: [
      { icon: "forum", label: "thread list, per-run pinning" },
      { icon: "token", label: "live token panel" },
      { icon: "extension", label: "tools + skills registry sidebar" },
      { icon: "arrow_outward", label: "inter-agent message blocks" },
    ],
  },
  pipeline: {
    tag: "PIPELINE",
    title: "Kanban over the ~40 states",
    desc: "The state machine collapsed into Backlog → Scripting → Production → QMS → Approval → Published with WIP caps.",
    items: [
      { icon: "view_kanban", label: "6 columns with WIP guards" },
      { icon: "movie", label: "cards show progress + ETA" },
      { icon: "open_in_new", label: "click → run detail in Tasks" },
    ],
  },
  library: {
    tag: "LIBRARY",
    title: "Assets & drafts",
    desc: "Scripts, voices, images, clips, templates — a dense filterable grid.",
    items: [
      { icon: "description", label: "scripts" },
      { icon: "graphic_eq", label: "voices" },
      { icon: "image", label: "images" },
      { icon: "dashboard", label: "templates" },
    ],
  },
  skills: {
    tag: "SKILLS",
    title: "Every skill the fleet can call",
    desc: "Skill.md files become first-class. Pin, edit, sandbox, promote from memory, attach permissions.",
    items: [
      { icon: "extension", label: "enable / disable per skill" },
      { icon: "science", label: "sandbox test runs" },
      { icon: "shield", label: "risk + permission badges" },
      { icon: "history", label: "recent invocations + score" },
    ],
  },
  memory: {
    tag: "MEMORY",
    title: "The fleet brain",
    desc: "Rules, preferences, facts, people, projects. Confidence, provenance, backlinks. Editable, forgettable, promotable to skills.",
    items: [
      { icon: "hub", label: "Obsidian vault, live-synced" },
      { icon: "link", label: "backlinks + linked mentions" },
      { icon: "fact_check", label: "confidence + stale flagging" },
      { icon: "fork_right", label: "promote belief → skill" },
    ],
  },
  autonomy: {
    tag: "AUTONOMY",
    title: "Trust dials + dispatch policy",
    desc: "Per channel and per skill autonomy levels: observe → suggest → auto-capped → full. Plus the no-go rulebook enforced at dispatch.",
    items: [
      { icon: "tune", label: "trust dial per channel / skill" },
      { icon: "rule", label: "policy rules, toggleable" },
      { icon: "history", label: "autonomous actions feed" },
    ],
  },
  goals: {
    tag: "GOALS",
    title: "What I'm trying to do",
    desc: "Quarter cards, week list, today mirror.",
    items: [
      { icon: "flag", label: "quarter objectives" },
      { icon: "list", label: "this week" },
      { icon: "today", label: "today mirror" },
    ],
  },
  journal: {
    tag: "JOURNAL",
    title: "What happened",
    desc: "Auto-logged day-by-day. Every inbox resolution recorded as a decision.",
    items: [
      { icon: "calendar_month", label: "day calendar strip" },
      { icon: "gavel", label: "decisions log" },
      { icon: "notes", label: "auto-written entries" },
    ],
  },
  map: {
    tag: "MAP",
    title: "Where everything lives",
    desc: "Services, domains, storage, providers, channels — and what runs them.",
    items: [
      { icon: "lan", label: "services + systemd" },
      { icon: "language", label: "domains" },
      { icon: "database", label: "storage" },
      { icon: "cloud", label: "providers" },
    ],
  },
  search: {
    tag: "SEARCH",
    title: "Search the vault, runs, workers, skills, decisions",
    desc: "Routing hypervisor picks vector / grep / BM25 / SQL per query.",
    items: [
      { icon: "search", label: "multi-engine routing" },
      { icon: "description", label: "vault hits" },
      { icon: "conveyor_belt", label: "live runs" },
      { icon: "bolt", label: "skills + workers + inbox items" },
    ],
  },
};

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
  const [surface, setSurface] = useState<Surface>("today");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");

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
  });

  const clearNeedsM = useMutation({
    mutationFn: clearAllInbox,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
    },
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
        onNav={setSurface}
        onPalette={() => {
          setPaletteOpen(true);
          setPaletteQ("");
        }}
        badges={inboxBadges}
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LeftRail surface={surface} onNav={setSurface} badges={inboxBadges} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            background: tokens.bgBody,
          }}
        >
          {surface === "today" && (
            <TodaySurface
              data={todayQ.data ?? emptyToday}
              inboxCount={inboxCount}
              onNav={setSurface}
              onClearNeeds={() => clearNeedsM.mutate()}
              clearingNeeds={clearNeedsM.isPending}
            />
          )}
          {surface === "inbox" && (
            <InboxSurface
              items={inboxQ.data ?? []}
              onResolve={(id, action_id, reason) =>
                resolveInboxItem(id, {
                  resolved_by: "user",
                  action_id,
                  reason,
                }).then(() => {
                  qc.invalidateQueries({ queryKey: ["inbox"] });
                  qc.invalidateQueries({ queryKey: ["today"] });
                })
              }
            />
          )}
          {surface === "live" && <LiveSurface data={liveQ.data ?? emptyLive} />}
          {surface === "control" && (
            <ControlSurface
              data={controlQ.data ?? emptyControl}
              onFreeze={() => freezeM.mutate()}
            />
          )}
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
          {surface === "businesses" && <BusinessesSurface />}
          {surface in PLACEHOLDER_SURFACES &&
            surface !== "memory" &&
            surface !== "chat" &&
            surface !== "skills" &&
            surface !== "pipeline" &&
            surface !== "autonomy" &&
            surface !== "automation" &&
            surface !== "businesses" && (
              <PlaceholderSurface info={PLACEHOLDER_SURFACES[surface]} />
            )}
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
    </div>
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
}: {
  surface: Surface;
  onNav: (s: Surface) => void;
  onPalette: () => void;
  badges: Record<string, string>;
}) {
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
          paddingRight: 20,
        }}
      >
        <div
          style={{
            width: 11,
            height: 15,
            background: tokens.accent,
            borderRadius: 2,
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
      </div>
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
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
          minWidth: 172,
        }}
      >
        <span className="ms" style={{ fontSize: 14, color: tokens.textFaint }}>
          search
        </span>
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
      </div>
      <ThemeToggle />
    </div>
  );
}

/** Dark/light switch, deliberately beside the search box: Konrad works
 *  outdoors and in sunlight the dark palette is unreadable, so this has to be
 *  reachable without digging through settings. Persists to localStorage and is
 *  re-applied before first paint (see app/layout.tsx). */
function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("dark");

  // Read what the pre-paint script already applied, so the icon matches
  // reality on mount instead of assuming dark.
  useEffect(() => {
    setMode(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  const flip = () => {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    setMode(next);
    applyTheme(next);
  };

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
}: {
  surface: Surface;
  onNav: (s: Surface) => void;
  badges: Record<string, string>;
}) {
  const railStyle = (key: Surface): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    height: 31,
    padding: "0 16px",
    cursor: "pointer",
    borderLeft: `2px solid ${surface === key ? tokens.accent : "transparent"}`,
    background: surface === key ? "#141417" : "transparent",
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
        width: 184,
        flex: "none",
        borderRight: `1px solid ${tokens.borderSoft}`,
        background: tokens.bgBody,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
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
        {/* A real route, not a surface toggle: /settings is its own page.
            Every other entry in this rail is still client-side tab state. */}
        <Link
          href="/settings"
          style={{
            ...railStyle("settings"),
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <span className="ms" style={{ fontSize: 15, marginRight: 8 }}>
            settings
          </span>
          <span className="mono" style={{ fontSize: 11.5 }}>
            SETTINGS
          </span>
        </Link>
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
      <QuotaBars />
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
/** Subscription quota gauges — the 5-hour and 7-day windows, measured (not
 *  guessed) from Anthropic's OAuth usage endpoint.
 *
 *  Deliberately NOT live: it polls slowly and shows how old the reading is,
 *  with a manual refresh — Konrad's own framing ("it doesn't even have to be
 *  live, just add a refresh button and say when it was last refreshed"). A
 *  gauge that silently goes stale is worse than one that admits its age. */
function QuotaBars() {
  const q = useQuery({
    queryKey: ["usage", "quota"],
    queryFn: () => fetchQuota(false),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await fetchQuota(true);
      qc.setQueryData(["usage", "quota"], fresh);
    } finally {
      setRefreshing(false);
    }
  };

  // Re-render each minute so "3m ago" stays truthful between polls.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const d = q.data;
  if (!d) return null;

  const age = (iso: string) => {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
  };
  const resetIn = (iso: string | null) => {
    if (!iso) return "";
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "resetting";
    const m = Math.round(ms / 60000);
    return m < 60 ? `resets ${m}m` : `resets ${Math.round(m / 60)}h`;
  };

  const Bar = ({ label, w }: { label: string; w: { utilization: number | null; resets_at: string | null } }) => {
    const pct = w.utilization ?? 0;
    // Colour by pressure, not by brand — the point is to notice at a glance.
    const color = pct >= 90 ? tokens.bleed : pct >= 70 ? tokens.warn : tokens.ok;
    return (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
        title={`${label}: ${pct}% used${w.resets_at ? ` · ${resetIn(w.resets_at)}` : ""}`}
      >
        <span style={{ color: tokens.textFaint }}>{label}</span>
        <span
          style={{
            width: 46,
            height: 5,
            borderRadius: 3,
            background: tokens.borderEmphasis,
            overflow: "hidden",
            display: "inline-block",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${Math.min(100, Math.max(0, pct))}%`,
              height: "100%",
              background: color,
            }}
          />
        </span>
        <span style={{ color }}>{w.utilization == null ? "—" : `${Math.round(pct)}%`}</span>
      </span>
    );
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <Bar label="5h" w={d.five_hour} />
      <Bar label="7d" w={d.seven_day} />
      {/* The refresh control is ALWAYS rendered, including on error. It used
          to be swallowed by the failure state, so a single 429 left the bars
          stuck on "last refresh failed" with nothing to click. */}
      <span
        onClick={() => void refresh()}
        title={
          d.error
            ? `${d.error} — click to try again`
            : `quota updated ${age(d.fetched_at)} — click to refresh`
        }
        style={{
          cursor: refreshing ? "wait" : "pointer",
          color: d.error ? tokens.warn : tokens.textGhost,
          opacity: refreshing ? 0.5 : 1,
        }}
      >
        {refreshing ? "⟳ …" : d.error ? "⟳ retry" : `⟳ ${age(d.fetched_at)}`}
      </span>
    </span>
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
 * Placeholder — for unbuilt surfaces (chat, memory, skills, kanban, etc.)
 * -------------------------------------------------------------------------- */
function PlaceholderSurface({
  info,
}: {
  info: {
    tag: string;
    title: string;
    desc: string;
    items: { icon: string; label: string }[];
  };
}) {
  return (
    <div
      className="slidein"
      style={{ maxWidth: 720, margin: "0 auto", padding: "64px 40px" }}
    >
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: tokens.accent,
          letterSpacing: "0.12em",
          marginBottom: 12,
        }}
      >
        {info.tag}
      </div>
      <div
        style={{
          fontSize: 25,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          marginBottom: 11,
          color: tokens.textHi,
        }}
      >
        {info.title}
      </div>
      <div
        style={{
          fontSize: 14,
          color: tokens.textMuted,
          lineHeight: 1.65,
          marginBottom: 28,
        }}
      >
        {info.desc}
      </div>
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {info.items.map((it, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 16px",
              borderBottom:
                i === info.items.length - 1
                  ? "none"
                  : `1px solid ${tokens.borderDivider}`,
            }}
          >
            <span
              className="ms"
              style={{ fontSize: 15, color: tokens.textFaint }}
            >
              {it.icon}
            </span>
            <span style={{ fontSize: 13, color: tokens.textBody }}>
              {it.label}
            </span>
          </div>
        ))}
      </div>
      <div
        className="mono"
        style={{ fontSize: 11, color: tokens.textGhost, marginTop: 18 }}
      >
        live in this build: chrome · command palette · today · inbox · live ·
        control · tasks
      </div>
    </div>
  );
}
