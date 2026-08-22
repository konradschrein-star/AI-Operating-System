/**
 * check-settings-surface.tsx — round 1350's unit check for settings-in-shell.
 *
 * Konrad's bar this round was a feeling ("the interface seems a bit weird"),
 * and a feeling cannot be asserted. What CAN be asserted are the four
 * mechanical facts the feeling was made of, each of which was false before
 * this round:
 *
 *   §1 SETTINGS IS A SURFACE. It renders as a two-column pane, not a page:
 *      no `100dvh`, no "BACK TO OS" escape hatch, no page padding. The shell
 *      that mounts it stays on screen because the component never claims the
 *      viewport.
 *   §2 THE DRILL IS THE CHAT'S DRILL. The body carries `.nav-drill`, back
 *      carries `.nav-back` (the exported `BackButton`, not a copy), and
 *      `frameKey` changes on descend / lateral / climb and on nothing else —
 *      the same contract `scripts/checks/check-nav-stack.ts` holds
 *      `chat/nav-stack.ts` to.
 *   §3 ONE CONNECTIONS SURFACE. `ConnectionsPanel` is body-only, so the
 *      surface and the surviving `/settings` route mount the same component
 *      instead of two drifting copies. (Round 1876: it replaced `AccountsPanel`
 *      here when ACCOUNTS and INTEGRATIONS merged into CONNECTIONS — a Claude
 *      login and a Google consent are the same kind of thing to the person
 *      wiring them in, and they used to sit in two sections that explained
 *      neither.)
 *   §4 TOKENS ONLY. Every colour that reaches the DOM — inline styles AND the
 *      scoped hover stylesheet — is a `var(--fg-…)` reference, so both themes
 *      work. A hex literal anywhere in the output fails the check.
 *   §3b THE USAGE AND CONNECTIONS PANELS ARE THE REAL THING. Rounds 1350 and
 *      1352 replaced the round-1351 stubs ("loading usage" / "loading
 *      integrations") with the actual Credit Tracker and integration cards.
 *      This asserts their real, load-bearing pre-fetch markup instead —
 *      `UsagePanel` needs a `QueryClientProvider` above it to render at all
 *      (round-1350 fix: this check was throwing before any assertion ran,
 *      which is a check that is absent, not one that is failing).
 *
 * There is no DOM in this repo's check harness (no jsdom, and none is being
 * installed for this). So §2's click-driven half is asserted on `frameKey`,
 * the pure function that drives the animation, and the section bodies are
 * rendered directly rather than reached by clicking.
 *
 * Run (from forge-control-web, whose node_modules holds react/react-dom):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-settings-surface.tsx
 */

import { renderToStaticMarkup } from "react-dom/server";

import {
  SettingsSurface,
  frameKey,
} from "../../forge-control-web/app/desktop/settings/SettingsSurface.tsx";
import {
  ConnectionsPanel,
  ClaudeAccountsSection,
} from "../../forge-control-web/app/desktop/settings/ConnectionsPanel.tsx";
import type {
  Account,
  AccountRegistry,
} from "../../forge-control-web/app/desktop/settings/accountRegistry.tsx";
import { UsagePanel } from "../../forge-control-web/app/desktop/settings/UsagePanel.tsx";
import {
  CliAuthConnectView,
  type CliAuthView,
} from "../../forge-control-web/app/desktop/settings/CliAuthConnect.tsx";
import type {
  CliAuthState,
  CliAuthStatus,
} from "../../forge-control-web/app/api-connections.ts";
// `UsagePanel` (round 1352) calls `useQueryClient`, so it needs a real
// provider above it or the render throws before any assertion runs — that
// was defect #1 (round 1350's check, red since 1352 landed). Reusing the
// app's own `Providers` rather than hand-rolling a `new QueryClient()` gets
// the fix for free: its `useState` initialiser mints a fresh client on every
// render, so each `renderToStaticMarkup` call below is its own cache, and the
// panel is proven against the exact provider tree it runs under in prod.
import { Providers } from "../../forge-control-web/app/Providers.tsx";
// §5 asserts the amber colour by IDENTITY, not by literal: the check imports
// the same token the component renders, so a token rename cannot make the
// assertion pass against the wrong colour, and no hex ever enters this file.
import { tokens } from "../../forge-control-web/app/tokens.ts";

let failures = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/* `SettingsSurface` renders `ConnectionsPanel` in its CONNECTIONS section, and
 * that panel observes the shared quota cache entry (the Ultra row reads the
 * same reading the status bar shows). So the surface, like the usage panel,
 * needs a real provider above it or the render throws before any assertion
 * runs. */
const surface = renderToStaticMarkup(
  <Providers>
    <SettingsSurface />
  </Providers>,
);

console.log("§1 settings is a surface, not a page");
ok("renders", surface.length > 0);
ok("no viewport claim (100dvh/100vh)", !/100dvh|100vh/.test(surface));
ok("no escape hatch out of the OS", !/BACK TO OS/i.test(surface));
ok("no anchor to /settings inside the shell", !/href="\/settings/.test(surface));
ok(
  "carries the surface marker",
  surface.includes("data-settings-surface"),
);
ok(
  "opens at the index, not inside a section",
  surface.includes('data-settings-section="index"'),
);
for (const label of ["CONNECTIONS", "SECRETS", "USAGE"]) {
  ok(`section listed: ${label}`, surface.includes(label));
}

console.log("§2 the drill is the chat surface's drill");
ok("body wears .nav-drill", /class="[^"]*nav-drill/.test(surface));
ok(
  "index has no back button (nothing above it)",
  !/class="[^"]*nav-back/.test(surface),
);
ok("index key is stable", frameKey(null) === "index");
ok("descend changes the key", frameKey("connections") !== frameKey(null));
ok(
  "lateral move changes the key",
  frameKey("connections") !== frameKey("usage"),
);
ok("climb returns to the index key", frameKey(null) === "index");
ok(
  "same section re-render does NOT change the key",
  frameKey("secrets") === frameKey("secrets"),
);
ok(
  "every section has a distinct key",
  new Set((["connections", "secrets", "usage"] as const).map(frameKey)).size === 3,
);

console.log("§3 one connections surface, mounted twice");
const accounts = renderToStaticMarkup(
  <Providers>
    <ConnectionsPanel />
  </Providers>,
);
ok("ConnectionsPanel renders", accounts.includes("data-connections-panel"));
ok("body only — no page padding wrapper", !/100dvh/.test(accounts));
ok("body only — no back link", !/<a /.test(accounts));
/* The honesty rule, at the surface level: the panel tells Konrad what amber
 * means before he has to infer it from a chip. */
ok(
  "it states the amber rule in words",
  accounts.includes("Amber means unknown"),
);

/* ── EVERY CONNECTION IS ON THE SCREEN, NOT MERELY EXPORTED ──────────────────
 *
 * R4-gate blocker 1. `AgyCard` and `GitHubCard` were built, tested and
 * exported for a whole phase with NO MOUNT POINT, so R54 and R56 were
 * unreachable on the only surface Konrad opens — and every proof of them ran
 * against a throwaway page rendering the cards directly. A component test
 * cannot see that: it imports the thing it is testing.
 *
 * So the assertion is over the PANEL'S OWN MARKUP, at first paint, before any
 * fetch resolves. Delete a `<Row>` and this goes red.
 * ──────────────────────────────────────────────────────────────────────────── */
const EXPECTED_ROWS = [
  "google",
  "gemini-key",
  // The row that did not exist before the CLI sign-in broker: the Gemini CLI's
  // own Google session, as opposed to the billed API key above it. Without a
  // row there is nothing to put a Connect button on, and "the Gemini CLI has no
  // credentials" stays true and invisible.
  "gemini-cli",
  "gemini-ultra",
  "agy",
  "github",
] as const;
for (const id of EXPECTED_ROWS) {
  ok(
    `the ${id} connection has a row on the panel, not just an exported card`,
    accounts.includes(`data-connection-row="${id}"`),
  );
}
/* The anti-inert control: `includes("data-connection-row=…")` must FAIL for an
 * id that is not mounted, or the five lines above measure nothing. */
ok(
  "…and the row check discriminates — an unmounted id is not found",
  !accounts.includes('data-connection-row="not-a-real-connection"'),
);
/* And the cards themselves are inside those rows, not merely the heads. */
ok("the agy card body is mounted under its row", accounts.includes("data-agy-card"));
ok("the GitHub card body is mounted under its row", accounts.includes("data-github-card"));
ok(
  "the Gemini CLI card body is mounted under its row",
  accounts.includes("data-gemini-cli-card"),
);

console.log("§3b the real panels render — not the round-1351 stubs");
// Both panels fetch on mount (`useQuery` / a `useEffect` that calls the
// proxy). Neither fetch fires here: `@tanstack/query-core` gates its
// eager-fetch-in-render behind `!isServer`, and `isServer` is
// `typeof window === "undefined"` — true under `renderToStaticMarkup` in
// Node, false under a browser or jsdom. So this render is deterministically
// the panels' pre-fetch state, with no stubbed `fetch` needed to hold it
// still. That state is a real, load-bearing contract in its own right: it is
// what Konrad sees for the first paint of every settings visit.
const usage = renderToStaticMarkup(
  <Providers>
    <UsagePanel />
  </Providers>,
);
ok(
  // Not `usage.includes("data-usage-panel")`: the panel's own scoped
  // stylesheet contains `[data-usage-panel]` as a CSS selector, so a plain
  // substring check stays green even with the marker attribute stripped off
  // the root element — caught by deliberately breaking this in verification.
  "UsagePanel marks itself",
  /<div data-usage-panel="true"/.test(usage),
);
ok(
  "…renders the shadow-cost/quota framing, not a loading stub",
  usage.includes("SHADOW COST — NOT AN INVOICE") &&
    usage.includes("SUBSCRIPTION QUOTA") &&
    usage.includes("EUR PER USD"),
);
ok(
  "…is honest about having no reading yet (no invented number)",
  usage.includes("waiting for the first quota reading…") &&
    usage.includes("loading usage history…"),
);

/* The integration cards now live UNDER their Connections rows, mounted (so
 * their fetch happens once) and hidden until the row is expanded — hence they
 * are in this markup even though the panel opens collapsed. */
ok(
  "…the connections panel carries both integration cards",
  accounts.includes("data-gemini-card") && accounts.includes("data-google-card"),
);
ok(
  "…the Gemini key field is the real write-only contract",
  accounts.includes('placeholder="paste your AI Studio API key"') &&
    accounts.includes("GEMINI USAGE"),
);
ok(
  "…and every connection row states its exact connect/repair action",
  accounts.includes("TO CONNECT / REPAIR"),
);

/* ========================================================================== *
 * §5 THE PROBE-AGE INVARIANT, ASSERTED AGAINST FIXTURES (phase 4 / B4a).
 *
 * R57: no connection renders a positive state without a `checked_at`.
 * R45:  every account row carries the age of its last probe.
 * R58:  a failed probe shows the VERBATIM upstream error.
 *
 * §3 above renders `ConnectionsPanel` with no data at all — under
 * `renderToStaticMarkup` no `useEffect` runs and no fetch can resolve, so the
 * panel is permanently at its pre-fetch state and none of these rules is
 * reachable through it. `ClaudeAccountsSection` takes its registry as a prop
 * for exactly this reason, so the fixtures below drive the SAME component
 * Konrad looks at.
 *
 * The middle fixture is the one that matters: `stored_health: "healthy"` with
 * `last_probed_at: null`. That state was reproduced live on 2026-08-18 and
 * rendered CONNECTED in green
 * (docs/plan/artifacts/os-usable-for-work/phase4/b4a-before-connections.png).
 * `effectiveHealth()` in the API now demotes it before it ever reaches the
 * browser, which is why `health` and `stored_health` disagree here.
 * ========================================================================== */

console.log("§5 the probe-age invariant — R45 / R57 / R58");

function account(over: Partial<Account>): Account {
  return {
    slug: "fixture",
    config_dir: "/root/.claude",
    login_email: null,
    login_email_source: "configuration",
    plan_label: "max",
    priority: 10,
    enabled: true,
    health: "healthy",
    health_detail: "credential present, recently confirmed",
    stored_health: "healthy",
    health_downgraded: false,
    probe_age_ms: 4 * 60_000,
    measured_at: "2026-08-18T19:30:00.000Z",
    has_refresh: true,
    access_expires_at: null,
    last_probed_at: "2026-08-18T19:26:00.000Z",
    last_ok_at: "2026-08-18T19:28:00.000Z",
    last_error: null,
    reauth_command: "claude auth login --claudeai",
    ...over,
  };
}

const FIXTURES: Account[] = [
  // 1. Fresh probe, healthy → the only row entitled to a positive state.
  account({ slug: "fresh", priority: 10 }),
  // 2. THE INVARIANT. The registry still stores `healthy`; nothing measured it.
  account({
    slug: "unmeasured",
    priority: 20,
    health: "unknown",
    stored_health: "healthy",
    health_downgraded: true,
    health_detail:
      'never probed — the stored verdict "confirmed by a successful run" has no measurement behind it. Press Probe now.',
    probe_age_ms: null,
    last_probed_at: null,
  }),
  // 3. THE CONTROL FOR LAYER TWO. This is the RAW registry shape, exactly as it
  //    looked before `effectiveHealth()` existed: health `healthy`,
  //    `last_probed_at` null, `health_downgraded` false. If the API's demotion
  //    were removed — or an older forge-control served this build, or a future
  //    caller handed `claudeConnection()` a raw row — this is what would arrive.
  //    `renderSafeAccount()` must catch it in the browser. Without this fixture
  //    layer two is unreachable code that nobody would notice had stopped
  //    working, because layer one always fires first in production.
  account({
    slug: "raw-undemoted",
    priority: 25,
    health: "healthy",
    stored_health: "healthy",
    health_downgraded: false,
    health_detail: "confirmed by a successful run",
    probe_age_ms: null,
    last_probed_at: null,
  }),
  // 4. Broken, carrying a verbatim upstream 401.
  account({
    slug: "revoked",
    priority: 30,
    config_dir: "/home/claude-worker/.claude",
    health: "broken",
    stored_health: "broken",
    health_detail: "authentication failed during a run",
    last_error:
      'HTTP 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired or been revoked"}}',
    reauth_command: "CLAUDE_CONFIG_DIR=/home/claude-worker/.claude claude auth login --claudeai",
  }),
];

const fixtureRegistry: AccountRegistry = {
  data: {
    accounts: FIXTURES,
    summary: {
      total: 4,
      enabled: 4,
      healthy: 1,
      unknown: 2,
      broken: 1,
      usable: 3,
      serving: "fresh",
    },
    policy: { mode: "health-failover-only", description: "fixture policy" },
  },
  error: null,
  busy: null,
  actionError: null,
  reload: async () => {},
  act: async () => {},
  create: async () => FIXTURES[0],
};

const claude = renderToStaticMarkup(
  <ClaudeAccountsSection registry={fixtureRegistry} open={null} onToggle={() => {}} />,
);

/** The markup of exactly one row, so an assertion about `unmeasured` cannot be
 *  satisfied by text belonging to `fresh`. Rows are `data-connection-row="…"`
 *  siblings; slicing from one marker to the next is enough and needs no DOM. */
function row(slug: string): string {
  const start = claude.indexOf(`data-connection-row="claude:${slug}"`);
  if (start < 0) throw new Error(`fixture row ${slug} did not render at all`);
  const next = claude.indexOf('data-connection-row="', start + 1);
  return claude.slice(start, next < 0 ? undefined : next);
}

ok("all four fixture rows render", FIXTURES.every((a) => claude.includes(`claude:${a.slug}`)));

// --- The control for layer two -------------------------------------------
// This row arrives NOT demoted. If `renderSafeAccount()` is removed from
// `ClaudeAccountsSection`, these three assertions go red and the two above them
// (which read an already-demoted fixture) stay green — which is exactly the
// discrimination this control exists to provide.
const raw = row("raw-undemoted");
ok(
  "LAYER TWO: an UNDEMOTED healthy row with no probe is caught in the browser",
  /data-connection-state="unknown"/.test(raw),
  /data-connection-state="([a-z]+)"/.exec(raw)?.[1],
);
ok(
  "LAYER TWO: …and never reaches the chip as CONNECTED",
  !/CONNECTED/i.test(raw),
  /(\bCONNECTED\b)/i.exec(raw)?.[1],
);
ok(
  // NOT `raw.includes("never probed")`. That string is ALSO the probe-age
  // chip's label for any row with `last_probed_at: null`, so it renders whether
  // or not the demotion fired — the assertion was green with layer two removed,
  // caught by deliberately disabling it. The downgrade marker is emitted only
  // by the demotion path, so it discriminates.
  "LAYER TWO: …and marks itself as downgraded, which only the demotion does",
  raw.includes('data-health-downgraded="raw-undemoted"'),
);

// --- R57, the load-bearing one -------------------------------------------
const unmeasured = row("unmeasured");
ok(
  "R57: an account with last_probed_at=null renders UNKNOWN",
  /data-connection-state="unknown"/.test(unmeasured),
  /data-connection-state="([a-z]+)"/.exec(unmeasured)?.[1],
);
ok(
  "R57: …and does NOT render the connected word",
  !/CONNECTED/i.test(unmeasured),
  /(\bCONNECTED\b)/i.exec(unmeasured)?.[1],
);
ok(
  "R57: …and says on the row that it has never been probed",
  unmeasured.includes("never probed"),
);
ok(
  "R57: …and names the stored word it overrode, rather than demoting silently",
  unmeasured.includes("confirmed by a successful run"),
);
ok(
  "R57: …in AMBER — the same token the registry uses for unknown, no literal",
  unmeasured.includes(`color:${tokens.warn}`),
  `expected ${tokens.warn}`,
);

// --- R45 ------------------------------------------------------------------
const fresh = row("fresh");
ok(
  "R45: a freshly-probed healthy account renders CONNECTED",
  /data-connection-state="connected"/.test(fresh),
  /data-connection-state="([a-z]+)"/.exec(fresh)?.[1],
);
ok(
  "R45: …and states its probe AGE on the collapsed row",
  /probed 4 min ago/.test(fresh),
  fresh.includes("probed") ? "no age" : "no probe wording at all",
);
ok(
  "R45: …with the absolute timestamp available beside the relative one",
  /title="2026-08-18 19:26:00Z"/.test(fresh),
);
ok(
  "R45: every row carries a probe age — not just the ones that have one",
  FIXTURES.every((a) => /data-connection-probe-age/.test(row(a.slug))),
);
ok(
  "R45: a per-account Probe now control exists on every row",
  FIXTURES.every((a) => row(a.slug).includes(`data-probe-now="${a.slug}"`)),
);
ok(
  // The API and this build deploy separately. An older forge-control omits
  // `probe_age_ms` altogether, and `undefined === null` is false — which
  // rendered `probed NaN d ago` in a real browser on 2026-08-18. The fallback
  // must be "never probed": under-claiming is the safe direction.
  "R45: a row from an API too old to send probe_age_ms degrades to 'never probed', not NaN",
  (() => {
    const stale = { ...account({ slug: "old-api" }) } as Record<string, unknown>;
    delete stale.probe_age_ms;
    const markup = renderToStaticMarkup(
      <ClaudeAccountsSection
        registry={{
          ...fixtureRegistry,
          data: { ...fixtureRegistry.data!, accounts: [stale as unknown as Account] },
        }}
        open={null}
        onToggle={() => {}}
      />,
    );
    return !/NaN/.test(markup) && markup.includes("never probed");
  })(),
);
ok(
  "R47: priority is editable, not display-only",
  FIXTURES.every(
    (a) =>
      row(a.slug).includes(`data-priority-up="${a.slug}"`) &&
      row(a.slug).includes(`data-priority-value="${a.slug}"`),
  ),
);

// --- R58 ------------------------------------------------------------------
const revoked = row("revoked");
ok(
  "R58: a broken account renders its VERBATIM last_error — status code",
  revoked.includes("HTTP 401"),
);
ok(
  "R58: …and the upstream message, unparaphrased",
  revoked.includes("OAuth token has expired or been revoked"),
);
ok(
  "R58: …rather than a friendly stand-in",
  !/probe failed|something went wrong|unable to connect/i.test(revoked),
);

// --- R46, the add flow ----------------------------------------------------
ok("R46: the add-account affordance exists", claude.includes("data-add-account-open"));
const addForm = renderToStaticMarkup(
  <ClaudeAccountsSection
    registry={{ ...fixtureRegistry, busy: "new:create" }}
    open={null}
    onToggle={() => {}}
  />,
);
ok(
  "R46: the collapsed affordance says what registering actually means",
  claude.includes("already logged in on this box"),
);
ok(
  // The form itself is behind a click, which this DOM-less harness cannot
  // perform; the browser harness (browser-harness-phase4.cjs add-flow) asserts
  // the opened form.
  //
  // WHAT THIS RULE MEANS NOW. It used to read "nothing implies a browser OAuth
  // flow", because there was none: the OS could not log a Claude account in,
  // and a button promising otherwise would have been a fake success state. The
  // CLI sign-in broker gives it one — the OS runs the login on a pty and pastes
  // the code in — so the forbidden thing is no longer "a browser flow". It is
  // the ONE-CLICK version: a promise that pressing a button finishes the job
  // with no code to fetch and paste. The literals stay exactly as they were,
  // because those particular phrases are still the shape of that promise, and
  // the assertion below adds the other half — the paste step must be NAMED.
  "R46: the section never promises a one-click consent that needs no pasted code",
  !/sign in with claude|connect with claude|authorize in your browser|oauth consent/i.test(
    claude + addForm,
  ),
);
ok(
  "R46: …and where it does offer a sign-in, it says a code has to come back",
  /paste it below|paste it back|paste the code|paste it here/i.test(claude),
);

/* ========================================================================== *
 * §6 THE CLI SIGN-IN CONTROL — SEVEN STATES, EVERY ONE WITH A FIXTURE.
 *
 * `PLAN.md` §5 pins six behaviours; the server's state machine has seven
 * states. Six of them are unreachable through `CliAuthConnect` in this harness
 * — no effect runs, no fetch resolves, so the stateful component is frozen at
 * `idle` forever — which is why the control is split into a pure
 * `CliAuthConnectView` over a `CliAuthView` and a container that feeds it. The
 * fixtures below drive the SAME view Konrad looks at, one per state, and the
 * list of states is written out here rather than derived from the type, so a
 * state added upstream is a red line rather than a silently unfixtured branch.
 *
 * Two of these assertions are not about layout at all:
 *
 *   THE STALE-URL CONTROL. The `expired` fixture deliberately still CARRIES a
 *   url, which is what a server that forgot to null it would send. The box
 *   must not render — the PKCE challenge behind that link died with the
 *   session, and a consent page completed against it produces a code that can
 *   only ever be rejected. The same url on the `awaiting_code` fixture DOES
 *   render, which is what makes this a measurement rather than a coincidence.
 *
 *   THE SECRET CONTROL. The `awaiting_code` fixture carries a value in the
 *   code field. It may appear EXACTLY ONCE in the markup — as the password
 *   input's value — and in no data-attribute, no url and no title. That is the
 *   rule the whole broker is built around, asserted at the one place in this
 *   repo where the code and the DOM meet.
 * ========================================================================== */

console.log("§6 the CLI sign-in control — seven states, one control (PLAN §5)");

const CONSENT_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fixture.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";

/** Deliberately NOT a plausible authorization code: this string exists to be
 *  grepped for, and a realistic-looking one in a tracked file is the thing the
 *  repo's secret scanner is for. */
const FIXTURE_CODE = "FIXTURE-CODE-PLACEHOLDER-NOT-A-CREDENTIAL";

const CLI_NOW = Date.parse("2026-08-22T12:00:00.000Z");

function cliStatus(over: Partial<CliAuthStatus>): CliAuthStatus {
  return {
    provider: "agy",
    state: "idle",
    session_id: null,
    url: null,
    prompt: null,
    window_seconds: 60,
    started_at: null,
    expires_at: null,
    detail: "fixture detail",
    action: "fixture action",
    probe: null,
    ...over,
  };
}

function cliView(over: Partial<CliAuthView>): CliAuthView {
  return {
    provider: "agy",
    status: null,
    busy: null,
    error: null,
    code: "",
    nowMs: null,
    blocked: null,
    ...over,
  };
}

/** The CLI's own words when a wrong code is handed to it — verbatim, the way
 *  the panel prints every other upstream failure (R58). */
const WRONG_CODE_TAIL =
  "Error: invalid_grant — the authorization code is malformed or has already been used.";

const CLI_VIEWS: Record<CliAuthState, CliAuthView> = {
  idle: cliView({}),
  starting: cliView({ status: cliStatus({ state: "starting" }), busy: "start" }),
  awaiting_code: cliView({
    status: cliStatus({
      state: "awaiting_code",
      session_id: "11111111-2222-3333-4444-555555555555",
      url: CONSENT_URL,
      prompt: "Or, paste the authorization code here and press Enter:",
      // 42 seconds left of a 60-second window: the state PLAN §5 step 2 draws.
      started_at: "2026-08-22T11:59:42.000Z",
      expires_at: "2026-08-22T12:00:42.000Z",
      detail: "the CLI is waiting for the code",
      action: "Paste the code from the Google page into the field below.",
    }),
    code: FIXTURE_CODE,
    nowMs: CLI_NOW,
  }),
  exchanging: cliView({
    status: cliStatus({
      state: "exchanging",
      session_id: "11111111-2222-3333-4444-555555555555",
      detail: "the code has been delivered; the CLI is talking to Google",
    }),
    busy: "code",
  }),
  connected: cliView({
    status: cliStatus({
      state: "connected",
      detail: "the CLI reported success and the probe agreed",
      action: "Nothing to do.",
      probe: {
        ok: true,
        identity: "konrad.schrein@gmail.com",
        detail: "/root/.local/bin/agy models exited 0 and listed 7 models.",
        checked_at: "2026-08-22T12:00:04.000Z",
      },
    }),
  }),
  expired: cliView({
    status: cliStatus({
      state: "expired",
      // THE CONTROL: a server that forgot to null it. The client nulls it too.
      url: CONSENT_URL,
      detail: "the 60 s window closed before the code arrived",
      action: "Press Relaunch — a fresh URL, with a fresh challenge behind it.",
    }),
    nowMs: CLI_NOW,
  }),
  failed: cliView({
    status: cliStatus({
      state: "failed",
      detail: WRONG_CODE_TAIL,
      action: "Press Relaunch and try again with the code from the new page.",
    }),
  }),
};

const CLI_STATES: readonly CliAuthState[] = [
  "idle",
  "starting",
  "awaiting_code",
  "exchanging",
  "connected",
  "expired",
  "failed",
];

const NOOP_ACTIONS = {
  connect: () => {},
  submit: () => {},
  cancel: () => {},
  setCode: () => {},
};

const cliMarkup: Record<CliAuthState, string> = Object.fromEntries(
  CLI_STATES.map((s) => [
    s,
    renderToStaticMarkup(<CliAuthConnectView view={CLI_VIEWS[s]} actions={NOOP_ACTIONS} />),
  ]),
) as Record<CliAuthState, string>;

ok(
  "every one of the seven states has a fixture and renders",
  CLI_STATES.length === 7 && CLI_STATES.every((s) => cliMarkup[s].length > 0),
);
for (const s of CLI_STATES) {
  ok(
    `${s}: the control marks the state it is in, so a browser test can wait on it`,
    cliMarkup[s].includes(`data-cli-auth-state="${s}"`),
    /data-cli-auth-state="([a-z_]+)"/.exec(cliMarkup[s])?.[1],
  );
}

// --- Step 1 / step 5: one button, two words --------------------------------
ok(
  "idle offers Connect",
  cliMarkup.idle.includes('data-cli-auth-connect="agy"') && />Connect</.test(cliMarkup.idle),
);
for (const s of ["expired", "failed"] as const) {
  ok(
    `${s} offers Relaunch, not Connect — the old challenge is dead`,
    cliMarkup[s].includes('data-cli-auth-relaunch="agy"') &&
      !cliMarkup[s].includes('data-cli-auth-connect="agy"'),
  );
  ok(
    `${s} prints the CLI's own last words, verbatim`,
    cliMarkup[s].includes(CLI_VIEWS[s].status!.detail),
  );
}
ok(
  "…and a wrong code is rendered as the CLI wrote it, not as 'that did not work'",
  cliMarkup.failed.includes(WRONG_CODE_TAIL) &&
    !/that did not work\b|something went wrong|try again later/i.test(cliMarkup.failed),
);

// --- THE STALE-URL CONTROL -------------------------------------------------
ok(
  "awaiting_code shows the consent URL in a copyable box",
  cliMarkup.awaiting_code.includes("data-cli-auth-url") &&
    cliMarkup.awaiting_code.includes(CONSENT_URL.replace(/&/g, "&amp;")),
);
ok(
  "expired does NOT show it — even though the fixture still carries one",
  CLI_VIEWS.expired.status!.url === CONSENT_URL &&
    !cliMarkup.expired.includes("data-cli-auth-url") &&
    !cliMarkup.expired.includes("accounts.google.com"),
);
for (const s of ["idle", "starting", "exchanging", "connected"] as const) {
  ok(`${s} shows no URL either — the box belongs to one state only`, !cliMarkup[s].includes("data-cli-auth-url"));
}

// --- Step 2: the field, and the countdown ----------------------------------
ok(
  "awaiting_code takes the code in a password field with autocomplete off",
  /<input [^>]*data-cli-auth-code="agy"[^>]*type="password"[^>]*autocomplete="off"/i.test(
    cliMarkup.awaiting_code,
  ) ||
    /<input [^>]*type="password"[^>]*autocomplete="off"[^>]*data-cli-auth-code="agy"/i.test(
      cliMarkup.awaiting_code,
    ),
  cliMarkup.awaiting_code.slice(
    Math.max(0, cliMarkup.awaiting_code.indexOf("data-cli-auth-code") - 120),
    cliMarkup.awaiting_code.indexOf("data-cli-auth-code") + 160,
  ),
);
ok(
  "…and counts the window down in seconds",
  cliMarkup.awaiting_code.includes("expires in 42 s"),
  /expires in [^<]*/.exec(cliMarkup.awaiting_code)?.[0],
);
ok(
  "…and offers Submit and Cancel beside it",
  cliMarkup.awaiting_code.includes('data-cli-auth-submit="agy"') &&
    cliMarkup.awaiting_code.includes('data-cli-auth-cancel="agy"'),
);
ok(
  // Step 3: disabled, not removed — a field that vanishes under the cursor
  // reads as a page that lost the paste.
  "exchanging keeps the field on screen and disables it, and says who is being waited on",
  /data-cli-auth-code="agy"[^>]*disabled/.test(cliMarkup.exchanging.replace(/\n/g, " ")) &&
    cliMarkup.exchanging.includes("checking with the Antigravity CLI"),
);
ok(
  "…and no state anywhere claims the code was merely 'submitted'",
  !CLI_STATES.some((s) => /submitted/i.test(cliMarkup[s])),
);

// --- Step 4: connected says what the PROBE found, and paints no chip -------
ok(
  "connected reports the probe's identity and the probe's own words",
  cliMarkup.connected.includes("konrad.schrein@gmail.com") &&
    cliMarkup.connected.includes("listed 7 models"),
);
ok(
  // The invariant this whole surface is built on: the chip is the row's, and
  // the row reads it off the persisted record. If this control ever renders a
  // connection chip, an unprobed connection can be painted green from here.
  "…and the control paints NO row chip — not in any of the seven states",
  !CLI_STATES.some(
    (s) => cliMarkup[s].includes("data-connection-chip") || cliMarkup[s].includes("data-connection-state"),
  ),
);

// --- THE SECRET CONTROL ----------------------------------------------------
const codeHits = cliMarkup.awaiting_code.split(FIXTURE_CODE).length - 1;
ok(
  "the code appears EXACTLY ONCE in the rendered markup",
  codeHits === 1,
  `${codeHits} occurrence(s)`,
);
ok(
  "…and that one occurrence is the password input's value",
  new RegExp(`<input [^>]*type="password"[^>]*value="${FIXTURE_CODE}"`).test(
    cliMarkup.awaiting_code,
  ) ||
    new RegExp(`<input [^>]*value="${FIXTURE_CODE}"[^>]*type="password"`).test(
      cliMarkup.awaiting_code,
    ),
);
ok(
  "…and it is in no data-attribute",
  !new RegExp(`data-[a-z-]+="[^"]*${FIXTURE_CODE}`).test(cliMarkup.awaiting_code),
);
ok(
  "…and in no URL, href or title",
  !new RegExp(`(href|src|title)="[^"]*${FIXTURE_CODE}`).test(cliMarkup.awaiting_code) &&
    !cliMarkup.awaiting_code.includes(`code=${FIXTURE_CODE}`) &&
    !cliMarkup.awaiting_code.includes(`?${FIXTURE_CODE}`),
);
ok(
  // The anti-inert control for the three lines above: if the fixture's code
  // never reached the markup at all they would all pass while measuring
  // nothing. It reaches it, exactly once, and that is the whole rule.
  "…and the control is not vacuous — the fixture really does carry a code",
  CLI_VIEWS.awaiting_code.code === FIXTURE_CODE && FIXTURE_CODE.length > 0,
);

// --- IT IS MOUNTED, NOT MERELY EXPORTED ------------------------------------
/* R4-gate blocker 1 again, and it is the mistake this repo has already made
 * once with `AgyCard`: a control that exists, is tested, and is reachable from
 * nowhere. These read the PANEL's markup, at first paint. */
ok(
  "the control is mounted on the agy row's card",
  accounts.includes('data-cli-auth="agy"'),
);
ok(
  "…and on the Gemini CLI row's card",
  accounts.includes('data-cli-auth="gemini-cli"'),
);
ok(
  "…and on every Claude row that is not connected",
  ["unmeasured", "raw-undemoted", "revoked"].every((slug) =>
    row(slug).includes('data-cli-auth="claude"'),
  ),
);
ok(
  // The discrimination: a healthy, freshly-probed login has nothing to repair,
  // so it gets no sign-in control. Without this line the assertion above would
  // pass on a panel that put a Connect button under every row indiscriminately.
  "…and NOT on the freshly-probed healthy one, which has nothing to sign in",
  !row("fresh").includes("data-cli-auth="),
);

console.log("§4 design tokens only — both themes");
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC_COLOUR = /\b(?:rgba?|hsla?|oklch|color-mix)\(/;
for (const [name, markup] of [
  ["surface", surface],
  ["connections", accounts],
  ["usage", usage],
  // The phase-4 fixture render too: the probe-age chips, the downgrade notice
  // and the verbatim-error block all introduce new colour, and amber-for-
  // unknown is precisely the kind of rule someone reaches for a literal to
  // express.
  ["claude-fixtures", claude],
  // The sign-in control introduces a countdown in amber, an ok banner and a
  // bad banner — three new colours, and a countdown is exactly the kind of
  // thing someone expresses with a literal red.
  ...CLI_STATES.map((s) => [`cli-auth:${s}`, cliMarkup[s]] as const),
] as const) {
  ok(`${name}: no hex literal`, !HEX.test(markup), HEX.exec(markup)?.[0]);
  ok(
    `${name}: no rgb()/hsl()/oklch()`,
    !FUNC_COLOUR.test(markup),
    FUNC_COLOUR.exec(markup)?.[0],
  );
}
// The scoped hover stylesheet is the one place a colour could sneak in as
// text rather than as an inline style, so it gets its own assertion: every
// declaration it makes has to resolve through the theme.
const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(surface)?.[1] ?? "";
ok("scoped stylesheet is present", styleBlock.length > 0);
const declaredColours = [...styleBlock.matchAll(/(?:background|color|border-color):\s*([^;]+);/g)].map(
  (m) => m[1].trim(),
);
ok(
  "stylesheet declares at least one colour",
  declaredColours.length > 0,
);
ok(
  "every stylesheet colour is a theme variable",
  declaredColours.every((c) => c.startsWith("var(--fg-")),
  declaredColours.filter((c) => !c.startsWith("var(--fg-")).join(", "),
);

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
