"use client";

/**
 * VPS file explorer panel — browse the Obsidian vault / agent workspace
 * directly in the desktop UI instead of only ever uploading fresh copies.
 * Read-only browsing + download + drag-to-chat + "attach to this chat"
 * button (which just registers the existing VPS path as an attachment, no
 * re-upload).
 *
 * Uses VaultFileList for virtualized, token-native directory rendering.
 * Bounded LRU cache (CACHE_MAX entries) with stale-while-revalidate so
 * navigating back to a previously seen directory is instant.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import "./FileExplorerPanel.css";
import { tokens } from "../../tokens";
import {
  fetchFileRoots,
  fetchFileList,
  attachExistingFile,
  searchFiles,
  type FileRoot,
  type FileEntry,
  type FileSearchEntry,
  type UploadedFile,
} from "../../api";
import { VaultFileList, VPS_FILE_DRAG_MIME } from "./VaultFileList";
import { FilePreview } from "./FilePreview";
import {
  subscribeOpenFile,
  consumePendingOpenFile,
  clearPendingOpenFile,
  splitRel,
  type OpenFileRequest,
} from "./open-file-bus";

export { VPS_FILE_DRAG_MIME };

const CACHE_MAX = 32;

interface CacheEntry {
  entries: FileEntry[];
  truncated: boolean;
  total: number;
  ts: number;
}

/** Search result enriched with root+rel so attach/copy work without re-resolving. */
interface SearchHit {
  name: string;
  path: string;   // '/{rootLabel}/{relPath}' — unique key for selection identity
  root: string;   // root key
  rel: string;    // full relative path within root
  size?: number;
  mtime: string;
}

/** A selected file qualified by the (root, parentRel) it was selected in —
 *  so selection survives navigation without aliasing files that share a
 *  name across sibling directories (R4). `parentRel` is the containing
 *  directory's rel; the full rel of the file is `parentRel/entry.name`. */
interface SelectedFile {
  root: string;
  parentRel: string;
  entry: FileEntry;
  /** 1-based line carried in from a `path:line` reference in a chat message.
   *  Only ever set by a programmatic open — a manual click builds a
   *  `SelectedFile` without it, which is how "click another row" clears the
   *  line. */
  line?: number;
}

function selectionKey(root: string, parentRel: string, name: string): string {
  return `${root}::${parentRel}::${name}`;
}

function cacheKey(root: string | null, rel: string): string {
  return `${root ?? ""}::${rel}`;
}

function evictIfNeeded(cache: Map<string, CacheEntry>): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Memoised — ChatSurface re-renders on every streamed event; without memo
 *  the entire file tree would re-render on every token even when nothing
 *  file-related has changed. */
function FileExplorerPanelImpl({
  onAttach,
}: {
  /** null when there's no active chat to attach into. */
  onAttach: ((file: UploadedFile) => void) | null;
}) {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [currentRoot, setCurrentRoot] = useState<string | null>(null);
  const [currentRel, setCurrentRel] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchErrors, setSearchErrors] = useState<{ label: string; message: string }[]>([]);
  const [searchSelected, setSearchSelected] = useState<SearchHit[]>([]);
  const [pathCopied, setPathCopied] = useState(false);
  // Errors from user-initiated actions (attach, copy path). Distinct from
  // loadError (which is directory-load failures) so a click failure surfaces
  // even while the file list itself is healthy. T16: no silent fallbacks.
  const [actionError, setActionError] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  // Monotonic sequence for every load* call — used to drop stale responses
  // that resolve after the user has already navigated elsewhere. Without
  // this guard, a slow fetch for dir A resolves after a fast fetch for dir
  // B and overwrites B's entries under B's breadcrumb.
  const seqRef = useRef(0);

  const loadRoots = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    let rs: FileRoot[];
    try {
      rs = await fetchFileRoots();
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoading(false);
      setLoadError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (seq !== seqRef.current) return;
    setLoading(false);
    setRoots(rs);
    setLoadError(null);
    setEntries(rs.map((r) => ({ name: r.label, isDir: true, size: 0, mtime: new Date().toISOString() })));
    setTruncated(false);
    setTotal(undefined);
  }, []);

  /** Root METADATA only — deliberately never touches `entries`. Used when a
   *  file/folder request has already claimed the listing but the breadcrumb
   *  still needs "Obsidian Vault" rather than the raw key `vault`.
   *  `fetchFileRoots` is a cached module promise, so this adds no request and
   *  no poll. A failure degrades the labels, not the list, so it reports
   *  through the dismissable action banner instead of replacing the file list
   *  with an error row. */
  const ensureRootLabels = useCallback(async () => {
    try {
      setRoots(await fetchFileRoots());
    } catch (err) {
      setActionError(
        `file roots failed to load — breadcrumbs will show raw root keys: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, []);

  const loadDir = useCallback(async (root: string | null, rel: string) => {
    if (root === null) {
      await loadRoots();
      return;
    }
    const seq = ++seqRef.current;
    const key = cacheKey(root, rel);
    const cached = cacheRef.current.get(key);
    if (cached) {
      // Stale-while-revalidate: render cached data immediately, then refresh below
      setEntries(cached.entries);
      setTruncated(cached.truncated);
      setTotal(cached.total);
      setLoadError(null);
    } else {
      setLoading(true);
    }
    let result: Awaited<ReturnType<typeof fetchFileList>>;
    try {
      result = await fetchFileList(root, rel);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setLoading(false);
      // Preserve the SWR contract: if we already rendered cached entries above,
      // keep them visible on revalidation failure instead of replacing them
      // with an error row. Only surface the error when we have nothing to show.
      if (!cached) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    // Cache the result regardless — it's still a valid snapshot of `key`
    // even if the user navigated away, and populating the cache benefits
    // the eventual return trip.
    if (!cacheRef.current.has(key)) evictIfNeeded(cacheRef.current);
    cacheRef.current.set(key, { ...result, ts: Date.now() });
    if (seq !== seqRef.current) return;
    setLoading(false);
    setLoadError(null);
    setEntries(result.entries);
    setTruncated(result.truncated);
    setTotal(result.total);
  }, [loadRoots]);

  /* The initial listing: the root menu. Guarded on `seqRef` because this must
   * run ONCE PER COMPONENT INSTANCE, not once per effect invocation.
   *
   * MEASURED 2026-08-25, and it made the whole open-a-file path unverifiable:
   * `next.config.mjs` sets `reactStrictMode: true`, so in development React
   * invokes mount effects twice against the SAME instance (state survives, so
   * this is not a fresh mount). Pass 1 loaded the roots (seq 1), the latch
   * effect below then opened the requested directory (seq 2). Pass 2 re-ran
   * this effect — seq 3 — while `consumePendingOpenFile()` correctly returned
   * null the second time, so nothing re-issued the directory load. The roots
   * response won the seq guard and the panel sat on the root menu with the
   * requested folder in its breadcrumb: right breadcrumb, wrong list, no
   * selection, no preview. StrictMode's double-invoke is dev-only, but the
   * fragility is not — any remount that preserves state has the same shape. */
  useEffect(() => {
    if (seqRef.current > 0) {
      // Something already navigated. Take the labels, leave `entries` alone.
      void ensureRootLabels();
      return;
    }
    void loadDir(null, "");
  }, [loadDir, ensureRootLabels]);

  /* ── Open-a-file requests from a clicked path in a chat message ────────────
   *
   * Two steps, because they cannot be one: navigating to the directory is a
   * fetch, and the entry we want to select only exists once that fetch has
   * landed. So the request parks in `pendingOpen`, and the effect below
   * consumes it when `entries` next matches the directory it asked for.
   *
   * Search mode is cleared first: the preview pane refuses to render while
   * `isSearching` is true, so a request arriving during a search would
   * otherwise select the file and show nothing. */
  const [pendingOpen, setPendingOpen] = useState<{
    root: string;
    parentRel: string;
    name: string;
    line?: number;
  } | null>(null);

  /* D4: the reveal handed to VaultFileList. `nonce` is monotonic so re-opening
   * the same file re-runs the scroll and restarts the flash — without it the
   * second click on a pill would look dead. Held as state (not a ref) because
   * the list has to re-render to see it. */
  const [reveal, setReveal] = useState<{ name: string; nonce: number } | null>(null);
  const revealSeqRef = useRef(0);

  const handleOpenRequest = useCallback(
    ({ root, path, line, isDir }: OpenFileRequest) => {
      clearPendingOpenFile();
      setQuery("");
      setSearchResults(null);
      setSearchSelected([]);
      if (isDir) {
        /* D5: the request names a directory. There is no entry to select and
         * nothing to preview — navigating there IS the whole answer, and the
         * breadcrumb is what confirms it. Any earlier selection would keep a
         * preview of an unrelated file pinned under the new folder, so it
         * goes. A directory that does not exist surfaces through loadDir's
         * existing loadError row; there is deliberately no branch for it
         * here, because a second error path is a second thing to keep true. */
        setPendingOpen(null);
        setSelected([]);
        setReveal(null);
        setCurrentRoot(root);
        setCurrentRel(path);
        void loadDir(root, path);
        return;
      }
      const { parentRel, name } = splitRel(path);
      setPendingOpen({ root, parentRel, name, line });
      setCurrentRoot(root);
      setCurrentRel(parentRel);
      void loadDir(root, parentRel);
    },
    [loadDir],
  );

  useEffect(
    () => subscribeOpenFile(handleOpenRequest),
    [handleOpenRequest],
  );

  /* This panel is UNMOUNTED while the sidebar sits on the Team tab, so a click
   * that switches the tab dispatches before this component exists. Take the
   * request it left behind. Mount-only: the deps are empty on purpose. */
  useEffect(() => {
    const missed = consumePendingOpenFile();
    if (missed) handleOpenRequest(missed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pendingOpen) return;
    // Only act once the loaded directory IS the requested one — otherwise a
    // slower earlier load could satisfy the request with the wrong folder.
    if (currentRoot !== pendingOpen.root || currentRel !== pendingOpen.parentRel) return;
    const entry = entries.find((e) => !e.isDir && e.name === pendingOpen.name);
    if (!entry) {
      // The directory arrived and the file is not in it: drop the request
      // rather than leaving it armed to fire on some later navigation.
      if (!loading) setPendingOpen(null);
      return;
    }
    setSelected([
      {
        root: pendingOpen.root,
        parentRel: pendingOpen.parentRel,
        entry,
        line: pendingOpen.line,
      },
    ]);
    // D4: selection alone left the file invisible in a virtualized list. Ask
    // the list to scroll to it and flash it. Fired here, not in
    // handleOpenRequest, because only here is the entry known to exist.
    setReveal({ name: entry.name, nonce: ++revealSeqRef.current });
    setPendingOpen(null);
  }, [pendingOpen, entries, currentRoot, currentRel, loading]);

  const handleDescend = useCallback((entry: FileEntry) => {
    if (!entry.isDir) return;
    if (currentRoot === null) {
      const matchedRoot = roots.find((r) => r.label === entry.name);
      if (!matchedRoot) return;
      setCurrentRoot(matchedRoot.key);
      setCurrentRel("");
      void loadDir(matchedRoot.key, "");
    } else {
      const newRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      setCurrentRel(newRel);
      void loadDir(currentRoot, newRel);
    }
    // Selection persists across navigation (R4). Each selection is
    // qualified by (root, parentRel, name), so descending into a sibling
    // folder that happens to contain a same-named file won't visually
    // steal the earlier selection.
    setQuery("");
  }, [currentRoot, currentRel, roots, loadDir]);

  const handleBreadcrumb = useCallback((idx: number) => {
    if (idx === 0) {
      setCurrentRoot(null);
      setCurrentRel("");
      void loadDir(null, "");
    } else if (idx === 1) {
      setCurrentRel("");
      void loadDir(currentRoot, "");
    } else {
      const segs = currentRel.split("/").filter(Boolean);
      const newRel = segs.slice(0, idx - 1).join("/");
      setCurrentRel(newRel);
      void loadDir(currentRoot, newRel);
    }
    // Selection persists across navigation (R4) — see handleDescend.
    setQuery("");
  }, [currentRoot, currentRel, loadDir]);

  const handleDragStart = useCallback((entry: FileEntry, e: React.DragEvent<HTMLDivElement>) => {
    if (entry.isDir || currentRoot === null) return;
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    e.dataTransfer.setData(VPS_FILE_DRAG_MIME, JSON.stringify({ root: currentRoot, rel }));
  }, [currentRoot, currentRel]);

  const refresh = useCallback(() => {
    if (currentRoot === null) {
      void loadRoots();
    } else {
      cacheRef.current.delete(cacheKey(currentRoot, currentRel));
      void loadDir(currentRoot, currentRel);
    }
  }, [currentRoot, currentRel, loadDir, loadRoots]);

  // Debounced recursive search scoped to the current folder (or all roots at Home).
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setSearchResults(null);
      setSearchTruncated(false);
      setSearchErrors([]);
      setSearchSelected([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      const run = async () => {
        let scopes: Array<{ label: string; rootKey: string; rel: string }>;
        if (currentRoot === null) {
          scopes = roots.map((r) => ({ label: r.label, rootKey: r.key, rel: "" }));
        } else {
          const rootEntry = roots.find((r) => r.key === currentRoot);
          scopes = [{ label: rootEntry?.label ?? currentRoot, rootKey: currentRoot, rel: currentRel }];
        }
        // Track per-scope errors instead of swallowing them into "no
        // matches" — the reviewer flagged the silent fallback as banned.
        type ScopeResult =
          | { ok: true; label: string; rootKey: string; entries: FileSearchEntry[]; truncated: boolean }
          | { ok: false; label: string; rootKey: string; message: string };
        const results: ScopeResult[] = await Promise.all(
          scopes.map(async (s): Promise<ScopeResult> => {
            try {
              const r = await searchFiles(s.rootKey, s.rel, q);
              return { ok: true, label: s.label, rootKey: s.rootKey, entries: r.entries, truncated: r.truncated };
            } catch (err) {
              return {
                ok: false,
                label: s.label,
                rootKey: s.rootKey,
                message: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );
        if (cancelled) return;
        const hits: SearchHit[] = results.flatMap((r) =>
          r.ok
            ? r.entries
                .filter((e) => !e.isDir)
                .map((e) => ({
                  name: e.name,
                  path: `/${r.label}/${e.path}`,
                  root: r.rootKey,
                  rel: e.path,
                  size: e.size,
                  mtime: e.mtime,
                }))
            : [],
        );
        setSearchResults(hits);
        setSearchTruncated(results.some((r) => r.ok && r.truncated));
        setSearchErrors(
          results.flatMap((r) => (r.ok ? [] : [{ label: r.label, message: r.message }])),
        );
        setSearching(false);
      };
      void run();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, currentRoot, currentRel, roots]);

  /** Compose the file's full rel from its containing dir + name. */
  const selectedFullRel = (sf: SelectedFile): string =>
    sf.parentRel ? `${sf.parentRel}/${sf.entry.name}` : sf.entry.name;

  const attachSelected = async () => {
    if (!onAttach) return;
    setAttaching(true);
    setActionError(null);
    try {
      if (isSearching) {
        for (const h of searchSelected) {
          const attached = await attachExistingFile(h.root, h.rel);
          onAttach(attached);
        }
      } else {
        for (const sf of selected) {
          if (sf.entry.isDir) continue;
          const attached = await attachExistingFile(sf.root, selectedFullRel(sf));
          onAttach(attached);
        }
      }
    } catch (err) {
      setActionError(
        `attach failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttaching(false);
    }
  };

  /** Resolve selection to absolute VPS paths and put them on the clipboard. */
  const copySelectedPaths = async () => {
    setActionError(null);
    let resolved: (UploadedFile | Error)[];
    if (isSearching) {
      if (searchSelected.length === 0) return;
      resolved = await Promise.all(
        searchSelected.map((h) =>
          attachExistingFile(h.root, h.rel).catch((e: unknown): Error =>
            e instanceof Error ? e : new Error(String(e)),
          ),
        ),
      );
    } else {
      const targets = selected.filter((sf) => !sf.entry.isDir);
      if (targets.length === 0) return;
      resolved = await Promise.all(
        targets.map((sf) =>
          attachExistingFile(sf.root, selectedFullRel(sf)).catch((e: unknown): Error =>
            e instanceof Error ? e : new Error(String(e)),
          ),
        ),
      );
    }
    const paths = resolved
      .filter((f): f is UploadedFile => !(f instanceof Error))
      .map((f) => f.path);
    const failures = resolved.filter((f): f is Error => f instanceof Error);
    if (paths.length === 0) {
      const first = failures[0]?.message ?? "unknown error";
      setActionError(
        `copy path failed: ${failures.length > 1 ? `${failures.length} paths failed — first: ${first}` : first}`,
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
    } catch (err) {
      setActionError(
        `copy path: clipboard write failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1500);
    // Partial success: some paths copied but others failed — surface the
    // failure alongside the success so the user knows the clipboard is
    // incomplete.
    if (failures.length > 0) {
      setActionError(
        `copy path: ${failures.length} of ${resolved.length} failed — first: ${failures[0]?.message ?? "unknown error"}`,
      );
    }
  };

  const isSearching = query.trim().length >= 2;
  const fileSelectionCount = isSearching
    ? searchSelected.length
    : selected.filter((sf) => !sf.entry.isDir).length;

  // Selection subset visible in the current directory — VaultFileList
  // renders the checkmark only for files it can actually see.
  const selectedInCurrentDir: FileEntry[] = selected
    .filter((sf) => sf.root === currentRoot && sf.parentRel === currentRel)
    .map((sf) => sf.entry);

  const currentRootLabel =
    currentRoot === null ? undefined : roots.find((r) => r.key === currentRoot)?.label;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            currentRoot === null ? "search the whole vault…" : "search this folder, recursively…"
          }
          className="mono"
          style={{
            flex: 1,
            fontSize: 11,
            color: tokens.text,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 6,
            padding: "5px 8px",
            outline: "none",
          }}
        />
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint, whiteSpace: "nowrap" }}>
          {fileSelectionCount} selected
        </span>
        <button
          disabled={fileSelectionCount === 0}
          onClick={() => void copySelectedPaths()}
          className="mono"
          style={{
            fontSize: 10.5,
            color: pathCopied ? tokens.ok : tokens.textLabel,
            background: tokens.bgGutter,
            border: `1px solid ${pathCopied ? tokens.ok : tokens.borderEmphasis}`,
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            opacity: fileSelectionCount === 0 ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {pathCopied ? "copied ✓" : "copy path"}
        </button>
        {onAttach && (
          <button
            disabled={attaching || fileSelectionCount === 0}
            onClick={() => void attachSelected()}
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              opacity: attaching ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {attaching ? "attaching…" : "attach"}
          </button>
        )}
      </div>
      <div
        className="mono"
        style={{
          padding: "5px 10px",
          fontSize: 9.5,
          color: tokens.textGhost,
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        {isSearching
          ? searching
            ? "searching…"
            : `${searchResults?.length ?? 0} match${searchResults?.length === 1 ? "" : "es"}${searchTruncated ? " (more exist — narrow the search)" : ""}${searchErrors.length > 0 ? ` — ${searchErrors.length} root${searchErrors.length === 1 ? "" : "s"} failed` : ""} — click to select`
          : `select a file, then copy path${onAttach ? " or attach" : ""} — or drag it onto the composer`}
      </div>
      {actionError && (
        <div
          className="mono"
          style={{
            padding: "5px 10px",
            fontSize: 10,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textLabel,
              background: "transparent",
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 4,
              padding: "1px 6px",
              cursor: "pointer",
            }}
          >
            dismiss
          </button>
        </div>
      )}
      {isSearching && searchErrors.length > 0 && (
        <div
          className="mono"
          style={{
            padding: "5px 10px",
            fontSize: 10,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          {searchErrors.map((e) => (
            <div key={e.label}>
              {e.label}: {e.message}
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: isSearching ? "auto" : undefined }}>
        {isSearching ? (
          <SearchResultsList
            results={searchResults ?? []}
            searching={searching}
            selected={searchSelected}
            onToggle={(h) =>
              setSearchSelected((prev) =>
                prev.some((s) => s.path === h.path)
                  ? prev.filter((s) => s.path !== h.path)
                  : [...prev, h],
              )
            }
          />
        ) : (
          <VaultFileList
            root={currentRoot}
            rootLabel={currentRootLabel}
            rel={currentRel}
            entries={entries}
            loading={loading}
            error={loadError}
            truncated={truncated}
            total={total}
            selected={selectedInCurrentDir}
            onDescend={handleDescend}
            onBreadcrumb={handleBreadcrumb}
            onToggleSelect={(entry) => {
              // Toggle qualified by current (root, parentRel) — otherwise
              // two files named "notes.md" in different sibling folders
              // would alias to a single selection.
              if (currentRoot === null) return;
              const key = selectionKey(currentRoot, currentRel, entry.name);
              setSelected((prev) => {
                const has = prev.some(
                  (s) => selectionKey(s.root, s.parentRel, s.entry.name) === key,
                );
                if (has) {
                  return prev.filter(
                    (s) => selectionKey(s.root, s.parentRel, s.entry.name) !== key,
                  );
                }
                return [...prev, { root: currentRoot, parentRel: currentRel, entry }];
              });
            }}
            onDragStart={handleDragStart}
            onRetry={refresh}
            revealName={reveal?.name}
            revealNonce={reveal?.nonce}
          />
        )}
      </div>
      {(() => {
        if (isSearching || selected.length !== 1) return null;
        const sel = selected[0];
        if (!sel || sel.entry.isDir) return null;
        const rel = selectedFullRel(sel);
        return (
          <div
            /* The line the chat reference carried, published for the browser
             * regression test and for anyone debugging why the preview did or
             * did not scroll. It is NOT the mechanism — see the TODO on
             * <FilePreview> below — but it is the only place the carried value
             * is observable until the preview workstream lands.
             *
             * ALWAYS EMITTED, "none" when there is no line. An omitted
             * attribute would make `[data-open-line]` mean two different
             * things at once — "no preview" and "a preview of a reference that
             * named no line" — and a test asserting the attribute is absent
             * would pass for the wrong reason. */
            data-open-line={sel.line === undefined ? "none" : String(sel.line)}
            style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                padding: "4px 10px",
                borderBottom: `1px solid ${tokens.borderSoft}`,
              }}
            >
              <a
                href={`/document?root=${encodeURIComponent(sel.root)}&path=${encodeURIComponent(rel)}`}
                target="_blank"
                rel="noreferrer"
                className="mono"
                title="Open in a separate tab"
                style={{
                  fontSize: 10.5,
                  color: tokens.textMuted,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  padding: "3px 8px",
                  textDecoration: "none",
                }}
              >
                open ↗
              </a>
            </div>
            <FilePreview root={sel.root} rel={rel} name={sel.entry.name} line={sel.line} />
          </div>
        );
      })()}
    </div>
  );
}

/** Search results span multiple roots and paths — rendered as a flat token-native
 *  list rather than through VaultFileList's directory-scoped view. Files only
 *  (dirs are filtered before this renders). */
function SearchResultsList({
  results,
  searching,
  selected,
  onToggle,
}: {
  results: SearchHit[];
  searching: boolean;
  selected: SearchHit[];
  onToggle: (h: SearchHit) => void;
}) {
  if (results.length === 0) {
    return (
      <div
        className="mono"
        style={{ padding: "48px 24px", fontSize: 11.5, color: tokens.textFaint, textAlign: "center" }}
      >
        {searching ? "searching…" : "no matches."}
      </div>
    );
  }
  return (
    <div>
      {results.map((h) => {
        const parts = h.path.split("/").filter(Boolean);
        const rootLabel = parts[0] ?? "";
        const dir = parts.slice(1, -1).join("/");
        const seld = selected.some((s) => s.path === h.path);
        return (
          <div
            key={h.path}
            onClick={() => onToggle(h)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              cursor: "pointer",
              borderBottom: `1px solid ${tokens.borderSoft}`,
              background: seld ? tokens.rowSelected : "transparent",
            }}
          >
            <span className="ms" style={{ fontSize: 15, color: tokens.textMuted }}>
              description
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: seld ? tokens.text : tokens.textLabel,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {h.name}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textGhost,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {rootLabel}
                {dir ? ` / ${dir}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const FileExplorerPanel = memo(FileExplorerPanelImpl);
