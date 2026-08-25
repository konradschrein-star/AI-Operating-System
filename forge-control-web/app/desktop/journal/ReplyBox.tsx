"use client";

import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { CARD, SectionLabel, inputStyle } from "../goals/ui";
import { postJournalReply, type JournalReply } from "../../api";

export interface ReplyBoxProps {
  day: string;
  reply: JournalReply | null | undefined;
  isLoading?: boolean;
}

const FELT_RATINGS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function ReplyBox({ day, reply, isLoading = false }: ReplyBoxProps) {
  const queryClient = useQueryClient();
  const [subjective, setSubjective] = useState<number | null>(reply?.subjective ?? null);
  const [reflection, setReflection] = useState<string>(reply?.reflection ?? "");
  const [lastSavedNotePath, setLastSavedNotePath] = useState<string | null>(null);
  const [showSavedToast, setShowSavedToast] = useState(false);

  // Sync state when day or reply changes
  useEffect(() => {
    setSubjective(reply?.subjective ?? null);
    setReflection(reply?.reflection ?? "");
    setLastSavedNotePath(null);
    setShowSavedToast(false);
  }, [day, reply?.subjective, reply?.reflection]);

  const replyMutation = useMutation({
    mutationFn: async (payload: { subjective?: number; reflection?: string }) => {
      return postJournalReply(day, payload);
    },
    onSuccess: (data) => {
      if (data.reply?.note_path) {
        setLastSavedNotePath(data.reply.note_path);
      }
      setShowSavedToast(true);
      setTimeout(() => setShowSavedToast(false), 4000);

      // Invalidate journal and daily queries so the week board and stats update
      queryClient.invalidateQueries({ queryKey: ["journal", "day", day] });
      queryClient.invalidateQueries({ queryKey: ["daily"] });
      queryClient.invalidateQueries({ queryKey: ["daily-stats"] });
    },
  });

  const handleSave = () => {
    replyMutation.mutate({
      subjective: subjective ?? undefined,
      reflection: reflection.trim() || undefined,
    });
  };

  const isPending = replyMutation.isPending;
  const currentNotePath = lastSavedNotePath ?? reply?.note_path;

  return (
    <div>
      <SectionLabel>YOUR REPLY · REFLECTION &amp; RATING</SectionLabel>

      <div
        style={{
          ...CARD,
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {/* Felt Rating 1–10 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: tokens.textSecondary }}>
              Felt rating (1–10)
            </span>
            {subjective !== null && (
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: tokens.accent }}>
                Rating: {subjective} / 10
              </span>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(10, 1fr)",
              gap: 4,
            }}
          >
            {FELT_RATINGS.map((rating) => {
              const isSelected = subjective === rating;
              return (
                <button
                  key={rating}
                  type="button"
                  disabled={isPending || isLoading}
                  onClick={() => setSubjective((curr) => (curr === rating ? null : rating))}
                  className="mono"
                  style={{
                    height: 36,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: isSelected ? 700 : 500,
                    cursor: isPending || isLoading ? "not-allowed" : "pointer",
                    background: isSelected ? tokens.primaryActionBg : tokens.toolBg,
                    border: `1px solid ${isSelected ? tokens.accent : tokens.borderDivider}`,
                    color: isSelected ? tokens.accent : tokens.textMuted,
                    transition: "all 0.15s ease",
                  }}
                  title={`Rate ${rating}/10`}
                >
                  {rating}
                </button>
              );
            })}
          </div>
        </div>

        {/* Reflection Textarea */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            htmlFor="journal-reflection-input"
            style={{ fontSize: 11.5, fontWeight: 600, color: tokens.textSecondary }}
          >
            Daily reflection
          </label>
          <textarea
            id="journal-reflection-input"
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            disabled={isPending || isLoading}
            placeholder="Reflect on what the mentor said and what the day's evidence shows. Correct the record, add context, write notes…"
            rows={5}
            style={{
              ...inputStyle(),
              fontFamily: "inherit",
              resize: "vertical",
              minHeight: 100,
              lineHeight: 1.5,
              fontSize: 13,
            }}
          />
        </div>

        {/* Mutation Error */}
        {replyMutation.isError && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: `1px solid ${tokens.bleed}`,
              background: tokens.bgCard,
              color: tokens.bleed,
              fontSize: 11.5,
            }}
          >
            Failed to save reply:{" "}
            {replyMutation.error instanceof Error
              ? replyMutation.error.message
              : String(replyMutation.error)}
          </div>
        )}

        {/* Actions Bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {currentNotePath && (
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: tokens.textSecondary,
                  background: tokens.toolBg,
                  border: `1px solid ${tokens.borderDivider}`,
                  padding: "3px 8px",
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
                title="Mirrored to Obsidian vault note"
              >
                <span>📄</span>
                <span>{currentNotePath}</span>
              </span>
            )}

            {showSavedToast && (
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: tokens.ok,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>✓</span>
                <span>Saved to day plan &amp; vault</span>
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={isPending || isLoading}
            style={{
              padding: "7px 18px",
              borderRadius: 6,
              border: `1px solid ${tokens.accent}`,
              background: tokens.primaryActionBg,
              color: tokens.accent,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: isPending || isLoading ? "not-allowed" : "pointer",
              opacity: isPending ? 0.7 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {isPending ? (
              <>
                <span className="ms" style={{ fontSize: 14 }}>
                  hourglass_empty
                </span>
                <span>Saving…</span>
              </>
            ) : (
              <>
                <span className="ms" style={{ fontSize: 14 }}>
                  save
                </span>
                <span>Save Reply</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
