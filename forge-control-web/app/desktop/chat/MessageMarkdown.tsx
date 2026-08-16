"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokens } from "../../tokens";
import { rehypeForgeAllowlist, safeHref } from "./rehype-forge-allowlist";

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
