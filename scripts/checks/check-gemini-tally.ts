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
 *   • `agy` state comes from the BINARY plus the PERSISTED PROBE, and from
 *     nothing else. It used to come from walking this process's PATH and from
 *     the existence of a settings FILE — the first lies under pm2 (which never
 *     sources .bashrc, where `agy install` puts its export) and the second is
 *     configuration that survives a revoked session. R4-red photographed the
 *     result: one panel asserting "agy is not installed on this box" directly
 *     above a probe reporting "SIGNED IN · listed 7 models".
 *
 * WHAT THIS CHECK CANNOT DRIVE, AND WHERE IT IS MEASURED INSTEAD. The
 * substrate is now `access("/root/.local/bin/agy", X_OK)` against a named
 * absolute constant with no env seam — that absence of a seam is R52's point,
 * so this check cannot fake "the CLI is missing". The `installed:false` and
 * `installed:null` branches are measured directly, in
 * `forge-control/src/lib/connection-status.test.ts`, over the pure
 * `agyUltraNarrative()`. What THIS file drives is the sidecar: absent, fresh
 * ok, fresh failure and stale, through the real route.
 *
 * Everything runs against a THROWAWAY Postgres and a stubbed Anthropic — no
 * live service, no live database, nothing on :7700 is touched.
 *
 * Run (from forge-control; needs docker). The container password is a shell
 * variable rather than a literal — it is a throwaway, but a literal one in a
 * committed DSN is indistinguishable from a real one to `check-secret-scan.ts`
 * and to a human skimming the file, and this line was that check's last red:
 *   PGPW=$(openssl rand -hex 12)
 *   docker run -d --rm --name r1876-tally -e POSTGRES_PASSWORD="$PGPW" \
 *     -p 55876:5432 postgres:16-alpine
 *   GEMINI_TALLY_DSN="postgres://postgres:$PGPW@127.0.0.1:55876/postgres" \
 *     ./node_modules/.bin/tsx ../scripts/checks/check-gemini-tally.ts
 *   docker rm -f r1876-tally
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
/** The sidecar directory the route reads the persisted probe out of. Nothing
 *  under /opt/ai-os/.secrets is touched: this is the env seam the status store
 *  ships for exactly this purpose. Deliberately EMPTY to start — "nobody has
 *  ever probed" is the state Konrad's box is actually in today. */
const statusDir = join(tmp, "status");
mkdirSync(statusDir, { recursive: true });

const AGY_RECORD = join(statusDir, "agy.json");
/** Frozen so a fixture's freshness does not depend on when the check runs. */
const writeAgyRecord = (r: {
  ok: boolean;
  detail: string;
  ageMs: number;
}): void =>
  writeFileSync(
    AGY_RECORD,
    JSON.stringify({
      ok: r.ok,
      identity: null,
      detail: r.detail,
      checked_at: new Date(Date.now() - r.ageMs).toISOString(),
    }),
  );

process.env.CLAUDE_CREDENTIALS = credsPath;
process.env.FORGE_CONNECTION_STATUS_DIR = statusDir;
process.env.DATABASE_URL = DSN;

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
  cli_installed: boolean | null;
  probe_state: "connected" | "unknown" | "broken" | null;
  probe_checked_at: string | null;
  session_probed_ok: boolean;
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
      env: process.env,
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
  console.log("§1 nothing counted, no probe has ever run");
  {
    const b = await quota();
    ok("the Claude windows still come through", b.five_hour?.utilization === 41);
    ok("a gemini tally is attached", b.gemini !== undefined);
    const g = b.gemini!;
    /* THE ROW THAT USED TO LIE. `agy` IS installed on this box, so the only
     * honest answer here is `true` — and the previous implementation, walking
     * this process's PATH, answered `false`. */
    ok(
      "the CLI is seen where it actually is, not where PATH says",
      g.cli_installed === true,
      `cli_installed=${JSON.stringify(g.cli_installed)}`,
    );
    ok(
      "…and the row does NOT tell Konrad to install software already installed",
      !g.auth_note.includes("not installed"),
      g.auth_note,
    );
    ok(
      "an empty sidecar is 'nobody has asked', not a session",
      g.probe_state === "unknown" && g.probe_checked_at === null && g.session_probed_ok === false,
      `${g.probe_state}/${g.probe_checked_at}/${g.session_probed_ok}`,
    );
    ok(
      "…in a sentence, not a flag alone",
      g.auth_note.includes("no probe currently vouches") && g.auth_note.includes("Never checked"),
      g.auth_note,
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

  /* ══ §6 the probe is the only thing that can say "signed in" ═════════════ */
  console.log("\n§6 only a fresh successful probe produces a signed-in reading");
  sql(`CREATE TABLE IF NOT EXISTS spend_log (
      id          bigserial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      provider    text NOT NULL,
      kind        text NOT NULL,
      amount_eur  numeric(10,4) NOT NULL DEFAULT 0,
      units       integer,
      meta        jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);

  writeAgyRecord({
    ok: true,
    detail: "/root/.local/bin/agy models exited 0 and listed 7 models.",
    ageMs: 60_000,
  });
  {
    const g = (await quota()).gemini!;
    ok("a fresh ok probe is a signed-in session", g.session_probed_ok === true);
    ok("…and the state says so", g.probe_state === "connected", String(g.probe_state));
    ok("…carrying the probe's own words", g.auth_note.includes("listed 7 models"), g.auth_note);
    ok("…so no connect command is offered", g.connect_command === null);
  }

  console.log("\n§6b a probe that came back NO is not a session, and not 'not installed'");
  writeAgyRecord({
    ok: false,
    detail: "exit 1 — Error: Please sign in to view available models.",
    ageMs: 60_000,
  });
  {
    const g = (await quota()).gemini!;
    ok("a failed probe is not a session", g.session_probed_ok === false);
    ok("…it is BROKEN, not absent", g.probe_state === "broken", String(g.probe_state));
    ok(
      "…the CLI is still reported as installed",
      g.cli_installed === true && !g.auth_note.includes("not installed"),
      g.auth_note,
    );
    ok("…and the CLI's own words survive", g.auth_note.includes("Please sign in to view available models"));
    ok("…and a sign-in step is offered again", (g.connect_command ?? "").includes("agy"));
  }

  console.log("\n§6c evidence has a shelf life — a stale success is not a session");
  writeAgyRecord({
    ok: true,
    detail: "/root/.local/bin/agy models exited 0 and listed 7 models.",
    // 3 × the 15-minute default, plus a minute. The literal is written out
    // rather than imported from the subject, for the reason
    // check-connection-states.ts spells out at STALE_AFTER_MS.
    ageMs: 2_700_000 + 60_000,
  });
  {
    const g = (await quota()).gemini!;
    ok("a stale success stops counting as one", g.session_probed_ok === false);
    ok("…and is UNKNOWN, not CONNECTED", g.probe_state === "unknown", String(g.probe_state));
    ok("…saying why, and naming the shelf life", g.auth_note.includes("shelf life"), g.auth_note);
  }

  console.log("\n§6d a corrupt sidecar is an error on screen, never 'never checked'");
  writeFileSync(AGY_RECORD, "{ this is not json");
  {
    const g = (await quota()).gemini!;
    ok("the corrupt record does not read as a session", g.session_probed_ok === false);
    ok("…and the failure is quoted rather than swallowed", g.auth_note.includes("could not be read"), g.auth_note);
    ok(
      "…and it does not take the Claude quota row down with it",
      (await quota()).five_hour?.utilization === 41,
    );
  }
  unlinkSync(AGY_RECORD);
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
