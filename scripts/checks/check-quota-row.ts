/**
 * check-quota-row.ts — round 1876's invariants.
 *
 * Konrad, 2026-08-17: "Why do we have two indicators and why do we have them?
 * We do not need a weekly and a 5-hour limit twice, especially refreshing at
 * different intervals."
 *
 * The duplication was not a typo — it was the absence of a rule. Three
 * components each restated the query key, the refetch interval and the fetch,
 * and nothing failed when a fourth appeared. §1 below is that missing rule,
 * asserted against the SOURCE: if any module other than `quota/quotaQuery.ts`
 * names the quota endpoint, its key or its interval, this check fails and the
 * next round cannot re-introduce a second indicator by copying a hook.
 *
 * §2 holds the Gemini line to its four sentences (a tally, never a bar, and
 * never a zero standing in for a number we do not have), and §3 holds the
 * Connections rows to theirs — including the one that must never regress: an
 * unprobed Claude account is UNKNOWN in amber, never green.
 *
 * Run (from forge-control-web, whose node_modules holds react):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-quota-row.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiLine, humanCount } from "../../forge-control-web/app/desktop/quota/geminiLine";
import type { GeminiTally } from "../../forge-control-web/app/desktop/quota/quotaQuery";
import {
  QUOTA_QUERY_KEY,
  QUOTA_REFETCH_MS,
  QUOTA_STALE_MS,
  readingAge,
  resetsIn,
} from "../../forge-control-web/app/desktop/quota/quotaQuery";
import {
  claudeConnection,
  geminiKeyConnection,
  googleConnection,
  ultraConnection,
} from "../../forge-control-web/app/desktop/settings/connections";
import type { Account } from "../../forge-control-web/app/desktop/settings/accountRegistry";

let failures = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const APP = fileURLToPath(new URL("../../forge-control-web/app/", import.meta.url));

/** Every .ts/.tsx under app/, minus node_modules. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Comments do not count. Every file below is allowed to TALK about the quota
 *  endpoint — several of them explain at length why they no longer call it —
 *  and a check that could not tell prose from code would have forced those
 *  explanations out of the codebase. Block comments go, then line comments
 *  (except a `//` that is part of a `://` scheme, which is a URL, not a
 *  comment). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FILES = sources(APP).map((path) => ({
  path,
  rel: path.slice(APP.length),
  src: readFileSync(path, "utf8"),
  code: code(readFileSync(path, "utf8")),
}));

/* ════════════════════════════════════════════════════════════════════════════
 * §1 ONE SUBSCRIBER. One module owns the endpoint; everyone else uses its hook.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("§1 exactly one component subscribes to the quota endpoint");

const OWNER = "desktop/quota/quotaQuery.ts";

const namesEndpoint = FILES.filter((f) => /usage\/quota/.test(f.code)).map((f) => f.rel);
ok(
  "only the owner names /usage/quota",
  namesEndpoint.length === 1 && namesEndpoint[0] === OWNER,
  namesEndpoint.join(", "),
);

/* The key as a literal. A second `["usage", "quota"]` anywhere is a second
 * cache entry that merely looks like the first — which is exactly how the two
 * indicators ended up refreshing on different beats. */
const KEY_LITERAL = /\[\s*"usage"\s*,\s*"quota"\s*\]/;
const namesKey = FILES.filter((f) => KEY_LITERAL.test(f.code)).map((f) => f.rel);
ok(
  "only the owner spells the quota query key",
  namesKey.length === 1 && namesKey[0] === OWNER,
  namesKey.join(", "),
);

/* A `useQuery` whose queryKey mentions quota, outside the owner: the shape
 * this round deleted. */
const rogueQuery = FILES.filter(
  (f) =>
    f.rel !== OWNER &&
    /useQuery\s*[<(][\s\S]{0,400}?queryKey:\s*\[[^\]]*quota/.test(f.code),
).map((f) => f.rel);
ok("no component calls useQuery on a quota key itself", rogueQuery.length === 0, rogueQuery.join(", "));

/* One cadence. The interval literal lives with the key. */
const rogueInterval = FILES.filter(
  (f) => f.rel !== OWNER && /refetchInterval:\s*120_000/.test(f.code),
).map((f) => f.rel);
ok(
  "no second 120s quota timer",
  rogueInterval.length === 0,
  rogueInterval.join(", "),
);

ok("the shared key is what the app expects", JSON.stringify(QUOTA_QUERY_KEY) === '["usage","quota"]');
ok("one poll cadence", QUOTA_REFETCH_MS === 120_000);
ok("…with a stale window under it, so a mount reuses the reading", QUOTA_STALE_MS < QUOTA_REFETCH_MS);

/* The duplicate itself is gone, and nothing re-mounts it. */
const strip = FILES.filter((f) => /<QuotaStrip|from "[^"]*QuotaStrip"/.test(f.code)).map((f) => f.rel);
ok("the composer's duplicate strip is gone", strip.length === 0, strip.join(", "));

const rows = FILES.filter((f) => /<QuotaRow\s*\/>/.test(f.code)).map((f) => f.rel);
ok("exactly one QuotaRow is mounted, in the status bar", rows.length === 1 && rows[0] === "desktop/DesktopApp.tsx", rows.join(", "));

/* The context gauge sits INSIDE that row — Konrad asked for it "next to the
 * other two usage bars", not on a surface of its own. */
const rowSrc = FILES.find((f) => f.rel === "desktop/quota/QuotaRow.tsx")!.src;
ok("the row carries the context gauge", /<ContextGauge \/>/.test(rowSrc));
ok("…and the Gemini line", /data-gemini-line/.test(rowSrc));
ok("…and both quota bars", /label="5h"/.test(rowSrc) && /label="7d"/.test(rowSrc));

/* A window with no reading must not draw a fill. A 0%-wide bar and a real 0%
 * are the same pixels, and only one of them is a measurement. */
ok(
  "a missing window renders no fill and an em dash",
  /w\.utilization != null && \(/.test(rowSrc) && /w\.utilization == null \? "—"/.test(rowSrc),
);

/* ── age / reset vocabulary, one implementation ────────────────────────── */
const T0 = Date.parse("2026-08-17T12:00:00Z");
ok("age: fresh", readingAge(new Date(T0).toISOString(), T0) === "just now");
ok("age: minutes", readingAge(new Date(T0 - 3 * 60_000).toISOString(), T0) === "3m ago");
ok("age: hours", readingAge(new Date(T0 - 3 * 3_600_000).toISOString(), T0) === "3h ago");
ok("reset: none", resetsIn(null, T0) === "");
ok("reset: soon", resetsIn(new Date(T0 + 42 * 60_000).toISOString(), T0) === "resets 42m");
ok("reset: past due", resetsIn(new Date(T0 - 1000).toISOString(), T0) === "resetting");

/* ════════════════════════════════════════════════════════════════════════════
 * §2 THE GEMINI LINE — a tally, never a bar, never a fake zero.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§2 the Gemini line says only what is true");

const BASE: GeminiTally = {
  cli_installed: false,
  cli_profile: false,
  auth_note: "Antigravity CLI (agy) is not installed on this box, so the Ultra subscription has never been signed in here.",
  connect_command: "install the Antigravity CLI, then run `agy` once to sign in",
  five_hour: { calls: 0, tokens: null },
  seven_day: { calls: 0, tokens: null },
  no_limit_note:
    "Google publishes no quota endpoint for an AI Ultra subscription — no denominator exists, so this is our own count, not a share of a limit.",
};

const unauthenticated = geminiLine(BASE);
ok("unauthenticated: says so instead of showing 0%", unauthenticated.text === "not signed in", unauthenticated.text);
ok("…tone is not a healthy one", unauthenticated.tone === "unsigned");
ok("…and names the exact sign-in step", unauthenticated.title.includes("agy"));

const counted = geminiLine({
  ...BASE,
  cli_installed: true,
  cli_profile: true,
  auth_note: "agy has a local profile; the session lives in the OS keyring and cannot be read from here, so this is still our own count.",
  connect_command: null,
  five_hour: { calls: 4, tokens: 12_400 },
  seven_day: { calls: 31, tokens: 208_000 },
});
ok("authenticated + counted: shows tokens, not a percentage", counted.text === "12.4k tok/5h", counted.text);
ok("…with no percent sign anywhere in the line", !counted.text.includes("%") && !counted.title.includes("%"));
ok("…and states there is no published limit", counted.title.includes("no denominator exists"));

const noUnits = geminiLine({
  ...BASE,
  cli_installed: true,
  cli_profile: true,
  five_hour: { calls: 3, tokens: null },
  seven_day: { calls: 9, tokens: null },
});
ok("calls without token counts report calls, not zero tokens", noUnits.text === "3 calls/5h", noUnits.text);
ok("…and says why there is no token figure", noUnits.title.includes("no caller recorded a token count"));

const broken = geminiLine({ ...BASE, error: "spend_log is unreachable — the Gemini tally is unknown, not zero: connect ECONNREFUSED" });
ok("a failed tally is 'unknown', never 0", broken.text === "unknown" && broken.tone === "unknown");
ok("…and carries the diagnosis", broken.title.includes("ECONNREFUSED"));

ok("an old server (no tally field) renders an em dash, not a number", geminiLine(undefined).text === "—");

ok("humanCount keeps small readings exact", humanCount(7) === "7" && humanCount(999) === "999");
ok("humanCount abbreviates", humanCount(12_400) === "12.4k" && humanCount(208_000) === "208k" && humanCount(3_100_000) === "3.1M");

/* No bar geometry may reach the Gemini item: a track it could fill is the
 * thing round 1302's research forbids. */
const gemBlock = rowSrc.slice(rowSrc.indexOf("data-gemini-line"), rowSrc.indexOf("<Refresh"));
ok("the Gemini item draws no track", !/width: TRACK_W/.test(gemBlock) && !/borderRadius: 3/.test(gemBlock));

/* ════════════════════════════════════════════════════════════════════════════
 * §3 CONNECTIONS — five answers per row, and the amber rule.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§3 every connection answers the same five questions");

/**
 * WIDENED IN PHASE 4. Five fields were added to `Account` by B4a
 * (`login_email_source`, `stored_health`, `health_downgraded`, `probe_age_ms`,
 * `measured_at`) and this fixture did not grow with them, which left THIS FILE
 * RED under the instrument typecheck gate at HEAD 343a65e — `tsx` strips types
 * without checking them, so the check went on printing ALL PASS while
 * `tsc -p tsconfig.checks-instruments.json` reported TS2739 on this literal.
 * The fixture is the never-probed one, so the two new measurement fields are
 * null here on purpose.
 */
const ACCOUNT: Account = {
  slug: "konrad-max",
  config_dir: "/root/.claude",
  login_email: null,
  login_email_source: "configuration",
  plan_label: "Max 20x",
  priority: 1,
  enabled: true,
  health: "unknown",
  health_detail: null,
  stored_health: "unknown",
  health_downgraded: false,
  probe_age_ms: null,
  measured_at: "2026-08-18T20:00:00.000Z",
  has_refresh: null,
  access_expires_at: null,
  last_probed_at: null,
  last_ok_at: null,
  last_error: null,
  reauth_command: "CLAUDE_CONFIG_DIR=/root/.claude claude /login",
};

/** A probe that happened 4 minutes ago, against the SERVER's clock. Phase 4
 *  made this the difference between a green row and an amber one: a positive
 *  health word with no measurement behind it is now demoted by
 *  `claudeConnection()` itself (R57 layer three), so the "healthy" fixtures
 *  below must carry a probe or they are no longer healthy. */
const PROBED_4_MIN = {
  probe_age_ms: 4 * 60_000,
  last_probed_at: "2026-08-18T19:56:00.000Z",
} as const;

const unprobed = claudeConnection(ACCOUNT, false);
ok("an unprobed account is UNKNOWN, never connected", unprobed.state === "unknown", unprobed.state);
ok("…and its chip says why", unprobed.stateLabel === "UNKNOWN — NOT PROBED", unprobed.stateLabel);
ok("…and the health line refuses to imply it works", unprobed.health.includes("Not known to work"));
ok("…and the action is the probe", unprobed.action.includes("Probe now"));

const healthy = claudeConnection(
  {
    ...ACCOUNT,
    ...PROBED_4_MIN,
    health: "healthy",
    stored_health: "healthy",
    health_detail: "confirmed by a run 4m ago",
    login_email: "k@example.com",
  },
  true,
);
ok("a healthy serving account says so", healthy.state === "connected" && healthy.stateLabel === "SERVING RUNS");
ok(
  // PHASE 4 / R50: it is still the address on the row, and it is now LABELLED.
  // A Claude probe reads the credential file's presence and never learns whose
  // it is, so this address is configuration and now says so on screen. The
  // equality assertion this replaces would have gone on passing while the row
  // implied a verified account — which is exactly the lie R50 names.
  "…and shows the identity, labelled as configuration rather than as a probe result",
  healthy.identity.includes("k@example.com") && healthy.identity.includes("CONFIGURED, not verified"),
  healthy.identity,
);
ok(
  // R45: the health word never travels without its clock.
  "…and the health line leads with the age of the probe behind it",
  healthy.health.startsWith("probed 4 min ago."),
  healthy.health,
);

/* PHASE 4 / R57, LAYER THREE. The same fixture WITHOUT a probe is not healthy,
 * whatever the registry stores. This is the row photographed on 2026-08-18 at
 * phase4/b4c-before-integrations.png — a green SERVING RUNS chip beside the
 * words "never probed" — and it is asserted here as well as in
 * check-connection-states.ts because this file is the one that already owns
 * "an unprobed Claude account is UNKNOWN in amber, never green". */
const storedGreen = claudeConnection(
  { ...ACCOUNT, health: "healthy", stored_health: "healthy", health_detail: "healthy" },
  true,
);
ok(
  "a stored 'healthy' with NO probe age is UNKNOWN, even for the SERVING account",
  storedGreen.state === "unknown" && storedGreen.stateLabel !== "SERVING RUNS",
  `state=${storedGreen.state} stateLabel=${storedGreen.stateLabel}`,
);

const brokenAcct = claudeConnection(
  {
    ...ACCOUNT,
    ...PROBED_4_MIN,
    health: "broken",
    stored_health: "broken",
    health_detail: "invalid_grant",
  },
  false,
);
ok("a broken account is BROKEN", brokenAcct.state === "broken");
ok("…and its action is the exact re-auth command", brokenAcct.action.includes("claude /login"));

/* PHASE 4 / B4c: `GoogleFacts` no longer carries `email`, `checkOk` or
 * `checkMessage`. All three are now one field, `status` — the PERSISTED probe
 * record, which survives a `pm2 restart forge-control` (R48) and carries the
 * `checked_at` that R57 turns on. Losing `email` from this shape is the point:
 * there is now no parameter through which a configured address could be handed
 * to the row and rendered as if a probe had returned it (R50).
 *
 * The state matrix in full — four integrations × four states, plus the
 * inert-assertion control — lives in `scripts/checks/check-connection-states.ts`.
 * What stays here is only the wording this file has always owned. */
const GOOGLE_REAUTH = "python3 /opt/ai-os/google-setup/setup.py";
const GOOGLE_NOW = Date.parse("2026-08-18T20:00:00.000Z");

const noGoogle = googleConnection(
  {
    status: {
      state: "absent",
      identity: null,
      checked_at: null,
      detail: "No credential file at /root/.config/hermes/google_token.json.",
      action: `Run \`${GOOGLE_REAUTH}\` at a terminal and complete the consent in a browser.`,
    },
    hasAccount: false,
    hasRefreshToken: false,
    scopeCount: 0,
    reauthCommand: GOOGLE_REAUTH,
    recheckIntervalMs: 900_000,
  },
  GOOGLE_NOW,
);
ok("no Google credential is NOT CONNECTED", noGoogle.state === "absent");
ok("…and the action is the interactive command, not a button", noGoogle.action.includes("setup.py"));

const googleUnverified = googleConnection(
  {
    status: {
      // The adversarial shape: the server insisting on "connected" while
      // carrying no timestamp. A credential file proves storage, not
      // authorisation, and R57 is what stands between the two.
      state: "connected",
      identity: "konrad.schrein@gmail.com",
      checked_at: null,
      detail: "the credential file is present with a refresh token",
      action: "Press Test connection to run a real token refresh plus a Gmail profile call.",
    },
    hasAccount: true,
    hasRefreshToken: true,
    scopeCount: 9,
    reauthCommand: GOOGLE_REAUTH,
    recheckIntervalMs: 900_000,
  },
  GOOGLE_NOW,
);
ok(
  "a credential nobody checked is UNVERIFIED, not connected",
  googleUnverified.state === "unknown" && googleUnverified.stateLabel === "UNVERIFIED",
  `${googleUnverified.state}/${googleUnverified.stateLabel}`,
);
ok(
  "…and says so, rather than implying health",
  googleUnverified.health.includes("Never checked") &&
    googleUnverified.health.includes("amber and not green"),
  googleUnverified.health,
);
ok(
  "…and does NOT render the address the server tried to hand it",
  !googleUnverified.identity.includes("konrad.schrein@gmail.com"),
  googleUnverified.identity,
);

const googleLive = googleConnection(
  {
    status: {
      state: "connected",
      identity: "konrad.schrein@gmail.com",
      checked_at: "2026-08-18T19:56:00.000Z",
      detail: "Gmail answered for konrad.schrein@gmail.com.",
      action: "Nothing to do. The next scheduled re-check will refresh the timestamp.",
    },
    hasAccount: true,
    hasRefreshToken: true,
    scopeCount: 9,
    reauthCommand: GOOGLE_REAUTH,
    recheckIntervalMs: 900_000,
  },
  GOOGLE_NOW,
);
ok(
  "a live-checked credential is CONNECTED with its identity",
  googleLive.state === "connected" && googleLive.identity.includes("@"),
);
ok(
  "…and states how old that check is",
  googleLive.health.startsWith("probed 4 min ago."),
  googleLive.health,
);

ok("no stored Gemini key is NOT CONNECTED", geminiKeyConnection(false, null, null).state === "absent");
ok("a stored, untested key is UNTESTED — not healthy", geminiKeyConnection(true, "…aB4z", null).stateLabel === "UNTESTED");
ok("a rejected key is BROKEN", geminiKeyConnection(true, "…aB4z", { ok: false, message: "API key not valid" }).state === "broken");

const ultra = ultraConnection(BASE);
ok("Ultra with no local profile is NOT CONNECTED", ultra.state === "absent");
ok("…and the action names agy", ultra.action.includes("agy"));
ok("…and it never claims a percentage", !ultra.what.includes("%") && ultra.what.includes("unpublished"));

const ultraSigned = ultraConnection({ ...BASE, cli_installed: true, cli_profile: true });
ok(
  "a local agy profile is still UNKNOWN — a keyring session is not proof",
  ultraSigned.state === "unknown" && ultraSigned.stateLabel === "SIGNED IN LOCALLY",
);

/* The surface itself: one panel, mounted by both entry points, no leftover
 * ACCOUNTS/INTEGRATIONS split. */
const settingsSrc = FILES.find((f) => f.rel === "desktop/settings/SettingsSurface.tsx")!.src;
ok("settings has a CONNECTIONS section", /label: "CONNECTIONS"/.test(settingsSrc));
ok("…and no separate ACCOUNTS section", !/label: "ACCOUNTS"/.test(settingsSrc));
ok("…and no separate INTEGRATIONS section", !/label: "INTEGRATIONS"/.test(settingsSrc));

const mounts = FILES.filter((f) => /<ConnectionsPanel \/>/.test(f.code)).map((f) => f.rel).sort();
ok(
  "one connections panel, two entry points (shell + /settings)",
  mounts.length === 2 && mounts.includes("settings/page.tsx"),
  mounts.join(", "),
);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — round 1876 quota row + connections`,
);
process.exit(failures === 0 ? 0 : 1);
