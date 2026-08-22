"use client";

/**
 * The connections client — Google, `agy` and GitHub. Phase 4 / B4c.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
 * `app/api.ts` is 1462 lines and every lane of this project wants to add to
 * it. Five lanes editing one module is how a seven-phase project serialises on
 * a merge conflict, so `02-architecture.md` §8 rules one `api-<lane>.ts` per
 * lane and this is the connections lane's. It imports nothing FROM `api.ts`:
 * that module's `getJson`/`postJson` are module-private, and — the reason that
 * matters more — they throw `${res.status} ${res.statusText}`, dropping the
 * body. The body is where forge-control puts its diagnostic, and R58 is that
 * Konrad must be able to tell an expired token from a network outage. A helper
 * that discards the upstream's own words cannot satisfy R58, so this file
 * keeps its own.
 *
 * ── THE ONE RULE OVER EVERY SHAPE BELOW (R57) ────────────────────────────
 * `checked_at === null` means UNKNOWN. Always, for every connection, with no
 * exception for "but the credential file is right there". `identity` is what
 * the PROBE RESPONSE returned and is null in every non-connected state by
 * construction upstream (`lib/connection-status.ts#renderState`) — this client
 * re-declares that in its types rather than trusting a comment, so a component
 * that tries to render an identity beside a broken state has to write the
 * narrowing down and see what it is doing.
 *
 * ── N1: NO SILENT FALLBACK ───────────────────────────────────────────────
 * There is no `?? null`, no `|| []` and no `catch {}` in this file. A non-2xx
 * throws a `ConnectionApiError` carrying the HTTP status AND the raw body; a
 * body that is not JSON throws saying so and quoting it. A settings surface
 * that renders an empty card because a fetch failed is exactly the "status
 * that cannot distinguish connected from never checked" this phase deletes.
 *
 * Backed by `forge-control/src/routes/integrations.ts` (B4b) and the shapes in
 * `forge-control/src/lib/connection-status.ts`. Read-only functions GET;
 * `probe*` functions POST and cost a real upstream call each.
 */

/* ── Wire shapes — mirror lib/connection-status.ts exactly ───────────────── */

/** `absent` means the SUBSTRATE is missing — no credential file, no stored
 *  PAT, no installed binary — which is decidable without probing. A probe that
 *  ran and was told no is `broken`, which is a different sentence. */
export type ConnectionState = "connected" | "unknown" | "broken" | "absent";

export interface ConnectionStatus {
  id: string;
  state: ConnectionState;
  /** The email/login the PROBE returned. Non-null only when `state` is
   *  `connected`; the last-known identity of a now-broken connection is
   *  carried inside `detail` instead, where it cannot be mistaken for current. */
  identity: string | null;
  /** ISO-8601, or null when nothing has ever probed. Null ⇒ UNKNOWN (R57). */
  checked_at: string | null;
  /** The verbatim upstream answer on failure — status code and body (R58). */
  detail: string;
  /** The exact next step, in the imperative. */
  action: string;
}

export interface ConnectionsResponse {
  connections: ConnectionStatus[];
  /** A connection whose status could not be READ is reported here rather than
   *  omitted: a missing card and a broken card look identical to a reader. */
  errors: { id: string; detail: string }[];
  /** The re-check cadence. A `checked_at` older than 3× this is UNKNOWN. */
  recheck_interval_ms: number;
}

export interface GoogleAccountView {
  id: string;
  /** The VERIFIED address, from the last successful probe. Null otherwise. */
  email: string | null;
  /** What the credential file claims. Configuration, never a reading. */
  configured_account: string | null;
  scopes: string[];
  has_refresh_token: boolean;
  client_id: string | null;
  connected_at: string | null;
  access_expires_at: string | null;
  token_path: string;
}

export interface GoogleCheck {
  ok: boolean;
  email: string | null;
  reason: string | null;
  message: string;
  checked_at: string | null;
  http_status: number | null;
  /** Google's own words, scrubbed of the refresh token and client secret. */
  upstream: string | null;
}

export interface GoogleConnectionResponse {
  accounts: GoogleAccountView[];
  status: ConnectionStatus;
  last_check: GoogleCheck | null;
  reauth: { command: string; interactive: boolean; why: string };
  detail?: string;
}

/** Every field here is something `phase0/S-A-agy-flow.md` OBSERVED at a
 *  terminal. The UI prints these rather than a guess at how a CLI login
 *  usually works — building a paste-a-code affordance against an assumed flow
 *  is what R53 exists to prevent. */
export interface AgyFlow {
  binary: string;
  probe_command: string;
  signin_command: string;
  flow: string;
  paste_prompt: string;
  window_seconds: number;
  why_no_button: string;
}

export interface AgyConnectionResponse {
  status: ConnectionStatus;
  flow: AgyFlow;
}

export interface GithubConnectionResponse {
  status: ConnectionStatus;
  /** The name the PAT is stored under. The NAME travels; the value never
   *  leaves the server (R55). */
  secret_name: string;
}

/**
 * The Gemini CLI — `/usr/bin/gemini`, signed in with a Google account.
 *
 * A DIFFERENT SUBJECT from `GET /gemini`, which is the billed AI Studio API
 * key. One is a key in the secret store; the other is an OAuth session on
 * disk, and they fail independently — so they are two rows, not one row with
 * two meanings. Status-only on purpose: `PLAN.md` §4 gives this connection the
 * same three-function pattern as `agy` but names no `flow` block for it, and a
 * field this client does not read cannot be a field it describes wrongly.
 */
export interface GeminiCliConnectionResponse {
  status: ConnectionStatus;
}

/* ── The one reader, and it never softens a failure ──────────────────────── */

const ROOT = "/api/proxy/integrations";

/**
 * Thrown on any non-2xx, and on a 2xx whose body is not JSON.
 *
 * `status` and `body` are both kept because they answer different questions: a
 * 401 with `{"error":"bad credentials"}` and a 502 with an nginx error page are
 * both "it did not work" and require completely different actions from Konrad.
 */
export class ConnectionApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly path: string;

  constructor(path: string, status: number, body: string, message: string) {
    super(message);
    this.name = "ConnectionApiError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/** forge-control's error shape. Every 4xx/5xx from this router carries at
 *  least one of these; anything else is reported as the raw body. */
interface ErrorBody {
  error?: string;
  detail?: string;
  message?: string;
}

function diagnosticOf(parsed: unknown, status: number, raw: string): string {
  if (parsed !== null && typeof parsed === "object") {
    const b = parsed as ErrorBody;
    const parts = [b.error, b.detail, b.message].filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
    if (parts.length > 0) return parts.join(" — ");
  }
  return raw.trim() === "" ? `HTTP ${status} with an empty body` : raw.slice(0, 600);
}

/**
 * ONE reader for every call in this module.
 *
 * It reads the body as TEXT first and parses second, on purpose. `res.json()`
 * on an HTML error page throws a `SyntaxError` whose message names a character
 * position and nothing else, which is how "the middleware served the sign-in
 * page at HTTP 200" reads as a JSON bug three files away from the cause. Here,
 * the raw text is in the thrown error.
 */
async function callConnections<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });

  const raw = await res.text();
  let parsed: unknown = null;
  let parseFailure: string | null = null;
  try {
    parsed = raw === "" ? null : (JSON.parse(raw) as unknown);
  } catch (err) {
    parseFailure = err instanceof Error ? err.message : String(err);
  }

  if (!res.ok) {
    throw new ConnectionApiError(
      path,
      res.status,
      raw,
      `${path} answered HTTP ${res.status}: ${diagnosticOf(parsed, res.status, raw)}`,
    );
  }

  if (parseFailure !== null) {
    throw new ConnectionApiError(
      path,
      res.status,
      raw,
      `${path} answered HTTP ${res.status} with a body that is not JSON (${parseFailure}). ` +
        `First 200 characters: ${JSON.stringify(raw.slice(0, 200))}. ` +
        `If that looks like a sign-in page, the middleware rewrote this call and returned 200.`,
    );
  }

  if (parsed === null) {
    throw new ConnectionApiError(
      path,
      res.status,
      raw,
      `${path} answered HTTP ${res.status} with an empty body, but a JSON object was expected.`,
    );
  }

  return parsed as T;
}

/* ── The four connections ────────────────────────────────────────────────── */

/** Every persisted status in one call, so the panel's first paint cannot show
 *  two connections rendered against two different clocks. Reads only; the
 *  server never probes on this path. */
export const fetchConnections = (): Promise<ConnectionsResponse> =>
  callConnections<ConnectionsResponse>("/connections");

export const fetchGoogleConnection = (): Promise<GoogleConnectionResponse> =>
  callConnections<GoogleConnectionResponse>("/google");

/** A REAL call: refreshes the token and asks Gmail's profile endpoint who we
 *  are (R50). Persisted server-side before the response is written, so the
 *  `checked_at` survives even a client that drops the answer. */
export const probeGoogleConnection = (): Promise<GoogleCheck & { status: ConnectionStatus }> =>
  callConnections<GoogleCheck & { status: ConnectionStatus }>("/google/test", {
    method: "POST",
  });

export const fetchAgyConnection = (): Promise<AgyConnectionResponse> =>
  callConnections<AgyConnectionResponse>("/agy");

/** Spawns `/root/.local/bin/agy models` — absolute path, ~0.3s, and it never
 *  opens the 60-second OAuth wait that `agy -p` does. */
export const probeAgyConnection = (): Promise<AgyConnectionResponse> =>
  callConnections<AgyConnectionResponse>("/agy/probe", { method: "POST" });

export const fetchGithubConnection = (): Promise<GithubConnectionResponse> =>
  callConnections<GithubConnectionResponse>("/github");

/** A real `GET https://api.github.com/user`. The token goes up in an
 *  Authorization header on the SERVER; nothing in this module has ever seen
 *  it, and no function here takes one as an argument — that is deliberate, and
 *  it is why R55 cannot be violated from the browser by accident. */
export const probeGithubConnection = (): Promise<GithubConnectionResponse> =>
  callConnections<GithubConnectionResponse>("/github/probe", { method: "POST" });

export const fetchGeminiCliConnection = (): Promise<GeminiCliConnectionResponse> =>
  callConnections<GeminiCliConnectionResponse>("/gemini-cli");

/** A REAL call: runs the Gemini CLI and reports what it answered. Persisted
 *  server-side before the response is written, exactly like the agy probe. */
export const probeGeminiCliConnection = (): Promise<GeminiCliConnectionResponse> =>
  callConnections<GeminiCliConnectionResponse>("/gemini-cli/probe", { method: "POST" });

/* ════════════════════════════════════════════════════════════════════════════
 * THE CLI SIGN-IN BROKER — `PLAN.md` §3.2 (the shape) and §4 (the verbs).
 *
 * ── WHY THESE TYPES ARE COPIED FROM A PLAN AND NOT FROM AN ENDPOINT ──────
 * The broker is being built in the `main` workstream while this file is being
 * written in `web`; there is no running server to read the shape off, and
 * inventing one from a live response would mean mirroring whatever happened to
 * be deployed rather than what was agreed. So this mirrors `PLAN.md` §3.2
 * field for field, and anything the server adds beyond it is ignored rather
 * than described wrongly here.
 *
 * ── THE ONE RULE THAT OUTRANKS EVERY OTHER RULE IN THIS FILE ─────────────
 * THE AUTHORIZATION CODE TRAVELS IN A POST BODY AND NOWHERE ELSE. Not in a
 * path, not in a query string, not in a header, not in an error message, not
 * in a thrown `Error`, not in a retry. `submitCliAuthCode` is the only
 * function that has ever seen one, it does not store it, and the diagnostics
 * it throws are written from the PROVIDER and the SESSION ID — both of which
 * are public — precisely so that no future edit can widen them into the code.
 * A code that reaches a URL reaches an access log, and an access log is read
 * by everything.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The three CLIs the broker can sign in. Anything else is a 404 upstream. */
export type CliAuthProvider = "agy" | "gemini-cli" | "claude";

/**
 * Where a login is, as the SERVER sees it. There is no eighth state and no
 * "submitted": a code that has been pasted is `exchanging` until the CLI
 * answers, and then it is `connected`, `failed` or `expired`. The UI never
 * invents an optimistic state of its own — that is what a "submitted" toast
 * is, and it is the exact lie this whole surface exists to delete.
 */
export type CliAuthState =
  | "idle"
  | "starting"
  | "awaiting_code"
  | "exchanging"
  | "connected"
  | "expired"
  | "failed";

/** The probe's own record — mirrors `ConnectionRecord` in
 *  `forge-control/src/lib/connection-status.ts`. Its presence is what makes
 *  `connected` mean "a probe returned an identity" rather than "the CLI exited
 *  0", and it is null in every state before that probe has run. */
export interface CliAuthProbe {
  ok: boolean;
  identity: string | null;
  detail: string;
  checked_at: string | null;
}

export interface CliAuthStatus {
  provider: CliAuthProvider;
  state: CliAuthState;
  session_id: string | null;
  /** The consent URL — non-null ONLY while `state === "awaiting_code"`. The
   *  PKCE verifier is minted per launch, so a URL from a dead session can
   *  never be completed; the server nulls it and the control clears its own
   *  copy rather than leaving a link that leads to a closed door. */
  url: string | null;
  /** The CLI's own prompt line, verbatim, so the box on screen can be matched
   *  against what the terminal is actually asking for. */
  prompt: string | null;
  /** The hard consent window in seconds, or null when the provider has none
   *  that anybody has measured. Null is NOT "no limit" — it is "unmeasured",
   *  and the control says so rather than drawing a countdown from a guess. */
  window_seconds: number | null;
  started_at: string | null;
  expires_at: string | null;
  /** Human, scrubbed of the code, and where it helps, the CLI's verbatim tail. */
  detail: string;
  /** The exact next click, in the same voice the connection rows use. */
  action: string;
  probe: CliAuthProbe | null;
}

/** Claude alone needs a target: the registry key and the config directory the
 *  credential will be written into. The other two providers have exactly one
 *  identity per box and take no input. */
export interface CliAuthTarget {
  slug: string;
  config_dir: string;
}

const CLI_AUTH_ROOT = "/cli-auth";

/** `?slug=` for Claude, nothing for the other two. The slug is a registry key,
 *  never a credential — it is the only thing about this flow that is allowed
 *  in a query string. */
function slugQuery(slug: string | null): string {
  return slug === null || slug.trim() === "" ? "" : `?slug=${encodeURIComponent(slug.trim())}`;
}

/**
 * Launch a login. Kills whatever session that provider had and mints a fresh
 * URL, because the challenge behind the old one is dead by construction.
 */
export async function startCliAuth(
  provider: CliAuthProvider,
  target: CliAuthTarget | null = null,
): Promise<CliAuthStatus> {
  if (target !== null) {
    if (target.slug.trim() === "") {
      throw new Error(`cannot start a ${provider} login without a slug to register it under`);
    }
    if (!target.config_dir.trim().startsWith("/")) {
      throw new Error(
        `cannot start a ${provider} login: the config directory must be an absolute path, got ` +
          `${JSON.stringify(target.config_dir)}`,
      );
    }
  }
  return callConnections<CliAuthStatus>(`${CLI_AUTH_ROOT}/${provider}/start`, {
    method: "POST",
    body: JSON.stringify(
      target === null ? {} : { slug: target.slug.trim(), config_dir: target.config_dir.trim() },
    ),
  });
}

/** Where the login is NOW. The server re-inspects the pane on every call, so
 *  this is a measurement rather than a cached verdict. */
export const readCliAuth = (
  provider: CliAuthProvider,
  slug: string | null = null,
): Promise<CliAuthStatus> =>
  callConnections<CliAuthStatus>(`${CLI_AUTH_ROOT}/${provider}${slugQuery(slug)}`);

/**
 * Deliver the authorization code, and answer with what the CLI actually did.
 *
 * The code is in the BODY. Read the block at the top of this section before
 * touching this function: no argument of it is ever interpolated into a
 * message, a path or a log, and the two guards below are written against
 * `provider` and the emptiness of the field rather than against its contents.
 */
export async function submitCliAuthCode(
  provider: CliAuthProvider,
  input: { session_id: string; code: string; slug?: string | null },
): Promise<CliAuthStatus> {
  if (input.session_id.trim() === "") {
    throw new Error(
      `cannot deliver a code for ${provider}: there is no live session — press Connect first`,
    );
  }
  const code = input.code.trim();
  if (code === "") {
    throw new Error(`cannot deliver an empty code for ${provider}`);
  }
  const body: { session_id: string; code: string; slug?: string } = {
    session_id: input.session_id.trim(),
    code,
  };
  if (input.slug !== undefined && input.slug !== null && input.slug.trim() !== "") {
    body.slug = input.slug.trim();
  }
  return callConnections<CliAuthStatus>(`${CLI_AUTH_ROOT}/${provider}/code`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Abandon a login: the server kills the pane and reports `idle`. */
export const cancelCliAuth = (
  provider: CliAuthProvider,
  slug: string | null = null,
): Promise<CliAuthStatus> =>
  callConnections<CliAuthStatus>(`${CLI_AUTH_ROOT}/${provider}/cancel`, {
    method: "POST",
    body: JSON.stringify(slug === null || slug.trim() === "" ? {} : { slug: slug.trim() }),
  });
