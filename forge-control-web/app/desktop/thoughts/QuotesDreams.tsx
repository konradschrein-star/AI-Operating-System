"use client";

/**
 * Quotes & dreams — the two append-only lists beside the pool.
 *
 * `Thoughts/Quotes.md` and `Thoughts/Dreams.md` are one markdown line per
 * entry (`- "…" — source (date)`), so the vault stays readable in Obsidian
 * without this console. Append-only in the store AND here: there is no edit and
 * no delete control, because the store exposes neither — a line is corrected by
 * opening the note in Obsidian, which is the honest place to do it.
 *
 * Both boxes commit on Enter, like the idea line. A quote may carry a source;
 * an unsourced one is stored as his own.
 */

import { useState, type CSSProperties } from "react";
import { tokens } from "../../tokens";
import type { Dream, Quote } from "../../api";

export interface QuotesDreamsProps {
  quotes: Quote[];
  dreams: Dream[];
  onAddQuote: (text: string, source?: string) => void | Promise<void>;
  onAddDream: (text: string) => void | Promise<void>;
  busy: boolean;
}

export function QuotesDreams({ quotes, dreams, onAddQuote, onAddDream, busy }: QuotesDreamsProps) {
  const [quoteDraft, setQuoteDraft] = useState("");
  const [sourceDraft, setSourceDraft] = useState("");
  const [dreamDraft, setDreamDraft] = useState("");

  const submitQuote = (): void => {
    const text = quoteDraft.trim();
    if (!text) return;
    const source = sourceDraft.trim();
    setQuoteDraft("");
    setSourceDraft("");
    void onAddQuote(text, source || undefined);
  };

  const submitDream = (): void => {
    const text = dreamDraft.trim();
    if (!text) return;
    setDreamDraft("");
    void onAddDream(text);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 7, minHeight: 0 }}>
        <Label>Quotes &amp; inspiration · {quotes.length}</Label>
        <div style={{ display: "flex", gap: 5 }}>
          <input
            value={quoteDraft}
            onChange={(e) => setQuoteDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitQuote()}
            disabled={busy}
            data-quote-add
            placeholder="A line worth keeping"
            style={{ ...input(), flex: 1 }}
          />
          <input
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitQuote()}
            disabled={busy}
            placeholder="who"
            style={{ ...input(), width: 84 }}
          />
        </div>
        <List
          empty="No quotes yet — anything you would want to read again in a year."
          rows={quotes.map((q) => ({
            key: `${q.date}-${q.text}`,
            text: `“${q.text}”`,
            meta: `${q.source} · ${q.date}`,
          }))}
        />
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 7, minHeight: 0 }}>
        <Label>Dreams · {dreams.length}</Label>
        <input
          value={dreamDraft}
          onChange={(e) => setDreamDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitDream()}
          disabled={busy}
          data-dream-add
          placeholder="A dream, before it evaporates"
          style={input()}
        />
        <List
          empty="No dreams yet — the ones written down within a minute are the ones you still have."
          rows={dreams.map((d) => ({ key: `${d.date}-${d.text}`, text: d.text, meta: d.date }))}
        />
      </section>
    </div>
  );
}

function List({
  rows,
  empty,
}: {
  rows: { key: string; text: string; meta: string }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          border: `1px dashed ${tokens.border}`,
          borderRadius: 8,
          padding: "12px 11px",
          fontSize: 11.5,
          color: tokens.textMuted,
          lineHeight: 1.5,
        }}
      >
        {empty}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, overflowY: "auto" }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{
            padding: "7px 9px",
            borderRadius: 7,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div style={{ fontSize: 12, color: tokens.textHi, lineHeight: 1.45 }}>{r.text}</div>
          <div className="mono" style={{ fontSize: 9, color: tokens.textGhost, marginTop: 3 }}>
            {r.meta}
          </div>
        </div>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mono"
      style={{ fontSize: 9, letterSpacing: "0.12em", color: tokens.textFaint, textTransform: "uppercase" }}
    >
      {children}
    </span>
  );
}

function input(): CSSProperties {
  return {
    padding: "8px 10px",
    borderRadius: 7,
    border: `1px solid ${tokens.border}`,
    background: tokens.inputBg,
    color: tokens.textHi,
    fontSize: 12,
    outline: "none",
    fontFamily: "inherit",
    minWidth: 0,
  };
}
