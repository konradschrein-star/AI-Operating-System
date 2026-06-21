"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
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
  fetchLive,
  fetchControl,
  resolveInboxItem,
  freezeFleet,
  resumeFleet,
  emptyToday,
  emptyLive,
  emptyControl,
} from "../api";
import { MemorySurface } from "./MemorySurface";
import { ChatSurface } from "./ChatSurface";
import { SkillsSurface } from "./SkillsSurface";
import { PipelineSurface } from "./PipelineSurface";
import { AutonomySurface } from "./AutonomySurface";

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
  | "skills"
  | "memory"
  | "live"
  | "control"
  | "autonomy"
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
  { key: "tasks", label: "TASKS", group: "work" },
  { key: "pipeline", label: "PIPELINE", group: "work" },
  { key: "library", label: "LIBRARY", group: "work" },
  { key: "money", label: "MONEY", group: "work" },
  { key: "skills", label: "SKILLS", group: "ai" },
  { key: "memory", label: "MEMORY", group: "ai" },
  { key: "live", label: "LIVE", group: "ai" },
  { key: "control", label: "CONTROL", group: "ai" },
  { key: "autonomy", label: "AUTONOMY", group: "ai" },
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
      { icon: "token", label: "live token / spend panel" },
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
      { icon: "movie", label: "cards show progress + cost + ETA" },
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
  money: {
    tag: "MONEY",
    title: "Financial cockpit",
    desc: "Revenue, spend, net, runway — plus provider cost breakdown and a per-channel P&L ledger.",
    items: [
      { icon: "payments", label: "rev / spend / net / runway" },
      { icon: "show_chart", label: "revenue vs spend, 30 days" },
      { icon: "pie_chart", label: "provider cost breakdown" },
      { icon: "receipt_long", label: "per-job imputed cost ledger" },
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
  settings: {
    tag: "SETTINGS",
    title: "Appearance · Guardrails · Connectors",
    desc: "Theme + accent, the no-go rulebook, and external service connections.",
    items: [
      { icon: "palette", label: "theme + accent + density" },
      { icon: "shield", label: "guardrails (no-go rulebook)" },
      { icon: "cable", label: "service connectors" },
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
            />
          )}
          {surface === "inbox" && (
            <InboxSurface
              items={inboxQ.data ?? []}
              onResolve={(id, action_id) =>
                resolveInboxItem(id, {
                  resolved_by: "user",
                  action_id,
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
          {surface === "tasks" && <TasksSurface />}
          {surface === "memory" && <MemorySurface />}
          {surface === "chat" && <ChatSurface />}
          {surface === "skills" && <SkillsSurface />}
          {surface === "pipeline" && <PipelineSurface />}
          {surface === "autonomy" && <AutonomySurface />}
          {surface in PLACEHOLDER_SURFACES &&
            surface !== "memory" &&
            surface !== "chat" &&
            surface !== "skills" &&
            surface !== "pipeline" &&
            surface !== "autonomy" && (
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
    </div>
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
        <div onClick={() => onNav("settings")} style={railStyle("settings")}>
          <span className="ms" style={{ fontSize: 15, marginRight: 8 }}>
            settings
          </span>
          <span className="mono" style={{ fontSize: 11.5 }}>
            SETTINGS
          </span>
        </div>
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
}: {
  data: TodayResponse;
  inboxCount: number;
  onNav: (s: Surface) => void;
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
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textFaint,
              letterSpacing: "0.12em",
              marginBottom: 12,
            }}
          >
            NEEDS YOU
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
 * Inbox — 2-column split
 * -------------------------------------------------------------------------- */
function InboxSurface({
  items,
  onResolve,
}: {
  items: InboxItemUi[];
  onResolve: (id: string, action_id?: string) => void;
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
                    background: seld ? "#101013" : "transparent",
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
          <div
            className="slidein"
            style={{ maxWidth: 760, padding: "24px 30px 48px" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                marginBottom: 16,
              }}
            >
              <span
                style={dot(statusColor(sel.status), sel.status === "BLEED")}
              />
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: statusColor(sel.status),
                  letterSpacing: "0.1em",
                }}
              >
                {sel.type}
              </span>
              <span style={{ flex: 1 }} />
              <span
                className="mono"
                style={{ fontSize: 10, color: tokens.textFaint }}
              >
                {sel.age}
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
              {sel.title}
            </div>
            <div
              style={{
                fontSize: 13.5,
                color: tokens.textSecondary,
                lineHeight: 1.62,
                marginBottom: 24,
                maxWidth: 640,
              }}
            >
              {sel.ask}
            </div>

            {sel.tried.length > 0 && (
              <>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.textFaint,
                    letterSpacing: "0.1em",
                    marginBottom: 11,
                  }}
                >
                  MANAGER TRIED — {sel.tried.length} attempts before escalating
                </div>
                <div
                  style={{
                    borderLeft: `1px solid ${tokens.borderEmphasis}`,
                    paddingLeft: 14,
                    marginBottom: 26,
                  }}
                >
                  {sel.tried.map((t, j) => (
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

            <div
              style={{
                display: "flex",
                gap: 9,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {sel.actions.map((a, j) => (
                <div
                  key={j}
                  className="mono"
                  style={actionStyle(a.variant)}
                  onClick={() => onResolve(sel.id, a.action_id)}
                >
                  {a.label}
                </div>
              ))}
            </div>
          </div>
        ) : null}
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
 * Tasks — minimal until /api/tasks lands
 * -------------------------------------------------------------------------- */
function TasksSurface() {
  return (
    <div
      className="slidein"
      style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 40px 64px" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: tokens.textHi,
          }}
        >
          Tasks
        </span>
        <span
          className="mono"
          style={{ fontSize: 11, color: tokens.textMuted }}
        >
          long-running runs · dispatched, owned, tracked
        </span>
      </div>
      <div
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px dashed ${tokens.border}`,
          borderRadius: 10,
          padding: "32px 28px",
          fontSize: 12,
          color: tokens.textMuted,
          maxWidth: 760,
          lineHeight: 1.7,
        }}
      >
        <div
          style={{
            color: tokens.textHi,
            marginBottom: 10,
            fontFamily: "Inter, system-ui",
          }}
        >
          Runs surface — coming next
        </div>
        The runs table is provisioned (migration 0021), and forge-control will
        expose{" "}
        <span className="mono" style={{ color: tokens.accent }}>
          /api/tasks
        </span>{" "}
        next. Once the run executor is up, this surface will show:
        <ul style={{ marginTop: 12, paddingLeft: 18, color: tokens.textFaint }}>
          <li>filterable run list (active / stuck / queued / done / all)</li>
          <li>thread view: agent messages, tool calls, inter-agent → arrows</li>
          <li>STUCK banner with the manager-tried block</li>
          <li>run tree (parent + children) and per-provider cost</li>
        </ul>
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
