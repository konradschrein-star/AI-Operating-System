"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { tokens } from "../../tokens";
import {
  fetchVaultFile,
  saveVaultFile,
  type VaultFile,
  type VaultConflict,
  VaultApiError,
} from "../../api-vault";
import { vaultCreateNote } from "../../api";

interface JournalVaultEditorProps {
  day: string; // YYYY-MM-DD
  onSaved?: () => void;
}

interface SplitContent {
  before: string;
  journal: string;
  after: string;
}

function splitJournalSection(fullContent: string): SplitContent {
  const headingMatch = /(?:^|\n)## Journal\b/i.exec(fullContent);
  if (!headingMatch || headingMatch.index === undefined) {
    const trimmed = fullContent.trimEnd();
    return {
      before: trimmed ? `${trimmed}\n\n## Journal\n` : `## Journal\n`,
      journal: "",
      after: "",
    };
  }

  const headingStart = headingMatch.index;
  const matchLen = headingMatch[0].length;
  const contentStart = headingStart + matchLen;

  // Search for the next '## ' section after '## Journal'
  const nextHeadingMatch = /\n## [^\n]+/g;
  nextHeadingMatch.lastIndex = contentStart;
  const nextMatch = nextHeadingMatch.exec(fullContent);

  if (!nextMatch) {
    const before = fullContent.slice(0, contentStart).replace(/^\n/, "");
    const journal = fullContent.slice(contentStart).replace(/^\r?\n/, "");
    return {
      before: before.endsWith("\n") ? before : `${before}\n`,
      journal,
      after: "",
    };
  }

  const before = fullContent.slice(0, contentStart).replace(/^\n/, "");
  const journal = fullContent
    .slice(contentStart, nextMatch.index)
    .replace(/^\r?\n/, "");
  const after = fullContent.slice(nextMatch.index + 1); // skip initial newline

  return {
    before: before.endsWith("\n") ? before : `${before}\n`,
    journal,
    after,
  };
}

function assembleFullContent(
  before: string,
  journal: string,
  after: string,
): string {
  let res = before;
  if (!res.endsWith("\n")) res += "\n";
  res += journal.trimEnd();
  res += "\n";
  if (after.trim()) {
    res += `\n${after.trimStart()}`;
  }
  return res;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function JournalVaultEditor({ day, onSaved }: JournalVaultEditorProps) {
  const vaultPath = `Daily/${day}.md`;

  const [vaultFile, setVaultFile] = useState<VaultFile | null>(null);
  const [split, setSplit] = useState<SplitContent>({
    before: "",
    journal: "",
    after: "",
  });
  const [localJournal, setLocalJournal] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VaultConflict | null>(null);
  const [isNoteMissing, setIsNoteMissing] = useState(false);

  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;
  const localJournalRef = useRef(localJournal);
  localJournalRef.current = localJournal;
  const vaultFileRef = useRef(vaultFile);
  vaultFileRef.current = vaultFile;
  const splitRef = useRef(split);
  splitRef.current = split;

  // Load vault file for day
  const loadDailyNote = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);
    setConflict(null);
    setIsNoteMissing(false);

    try {
      const file = await fetchVaultFile(vaultPath);
      setVaultFile(file);
      const parsed = splitJournalSection(file.content);
      setSplit(parsed);
      setLocalJournal(parsed.journal);
      setIsDirty(false);
    } catch (err) {
      if (err instanceof VaultApiError && err.status === 404) {
        setIsNoteMissing(true);
        setVaultFile(null);
        setSplit({
          before: `# ${day}\n\n## Tasks\n\n## Notes\n\n## Journal\n`,
          journal: "",
          after: "",
        });
        setLocalJournal("");
        setIsDirty(false);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  }, [vaultPath, day]);

  useEffect(() => {
    loadDailyNote();
  }, [loadDailyNote]);

  // Execute CAS save
  const handleSave = async (forceBaseSha?: string) => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);

    const journalContent = localJournalRef.current;
    const currentSplit = splitRef.current;
    const currentFile = vaultFileRef.current;

    const fullContent = assembleFullContent(
      currentSplit.before,
      journalContent,
      currentSplit.after,
    );

    try {
      // If note was missing, create it first
      if (isNoteMissing || !currentFile) {
        await vaultCreateNote({
          title: day,
          folder: "Daily",
          content: fullContent,
        });
        setIsNoteMissing(false);
        await loadDailyNote();
        onSaved?.();
        return;
      }

      const baseSha = forceBaseSha ?? currentFile.sha256;
      const res = await saveVaultFile({
        path: vaultPath,
        content: fullContent,
        base_sha256: baseSha,
      });

      if (res.kind === "ok") {
        setVaultFile((prev) =>
          prev
            ? {
                ...prev,
                content: fullContent,
                sha256: res.value.sha256,
                bytes: res.value.bytes,
                mtime_ms: Date.now(),
              }
            : null,
        );
        setIsDirty(false);
        setConflict(null);
        onSaved?.();
      } else {
        // Conflict (409)
        setConflict(res.value);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle typing with auto-save debounce
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalJournal(val);
    setIsDirty(true);

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    // Debounced auto-save after 2 seconds
    autoSaveTimerRef.current = setTimeout(() => {
      if (isDirtyRef.current && !conflict) {
        handleSave();
      }
    }, 2000);
  };

  // Conflict actions
  const handleOverwriteConflict = async () => {
    if (!conflict) return;
    await handleSave(conflict.current_sha256);
  };

  const handleReloadConflict = () => {
    if (!conflict) return;
    const parsed = splitJournalSection(conflict.current_content);
    setSplit(parsed);
    setLocalJournal(parsed.journal);
    if (vaultFile) {
      setVaultFile({
        ...vaultFile,
        content: conflict.current_content,
        sha256: conflict.current_sha256,
        bytes: conflict.current_bytes,
        mtime_ms: Date.now(),
      });
    }
    setIsDirty(false);
    setConflict(null);
  };

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Header & Status Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="ms"
            style={{ fontSize: 18, color: tokens.textSecondary }}
          >
            history_edu
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: tokens.text,
              letterSpacing: "0.06em",
              fontFamily: "monospace",
            }}
          >
            WRITTEN JOURNAL (Obsidian Daily/## Journal)
          </span>
        </div>

        {/* Sync Status Badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isSaving ? (
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                color: tokens.info,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.info,
                }}
              />
              Saving...
            </span>
          ) : conflict ? (
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                color: tokens.warn,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.warn,
                }}
              />
              Conflict detected
            </span>
          ) : isDirty ? (
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                color: tokens.decide,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.decide,
                }}
              />
              Unsaved edits
            </span>
          ) : vaultFile ? (
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                color: tokens.ok,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.ok,
                }}
              />
              Synced to {vaultPath}
              {vaultFile.mtime_ms
                ? ` (${formatMtime(vaultFile.mtime_ms)})`
                : ""}
            </span>
          ) : isNoteMissing ? (
            <span
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                color: tokens.textMuted,
              }}
            >
              Note will be created on save
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => handleSave()}
            disabled={isSaving || (!isDirty && !isNoteMissing)}
            style={{
              background: isDirty ? tokens.primaryActionBg : tokens.toolBg,
              border: `1px solid ${isDirty ? tokens.accent : tokens.border}`,
              borderRadius: 6,
              color: isDirty ? tokens.accent : tokens.textMuted,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              cursor:
                isSaving || (!isDirty && !isNoteMissing)
                  ? "default"
                  : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              save
            </span>
            Save Changes (CAS)
          </button>
        </div>
      </div>

      {/* Error state */}
      {loadError && (
        <div
          style={{
            padding: "12px 14px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 6,
            color: tokens.bleed,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 16 }}>
              error
            </span>
            <span>Failed to read vault file: {loadError}</span>
          </div>
          <button
            type="button"
            onClick={loadDailyNote}
            style={{
              background: tokens.toolBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 4,
              color: tokens.text,
              padding: "3px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {saveError && (
        <div
          style={{
            padding: "10px 12px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 6,
            color: tokens.bleed,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="ms" style={{ fontSize: 16 }}>
            error
          </span>
          <span style={{ flex: 1 }}>Save failed: {saveError}</span>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.bleed,
              cursor: "pointer",
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              close
            </span>
          </button>
        </div>
      )}

      {/* Conflict Resolution Modal / Banner */}
      {conflict && (
        <div
          style={{
            padding: 14,
            background: tokens.freezeBgWarn,
            border: `1px solid ${tokens.freezeBorderWarn}`,
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="ms" style={{ fontSize: 18, color: tokens.warn }}>
              warning
            </span>
            <div style={{ fontSize: 12, fontWeight: 600, color: tokens.warn }}>
              File modified on disk by another process (Syncthing / Mentor agent
              / Obsidian)
            </div>
          </div>
          <div
            style={{ fontSize: 11, color: tokens.textSoft, lineHeight: 1.5 }}
          >
            The note on disk changed since you loaded it. You can overwrite the
            disk file with your edits, or reload the disk version.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={handleOverwriteConflict}
              disabled={isSaving}
              style={{
                background: tokens.dangerActionBg,
                border: `1px solid ${tokens.dangerActionBorder}`,
                borderRadius: 6,
                color: tokens.bleed,
                padding: "6px 12px",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Overwrite with My Version
            </button>
            <button
              type="button"
              onClick={handleReloadConflict}
              disabled={isSaving}
              style={{
                background: tokens.toolBg,
                border: `1px solid ${tokens.border}`,
                borderRadius: 6,
                color: tokens.text,
                padding: "6px 12px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Reload Disk Version
            </button>
          </div>
        </div>
      )}

      {/* Editor Content Area */}
      {isLoading ? (
        /* Loading Skeleton */
        <div
          style={{
            height: 180,
            borderRadius: 6,
            background: tokens.toolBg,
            border: `1px solid ${tokens.borderDivider}`,
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />
      ) : (
        /* Populated / Editable Textarea */
        <div style={{ position: "relative" }}>
          <textarea
            value={localJournal}
            onChange={handleChange}
            placeholder="What did you build today? What gave you energy? Where did you hesitate or avoid? Write your evening retrospective reflections..."
            style={{
              width: "100%",
              minHeight: 180,
              background: tokens.inputBg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: "12px 14px",
              color: tokens.text,
              fontSize: 13,
              fontFamily: "inherit",
              lineHeight: 1.6,
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>
      )}

      {/* Context note hint */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 11,
          color: tokens.textMuted,
        }}
      >
        <span>
          Reads and writes section <code>## Journal</code> in{" "}
          <code>/opt/obsidian-vault/{vaultPath}</code>
        </span>
        <span>{localJournal.length} characters</span>
      </div>
    </div>
  );
}
