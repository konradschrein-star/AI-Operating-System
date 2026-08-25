"use client";

/**
 * The run thread rendered on assistant-ui primitives (headless — styled
 * with our tokens, no Tailwind). What this buys over the old hand-rolled
 * list: viewport auto-scroll that respects the user's scroll position,
 * message-part grouping, and first-class tool-call parts so CC's streamed
 * Bash/Read/Write calls render as a live activity timeline.
 *
 * ── Round 602: `mode="summary"` (U23) ─────────────────────────────────────
 * "The agent's prose is the primary reading layer, the machinery the secondary
 * one" (13 §8). In summary mode a tool row's collapsed line is round 601A's
 * `summarizeTool` one-liner — tool, argument gist, outcome — instead of a raw
 * 110-character slice of the JSON payload, and the row loses its filled card
 * so the prose cards are the only thing with weight. An Agent/Task call whose
 * sub-agent was folded into it (see thread-mapping.ts) says how many entries
 * are down there.
 *
 * EXPANDED IS STILL BYTE-COMPLETE. The ARGS/RESULT panes render `argsText` and
 * the result string verbatim, with no clip, no ellipsis and no character cap;
 * the only bound is the pre-existing `maxHeight: 260 + overflowY: auto`, which
 * scrolls rather than truncates. Round 604 measures the expanded text against
 * the API payload byte-for-byte, so anything added here that shortens it is a
 * regression, not a tidy-up.
 *
 * The mode travels by context rather than by prop because `ToolCallRow` is
 * mounted by assistant-ui's `tools: { Fallback }` slot, which passes the
 * message part and nothing of ours.
 *
 * ── Chat reference navigation, round 2: the tool row's path opens ─────────
 * A read/write/edit row NAMES A FILE, and until now that was dead text — the
 * pill work only reached inline `code` in prose, and prose is not where paths
 * mostly live. Both modes now open it, through the same
 * `detectPath` → `openPathTarget` pair as a pill: plain click opens the Files
 * panel, Ctrl/Cmd-click the /document viewer.
 *   · summary — `summary.path`, the whole gist is the target;
 *   · raw     — `toolPath(toolName, argsText)`, and only the sub-range of the
 *               payload slice that IS the path (`visiblePathRange`), so the
 *               manager chat's text does not move by a character.
 * Neither reads the path back out of the rendered string: tool-summary.ts
 * parsed it out of the payload, and that is the value both use. See
 * `ToolCallRow`.
 *
 * THE PATH IS TEXT, NEVER MARKUP. Tool payloads are agent-authored — the same
 * attacker-facing surface MessageMarkdown's header describes. It is rendered as
 * a text child of a span; nothing an agent writes becomes a tag, a URL or a
 * handler, and the only thing a click can do is ask the read-only files API for
 * a path inside a configured root.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { tokens, dot } from "../../tokens";
import type { RunDetail } from "../../api";
import { MessageMarkdown, modifierLabel, openPathTarget } from "./MessageMarkdown";
import { detectPath } from "./code-path-link";
import { RichActionsProvider, RichMessage, type RichActions } from "./RichMessage";
import {
  commsCensus,
  commsHeader,
  commsLedgerLine,
  commsLedgerTitle,
  commsPreview,
  stripCommsPrefix,
  type CommsFacts,
  type PeerFacts,
} from "./comms-identity";
import { readControlEnvelope, type ControlEnvelope } from "./machinery";
import {
  summarizeTool,
  toolPath,
  visiblePathRange,
  type ToolTone,
} from "./tool-summary";
import { extractBrowserShots } from "./browser-shots";
import { BrowserShots } from "./BrowserShots";
import {
  mapThreadToMessages,
  type SubagentFold,
  type ThreadScope,
} from "./thread-mapping";

/** `raw` — the pre-602 collapsed line (tool name + a slice of the payload).
 *  `summary` — 601A's derived one-liner. Expanded is identical in both. */
export type ToolRenderMode = "raw" | "summary";

const ToolRenderModeContext = createContext<ToolRenderMode>("raw");

/**
 * peer run id → what is known about that run: its `metadata.role`, for comms
 * entries written before round 808 started stamping `peer_role` server-side,
 * and (round 1871) its task title, which is what the collapsed card leads with
 * instead of eight hex characters.
 *
 * NO FETCH BACKS THIS. ChatSurface fills it from the team panel's already
 * polled `["chat-team", chatId]` cache; an empty map is the normal state when
 * that panel has never been opened, and the header then falls back through
 * role → short id rather than inventing anything. The context exists because
 * message components are mounted by assistant-ui, which passes its own props
 * and nothing of ours.
 */
const PeerRolesContext = createContext<ReadonlyMap<string, PeerFacts>>(new Map());

/** The `meta.comms` a message carries, when it is relayed traffic. */
function useCommsFacts(): CommsFacts | null {
  return useMessage((m) => {
    const custom = m.metadata?.custom as { comms?: CommsFacts } | undefined;
    return custom?.comms ?? null;
  });
}

function humanAge(ts: Date | undefined): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/* ----------------------------------------------------------------- */

function RoleLabel({
  text,
  color,
  right,
}: {
  text: string;
  color: string;
  right?: boolean;
}) {
  const createdAt = useMessage((m) => m.createdAt);
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        color,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        textAlign: right ? "right" : "left",
      }}
    >
      {text}
      <span style={{ color: tokens.textFaint, marginLeft: 8 }}>
        {humanAge(createdAt ?? undefined)}
      </span>
    </div>
  );
}

/* ── Relayed agent traffic (round 808) ────────────────────────────────────
 *
 * Konrad, reading this chat: "pls colorcode the messages from the builders in
 * this chat so I can faster distinguish."
 *
 * Until this round a worker's report was appended with `role: "user"` (see
 * comms-identity.ts for why the engine needs that) and therefore rendered as
 * an ordinary right-aligned Konrad bubble. This card is the difference: full
 * width, left-aligned like the machine's own output, a 3px rule and a tint in
 * the ROLE's colour, and a header line naming what it is — direction, actor,
 * role, and the eight characters of run id that every log line already
 * prints.
 *
 * Both directions land here. `◂ from · worker · builder · 4e842cc8` is a
 * report coming up; `▸ to · worker · reviewer · 1a2b3c4d` is the echo of what
 * the operator sent down, which is the transcript half Konrad asked for when
 * he said he wanted to see "that you sent them a message and that you received
 * a message from them".
 */
function CommsMessage({ facts }: { facts: CommsFacts }) {
  const peers = useContext(PeerRolesContext);
  const peer = facts.peerRunId ? (peers.get(facts.peerRunId) ?? null) : null;
  const header = commsHeader(facts, peer);
  const { identity } = header;
  /* Round 1871 — COLLAPSED BY DEFAULT, exactly like a Bash row.
   *
   * The customer test counted 117 of these cards with every payload fully
   * expanded and not one collapse control, sitting directly above tool rows
   * that fold to `done ▸`. Konrad's own words for what he wanted are "something
   * similar to the bash command, where I can see that you sent them a message
   * and that you received a message from them" — a LINE, that opens.
   *
   * `useMessage` supplies the body: the same text the expanded card renders,
   * read once for the preview. Nothing is fetched and nothing is derived twice.
   */
  const [open, setOpen] = useState(false);
  const body = useMessage((m) => {
    const first = m.content.find((p) => p.type === "text");
    return first && first.type === "text" ? first.text : "";
  });
  const preview = useMemo(() => commsPreview(stripCommsPrefix(body).body), [body]);

  return (
    <MessagePrimitive.Root
      data-comms-direction={facts.direction}
      data-comms-role={identity.role ?? ""}
      data-comms-peer={facts.peerRunId ?? ""}
      data-comms-open={open ? "true" : "false"}
      /* The same sentence the header line carries, on the CARD — while it is
         collapsed, when the card and the line are the same rectangle. Round
         1874's tester read `title` off this element, found "", and reported the
         cards as having "no tooltip at all"; they had one, on the child. It is
         dropped when the card opens, where a native tooltip following the
         pointer across a paragraph of report prose is noise. */
      title={open ? undefined : header.summary}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div
        style={{
          background: open ? identity.bg : "transparent",
          border: `1px solid ${open ? tokens.border : "transparent"}`,
          borderLeft: `3px solid ${identity.ink}`,
          borderRadius: 10,
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {/* The one line. Direction glyph, who, one-sentence gist, age, caret —
            the same reading order and the same caret glyph ToolCallRow uses,
            so the two block types are one grammar rather than two. */}
        <div
          data-comms-toggle
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={header.summary}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 11px",
            cursor: "pointer",
            userSelect: "none",
            fontSize: 10.5,
          }}
        >
          <span aria-hidden style={{ flex: "none", color: identity.ink }}>
            {header.arrow}
          </span>
          <span
            style={{
              flex: "none",
              color: identity.ink,
              fontWeight: 600,
              maxWidth: 190,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {header.name}
          </span>
          {/* The role, only when it adds something the name did not already
              say — a card headed "Fix cycle 1 · builder" is informative, one
              headed "builder · builder" is noise. */}
          {facts.from !== "konrad" && header.role !== header.name && (
            <span style={{ flex: "none", color: tokens.textMuted2 }}>{header.role}</span>
          )}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textTransform: "none",
            }}
          >
            {preview}
          </span>
          <CommsAge />
          <span style={{ flex: "none", color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
        </div>
        {open && (
          <div
            style={{
              borderTop: `1px solid ${tokens.borderDivider}`,
              padding: "9px 13px",
            }}
          >
            {/* Where the id lives now: visible on the expanded card, out of the
                skim line. `→ sub-agent …` keeps its place beside it. */}
            <div
              className="mono"
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 9,
                letterSpacing: "0.07em",
                color: tokens.textFaint,
                marginBottom: 7,
              }}
            >
              <span>
                {header.preposition} {header.actor}
              </span>
              <span>{header.peer}</span>
              {header.subagent !== null && <span>→ sub-agent {header.subagent}</span>}
            </div>
            <MessagePrimitive.Parts components={{ Text: CommsText }} />
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/** Same age string the role labels print, in the card's own header. */
function CommsAge() {
  const createdAt = useMessage((m) => m.createdAt);
  return (
    <span style={{ color: tokens.textFaint, textTransform: "none" }}>
      {humanAge(createdAt ?? undefined)}
    </span>
  );
}

/**
 * The body. The in-band `[message from worker c8bc5ffa]` label is lifted out —
 * the header above says the same thing, and printing it twice is how a card
 * ends up looking like a quote of itself. It is only removed when it PARSES:
 * an unrecognised prefix stays in the body where Konrad can see it.
 *
 * The rest goes through the same sanitised rich renderer the operator's own
 * prose uses, which is the point of round 808 — a worker's report is markdown
 * written by an agent, and it was being shown as a wall of pre-wrapped text.
 */
function CommsText({ text }: { text: string }) {
  const { body } = stripCommsPrefix(text);
  return <RichMessage source={body} />;
}

function UserMessage() {
  const comms = useCommsFacts();
  if (comms) return <CommsMessage facts={comms} />;
  return (
    <MessagePrimitive.Root
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
      }}
    >
      <RoleLabel text="user" color={tokens.accent} right />
      <div
        style={{
          maxWidth: "82%",
          background: tokens.primaryActionBg,
          border: `1px solid ${tokens.accent}`,
          borderRadius: 10,
          padding: "10px 13px",
          color: tokens.text,
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        <MessagePrimitive.Parts
          components={{
            Text: UserText,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserText({ text }: { text: string }) {
  return <>{text}</>;
}

function AssistantMessage() {
  /* An outbound comms echo arrives as its own assistant message (see
   * thread-mapping) — same card, opposite arrow. */
  const comms = useCommsFacts();
  if (comms) return <CommsMessage facts={comms} />;
  return (
    <MessagePrimitive.Root
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
      }}
    >
      <RoleLabel text="assistant" color={tokens.ok} />
      <div
        style={{
          maxWidth: "88%",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 0,
        }}
      >
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            tools: { Fallback: ToolCallRow },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantText({ text }: { text: string }) {
  /* Round 1871, finding 10. Some "assistant messages" are control-plane
     receipts that were appended to the thread verbatim — `{"queued":true,
     "delivery":"next-turn","echo":true}` rendered as a prose card, which
     is the machine's plumbing wearing the machine's voice. `machinery.ts`
     recognises the closed envelope vocabulary and nothing else; anything it
     does not recognise takes the identical path it took before. */
  const envelope = useMemo(() => readControlEnvelope(text), [text]);
  if (envelope) return <ControlReceipt envelope={envelope} />;
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        padding: "10px 13px",
        color: tokens.text,
        fontSize: 13,
        lineHeight: 1.6,
        overflowWrap: "anywhere",
      }}
    >
      {/* Round 808: the operator's own prose goes through the rich renderer
          too, so `forge:ui` blocks it emits become real controls. Prose with
          no control block takes the identical path it took before — see
          RichMessage's single-segment shortcut. */}
      <RichMessage source={text} />
    </div>
  );
}

/** A receipt, not a sentence the machine said. Same collapsed-line grammar as
 *  a tool row and a comms card; the raw envelope is verbatim behind the caret,
 *  because "the transcript shows what is in the thread" outranks tidiness. */
function ControlReceipt({ envelope }: { envelope: ControlEnvelope }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-control-receipt
      style={{
        border: `1px solid ${tokens.borderDivider}`,
        borderLeft: `2px solid ${tokens.textMuted}`,
        borderRadius: 8,
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "pointer",
          userSelect: "none",
          fontSize: 10.5,
          color: tokens.textMuted,
        }}
      >
        <span style={{ flex: "none", color: tokens.textFaint }}>receipt</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {envelope.label}
        </span>
        <span style={{ flex: "none", color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            borderTop: `1px solid ${tokens.borderDivider}`,
            fontSize: 11,
            lineHeight: 1.5,
            color: tokens.textBody,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          }}
        >
          {envelope.raw}
        </pre>
      )}
    </div>
  );
}

/** Tone → the row's rule and accent. One mapping, both render modes. */
const TONE_COLOR: Record<ToolTone, string> = {
  ok: tokens.info,
  error: tokens.bleed,
  pending: tokens.warn,
};

/**
 * The folded sub-agent's count, sitting on its spawn row: "118 events" is the
 * whole reason the parent's transcript is readable — that many entries are not
 * interleaved into it. Zero is stated, not hidden: an older run's sub-agent
 * really did run with none of its steps stamped into the thread, and pretending
 * the fold is absent would leave the reader wondering where the work went.
 */
function SubagentChip({ fold }: { fold: SubagentFold }) {
  const empty = fold.eventCount === 0;
  return (
    <span
      data-subagent-fold={fold.subagentId}
      title={
        empty
          ? `sub-agent ${fold.subagentId} — no entries in this run's thread carry its id, so its individual steps were never recorded`
          : `sub-agent ${fold.subagentId} — ${fold.eventCount} entries folded out of this transcript`
      }
      style={{
        flex: "none",
        color: empty ? tokens.textFaint : tokens.info,
        border: `1px solid ${tokens.borderDivider}`,
        borderRadius: 4,
        padding: "0 5px",
        lineHeight: "15px",
      }}
    >
      {empty
        ? "no inline events"
        : `${fold.eventCount} event${fold.eventCount === 1 ? "" : "s"}`}
    </span>
  );
}

/** Streamed CC tool call — collapsed one-liner, expandable to args+result. */
function ToolCallRow({
  toolName,
  argsText,
  result,
  isError,
  subagent,
}: {
  toolCallId?: string;
  toolName: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  subagent?: SubagentFold;
}) {
  const mode = useContext(ToolRenderModeContext);
  const [open, setOpen] = useState(false);
  const pending = result === undefined;
  /* The result is a string on every path thread-mapping builds; `unknown` is
   * assistant-ui's part type, not our data. Anything else is coerced rather
   * than dropped, so an unexpected shape is visible instead of blank. */
  const resultText =
    result === undefined ? null : typeof result === "string" ? result : String(result);

  /* One derivation per render, and only in the mode that shows it. The raw
   * mode keeps its 110-char slice byte-for-byte, so nothing about the manager
   * chat moves. */
  const summary = useMemo(
    () =>
      mode === "summary"
        ? summarizeTool(toolName, argsText, resultText, isError === true)
        : null,
    [mode, toolName, argsText, resultText, isError],
  );

  /* Round 1350: screenshots this call took (research-browser via Bash) or
   * opened (Read of /opt/ai-os/uploads/<12hex>/…). Derived from the SAME two
   * strings the row already renders — no new fetch, no new pipeline, and the
   * extractor never throws. Memoized on them because this runs for every tool
   * row of a 300-entry transcript on every poll. */
  const shots = useMemo(
    () => extractBrowserShots({ toolName, argsText, result: resultText }),
    [toolName, argsText, resultText],
  );

  /* ── The path in this row is openable (chat reference navigation, round 2) ──
   *
   * WHY HERE. Inline `code` pills in prose already open; tool rows did not, and
   * this is where paths are DENSEST — a transcript is mostly `read …/x.ts`,
   * `write …/y.sql`. Konrad clicked those first and nothing happened, which
   * reads as "the feature does not work".
   *
   * BOTH MODES, because the mode Konrad reads is the raw one. `mode="summary"`
   * is mounted in exactly one place (AgentChatView's drilled worker view); the
   * manager chat and ProjectsSurface render `mode="raw"`, and the screenshots
   * that opened this round are raw rows — `Write {"file_path":"/opt/…"}`. A fix
   * that only reached summary mode would have missed the surface entirely.
   *
   * NOT A SECOND IMPLEMENTATION. The path comes from tool-summary.ts, which
   * already parsed it out of the payload (no regex over prose, no guessing),
   * and `detectPath` → `openPathTarget` is the same pair the pill uses, so root
   * mapping, search fallback and the never-silent miss behave identically.
   *
   * NEVER A DEAD CLICK. `detectPath` returns null for anything it cannot place
   * in a file root, and an errored call is left plain: a failed Read usually
   * failed BECAUSE the file is not there, and offering to open it is the false
   * affordance code-path-link.ts is written to avoid. */
  const rowPath = useMemo(
    () => (summary ? (summary.path ?? null) : toolPath(toolName, argsText)),
    [summary, toolName, argsText],
  );
  const pathTarget = useMemo(
    () => (rowPath !== null && isError !== true ? detectPath(rowPath) : null),
    [rowPath, isError],
  );
  /* Restraint (the tool row is already busy, and legibility of these blocks is
   * a standing requirement): AT REST the gist looks exactly as it did before —
   * no second underline style running down the transcript. The affordance
   * appears under the pointer, where the question "can I click this?" is
   * actually being asked, and the tooltip names the chord. */
  const [pathHover, setPathHover] = useState(false);

  /** The row's one click target, wrapped around whatever text renders it.
   *  An element factory, not a component: `pathTarget` is captured, and both
   *  modes must produce the SAME affordance and the SAME handler. */
  const openable = (text: string) =>
    pathTarget === null ? (
      text
    ) : (
      <span
        data-openable-path="true"
        data-openable-source="tool"
        title={`click to open ${pathTarget.label} in the Files panel · ${modifierLabel()}-click for a new tab`}
        onMouseEnter={() => setPathHover(true)}
        onMouseLeave={() => setPathHover(false)}
        onClick={(e) => {
          // The row's own onClick toggles the payload pane. Opening a file must
          // not also expand the JSON underneath it.
          e.preventDefault();
          e.stopPropagation();
          void openPathTarget(pathTarget, e.ctrlKey || e.metaKey ? "tab" : "panel");
        }}
        style={{
          cursor: "pointer",
          ...(pathHover
            ? {
                color: "var(--v2-accent-secondary)",
                textDecoration: "underline",
                textDecorationStyle: "dotted" as const,
                textUnderlineOffset: 2,
                textDecorationColor: "rgba(var(--v2-accent-rgb), 0.5)",
              }
            : null),
        }}
      >
        {text}
      </span>
    );

  const color = summary
    ? TONE_COLOR[summary.tone]
    : isError
      ? tokens.bleed
      : pending
        ? tokens.warn
        : tokens.info;
  const argsPreview = (argsText ?? "").replace(/\s+/g, " ").slice(0, 110);

  /* RAW MODE keeps its payload slice byte for byte — the manager chat is
   * Konrad's main surface and this round is not licensed to restyle it. Only
   * the sub-range that IS the path becomes the click target; everything before
   * and after it renders exactly as before, and a slice that cuts the path in
   * half offers the visible half (opening, as always, the whole one). */
  const rawRange = useMemo(
    () => (pathTarget === null ? null : visiblePathRange(argsPreview, rowPath)),
    [pathTarget, argsPreview, rowPath],
  );

  const preStyle: CSSProperties = {
    margin: 0,
    padding: "8px 10px",
    fontSize: 11,
    lineHeight: 1.5,
    color: tokens.textBody,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: 260,
    overflowY: "auto",
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  };

  /* Visual weight (U23): in summary mode the prose keeps its card and the tool
   * row gives up its own — no fill, no full border, just the tone rule left.
   * Expanding restores the panel, because a payload needs a container. */
  const quiet = summary !== null && !open;

  const row = (
    <div
      data-tool-row={mode}
      style={{
        border: `1px solid ${quiet ? "transparent" : tokens.borderDivider}`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 8,
        background: quiet ? "transparent" : tokens.toolBg,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "pointer",
          fontSize: 10.5,
          userSelect: "none",
        }}
      >
        <span style={dot(color, pending)} />
        {summary ? (
          <>
            <span style={{ flex: "none", color: tokens.textLabel, fontWeight: 600 }}>
              {summary.label}
            </span>
            <span
              style={{
                color: tokens.textMuted2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              {/* The click target is the TEXT, not this flex cell: the cell
                  stretches to fill the row, and a click on its empty half must
                  keep meaning "expand", not "open a file". The whole gist is
                  the target here because the whole gist is about that one file
                  — `…/chat/x.ts ×3` is the path plus how many edits it took. */}
              {openable(summary.gist)}
            </span>
            {subagent && <SubagentChip fold={subagent} />}
            <span
              style={{
                flex: "none",
                color: summary.tone === "ok" ? tokens.textFaint : color,
              }}
            >
              → {summary.outcome}
            </span>
            <span style={{ flex: "none", color: tokens.textGhost }}>
              {open ? "▾" : "▸"}
            </span>
          </>
        ) : (
          <>
            <span style={{ color, fontWeight: 600 }}>{toolName}</span>
            <span
              style={{
                color: tokens.textMuted2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {rawRange === null ? (
                argsPreview
              ) : (
                <>
                  {argsPreview.slice(0, rawRange[0])}
                  {openable(argsPreview.slice(rawRange[0], rawRange[1]))}
                  {argsPreview.slice(rawRange[1])}
                </>
              )}
            </span>
            <span style={{ color: tokens.textFaint }}>
              {pending ? "running" : isError ? "error" : "done"} {open ? "▾" : "▸"}
            </span>
          </>
        )}
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${tokens.borderDivider}` }}>
          <div
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              letterSpacing: "0.08em",
              padding: "6px 10px 0",
            }}
          >
            ARGS
          </div>
          <pre style={preStyle}>{argsText ?? "—"}</pre>
          {!pending && (
            <>
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  color: tokens.textFaint,
                  letterSpacing: "0.08em",
                  padding: "6px 10px 0",
                  borderTop: `1px solid ${tokens.borderDivider}`,
                }}
              >
                RESULT
              </div>
              {/* Verbatim. No slice, no clip — round 604 diffs this against
                  the API payload byte-for-byte. */}
              <pre style={preStyle}>{resultText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );

  /* The screenshot block is a SIBLING of the row, not a child: the parts
   * container is already a 6px-gap column (AssistantMessage), so it lands
   * directly under the call it belongs to while keeping its own card. Nesting
   * it inside would put two tone rules on one border-left. Rows with no
   * screenshots — nearly all of them — return exactly what they returned
   * before this round, down to the DOM. */
  if (shots.length === 0) return row;
  return (
    <>
      {row}
      <BrowserShots refs={shots} />
    </>
  );
}

const SYSTEM_KIND_COLOR: Record<string, string> = {
  error: tokens.bleed,
  stuck_notice: tokens.stuck,
  text: tokens.info,
};

function SystemMessage() {
  const kind = useMessage(
    (m) =>
      ((m.metadata?.custom as { kind?: string } | undefined)?.kind ?? "text"),
  );
  const color = SYSTEM_KIND_COLOR[kind] ?? tokens.info;
  return (
    <MessagePrimitive.Root
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderLeft: `2px solid ${color}`,
          /* Was `rgba(79, 176, 196, 0.05)` — a hand-mixed 5% wash of the DARK
           * theme's info hue, so a system line kept a cyan tint in light mode
           * (raw-colour-allowlist.txt's TODO line for this file). `toolBg` is
           * the theme-aware recessed panel; the left rule keeps the hue. */
          background: tokens.toolBg,
          borderRadius: 6,
          fontSize: 12,
          color: tokens.textSecondary,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color,
            letterSpacing: "0.08em",
            marginBottom: 3,
            textTransform: "uppercase",
          }}
        >
          system{kind !== "text" ? ` · ${kind}` : ""}
        </div>
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

/* ----------------------------------------------------------------- */

function ActivityStrip({ run }: { run: RunDetail }) {
  const toolCalls = run.thread.filter((e) => e.kind === "tool_call").length;
  const hbAge = run.last_heartbeat_at
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(run.last_heartbeat_at).getTime()) / 1000),
      )
    : null;
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        border: `1px dashed ${tokens.borderEmphasis}`,
        borderRadius: 8,
        fontSize: 10.5,
        color: tokens.textMuted,
      }}
    >
      <span style={dot(tokens.accent, true)} />
      engine working
      {toolCalls > 0 ? ` · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : ""}
      {hbAge !== null ? ` · heartbeat ${hbAge}s ago` : ""}
    </div>
  );
}

/**
 * The comms ledger — one line above the transcript, when there is traffic in it.
 *
 * Round 1873, finding 6: 119 inbound cards and zero outbound ones is the honest
 * rendering of this thread, and the panel said nothing about it, so a customer
 * reading it concludes the operator never speaks to its agents. This line states
 * the count in both directions and, when one of them is empty, says why and
 * where those records actually live (`commsLedgerTitle`).
 *
 * ABOVE the viewport rather than inside it, deliberately: assistant-ui scrolls
 * its viewport to the bottom, so a note at the top of a 460-entry transcript is
 * a note nobody sees. It is `flex: none` and 9.5px — the same register as the
 * other structural lines on this surface, not a banner.
 */
function CommsLedger({ thread }: { thread: RunDetail["thread"] }) {
  const census = useMemo(() => commsCensus(thread), [thread]);
  const line = commsLedgerLine(census);
  if (line === null) return null;
  return (
    <div
      data-comms-ledger
      data-comms-in={census.in}
      data-comms-out={census.out}
      className="mono"
      title={commsLedgerTitle(census)}
      style={{
        flex: "none",
        padding: "6px 28px",
        fontSize: 9.5,
        letterSpacing: "0.04em",
        lineHeight: 1.5,
        color: census.out === 0 ? tokens.warn : tokens.textFaint,
        borderBottom: `1px solid ${tokens.borderDivider}`,
      }}
    >
      {line}
    </div>
  );
}

/** Nothing is actionable unless a caller says so. A drilled worker view has no
 *  composer, and its controls must render disabled-with-a-reason rather than
 *  appear live and do nothing (RichMessage.tsx). */
const NO_ACTIONS: RichActions = {};
const NO_PEERS: ReadonlyMap<string, PeerFacts> = new Map();

/** How many messages mount initially, and how many each "show older" adds.
 *  60 is not a guess: it comfortably exceeds a full screen at any realistic
 *  row height, so the window is invisible in a normal-length chat and only
 *  engages where the freeze actually was. */
const WINDOW_STEP = 60;

export interface AssistantThreadProps {
  run: RunDetail;
  /** Defaults to `raw` — the manager chat and ProjectsSurface are unchanged. */
  mode?: ToolRenderMode;
  /** Whose story to tell. Defaults to `{ kind: "all" }`, i.e. every entry
   *  inline, which is what every caller got before round 602. */
  scope?: ThreadScope;
  /** What an agent-emitted control may do here (round 808). Omitted → the
   *  controls render disabled and say why. */
  actions?: RichActions;
  /** peer run id → role + task title, for comms entries that predate the
   *  `peer_role` stamp and for the card's display name. Read-only, never
   *  fetched by this component. */
  peers?: ReadonlyMap<string, PeerFacts>;
}

export function AssistantThread({
  run,
  mode = "raw",
  scope,
  actions = NO_ACTIONS,
  peers = NO_PEERS,
}: AssistantThreadProps) {
  /* Deps are the scope's PRIMITIVES, not the object: callers build the scope
   * inline, so a fresh identity every render would re-map a 285-entry thread
   * on every poll tick. This surface is the one where hover cost is measured
   * (project DoD #3); it does not get to re-derive for nothing. */
  const scopeKind = scope?.kind ?? "all";
  const scopeSubagentId = scope?.kind === "subagent" ? scope.subagentId : null;
  const messages = useMemo(
    () =>
      mapThreadToMessages(
        run.thread,
        scopeKind === "subagent" && scopeSubagentId !== null
          ? { scope: { kind: "subagent", subagentId: scopeSubagentId } }
          : scopeKind === "top-level"
            ? { scope: { kind: "top-level" } }
            : undefined,
      ),
    [run.thread, scopeKind, scopeSubagentId],
  );

  /* WINDOWING (2026-08-18). Measured cause of the scroll freeze Konrad
   * reported: this chat's thread is 2200 entries / 2.8 MB and EVERY mapped
   * message was mounted. A long transcript therefore built many thousands of
   * DOM nodes — each message rendering markdown, tool rows and comms cards —
   * in one synchronous commit, which locks the main thread. That is the Long
   * Task; the frozen cursor and the buffered-mouse replay are its symptom.
   *
   * Only the newest WINDOW_STEP messages mount; older ones are reachable by an
   * explicit control. Deliberately NOT virtual scrolling: these rows have
   * wildly variable heights (a one-line tool call vs a 300-line report), and a
   * virtualiser that estimates heights fights the scroll anchor on every poll
   * tick — which on this surface fires every 3s.
   *
   * The window is on RENDER ONLY, never on the data. `messages` stays
   * complete, so the ledger, the digest and every count still describe the
   * whole transcript. A window that also shrank the numbers would make the UI
   * lie about what it holds. */
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  /* Reset on identity change: otherwise opening a short chat after a long one
   * keeps a grown window, and the reverse silently truncates. */
  useEffect(() => {
    setWindowSize(WINDOW_STEP);
  }, [run.id, scopeKind, scopeSubagentId]);

  const hiddenCount = Math.max(0, messages.length - windowSize);
  const windowed = useMemo(
    () => (hiddenCount > 0 ? messages.slice(hiddenCount) : messages),
    [messages, hiddenCount],
  );

  const isRunning = run.status === "running" || run.status === "queued";

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: windowed,
    isRunning,
    convertMessage: (m) => m,
    // The composer lives outside assistant-ui (slash commands need it);
    // onNew is required by the adapter but never fires.
    onNew: async () => {},
  });

  return (
    <ToolRenderModeContext.Provider value={mode}>
      <PeerRolesContext.Provider value={peers}>
        <RichActionsProvider actions={actions}>
          <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root
              style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
            >
              <CommsLedger thread={run.thread} />
              <ThreadPrimitive.Viewport
                className="scroll-tinted"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "20px 28px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                {run.thread.length === 0 && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: tokens.textFaint,
                      textAlign: "center",
                      padding: 24,
                    }}
                  >
                    empty thread
                  </div>
                )}
                {hiddenCount > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 0 12px",
                    }}
                  >
                    <button
                      type="button"
                      className="mono"
                      onClick={() => setWindowSize((n) => n + WINDOW_STEP)}
                      style={{
                        fontSize: 10.5,
                        letterSpacing: "0.04em",
                        padding: "6px 14px",
                        borderRadius: 6,
                        cursor: "pointer",
                        color: tokens.textMuted,
                        background: tokens.bgCard,
                        border: `1px solid ${tokens.borderDivider}`,
                      }}
                    >
                      show {Math.min(WINDOW_STEP, hiddenCount)} older
                    </button>
                    <button
                      type="button"
                      className="mono"
                      onClick={() => setWindowSize(messages.length)}
                      style={{
                        fontSize: 9.5,
                        letterSpacing: "0.04em",
                        padding: 0,
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        color: tokens.textFaint,
                      }}
                      title="Mounts every remaining message at once. On a very long transcript this is the slow path — it is what the window exists to avoid."
                    >
                      {hiddenCount} older hidden · show all
                    </button>
                  </div>
                )}
                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage,
                    SystemMessage,
                  }}
                />
                {isRunning && <ActivityStrip run={run} />}
              </ThreadPrimitive.Viewport>
            </ThreadPrimitive.Root>
          </AssistantRuntimeProvider>
        </RichActionsProvider>
      </PeerRolesContext.Provider>
    </ToolRenderModeContext.Provider>
  );
}
