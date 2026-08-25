"use client";

/**
 * The habit strip — one time-block at a time, plus the day's two numbers.
 *
 * The old surface put all eighteen habits on screen at once and asked for them
 * at the end of the day. Result, measured over thirty days: not one tick. The
 * same list in Notion, over the ten days he screenshotted: also not one tick.
 * Two independent systems, identical outcome, so the list is not the problem —
 * being asked for eighteen things at once, once a day, is.
 *
 * So: the block that is plausible *now* is open, the others are collapsed to a
 * count. Five or six taps, three times a day, and you never open it to a screen
 * that is mostly failure.
 */

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import {
  BLOCK_LABEL,
  BLOCK_ORDER,
  blockOf,
  currentBlock,
  habitScore,
  type HabitBlock,
} from "./pressure";
import type { DayHabitWithStreak, DayHabitTick } from "../../api";

export interface HabitStripProps {
  habits: DayHabitWithStreak[];
  ticks: DayHabitTick[];
  subjective: number | null;
  onTick: (habitId: string, done: boolean) => void | Promise<void>;
  onSubjective: (value: number) => void | Promise<void>;
}

/** 1 (bad) → 10 (great), red through amber to green. */
function ratingColor(n: number): string {
  if (n <= 2) return tokens.bleed;
  if (n <= 4) return tokens.stuck;
  if (n <= 6) return tokens.warn;
  if (n <= 8) return tokens.info;
  return tokens.ok;
}

export function HabitStrip({ habits, ticks, subjective, onTick, onSubjective }: HabitStripProps) {
  const [open, setOpen] = useState<HabitBlock>(() => currentBlock(new Date().getHours()));

  const done = useMemo(
    () => new Set(ticks.filter((t) => t.done).map((t) => t.habit_id)),
    [ticks],
  );
  const active = useMemo(() => habits.filter((h) => h.active !== false), [habits]);
  const score = habitScore(active, done);

  const grouped = useMemo(() => {
    const m = new Map<HabitBlock, DayHabitWithStreak[]>();
    for (const b of BLOCK_ORDER) m.set(b, []);
    for (const h of active) m.get(blockOf(h))?.push(h);
    return m;
  }, [active]);

  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        background: tokens.bgCard,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Headline row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: tokens.textHi, lineHeight: 1 }}>
            {score}
          </span>
          <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
            / 100 today
          </span>
        </div>

        <div style={{ flex: 1, minWidth: 80, height: 5, background: tokens.bgGutter, borderRadius: 3 }}>
          <div
            style={{
              width: `${score}%`,
              height: "100%",
              borderRadius: 3,
              background: score >= 70 ? tokens.ok : score >= 40 ? tokens.warn : tokens.bleed,
              transition: "width 160ms ease",
            }}
          />
        </div>

        {/* Subjective 1–10 — the only number the score cannot derive, and the
            one that makes the other columns mean something after 60 days. */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span className="mono" style={{ fontSize: 9, color: tokens.textGhost, marginRight: 2 }}>
            FELT
          </span>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const on = subjective === n;
            return (
              <button
                key={n}
                onClick={() => void onSubjective(n)}
                title={`${n}/10`}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: on ? `1px solid ${ratingColor(n)}` : `1px solid ${tokens.borderSoft}`,
                  background: on ? ratingColor(n) : "transparent",
                  color: on ? tokens.onAccent : tokens.textGhost,
                  fontSize: 10,
                  fontWeight: on ? 700 : 400,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>

      {/* Block tabs */}
      <div style={{ display: "flex", gap: 5 }}>
        {BLOCK_ORDER.map((b) => {
          const list = grouped.get(b) ?? [];
          if (list.length === 0) return null;
          const hit = list.filter((h) => done.has(h.id)).length;
          const isOpen = b === open;
          return (
            <button
              key={b}
              onClick={() => setOpen(b)}
              style={{
                padding: "4px 9px",
                borderRadius: 6,
                border: `1px solid ${isOpen ? tokens.accent : tokens.borderSoft}`,
                background: isOpen ? `${tokens.accent}1a` : "transparent",
                color: isOpen ? tokens.accent : tokens.textSoft,
                fontSize: 11,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {BLOCK_LABEL[b]}{" "}
              <span className="mono" style={{ opacity: 0.7, fontSize: 9 }}>
                {hit}/{list.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* The open block */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {(grouped.get(open) ?? []).map((h) => {
          const on = done.has(h.id);
          return (
            <button
              key={h.id}
              onClick={() => void onTick(h.id, !on)}
              title={h.streak > 0 ? `${h.label} · ${h.streak} day streak` : h.label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                borderRadius: 7,
                border: `1px solid ${on ? tokens.ok : tokens.borderSoft}`,
                background: on ? `${tokens.ok}1f` : tokens.bgGutter,
                color: on ? tokens.ok : tokens.textSoft,
                fontSize: 11.5,
                cursor: "pointer",
                minHeight: 32,
              }}
            >
              <span
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: 3,
                  border: `1px solid ${on ? tokens.ok : tokens.borderEmphasis}`,
                  background: on ? tokens.ok : "transparent",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  color: tokens.onAccent,
                  flexShrink: 0,
                }}
              >
                {on ? "✓" : ""}
              </span>
              {h.label}
              {h.streak > 1 && (
                <span className="mono" style={{ fontSize: 9, opacity: 0.7 }}>
                  {h.streak}d
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
