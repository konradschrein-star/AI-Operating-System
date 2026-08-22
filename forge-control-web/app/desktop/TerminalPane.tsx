"use client";

/**
 * TerminalPane — a shell on the VPS, in the slot the canvas uses.
 *
 * ── THE SESSION IS THE SERVER'S, NOT THE TAB'S ───────────────────────────────
 * Closing this pane does NOT kill the shell. That is the whole point: the stated
 * use is "run Claude Code agents directly on the VPS", and those run for minutes
 * to hours. A pane that killed its session on unmount would make every accidental
 * click of the toggle — or a reload, or a phone locking — destroy work in flight.
 * So the toggle detaches a viewport, and killing is a separate, labelled button.
 * The pane says which of the two it is doing rather than leaving Konrad to find
 * out by losing an agent.
 *
 * ── WHY A POLL AND NOT A SOCKET ──────────────────────────────────────────────
 * The backend is tmux capture-pane, which is a frame, not a stream — there is
 * nothing to push. A poll matches the substrate. It runs at 700ms while the pane
 * is open and STOPS when it is closed, because a terminal nobody is looking at
 * has no reason to cost a request per second against a surface already close to
 * its request ceiling.
 *
 * What this is not: a faithful emulator. No ANSI colour, no scrollback past the
 * pane, and a full-screen TUI shows as its current frame. Enough to run a
 * command, watch an agent, and answer its prompts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { tokens } from "../tokens";

const POLL_MS = 700;
const ROOT = "/api/proxy/terminal";

interface TerminalRead {
  id: string;
  alive: boolean;
  title: string;
  content: string;
  detail?: string;
}

/** Keys the backend accepts by name. Anything else is sent as literal text, so
 *  a paste containing "C-c" is typed rather than interpreted. */
const CTRL_KEYS: { key: string; label: string; title: string }[] = [
  { key: "C-c", label: "^C", title: "Interrupt (Ctrl-C)" },
  { key: "C-d", label: "^D", title: "End of input (Ctrl-D)" },
  { key: "Escape", label: "ESC", title: "Escape" },
  { key: "Up", label: "↑", title: "Previous command" },
  { key: "Down", label: "↓", title: "Next command" },
  { key: "Tab", label: "⇥", title: "Complete" },
];

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const raw = await res.text();
  if (!res.ok) {
    // The body carries forge-control's own diagnostic; a helper that threw
    // `${status} ${statusText}` would drop the one part worth reading.
    let msg = raw.slice(0, 300);
    try {
      const b = JSON.parse(raw) as { error?: string; detail?: string };
      msg = [b.error, b.detail].filter(Boolean).join(" — ") || msg;
    } catch {
      /* keep the raw text */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return JSON.parse(raw) as T;
}

export function TerminalPane({ onClose }: { onClose: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [alive, setAlive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const outRef = useRef<HTMLPreElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* Adopt an existing session before making a new one, so a reload or a toggle
   * reattaches to the agent that is still running rather than stranding it. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await call<{ sessions: { id: string }[] }>("/sessions");
        if (cancelled) return;
        if (list.sessions.length > 0) {
          setSessionId(list.sessions[0].id);
          return;
        }
        const made = await call<{ id: string }>("/sessions", {
          method: "POST",
          body: JSON.stringify({ cwd: "/opt/forge-ai-os", title: "shell", cols: 120, rows: 32 }),
        });
        if (!cancelled) setSessionId(made.id);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Poll only while mounted. Unmount stops the requests; it does not stop the shell. */
  useEffect(() => {
    if (sessionId === null) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await call<TerminalRead>(`/sessions/${sessionId}`);
        if (stop) return;
        setContent(r.content);
        setAlive(r.alive);
        setError(null);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void tick();
    const h = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [sessionId]);

  useEffect(() => {
    const el = outRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [content]);

  const send = useCallback(
    async (body: Record<string, unknown>) => {
      if (sessionId === null) return;
      setBusy(true);
      try {
        await call(`/sessions/${sessionId}/input`, { method: "POST", body: JSON.stringify(body) });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const submit = useCallback(async () => {
    const text = input;
    setInput("");
    await send({ text, submit: true });
    inputRef.current?.focus();
  }, [input, send]);

  const killSession = useCallback(async () => {
    if (sessionId === null) return;
    try {
      await call(`/sessions/${sessionId}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
    }
    setSessionId(null);
    setContent("");
    onClose();
  }, [sessionId, onClose]);

  const btn = {
    fontSize: 10,
    letterSpacing: "0.06em",
    padding: "4px 8px",
    borderRadius: 5,
    cursor: "pointer",
    color: tokens.textMuted,
    background: "transparent",
    border: `1px solid ${tokens.border}`,
  } as const;

  return (
    <div
      data-terminal-pane
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: `1px solid ${tokens.border}`,
          flex: "none",
        }}
      >
        <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: tokens.textMuted }}>
          TERMINAL
        </span>
        <span
          data-terminal-alive={alive ? "1" : "0"}
          className="mono"
          style={{ fontSize: 10, color: alive ? tokens.accent : tokens.textFaint }}
        >
          {sessionId === null ? "starting…" : alive ? "live" : "exited"}
        </span>
        <div style={{ flex: 1 }} />
        {CTRL_KEYS.map((k) => (
          <button
            key={k.key}
            className="mono"
            title={k.title}
            data-terminal-key={k.key}
            disabled={sessionId === null || !alive}
            onClick={() => void send({ key: k.key })}
            style={btn}
          >
            {k.label}
          </button>
        ))}
        <button className="mono" title="Kill this shell and everything running in it" onClick={() => void killSession()} style={btn}>
          KILL
        </button>
        <button
          className="mono"
          title="Close this pane. The shell keeps running — anything in flight is untouched."
          onClick={onClose}
          style={btn}
        >
          ✕
        </button>
      </div>

      {error !== null && (
        <div
          data-terminal-error
          className="mono"
          style={{ fontSize: 11, color: tokens.bleed, padding: "5px 8px", borderBottom: `1px solid ${tokens.border}` }}
        >
          {error}
        </div>
      )}

      <pre
        ref={outRef}
        data-terminal-output
        className="mono"
        style={{
          flex: 1,
          margin: 0,
          padding: "8px 10px",
          overflow: "auto",
          fontSize: 12,
          lineHeight: 1.45,
          color: tokens.text,
          background: tokens.bgBody,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: 0,
        }}
      >
        {content}
      </pre>

      <div style={{ display: "flex", gap: 6, padding: 8, borderTop: `1px solid ${tokens.border}`, flex: "none" }}>
        <input
          ref={inputRef}
          data-terminal-input
          className="mono"
          value={input}
          disabled={sessionId === null || !alive}
          placeholder={alive ? "command, then Enter" : "this shell has exited"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "ArrowUp") {
              // Shell history lives in the shell, not here — a second history
              // in the browser would disagree with it the moment anything is
              // typed in the pane by an agent.
              e.preventDefault();
              void send({ key: "Up" });
            } else if (e.key === "Tab") {
              e.preventDefault();
              void send({ text: input, key: "Tab" });
              setInput("");
            }
          }}
          style={{
            flex: 1,
            fontSize: 12,
            padding: "6px 8px",
            borderRadius: 5,
            color: tokens.text,
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            outline: "none",
          }}
        />
        <button
          data-terminal-submit
          className="mono"
          disabled={busy || sessionId === null || !alive}
          onClick={() => void submit()}
          style={{ ...btn, padding: "6px 12px" }}
        >
          RUN
        </button>
      </div>
    </div>
  );
}
