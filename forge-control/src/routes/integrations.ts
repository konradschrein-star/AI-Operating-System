/**
 * /api/integrations — outside services the OS is wired into, and whether they
 * answer. Two subjects today: the Gemini API key, and the Google account the
 * Gmail/Calendar/Drive tooling already runs on.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO (round 1302 research,
 * docs/plan/operator-visibility/artifacts/phase1700/gemini-ultra-oauth.md §6):
 *
 *   • No "Connect Google AI Ultra" OAuth flow. There is none. The one consumer
 *     flow that ever turned an Ultra subscription into programmatic Gemini
 *     access — Login-with-Google into Gemini Code Assist / Gemini CLI — was
 *     switched off by Google on 2026-06-18 (§1.3). A button here would be a
 *     button onto a closed door.
 *   • No `cloud-platform` scope added to the existing Gmail/Calendar/Drive
 *     consent. It is technically one extra consent on the same Desktop client
 *     (§1.2) and it buys nothing Ultra-related, while widening this box's most
 *     valuable long-lived credential to full Cloud access (§6B).
 *   • No Gemini quota percentage. The v1beta discovery document (revision
 *     20260814) has no quota/usage/credits resource at all (§3.1); the only
 *     credit numbers that exist live behind Google's own agent clients. A bar
 *     needs a denominator, and an invented denominator is worse than no bar.
 *
 * SECRET HANDLING. The Gemini key goes through lib/secret-store.ts — file on
 * disk, 0600, root — under the name `gemini-api-key`, which is the exact path
 * `scripts/gemini-qa.mjs` already resolves (SECRET_FILE there). It never
 * enters postgres, never enters a run thread, and is never echoed back by any
 * response on this router: reads return `present` + a `…last4` mask only. The
 * upstream test sends it in the `x-goog-api-key` HEADER rather than the `?key=`
 * query parameter precisely so it cannot land in an access log or a proxy
 * trace, and every upstream body is passed through `scrub()` before it is
 * quoted back, so even a future Google error that echoed the key could not
 * leak through this router. Phase-800 rules, in full.
 *
 * All routes bind to 127.0.0.1 via index.ts; the browser reaches them through
 * the Next proxy at forge-control-web, behind NextAuth. Same posture as
 * routes/secrets.ts — no second auth layer here.
 */

import { Hono } from "hono";
import { access, readFile, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  deleteSecret,
  getSecret,
  listSecrets,
  putSecret,
} from "../lib/secret-store.ts";
import {
  AGY_BIN,
  AGY_PROBE_ARGS,
  AGY_SIGNIN_COMMAND,
  GITHUB_PAT_SECRET,
  GOOGLE_REAUTH_COMMAND,
  absentConnectionStatus,
  agyBinaryPresent,
  buildConnectionStatus,
  connectionRecheckIntervalMs,
  googleTokenPath,
  probeAgy,
  probeGithub,
  probeGoogle,
  readConnectionRecord,
  resolveGithubToken,
  writeConnectionRecord,
  type ConnectionRecord,
  type ConnectionStatus,
  type GoogleTokenFile,
} from "../lib/connection-status.ts";

const r = new Hono();

/* ── Gemini ──────────────────────────────────────────────────────────────── */

/** The secret-store name. Chosen by `scripts/gemini-qa.mjs`, not by this file:
 *  it reads `/opt/ai-os/.secrets/store/gemini-api-key`. Renaming this breaks
 *  the video-QA CLI silently, which is the one failure mode worth a comment. */
const GEMINI_SECRET = "gemini-api-key";

const STORE_DIR = process.env.SECRET_STORE_DIR ?? "/opt/ai-os/.secrets/store";
/** Display only — shown in the UI so Konrad can see where the key landed. */
const GEMINI_KEY_PATH = join(STORE_DIR, GEMINI_SECRET);

/** `pageSize=200` because the default page is 50 and the account serves 53 —
 *  a silently truncated model list is the kind of small lie this panel exists
 *  to avoid. `next_page_token` is still reported if Google ever pages past it. */
const MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** §6A. Not a floating alias on purpose: `gemini-flash-latest` would change
 *  behaviour under us without a deploy. */
const DEFAULT_MODEL = "gemini-3.7-flash";

/** AI Studio keys are `AIza…`, 39 chars, URL-safe alphabet. The bounds are
 *  deliberately loose (Google has never published a format contract) — this
 *  rejects pasted JSON, quoted strings and multi-line blobs, nothing more. */
const KEY_RE = /^[A-Za-z0-9_\-.]{20,200}$/;

interface KeyStatus {
  present: boolean;
  /** `…last4`, or null when absent. Never the value, never a prefix. */
  masked: string | null;
  stored_at: string | null;
  bytes: number | null;
  path: string;
}

/** Mask a key for display. Short values reveal NOTHING — a 6-character secret
 *  whose last four are shown is 2 characters from being handed over. */
function mask(value: string): string {
  const v = value.trim();
  return v.length > 8 ? `…${v.slice(-4)}` : "…";
}

async function keyStatus(): Promise<KeyStatus> {
  const meta = (await listSecrets()).find((s) => s.name === GEMINI_SECRET);
  if (!meta) {
    return {
      present: false,
      masked: null,
      stored_at: null,
      bytes: null,
      path: GEMINI_KEY_PATH,
    };
  }
  // The value is read here ONLY to compute the mask. It does not leave this
  // function, and KeyStatus has no field that could carry it.
  const value = await getSecret(GEMINI_SECRET);
  return {
    present: true,
    masked: value ? mask(value) : "…",
    stored_at: meta.updatedAt,
    bytes: meta.bytes,
    path: GEMINI_KEY_PATH,
  };
}

/** Belt and braces: never quote an upstream body back without removing the
 *  credential from it first. Google puts the key in neither of the two
 *  documented failure bodies (§1.2) — this exists so that a THIRD, undocumented
 *  body cannot become a leak. */
function scrub(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("<redacted>");
}

interface ReachableModel {
  /** `gemini-3.7-flash` — the `models/` prefix stripped, the id you pass to a
   *  client library. */
  id: string;
  display_name: string | null;
  input_token_limit: number | null;
  output_token_limit: number | null;
}

type TestVerdict =
  | {
      ok: true;
      models: ReachableModel[];
      count: number;
      /** True when Google paged the list — the panel must not present the
       *  models it got as "everything this key can reach". */
      truncated: boolean;
      checked_at: string;
    }
  | {
      ok: false;
      reason:
        | "no_key_stored"
        | "not_an_api_key"
        | "oauth_token_not_key"
        | "key_rejected"
        | "upstream_error"
        | "timeout"
        | "unreachable";
      /** Plain English, for a human reading a settings panel. */
      message: string;
      http_status: number | null;
      /** Google's own words, key-scrubbed. Null when we never got a body. */
      upstream: string | null;
      checked_at: string;
    };

interface ModelRecord {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
}

function toModel(raw: ModelRecord): ReachableModel {
  const name = typeof raw.name === "string" ? raw.name : "";
  return {
    id: name.replace(/^models\//, "") || name,
    display_name: typeof raw.displayName === "string" ? raw.displayName : null,
    input_token_limit:
      typeof raw.inputTokenLimit === "number" ? raw.inputTokenLimit : null,
    output_token_limit:
      typeof raw.outputTokenLimit === "number" ? raw.outputTokenLimit : null,
  };
}

/** Classify a non-200 from `models.list`. The first two branches are the two
 *  bodies captured verbatim in §1.2 of the research; the rest is a truthful
 *  relay rather than a guess. */
function classify(
  status: number,
  body: string,
  key: string,
): Exclude<TestVerdict, { ok: true }> {
  const clean = scrub(body, key);
  const checked_at = new Date().toISOString();
  const base = { ok: false as const, http_status: status, upstream: clean, checked_at };

  if (clean.includes("Method doesn't allow unregistered callers")) {
    return {
      ...base,
      reason: "not_an_api_key",
      message:
        "Google did not recognise this as an API key at all — the request " +
        "arrived without an established identity. Create a key in Google AI " +
        "Studio (aistudio.google.com/apikey) and paste that.",
    };
  }
  if (clean.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return {
      ...base,
      reason: "oauth_token_not_key",
      message:
        "That is an OAuth access token, not an API key. The Gemini API will " +
        "not accept the Google account credential this box already holds — " +
        "there is no path from the AI Ultra subscription to the API (Google " +
        "closed it on 2026-06-18). Use an AI Studio API key.",
    };
  }
  if (clean.includes("API_KEY_INVALID") || clean.includes("API key not valid")) {
    return {
      ...base,
      reason: "key_rejected",
      message:
        "Google rejected the key. It may be revoked, restricted to other APIs " +
        "or referrers, or belong to a project without the Generative Language " +
        "API enabled.",
    };
  }
  return {
    ...base,
    reason: "upstream_error",
    message: `Google answered HTTP ${status}. The key was not accepted, and the reason is not one this panel knows how to translate — the raw response is shown below.`,
  };
}

async function testGeminiKey(key: string): Promise<TestVerdict> {
  let res: Response;
  try {
    res = await fetch(MODELS_URL, {
      headers: { "x-goog-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return {
      ok: false,
      reason: timedOut ? "timeout" : "unreachable",
      message: timedOut
        ? `generativelanguage.googleapis.com did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s. The key was not tested — this says nothing about whether it is valid.`
        : `Could not reach generativelanguage.googleapis.com: ${scrub(e.message, key)}`,
      http_status: null,
      upstream: null,
      checked_at: new Date().toISOString(),
    };
  }

  const text = await res.text();
  if (!res.ok) return classify(res.status, text, key);

  let parsed: { models?: unknown; nextPageToken?: unknown };
  try {
    parsed = JSON.parse(text) as { models?: unknown; nextPageToken?: unknown };
  } catch {
    return {
      ok: false,
      reason: "upstream_error",
      message:
        "Google answered HTTP 200 with a body that is not JSON. Treat the key " +
        "as untested rather than valid.",
      http_status: res.status,
      upstream: scrub(text.slice(0, 400), key),
      checked_at: new Date().toISOString(),
    };
  }

  const models = Array.isArray(parsed.models)
    ? (parsed.models as ModelRecord[]).map(toModel).filter((m) => m.id !== "")
    : [];
  return {
    ok: true,
    models,
    count: models.length,
    truncated:
      typeof parsed.nextPageToken === "string" && parsed.nextPageToken !== "",
    checked_at: new Date().toISOString(),
  };
}

r.get("/gemini", async (c) => {
  try {
    return c.json({
      key: await keyStatus(),
      default_model: DEFAULT_MODEL,
      /* The pool is not a fallback this route implements — it is the default
       * path `scripts/gemini-qa.mjs` already takes. Stated here so the UI can
       * say so without hardcoding a claim about another service. */
      pool: {
        url: process.env.GEMINI_POOL_URL ?? "http://127.0.0.1:8090",
        role: "free default path (no billing, ~46s mean response, no model pinning)",
      },
      api_role:
        "higher-quality opt-in: model-pinned, low-latency, structured output — billed to the key's Cloud project",
    });
  } catch (err) {
    return c.json(
      { error: "could not read the secret store", detail: (err as Error).message },
      500,
    );
  }
});

r.post("/gemini/key", async (c) => {
  let body: { key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body.key !== "string") {
    return c.json({ error: "key is required and must be a string" }, 400);
  }
  const key = body.key.trim();
  if (!key) return c.json({ error: "key is empty" }, 400);
  if (!KEY_RE.test(key)) {
    // The value is NEVER echoed, not even truncated — the whole point of this
    // endpoint is that the key exists in exactly one place on this box.
    return c.json(
      {
        error:
          "that does not look like a Google AI Studio API key (expected 20–200 characters of letters, digits, dash, dot or underscore — no spaces, quotes or newlines)",
      },
      400,
    );
  }

  try {
    await putSecret(GEMINI_SECRET, key, {
      note: "Google AI Studio key for the Gemini API (scripts/gemini-qa.mjs --backend api). Stored from the Integrations panel.",
    });
  } catch (err) {
    return c.json(
      { error: "could not write the secret store", detail: (err as Error).message },
      500,
    );
  }
  // Response carries metadata only. Same rule as POST /api/secrets.
  return c.json({ key: await keyStatus() }, 201);
});

/** Test the stored key against `models.list`. HTTP 200 with `ok:false` for an
 *  upstream verdict — the test itself succeeded, its answer is "no" — and a
 *  4xx/5xx only when THIS route could not do its job. */
r.post("/gemini/test", async (c) => {
  const key = await getSecret(GEMINI_SECRET);
  if (!key || !key.trim()) {
    return c.json(
      {
        ok: false,
        reason: "no_key_stored",
        message: `No Gemini API key is stored. Paste one first; it lands at ${GEMINI_KEY_PATH}.`,
        http_status: null,
        upstream: null,
        checked_at: new Date().toISOString(),
      } satisfies TestVerdict,
      400,
    );
  }
  return c.json(await testGeminiKey(key.trim()));
});

r.delete("/gemini/key", async (c) => {
  const existed = await deleteSecret(GEMINI_SECRET);
  if (!existed) return c.json({ error: "no key stored" }, 404);
  return c.json({ deleted: true, key: await keyStatus() });
});

/* ── Gemini usage: our own count, or nothing ─────────────────────────────── */

const { Pool } = pg;
let spendPool: pg.Pool | null = null;

/** Lazy, like usage.ts's series pool: importing this router (the single-router
 *  probe harness does exactly that) must not open a socket. `spend_log` lives
 *  in content_forge — no DSN guessing, no fallback to another database. */
function spendDb(): pg.Pool {
  if (!spendPool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. spend_log lives in content_forge " +
          "(127.0.0.1:5432); /api/integrations/gemini/usage refuses to guess a DSN.",
      );
    }
    spendPool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    spendPool.on("error", (e) =>
      console.error("[integrations/usage pool]", e.message),
    );
  }
  return spendPool;
}

const USAGE_LOOKBACK_DAYS = 30;

interface UsageRow {
  provider: string;
  rows_5h: string;
  eur_5h: string;
  rows_7d: string;
  eur_7d: string;
  rows_window: string;
  eur_window: string;
}

interface UsageProvider {
  provider: string;
  rows_5h: number;
  eur_5h: number;
  rows_7d: number;
  eur_7d: number;
  rows_lookback: number;
  eur_lookback: number;
}

/**
 * GET /api/integrations/gemini/usage
 *
 * OUR count, from OUR spend_log — never an upstream quota, because none is
 * published (§3.1). `counted:false` means no gateway on this box has ever
 * logged a `gemini%` row in the lookback window, and the UI is expected to
 * say that in words rather than draw an empty bar. A database that will not
 * answer is a 503, NOT a zero: "we spent nothing" and "we cannot tell" are
 * different sentences and must never render the same.
 */
r.get("/gemini/usage", async (c) => {
  let rows: UsageRow[];
  try {
    const res = await spendDb().query<UsageRow>(
      `SELECT provider,
              count(*) FILTER (WHERE created_at >= now() - interval '5 hours')  AS rows_5h,
              coalesce(sum(amount_eur) FILTER (WHERE created_at >= now() - interval '5 hours'), 0) AS eur_5h,
              count(*) FILTER (WHERE created_at >= now() - interval '7 days')   AS rows_7d,
              coalesce(sum(amount_eur) FILTER (WHERE created_at >= now() - interval '7 days'), 0)  AS eur_7d,
              count(*)                                                          AS rows_window,
              coalesce(sum(amount_eur), 0)                                      AS eur_window
         FROM spend_log
        WHERE provider ILIKE 'gemini%'
          AND created_at >= now() - ($1::int * interval '1 day')
        GROUP BY provider
        ORDER BY provider`,
      [USAGE_LOOKBACK_DAYS],
    );
    rows = res.rows;
  } catch (err) {
    return c.json(
      {
        error: "spend_log is unreachable — usage is unknown, not zero",
        detail: (err as Error).message,
      },
      503,
    );
  }

  const providers: UsageProvider[] = rows.map((row) => ({
    provider: row.provider,
    rows_5h: Number(row.rows_5h),
    eur_5h: Number(row.eur_5h),
    rows_7d: Number(row.rows_7d),
    eur_7d: Number(row.eur_7d),
    rows_lookback: Number(row.rows_window),
    eur_lookback: Number(row.eur_window),
  }));

  const sum = (pick: (p: UsageProvider) => number): number =>
    providers.reduce((acc, p) => acc + pick(p), 0);

  return c.json({
    counted: providers.length > 0,
    lookback_days: USAGE_LOOKBACK_DAYS,
    providers,
    totals: {
      rows_5h: sum((p) => p.rows_5h),
      eur_5h: sum((p) => p.eur_5h),
      rows_7d: sum((p) => p.rows_7d),
      eur_7d: sum((p) => p.eur_7d),
    },
    /* Shown verbatim by the panel when `counted` is false. Written here, next
     * to the query, so the sentence and the thing it describes cannot drift. */
    why_empty:
      "Nothing on this box posts a gemini row to /api/spend yet: the Gemini Pool is unbilled and scripts/gemini-qa.mjs does not report usageMetadata. Until a caller logs its calls, we have no honest number to show — and Google publishes no quota endpoint to borrow one from.",
    basis:
      "our own spend_log rows where provider ILIKE 'gemini%'. This is what WE counted; it is not a share of any Google limit.",
  });
});

/* ── Connections: Google, agy, GitHub (R48–R58) ──────────────────────────── */

/**
 * THE INVARIANT THIS SECTION EXISTS FOR (R57):
 *
 *   NO CONNECTION RENDERS A POSITIVE STATE WITHOUT A checked_at TIMESTAMP.
 *   checked_at === null RENDERS UNKNOWN, IN AMBER, ALWAYS.
 *
 * Every `status` field below is produced by exactly one of two functions in
 * `lib/connection-status.ts` — `buildConnectionStatus()` (which funnels through
 * `renderState()`, the only producer of "connected") or
 * `absentConnectionStatus()` (which hardcodes `checked_at: null`). No route in
 * this file assembles a state by hand, so there is one place to audit.
 *
 * WHAT WAS REMOVED, AND WHY THE OLD COMMENT WAS WRONG. Until this task the
 * Google check lived in `let lastGoogleCheck: GoogleCheck | null = null` — a
 * MODULE-LEVEL VARIABLE — whose own comment defended the choice: "Survives no
 * restart on purpose: a stale 'connected' from before a revocation is exactly
 * the fake success state this panel must not show." The fear was right and the
 * remedy was backwards. Dying on restart does not degrade the answer to "we do
 * not know"; it degrades it to "nobody has ever asked", while the credential
 * file still sits on disk looking exactly like a working account. So after
 * every `pm2 restart forge-control` the surface could not distinguish
 * CONNECTED from NEVER CHECKED — the precise failure Konrad calls worse than
 * showing nothing. Staleness is now handled where it belongs: the result is
 * PERSISTED WITH ITS AGE and demoted to UNKNOWN once it is older than three
 * re-check intervals (R51), so a pre-revocation "connected" expires instead of
 * being thrown away and re-learned from zero.
 *
 * IDENTITY COMES FROM THE PROBE RESPONSE, NEVER FROM CONFIGURATION (R50). The
 * old GET fell back to `parsed.account` from the credential file. That field is
 * written by nobody and verified by nothing; rendering it beside a green dot
 * was the same lie in a smaller font. It is still reported — as
 * `configured_account`, explicitly labelled, next to the verified one.
 */

const GOOGLE_ID = "google";
const AGY_ID = "agy";
const GITHUB_ID = "github";

const GOOGLE_REAUTH_WHY =
  "setup.py opens a consent URL and waits on a redirect to http://localhost:8765. It needs a human at a browser, so it cannot be started from an API request that has no terminal.";

function reauthBlock(): { command: string; interactive: boolean; why: string } {
  return { command: GOOGLE_REAUTH_COMMAND, interactive: true, why: GOOGLE_REAUTH_WHY };
}

/** One clock for every status this router builds, so the staleness boundary
 *  and the cron cadence cannot drift apart between two endpoints. */
function clock(): { now: number; intervalMs: number } {
  return { now: Date.now(), intervalMs: connectionRecheckIntervalMs() };
}

/* ── Google ──────────────────────────────────────────────────────────────── */

interface GoogleAccountView {
  /** Stable handle for the UI's key. One credential file, one account today —
   *  the list shape is plural so a second one does not need a new contract. */
  id: string;
  /** THE VERIFIED ADDRESS: the one Gmail's profile call returned on the last
   *  successful probe, and null whenever the connection is not currently
   *  CONNECTED. Never the credential file's own `account` field (R50). */
  email: string | null;
  /** What the credential file claims, labelled as configuration so it can be
   *  shown without being mistaken for a verified identity. Usually null:
   *  setup.py leaves it empty. */
  configured_account: string | null;
  scopes: string[];
  has_refresh_token: boolean;
  client_id: string | null;
  /** mtime of the credential file — when the consent was last written. */
  connected_at: string | null;
  /** Access-token expiry from the file. Access tokens are ~1h and the refresh
   *  renews them; this is NOT a health signal, same as AccountsPanel's note. */
  access_expires_at: string | null;
  token_path: string;
}

/** Kept for the existing panel, which types `last_check` as this shape. Now
 *  derived from the PERSISTED record rather than a variable, and widened with
 *  the verbatim upstream fields R58 requires. */
interface GoogleCheck {
  ok: boolean;
  email: string | null;
  reason: string | null;
  message: string;
  checked_at: string | null;
  http_status: number | null;
  upstream: string | null;
}

const GOOGLE_ACTIONS = {
  connected: "Nothing to do. The next scheduled re-check will refresh the timestamp.",
  unknown: "Press Test connection to run a real token refresh plus a Gmail profile call.",
  broken: `Re-authorise at a terminal: ${GOOGLE_REAUTH_COMMAND}`,
} as const;

function googleCheckFromRecord(record: ConnectionRecord | null): GoogleCheck | null {
  if (record === null) return null;
  return {
    ok: record.ok,
    email: record.ok ? record.identity : null,
    reason: record.ok ? null : "see detail",
    message: record.detail,
    checked_at: record.checked_at,
    http_status: null,
    upstream: null,
  };
}

function readScopes(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/**
 * GET /api/integrations/google
 *
 * Reads the persisted record back. A restart between the probe and this call
 * changes nothing — that is the whole point of R48, and the proof transcript
 * lives in phase4/google-persistence-proof.md.
 */
r.get("/google", async (c) => {
  const tokenPath = googleTokenPath();

  let record: ConnectionRecord | null;
  try {
    record = await readConnectionRecord(GOOGLE_ID);
  } catch (err) {
    return c.json(
      {
        error: "could not read the persisted Google connection status",
        detail: (err as Error).message,
      },
      500,
    );
  }

  let raw: string;
  try {
    raw = await readFile(tokenPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // No credential file at all: ABSENT, not broken and certainly not
      // unknown-with-a-timestamp. There is nothing here to have checked.
      return c.json({
        accounts: [],
        status: absentConnectionStatus(
          GOOGLE_ID,
          `No credential file at ${tokenPath} — the Google tooling on this box has never been connected.`,
          `Run \`${GOOGLE_REAUTH_COMMAND}\` at a terminal and complete the consent in a browser.`,
        ),
        last_check: googleCheckFromRecord(record),
        reauth: reauthBlock(),
        detail: `no credential file at ${tokenPath} — the Google tooling on this box is not connected`,
      });
    }
    return c.json(
      {
        error: "could not read the Google credential file",
        detail: `${tokenPath}: ${e.message}`,
      },
      500,
    );
  }

  let parsed: GoogleTokenFile;
  try {
    parsed = JSON.parse(raw) as GoogleTokenFile;
  } catch (err) {
    return c.json(
      {
        error: "the Google credential file is not valid JSON",
        detail: `${tokenPath}: ${(err as Error).message}`,
      },
      500,
    );
  }

  // Carried over unchanged from the pre-existing GET. The only tolerated catch
  // on this path, and it is tolerable because `connected_at` is decoration:
  // it is "when the consent was last written", it feeds NO state, and `null`
  // renders as "unknown" rather than as anything positive. The file itself was
  // read successfully three lines above, so this cannot mask a missing
  // credential — that case returned ABSENT already.
  const mtime = await stat(tokenPath)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);

  const status = buildConnectionStatus(GOOGLE_ID, record, clock(), GOOGLE_ACTIONS);

  const account: GoogleAccountView = {
    id: "hermes-google",
    // The verified address, and ONLY when the status is currently positive.
    // `status.identity` is null in every other state by construction.
    email: status.identity,
    configured_account:
      typeof parsed.account === "string" && parsed.account.trim()
        ? parsed.account.trim()
        : null,
    scopes: readScopes(parsed.scopes),
    has_refresh_token:
      typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0,
    client_id: typeof parsed.client_id === "string" ? parsed.client_id : null,
    connected_at: mtime,
    access_expires_at: typeof parsed.expiry === "string" ? parsed.expiry : null,
    token_path: tokenPath,
  };

  return c.json({
    accounts: [account],
    status,
    last_check: googleCheckFromRecord(record),
    reauth: reauthBlock(),
  });
});

/**
 * POST /api/integrations/google/test — the real probe (R50): spend the refresh
 * token once, then ask Gmail's profile endpoint who we are. Persisted before
 * the response is written, so a client that never reads the body still leaves
 * a durable `checked_at` behind.
 *
 * This is a READ against the credential file. The refreshed access token is
 * used for one call and dropped; nothing on this path opens the file for
 * writing. Proven by sha256 before and after in
 * phase4/google-persistence-proof.md.
 */
r.post("/google/test", async (c) => {
  const result = await probeGoogle();

  let stored: ConnectionRecord;
  try {
    stored = await writeConnectionRecord(GOOGLE_ID, result.record);
  } catch (err) {
    // The probe succeeded and the STORE failed. Reporting the probe's answer
    // with no timestamp would be exactly the state this task deletes, so this
    // is a 500 carrying both facts (N1).
    return c.json(
      {
        error: "the Google probe ran but its result could not be persisted",
        detail: (err as Error).message,
        probe_detail: result.record.detail,
      },
      500,
    );
  }

  const check: GoogleCheck = {
    ok: stored.ok,
    email: stored.ok ? stored.identity : null,
    reason: result.reason,
    message: stored.detail,
    checked_at: stored.checked_at,
    http_status: result.http_status,
    upstream: result.upstream,
  };

  return c.json({
    ...check,
    status: buildConnectionStatus(GOOGLE_ID, stored, clock(), GOOGLE_ACTIONS),
    reauth_command: GOOGLE_REAUTH_COMMAND,
  });
});

/* ── agy / Antigravity CLI (R52) ─────────────────────────────────────────── */

const AGY_ACTIONS = {
  connected: "Nothing to do. The next scheduled re-check will refresh the timestamp.",
  unknown: "Press Probe to run the CLI and see what it says.",
  broken: `Sign in at a terminal on this box: run \`${AGY_SIGNIN_COMMAND}\`, open the printed Google URL in a browser, and paste the authorization code back into the terminal within 60 seconds. There is no login subcommand and no browser flow this OS can drive for you.`,
} as const;

/** The affordance, in one object, so the panel prints facts rather than a
 *  guess at how a CLI login usually works. Every line here is something
 *  phase0/S-A-agy-flow.md OBSERVED. */
function agyFlow(): {
  binary: string;
  probe_command: string;
  signin_command: string;
  flow: string;
  paste_prompt: string;
  window_seconds: number;
  why_no_button: string;
} {
  return {
    binary: AGY_BIN,
    probe_command: `${AGY_BIN} ${AGY_PROBE_ARGS.join(" ")}`,
    signin_command: AGY_SIGNIN_COMMAND,
    flow: "PKCE authorization-code, not device-code. agy prints a Google consent URL, waits 60 seconds, and asks for an authorization code to be pasted back into the terminal.",
    paste_prompt: "Or, paste the authorization code here and press Enter:",
    window_seconds: 60,
    why_no_button:
      "redirect_uri is https://antigravity.google/oauth-callback, not localhost, so no local listener can catch the callback — a human reads the code off Google's page and types it into the terminal. Observed in phase0/S-A-agy-flow.md §2.",
  };
}

/** "Is there a credential file at all?" — and nothing else. ENOENT and EACCES
 *  mean there is nothing here to be connected, which is ABSENT. Any other
 *  errno is this box failing at something it should be able to do, and is
 *  rethrown so it surfaces as an error rather than degrading into a state
 *  (N1): "no credential" and "the disk is unhappy" are different sentences. */
async function credentialFilePresent(path: string): Promise<boolean> {
  try {
    await access(path, FS.R_OK);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EACCES") return false;
    throw new Error(`could not stat ${path}: ${e.message}`);
  }
}

async function agyStatus(record: ConnectionRecord | null): Promise<ConnectionStatus> {
  if (!(await agyBinaryPresent())) {
    return absentConnectionStatus(
      AGY_ID,
      `${AGY_BIN} is not present or not executable — the Antigravity CLI is not installed on this box.`,
      // NAMES THE BINARY. The Ultra row prints this same action, and an
      // instruction that does not say which path must exist is a step Konrad
      // cannot follow to a checkable end.
      `Install the Antigravity CLI so that ${AGY_BIN} exists, then run \`${AGY_SIGNIN_COMMAND}\` once to sign in.`,
    );
  }
  return buildConnectionStatus(AGY_ID, record, clock(), AGY_ACTIONS);
}

r.get("/agy", async (c) => {
  let record: ConnectionRecord | null;
  try {
    record = await readConnectionRecord(AGY_ID);
  } catch (err) {
    return c.json(
      {
        error: "could not read the persisted agy connection status",
        detail: (err as Error).message,
      },
      500,
    );
  }
  try {
    return c.json({ status: await agyStatus(record), flow: agyFlow() });
  } catch (err) {
    return c.json(
      { error: "could not determine the agy status", detail: (err as Error).message },
      500,
    );
  }
});

/**
 * POST /api/integrations/agy/probe — spawn `<AGY_BIN> models`.
 *
 * `models` and never `-p`: S-A-agy-flow.md §5 measured `models` at 0.32s and
 * confirmed it fails clean when signed out, while `-p` opens the 60-second
 * OAuth wait. A route that can block for a minute is a route that will.
 */
r.post("/agy/probe", async (c) => {
  let record: ConnectionRecord;
  try {
    record = await probeAgy();
  } catch (err) {
    return c.json(
      { error: `could not run ${AGY_BIN}`, detail: (err as Error).message },
      500,
    );
  }

  let stored: ConnectionRecord;
  try {
    stored = await writeConnectionRecord(AGY_ID, record);
  } catch (err) {
    return c.json(
      {
        error: "the agy probe ran but its result could not be persisted",
        detail: (err as Error).message,
        probe_detail: record.detail,
      },
      500,
    );
  }

  try {
    return c.json({ status: await agyStatus(stored), flow: agyFlow() });
  } catch (err) {
    return c.json(
      { error: "could not determine the agy status", detail: (err as Error).message },
      500,
    );
  }
});

/* ── GitHub (R55, R56) ───────────────────────────────────────────────────── */

const GITHUB_ACTIONS = {
  connected: "Nothing to do. The next scheduled re-check will refresh the timestamp.",
  unknown: "Press Probe to make a real GET https://api.github.com/user with the stored token.",
  broken: `The stored token was rejected. Mint a new personal access token on GitHub and store it through the secure panel under the name \`${GITHUB_PAT_SECRET}\` — never paste it into a chat.`,
} as const;

const GITHUB_ABSENT_ACTION = `Store a GitHub personal access token through the secure panel (POST /api/secrets) under the name \`${GITHUB_PAT_SECRET}\`. The value must never travel through a chat message, a brief, a log line or a URL.`;

async function secretNames(): Promise<string[]> {
  return (await listSecrets()).map((s) => s.name);
}

/** Resolve the PAT, or describe precisely what is missing. The token itself
 *  never leaves this function's caller and is never returned, logged or
 *  echoed — only the NAME appears anywhere in a response. */
async function githubToken(): Promise<
  { token: string } | { token: null; status: ConnectionStatus }
> {
  const resolved = await resolveGithubToken(secretNames, getSecret);
  if (resolved.token !== null) return { token: resolved.token };
  const near =
    resolved.candidates.length === 0
      ? ""
      : ` The store does hold ${resolved.candidates.map((n) => `\`${n}\``).join(", ")}, but this probe will not guess which account you mean — store the one you want under \`${GITHUB_PAT_SECRET}\`.`;
  return {
    token: null,
    status: absentConnectionStatus(
      GITHUB_ID,
      `No secret named \`${GITHUB_PAT_SECRET}\` is stored, so there is nothing to authorise with.${near}`,
      GITHUB_ABSENT_ACTION,
    ),
  };
}

r.get("/github", async (c) => {
  let record: ConnectionRecord | null;
  try {
    record = await readConnectionRecord(GITHUB_ID);
  } catch (err) {
    return c.json(
      {
        error: "could not read the persisted GitHub connection status",
        detail: (err as Error).message,
      },
      500,
    );
  }

  let resolved: Awaited<ReturnType<typeof githubToken>>;
  try {
    resolved = await githubToken();
  } catch (err) {
    return c.json(
      { error: "could not read the secret store", detail: (err as Error).message },
      500,
    );
  }

  if (resolved.token === null) {
    return c.json({ status: resolved.status, secret_name: GITHUB_PAT_SECRET });
  }
  return c.json({
    status: buildConnectionStatus(GITHUB_ID, record, clock(), GITHUB_ACTIONS),
    secret_name: GITHUB_PAT_SECRET,
  });
});

/**
 * POST /api/integrations/github/probe — a real `GET /user`.
 *
 * "Token present" is storage, not authorisation: the only thing that produces
 * CONNECTED here is a 200 carrying a `login`. The token goes in an
 * Authorization HEADER, never a query string, so it cannot land in an access
 * log; it is not written to the status record, not logged, and not echoed.
 */
r.post("/github/probe", async (c) => {
  let resolved: Awaited<ReturnType<typeof githubToken>>;
  try {
    resolved = await githubToken();
  } catch (err) {
    return c.json(
      { error: "could not read the secret store", detail: (err as Error).message },
      500,
    );
  }
  if (resolved.token === null) {
    return c.json({ status: resolved.status, secret_name: GITHUB_PAT_SECRET }, 400);
  }

  const record = await probeGithub(resolved.token);

  let stored: ConnectionRecord;
  try {
    stored = await writeConnectionRecord(GITHUB_ID, record);
  } catch (err) {
    return c.json(
      {
        error: "the GitHub probe ran but its result could not be persisted",
        detail: (err as Error).message,
        probe_detail: record.detail,
      },
      500,
    );
  }

  return c.json({
    status: buildConnectionStatus(GITHUB_ID, stored, clock(), GITHUB_ACTIONS),
    secret_name: GITHUB_PAT_SECRET,
  });
});

/* ── All three at once, for the settings panel's first paint ─────────────── */

/**
 * GET /api/integrations/connections — every persisted status in one call, so
 * B4c's panel makes one request instead of three and cannot render two of them
 * against different clocks. Reads only; it never probes.
 */
r.get("/connections", async (c) => {
  const out: ConnectionStatus[] = [];
  const errors: { id: string; detail: string }[] = [];

  for (const id of [GOOGLE_ID, AGY_ID, GITHUB_ID]) {
    try {
      const record = await readConnectionRecord(id);
      if (id === AGY_ID) {
        out.push(await agyStatus(record));
        continue;
      }
      if (id === GITHUB_ID) {
        const resolved = await githubToken();
        out.push(
          resolved.token === null
            ? resolved.status
            : buildConnectionStatus(GITHUB_ID, record, clock(), GITHUB_ACTIONS),
        );
        continue;
      }
      const tokenPath = googleTokenPath();
      const present = await credentialFilePresent(tokenPath);
      out.push(
        present
          ? buildConnectionStatus(GOOGLE_ID, record, clock(), GOOGLE_ACTIONS)
          : absentConnectionStatus(
              GOOGLE_ID,
              `No credential file at ${tokenPath} — the Google tooling on this box has never been connected.`,
              `Run \`${GOOGLE_REAUTH_COMMAND}\` at a terminal and complete the consent in a browser.`,
            ),
      );
    } catch (err) {
      // A connection whose status cannot be read is reported as an ERROR, not
      // omitted and not defaulted: a missing card and a broken card look
      // identical to a reader, and only one of them is our fault (N1).
      errors.push({ id, detail: (err as Error).message });
    }
  }

  if (errors.length > 0 && out.length === 0) {
    return c.json({ error: "no connection status could be read", errors }, 500);
  }
  return c.json({
    connections: out,
    errors,
    recheck_interval_ms: connectionRecheckIntervalMs(),
  });
});

export default r;
