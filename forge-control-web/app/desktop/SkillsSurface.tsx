"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchSkills, fetchSkill, type SkillSummary } from "../api";

const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  hermes: { label: "hermes", color: tokens.decide },
  user: { label: "claude", color: tokens.accent },
};

export function SkillsSurface() {
  const listQ = useQuery({
    queryKey: ["skills", "list"],
    queryFn: fetchSkills,
  });
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<string | null>(null);

  const filtered = useMemo<SkillSummary[]>(() => {
    const all = listQ.data?.skills ?? [];
    let out = cat ? all.filter((s) => s.category === cat) : all;
    const qq = q.trim().toLowerCase();
    if (qq) {
      out = out.filter(
        (s) =>
          s.name.toLowerCase().includes(qq) ||
          s.description.toLowerCase().includes(qq) ||
          s.category.toLowerCase().includes(qq),
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
          active={!cat}
          onClick={() => setCat(null)}
        />
        {listQ.data?.categories.map((c) => (
          <CatItem
            key={c.key}
            label={c.key}
            count={c.count}
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
          <span style={{ flex: 1 }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter skills…"
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
                onClick={() => setSelId(s.id)}
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
        {!selId && (
          <div
            className="mono"
            style={{
              padding: "48px 20px",
              fontSize: 11,
              color: tokens.textFaint,
              textAlign: "center",
            }}
          >
            select a skill
          </div>
        )}
        {selId && detailQ.isLoading && (
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
        {detailQ.data && (
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
              </div>
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

function CatItem({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        padding: "7px 16px",
        cursor: "pointer",
        borderLeft: `2px solid ${active ? tokens.accent : "transparent"}`,
        background: active ? "#101013" : "transparent",
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
      <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
        {count}
      </span>
    </div>
  );
}
