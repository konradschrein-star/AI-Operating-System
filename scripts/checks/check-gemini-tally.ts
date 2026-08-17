/**
 * check-gemini-tally.ts — GET /api/usage/quota carries an honest Gemini count.
 *
 * Konrad asked for his Google subscription's limit beside the Claude ones. The
 * limit is not readable: round 1302 proved Google publishes no quota surface
 * for a consumer AI Ultra subscription (docs/plan/operator-visibility/
 * artifacts/phase1700/gemini-ultra-oauth.md §3.1–§3.4). So the endpoint reports
 * OUR OWN tally, and the sentences it must never say are the point of this
 * check:
 *
 *   • a database that will not answer is `error`, NEVER zero calls;
 *   • rows with no unit count are `tokens: null`, NEVER `tokens: 0`;
 *   • the tally survives an Anthropic 429 — two upstreams, one row, and one
 *     failing is no reason for the other's number to disappear;
 *   • `agy` state is read from the filesystem only. The session lives in the
 *     OS keyring (verified against antigravity.google/docs/cli/install), which
 *     an HTTP handler must not open, so "a profile exists" is as far as an
 *     honest probe goes.
 *
 * Everything runs against a THROWAWAY Postgres and a stubbed Anthropic — no
 * live service, no live database, nothing on :7700 is touched.
 *
 * Run (from forge-control; needs docker):
 *   docker run -d --rm --name r1876-tally -e POSTGRES_PASSWORD=x \
 *     -p 55876:5432 postgres:16-alpine
 *   GEMINI_TALLY_DSN=postgres://postgres:x@127.0.0.1:55876/postgres \
 *     ./node_modules/.bin/tsx ../scripts/checks/check-gemini-tally.ts
 *   docker rm -f r1876-tally
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DSN = process.env.GEMINI_TALLY_DSN;
if (!DSN) {
  console.error(
    "GEMINI_TALLY_DSN is not set. This check needs a THROWAWAY Postgres — it " +
      "creates and drops spend_log. Point it at a container, never at " +
      "content_forge. See the header for the docker line.",
  );
  process.exit(2);
}

let failures = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ── Fixtures on disk ────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "r1876-tally-"));
const credsPath = join(tmp, "credentials.json");
writeFileSync(
  credsPath,
  JSON.stringify({ claudeAiOauth: { accessToken: "fake-oauth-token" } }),
);
/** Deliberately NOT created: the unauthenticated state is the one Konrad has
 *  today, and it is the one that must render as words rather than a zero. */
const agyAbsent = join(tmp, "no-such-agy", "settings.json");
const agyPresent = join(tmp, "agy-settings.json");
writeFileSync(agyPresent, JSON.stringify({ useG1Credits: true }));

/** Kept before PATH is emptied below: `psql` still has to be found, while the
 *  route's `agy` probe must see a PATH with no CLI on it. */
const REAL_PATH = process.env.PATH ?? "";

process.env.CLAUDE_CREDENTIALS = credsPath;
process.env.AGY_SETTINGS_PATH = agyAbsent;
process.env.DATABASE_URL = DSN;
/** `agy` is genuinely absent from this box; PATH is emptied anyway so the
 *  result cannot depend on whatever the runner happens to have installed. */
process.env.PATH = join(tmp, "empty-bin");

/* ── Anthropic stub ──────────────────────────────────────────────────────── */

type Upstream =
  | { status: 200; five: number; seven: number }
  | { status: 429 }
  | { throws: string };
let upstream: Upstream = { status: 200, five: 41, seven: 12 };

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("api.anthropic.com")) {
    return realFetch(input as RequestInfo, init);
  }
  if ("throws" in upstream) return Promise.reject(new Error(upstream.throws));
  if (upstream.status === 429) {
    return Promise.resolve(new Response("{}", { status: 429 }));
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        five_hour: { utilization: upstream.five, resets_at: "2026-08-17T18:00:00Z" },
        seven_day: { utilization: upstream.seven, resets_at: "2026-08-22T00:00:00Z" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}) as typeof fetch;

/* ── Wire shapes ─────────────────────────────────────────────────────────── */

interface Tally {
  cli_installed: boolean;
  cli_profile: boolean;
  auth_note: string;
  connect_command: string | null;
  five_hour: { calls: number; tokens: number | null } | null;
  seven_day: { calls: number; tokens: number | null } | null;
  error?: string;
  no_limit_note: string;
}
interface QuotaBody {
  five_hour?: { utilization: number | null };
  gemini?: Tally;
  error?: string;
  cached?: boolean;
}

/** Fixtures go in through `psql`, not through `pg`: `scripts/checks/` has no
 *  node_modules, so a bare `import "pg"` resolves nowhere from here — the same
 *  constraint, and the same answer, as `psqlQuerier` in check-usage-fold.ts.
 *  The ROUTER still uses the real driver; it is imported from forge-control,
 *  which has it. A failed statement throws with psql's own stderr: a check
 *  that reports PASS because its fixture silently failed is worse than none. */
function sql(statement: string): void {
  try {
    execFileSync("psql", [DSN!, "-v", "ON_ERROR_STOP=1", "-tAXq", "-c", statement], {
      encoding: "utf8",
      env: { ...process.env, PATH: REAL_PATH },
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `psql failed\n  sql: ${statement.slice(0, 200)}\n  ${(err.stderr ?? err.message ?? "").trim()}`,
    );
  }
}

async function main(): Promise<void> {

  /* The scratch table. `units` is nullable on purpose — that nullability is
   * the difference between "we counted no tokens" and "nobody recorded any". */
  sql(`DROP TABLE IF EXISTS spend_log`);
  sql(`
    CREATE TABLE spend_log (
      id          serial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      provider    text NOT NULL,
      kind        text NOT NULL,
      amount_eur  numeric(10,4) NOT NULL DEFAULT 0,
      units       integer,
      meta        jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);

  const { default: router } = await import("../../forge-control/src/routes/usage.ts");

  async function quota(fresh = true): Promise<QuotaBody> {
    const res = await router.request(`/quota${fresh ? "?fresh=1" : ""}`);
    return (await res.json()) as QuotaBody;
  }

  /* ══ §1 nothing logged yet — the state Konrad is in today ════════════════ */
  console.log("§1 nothing counted, nobody signed in");
  {
    const b = await quota();
    ok("the Claude windows still come through", b.five_hour?.utilization === 41);
    ok("a gemini tally is attached", b.gemini !== undefined);
    const g = b.gemini!;
    ok("agy is reported as not installed", g.cli_installed === false && g.cli_profile === false);
    ok(
      "…in a sentence, not a flag alone",
      g.auth_note.includes("not installed") && g.auth_note.includes("never been signed in"),
    );
    ok("…with the exact thing to do", (g.connect_command ?? "").includes("agy"));
    ok("zero calls is a real zero, not an error", g.five_hour?.calls === 0 && g.error === undefined);
    ok(
      "…and tokens are null, not 0 — nobody recorded any",
      g.five_hour?.tokens === null && g.seven_day?.tokens === null,
    );
    ok(
      "the missing denominator is stated in the payload",
      g.no_limit_note.includes("no quota endpoint") && g.no_limit_note.includes("denominator"),
    );
    ok("no percentage is fabricated", !JSON.stringify(g).includes("utilization"));
  }

  /* ══ §2 rows arrive — our count, in tokens ═══════════════════════════════ */
  console.log("\n§2 our own count, once something logs a Gemini call");
  sql(`
    INSERT INTO spend_log (created_at, provider, kind, amount_eur, units) VALUES
      (now() - interval '10 minutes', 'gemini-api',  'llm_input',  0.0021, 8000),
      (now() - interval '20 minutes', 'gemini-api',  'llm_output', 0.0110, 4400),
      (now() - interval '2 days',     'gemini-pool', 'llm_input',  0.0000, 120000),
      (now() - interval '2 days',     'gemini-pool', 'image',      0.0000, 3),
      (now() - interval '9 days',     'gemini-api',  'llm_input',  0.0500, 999999),
      (now() - interval '30 minutes', 'claude-code', 'llm_input',  1.2000, 500000)`);
  {
    const g = (await quota()).gemini!;
    ok("the 5h window counts only Gemini rows in 5h", g.five_hour?.calls === 2, String(g.five_hour?.calls));
    ok("…and sums their tokens", g.five_hour?.tokens === 12_400, String(g.five_hour?.tokens));
    ok("the 7d window includes the older Gemini rows", g.seven_day?.calls === 4, String(g.seven_day?.calls));
    ok(
      "…and an image row's `units` is NOT summed as tokens",
      g.seven_day?.tokens === 132_400,
      String(g.seven_day?.tokens),
    );
    ok("a row older than 7d is outside both windows", (g.seven_day?.calls ?? 0) < 5);
  }

  /* ══ §3 calls without unit counts ════════════════════════════════════════ */
  console.log("\n§3 calls nobody metered are calls, not zero tokens");
  sql(`DELETE FROM spend_log`);
  sql(`
    INSERT INTO spend_log (created_at, provider, kind, amount_eur, units) VALUES
      (now() - interval '5 minutes', 'gemini-pool', 'llm_input', 0, NULL),
      (now() - interval '6 minutes', 'gemini-pool', 'llm_input', 0, NULL)`);
  {
    const g = (await quota()).gemini!;
    ok("the calls are counted", g.five_hour?.calls === 2);
    ok("…and tokens stay null rather than becoming 0", g.five_hour?.tokens === null);
  }

  /* ══ §4 the database refuses — unknown, never zero ═══════════════════════ */
  console.log("\n§4 an unreadable spend_log is 'unknown', never 'nothing'");
  sql(`DROP TABLE spend_log`);
  {
    const g = (await quota()).gemini!;
    ok("the windows are null, not zero", g.five_hour === null && g.seven_day === null);
    ok(
      "…and the payload says unknown-not-zero in words",
      (g.error ?? "").includes("unknown, not zero"),
      g.error,
    );
    ok("…carrying the database's own diagnosis", (g.error ?? "").includes("spend_log"));
  }

  /* ══ §5 the two upstreams are independent ════════════════════════════════ */
  console.log("\n§5 an Anthropic 429 does not take the Gemini line down");
  upstream = { status: 429 };
  {
    const b = await quota();
    ok("the quota reading reports the limit", (b.error ?? "").includes("rate limited"));
    ok("the gemini tally is still attached", b.gemini !== undefined);
    ok("…and still names the sign-in state", (b.gemini?.auth_note ?? "").includes("agy"));
  }
  upstream = { status: 200, five: 41, seven: 12 };

  /* ══ §6 a local agy profile ══════════════════════════════════════════════ */
  console.log("\n§6 a local agy profile is a profile, not a proven session");
  process.env.AGY_SETTINGS_PATH = agyPresent;
  process.env.PATH = tmp; // pretend `agy` resolves: the check writes one below
  writeFileSync(join(tmp, "agy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  {
    const g = (await quota()).gemini!;
    ok("the CLI is seen on PATH", g.cli_installed === true);
    ok("…and its profile is found", g.cli_profile === true);
    ok(
      "…but the session is NOT claimed — it lives in the OS keyring",
      g.auth_note.includes("keyring") && g.auth_note.includes("our own count"),
    );
    ok("…so no connect command is offered", g.connect_command === null);
  }
}

main()
  .then(() => {
    rmSync(tmp, { recursive: true, force: true });
    console.log(
      `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — gemini tally on /usage/quota`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e: unknown) => {
    rmSync(tmp, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
  });
