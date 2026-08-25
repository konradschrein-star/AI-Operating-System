"use client";

import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  fetchChatList,
  fetchChatDelta,
  createChat,
  sendChatMessage,
  type RunDetail,
  type RunSummary,
} from "../../api";
import { AssistantThread } from "../chat/AssistantThread";
import { useRunEvents } from "../chat/useRunEvents";
import { useAutogrow } from "../chat/useAutogrow";
import {
  CHAT_DETAIL_FALLBACK_POLL_MS,
  CHAT_DETAIL_LIVE_POLL_MS,
} from "../chat/pollBudget";

const COMPOSER_ROWS = { minRows: 2, maxRows: 6 };

const QUICK_PROMPTS = [
  {
    icon: "⚡",
    label: "Evening Debrief",
    prompt:
      "Give me my evening debrief. Interrogate my checkboxes from today's daily note, score my said vs. done ratio, and give me the hard truth.",
  },
  {
    icon: "🎯",
    label: "Diagnose Blockers",
    prompt:
      "Diagnose what blocked my top goal today. Cut through the narrative and tell me what the real failure mode was.",
  },
  {
    icon: "📊",
    label: "Audit Volume",
    prompt:
      "Audit my output volume this week. Where am I falling behind on raw inputs and pipeline throughput?",
  },
  {
    icon: "⚔️",
    label: "Interrogate Excuses",
    prompt:
      "Review my logged decisions and daily notes. Spot where I compromised on standard, delayed hard actions, or accepted soft excuses.",
  },
];

export interface MentorAgentDeckProps {
  day?: string;
  className?: string;
  style?: CSSProperties;
}

export function MentorAgentDeck({
  day,
  className,
  style,
}: MentorAgentDeckProps) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [isStartingNew, setIsStartingNew] = useState(false);
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useAutogrow(composerRef, draft, COMPOSER_ROWS);

  // Query all chats to find mentor runs
  const {
    data: listData,
    isLoading: isListLoading,
    isError: isListError,
    error: listError,
    refetch: refetchList,
  } = useQuery({
    queryKey: ["chat", "list"],
    queryFn: () => fetchChatList(),
    staleTime: 10_000,
  });

  // Filter mentor runs by title or role
  const mentorRuns: RunSummary[] = useMemo(() => {
    if (!listData?.runs) return [];
    return listData.runs.filter((r) => {
      const titleLower = (r.title ?? "").toLowerCase();
      const roleLower = (r.last_role ?? "").toLowerCase();
      return (
        titleLower.includes("mentor") ||
        titleLower.includes("debrief") ||
        roleLower.includes("mentor")
      );
    });
  }, [listData]);

  // Determine active run id
  const activeRunId = useMemo(() => {
    if (isStartingNew) return null;
    if (selectedRunId) return selectedRunId;
    if (mentorRuns.length > 0) return mentorRuns[0].id;
    return null;
  }, [isStartingNew, selectedRunId, mentorRuns]);

  // SSE subscription for live events
  const { live } = useRunEvents(activeRunId, !!activeRunId);

  // Query active run detail
  const {
    data: runDetail,
    isLoading: isDetailLoading,
    isError: isDetailError,
    error: detailError,
    refetch: refetchDetail,
  } = useQuery<RunDetail, Error>({
    queryKey: ["chat", "run", activeRunId],
    /* Delta poll, same key namespace and same merge rules as ChatSurface's
     * detailQ (see fetchChatDelta's own doc). A mentor debrief grows into the
     * hundreds of entries like any other thread, and this deck was the one
     * transcript in the codebase still re-downloading all of it every tick. */
    queryFn: () =>
      fetchChatDelta(activeRunId!, () =>
        queryClient.getQueryData<RunDetail>(["chat", "run", activeRunId]),
      ),
    enabled: !!activeRunId,
    refetchInterval: live
      ? CHAT_DETAIL_LIVE_POLL_MS
      : CHAT_DETAIL_FALLBACK_POLL_MS,
  });

  // Mutations
  const createChatMutation = useMutation({
    mutationFn: async (promptText: string) => {
      const title = day
        ? `Mentor Debrief — ${day}`
        : "Mentor Evening Debrief";
      return createChat({
        prompt: promptText,
        title,
        metadata: {
          kind: "mentor",
          source: "journal-surface",
          day: day ?? undefined,
        },
      });
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: ["chat", "list"] });
      setSelectedRunId(newRun.id);
      setIsStartingNew(false);
      setDraft("");
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) => {
      return sendChatMessage(id, text);
    },
    onSuccess: (updatedRun) => {
      queryClient.setQueryData(["chat", "run", updatedRun.id], updatedRun);
      queryClient.invalidateQueries({ queryKey: ["chat", "list"] });
      setDraft("");
    },
  });

  const isSending =
    createChatMutation.isPending || sendMessageMutation.isPending;

  const handleSend = useCallback(
    (textToSend?: string) => {
      const message = (textToSend ?? draft).trim();
      if (!message || isSending) return;

      if (activeRunId) {
        sendMessageMutation.mutate({ id: activeRunId, text: message });
      } else {
        createChatMutation.mutate(message);
      }
    },
    [activeRunId, draft, isSending, sendMessageMutation, createChatMutation],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTriggerQuickPrompt = (promptText: string) => {
    if (activeRunId) {
      handleSend(promptText);
    } else {
      createChatMutation.mutate(promptText);
    }
  };

  const isRunning =
    runDetail?.status === "running" || runDetail?.status === "queued";

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: tokens.bgCard,
        border: `1px solid ${tokens.borderDivider}`,
        borderRadius: 8,
        overflow: "hidden",
        ...style,
      }}
    >
      {/* 1. Mentor Persona Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgTabBar,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: tokens.textHi,
                letterSpacing: "0.04em",
              }}
            >
              MENTOR
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 4,
                background: tokens.primaryActionBg,
                color: tokens.accent,
                border: `1px solid ${tokens.accent}`,
              }}
            >
              PERSONA.md
            </span>
            {isRunning && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: tokens.accent,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: tokens.accent,
                    animation: "pulse 1.5s infinite",
                  }}
                />
                active
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {mentorRuns.length > 1 && (
              <select
                aria-label="Select mentor session"
                value={activeRunId ?? ""}
                onChange={(e) => {
                  if (e.target.value === "new") {
                    setIsStartingNew(true);
                    setSelectedRunId(null);
                  } else {
                    setIsStartingNew(false);
                    setSelectedRunId(e.target.value);
                  }
                }}
                className="mono"
                style={{
                  background: tokens.inputBg,
                  color: tokens.textBody,
                  border: `1px solid ${tokens.borderDivider}`,
                  borderRadius: 4,
                  fontSize: 10.5,
                  padding: "3px 8px",
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                <option value="new">+ Start New Session</option>
                {mentorRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title || `Session ${r.id.slice(0, 8)}`} (
                    {new Date(r.created_at).toLocaleDateString("en-GB", {
                      month: "short",
                      day: "numeric",
                    })}
                    )
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => {
                setIsStartingNew(true);
                setSelectedRunId(null);
              }}
              className="mono"
              style={{
                fontSize: 10.5,
                padding: "3px 8px",
                borderRadius: 4,
                background: isStartingNew ? tokens.primaryActionBg : tokens.bgCard,
                color: isStartingNew ? tokens.accent : tokens.textMuted,
                border: `1px solid ${isStartingNew ? tokens.accent : tokens.borderDivider}`,
                cursor: "pointer",
              }}
            >
              + New Session
            </button>
          </div>
        </div>

        <div
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: tokens.textSecondary, fontWeight: 500 }}>
            Said vs. done is the only scoreboard.
          </span>{" "}
          Andrew Tate&apos;s frame control &amp; Alex Hormozi&apos;s volume doctrine.
          Reads <code className="mono" style={{ fontSize: 10 }}>/opt/obsidian-vault/Mentor/Profile/</code>.
        </div>
      </div>

      {/* 2. Quick Debrief Trigger Chips */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgBody,
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            marginRight: 2,
          }}
        >
          TRIGGERS:
        </span>
        {QUICK_PROMPTS.map((qp) => (
          <button
            key={qp.label}
            type="button"
            disabled={isSending || isRunning}
            onClick={() => handleTriggerQuickPrompt(qp.prompt)}
            title={qp.prompt}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 6,
              background: tokens.bgCard,
              color: tokens.textBody,
              border: `1px solid ${tokens.borderDivider}`,
              cursor: isSending || isRunning ? "not-allowed" : "pointer",
              opacity: isSending || isRunning ? 0.6 : 1,
              transition: "all 0.15s ease",
            }}
          >
            <span>{qp.icon}</span>
            <span>{qp.label}</span>
          </button>
        ))}
      </div>

      {/* 3. Thread Area */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        {isListLoading || (activeRunId && isDetailLoading && !runDetail) ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              gap: 12,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.textMuted,
              }}
            >
              Loading mentor debrief transcript…
            </div>
          </div>
        ) : isListError ? (
          <div
            style={{
              padding: 16,
              margin: 16,
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 6,
              color: tokens.bleed,
              fontSize: 12,
            }}
          >
            <div>Failed to load mentor sessions.</div>
            <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>
              {listError instanceof Error ? listError.message : String(listError)}
            </div>
            <button
              type="button"
              onClick={() => refetchList()}
              style={{
                marginTop: 8,
                background: "none",
                border: "none",
                color: tokens.bleed,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
                fontSize: 11,
              }}
            >
              Retry
            </button>
          </div>
        ) : isDetailError ? (
          <div
            style={{
              padding: 16,
              margin: 16,
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 6,
              color: tokens.bleed,
              fontSize: 12,
            }}
          >
            <div>Failed to load session transcript.</div>
            <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>
              {detailError instanceof Error ? detailError.message : String(detailError)}
            </div>
            <button
              type="button"
              onClick={() => refetchDetail()}
              style={{
                marginTop: 8,
                background: "none",
                border: "none",
                color: tokens.bleed,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
                fontSize: 11,
              }}
            >
              Retry
            </button>
          </div>
        ) : runDetail ? (
          <AssistantThread
            run={runDetail}
            mode="raw"
            actions={{
              insertDraft: (txt: string) => setDraft((d) => (d ? `${d} ${txt}` : txt)),
            }}
          />
        ) : (
          /* Empty / New Session Starter View */
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 32,
              textAlign: "center",
              gap: 16,
            }}
          >
            <div
              style={{
                fontSize: 28,
                lineHeight: 1,
              }}
            >
              ⚔️
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: tokens.textHi,
              }}
            >
              {isStartingNew ? "New Mentor Debrief" : "No Mentor Runs Yet"}
            </div>
            <div
              style={{
                fontSize: 12,
                color: tokens.textMuted,
                maxWidth: 420,
                lineHeight: 1.5,
              }}
            >
              The Mentor operates on zero-excuse accountability. Click one of the
              quick trigger buttons above or type below to begin your evening
              debrief.
            </div>
          </div>
        )}
      </div>

      {/* 4. Composer & Reply Bar */}
      <div
        style={{
          padding: "10px 12px",
          borderTop: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgTabBar,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSending || isRunning}
            placeholder={
              isRunning
                ? "Mentor is responding…"
                : isStartingNew || !activeRunId
                ? "Start a new debrief session… (Enter to send, Shift+Enter for newline)"
                : "Reply to Mentor… (Enter to send, Shift+Enter for newline)"
            }
            rows={COMPOSER_ROWS.minRows}
            style={{
              flex: 1,
              background: tokens.inputBg,
              color: tokens.textBody,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 12,
              lineHeight: 1.5,
              resize: "none",
              outline: "none",
              fontFamily: "inherit",
            }}
          />

          <button
            type="button"
            disabled={!draft.trim() || isSending || isRunning}
            onClick={() => handleSend()}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              background: draft.trim() && !isSending && !isRunning ? tokens.accent : tokens.bgCard,
              color: draft.trim() && !isSending && !isRunning ? tokens.bgBody : tokens.textGhost,
              border: `1px solid ${draft.trim() && !isSending && !isRunning ? tokens.accent : tokens.borderDivider}`,
              cursor: draft.trim() && !isSending && !isRunning ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 4,
              transition: "all 0.15s ease",
              height: 36,
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>

        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textGhost,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>Shift+Enter for newline</span>
          {activeRunId && (
            <span>
              Session: <code style={{ color: tokens.textMuted }}>{activeRunId.slice(0, 8)}</code>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
