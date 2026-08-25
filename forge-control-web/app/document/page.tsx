"use client";

/**
 * Full-window document viewer — the "open ↗" target from the file explorer,
 * for when a preview needs more room than the split pane gives it. Renders
 * the exact same FilePreview component as the in-app viewer; this route is
 * chrome around it, not a second implementation.
 *
 * Three ways to land here, same chrome either way:
 *   ?root=&path=            — a resolved reference, as `documentHref()` builds it.
 *   ?root=&path=&line=      — the same, plus a `path:line` reference (D1); the line
 *                              is only ever a display hint (highlight + scroll), so a
 *                              bad or out-of-range value is dropped, never thrown.
 *   ?wikilink=&wikipath=     — a `[[wikilink]]` the remark plugin turned into a link
 *                              (D2), as `wikilinkHref()` in remark-wikilink.ts builds
 *                              it. This page resolves it into vault root+path with
 *                              the SAME `resolveWikilink()` the chat pill uses —
 *                              MessageMarkdown.tsx's DocLink resolves it before
 *                              navigating on a plain click, but a Ctrl/Cmd-click, a
 *                              hand-typed URL, or the zero-listener fallback all land
 *                              on the raw href, so this page must be able to resolve
 *                              it itself rather than assume it always arrives resolved.
 */

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { FilePreview } from "../desktop/chat/FilePreview";
import { resolveWikilink, type Resolution } from "../desktop/chat/resolve-path";
import { tokens } from "../tokens";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        height: "100dvh",
        display: "grid",
        placeItems: "center",
        background: tokens.bgBody,
        color: tokens.textMuted,
        fontSize: 11,
        textAlign: "center",
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

/** `?line=` is a display hint only (highlight + scroll in FilePreview) — a
 *  missing, non-numeric, zero or negative value is dropped rather than
 *  thrown, so a hand-edited or stale URL still renders the file. */
function parseLine(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

function DocumentWindow() {
  const params = useSearchParams();
  const line = parseLine(params.get("line"));

  const wikilink = params.get("wikilink");
  const wikipath = params.get("wikipath");
  const rootParam = params.get("root");
  const pathParam = params.get("path");

  // "loading" while resolveWikilink() is in flight, null when there is no
  // ?wikilink= to resolve at all — kept apart so the render below can tell
  // "haven't started" from "in progress" without a third boolean.
  const [wikiResolution, setWikiResolution] = useState<Resolution | "loading" | null>(
    wikilink ? "loading" : null,
  );

  useEffect(() => {
    if (!wikilink) {
      setWikiResolution(null);
      return;
    }
    let cancelled = false;
    setWikiResolution("loading");
    resolveWikilink(wikilink, wikipath)
      .then((res) => {
        if (!cancelled) setWikiResolution(res);
      })
      /* `resolveWikilink` is total today — it catches its own search failure and
       * returns a `search-failed` resolution. This is the guard for the day it
       * stops being: without it a rejection is an unhandled promise and the page
       * sits on "locating …" forever, which is the one failure mode this whole
       * feature exists to eliminate. Reported as `search-failed` because that is
       * literally what happened and it is the reason whose `detail` is rendered
       * verbatim by the branch below. */
      .catch((err: unknown) => {
        if (cancelled) return;
        setWikiResolution({
          ok: false,
          reason: "search-failed",
          label: wikilink,
          detail: `Could not resolve [[${wikilink}]] — ${
            err instanceof Error ? err.message : String(err)
          }.`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [wikilink, wikipath]);

  let root: string | null;
  let path: string | null;

  if (wikilink !== null) {
    if (wikiResolution === "loading" || wikiResolution === null) {
      return <Centered>locating {wikilink}…</Centered>;
    }
    if (!wikiResolution.ok) {
      // "not-found" gets the wording the brief asked for; the other two
      // reasons (root-not-live, search-failed) are real distinct facts about
      // the vault search itself, so they get their own diagnostic rather than
      // being folded into the same "no note named" sentence.
      return (
        <Centered>
          {wikiResolution.reason === "not-found"
            ? `no vault note named "${wikilink}"`
            : wikiResolution.detail}
        </Centered>
      );
    }
    root = wikiResolution.root;
    path = wikiResolution.path;
  } else {
    root = rootParam;
    path = pathParam;
  }

  const name = path ? (path.split("/").pop() ?? path) : null;

  if (!root || !path || !name) {
    return <Centered>no document specified — pass ?root=&path= or ?wikilink=</Centered>;
  }

  return (
    <div style={{ height: "100dvh", background: tokens.bgBody, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          background: tokens.bgCard,
          flexShrink: 0,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 10, color: tokens.accent, letterSpacing: "0.12em" }}
        >
          DOCUMENT
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {root} / {path}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <FilePreview root={root} rel={path} name={name} line={line} />
      </div>
    </div>
  );
}

export default function DocumentPage() {
  return (
    <Suspense
      fallback={
        <div
          className="mono"
          style={{
            height: "100dvh",
            display: "grid",
            placeItems: "center",
            background: tokens.bgBody,
            color: tokens.textMuted,
            fontSize: 11,
          }}
        >
          loading…
        </div>
      }
    >
      <DocumentWindow />
    </Suspense>
  );
}
