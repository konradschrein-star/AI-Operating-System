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

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from "react";
import { tokens } from "../../tokens";
import { probeAllConnections, type ProbeAllResponse } from "../../api-connections";
import {
  AccountCard,
  HEALTH_STYLE,
  probeAge,
  renderSafeAccount,
  useAccountRegistry,
  type AccountRegistry,
} from "./accountRegistry";
import {
  AgyCard,
  GeminiCard,
  GeminiCliCard,
  GitHubCard,
  GoogleCard,
  input,
  type GeminiKeyFacts,
} from "./integrationCards";
import {
  agyConnection,
  claudeConnection,
  fetchFleetDefaultTier,
  geminiCliConnection,
  geminiKeyConnection,
  githubConnection,
  googleConnection,
  isReadFailure,
  ultraConnection,
  updateFleetDefaultTier,
  type AgyFacts,
  type ConnectionState,
  type ConnectionSummary,
  type FleetDefaultTierSetting,
  type GeminiCliFacts,
  type GithubFacts,
  type GoogleFacts,
  type Read,
} from "./connections";
import { CliAuthConnect } from "./CliAuthConnect";
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
  // `Read<…>`, not `… | null`: a card whose fetch REJECTED reports the reason
  // upward instead of staying silent, and the row head renders READ FAILED
  // with that reason rather than READING… for as long as the tab is open
  // (R5-gate item 3). `null` still means "in flight" and nothing else.
  const [google, setGoogle] = useState<Read<GoogleFacts>>(null);
  // Reported UPWARD by the cards, exactly as Gemini and Google already do —
  // one fetch per subject. `agy` is read twice on this panel (its own row and
  // the Ultra row) and fetched once, which is what makes the two rows
  // structurally incapable of disagreeing.
  const [agy, setAgy] = useState<Read<AgyFacts>>(null);
  const [geminiCli, setGeminiCli] = useState<Read<GeminiCliFacts>>(null);
  const [github, setGithub] = useState<Read<GithubFacts>>(null);
  // The Ultra row rides the indicator row's cache entry — an observer, not a
  // poll. See desktop/quota/quotaQuery.ts.
  const quota = useQuotaSnapshot();

  /* Rendered ONCE, and the verbatim-error box below is gated on the RENDERED
   * state rather than on the server's. They differ exactly when the client's
   * staleness rule demotes a stored failure to UNKNOWN (R51) — and a red
   * upstream error box beside an amber chip is a row disagreeing with itself,
   * which is the shape of defect this phase exists to remove. The failure text
   * is not lost: `summary.health` carries it, prefixed with why it is stale. */
  const agySummary = agyConnection(agy);
  const geminiCliSummary = geminiCliConnection(geminiCli);
  const githubSummary = githubConnection(github);

  /* A read that FAILED carries no `status`, so it has no upstream text to show
   * verbatim in that box — and it never renders `broken` anyway, so this only
   * narrows the type to the arm the box was written for. The reason is not
   * lost: `summary.health` prints it, which is the whole point of item 3. */
  const agyFacts = isReadFailure(agy) ? null : agy;
  const geminiCliFacts = isReadFailure(geminiCli) ? null : geminiCli;
  const githubFacts = isReadFailure(github) ? null : github;

  const [open, setOpen] = useState<string | null>(null);
  const toggle = useCallback(
    (id: string) => setOpen((cur) => (cur === id ? null : id)),
    [],
  );

  /* PROBE ALL — one press, every probe this box can run unattended.
   *
   * `POST /api/integrations/probe-all` fans out to Google, agy and GitHub in
   * parallel and persists each record, so what comes back is three real
   * readings rather than three cached words. Three, not six: a Claude account
   * is probed through the account registry's own verb, and the two Gemini
   * subjects cost either money (a live `generateContent`) or a 60-second
   * interactive window (`agy`), so neither belongs in a batch fired by one
   * click. The strip below names what was probed, so the set is on screen
   * rather than assumed.
   *
   * `reloadKey` is what makes the ROWS agree with the batch: the cards own
   * their own reads (one fetch per subject) and would otherwise keep showing
   * the pre-probe state. See RELOAD_KEY_CONTRACT in integrationCards.tsx. */
  const [probeAll, setProbeAll] = useState<ProbeAllResponse | null>(null);
  const [probeAllError, setProbeAllError] = useState<string | null>(null);
  const [probingAll, setProbingAll] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const runProbeAll = useCallback(async () => {
    setProbingAll(true);
    setProbeAllError(null);
    try {
      const res = await probeAllConnections();
      setProbeAll(res);
      // Only after a real answer: a bump on failure would re-read three
      // endpoints for nothing and make a failed batch look like activity.
      setReloadKey((k) => k + 1);
    } catch (e) {
      // Verbatim (R58). `ConnectionApiError` carries the HTTP status and the
      // body forge-control wrote, and both are the diagnostic.
      setProbeAllError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbingAll(false);
    }
  }, []);

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

      <ProbeAllBar
        busy={probingAll}
        result={probeAll}
        error={probeAllError}
        onRun={() => void runProbeAll()}
      />

      <FleetDefaultEngineSection />

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
        <GoogleCard onFacts={setGoogle} reloadKey={reloadKey} />
      </Row>

      <GroupLabel
        text="GEMINI — three different products, wired separately"
        note="a billed API key · a signed-in CLI on this box · and the Ultra subscription behind the agy CLI"
      />
      <Row
        summary={geminiKeyConnection(
          gemini?.present ?? null,
          gemini?.masked ?? null,
          gemini?.verdict ?? null,
          gemini?.readError ?? null,
        )}
        open={open === "gemini-key"}
        onToggle={toggle}
      >
        <GeminiCard onFacts={setGemini} />
      </Row>
      {/* THE ROW THAT DID NOT EXIST. `GET /gemini` is the API key; the CLI's
          own Google session had no row at all, so there was nothing on this
          surface to put a Connect button on and no way to see that it had
          never been signed in. One more subject, the same renderer. */}
      <Row
        summary={geminiCliSummary}
        open={open === "gemini-cli"}
        onToggle={toggle}
        verbatimError={
          geminiCliSummary.state === "broken" ? geminiCliFacts?.status.detail ?? null : null
        }
      >
        <GeminiCliCard onFacts={setGeminiCli} />
      </Row>
      <Row
        summary={ultraConnection(quota.data?.gemini, agy)}
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

      {/* THE agy ROW. R53/R54 lived in `AgyCard` for a whole phase without a
          mount point, which made them unreachable on the only surface Konrad
          opens — R4-gate blocker 1. The card reports its facts upward, and the
          Ultra row above reads the SAME `agy` state, so the two rows about one
          binary cannot contradict each other any more. */}
      <Row
        summary={agySummary}
        open={open === "agy"}
        onToggle={toggle}
        verbatimError={agySummary.state === "broken" ? agyFacts?.status.detail ?? null : null}
      >
        <AgyCard onFacts={setAgy} reloadKey={reloadKey} />
      </Row>

      <GroupLabel
        text="GITHUB — the token that pushes branches and opens pull requests"
        note="write-only from this browser · verified by a real GET /user"
      />
      <Row
        summary={githubSummary}
        open={open === "github"}
        onToggle={toggle}
        verbatimError={githubSummary.state === "broken" ? githubFacts?.status.detail ?? null : null}
      >
        <GitHubCard onFacts={setGithub} reloadKey={reloadKey} />
      </Row>
    </div>
  );
}

const FLEET_TIER_DESCRIPTIONS: Record<string, { label: string; desc: string }> = {
  gemini: {
    label: "gemini — Gemini 3.7 Flash via agy (Default)",
    desc: "Default engine for sub-agent work: builders, tests, boilerplate, docs, evidence and all re-checks.",
  },
  junior: {
    label: "junior — Claude 3.5 Sonnet",
    desc: "Claude junior: deploy/host-touching tasks where work must definitely land on disk.",
  },
  standard: {
    label: "standard — Claude Opus / Sonnet",
    desc: "Claude standard: gating reviews of product code and tasks requiring high judgement.",
  },
  fast: {
    label: "fast — Claude 3.5 Haiku",
    desc: "Claude fast: trivial mechanical work and fast scout recon.",
  },
  flagship: {
    label: "flagship — Claude Opus / Fable",
    desc: "Claude flagship: genuinely hard top-level architecture and system design only.",
  },
};

/**
 * Fleet default engine switch — runtime tier configuration for sub-agent dispatch.
 *
 * Untiered and newly created tasks resolve against this setting at tick / dispatch time
 * (GET /api/fleet/default-tier), backed by app_settings['fleet.default_tier'].
 * Changing this setting updates the default immediately at runtime without restart.
 */
export function FleetDefaultEngineSection(): JSX.Element {
  const [tierData, setTierData] = useState<FleetDefaultTierSetting | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchFleetDefaultTier()
      .then((data) => {
        if (active) setTierData(data);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChange = useCallback(async (newTier: string) => {
    setUpdating(true);
    setError(null);
    try {
      const res = await updateFleetDefaultTier(newTier);
      setTierData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  }, []);

  const activeTier = tierData?.default_tier ?? "gemini";
  const source = tierData?.source ?? "default";
  const isGemini = activeTier === "gemini";

  return (
    <div
      data-fleet-default-engine
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: tokens.textHi }}>
          Fleet Default Engine
        </span>
        <span
          className="mono"
          data-fleet-tier-badge
          style={{
            background: isGemini ? tokens.primaryActionBg : tokens.selectedBg,
            color: isGemini ? tokens.textHi : tokens.accent,
            border: `1px solid ${tokens.borderEmphasis}`,
            borderRadius: 5,
            padding: "2px 7px",
            fontSize: 10.5,
            fontWeight: 600,
          }}
        >
          {tierData ? tierData.default_tier.toUpperCase() : "GEMINI"}
        </span>
        <span
          className="mono"
          data-fleet-tier-source
          style={{
            background: tokens.bgGutter,
            color: source === "app_settings" ? tokens.ok : tokens.textFaint,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 5,
            padding: "2px 7px",
            fontSize: 10.5,
          }}
        >
          {source === "app_settings" ? "APP_SETTINGS (RUNTIME)" : "DEFAULT"}
        </span>
        <span style={{ flex: 1 }} />
        {tierData?.updated_at && (
          <span
            className="mono"
            data-fleet-tier-updated
            title={tierData.updated_at}
            style={{ fontSize: 10.5, color: tokens.textFaint }}
          >
            UPDATED {new Date(tierData.updated_at).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: tokens.textSoft, lineHeight: 1.5, marginTop: 8 }}>
        The engine tier newly created and untiered sub-agent tasks resolve against at dispatch
        time. Switchable at runtime with no deploy or restart required.
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        <label
          htmlFor="fleet-default-tier-select"
          className="mono"
          style={{ fontSize: 10, color: tokens.textLabel }}
        >
          DEFAULT ENGINE TIER
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <select
            id="fleet-default-tier-select"
            data-fleet-tier-select
            value={activeTier}
            disabled={updating || tierData === null}
            onChange={(e) => void handleChange(e.target.value)}
            className="mono"
            style={{
              background: tokens.bgGutter,
              border: `1px solid ${tokens.border}`,
              borderRadius: 7,
              color: tokens.textHi,
              cursor: updating ? "progress" : "pointer",
              fontSize: 12,
              padding: "6px 10px",
              minWidth: 260,
            }}
          >
            <option value="gemini">gemini — Gemini 3.7 Flash via agy (Default)</option>
            <option value="junior">junior — Claude 3.5 Sonnet</option>
            <option value="standard">standard — Claude Opus / Sonnet</option>
            <option value="fast">fast — Claude 3.5 Haiku</option>
            <option value="flagship">flagship — Claude Opus / Fable</option>
          </select>
          {updating && (
            <span className="mono" style={{ fontSize: 11, color: tokens.textSoft }}>
              Updating runtime setting…
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: tokens.textSoft, lineHeight: 1.45, marginTop: 2 }}>
          {FLEET_TIER_DESCRIPTIONS[activeTier]?.desc ?? ""}
        </div>
      </div>

      {error && (
        <div
          data-fleet-tier-error
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 8,
            padding: "8px 10px",
            marginTop: 10,
            lineHeight: 1.45,
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}
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
      {accounts.map((a) => {
        const summary = claudeConnection(a, serving === a.slug);
        return (
        <Row
          key={a.slug}
          summary={summary}
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
          {/* A broken or never-probed login is the state this project exists
              for: the row used to end at "re-authenticate on the VPS". The
              control signs it in from here, into THIS row's config directory,
              and calls `reload()` on success so the chip above comes from the
              re-probed registry record rather than from anything painted here.
              A healthy row gets no control — there is nothing to repair. */}
          {summary.state !== "connected" && (
            <CliAuthConnect
              provider="claude"
              target={{ slug: a.slug, config_dir: a.config_dir }}
              onConnected={() => void registry.reload()}
            />
          )}
          <AccountCard
            a={a}
            serving={serving === a.slug}
            busy={registry.busy}
            act={registry.act}
          />
        </Row>
        );
      })}
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

  /* The broker's own input rule, restated here so the reason a disabled button
   * is disabled is on screen instead of arriving as a 400 after the click.
   * `PLAN.md` §4: slug `^[a-z0-9][a-z0-9-]{0,39}$`, config_dir absolute. */
  const signInBlocked: string | null = !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug.trim())
    ? "Type a slug first — lower-case letters, digits and dashes, starting with a letter or digit."
    : !dir.trim().startsWith("/")
      ? "Type the absolute config directory this login should write into."
      : null;

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
        A Claude session is a <span className="mono">.credentials.json</span> inside a config
        directory, written by the Claude CLI&rsquo;s own login. There are now two ways to get one:
        sign in <strong>from here</strong> — the OS runs that login on this box and pastes the code
        back for you — or run it yourself at a terminal and register the directory it wrote. Either
        way the row you end up with shows the health a <strong>probe</strong> measured, never a
        hopeful default.
      </div>

      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel, margin: "14px 0 5px" }}>
        STEP 1 — NAME IT AND SAY WHERE IT LIVES
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

      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel, margin: "14px 0 5px" }}>
        STEP 2 — SIGN IN, WITHOUT LEAVING THIS PAGE
      </div>
      <CliAuthConnect
        provider="claude"
        target={{ slug: slug.trim(), config_dir: dir.trim() }}
        blocked={signInBlocked}
        onConnected={() => {
          // The broker registers the row itself on success, so there is
          // nothing left for this form to submit — close it and let the
          // registry's own reload put the probed row on screen.
          setSlug("");
          setDir("");
          setOpen(false);
          void registry.reload();
        }}
      />

      <div className="mono" style={{ fontSize: 10, color: tokens.textLabel, margin: "14px 0 5px" }}>
        OR RUN THE SAME LOGIN YOURSELF, ON THE VPS
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
        STEP 3 — ALREADY LOGGED IN ON THIS BOX? REGISTER THAT DIRECTORY
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
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

/* `input()` moved to `integrationCards.tsx` and is imported above. One field
 * style, three importers — this panel, the integration cards, and the CLI
 * sign-in control that renders inside both. */

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

/**
 * The batch-probe control and its last result.
 *
 * ── WHY THE RESULT STRIP EXISTS AND IS NOT JUST "DONE ✓" ─────────────────
 * The rows below already re-read themselves after a batch, so a naive version
 * of this control could be a button and nothing else. It is not, for two
 * reasons Konrad named: he cannot probe anything today, and when he can he
 * has to be able to see WHICH probes ran. A batch that silently skips GitHub
 * because no PAT is stored, and a batch where GitHub answered 200, look
 * identical if the only output is the rows refreshing.
 *
 * So each returned connection gets a chip carrying the state the PROBE
 * produced, and a failed one prints the upstream's verbatim `detail`
 * underneath — the same R58 rule the rows follow. `absent` is not a failure
 * and is not painted as one: nothing is wrong with a credential that was
 * never supplied.
 */
function ProbeAllBar({
  busy,
  result,
  error,
  onRun,
}: {
  busy: boolean;
  result: ProbeAllResponse | null;
  error: string | null;
  onRun: () => void;
}): JSX.Element {
  const failures = (result?.connections ?? []).filter(
    (c) => c.state === "broken" || c.state === "unknown",
  );

  return (
    <div
      data-probe-all
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: "12px 14px",
        marginBottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          data-probe-all-run
          onClick={onRun}
          disabled={busy}
          style={{
            font: "inherit",
            background: busy ? tokens.toolBg : tokens.primaryActionBg,
            border: `1px solid ${busy ? tokens.border : tokens.borderEmphasis}`,
            borderRadius: 8,
            color: tokens.textHi,
            cursor: busy ? "progress" : "pointer",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "7px 14px",
          }}
        >
          {busy ? "Probing…" : "Probe all"}
        </button>
        <span style={{ fontSize: 12, color: tokens.textSoft, lineHeight: 1.5 }}>
          Calls Google, <span className="mono">agy</span> and GitHub for real, in
          parallel, and rewrites each row from what they answered.
        </span>
        <span style={{ flex: 1 }} />
        {result && (
          <span
            className="mono"
            data-probe-all-at
            title={result.timestamp}
            style={{ fontSize: 10.5, color: tokens.textFaint }}
          >
            LAST RUN {new Date(result.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div
          data-probe-all-error
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.bleed,
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 8,
            padding: "8px 10px",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {result.connections.map((c) => {
            const skin = STATE_SKIN[c.state];
            return (
              <span
                key={c.id}
                className="mono"
                data-probe-all-result={c.id}
                data-probe-all-state={c.state}
                style={{
                  background: skin.bg,
                  color: skin.fg,
                  border: `1px solid ${tokens.borderSoft}`,
                  borderRadius: 5,
                  padding: "3px 8px",
                  fontSize: 10.5,
                }}
              >
                {c.id.toUpperCase()} — {c.state.toUpperCase()}
              </span>
            );
          })}
        </div>
      )}

      {/* R58 again: a chip says a probe failed, this says what it was told. */}
      {failures.map((c) => (
        <div
          key={c.id}
          data-probe-all-detail={c.id}
          className="mono"
          style={{
            fontSize: 11,
            color: tokens.textBody,
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            padding: "8px 10px",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <span style={{ color: tokens.textLabel }}>{c.id.toUpperCase()}: </span>
          {c.detail}
        </div>
      ))}
    </div>
  );
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
