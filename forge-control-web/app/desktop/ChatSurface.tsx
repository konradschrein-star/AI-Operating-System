"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchChatList,
  fetchChat,
  createChat,
  sendChatMessage,
  setChatStatus,
  resumeChat,
  type RunStatus,
  type RunSummary,
  type ThreadEntry,
} from "../api";

const STATUS_COLOR: Record<RunStatus, string> = {
  queued: tokens.textMuted,
  running: tokens.accent,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

const ROLE_COLOR: Record<string, string> = {
  user: tokens.accent,
  assistant: tokens.ok,
  system: tokens.info,
  tool: tokens.warn,
  agent: tokens.decide,
};

function humanAge(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ChatSurface() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ["chat", "list"],
    queryFn: fetchChatList,
    refetchInterval: 8000,
  });
  const [selId, setSelId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (!selId && (listQ.data?.runs.length ?? 0) > 0) {
      setSelId(listQ.data!.runs[0].id);
    }
  }, [listQ.data, selId]);

  const detailQ = useQuery({
    queryKey: ["chat", "run", selId],
    queryFn: () => fetchChat(selId!),
    enabled: !!selId && !composing,
    refetchInterval: 3000,
  });

  const createM = useMutation({
    mutationFn: (input: { prompt: string; title?: string }) =>
      createChat(input),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      setSelId(run.id);
      setComposing(false);
    },
  });

  const sendM = useMutation({
    mutationFn: (input: { id: string; content: string }) =>
      sendChatMessage(input.id, input.content),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  const statusM = useMutation({
    mutationFn: (input: { id: string; status: RunStatus }) =>
      setChatStatus(input.id, input.status),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  const resumeM = useMutation({
    mutationFn: (id: string) => resumeChat(id),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      qc.setQueryData(["chat", "run", run.id], run);
    },
  });

  const counts = listQ.data?.counts ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — chat list */}
      <div
        style={{
          width: 300,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 14px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}>
            Chats
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.accent,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "2px 7px",
            }}
          >
            {listQ.data?.count ?? 0}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => {
              setSelId(null);
              setComposing(true);
            }}
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            + new
          </button>
        </div>
        {counts && (
          <div
            className="mono"
            style={{
              padding: "8px 14px",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              borderBottom: `1px solid ${tokens.borderDivider}`,
              fontSize: 10,
            }}
          >
            {(["running", "queued", "stuck", "completed"] as RunStatus[]).map(
              (s) => (
                <span key={s} style={{ color: STATUS_COLOR[s] }}>
                  {s} {counts[s]}
                </span>
              ),
            )}
          </div>
        )}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {listQ.isLoading && (
            <div
              className="mono"
              style={{
                padding: 24,
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              loading…
            </div>
          )}
          {!listQ.isLoading && (listQ.data?.runs.length ?? 0) === 0 && (
            <div
              className="mono"
              style={{
                padding: "32px 16px",
                fontSize: 11,
                color: tokens.textFaint,
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              no chats yet.
              <br />
              hit “+ new” to start one.
            </div>
          )}
          {listQ.data?.runs.map((r) => (
            <ChatListItem
              key={r.id}
              run={r}
              selected={r.id === selId && !composing}
              onSelect={() => {
                setSelId(r.id);
                setComposing(false);
              }}
            />
          ))}
        </div>
      </div>

      {/* Right pane — thread or composer */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {composing ? (
          <NewChat
            isCreating={createM.isPending}
            onCancel={() => setComposing(false)}
            onCreate={(prompt, title) =>
              createM.mutate({ prompt, title: title || undefined })
            }
          />
        ) : detailQ.data ? (
          <ChatThread
            run={detailQ.data}
            onSend={(content) =>
              sendM.mutate({ id: detailQ.data!.id, content })
            }
            onStatus={(status) =>
              statusM.mutate({ id: detailQ.data!.id, status })
            }
            onResume={() => resumeM.mutate(detailQ.data!.id)}
            isSending={sendM.isPending}
            isResuming={resumeM.isPending}
          />
        ) : (
          <div
            className="mono"
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: tokens.textFaint,
            }}
          >
            select a chat or create a new one
          </div>
        )}
      </div>
    </div>
  );
}

function ChatListItem({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = STATUS_COLOR[run.status];
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "12px 14px",
        cursor: "pointer",
        borderBottom: `1px solid ${tokens.borderDivider}`,
        borderLeft: `2px solid ${selected ? color : "transparent"}`,
        background: selected ? "#101013" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={dot(color, run.status === "running")} />
        <span
          className="mono"
          style={{ fontSize: 10, color, letterSpacing: "0.06em" }}
        >
          {run.status}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textFaint }}
        >
          {humanAge(run.updated_at)}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: selected ? tokens.text : tokens.textLabel,
          marginTop: 6,
          lineHeight: 1.42,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {run.title}
      </div>
      {run.last_message_preview && (
        <div
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            marginTop: 4,
            lineHeight: 1.4,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          <span style={{ color: tokens.textFaint, marginRight: 6 }}>
            {run.last_role}
          </span>
          {run.last_message_preview}
        </div>
      )}
    </div>
  );
}

function ChatThread({
  run,
  onSend,
  onStatus,
  onResume,
  isSending,
  isResuming,
}: {
  run: {
    id: string;
    title: string;
    status: RunStatus;
    worker: string | null;
    thread: ThreadEntry[];
    budget_usd: string;
    spent_usd: string;
  };
  onSend: (content: string) => void;
  onStatus: (status: RunStatus) => void;
  onResume: () => void;
  isSending: boolean;
  isResuming: boolean;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // v1.6: sticky auto-scroll. Only yank to bottom if the user is already
  // within ~120px of the bottom; otherwise leave them where they are.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [run.thread.length]);

  const color = STATUS_COLOR[run.status];

  return (
    <>
      <div
        style={{
          padding: "12px 18px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={dot(color, run.status === "running")} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: tokens.textHi,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {run.title}
          </div>
          <div
            className="mono"
            style={{ fontSize: 10.5, color: tokens.textFaint, marginTop: 2 }}
          >
            {run.status} · {run.worker ?? "no worker"} · spent ${run.spent_usd}{" "}
            / cap ${run.budget_usd}
          </div>
        </div>
        {run.status === "stuck" && (
          <button
            onClick={onResume}
            disabled={isResuming}
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: isResuming ? "not-allowed" : "pointer",
            }}
          >
            {isResuming ? "resuming…" : "resume"}
          </button>
        )}
        {run.status !== "completed" &&
          run.status !== "cancelled" &&
          run.status !== "failed" && (
            <button
              onClick={() => onStatus("cancelled")}
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.bleed,
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              cancel
            </button>
          )}
      </div>
      <div
        ref={scrollRef}
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
        {run.thread.map((entry, i) => (
          <ThreadBubble key={i} entry={entry} />
        ))}
      </div>
      <div
        style={{
          borderTop: `1px solid ${tokens.borderSoft}`,
          padding: "12px 18px",
          display: "flex",
          gap: 10,
          alignItems: "flex-end",
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // v1.6: Enter sends, Shift+Enter newline. Skip when an IME
            // composition is in flight so CJK candidate confirmation doesn't
            // accidentally send.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              const v = draft.trim();
              if (v) {
                onSend(v);
                setDraft("");
              }
            }
          }}
          placeholder={
            run.status === "running"
              ? "running… Enter to interrupt with a message · Shift+Enter newline"
              : "message · Enter to send · Shift+Enter newline"
          }
          rows={2}
          style={{
            flex: 1,
            resize: "none",
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            padding: "10px 12px",
            color: tokens.text,
            fontSize: 13,
            fontFamily: "Inter, system-ui",
            outline: "none",
          }}
        />
        <button
          disabled={isSending || draft.trim().length === 0}
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            onSend(v);
            setDraft("");
          }}
          className="mono"
          style={{
            fontSize: 11.5,
            color: draft.trim().length === 0 ? tokens.textFaint : tokens.accent,
            border: `1px solid ${draft.trim().length === 0 ? tokens.border : tokens.accent}`,
            background:
              draft.trim().length === 0
                ? "transparent"
                : tokens.primaryActionBg,
            borderRadius: 6,
            padding: "10px 14px",
            cursor:
              isSending || draft.trim().length === 0
                ? "not-allowed"
                : "pointer",
          }}
        >
          {isSending ? "…" : "send"}
        </button>
      </div>
    </>
  );
}

function ThreadBubble({ entry }: { entry: ThreadEntry }) {
  const isUser = entry.role === "user";
  const color = ROLE_COLOR[entry.role] ?? tokens.textMuted;
  const bubbleStyle: CSSProperties = {
    maxWidth: "78%",
    background: isUser ? tokens.primaryActionBg : tokens.bgCard,
    border: `1px solid ${isUser ? tokens.accent : tokens.border}`,
    borderRadius: 10,
    padding: "10px 13px",
    color: tokens.text,
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {entry.role}
        {entry.kind && entry.kind !== "text" ? ` · ${entry.kind}` : ""}
        <span style={{ color: tokens.textFaint, marginLeft: 8 }}>
          {humanAge(entry.ts)}
        </span>
      </div>
      <div style={bubbleStyle}>{entry.content}</div>
    </div>
  );
}

function NewChat({
  onCancel,
  onCreate,
  isCreating,
}: {
  onCancel: () => void;
  onCreate: (prompt: string, title: string) => void;
  isCreating: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const canCreate = prompt.trim().length > 0;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      style={{
        padding: "24px 28px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.accent,
          letterSpacing: "0.12em",
        }}
      >
        NEW CHAT
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="optional title (auto from first line if blank)"
        className="mono"
        style={{
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "10px 12px",
          color: tokens.text,
          fontSize: 13,
          outline: "none",
        }}
      />
      <textarea
        ref={inputRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          // v1.6: Enter dispatches, Shift+Enter newline. Skip during IME composition.
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            canCreate
          ) {
            e.preventDefault();
            onCreate(prompt.trim(), title.trim());
          }
        }}
        placeholder="what's the task?  Enter to dispatch · Shift+Enter newline"
        rows={10}
        style={{
          flex: 1,
          resize: "none",
          background: tokens.bgCard,
          border: `1px solid ${tokens.border}`,
          borderRadius: 8,
          padding: "12px 14px",
          color: tokens.text,
          fontSize: 13,
          fontFamily: "Inter, system-ui",
          lineHeight: 1.55,
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={onCancel}
          className="mono"
          style={{
            fontSize: 11.5,
            color: tokens.textMuted,
            background: "transparent",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            padding: "9px 14px",
            cursor: "pointer",
          }}
        >
          cancel
        </button>
        <button
          disabled={!canCreate || isCreating}
          onClick={() => onCreate(prompt.trim(), title.trim())}
          className="mono"
          style={{
            fontSize: 11.5,
            color: canCreate ? tokens.accent : tokens.textFaint,
            background: canCreate ? tokens.primaryActionBg : "transparent",
            border: `1px solid ${canCreate ? tokens.accent : tokens.border}`,
            borderRadius: 6,
            padding: "9px 14px",
            cursor: canCreate ? "pointer" : "not-allowed",
          }}
        >
          {isCreating ? "creating…" : "dispatch"}
        </button>
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.textFaint,
            marginLeft: "auto",
          }}
        >
          queued · executor will pick this up
        </span>
      </div>
    </div>
  );
}
