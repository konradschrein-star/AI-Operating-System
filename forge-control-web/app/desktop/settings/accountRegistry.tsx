"use client";

/**
 * The Claude account registry — the data, the health rule, and one account's
 * card. Formerly `AccountsPanel.tsx`.
 *
 * ── Why there is no `AccountsPanel` any more (round 1876) ────────────────
 * Konrad: "the settings are still a bit confusing, especially with connecting
 * accounts, Claude accounts, like wiring them in and wiring in Google
 * accounts." A Claude login and a Google consent are the same kind of thing to
 * the person connecting them, and they sat in two settings sections that each
 * explained neither. `ConnectionsPanel` is now the one surface that lists them
 * — mounted in the shell AND at the `/settings` URL, so there is still exactly
 * one implementation with two entry points. What used to be the panel's body
 * lives on here as its two reusable halves:
 *
 *   `useAccountRegistry()`  the single /accounts client — fetch, 30s poll,
 *                           probe/enable actions, reload on completion.
 *   `AccountCard`           one account in full, with its own controls.
 *
 * ── The load-bearing rule, restated ─────────────────────────────────────
 * An account whose health is UNKNOWN renders AMBER, never green. An unprobed
 * account is not known to work, and showing it as healthy is how a dead
 * account went unnoticed for two months. `HEALTH_STYLE` is the only place that
 * mapping exists; `settings/connections.ts` reuses it for the row chips rather
 * than restating it.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { tokens } from "../../tokens";

export interface Account {
  slug: string;
  config_dir: string;
  login_email: string | null;
  /** Always `"configuration"`: the cheap-tier probe reads the credential file
   *  for presence only and never learns an address, so `login_email` was typed
   *  in, not verified. Rendered as CONFIGURED, never as a probe result. */
  login_email_source: "configuration";
  plan_label: string | null;
  priority: number;
  enabled: boolean;
  /** EFFECTIVE health — already demoted by the API when nothing measured it.
   *  See `effectiveHealth()` in forge-control/src/lib/account-health.ts. */
  health: "healthy" | "broken" | "unknown";
  health_detail: string | null;
  /** The raw `claude_accounts.health` column, before the demotion. */
  stored_health: "healthy" | "broken" | "unknown";
  /** True when `health` differs from `stored_health` — i.e. a positive word was
   *  demoted because no probe stands behind it. */
  health_downgraded: boolean;
  /** Age of the last probe in ms against the SERVER's clock, or null. */
  probe_age_ms: number | null;
  /** The server clock at the moment of the response. Ages are rendered against
   *  this, not `Date.now()`, so a skewed browser clock cannot invent or erase
   *  staleness. */
  measured_at: string;
  has_refresh: boolean | null;
  access_expires_at: string | null;
  last_probed_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  reauth_command: string;
}

export interface AccountsResponse {
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

export const HEALTH_STYLE: Record<Account["health"], { bg: string; fg: string; label: string }> = {
  healthy: { bg: tokens.freezeBgOk, fg: tokens.ok, label: "HEALTHY" },
  // Amber, never green. An unprobed or unexercised account is not known to
  // work, and showing it as healthy is how a dead account went unnoticed for
  // two months.
  unknown: { bg: tokens.freezeBgWarn, fg: tokens.warn, label: "UNKNOWN" },
  broken: { bg: tokens.dangerActionBg, fg: tokens.bleed, label: "BROKEN" },
};

export function accountAgo(iso: string | null): string {
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

/**
 * The probe age, in the words R45 asks for: `probed 4 min ago`.
 *
 * Measured against `probe_age_ms`, which the SERVER computed — not against the
 * browser's clock. A machine whose clock is minutes off would otherwise invent
 * staleness that does not exist, or hide staleness that does.
 *
 * `never probed` is not a decoration: it is the whole reason a positive state
 * cannot be shown. Never soften it to a dash.
 */
export function probeAge(a: Account): { label: string; absolute: string } {
  // `!Number.isFinite`, not `=== null`. An older forge-control — the API and
  // this build deploy separately — omits `probe_age_ms` entirely, and
  // `undefined === null` is false, so a strict null check let it through and
  // the row rendered `probed NaN d ago`. Observed in the browser on
  // 2026-08-18 while :7742 still held pre-fix code.
  //
  // Falling back to "never probed" is the SAFE direction and not a silent
  // default (N1): it under-claims. The alternative — assuming a fresh probe
  // because a field is missing — is the exact failure this phase exists to
  // abolish.
  if (!Number.isFinite(a.probe_age_ms) || !a.last_probed_at) {
    return { label: "never probed", absolute: "no probe on record" };
  }
  const ageMs = a.probe_age_ms as number;
  const absolute = new Date(a.last_probed_at).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  const m = Math.floor(ageMs / 60_000);
  if (m < 1) return { label: "probed just now", absolute };
  if (m < 60) return { label: `probed ${m} min ago`, absolute };
  const h = Math.floor(m / 60);
  if (h < 24) return { label: `probed ${h} h ago`, absolute };
  return { label: `probed ${Math.floor(h / 24)} d ago`, absolute };
}

/**
 * LAYER TWO of the R57 invariant, applied at the boundary where an account
 * becomes something rendered.
 *
 * Layer one is `effectiveHealth()` in `forge-control/src/lib/account-health.ts`,
 * called from `shape()` in `routes/accounts.ts`, so the API never emits a
 * positive health without a probe age. That is the right place for it and it is
 * unit-tested there.
 *
 * This exists because the API is not the only thing that can hand this surface
 * an account: an older forge-control (the web build and the API deploy
 * separately), a cached response, a fixture, or a future caller passing a raw
 * registry row straight into `claudeConnection()`. Every one of those routes
 * ends at a row chip, and a green chip on an unmeasured account is the exact
 * defect this phase exists to remove — photographed on 2026-08-18 at
 * `phase4/b4a-before-connections.png`.
 *
 * It only DOWNGRADES, and it agrees with layer one by construction: same rule,
 * same direction, `broken` untouched. When layer one has already fired this is
 * a no-op, which is why `check-settings-surface.tsx` drives a deliberately
 * un-demoted fixture through it — an unreachable guard needs its own control,
 * or nobody ever learns it stopped working.
 */
export function renderSafeAccount(a: Account): Account {
  if (a.last_probed_at !== null || a.health !== "healthy") return a;
  return {
    ...a,
    health: "unknown",
    health_downgraded: true,
    stored_health: a.stored_health ?? "healthy",
    health_detail:
      `never probed — the stored verdict "${a.health_detail ?? "healthy"}" has no ` +
      `measurement behind it. Press Probe now.`,
  };
}

/** What a mounted registry hands its renderer. `act` reloads on completion, so
 *  a probe's verdict lands without a second poll. */
export interface AccountRegistry {
  data: AccountsResponse | null;
  error: string | null;
  /** `"<slug>:probe"` / `"<slug>:toggle"` while that action is in flight. */
  busy: string | null;
  /** The verbatim failure of the LAST action — status code and server message.
   *  Never a friendly string (R58): Konrad cannot tell an expired token from a
   *  network outage if the UI paraphrases the upstream. */
  actionError: string | null;
  reload: () => Promise<void>;
  act: (slug: string, kind: "probe" | "toggle", body?: unknown) => Promise<void>;
  /** Register a config directory that ALREADY holds a `.credentials.json`.
   *  Resolves to the created row (which the API has already probed) or throws
   *  with the verbatim server message. */
  create: (input: {
    slug: string;
    config_dir: string;
    plan_label?: string | null;
    priority?: number;
  }) => Promise<Account>;
}

/** Reads the server's error shape without inventing one. Any 4xx/5xx from this
 *  API carries `{error, detail?, hint?}`; anything else is reported as the raw
 *  body so a proxy error page is still legible rather than swallowed. */
async function failureText(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { error?: string; detail?: string; hint?: string };
    const parts = [j.error, j.detail, j.hint].filter(Boolean);
    return `HTTP ${res.status} — ${parts.length ? parts.join(" · ") : raw.slice(0, 400)}`;
  } catch {
    return `HTTP ${res.status} — ${raw.slice(0, 400) || res.statusText}`;
  }
}

/** The one /accounts client. `ConnectionsPanel` mounts it exactly once, which
 *  is why that surface renders the account rows itself instead of embedding a
 *  second component that would poll the endpoint again. */
export function useAccountRegistry(): AccountRegistry {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError(null);
      try {
        const res = await fetch(
          kind === "probe"
            ? `/api/proxy/accounts/${slug}/probe`
            : `/api/proxy/accounts/${slug}`,
          {
            method: kind === "probe" ? "POST" : "PATCH",
            headers: { "content-type": "application/json" },
            body: kind === "probe" ? undefined : JSON.stringify(body),
          },
        );
        // Until this round the response was discarded entirely: a 503 from an
        // unreachable registry, or a 404 on a slug that had just been removed,
        // reloaded the list and looked exactly like success. A control that
        // cannot fail visibly is a control Konrad cannot trust (N1, R58).
        if (!res.ok) setActionError(`${kind} ${slug}: ${await failureText(res)}`);
        await load();
      } catch (e) {
        setActionError(`${kind} ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const create = useCallback<AccountRegistry["create"]>(
    async (input) => {
      setBusy("new:create");
      setActionError(null);
      try {
        const res = await fetch("/api/proxy/accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const message = await failureText(res);
          setActionError(`register ${input.slug}: ${message}`);
          throw new Error(message);
        }
        const created = (await res.json()) as Account & { probe_error?: string | null };
        // The registration succeeded; the PROBE that follows it may not have.
        // Reporting only the 201 is how "accepts a directory without probing
        // it" hides in plain sight (R46).
        if (created.probe_error) {
          setActionError(
            `registered ${input.slug}, but the probe failed: ${created.probe_error}`,
          );
        }
        await load();
        return created;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return { data, error, busy, actionError, reload: load, act, create };
}

/** One account, in full: identity, the evidence behind its health, its config
 *  directory, its probe/enable controls and — when it is broken — the exact
 *  re-auth command. Rendered under its Connections row. */
export function AccountCard({
  a,
  serving,
  busy,
  act,
}: {
  a: Account;
  serving: boolean;
  busy: string | null;
  act: AccountRegistry["act"];
}): JSX.Element {
  const hs = HEALTH_STYLE[a.health];
  const probed = probeAge(a);
  return (
    <div
      data-account-card={a.slug}
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
        {serving && (
          <span
            className="mono"
            style={{ fontSize: 10.5, color: tokens.accent }}
          >
            ● SERVING RUNS
          </span>
        )}
        {/* The health word and its clock, never apart. A verdict with no age is
            the defect this round exists to fix. */}
        <span
          className="mono"
          data-probe-age={a.slug}
          title={probed.absolute}
          style={{
            fontSize: 10.5,
            color: a.last_probed_at === null ? tokens.warn : tokens.textFaint,
          }}
        >
          {probed.label}
        </span>
        <span style={{ flex: 1 }} />
        <button
          data-probe-now={a.slug}
          data-busy={busy === `${a.slug}:probe` ? "true" : "false"}
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

      {a.health_downgraded && (
        <div
          data-health-downgraded={a.slug}
          style={{
            marginTop: 8,
            fontSize: 12,
            color: tokens.warn,
            lineHeight: 1.5,
          }}
        >
          The registry still stores <span className="mono">{a.stored_health}</span> for this account.
          It is shown as {HEALTH_STYLE[a.health].label} because nothing has measured it — a stored
          word is not a reading.
        </div>
      )}

      <div
        style={{
          display: "grid",
          // 195px, not 168: the fields now carry a provenance/absolute-time
          // second line, and an email in a 168px column wrapped into its
          // neighbour.
          gridTemplateColumns: "repeat(auto-fit, minmax(195px, 1fr))",
          gap: 12,
          marginTop: 14,
          fontSize: 12.5,
        }}
      >
        {/* CONFIGURED, not verified. The cheap-tier probe reads the credential
            file for presence only and never learns an address, so this is a
            value somebody typed in. Labelling it `IDENTITY` alone presented
            configuration as a probe result — the same lie in a smaller font
            (02-architecture.md §3). */}
        <Field
          label="IDENTITY (CONFIGURED)"
          value={a.login_email ?? "not recorded"}
          note="typed in, not returned by a probe"
        />
        <Field label="PLAN" value={a.plan_label ?? "—"} />
        {/* The signal that actually matters. An access-token
            countdown is deliberately NOT shown as health: those
            are ~8h tokens the refresh renews continuously. */}
        <Field label="LAST CONFIRMED RUN" value={accountAgo(a.last_ok_at)} />
        <Field label="LAST PROBED" value={probed.label} note={probed.absolute} />
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
        <PriorityField a={a} busy={busy} act={act} />
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
}

function Field({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  /** The secondary line — the absolute timestamp behind a relative age, or the
   *  provenance behind a value. Never a tooltip alone: a caveat that needs a
   *  hover is a caveat nobody reads. */
  note?: string;
}) {
  return (
    // `minWidth: 0` and a wrap rule: a grid item's default `min-width: auto`
    // refuses to shrink below its content, so a long unbroken value (an email
    // address) overflowed its column and ran into the next field's value —
    // rendering "media.asphaltaction@gmail.commax". Caught in the browser at
    // phase4/b4a-after-claude-accounts.png, not in the markup assertions,
    // which is what a screenshot is for.
    <div style={{ minWidth: 0 }}>
      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
        {label}
      </div>
      <div style={{ color: tokens.textBody, marginTop: 2, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {note && (
        <div
          className="mono"
          style={{ fontSize: 10, color: tokens.textGhost, marginTop: 2, overflowWrap: "anywhere" }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * Priority, editable in place (R47).
 *
 * Lower wins — the same rule `rankAccounts()` applies — so the control is
 * labelled with that rather than with arrows whose direction the reader has to
 * guess. It writes through the existing `PATCH /api/accounts/:slug`, which has
 * accepted `priority` since the registry was built; nothing ever invoked it,
 * which is why the number was display-only.
 */
function PriorityField({
  a,
  busy,
  act,
}: {
  a: Account;
  busy: string | null;
  act: AccountRegistry["act"];
}): JSX.Element {
  const pending = busy === `${a.slug}:toggle`;
  const step = (delta: number) =>
    void act(a.slug, "toggle", { priority: Math.max(0, a.priority + delta) });
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
        PRIORITY — LOWER WINS
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <button
          data-priority-down={a.slug}
          onClick={() => step(-10)}
          disabled={pending || a.priority === 0}
          style={stepBtn()}
          aria-label={`raise ${a.slug} in the order`}
        >
          −10
        </button>
        <span
          className="mono"
          data-priority-value={a.slug}
          style={{ color: tokens.textBody, minWidth: 26, textAlign: "center" }}
        >
          {a.priority}
        </span>
        <button
          data-priority-up={a.slug}
          onClick={() => step(10)}
          disabled={pending}
          style={stepBtn()}
          aria-label={`lower ${a.slug} in the order`}
        >
          +10
        </button>
      </div>
    </div>
  );
}

function stepBtn(): CSSProperties {
  return {
    background: tokens.toolBg,
    border: `1px solid ${tokens.border}`,
    borderRadius: 6,
    color: tokens.text,
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1.2,
    padding: "3px 7px",
  };
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
