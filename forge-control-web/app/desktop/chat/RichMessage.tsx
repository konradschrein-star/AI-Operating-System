"use client";

/**
 * RichMessage — prose plus the agent's interactive controls, round 808.
 *
 * Konrad asked for two things in one sentence: messages rendered richly, and
 * "selection elements, you telling me secrets and so on". This component is
 * the second half. The first half is `MessageMarkdown`, which it wraps.
 *
 * ── THE SPLIT, RESTATED WHERE IT IS RENDERED ──────────────────────────────
 * `splitRichSegments` cuts a message into prose and `forge:ui` blocks. Prose
 * goes through the sanitised markdown pipeline. A block has ALREADY been
 * validated against a closed schema by the time it arrives here — this file
 * receives `ChoiceBlock` / `SecretBlock` values, never JSON and never markup.
 * Every string it renders lands in a React text node, and every colour, size
 * and handler is written here, not by the agent.
 *
 * ── WHAT A CONTROL IS ALLOWED TO DO ───────────────────────────────────────
 * Two things, both reversible, neither of which reaches the network on its
 * own:
 *   · a choice option INSERTS its value into the composer draft. It does not
 *     send. Konrad still reads what he is about to say and presses Enter —
 *     an agent-authored button that could send on his behalf is a machine
 *     writing in his voice, which is the one thing this console does not do.
 *   · a secret request OPENS the existing secure panel with the name filled
 *     in. The credential travels through `POST /api/secrets` exactly as it
 *     does today; round 804's sentinel proves that path puts it in neither
 *     the DOM, the thread, nor any response body.
 *
 * ── AND WHEN IT CANNOT ────────────────────────────────────────────────────
 * A drilled worker view has no composer. There, the controls render DISABLED
 * WITH A REASON rather than hidden or silently inert — the same rule the team
 * panel's unavailable actions follow (U8). A button that looks live and does
 * nothing teaches Konrad to distrust every other button.
 */

import { createContext, memo, useContext, useMemo, useState } from "react";
import { tokens } from "../../tokens";
import { MessageMarkdown } from "./MessageMarkdown";
import {
  splitRichSegments,
  type ChoiceBlock,
  type ChoiceOption,
  type RichSegment,
  type SecretBlock,
} from "./rich-blocks";

/** What the surrounding surface lets an agent's control do. Both optional:
 *  absent means "this view cannot", which is rendered, not hidden. */
export interface RichActions {
  /** Append text to the composer draft and focus it. */
  insertDraft?: (text: string) => void;
  /** Open the secure credential panel for `name`. Never carries a value. */
  openSecret?: (name: string) => void;
}

const NO_ACTIONS: RichActions = {};

/* Context rather than props: the message body is rendered several component
 * layers below the surface that owns the composer, through assistant-ui's
 * `MessagePrimitive.Parts` slots, which pass their own props and nothing of
 * ours (the same constraint `ToolRenderModeContext` was created for). */
const RichActionsContext = createContext<RichActions>(NO_ACTIONS);

export function RichActionsProvider({
  actions,
  children,
}: {
  actions: RichActions;
  children: React.ReactNode;
}) {
  return (
    <RichActionsContext.Provider value={actions}>{children}</RichActionsContext.Provider>
  );
}

export function useRichActions(): RichActions {
  return useContext(RichActionsContext);
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

const BLOCK_STYLE: React.CSSProperties = {
  border: `1px solid ${tokens.borderDivider}`,
  borderRadius: 8,
  background: tokens.toolBg,
  padding: "9px 11px",
  margin: "2px 0 8px",
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

function BlockLabel({ text, color }: { text: string; color?: string }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: color ?? tokens.textFaint,
      }}
    >
      {text}
    </div>
  );
}

function ChoiceView({ block }: { block: ChoiceBlock }) {
  const { insertDraft } = useRichActions();
  /** Which values this reader has already put in the draft. Purely local
   *  feedback — nothing is stored, and reloading the thread forgets it,
   *  because the composer is the only real record of what was picked. */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const live = typeof insertDraft === "function";

  const choose = (option: ChoiceOption) => {
    if (!insertDraft) return;
    insertDraft(option.value);
    setPicked((prev) =>
      block.multiple ? [...prev, option.value] : [option.value],
    );
  };

  return (
    <div style={BLOCK_STYLE} data-forge-ui="choice" data-block-id={block.id ?? ""}>
      <BlockLabel
        text={block.multiple ? "choose any" : "choose one"}
        color={tokens.textLabel}
      />
      {block.prompt !== null && (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: tokens.text }}>
          {block.prompt}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {block.options.map((option, i) => {
          const chosen = picked.includes(option.value);
          return (
            <button
              key={`${block.id ?? "opt"}-${i}-${option.value}`}
              type="button"
              disabled={!live}
              onClick={() => choose(option)}
              title={
                live
                  ? `puts "${option.value}" in the composer — nothing is sent until you press Enter`
                  : "this view has no composer to type into"
              }
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 2,
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 12,
                cursor: live ? "pointer" : "not-allowed",
                opacity: live ? 1 : 0.55,
                color: chosen ? tokens.ok : tokens.text,
                background: chosen ? tokens.okActionBg : tokens.bgCard,
                border: `1px solid ${chosen ? tokens.okActionBorder : tokens.border}`,
              }}
            >
              <span>
                {chosen ? "✓ " : ""}
                {option.label}
              </span>
              {option.hint !== null && (
                <span className="mono" style={{ fontSize: 10, color: tokens.textMuted }}>
                  {option.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
        {live
          ? "picking writes into the composer — nothing is sent until you press Enter"
          : "read-only here: open this chat's own view to answer"}
      </div>
    </div>
  );
}

function SecretView({ block }: { block: SecretBlock }) {
  const { openSecret } = useRichActions();
  const live = typeof openSecret === "function";
  return (
    <div style={BLOCK_STYLE} data-forge-ui="secret">
      <BlockLabel text="credential requested" color={tokens.warn} />
      <div style={{ fontSize: 13, lineHeight: 1.5, color: tokens.text }}>
        <span className="mono">{block.name}</span>
        {block.why !== null ? ` — ${block.why}` : ""}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          disabled={!live}
          onClick={() => openSecret?.(block.name)}
          title={
            live
              ? "opens the secure panel; the value is stored on disk and never enters this thread"
              : "this view cannot open the credential panel"
          }
          style={{
            fontSize: 12,
            padding: "6px 11px",
            borderRadius: 6,
            cursor: live ? "pointer" : "not-allowed",
            opacity: live ? 1 : 0.55,
            color: tokens.warn,
            background: tokens.freezeBgWarn,
            border: `1px solid ${tokens.freezeBorderWarn}`,
          }}
        >
          provide securely
        </button>
        <span className="mono" style={{ fontSize: 9.5, color: tokens.textFaint }}>
          the value never enters this thread
        </span>
      </div>
    </div>
  );
}

/** A control that did not survive validation. Shown, with its reason, because
 *  a silently dropped block is a hostile payload's second chance and an honest
 *  agent's invisible bug. */
function InvalidView({ raw, reason }: { raw: string; reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...BLOCK_STYLE, gap: 5 }} data-forge-ui="invalid">
      <BlockLabel text="unreadable control block" color={tokens.bleed} />
      <div style={{ fontSize: 12, color: tokens.textSecondary }}>{reason}</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          alignSelf: "flex-start",
          fontSize: 10,
          padding: "2px 7px",
          borderRadius: 5,
          cursor: "pointer",
          color: tokens.textMuted,
          background: "transparent",
          border: `1px solid ${tokens.borderDivider}`,
        }}
      >
        {open ? "▾ hide payload" : "▸ show payload"}
      </button>
      {open && (
        <pre
          className="mono"
          style={{
            margin: 0,
            fontSize: 11,
            lineHeight: 1.5,
            color: tokens.textBody,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {raw}
        </pre>
      )}
    </div>
  );
}

function Segment({ segment }: { segment: RichSegment }) {
  if (segment.kind === "markdown") return <MessageMarkdown source={segment.text} />;
  if (segment.kind === "invalid") {
    return <InvalidView raw={segment.raw} reason={segment.reason} />;
  }
  return segment.block.kind === "choice" ? (
    <ChoiceView block={segment.block} />
  ) : (
    <SecretView block={segment.block} />
  );
}

/**
 * MEMOISED on `source` for the same reason `MessageMarkdown` is: this renders
 * once per message in a thread that can hold 600 of them, and the split is a
 * full scan of the text. `RichActions` travels by context precisely so it
 * cannot become a second prop that breaks that memo on every parent render.
 */
export const RichMessage = memo(function RichMessage({ source }: { source: string }) {
  const segments = useMemo(() => splitRichSegments(source), [source]);
  /* No control block in the message — the overwhelmingly common case — costs
   * exactly what it cost before: one MessageMarkdown, no wrapper. */
  if (segments.length === 1 && segments[0].kind === "markdown") {
    return <MessageMarkdown source={segments[0].text} />;
  }
  return (
    <>
      {segments.map((segment, i) => (
        <Segment key={`seg-${i}`} segment={segment} />
      ))}
    </>
  );
});
