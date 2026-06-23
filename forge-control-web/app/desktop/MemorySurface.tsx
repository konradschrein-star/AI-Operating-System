"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchMemoryList,
  fetchMemoryNote,
  searchMemoryExpanded,
  TRIPLE_CATEGORIES,
  type MemoryCategory,
  type MemoryNote,
  type MemorySearchHitWithLane,
  type TripleCategory,
} from "../api";

/* v1.7 phase 4: lane viz. Vector hits and each graph hop get a distinct
 * colour so Konrad can SEE which lane / hop a result came from. */
const LANE_COLOR = (h: MemorySearchHitWithLane): string => {
  if (h.via === "vector") return tokens.ok;
  if (h.hop === 1) return tokens.warn;
  if (h.hop === 2) return tokens.decide;
  return tokens.stuck; // hop >= 3
};
const LANE_LABEL = (h: MemorySearchHitWithLane): string =>
  h.via === "vector" ? "vector" : `graph ${h.hop}-hop`;

const CATEGORY_COLOR: Record<MemoryCategory, string> = {
  rule: tokens.decide,
  pref: tokens.info,
  fact: tokens.textMuted,
  person: tokens.ok,
  project: tokens.accent,
  note: tokens.textSecondary,
};

const CAT_LABEL: { key: MemoryCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "rule", label: "Rules" },
  { key: "pref", label: "Preferences" },
  { key: "fact", label: "Facts" },
  { key: "person", label: "People" },
  { key: "project", label: "Projects" },
  { key: "note", label: "Notes" },
];

export function MemorySurface() {
  const listQ = useQuery({
    queryKey: ["memory", "list"],
    queryFn: fetchMemoryList,
  });
  const [cat, setCat] = useState<MemoryCategory | "all">("all");
  const [selSlug, setSelSlug] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // v1.7 phase 4: search controls
  const [searchCategory, setSearchCategory] = useState<TripleCategory | null>(null);
  const [hops, setHops] = useState<number>(2);

  const allNotes = listQ.data ?? [];
  const visibleNotes = useMemo(
    () =>
      cat === "all" ? allNotes : allNotes.filter((n) => n.category === cat),
    [allNotes, cat],
  );

  const searchQ = useQuery({
    queryKey: ["memory", "search-expanded", q, hops, searchCategory],
    queryFn: () =>
      searchMemoryExpanded(q, {
        hops,
        category: searchCategory ?? undefined,
      }),
    enabled: q.length >= 2,
  });

  const slugInView = selSlug ?? visibleNotes[0]?.slug ?? null;
  const detailQ = useQuery({
    queryKey: ["memory", "note", slugInView],
    queryFn: () => fetchMemoryNote(slugInView!),
    enabled: !!slugInView,
  });
  const note = detailQ.data;

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: allNotes.length };
    for (const n of allNotes) m[n.category] = (m[n.category] ?? 0) + 1;
    return m;
  }, [allNotes]);

  const searchHits = searchQ.data?.hits ?? [];
  const laneCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const h of searchHits) {
      const k = h.via === "vector" ? "vector" : `${h.hop}h`;
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [searchHits]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — categories + sync state */}
      <div
        style={{
          width: 188,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "14px 10px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "0 4px 4px",
          }}
        >
          <span className="ms" style={{ fontSize: 14, color: tokens.decide }}>
            hub
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textSecondary,
              letterSpacing: "0.04em",
            }}
          >
            Obsidian vault
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 4px 10px",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: tokens.ok,
              animation: "pulse 2.4s infinite",
            }}
          />
          <span
            className="mono"
            style={{ fontSize: 9, color: tokens.textFaint }}
          >
            {listQ.isLoading ? "loading…" : `${counts.all ?? 0} notes`}
          </span>
        </div>

        {CAT_LABEL.map((c) => {
          const seld = cat === c.key;
          const color =
            c.key === "all"
              ? tokens.textFaint
              : CATEGORY_COLOR[c.key as MemoryCategory];
          return (
            <div
              key={c.key}
              onClick={() => setCat(c.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 12px",
                borderRadius: 6,
                cursor: "pointer",
                background: seld ? "#141417" : "transparent",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  flex: "none",
                }}
              />
              <span
                style={{
                  fontSize: 12.5,
                  color: seld ? tokens.text : tokens.textSecondary,
                  flex: 1,
                }}
              >
                {c.label}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: seld ? tokens.textMuted : tokens.textFaint,
                }}
              >
                {counts[c.key] ?? 0}
              </span>
            </div>
          );
        })}

        <div style={{ flex: 1 }} />
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textGhost,
            lineHeight: 1.7,
            padding: "0 4px",
          }}
        >
          read/write brain
          <br />
          linked-from [[graph]]
          <br />
          stale detection on
        </div>
      </div>

      {/* Middle column — note list with search */}
      <div
        style={{
          width: 340,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 15px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}>
            Memory
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
            {visibleNotes.length}
          </span>
          <span style={{ flex: 1 }} />
        </div>
        <div
          style={{
            flex: "none",
            padding: "10px 12px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="ms"
              style={{ fontSize: 14, color: tokens.textFaint }}
            >
              search
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="semantic search the vault…"
              className="mono"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: tokens.text,
                fontSize: 11.5,
              }}
            />
            {q && (
              <span
                onClick={() => setQ("")}
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textFaint,
                  cursor: "pointer",
                }}
              >
                ✕
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {q.length >= 2 ? (
            <>
              {/* v1.7 phase 4: lane-viz controls — hop slider + category chips */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px 6px",
                  borderBottom: `1px solid ${tokens.borderDivider}`,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: tokens.textFaint,
                    letterSpacing: "0.08em",
                  }}
                >
                  HOPS
                </span>
                {[0, 1, 2, 3].map((n) => (
                  <span
                    key={n}
                    onClick={() => setHops(n)}
                    className="mono"
                    style={{
                      cursor: "pointer",
                      fontSize: 10,
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: hops === n ? tokens.primaryActionBg : "transparent",
                      color: hops === n ? tokens.textHi : tokens.textMuted,
                      border: `1px solid ${hops === n ? tokens.accent : tokens.borderSoft}`,
                    }}
                  >
                    {n}
                  </span>
                ))}
              </div>
              {/* v1.9: reframed from "filter" to "lens". The category arg
                  affects only the 6-slot graph budget; the 12-slot vector
                  seed always survives, so at most 33% of result slots rotate.
                  See docs/ai-os-v17/multihop-bench.md for the bench finding. */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 14px 10px",
                  borderBottom: `1px solid ${tokens.borderDivider}`,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: tokens.textFaint,
                    letterSpacing: "0.08em",
                    marginRight: 4,
                  }}
                >
                  LENS
                </span>
                <span
                  onClick={() => setSearchCategory(null)}
                  className="mono"
                  style={{
                    cursor: "pointer",
                    fontSize: 9.5,
                    padding: "2px 7px",
                    borderRadius: 4,
                    background: !searchCategory ? tokens.primaryActionBg : "transparent",
                    color: !searchCategory ? tokens.textHi : tokens.textMuted,
                    border: `1px solid ${!searchCategory ? tokens.accent : tokens.borderSoft}`,
                  }}
                >
                  off
                </span>
                {TRIPLE_CATEGORIES.map((c) => {
                  const sparse = c === "decision" || c === "rule";
                  return (
                    <span
                      key={c}
                      onClick={() => setSearchCategory(c === searchCategory ? null : c)}
                      title={
                        sparse
                          ? `${c} has few triples — graph budget often won't fill`
                          : undefined
                      }
                      className="mono"
                      style={{
                        cursor: "pointer",
                        fontSize: 9.5,
                        padding: "2px 7px",
                        borderRadius: 4,
                        background: searchCategory === c ? tokens.primaryActionBg : "transparent",
                        color: searchCategory === c ? tokens.textHi : tokens.textMuted,
                        border: `1px solid ${searchCategory === c ? tokens.accent : tokens.borderSoft}`,
                        opacity: sparse && searchCategory !== c ? 0.65 : 1,
                      }}
                    >
                      {c}
                      {sparse && (
                        <span style={{ color: tokens.warn, marginLeft: 3 }}>·</span>
                      )}
                    </span>
                  );
                })}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  letterSpacing: "0.1em",
                  padding: "10px 15px 4px",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>HITS · {searchHits.length}</span>
                {Object.entries(laneCounts).map(([k, v]) => (
                  <span key={k} style={{ color: tokens.textMuted }}>
                    · {k}={v}
                  </span>
                ))}
              </div>
              {searchQ.isLoading && (
                <div
                  className="mono"
                  style={{
                    padding: "20px 16px",
                    color: tokens.textFaint,
                    fontSize: 11,
                  }}
                >
                  searching…
                </div>
              )}
              {searchHits.map((h) => {
                const laneColor = LANE_COLOR(h);
                return (
                  <div
                    key={`${h.slug}_${h.chunk_index}_${h.hop}`}
                    onClick={() => {
                      setSelSlug(h.slug);
                      setQ("");
                    }}
                    style={{
                      padding: "11px 14px",
                      cursor: "pointer",
                      borderBottom: `1px solid ${tokens.borderDivider}`,
                      borderLeft: `3px solid ${laneColor}`,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 8 }}
                    >
                      <span
                        style={{
                          fontSize: 12.5,
                          color: tokens.textLabel,
                          lineHeight: 1.4,
                        }}
                      >
                        {h.title}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        className="mono"
                        style={{
                          fontSize: 9,
                          color: laneColor,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                        }}
                      >
                        {LANE_LABEL(h)}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: laneColor }}
                      >
                        {h.score.toFixed(2)}
                      </span>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: tokens.textFaint,
                        marginTop: 4,
                        lineHeight: 1.4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {h.snippet}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            visibleNotes.map((n: MemoryNote) => {
              const seld = n.slug === slugInView;
              const color = CATEGORY_COLOR[n.category];
              return (
                <div
                  key={n.slug}
                  onClick={() => setSelSlug(n.slug)}
                  style={{
                    padding: "11px 14px",
                    cursor: "pointer",
                    borderBottom: `1px solid ${tokens.borderDivider}`,
                    borderLeft: `2px solid ${seld ? color : "transparent"}`,
                    background: seld ? "#101013" : "transparent",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      marginBottom: 5,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 8.5,
                        color,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      {n.category}
                    </span>
                    <span style={{ flex: 1 }} />
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: seld ? tokens.text : tokens.textLabel,
                      lineHeight: 1.42,
                    }}
                  >
                    {n.topic}
                  </div>
                  {n.tags.length > 0 && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: tokens.textFaint,
                        marginTop: 5,
                      }}
                    >
                      {n.tags.slice(0, 4).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {!listQ.isLoading && visibleNotes.length === 0 && q.length < 2 && (
            <div
              className="mono"
              style={{
                padding: "48px 24px",
                fontSize: 11.5,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              no notes in this category.
            </div>
          )}
        </div>
      </div>

      {/* Right column — detail */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {note ? (
          <div
            className="slidein"
            style={{ maxWidth: 680, padding: "24px 30px 48px" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: CATEGORY_COLOR[note.category],
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                {note.category}
              </span>
              <span style={{ flex: 1 }} />
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textMuted,
                  cursor: "pointer",
                }}
              >
                edit
              </span>
            </div>

            <div
              style={{
                fontSize: 21,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                color: tokens.textHi,
                lineHeight: 1.34,
                marginBottom: 8,
              }}
            >
              {note.topic}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: 16,
              }}
            >
              <span
                className="ms"
                style={{ fontSize: 13, color: tokens.decide }}
              >
                description
              </span>
              <span
                className="mono"
                style={{ fontSize: 10.5, color: tokens.textMuted }}
              >
                Vault › {note.vault_path}
              </span>
              <span
                className="mono"
                style={{ fontSize: 10, color: tokens.textGhost }}
              >
                · {note.word_count} words
              </span>
              <span style={{ flex: 1 }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  cursor: "pointer",
                  border: `1px solid ${tokens.invariantBorder}`,
                  borderRadius: 6,
                  padding: "4px 9px",
                  background: "#0e0c14",
                }}
              >
                <span
                  className="ms"
                  style={{ fontSize: 13, color: tokens.decide }}
                >
                  open_in_new
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 10, color: tokens.decide }}
                >
                  Open in Obsidian
                </span>
              </div>
            </div>

            {note.tags.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 18,
                }}
              >
                {note.tags.map((t, j) => (
                  <span
                    key={j}
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: tokens.info,
                      background: "#0a1316",
                      border: "1px solid #16323a",
                      borderRadius: 5,
                      padding: "3px 8px",
                    }}
                  >
                    #{t.replace(/^#/, "")}
                  </span>
                ))}
              </div>
            )}

            <div
              style={{
                background: tokens.bgCard,
                border: `1px solid ${tokens.border}`,
                borderRadius: 8,
                padding: "16px 18px",
                marginBottom: 22,
              }}
            >
              <pre
                style={{
                  fontFamily: "inherit",
                  fontSize: 14,
                  color: tokens.textLabel,
                  lineHeight: 1.66,
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {note.body.slice(0, 4000)}
                {note.body.length > 4000 && (
                  <span
                    style={{ color: tokens.textMuted }}
                  >{`\n\n… ${note.body.length - 4000} more chars`}</span>
                )}
              </pre>
            </div>

            {note.wikilinks.length > 0 && (
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
                  LINKS — {note.wikilinks.length}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 7,
                    flexWrap: "wrap",
                    marginBottom: 24,
                  }}
                >
                  {note.wikilinks.map((l, j) => (
                    <div
                      key={j}
                      onClick={() => setSelSlug(l)}
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: tokens.decide,
                        background: "#0e0c14",
                        border: "1px solid #221d33",
                        borderRadius: 5,
                        padding: "4px 9px",
                        cursor: "pointer",
                      }}
                    >
                      [[{l}]]
                    </div>
                  ))}
                </div>
              </>
            )}

            {note.backlinks.length > 0 && (
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
                  LINKED MENTIONS — {note.backlinks.length} notes link here
                </div>
                <div style={{ marginBottom: 26 }}>
                  {note.backlinks.map((b, j) => (
                    <div
                      key={j}
                      onClick={() => setSelSlug(b.slug)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 12px",
                        border: `1px solid ${tokens.borderSoft}`,
                        borderLeft: `2px solid ${CATEGORY_COLOR[note.category]}`,
                        borderRadius: 7,
                        marginBottom: 7,
                        cursor: "pointer",
                        background: "#0a0a0c",
                      }}
                    >
                      <span
                        className="ms"
                        style={{
                          fontSize: 14,
                          color: CATEGORY_COLOR[note.category],
                        }}
                      >
                        north_east
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: tokens.textLabel,
                          flex: 1,
                        }}
                      >
                        {b.topic}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: tokens.textFaint }}
                      >
                        note
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div
            className="mono"
            style={{
              padding: "64px 30px",
              fontSize: 12,
              color: tokens.textFaint,
            }}
          >
            {detailQ.isLoading ? "loading note…" : "select a note to read."}
          </div>
        )}
      </div>
    </div>
  );
}
