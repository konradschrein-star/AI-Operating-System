"use client";

import { memo, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokens } from "../../tokens";
import { searchFiles, fetchFileRoots } from "../../api";
import { rehypeForgeAllowlist, safeHref } from "./rehype-forge-allowlist";
import {
  codeText,
  detectPath,
  documentHref,
  type PathTarget,
  type RootKey,
} from "./code-path-link";
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

/** Roots searched for a bare filename, in the order Konrad is likeliest to
 *  mean. The vault first: most references in chat are to his own notes; the
 *  source trees last, because a bare `page.tsx` matches in a dozen places
 *  there and a vault note of the same name is almost certainly what was
 *  meant. */
const SEARCH_ROOTS: readonly RootKey[] = [
  "vault",
  "workspace",
  "uploads",
  "forge-src",
  "aios",
];

/**
 * The roots the API actually serves right now, fetched once and cached.
 *
 * The prefix table in code-path-link.ts is a static map, and the server's ROOTS
 * is the truth. They go out of step for real: `aios` and `forge-src` were added
 * to both on 2026-08-25, but forge-control only picks up a route change on
 * restart — and a restart waits for the fleet to go quiet. In that window the
 * UI would confidently open /document on a root the API has never heard of and
 * render "(failed to load)". Asking is cheaper than guessing.
 */
let rootsPromise: Promise<Set<string>> | null = null;
function knownRoots(): Promise<Set<string>> {
  if (!rootsPromise) {
    rootsPromise = fetchFileRoots()
      .then((rs) => new Set(rs.map((r) => r.key)))
      // A failed lookup must not disable the feature — assume the mapping is
      // right and let the viewer report its own error if it isn't.
      .catch(() => new Set<string>());
  }
  return rootsPromise;
}

/**
 * Turn a detected path into a concrete (root, path). An exact target is
 * already there; a bare name is placed by asking the search API, vault first.
 */
async function resolveTarget(
  target: PathTarget,
): Promise<{ root: string; path: string } | null> {
  if (target.kind === "exact") {
    const live = await knownRoots();
    if (live.size > 0 && !live.has(target.root)) {
      toast(
        `Can't open ${target.label} yet`,
        "info",
        `The "${target.root}" file root isn't live on this server yet.`,
      );
      return null;
    }
    return { root: target.root, path: target.path };
  }
  for (const root of SEARCH_ROOTS) {
    try {
      // SEARCH BY FILENAME, NOT BY THE PATH. `/files/search` matches with
      // `name.toLowerCase().includes(q)` against each entry's NAME — so a
      // query containing a slash can never match anything. Measured: clicking
      // `Mentor/Profile/Operating Manual.md` sent q=the whole path, got zero
      // hits, and the click did nothing. The directory part is not thrown
      // away though: it is what picks the right file out of the results below.
      const { entries } = await searchFiles(root, "", target.label);
      const files = entries.filter((e) => !e.isDir);
      const wantPath = target.query.toLowerCase();
      const hit =
        // The author wrote a path: honour it exactly, then as a suffix
        // ("Profile/OPEN-QUESTIONS.md" should beat a same-named file
        // elsewhere in the root).
        files.find((e) => e.path.toLowerCase() === wantPath) ??
        files.find((e) => e.path.toLowerCase().endsWith(`/${wantPath}`)) ??
        // Bare name: exact filename beats a substring match — searching
        // "Operator Log.md" also returns "AI OS Operator Log.md".
        files.find((e) => e.name.toLowerCase() === target.label.toLowerCase()) ??
        files[0];
      if (hit) return { root, path: hit.path };
    } catch {
      // Try the next root; a search failure is not worth a dialog.
    }
  }
  return null;
}

/**
 * Plain click: show the file in the right sidebar's Files panel, keeping the
 * chat you were reading on screen. Konrad's UI model puts selection on the
 * left and views on the right — a new tab throws the conversation away, which
 * is the exact thing this feature exists to avoid.
 *
 * Ctrl/Cmd-click keeps the browser's universal "open elsewhere" meaning and
 * goes to the full-window /document viewer.
 *
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
  where: "panel" | "tab",
): Promise<void> {
  const hit = await resolveTarget(target);
  if (!hit) {
    // NEVER silent. The first live test of this feature failed exactly here:
    // the click fired, both searches went out, neither matched, and nothing
    // whatsoever happened on screen — which reads as "the feature is broken"
    // and is indistinguishable from a dead handler. A miss has to say so.
    toast(`Couldn't find ${target.label}`, "info", "Not in any indexed file root.");
    return;
  }
  if (where === "tab") {
    window.open(documentHref(hit.root, hit.path), "_blank", "noopener");
    return;
  }
  requestOpenFile(hit);
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
        remarkPlugins={[remarkGfm]}
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
              // Ctrl/Cmd-click opens a referenced file in the /document
              // viewer. `detectPath` is deliberately narrow — see
              // code-path-link.ts on why a dead click is worse than no
              // affordance. Non-path pills fall through unchanged.
              const target = detectPath(codeText(children));
              return (
                <code
                  style={{
                    fontFamily:
                      "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                    fontSize: "0.92em",
                    background: "rgba(var(--v2-accent-rgb), 0.08)",
                    padding: "1px 5px",
                    borderRadius: 4,
                    color: "var(--v2-accent-secondary)",
                    ...(target
                      ? {
                          cursor: "pointer",
                          textDecoration: "underline",
                          textDecorationStyle: "dotted" as const,
                          textUnderlineOffset: 2,
                          textDecorationColor: "rgba(var(--v2-accent-rgb), 0.5)",
                        }
                      : null),
                  }}
                  {...(target
                    ? {
                        "data-openable-path": "true",
                        title: `click to open ${target.label} in the Files panel · ${modifierLabel()}-click for a new tab`,
                        onClick: (e: ReactMouseEvent<HTMLElement>) => {
                          // A click that is really a text selection (the user
                          // dragged across the pill) must not navigate.
                          const sel = window.getSelection();
                          if (sel && !sel.isCollapsed) return;
                          e.preventDefault();
                          e.stopPropagation();
                          void openPathTarget(
                            target,
                            e.ctrlKey || e.metaKey ? "tab" : "panel",
                          );
                        },
                      }
                    : null)}
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
