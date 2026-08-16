/**
 * psql-argv-leak.cjs — ROUND 808, the proof for round 807 finding 3.
 *
 * THE DEFECT. Every version of `secret-sentinel.cjs` through round 806 called
 *
 *     execFileSync("psql", [process.env.DATABASE_URL, "-t", "-A", …])
 *
 * and `check-working-sql-agreement.ts:86` did the same thing. DATABASE_URL is
 * `postgres://postgres:<PASSWORD>@127.0.0.1:5432/content_forge`. When a child
 * process fails, Node builds an `Error` whose `.message` is
 * `Command failed: <the whole argv, verbatim>` — so ANY psql failure (server
 * down, role missing, a typo in the SQL, ON_ERROR_STOP firing) printed the
 * postgres superuser password to stderr, into the transcript of the agent that
 * ran it, and from there into `runs.thread`, permanently, in a database this
 * fleet reads. The `scrub()` beside it redacted the LEAKCANARY and nothing
 * else, so it did not help. A credential-leak sentinel leaking a credential is
 * the joke that writes itself; round 807 found it had already fired on real
 * runs.
 *
 * WHAT THIS SCRIPT DOES. It runs BOTH code paths — the round-806 form and the
 * round-808 form — against a database that cannot exist, with a SYNTHETIC
 * password generated here. It then asserts that the old form leaks it and the
 * new form does not. The failure is real (nothing listens on the probe port),
 * which is the point: this measures the actual error text Node produces, not a
 * claim about it.
 *
 * NO REAL CREDENTIAL IS TOUCHED. The synthetic password is `P808-SYNTHETIC-`
 * plus hex from `crypto.randomBytes`, it is generated fresh per run, it
 * authenticates nothing, and `DATABASE_URL` is never read. That is deliberate:
 * a probe for a credential-leak bug must not need the credential to run, or
 * nobody will ever re-run it.
 *
 * PLUS A DRIFT GUARD. The behavioural half proves the MECHANISM; it cannot
 * prove the shipped files still use it, because it necessarily runs its own
 * copy of both paths. So the second half reads `secret-sentinel.cjs` and
 * `check-working-sql-agreement.ts` as text and asserts the structural
 * properties directly: no connection URL in an `execFileSync` argv, PGPASSWORD
 * on the child env, DATABASE_URL deleted from it, and a `scrub()` whose
 * password branch does not depend on a canary having been passed. If a future
 * round reintroduces the URL in argv, this fails.
 *
 * Run (no arguments, no environment, no database):
 *   node docs/plan/artifacts/phase800/psql-argv-leak.cjs
 *
 * Exit 0 = every assertion held. Exit 1 = at least one failed.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const OUT_DIR = __dirname;
const REPO = path.resolve(__dirname, "../../../..");

/* ── A checker in the shape phase 700/800 already use ─────────────────────── */
function makeChecker() {
  const results = [];
  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    results.push({ name, ok, actual, expected });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}` +
        (ok
          ? ""
          : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
    );
  };
  const note = (name, value) => {
    results.push({ name, note: value });
    console.log(`      ${name}: ${JSON.stringify(value)}`);
  };
  return { results, check, note, failed: () => failures };
}

/* ── The synthetic credential ─────────────────────────────────────────────
 *
 * A closed port on loopback, not a bogus hostname: DNS failure and connection
 * refusal take different paths through libpq, and the one this reproduces is
 * the one the real script hits when postgres is down. */
const PW = `P808-SYNTHETIC-${crypto.randomBytes(12).toString("hex")}`;
const USER = "p808probe";
const DB = "p808_nosuchdb";
const HOST = "127.0.0.1";
const PORT = "59997";
const DSN = `postgres://${USER}:${PW}@${HOST}:${PORT}/${DB}`;
const SQL = "SELECT 1";

/** Everything a failed exec can hand back, as one string to search. */
const errText = (err) =>
  [err && err.message, err && err.stderr, err && err.stdout, err && err.cmd]
    .map((v) => (v == null ? "" : String(v)))
    .join("\n");

/**
 * THE ROUND-806 FORM, copied verbatim from `secret-sentinel.cjs@7b961b5`
 * except that it takes the DSN as an argument instead of reading the real
 * DATABASE_URL. Kept here so the leak is demonstrated, not asserted.
 */
function psqlBefore(sql, url, redact = null) {
  const scrub = (s) => (redact ? String(s).split(redact).join("<canary-redacted>") : String(s));
  try {
    return execFileSync("psql", [url, "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1"], {
      input: sql,
      encoding: "utf8",
    }).trim();
  } catch (err) {
    throw new Error(`psql failed: ${scrub(err.message)}\nstderr: ${scrub(err.stderr ?? "")}`);
  }
}

/** THE ROUND-808 FORM, the same shape the two fixed files now carry. */
function psqlAfter(sql, url, redact = null) {
  let dsn;
  try {
    dsn = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL (value withheld — it contains the password)");
  }
  const password = decodeURIComponent(dsn.password || "");
  const scrub = (s) => {
    let out = String(s);
    if (password) out = out.split(password).join("<pgpassword-redacted>");
    if (redact) out = out.split(redact).join("<canary-redacted>");
    return out;
  };
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  if (password) childEnv.PGPASSWORD = password;
  const argv = [
    "-h", dsn.hostname || "127.0.0.1",
    "-p", dsn.port || "5432",
    "-U", decodeURIComponent(dsn.username || "") || "postgres",
    "-d", decodeURIComponent(dsn.pathname.replace(/^\//, "")) || "content_forge",
    "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1",
  ];
  try {
    return execFileSync("psql", argv, { input: sql, encoding: "utf8", env: childEnv }).trim();
  } catch (err) {
    const e = new Error(`psql failed: ${scrub(err.message)}\nstderr: ${scrub(err.stderr ?? "")}`);
    e.p808 = { argv, childEnv, scrub };
    throw e;
  }
}

function main() {
  const { check, note, results, failed } = makeChecker();
  const started_at = new Date().toISOString();

  console.log("── A. BEHAVIOURAL — both forms against a database that cannot exist ──\n");

  /* ── BEFORE ─────────────────────────────────────────────────────────────── */
  let beforeErr = null;
  try {
    psqlBefore(SQL, DSN);
    beforeErr = null;
  } catch (e) {
    beforeErr = e;
  }
  check("A1 the round-806 form fails (non-vacuous: the leak is measured on a real error)", beforeErr !== null, true);
  const beforeText = beforeErr ? errText(beforeErr) : "";
  check("A2 the round-806 form LEAKS the password into its own error", beforeText.includes(PW), true);
  note("A2 evidence — the leaked substring, password masked", beforeText.split(PW).join("‹PASSWORD-WAS-HERE›").slice(0, 220));

  /* ── AFTER ──────────────────────────────────────────────────────────────── */
  let afterErr = null;
  try {
    psqlAfter(SQL, DSN);
    afterErr = null;
  } catch (e) {
    afterErr = e;
  }
  check("A3 the round-808 form fails the same way (non-vacuous: it is not passing by succeeding)", afterErr !== null, true);
  const afterText = afterErr ? errText(afterErr) : "";
  check("A4 the round-808 form does NOT leak the password anywhere in its error", afterText.includes(PW), false);
  note("A4 evidence — the full error text the new form produces", afterText.slice(0, 220));

  /* Both failures must be the SAME failure, or A4 proves nothing — a new form
   * that fell over earlier (bad flag, psql missing) would also not print a
   * password. Both must have reached libpq and been refused. */
  const refused = (s) => /could not connect|Connection refused|connection to server/i.test(s);
  check("A5 both forms reached libpq and were refused — the same failure, not an earlier one", [refused(beforeText), refused(afterText)], [true, true]);

  /* argv, directly. */
  const argv = afterErr && afterErr.p808 ? afterErr.p808.argv : [];
  check("A6 no argv element contains the password", argv.some((a) => String(a).includes(PW)), false);
  check("A7 no argv element contains a connection URL at all", argv.some((a) => /^postgres(ql)?:\/\//.test(String(a))), false);
  note("A7 evidence — the exact argv psql now receives", argv);

  /* env, directly. */
  const childEnv = afterErr && afterErr.p808 ? afterErr.p808.childEnv : {};
  check("A8 the password travels on the child env as PGPASSWORD", childEnv.PGPASSWORD === PW, true);
  check("A9 DATABASE_URL is deleted from the child env", "DATABASE_URL" in childEnv, false);

  /* The scrub, with NO canary — the half round 806 did not have. */
  const scrub = afterErr && afterErr.p808 ? afterErr.p808.scrub : (s) => s;
  const synthetic = `libpq notice: conninfo user=${USER} password=${PW} sslmode=disable`;
  check("A10 scrub() redacts the password with redact=null (unconditional, not canary-gated)", scrub(synthetic).includes(PW), false);
  check("A10b scrub() leaves the redaction marker so a reader knows something was removed", scrub(synthetic).includes("<pgpassword-redacted>"), true);

  console.log("\n── B. DRIFT GUARD — the shipped files still use the fixed form ──\n");

  const SENTINEL = "docs/plan/artifacts/phase800/secret-sentinel.cjs";
  const WSQL = "scripts/checks/check-working-sql-agreement.ts";
  const src = {};
  for (const rel of [SENTINEL, WSQL]) src[rel] = fs.readFileSync(path.join(REPO, rel), "utf8");

  for (const rel of [SENTINEL, WSQL]) {
    const t = src[rel];
    const label = rel.split("/").pop();
    /* The exact defect: a connection URL as an execFileSync argument. Both the
     * `[url,` and `[DATABASE_URL as string,` spellings the two files used. */
    check(
      `B1 ${label}: no connection URL passed as an execFileSync argument`,
      /execFileSync\(\s*["']psql["']\s*,\s*\[\s*(url|DATABASE_URL|dsn|process\.env\.DATABASE_URL)\b/.test(t),
      false,
    );
    check(`B2 ${label}: psql is addressed with -h/-p/-U/-d flags`, /"-h"[\s\S]{0,200}"-U"[\s\S]{0,200}"-d"/.test(t), true);
    check(`B3 ${label}: the password is handed over as PGPASSWORD`, /PGPASSWORD/.test(t), true);
    check(`B4 ${label}: DATABASE_URL is removed from the child environment`, /delete\s+(childEnv|env)\.DATABASE_URL/.test(t), true);
    check(`B5 ${label}: an env is actually passed to the child`, /env:\s*(childEnv|PG\.env)/.test(t), true);
    check(`B6 ${label}: password redaction is not gated on a canary`, /(if \(password\) out = out\.split\(password\)|password \? s\.split\(password\))/.test(t), true);
  }

  const payload = {
    protocol: "round 808 — psql argv credential leak, before/after",
    finding: "round 807 finding 3",
    started_at,
    finished_at: new Date().toISOString(),
    synthetic_password: {
      note: "generated per run by crypto.randomBytes; authenticates nothing; the real DATABASE_URL is never read by this script",
      prefix: PW.slice(0, 15),
      length: PW.length,
      sha256: crypto.createHash("sha256").update(PW).digest("hex"),
    },
    dsn_shape: `postgres://${USER}:‹synthetic›@${HOST}:${PORT}/${DB}`,
    files_guarded: [SENTINEL, WSQL],
    checks: results.filter((r) => "ok" in r).length,
    failures: failed(),
    results,
  };
  const out = path.join(OUT_DIR, "psql-argv-leak.json");
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failed() === 0 ? "ALL PASS" : `${failed()} FAILURE(S)`} — ${payload.checks} checks → ${out}`);
  process.exit(failed() === 0 ? 0 : 1);
}

main();
