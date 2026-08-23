"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokens } from "../tokens";
import {
  fetchMemoryList,
  searchMemoryExpanded,
  TRIPLE_CATEGORIES,
  type MemoryCategory,
  type MemoryNote,
  type MemorySearchHitWithLane,
  type MemorySource,
  type TripleCategory,
} from "../api";
/* The phase-2 client. app/api.ts is deliberately NOT extended: every lane in
 * this project conflicts on it (02-architecture.md §0.3), and its getJson
 * discards the server's message body, which makes R24 unsatisfiable here. */
import {
  fetchMemoryCountsLabelled,
  fetchMemoryNoteV2,
  fetchVaultFile,
  saveVaultFile,
  VaultApiError,
  type VaultConflict,
} from "../api-vault";
import { MemoryGraph3D } from "./MemoryGraph3D";

/* v1.7 phase 4: lane viz. Vector hits and each graph hop get a distinct
 * colour so Konrad can SEE which lane / hop a result came from. */
const LANE_COLOR = (h: MemorySearchHitWithLane): string => {
  if (h.via === "vector") return tokens.ok;
  if (h.hop === 1) return tokens.warn;
  if (h.hop === 2) return tokens.decide;
  return tokens.stuck; // hop >= 3
};
const LANE_LABEL = (h: MemorySearchHitWithLane): string =>
  h.via === "vector" ? "vector" : `graph ${h.hop}-hop`;

const CATEGORY_COLOR: Record<MemoryCategory, string> = {
  rule: tokens.decide,
  pref: tokens.info,
  fact: tokens.textMuted,
  person: tokens.ok,
  project: tokens.accent,
  note: tokens.textSecondary,
};

/* ────────────────────────────────────────────────────────────────────────────
 * THE SEVEN CATEGORY CHIPS ARE GONE, and this is the reason, kept next to
 * their grave rather than in a commit message.
 *
 * They read `counts[c.key] ?? 0` against an envelope whose keys were per-
 * category totals from inferCategory(), which matches frontmatter tags named
 * rule/pref/person/project/fact. The vault's real tags are `recurring`,
 * `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope` — and only 65
 * of 284 notes carry any tag at all. Five of the six were STRUCTURALLY
 * incapable of a non-zero number, and a filter that always returns zero
 * teaches its operator that his vault is empty.
 *
 * B1c replaced them server-side with `folder_counts` + a `folder_rule` string
 * that states the derivation. This rail renders those instead: a real
 * partition of the vault, counted server-side over EVERY note rather than over
 * the 30 currently paged in, with the rule printed underneath.
 *
 * `inferCategory()` itself survives — listMemoryPage() still returns a per-note
 * `category`, and the list rows and the detail header still show it as a LABEL.
 * It is no longer a COUNT, because it could not compute one.
 * ──────────────────────────────────────────────────────────────────────────*/

/** Compact integers with a thin space so "3412 chunks" reads as a number. */
function n(value: number): string {
  return value.toLocaleString("en-US");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Wikilinks Preprocessing & Resolution
 * Handles [[Target]], [[Target|Alias]], [[Target#Heading]], [[#Heading]],
 * and table-escaped [[Target\|Alias]].
 * ──────────────────────────────────────────────────────────────────────────*/
function preprocessWikilinks(md: string): string {
  if (!md) return "";
  return md.replace(
    /(```[\s\S]*?```|`[^`\n]*`)|\[\[([\s\S]*?)\]\]/g,
    (match, codeBlock, wikilinkContent) => {
      if (codeBlock) return codeBlock;
      if (!wikilinkContent) return match;
      const raw = wikilinkContent.trim();
      let targetPart = raw;
      let labelPart = raw;
      if (raw.includes("\\|")) {
        const parts = raw.split("\\|");
        targetPart = parts[0].trim();
        labelPart = parts.slice(1).join("|").trim();
      } else if (raw.includes("|")) {
        const parts = raw.split("|");
        targetPart = parts[0].trim();
        labelPart = parts.slice(1).join("|").trim();
      }
      const cleanTarget = targetPart.replace(/\\+$/, "").trim();
      const cleanLabel = labelPart.replace(/\\+$/, "").trim();
      return `[${cleanLabel || cleanTarget}](wikilink://${encodeURIComponent(cleanTarget)})`;
    },
  );
}

function normalizeWikilinkTarget(raw: string): string {
  // Strip from first # anchor, strip trailing backslashes, strip .md, trim
  return raw
    .split("#")[0]
    .replace(/\\+$/, "")
    .replace(/\.md$/i, "")
    .trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Obsidian Callout Block Renderer
 * Supports > [!NOTE], > [!TIP], > [!WARNING], > [!IMPORTANT], > [!CAUTION]
 * ──────────────────────────────────────────────────────────────────────────*/
function CalloutBlock({ children }: { children?: React.ReactNode }) {
  let isCallout = false;
  let calloutType = "";
  let calloutTitle = "";
  let remainingChildren: React.ReactNode = children;

  const childArray = React.Children.toArray(children);
  if (childArray.length > 0) {
    const firstChild = childArray[0];
    if (
      React.isValidElement(firstChild) &&
      firstChild.props &&
      (firstChild.props as { children?: React.ReactNode }).children
    ) {
      const pChildren = React.Children.toArray(
        (firstChild.props as { children?: React.ReactNode }).children,
      );
      if (typeof pChildren[0] === "string") {
        const match = pChildren[0].match(/^\[!([A-Za-z0-9_-]+)\](?:\s+(.*))?/);
        if (match) {
          isCallout = true;
          calloutType = match[1].toUpperCase();
          calloutTitle = match[2] || calloutType;

          const restOfFirst = pChildren.slice(1);
          const firstPWithoutCallout =
            restOfFirst.length > 0 ? (
              <p key="p-0" style={{ margin: "4px 0 0 0" }}>
                {restOfFirst}
              </p>
            ) : null;

          remainingChildren = [
            firstPWithoutCallout,
            ...childArray.slice(1),
          ].filter(Boolean);
        }
      }
    }
  }

  if (isCallout) {
    let calloutColor = tokens.info;
    let calloutBg = "rgba(56, 189, 248, 0.08)";
    let calloutBorder = "rgba(56, 189, 248, 0.28)";
    let iconName = "info";

    if (["TIP", "HINT", "SUCCESS", "DONE", "CHECK"].includes(calloutType)) {
      calloutColor = tokens.ok;
      calloutBg = "rgba(34, 197, 94, 0.08)";
      calloutBorder = "rgba(34, 197, 94, 0.28)";
      iconName = "check_circle";
    } else if (["WARNING", "WARN", "ATTENTION"].includes(calloutType)) {
      calloutColor = tokens.warn;
      calloutBg = "rgba(245, 158, 11, 0.08)";
      calloutBorder = "rgba(245, 158, 11, 0.28)";
      iconName = "warning";
    } else if (
      ["IMPORTANT", "DECIDE", "KEY", "CRITICAL"].includes(calloutType)
    ) {
      calloutColor = tokens.decide;
      calloutBg = "rgba(168, 85, 247, 0.08)";
      calloutBorder = "rgba(168, 85, 247, 0.28)";
      iconName = "priority_high";
    } else if (
      ["CAUTION", "DANGER", "ERROR", "BUG", "FAILURE"].includes(calloutType)
    ) {
      calloutColor = tokens.stuck;
      calloutBg = "rgba(239, 68, 68, 0.08)";
      calloutBorder = "rgba(239, 68, 68, 0.28)";
      iconName = "report";
    }

    return (
      <div
        style={{
          margin: "12px 0",
          border: `1px solid ${calloutBorder}`,
          borderLeft: `4px solid ${calloutColor}`,
          borderRadius: 6,
          background: calloutBg,
          padding: "10px 14px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: calloutColor,
            fontWeight: 600,
            fontSize: 12.5,
            marginBottom:
              remainingChildren && React.Children.count(remainingChildren) > 0
                ? 6
                : 0,
          }}
        >
          <span className="ms" style={{ fontSize: 16, color: calloutColor }}>
            {iconName}
          </span>
          <span
            className="mono"
            style={{
              textTransform: "uppercase",
              fontSize: 11,
              letterSpacing: "0.06em",
            }}
          >
            {calloutTitle}
          </span>
        </div>
        {remainingChildren && (
          <div
            style={{ fontSize: 13, lineHeight: 1.6, color: tokens.textBody }}
          >
            {remainingChildren}
          </div>
        )}
      </div>
    );
  }

  return (
    <blockquote
      style={{
        borderLeft: `3px solid ${tokens.borderEmphasis}`,
        background: tokens.toolBg,
        padding: "10px 14px",
        borderRadius: "0 6px 6px 0",
        margin: "10px 0",
        color: tokens.textSecondary,
        fontStyle: "italic",
      }}
    >
      {children}
    </blockquote>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The editor's loaded-state. `content` and `sha256` are held TOGETHER in one
 * object and are only ever replaced together, so they cannot drift apart: the
 * hash must always be the hash of the bytes that were actually loaded, or the
 * compare-and-swap is theatre.
 *
 * The bytes come from GET /vault/file — the file on disk — NOT from the memory
 * note detail, whose `body` comes from an index and is not guaranteed
 * byte-identical.
 * ──────────────────────────────────────────────────────────────────────────*/
interface LoadedFile {
  content: string;
  sha256: string;
  bytes: number;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; sha256: string; bytes: number; snapshot: string }
  | { kind: "error"; status: number | null; message: string }
  | { kind: "conflict"; conflict: VaultConflict };

export function MemorySurface() {
  // Paged — the vault only grows, so a single unbounded fetch would slow to
  // a crawl eventually. Same "load more" pattern as the Chats rail.
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /** Vault-relative first path segment, or null for "every folder". Replaces
   *  the old `cat` filter — see the block comment above CATEGORY_COLOR. */
  const [folder, setFolder] = useState<string | null>(null);
  // "vault" = real notes from your Obsidian vault (indexed by the vault-sync
  // job). "agent" = status briefs your Hermes fleet workers write directly
  // to the DB — never real files. Kept as separate tabs so the two don't
  // read as one confusing, half-broken list.
  const [source, setSource] = useState<MemorySource>("vault");
  // A folder filter runs client-side over whatever page is loaded, so it needs
  // a bigger candidate pool than the 30-note default — otherwise picking a
  // folder would search only the newest 30 notes and mostly come up empty. The
  // chip's own count is server-side and vault-wide either way, and the list
  // header states how many of it are actually loaded.
  const effectiveLimit = folder === null ? visibleCount : 300;
  const listQ = useQuery({
    queryKey: ["memory", "list", source, effectiveLimit],
    queryFn: () => fetchMemoryList({ limit: effectiveLimit, source }),
  });
  const countsQ = useQuery({
    queryKey: ["memory", "counts-labelled", source],
    queryFn: () => fetchMemoryCountsLabelled(source),
  });
  const [selSlug, setSelSlug] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // v2.2: 3D luminescent net view of the knowledge graph.
  const [view, setView] = useState<"notes" | "graph">("notes");
  // v1.7 phase 4: search controls
  const [searchCategory, setSearchCategory] = useState<TripleCategory | null>(null);
  const [hops, setHops] = useState<number>(2);

  const allNotes = listQ.data?.notes ?? [];
  const folderOf = (vaultPath: string): string => {
    const cut = vaultPath.indexOf("/");
    return cut === -1 ? "(vault root)" : vaultPath.slice(0, cut);
  };
  const visibleNotes = useMemo(
    () =>
      folder === null
        ? allNotes
        : allNotes.filter((x) => folderOf(x.vault_path) === folder),
    [allNotes, folder],
  );

  const searchQ = useQuery({
    queryKey: ["memory", "search-expanded", q, hops, searchCategory],
    queryFn: () =>
      searchMemoryExpanded(q, {
        hops,
        category: searchCategory ?? undefined,
      }),
    enabled: q.length >= 2,
  });

  const slugInView = selSlug ?? visibleNotes[0]?.slug ?? null;
  const detailQ = useQuery({
    queryKey: ["memory", "note-v2", slugInView],
    queryFn: () => fetchMemoryNoteV2(slugInView!),
    enabled: !!slugInView,
  });
  const note = detailQ.data;

  /* ── editor state ─────────────────────────────────────────────────────── */
  const [editing, setEditing] = useState(false);
  const [showProperties, setShowProperties] = useState(true);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  /** Set when "Take theirs" replaced the draft, so his own text is never gone
   *  — R23 requires it to survive every path through this UI. */
  const [displaced, setDisplaced] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<
    { kind: "idle" } | { kind: "copied"; path: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Switching notes tears the whole editor down. Carrying a draft or a base
  // hash across notes would offer one note's bytes as another's base.
  useEffect(() => {
    setEditing(false);
    setLoaded(null);
    setDraft("");
    setSaveState({ kind: "idle" });
    setDisplaced(null);
    setCopyState({ kind: "idle" });
  }, [slugInView]);

  const isVaultNote = note?.source === "vault";
  const fileQ = useQuery({
    queryKey: ["vault", "file", note?.vault_path],
    queryFn: () => fetchVaultFile(note!.vault_path),
    enabled: editing && !!note && isVaultNote,
    // The bytes ARE the compare-and-swap base; a background refetch would swap
    // the base under an open editor.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Seed the editor exactly once per load. Guarded on `loaded === null` so a
  // re-render never overwrites what he has typed.
  useEffect(() => {
    if (!fileQ.data || loaded !== null) return;
    setLoaded({
      content: fileQ.data.content,
      sha256: fileQ.data.sha256,
      bytes: fileQ.data.bytes,
    });
    setDraft(fileQ.data.content);
  }, [fileQ.data, loaded]);

  const dirty = loaded !== null && draft !== loaded.content;

  function describeError(e: unknown): { status: number | null; message: string } {
    if (e instanceof VaultApiError) return { status: e.status, message: e.message };
    if (e instanceof Error) return { status: null, message: e.message };
    return { status: null, message: String(e) };
  }

  /** One PUT. `base` is passed in explicitly and is NEVER re-derived here —
   *  the only way to save against a newer base is Konrad clicking the labelled
   *  overwrite button, which passes it. */
  const put = useCallback(
    async (base: string, content: string) => {
      if (!note) return;
      setSaveState({ kind: "saving" });
      try {
        const r = await saveVaultFile({
          path: note.vault_path,
          content,
          base_sha256: base,
        });
        if (r.kind === "conflict") {
          setSaveState({ kind: "conflict", conflict: r.value });
          return;
        }
        // Adopt the server's hash as the new base so a second edit works without
        // a reload. The content we adopt is what we sent, which is what is now
        // on disk.
        setLoaded({ content, sha256: r.value.sha256, bytes: r.value.bytes });
        setDraft(content);
        setSaveState({
          kind: "saved",
          sha256: r.value.sha256,
          bytes: r.value.bytes,
          snapshot: r.value.snapshot,
        });
      } catch (e) {
        // NOT a catch-and-default: nothing is substituted, the failure becomes a
        // persistent visible state and the draft is untouched (R24).
        setSaveState({ kind: "error", ...describeError(e) });
      }
    },
    [note],
  );

  // Cmd+S / Ctrl+S keyboard shortcut to save in editor
  useEffect(() => {
    if (!editing || !isVaultNote || loaded === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && saveState.kind !== "saving") {
          void put(loaded.sha256, draft);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, isVaultNote, loaded, dirty, saveState.kind, draft, put]);

  // Clickable wikilinks resolver
  const handleWikilinkClick = useCallback(
    (rawTarget: string) => {
      const clean = normalizeWikilinkTarget(rawTarget);
      if (!clean) return;
      const cleanLower = clean.toLowerCase();
      const cleanBaseLower = (clean.split("/").pop() ?? clean).toLowerCase();

      // Find best match among loaded notes
      const match = allNotes.find((n) => {
        if (n.slug.toLowerCase() === cleanLower) return true;
        if (n.topic.toLowerCase() === cleanLower) return true;
        if (
          n.vault_path.toLowerCase() === cleanLower ||
          n.vault_path.toLowerCase() === `${cleanLower}.md`
        )
          return true;
        const noteBase = (n.topic.split("/").pop() ?? n.topic).toLowerCase();
        if (noteBase === cleanBaseLower) return true;
        const pathBase = (n.vault_path.split("/").pop() ?? n.vault_path)
          .replace(/\.md$/i, "")
          .toLowerCase();
        return pathBase === cleanBaseLower;
      });

      if (match) {
        setSelSlug(match.slug);
      } else {
        setSelSlug(clean);
      }
    },
    [allNotes],
  );

  async function copyPath(path: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(path);
      } else {
        // http on a LAN address is not a secure context, so the async clipboard
        // API is simply absent. The old synchronous path still works there.
        const ta = document.createElement("textarea");
        ta.value = path;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("document.execCommand('copy') returned false");
      }
      setCopyState({ kind: "copied", path });
    } catch (e) {
      setCopyState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const searchHits = searchQ.data?.hits ?? [];
  const laneCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const h of searchHits) {
      const k = h.via === "vector" ? "vector" : `${h.hop}h`;
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [searchHits]);

  const counts = countsQ.data;
  const folderRows = useMemo(() => {
    if (!counts) return [];
    return Object.entries(counts.folder_counts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [counts]);

  const railLabel = { fontSize: 9, color: tokens.textFaint, letterSpacing: "0.06em" };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Left rail — labelled counts + folder partition + sync state */}
      <div
        className="scroll"
        style={{
          width: 210,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "14px 10px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "0 4px 8px",
          }}
        >
          <span className="ms" style={{ fontSize: 14, color: tokens.decide }}>
            hub
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.textSecondary,
              letterSpacing: "0.04em",
            }}
          >
            {source === "vault" ? "Obsidian vault" : "Agent notes"}
          </span>
        </div>

        {/* ── THE COUNTS RAIL (R28, R29) ───────────────────────────────────
            Until 2026-08-19 this rendered `${counts.all ?? 0} notes`. B1c had
            correctly removed the bare `all` key from the API (R15), so against
            the current server it renders "0 notes" for a 284-note vault. That
            is Konrad's "it's zero and not eight", and it was reproducible in
            the source.

            Every figure below carries its UNIT and, where two sources exist,
            its SOURCE. There is no `?? 0` anywhere: loading says loading, a
            failure says what failed. Neither renders a number. */}
        <div style={{ padding: "0 4px 10px" }}>
          {countsQ.isLoading && (
            <div className="mono" style={railLabel}>
              loading counts…
            </div>
          )}
          {countsQ.isError && (
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.stuck,
                lineHeight: 1.5,
                border: `1px solid ${tokens.dangerActionBorder}`,
                background: tokens.dangerActionBg,
                borderRadius: 5,
                padding: "6px 7px",
              }}
            >
              counts unavailable —{" "}
              {countsQ.error instanceof Error
                ? countsQ.error.message
                : String(countsQ.error)}
            </div>
          )}
          {counts && (
            <div
              className="mono"
              style={{ fontSize: 9.5, lineHeight: 1.75, color: tokens.textMuted }}
            >
              {/* R29: BOTH figures render at once, whichever tab is selected.
                  The split is the honest presentation — 284 files he wrote,
                  198 briefs a worker wrote — and the tabs below filter it. */}
              <div>
                <span style={{ color: tokens.textHi }}>
                  {n(counts.vault_notes_indexed)}
                </span>{" "}
                vault notes indexed
              </div>
              <div>
                <span style={{ color: tokens.textHi }}>
                  {n(counts.agent_notes)}
                </span>{" "}
                agent briefs (no file on disk)
              </div>
              <div style={{ color: tokens.textFaint }}>
                {n(counts.vault_files_on_disk)} .md files on disk
              </div>
              <div style={{ color: tokens.textFaint }}>
                {n(counts.embedded_files)} files embedded ·{" "}
                {n(counts.embedded_chunks)} chunks embedded
              </div>
              <div style={{ color: tokens.textFaint }}>
                excluded: {n(counts.excluded.excalidraw)} excalidraw ·{" "}
                {n(counts.excluded.empty)} empty ·{" "}
                {n(counts.excluded.frontmatter_only)} frontmatter-only
              </div>
              <div style={{ color: tokens.textFaint }}>
                {n(counts.stale_embedding_rows)} stale embedding rows
              </div>
              <div style={{ color: tokens.textGhost, marginTop: 3 }}>
                measured at {counts.measured_at}
              </div>
            </div>
          )}
        </div>

        {/* Real vault files vs Hermes fleet-worker status briefs — clarified copy */}
        <div style={{ display: "flex", gap: 4, padding: "0 4px 4px" }}>
          {(["vault", "agent"] as const).map((s) => (
            <div
              key={s}
              onClick={() => {
                setSource(s);
                setSelSlug(null);
                setFolder(null);
              }}
              className="mono"
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 10,
                padding: "6px 0",
                borderRadius: 5,
                cursor: "pointer",
                fontWeight: source === s ? 600 : 400,
                color: source === s ? tokens.text : tokens.textFaint,
                background: source === s ? tokens.selectedBg : "transparent",
                border: `1px solid ${source === s ? tokens.borderEmphasis : "transparent"}`,
              }}
            >
              {s === "vault" ? "Obsidian Vault" : "Agent Briefs"}
            </div>
          ))}
        </div>
        <div
          className="mono"
          style={{ ...railLabel, padding: "0 4px 10px", lineHeight: 1.5 }}
        >
          {source === "vault"
            ? "Obsidian notes on disk (/opt/obsidian-vault) — editable markdown & wikilinks"
            : "Worker memories written directly to DB by Hermes fleet workers (read-only briefs)"}
        </div>

        {/* folder partition — replaces the seven category chips */}
        <div
          className="mono"
          style={{ ...railLabel, padding: "0 4px 6px", letterSpacing: "0.1em" }}
        >
          BY FOLDER
        </div>
        {counts && (
          <div
            onClick={() => setFolder(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 6,
              cursor: "pointer",
              background: folder === null ? tokens.selectedBg : "transparent",
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: folder === null ? tokens.text : tokens.textSecondary,
                flex: 1,
              }}
            >
              Every folder
            </span>
            <span
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textFaint }}
            >
              {n(folderRows.reduce((s, [, v]) => s + v, 0))} notes
            </span>
          </div>
        )}
        {folderRows.map(([name, total]) => {
          const seld = folder === name;
          return (
            <div
              key={name}
              onClick={() => setFolder(seld ? null : name)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 6,
                cursor: "pointer",
                background: seld ? tokens.selectedBg : "transparent",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: seld ? tokens.text : tokens.textSecondary,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={name}
              >
                {name}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: seld ? tokens.textMuted : tokens.textFaint,
                }}
              >
                {n(total)} notes
              </span>
            </div>
          );
        })}
        {counts && (
          <div
            className="mono"
            style={{
              fontSize: 8.5,
              color: tokens.textGhost,
              lineHeight: 1.6,
              padding: "8px 4px 0",
            }}
          >
            {counts.folder_rule}
          </div>
        )}

        {/* v2.2: view toggle — note reader vs 3D net */}
        <div
          onClick={() => setView(view === "graph" ? "notes" : "graph")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 12px",
            marginTop: 10,
            borderRadius: 6,
            cursor: "pointer",
            border: `1px solid ${view === "graph" ? tokens.accent : tokens.borderSoft}`,
            background: view === "graph" ? tokens.primaryActionBg : "transparent",
          }}
        >
          <span
            className="ms"
            style={{
              fontSize: 14,
              color: view === "graph" ? tokens.accent : tokens.textFaint,
            }}
          >
            graph_3
          </span>
          <span
            style={{
              fontSize: 12.5,
              color: view === "graph" ? tokens.text : tokens.textSecondary,
            }}
          >
            3D net
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 8 }} />
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textGhost,
            lineHeight: 1.7,
            padding: "0 4px",
          }}
        >
          read/write brain
          <br />
          linked-from [[graph]]
          <br />
          stale detection on
        </div>
      </div>

      {view === "graph" ? (
        <MemoryGraph3D
          onSelectNote={(slug) => {
            setSelSlug(slug);
            setView("notes");
          }}
        />
      ) : (
        <>
      {/* Middle column — note list with search */}
      <div
        style={{
          width: 340,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "12px 15px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}>
            Memory
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
            {n(visibleNotes.length)} notes loaded
          </span>
          <span style={{ flex: 1 }} />
        </div>
        {folder !== null && (
          <div
            className="mono"
            style={{
              flex: "none",
              fontSize: 9.5,
              color: tokens.textFaint,
              padding: "7px 15px",
              borderBottom: `1px solid ${tokens.borderDivider}`,
              lineHeight: 1.5,
            }}
          >
            folder “{folder}” · {n(visibleNotes.length)} notes loaded of{" "}
            {counts ? `${n(counts.folder_counts[folder])} notes in this folder` : "an unknown total (counts unavailable)"}
          </div>
        )}
        <div
          style={{
            flex: "none",
            padding: "10px 12px",
            borderBottom: `1px solid ${tokens.borderSoft}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="ms"
              style={{ fontSize: 14, color: tokens.textFaint }}
            >
              search
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="semantic search the vault…"
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
            {q && (
              <span
                onClick={() => setQ("")}
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.textFaint,
                  cursor: "pointer",
                }}
              >
                ✕
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {q.length >= 2 ? (
            <>
              {/* v1.7 phase 4: lane-viz controls — hop slider + category chips */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px 6px",
                  borderBottom: `1px solid ${tokens.borderDivider}`,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: tokens.textFaint,
                    letterSpacing: "0.08em",
                  }}
                >
                  HOPS
                </span>
                {[0, 1, 2, 3].map((h) => (
                  <span
                    key={h}
                    onClick={() => setHops(h)}
                    className="mono"
                    style={{
                      cursor: "pointer",
                      fontSize: 10,
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: hops === h ? tokens.primaryActionBg : "transparent",
                      color: hops === h ? tokens.textHi : tokens.textMuted,
                      border: `1px solid ${hops === h ? tokens.accent : tokens.borderSoft}`,
                    }}
                  >
                    {h} hops
                  </span>
                ))}
              </div>
              {/* v1.9: reframed from "filter" to "lens". The category arg
                  affects only the 6-slot graph budget; the 12-slot vector
                  seed always survives, so at most 33% of result slots rotate.
                  See docs/ai-os-v17/multihop-bench.md for the bench finding. */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 14px 10px",
                  borderBottom: `1px solid ${tokens.borderDivider}`,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: tokens.textFaint,
                    letterSpacing: "0.08em",
                    marginRight: 4,
                  }}
                >
                  LENS
                </span>
                <span
                  onClick={() => setSearchCategory(null)}
                  className="mono"
                  style={{
                    cursor: "pointer",
                    fontSize: 9.5,
                    padding: "2px 7px",
                    borderRadius: 4,
                    background: !searchCategory ? tokens.primaryActionBg : "transparent",
                    color: !searchCategory ? tokens.textHi : tokens.textMuted,
                    border: `1px solid ${!searchCategory ? tokens.accent : tokens.borderSoft}`,
                  }}
                >
                  off
                </span>
                {TRIPLE_CATEGORIES.map((c) => {
                  const sparse = c === "decision" || c === "rule";
                  return (
                    <span
                      key={c}
                      onClick={() => setSearchCategory(c === searchCategory ? null : c)}
                      title={
                        sparse
                          ? `${c} has few triples — graph budget often won't fill`
                          : undefined
                      }
                      className="mono"
                      style={{
                        cursor: "pointer",
                        fontSize: 9.5,
                        padding: "2px 7px",
                        borderRadius: 4,
                        background: searchCategory === c ? tokens.primaryActionBg : "transparent",
                        color: searchCategory === c ? tokens.textHi : tokens.textMuted,
                        border: `1px solid ${searchCategory === c ? tokens.accent : tokens.borderSoft}`,
                        opacity: sparse && searchCategory !== c ? 0.65 : 1,
                      }}
                    >
                      {c}
                      {sparse && (
                        <span style={{ color: tokens.warn, marginLeft: 3 }}>·</span>
                      )}
                    </span>
                  );
                })}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  letterSpacing: "0.1em",
                  padding: "10px 15px 4px",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span>HITS · {n(searchHits.length)} results</span>
                {Object.entries(laneCounts).map(([k, v]) => (
                  <span key={k} style={{ color: tokens.textMuted }}>
                    · {k}={n(v)} hits
                  </span>
                ))}
              </div>
              {searchQ.isLoading && (
                <div
                  className="mono"
                  style={{
                    padding: "20px 16px",
                    color: tokens.textFaint,
                    fontSize: 11,
                  }}
                >
                  searching…
                </div>
              )}
              {searchHits.map((h) => {
                const laneColor = LANE_COLOR(h);
                const isDrawing =
                  h.vault_path.endsWith(".excalidraw.md") || !!h.is_drawing;
                const isEmpty = !!h.is_empty || h.match_type === "empty";

                // Determine match badge label and color
                let badgeLabel = "VECTOR";
                let badgeColor = tokens.ok;

                if (
                  h.match_type === "exact_title" ||
                  (q && h.title.toLowerCase() === q.toLowerCase())
                ) {
                  badgeLabel = "EXACT TITLE";
                  badgeColor = tokens.ok;
                } else if (
                  h.match_type === "title_match" ||
                  h.via === "title"
                ) {
                  badgeLabel = "TITLE MATCH";
                  badgeColor = tokens.accent;
                } else if (h.match_type === "tag_match" || h.via === "tag") {
                  badgeLabel = "TAG MATCH";
                  badgeColor = tokens.info;
                } else if (isEmpty) {
                  badgeLabel = "EMPTY NOTE";
                  badgeColor = tokens.warn;
                } else if (isDrawing) {
                  badgeLabel = "DRAWING";
                  badgeColor = tokens.decide;
                } else if (h.via === "graph") {
                  badgeLabel = `GRAPH ${h.hop}-HOP`;
                  badgeColor = tokens.warn;
                }

                return (
                  <div
                    key={`${h.slug}_${h.chunk_index}_${h.hop ?? 0}`}
                    onClick={() => {
                      setSelSlug(h.slug);
                      setQ("");
                    }}
                    style={{
                      padding: "11px 14px",
                      cursor: "pointer",
                      borderBottom: `1px solid ${tokens.borderDivider}`,
                      borderLeft: `3px solid ${badgeColor}`,
                      background:
                        h.slug === slugInView
                          ? tokens.selectedBg
                          : "transparent",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12.5,
                          color: tokens.textLabel,
                          lineHeight: 1.4,
                          fontWeight:
                            badgeLabel === "EXACT TITLE" ? 600 : 400,
                        }}
                      >
                        {h.title}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        className="mono"
                        style={{
                          fontSize: 8.5,
                          color: badgeColor,
                          letterSpacing: "0.06em",
                          border: `1px solid ${badgeColor}`,
                          borderRadius: 3,
                          padding: "1px 5px",
                        }}
                      >
                        {badgeLabel}
                      </span>
                      {isDrawing && (
                        <span
                          className="mono"
                          style={{
                            fontSize: 8.5,
                            color: tokens.info,
                            letterSpacing: "0.06em",
                            border: `1px solid ${tokens.info}`,
                            borderRadius: 3,
                            padding: "1px 5px",
                          }}
                        >
                          CANVAS
                        </span>
                      )}
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: laneColor }}
                      >
                        score {h.score.toFixed(2)}
                      </span>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: isEmpty ? tokens.warn : tokens.textFaint,
                        marginTop: 4,
                        lineHeight: 1.4,
                        fontStyle: isEmpty ? "italic" : "normal",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {isEmpty
                        ? "(empty note — 0 bytes on disk)"
                        : h.match_reason
                          ? `${h.match_reason} · ${h.snippet}`
                          : h.snippet}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            visibleNotes.map((x: MemoryNote) => {
              const seld = x.slug === slugInView;
              const color = CATEGORY_COLOR[x.category];
              return (
                <div
                  key={x.slug}
                  onClick={() => setSelSlug(x.slug)}
                  style={{
                    padding: "11px 14px",
                    cursor: "pointer",
                    borderBottom: `1px solid ${tokens.borderDivider}`,
                    borderLeft: `2px solid ${seld ? color : "transparent"}`,
                    background: seld ? tokens.selectedBg : "transparent",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      marginBottom: 5,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 8.5,
                        color,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                      }}
                    >
                      {x.category}
                    </span>
                    <span style={{ flex: 1 }} />
                    {x.source === "agent" && (
                      <span
                        className="mono"
                        style={{ fontSize: 8.5, color: tokens.textGhost }}
                      >
                        {x.created_by}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: seld ? tokens.text : tokens.textLabel,
                      lineHeight: 1.42,
                    }}
                  >
                    {x.topic}
                  </div>
                  {x.tags.length > 0 && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: tokens.textFaint,
                        marginTop: 5,
                      }}
                    >
                      {x.tags.slice(0, 4).join(" · ")}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {q.length < 2 && folder === null && listQ.data?.hasMore && (
            <div
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
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
          {!listQ.isLoading && visibleNotes.length === 0 && q.length < 2 && (
            <div
              className="mono"
              style={{
                padding: "48px 24px",
                fontSize: 11.5,
                color: tokens.textFaint,
                textAlign: "center",
              }}
            >
              {folder === null
                ? source === "vault"
                  ? "no vault notes loaded."
                  : "no agent notes loaded."
                : `no loaded note is in “${folder}”.`}
            </div>
          )}
        </div>
      </div>

      {/* Right column — detail + editor */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {note ? (
          <div
            className="slidein"
            style={{ maxWidth: 680, padding: "24px 30px 48px" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: CATEGORY_COLOR[note.category],
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                {note.category}
              </span>
              <span style={{ flex: 1 }} />
              {/* Read / Edit Switcher */}
              {isVaultNote && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    background: tokens.toolBg,
                    border: `1px solid ${tokens.borderSoft}`,
                    borderRadius: 6,
                    padding: 2,
                    gap: 2,
                  }}
                >
                  <div
                    onClick={() => {
                      if (editing && dirty) return; // never discard his text
                      setEditing(false);
                    }}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: "3px 10px",
                      borderRadius: 4,
                      cursor: editing && dirty ? "not-allowed" : "pointer",
                      color: !editing ? tokens.textHi : tokens.textMuted,
                      background: !editing ? tokens.selectedBg : "transparent",
                      border: `1px solid ${!editing ? tokens.borderEmphasis : "transparent"}`,
                    }}
                    title={
                      editing && dirty
                        ? "save or revert first — closing would discard your text"
                        : undefined
                    }
                  >
                    👁 Read
                  </div>
                  <div
                    onClick={() => setEditing(true)}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: "3px 10px",
                      borderRadius: 4,
                      cursor: "pointer",
                      color: editing ? tokens.textHi : tokens.textMuted,
                      background: editing ? tokens.selectedBg : "transparent",
                      border: `1px solid ${editing ? tokens.borderEmphasis : "transparent"}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <span>✏️ Edit</span>
                    {dirty && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: tokens.warn,
                          display: "inline-block",
                        }}
                        title="Unsaved changes"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                fontSize: 21,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                color: tokens.textHi,
                lineHeight: 1.34,
                marginBottom: 8,
              }}
            >
              {note.topic}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              <span
                className="ms"
                style={{ fontSize: 13, color: tokens.decide }}
              >
                description
              </span>
              <span
                className="mono"
                style={{ fontSize: 10.5, color: tokens.textMuted }}
              >
                {note.source === "vault" ? "Vault" : "Agent"} › {note.vault_path}
              </span>
              <span
                className="mono"
                style={{ fontSize: 10, color: tokens.textGhost }}
              >
                · {n(note.word_count)} words
              </span>
              <span style={{ flex: 1 }} />

              {/* ── R25/R26/R27 ─────────────────────────────────────────────
                  Obsidian URI & Copy path fallback */}
              {note.obsidian_uri !== null && (
                <a
                  href={note.obsidian_uri}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    textDecoration: "none",
                    border: `1px solid ${tokens.invariantBorder}`,
                    borderRadius: 6,
                    padding: "4px 9px",
                    background: tokens.invariantBg,
                  }}
                >
                  <span
                    className="ms"
                    style={{ fontSize: 13, color: tokens.decide }}
                  >
                    open_in_new
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: tokens.decide }}
                  >
                    Open in Obsidian
                  </span>
                </a>
              )}

              {/* R27 — the fallback */}
              {isVaultNote && (
                <span
                  onClick={() => void copyPath(note.vault_path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                    border: `1px solid ${tokens.borderEmphasis}`,
                    borderRadius: 6,
                    padding: "4px 9px",
                  }}
                >
                  <span
                    className="ms"
                    style={{ fontSize: 13, color: tokens.textMuted }}
                  >
                    content_copy
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: tokens.textMuted }}
                  >
                    Copy vault path
                  </span>
                </span>
              )}
            </div>

            {/* R26 — THE PRECONDITION */}
            {isVaultNote && (
              <div
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  lineHeight: 1.6,
                  marginBottom: 14,
                }}
              >
                Open in Obsidian only works on a machine running Obsidian with a
                vault named “{note.vault_name}” — this server does not run
                Obsidian. If it does nothing, use Copy vault path instead.
              </div>
            )}

            {copyState.kind === "copied" && (
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.ok,
                  marginBottom: 14,
                }}
              >
                copied to clipboard: {copyState.path}
              </div>
            )}
            {copyState.kind === "error" && (
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.stuck,
                  marginBottom: 14,
                  lineHeight: 1.5,
                }}
              >
                could not copy — {copyState.message}. The path is{" "}
                {note.vault_path}
              </div>
            )}

            {/* Agent briefs info banner */}
            {!isVaultNote && (
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: tokens.warn,
                  lineHeight: 1.6,
                  marginBottom: 16,
                  border: `1px solid ${tokens.borderSoft}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                }}
              >
                Read-only: this is an agent brief written straight to the
                database by {note.created_by}. Its path is a self-declared
                label, not a file on disk — there is nothing to open in Obsidian
                and nothing to save.
              </div>
            )}

            {/* ── Obsidian Properties Inspector Card ────────────────────── */}
            <div
              style={{
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 18,
              }}
            >
              <div
                onClick={() => setShowProperties(!showProperties)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span
                  className="ms"
                  style={{
                    fontSize: 14,
                    color: tokens.textMuted,
                    transform: showProperties ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.15s ease",
                  }}
                >
                  chevron_right
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: tokens.textFaint,
                    fontWeight: 600,
                  }}
                >
                  Properties (
                  {Object.keys(note.frontmatter || {}).length +
                    (note.tags && note.tags.length > 0 ? 1 : 0) +
                    1}
                  )
                </span>
                <span style={{ flex: 1 }} />
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: CATEGORY_COLOR[note.category],
                    background: "rgba(var(--v2-accent-rgb, 140, 100, 255), 0.08)",
                    padding: "1px 6px",
                    borderRadius: 4,
                    border: `1px solid ${tokens.borderSoft}`,
                  }}
                >
                  {note.category}
                </span>
              </div>

              {showProperties && (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {/* Category / Type */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 10,
                      fontSize: 11.5,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        width: 90,
                        flexShrink: 0,
                        color: tokens.textFaint,
                        fontSize: 10,
                      }}
                    >
                      type
                    </span>
                    <span
                      className="mono"
                      style={{
                        color: CATEGORY_COLOR[note.category],
                        fontSize: 11,
                      }}
                    >
                      {note.category}
                    </span>
                  </div>

                  {/* Tags */}
                  {note.tags && note.tags.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 10,
                        fontSize: 11.5,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          width: 90,
                          flexShrink: 0,
                          color: tokens.textFaint,
                          fontSize: 10,
                        }}
                      >
                        tags
                      </span>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 5,
                          flex: 1,
                        }}
                      >
                        {note.tags.map((t, idx) => (
                          <span
                            key={idx}
                            onClick={(e) => {
                              e.stopPropagation();
                              const tagClean = t.replace(/^#/, "");
                              setQ(tagClean);
                            }}
                            title="Click to search tag"
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: tokens.info,
                              background: "#0a1316",
                              border: "1px solid #16323a",
                              borderRadius: 4,
                              padding: "2px 7px",
                              cursor: "pointer",
                            }}
                          >
                            #{t.replace(/^#/, "")}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dynamic Frontmatter Properties */}
                  {note.frontmatter &&
                    Object.entries(note.frontmatter).map(([k, v]) => {
                      if (k === "tags") return null;
                      const displayVal =
                        typeof v === "object" && v !== null
                          ? JSON.stringify(v)
                          : String(v);
                      return (
                        <div
                          key={k}
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 10,
                            fontSize: 11.5,
                          }}
                        >
                          <span
                            className="mono"
                            style={{
                              width: 90,
                              flexShrink: 0,
                              color: tokens.textFaint,
                              fontSize: 10,
                            }}
                          >
                            {k}
                          </span>
                          <span
                            className="mono"
                            style={{
                              color: tokens.textLabel,
                              flex: 1,
                              wordBreak: "break-all",
                            }}
                          >
                            {displayVal}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* ── BODY: reader, or the editor ─────────────────────────────── */}
            {editing && isVaultNote ? (
              <div style={{ marginBottom: 22 }}>
                {fileQ.isLoading && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: tokens.textFaint,
                      padding: "18px 0",
                    }}
                  >
                    reading the file from disk…
                  </div>
                )}
                {fileQ.isError && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: tokens.stuck,
                      lineHeight: 1.6,
                      border: `1px solid ${tokens.dangerActionBorder}`,
                      background: tokens.dangerActionBg,
                      borderRadius: 8,
                      padding: "12px 14px",
                    }}
                  >
                    could not read the file, so there is no base hash and
                    nothing may be saved —{" "}
                    {fileQ.error instanceof Error
                      ? fileQ.error.message
                      : String(fileQ.error)}
                  </div>
                )}
                {loaded !== null && (
                  <>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      className="mono"
                      style={{
                        width: "100%",
                        minHeight: 440,
                        resize: "vertical",
                        background: tokens.inputBg,
                        border: `1px solid ${dirty ? tokens.accent : tokens.border}`,
                        borderRadius: 8,
                        padding: "14px 16px",
                        color: tokens.textLabel,
                        fontSize: 12.5,
                        lineHeight: 1.7,
                        outline: "none",
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginTop: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        onClick={() => {
                          if (!dirty || saveState.kind === "saving") return;
                          void put(loaded.sha256, draft);
                        }}
                        className="mono"
                        style={{
                          fontSize: 11,
                          padding: "6px 14px",
                          borderRadius: 6,
                          cursor:
                            dirty && saveState.kind !== "saving"
                              ? "pointer"
                              : "not-allowed",
                          color: dirty ? tokens.textHi : tokens.textFaint,
                          background: dirty ? tokens.okActionBg : "transparent",
                          border: `1px solid ${dirty ? tokens.okActionBorder : tokens.borderSoft}`,
                        }}
                      >
                        {saveState.kind === "saving"
                          ? "saving…"
                          : "Save to vault"}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: tokens.textFaint }}
                      >
                        {dirty ? "unsaved changes" : "no unsaved changes"} ·{" "}
                        {n(draft.length)} characters ·{" "}
                        {n(draft.split(/\s+/).filter(Boolean).length)} words ·{" "}
                        base sha256 {loaded.sha256.slice(0, 12)}… ·{" "}
                        <span style={{ color: tokens.textMuted }}>
                          (Cmd+S / Ctrl+S)
                        </span>
                      </span>
                      {displaced !== null && (
                        <span
                          onClick={() => {
                            setDraft(displaced);
                            setDisplaced(null);
                          }}
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: tokens.warn,
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                        >
                          restore my discarded version ({n(displaced.length)}{" "}
                          characters)
                        </span>
                      )}
                    </div>

                    {saveState.kind === "saved" && (
                      <div
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: tokens.ok,
                          marginTop: 10,
                          lineHeight: 1.6,
                        }}
                      >
                        saved · {n(saveState.bytes)} bytes on disk · new sha256{" "}
                        {saveState.sha256.slice(0, 12)}… · previous version kept
                        at {saveState.snapshot}
                      </div>
                    )}

                    {/* ── R24: LOUD AND PERSISTENT ──────────────────────────── */}
                    {saveState.kind === "error" && (
                      <div
                        style={{
                          marginTop: 12,
                          border: `1px solid ${tokens.dangerActionBorder}`,
                          background: tokens.dangerActionBg,
                          borderRadius: 8,
                          padding: "12px 14px",
                        }}
                      >
                        <div
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: tokens.stuck,
                            letterSpacing: "0.08em",
                            marginBottom: 6,
                          }}
                        >
                          SAVE FAILED
                          {saveState.status === null
                            ? " — no HTTP status (the request never completed)"
                            : ` — HTTP ${saveState.status}`}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: tokens.textLabel,
                            lineHeight: 1.6,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {saveState.message}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: tokens.textFaint,
                            marginTop: 8,
                          }}
                        >
                          Nothing was written. Your unsaved text is still in the
                          editor above.
                        </div>
                      </div>
                    )}

                    {/* ── R23: THE CONFLICT ─────────────────────────────────── */}
                    {saveState.kind === "conflict" && (
                      <div
                        style={{
                          marginTop: 12,
                          border: `1px solid ${tokens.dangerActionBorder}`,
                          background: tokens.dangerActionBg,
                          borderRadius: 8,
                          padding: "14px 16px",
                        }}
                      >
                        <div
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: tokens.warn,
                            letterSpacing: "0.08em",
                            marginBottom: 6,
                          }}
                        >
                          CONFLICT — HTTP 409. NOTHING HAS BEEN WRITTEN.
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            color: tokens.textLabel,
                            lineHeight: 1.6,
                            marginBottom: 4,
                          }}
                        >
                          {saveState.conflict.error}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: tokens.textFaint,
                            lineHeight: 1.6,
                            marginBottom: 12,
                          }}
                        >
                          The file changed on disk after you opened it —
                          something else (an agent, the vault-sync tick, another
                          tab) wrote it. Your base sha256 was{" "}
                          {loaded.sha256.slice(0, 12)}…; the version on disk is{" "}
                          {saveState.conflict.current_sha256.slice(0, 12)}… at{" "}
                          {n(saveState.conflict.current_bytes)} bytes. Choose
                          below — nothing happens until you do.
                        </div>

                        <div
                          className="mono"
                          style={{
                            fontSize: 9,
                            color: tokens.accent,
                            letterSpacing: "0.1em",
                            marginBottom: 5,
                          }}
                        >
                          YOUR UNSAVED VERSION · {n(draft.length)} characters
                        </div>
                        <pre
                          className="scroll"
                          style={{
                            fontFamily: "inherit",
                            fontSize: 11,
                            color: tokens.textLabel,
                            background: tokens.toolBg,
                            border: `1px solid ${tokens.borderSoft}`,
                            borderRadius: 6,
                            padding: "10px 12px",
                            margin: 0,
                            maxHeight: 220,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {draft}
                        </pre>

                        <div
                          className="mono"
                          style={{
                            fontSize: 9,
                            color: tokens.warn,
                            letterSpacing: "0.1em",
                            margin: "12px 0 5px",
                          }}
                        >
                          THE VERSION NOW ON DISK ·{" "}
                          {n(saveState.conflict.current_bytes)} bytes
                          {saveState.conflict.current_content_truncated
                            ? " · SHOWN TRUNCATED"
                            : ""}
                        </div>
                        <pre
                          className="scroll"
                          style={{
                            fontFamily: "inherit",
                            fontSize: 11,
                            color: tokens.textLabel,
                            background: tokens.toolBg,
                            border: `1px solid ${tokens.borderSoft}`,
                            borderRadius: 6,
                            padding: "10px 12px",
                            margin: 0,
                            maxHeight: 220,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {saveState.conflict.current_content}
                        </pre>

                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginTop: 14,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            onClick={() =>
                              void put(
                                saveState.conflict.current_sha256,
                                draft,
                              )
                            }
                            className="mono"
                            style={{
                              fontSize: 10.5,
                              padding: "6px 12px",
                              borderRadius: 6,
                              cursor: "pointer",
                              color: tokens.textHi,
                              background: tokens.dangerActionBg,
                              border: `1px solid ${tokens.dangerActionBorder}`,
                            }}
                          >
                            Keep mine — overwrite the{" "}
                            {n(saveState.conflict.current_bytes)} bytes now on
                            disk
                          </span>
                          {saveState.conflict.current_content_truncated ? (
                            <span
                              className="mono"
                              style={{
                                fontSize: 10.5,
                                padding: "6px 12px",
                                borderRadius: 6,
                                cursor: "not-allowed",
                                color: tokens.textFaint,
                                border: `1px solid ${tokens.borderSoft}`,
                              }}
                              title="the on-disk version was truncated for transport"
                            >
                              Take theirs — unavailable, the copy above is
                              truncated
                            </span>
                          ) : (
                            <span
                              onClick={() => {
                                setDisplaced(draft);
                                setDraft(saveState.conflict.current_content);
                                setLoaded({
                                  content: saveState.conflict.current_content,
                                  sha256: saveState.conflict.current_sha256,
                                  bytes: saveState.conflict.current_bytes,
                                });
                                setSaveState({ kind: "idle" });
                              }}
                              className="mono"
                              style={{
                                fontSize: 10.5,
                                padding: "6px 12px",
                                borderRadius: 6,
                                cursor: "pointer",
                                color: tokens.textHi,
                                background: tokens.primaryActionBg,
                                border: `1px solid ${tokens.borderEmphasis}`,
                              }}
                            >
                              Take theirs — load the disk version into the
                              editor
                            </span>
                          )}
                          <span
                            onClick={() => setSaveState({ kind: "idle" })}
                            className="mono"
                            style={{
                              fontSize: 10.5,
                              padding: "6px 12px",
                              borderRadius: 6,
                              cursor: "pointer",
                              color: tokens.textMuted,
                              border: `1px solid ${tokens.borderSoft}`,
                            }}
                          >
                            Cancel and keep editing
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              /* ── RICH MARKDOWN READER (ReactMarkdown + remarkGfm + Wikilinks + Callouts) ── */
              <div
                style={{
                  background: tokens.bgCard,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  padding: "20px 22px",
                  marginBottom: 22,
                  color: tokens.textBody,
                }}
              >
                {note.body ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children, ...props }) => {
                        if (href?.startsWith("wikilink://")) {
                          const rawTarget = decodeURIComponent(
                            href.replace("wikilink://", ""),
                          );
                          return (
                            <span
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleWikilinkClick(rawTarget);
                              }}
                              title={`Open note: ${rawTarget}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 2,
                                color: tokens.decide,
                                background:
                                  "rgba(var(--v2-accent-rgb, 140, 100, 255), 0.08)",
                                border:
                                  "1px solid rgba(var(--v2-accent-rgb, 140, 100, 255), 0.25)",
                                borderRadius: 4,
                                padding: "0.5px 5px",
                                cursor: "pointer",
                                textDecoration: "none",
                                fontSize: "0.94em",
                                fontFamily:
                                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                                fontWeight: 500,
                                verticalAlign: "baseline",
                              }}
                            >
                              <span style={{ opacity: 0.5, fontSize: "0.85em" }}>
                                [[
                              </span>
                              {children}
                              <span style={{ opacity: 0.5, fontSize: "0.85em" }}>
                                ]]
                              </span>
                            </span>
                          );
                        }
                        if (href?.startsWith("obsidian://")) {
                          return (
                            <a
                              href={href}
                              style={{
                                color: tokens.decide,
                                textDecoration: "underline",
                              }}
                              {...props}
                            >
                              {children}
                            </a>
                          );
                        }
                        return (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: tokens.accent,
                              textDecoration: "underline",
                            }}
                            {...props}
                          >
                            {children}
                          </a>
                        );
                      },
                      blockquote: CalloutBlock,
                      h1: ({ children }) => (
                        <h1
                          style={{
                            fontSize: 20,
                            fontWeight: 600,
                            margin: "20px 0 10px",
                            color: tokens.textHi,
                            borderBottom: `1px solid ${tokens.borderDivider}`,
                            paddingBottom: 6,
                          }}
                        >
                          {children}
                        </h1>
                      ),
                      h2: ({ children }) => (
                        <h2
                          style={{
                            fontSize: 16.5,
                            fontWeight: 600,
                            margin: "18px 0 8px",
                            color: tokens.textHi,
                            borderBottom: `1px solid ${tokens.borderSoft}`,
                            paddingBottom: 4,
                          }}
                        >
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3
                          style={{
                            fontSize: 14.5,
                            fontWeight: 600,
                            margin: "14px 0 6px",
                            color: tokens.textLabel,
                          }}
                        >
                          {children}
                        </h3>
                      ),
                      h4: ({ children }) => (
                        <h4
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            margin: "12px 0 4px",
                            color: tokens.textSecondary,
                          }}
                        >
                          {children}
                        </h4>
                      ),
                      p: ({ children }) => (
                        <p
                          style={{
                            margin: "0 0 10px 0",
                            lineHeight: 1.68,
                            color: tokens.textBody,
                          }}
                        >
                          {children}
                        </p>
                      ),
                      ul: ({ children }) => (
                        <ul
                          style={{
                            margin: "0 0 10px 22px",
                            padding: 0,
                            color: tokens.textBody,
                          }}
                        >
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol
                          style={{
                            margin: "0 0 10px 22px",
                            padding: 0,
                            color: tokens.textBody,
                          }}
                        >
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => (
                        <li style={{ margin: "3px 0", lineHeight: 1.6 }}>
                          {children}
                        </li>
                      ),
                      input: ({ type, checked, ...props }) => {
                        if (type === "checkbox") {
                          return (
                            <input
                              type="checkbox"
                              disabled
                              checked={checked}
                              style={{
                                marginRight: 6,
                                accentColor: tokens.accent,
                                verticalAlign: "middle",
                              }}
                              {...props}
                            />
                          );
                        }
                        return <input type={type} checked={checked} {...props} />;
                      },
                      code: ({ children, className, ...props }) => {
                        const inline = !className;
                        if (inline) {
                          return (
                            <code
                              style={{
                                fontFamily:
                                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                                fontSize: "0.92em",
                                background:
                                  "rgba(var(--v2-accent-rgb, 140, 100, 255), 0.08)",
                                padding: "1px 5px",
                                borderRadius: 4,
                                color: "var(--v2-accent-secondary, #b392f0)",
                              }}
                              {...props}
                            >
                              {children}
                            </code>
                          );
                        }
                        return (
                          <code
                            className={className}
                            style={{
                              fontFamily:
                                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                              fontSize: 12,
                              color: tokens.textLabel,
                              background: "transparent",
                            }}
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => (
                        <pre
                          style={{
                            background: tokens.toolBg,
                            border: `1px solid ${tokens.borderSoft}`,
                            borderRadius: 7,
                            padding: "12px 14px",
                            overflowX: "auto",
                            fontSize: 12,
                            lineHeight: 1.55,
                            margin: "0 0 10px 0",
                          }}
                        >
                          {children}
                        </pre>
                      ),
                      table: ({ children }) => (
                        <div style={{ overflowX: "auto", margin: "12px 0" }}>
                          <table
                            style={{
                              borderCollapse: "collapse",
                              fontSize: 12,
                              width: "100%",
                            }}
                          >
                            {children}
                          </table>
                        </div>
                      ),
                      th: ({ children }) => (
                        <th
                          style={{
                            textAlign: "left",
                            padding: "7px 10px",
                            borderBottom: `2px solid ${tokens.borderEmphasis}`,
                            background: tokens.bgGutter,
                            color: tokens.textLabel,
                            fontWeight: 600,
                          }}
                        >
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td
                          style={{
                            padding: "6px 10px",
                            borderBottom: `1px solid ${tokens.borderDivider}`,
                            color: tokens.textBody,
                          }}
                        >
                          {children}
                        </td>
                      ),
                      hr: () => (
                        <hr
                          style={{
                            border: 0,
                            borderTop: `1px solid ${tokens.borderDivider}`,
                            margin: "18px 0",
                          }}
                        />
                      ),
                    }}
                  >
                    {preprocessWikilinks(note.body)}
                  </ReactMarkdown>
                ) : (
                  <div
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      color: tokens.textFaint,
                      fontStyle: "italic",
                      padding: "12px 0",
                    }}
                  >
                    (empty note — 0 bytes on disk)
                  </div>
                )}
              </div>
            )}

            {/* ── Wikilinks Section ─────────────────────────────────────── */}
            {note.wikilinks.length > 0 && (
              <>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.textFaint,
                    letterSpacing: "0.1em",
                    marginBottom: 11,
                  }}
                >
                  LINKS — {n(note.wikilinks.length)} wikilinks
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 7,
                    flexWrap: "wrap",
                    marginBottom: 24,
                  }}
                >
                  {note.wikilinks.map((l, j) => (
                    <div
                      key={j}
                      onClick={() => handleWikilinkClick(l)}
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: tokens.decide,
                        background: "#0e0c14",
                        border: "1px solid #221d33",
                        borderRadius: 5,
                        padding: "4px 9px",
                        cursor: "pointer",
                      }}
                    >
                      [[{l}]]
                    </div>
                  ))}
                </div>
              </>
            )}

            {note.backlinks.length > 0 && (
              <>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.textFaint,
                    letterSpacing: "0.1em",
                    marginBottom: 11,
                  }}
                >
                  LINKED MENTIONS — {n(note.backlinks.length)} notes link here
                </div>
                <div style={{ marginBottom: 26 }}>
                  {note.backlinks.map((b, j) => (
                    <div
                      key={j}
                      onClick={() => setSelSlug(b.slug)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 12px",
                        border: `1px solid ${tokens.borderSoft}`,
                        borderLeft: `2px solid ${CATEGORY_COLOR[note.category]}`,
                        borderRadius: 7,
                        marginBottom: 7,
                        cursor: "pointer",
                        background: "#0a0a0c",
                      }}
                    >
                      <span
                        className="ms"
                        style={{
                          fontSize: 14,
                          color: CATEGORY_COLOR[note.category],
                        }}
                      >
                        north_east
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: tokens.textLabel,
                          flex: 1,
                        }}
                      >
                        {b.topic}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 9.5, color: tokens.textFaint }}
                      >
                        note
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div
            className="mono"
            style={{
              padding: "64px 30px",
              fontSize: 12,
              color: tokens.textFaint,
            }}
          >
            {detailQ.isLoading
              ? "loading note…"
              : detailQ.isError
                ? `could not load the note — ${
                    detailQ.error instanceof Error
                      ? detailQ.error.message
                      : String(detailQ.error)
                  }`
                : "select a note to read."}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
