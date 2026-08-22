"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchSkills,
  fetchSkill,
  runCuratorAudit,
  toggleSkill,
  bulkToggleSkills,
  type SkillSummary,
  type SkillLifecycle,
  type CuratorAuditResult,
} from "../api";

const PROTECTED_TOOLTIP =
  "Protected — a core OS workflow (see DEFAULT_PROTECTED_IDS in skills-curator.ts). Can't be disabled from here.";

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Small enable/disable pill — a real toggle, not decoration. Stops
 *  propagation so it works inside a clickable card without also selecting
 *  the skill underneath it. */
function EnableToggle({
  enabled,
  disabled,
  title,
  pending,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  title?: string;
  pending?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      title={title}
      disabled={disabled || pending}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!enabled);
      }}
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: "0.06em",
        borderRadius: 4,
        padding: "2px 7px",
        border: `1px solid ${enabled ? `${tokens.ok}55` : tokens.border}`,
        background: enabled ? `${tokens.ok}15` : "transparent",
        color: disabled ? tokens.textFaint : enabled ? tokens.ok : tokens.textMuted,
        cursor: disabled ? "not-allowed" : pending ? "wait" : "pointer",
        opacity: pending ? 0.6 : 1,
      }}
    >
      {pending ? "…" : disabled ? "LOCKED" : enabled ? "ACTIVE" : "DISABLED"}
    </button>
  );
}

const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  hermes: { label: "hermes", color: tokens.decide },
  user: { label: "claude", color: tokens.accent },
};

const LIFECYCLE_COLOR: Record<SkillLifecycle, string> = {
  active: tokens.ok,
  stale: tokens.warn,
  archive_candidate: tokens.stuck,
  protected: tokens.decide,
};

const LIFECYCLE_LABEL: Record<SkillLifecycle, string> = {
  active: "ACTIVE",
  stale: "STALE",
  archive_candidate: "ARCHIVE?",
  protected: "PROTECTED",
};

export function SkillsSurface() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ["skills", "list"],
    queryFn: fetchSkills,
  });
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  // Ids currently mid-toggle, for the "…" pending state on their pill.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toggleSkill(id, enabled),
    onMutate: ({ id }) =>
      setPendingIds((prev) => new Set(prev).add(id)),
    onSettled: (_data, _err, { id }) => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const bulkMut = useMutation({
    mutationFn: ({ category, enabled }: { category: string; enabled: boolean }) =>
      bulkToggleSkills({ category }, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });

  const disableCategory = (category: string) =>
    bulkMut.mutate({ category, enabled: false });
  // Detail-panel mode: "skill" shows the selected SKILL.md; "audit" shows the
  // last curator audit report. Mutually exclusive — selecting a skill flips
  // back to "skill", clicking Run Audit flips to "audit".
  const [detailMode, setDetailMode] = useState<"skill" | "audit">("skill");
  const searchRef = useRef<HTMLInputElement | null>(null);

  // "/" focuses the filter box (unless already typing somewhere) — same
  // discoverability convention as GitHub/Slack search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const auditMut = useMutation({
    mutationFn: runCuratorAudit,
    onSuccess: () => setDetailMode("audit"),
  });
  const audit: CuratorAuditResult | undefined = auditMut.data;
  // Lifecycle lookup by skill id, populated only after an audit runs. Used
  // to decorate card chips and to drive the report panel.
  const lifecycleById = useMemo(() => {
    const m = new Map<string, SkillLifecycle>();
    if (audit) for (const e of audit.lifecycle) m.set(e.id, e.lifecycle);
    return m;
  }, [audit]);

  const filtered = useMemo<SkillSummary[]>(() => {
    const all = listQ.data?.skills ?? [];
    let out = cat ? all.filter((s) => s.category === cat) : all;
    const qq = q.trim().toLowerCase();
    if (qq) {
      out = out.filter(
        (s) =>
          s.name.toLowerCase().includes(qq) ||
          s.description.toLowerCase().includes(qq) ||
          s.category.toLowerCase().includes(qq) ||
          s.id.toLowerCase().includes(qq) ||
          s.source.toLowerCase().includes(qq),
      );
    }
    return out;
  }, [listQ.data, cat, q]);

  const detailQ = useQuery({
    queryKey: ["skills", "one", selId],
    queryFn: () => fetchSkill(selId!),
    enabled: !!selId,
  });

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Category rail */}
      <div
        style={{
          width: 200,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "12px 0",
          overflowY: "auto",
        }}
      >
        {listQ.data?.token_estimate && (
          <div
            style={{
              margin: "0 12px 12px",
              padding: "9px 10px",
              borderRadius: 6,
              border: `1px solid ${tokens.borderSoft}`,
              background: tokens.bgCard,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textFaint,
                letterSpacing: "0.08em",
                marginBottom: 5,
              }}
            >
              CONTEXT COST
            </div>
            <div
              className="mono"
              style={{ fontSize: 13, color: tokens.textHi, marginBottom: 2 }}
            >
              ~{fmtTokens(listQ.data.token_estimate.current_tokens)} tok
            </div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textMuted }}
            >
              {listQ.data.token_estimate.enabled_count} active ·{" "}
              {listQ.data.token_estimate.disabled_count} disabled
            </div>
            {listQ.data.token_estimate.savings_tokens > 0 && (
              <div
                className="mono"
                style={{ fontSize: 9.5, color: tokens.ok, marginTop: 3 }}
              >
                saving ~{fmtTokens(listQ.data.token_estimate.savings_tokens)} tok
                /turn
              </div>
            )}
          </div>
        )}
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            padding: "0 16px 8px",
          }}
        >
          CATEGORIES
        </div>
        <CatItem
          label="ALL"
          count={listQ.data?.count ?? 0}
          enabledCount={listQ.data?.token_estimate?.enabled_count}
          active={!cat}
          onClick={() => setCat(null)}
        />
        {listQ.data?.categories.map((c) => (
          <CatItem
            key={c.key}
            label={c.key}
            count={c.count}
            enabledCount={c.enabled_count}
            active={cat === c.key}
            onClick={() => setCat(c.key)}
          />
        ))}
      </div>

      {/* Middle: search + grid */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "12px 18px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{ fontSize: 13.5, fontWeight: 500, color: tokens.textHi }}
          >
            Skills
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
            {filtered.length}
          </span>
          {(() => {
            const appleCat = listQ.data?.categories.find((c) => c.key === "apple");
            if (!appleCat) return null;
            const allDisabled = appleCat.enabled_count === 0;
            return (
              <button
                onClick={() => disableCategory("apple")}
                disabled={bulkMut.isPending || allDisabled}
                title="Disable all skills in the 'apple' category — macOS/iOS automation is useless on this Linux VPS"
                className="mono"
                style={{
                  background: "transparent",
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  color: allDisabled ? tokens.textFaint : tokens.textMuted,
                  fontSize: 10.5,
                  letterSpacing: "0.04em",
                  cursor: allDisabled ? "default" : "pointer",
                  outline: "none",
                }}
              >
                {allDisabled
                  ? `macOS/Apple disabled (${appleCat.count})`
                  : `Disable macOS/Apple Skills (${appleCat.count})`}
              </button>
            );
          })()}
          <span style={{ flex: 1 }} />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter skills… (name, id, category, source) · / to focus"
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "6px 10px",
              color: tokens.text,
              fontSize: 12,
              minWidth: 220,
              outline: "none",
            }}
          />
          <button
            onClick={() => auditMut.mutate()}
            disabled={auditMut.isPending}
            className="mono"
            style={{
              background: auditMut.isPending ? tokens.bgGutter : tokens.selectedBg,
              border: `1px solid ${audit ? tokens.accent : tokens.borderEmphasis}`,
              borderRadius: 6,
              padding: "6px 12px",
              color: auditMut.isPending ? tokens.textFaint : tokens.text,
              fontSize: 11,
              letterSpacing: "0.06em",
              cursor: auditMut.isPending ? "wait" : "pointer",
              outline: "none",
            }}
          >
            {auditMut.isPending
              ? "AUDITING…"
              : audit
                ? "RE-RUN AUDIT"
                : "RUN AUDIT"}
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
            alignContent: "start",
          }}
        >
          {listQ.isLoading && (
            <div
              className="mono"
              style={{ color: tokens.textFaint, fontSize: 11 }}
            >
              loading skills…
            </div>
          )}
          {!listQ.isLoading && filtered.length === 0 && (
            <div
              className="mono"
              style={{
                color: tokens.textFaint,
                fontSize: 11,
                padding: 16,
                gridColumn: "1/-1",
              }}
            >
              no skills match.
            </div>
          )}
          {filtered.map((s) => {
            const src = SOURCE_LABEL[s.source] ?? {
              label: s.source,
              color: tokens.textMuted,
            };
            const selected = selId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => {
                  setSelId(s.id);
                  setDetailMode("skill");
                }}
                style={{
                  background: tokens.bgCard,
                  border: `1px solid ${selected ? tokens.accent : tokens.border}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: src.color,
                      letterSpacing: "0.08em",
                    }}
                  >
                    {src.label}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: tokens.textFaint,
                      letterSpacing: "0.06em",
                    }}
                  >
                    · {s.category}
                  </span>
                  {s.risk === "guarded" && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 9,
                        color: "#fbbf24",
                        border: "1px solid rgba(251,191,36,0.45)",
                        borderRadius: 4,
                        padding: "1px 5px",
                        letterSpacing: "0.08em",
                      }}
                    >
                      GUARDED
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                    {(() => {
                      const lc = lifecycleById.get(s.id);
                      if (!lc) return null;
                      const color = LIFECYCLE_COLOR[lc];
                      return (
                        <span
                          className="mono"
                          title={`curator: ${lc}`}
                          style={{
                            fontSize: 9,
                            color,
                            border: `1px solid ${color}55`,
                            borderRadius: 4,
                            padding: "1px 5px",
                            letterSpacing: "0.08em",
                          }}
                        >
                          {LIFECYCLE_LABEL[lc]}
                        </span>
                      );
                    })()}
                    <EnableToggle
                      enabled={s.enabled}
                      disabled={s.protected}
                      pending={pendingIds.has(s.id)}
                      title={s.protected ? PROTECTED_TOOLTIP : undefined}
                      onChange={(next) => toggleMut.mutate({ id: s.id, enabled: next })}
                    />
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: tokens.textHi,
                    lineHeight: 1.35,
                  }}
                >
                  {s.name}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: tokens.textSecondary,
                    lineHeight: 1.5,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {s.description || "no description"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail */}
      <div
        style={{
          width: 420,
          flex: "none",
          borderLeft: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {detailMode === "audit" && audit && (
          <AuditPanel
            audit={audit}
            onPickSkill={(id) => {
              setSelId(id);
              setDetailMode("skill");
            }}
          />
        )}
        {detailMode === "skill" && !selId && (
          <div
            className="mono"
            style={{
              padding: "48px 20px",
              fontSize: 11,
              color: tokens.textFaint,
              textAlign: "center",
            }}
          >
            {audit ? (
              <>
                select a skill
                <div style={{ marginTop: 12 }}>
                  <button
                    onClick={() => setDetailMode("audit")}
                    className="mono"
                    style={{
                      background: "transparent",
                      border: `1px solid ${tokens.borderEmphasis}`,
                      borderRadius: 5,
                      padding: "5px 10px",
                      color: tokens.textMuted,
                      fontSize: 10,
                      letterSpacing: "0.08em",
                      cursor: "pointer",
                    }}
                  >
                    SHOW AUDIT REPORT
                  </button>
                </div>
              </>
            ) : (
              "select a skill"
            )}
          </div>
        )}
        {detailMode === "skill" && selId && detailQ.isLoading && (
          <div
            className="mono"
            style={{
              padding: 24,
              fontSize: 11,
              color: tokens.textFaint,
            }}
          >
            loading…
          </div>
        )}
        {detailMode === "skill" && detailQ.data && (
          <>
            <div
              style={{
                padding: "16px 18px",
                borderBottom: `1px solid ${tokens.borderSoft}`,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color:
                    SOURCE_LABEL[detailQ.data.source]?.color ??
                    tokens.textMuted,
                  letterSpacing: "0.1em",
                  marginBottom: 6,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>
                  {detailQ.data.source} · {detailQ.data.category}
                </span>
                {detailQ.data.risk === "guarded" && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "#fbbf24",
                      border: "1px solid rgba(251,191,36,0.45)",
                      borderRadius: 4,
                      padding: "1px 5px",
                      letterSpacing: "0.08em",
                    }}
                  >
                    GUARDED
                  </span>
                )}
                <span style={{ marginLeft: "auto" }}>
                  <EnableToggle
                    enabled={detailQ.data.enabled}
                    disabled={detailQ.data.protected}
                    pending={pendingIds.has(detailQ.data.id)}
                    title={detailQ.data.protected ? PROTECTED_TOOLTIP : undefined}
                    onChange={(next) =>
                      toggleMut.mutate({ id: detailQ.data.id, enabled: next })
                    }
                  />
                </span>
              </div>
              {detailQ.data.protected && (
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: tokens.decide,
                    marginTop: 8,
                    lineHeight: 1.5,
                  }}
                  title={PROTECTED_TOOLTIP}
                >
                  PROTECTED — core OS workflow, can't be disabled from here.
                </div>
              )}
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: tokens.textHi,
                  marginBottom: 8,
                  lineHeight: 1.3,
                }}
              >
                {detailQ.data.name}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: tokens.textSecondary,
                  lineHeight: 1.6,
                }}
              >
                {detailQ.data.description || "no description"}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  marginTop: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {detailQ.data.path}
              </div>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "16px 18px",
                fontSize: 12,
                color: tokens.textBody,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                fontFamily: "Inter, system-ui",
              }}
            >
              {detailQ.data.body}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AuditPanel({
  audit,
  onPickSkill,
}: {
  audit: CuratorAuditResult;
  onPickSkill: (id: string) => void;
}) {
  // Stale + archive_candidate skills sorted by days_since_touch desc — these
  // are what the user actually needs to look at.
  const needsAttention = useMemo(
    () =>
      audit.lifecycle.filter(
        (e) => e.lifecycle === "stale" || e.lifecycle === "archive_candidate",
      ),
    [audit.lifecycle],
  );
  const generatedAt = new Date(audit.generated_at).toLocaleString();

  return (
    <>
      <div
        style={{
          padding: "16px 18px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 8,
          }}
        >
          CURATOR REPORT · {audit.duration_ms}ms
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: tokens.textHi,
            marginBottom: 8,
          }}
        >
          {audit.total_skills} skills audited
        </div>
        <div
          className="mono"
          style={{ fontSize: 10, color: tokens.textMuted, marginBottom: 12 }}
        >
          generated {generatedAt}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(
            ["active", "stale", "archive_candidate", "protected"] as const
          ).map((lc) => {
            const n = audit.lifecycle_summary[lc];
            const color = LIFECYCLE_COLOR[lc];
            return (
              <span
                key={lc}
                className="mono"
                style={{
                  fontSize: 10,
                  color,
                  border: `1px solid ${color}55`,
                  borderRadius: 5,
                  padding: "3px 8px",
                  letterSpacing: "0.06em",
                }}
              >
                {LIFECYCLE_LABEL[lc]} {n}
              </span>
            );
          })}
        </div>
        {audit.llm_error && (
          <div
            className="mono"
            style={{
              marginTop: 10,
              fontSize: 10,
              color: tokens.warn,
              lineHeight: 1.5,
            }}
          >
            llm pass skipped: {audit.llm_error}
          </div>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 18px 18px",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            marginBottom: 8,
          }}
        >
          NEEDS ATTENTION ({needsAttention.length})
        </div>
        {needsAttention.length === 0 && (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              padding: "6px 0 14px",
            }}
          >
            nothing stale.
          </div>
        )}
        {needsAttention.map((e) => {
          const color = LIFECYCLE_COLOR[e.lifecycle];
          return (
            <div
              key={e.id}
              onClick={() => onPickSkill(e.id)}
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderLeft: `3px solid ${color}`,
                borderRadius: 6,
                padding: "9px 11px",
                marginBottom: 8,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color,
                    letterSpacing: "0.08em",
                  }}
                >
                  {LIFECYCLE_LABEL[e.lifecycle]}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 9, color: tokens.textFaint }}
                >
                  {e.days_since_touch}d
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: tokens.textHi,
                  marginBottom: 2,
                }}
              >
                {e.name}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.id}
              </div>
            </div>
          );
        })}

        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            margin: "18px 0 8px",
          }}
        >
          CONSOLIDATION SUGGESTIONS ({audit.consolidations.length})
        </div>
        {audit.consolidations.length === 0 && (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              padding: "6px 0",
            }}
          >
            none.
          </div>
        )}
        {audit.consolidations.map((c, i) => (
          <div
            key={`${c.from}-${c.into}-${i}`}
            style={{
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "10px 12px",
              marginBottom: 8,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.accent,
                letterSpacing: "0.08em",
                marginBottom: 6,
              }}
            >
              {c.strategy.replace(/_/g, " ").toUpperCase()}
            </div>
            <div
              className="mono"
              style={{ fontSize: 10.5, color: tokens.textHi, marginBottom: 4 }}
            >
              <span style={{ color: tokens.textMuted }}>from</span>{" "}
              <span
                onClick={() => onPickSkill(c.from)}
                style={{ cursor: "pointer", textDecoration: "underline" }}
              >
                {c.from}
              </span>{" "}
              <span style={{ color: tokens.textMuted }}>→ into</span>{" "}
              <span
                onClick={() => onPickSkill(c.into)}
                style={{ cursor: "pointer", textDecoration: "underline" }}
              >
                {c.into}
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: tokens.textSecondary,
                lineHeight: 1.5,
              }}
            >
              {c.reason}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CatItem({
  label,
  count,
  enabledCount,
  active,
  onClick,
}: {
  label: string;
  count: number;
  enabledCount?: number;
  active: boolean;
  onClick: () => void;
}) {
  // Fraction only when it's informative (some disabled) — plain count
  // otherwise, so a fully-active category doesn't clutter with "20/20".
  const showFraction =
    typeof enabledCount === "number" && enabledCount < count;
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        padding: "7px 16px",
        cursor: "pointer",
        borderLeft: `2px solid ${active ? tokens.accent : "transparent"}`,
        background: active ? tokens.selectedBg : "transparent",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: active ? tokens.text : tokens.textMuted,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: showFraction ? tokens.warn : tokens.textFaint,
        }}
      >
        {showFraction ? `${enabledCount}/${count}` : count}
      </span>
    </div>
  );
}
