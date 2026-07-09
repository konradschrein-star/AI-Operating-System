"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchChatList,
  fetchChat,
  createChat,
  sendChatMessage,
  setChatStatus,
  resumeChat,
  archiveChat,
  archiveAllChats,
  searchChats,
  freezeFleet,
  resumeFleet,
  vaultAppend,
  vaultCreateNote,
  createReminder,
  setChatModel,
  fetchAutonomy,
  updateRule,
  attachmentsBlock,
  MODEL_OPTIONS,
  type ModelOption,
  type RunDetail,
  type RunStatus,
  type RunSummary,
} from "../api";
import { useAttachments, AttachmentChips } from "./chat/useAttachments";
import { SlashPopover, type SlashPopoverHandle } from "./chat/SlashPopover";
import {
  findSlash,
  parseSlash,
  type SlashContext,
  type SlashDirective,
  type SurfaceKey,
} from "./chat/slash-registry";
import { AssistantThread } from "./chat/AssistantThread";
import { useRunEvents } from "./chat/useRunEvents";

const STATUS_COLOR: Record<RunStatus, string> = {
  queued: tokens.textMuted,
  running: tokens.accent,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
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

export function ChatSurface({
  onNavigate,
}: {
  onNavigate?: (s: SurfaceKey) => void;
} = {}) {
  const qc = useQueryClient();
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const listQ = useQuery({
    queryKey: ["chat", "list", visibleCount],
    queryFn: () => fetchChatList({ limit: visibleCount }),
    refetchInterval: 8000,
  });
  const [selId, setSelId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState("");
  const searching = search.trim().length >= 2;
  const searchQ = useQuery({
    queryKey: ["chat", "search", search],
    queryFn: () => searchChats(search.trim()),
    enabled: searching,
  });

  useEffect(() => {
    if (!selId && (listQ.data?.runs.length ?? 0) > 0) {
      setSelId(listQ.data!.runs[0].id);
    }
  }, [listQ.data, selId]);

  // v2.0: SSE stream is the primary sync path; the query interval is only
  // a safety net (tight when the stream is down, lazy when it's live).
  const { live } = useRunEvents(selId, !composing);
  const detailQ = useQuery({
    queryKey: ["chat", "run", selId],
    queryFn: () => fetchChat(selId!),
    enabled: !!selId && !composing,
    refetchInterval: live ? 20000 : 3000,
  });

  const createM = useMutation({
    mutationFn: (input: {
      prompt: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }) => createChat(input),
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

  // Close = archive. Stops the underlying agent first (if it's still
  // queued/running/paused/stuck — same mechanism as the Cancel button, so
  // the executor kills the claude-code process within ~5s) then hides the
  // chat from the rail. Logs stay in the DB and stay searchable.
  const archiveM = useMutation({
    mutationFn: (id: string) => archiveChat(id),
    onSuccess: (_run, id) => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      if (selId === id) setSelId(null);
    },
  });
  const archiveAllM = useMutation({
    mutationFn: () => archiveAllChats(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", "list"] });
      setSelId(null);
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
          <CloseAllButton
            disabled={(listQ.data?.count ?? 0) === 0}
            pending={archiveAllM.isPending}
            onConfirm={() => archiveAllM.mutate()}
          />
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
        <div
          style={{
            flex: "none",
            padding: "9px 12px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 14, color: tokens.textFaint }}>
              search
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search past chats — titles + what was said…"
              className="mono"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: tokens.text,
                fontSize: 11.5,
              }}
            />
            {search && (
              <span
                onClick={() => setSearch("")}
                className="mono"
                style={{ fontSize: 10, color: tokens.textFaint, cursor: "pointer" }}
              >
                ✕
              </span>
            )}
          </div>
        </div>
        {!searching && counts && (
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
          {searching ? (
            <>
              {searchQ.isLoading && (
                <div
                  className="mono"
                  style={{ padding: 24, fontSize: 11, color: tokens.textFaint, textAlign: "center" }}
                >
                  searching…
                </div>
              )}
              {!searchQ.isLoading && (searchQ.data?.length ?? 0) === 0 && (
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
                  no chats match “{search.trim()}”.
                </div>
              )}
              {searchQ.data?.map((r) => (
                <ChatListItem
                  key={r.id}
                  run={r}
                  selected={r.id === selId && !composing}
                  onSelect={() => {
                    setSelId(r.id);
                    setComposing(false);
                    setSearch("");
                  }}
                  onClose={() => archiveM.mutate(r.id)}
                  closing={archiveM.isPending && archiveM.variables === r.id}
                />
              ))}
            </>
          ) : (
            <>
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
                  onClose={() => archiveM.mutate(r.id)}
                  closing={archiveM.isPending && archiveM.variables === r.id}
                />
              ))}
              {listQ.data?.hasMore && (
                <div
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  className="mono"
                  style={{
                    padding: "12px 14px",
                    fontSize: 11,
                    color: tokens.accent,
                    textAlign: "center",
                    cursor: "pointer",
                    borderTop: `1px solid ${tokens.borderDivider}`,
                  }}
                >
                  load more
                </div>
              )}
            </>
          )}
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
            onCreate={(prompt, title, model) =>
              createM.mutate({
                prompt,
                title: title || undefined,
                metadata: model === "sonnet" ? undefined : { model },
              })
            }
          />
        ) : detailQ.data ? (
          <ChatThread
            key={detailQ.data.id}
            run={detailQ.data}
            live={live}
            onSend={(content) =>
              sendM.mutate({ id: detailQ.data!.id, content })
            }
            onStatus={(status) =>
              statusM.mutate({ id: detailQ.data!.id, status })
            }
            onResume={() => resumeM.mutate(detailQ.data!.id)}
            onNavigate={onNavigate}
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
  onClose,
  closing,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  closing: boolean;
}) {
  const color = STATUS_COLOR[run.status];
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "12px 14px",
        cursor: "pointer",
        borderBottom: `1px solid ${tokens.borderDivider}`,
        borderLeft: `2px solid ${selected ? color : "transparent"}`,
        background: selected ? "#101013" : "transparent",
        opacity: closing ? 0.5 : 1,
        position: "relative",
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
        {run.archived && (
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 4,
              padding: "0 4px",
              letterSpacing: "0.06em",
            }}
          >
            closed
          </span>
        )}
        <span style={{ flex: 1 }} />
        {hover ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (!closing) onClose();
            }}
            title="Close this chat — stops the agent if it's still working, and hides it from the list. Nothing is deleted; it stays searchable."
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.bleed,
              cursor: closing ? "wait" : "pointer",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            ✕
          </span>
        ) : (
          <span
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textFaint }}
          >
            {humanAge(run.updated_at)}
          </span>
        )}
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

/** Two-click confirm so "close all" can't fire from a stray click — closes
 *  every open chat (stops any still-active agents, archives the rest). */
function CloseAllButton({
  disabled,
  pending,
  onConfirm,
}: {
  disabled: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      disabled={disabled || pending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          timerRef.current = setTimeout(() => setArmed(false), 4000);
          return;
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        setArmed(false);
        onConfirm();
      }}
      title="Closes every chat — stops any that are still working and hides them from the list. Logs are kept."
      className="mono"
      style={{
        fontSize: 11,
        color: armed ? tokens.bleed : tokens.textMuted,
        background: armed ? tokens.dangerActionBg : "transparent",
        border: `1px solid ${armed ? tokens.dangerActionBorder : tokens.border}`,
        borderRadius: 6,
        padding: "4px 10px",
        cursor: disabled || pending ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {pending ? "closing…" : armed ? "confirm close all?" : "close all"}
    </button>
  );
}

function ChatThread({
  run,
  live,
  onSend,
  onStatus,
  onResume,
  onNavigate,
  isSending,
  isResuming,
}: {
  run: RunDetail;
  live: boolean;
  onSend: (content: string) => void;
  onStatus: (status: RunStatus) => void;
  onResume: () => void;
  onNavigate?: (s: SurfaceKey) => void;
  isSending: boolean;
  isResuming: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [localSys, setLocalSys] = useState<
    Array<{ text: string; ts: string }>
  >([]);
  const popoverRef = useRef<SlashPopoverHandle | null>(null);
  const att = useAttachments();

  const pushSys = (text: string) =>
    setLocalSys((prev) => [...prev, { text, ts: new Date().toISOString() }]);

  const sendWithAttachments = (text: string) => {
    onSend(`${text}${attachmentsBlock(att.attachments)}`);
    att.clear();
  };

  // Slash context — handlers reach back into the chat surface for the
  // mutations they need (cancel, resume, freeze, etc.). Built per-render
  // because runId/runStatus can change; cheap.
  const slashCtx: SlashContext = {
    runId: run.id,
    runStatus: run.status,
    sys: pushSys,
    nav: (s) => {
      if (onNavigate) onNavigate(s);
      else pushSys(`(no navigate handler — would open ${s})`);
    },
    freezeFleet: () => freezeFleet("chat-slash"),
    resumeFleet: () => resumeFleet("chat-slash"),
    resumeRun: (id) => resumeChat(id),
    setRunStatus: (id, status) => setChatStatus(id, status),
    vaultAppend: (input) => vaultAppend(input),
    vaultCreateNote: (input) => vaultCreateNote(input),
    createReminder: (input) => createReminder(input),
    setModel: (id, model) => setChatModel(id, model),
    fetchRules: async () => (await fetchAutonomy()).rules,
    updateRuleConfig: (id, config) => updateRule(id, { config }),
  };

  const dispatchSlash = async (raw: string) => {
    const { name } = parseSlash(raw);
    if (!name) return false;
    const cmd = findSlash(name);
    if (!cmd) {
      // Unknown slash — treat as a normal message so user can still send
      // literal text starting with "/" if they want.
      return false;
    }
    try {
      const result: SlashDirective = await Promise.resolve(
        cmd.handler(slashCtx, parseSlash(raw).args),
      );
      if (result.kind === "navigate") slashCtx.nav(result.surface);
      else if (result.kind === "send-message") {
        onSend(result.message);
      }
    } catch (e) {
      pushSys(
        `slash /${name} error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return true;
  };
  const color = STATUS_COLOR[run.status];
  const engine = String(run.metadata?.engine ?? "claude-code");
  const model = String(run.metadata?.model ?? "sonnet");

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
            {run.status} · {engine} · {model} · spent ${run.spent_usd} / cap $
            {run.budget_usd} ·{" "}
            <span style={{ color: live ? tokens.ok : tokens.warn }}>
              {live ? "live" : "polling"}
            </span>
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
      <AssistantThread run={run} />
      {localSys.length > 0 && (
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            padding: "8px 28px 0",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {localSys.map((m, i) => (
            <div
              key={`localsys-${i}`}
              style={{
                padding: "8px 12px",
                borderLeft: `2px solid ${tokens.info}`,
                background: "rgba(79, 176, 196, 0.06)",
                borderRadius: 6,
                fontSize: 12,
                color: tokens.textSecondary,
                whiteSpace: "pre-wrap",
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: tokens.info,
                  letterSpacing: "0.08em",
                  marginBottom: 3,
                }}
              >
                SLASH · {humanAge(m.ts)}
              </div>
              {m.text}
            </div>
          ))}
        </div>
      )}
      <div
        {...att.dropHandlers}
        style={{
          position: "relative",
          borderTop: `1px solid ${tokens.borderSoft}`,
          padding: "8px 18px 12px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <AttachmentChips
          attachments={att.attachments}
          uploading={att.uploading}
          uploadError={att.uploadError}
          onRemove={att.remove}
        />
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 8 }}>
          <SlashPopover
            ref={popoverRef}
            input={draft}
            onApply={(cmd) => {
              // Tab/click on popover: replace input with "/name " ready for args.
              setDraft(`/${cmd.name} `);
            }}
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={att.onPaste}
            onKeyDown={(e) => {
              // Popover gets first crack at the key — arrows, Tab, Esc.
              if (popoverRef.current?.handleKey(e)) return;
              // v1.6 phase 1: Enter sends; Shift+Enter newline; IME-safe.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                const v = draft.trim();
                if (!v && att.attachments.length === 0) return;
                // v1.6 phase 4: if the input is a slash command, dispatch it
                // locally and DO NOT send to the run executor.
                if (v.startsWith("/")) {
                  // If the popover is open and a command is highlighted, accept
                  // that instead of relying on the typed name. Otherwise parse
                  // the typed string directly.
                  const accepted = popoverRef.current?.acceptSelected() ?? null;
                  const target = accepted ? `/${accepted.name}` : v;
                  void dispatchSlash(target);
                  setDraft("");
                  return;
                }
                sendWithAttachments(v || "See attached files.");
                setDraft("");
              }
            }}
            placeholder={
              run.status === "running"
                ? "engine working… Enter to queue a message · / for commands"
                : "message · Enter to send · drop/paste files · /note /todo /remind · Shift+Enter newline"
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
            disabled={
              isSending ||
              (draft.trim().length === 0 && att.attachments.length === 0)
            }
            onClick={() => {
              const v = draft.trim();
              if (!v && att.attachments.length === 0) return;
              if (v.startsWith("/")) {
                const accepted = popoverRef.current?.acceptSelected() ?? null;
                const target = accepted ? `/${accepted.name}` : v;
                void dispatchSlash(target);
                setDraft("");
                return;
              }
              sendWithAttachments(v || "See attached files.");
              setDraft("");
            }}
            className="mono"
            style={{
              fontSize: 11.5,
              color:
                draft.trim().length === 0 && att.attachments.length === 0
                  ? tokens.textFaint
                  : tokens.accent,
              border: `1px solid ${
                draft.trim().length === 0 && att.attachments.length === 0
                  ? tokens.border
                  : tokens.accent
              }`,
              background:
                draft.trim().length === 0 && att.attachments.length === 0
                  ? "transparent"
                  : tokens.primaryActionBg,
              borderRadius: 6,
              padding: "10px 14px",
              cursor:
                isSending ||
                (draft.trim().length === 0 && att.attachments.length === 0)
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {isSending ? "…" : "send"}
          </button>
        </div>
      </div>
    </>
  );
}

function NewChat({
  onCancel,
  onCreate,
  isCreating,
}: {
  onCancel: () => void;
  onCreate: (prompt: string, title: string, model: ModelOption) => void;
  isCreating: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelOption>("sonnet");
  const att = useAttachments();
  const canCreate = prompt.trim().length > 0 || att.attachments.length > 0;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const create = () => {
    const text = prompt.trim() || "See attached files.";
    onCreate(`${text}${attachmentsBlock(att.attachments)}`, title.trim(), model);
  };
  return (
    <div
      {...att.dropHandlers}
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
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.accent,
            letterSpacing: "0.12em",
          }}
        >
          NEW CHAT
        </span>
        <span style={{ flex: 1 }} />
        {MODEL_OPTIONS.map((m) => {
          const on = m === model;
          return (
            <button
              key={m}
              onClick={() => setModel(m)}
              className="mono"
              style={{
                fontSize: 10.5,
                color: on ? tokens.accent : tokens.textMuted,
                border: `1px solid ${on ? tokens.accent : tokens.border}`,
                background: on ? tokens.primaryActionBg : "transparent",
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
              }}
            >
              {m}
              {m === "sonnet" ? " ·std" : ""}
            </button>
          );
        })}
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
      <AttachmentChips
        attachments={att.attachments}
        uploading={att.uploading}
        uploadError={att.uploadError}
        onRemove={att.remove}
      />
      <textarea
        ref={inputRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => {
          // v1.6: Enter dispatches, Shift+Enter newline. Skip during IME composition.
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            canCreate
          ) {
            e.preventDefault();
            create();
          }
        }}
        placeholder="what's the task?  Enter to dispatch · drop/paste files · Shift+Enter newline"
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
          onClick={create}
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
