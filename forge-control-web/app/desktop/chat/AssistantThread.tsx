"use client";

/**
 * The run thread rendered on assistant-ui primitives (headless — styled
 * with our tokens, no Tailwind). What this buys over the old hand-rolled
 * list: viewport auto-scroll that respects the user's scroll position,
 * message-part grouping, and first-class tool-call parts so CC's streamed
 * Bash/Read/Write calls render as a live activity timeline.
 */

import { useMemo, useState, type CSSProperties } from "react";
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
import { mapThreadToMessages } from "./thread-mapping";

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

/** Streamed CC tool call — collapsed one-liner, expandable to args+result. */
function ToolCallRow({
  toolName,
  argsText,
  result,
  isError,
}: {
  toolCallId?: string;
  toolName: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = result === undefined;
  const color = isError ? tokens.bleed : pending ? tokens.warn : tokens.info;
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

  return (
    <div
      style={{
        border: `1px solid ${tokens.borderDivider}`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 8,
        background: "#0a0a0c",
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
              <pre style={preStyle}>{String(result)}</pre>
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

export function AssistantThread({ run }: { run: RunDetail }) {
  const messages = useMemo(
    () => mapThreadToMessages(run.thread),
    [run.thread],
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
  );
}
