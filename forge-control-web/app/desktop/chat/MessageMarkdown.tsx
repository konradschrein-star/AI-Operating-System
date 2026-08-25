"use client";

import {
  memo,
  useCallback,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokens } from "../../tokens";
import { rehypeForgeAllowlist, safeHref } from "./rehype-forge-allowlist";
import { remarkWikilink } from "./remark-wikilink";
import {
  codeText,
  detectPath,
  documentHref,
  type PathTarget,
} from "./code-path-link";
import {
  resolveRootPath,
  resolveTarget,
  resolveWikilink,
  type Resolution,
} from "./resolve-path";
import { requestOpenFile } from "./open-file-bus";
import { toast } from "../_ui/Toasts";

/** Ctrl on everything except Apple hardware, where the chord is ⌘.
 *  Exported so the tool row's tooltip names the same chord as the pill's. */
export function modifierLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? "⌘"
    : "Ctrl";
}

/** Where a click wants the file: the right sidebar's Files panel (plain
 *  click) or the full-window /document viewer (Ctrl/Cmd-click). */
type OpenWhere = "panel" | "tab";

/**
 * Act on a resolution — the ONE place a reference becomes a navigation.
 *
 * Plain click: show the file in the right sidebar's Files panel, keeping the
 * chat you were reading on screen. Konrad's UI model puts selection on the
 * left and views on the right — a new tab throws the conversation away, which
 * is the exact thing this feature exists to avoid. Ctrl/Cmd-click keeps the
 * browser's universal "open elsewhere" meaning and goes to /document.
 *
 * THREE FAILURE PATHS, ALL VISIBLE:
 *  • a root that this server has not restarted into yet → an info toast that
 *    names the root (the `memory` root is in this state today);
 *  • nothing matched → an info toast naming what was searched;
 *  • a search that ERRORED → an ERROR toast carrying the status. "Not found"
 *    and "the search 500'd" are different facts and reporting the second as
 *    the first is how a broken index looks like an empty one for a week.
 *
 * D8, THE ZERO-LISTENER FALLBACK: `requestOpenFile` reports how many
 * subscribers took the request. Zero means this surface has no Files panel at
 * all — the mobile shell renders control tabs and no chat sidebar, and any
 * future embedding of the transcript is the same case. Rather than a click
 * that looks dead, navigate the current tab to the full-window viewer. Same
 * tab on purpose: a popup blocker eats `window.open` from an async
 * continuation, and the reader asked to read a file, not to get a second tab.
 */
function applyResolution(res: Resolution, where: OpenWhere): void {
  if (!res.ok) {
    if (res.reason === "root-not-live") {
      toast(`Can't open ${res.label} yet`, "info", res.detail);
    } else if (res.reason === "search-failed") {
      toast(`Couldn't open ${res.label}`, "error", res.detail);
    } else {
      toast(`Couldn't find ${res.label}`, "info", res.detail);
    }
    return;
  }
  const href = documentHref(res.root, res.path, res.line);
  if (where === "tab") {
    window.open(href, "_blank", "noopener");
    return;
  }
  const heard = requestOpenFile({
    root: res.root,
    path: res.path,
    ...(res.line !== undefined ? { line: res.line } : null),
    ...(res.isDir ? { isDir: true } : null),
  });
  if (heard === 0) window.location.assign(href);
}

/**
 * EXPORTED, AND DELIBERATELY THE ONLY COPY. The inline pill is not the only
 * place a path appears in the transcript — a tool row (`AssistantThread`'s
 * `ToolCallRow`) shows the `file_path` of every Read/Write/Edit, which is where
 * paths are densest of all. That row opens files through THIS function, so the
 * root mapping, the filename-not-path search, the "root isn't live yet" notice
 * and the never-silent miss are one implementation with one set of bugs.
 * If you move it, move it whole; do not grow a second one.
 */
export async function openPathTarget(
  target: PathTarget,
  where: OpenWhere,
): Promise<void> {
  applyResolution(await resolveTarget(target), where);
}

/** How long a click may look like nothing before it has to say something.
 *  A bare-name click searches up to six roots in sequence; on a cold cache the
 *  measured worst case was four seconds of an entirely still screen. */
const PENDING_TOAST_MS = 1_000;

/**
 * The click behaviour every openable reference shares: a pending flag while
 * the resolver works, a "locating…" toast if it takes longer than a second,
 * and a visible end in every branch.
 *
 * A hook rather than a helper because the pending flag is per-reference state
 * and has to re-render that one pill. It lives in `PathPill`/`DocLink` — real
 * components, defined at module level — and NOT in the `components` map's
 * arrow functions: those are re-created on every render of `MessageMarkdown`,
 * so React would see a new component type each time and remount, throwing the
 * state away. The memo on `source` alone is untouched by any of this.
 */
function useOpener(): {
  resolving: boolean;
  open: (label: string, where: OpenWhere, resolve: () => Promise<Resolution>) => void;
} {
  const [resolving, setResolving] = useState(false);
  const open = useCallback(
    (label: string, where: OpenWhere, resolve: () => Promise<Resolution>) => {
      setResolving(true);
      const slow = window.setTimeout(() => {
        toast(`locating ${label}…`, "info", "Searching the file roots.");
      }, PENDING_TOAST_MS);
      void resolve()
        .then((res) => applyResolution(res, where))
        .catch((e: unknown) => {
          // The resolver returns its failures; reaching here means it THREW,
          // which is a bug in this app rather than a missing file. Say so with
          // the message — a swallowed exception here is the defect that made
          // the whole feature look dead in the first place.
          toast(
            `Couldn't open ${label}`,
            "error",
            e instanceof Error ? e.message : String(e),
          );
        })
        .finally(() => {
          window.clearTimeout(slow);
          setResolving(false);
        });
    },
    [],
  );
  return { resolving, open };
}

/** Base look of an inline `code` pill, openable or not. */
const PILL_STYLE = {
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  fontSize: "0.92em",
  background: "rgba(var(--v2-accent-rgb), 0.08)",
  padding: "1px 5px",
  borderRadius: 4,
} as const;

/**
 * D7, DISCOVERABILITY — the restrained version, and the default Konrad was
 * asked about: an openable pill takes THE APP'S LINK COLOUR on top of the
 * dotted underline it already had. Nothing else. No badge, no icon, no
 * permanent chrome on every pill in the transcript; the colour is a signal
 * Konrad already reads everywhere else in this console as "this is a link".
 * Non-openable pills are untouched.
 */
const OPENABLE_PILL_STYLE = {
  ...PILL_STYLE,
  color: "var(--v2-accent)",
  textDecoration: "underline",
  textDecorationStyle: "dotted" as const,
  textUnderlineOffset: 2,
  textDecorationColor: "rgba(var(--v2-accent-rgb), 0.5)",
} as const;

/**
 * An inline `code` span that names a file or a folder.
 *
 * `data-openable-path` is what the Playwright regression test keys on and must
 * not be renamed. `data-openable-kind` says which affordance it is, so a test
 * (and a stylesheet) can tell a folder from a file from a note without parsing
 * the text. `data-resolving` appears only while a search is in flight.
 */
function PathPill({
  target,
  passThrough,
  children,
}: {
  target: PathTarget;
  passThrough: Record<string, unknown>;
  children: ReactNode;
}) {
  const { resolving, open } = useOpener();
  const kind = target.isDir ? "dir" : "file";
  const noun = target.isDir ? "folder" : "file";
  return (
    <code
      /* The renderer's own props first so nothing below can be clobbered by
       * whatever react-markdown passes through. */
      {...passThrough}
      data-openable-path="true"
      data-openable-kind={kind}
      {...(resolving ? { "data-resolving": "true" } : null)}
      title={`click to open the ${noun} ${target.label} in the Files panel · ${modifierLabel()}-click for a new tab`}
      style={{
        ...OPENABLE_PILL_STYLE,
        cursor: resolving ? "progress" : "pointer",
      }}
      onClick={(e: ReactMouseEvent<HTMLElement>) => {
        // A click that is really a text selection (the user dragged across
        // the pill) must not navigate.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        e.stopPropagation();
        open(target.label, e.ctrlKey || e.metaKey ? "tab" : "panel", () =>
          resolveTarget(target),
        );
      }}
    >
      {children}
    </code>
  );
}

/**
 * An `a` whose href points into the full-window viewer — a `[[wikilink]]` the
 * remark plugin created, or a `/document?root=…&path=…` link somebody wrote.
 *
 * It is a REAL ANCHOR with a real href, so Ctrl/Cmd-click and middle-click
 * keep their universal meaning and the browser handles them (the `click` event
 * does not even fire for the middle button). Only the plain left click is
 * intercepted, to open the file in the panel beside the conversation instead
 * of navigating away from it.
 *
 * The href it renders is the SANITISED one: `safeHref` has already run, and it
 * only ever permits http(s), mailto, a fragment or a same-origin relative path.
 * Nothing an agent writes as markup becomes a handler here — the handler is
 * this component, and it fires for one shape of same-origin path.
 */
function DocLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const { resolving, open } = useOpener();
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const wikilink = params.get("wikilink");
  const root = params.get("root");
  const rawLine = params.get("line");
  const line = rawLine !== null && /^\d{1,9}$/.test(rawLine) ? Number(rawLine) : undefined;
  const label = wikilink ?? params.get("path")?.split("/").pop() ?? root ?? href;
  return (
    <a
      href={href}
      rel="noopener"
      data-openable-path="true"
      data-openable-kind={wikilink !== null ? "wikilink" : "file"}
      {...(resolving ? { "data-resolving": "true" } : null)}
      title={
        wikilink !== null
          ? `click to open the note ${wikilink} in the Files panel · ${modifierLabel()}-click for a new tab`
          : `click to open ${label} in the Files panel · ${modifierLabel()}-click for a new tab`
      }
      style={{
        color: "var(--v2-accent)",
        textDecoration: "underline",
        textDecorationStyle: "dotted",
        textUnderlineOffset: 2,
        textDecorationColor: "rgba(var(--v2-accent-rgb), 0.5)",
        cursor: resolving ? "progress" : "pointer",
      }}
      onClick={(e: ReactMouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        e.preventDefault();
        e.stopPropagation();
        open(label, "panel", () =>
          wikilink !== null
            ? resolveWikilink(wikilink, params.get("wikipath"))
            : resolveRootPath(root ?? "", params.get("path") ?? "", { label, line }),
        );
      }}
    >
      {/* NO LEADING `[[` GLYPH. It was built and photographed
        * (20260825T061654Z-r3-thread-references.png): rendered, a wikilink read
        * "[[Operating Manual" — an opening bracket with nothing closing it,
        * which looks like markdown the renderer failed to finish rather than
        * like restraint. The dotted underline in the link colour is the same
        * signal the path pills carry, and one visual language for "this opens
        * in the Files panel" is better than two. */}
      {children}
    </a>
  );
}

/**
 * Render an assistant / system message as markdown. v1.6 phase 4.
 *
 * Targets the inline-style V2 system — no Tailwind, no `@tailwind/typography`.
 * Headings, lists, blockquotes, tables, inline code, and fenced code blocks
 * each get a small inline-style block. Syntax highlighting is deferred —
 * a future iteration can add prism/shiki when the bundle cost is worth it.
 *
 * MEMOISED: parsing markdown is the most expensive thing the chat does, and a
 * long thread renders dozens of these. Without memo every parent re-render
 * (a poll, a streamed token, opening a panel) re-parsed every message in the
 * thread — the single largest source of click-to-response lag. `source` is a
 * plain string, so reference equality is exactly the right cache key.
 *
 * ── Round 808: this is now an ATTACKER-FACING surface ─────────────────────
 * Konrad asked for richer messages, and round 808 routes worker reports
 * through here too — text written by agents that read hostile inputs. Three
 * rules hold this file safe and none of them may be relaxed:
 *
 *   1. NO `rehype-raw`, ever. Without it react-markdown renders raw HTML as
 *      escaped literal text, which is exactly what round 804 proved the
 *      secrets panel does. Adding it would turn every message into markup.
 *   2. `rehypeForgeAllowlist` runs on the tree: tags and attributes are a
 *      whitelist, hrefs are scheme-checked, and images become inert text.
 *      MEASURED BEFORE IT EXISTED: `![x](http://host/beacon.png)` in an agent
 *      message made this console fetch the URL — the one live hole in the
 *      pre-808 renderer, closed here.
 *   3. `urlTransform` is the second gate on the same URLs, running before the
 *      tree is built. Both, not either: the plugin protects against a future
 *      plugin, the transform against a future component override.
 *
 * INTERACTIVE controls do not come from this file. They are a typed payload
 * (`rich-blocks.ts`) rendered by `RichMessage.tsx`; nothing an agent writes as
 * markup can produce a button, a form or a handler here.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  source,
}: {
  source: string;
}) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: tokens.text }}>
      <ReactMarkdown
        /* remarkWikilink runs AFTER remarkGfm on purpose: gfm is what turns a
         * table row into cells, and an aliased wikilink inside a cell has to
         * be written `[[Target\|Alias]]` so the pipe is not read as a cell
         * separator. It produces mdast `link` nodes — ordinary links, which
         * then go through urlTransform and the allowlist like any other. */
        remarkPlugins={[remarkGfm, remarkWikilink]}
        rehypePlugins={[rehypeForgeAllowlist]}
        /* Runs on every url-bearing node before the tree is handed over.
         * Returning "" is react-markdown's own "no link" signal. */
        urlTransform={(url) => safeHref(url) ?? ""}
        components={{
          /* Belt and braces: the allowlist has already replaced every image
           * with text, so this component should be unreachable. If a future
           * change ever lets one through, it renders as a visible marker
           * instead of a request to somebody else's server. */
          img: ({ alt, src }) => (
            <span
              data-inert-image
              className="mono"
              style={{ fontSize: 11.5, color: tokens.textMuted }}
            >
              [image not loaded: {alt || "image"}
              {typeof src === "string" && src ? ` — ${src}` : ""}]
            </span>
          ),
          p: ({ children }) => (
            <p style={{ margin: "0 0 8px 0" }}>{children}</p>
          ),
          h1: ({ children }) => (
            <h1
              style={{
                fontSize: 17,
                fontWeight: 600,
                margin: "12px 0 6px",
                color: tokens.textHi,
              }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                margin: "10px 0 5px",
                color: tokens.textHi,
              }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                margin: "10px 0 5px",
                color: tokens.textHi,
              }}
            >
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: "0 0 8px 18px", padding: 0 }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ margin: "2px 0" }}>{children}</li>
          ),
          /* A link whose href did not survive `safeHref` renders as TEXT, not
           * as an anchor to nowhere: `href="#"` on a hostile link is a click
           * target that looks legitimate and silently does nothing, which is
           * worse than showing the reader that the link was refused. */
          a: ({ href, children }) => {
            const safe = safeHref(href);
            if (safe === null) {
              return (
                <span
                  data-refused-link
                  title="link refused: only http(s), mailto, #fragment and relative paths are followed"
                  style={{ color: tokens.textMuted, textDecoration: "line-through" }}
                >
                  {children}
                </span>
              );
            }
            /* A link into this app's own viewer — every `[[wikilink]]` the
             * remark plugin created, and a hand-written `/document?root=…`.
             * It opens beside the conversation instead of replacing it. */
            if (safe.startsWith("/document?")) {
              return <DocLink href={safe}>{children}</DocLink>;
            }
            return (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer nofollow"
                style={{ color: "var(--v2-accent)", textDecoration: "underline" }}
              >
                {children}
              </a>
            );
          },
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: `2px solid ${tokens.borderEmphasis}`,
                paddingLeft: 12,
                margin: "0 0 8px 0",
                color: tokens.textSecondary,
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children, className, ...props }) => {
            // Inline code: no language class → render inline pill.
            // Fenced block: parent <pre> sets background; we just keep mono.
            const inline = !className;
            if (inline) {
              // A plain click opens a referenced file in the Files panel;
              // Ctrl/Cmd-click opens the /document viewer. `detectPath` is
              // deliberately narrow — see code-path-link.ts on why a dead
              // click is worse than no affordance. Non-path pills fall
              // through unchanged, INCLUDING their colour: the accent colour
              // means "openable" and must not appear on a pill that is not.
              const target = detectPath(codeText(children));
              if (target) {
                return (
                  <PathPill target={target} passThrough={props}>
                    {children}
                  </PathPill>
                );
              }
              return (
                <code
                  style={{ ...PILL_STYLE, color: "var(--v2-accent-secondary)" }}
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
                /* Was `rgba(0, 0, 0, 0.45)` — a hardcoded dark wash that
                 * stayed dark in light mode (raw-colour-allowlist.txt's TODO
                 * line for this file). `toolBg` is the theme-aware recessed
                 * panel every other code surface in the chat uses. */
                background: tokens.toolBg,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 6,
                padding: "10px 12px",
                overflowX: "auto",
                fontSize: 12,
                lineHeight: 1.55,
                margin: "0 0 8px 0",
              }}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: "auto", margin: "0 0 8px 0" }}>
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
                padding: "4px 8px",
                borderBottom: `1px solid ${tokens.borderEmphasis}`,
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
                padding: "4px 8px",
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
                margin: "10px 0",
              }}
            />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
