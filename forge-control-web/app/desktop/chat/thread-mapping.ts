/**
 * runs.thread (flat ThreadEntry[]) → assistant-ui ThreadMessageLike[].
 *
 * Grouping rule: a consecutive run of assistant/tool/agent entries is ONE
 * assistant message whose content interleaves text parts and tool-call
 * parts (matching CC's actual turn structure). tool_result entries attach
 * to their tool-call part by tool_use_id. user/system entries are their
 * own messages; system carries `kind` in metadata.custom so the renderer
 * can color errors / stuck notices.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadEntry } from "../../api";

type ToolCallPart = {
  type: "tool-call";
  toolCallId?: string;
  toolName: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
};

type TextPart = { type: "text"; text: string };
type Part = TextPart | ToolCallPart;

function entryDate(e: ThreadEntry): Date | undefined {
  const t = new Date(e.ts).getTime();
  return Number.isNaN(t) ? undefined : new Date(t);
}

export function mapThreadToMessages(
  thread: ThreadEntry[],
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let openParts: Part[] | null = null;
  let openId = "";
  let openAt: Date | undefined;

  const closeOpen = () => {
    if (openParts && openParts.length > 0) {
      messages.push({
        role: "assistant",
        content: openParts as ThreadMessageLike["content"],
        id: openId,
        createdAt: openAt,
      } as ThreadMessageLike);
    }
    openParts = null;
  };

  thread.forEach((e, i) => {
    const content = String(e.content ?? "");
    if (e.role === "user") {
      closeOpen();
      messages.push({
        role: "user",
        content: [{ type: "text", text: content }],
        id: `t${i}`,
        createdAt: entryDate(e),
      });
      return;
    }
    if (e.role === "system") {
      closeOpen();
      messages.push({
        role: "system",
        content: [{ type: "text", text: content }],
        id: `t${i}`,
        createdAt: entryDate(e),
        metadata: { custom: { kind: e.kind ?? "text", meta: e.meta ?? {} } },
      });
      return;
    }
    // assistant / tool / agent → accumulate into the open assistant message
    if (!openParts) {
      openParts = [];
      openId = `t${i}`;
      openAt = entryDate(e);
    }
    if (e.role === "assistant" || e.role === "agent") {
      if (content.trim()) openParts.push({ type: "text", text: content });
      return;
    }
    // e.role === "tool"
    if (e.kind === "tool_call") {
      const meta = e.meta ?? {};
      openParts.push({
        type: "tool-call",
        toolCallId:
          typeof meta.tool_use_id === "string" ? meta.tool_use_id : `c${i}`,
        toolName:
          typeof meta.tool === "string" && meta.tool
            ? meta.tool
            : content.split(" ")[0] || "tool",
        argsText: typeof meta.input === "string" ? meta.input : content,
      });
      return;
    }
    if (e.kind === "tool_result") {
      const meta = e.meta ?? {};
      const id = typeof meta.tool_use_id === "string" ? meta.tool_use_id : null;
      // attach to the matching unresolved tool-call part (search backwards)
      for (let p = openParts.length - 1; p >= 0; p--) {
        const part = openParts[p];
        if (
          part.type === "tool-call" &&
          part.result === undefined &&
          (id === null || part.toolCallId === id)
        ) {
          part.result = content;
          part.isError = meta.is_error === true;
          return;
        }
      }
      // orphaned result — degrade to a text part rather than dropping it
      if (content.trim()) openParts.push({ type: "text", text: content });
    }
  });

  closeOpen();
  return messages;
}
