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
import pg from "pg";

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
 * Scan directory or profile state to find the associated profile name for a run.
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

  // 2. Look inside upload directory for screenshots with service labels (e.g. 20260805T101530Z-perplexity-login-wall.png)
  const dir = path.join(uploadDir, runId);
  const entries = await fs.readdir(dir).catch(() => []);
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

  // 3. Check local metadata or auth files inside upload directory
  const localAuth = await readJsonFile<ProfileAuth>(path.join(uploadDir, runId, "auth.json"));
  if (localAuth?.service && PROFILE_RE.test(localAuth.service)) {
    return localAuth.service;
  }

  const localState = await readJsonFile<Partial<BrowserState>>(path.join(uploadDir, runId, "browser_state.json"));
  if (localState?.profile && PROFILE_RE.test(localState.profile)) {
    return localState.profile;
  }
  if (localState?.service && PROFILE_RE.test(localState.service)) {
    return localState.service;
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
