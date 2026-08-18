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
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import {
  deleteSecret,
  getSecret,
  listSecrets,
  putSecret,
} from "../lib/secret-store.ts";

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

/* ── Google account (Gmail / Calendar / Drive) ───────────────────────────── */

/** Where setup.py writes the credential (TOKEN_PATH = HERMES_HOME/google_token.json). */
const GOOGLE_TOKEN_PATH =
  process.env.GOOGLE_TOKEN_PATH ?? "/root/.hermes/google_token.json";
const GOOGLE_SETUP_SCRIPT = "/opt/ai-os/google-setup/setup.py";
const GOOGLE_REAUTH_COMMAND = `python3 ${GOOGLE_SETUP_SCRIPT}`;
const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";

interface GoogleTokenFile {
  account?: unknown;
  scopes?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  refresh_token?: unknown;
  token_uri?: unknown;
  expiry?: unknown;
}

interface GoogleAccountView {
  /** Stable handle for the UI's key. One credential file, one account today —
   *  the list shape is plural so a second one does not need a new contract. */
  id: string;
  /** The credential file does NOT record the address (setup.py leaves
   *  `account` empty), so this is usually null until a live check fills it in.
   *  Null is honest; a hardcoded address would be decoration. */
  email: string | null;
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

interface GoogleCheck {
  ok: boolean;
  email: string | null;
  reason: string | null;
  message: string;
  checked_at: string;
}

/** Last live probe result, in memory. Survives no restart on purpose: a stale
 *  "connected" from before a revocation is exactly the fake success state this
 *  panel must not show. */
let lastGoogleCheck: GoogleCheck | null = null;

function readScopes(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

r.get("/google", async (c) => {
  let raw: string;
  try {
    raw = await readFile(GOOGLE_TOKEN_PATH, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return c.json({
        accounts: [],
        last_check: lastGoogleCheck,
        reauth: {
          command: GOOGLE_REAUTH_COMMAND,
          interactive: true,
          why: "setup.py opens a consent URL and waits on a redirect to http://localhost:8765. It needs a human at a browser, so it cannot be started from an API request that has no terminal.",
        },
        detail: `no credential file at ${GOOGLE_TOKEN_PATH} — the Google tooling on this box is not connected`,
      });
    }
    return c.json(
      {
        error: "could not read the Google credential file",
        detail: `${GOOGLE_TOKEN_PATH}: ${e.message}`,
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
        detail: `${GOOGLE_TOKEN_PATH}: ${(err as Error).message}`,
      },
      500,
    );
  }

  const mtime = await stat(GOOGLE_TOKEN_PATH)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);

  const account: GoogleAccountView = {
    id: "hermes-google",
    email:
      typeof parsed.account === "string" && parsed.account.trim()
        ? parsed.account.trim()
        : (lastGoogleCheck?.ok ? lastGoogleCheck.email : null),
    scopes: readScopes(parsed.scopes),
    has_refresh_token:
      typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0,
    client_id: typeof parsed.client_id === "string" ? parsed.client_id : null,
    connected_at: mtime,
    access_expires_at: typeof parsed.expiry === "string" ? parsed.expiry : null,
    token_path: GOOGLE_TOKEN_PATH,
  };

  return c.json({
    accounts: [account],
    last_check: lastGoogleCheck,
    reauth: {
      command: GOOGLE_REAUTH_COMMAND,
      interactive: true,
      why: "setup.py opens a consent URL and waits on a redirect to http://localhost:8765. It needs a human at a browser, so it cannot be started from an API request that has no terminal.",
    },
  });
});

/**
 * POST /api/integrations/google/test — spend the refresh token once and ask
 * Gmail who we are. This is the ONLY way to distinguish "connected" from
 * "invalid_grant", and it is also where the connected email comes from: the
 * credential file does not record it, and `userinfo` is out of scope on this
 * consent, so Gmail's own profile endpoint is the address of record.
 *
 * Nothing is written back — the refreshed access token is used for one call
 * and dropped. The file on disk is not touched by this route at all.
 */
r.post("/google/test", async (c) => {
  let parsed: GoogleTokenFile;
  try {
    parsed = JSON.parse(await readFile(GOOGLE_TOKEN_PATH, "utf8")) as GoogleTokenFile;
  } catch (err) {
    const check: GoogleCheck = {
      ok: false,
      email: null,
      reason: "no_credential",
      message: `Could not read ${GOOGLE_TOKEN_PATH}: ${(err as Error).message}`,
      checked_at: new Date().toISOString(),
    };
    lastGoogleCheck = check;
    return c.json({ ...check, reauth_command: GOOGLE_REAUTH_COMMAND }, 400);
  }

  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id : "";
  const clientSecret =
    typeof parsed.client_secret === "string" ? parsed.client_secret : "";
  const tokenUri =
    typeof parsed.token_uri === "string"
      ? parsed.token_uri
      : "https://oauth2.googleapis.com/token";

  if (!refresh || !clientId || !clientSecret) {
    const check: GoogleCheck = {
      ok: false,
      email: null,
      reason: "incomplete_credential",
      message:
        "The credential file is missing the refresh token or the client identity, so it cannot be renewed. Re-run the setup script.",
      checked_at: new Date().toISOString(),
    };
    lastGoogleCheck = check;
    return c.json({ ...check, reauth_command: GOOGLE_REAUTH_COMMAND });
  }

  const fail = (reason: string, message: string) => {
    const check: GoogleCheck = {
      ok: false,
      email: null,
      reason,
      message,
      checked_at: new Date().toISOString(),
    };
    lastGoogleCheck = check;
    return c.json({ ...check, reauth_command: GOOGLE_REAUTH_COMMAND });
  };

  /** Google's error bodies quote neither secret, but this router's rule is
   *  that nothing upstream is relayed unscrubbed. */
  const clean = (text: string): string =>
    text.split(refresh).join("<redacted>").split(clientSecret).join("<redacted>");

  let tokenRes: Response;
  try {
    tokenRes = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(
      "unreachable",
      `Could not reach Google's token endpoint: ${clean((err as Error).message)}`,
    );
  }

  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) {
    const isInvalidGrant = tokenBody.includes("invalid_grant");
    return fail(
      isInvalidGrant ? "invalid_grant" : "token_refresh_failed",
      isInvalidGrant
        ? "Google refused the refresh token (invalid_grant) — the consent was revoked, the password changed, or the token expired. Gmail, Calendar and Drive are dead until it is re-authorised, and that needs the interactive setup script."
        : `Google answered HTTP ${tokenRes.status} to the refresh: ${clean(tokenBody.slice(0, 300))}`,
    );
  }

  let accessToken = "";
  try {
    const j = JSON.parse(tokenBody) as { access_token?: unknown };
    accessToken = typeof j.access_token === "string" ? j.access_token : "";
  } catch {
    return fail(
      "token_refresh_failed",
      "Google's token endpoint answered 200 with a body that is not JSON.",
    );
  }
  if (!accessToken) {
    return fail(
      "token_refresh_failed",
      "Google's token response carried no access_token.",
    );
  }

  let profileRes: Response;
  try {
    profileRes = await fetch(GMAIL_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(
      "unreachable",
      `The token refreshed, but Gmail did not answer: ${clean((err as Error).message)}`,
    );
  }

  const profileBody = await profileRes.text();
  if (!profileRes.ok) {
    return fail(
      "profile_failed",
      `The token refreshed, so the consent is alive, but Gmail answered HTTP ${profileRes.status}: ${clean(profileBody.slice(0, 300))}`,
    );
  }

  let email: string | null = null;
  try {
    const j = JSON.parse(profileBody) as { emailAddress?: unknown };
    email = typeof j.emailAddress === "string" ? j.emailAddress : null;
  } catch {
    email = null;
  }

  const check: GoogleCheck = {
    ok: true,
    email,
    reason: null,
    message: email
      ? `Connected. Google renewed the token and Gmail answered as ${email}.`
      : "Connected. Google renewed the token and Gmail answered, but returned no address.",
    checked_at: new Date().toISOString(),
  };
  lastGoogleCheck = check;
  return c.json(check);
});

export default r;
