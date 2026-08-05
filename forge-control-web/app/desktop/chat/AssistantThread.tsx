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
 */

import {
  createContext,
  useContext,
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
import { MessageMarkdown } from "./MessageMarkdown";
import { summarizeTool, type ToolTone } from "./tool-summary";
import {
  mapThreadToMessages,
  type SubagentFold,
  type ThreadScope,
} from "./thread-mapping";

/** `raw` — the pre-602 collapsed line (tool name + a slice of the payload).
 *  `summary` — 601A's derived one-liner. Expanded is identical in both. */
export type ToolRenderMode = "raw" | "summary";

const ToolRenderModeContext = createContext<ToolRenderMode>("raw");

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

function UserMessage() {
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
      <MessageMarkdown source={text} />
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

  const color = summary
    ? TONE_COLOR[summary.tone]
    : isError
      ? tokens.bleed
      : pending
        ? tokens.warn
        : tokens.info;
  const argsPreview = (argsText ?? "").replace(/\s+/g, " ").slice(0, 110);

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

  return (
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
              {summary.gist}
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
              {argsPreview}
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
          background: "rgba(79, 176, 196, 0.05)",
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

export interface AssistantThreadProps {
  run: RunDetail;
  /** Defaults to `raw` — the manager chat and ProjectsSurface are unchanged. */
  mode?: ToolRenderMode;
  /** Whose story to tell. Defaults to `{ kind: "all" }`, i.e. every entry
   *  inline, which is what every caller got before round 602. */
  scope?: ThreadScope;
}

export function AssistantThread({ run, mode = "raw", scope }: AssistantThreadProps) {
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
  const isRunning = run.status === "running" || run.status === "queued";

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (m) => m,
    // The composer lives outside assistant-ui (slash commands need it);
    // onNew is required by the adapter but never fires.
    onNew: async () => {},
  });

  return (
    <ToolRenderModeContext.Provider value={mode}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
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
    </ToolRenderModeContext.Provider>
  );
}
