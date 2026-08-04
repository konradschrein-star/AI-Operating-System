"use client";

/**
 * Businesses surface — the register of every web property Konrad runs,
 * grouped by BUSINESS (not by machine).
 *
 * Konrad's ask, 2026-08-04:
 *   1. Do not unmount the OS to reach this — it lives inside the shell, like
 *      every other surface. That's why this file exports a surface component
 *      that DesktopApp switches to; there is no /businesses route any more.
 *   2. Group by business. He thinks "Directory has these five things", not
 *      "VPS2 has these seven things". Boxes are a chip on the row.
 *   3. Navigable without scrolling. Five business rows, collapsed by default,
 *      so the whole portfolio fits on one screen. Click a row to expand its
 *      properties in place.
 *   4. Keep OPEN and REPO right next to each other on every property row —
 *      that was the one thing he explicitly liked about the previous version.
 *
 * Density > decoration. Every property fits on two lines: the actionable row
 * (dot / name / box / OPEN / REPO) plus the one-line description under it.
 * `statusNote` only renders when something is actually wrong.
 *
 * Data source: ./businesses-inventory.ts — the single editable register.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { tokens } from "../tokens";
import { BUSINESSES, type Box, type Property, type Status } from "./businesses-inventory";

const STATUS: Record<Status, { fg: string; label: string }> = {
  running: { fg: tokens.ok, label: "running" },
  stopped: { fg: tokens.bleed, label: "stopped" },
  not_deployed: { fg: tokens.warn, label: "not deployed" },
  unknown: { fg: tokens.warn, label: "unknown" },
  dormant: { fg: tokens.textFaint, label: "dormant" },
};

const BOX_LABEL: Record<Box, string> = {
  vps1: "VPS1",
  vps2: "VPS2",
  external: "EXTERNAL",
};

export function BusinessesSurface() {
  // Every business collapsed by default so the whole portfolio fits on one
  // screen. Konrad's core complaint about the previous page was "quite a
  // lot" — the first paint here is five headers, nothing else.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const allOpen = open.size === BUSINESSES.length;
  const expandAll = () => setOpen(new Set(BUSINESSES.map((b) => b.key)));
  const collapseAll = () => setOpen(new Set());

  const totals = useMemo(() => {
    const flat = BUSINESSES.flatMap((b) => b.properties);
    return {
      total: flat.length,
      running: flat.filter((p) => p.status === "running").length,
      stopped: flat.filter((p) => p.status === "stopped").length,
      not_deployed: flat.filter((p) => p.status === "not_deployed").length,
    };
  }, []);

  return (
    <div
      className="slidein"
      style={{ maxWidth: 980, margin: "0 auto", padding: "24px 28px 48px" }}
    >
      {/* Header — matches the density of other surfaces: title, one-line
          descriptor, small controls. No decorative summary cards. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Businesses
        </span>
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {BUSINESSES.length} ventures · {totals.total} properties
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={allOpen ? collapseAll : expandAll}
          className="mono"
          style={smallBtn}
        >
          {allOpen ? "collapse all" : "expand all"}
        </button>
      </div>

      <div
        style={{
          color: tokens.textMuted,
          fontSize: 12.5,
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Grouped by venture. Box (VPS1 / VPS2 / external) is a chip on the row.
        Edit{" "}
        <code
          className="mono"
          style={{ fontSize: 11.5, color: tokens.textBody }}
        >
          app/desktop/businesses-inventory.ts
        </code>{" "}
        to move a property between businesses.
      </div>

      {/* Compact totals strip — small, one line, not a bento-card wall. */}
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 14,
          fontSize: 11,
          color: tokens.textMuted,
          padding: "8px 12px",
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          marginBottom: 14,
        }}
      >
        <span>
          <span style={{ color: tokens.ok }}>●</span> {totals.running} running
        </span>
        <span>
          <span style={{ color: tokens.bleed }}>●</span> {totals.stopped} stopped
        </span>
        <span>
          <span style={{ color: tokens.warn }}>●</span> {totals.not_deployed} not
          deployed
        </span>
      </div>

      {/* The tree. Each business is a header row + (when open) a stack of
          property rows. All headers are always visible; only bodies fold. */}
      <div
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {BUSINESSES.map((b, i) => {
          const isOpen = open.has(b.key);
          const isLast = i === BUSINESSES.length - 1;
          const counts = countByStatus(b.properties);
          return (
            <div
              key={b.key}
              style={{
                borderBottom: isLast
                  ? "none"
                  : `1px solid ${tokens.borderDivider}`,
              }}
            >
              <BusinessHeader
                title={b.title}
                subtitle={b.subtitle}
                counts={counts}
                total={b.properties.length}
                isOpen={isOpen}
                onToggle={() => toggle(b.key)}
              />
              {isOpen && (
                <div
                  style={{
                    borderTop: `1px solid ${tokens.borderDivider}`,
                    background: "transparent",
                  }}
                >
                  {b.properties.map((p, j) => (
                    <PropertyRow
                      key={`${b.key}:${p.name}`}
                      p={p}
                      last={j === b.properties.length - 1}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Business header — click to fold/unfold. Keeps five rows always visible.
 * ------------------------------------------------------------------------- */
function BusinessHeader({
  title,
  subtitle,
  counts,
  total,
  isOpen,
  onToggle,
}: {
  title: string;
  subtitle: string;
  counts: { running: number; stopped: number; not_deployed: number };
  total: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span
        className="mono"
        style={{
          width: 12,
          fontSize: 11,
          color: tokens.textFaint,
          transition: "transform 120ms",
          display: "inline-block",
          transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
        }}
      >
        ▸
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: tokens.textHi }}>
        {title}
      </span>
      <span
        className="mono"
        style={{ fontSize: 10.5, color: tokens.textFaint }}
      >
        {total}
      </span>
      <span
        className="mono"
        style={{
          display: "inline-flex",
          gap: 8,
          fontSize: 10.5,
          color: tokens.textFaint,
        }}
      >
        {counts.running > 0 && (
          <span>
            <span style={{ color: tokens.ok }}>●</span> {counts.running}
          </span>
        )}
        {counts.stopped > 0 && (
          <span>
            <span style={{ color: tokens.bleed }}>●</span> {counts.stopped}
          </span>
        )}
        {counts.not_deployed > 0 && (
          <span>
            <span style={{ color: tokens.warn }}>●</span> {counts.not_deployed}
          </span>
        )}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: tokens.textMuted,
          marginLeft: 6,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={subtitle}
      >
        {!isOpen && subtitle}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Property row — dense two-line row with OPEN + REPO always adjacent.
 * ------------------------------------------------------------------------- */
function PropertyRow({ p, last }: { p: Property; last: boolean }) {
  const [showDetail, setShowDetail] = useState(false);
  const st = STATUS[p.status];
  const dead = p.status === "stopped" || p.status === "not_deployed";
  return (
    <div
      style={{
        padding: "10px 14px 10px 34px",
        borderBottom: last ? "none" : `1px solid ${tokens.borderDivider}`,
        opacity: dead ? 0.82 : 1,
      }}
    >
      {/* Action row. Everything on one line: name, status dot, box chip,
          OPEN + REPO side by side. Konrad explicitly liked OPEN adjacent
          to REPO — keep it that way. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          title={st.label}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: st.fg,
            flex: "none",
          }}
        />
        <span
          style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}
        >
          {p.name}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: st.fg,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {st.label}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          {BOX_LABEL[p.box]}
        </span>
        <span style={{ flex: 1 }} />
        {/* OPEN and REPO — side by side, always in that order. */}
        {p.publicUrl ? (
          <a
            href={p.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={linkBtn(tokens.primaryActionBg, tokens.accent, tokens.accent)}
          >
            OPEN ↗
          </a>
        ) : (
          <span
            className="mono"
            style={{
              ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
              cursor: "default",
              opacity: 0.5,
            }}
            title="No public URL"
          >
            OPEN
          </span>
        )}
        {p.githubUrl ? (
          <a
            href={p.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={linkBtn(tokens.toolBg, tokens.border, tokens.textBody)}
          >
            REPO ↗
          </a>
        ) : (
          <span
            className="mono"
            style={{
              ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
              cursor: "default",
              opacity: 0.5,
            }}
            title="Not a git repo"
          >
            REPO
          </span>
        )}
        <button
          onClick={() => setShowDetail((v) => !v)}
          className="mono"
          title={showDetail ? "hide paths / admin URL" : "show paths / admin URL"}
          style={{
            ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
            cursor: "pointer",
          }}
        >
          {showDetail ? "−" : "…"}
        </button>
      </div>

      {/* Line 2: what this thing is. Muted, one line. */}
      <div
        style={{
          color: tokens.textMuted,
          fontSize: 11.5,
          marginTop: 4,
          marginLeft: 17,
          lineHeight: 1.5,
        }}
      >
        {p.what}
      </div>

      {/* Line 3: only when something is actually wrong or worth flagging. */}
      {p.statusNote && (
        <div
          style={{
            color: st.fg,
            fontSize: 11,
            marginTop: 3,
            marginLeft: 17,
            lineHeight: 1.5,
          }}
        >
          {p.statusNote}
        </div>
      )}

      {p.note && !p.statusNote && (
        <div
          style={{
            color: tokens.textFaint,
            fontSize: 11,
            marginTop: 3,
            marginLeft: 17,
            lineHeight: 1.5,
          }}
        >
          {p.note}
        </div>
      )}

      {/* Optional detail: admin URL + local path. Not visible until asked
          for — Konrad's baseline density is name + description, not URL
          tables. */}
      {showDetail && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 8,
            marginTop: 8,
            marginLeft: 17,
            fontSize: 11.5,
          }}
        >
          {p.adminUrl && <Field label="ADMIN" value={p.adminUrl} />}
          {p.localPath && <Field label="PATH" value={p.localPath} />}
          {p.publicUrl && <Field label="PUBLIC" value={p.publicUrl} />}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 9.5, color: tokens.textLabel, letterSpacing: "0.08em" }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          color: tokens.textBody,
          marginTop: 2,
          fontSize: 11,
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function countByStatus(props: Property[]) {
  return {
    running: props.filter((p) => p.status === "running").length,
    stopped: props.filter((p) => p.status === "stopped").length,
    not_deployed: props.filter((p) => p.status === "not_deployed").length,
  };
}

const smallBtn: CSSProperties = {
  fontSize: 10.5,
  color: tokens.textMuted,
  background: tokens.toolBg,
  border: `1px solid ${tokens.border}`,
  borderRadius: 6,
  padding: "4px 9px",
  cursor: "pointer",
};

function linkBtn(bg: string, border: string, fg: string): CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 6,
    color: fg,
    cursor: "pointer",
    fontSize: 10.5,
    padding: "4px 8px",
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    lineHeight: 1,
  };
}
