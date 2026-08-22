"use client";

import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  statusColor,
  triedIconColor,
  type InboxAction,
  type InboxItem as InboxItemUi,
} from "../data";
import { fetchInboxPreview, type InboxPreview } from "../api";

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
 * Inbox — 2-column split. v1.6 phase 3 splits the detail pane into its own
 * InboxDetail component that fetches /api/inbox/:id/preview for video player
 * + scene thumbs + stats grid, and the action row supports Deny-with-reason
 * inline. The `key={sel.id}` on InboxDetail resets reason/state on switch.
 * -------------------------------------------------------------------------- */
export function InboxSurface({
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

