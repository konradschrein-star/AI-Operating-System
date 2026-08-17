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
 *   §3 ONE ACCOUNT REGISTRY. `AccountsPanel` is body-only, so the surface and
 *      the surviving `/settings` route mount the same component instead of
 *      two drifting copies.
 *   §4 TOKENS ONLY. Every colour that reaches the DOM — inline styles AND the
 *      scoped hover stylesheet — is a `var(--fg-…)` reference, so both themes
 *      work. A hex literal anywhere in the output fails the check.
 *   §3b THE USAGE AND INTEGRATIONS PANELS ARE THE REAL THING. Rounds 1350 and
 *      1352 replaced the round-1351 stubs ("loading usage" / "loading
 *      integrations") with the actual Credit Tracker and Integrations panels.
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
import { AccountsPanel } from "../../forge-control-web/app/desktop/settings/AccountsPanel.tsx";
import { UsagePanel } from "../../forge-control-web/app/desktop/settings/UsagePanel.tsx";
import { IntegrationsPanel } from "../../forge-control-web/app/desktop/settings/IntegrationsPanel.tsx";
// `UsagePanel` (round 1352) calls `useQueryClient`, so it needs a real
// provider above it or the render throws before any assertion runs — that
// was defect #1 (round 1350's check, red since 1352 landed). Reusing the
// app's own `Providers` rather than hand-rolling a `new QueryClient()` gets
// the fix for free: its `useState` initialiser mints a fresh client on every
// render, so each `renderToStaticMarkup` call below is its own cache, and the
// panel is proven against the exact provider tree it runs under in prod.
import { Providers } from "../../forge-control-web/app/Providers.tsx";

let failures = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const surface = renderToStaticMarkup(<SettingsSurface />);

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
for (const label of ["ACCOUNTS", "SECRETS", "USAGE", "INTEGRATIONS"]) {
  ok(`section listed: ${label}`, surface.includes(label));
}

console.log("§2 the drill is the chat surface's drill");
ok("body wears .nav-drill", /class="[^"]*nav-drill/.test(surface));
ok(
  "index has no back button (nothing above it)",
  !/class="[^"]*nav-back/.test(surface),
);
ok("index key is stable", frameKey(null) === "index");
ok("descend changes the key", frameKey("accounts") !== frameKey(null));
ok(
  "lateral move changes the key",
  frameKey("accounts") !== frameKey("usage"),
);
ok("climb returns to the index key", frameKey(null) === "index");
ok(
  "same section re-render does NOT change the key",
  frameKey("secrets") === frameKey("secrets"),
);
ok(
  "every section has a distinct key",
  new Set(
    (["accounts", "secrets", "usage", "integrations"] as const).map(frameKey),
  ).size === 4,
);

console.log("§3 one account registry, mounted twice");
const accounts = renderToStaticMarkup(<AccountsPanel />);
ok("AccountsPanel renders", accounts.includes("data-accounts-panel"));
ok("body only — no page padding wrapper", !/100dvh/.test(accounts));
ok("body only — no back link", !/<a /.test(accounts));

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
const integrations = renderToStaticMarkup(<IntegrationsPanel />);

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

ok("IntegrationsPanel marks itself", integrations.includes("data-integrations-panel"));
ok(
  "…renders both subject cards, not a loading stub",
  integrations.includes("Gemini API") && integrations.includes("Google account"),
);
ok(
  "…the Gemini key field is the real write-only contract",
  integrations.includes('placeholder="paste your AI Studio API key"') &&
    integrations.includes("GEMINI USAGE"),
);

console.log("§4 design tokens only — both themes");
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC_COLOUR = /\b(?:rgba?|hsla?|oklch|color-mix)\(/;
for (const [name, markup] of [
  ["surface", surface],
  ["accounts", accounts],
  ["usage", usage],
  ["integrations", integrations],
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
