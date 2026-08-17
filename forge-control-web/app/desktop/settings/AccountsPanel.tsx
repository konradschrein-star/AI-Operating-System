"use client";

/**
 * AccountsPanel — the Claude account registry, health and failover policy.
 *
 * This is the body that used to BE `app/settings/page.tsx` (git b02aa62). It
 * moved here so the same component can be mounted twice with no copy:
 *
 *   • in the shell, as the ACCOUNTS section of `SettingsSurface`;
 *   • at the `/settings` URL, which is now a thin page wrapper around it.
 *
 * The component renders body only — no page padding, no heading, no back
 * link. Whoever mounts it owns the chrome, because the chrome is exactly what
 * differs between a surface slot and a standalone route.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { tokens } from "../../tokens";

interface Account {
  slug: string;
  config_dir: string;
  login_email: string | null;
  plan_label: string | null;
  priority: number;
  enabled: boolean;
  health: "healthy" | "broken" | "unknown";
  health_detail: string | null;
  has_refresh: boolean | null;
  access_expires_at: string | null;
  last_probed_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  reauth_command: string;
}

interface AccountsResponse {
  accounts: Account[];
  summary: {
    total: number;
    enabled: number;
    healthy: number;
    unknown: number;
    broken: number;
    usable: number;
    serving: string | null;
  };
  policy: { mode: string; description: string };
  error?: string;
  detail?: string;
  hint?: string;
}

const HEALTH_STYLE: Record<Account["health"], { bg: string; fg: string; label: string }> = {
  healthy: { bg: tokens.freezeBgOk, fg: tokens.ok, label: "HEALTHY" },
  // Amber, never green. An unprobed or unexercised account is not known to
  // work, and showing it as healthy is how a dead account went unnoticed for
  // two months.
  unknown: { bg: tokens.freezeBgWarn, fg: tokens.warn, label: "UNKNOWN" },
  broken: { bg: tokens.dangerActionBg, fg: tokens.bleed, label: "BROKEN" },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AccountsPanel(): JSX.Element {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/accounts", {
        headers: { accept: "application/json" },
      });
      const json = (await res.json()) as AccountsResponse;
      if (!res.ok) {
        setError(json.detail ?? json.error ?? `${res.status}`);
        setData(null);
        return;
      }
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (slug: string, kind: "probe" | "toggle", body?: unknown) => {
      setBusy(`${slug}:${kind}`);
      try {
        await fetch(
          kind === "probe"
            ? `/api/proxy/accounts/${slug}/probe`
            : `/api/proxy/accounts/${slug}`,
          {
            method: kind === "probe" ? "POST" : "PATCH",
            headers: { "content-type": "application/json" },
            body: kind === "probe" ? undefined : JSON.stringify(body),
          },
        );
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <div data-accounts-panel>
      {error && (
        <div
          style={{
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 20,
            fontSize: 13,
          }}
        >
          <strong>Account registry unavailable.</strong>
          <div style={{ color: tokens.textSoft, marginTop: 4 }}>{error}</div>
          {data?.hint && (
            <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
              {data.hint}
            </div>
          )}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 18,
            }}
          >
            {[
              ["SERVING", data.summary.serving ?? "none", tokens.accent],
              ["HEALTHY", String(data.summary.healthy), tokens.ok],
              ["UNKNOWN", String(data.summary.unknown), tokens.warn],
              ["BROKEN", String(data.summary.broken), tokens.bleed],
            ].map(([label, value, colour]) => (
              <div
                key={label}
                style={{
                  background: tokens.bgCard,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 10,
                  padding: "10px 14px",
                  minWidth: 118,
                }}
              >
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: tokens.textLabel }}
                >
                  {label}
                </div>
                <div style={{ fontSize: 17, color: colour, marginTop: 3 }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          {data.accounts.map((a) => {
            const hs = HEALTH_STYLE[a.health];
            return (
              <div
                key={a.slug}
                style={{
                  background: tokens.bgCard,
                  border: `1px solid ${a.health === "broken" ? tokens.dangerActionBorder : tokens.border}`,
                  borderRadius: 12,
                  padding: 18,
                  marginBottom: 14,
                  opacity: a.enabled ? 1 : 0.62,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontSize: 17, fontWeight: 600 }}>{a.slug}</span>
                  <span
                    className="mono"
                    style={{
                      background: hs.bg,
                      color: hs.fg,
                      borderRadius: 5,
                      padding: "2px 7px",
                      fontSize: 10.5,
                    }}
                  >
                    {hs.label}
                  </span>
                  {!a.enabled && (
                    <span
                      className="mono"
                      style={{ fontSize: 10.5, color: tokens.textFaint }}
                    >
                      DISABLED
                    </span>
                  )}
                  {data.summary.serving === a.slug && (
                    <span
                      className="mono"
                      style={{ fontSize: 10.5, color: tokens.accent }}
                    >
                      ● SERVING RUNS
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() => void act(a.slug, "probe")}
                    disabled={busy === `${a.slug}:probe`}
                    style={btn(tokens.toolBg, tokens.border)}
                  >
                    {busy === `${a.slug}:probe` ? "probing…" : "Probe now"}
                  </button>
                  <button
                    onClick={() =>
                      void act(a.slug, "toggle", { enabled: !a.enabled })
                    }
                    disabled={busy === `${a.slug}:toggle`}
                    style={btn(
                      a.enabled ? tokens.dangerActionBg : tokens.okActionBg,
                      a.enabled
                        ? tokens.dangerActionBorder
                        : tokens.okActionBorder,
                    )}
                  >
                    {a.enabled ? "Disable" : "Enable"}
                  </button>
                </div>

                <div style={{ color: tokens.textSoft, fontSize: 13, marginTop: 8 }}>
                  {a.health_detail}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
                    gap: 10,
                    marginTop: 14,
                    fontSize: 12.5,
                  }}
                >
                  <Field label="IDENTITY" value={a.login_email ?? "—"} />
                  <Field label="PLAN" value={a.plan_label ?? "—"} />
                  {/* The signal that actually matters. An access-token
                      countdown is deliberately NOT shown as health: those
                      are ~8h tokens the refresh renews continuously. */}
                  <Field label="LAST CONFIRMED RUN" value={ago(a.last_ok_at)} />
                  <Field label="LAST PROBED" value={ago(a.last_probed_at)} />
                  <Field
                    label="REFRESH TOKEN"
                    value={
                      a.has_refresh === null
                        ? "not probed"
                        : a.has_refresh
                          ? "present"
                          : "MISSING"
                    }
                  />
                  <Field label="PRIORITY" value={String(a.priority)} />
                </div>

                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: tokens.textFaint,
                    marginTop: 12,
                  }}
                >
                  {a.config_dir}
                </div>

                {a.health === "broken" && (
                  <div
                    style={{
                      marginTop: 14,
                      background: tokens.bgGutter,
                      border: `1px solid ${tokens.borderSoft}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                      Re-authenticate this account (interactive — run it on the
                      VPS):
                    </div>
                    <code
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: tokens.textHi,
                        wordBreak: "break-all",
                      }}
                    >
                      {a.reauth_command}
                    </code>
                  </div>
                )}

                {a.last_error && (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 12,
                      color: tokens.bleed,
                      wordBreak: "break-word",
                    }}
                  >
                    {a.last_error}
                  </div>
                )}
              </div>
            );
          })}

          <div
            style={{
              background: tokens.invariantBg,
              border: `1px solid ${tokens.invariantBorder}`,
              borderRadius: 10,
              padding: "14px 16px",
              marginTop: 22,
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 10.5, color: tokens.textLabel, marginBottom: 6 }}
            >
              FAILOVER POLICY — {data.policy.mode.toUpperCase()}
            </div>
            <div style={{ color: tokens.textBody }}>{data.policy.description}</div>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
        {label}
      </div>
      <div style={{ color: tokens.textBody, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function btn(bg: string, border: string): CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 7,
    color: tokens.text,
    cursor: "pointer",
    fontSize: 12,
    padding: "5px 11px",
  };
}
