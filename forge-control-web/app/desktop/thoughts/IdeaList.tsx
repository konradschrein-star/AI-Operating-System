"use client";

/**
 * The idea pool, one row per idea.
 *
 * The row is built around the age, not around the title: the leading number is
 * the largest thing on the line, because the default view exists to make an
 * idea that has sat untouched for four months uncomfortable to look at. That is
 * Konrad's own doctrine — "un-executed ideas are of course bullshit" — rendered
 * rather than written down somewhere.
 *
 * Rows are drawn in the order the server sent them. Every view's ordering lives
 * in forge-control/src/lib/thoughts.ts (`applyView`); a second sort here would
 * be a second source of truth for "oldest first".
 *
 * A seed (`author: "forge"`) is an idea an agent derived from one of his notes.
 * It carries a *derived* badge and an Adopt button, and adopting it MOVES the
 * file onto his side of the vault — that is the correction step, and it is the
 * only thing on this surface that is not a plain edit.
 */

import type { CSSProperties } from "react";
import { tokens } from "../../tokens";
import { areaColor } from "../goals/ui";
import type { Idea, ThoughtsView } from "../../api";
import { ageText, ageTone, isSeed, type AgeTone } from "./pool";

/** The 1..10 importance ramp, in tokens only (raw hexes are a gate failure and
 *  a theme bug: a colour tuned against near-black turns to mud on paper). Four
 *  bands rather than ten shades — ten indistinguishable greys carry no more
 *  information than four legible ones. */
export function importanceColor(importance: number): string {
  if (importance >= 9) return tokens.bleed;
  if (importance >= 7) return tokens.warn;
  if (importance >= 4) return tokens.info;
  return tokens.textGhost;
}

const AGE_COLOR: Record<AgeTone, string> = {
  stale: tokens.bleed,
  ageing: tokens.warn,
  fresh: tokens.textSoft,
  settled: tokens.textGhost,
};

export function statusColor(status: string): string {
  switch (status) {
    case "done":
      return tokens.ok;
    case "executing":
      return tokens.accent;
    case "started":
      return tokens.info;
    case "dropped":
      return tokens.textGhost;
    default:
      return tokens.textMuted;
  }
}

export interface IdeaListProps {
  ideas: Idea[];
  view: ThoughtsView;
  loading: boolean;
  /** Per-file parse failures from the same response. Shown, never swallowed:
   *  a note Konrad hand-edited in Obsidian into an unparseable state must not
   *  quietly shrink his pool. */
  errors: { path: string; message: string }[];
  selectedPath: string | null;
  onOpen: (idea: Idea) => void;
  onAdopt: (idea: Idea) => void;
  adoptingPath: string | null;
}

export function IdeaList({
  ideas,
  view,
  loading,
  errors,
  selectedPath,
  onOpen,
  onAdopt,
  adoptingPath,
}: IdeaListProps) {
  if (loading && ideas.length === 0) {
    return (
      <div className="mono" style={{ fontSize: 11, color: tokens.textGhost, padding: "18px 2px" }}>
        reading the vault…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {errors.length > 0 && (
        <div
          style={{
            border: `1px solid ${tokens.dangerActionBorder}`,
            background: tokens.dangerActionBg,
            borderRadius: 8,
            padding: "9px 11px",
            marginBottom: 4,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 9, letterSpacing: "0.12em", color: tokens.bleed, marginBottom: 4 }}
          >
            {errors.length} FILE{errors.length === 1 ? "" : "S"} COULD NOT BE READ
          </div>
          {errors.map((e) => (
            <div key={e.path} className="mono" style={{ fontSize: 10, color: tokens.textMuted, lineHeight: 1.5 }}>
              {e.path} — {e.message}
            </div>
          ))}
        </div>
      )}

      {ideas.length === 0 && <EmptyPool view={view} />}

      {ideas.map((idea) => (
        <IdeaRow
          key={idea.path}
          idea={idea}
          selected={idea.path === selectedPath}
          onOpen={onOpen}
          onAdopt={onAdopt}
          adopting={idea.path === adoptingPath}
        />
      ))}
    </div>
  );
}

/** An empty pool says what will fill it — the seed script derives the first
 *  batch from his Project notes, so the page is full before he touches it
 *  (PLAN.md §3.2). A blank box here would be the exact failure this whole
 *  project exists to undo. */
function EmptyPool({ view }: { view: ThoughtsView }) {
  const line =
    view === "executed"
      ? "Nothing executed yet — an idea moves here the moment you set it to started."
      : view === "area"
        ? "No ideas in this area yet — capture one above, or check another area."
        : "No ideas yet — the seed script derives the first batch from your Project notes.";
  return (
    <div
      style={{
        border: `1px dashed ${tokens.border}`,
        borderRadius: 10,
        padding: "20px 18px",
        color: tokens.textMuted,
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      {line}
    </div>
  );
}

function IdeaRow({
  idea,
  selected,
  onOpen,
  onAdopt,
  adopting,
}: {
  idea: Idea;
  selected: boolean;
  onOpen: (idea: Idea) => void;
  onAdopt: (idea: Idea) => void;
  adopting: boolean;
}) {
  const tone = ageTone(idea);
  const seed = isSeed(idea);

  return (
    <div
      onClick={() => onOpen(idea)}
      data-idea-path={idea.path}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? tokens.rowSelected : tokens.bgCard,
        border: `1px solid ${selected ? tokens.borderEmphasis : tokens.border}`,
        borderLeft: `3px solid ${importanceColor(idea.importance)}`,
      }}
    >
      {/* The number that does the arguing. */}
      <div style={{ minWidth: 58, textAlign: "right", flexShrink: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 22,
            lineHeight: 1.05,
            fontWeight: 700,
            color: AGE_COLOR[tone],
            letterSpacing: "-0.02em",
          }}
        >
          {ageText(idea.age_days)}
        </div>
        <div className="mono" style={{ fontSize: 8.5, color: tokens.textGhost, letterSpacing: "0.08em" }}>
          {idea.created}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.4, color: tokens.textHi }}>{idea.idea}</div>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          <Chip text={idea.area} color={areaColor(idea.area)} />
          <Chip text={`importance ${idea.importance}`} color={importanceColor(idea.importance)} />
          <Chip text={idea.status} color={statusColor(idea.status)} />
          {seed && <Chip text="derived" color={tokens.decide} />}
        </div>
      </div>

      {seed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdopt(idea);
          }}
          disabled={adopting}
          title={`Move ${idea.path} onto your side of the vault`}
          style={adoptButton()}
        >
          {adopting ? "adopting…" : "Adopt"}
        </button>
      )}
    </div>
  );
}

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9,
        padding: "2px 6px",
        borderRadius: 4,
        border: `1px solid ${tokens.borderSoft}`,
        background: tokens.toolBg,
        color,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function adoptButton(): CSSProperties {
  return {
    flexShrink: 0,
    alignSelf: "center",
    padding: "6px 12px",
    borderRadius: 7,
    border: `1px solid ${tokens.border}`,
    background: tokens.toolBg,
    color: tokens.textSoft,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
