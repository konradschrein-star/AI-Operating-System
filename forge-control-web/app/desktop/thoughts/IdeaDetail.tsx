"use client";

/**
 * The idea behind a click on a row — the whole record, editable.
 *
 * Same shape as `goals/TaskDetail.tsx` (overlay, one card, facts first, fields
 * below, Save at the bottom left) so the two surfaces feel like one console.
 *
 * The one thing this has that TaskDetail does not is compare-and-swap. The
 * store is a file in the Obsidian vault, which Syncthing replicates
 * last-writer-wins and never merges, and both Konrad-in-Obsidian and a seed
 * script can write it. So every save carries the `sha256` the drawer loaded
 * with; if the file moved underneath, the API answers 409 and this refuses to
 * overwrite, says so, and refetches. Nothing here silently wins a race.
 *
 * There is no Delete. Ideas are not deleted, they are `dropped` — a status,
 * which keeps the record and the reason. The vault rule is append-or-create,
 * and this surface honours it.
 */

import { useEffect, useState } from "react";
import { tokens } from "../../tokens";
import { areaColor } from "../goals/ui";
import {
  IdeaConflictError,
  updateIdea,
  type Idea,
  type IdeaExecutionStatus,
  type ThoughtArea,
  type UpdateIdeaFields,
} from "../../api";
import { AREAS, STATUSES, ageText, isSeed } from "./pool";
import { importanceColor, statusColor } from "./IdeaList";

const IMPORTANCE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export interface IdeaDetailProps {
  idea: Idea;
  onClose: () => void;
  /** Saved successfully — the surface refetches and keeps the drawer open on
   *  the fresh copy. */
  onSaved: (saved: Idea) => void;
  /** A CAS miss: the caller refetches the pool so the next open reads the
   *  file as it now is. */
  onConflict: () => void;
  onAdopt: (idea: Idea) => void;
}

export function IdeaDetail({ idea, onClose, onSaved, onConflict, onAdopt }: IdeaDetailProps) {
  const [line, setLine] = useState(idea.idea);
  const [area, setArea] = useState<ThoughtArea>(idea.area);
  const [importance, setImportance] = useState(idea.importance);
  const [status, setStatus] = useState<IdeaExecutionStatus>(idea.status);
  const [description, setDescription] = useState(idea.description);
  const [whyGenius, setWhyGenius] = useState(idea.why_genius);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  /* Keyed on `path` + `sha256`: a refetch that returns the same bytes must not
   * throw away half-typed edits, but a genuinely different revision (adopted,
   * saved, changed in Obsidian) must reload the fields. */
  useEffect(() => {
    setLine(idea.idea);
    setArea(idea.area);
    setImportance(idea.importance);
    setStatus(idea.status);
    setDescription(idea.description);
    setWhyGenius(idea.why_genius);
    setErr(null);
    setConflict(false);
  }, [idea.path, idea.sha256]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (fields?: UpdateIdeaFields): Promise<void> => {
    setSaving(true);
    setErr(null);
    setConflict(false);
    try {
      const body: UpdateIdeaFields = fields ?? {
        idea: line.trim() || idea.idea,
        area,
        importance,
        status,
        description,
        why_genius: whyGenius,
      };
      const r = await updateIdea(idea.path, idea.sha256, body);
      onSaved(r.idea);
    } catch (e) {
      if (e instanceof IdeaConflictError) {
        setConflict(true);
        setErr(
          `changed elsewhere — reload. ${e.message}${
            e.currentSha256 ? ` (now ${e.currentSha256.slice(0, 12)}…)` : ""
          }`,
        );
        onConflict();
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  /** A status button saves immediately — it is the one field whose whole point
   *  is being one click away from the list. The rest wait for Save. */
  const setStatusNow = (next: IdeaExecutionStatus): void => {
    setStatus(next);
    void save({
      idea: line.trim() || idea.idea,
      area,
      importance,
      status: next,
      description,
      why_genius: whyGenius,
    });
  };

  return (
    <div
      onClick={onClose}
      data-idea-detail
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.overlay,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "flex-end",
        zIndex: 400,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          height: "100%",
          overflowY: "auto",
          background: tokens.bgCard,
          borderLeft: `1px solid ${tokens.borderEmphasis}`,
          boxShadow: tokens.shadowPopover,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="mono"
            style={{ fontSize: 9, letterSpacing: "0.14em", color: tokens.textGhost }}
          >
            IDEA
          </span>
          {isSeed(idea) && (
            <>
              <span className="mono" style={{ fontSize: 9, color: tokens.decide, letterSpacing: "0.1em" }}>
                DERIVED
              </span>
              <button onClick={() => onAdopt(idea)} style={ghost()}>
                Adopt
              </button>
            </>
          )}
          <button onClick={onClose} style={{ ...ghost(), marginLeft: "auto" }}>
            Close
          </button>
        </div>

        <textarea
          value={line}
          onChange={(e) => setLine(e.target.value.replace(/\n/g, " "))}
          rows={2}
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: tokens.textHi,
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${tokens.borderSoft}`,
            padding: "2px 0 8px",
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            lineHeight: 1.35,
          }}
        />

        {/* Facts the store already knows — shown, not asked for. */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Fact label="age" value={ageText(idea.age_days)} tone={ageToneColor(idea)} />
          <Fact label="created" value={idea.created} />
          <Fact label="author" value={idea.author} />
          <Fact label="source" value={idea.source} />
        </div>
        <div className="mono" style={{ fontSize: 9, color: tokens.textGhost, wordBreak: "break-all" }}>
          {idea.path}
        </div>

        <Field label="Execution status — a click saves it">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatusNow(s)}
                disabled={saving}
                style={pill(status === s, statusColor(s))}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Life area">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {AREAS.map((a) => (
              <button key={a} onClick={() => setArea(a)} style={pill(area === a, areaColor(a))}>
                {a}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Importance 1–10">
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {IMPORTANCE_VALUES.map((n) => (
              <button
                key={n}
                onClick={() => setImportance(n)}
                style={{
                  ...pill(importance === n, importanceColor(n)),
                  minWidth: 34,
                  justifyContent: "center",
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="What the idea actually is, in enough detail that it survives a month in the drawer."
            style={textareaStyle()}
          />
        </Field>

        <Field label="Why it is genius">
          <textarea
            value={whyGenius}
            onChange={(e) => setWhyGenius(e.target.value)}
            rows={5}
            placeholder="The argument for it. If you cannot write one, that is an answer too."
            style={textareaStyle()}
          />
        </Field>

        {err && (
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: conflict ? tokens.warn : tokens.bleed,
              lineHeight: 1.5,
              border: `1px solid ${conflict ? tokens.freezeBorderWarn : tokens.dangerActionBorder}`,
              background: conflict ? tokens.freezeBgWarn : tokens.dangerActionBg,
              borderRadius: 7,
              padding: "8px 10px",
            }}
          >
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 6 }}>
          <button
            onClick={() => void save()}
            disabled={saving || conflict}
            title={conflict ? "the file changed on disk — close and reopen to load it" : undefined}
            style={{
              padding: "8px 18px",
              borderRadius: 7,
              border: "none",
              background: tokens.accent,
              color: tokens.onAccent,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: saving || conflict ? "not-allowed" : "pointer",
              opacity: saving || conflict ? 0.6 : 1,
            }}
          >
            {saving ? "saving…" : "Save"}
          </button>
          <button onClick={onClose} style={ghost()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ageToneColor(idea: Idea): string | undefined {
  if (idea.status !== "not-started") return undefined;
  if (idea.age_days >= 90) return tokens.bleed;
  if (idea.age_days >= 30) return tokens.warn;
  return undefined;
}

function pill(active: boolean, color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    borderRadius: 6,
    border: `1px solid ${active ? color : tokens.borderSoft}`,
    background: active ? tokens.selectedBg : "transparent",
    color: active ? color : tokens.textSoft,
    fontSize: 11,
    cursor: "pointer",
  };
}

function ghost(): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 7,
    border: `1px solid ${tokens.border}`,
    background: "transparent",
    color: tokens.textSoft,
    fontSize: 11.5,
    cursor: "pointer",
  };
}

function textareaStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 7,
    border: `1px solid ${tokens.border}`,
    background: tokens.inputBg,
    color: tokens.textHi,
    fontSize: 12.5,
    lineHeight: 1.5,
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: "0.12em",
          color: tokens.textGhost,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span className="mono" style={{ fontSize: 8.5, color: tokens.textGhost, letterSpacing: "0.1em" }}>
        {label.toUpperCase()}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: tone ?? tokens.textSoft,
          maxWidth: 200,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}
