"use client";

/**
 * ConnectionsPanel — every account this OS holds, in one surface. Round 1876.
 *
 * Konrad: "the settings are still a bit confusing, especially with connecting
 * accounts, Claude accounts, like wiring them in and wiring in Google
 * accounts. I want to be able to do that also."
 *
 * ── What was confusing ───────────────────────────────────────────────────
 * Two sections that never introduced themselves. ACCOUNTS opened straight into
 * a Claude registry with health chips and a failover policy; INTEGRATIONS
 * opened into a Gemini key field and a Google credential dump. Neither said
 * what the thing was, whether it was connected, or what to type to connect it
 * — and the subscription he actually asked about (Google AI Ultra) appeared in
 * neither.
 *
 * ── The shape ────────────────────────────────────────────────────────────
 * One list. Every connection — a Claude login, the Google consent, the Gemini
 * key, the Ultra subscription — is a ROW answering the same five questions in
 * the same order: what it is · connected? · which identity · health · the
 * exact action. Expand a row and the full existing card is underneath it,
 * unchanged: the same probe/test/save controls, the same command blocks.
 *
 * ── Rules kept, deliberately ─────────────────────────────────────────────
 *  • UNKNOWN IS AMBER, NEVER GREEN. An unprobed Claude account is not known to
 *    work. `connections.ts` decides the words, `accountRegistry.HEALTH_STYLE`
 *    the colours, and neither has a second copy. Showing an unprobed account
 *    as healthy is how a dead account went unnoticed for two months.
 *  • RE-AUTH IS A COMMAND, NOT A BUTTON. `setup.py` is interactive and blocks
 *    on a localhost:8765 redirect; `agy` opens a browser or prints a device
 *    code. A button that cannot finish the job is a fake success state, so the
 *    row prints the exact line to run instead.
 *  • ONE FETCH PER SUBJECT. The rows do not fetch. The account registry is
 *    `useAccountRegistry()`, mounted once here; the Gemini and Google cards
 *    report their loaded state upward through `onFacts`; the Ultra row reads
 *    the indicator row's shared quota cache entry and costs nothing at all.
 *    The detail bodies stay MOUNTED and are hidden with CSS, so expanding a
 *    row is free and collapsing one does not throw its reading away.
 *
 * Tokens only, both themes. Hover affordance is a scoped stylesheet, not React
 * state — the same rule the rest of this surface follows.
 */

import { useCallback, useMemo, useState, type CSSProperties, type JSX } from "react";
import { tokens } from "../../tokens";
import {
  AccountCard,
  HEALTH_STYLE,
  probeAge,
  renderSafeAccount,
  useAccountRegistry,
  type AccountRegistry,
} from "./accountRegistry";
import {
  GeminiCard,
  GoogleCard,
  type GeminiKeyFacts,
} from "./integrationCards";
import {
  claudeConnection,
  geminiKeyConnection,
  googleConnection,
  ultraConnection,
  type ConnectionState,
  type ConnectionSummary,
  type GoogleFacts,
} from "./connections";
import { useQuotaSnapshot } from "../quota/quotaQuery";

/** Chip colours per state. `unknown` reuses the account registry's amber pair
 *  so the two surfaces cannot disagree about what "not known to work" looks
 *  like; `absent` is deliberately neutral — nothing is wrong with a connection
 *  that was never made, it simply is not there. */
const STATE_SKIN: Record<ConnectionState, { fg: string; bg: string }> = {
  connected: { fg: HEALTH_STYLE.healthy.fg, bg: HEALTH_STYLE.healthy.bg },
  unknown: { fg: HEALTH_STYLE.unknown.fg, bg: HEALTH_STYLE.unknown.bg },
  broken: { fg: HEALTH_STYLE.broken.fg, bg: HEALTH_STYLE.broken.bg },
  absent: { fg: tokens.textFaint, bg: tokens.bgGutter },
};

const PANEL_CSS = `
[data-connections-panel] .conn-head {
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
[data-connections-panel] .conn-head:hover,
[data-connections-panel] .conn-head:focus-visible {
  background: ${tokens.rowHover};
  border-color: ${tokens.borderEmphasis};
}
@media (prefers-reduced-motion: reduce) {
  [data-connections-panel] .conn-head { transition: none; }
}
`;

export function ConnectionsPanel(): JSX.Element {
  const registry = useAccountRegistry();
  const [gemini, setGemini] = useState<GeminiKeyFacts | null>(null);
  const [google, setGoogle] = useState<GoogleFacts | null>(null);
  // The Ultra row rides the indicator row's cache entry — an observer, not a
  // poll. See desktop/quota/quotaQuery.ts.
  const quota = useQuotaSnapshot();

  const [open, setOpen] = useState<string | null>(null);
  const toggle = useCallback(
    (id: string) => setOpen((cur) => (cur === id ? null : id)),
    [],
  );

  return (
    <div data-connections-panel style={{ maxWidth: 940 }}>
      <style>{PANEL_CSS}</style>

      <div
        style={{
          fontSize: 12.5,
          color: tokens.textSoft,
          lineHeight: 1.55,
          marginBottom: 16,
        }}
      >
        Every account this machine holds, and what state it is actually in.
        Expand a row for its controls.{" "}
        <strong style={{ color: tokens.warn }}>Amber means unknown</strong> — an
        account nobody has probed is not known to work, so it is never shown as
        healthy. Where connecting needs a human at a browser, the row prints the
        exact command instead of a button that could not finish the job.
      </div>

      {registry.error && (
        <div
          style={{
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 10,
            padding: "12px 14px",
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong>Claude account registry unavailable.</strong>
          <div style={{ color: tokens.textSoft, marginTop: 4 }}>
            {registry.error}
          </div>
        </div>
      )}

      <ClaudeAccountsSection registry={registry} open={open} onToggle={toggle} />

      {registry.data && (
        <div
          style={{
            /* The neutral gutter surface, NOT `invariantBg`: that token is a
               warm pink in the light palette, and a policy statement sitting
               between two account rows in warning colours reads as a problem
               with the accounts. Same call, same reason, as the integration
               cards' `info` banner. Verified in both themes. */
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 10,
            padding: "12px 14px",
            margin: "4px 0 22px",
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 10.5, color: tokens.textLabel, marginBottom: 5 }}
          >
            FAILOVER POLICY — {registry.data.policy.mode.toUpperCase()}
          </div>
          <div style={{ color: tokens.textBody }}>
            {registry.data.policy.description}
          </div>
        </div>
      )}

      <GroupLabel
        text="GOOGLE — one consent, every Google tool"
        note="Gmail · Calendar · Drive · Docs · Sheets · Contacts"
      />
      <Row
        summary={googleConnection(google)}
        open={open === "google"}
        onToggle={toggle}
      >
        <GoogleCard onFacts={setGoogle} />
      </Row>

      <GroupLabel
        text="GEMINI — two different products, wired separately"
        note="a billed API key · and the Ultra subscription"
      />
      <Row
        summary={geminiKeyConnection(
          gemini?.present ?? null,
          gemini?.masked ?? null,
          gemini?.verdict ?? null,
        )}
        open={open === "gemini-key"}
        onToggle={toggle}
      >
        <GeminiCard onFacts={setGemini} />
      </Row>
      <Row
        summary={ultraConnection(quota.data?.gemini)}
        open={open === "gemini-ultra"}
        onToggle={toggle}
      >
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 12,
            padding: 18,
            marginBottom: 16,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: tokens.textBody,
          }}
        >
          <div>
            <strong>There is no bar to draw here, and that is a finding, not
            an omission.</strong>{" "}
            {quota.data?.gemini?.no_limit_note ??
              "Google publishes no quota endpoint for an AI Ultra subscription."}{" "}
            The Gemini API&rsquo;s discovery document has no quota resource, the
            credits API that once had one was switched off for consumer accounts
            on 2026-06-18, and the remaining-credit figure now exists only
            inside the Antigravity CLI&rsquo;s own <span className="mono">/usage</span>{" "}
            panel. The indicator row therefore shows what THIS box counted, with
            no denominator — never a percentage of a limit nobody published.
          </div>
          <div style={{ marginTop: 8, color: tokens.textSoft }}>
            {quota.data?.gemini?.auth_note ?? "Tally not read yet."}
          </div>
        </div>
      </Row>
    </div>
  );
}

/**
 * The Claude half of the panel — every registered login, its probe age, its
 * controls, and the add flow.
 *
 * ── WHY THIS TAKES ITS REGISTRY AS A PROP ────────────────────────────────
 * `ConnectionsPanel` mounts `useAccountRegistry()` once and passes the result
 * down, which is the same one-fetch-per-subject rule the rest of this surface
 * follows. It also gives `scripts/checks/check-settings-surface.tsx` a real
 * seam: that harness renders with `react-dom/server`, where `useEffect` never
 * runs and no fetch can ever resolve, so a self-fetching component is
 * permanently stuck at its loading state and the health rules cannot be
 * asserted at all. Injecting the registry lets the check drive FIXTURES through
 * the exact component Konrad looks at — including the one state that matters
 * most and cannot occur on demand in production: a stored `healthy` with no
 * probe behind it.
 *
 * This is dependency injection at a seam that already existed, not test-only
 * plumbing bolted onto production code: the panel above was already the single
 * owner of the fetch.
 */
export function ClaudeAccountsSection({
  registry,
  open,
  onToggle,
}: {
  registry: AccountRegistry;
  open: string | null;
  onToggle: (id: string) => void;
}): JSX.Element {
  // LAYER TWO of R57, applied once, here — before an account reaches either
  // `claudeConnection()` (which decides the row's words and belongs to another
  // task) or `AccountCard`. Fixing it at this boundary means both consumers get
  // a truthful row without either of them having to re-derive the rule.
  const accounts = (registry.data?.accounts ?? []).map(renderSafeAccount);
  const serving = registry.data?.summary.serving ?? null;

  return (
    <>
      <GroupLabel
        text="CLAUDE — the logins that run your agents"
        note={
          registry.data
            ? `${registry.data.summary.usable} usable of ${registry.data.summary.total} · serving ${serving ?? "none"}`
            : "loading…"
        }
      />
      {registry.data && accounts.length === 0 && (
        <Empty text="No Claude account is registered. Runs cannot execute until one is." />
      )}
      {registry.actionError && (
        <div
          data-account-action-error
          style={{
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 12,
            fontSize: 12.5,
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, color: tokens.textLabel }}>
            LAST ACTION FAILED —{" "}
          </span>
          {registry.actionError}
        </div>
      )}
      {accounts.map((a) => (
        <Row
          key={a.slug}
          summary={claudeConnection(a, serving === a.slug)}
          open={open === `claude:${a.slug}`}
          onToggle={onToggle}
          // R45: the health word never travels without its clock, and the age
          // sits on the COLLAPSED head — the only thing visible before a click.
          probe={{
            label: probeAge(a).label,
            absolute: probeAge(a).absolute,
            unmeasured: a.last_probed_at === null,
          }}
          // R58: the verbatim upstream error, on the head, not buried in the
          // expanded card. Konrad must be able to tell an expired token from a
          // network outage without opening anything.
          verbatimError={a.last_error}
        >
          <AccountCard
            a={a}
            serving={serving === a.slug}
            busy={registry.busy}
            act={registry.act}
          />
        </Row>
      ))}
      <AddAccount registry={registry} />
      {registry.data && (
        <div
          style={{
            fontSize: 12,
            color: tokens.textFaint,
            lineHeight: 1.55,
            margin: "2px 2px 4px",
          }}
        >
          Every Claude row above carries the age of its last probe. A row that has never been
          probed reads <strong style={{ color: tokens.warn }}>UNKNOWN</strong> whatever the
          registry stores for it — a word written once is not a reading.
        </div>
      )}
    </>
  );
}

/**
 * Add a Claude account — and be honest about what that means (R46).
 *
 * ── THERE IS NO BROWSER OAUTH FLOW, AND THE UI MUST NOT IMPLY ONE ────────
 * The AI OS cannot log a Claude account in. A Claude Code session is created by
 * `claude auth login --claudeai` running INTERACTIVELY ON THIS BOX, which opens
 * a browser and writes `<config dir>/.credentials.json`. All this form does is
 * REGISTER a directory that already holds that file.
 *
 * So the flow is: show the exact command → Konrad runs it on the VPS → he pastes
 * the directory here → we register it → we PROBE it → we show the probed
 * health. A "Sign in with Claude" button would be a fake success state, and a
 * UI implying a flow that does not exist is a worse lie than the one this phase
 * is fixing.
 *
 * The command is not a constant: it is recomputed from the directory as it is
 * typed, matching `reauth_command` in routes/accounts.ts exactly (bare
 * `claude auth login --claudeai` for /root/.claude, `CLAUDE_CONFIG_DIR=<dir>`
 * in front of it otherwise). A copyable line that names the wrong directory is
 * worse than no line at all.
 */
function AddAccount({ registry }: { registry: AccountRegistry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [dir, setDir] = useState("");
  const [copied, setCopied] = useState(false);

  const command = useMemo(
    () =>
      dir.trim() === "" || dir.trim() === "/root/.claude"
        ? "claude auth login --claudeai"
        : `CLAUDE_CONFIG_DIR=${dir.trim()} claude auth login --claudeai`,
    [dir],
  );

  const submit = useCallback(async () => {
    // The registry surfaces the verbatim failure through `actionError`; this
    // catch exists only so a rejected promise does not become an unhandled
    // rejection. It deliberately swallows NOTHING that the user would not
    // otherwise see.
    const created = await registry
      .create({ slug: slug.trim(), config_dir: dir.trim() })
      .catch(() => null);
    if (created) {
      setSlug("");
      setDir("");
      setOpen(false);
    }
  }, [registry, slug, dir]);

  if (!open) {
    return (
      <button
        type="button"
        data-add-account-open
        onClick={() => setOpen(true)}
        style={{
          background: tokens.toolBg,
          border: `1px dashed ${tokens.borderSoft}`,
          borderRadius: 10,
          color: tokens.textBody,
          cursor: "pointer",
          fontSize: 12.5,
          padding: "10px 14px",
          marginBottom: 12,
          textAlign: "left",
          width: "100%",
          font: "inherit",
        }}
      >
        + Add a Claude account —{" "}
        <span style={{ color: tokens.textFaint }}>
          registers a config directory you have already logged in on this box
        </span>
      </button>
    );
  }

  const canSubmit =
    slug.trim().length > 0 && dir.trim().startsWith("/") && registry.busy !== "new:create";

  return (
    <div
      data-add-account-form
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: 18,
        marginBottom: 12,
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi, marginBottom: 6 }}>
        Add a Claude account
      </div>
      <div style={{ color: tokens.textSoft }}>
        This OS <strong>cannot log a Claude account in for you</strong>. There is no browser consent
        to click here. A session is created by running the Claude CLI interactively on this VPS,
        which writes <span className="mono">.credentials.json</span> into a config directory. This
        form registers a directory that <strong>already holds that file</strong>, then probes it and
        shows what the probe found.
      </div>

      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel, margin: "14px 0 5px" }}>
        STEP 1 — RUN THIS ON THE VPS, IN A REAL TERMINAL
      </div>
      <div
        style={{
          background: tokens.bgGutter,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <code
          className="mono"
          data-add-account-command
          style={{ fontSize: 12, color: tokens.textHi, wordBreak: "break-all", flex: 1 }}
        >
          {command}
        </code>
        <button
          type="button"
          data-add-account-copy
          onClick={() => {
            void navigator.clipboard?.writeText(command);
            setCopied(true);
          }}
          style={smallBtn()}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel, margin: "14px 0 5px" }}>
        STEP 2 — REGISTER THE DIRECTORY IT WROTE
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <label style={{ display: "block" }}>
          <span className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
            SLUG
          </span>
          <input
            data-add-account-slug
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. konrad-second"
            style={input()}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
            CONFIG DIRECTORY (ABSOLUTE)
          </span>
          <input
            data-add-account-dir
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="/root/.claude-second"
            style={input()}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button
          type="button"
          data-add-account-submit
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{
            ...smallBtn(),
            background: canSubmit ? tokens.okActionBg : tokens.toolBg,
            border: `1px solid ${canSubmit ? tokens.okActionBorder : tokens.border}`,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {registry.busy === "new:create" ? "registering and probing…" : "Register and probe"}
        </button>
        <button type="button" data-add-account-cancel onClick={() => setOpen(false)} style={smallBtn()}>
          Cancel
        </button>
        <span style={{ color: tokens.textFaint, fontSize: 11.5 }}>
          Registration always probes. The row you get back shows the health the probe measured, not
          a hopeful default.
        </span>
      </div>
    </div>
  );
}

function input(): CSSProperties {
  return {
    background: tokens.bgGutter,
    border: `1px solid ${tokens.border}`,
    borderRadius: 7,
    color: tokens.text,
    display: "block",
    fontSize: 12.5,
    marginTop: 3,
    padding: "6px 9px",
    width: "100%",
  };
}

function smallBtn(): CSSProperties {
  return {
    // `font` FIRST: it is a shorthand and would reset `fontSize` if it came
    // after. React writes inline styles in key order, so the order here is the
    // order the browser sees.
    font: "inherit",
    background: tokens.toolBg,
    border: `1px solid ${tokens.border}`,
    borderRadius: 7,
    color: tokens.text,
    cursor: "pointer",
    fontSize: 12,
    padding: "5px 11px",
  };
}

function GroupLabel({ text, note }: { text: string; note?: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
        margin: "18px 2px 8px",
      }}
    >
      <span
        className="mono"
        style={{ fontSize: 10, letterSpacing: "0.05em", color: tokens.textLabel }}
      >
        {text}
      </span>
      {note && (
        <span className="mono" style={{ fontSize: 10.5, color: tokens.textGhost }}>
          {note}
        </span>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div
      style={{
        border: `1px dashed ${tokens.borderSoft}`,
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 12.5,
        color: tokens.textFaint,
        marginBottom: 10,
      }}
    >
      {text}
    </div>
  );
}

/** One connection. The head is the five-question summary; the body is whatever
 *  card already owned this subject, kept mounted and hidden when collapsed so
 *  no reading is thrown away by a click. */
function Row({
  summary,
  open,
  onToggle,
  probe,
  verbatimError,
  children,
}: {
  summary: ConnectionSummary;
  open: boolean;
  onToggle: (id: string) => void;
  /** The age of the reading behind `summary.state`. Optional only because the
   *  non-Claude rows are B4b/B4c's to wire; a Claude row always passes it. */
  probe?: { label: string; absolute: string; unmeasured: boolean };
  /** The upstream failure, VERBATIM — status code and message (R58). */
  verbatimError?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  const skin = STATE_SKIN[summary.state];
  return (
    <div
      data-connection-row={summary.id}
      data-connection-state={summary.state}
      style={{ marginBottom: 10 }}
    >
      <button
        type="button"
        className="conn-head"
        data-row-toggle={summary.id}
        aria-expanded={open}
        onClick={() => onToggle(summary.id)}
        style={headStyle(open)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
            {summary.title}
          </span>
          <span
            className="mono"
            data-connection-chip
            style={{
              background: skin.bg,
              color: skin.fg,
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
            }}
          >
            {summary.stateLabel}
          </span>
          {probe && (
            <span
              className="mono"
              data-connection-probe-age
              title={probe.absolute}
              style={{
                fontSize: 10.5,
                color: probe.unmeasured ? tokens.warn : tokens.textFaint,
              }}
            >
              {probe.label}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 11, color: tokens.textGhost }}>
            {open ? "▾ hide" : "▸ open"}
          </span>
        </div>

        <div style={{ fontSize: 12.5, color: tokens.textSoft, lineHeight: 1.5 }}>
          {summary.what}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: 10,
            fontSize: 12,
          }}
        >
          <Cell label="IDENTITY" value={summary.identity} />
          <Cell label="HEALTH" value={summary.health} />
        </div>

        <div
          style={{
            fontSize: 12,
            color: tokens.textBody,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            padding: "8px 10px",
            lineHeight: 1.5,
          }}
        >
          <span className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
            TO CONNECT / REPAIR{" "}
          </span>
          <span data-connection-action>{summary.action}</span>
        </div>

        {/* R58 — VERBATIM. Status code and message, exactly as the upstream
            sent them. A friendly string here ("probe failed") is precisely what
            makes an expired token indistinguishable from a network outage. */}
        {verbatimError && (
          <div
            data-connection-error
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.bleed,
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 8,
              padding: "8px 10px",
              lineHeight: 1.45,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {verbatimError}
          </div>
        )}
      </button>

      {/* Kept mounted: its fetch already happened, and a collapse must not
          throw the reading away or re-request it on the next click. */}
      <div style={{ display: open ? "block" : "none", marginTop: 10 }}>
        {children}
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel }}>
        {label}
      </div>
      <div style={{ color: tokens.textBody, marginTop: 2, lineHeight: 1.45 }}>
        {value}
      </div>
    </div>
  );
}

function headStyle(open: boolean): CSSProperties {
  return {
    width: "100%",
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: open ? tokens.selectedBg : tokens.bgCard,
    border: `1px solid ${open ? tokens.borderEmphasis : tokens.border}`,
    borderRadius: 12,
    padding: "14px 16px",
    cursor: "pointer",
    color: tokens.text,
    font: "inherit",
  };
}
