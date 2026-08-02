"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tokens } from "../../tokens";

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
        components={{
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
          a: ({ href, children }) => (
            <a
              href={href ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--v2-accent)", textDecoration: "underline" }}
            >
              {children}
            </a>
          ),
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
                background: "rgba(0, 0, 0, 0.45)",
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
