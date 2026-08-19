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
const EXPECTED_ROWS = ["google", "gemini-key", "gemini-ultra", "agy", "github"] as const;
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
  // the opened form. What IS assertable here is that no rendered state of this
  // section ever offers a browser consent that does not exist.
  "R46: nothing in the section implies a browser OAuth flow",
  !/sign in with claude|connect with claude|authorize in your browser|oauth consent/i.test(
    claude + addForm,
  ),
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
