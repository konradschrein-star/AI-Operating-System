/**
 * browser-takeover.ts — backend signal resolution & noVNC takeover proxy for
 * Konrad's AI OS browser stream viewer.
 *
 * Plumbs into scripts/research-browser.mjs persistent profiles (.state/<profile>/)
 * and postgres runs.stuck_signal to provide:
 * 1. Deterministic display and port math matching the research-browser contract.
 * 2. Signal resolution (exit code 4 / auth.json needs_login, service, decision,
 *    takeover.json status, and runs.stuck_signal).
 * 3. Authenticated loopback proxying to websockify / noVNC on 127.0.0.1:${novncPort}.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createConnection } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import pg from "pg";

import {
  verifyTakeoverTicket,
  isTakeoverTicketError,
  type VerifyTakeoverTicketResult,
} from "./takeover-ticket.ts";

const { Pool } = pg;

export const PROFILES_ROOT = process.env.PROFILES_ROOT ?? "/opt/ai-os/browser-profiles";
export const STATE_ROOT = process.env.STATE_ROOT ?? path.join(PROFILES_ROOT, ".state");
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";

/** Profile names are directory names, URL-safe, matching scripts/research-browser.mjs */
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const DISPLAY_BASE = 90;
export const DISPLAY_SPAN = 60; // displays :90 .. :149
export const VNC_PORT_BASE = 5900; // x11vnc convention: 5900 + display
export const NOVNC_PORT_BASE = 6900; // 6900 + (display - DISPLAY_BASE)

/** FNV-1a 32-bit hash — identical to research-browser.mjs:180 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The PREFERRED display number for a profile */
export function displaySlot(profile: string): number {
  return DISPLAY_BASE + (fnv1a32(profile) % DISPLAY_SPAN);
}

export interface DisplayPorts {
  display: string;
  displayNum: number;
  vncPort: number;
  novncPort: number;
}

export function portsForDisplay(displayNum: number): DisplayPorts {
  if (
    !Number.isInteger(displayNum) ||
    displayNum < DISPLAY_BASE ||
    displayNum >= DISPLAY_BASE + DISPLAY_SPAN
  ) {
    throw new Error(
      `display :${displayNum} is outside the managed range :${DISPLAY_BASE}-:${
        DISPLAY_BASE + DISPLAY_SPAN - 1
      }`,
    );
  }
  return {
    display: `:${displayNum}`,
    displayNum,
    vncPort: VNC_PORT_BASE + displayNum,
    novncPort: NOVNC_PORT_BASE + (displayNum - DISPLAY_BASE),
  };
}

export function novncUrl(novncPort: number): string {
  return `http://127.0.0.1:${novncPort}/vnc.html?autoconnect=1&resize=scale`;
}

export interface ProfileAuth {
  checked_at?: string;
  service?: string;
  url?: string;
  authenticated?: boolean;
  needs_login?: boolean;
  decision?: string;
  reasons?: string[];
}

export interface ProfileTakeoverProcess {
  pid: number;
  log?: string;
  bin?: string;
}

export interface ProfileTakeover {
  displayNum?: number;
  display?: string;
  vncPort?: number;
  novncPort?: number;
  xvfb?: ProfileTakeoverProcess | null;
  wm?: ProfileTakeoverProcess | null;
  x11vnc?: ProfileTakeoverProcess | null;
  websockify?: ProfileTakeoverProcess | null;
  started_at?: string;
  supervisor_pid?: number | null;
}

export interface ProfileSession {
  pid?: number;
  display?: string;
  displayNum?: number;
  started_at?: string;
  idle_deadline?: number;
}

export interface BrowserState {
  is_live: boolean;
  needs_human: boolean;
  needs_login: boolean;
  signal: string | null;
  service: string | null;
  decision: string | null;
  reason: string | null;
  reasons: string[];
  novnc_port: number | null;
  novnc_url: string | null;
  takeover_up: boolean;
  profile: string | null;
  stuck_signal: string | null;
  checked_at: string | null;
}

export interface TakeoverInspection {
  profile: string;
  up: boolean;
  display: string;
  displayNum: number;
  vnc_port: number;
  novnc_port: number;
  novnc_url: string;
  window_manager: string | null;
  started_at: string | null;
  supervisor_pid: number | null;
  auth: ProfileAuth | null;
  browser_state: BrowserState;
}

export function isPidAlive(pid: number | undefined | null): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function isPortListening(port: number, host = "127.0.0.1", timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function readProfileAuth(profile: string, stateRoot = STATE_ROOT): Promise<ProfileAuth | null> {
  if (!PROFILE_RE.test(profile)) return null;
  return readJsonFile<ProfileAuth>(path.join(stateRoot, profile, "auth.json"));
}

export async function readProfileTakeover(profile: string, stateRoot = STATE_ROOT): Promise<ProfileTakeover | null> {
  if (!PROFILE_RE.test(profile)) return null;
  return readJsonFile<ProfileTakeover>(path.join(stateRoot, profile, "takeover.json"));
}

export async function readProfileSession(profile: string, stateRoot = STATE_ROOT): Promise<ProfileSession | null> {
  if (!PROFILE_RE.test(profile)) return null;
  return readJsonFile<ProfileSession>(path.join(stateRoot, profile, "session.json"));
}

let dbPool: pg.Pool | null = null;
function getDbPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === "test") {
    return null;
  }
  if (!dbPool) {
    const connStr =
      process.env.DATABASE_URL ??
      "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";
    dbPool = new Pool({
      connectionString: connStr,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 1_000,
    });
    dbPool.on("error", () => {});
  }
  return dbPool;
}

export async function queryRunDbStatus(
  runId: string,
): Promise<{ status?: string; stuck_signal?: string | null } | null> {
  const pool = getDbPool();
  if (!pool) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId);
    let res: pg.QueryResult<{ status: string; stuck_signal: string | null }>;
    if (isUuid) {
      res = await pool.query<{ status: string; stuck_signal: string | null }>(
        `SELECT status, stuck_signal FROM runs WHERE id = $1 LIMIT 1`,
        [runId],
      );
    } else {
      res = await pool.query<{ status: string; stuck_signal: string | null }>(
        `SELECT status, stuck_signal FROM runs WHERE replace(id::text, '-', '') ILIKE ($1 || '%') LIMIT 1`,
        [runId],
      );
    }
    if (res.rows.length > 0) {
      return res.rows[0];
    }
    return null;
  } catch {
    return null;
  }
}

export const getStateRoot = () =>
  process.env.STATE_ROOT ??
  path.join(process.env.PROFILES_ROOT ?? "/opt/ai-os/browser-profiles", ".state");
export const getUploadDir = () => process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";

export interface ResolveBrowserStateOptions {
  profile?: string | null;
  uploadDir?: string;
  stateRoot?: string;
  dbLookup?: boolean;
}

/**
 * Directory of PER-PROFILE run→profile markers, relative to the run's upload dir:
 * `<uploadDir>/<runId>/browser-state/<profile>.json`. Written by
 * scripts/research-browser.mjs alongside the legacy single-file
 * `browser_state.json`.
 *
 * Round-4 review, finding 3: `browser_state.json` is one file per RUN, so a run
 * that drives two profiles keeps only the last writer's — and whichever profile
 * lost the race is unreachable while the winner is silently handed out to
 * anything asking about the run. Keying the marker by run AND profile means a
 * second takeover adds a file instead of erasing one, and `checked_at` (not
 * arrival order) decides which one is current.
 */
export const PROFILE_MARKER_DIR = "browser-state";

/**
 * Newest per-profile marker under `<uploadDir>/<runId>/browser-state/`, or null.
 *
 * A marker only counts when the FILENAME and the `profile` field inside agree.
 * The filename is the key; a file whose body claims a different profile is a
 * marker somebody built by hand or a partial write, and the one thing this
 * function must never do is hand back a profile the run did not actually drive
 * — the answer becomes the profile a ticket is signed for, and that ticket opens
 * a socket onto a real logged-in Chrome.
 */
export async function readNewestProfileMarker(
  runId: string,
  uploadDir: string,
): Promise<{ profile: string; checkedAt: number } | null> {
  const dir = path.join(uploadDir, runId, PROFILE_MARKER_DIR);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let best: { profile: string; checkedAt: number } | null = null;
  for (const name of entries.slice().sort()) {
    if (!name.endsWith(".json")) continue;
    const profile = name.slice(0, -".json".length);
    if (!PROFILE_RE.test(profile)) continue;
    const marker = await readJsonFile<Partial<BrowserState>>(path.join(dir, name));
    if (!marker) continue;
    if (marker.profile !== profile) continue; // filename ↔ body must agree
    // No checked_at, or one that does not parse, sorts oldest rather than
    // throwing the marker away: the file's existence is still evidence, it just
    // loses every tiebreak to a marker that carries a real clock.
    const parsed = marker.checked_at ? Date.parse(marker.checked_at) : Number.NaN;
    const checkedAt = Number.isFinite(parsed) ? parsed : 0;
    // Strictly-greater keeps the sorted-name order as the tiebreak, so equal
    // timestamps resolve the same way on every call.
    if (!best || checkedAt > best.checkedAt) best = { profile, checkedAt };
  }
  return best;
}

/**
 * Scan directory or profile state to find the associated profile name for a run.
 *
 * ORDER IS A SECURITY PROPERTY, not a preference. The answer is what
 * `GET /:id/vnc/ticket` signs a takeover ticket for, and that ticket is the only
 * credential on a WebSocket that bypasses NextAuth. So the routes run
 * most-authoritative first:
 *
 *   1. runId IS a profile name with live state — the caller named it outright.
 *   2. Per-profile marker  `browser-state/<profile>.json` — written deliberately
 *      by the driver at the moment it hit the login wall, newest wins.
 *   3. Legacy marker       `browser_state.json` (.profile, then .service).
 *   4. `auth.json` .service — also written by the driver.
 *   5. LAST RESORT: guessing from a screenshot's FILENAME.
 *
 * Route 5 used to run second (round-4 review, finding 3): one file called
 * `<ts>-perplexity-open.png` in a run's uploads dir outranked that run's own
 * marker, so `resolveProfileForRun("2ce31fa484df")` answered `perplexity` while
 * the marker said `os-ui` — i.e. a ticket for the wrong browser. Screenshot
 * names are a naming convention, and the uploads tree is writable by anything
 * that can drop a file in it; a marker is a statement. Guess last.
 */
export async function resolveProfileForRun(
  runId: string,
  options: { uploadDir?: string; stateRoot?: string } = {},
): Promise<string | null> {
  const uploadDir = options.uploadDir ?? getUploadDir();
  const stateRoot = options.stateRoot ?? getStateRoot();

  // 1. Direct profile directory if runId happens to be a valid profile name
  if (PROFILE_RE.test(runId)) {
    const st = await fs.stat(path.join(stateRoot, runId)).catch(() => null);
    if (st?.isDirectory()) return runId;
  }

  // 2. The per-profile marker the driver writes — keyed by run AND profile.
  const marker = await readNewestProfileMarker(runId, uploadDir);
  if (marker) return marker.profile;

  // 3. The legacy single-file marker, still written for backwards compatibility.
  const localState = await readJsonFile<Partial<BrowserState>>(path.join(uploadDir, runId, "browser_state.json"));
  if (localState?.profile && PROFILE_RE.test(localState.profile)) {
    return localState.profile;
  }
  if (localState?.service && PROFILE_RE.test(localState.service)) {
    return localState.service;
  }

  // 4. auth.json, the other file the driver writes into the run's upload dir.
  const localAuth = await readJsonFile<ProfileAuth>(path.join(uploadDir, runId, "auth.json"));
  if (localAuth?.service && PROFILE_RE.test(localAuth.service)) {
    return localAuth.service;
  }

  // 5. LAST RESORT — infer from a screenshot's name
  //    (e.g. 20260805T101530Z-perplexity-login-wall.png). Only reached when the
  //    run left no marker at all; still requires the profile to have live state.
  const dir = path.join(uploadDir, runId);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    const m = /^(\d{8}T\d{6}Z)-([a-z0-9-]+)\.[a-zA-Z0-9]+$/.exec(name);
    if (m) {
      const label = m[2];
      const parts = label.split("-");
      const serviceCandidate = parts[0];
      if (PROFILE_RE.test(serviceCandidate)) {
        const st = await fs.stat(path.join(stateRoot, serviceCandidate)).catch(() => null);
        if (st?.isDirectory()) {
          return serviceCandidate;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve the full browser state for a run or profile directory.
 * Priority order of trust:
 * 1. research-browser exit code 4 / auth.json needs_login / decision / service / reasons
 * 2. takeover.json active takeover stack & ports
 * 3. PostgreSQL runs.stuck_signal and status
 * 4. Screenshot label signals (*-login-wall)
 */
export async function resolveBrowserState(
  runIdOrDir: string,
  options: ResolveBrowserStateOptions = {},
): Promise<BrowserState> {
  const uploadDir = options.uploadDir ?? getUploadDir();
  const stateRoot = options.stateRoot ?? getStateRoot();
  const id = path.basename(runIdOrDir);

  let profile = options.profile ?? null;
  if (!profile) {
    profile = await resolveProfileForRun(id, { uploadDir, stateRoot });
  }

  // Check upload directory direct state file if present
  const localAuth = await readJsonFile<ProfileAuth>(path.join(uploadDir, id, "auth.json"));
  const localTakeover = await readJsonFile<ProfileTakeover>(path.join(uploadDir, id, "takeover.json"));
  const localBrowserState = await readJsonFile<Partial<BrowserState>>(
    path.join(uploadDir, id, "browser_state.json"),
  );

  const profileAuth = profile ? await readProfileAuth(profile, stateRoot) : null;
  const profileTakeover = profile ? await readProfileTakeover(profile, stateRoot) : null;
  const profileSession = profile ? await readProfileSession(profile, stateRoot) : null;

  const auth = localAuth ?? profileAuth;
  const takeover = localTakeover ?? profileTakeover;

  let novnc_port: number | null = null;
  let novnc_url: string | null = null;
  let takeover_up = false;

  if (takeover) {
    novnc_port = takeover.novncPort ?? (takeover.displayNum ? portsForDisplay(takeover.displayNum).novncPort : null);
    if (novnc_port) {
      novnc_url = novncUrl(novnc_port);
    }
    const xvfbAlive = takeover.xvfb?.pid ? isPidAlive(takeover.xvfb.pid) : false;
    const x11vncAlive = takeover.x11vnc?.pid ? isPidAlive(takeover.x11vnc.pid) : false;
    const websockifyAlive = takeover.websockify?.pid ? isPidAlive(takeover.websockify.pid) : false;
    // Considered up if processes are live or takeover object was populated
    takeover_up = (xvfbAlive && x11vncAlive && websockifyAlive) || (novnc_port !== null && takeover.started_at !== undefined);
  } else if (profile) {
    const slot = displaySlot(profile);
    const ports = portsForDisplay(slot);
    novnc_port = ports.novncPort;
    novnc_url = novncUrl(novnc_port);
  }

  let sessionLive = false;
  if (profileSession) {
    sessionLive = isPidAlive(profileSession.pid) || (profileSession.idle_deadline !== undefined && profileSession.idle_deadline > Date.now());
  }

  // Check screenshot labels in upload directory for login wall indicators
  let screenshotLoginWall = false;
  let screenshotService: string | null = null;
  try {
    const files = await fs.readdir(path.join(uploadDir, id));
    for (const f of files) {
      if (f.includes("login-wall") || f.includes("bot-wall") || f.includes("captcha")) {
        screenshotLoginWall = true;
        const m = /^(\d{8}T\d{6}Z)-([a-z0-9-]+)\.[a-zA-Z0-9]+$/.exec(f);
        if (m) {
          const parts = m[2].split("-");
          screenshotService = parts[0] || null;
        }
        break;
      }
    }
  } catch {}

  // Check PostgreSQL runs table if enabled
  let dbStuckSignal: string | null = null;
  let dbStatus: string | null = null;
  if (options.dbLookup !== false) {
    const dbRow = await queryRunDbStatus(id);
    if (dbRow) {
      dbStuckSignal = dbRow.stuck_signal ?? null;
      dbStatus = dbRow.status ?? null;
    }
  }

  const needs_login =
    auth?.needs_login === true ||
    auth?.decision === "login_required" ||
    localBrowserState?.needs_login === true ||
    screenshotLoginWall;

  const service = auth?.service ?? screenshotService ?? localBrowserState?.service ?? profile;
  const decision = auth?.decision ?? (needs_login ? "login_required" : null) ?? localBrowserState?.decision ?? null;
  const reasons = auth?.reasons ?? localBrowserState?.reasons ?? [];

  let signal: string | null = null;
  let reason: string | null = null;
  let needs_human = false;

  if (needs_login) {
    needs_human = true;
    signal = "login_required";
    reason = reasons.length > 0 ? reasons[0] : service ? `Login required on ${service}` : "Login required";
  } else if (dbStuckSignal || localBrowserState?.stuck_signal) {
    needs_human = true;
    signal = dbStuckSignal ?? localBrowserState?.stuck_signal ?? "stuck";
    reason = signal === "heartbeat_stale" ? "Process heartbeat is stale" : `Run stuck: ${signal}`;
  } else if (dbStatus === "stuck") {
    needs_human = true;
    signal = "stuck";
    reason = "Run marked as stuck";
  }

  const is_live =
    sessionLive ||
    takeover_up ||
    dbStatus === "running" ||
    localBrowserState?.is_live === true;

  return {
    is_live,
    needs_human,
    needs_login,
    signal,
    service,
    decision,
    reason,
    reasons,
    novnc_port,
    novnc_url,
    takeover_up,
    profile,
    stuck_signal: dbStuckSignal ?? localBrowserState?.stuck_signal ?? null,
    checked_at: auth?.checked_at ?? localBrowserState?.checked_at ?? new Date().toISOString(),
  };
}

export async function inspectTakeover(
  profile: string,
  stateRoot = getStateRoot(),
): Promise<TakeoverInspection> {
  if (!PROFILE_RE.test(profile)) {
    throw new Error(`invalid profile name: "${profile}"`);
  }
  const ports = portsForDisplay(displaySlot(profile));
  const auth = await readProfileAuth(profile, stateRoot);
  const takeover = await readProfileTakeover(profile, stateRoot);
  const browser_state = await resolveBrowserState(profile, { profile, stateRoot });

  const novnc_port = takeover?.novncPort ?? ports.novncPort;
  const novnc_url = novncUrl(novnc_port);

  return {
    profile,
    up: browser_state.takeover_up,
    display: takeover?.display ?? ports.display,
    displayNum: takeover?.displayNum ?? ports.displayNum,
    vnc_port: takeover?.vncPort ?? ports.vncPort,
    novnc_port,
    novnc_url,
    window_manager: takeover?.wm?.bin ?? null,
    started_at: takeover?.started_at ?? null,
    supervisor_pid: takeover?.supervisor_pid ?? null,
    auth,
    browser_state,
  };
}

export interface ProxyTakeoverOptions {
  stateRoot?: string;
  targetPort?: number;
}

/**
 * Proxies HTTP requests to loopback noVNC instance at 127.0.0.1:${novncPort}.
 * Security enforcement:
 * 1. Only connects to 127.0.0.1.
 * 2. Only connects to verified noVNC port range 6900..6959.
 * 3. Profile name strictly checked against PROFILE_RE.
 */
export async function proxyTakeoverHttp(
  req: Request,
  profile: string,
  subpath = "",
  options: ProxyTakeoverOptions = {},
): Promise<Response> {
  if (!PROFILE_RE.test(profile)) {
    return new Response(
      JSON.stringify({ error: `Invalid profile name "${profile}"`, code: "INVALID_PROFILE" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  let targetPort = options.targetPort;
  if (!targetPort) {
    const inspection = await inspectTakeover(profile, options.stateRoot);
    targetPort = inspection.novnc_port;
  }

  if (
    !Number.isInteger(targetPort) ||
    targetPort < NOVNC_PORT_BASE ||
    targetPort >= NOVNC_PORT_BASE + DISPLAY_SPAN
  ) {
    return new Response(
      JSON.stringify({
        error: `Target port ${targetPort} is outside allowed loopback range ${NOVNC_PORT_BASE}-${NOVNC_PORT_BASE + DISPLAY_SPAN - 1}`,
        code: "FORBIDDEN_PORT",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  const cleanSubpath = subpath.replace(/^\/+/, "");
  const targetUrl = new URL(`http://127.0.0.1:${targetPort}/${cleanSubpath}`);
  const reqUrl = new URL(req.url);
  reqUrl.searchParams.forEach((v, k) => {
    targetUrl.searchParams.set(k, v);
  });

  try {
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "host") {
        headers.set(k, v);
      }
    });

    const init: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      init.body = req.body;
      (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstreamRes = await fetch(targetUrl.toString(), init);

    const outHeaders = new Headers(upstreamRes.headers);
    outHeaders.set("x-proxied-by", "forge-control-browser-takeover");

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: outHeaders,
    });
  } catch (err: unknown) {
    const message = (err as Error).message || "Connection refused";
    return new Response(
      JSON.stringify({
        error: `Failed to connect to loopback takeover service on port ${targetPort}: ${message}`,
        code: "TAKEOVER_UNREACHABLE",
        novnc_port: targetPort,
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
}

/**
 * Round-5 fix: WebSocket-upgrade proxying for the noVNC takeover session.
 *
 * `proxyTakeoverHttp` above forwards plain HTTP via `fetch()`, which cannot
 * complete a `101 Switching Protocols` handshake — noVNC's RFB-over-websockify
 * canvas connection needs a real WebSocket. `@hono/node-server`'s bare
 * `serve()` never registers a Node `'upgrade'` listener either, so an
 * unhandled upgrade socket is destroyed by Node's default behaviour. This
 * section wires the missing hop: `index.ts` attaches `handleBrowserTakeoverUpgrade`
 * to the underlying `http.Server`'s `'upgrade'` event, and this function
 * raw-pipes the socket to the loopback websockify port after applying the
 * SAME security checks as `proxyTakeoverHttp` (profile regex, loopback-only,
 * verified noVNC port range).
 */

export interface TakeoverUpgradeMatch {
  kind: "ticket";
  /**
   * The opaque signed ticket lifted out of the URL path. It is a BEARER
   * CREDENTIAL: never log it, never echo it back, never put it in an error
   * body. Only its `jti` (which carries no signature) is safe to record.
   */
  ticket: string;
}

/**
 * The ONE upgrade route.
 *
 * `/api/browser-takeover/ws/<ticket>` is a dedicated, single-purpose prefix
 * carried straight to this process by its own nginx `location`, because a Next
 * Route Handler cannot host a WebSocket (no socket access, `Response` rejects
 * 101). That location therefore also bypasses NextAuth's middleware, so the
 * socket has to authenticate itself — the ticket is what replaces the missing
 * session check.
 *
 * The two arms that used to live here — `/api/uploads/browser/:profile/vnc/*`
 * and `/api/uploads/:id/vnc/*` — are DELETED, deliberately. They authenticated
 * nothing: anyone who guessed a run id would have opened a live Chrome holding
 * Konrad's logged-in Google and Perplexity sessions. Their HTTP siblings still
 * exist in routes/uploads.ts and still sit behind NextAuth via `/api/proxy`;
 * only the raw socket is ticket-only. One authentication rule, not "the safe
 * one and the other one" — an unauthenticated arm left alive is how a careless
 * nginx edit later becomes account takeover.
 */
/**
 * The public prefix nginx forwards here, exported so nothing else has to spell
 * it out. `check-browser-takeover-ticket.ts` §6.1 allowlists the handful of
 * files permitted to name this literal, on the principle that a new file naming
 * it is a new public route until proven otherwise — and a test harness that
 * needs to know where the socket goes should IMPORT the answer rather than earn
 * an exemption for restating it. An exemption should buy something.
 */
export const TAKEOVER_UPGRADE_PREFIX = "/api/browser-takeover/ws/";

const TICKET_UPGRADE_RE = /^\/api\/browser-takeover\/ws\/([^/]+)\/?$/;

export function matchTakeoverUpgradePath(pathname: string): TakeoverUpgradeMatch | null {
  const m = TICKET_UPGRADE_RE.exec(pathname);
  if (!m) return null;
  // A ticket is base64url, so decoding is normally a no-op; malformed percent
  // escapes must not throw inside the server's 'upgrade' listener. Hand the
  // raw segment to verify instead and let it reject.
  let ticket: string;
  try {
    ticket = decodeURIComponent(m[1]);
  } catch {
    ticket = m[1];
  }
  return { kind: "ticket", ticket };
}

/**
 * Ticket ids already spent, keyed by `jti`, valued by that ticket's own expiry.
 *
 * The ticket rides in the URL PATH SEGMENT — noVNC rebuilds its socket URL from
 * the `path` setting and drops query parameters, so there is nowhere else to put
 * it. That means every ticket lands in nginx access logs, browser history and
 * any referrer header. "Signed and expiring" is not enough for a credential
 * with that trail: without this store a ticket is replayable for its entire TTL
 * by anyone who reads one log line.
 *
 * Swept lazily on each consume. Entries cannot outlive their own expiry, and
 * the map is bounded by "takeover attempts inside one TTL", which is a human
 * clicking a link.
 */
const spentTicketJtis = new Map<string, number>();

/**
 * Marks a ticket id as spent. Returns `false` if it was already spent — that is
 * a replay, and the caller must refuse the socket.
 */
export function consumeTakeoverTicketJti(jti: string, exp: number, now = Date.now()): boolean {
  for (const [seenJti, seenExp] of spentTicketJtis) {
    if (seenExp <= now) spentTicketJtis.delete(seenJti);
  }
  if (spentTicketJtis.has(jti)) return false;
  spentTicketJtis.set(jti, exp);
  return true;
}

/** Drops the replay store. For tests, and for a signing-key rotation. */
export function clearSpentTakeoverTicketJtis(): void {
  spentTicketJtis.clear();
}

export interface TakeoverUpgradeTarget {
  profile: string;
  targetPort: number;
  runId: string;
  jti: string;
}

export interface TakeoverUpgradeRejection {
  /** Status line written on the raw socket before it closes. */
  status: 401 | 404 | 503;
  /** Short machine-readable cause — this is what the takeover log records. */
  reason: string;
  /** Body text. Deliberately terse and never derived from the ticket. */
  error: string;
  /** Present only once the ticket verified far enough to name them. */
  runId?: string;
  profile?: string;
  port?: number;
}

export function isTakeoverUpgradeRejection(
  result: TakeoverUpgradeTarget | TakeoverUpgradeRejection,
): result is TakeoverUpgradeRejection {
  return "reason" in result;
}

/**
 * Turns a matched upgrade into a loopback target, or a refusal.
 *
 * Profile and port come from the SIGNED PAYLOAD and from nowhere else — there
 * is no client-supplied run id, no path-derived profile and no caller override.
 * That is the whole point of the ticket: the only thing the client contributes
 * is a blob this process signed itself.
 */
export function resolveTakeoverUpgradeTarget(
  match: TakeoverUpgradeMatch,
): TakeoverUpgradeTarget | TakeoverUpgradeRejection {
  let claims: VerifyTakeoverTicketResult;
  try {
    claims = verifyTakeoverTicket(match.ticket);
  } catch (err: unknown) {
    // Only a missing or too-short signing secret throws; hostile input never
    // does. An unconfigured box must fail closed, loudly, not open.
    return {
      status: 503,
      reason: "ticket_secret_unavailable",
      error: `Browser takeover is not configured: ${(err as Error).message}`,
    };
  }

  if (isTakeoverTicketError(claims)) {
    return { status: 401, reason: claims.error, error: "Unauthorized" };
  }

  // Defence in depth, and stated plainly: verifyTakeoverTicket ALREADY checks
  // both of these against the same two constants, so as the code stands today
  // neither branch below can be reached through a signed ticket — a test
  // pointing a signed ticket at port 7700 gets `ticket_port_out_of_range` from
  // verify, not `port_out_of_range_at_use` from here. They are kept because
  // they are the layer that survives verify being relaxed, the payload schema
  // gaining a field, or a second caller appearing; the invariant "a socket is
  // only ever aimed at 127.0.0.1:6900-6959" then still holds locally, where it
  // is used. Anyone deleting them owes the tree a re-run proving the socket
  // tests still refuse those ports.
  if (!PROFILE_RE.test(claims.profile)) {
    return {
      status: 404,
      reason: "profile_rejected_at_use",
      error: "No browser profile found for this ticket",
      runId: claims.runId,
      profile: claims.profile,
      port: claims.port,
    };
  }
  if (
    !Number.isInteger(claims.port) ||
    claims.port < NOVNC_PORT_BASE ||
    claims.port >= NOVNC_PORT_BASE + DISPLAY_SPAN
  ) {
    return {
      status: 404,
      reason: "port_out_of_range_at_use",
      error: `Target port ${claims.port} is outside allowed loopback range ${NOVNC_PORT_BASE}-${NOVNC_PORT_BASE + DISPLAY_SPAN - 1}`,
      runId: claims.runId,
      profile: claims.profile,
      port: claims.port,
    };
  }

  // Last, so that a ticket is only burnt once it would actually have opened a
  // socket. A second presentation of the same jti is a replay.
  if (!consumeTakeoverTicketJti(claims.jti, claims.exp)) {
    return {
      status: 401,
      reason: "ticket_replayed",
      error: "Unauthorized",
      runId: claims.runId,
      profile: claims.profile,
      port: claims.port,
    };
  }

  return {
    profile: claims.profile,
    targetPort: claims.port,
    runId: claims.runId,
    jti: claims.jti,
  };
}

/**
 * Raw-pipes an already-validated WebSocket upgrade to the loopback websockify
 * instance on `127.0.0.1:${targetPort}`. Node's client-side `http.request`
 * exposes the outbound handshake as an `'upgrade'` event with the raw duplex
 * socket, which is the piece `fetch()` cannot do — this mirrors exactly what
 * `http-proxy`'s `.ws()` does internally.
 *
 * How the socket gets here (the comment this replaces claimed Next.js proxied
 * upgrades to this process via `next.config.mjs`; it does not, and never did —
 * `next.config.mjs` is 14 lines of `reactStrictMode` plus a webpack alias, with
 * no `rewrites()` at all, and a Next Route Handler cannot host a WebSocket in
 * the first place. That false comment is a large part of why this gap survived):
 * nginx carries `/api/browser-takeover/ws/` straight to 127.0.0.1:7700 from its
 * own `location` block, bypassing Next entirely. See PLAN.md.
 */
export function proxyTakeoverUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  targetPort: number,
  subpath: string,
): void {
  const cleanSubpath = subpath.replace(/^\/+/, "") || "websockify";
  const rawUrl = req.url ?? "/";
  const qIndex = rawUrl.indexOf("?");
  const query = qIndex >= 0 ? rawUrl.slice(qIndex) : "";
  const targetPath = `/${cleanSubpath}${query}`;

  const outHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.toLowerCase() === "host") continue;
    outHeaders[key] = value;
  }
  outHeaders.host = `127.0.0.1:${targetPort}`;

  const proxyReq = httpRequest({
    host: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: targetPath,
    headers: outHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const headerLines = Object.entries(proxyRes.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`)
      .join("");
    clientSocket.write(
      `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n${headerLines}\r\n`,
    );
    if (proxyHead && proxyHead.length > 0) clientSocket.write(proxyHead);
    if (head && head.length > 0) proxySocket.write(head);

    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => proxySocket.destroy());
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxyReq.on("error", (err: unknown) => {
    console.error(
      `[browser-takeover] upgrade proxy to 127.0.0.1:${targetPort} failed:`,
      (err as Error).message ?? err,
    );
    clientSocket.destroy();
  });

  proxyReq.end();
}

const UPGRADE_STATUS_TEXT: Record<401 | 404 | 503, string> = {
  401: "Unauthorized",
  404: "Not Found",
  503: "Service Unavailable",
};

/**
 * One line per upgrade attempt, accepted or rejected. This is a live browser
 * holding Konrad's logged-in sessions; every attempt to reach it is worth a
 * record.
 *
 * The `jti` is logged and the ticket is NOT. A jti identifies an attempt and
 * carries no signature, so it cannot be replayed; the ticket is the credential
 * itself and would turn the log file into a set of live keys.
 */
function logTakeoverUpgrade(
  outcome: "accepted" | "rejected",
  fields: { runId?: string; profile?: string; port?: number; jti?: string; reason?: string; status?: number },
): void {
  const parts = [
    `run=${fields.runId ?? "-"}`,
    `profile=${fields.profile ?? "-"}`,
    `port=${fields.port ?? "-"}`,
    `jti=${fields.jti ?? "-"}`,
  ];
  if (outcome === "rejected") {
    parts.push(`status=${fields.status ?? "-"}`, `reason=${fields.reason ?? "-"}`);
  }
  console.log(`[browser-takeover] upgrade ${outcome} ${parts.join(" ")}`);
}

/**
 * Entry point wired to the Node `http.Server`'s `'upgrade'` event in
 * `index.ts`. Returns `false` when the path is not a takeover upgrade at all
 * (caller should destroy the socket — no other route in this process expects
 * a raw upgrade), `true` once this function has taken ownership of the
 * socket (either proxying it or rejecting it with an HTTP status line).
 *
 * There is no `options` parameter any more, on purpose: a caller-supplied
 * `targetPort` would be a second way to choose where the socket points, and
 * the ticket must be the only one.
 */
export async function handleBrowserTakeoverUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const match = matchTakeoverUpgradePath(pathname);
  if (!match) return false;

  const target = resolveTakeoverUpgradeTarget(match);
  if (isTakeoverUpgradeRejection(target)) {
    logTakeoverUpgrade("rejected", {
      runId: target.runId,
      profile: target.profile,
      port: target.port,
      reason: target.reason,
      status: target.status,
    });
    socket.end(
      `HTTP/1.1 ${target.status} ${UPGRADE_STATUS_TEXT[target.status]}\r\n` +
        `Content-Type: text/plain\r\nConnection: close\r\n\r\n${target.error}`,
    );
    return true;
  }

  logTakeoverUpgrade("accepted", {
    runId: target.runId,
    profile: target.profile,
    port: target.targetPort,
    jti: target.jti,
  });
  // Fixed subpath: the ticket route carries no path of its own, and websockify
  // is the only endpoint an upgrade ever needs. vnc.html and its assets are
  // plain HTTP and stay behind NextAuth via /api/proxy.
  proxyTakeoverUpgrade(req, socket, head, target.targetPort, "websockify");
  return true;
}
