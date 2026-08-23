"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  statusColor,
  triedIconColor,
  type InboxAction,
  type InboxItem as InboxItemUi,
} from "../data";
import {
  createReminder,
  dismissReminder,
  fetchControl,
  fetchInbox,
  fetchInboxHistory,
  fetchInboxPreview,
  fetchLive,
  fetchReminders,
  resolveInboxItem,
  type ControlResponse,
  type InboxHistoryItem,
  type InboxPreview,
  type LiveResponse,
  type Reminder,
} from "../api";
import { toast, toastError } from "./_ui/Toasts";
import type { Surface } from "./nav-items";

/* ----------------------------------------------------------------------------
 * Helper: Safe Media Proxy URL Generator
 *
 * Immunizes against double "/api" prefixing.
 * Next.js rewrites `/api/proxy/:path*` to `http://127.0.0.1:7700/api/:path*`.
 * If backend sends `/media/job/...` or `/api/media/job/...`, this safely
 * produces `/api/proxy/media/job/...` which hits Hono on port 7700 at `/api/media/job/...`.
 * -------------------------------------------------------------------------- */
export function mediaProxyUrl(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl) return undefined;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const clean = rawUrl.replace(/^\/?(?:api\/)?/, "");
  return `/api/proxy/${clean}`;
}

/* ----------------------------------------------------------------------------
 * Filter Tabs Definition
 * -------------------------------------------------------------------------- */
export type InboxTab = "all" | "urgent" | "qc" | "reminders" | "history";

/* ----------------------------------------------------------------------------
 * Action button styling using design tokens only
 * -------------------------------------------------------------------------- */
const actionStyle = (variant: InboxAction["variant"]): CSSProperties => {
  const base: CSSProperties = {
    fontSize: 11.5,
    borderRadius: 6,
    padding: "7px 13px",
    cursor: "pointer",
    userSelect: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    transition: "background 0.15s, border-color 0.15s",
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
        background: tokens.toolBg,
      };
  }
};

/* ----------------------------------------------------------------------------
 * Props
 * -------------------------------------------------------------------------- */
export interface InboxSurfaceProps {
  items?: InboxItemUi[];
  onResolve?: (id: string, action_id?: string, reason?: string) => void | Promise<void>;
  onNav?: (s: Surface) => void;
}

/* ----------------------------------------------------------------------------
 * Main InboxSurface Component
 * -------------------------------------------------------------------------- */
export function InboxSurface({
  items: initialItems,
  onResolve: propsOnResolve,
  onNav,
}: InboxSurfaceProps) {
  const qc = useQueryClient();

  // 1. Auto-refresh polling: 10s refetch interval for live queue
  const inboxQ = useQuery({
    queryKey: ["inbox"],
    queryFn: fetchInbox,
    refetchInterval: 10_000,
  });

  // State
  const [tab, setTab] = useState<InboxTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(Date.now());
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Queries for System Pulse & History
  const historyQ = useQuery({
    queryKey: ["inbox-history"],
    queryFn: () => fetchInboxHistory(50),
    enabled: tab === "history" || (inboxQ.data?.length ?? 0) === 0,
    refetchInterval: tab === "history" ? 15_000 : 30_000,
  });

  const liveQ = useQuery({
    queryKey: ["live"],
    queryFn: fetchLive,
    refetchInterval: 15_000,
  });

  const controlQ = useQuery({
    queryKey: ["control"],
    queryFn: fetchControl,
    refetchInterval: 15_000,
  });

  const remindersQ = useQuery({
    queryKey: ["reminders"],
    queryFn: fetchReminders,
    refetchInterval: 30_000,
  });

  // Active open items (prioritize query data with fallback to initial prop)
  const openItems = useMemo<InboxItemUi[]>(() => {
    return inboxQ.data ?? initialItems ?? [];
  }, [inboxQ.data, initialItems]);

  // Tab counts
  const urgentCount = useMemo(
    () => openItems.filter((i) => i.status === "BLEED" || i.status === "STUCK").length,
    [openItems],
  );
  const qcCount = useMemo(
    () =>
      openItems.filter(
        (i) =>
          i.type === "APPROVAL" ||
          i.type === "QC" ||
          i.status === "APPROVE" ||
          Boolean((i as unknown as { related_job_id?: string }).related_job_id),
      ).length,
    [openItems],
  );
  const remindersCount = useMemo(
    () =>
      openItems.filter(
        (i) =>
          i.type === "REMINDER" ||
          i.status === "DECIDE" ||
          i.status === "NORMAL",
      ).length,
    [openItems],
  );
  const historyCount = historyQ.data?.length ?? 0;

  // Filter items based on active tab
  const tabItems = useMemo<InboxItemUi[] | InboxHistoryItem[]>(() => {
    if (tab === "history") {
      return historyQ.data ?? [];
    }
    switch (tab) {
      case "urgent":
        return openItems.filter(
          (i) => i.status === "BLEED" || i.status === "STUCK",
        );
      case "qc":
        return openItems.filter(
          (i) =>
            i.type === "APPROVAL" ||
            i.type === "QC" ||
            i.status === "APPROVE" ||
            Boolean((i as unknown as { related_job_id?: string }).related_job_id),
        );
      case "reminders":
        return openItems.filter(
          (i) =>
            i.type === "REMINDER" ||
            i.status === "DECIDE" ||
            i.status === "NORMAL",
        );
      case "all":
      default:
        return openItems;
    }
  }, [tab, openItems, historyQ.data]);

  // Apply instant search filter
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tabItems;
    return tabItems.filter((item) => {
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchAsk = item.ask?.toLowerCase().includes(q) ?? false;
      const matchType = item.type.toLowerCase().includes(q);
      const matchStatus = item.status.toLowerCase().includes(q);
      const histItem = item as InboxHistoryItem;
      const matchResolvedBy = histItem.resolved_by?.toLowerCase().includes(q) ?? false;
      return matchTitle || matchAsk || matchType || matchStatus || matchResolvedBy;
    });
  }, [tabItems, searchQuery]);

  // Synchronize selection ID when list changes
  useEffect(() => {
    if (filteredItems.length === 0) {
      setSelId(null);
    } else if (!selId || !filteredItems.some((i) => i.id === selId)) {
      setSelId(filteredItems[0].id);
    }
  }, [filteredItems, selId]);

  // Selected item reference
  const selectedItem = useMemo(() => {
    if (!selId) return null;
    return filteredItems.find((i) => i.id === selId) ?? null;
  }, [filteredItems, selId]);

  // 5. Selection Preservation on Item Resolution
  const handleResolve = useCallback(
    async (itemId: string, actionId?: string, reason?: string) => {
      const currentIndex = filteredItems.findIndex((i) => i.id === itemId);
      const remaining = filteredItems.filter((i) => i.id !== itemId);

      if (remaining.length === 0) {
        setSelId(null);
      } else {
        const nextIndex = Math.min(currentIndex, remaining.length - 1);
        setSelId(remaining[nextIndex].id);
      }

      try {
        if (propsOnResolve) {
          await propsOnResolve(itemId, actionId, reason);
        } else {
          await resolveInboxItem(itemId, {
            resolved_by: "user",
            action_id: actionId,
            reason,
          });
          qc.invalidateQueries({ queryKey: ["inbox"] });
          qc.invalidateQueries({ queryKey: ["today"] });
          qc.invalidateQueries({ queryKey: ["inbox-history"] });
          qc.invalidateQueries({ queryKey: ["control"] });
        }
        toast("Resolved inbox item", "ok", actionId ? `Action: ${actionId}` : undefined);
      } catch (err: unknown) {
        toastError("Couldn't resolve inbox item", err);
        qc.invalidateQueries({ queryKey: ["inbox"] });
      }
    },
    [filteredItems, propsOnResolve, qc],
  );

  // Manual sync / refresh
  const handleRefresh = useCallback(() => {
    void inboxQ.refetch();
    void historyQ.refetch();
    void liveQ.refetch();
    void controlQ.refetch();
    void remindersQ.refetch();
    setLastRefreshedAt(Date.now());
    toast("Synced inbox queue", "info");
  }, [inboxQ, historyQ, liveQ, controlQ, remindersQ]);

  // 4. Keyboard Navigation (j/k/ArrowUp/ArrowDown, a: approve, d: deny, e: done, /: search, r: refresh, 1-5: tabs)
  const [denyTriggeredId, setDenyTriggeredId] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isInput =
        activeTag === "input" ||
        activeTag === "textarea" ||
        activeTag === "select" ||
        Boolean((document.activeElement as HTMLElement | null)?.isContentEditable);

      if (e.key === "Escape") {
        if (isInput) {
          (document.activeElement as HTMLElement)?.blur();
        }
        if (searchQuery) {
          setSearchQuery("");
        }
        if (denyTriggeredId) {
          setDenyTriggeredId(null);
        }
        return;
      }

      if (isInput) return;

      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "r" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleRefresh();
        return;
      }

      // Tab switcher 1-5
      if (["1", "2", "3", "4", "5"].includes(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const tabMap: Record<string, InboxTab> = {
          "1": "all",
          "2": "urgent",
          "3": "qc",
          "4": "reminders",
          "5": "history",
        };
        setTab(tabMap[e.key]);
        return;
      }

      if (filteredItems.length === 0) return;

      const currentIdx = filteredItems.findIndex((i) => i.id === selId);

      // j / ArrowDown -> next
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const nextIdx = currentIdx < filteredItems.length - 1 ? currentIdx + 1 : 0;
        setSelId(filteredItems[nextIdx].id);
        return;
      }

      // k / ArrowUp -> previous
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : filteredItems.length - 1;
        setSelId(filteredItems[prevIdx].id);
        return;
      }

      if (tab === "history" || !selectedItem) return;

      // a: Approve / Primary action
      if (e.key === "a" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const primaryAction =
          selectedItem.actions.find(
            (act) =>
              act.variant === "ok" ||
              act.variant === "primary" ||
              act.action_id?.toLowerCase() === "approve" ||
              act.label.toLowerCase().includes("approve"),
          ) ?? selectedItem.actions[0];
        if (primaryAction) {
          void handleResolve(selectedItem.id, primaryAction.action_id);
        }
        return;
      }

      // e: Done / Resolve action
      if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const doneAction =
          selectedItem.actions.find(
            (act) =>
              act.action_id?.toLowerCase() === "resolve" ||
              act.label.toLowerCase().includes("done") ||
              act.label.toLowerCase().includes("resolve"),
          ) ?? selectedItem.actions[0];
        if (doneAction) {
          void handleResolve(selectedItem.id, doneAction.action_id);
        }
        return;
      }

      // d: Deny action
      if (e.key === "d" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setDenyTriggeredId(selectedItem.id);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    filteredItems,
    selId,
    selectedItem,
    tab,
    searchQuery,
    denyTriggeredId,
    handleRefresh,
    handleResolve,
  ]);

  // Relative time since last sync
  const secondsAgo = Math.max(0, Math.floor((Date.now() - lastRefreshedAt) / 1000));
  const syncLabel =
    secondsAgo < 5
      ? "Synced just now"
      : secondsAgo < 60
        ? `Synced ${secondsAgo}s ago`
        : `Synced ${Math.floor(secondsAgo / 60)}m ago`;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        background: tokens.bgBody,
      }}
    >
      {/* ----------------------------------------------------------------------
       * Left Column: Triage Rail (380px)
       * -------------------------------------------------------------------- */}
      <div
        style={{
          width: 380,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: tokens.bgTabBar,
        }}
      >
        {/* Header Section */}
        <div
          style={{
            padding: "12px 14px 10px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Top Title & Sync Bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: tokens.textHi }}>
              Inbox
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: urgentCount > 0 ? tokens.bleed : tokens.accent,
                border: `1px solid ${urgentCount > 0 ? tokens.dangerActionBorder : tokens.borderEmphasis}`,
                background: urgentCount > 0 ? tokens.dangerActionBg : tokens.toolBg,
                borderRadius: 5,
                padding: "2px 7px",
              }}
            >
              {openItems.length} open
            </span>

            <span style={{ flex: 1 }} />

            {/* Sync telemetry pulse & refresh button */}
            <span
              className="mono"
              title="Auto-refreshes every 10 seconds"
              style={{
                fontSize: 9.5,
                color: tokens.textFaint,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                style={dot(inboxQ.isFetching ? tokens.accent : tokens.ok, inboxQ.isFetching)}
              />
              {syncLabel}
            </span>

            <button
              onClick={handleRefresh}
              title="Refresh queue (r)"
              style={{
                background: "transparent",
                border: `1px solid ${tokens.border}`,
                borderRadius: 4,
                color: tokens.textMuted,
                cursor: "pointer",
                padding: "3px 6px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                className="ms"
                style={{
                  fontSize: 12,
                  display: "inline-block",
                  transform: inboxQ.isFetching ? "rotate(180deg)" : "none",
                  transition: "transform 0.3s ease",
                }}
              >
                refresh
              </span>
            </button>
          </div>

          {/* Segmented Filter Tabs */}
          <div
            style={{
              display: "flex",
              background: tokens.bgBody,
              padding: 2,
              borderRadius: 6,
              border: `1px solid ${tokens.borderSoft}`,
              gap: 2,
            }}
          >
            {(
              [
                { id: "all", label: "All", count: openItems.length, urgent: false },
                { id: "urgent", label: "Urgent", count: urgentCount, urgent: true },
                { id: "qc", label: "QC", count: qcCount, urgent: false },
                { id: "reminders", label: "Notes", count: remindersCount, urgent: false },
                { id: "history", label: "History", count: historyCount, urgent: false },
              ] as const
            ).map((t) => {
              const active = tab === t.id;
              const hasUrgent = Boolean(t.urgent && t.count > 0);
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    flex: 1,
                    background: active ? tokens.bgCard : "transparent",
                    border: `1px solid ${active ? tokens.borderEmphasis : "transparent"}`,
                    borderRadius: 4,
                    padding: "4px 2px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    color: active
                      ? tokens.textHi
                      : hasUrgent
                        ? tokens.bleed
                        : tokens.textMuted,
                    fontSize: 10.5,
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  <span>{t.label}</span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: hasUrgent
                        ? tokens.bleed
                        : active
                          ? tokens.text
                          : tokens.textGhost,
                      fontWeight: hasUrgent || active ? 600 : 400,
                    }}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Instant Search Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: tokens.inputBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "4px 8px",
              gap: 6,
            }}
          >
            <span className="ms" style={{ fontSize: 13, color: tokens.textGhost }}>
              search
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter items... (/)"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: tokens.text,
                fontSize: 11.5,
                flex: 1,
                fontFamily: "inherit",
              }}
            />
            {searchQuery ? (
              <button
                onClick={() => setSearchQuery("")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: tokens.textGhost,
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 11,
                }}
              >
                ✕
              </button>
            ) : (
              <span
                className="mono"
                style={{
                  fontSize: 9,
                  color: tokens.textGhost,
                  border: `1px solid ${tokens.border}`,
                  padding: "1px 4px",
                  borderRadius: 3,
                }}
              >
                /
              </span>
            )}
          </div>
        </div>

        {/* Item List Area */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {/* Loading Skeleton */}
          {inboxQ.isLoading && openItems.length === 0 ? (
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  style={{
                    height: 64,
                    background: tokens.toolBg,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    opacity: 0.6,
                  }}
                />
              ))}
            </div>
          ) : inboxQ.isError && openItems.length === 0 ? (
            /* Error State */
            <div style={{ padding: "36px 20px", textAlign: "center" }}>
              <div
                style={{
                  color: tokens.bleed,
                  fontSize: 12,
                  fontWeight: 500,
                  marginBottom: 6,
                }}
              >
                Failed to load inbox
              </div>
              <div style={{ color: tokens.textFaint, fontSize: 11, marginBottom: 14 }}>
                {String(inboxQ.error)}
              </div>
              <button
                onClick={() => void inboxQ.refetch()}
                style={{ ...actionStyle("primary"), fontSize: 11 }}
              >
                Retry
              </button>
            </div>
          ) : filteredItems.length === 0 ? (
            /* Empty State for current tab */
            <div
              style={{
                padding: "48px 20px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: tokens.freezeBgOk,
                  border: `1px solid ${tokens.freezeBorderOk}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: tokens.ok,
                }}
              >
                <span className="ms" style={{ fontSize: 18 }}>
                  check
                </span>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: tokens.textMuted,
                  lineHeight: 1.6,
                }}
              >
                {searchQuery
                  ? "No items match your filter"
                  : tab === "urgent"
                    ? "No urgent anomalies or bleeds"
                    : tab === "qc"
                      ? "No content assets awaiting review"
                      : tab === "reminders"
                        ? "No personal reminders waiting"
                        : tab === "history"
                          ? "No resolved history recorded yet"
                          : "Inbox zero. Systems healthy."}
              </div>
              {(searchQuery || tab !== "all") && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setTab("all");
                  }}
                  style={{
                    background: tokens.toolBg,
                    border: `1px solid ${tokens.border}`,
                    color: tokens.textSecondary,
                    borderRadius: 4,
                    padding: "4px 10px",
                    fontSize: 10.5,
                    cursor: "pointer",
                    marginTop: 4,
                  }}
                >
                  Show all open items
                </button>
              )}
            </div>
          ) : (
            /* Populated Items */
            filteredItems.map((i) => {
              const isHist = tab === "history";
              const histItem = isHist ? (i as InboxHistoryItem) : null;
              const color = statusColor(i.status);
              const seld = i.id === selId;
              const isBleed = i.status === "BLEED";

              return (
                <div
                  key={i.id}
                  onClick={() => setSelId(i.id)}
                  style={{
                    padding: "10px 14px",
                    cursor: "pointer",
                    borderBottom: `1px solid ${tokens.borderDivider}`,
                    borderLeft: `2.5px solid ${seld ? color : "transparent"}`,
                    background: seld ? tokens.selectedBg : "transparent",
                    transition: "background 0.1s ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={dot(color, isBleed)} />
                    <span
                      className="mono"
                      style={{
                        fontSize: 9,
                        color,
                        fontWeight: 600,
                        letterSpacing: "0.06em",
                      }}
                    >
                      {i.type}
                    </span>

                    <span style={{ flex: 1 }} />

                    {isHist && histItem ? (
                      <span
                        className="mono"
                        style={{
                          fontSize: 9,
                          color: tokens.textGhost,
                          background: tokens.toolBg,
                          padding: "1px 5px",
                          borderRadius: 3,
                        }}
                      >
                        by {histItem.resolved_by ?? "user"}
                      </span>
                    ) : (
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: tokens.textFaint }}
                      >
                        {i.age}
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: seld ? 500 : 400,
                      color: seld ? tokens.textHi : tokens.textLabel,
                      marginTop: 5,
                      lineHeight: 1.4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {i.title}
                  </div>

                  {/* Inline quick-action button on selection for open items */}
                  {!isHist && seld && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 8,
                        paddingTop: 6,
                        borderTop: `1px dashed ${tokens.borderSoft}`,
                      }}
                    >
                      <span className="mono" style={{ fontSize: 9, color: tokens.textGhost }}>
                        Quick resolve:
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const primary =
                            i.actions.find(
                              (a) =>
                                a.variant === "ok" ||
                                a.variant === "primary" ||
                                a.action_id?.toLowerCase() === "approve",
                            ) ?? i.actions[0];
                          void handleResolve(i.id, primary?.action_id);
                        }}
                        style={{
                          background: tokens.okActionBg,
                          border: `1px solid ${tokens.okActionBorder}`,
                          color: tokens.ok,
                          borderRadius: 4,
                          padding: "2px 7px",
                          fontSize: 9.5,
                          cursor: "pointer",
                        }}
                      >
                        ✓ Done (e)
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer: Keyboard Navigation Hints */}
        <div
          style={{
            padding: "8px 12px",
            borderTop: `1px solid ${tokens.borderSoft}`,
            background: tokens.bgBody,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textGhost,
              letterSpacing: "0.02em",
            }}
          >
            ↑/↓/j/k move · a approve · d deny · e done · / search · 1-5 tabs
          </span>
        </div>
      </div>

      {/* ----------------------------------------------------------------------
       * Right Column: Detail & Execution Pane (Flex 1)
       * -------------------------------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", background: tokens.bgBody }}>
        {tab === "history" && selectedItem ? (
          <InboxHistoryDetail
            key={selectedItem.id}
            item={selectedItem as InboxHistoryItem}
          />
        ) : selectedItem ? (
          <InboxDetail
            key={selectedItem.id}
            item={selectedItem}
            denyModeTriggered={denyTriggeredId === selectedItem.id}
            onResolve={(action_id, reason) =>
              handleResolve(selectedItem.id, action_id, reason)
            }
          />
        ) : (
          /* 3. Executive System Pulse Dashboard on Inbox Zero */
          <ExecutiveSystemPulse
            openCount={openItems.length}
            urgentCount={urgentCount}
            resolvedCount={historyCount}
            liveData={liveQ.data}
            controlData={controlQ.data}
            reminders={remindersQ.data ?? []}
            onViewHistory={() => setTab("history")}
            onRefreshTelemetry={handleRefresh}
            onNav={onNav}
          />
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Active Item Detail View (`InboxDetail`)
 * -------------------------------------------------------------------------- */
function InboxDetail({
  item,
  denyModeTriggered,
  onResolve,
}: {
  item: InboxItemUi;
  denyModeTriggered?: boolean;
  onResolve: (action_id?: string, reason?: string) => void;
}) {
  const previewQ = useQuery({
    queryKey: ["inbox-preview", item.id],
    queryFn: () => fetchInboxPreview(item.id),
  });

  const [denyMode, setDenyMode] = useState(denyModeTriggered ?? false);
  const [reason, setReason] = useState("");
  const denyInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (denyModeTriggered) {
      setDenyMode(true);
    }
  }, [denyModeTriggered]);

  useEffect(() => {
    if (denyMode) {
      denyInputRef.current?.focus();
    }
  }, [denyMode]);

  const color = statusColor(item.status);
  const isBleed = item.status === "BLEED";

  return (
    <div
      className="slidein"
      style={{ maxWidth: 960, padding: "24px 32px 48px", minHeight: "100%" }}
    >
      {/* Header — type pill + age + status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <span style={dot(color, isBleed)} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            color,
            letterSpacing: "0.08em",
            fontWeight: 600,
          }}
        >
          {item.type}
        </span>

        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textMuted,
            background: tokens.toolBg,
            padding: "2px 6px",
            borderRadius: 4,
            border: `1px solid ${tokens.borderSoft}`,
          }}
        >
          {item.status}
        </span>

        <span style={{ flex: 1 }} />

        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {item.age}
        </span>
      </div>

      {/* Main Title */}
      <div
        style={{
          fontSize: 21,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: tokens.textHi,
          lineHeight: 1.34,
          marginBottom: 12,
        }}
      >
        {item.title}
      </div>

      {/* The Ask Block */}
      <div
        style={{
          fontSize: 13.5,
          color: tokens.textSecondary,
          lineHeight: 1.62,
          marginBottom: 24,
          maxWidth: 780,
          whiteSpace: "pre-wrap",
        }}
      >
        {item.ask}
      </div>

      {/* 1. Safe Rich Preview (Video Player + Scene Thumbnails + Stats Grid) */}
      <InboxRichPreview previewQ={previewQ} />

      {/* Manager Tried section */}
      {item.tried && item.tried.length > 0 && (
        <div style={{ marginTop: 24, marginBottom: 24 }}>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
              marginBottom: 10,
            }}
          >
            MANAGER TRIED — {item.tried.length} attempts before escalating
          </div>
          <div
            style={{
              borderLeft: `2px solid ${tokens.borderEmphasis}`,
              paddingLeft: 14,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {item.tried.map((t, j) => (
              <div key={j} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
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
        </div>
      )}

      {/* Action Row — Deny opens inline reason textarea */}
      <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${tokens.borderSoft}` }}>
        {denyMode ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 8,
              padding: 14,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 10.5, color: tokens.bleed, fontWeight: 600 }}
            >
              DENY WITH OPERATOR REASON (rides back to autonomous agent)
            </div>
            <textarea
              ref={denyInputRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you denying? Provide context for the worker to adapt strategy..."
              rows={3}
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
            <div style={{ display: "flex", gap: 9 }}>
              <button
                className="mono"
                style={{
                  ...actionStyle("danger"),
                  opacity: reason.trim() ? 1 : 0.5,
                  cursor: reason.trim() ? "pointer" : "not-allowed",
                }}
                onClick={() => {
                  if (!reason.trim()) return;
                  onResolve("deny", reason.trim());
                }}
              >
                Send Deny Payload
              </button>
              <button
                className="mono"
                style={actionStyle("neutral")}
                onClick={() => {
                  setDenyMode(false);
                  setReason("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {item.actions.map((a, j) => {
              const isDeny =
                a.variant === "danger" || a.action_id?.toLowerCase() === "deny";
              const isApprove =
                a.variant === "primary" ||
                a.action_id?.toLowerCase() === "approve" ||
                a.label.toLowerCase().includes("approve");
              const isDone =
                a.variant === "ok" ||
                a.action_id?.toLowerCase() === "resolve" ||
                a.label.toLowerCase().includes("done");

              return (
                <button
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
                  <span>{a.label}</span>
                  <span style={{ fontSize: 9.5, opacity: 0.6 }}>
                    {isApprove ? "(a)" : isDone ? "(e)" : isDeny ? "(d)" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * History Detail View (`InboxHistoryDetail`)
 * -------------------------------------------------------------------------- */
function InboxHistoryDetail({ item }: { item: InboxHistoryItem }) {
  const previewQ = useQuery({
    queryKey: ["inbox-preview", item.id],
    queryFn: () => fetchInboxPreview(item.id),
  });

  const formattedResolvedAt = item.resolved_at
    ? new Date(item.resolved_at).toLocaleString("de-DE", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : item.age;

  const resolutionAction =
    (item.resolution?.action_id as string | undefined) ?? "resolved";
  const resolutionReason =
    (item.resolution?.reason as string | undefined) ?? null;

  return (
    <div
      className="slidein"
      style={{ maxWidth: 960, padding: "24px 32px 48px", minHeight: "100%" }}
    >
      {/* Header Badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.ok,
            background: tokens.freezeBgOk,
            border: `1px solid ${tokens.freezeBorderOk}`,
            borderRadius: 4,
            padding: "2px 7px",
            fontWeight: 600,
          }}
        >
          ✓ RESOLVED
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textMuted,
            letterSpacing: "0.08em",
          }}
        >
          {item.type}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          Resolved at {formattedResolvedAt}
        </span>
      </div>

      {/* Main Title */}
      <div
        style={{
          fontSize: 21,
          fontWeight: 600,
          color: tokens.textHi,
          lineHeight: 1.34,
          marginBottom: 12,
        }}
      >
        {item.title}
      </div>

      {/* Resolution Audit Box */}
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 10, color: tokens.textFaint, letterSpacing: "0.06em" }}
        >
          RESOLUTION AUDIT TRAIL
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
          <div>
            <span style={{ color: tokens.textFaint, marginRight: 6 }}>Resolved by:</span>
            <span
              className="mono"
              style={{
                color: tokens.accent,
                background: tokens.toolBg,
                padding: "2px 6px",
                borderRadius: 4,
                border: `1px solid ${tokens.borderSoft}`,
              }}
            >
              {item.resolved_by ?? "user"}
            </span>
          </div>
          <div>
            <span style={{ color: tokens.textFaint, marginRight: 6 }}>Action:</span>
            <span className="mono" style={{ color: tokens.textHi, fontWeight: 500 }}>
              {resolutionAction}
            </span>
          </div>
        </div>

        {resolutionReason && (
          <div
            style={{
              marginTop: 6,
              padding: "8px 12px",
              background: tokens.toolBg,
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 6,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textFaint, marginBottom: 4 }}
            >
              RECORDED REASON / PAYLOAD:
            </div>
            <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.5 }}>
              {resolutionReason}
            </div>
          </div>
        )}
      </div>

      {/* Original Ask */}
      <div
        style={{
          fontSize: 13,
          color: tokens.textSecondary,
          lineHeight: 1.6,
          marginBottom: 20,
          whiteSpace: "pre-wrap",
        }}
      >
        {item.ask}
      </div>

      {/* Preview if any */}
      <InboxRichPreview previewQ={previewQ} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 1. Safe Rich Preview Component (Video Player + Scene Scrubber + Stats Grid)
 * -------------------------------------------------------------------------- */
function InboxRichPreview({
  previewQ,
}: {
  previewQ: { data: InboxPreview | undefined; isLoading: boolean };
}) {
  const p = previewQ.data;
  const videoRef = useRef<HTMLVideoElement>(null);

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

  if (!p || !p.job) {
    return null;
  }

  const safeVideoUrl = mediaProxyUrl(p.video?.url);
  const safePosterUrl = mediaProxyUrl(p.video?.poster_url);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.45fr) minmax(220px, 1fr)",
        gap: 18,
        marginBottom: 16,
      }}
    >
      {/* Left: Video Player + Scene Scrubber Strip */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minWidth: 0,
        }}
      >
        {p.video && safeVideoUrl ? (
          <video
            ref={videoRef}
            controls
            preload="metadata"
            playsInline
            poster={safePosterUrl}
            src={safeVideoUrl}
            style={{
              width: "100%",
              maxHeight: 420,
              borderRadius: 8,
              background: tokens.bgBody,
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
              borderRadius: 8,
              textAlign: "center",
              background: tokens.toolBg,
            }}
          >
            no rendered asset for this job yet
          </div>
        )}

        {/* Scene Scrubber Strip */}
        {p.scenes.length > 0 && (
          <div>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textFaint,
                marginBottom: 6,
                letterSpacing: "0.06em",
              }}
            >
              SCENE STRIP — {p.scenes.length} frames (click to scrub)
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                overflowX: "auto",
                paddingBottom: 6,
              }}
            >
              {p.scenes.map((s, idx) => {
                const safeThumb = mediaProxyUrl(s.thumb_url);
                return (
                  <div
                    key={s.index ?? idx}
                    onClick={() => {
                      if (videoRef.current && typeof s.duration_sec === "number") {
                        const targetTime = idx * (s.duration_sec || 3);
                        videoRef.current.currentTime = targetTime;
                        void videoRef.current.play().catch(() => {});
                      }
                    }}
                    title={s.sentence ?? `Scene ${s.index}`}
                    style={{
                      flex: "none",
                      width: 96,
                      height: 54,
                      borderRadius: 4,
                      border: `1px solid ${tokens.borderDivider}`,
                      background: safeThumb
                        ? `url(${safeThumb}) center/cover`
                        : tokens.bgCard,
                      position: "relative",
                      cursor: "pointer",
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
                        background: tokens.overlay,
                        color: tokens.textHi,
                        borderRadius: 3,
                      }}
                    >
                      {s.index}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Right: Technical Stats Grid */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          minWidth: 220,
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          padding: "12px 14px",
          alignSelf: "start",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.accent,
            fontWeight: 600,
            letterSpacing: "0.06em",
            paddingBottom: 8,
            marginBottom: 8,
            borderBottom: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>JOB METADATA</span>
          <span style={{ color: tokens.ok }}>{p.job.status}</span>
        </div>

        {p.stats.map((s, j) => (
          <div
            key={j}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "4px 0",
              fontSize: 11.5,
              borderBottom: `1px dashed ${tokens.borderDivider}`,
            }}
          >
            <span style={{ color: tokens.textFaint }}>{s.label}</span>
            <span className="mono" style={{ color: tokens.textSecondary }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * 3. Executive System Pulse Dashboard (Inbox Zero View)
 * -------------------------------------------------------------------------- */
function ExecutiveSystemPulse({
  openCount,
  urgentCount,
  resolvedCount,
  liveData,
  controlData,
  reminders,
  onViewHistory,
  onRefreshTelemetry,
  onNav,
}: {
  openCount: number;
  urgentCount: number;
  resolvedCount: number;
  liveData: LiveResponse | undefined;
  controlData: ControlResponse | undefined;
  reminders: Reminder[];
  onViewHistory: () => void;
  onRefreshTelemetry: () => void;
  onNav?: (s: Surface) => void;
}) {
  const qc = useQueryClient();
  const [quickText, setQuickText] = useState("");
  const [quickWhen, setQuickWhen] = useState("in 2h");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateReminder = async () => {
    if (!quickText.trim()) return;
    setIsSubmitting(true);
    try {
      await createReminder({
        text: quickText.trim(),
        when: quickWhen,
        source: "inbox-surface",
      });
      setQuickText("");
      qc.invalidateQueries({ queryKey: ["reminders"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      toast("Reminder scheduled", "ok", `Due ${quickWhen}`);
    } catch (e: unknown) {
      toastError("Failed to schedule reminder", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismissReminder = async (id: string) => {
    try {
      await dismissReminder(id);
      qc.invalidateQueries({ queryKey: ["reminders"] });
      toast("Reminder dismissed", "ok");
    } catch (e: unknown) {
      toastError("Failed to dismiss reminder", e);
    }
  };

  const fleetStatus = controlData?.fleet.status ?? "running";
  const isFleetRunning = fleetStatus === "running";
  const activeWorkers = liveData?.stats.find((s) => s.label === "WORKERS")?.value ?? "5";
  const pendingJobs = liveData?.stats.find((s) => s.label === "QUEUED")?.value ?? "0";
  const stuckWorkers = liveData?.stats.find((s) => s.label === "STUCK")?.value ?? "0";

  const upcomingReminders = useMemo(() => {
    return reminders
      .filter((r) => r.status === "pending" || r.status === "delivered")
      .slice(0, 3);
  }, [reminders]);

  return (
    <div
      className="slidein"
      style={{
        maxWidth: 1080,
        padding: "36px 40px 60px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* All-Clear Hero Banner */}
      <div
        style={{
          background: tokens.freezeBgOk,
          border: `1px solid ${tokens.freezeBorderOk}`,
          borderRadius: 12,
          padding: "24px 28px",
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: tokens.okActionBg,
            border: `1.5px solid ${tokens.ok}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: tokens.ok,
            flex: "none",
          }}
        >
          <span className="ms" style={{ fontSize: 26 }}>
            verified
          </span>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: tokens.textHi,
              marginBottom: 4,
            }}
          >
            Inbox Zero · Autonomous Systems Operating Cleanly
          </div>
          <div style={{ fontSize: 13, color: tokens.textSecondary, lineHeight: 1.4 }}>
            All urgent escalations and QC gates are clear. The manager and background workers
            are executing autonomously without human blockers.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onViewHistory}
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 6,
              padding: "8px 14px",
              color: tokens.textHi,
              fontSize: 11.5,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              history
            </span>
            View Resolved ({resolvedCount})
          </button>
        </div>
      </div>

      {/* 3-Card Operational Pulse Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {/* Card 1: Fleet Health & Providers */}
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              FLEET & WORKER TELEMETRY
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: isFleetRunning ? tokens.ok : tokens.warn,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span style={dot(isFleetRunning ? tokens.ok : tokens.warn)} />
              {fleetStatus.toUpperCase()}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              padding: "8px 0",
              borderTop: `1px solid ${tokens.borderDivider}`,
              borderBottom: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: tokens.textFaint }}>Workers</div>
              <div
                className="mono"
                style={{ fontSize: 17, fontWeight: 600, color: tokens.textHi }}
              >
                {activeWorkers}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: tokens.textFaint }}>Queued Jobs</div>
              <div
                className="mono"
                style={{ fontSize: 17, fontWeight: 600, color: tokens.textSecondary }}
              >
                {pendingJobs}
              </div>
            </div>
          </div>

          {/* Providers List */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
              PROVIDER HEALTH:
            </span>
            {(liveData?.providers ?? []).map((p, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 11,
                }}
              >
                <span style={{ color: tokens.textSecondary }}>{p.name}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: p.status === "ok" ? tokens.ok : tokens.bleed,
                  }}
                >
                  {p.badge}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Card 2: Today's Triage Summary */}
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              TODAY'S TRIAGE PULSE
            </span>
            <span className="mono" style={{ fontSize: 10, color: tokens.ok }}>
              0 BLOCKERS
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              padding: "10px 0",
              borderTop: `1px solid ${tokens.borderDivider}`,
              borderBottom: `1px solid ${tokens.borderDivider}`,
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 24, fontWeight: 700, color: tokens.textHi }}
            >
              {resolvedCount}
            </span>
            <span style={{ fontSize: 12, color: tokens.textSecondary }}>
              items handled & resolved
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: tokens.textFaint }}>Critical Bleeds:</span>
              <span className="mono" style={{ color: tokens.ok }}>
                0 active
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: tokens.textFaint }}>Stuck Processes:</span>
              <span className="mono" style={{ color: tokens.ok }}>
                {stuckWorkers} stuck
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: tokens.textFaint }}>Invariants:</span>
              <span className="mono" style={{ color: tokens.accent }}>
                5 rules enforced
              </span>
            </div>
          </div>
        </div>

        {/* Card 3: Upcoming Reminders */}
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.textFaint,
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              UPCOMING SCHEDULED
            </span>
            <span className="mono" style={{ fontSize: 10, color: tokens.accent }}>
              {upcomingReminders.length} DUE
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              flex: 1,
              borderTop: `1px solid ${tokens.borderDivider}`,
              paddingTop: 8,
            }}
          >
            {upcomingReminders.length === 0 ? (
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: tokens.textFaint,
                  padding: "16px 0",
                  textAlign: "center",
                }}
              >
                No upcoming reminders scheduled.
              </div>
            ) : (
              upcomingReminders.map((r) => (
                <div
                  key={r.id}
                  style={{
                    background: tokens.toolBg,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: tokens.textHi,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.text}
                    </div>
                    <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 2 }}>
                      due {r.due_at ? new Date(r.due_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDismissReminder(r.id)}
                    title="Dismiss reminder"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: tokens.textMuted,
                      cursor: "pointer",
                      padding: 2,
                    }}
                  >
                    <span className="ms" style={{ fontSize: 14 }}>
                      close
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick Capture Form & Action Shortcuts */}
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 10,
          padding: "18px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.textFaint,
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          QUICK CAPTURE REMINDER / OPERATOR NOTE
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            value={quickText}
            onChange={(e) => setQuickText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleCreateReminder();
              }
            }}
            placeholder="What needs to happen? (e.g. Check video rendering pipeline or review server patch)..."
            style={{
              flex: "1 1 320px",
              background: tokens.inputBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "8px 12px",
              color: tokens.text,
              fontSize: 12,
              outline: "none",
              fontFamily: "inherit",
            }}
          />

          {/* Quick When Selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {["in 2h", "tomorrow 9:00", "daily 08:30"].map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setQuickWhen(w)}
                className="mono"
                style={{
                  background: quickWhen === w ? tokens.selectedBg : tokens.toolBg,
                  border: `1px solid ${quickWhen === w ? tokens.accent : tokens.border}`,
                  color: quickWhen === w ? tokens.accent : tokens.textMuted,
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 10.5,
                  cursor: "pointer",
                }}
              >
                {w}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={isSubmitting || !quickText.trim()}
            onClick={() => void handleCreateReminder()}
            style={{
              ...actionStyle("primary"),
              opacity: isSubmitting || !quickText.trim() ? 0.5 : 1,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              add_task
            </span>
            Schedule Reminder
          </button>
        </div>
      </div>
    </div>
  );
}
