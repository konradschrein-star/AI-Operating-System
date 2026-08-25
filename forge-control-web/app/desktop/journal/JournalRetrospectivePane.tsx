"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchJournalDay, type JournalEntry } from "../../api";
import { MentorRead } from "./MentorRead";
import { DayEvidence } from "./DayEvidence";
import { ReplyBox } from "./ReplyBox";
import { StatsPanel } from "../stats/StatsPanel";
import { PaperCaptureDeck } from "./PaperCaptureDeck";
import { JournalVaultEditor } from "./JournalVaultEditor";
import { CARD } from "../goals/ui";

interface JournalRetrospectivePaneProps {
  day: string; // YYYY-MM-DD
}

export function JournalRetrospectivePane({ day }: JournalRetrospectivePaneProps) {
  const queryClient = useQueryClient();

  // Query: Journal Day Data (mentor + evidence + reply + entries + errors)
  const {
    data: journalData,
    isLoading: isJournalLoading,
    isError: isJournalError,
    error: journalError,
    refetch: refetchJournal,
  } = useQuery({
    queryKey: ["journal", "day", day],
    queryFn: () => fetchJournalDay(day),
    staleTime: 10_000,
  });

  const entries: JournalEntry[] = journalData?.entries ?? [];

  const handleSavedVault = () => {
    queryClient.invalidateQueries({ queryKey: ["vault", "file", `Daily/${day}.md`] });
    queryClient.invalidateQueries({ queryKey: ["journal", "day", day] });
  };

  const handleUploadSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["journal", "day", day] });
    queryClient.invalidateQueries({ queryKey: ["vault", "file", `Daily/${day}.md`] });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        paddingBottom: 32,
      }}
    >
      {/* 1. MENTOR'S READ */}
      <MentorRead
        day={day}
        mentor={journalData?.mentor}
        errors={journalData?.errors}
        isLoading={isJournalLoading}
      />

      {/* 2. WHAT HAPPENED — EVIDENCE OF THE DAY */}
      <DayEvidence
        day={day}
        evidence={journalData?.evidence}
        errors={journalData?.errors}
        isLoading={isJournalLoading}
      />

      {/* 3. YOUR REPLY — REFLECTION & FELT RATING */}
      <ReplyBox
        day={day}
        reply={journalData?.reply}
        isLoading={isJournalLoading}
      />

      {/* 4. STATS — MOUNTED IN JOURNAL */}
      <div style={{ marginTop: 4 }}>
        <StatsPanel mount="journal" day={day} />
      </div>

      {/* 5. COLLAPSIBLE DISCLOSURES AT THE BOTTOM */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
        {/* Paper capture disclosure */}
        <details
          style={{
            ...CARD,
            padding: "12px 16px",
            background: tokens.bgCard,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: 12.5,
              fontWeight: 600,
              color: tokens.textSecondary,
              userSelect: "none",
              outline: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>📷</span>
            <span>
              Paper capture
              {entries.length > 0 ? ` (${entries.length} page${entries.length === 1 ? "" : "s"})` : " (0 pages)"}
            </span>
          </summary>
          <div style={{ marginTop: 14 }}>
            <PaperCaptureDeck
              day={day}
              entries={entries}
              isLoading={isJournalLoading}
              isError={isJournalError}
              error={journalError instanceof Error ? journalError : null}
              onRefresh={() => refetchJournal()}
              onUploadSuccess={handleUploadSuccess}
            />
          </div>
        </details>

        {/* Edit day note disclosure */}
        <details
          style={{
            ...CARD,
            padding: "12px 16px",
            background: tokens.bgCard,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: 12.5,
              fontWeight: 600,
              color: tokens.textSecondary,
              userSelect: "none",
              outline: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>📝</span>
            <span>Edit day note (Daily/{day}.md)</span>
          </summary>
          <div style={{ marginTop: 14 }}>
            <JournalVaultEditor day={day} onSaved={handleSavedVault} />
          </div>
        </details>
      </div>
    </div>
  );
}
