"use client";

/**
 * LibrarySurface — The unified AI OS Deliverables, Artifact & Media Hub.
 *
 * Provides a master-detail split layout to explore, search, preview, and edit
 * artifacts across four primary roots:
 * 1. Run Artefacts & Uploads (/opt/ai-os/uploads)
 * 2. Obsidian Vault (/opt/obsidian-vault)
 * 3. Content Forge Media (/opt/content-forge/media)
 * 4. Agent Workspace (/opt/ai-os/workspace)
 *
 * Integrates the reusable MediaDocumentViewer primitive for Markdown rendering/editing,
 * code syntax highlighting, high-res image zoom/pan, seekable video playback, audio,
 * and document inspection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./LibrarySurface.css";
import { tokens } from "../tokens";
import {
  fetchUploadRuns,
  fetchRunArtifacts,
  fetchFileList,
  searchFiles,
  fileReadUrl,
  runArtifactUrl,
  type UploadRunSummary,
  type RunArtifact,
  type FileEntry,
  type FileSearchEntry,
} from "../api";
import { useResizablePanel, ResizeHandle } from "./_ui/ResizableSplit";
import { MediaDocumentViewer } from "./_ui/MediaDocumentViewer";

type RootKey = "uploads" | "vault" | "media" | "workspace";

interface RootConfig {
  key: RootKey;
  label: string;
  icon: string;
  basePath: string;
}

const ROOTS: RootConfig[] = [
  {
    key: "uploads",
    label: "Run Artefacts & Uploads",
    icon: "photo_library",
    basePath: "/opt/ai-os/uploads",
  },
  {
    key: "vault",
    label: "Obsidian Vault",
    icon: "inventory_2",
    basePath: "/opt/obsidian-vault",
  },
  {
    key: "media",
    label: "Content Forge Media",
    icon: "movie",
    basePath: "/opt/content-forge/media",
  },
  {
    key: "workspace",
    label: "Agent Workspace",
    icon: "terminal",
    basePath: "/opt/ai-os/workspace",
  },
];

type FilterType = "all" | "images" | "videos" | "docs" | "patches" | "data";

interface FilterChip {
  id: FilterType;
  label: string;
  icon: string;
  exts: Set<string>;
}

const FILTER_CHIPS: FilterChip[] = [
  { id: "all", label: "All", icon: "select_all", exts: new Set() },
  {
    id: "images",
    label: "Screenshots & Images",
    icon: "image",
    exts: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"]),
  },
  {
    id: "videos",
    label: "Videos & Media",
    icon: "movie",
    exts: new Set([".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".ogg"]),
  },
  {
    id: "docs",
    label: "Notes & Docs",
    icon: "description",
    exts: new Set([".md", ".markdown", ".txt", ".pdf", ".doc", ".docx"]),
  },
  {
    id: "patches",
    label: "Patches & Diffs",
    icon: "difference",
    exts: new Set([".patch", ".diff"]),
  },
  {
    id: "data",
    label: "Data & JSON",
    icon: "data_object",
    exts: new Set([".json", ".csv", ".yml", ".yaml", ".sql", ".log", ".env", ".toml"]),
  },
];

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

function formatByteSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatShortDate(ts?: string | number | null): string {
  if (!ts) return "";
  try {
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return String(ts);
  }
}

interface SelectedItem {
  name: string;
  root: RootKey;
  path: string;
  url: string;
  vpsPath: string;
  size?: number;
  mtime?: string | number;
  runId?: string;
}

export function LibrarySurface() {
  // Navigation State
  const [activeRoot, setActiveRoot] = useState<RootKey>("uploads");
  const [currentRel, setCurrentRel] = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");

  // Uploads root state
  const [runs, setRuns] = useState<UploadRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runArtifacts, setRunArtifacts] = useState<RunArtifact[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Directory root state (vault, media, workspace)
  const [dirEntries, setDirEntries] = useState<FileEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Search hits state
  const [searchHits, setSearchHits] = useState<FileSearchEntry[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Active item in the preview pane
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);

  // Resizable split panel
  const masterPanel = useResizablePanel({
    storageKey: "forge.layout.library.masterWidth",
    initial: 380,
    min: 280,
    max: 650,
  });

  // Current active root configuration
  const currentRootConfig = useMemo(
    () => ROOTS.find((r) => r.key === activeRoot) ?? ROOTS[0]!,
    [activeRoot],
  );

  // Load Upload Runs when in "uploads" root
  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setRunsError(null);
    try {
      const result = await fetchUploadRuns();
      setRuns(result);
      if (result.length > 0 && !selectedRunId) {
        setSelectedRunId(result[0]!.id);
      }
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingRuns(false);
    }
  }, [selectedRunId]);

  // Load Artifacts for selected run
  const loadRunArtifacts = useCallback(async (runId: string) => {
    setLoadingArtifacts(true);
    try {
      const shots = await fetchRunArtifacts(runId, "all");
      setRunArtifacts(shots);
      // Auto-select first artifact if none selected
      if (shots.length > 0) {
        const first = shots[0]!;
        setSelectedItem({
          name: first.name,
          root: "uploads",
          path: `${runId}/${first.name}`,
          url: runArtifactUrl(runId, first.name),
          vpsPath: `/opt/ai-os/uploads/${runId}/${first.name}`,
          size: first.size,
          mtime: first.mtime,
          runId,
        });
      }
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingArtifacts(false);
    }
  }, []);

  // Load directory entries for vault, media, or workspace
  const loadDirectory = useCallback(async (rootKey: RootKey, relPath: string) => {
    setLoadingDir(true);
    setDirError(null);
    try {
      const res = await fetchFileList(rootKey, relPath);
      setDirEntries(res.entries);
    } catch (err) {
      setDirError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDir(false);
    }
  }, []);

  // Initial load / tab change
  useEffect(() => {
    setSearchQuery("");
    setSearchHits(null);
    if (activeRoot === "uploads") {
      void loadRuns();
    } else {
      setCurrentRel("");
      void loadDirectory(activeRoot, "");
    }
  }, [activeRoot, loadRuns, loadDirectory]);

  // Load artifacts when selected run changes
  useEffect(() => {
    if (activeRoot === "uploads" && selectedRunId) {
      void loadRunArtifacts(selectedRunId);
    }
  }, [activeRoot, selectedRunId, loadRunArtifacts]);

  // Directory search debounce
  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2 || activeRoot === "uploads") {
      setSearchHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchFiles(activeRoot, currentRel, q)
        .then((res) => {
          if (!cancelled) {
            setSearchHits(res.entries.filter((e) => !e.isDir));
            setSearching(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchHits([]);
            setSearching(false);
          }
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, activeRoot, currentRel]);

  // Breadcrumb navigation handler
  const handleBreadcrumbClick = (segIndex: number) => {
    if (segIndex === 0) {
      setCurrentRel("");
      void loadDirectory(activeRoot, "");
    } else {
      const parts = currentRel.split("/").filter(Boolean);
      const nextRel = parts.slice(0, segIndex).join("/");
      setCurrentRel(nextRel);
      void loadDirectory(activeRoot, nextRel);
    }
  };

  // Descend into folder
  const handleFolderClick = (dirName: string) => {
    const nextRel = currentRel ? `${currentRel}/${dirName}` : dirName;
    setCurrentRel(nextRel);
    void loadDirectory(activeRoot, nextRel);
  };

  // Select file from directory list
  const handleFileSelect = (entry: FileEntry | FileSearchEntry) => {
    const rel = "path" in entry ? entry.path : currentRel ? `${currentRel}/${entry.name}` : entry.name;
    const vps = `${currentRootConfig.basePath}/${rel}`;
    const url = fileReadUrl(activeRoot, rel);
    setSelectedItem({
      name: entry.name,
      root: activeRoot,
      path: rel,
      url,
      vpsPath: vps,
      size: entry.size,
      mtime: entry.mtime,
    });
  };

  // Select artifact from run
  const handleArtifactSelect = (artifact: RunArtifact) => {
    if (!selectedRunId) return;
    setSelectedItem({
      name: artifact.name,
      root: "uploads",
      path: `${selectedRunId}/${artifact.name}`,
      url: runArtifactUrl(selectedRunId, artifact.name),
      vpsPath: `/opt/ai-os/uploads/${selectedRunId}/${artifact.name}`,
      size: artifact.size,
      mtime: artifact.mtime,
      runId: selectedRunId,
    });
  };

  // Filter items based on activeFilter and searchQuery
  const currentFilterChip = useMemo(
    () => FILTER_CHIPS.find((c) => c.id === activeFilter) ?? FILTER_CHIPS[0]!,
    [activeFilter],
  );

  const filteredArtifacts = useMemo(() => {
    return runArtifacts.filter((a) => {
      const ext = getFileExtension(a.name);
      if (activeFilter !== "all" && !currentFilterChip.exts.has(ext)) {
        return false;
      }
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        const matchesName = a.name.toLowerCase().includes(q);
        const matchesLabel = a.label ? a.label.toLowerCase().includes(q) : false;
        return matchesName || matchesLabel;
      }
      return true;
    });
  }, [runArtifacts, activeFilter, currentFilterChip, searchQuery]);

  const filteredDirEntries = useMemo(() => {
    return dirEntries.filter((e) => {
      if (e.isDir) return true;
      const ext = getFileExtension(e.name);
      if (activeFilter !== "all" && !currentFilterChip.exts.has(ext)) {
        return false;
      }
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase();
        return e.name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [dirEntries, activeFilter, currentFilterChip, searchQuery]);

  // Summary counts
  const totalUploadFiles = useMemo(
    () => runs.reduce((acc, r) => acc + (r.file_count || r.count || 0), 0),
    [runs],
  );
  const totalUploadImages = useMemo(
    () => runs.reduce((acc, r) => acc + (r.image_count || r.count || 0), 0),
    [runs],
  );

  return (
    <div className="library-surface">
      {/* ── Top Control & Filter Bar ── */}
      <div className="lib-control-bar">
        {/* Row 1: Root Tabs & Summary Badge */}
        <div className="lib-control-row-top">
          <div className="lib-root-tabs">
            {ROOTS.map((root) => {
              const isActive = activeRoot === root.key;
              return (
                <button
                  key={root.key}
                  type="button"
                  onClick={() => setActiveRoot(root.key)}
                  className={`mono lib-root-tab ${isActive ? "active" : ""}`}
                  title={root.basePath}
                >
                  <span className="ms" style={{ fontSize: 16 }}>
                    {root.icon}
                  </span>
                  {root.label}
                </button>
              );
            })}
          </div>

          {/* Live Summary Stat Badge */}
          <div className="mono lib-stat-badge">
            <span className="ms" style={{ fontSize: 14, color: tokens.accent }}>
              analytics
            </span>
            {activeRoot === "uploads" ? (
              <span>
                {runs.length} runs · {totalUploadFiles} files · {totalUploadImages} shots
              </span>
            ) : (
              <span>
                {dirEntries.filter((e) => !e.isDir).length} files ·{" "}
                {dirEntries.filter((e) => e.isDir).length} folders in current path
              </span>
            )}
          </div>
        </div>

        {/* Row 2: Search Box, Type Filters, and View Toggle */}
        <div className="lib-control-row-bottom">
          <div className="lib-search-box">
            <span className="ms" style={{ fontSize: 16, color: tokens.textMuted }}>
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                activeRoot === "uploads"
                  ? "Search runs & artifacts…"
                  : "Search directory files…"
              }
              className="mono lib-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: tokens.textFaint,
                  cursor: "pointer",
                  display: "flex",
                }}
              >
                <span className="ms" style={{ fontSize: 14 }}>
                  close
                </span>
              </button>
            )}
          </div>

          {/* Type Filter Pills */}
          <div className="lib-filter-chips">
            {FILTER_CHIPS.map((chip) => {
              const isActive = activeFilter === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setActiveFilter(chip.id)}
                  className={`mono lib-chip-btn ${isActive ? "active" : ""}`}
                >
                  <span className="ms" style={{ fontSize: 12, marginRight: 4 }}>
                    {chip.icon}
                  </span>
                  {chip.label}
                </button>
              );
            })}
          </div>

          {/* View Mode Toggle */}
          <div className="lib-view-toggle">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`lib-view-btn ${viewMode === "grid" ? "active" : ""}`}
              title="Grid Thumbnail View"
            >
              <span className="ms" style={{ fontSize: 16 }}>
                grid_view
              </span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`lib-view-btn ${viewMode === "list" ? "active" : ""}`}
              title="Dense List View"
            >
              <span className="ms" style={{ fontSize: 16 }}>
                view_list
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Split Layout Area ── */}
      <div className="lib-split-body">
        {/* Left Column: Explorer / Run & Sibling Files Navigator */}
        <div
          className="lib-master-pane"
          style={{ width: masterPanel.size, flex: "none" }}
        >
          {/* Breadcrumbs Bar */}
          <div className="mono lib-breadcrumbs-bar">
            <span
              onClick={() => {
                if (activeRoot === "uploads") {
                  setSelectedRunId(null);
                } else {
                  handleBreadcrumbClick(0);
                }
              }}
              className="lib-breadcrumb-link"
            >
              {currentRootConfig.label}
            </span>

            {activeRoot === "uploads" && selectedRunId && (
              <>
                <span style={{ color: tokens.textGhost }}>/</span>
                <span className="lib-breadcrumb-active">
                  Run {selectedRunId.slice(0, 12)}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(null)}
                  style={{
                    marginLeft: "auto",
                    background: "transparent",
                    border: "none",
                    color: tokens.accent,
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  All Runs ↗
                </button>
              </>
            )}

            {activeRoot !== "uploads" && currentRel && (
              <>
                {currentRel.split("/").map((seg, idx, arr) => {
                  const isLast = idx === arr.length - 1;
                  return (
                    <span key={seg} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <span style={{ color: tokens.textGhost }}>/</span>
                      {isLast ? (
                        <span className="lib-breadcrumb-active">{seg}</span>
                      ) : (
                        <span
                          onClick={() => handleBreadcrumbClick(idx + 1)}
                          className="lib-breadcrumb-link"
                        >
                          {seg}
                        </span>
                      )}
                    </span>
                  );
                })}
              </>
            )}
          </div>

          {/* Content Viewport */}
          <div className="lib-items-viewport">
            {/* 1. UPLOADS: RUNS LIST (when no run selected or viewing runs overview) */}
            {activeRoot === "uploads" && !selectedRunId && (
              <div className="lib-run-list">
                {loadingRuns && (
                  <div className="mono" style={{ padding: 16, fontSize: 11, color: tokens.textFaint }}>
                    loading runs…
                  </div>
                )}
                {runsError && (
                  <div className="mono" style={{ padding: 16, fontSize: 11, color: tokens.bleed }}>
                    error loading runs: {runsError}
                  </div>
                )}
                {!loadingRuns && runs.length === 0 && (
                  <div className="mono" style={{ padding: 24, fontSize: 11, color: tokens.textFaint, textAlign: "center" }}>
                    no runs found in /opt/ai-os/uploads
                  </div>
                )}
                {runs.map((run) => (
                  <div
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    className="lib-run-row"
                  >
                    <div>
                      <div className="mono lib-run-id">{run.id.slice(0, 12)}</div>
                      <div className="mono" style={{ fontSize: 10, color: tokens.textFaint, marginTop: 2 }}>
                        {formatShortDate(run.latest_ts)}
                      </div>
                    </div>
                    <div className="mono lib-run-count">
                      {run.file_count || run.count} items
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 2. UPLOADS: RUN ARTIFACTS (when run is selected) */}
            {activeRoot === "uploads" && selectedRunId && (
              <>
                {loadingArtifacts && (
                  <div className="mono" style={{ padding: 16, fontSize: 11, color: tokens.textFaint }}>
                    loading run artifacts…
                  </div>
                )}
                {!loadingArtifacts && filteredArtifacts.length === 0 && (
                  <div className="mono" style={{ padding: 24, fontSize: 11, color: tokens.textFaint, textAlign: "center" }}>
                    no artifacts match current filter
                  </div>
                )}

                {/* Grid View */}
                {viewMode === "grid" && (
                  <div className="lib-grid-container">
                    {filteredArtifacts.map((artifact) => {
                      const isSel = selectedItem?.path === `${selectedRunId}/${artifact.name}`;
                      const isImg = IMAGE_EXT_SET.has(getFileExtension(artifact.name));
                      const isVid = VIDEO_EXT_SET.has(getFileExtension(artifact.name));
                      return (
                        <div
                          key={artifact.name}
                          onClick={() => handleArtifactSelect(artifact)}
                          className={`lib-grid-card ${isSel ? "selected" : ""}`}
                        >
                          <div className="lib-grid-thumb">
                            {isImg ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={runArtifactUrl(selectedRunId, artifact.name)}
                                alt={artifact.name}
                                loading="lazy"
                                className="lib-grid-img"
                              />
                            ) : isVid ? (
                              <span className="ms" style={{ fontSize: 32, color: tokens.warn }}>
                                movie
                              </span>
                            ) : (
                              <span className="ms" style={{ fontSize: 32, color: tokens.accent }}>
                                description
                              </span>
                            )}
                          </div>
                          <div className="lib-grid-meta">
                            <div className="mono lib-grid-name" title={artifact.name}>
                              {artifact.name}
                            </div>
                            <div className="mono lib-grid-sub">
                              <span>{formatByteSize(artifact.size)}</span>
                              <span>{formatShortDate(artifact.mtime)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* List View */}
                {viewMode === "list" && (
                  <div className="lib-list-container">
                    {filteredArtifacts.map((artifact) => {
                      const isSel = selectedItem?.path === `${selectedRunId}/${artifact.name}`;
                      return (
                        <div
                          key={artifact.name}
                          onClick={() => handleArtifactSelect(artifact)}
                          className={`lib-list-row ${isSel ? "selected" : ""}`}
                        >
                          <span className="ms lib-list-icon">
                            {IMAGE_EXT_SET.has(getFileExtension(artifact.name))
                              ? "image"
                              : VIDEO_EXT_SET.has(getFileExtension(artifact.name))
                              ? "movie"
                              : "description"}
                          </span>
                          <span className="mono lib-list-name">{artifact.name}</span>
                          <span className="mono lib-list-size">
                            {formatByteSize(artifact.size)}
                          </span>
                          <span className="mono lib-list-mtime">
                            {formatShortDate(artifact.mtime)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* 3. DIRECTORY ROOTS: VAULT, MEDIA, WORKSPACE */}
            {activeRoot !== "uploads" && (
              <>
                {loadingDir && (
                  <div className="mono" style={{ padding: 16, fontSize: 11, color: tokens.textFaint }}>
                    loading folder…
                  </div>
                )}
                {dirError && (
                  <div className="mono" style={{ padding: 16, fontSize: 11, color: tokens.bleed }}>
                    error: {dirError}
                  </div>
                )}
                {!loadingDir && !dirError && filteredDirEntries.length === 0 && (
                  <div className="mono" style={{ padding: 24, fontSize: 11, color: tokens.textFaint, textAlign: "center" }}>
                    folder is empty or no files match filter
                  </div>
                )}

                {/* Grid View */}
                {viewMode === "grid" && (
                  <div className="lib-grid-container">
                    {filteredDirEntries.map((entry) => {
                      const fullRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
                      const isSel = selectedItem?.path === fullRel && selectedItem?.root === activeRoot;
                      const isImg = IMAGE_EXT_SET.has(getFileExtension(entry.name));
                      const isVid = VIDEO_EXT_SET.has(getFileExtension(entry.name));
                      return (
                        <div
                          key={entry.name}
                          onClick={() => {
                            if (entry.isDir) {
                              handleFolderClick(entry.name);
                            } else {
                              handleFileSelect(entry);
                            }
                          }}
                          className={`lib-grid-card ${isSel ? "selected" : ""}`}
                        >
                          <div className="lib-grid-thumb">
                            {entry.isDir ? (
                              <span className="ms" style={{ fontSize: 36, color: tokens.accent }}>
                                folder
                              </span>
                            ) : isImg ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={fileReadUrl(activeRoot, fullRel)}
                                alt={entry.name}
                                loading="lazy"
                                className="lib-grid-img"
                              />
                            ) : isVid ? (
                              <span className="ms" style={{ fontSize: 32, color: tokens.warn }}>
                                movie
                              </span>
                            ) : (
                              <span className="ms" style={{ fontSize: 32, color: tokens.textMuted }}>
                                description
                              </span>
                            )}
                          </div>
                          <div className="lib-grid-meta">
                            <div className="mono lib-grid-name" title={entry.name}>
                              {entry.name}
                            </div>
                            <div className="mono lib-grid-sub">
                              <span>{entry.isDir ? "directory" : formatByteSize(entry.size)}</span>
                              <span>{formatShortDate(entry.mtime)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* List View */}
                {viewMode === "list" && (
                  <div className="lib-list-container">
                    {filteredDirEntries.map((entry) => {
                      const fullRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
                      const isSel = selectedItem?.path === fullRel && selectedItem?.root === activeRoot;
                      return (
                        <div
                          key={entry.name}
                          onClick={() => {
                            if (entry.isDir) {
                              handleFolderClick(entry.name);
                            } else {
                              handleFileSelect(entry);
                            }
                          }}
                          className={`lib-list-row ${isSel ? "selected" : ""}`}
                        >
                          <span
                            className="ms lib-list-icon"
                            style={{ color: entry.isDir ? tokens.accent : undefined }}
                          >
                            {entry.isDir
                              ? "folder"
                              : IMAGE_EXT_SET.has(getFileExtension(entry.name))
                              ? "image"
                              : VIDEO_EXT_SET.has(getFileExtension(entry.name))
                              ? "movie"
                              : "description"}
                          </span>
                          <span className="mono lib-list-name">{entry.name}</span>
                          <span className="mono lib-list-size">
                            {entry.isDir ? "—" : formatByteSize(entry.size)}
                          </span>
                          <span className="mono lib-list-mtime">
                            {formatShortDate(entry.mtime)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Resize Handle Strip */}
        <ResizeHandle {...masterPanel.handleProps} />

        {/* Right Column: Deep Inspection Preview with MediaDocumentViewer */}
        <div className="lib-detail-pane">
          {selectedItem ? (
            <MediaDocumentViewer
              key={`${selectedItem.root}:${selectedItem.path}`}
              name={selectedItem.name}
              root={selectedItem.root}
              path={selectedItem.path}
              url={selectedItem.url}
              vpsPath={selectedItem.vpsPath}
              size={selectedItem.size}
              mtime={selectedItem.mtime}
              onSave={() => {
                // Refresh directory or artifacts to pick up updated file metadata
                if (activeRoot === "uploads" && selectedRunId) {
                  void loadRunArtifacts(selectedRunId);
                } else if (activeRoot !== "uploads") {
                  void loadDirectory(activeRoot, currentRel);
                }
              }}
            />
          ) : (
            <div className="lib-empty-detail">
              <span className="ms lib-empty-icon">visibility</span>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: tokens.textHi }}>
                Select an artifact or document to inspect
              </div>
              <p className="mono" style={{ fontSize: 11.5, color: tokens.textMuted, maxWidth: 380 }}>
                Browse artifacts across runs, the Obsidian vault, media renders, or the agent workspace.
                Markdown files can be edited in place with atomic conflict-guarded saves.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const IMAGE_EXT_SET = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"]);
const VIDEO_EXT_SET = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
