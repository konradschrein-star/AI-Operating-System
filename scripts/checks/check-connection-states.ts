/**
 * check-connection-states.ts — THE TEST THAT DECIDES PHASE 4.
 *
 * Run (from forge-control-web, whose node_modules holds react):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-connection-states.ts
 *
 * ── WHAT IT HOLDS ────────────────────────────────────────────────────────
 * The invariant this whole phase exists for, over ALL FOUR connections rather
 * than over the one that happened to be under a reviewer's nose:
 *
 *   R57  NO CONNECTION RENDERS A POSITIVE STATE WITHOUT A `checked_at`.
 *        `checked_at === null` renders UNKNOWN, in amber, ALWAYS.
 *   R58  every probe failure surfaces the VERBATIM upstream error — status
 *        code and message — not a friendly string.
 *   R50  `identity` is what the PROBE RETURNED, never configuration.
 *   R51  a `checked_at` older than STALE_FACTOR × the re-check interval
 *        renders UNKNOWN, not CONNECTED. Evidence has a shelf life.
 *
 * Four integrations × three fixtures (null / fresh-ok / fresh-fail) is the
 * twelve the phase's acceptance criteria name; §4 adds the thirteenth
 * (stale ⇒ UNKNOWN) for each of the four, and §5 adds the identity rule.
 * §5c adds the state none of them had: a read that came back BROKEN, which is
 * neither a probe result nor a fetch still in flight, and which the panel used
 * to render as READING… for as long as the tab stayed open.
 *
 * Assertions are over the PURE layer — the `ConnectionSummary` objects
 * `app/desktop/settings/connections.ts` produces — not over a screenshot. The
 * browser proof is separate and lives in
 * `docs/plan/artifacts/os-usable-for-work/phase4/browser-harness-phase4.cjs`
 * (`b4c-unknown` compares the rendered chip's computed colour against the
 * `--fg-warn` token). Two different questions: this file asks whether the words
 * are right, that one asks whether the pixels are.
 *
 * ── HOW CLAUDE'S FIXTURES MAP ONTO "checked_at" ──────────────────────────
 * Claude accounts do not carry a `checked_at`; they carry `last_probed_at`
 * plus a SERVER-measured `probe_age_ms`, because their age must not be
 * computed against a browser clock. The three fixtures map exactly:
 *
 *   checked_at null          ⇔  last_probed_at null AND probe_age_ms null
 *   checked_at now + ok      ⇔  probe_age_ms small, health "healthy"
 *   checked_at now + fail    ⇔  probe_age_ms small, health "broken"
 *
 * and the deliberately nastiest fixture in this file is `claudeStoredGreen`:
 * `health: "healthy"` with NO probe behind it. That is the row photographed on
 * 2026-08-18 in `phase4/b4c-before-integrations.png`, where `arved` rendered a
 * green SERVING RUNS chip with the words "never probed" beside it.
 *
 * ── THE INERT-ASSERTION CONTROL (§6) ─────────────────────────────────────
 * An assertion over a clause every branch shares passes at every fixture
 * value and proves nothing. So every rule asserted below is ALSO run against
 * the fixture on the other side of its boundary and REQUIRED TO FAIL there.
 * `discriminates()` is that control: it fails the check if a predicate holds
 * on both sides, naming the predicate, and it is the reason this file is
 * longer than the twelve assertions it was asked for.
 */

import type { Account } from "../../forge-control-web/app/desktop/settings/accountRegistry";
import {
  agyConnection,
  claudeConnection,
  geminiKeyConnection,
  githubConnection,
  googleConnection,
  STALE_FACTOR,
  summaryFromStatus,
  ultraConnection,
  type AgyFacts,
  type ConnectionStatusFacts,
  type ConnectionSummary,
  type GithubFacts,
  type GoogleFacts,
} from "../../forge-control-web/app/desktop/settings/connections";

let failures = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * THE ANTI-INERT CONTROL.
 *
 * Asserts that `predicate` holds on `holdsOn` AND does NOT hold on `failsOn`.
 * A predicate that is true on both sides is not measuring the boundary it
 * claims to measure — it is measuring a clause every branch shares — and this
 * reports that as a failure rather than as two green lines.
 */
function discriminates(
  name: string,
  predicate: (s: ConnectionSummary) => boolean,
  holdsOn: { label: string; summary: ConnectionSummary },
  failsOn: { label: string; summary: ConnectionSummary },
): void {
  const positive = predicate(holdsOn.summary);
  const negative = predicate(failsOn.summary);
  if (positive && !negative) {
    console.log(`  ok   ${name}  [holds on ${holdsOn.label}, fails on ${failsOn.label}]`);
    return;
  }
  failures += 1;
  if (!positive) {
    console.log(`  FAIL ${name} — the rule does NOT hold on ${holdsOn.label}, where it must`);
    return;
  }
  console.log(
    `  FAIL ${name} — INERT: the rule also holds on ${failsOn.label}, so it discriminates nothing`,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Fixtures. One clock, one interval, shared by every integration, so a
 * boundary crossed for one is crossed identically for all four.
 * ══════════════════════════════════════════════════════════════════════════ */

const NOW = Date.parse("2026-08-18T20:00:00.000Z");
const INTERVAL_MS = 900_000; // 15 minutes — forge-control's default cadence

/**
 * 45 minutes, WRITTEN OUT, and this literal is load-bearing.
 *
 * The first version of this file computed it as `INTERVAL_MS * STALE_FACTOR`,
 * importing the factor from the module under test. That made every staleness
 * assertion INERT in the most complete way possible: a mutation run that
 * changed the implementation's `STALE_FACTOR` from 3 to 100 — a 45-minute
 * shelf life silently becoming 25 hours — left all 93 assertions green,
 * because the fixture's idea of "stale" moved with the code it was supposed to
 * be measuring. A test that reads its expected value out of the subject
 * asserts only that the subject agrees with itself.
 *
 * So the boundary is a constant here, and the factor is asserted separately,
 * below, against a literal 3.
 */
const STALE_AFTER_MS = 2_700_000;

const iso = (ageMs: number): string => new Date(NOW - ageMs).toISOString();

/** The verbatim upstream text every BROKEN fixture must carry through to the
 *  rendered row untouched. Deliberately contains a status code, a machine
 *  error name and a sentence — if any layer paraphrases, one of the three
 *  goes missing and the assertions below say which. */
const VERBATIM_401 =
  "UPSTREAM HTTP 401: {\"error\":\"invalid_grant\",\"error_description\":\"Token has been expired or revoked.\"}";

const PROBE_IDENTITY = {
  google: "konrad.schrein@gmail.com",
  agy: "konrad.schrein@gmail.com (Antigravity CLI session)",
  github: "konradschreiner",
  claude: "arved@example.com",
} as const;

/** A configured address that must NEVER appear as a verified identity. If any
 *  row ever renders this string, some layer read configuration and called it a
 *  probe result — which is R50's exact failure. */
const CONFIGURED_ONLY = "configured-not-verified@example.com";

function status(over: Partial<ConnectionStatusFacts>): ConnectionStatusFacts {
  return {
    state: "unknown",
    identity: null,
    checked_at: null,
    detail: "fixture",
    action: "fixture action",
    ...over,
  };
}

/**
 * THE ADVERSARIAL NULL FIXTURE, and it is the whole point of R57.
 *
 * The obvious fixture — `state: "unknown", checked_at: null` — asserts almost
 * nothing: the row is already unknown before any rule runs, so a build that
 * deleted the null rule entirely would still pass it. That was the first shape
 * of this file, and a mutation run (null `checked_at` allowed to fall through
 * to the state the server sent) turned only THREE assertions red instead of
 * the twelve it should have.
 *
 * R57 says "no connection renders a positive state without a `checked_at`" —
 * so the fixture has to be a server INSISTING on the positive state while
 * carrying no timestamp, identity and all. That is not a hypothetical: it is
 * exactly what a credential-file-presence check produces, and what
 * `lastGoogleCheck` produced for a whole process lifetime before B4b.
 */
const claimedConnectedWithNoTimestamp = (identity: string): ConnectionStatusFacts =>
  status({
    state: "connected",
    identity,
    checked_at: null,
    detail: "the credential file is right here on disk",
    action: "fixture action",
  });

/**
 * THE FOURTH FIXTURE: CONNECTED, FRESH, AND CARRYING NO IDENTITY.
 *
 * R4-red's item 3. Every `connected` fixture above supplies an identity, so
 * the `connected` + `identity: null` path was never rendered — and that path
 * is the NORMAL case for `agy`, whose probe returns `identity: null` by
 * construction (`connection-status.ts#classifyAgyProbe`: `agy models` prints a
 * model list and nothing about the account, and inventing an address there
 * would be configuration-as-truth wearing a different hat). A mutation that
 * substituted a configured address into that branch passed green.
 *
 * So this is the fixture that measures it: the state is CONNECTED, the probe
 * returned no name, and §5b asserts that what lands in the identity slot is a
 * stated absence — never `CONFIGURED_ONLY`, never an address from anywhere.
 */
const connectedWithNoIdentity = (detail: string): ConnectionStatusFacts =>
  status({
    state: "connected",
    identity: null,
    checked_at: iso(3 * 60_000),
    detail,
    action: "fixture action",
  });

/* ── Claude ──────────────────────────────────────────────────────────────── */

const CLAUDE_BASE: Account = {
  slug: "arved",
  config_dir: "/root/.claude",
  login_email: PROBE_IDENTITY.claude,
  login_email_source: "configuration",
  plan_label: "Max 20x",
  priority: 1,
  enabled: true,
  health: "unknown",
  health_detail: null,
  stored_health: "unknown",
  health_downgraded: false,
  probe_age_ms: null,
  measured_at: iso(0),
  has_refresh: null,
  access_expires_at: null,
  last_probed_at: null,
  last_ok_at: null,
  last_error: null,
  reauth_command: "CLAUDE_CONFIG_DIR=/root/.claude claude auth login --claudeai",
};

const claudeNever = claudeConnection(CLAUDE_BASE, false, INTERVAL_MS);

const claudeOk = claudeConnection(
  {
    ...CLAUDE_BASE,
    health: "healthy",
    stored_health: "healthy",
    health_detail: "confirmed by a successful run",
    probe_age_ms: 4 * 60_000,
    last_probed_at: iso(4 * 60_000),
    last_ok_at: iso(4 * 60_000),
  },
  false,
  INTERVAL_MS,
);

const claudeBroken = claudeConnection(
  {
    ...CLAUDE_BASE,
    health: "broken",
    stored_health: "broken",
    health_detail: VERBATIM_401,
    probe_age_ms: 2 * 60_000,
    last_probed_at: iso(2 * 60_000),
    last_error: VERBATIM_401,
  },
  false,
  INTERVAL_MS,
);

const claudeStale = claudeConnection(
  {
    ...CLAUDE_BASE,
    health: "healthy",
    stored_health: "healthy",
    health_detail: "confirmed by a successful run",
    probe_age_ms: STALE_AFTER_MS + 60_000,
    last_probed_at: iso(STALE_AFTER_MS + 60_000),
    last_ok_at: iso(STALE_AFTER_MS + 60_000),
  },
  false,
  INTERVAL_MS,
);

/** health "healthy", NO probe. The photographed defect. */
const claudeStoredGreen = claudeConnection(
  { ...CLAUDE_BASE, health: "healthy", stored_health: "healthy", health_detail: "healthy" },
  true, // and it is the SERVING account, which is the strongest green there is
  INTERVAL_MS,
);

/* ── Google ──────────────────────────────────────────────────────────────── */

const googleFacts = (s: Partial<ConnectionStatusFacts>): GoogleFacts => ({
  status: status(s),
  hasAccount: true,
  hasRefreshToken: true,
  scopeCount: 9,
  reauthCommand: "python3 /opt/ai-os/google-setup/setup.py",
  recheckIntervalMs: INTERVAL_MS,
});

const googleNever = googleConnection(
  { ...googleFacts({}), status: claimedConnectedWithNoTimestamp(PROBE_IDENTITY.google) },
  NOW,
);
const googleOk = googleConnection(
  googleFacts({
    state: "connected",
    identity: PROBE_IDENTITY.google,
    checked_at: iso(4 * 60_000),
    detail: `Gmail answered for ${PROBE_IDENTITY.google}.`,
  }),
  NOW,
);
const googleFail = googleConnection(
  googleFacts({ state: "broken", checked_at: iso(60_000), detail: VERBATIM_401 }),
  NOW,
);
const googleStale = googleConnection(
  googleFacts({
    state: "connected",
    identity: PROBE_IDENTITY.google,
    checked_at: iso(STALE_AFTER_MS + 60_000),
    detail: "Gmail answered.",
  }),
  NOW,
);

/* ── agy ─────────────────────────────────────────────────────────────────── */

const agyFacts = (s: Partial<ConnectionStatusFacts>): AgyFacts => ({
  status: status(s),
  recheckIntervalMs: INTERVAL_MS,
});

const agyNever = agyConnection(
  { ...agyFacts({}), status: claimedConnectedWithNoTimestamp(PROBE_IDENTITY.agy) },
  NOW,
);
const agyOk = agyConnection(
  agyFacts({
    state: "connected",
    identity: PROBE_IDENTITY.agy,
    checked_at: iso(90_000),
    detail: "/root/.local/bin/agy models exited 0 and listed 7 models.",
  }),
  NOW,
);
const agyFail = agyConnection(
  agyFacts({
    state: "broken",
    checked_at: iso(30_000),
    detail:
      "/root/.local/bin/agy models exited 1.\n\nUPSTREAM: Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
  }),
  NOW,
);
const agyStale = agyConnection(
  agyFacts({
    state: "connected",
    identity: PROBE_IDENTITY.agy,
    checked_at: iso(STALE_AFTER_MS + 60_000),
    detail: "agy models exited 0.",
  }),
  NOW,
);

/* ── GitHub ──────────────────────────────────────────────────────────────── */

const githubFacts = (s: Partial<ConnectionStatusFacts>): GithubFacts => ({
  status: status(s),
  secretName: "github-pat",
  recheckIntervalMs: INTERVAL_MS,
});

const githubNever = githubConnection(
  { ...githubFacts({}), status: claimedConnectedWithNoTimestamp(PROBE_IDENTITY.github) },
  NOW,
);
const githubOk = githubConnection(
  githubFacts({
    state: "connected",
    identity: PROBE_IDENTITY.github,
    checked_at: iso(11 * 60_000),
    detail:
      "GET https://api.github.com/user answered 200 for konradschreiner. x-oauth-scopes: repo, read:org.",
  }),
  NOW,
);
const githubFail = githubConnection(
  githubFacts({
    state: "broken",
    checked_at: iso(45_000),
    detail:
      "GET https://api.github.com/user was rejected.\n\nUPSTREAM HTTP 401: {\"message\":\"Bad credentials\",\"documentation_url\":\"https://docs.github.com/rest\"}",
  }),
  NOW,
);
const githubStale = githubConnection(
  githubFacts({
    state: "connected",
    identity: PROBE_IDENTITY.github,
    checked_at: iso(STALE_AFTER_MS + 60_000),
    detail: "GET /user answered 200.",
  }),
  NOW,
);

/* ── The fourth fixture, one per integration ─────────────────────────────── */

const googleAnon = googleConnection(
  { ...googleFacts({}), status: connectedWithNoIdentity("Google renewed the token but Gmail named nobody.") },
  NOW,
);
const agyAnon = agyConnection(
  { ...agyFacts({}), status: connectedWithNoIdentity("/root/.local/bin/agy models exited 0 and listed 7 models.") },
  NOW,
);
const githubAnon = githubConnection(
  { ...githubFacts({}), status: connectedWithNoIdentity("GET https://api.github.com/user answered 200 with no login field.") },
  NOW,
);
/** Claude's equivalent: probed, healthy, and its address is configuration —
 *  which is the same question asked of the one integration that has no probed
 *  identity to lose. */
const claudeAnon = claudeConnection(
  {
    ...CLAUDE_BASE,
    login_email: null,
    health: "healthy",
    stored_health: "healthy",
    health_detail: "confirmed by a successful run",
    probe_age_ms: 3 * 60_000,
    last_probed_at: iso(3 * 60_000),
    last_ok_at: iso(3 * 60_000),
  },
  false,
  INTERVAL_MS,
);

/**
 * The four integrations, indexed by the states the phase names.
 *
 * `identityIsProbed` is false for exactly one of them, and that asymmetry is a
 * FINDING rather than a convenience. Google, agy and GitHub each have a probe
 * that returns an account; a Claude probe reads the credential file for
 * PRESENCE and never learns whose it is, which is why the API ships
 * `login_email_source: "configuration"` beside that field. So Claude's identity
 * slot holds configuration, and the rule it is held to is the opposite one: it
 * must be LABELLED as configuration in every state, and must never sit in the
 * slot unqualified where the other three put a verified answer.
 */
const MATRIX = [
  {
    id: "claude",
    anon: claudeAnon,
    never: claudeNever,
    ok: claudeOk,
    fail: claudeBroken,
    stale: claudeStale,
    identity: PROBE_IDENTITY.claude,
    identityIsProbed: false,
    verbatim: VERBATIM_401,
    connectedWord: "CONNECTED",
  },
  {
    id: "google",
    anon: googleAnon,
    never: googleNever,
    ok: googleOk,
    fail: googleFail,
    stale: googleStale,
    identity: PROBE_IDENTITY.google,
    identityIsProbed: true,
    verbatim: VERBATIM_401,
    connectedWord: "CONNECTED",
  },
  {
    id: "agy",
    anon: agyAnon,
    never: agyNever,
    ok: agyOk,
    fail: agyFail,
    stale: agyStale,
    identity: PROBE_IDENTITY.agy,
    identityIsProbed: true,
    verbatim: "Please sign in to view available models",
    connectedWord: "SIGNED IN",
  },
  {
    id: "github",
    anon: githubAnon,
    never: githubNever,
    ok: githubOk,
    fail: githubFail,
    stale: githubStale,
    identity: PROBE_IDENTITY.github,
    identityIsProbed: true,
    verbatim: "Bad credentials",
    connectedWord: "CONNECTED",
  },
] as const;

/** "does this row present a VERIFIED account?" — the predicate every identity
 *  rule below is written in terms of. A string that carries the address AND
 *  the word CONFIGURED is not presenting a verified account; it is presenting
 *  configuration, labelled. */
const presentsVerified = (s: ConnectionSummary, address: string): boolean =>
  s.identity.includes(address) && !/CONFIGURED, not verified/.test(s.identity);

/* ════════════════════════════════════════════════════════════════════════════
 * §1 checked_at null → UNKNOWN, and never the connected word.   (4 assertions)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("§1 checked_at null ⇒ UNKNOWN, amber, never the connected word (R57)");

for (const c of MATRIX) {
  ok(
    `${c.id}: an unchecked connection is UNKNOWN`,
    c.never.state === "unknown",
    `state=${c.never.state}`,
  );
  ok(
    `${c.id}: …and its chip never says the connected word`,
    c.never.stateLabel !== c.connectedWord && c.never.state !== "connected",
    `stateLabel=${c.never.stateLabel}`,
  );
  ok(
    `${c.id}: …and it presents NO verified account, because no probe returned one`,
    !presentsVerified(c.never, c.identity),
    `identity=${c.never.identity}`,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * §2 checked_at now + ok true → CONNECTED, with the probe's identity.
 *                                                               (4 assertions)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§2 a fresh successful probe ⇒ CONNECTED, carrying the identity it returned");

for (const c of MATRIX) {
  ok(
    `${c.id}: a fresh ok probe is CONNECTED`,
    c.ok.state === "connected",
    `state=${c.ok.state}`,
  );
  ok(
    c.identityIsProbed
      ? `${c.id}: …and the row carries the identity the PROBE returned`
      : `${c.id}: …and its address is LABELLED as configuration, because no probe returns one`,
    c.identityIsProbed
      ? presentsVerified(c.ok, c.identity)
      : c.ok.identity.includes(c.identity) && !presentsVerified(c.ok, c.identity),
    `identity=${c.ok.identity}`,
  );
  ok(
    `${c.id}: …and the health line carries the AGE of that probe, as a number`,
    /probed (\d+ (min|h|d) ago|just now)/.test(c.ok.health),
    `health=${JSON.stringify(c.ok.health.slice(0, 120))}`,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * §3 checked_at now + ok false → BROKEN, carrying the VERBATIM upstream text.
 *                                                               (4 assertions)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§3 a fresh failed probe ⇒ BROKEN, with the upstream's own words (R58)");

for (const c of MATRIX) {
  ok(`${c.id}: a fresh failed probe is BROKEN`, c.fail.state === "broken", `state=${c.fail.state}`);
  ok(
    `${c.id}: …and the VERBATIM upstream text survives into the row`,
    c.fail.health.includes(c.verbatim),
    `health=${JSON.stringify(c.fail.health.slice(0, 200))}`,
  );
  ok(
    `${c.id}: …and it is not replaced by a friendly string`,
    !/^(failed|something went wrong|could not connect)\.?$/i.test(c.fail.health.trim()),
    `health=${JSON.stringify(c.fail.health.slice(0, 120))}`,
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * §4 THE THIRTEENTH: a checked_at older than 3× the interval → UNKNOWN.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log(
  `\n§4 a probe older than ${STALE_AFTER_MS / 60_000} minutes ⇒ UNKNOWN (R51)`,
);

/* The factor itself, against a LITERAL. This is the assertion the fixtures
 * above deliberately do not make for themselves — see STALE_AFTER_MS. Change
 * the implementation's factor and this line is what says so, rather than
 * ninety-three assertions quietly re-aiming at the new number. */
ok(
  "the shelf life is 3 × the re-check interval, and the fixtures below pin 45 minutes",
  STALE_FACTOR === 3 && INTERVAL_MS * 3 === STALE_AFTER_MS,
  `STALE_FACTOR=${STALE_FACTOR} INTERVAL_MS=${INTERVAL_MS} STALE_AFTER_MS=${STALE_AFTER_MS}`,
);

for (const c of MATRIX) {
  ok(
    `${c.id}: a stale success is UNKNOWN, not CONNECTED`,
    c.stale.state === "unknown",
    `state=${c.stale.state}`,
  );
  ok(
    `${c.id}: …and the row says WHY, naming the shelf life`,
    /stale/i.test(c.stale.health) && c.stale.health.includes("shelf life"),
    `health=${JSON.stringify(c.stale.health.slice(0, 160))}`,
  );
}

/* THE BOUNDARY, CROSSED BOTH WAYS. One millisecond either side of
 * STALE_FACTOR × interval, for every integration — the fixture above sits a
 * whole minute past the line, which would still pass if the implementation
 * used 4× or 10×. These two do not. */
console.log("\n§4b the staleness boundary itself, ±1ms");

for (const [id, at] of [
  ["google", (ageMs: number) => googleConnection(googleFacts({ state: "connected", identity: PROBE_IDENTITY.google, checked_at: iso(ageMs), detail: "ok" }), NOW)],
  ["agy", (ageMs: number) => agyConnection(agyFacts({ state: "connected", identity: PROBE_IDENTITY.agy, checked_at: iso(ageMs), detail: "ok" }), NOW)],
  ["github", (ageMs: number) => githubConnection(githubFacts({ state: "connected", identity: PROBE_IDENTITY.github, checked_at: iso(ageMs), detail: "ok" }), NOW)],
] as const) {
  ok(
    `${id}: exactly AT the boundary is still CONNECTED`,
    at(STALE_AFTER_MS).state === "connected",
    `state=${at(STALE_AFTER_MS).state}`,
  );
  ok(
    `${id}: one millisecond past it is UNKNOWN`,
    at(STALE_AFTER_MS + 1).state === "unknown",
    `state=${at(STALE_AFTER_MS + 1).state}`,
  );
}

/* Claude's boundary rides `probe_age_ms`, not a timestamp, so it is crossed
 * on its own field rather than through the shared helper. */
const claudeAt = (ageMs: number): ConnectionSummary =>
  claudeConnection(
    {
      ...CLAUDE_BASE,
      health: "healthy",
      stored_health: "healthy",
      health_detail: "confirmed by a successful run",
      probe_age_ms: ageMs,
      last_probed_at: iso(ageMs),
    },
    false,
    INTERVAL_MS,
  );
ok(
  "claude: exactly AT the boundary is still CONNECTED",
  claudeAt(STALE_AFTER_MS).state === "connected",
  `state=${claudeAt(STALE_AFTER_MS).state}`,
);
ok(
  "claude: one millisecond past it is UNKNOWN",
  claudeAt(STALE_AFTER_MS + 1).state === "unknown",
  `state=${claudeAt(STALE_AFTER_MS + 1).state}`,
);

/* ════════════════════════════════════════════════════════════════════════════
 * §5 IDENTITY COMES FROM THE PROBE, NEVER FROM CONFIGURATION (R50).
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§5 identity comes from the probe response, never from configuration (R50)");

/* There is deliberately no parameter through which a configured address could
 * reach `googleConnection`. This asserts that structurally: the address is fed
 * in through the STATUS (a probe result) and comes out; there is no second
 * input that could supply `CONFIGURED_ONLY`, so the only way it could ever be
 * rendered is if some layer started reading the credential file again. */
const googleProbeSaidSo = googleConnection(
  googleFacts({
    state: "connected",
    identity: PROBE_IDENTITY.google,
    checked_at: iso(60_000),
    detail: "Gmail answered.",
  }),
  NOW,
);
ok(
  "google: the rendered identity is the probe's answer",
  googleProbeSaidSo.identity.includes(PROBE_IDENTITY.google),
  googleProbeSaidSo.identity,
);
ok(
  "google: a configured-only address appears in NO state's identity",
  ![googleNever, googleOk, googleFail, googleStale, googleProbeSaidSo].some((s) =>
    s.identity.includes(CONFIGURED_ONLY),
  ),
);
ok(
  "google/github/agy: a BROKEN row presents no verified account — a dead credential has none",
  !presentsVerified(googleFail, PROBE_IDENTITY.google) &&
    !presentsVerified(agyFail, PROBE_IDENTITY.agy) &&
    !presentsVerified(githubFail, PROBE_IDENTITY.github),
  [googleFail.identity, agyFail.identity, githubFail.identity].join(" | "),
);

/* The Claude asymmetry, asserted in full: there is NO state — not even the
 * freshly-probed, currently-serving one — in which that row presents its
 * configured address as a verified account. */
ok(
  "claude: presents a verified account in NO state, because no Claude probe returns one",
  ![claudeNever, claudeOk, claudeBroken, claudeStale, claudeStoredGreen].some((s) =>
    presentsVerified(s, PROBE_IDENTITY.claude),
  ),
  [claudeNever.identity, claudeOk.identity].join(" | "),
);
ok(
  "claude: …and the address is still SHOWN, labelled, rather than hidden",
  claudeOk.identity.includes(PROBE_IDENTITY.claude) &&
    /CONFIGURED, not verified/.test(claudeOk.identity),
  claudeOk.identity,
);

/* ════════════════════════════════════════════════════════════════════════════
 * §5b CONNECTED WITH NO IDENTITY — the fourth fixture, and the normal `agy`
 *     case. R4-red item 3: this path was rendered by nothing, and a mutation
 *     that substituted a configured address into it passed green.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§5b a fresh CONNECTED probe that returned no identity (the normal agy case)");

/** Every address any layer could reach for if it started inventing one: the
 *  configured-only fixture AND each integration's own probed address, which
 *  must not leak from one fixture into another row. */
const NO_ADDRESS_MAY_APPEAR = [
  CONFIGURED_ONLY,
  PROBE_IDENTITY.google,
  PROBE_IDENTITY.agy,
  PROBE_IDENTITY.github,
  PROBE_IDENTITY.claude,
];

for (const c of MATRIX) {
  ok(
    `${c.id}: a fresh probe that named nobody is still CONNECTED — the state is the probe's, not the name's`,
    c.anon.state === "connected",
    `state=${c.anon.state}`,
  );
  ok(
    `${c.id}: …and NO address appears in the identity slot, configured or otherwise`,
    !NO_ADDRESS_MAY_APPEAR.some((addr) => c.anon.identity.includes(addr)),
    `identity=${c.anon.identity}`,
  );
  ok(
    `${c.id}: …and the slot states the absence in words rather than sitting empty`,
    c.anon.identity.trim().length > 0 && !/^(null|undefined|-|—)$/.test(c.anon.identity.trim()),
    `identity=${JSON.stringify(c.anon.identity)}`,
  );
}

/* The anti-inert control for the rule above: "no address appears" must FAIL on
 * the fixture where the probe DID return one, or it is measuring nothing. The
 * three integrations with a probed identity are the ones that can carry it. */
for (const c of MATRIX.filter((m) => m.identityIsProbed)) {
  discriminates(
    `${c.id}: "the identity slot names no address" separates the anonymous probe from the named one`,
    (sum) => !NO_ADDRESS_MAY_APPEAR.some((addr) => sum.identity.includes(addr)),
    { label: `${c.id}.anon`, summary: c.anon },
    { label: `${c.id}.ok`, summary: c.ok },
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * §5c A READ THAT FAILED IS NOT A READ THAT IS STILL RUNNING.
 *     R5-gate item 3: when `fetchAgyConnection()` rejected, the card kept the
 *     reason to itself, the panel's state stayed `null`, and the row head read
 *     READING… for as long as the tab was open — beside a dead API, with the
 *     reason inside a collapsed card body. "READING…" is a claim too.
 *
 *     The boundary this section measures is between the TWO unread states, and
 *     it is exactly the boundary the old code did not have: `null` (in flight)
 *     versus `{read_error}` (came back broken). Both are amber; only one of
 *     them says why, and neither may ever be green.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§5c a read that FAILED says so, verbatim — it does not sit at READING… (R5-gate 3)");

/** A verbatim rejection message, of the shape `messageOf()` produces from a
 *  failed proxy call. The exact string must survive into the row: "could not
 *  load" would not tell Konrad a 502 from an expired session. */
const READ_ERROR = "GET /api/proxy/integrations/connections failed: 502 Bad Gateway";

const READS: {
  id: string;
  failed: ConnectionSummary;
  loading: ConnectionSummary;
  /** The fixture that proves the "no probe age" rule below is not vacuous.
   *  Null for the Gemini key row, which has no probe and no age to carry —
   *  its own non-vacuity control is the `discriminates()` pair. */
  connected: ConnectionSummary | null;
  /** The word this row shows while the fetch is IN FLIGHT. Four of the five
   *  say READING…; the Gemini key row said UNKNOWN before any of this existed
   *  and still does. Written per row rather than assumed, because asserting a
   *  shared literal here would have quietly demanded a copy change nobody
   *  asked for — and the rule is about the FAILED state, not the waiting one. */
  waitingLabel: string;
}[] = [
  {
    id: "google",
    failed: googleConnection({ read_error: READ_ERROR }, NOW),
    loading: googleConnection(null, NOW),
    connected: googleOk,
    waitingLabel: "READING…",
  },
  {
    id: "agy",
    failed: agyConnection({ read_error: READ_ERROR }, NOW),
    loading: agyConnection(null, NOW),
    connected: agyOk,
    waitingLabel: "READING…",
  },
  {
    id: "github",
    failed: githubConnection({ read_error: READ_ERROR }, NOW),
    loading: githubConnection(null, NOW),
    connected: githubOk,
    waitingLabel: "READING…",
  },
  {
    // The Ultra row has no state of its own — it reads the SAME agy value —
    // so it inherits the defect and must inherit the fix. It is asserted here
    // rather than in `check-quota-row.ts` because the boundary is this one.
    id: "gemini-ultra",
    failed: ultraConnection(undefined, { read_error: READ_ERROR }, NOW),
    loading: ultraConnection(undefined, null, NOW),
    connected: ultraConnection(undefined, agyFacts({
      state: "connected",
      identity: null,
      checked_at: iso(60_000),
      detail: "/root/.local/bin/agy models exited 0 and listed 7 models.",
    }), NOW),
    waitingLabel: "READING…",
  },
  {
    /* The fifth row on the panel. It reaches the failed-read rendering by a
     * different door — three primitives, not a facts object — and it is here
     * because a panel with four honest rows and one still saying "Loading…"
     * teaches the reader that "Loading…" is just how this surface looks. */
    id: "gemini-key",
    failed: geminiKeyConnection(null, null, null, READ_ERROR),
    loading: geminiKeyConnection(null, null, null),
    connected: null,
    waitingLabel: "UNKNOWN",
  },
];

for (const r of READS) {
  ok(
    `${r.id}: a failed read renders UNKNOWN — never green, never NOT CONNECTED`,
    r.failed.state === "unknown",
    `state=${r.failed.state}`,
  );
  ok(
    `${r.id}: …and the chip NAMES the failed read instead of a waiting state`,
    /READ FAILED/.test(r.failed.stateLabel) && !/READING/i.test(r.failed.stateLabel),
    `stateLabel=${JSON.stringify(r.failed.stateLabel)}`,
  );
  ok(
    `${r.id}: …and the rejection message is carried VERBATIM into the row`,
    r.failed.health.includes(READ_ERROR),
    JSON.stringify(r.failed.health.slice(0, 200)),
  );
  ok(
    `${r.id}: …and the row says it is not a measurement of the connection`,
    /not a measurement|not a statement about the connection/i.test(r.failed.health),
    JSON.stringify(r.failed.health.slice(0, 200)),
  );
  ok(
    `${r.id}: a read still in flight is UNCHANGED — it still says ${r.waitingLabel}`,
    r.loading.state === "unknown" && r.loading.stateLabel === r.waitingLabel,
    `stateLabel=${JSON.stringify(r.loading.stateLabel)}`,
  );

  /* THE CONTROL THAT MAKES THIS SECTION NON-INERT, and it points at exactly
   * the code that was wrong: before the fix both unread states came out of one
   * branch, so a predicate satisfied by the failed read was satisfied by the
   * loading one too. Each of these must FAIL on `loading`. */
  discriminates(
    `${r.id}: "prints the read's rejection" separates a failed read from one in flight`,
    (s) => s.health.includes(READ_ERROR),
    { label: `${r.id}.readFailed`, summary: r.failed },
    { label: `${r.id}.loading`, summary: r.loading },
  );
  discriminates(
    `${r.id}: "the chip names a failed read" separates a failed read from one in flight`,
    (s) => /READ FAILED/.test(s.stateLabel),
    { label: `${r.id}.readFailed`, summary: r.failed },
    { label: `${r.id}.loading`, summary: r.loading },
  );
  /* And neither unread state may be confused with a real reading. */
  ok(
    `${r.id}: neither unread state carries a probe age, because no probe was read`,
    !/probed (\d+ (min|h|d) ago|just now)/.test(r.failed.health) &&
      !/probed (\d+ (min|h|d) ago|just now)/.test(r.loading.health),
    `${JSON.stringify(r.failed.health.slice(0, 80))} | ${JSON.stringify(r.loading.health.slice(0, 80))}`,
  );
  if (r.connected !== null) {
    ok(
      `${r.id}: …while the CONNECTED fixture does carry one — so the rule above is not vacuous`,
      /probed (\d+ (min|h|d) ago|just now)/.test(r.connected.health),
      JSON.stringify(r.connected.health.slice(0, 120)),
    );
  }
}

/* A failure carrying nothing to print is an ERROR, not a row saying READ
 * FAILED with an empty reason (N1) — the same rule §8 applies to a corrupt
 * timestamp. */
throwsWith(
  "a read failure with an empty reason throws rather than rendering an empty banner",
  () => agyConnection({ read_error: "   " }, NOW),
  "carried no reason to print",
);

/* ════════════════════════════════════════════════════════════════════════════
 * §6 THE PHOTOGRAPHED DEFECT, and the layer that now stops it.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§6 a stored green word with no probe behind it (the 2026-08-18 screenshot)");

ok(
  "claude: health=healthy with NO probe age is UNKNOWN, even when it is the SERVING account",
  claudeStoredGreen.state === "unknown",
  `state=${claudeStoredGreen.state} stateLabel=${claudeStoredGreen.stateLabel}`,
);
ok(
  "claude: …and the chip does not say SERVING RUNS",
  claudeStoredGreen.stateLabel !== "SERVING RUNS",
  claudeStoredGreen.stateLabel,
);
ok(
  "claude: …and the row explains that the stored word is not a reading",
  claudeStoredGreen.health.includes("no probe age came with it"),
  JSON.stringify(claudeStoredGreen.health.slice(0, 160)),
);

/* The other half of the gap: `last_probed_at` set, `probe_age_ms` absent —
 * the shape an older forge-control serves, and the one that slipped between
 * R57's first two layers. It must NOT render `NaN` and must NOT render green. */
const claudeHalfMeasured = claudeConnection(
  {
    ...CLAUDE_BASE,
    health: "healthy",
    stored_health: "healthy",
    health_detail: "healthy",
    last_probed_at: iso(4 * 60_000),
    probe_age_ms: null,
  },
  true,
  INTERVAL_MS,
);
ok(
  "claude: last_probed_at WITHOUT probe_age_ms is UNKNOWN, not green",
  claudeHalfMeasured.state === "unknown",
  `state=${claudeHalfMeasured.state}`,
);
ok(
  "claude: …and renders no NaN anywhere in the row",
  ![
    claudeHalfMeasured.health,
    claudeHalfMeasured.identity,
    claudeHalfMeasured.action,
    claudeHalfMeasured.stateLabel,
  ].some((s) => s.includes("NaN")),
);

/* ════════════════════════════════════════════════════════════════════════════
 * §7 THE INERT-ASSERTION CONTROL. Every rule above, proved to FAIL on the
 *    fixture on the other side of its boundary.
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§7 each rule is proved to discriminate — it must FAIL on the other side");

for (const c of MATRIX) {
  discriminates(
    `${c.id}: "state is unknown" separates never-checked from freshly-ok`,
    (s) => s.state === "unknown",
    { label: `${c.id}.never`, summary: c.never },
    { label: `${c.id}.ok`, summary: c.ok },
  );
  discriminates(
    `${c.id}: "state is connected" separates freshly-ok from never-checked`,
    (s) => s.state === "connected",
    { label: `${c.id}.ok`, summary: c.ok },
    { label: `${c.id}.never`, summary: c.never },
  );
  discriminates(
    `${c.id}: "state is broken" separates a failed probe from a successful one`,
    (s) => s.state === "broken",
    { label: `${c.id}.fail`, summary: c.fail },
    { label: `${c.id}.ok`, summary: c.ok },
  );
  discriminates(
    `${c.id}: "carries the verbatim upstream text" separates broken from ok`,
    (s) => s.health.includes(c.verbatim),
    { label: `${c.id}.fail`, summary: c.fail },
    { label: `${c.id}.ok`, summary: c.ok },
  );
  /* Claude has no probed identity to discriminate ON — see MATRIX. Its
   * equivalent boundary is the probe AGE, which is the thing that actually
   * changes between "checked" and "never checked" for that row. Using the
   * address here instead would be the inert assertion this section exists to
   * catch, and it was: the first run of this file reported exactly that. */
  discriminates(
    c.identityIsProbed
      ? `${c.id}: "presents a VERIFIED account" separates ok from never-checked`
      : `${c.id}: "states a probe age" separates ok from never-checked`,
    c.identityIsProbed
      ? (s) => presentsVerified(s, c.identity)
      : (s) => /probed (\d+ (min|h|d) ago|just now)/.test(s.health),
    { label: `${c.id}.ok`, summary: c.ok },
    { label: `${c.id}.never`, summary: c.never },
  );
  discriminates(
    `${c.id}: "says stale, naming the shelf life" separates a stale probe from a fresh one`,
    (s) => /stale/i.test(s.health) && s.health.includes("shelf life"),
    { label: `${c.id}.stale`, summary: c.stale },
    { label: `${c.id}.ok`, summary: c.ok },
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * §8 THE SHARED LAYER ITSELF — the two inputs that must THROW rather than
 *    degrade into a state (N1).
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n§8 a corrupt record is an ERROR, not a state (N1)");

const COPY = {
  id: "fixture",
  title: "Fixture",
  what: "a fixture",
  labels: {
    connected: "CONNECTED",
    unknown: "UNKNOWN",
    broken: "BROKEN",
    absent: "NOT CONNECTED",
  },
  noIdentity: "none",
};

function throwsWith(name: string, fn: () => unknown, needle: string): void {
  try {
    fn();
    ok(name, false, "it returned a value instead of throwing");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ok(name, message.includes(needle), message);
  }
}

throwsWith(
  "an unparseable checked_at throws, naming the value",
  () =>
    summaryFromStatus(COPY, status({ state: "connected", checked_at: "not-a-date" }), {
      nowMs: NOW,
      intervalMs: INTERVAL_MS,
    }),
  "not a parseable timestamp",
);
throwsWith(
  "a non-positive interval throws rather than dividing by it",
  () =>
    summaryFromStatus(COPY, status({ checked_at: iso(0) }), { nowMs: NOW, intervalMs: 0 }),
  "positive intervalMs",
);
throwsWith(
  "claudeConnection refuses a non-positive interval too",
  () => claudeConnection(CLAUDE_BASE, false, -1),
  "positive intervalMs",
);

/* A checked_at in the FUTURE is a clock we cannot trust, and must under-claim
 * rather than render a very fresh success. */
const futureDated = summaryFromStatus(
  COPY,
  status({ state: "connected", identity: "someone@example.com", checked_at: iso(-60_000) }),
  { nowMs: NOW, intervalMs: INTERVAL_MS },
);
ok(
  "a checked_at in the future renders UNKNOWN, not a very fresh CONNECTED",
  futureDated.state === "unknown",
  `state=${futureDated.state}`,
);
ok(
  "…and it strips the identity with it",
  !futureDated.identity.includes("someone@example.com"),
  futureDated.identity,
);

/* The `absent` state is a different sentence from `broken`, and must not be
 * reachable from a probe result. */
const absent = summaryFromStatus(
  COPY,
  status({ state: "absent", detail: "no credential file", action: "run setup" }),
  { nowMs: NOW, intervalMs: INTERVAL_MS },
);
ok("an absent substrate renders NOT CONNECTED, not BROKEN", absent.state === "absent");
ok("…and carries the reason it is absent", absent.health === "no credential file");

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — phase 4 connection states ` +
    `(4 integrations × {null, fresh-ok, fresh-fail, stale, connected-with-no-identity}, ` +
    `plus the failed READ over all five rows on the panel — R50/R51/R57/R58, R5-gate 3)`,
);
process.exit(failures === 0 ? 0 : 1);
