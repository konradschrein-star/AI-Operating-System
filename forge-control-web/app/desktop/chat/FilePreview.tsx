"use client";

/**
 * Renders the content of one file — used both inline (FileExplorerPanel, when
 * exactly one file is selected) and standalone (app/document/page.tsx, the
 * "open in a separate tab" target). Same component either way: the standalone
 * route is not a fork of this renderer, just a different chrome around it.
 *
 * It is therefore the ONLY thing behind a clicked path pill in chat. Until
 * 2026-08-25 it knew `.md .txt .json .csv` plus media and answered every other
 * extension with "no inline preview — download": clicking `executor.ts:715`
 * ended in a download button, which is what Konrad meant by "they still don't
 * open up in a proper way". Source files now get a line-numbered viewer, JSON
 * is pretty-printed, CSV becomes a table, and a note's YAML frontmatter is a
 * compact meta strip instead of a wall of prose above the first sentence.
 *
 * The line-numbered viewer is deliberately NOT `_ui/MediaDocumentViewer` — that
 * is the Library's inspector, 900 lines with an edit mode, and the chat panel
 * must not grow an editor. Same idea, own (much smaller) implementation.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { tokens } from "../../tokens";
import { fileReadUrl } from "../../api";
import { MessageMarkdown } from "./MessageMarkdown";
import { splitFrontmatter, type MetaEntry } from "./frontmatter";
import "./FilePreview.css";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a"]);

/**
 * Everything that reads as source or plain text. Dotfiles (`.env`, `.gitignore`)
 * are absent on purpose — the API refuses to serve them, so an entry here would
 * only promise a preview the server will never hand over.
 */
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".sh", ".bash", ".sql",
  ".css", ".html", ".xml",
  ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
  ".log", ".txt", ".patch", ".diff",
  ".rs", ".go", ".java", ".rb", ".php",
]);

/** Extensionless files that are still code. Matched on the lowercased name. */
const CODE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "procfile",
  "rakefile",
  "gemfile",
  "justfile",
  "brewfile",
]);

/** Hard cap on previewed text — large files (65KB+) froze the UI. */
const PREVIEW_MAX_CHARS = 40_000;

/** CSV rows rendered as a table before the "showing N of M" note takes over. */
const CSV_MAX_ROWS = 200;

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

type TextKind = "markdown" | "code" | "json" | "csv";

/** Which text renderer a name asks for, or null if it is not text at all. */
export function textKind(name: string): TextKind | null {
  const e = ext(name);
  if (e === ".md") return "markdown";
  if (e === ".json") return "json";
  if (e === ".csv") return "csv";
  if (CODE_EXT.has(e)) return "code";
  if (e === "" && CODE_NAMES.has(name.toLowerCase())) return "code";
  return null;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; truncated: boolean };

export function FilePreview({
  root,
  rel,
  name,
  line,
}: {
  root: string;
  rel: string;
  name: string;
  /**
   * 1-based line to reveal, from a `path:line` reference in chat. Highlighted
   * and scrolled to in the code viewer; for markdown it is only reported in the
   * meta strip (see the markdown branch for why there is nothing to scroll to).
   */
  line?: number;
}) {
  const url = fileReadUrl(root, rel);
  const e = ext(name);
  const kind = textKind(name);

  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    if (kind === null) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          // A blank pane is indistinguishable from a dead handler. Say what the
          // server said, including the status — the caller cannot see it.
          throw new Error(`${r.status} ${r.statusText || "request failed"}`);
        }
        const t = await r.text();
        if (cancelled) return;
        if (t.length > PREVIEW_MAX_CHARS) {
          const cut = t.slice(0, PREVIEW_MAX_CHARS);
          const lastNl = cut.lastIndexOf("\n");
          setLoad({
            status: "ready",
            text: lastNl > 0 ? cut.slice(0, lastNl) : cut,
            truncated: true,
          });
        } else {
          setLoad({ status: "ready", text: t, truncated: false });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [url, kind]);

  if (kind !== null) {
    if (load.status === "loading") {
      return (
        <div className="mono fp-loading">loading…</div>
      );
    }
    if (load.status === "error") {
      return (
        <div className="mono fp-error">
          failed to load: {load.message}
        </div>
      );
    }
    return (
      <TextPreview
        kind={kind}
        text={load.text}
        truncated={load.truncated}
        line={line}
      />
    );
  }

  if (IMAGE_EXT.has(e)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} style={{ maxWidth: "100%", display: "block" }} />;
  }
  if (VIDEO_EXT.has(e)) {
    return <video controls src={url} style={{ maxWidth: "100%", display: "block" }} />;
  }
  if (AUDIO_EXT.has(e)) {
    return <audio controls src={url} style={{ width: "100%" }} />;
  }
  if (e === ".pdf") {
    return <iframe src={url} style={{ width: "100%", height: "70vh", border: "none" }} />;
  }
  return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <p className="mono" style={{ fontSize: 11.5, color: tokens.textMuted, marginBottom: 12 }}>
        no inline preview for {e || "this file type"}
      </p>
      <a
        href={url}
        download={name}
        className="mono"
        style={{
          fontSize: 11.5,
          color: tokens.accent,
          border: `1px solid ${tokens.accent}`,
          borderRadius: 6,
          padding: "8px 14px",
          textDecoration: "none",
        }}
      >
        download {name}
      </a>
    </div>
  );
}

function TextPreview({
  kind,
  text,
  truncated,
  line,
}: {
  kind: TextKind;
  text: string;
  truncated: boolean;
  line?: number;
}) {
  const truncNote = truncated ? (
    <div className="mono fp-note">
      preview truncated at {(PREVIEW_MAX_CHARS / 1000) | 0}k characters — open the file to
      read it in full
    </div>
  ) : null;

  if (kind === "markdown") {
    const { meta, body } = splitFrontmatter(text);
    // No scroll for markdown: the rendered document has no line boundaries to
    // scroll to — one source line can be half a paragraph or an entire table.
    // The reference is reported in the strip and left at that.
    return (
      <>
        <MetaStrip meta={meta} line={line} />
        <div className="fp-scroll">
          <MessageMarkdown source={body} />
        </div>
        {truncNote}
      </>
    );
  }

  if (kind === "json") {
    const pretty = tryPrettyJson(text);
    return (
      <>
        {pretty === null && (
          <div className="mono fp-note">not valid JSON — showing the file as written</div>
        )}
        <CodeViewer text={pretty ?? text} line={line} />
        {truncNote}
      </>
    );
  }

  if (kind === "csv") {
    const rows = tryParseCsv(text);
    if (rows === null) {
      return (
        <>
          <div className="mono fp-note">
            could not parse this as CSV — showing the file as written
          </div>
          <CodeViewer text={text} line={line} />
          {truncNote}
        </>
      );
    }
    return (
      <>
        <CsvTable rows={rows} />
        {truncNote}
      </>
    );
  }

  return (
    <>
      <CodeViewer text={text} line={line} />
      {truncNote}
    </>
  );
}

/** The frontmatter strip — key muted, value as written, never body prose. */
function MetaStrip({ meta, line }: { meta: MetaEntry[] | null; line?: number }) {
  const hasMeta = meta !== null && meta.length > 0;
  if (!hasMeta && line === undefined) return null;
  return (
    <div className="mono fp-meta">
      {meta?.map(([k, v], i) => (
        <Fragment key={`${k}-${i}`}>
          <span className="fp-meta-key">{k}</span>
          <span className="fp-meta-val">{v}</span>
        </Fragment>
      ))}
      {line !== undefined && <span className="fp-meta-line">line {line}</span>}
    </div>
  );
}

function CodeViewer({ text, line }: { text: string; line?: number }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const hitRef = useRef<HTMLDivElement | null>(null);
  /** Which (line, length) pair has already been scrolled to — scroll once. */
  const scrolled = useRef<string | null>(null);
  const past = line !== undefined && line > lines.length;

  useEffect(() => {
    if (line === undefined || past) return;
    const key = `${line}:${text.length}`;
    if (scrolled.current === key) return;
    const el = hitRef.current;
    if (!el) return;
    scrolled.current = key;
    el.scrollIntoView({ block: "center" });
  }, [line, past, text]);

  return (
    <>
      {past && (
        <div className="mono fp-note">
          line {line} is past the end ({lines.length} lines)
        </div>
      )}
      <div className="mono fp-code-scroll">
        {lines.map((l, i) => {
          const n = i + 1;
          const hit = n === line && !past;
          return (
            <div
              key={n}
              data-line={n}
              ref={hit ? hitRef : undefined}
              className={hit ? "fp-code-row fp-code-row-hit" : "fp-code-row"}
            >
              <span className="fp-code-num">{n}</span>
              <span className="fp-code-text">{l}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function CsvTable({ rows }: { rows: string[][] }) {
  const head = rows[0] ?? [];
  const body = rows.slice(1, CSV_MAX_ROWS + 1);
  const hidden = Math.max(0, rows.length - 1 - body.length);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return (
    <>
      <div className="fp-csv-wrap">
        <table className="mono fp-csv">
          <thead>
            <tr>
              <th className="fp-csv-num">#</th>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>{head[c] ?? ""}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                <td className="fp-csv-num">{i + 1}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>{r[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="mono fp-note">
          showing {body.length} of {rows.length - 1} rows
        </div>
      )}
    </>
  );
}

/** Pretty-print JSON, or null when the text is not JSON (caller shows it raw). */
function tryPrettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return null;
  }
}

/**
 * Minimal RFC4180-ish CSV reader: quoted fields, doubled quotes, CRLF. Returns
 * null on a row it cannot read (an unterminated quote — which a truncated
 * preview produces routinely) so the caller can fall back to the raw text
 * rather than render a table that lies about the file.
 */
function tryParseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        field += c;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (quoted) return null;
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}
