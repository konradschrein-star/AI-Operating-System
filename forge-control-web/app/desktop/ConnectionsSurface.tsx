"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  cancelConnection,
  fetchConnections,
  fetchConnectionSession,
  sendConnectionInput,
  startConnection,
  type ConnectionProvider,
  type LoginSession,
} from "../api";

const providerName: Record<string, string> = {
  claude: "Claude Code",
  agy: "Agy",
  codex: "Codex",
};

function stateFor(p: ConnectionProvider): { text: string; color: string } {
  if (p.connected) return { text: "connected", color: tokens.ok };
  if (!p.installed && p.configured === false) return { text: "not configured", color: tokens.textFaint };
  if (!p.installed) return { text: "not installed", color: tokens.bleed };
  return { text: "sign-in required", color: tokens.warn };
}

export function ConnectionsSurface() {
  const connections = useQuery({ queryKey: ["connections"], queryFn: fetchConnections, refetchInterval: 15_000 });
  const qc = useQueryClient();
  const [active, setActive] = useState<"claude" | "codex" | null>(null);
  const [session, setSession] = useState<LoginSession | null>(null);
  const [input, setInput] = useState("");

  const start = useMutation({
    mutationFn: (id: "claude" | "codex") => startConnection(id),
    onSuccess: (value, id) => { setActive(id); setSession(value); },
  });

  const sessionQ = useQuery({
    queryKey: ["connection-session", active],
    queryFn: () => fetchConnectionSession(active!),
    enabled: !!active,
    refetchInterval: (q) => q.state.data?.active ? 1_000 : false,
  });
  useEffect(() => { if (sessionQ.data) setSession(sessionQ.data); }, [sessionQ.data]);
  useEffect(() => {
    if (session && !session.active) void qc.invalidateQueries({ queryKey: ["connections"] });
  }, [session, qc]);

  const submit = useMutation({
    mutationFn: () => sendConnectionInput(active!, input.endsWith("\n") ? input : `${input}\n`),
    onSuccess: (value) => { setSession(value); setInput(""); },
  });

  const providers = connections.data?.providers ?? [];
  const authUrl = session?.output?.match(/https?:\/\/[^\s<>"')\]]+/)?.[0] ?? null;
  return (
    <div style={{ maxWidth: 980, padding: "28px 30px 48px" }}>
      <div className="mono" style={{ color: tokens.accent, fontSize: 10, letterSpacing: "0.12em" }}>SETTINGS / CONNECTIONS</div>
      <h1 style={{ color: tokens.textHi, fontSize: 23, fontWeight: 500, margin: "10px 0 8px" }}>Runtime connections</h1>
      <p style={{ color: tokens.textSecondary, maxWidth: 700, margin: 0, lineHeight: 1.55 }}>
        Connect the fixed AI runtimes from here. This is a scoped authentication panel, not a general server terminal.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 24 }}>
        {providers.map((p) => {
          const state = stateFor(p);
          const canConnect = (p.id === "claude" || p.id === "codex") && p.installed;
          return <div key={p.id} style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, background: tokens.bgCard, padding: 15 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={dot(state.color)} /><span className="mono" style={{ color: tokens.text, fontSize: 12 }}>{providerName[p.id]}</span>
            </div>
            <div className="mono" style={{ color: state.color, fontSize: 10.5, marginTop: 9 }}>{state.text}</div>
            <div style={{ color: tokens.textFaint, fontSize: 11, marginTop: 7 }}>Usage: provider does not expose a live quota API.</div>
            {canConnect && <button onClick={() => start.mutate(p.id as "claude" | "codex")} disabled={start.isPending} style={buttonStyle}>
              {p.connected ? "reconnect" : `connect ${p.id}`}
            </button>}
          </div>;
        })}
      </div>

      <div style={{ marginTop: 15, border: `1px solid ${connections.data?.skills.ready ? tokens.ok : tokens.warn}`, borderRadius: 8, padding: "12px 15px", color: tokens.textSecondary, fontSize: 12 }}>
        Skills: <span style={{ color: connections.data?.skills.ready ? tokens.ok : tokens.warn }}>{connections.data?.skills.ready ? "ready" : "missing"}</span>
        <span className="mono" style={{ color: tokens.textFaint, marginLeft: 10 }}>{connections.data?.skills.root ?? "checking…"}</span>
      </div>

      {active && <div style={{ marginTop: 24, border: `1px solid ${tokens.accent}`, borderRadius: 8, overflow: "hidden", background: "#09090b" }}>
        <div style={{ padding: "10px 13px", borderBottom: `1px solid ${tokens.border}`, display: "flex", alignItems: "center" }}>
          <span className="mono" style={{ color: tokens.accent, fontSize: 11 }}>{active} secure login</span><span style={{ flex: 1 }} />
          <button onClick={() => cancelConnection(active).then(() => { setSession({ active: false }); setActive(null); })} style={quietButtonStyle}>cancel</button>
        </div>
        {authUrl && <div style={{ padding: "10px 13px", borderBottom: `1px solid ${tokens.border}`, background: tokens.primaryActionBg }}>
          <a href={authUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: tokens.accent, fontSize: 11 }}>open secure {active} authentication ↗</a>
        </div>}
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", minHeight: 150, maxHeight: 360, overflowY: "auto", margin: 0, padding: 14, color: tokens.textSecondary, fontSize: 11.5, lineHeight: 1.5 }}>{session?.output ?? "Opening login session…"}</pre>
        {session?.active && <form onSubmit={(e) => { e.preventDefault(); if (input) submit.mutate(); }} style={{ padding: 10, borderTop: `1px solid ${tokens.border}`, display: "flex", gap: 8 }}>
          <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Enter the menu choice or confirmation shown above" className="mono" style={inputStyle} />
          <button type="submit" disabled={!input || submit.isPending} style={buttonStyle}>send</button>
        </form>}
        {session && !session.active && <div className="mono" style={{ padding: 10, color: tokens.textFaint, fontSize: 10.5 }}>Session ended. Connection status is refreshing.</div>}
      </div>}
    </div>
  );
}

const buttonStyle = { marginTop: 14, padding: "7px 10px", borderRadius: 5, border: `1px solid ${tokens.accent}`, color: tokens.accent, background: tokens.primaryActionBg, cursor: "pointer", fontSize: 11 };
const quietButtonStyle = { padding: "4px 7px", border: "none", color: tokens.textFaint, background: "transparent", cursor: "pointer", fontSize: 11 };
const inputStyle = { flex: 1, background: "transparent", border: `1px solid ${tokens.borderEmphasis}`, borderRadius: 5, padding: "7px 9px", color: tokens.text, outline: "none", fontSize: 11.5 };
