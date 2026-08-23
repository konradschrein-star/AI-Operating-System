"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  fetchJournalDay,
  fetchDecisionsForDay,
  type JournalEntry,
  type DecisionEntry,
} from "../../api";
import { PaperCaptureDeck } from "./PaperCaptureDeck";
import { JournalVaultEditor } from "./JournalVaultEditor";
import { DailyDecisionsStream } from "./DailyDecisionsStream";

interface JournalRetrospectivePaneProps {
  day: string; // YYYY-MM-DD
}

export function JournalRetrospectivePane({ day }: JournalRetrospectivePaneProps) {
  const queryClient = useQueryClient();

  // Query 1: Paper Journal Entries for day
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

  // Query 2: Daily Decisions for day
  const {
    data: decisionsData,
    isLoading: isDecisionsLoading,
    isError: isDecisionsError,
    error: decisionsError,
    refetch: refetchDecisions,
  } = useQuery({
    queryKey: ["decisions", "day", day],
    queryFn: () => fetchDecisionsForDay(day),
    staleTime: 15_000,
  });

  const entries: JournalEntry[] = journalData?.entries ?? [];
  const decisions: DecisionEntry[] = decisionsData ?? [];

  const handleSavedVault = () => {
    // Invalidate queries that might be affected by vault changes
    queryClient.invalidateQueries({ queryKey: ["vault", "file", `Daily/${day}.md`] });
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
        gap: 16,
        paddingBottom: 24,
      }}
    >
      {/* Section 1: Paper Journal & Scans */}
      <PaperCaptureDeck
        day={day}
        entries={entries}
        isLoading={isJournalLoading}
        isError={isJournalError}
        error={journalError instanceof Error ? journalError : null}
        onRefresh={() => refetchJournal()}
        onUploadSuccess={handleUploadSuccess}
      />

      {/* Section 2: Written Journal (Obsidian Daily ## Journal CAS Editor) */}
      <JournalVaultEditor day={day} onSaved={handleSavedVault} />

      {/* Section 3: Daily Decisions Stream */}
      <DailyDecisionsStream
        day={day}
        decisions={decisions}
        isLoading={isDecisionsLoading}
        isError={isDecisionsError}
        error={decisionsError instanceof Error ? decisionsError : null}
        onRefresh={() => refetchDecisions()}
      />
    </div>
  );
}
