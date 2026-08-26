/**
 * browser-shots.ts — "which UI did you actually look at?", answered from the
 * transcript. Round 1350, PHASE 6 item 2 (client half).
 *
 * Pure, React-free, dependency-free, and it NEVER THROWS: every entry point
 * returns `[]` (or `null`) on anything it does not recognise. It runs inside
 * the render path of every tool row in a 300-entry transcript, so a malformed
 * payload must cost a wasted regex, not a blank chat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT MARKDOWN, AND MUST NEVER BECOME MARKDOWN
 * ═══════════════════════════════════════════════════════════════════════════
 * `rehype-forge-allowlist.ts` turns EVERY markdown image into inert text. Read
 * its header: that was a real beacon hole — an agent that has read a hostile
 * page writes the message this console renders, and `![x](http://attacker/…)`
 * made the console fetch an attacker-chosen URL from Konrad's IP the moment he
 * opened the chat. It was closed on purpose and it stays closed.
 *
 * Screenshots therefore do NOT travel as markdown. They travel as STRUCTURED
 * data: this module reads the tool-call/tool-result payloads the mapping layer
 * already produced, extracts a 12-hex directory id and a filename, VALIDATES
 * both against fixed character classes, and `shotSrc()` builds the URL itself
 * from those two validated pieces. No attacker-supplied string ever reaches an
 * `src` — the only thing an agent's output can influence is *which file under
 * /opt/ai-os/uploads/<12hex>/ is shown*, and every one of those was written by
 * this machine. A future reader tempted to "just re-enable images in the
 * allowlist": don't. The allowlist and this file are two halves of one
 * decision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO SHAPES IT READS
 * ═══════════════════════════════════════════════════════════════════════════
 * (a) A `Bash` tool_result from `scripts/research-browser.mjs`, which prints a
 *     JSON status carrying `screenshots: [{ label, path, url, url_servable }]`
 *     (research-browser.mjs:306 `screenshotRecord`).
 *
 *     NOT parsed as JSON, and that is deliberate rather than lazy. The real
 *     captured fixture (run 7a0c6432, entry 121) is the operator piping the
 *     tool through `grep -A3 '"path"'` — three lines of a JSON object, brace
 *     unbalanced, `JSON.parse` hopeless. What survives every such mangling is
 *     the RECORD SHAPE: a `"url"` member whose value is
 *     `/api/uploads/<12hex>/<name>`. That is what this matches — the shape, not
 *     prose. A result that merely mentions `/api/uploads` in a sentence has no
 *     such member and yields nothing (asserted in check-browser-shots.ts).
 *
 * (b) A `Read` tool_call whose `file_path` is under `/opt/ai-os/uploads/<12hex>/`
 *     — the operator opening a shot to look at it. Note this also catches an
 *     image Konrad ATTACHED to the chat (POST /api/uploads writes into the same
 *     tree with the same id shape); `source: "read"` is what distinguishes the
 *     two provenances, and the UI says "images" rather than "screenshots" when
 *     any ref came in that way. See docs/plan/artifacts/phase1350/browser-visibility.md.
 */

/** The uploads route's own gate: `/^[a-f0-9]{12}$/`, 400 for anything else
 *  (forge-control/src/routes/uploads.ts:24). Never weaken it. */
const DIR_ID_RE = /^[a-f0-9]{12}$/;

/**
 * A filename we are willing to put in a URL. Deliberately NARROWER than the
 * server's `safeName`, which rewrites offending characters to `_`: rewriting
 * here would produce a URL for a file that does not exist under that name, so
 * anything outside this class is dropped instead.
 */
const SHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,119}$/;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

/** `20260805T101530Z-perplexity-login-wall.png` → stamp + label.
 *  Same convention as forge-control/src/lib/uploads-index.ts:23. */
const STAMPED_NAME_RE = /^(\d{8}T\d{6}Z)-(.+)\.[A-Za-z0-9]+$/;

/** A `"url": "/api/uploads/<12hex>/<name>"` member, however mangled its
 *  surroundings. `[^"\\]` rather than `.`: a JSON escape inside the value means
 *  this is not a plain filename and we want no part of it. */
const URL_MEMBER_RE = /"url"\s*:\s*"\/api\/uploads\/([a-f0-9]{12})\/([^"\\/]{1,140})"/g;

/** `"file_path": "…"` — the salvage path for a `Read` whose args are not
 *  parseable JSON (a clipped payload). */
const FILE_PATH_MEMBER_RE = /"file_path"\s*:\s*"([^"\\]{1,300})"/;

const UPLOADS_PATH_RE = /^\/opt\/ai-os\/uploads\/([a-f0-9]{12})\/([^/]{1,140})$/;

/** Where this file's screenshots are proxied from — the same `/api/proxy`
 *  rewrite every other client call goes through (app/api.ts:22,
 *  next.config.mjs). */
const PROXY_ROOT = "/api/proxy";

export interface BrowserShotRef {
  /** The 12-hex uploads directory — a run's `uploadsRunId`. Validated. */
  dirId: string;
  /** Bare filename, validated against SHOT_NAME_RE. */
  name: string;
  /** The forge-control path that serves it. Built here from the two validated
   *  pieces, never lifted verbatim out of the payload. `shotSrc()` is what the
   *  browser actually loads; this field is the greppable server-side form. */
  url: string;
  /** Human label — the convention's `<label>` segment, else the bare stem. */
  label: string;
  /** The shot's own time, ISO-8601 UTC, parsed from the filename stamp. Null
   *  when the name carries no stamp (a chat attachment, `image.png`). */
  ts: string | null;
  source: "bash" | "read";
}

/** What the mapping layer hands a tool row (thread-mapping.ts `ToolCallPart`),
 *  reduced to the three fields this module reads. Structural on purpose — the
 *  check script builds these from a raw thread without importing React. */
export interface ToolCallLike {
  toolName: string;
  argsText?: string;
  result?: unknown;
}

/**
 * A run id in its uploads-directory form: the first 12 hex characters of the
 * run UUID.
 *
 * MIRRORS `uploadsRunId` in forge-control/src/lib/cc-runner.ts:138 — the
 * producer of the convention. It is re-derived here rather than imported
 * because engine internals are owned by another project this cycle and this
 * one may not touch that file; the assertion
 * `"ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f" → "ece63bdb1f2a"` is copied from
 * cc-runner.test.ts:80 into check-browser-shots.ts so the two stay pinned to
 * each other. If that assertion ever fails, the convention moved and this file
 * is wrong, not the test.
 *
 * Differs from the engine's version in exactly one way: it returns `null`
 * where cc-runner throws. The engine is DECIDING a directory and must fail
 * loudly; this is a renderer LOOKING one up, and a row with an unusable id
 * simply has no screenshots to show.
 */
export function uploadsDirId(runId: string | null | undefined): string | null {
  if (typeof runId !== "string") return null;
  const hex = runId.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (hex.length < 12) return null;
  return hex.slice(0, 12);
}

/** `20260817T032357Z` → `2026-08-17T03:23:57Z`. Null for anything else. */
export function stampToIso(stamp: string | null): string | null {
  if (stamp === null || !/^\d{8}T\d{6}Z$/.test(stamp)) return null;
  const d = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const t = `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  return `${d}T${t}Z`;
}

/** `20260817T032357Z-settings-dark.png` → `03:23:57` (UTC, no locale).
 *  Formatted from the STAMP, not from `Date#toLocaleTimeString`: this renders
 *  during SSR as well as in the browser and a locale-dependent string there is
 *  a hydration mismatch. */
export function shotClock(ts: string | null): string {
  if (ts === null || ts.length < 20) return "";
  return ts.slice(11, 19);
}

export interface ParsedShotName {
  label: string;
  ts: string | null;
}

/** Convention first, honest fallback second. Never throws. */
export function parseShotName(name: string): ParsedShotName {
  const m = STAMPED_NAME_RE.exec(name);
  if (m) return { label: m[2], ts: stampToIso(m[1]) };
  return { label: name.replace(IMAGE_EXT_RE, "") || name, ts: null };
}

/**
 * THE ONLY PLACE A SCREENSHOT URL IS BUILT. Both pieces are re-validated here
 * even though every caller validated them already — this function is the
 * security boundary, and a boundary that trusts its callers is not one.
 * Returns null rather than a half-built URL.
 */
export function shotSrc(dirId: string, name: string): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  if (!SHOT_NAME_RE.test(name) || !IMAGE_EXT_RE.test(name)) return null;
  return `${PROXY_ROOT}/uploads/${dirId}/${encodeURIComponent(name)}`;
}

function makeRef(
  dirId: string,
  rawName: string,
  source: "bash" | "read",
): BrowserShotRef | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  const name = rawName.trim();
  if (!SHOT_NAME_RE.test(name) || !IMAGE_EXT_RE.test(name)) return null;
  const { label, ts } = parseShotName(name);
  return {
    dirId,
    name,
    url: `/api/uploads/${dirId}/${encodeURIComponent(name)}`,
    label,
    ts,
    source,
  };
}

/** `Read`'s `file_path`, from JSON when it parses and from the member regex
 *  when it does not. */
function readFilePath(argsText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed !== null && typeof parsed === "object") {
      const fp = (parsed as Record<string, unknown>).file_path;
      if (typeof fp === "string") return fp;
    }
  } catch {
    /* Clipped or wrapped payload — fall through to the shape match, which is
     * the same tactic the Bash path uses and for the same reason. */
  }
  const m = FILE_PATH_MEMBER_RE.exec(argsText);
  return m ? m[1] : null;
}

/**
 * Every screenshot this tool call touched, in payload order, deduplicated by
 * `<dirId>/<name>` (a research-browser run prints its record on stdout AND in
 * the status block, and the reader wants one thumbnail, not two).
 *
 * Never throws. Anything unrecognised yields `[]`.
 */
export function extractBrowserShots(call: ToolCallLike): BrowserShotRef[] {
  const out: BrowserShotRef[] = [];
  const seen = new Set<string>();
  const push = (ref: BrowserShotRef | null): void => {
    if (ref === null) return;
    const key = `${ref.dirId}/${ref.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  const tool = typeof call.toolName === "string" ? call.toolName : "";

  if (tool === "Bash" || tool === "bash") {
    const result = typeof call.result === "string" ? call.result : null;
    if (result !== null && result.length > 0) {
      /* `lastIndex` is per-call state on a module-level /g regex; reset it so
       * one row's scan can never start mid-string because of the previous. */
      URL_MEMBER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_MEMBER_RE.exec(result)) !== null) {
        push(makeRef(m[1], m[2], "bash"));
      }
    }
    return out;
  }

  if (tool === "Read" || tool === "read") {
    const args = typeof call.argsText === "string" ? call.argsText : null;
    if (args === null || args.length === 0) return out;
    const filePath = readFilePath(args);
    if (filePath === null) return out;
    const m = UPLOADS_PATH_RE.exec(filePath);
    if (m) push(makeRef(m[1], m[2], "read"));
    return out;
  }

  return out;
}

/**
 * The collapsed line's noun. "screenshots" is a claim about PROVENANCE — that
 * the browser tool took them — and it is only true of `source: "bash"` refs. A
 * `Read` of `/opt/ai-os/uploads/<id>/image.png` may equally be an attachment
 * Konrad dropped into the chat, so a mixed or read-only set says "images".
 */
export function shotsNoun(refs: readonly BrowserShotRef[]): string {
  const allBash = refs.length > 0 && refs.every((r) => r.source === "bash");
  const noun = allBash ? "screenshot" : "image";
  return refs.length === 1 ? noun : `${noun}s`;
}

/** Newest first by stamp; unstamped refs keep payload order at the end. */
export function newestFirst(refs: readonly BrowserShotRef[]): BrowserShotRef[] {
  return [...refs].sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return b.ts.localeCompare(a.ts);
  });
}

/* ── Stream state & diagnostics (Round 1: Live & Red Mode) ────────────────── */

export type StreamMode = "idle" | "live" | "needs_human";

export interface BrowserStateSummary {
  is_live?: boolean;
  needs_human?: boolean;
  needs_login?: boolean;
  signal?: string | null;
  service?: string | null;
  decision?: string | null;
  reason?: string | null;
  reasons?: string[];
  novnc_port?: number | null;
  novnc_url?: string | null;
  takeover_up?: boolean;
  profile?: string | null;
  stuck_signal?: string | null;
  checked_at?: string | null;
}

export interface StreamWarningInfo {
  title: string;
  detail: string;
  action: string;
  service: string | null;
  signal: string | null;
}

const LOGIN_WALL_PATTERN = /(login-wall|bot-wall|captcha|auth-wall|sign-in|challenge)/i;

/**
 * Check if a filename or label matches a login-wall or bot detection pattern.
 * Pure and case-insensitive.
 */
export function isLoginWallName(name: string | null | undefined): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  return LOGIN_WALL_PATTERN.test(name);
}

/**
 * Deterministically resolve whether a browser stream is:
 * - "needs_human": blocked on login wall (exit 4), stuck signal, or captcha (Red Mode)
 * - "live": actively running, streaming, or has active takeover stack (Blue Flowing Mode)
 * - "idle": static archived stills
 */
export function resolveStreamMode(
  state?: BrowserStateSummary | null,
  refs?: readonly { name: string; label?: string }[],
): StreamMode {
  // 1. Red mode checks (priority order of trust)
  if (state?.needs_human === true || state?.needs_login === true) {
    return "needs_human";
  }
  if (state?.signal === "login_required" || state?.decision === "login_required") {
    return "needs_human";
  }
  if (state?.stuck_signal && state.stuck_signal.length > 0) {
    return "needs_human";
  }
  if (refs && refs.length > 0) {
    for (const r of refs) {
      if (isLoginWallName(r.name) || (r.label && isLoginWallName(r.label))) {
        return "needs_human";
      }
    }
  }

  // 2. Live mode checks
  if (state?.is_live === true || state?.takeover_up === true) {
    return "live";
  }

  return "idle";
}

/**
 * Return structured diagnostic warning info for Red Mode.
 * Returns null if the stream is not in needs_human state.
 */
export function resolveStreamWarning(
  state?: BrowserStateSummary | null,
  refs?: readonly { name: string; label?: string }[],
): StreamWarningInfo | null {
  const mode = resolveStreamMode(state, refs);
  if (mode !== "needs_human") return null;

  let service = state?.service ?? null;
  const signal = state?.signal ?? state?.stuck_signal ?? (state?.needs_login ? "login_required" : null);

  // Attempt to deduce service from refs if not in state
  if (!service && refs && refs.length > 0) {
    for (const r of refs) {
      const match = /^(\d{8}T\d{6}Z)-([a-z0-9-]+)\.[a-zA-Z0-9]+$/.exec(r.name);
      if (match) {
        const parts = match[2].split("-");
        if (parts.length > 0 && parts[0] !== "screenshot") {
          service = parts[0];
          break;
        }
      }
    }
  }

  if (signal === "login_required" || state?.needs_login) {
    const serviceName = service ? service.charAt(0).toUpperCase() + service.slice(1) : "Browser";
    const customReason = state?.reason ?? (state?.reasons && state.reasons.length > 0 ? state.reasons[0] : null);
    return {
      title: "Login Required",
      detail: customReason ?? `${serviceName} requires human login or CAPTCHA verification`,
      action: "Take control in manual mode or solve login to resume",
      service,
      signal: "login_required",
    };
  }

  if (signal === "heartbeat_stale") {
    return {
      title: "Process Heartbeat Stale",
      detail: "Worker process stopped sending heartbeats",
      action: "Check worker logs or re-evaluate task status",
      service,
      signal: "heartbeat_stale",
    };
  }

  return {
    title: "Needs Operator Intervention",
    detail: state?.reason ?? (signal ? `Run stalled with signal: ${signal}` : "Browser task requires human action"),
    action: "Inspect stream in fullscreen or take manual control",
    service,
    signal: signal ?? "stuck",
  };
}

/**
 * Build the authenticated loopback noVNC proxy URL for a run directory.
 * Security boundary: validates dirId against DIR_ID_RE before constructing,
 * AND now requires a minted ticket — `ticket` is optional only so existing
 * callers that predate the ticket (BrowserStreamViewer.tsx:264, the unused
 * import in BrowserShots.tsx) keep compiling; omitting it returns `null`
 * rather than a URL pointing at a socket nothing will authenticate, so a
 * caller that has not been wired up to mint one yet renders nothing instead
 * of a broken canvas.
 *
 * Appends a `path=` query param noVNC's own UI/vnc_lite.js read via
 * `WebUtil.getConfigVar('path', 'websockify')` (see /usr/share/novnc/app/ui.js
 * and vnc_lite.html) to pick the WebSocket URL it opens for the RFB canvas.
 * Left at its default, that setting builds `ws://<host>/websockify` — the
 * BARE root path on this origin, which never touches this proxy at all.
 * Overridden here to `api/browser-takeover/ws/<ticket>` (no leading slash —
 * noVNC does `url += '/' + path`, ui.js:1019-1025): the dedicated nginx
 * location that bypasses the Next Route Handler's upgrade bailout entirely,
 * carrying the ticket as its only credential.
 *
 * `reconnect=0` is mandatory, not cosmetic: noVNC rebuilds the socket URL
 * from the `path` setting frozen at page load (ui.js:1062-1070 -> connect()
 * -> core/rfb.js:83), so an auto-reconnect after the 120s ticket TTL replays
 * an EXPIRED ticket and shows an opaque failure instead of asking the caller
 * to re-mint.
 */
export function vncProxyUrl(
  dirId: string,
  ticket?: string | null,
  subpath = "vnc.html?autoconnect=1&resize=scale",
): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  if (!ticket) return null;
  const cleanSub = subpath.replace(/^\/+/, "");
  const wsPath = `api/browser-takeover/ws/${ticket}`;
  const sep = cleanSub.includes("?") ? "&" : "?";
  return `${PROXY_ROOT}/uploads/${dirId}/vnc/${cleanSub}${sep}path=${wsPath}&reconnect=0`;
}

/**
 * The authenticated mint path for a run's takeover ticket — behind
 * `/api/proxy`, so it carries Konrad's session cookie same-origin, unlike the
 * websocket hop it feeds which cannot go through NextAuth middleware at all.
 * Forge-control mints a fresh 120s ticket bound to this run's resolved
 * profile+port on every GET (forge-control/src/routes/uploads.ts, `GET
 * /:id/vnc/ticket`) — there is nothing to cache client-side.
 */
export function takeoverTicketUrl(dirId: string): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  return `${PROXY_ROOT}/uploads/${dirId}/vnc/ticket`;
}

/** What `GET /api/uploads/:id/vnc/ticket` answers with on success. */
export interface TakeoverTicketBody {
  ticket: string;
  expires_at: string;
  novnc_port: number;
  profile: string;
}

/**
 * Mint a takeover ticket for a run. THE ONLY WAY to a working `vncProxyUrl` —
 * that function returns null without one, by design.
 *
 * This lives here rather than in a component because there are two callers that
 * must behave identically: the /takeover/<runId> landing page a phone
 * notification opens, and the in-chat "Take Control" affordances in
 * BrowserStreamViewer. Round-4 review, finding 4: the in-chat path called
 * `vncProxyUrl(dirId)` with no ticket, so every in-chat button rendered the
 * error branch while the landing page worked — one code path had the mint and
 * the other never grew one. One mint, one place.
 *
 * Throws with the reason on every failure. A takeover that cannot start is
 * something Konrad has to be told about in words; there is no useful degraded
 * mode between "live browser" and "nothing".
 */
export async function mintTakeoverTicket(dirId: string): Promise<TakeoverTicketBody> {
  const mintUrl = takeoverTicketUrl(dirId);
  if (!mintUrl) {
    throw new Error(`"${dirId}" is not a valid run id (expected 12 lowercase hex characters)`);
  }
  let res: Response;
  try {
    res = await fetch(mintUrl, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    throw new Error(`Could not reach forge-control to mint a ticket: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // Response body wasn't JSON — fall back to the status line already captured.
    }
    throw new Error(`${res.status} ${detail}`);
  }
  const body = (await res.json()) as Partial<TakeoverTicketBody>;
  if (typeof body.ticket !== "string" || typeof body.profile !== "string") {
    throw new Error("Ticket mint endpoint returned an unexpected response shape");
  }
  return body as TakeoverTicketBody;
}

/* ── Session clock & Done (aios-takeover-usable, PLAN.md §1.3/§1.4) ──────── */

/**
 * The session-clock path for a run: `GET /api/uploads/:id/takeover/session`
 * behind `/api/proxy`. Answers the questions the ticket cannot — how long the
 * SESSION (not the 120 s connect window) has left, whether it has ended and
 * why. Same validation as `takeoverTicketUrl`; null for a bad id.
 */
export function takeoverSessionUrl(dirId: string): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  return `${PROXY_ROOT}/uploads/${dirId}/takeover/session`;
}

/** The Done button's target: `POST /api/uploads/:id/takeover/end`. */
export function takeoverEndUrl(dirId: string): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  return `${PROXY_ROOT}/uploads/${dirId}/takeover/end`;
}

/** What `GET /api/uploads/:id/takeover/session` answers (PLAN.md §1.4). */
export interface TakeoverSessionBody {
  profile: string;
  stack_up: boolean;
  supervisor_live: boolean;
  connected_sockets: number;
  connects: number;
  takeover_started_at: string | null;
  last_disconnect_at: string | null;
  idle_deadline: string | null;
  takeover_deadline: string | null;
  hard_deadline: string | null;
  /** ms until the earliest deadline; null when no clock is armed yet. */
  remaining_ms: number | null;
  /** Server clock, ISO — the page measures its own drift against it. */
  now: string;
  ended: null | { reason: string; at: string };
}

/** What `POST /api/uploads/:id/takeover/end` answers on success. */
export interface TakeoverEndBody {
  ended: true;
  profile: string;
  actions: string[];
}

/**
 * One poll of the session clock.
 *
 *   ok           — the route answered; `body` is the clock.
 *   unavailable  — forge-control predates this build: the route is not
 *                  mounted. Distinguished from the route's OWN 404 (`{error}`
 *                  JSON, "run has no profile") by the body: Hono's unmounted
 *                  404 is not this route's JSON. The page renders the
 *                  difference in words — never a blank, never a spinner.
 *   error        — anything else, with the reason.
 */
export type TakeoverSessionPoll =
  | { kind: "ok"; body: TakeoverSessionBody; fetchedAt: number }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export async function fetchTakeoverSession(dirId: string): Promise<TakeoverSessionPoll> {
  const url = takeoverSessionUrl(dirId);
  if (!url) return { kind: "error", message: `"${dirId}" is not a valid run id` };
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    return { kind: "error", message: `session clock unreachable: ${(err as Error).message}` };
  }
  const fetchedAt = Date.now();
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const errorField =
    json !== null && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
      ? (json as { error: string }).error
      : null;
  if (res.status === 404 && errorField === null) return { kind: "unavailable" };
  if (!res.ok) return { kind: "error", message: `${res.status} ${errorField ?? res.statusText}` };
  if (json === null || typeof json !== "object" || typeof (json as { now?: unknown }).now !== "string") {
    return { kind: "error", message: "session route returned an unexpected shape" };
  }
  return { kind: "ok", body: json as TakeoverSessionBody, fetchedAt };
}

/**
 * End the session (Done). Resolves with the route's body; throws with the
 * reason on any failure (502 carries `stderr_tail` — surfaced, since the
 * alternative is a Done button that says nothing while Xvfb keeps running).
 */
export async function endTakeoverSession(dirId: string): Promise<TakeoverEndBody> {
  const url = takeoverEndUrl(dirId);
  if (!url) throw new Error(`"${dirId}" is not a valid run id`);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    throw new Error(`could not reach forge-control to end the session: ${(err as Error).message}`);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const rec = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const detail = typeof rec.error === "string" ? rec.error : res.statusText;
    const tail = typeof rec.stderr_tail === "string" && rec.stderr_tail.length > 0 ? ` — ${rec.stderr_tail}` : "";
    if (res.status === 404 && typeof rec.error !== "string") {
      throw new Error("end route unavailable — forge-control predates this build");
    }
    throw new Error(`${res.status} ${detail}${tail}`);
  }
  if (json === null || typeof json !== "object" || (json as { ended?: unknown }).ended !== true) {
    throw new Error("end route returned an unexpected shape");
  }
  return json as TakeoverEndBody;
}

