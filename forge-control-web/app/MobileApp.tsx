"use client";

import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "./tokens";
import {
  statusColor,
  tierColor,
  triedIconColor,
  decisionKindColor,
  loopColor,
  providerColor,
  liveStatColor,
  type InboxAction,
  type TabKey,
  type FleetWorker,
  type NeedsItem,
  type DecisionLogEntry,
} from "./data";
import {
  fetchToday,
  fetchInbox,
  fetchInboxPreview,
  fetchLive,
  fetchControl,
  resolveInboxItem,
  freezeFleet,
  resumeFleet,
  emptyToday,
  emptyLive,
  emptyControl,
} from "./api";

/* ----------------------------------------------------------------------------
 * Tab definitions
 * -------------------------------------------------------------------------- */
const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "today", label: "Today", icon: "wb_sunny" },
  { key: "inbox", label: "Inbox", icon: "inbox" },
  { key: "live", label: "Live", icon: "sensors" },
  { key: "control", label: "Control", icon: "tune" },
];

const actionStyle = (variant: InboxAction["variant"]): CSSProperties => {
  const base: CSSProperties = {
    fontSize: 11,
    borderRadius: 8,
    padding: "9px 0",
    flex: 1,
    textAlign: "center",
    cursor: "pointer",
    userSelect: "none",
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
    case "neutral":
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
export function MobileApp() {
  const [tab, setTab] = useState<TabKey>("today");
  const [inboxOpen, setInboxOpen] = useState<Record<string, boolean>>({});

  const qc = useQueryClient();
  const todayQ = useQuery({ queryKey: ["today"], queryFn: fetchToday });
  const inboxQ = useQuery({ queryKey: ["inbox"], queryFn: fetchInbox });
  const liveQ = useQuery({
    queryKey: ["live"],
    queryFn: fetchLive,
    enabled: tab === "live",
  });
  const controlQ = useQuery({
    queryKey: ["control"],
    queryFn: fetchControl,
    enabled: tab === "control" || tab === "today",
  });

  const fleetStatus = controlQ.data?.fleet.status ?? "running";
  const paused = fleetStatus === "paused";
  const fleetLabel = paused ? "frozen" : "auto";
  const fleetColor = paused ? tokens.warn : tokens.ok;

  const inboxData = inboxQ.data ?? [];
  const inboxCount = inboxData.length;

  const toggleInbox = (id: string) =>
    setInboxOpen((s) => ({ ...s, [id]: !s[id] }));

  const resolveM = useMutation({
    mutationFn: ({
      id,
      action_id,
      reason,
    }: {
      id: string;
      action_id?: string;
      reason?: string;
    }) => resolveInboxItem(id, { resolved_by: "user", action_id, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["today"] });
    },
  });

  const freezeM = useMutation({
    mutationFn: () => (paused ? resumeFleet("user") : freezeFleet("user")),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["control"] });
      qc.invalidateQueries({ queryKey: ["today"] });
    },
  });

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: tokens.bgBody,
        color: tokens.text,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* HEADER */}
      <div
        style={{
          flex: "none",
          paddingTop: "max(20px, env(safe-area-inset-top))",
          paddingLeft: 18,
          paddingRight: 18,
          paddingBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: `1px solid ${tokens.borderSoft}`,
          background: tokens.bgBody,
        }}
      >
        <div
          style={{
            width: 15,
            height: 15,
            borderRadius: 4,
            background: tokens.accent,
          }}
        />
        <span
          style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}
        >
          forge
        </span>
        <span style={{ flex: 1 }} />
        <div
          onClick={() => setTab("control")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: `1px solid ${tokens.borderEmphasis}`,
            borderRadius: 999,
            padding: "5px 11px",
            cursor: "pointer",
          }}
        >
          <span style={dot(fleetColor, !paused)} />
          <span className="mono" style={{ fontSize: 11, color: fleetColor }}>
            {fleetLabel}
          </span>
        </div>
        <span
          className="ms"
          style={{ fontSize: 22, color: tokens.textMuted, cursor: "pointer" }}
        >
          search
        </span>
      </div>

      {/* SCREENS */}
      <div
        className="scroll"
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}
      >
        {tab === "today" && (
          <TodayScreen
            data={todayQ.data ?? emptyToday}
            onChip={(t) => setTab(t)}
            onInbox={() => setTab("inbox")}
          />
        )}
        {tab === "inbox" && (
          <InboxScreen
            items={inboxData}
            isLoading={inboxQ.isLoading}
            inboxOpen={inboxOpen}
            onToggle={toggleInbox}
            onResolve={(id, action_id, reason) =>
              resolveM.mutate({ id, action_id, reason })
            }
          />
        )}
        {tab === "live" && <LiveScreen data={liveQ.data ?? emptyLive} />}
        {tab === "control" && (
          <ControlScreen
            data={controlQ.data ?? emptyControl}
            onCycle={() => freezeM.mutate()}
          />
        )}
      </div>

      {/* BOTTOM TAB BAR */}
      <div
        className="safe-bottom"
        style={{
          flex: "none",
          display: "flex",
          borderTop: `1px solid ${tokens.borderSoft}`,
          background: tokens.bgTabBar,
          padding: "8px 6px 0",
        }}
      >
        {TABS.map((t) => {
          const on = tab === t.key;
          const color = on ? tokens.accent : tokens.textMuted2;
          const badge =
            t.key === "inbox" && inboxCount > 0 ? String(inboxCount) : "";
          return (
            <div
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                padding: "6px 0",
                position: "relative",
                cursor: "pointer",
              }}
            >
              <span className="ms" style={{ fontSize: 23, color }}>
                {t.icon}
              </span>
              <span className="mono" style={{ fontSize: 9, color }}>
                {t.label}
              </span>
              {badge && (
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    right: "50%",
                    marginRight: -22,
                    minWidth: 15,
                    height: 15,
                    borderRadius: 8,
                    background: tokens.bleed,
                    color: "#fff",
                    fontSize: 9,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 4px",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {badge}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * TODAY
 * -------------------------------------------------------------------------- */
import type { TodayResponse } from "./api";

function TodayScreen({
  data,
  onChip,
  onInbox,
}: {
  data: TodayResponse;
  onChip: (k: TabKey) => void;
  onInbox: () => void;
}) {
  return (
    <div className="slidein" style={{ padding: "18px 18px 28px" }}>
      <div style={{ fontSize: 13, color: tokens.textMuted }}>{data.date}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          marginTop: 4,
          lineHeight: 1.25,
        }}
      >
        {data.greeting}
      </div>

      {data.chips.length > 0 && (
        <div
          style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}
        >
          {data.chips.map((c, i) => {
            const color =
              c.type === "NORMAL" ? tokens.textLabel : statusColor(c.type);
            return (
              <div
                key={i}
                onClick={() => onChip(c.goto)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 999,
                  padding: "7px 13px",
                  cursor: "pointer",
                }}
              >
                <span
                  style={dot(
                    c.type === "NORMAL" ? tokens.accent : color,
                    c.animate,
                  )}
                />
                <span className="mono" style={{ fontSize: 12, color }}>
                  {c.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <SectionLabel>NEEDS YOU</SectionLabel>
      {data.needs.length === 0 && (
        <EmptyHint>nothing waiting on you.</EmptyHint>
      )}
      {data.needs.map((n: NeedsItem, i: number) => {
        const color = statusColor(n.status);
        return (
          <div
            key={i}
            onClick={onInbox}
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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
      })}

      <SectionLabel>FLEET</SectionLabel>
      {data.fleet.length === 0 ? (
        <EmptyHint>no workers reporting in.</EmptyHint>
      ) : (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
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

      <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
        <StatCard
          label="SPEND TODAY"
          value={data.spend.value}
          sub={data.spend.cap}
          color={tokens.info}
        />
        <StatCard
          label="SHIPPED"
          value={data.shipped.value}
          sub={data.shipped.pipeline}
          color={tokens.ok}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * INBOX
 * -------------------------------------------------------------------------- */
function InboxScreen({
  items,
  isLoading,
  inboxOpen,
  onToggle,
  onResolve,
}: {
  items: import("./data").InboxItem[];
  isLoading: boolean;
  inboxOpen: Record<string, boolean>;
  onToggle: (id: string) => void;
  onResolve: (id: string, action_id?: string, reason?: string) => void;
}) {
  return (
    <div className="slidein" style={{ padding: "18px 18px 28px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 9,
          marginBottom: 16,
        }}
      >
        <span
          style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}
        >
          Inbox
        </span>
        <span className="mono" style={{ fontSize: 12, color: tokens.accent }}>
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

      {items.map((i) => (
        <InboxCardMobile
          key={i.id}
          item={i}
          openTried={!!inboxOpen[i.id]}
          onToggleTried={() => onToggle(i.id)}
          onResolve={(action_id, reason) => onResolve(i.id, action_id, reason)}
        />
      ))}

      {items.length === 0 && !isLoading && (
        <div
          className="mono"
          style={{
            padding: "60px 20px",
            textAlign: "center",
            color: tokens.textFaint,
            fontSize: 12,
            lineHeight: 1.9,
          }}
        >
          inbox zero.
          <br />
          the manager is handling everything else.
        </div>
      )}
      {items.length === 0 && isLoading && (
        <div
          className="mono"
          style={{
            padding: "60px 20px",
            textAlign: "center",
            color: tokens.textFaint,
            fontSize: 12,
          }}
        >
          loading…
        </div>
      )}
    </div>
  );
}

/* InboxCardMobile — one card per item. Owns its own preview query, tried
 * toggle, and deny-with-reason state. v1.6 phase 3. */
function InboxCardMobile({
  item,
  openTried,
  onToggleTried,
  onResolve,
}: {
  item: import("./data").InboxItem;
  openTried: boolean;
  onToggleTried: () => void;
  onResolve: (action_id?: string, reason?: string) => void;
}) {
  const previewQ = useQuery({
    queryKey: ["inbox-preview", item.id],
    queryFn: () => fetchInboxPreview(item.id),
  });
  const [denyMode, setDenyMode] = useState(false);
  const [reason, setReason] = useState("");

  const color = statusColor(item.status);
  const isBleed = item.status === "BLEED";
  const hasTried = item.tried.length > 0;
  const p = previewQ.data;
  const showRich = p && p.job;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 14,
        padding: 15,
        marginBottom: 11,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 9,
        }}
      >
        <span style={dot(color, isBleed)} />
        <span
          className="mono"
          style={{ fontSize: 9.5, color, letterSpacing: "0.06em" }}
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
          fontSize: 15,
          fontWeight: 500,
          color: tokens.textHi,
          lineHeight: 1.35,
        }}
      >
        {item.title}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: tokens.textSecondary,
          lineHeight: 1.55,
          marginTop: 7,
        }}
      >
        {item.ask}
      </div>

      {/* Rich preview block (mobile-stacked). Only renders when the inbox
          item has a related_job_id and the JOIN found a job. */}
      {showRich && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {p!.video ? (
            <video
              controls
              preload="metadata"
              playsInline
              poster={p!.video.poster_url ?? undefined}
              src={`/api/proxy${p!.video.url}`}
              style={{
                width: "100%",
                maxHeight: 240,
                borderRadius: 10,
                background: "#000",
                border: `1px solid ${tokens.borderEmphasis}`,
              }}
            />
          ) : (
            <div
              className="mono"
              style={{
                padding: "18px 12px",
                fontSize: 11,
                color: tokens.textFaint,
                border: `1px dashed ${tokens.border}`,
                borderRadius: 10,
                textAlign: "center",
              }}
            >
              no rendered asset yet
            </div>
          )}
          {p!.scenes.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 5,
                overflowX: "auto",
                paddingBottom: 2,
              }}
            >
              {p!.scenes.map((s) => (
                <div
                  key={s.index}
                  style={{
                    flex: "none",
                    width: 72,
                    height: 40,
                    borderRadius: 4,
                    border: `1px solid ${tokens.borderDivider}`,
                    background: s.thumb_url
                      ? `url(/api/proxy${s.thumb_url}) center/cover`
                      : tokens.bgCard,
                  }}
                />
              ))}
            </div>
          )}
          {p!.stats.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "3px 14px",
                fontSize: 11,
                color: tokens.textBody,
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              {p!.stats.map((s, j) => (
                <div
                  key={j}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span style={{ color: tokens.textFaint }}>{s.label}</span>
                  <span className="mono" style={{ color: tokens.textLabel }}>
                    {s.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        onClick={() => hasTried && onToggleTried()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginTop: 11,
          cursor: hasTried ? "pointer" : "default",
        }}
      >
        <span className="ms" style={{ fontSize: 14, color: tokens.decide }}>
          {hasTried ? "unfold_more" : "check_circle"}
        </span>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: tokens.decide }}
        >
          {hasTried
            ? `Manager tried ${item.tried.length} things`
            : "No remedy needed — your call"}
        </span>
      </div>

      {hasTried && openTried && (
        <div
          style={{
            borderLeft: `1px solid ${tokens.borderEmphasis}`,
            paddingLeft: 12,
            marginTop: 10,
          }}
        >
          {item.tried.map((t, j) => (
            <div
              key={j}
              style={{ display: "flex", gap: 8, padding: "3px 0" }}
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
                  lineHeight: 1.5,
                }}
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Action row — Deny opens inline reason textarea. */}
      {denyMode ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 13,
          }}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why are you denying?"
            rows={2}
            autoFocus
            style={{
              width: "100%",
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
          <div style={{ display: "flex", gap: 8 }}>
            <div
              className="mono"
              style={{
                ...actionStyle("danger"),
                opacity: reason.trim() ? 1 : 0.5,
                flex: 1,
                textAlign: "center",
              }}
              onClick={() => {
                if (!reason.trim()) return;
                onResolve("deny", reason.trim());
              }}
            >
              Send deny
            </div>
            <div
              className="mono"
              style={{ ...actionStyle("neutral"), textAlign: "center" }}
              onClick={() => {
                setDenyMode(false);
                setReason("");
              }}
            >
              Cancel
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
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

/* ----------------------------------------------------------------------------
 * LIVE
 * -------------------------------------------------------------------------- */
import type { LiveResponse } from "./api";

function LiveScreen({ data }: { data: LiveResponse }) {
  return (
    <div className="slidein" style={{ padding: "18px 18px 28px" }}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          marginBottom: 16,
        }}
      >
        Live
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 9,
          marginBottom: 20,
        }}
      >
        {data.stats.map((s, i) => (
          <div
            key={i}
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 12,
              padding: "13px 15px",
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 9, color: tokens.textFaint }}
            >
              {s.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 20,
                color: liveStatColor(s.tone),
                marginTop: 6,
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <SectionLabel>DEGRADATION · per service</SectionLabel>
      {data.degradation.length === 0 ? (
        <EmptyHint>no service degradation reported.</EmptyHint>
      ) : (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
            overflow: "hidden",
            marginBottom: 20,
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

      <SectionLabel>PROVIDERS</SectionLabel>
      {data.providers.length === 0 ? (
        <EmptyHint>no providers configured.</EmptyHint>
      ) : (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
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
  );
}

/* ----------------------------------------------------------------------------
 * CONTROL
 * -------------------------------------------------------------------------- */
import type { ControlResponse } from "./api";

function ControlScreen({
  data,
  onCycle,
}: {
  data: ControlResponse;
  onCycle: () => void;
}) {
  const paused = data.fleet.status === "paused";
  const freezeColor = paused ? tokens.warn : tokens.ok;
  const freezeIcon = paused ? "ac_unit" : "bolt";
  const freezeTitle = paused ? "Fleet is FROZEN" : "Fleet is running";
  const freezeDesc = paused
    ? "Every worker is held. No new dispatch until you resume."
    : "Dispatching autonomously within your trust levels and policies.";
  const freezeAction = paused ? "Resume fleet" : "FREEZE ALL";

  return (
    <div className="slidein" style={{ padding: "18px 18px 28px" }}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          marginBottom: 16,
        }}
      >
        Control
      </div>

      <div
        onClick={onCycle}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          borderRadius: 18,
          padding: "24px 20px",
          border: `1.5px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
          background: paused ? tokens.freezeBgWarn : tokens.freezeBgOk,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span className="ms" style={{ fontSize: 40, color: freezeColor }}>
          {freezeIcon}
        </span>
        <div
          style={{
            fontSize: 19,
            fontWeight: 700,
            color: freezeColor,
            marginTop: 10,
          }}
        >
          {freezeTitle}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: tokens.textSecondary,
            lineHeight: 1.5,
            marginTop: 6,
            maxWidth: 240,
          }}
        >
          {freezeDesc}
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 15,
            fontWeight: 700,
            borderRadius: 11,
            padding: "13px 32px",
            color: paused ? tokens.freezeBgOk : tokens.freezeBgWarn,
            background: paused ? tokens.ok : tokens.warn,
          }}
        >
          {freezeAction}
        </div>
      </div>

      <SectionLabel>FEEDBACK LOOPS</SectionLabel>
      {data.loops.length === 0 ? (
        <EmptyHint>no loops fired yet.</EmptyHint>
      ) : (
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {data.loops.map((l, i) => {
            const color = loopColor(l.tone);
            const animate = l.tone === "error" || l.tone === "warn";
            const isLast = i === data.loops.length - 1;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "11px 15px",
                  borderBottom: isLast
                    ? "none"
                    : `1px solid ${tokens.borderDivider}`,
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: 12, color, width: 24 }}
                >
                  {l.id}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: tokens.textLabel }}>
                    {l.name}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: tokens.textFaint,
                      marginTop: 2,
                    }}
                  >
                    {l.cadence}
                  </div>
                </div>
                <span style={dot(color, animate)} />
                <span
                  className="mono"
                  style={{ fontSize: 9.5, color: tokens.textFaint }}
                >
                  {l.last}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: tokens.invariantBg,
          border: `1px solid ${tokens.invariantBorder}`,
          borderRadius: 12,
          padding: "13px 15px",
          marginTop: 14,
        }}
      >
        <span className="ms" style={{ fontSize: 18, color: tokens.bleed }}>
          lock
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: tokens.text, fontWeight: 500 }}>
            {data.invariant.label}
          </div>
          <div
            className="mono"
            style={{ fontSize: 10, color: tokens.textMuted, marginTop: 2 }}
          >
            {data.invariant.sub}
          </div>
        </div>
      </div>

      <SectionLabel>DECISION LOG</SectionLabel>
      {data.decisionLog.length === 0 ? (
        <EmptyHint>nothing decided yet.</EmptyHint>
      ) : (
        <div
          style={{ borderLeft: `1px solid ${tokens.border}`, paddingLeft: 13 }}
        >
          {data.decisionLog.map((d: DecisionLogEntry, i: number) => (
            <div
              key={i}
              style={{
                padding: "7px 0",
                borderBottom:
                  i === data.decisionLog.length - 1
                    ? "none"
                    : `1px solid ${tokens.bgGutter}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
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
                  color: tokens.textSecondary,
                  marginTop: 3,
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
  );
}

/* ----------------------------------------------------------------------------
 * Shared bits
 * -------------------------------------------------------------------------- */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10,
        color: tokens.textFaint,
        letterSpacing: "0.1em",
        margin: "24px 0 11px",
      }}
    >
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: "13px 15px",
      }}
    >
      <div className="mono" style={{ fontSize: 9, color: tokens.textFaint }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 19, color, marginTop: 6 }}>
        {value}
      </div>
      <div
        className="mono"
        style={{ fontSize: 9, color: tokens.textFaint, marginTop: 3 }}
      >
        {sub}
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        background: tokens.bgCard,
        border: `1px dashed ${tokens.border}`,
        borderRadius: 12,
        padding: "20px 15px",
        textAlign: "center",
        fontSize: 11,
        color: tokens.textFaint,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
