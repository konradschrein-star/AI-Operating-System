"use client";

/**
 * Quick-add: one line, one Enter, one idea.
 *
 * The capture box is the only part of this surface that has to be faster than
 * thinking about it — an idea that needs a form is an idea that does not get
 * written down. So the line is the idea, and area and importance are two chips
 * sitting beside it with defaults already chosen (`business`, 5). Nothing is
 * required beyond the sentence.
 *
 * Same shape as `goals/TaskRail`'s quick-add line, minus the `!`/`@` token
 * menus: five areas fit on screen as chips, so there is nothing to remember
 * and nothing to parse out of the text.
 */

import { useState, type CSSProperties } from "react";
import { tokens } from "../../tokens";
import { areaColor } from "../goals/ui";
import type { CreateIdeaInput, ThoughtArea } from "../../api";
import { AREAS } from "./pool";

const IMPORTANCE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export interface IdeaFormProps {
  onCreate: (input: CreateIdeaInput) => void | Promise<void>;
  busy: boolean;
  /** Area to pre-select — the BY AREA view hands its current area through, so
   *  capturing while filtered to health files it under health. */
  defaultArea?: ThoughtArea;
}

export function IdeaForm({ onCreate, busy, defaultArea }: IdeaFormProps) {
  const [draft, setDraft] = useState("");
  const [area, setArea] = useState<ThoughtArea>(defaultArea ?? "business");
  const [importance, setImportance] = useState(5);
  const [impOpen, setImpOpen] = useState(false);

  const submit = (): void => {
    const idea = draft.trim();
    if (!idea) return;
    setDraft("");
    void onCreate({ idea, area, importance });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        disabled={busy}
        data-idea-quick-add
        placeholder="An idea, one line. Enter files it."
        style={{
          width: "100%",
          padding: "11px 13px",
          borderRadius: 9,
          border: `1px solid ${tokens.border}`,
          background: tokens.inputBg,
          color: tokens.textHi,
          fontSize: 13.5,
          outline: "none",
          fontFamily: "inherit",
        }}
      />

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        {AREAS.map((a) => (
          <button key={a} onClick={() => setArea(a)} style={chip(area === a, areaColor(a))}>
            {a}
          </button>
        ))}

        <div style={{ position: "relative", marginLeft: "auto" }}>
          <button
            onClick={() => setImpOpen((v) => !v)}
            title="importance 1–10"
            style={chip(true, tokens.textSoft)}
          >
            importance {importance}
          </button>
          {impOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                zIndex: 30,
                display: "flex",
                gap: 3,
                padding: 5,
                background: tokens.bgCard,
                border: `1px solid ${tokens.borderEmphasis}`,
                borderRadius: 8,
                boxShadow: tokens.shadowPopover,
              }}
            >
              {IMPORTANCE_VALUES.map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setImportance(n);
                    setImpOpen(false);
                  }}
                  style={{ ...chip(importance === n, tokens.textSoft), minWidth: 30, justifyContent: "center" }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function chip(active: boolean, color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 6,
    border: `1px solid ${active ? color : tokens.borderSoft}`,
    background: active ? tokens.selectedBg : "transparent",
    color: active ? color : tokens.textMuted,
    fontSize: 11,
    cursor: "pointer",
  };
}
