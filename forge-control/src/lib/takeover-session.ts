/**
 * Takeover session facts, the session view, and the one way to end a session.
 *
 * forge-control owns exactly one fact about a takeover: which noVNC sockets
 * are open right now, because the socket pipe lives in this process. The
 * supervisor in `scripts/research-browser.mjs` owns the LIFETIME (idle grace,
 * 2 h cap, teardown) — it does not restart when forge-control deploys, so the
 * clocks survive there. The two talk through one file this module writes and
 * the supervisor polls:
 *
 *   <stateRoot>/<profile>/takeover-activity.json
 *   {
 *     "connected":          number,        // sockets open in THIS forge-control process
 *     "connects":           number,        // accepted upgrades, cumulative across restarts
 *     "first_connect_at":   string | null, // ISO — the takeover clock's origin
 *     "last_connect_at":    string | null,
 *     "last_disconnect_at": string | null, // ISO — the idle clock's origin
 *     "written_at":         string
 *   }
 *
 * That shape is the CONTRACT with the browser workstream: change a key here and
 * `computeTakeoverDeadlines()` in the script stops seeing it. Writes are
 * read-modify-write behind a per-profile queue and land by atomic rename, so
 * `first_connect_at` and `connects` survive a forge-control restart while
 * `connected` — which only this process can know — is rebuilt from the
 * in-memory set on the first write after boot.
 *
 * `stateRoot` is a parameter everywhere, resolved through `getStateRoot()` AT
 * CALL TIME. Never capture it at module scope: tests repoint STATE_ROOT, and a
 * module-level default would make every test write into the live state tree.
 *
 * Module graph: this file imports `getStateRoot`, `isPidAlive`, `PROFILE_RE`
 * from browser-takeover.ts, and browser-takeover.ts imports `recordConnect` /
 * `recordDisconnect` from here. That is a cycle, and a cycle is only safe when
 * NEITHER side touches the other's exports at module evaluation time — the
 * exact trap that once stopped forge-control booting (a top-level
 * `const X = NOVNC_PORT_BASE` in takeover-ticket.ts hit the TDZ). Every use
 * below sits inside a function body; `takeover-session.test.ts` boots the
 * module in both import orders to keep it that way.
 *
 * NOTHING in this file logs, stores or forwards user-typed text. The text a
 * user sends to the VM travels browser → socket → x11vnc as RFB frames that
 * this process pipes and never parses; this module sees jtis and timestamps.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getStateRoot,
  isPidAlive,
  deadlineToMs,
  PROFILE_RE,
  readJsonFile,
  readProfileSession,
  readProfileTakeover,
  type ProfileSession,
  type ProfileTakeover,
} from "./browser-takeover.ts";

export const ACTIVITY_FILE = "takeover-activity.json";
export const LAST_SHUTDOWN_FILE = "last-shutdown.json";

export interface TakeoverActivity {
  connected: number;
  connects: number;
  first_connect_at: string | null;
  last_connect_at: string | null;
  last_disconnect_at: string | null;
  written_at: string;
}

/** Written by the supervisor on every shutdown so a late poll can say WHY. */
export interface LastShutdown {
  reason: string;
  at: string;
}

export interface ActivityOptions {
  stateRoot?: string;
  now?: Date;
}

function assertProfile(profile: string): void {
  if (!PROFILE_RE.test(profile)) {
    throw new Error(`invalid profile name: ${JSON.stringify(profile)}`);
  }
}

export function activityPath(profile: string, stateRoot: string = getStateRoot()): string {
  assertProfile(profile);
  return path.join(stateRoot, profile, ACTIVITY_FILE);
}

export function lastShutdownPath(profile: string, stateRoot: string = getStateRoot()): string {
  assertProfile(profile);
  return path.join(stateRoot, profile, LAST_SHUTDOWN_FILE);
}

/* ---------------------------------------------------------------------------
 * Live sockets — the in-memory truth for this process.
 * ------------------------------------------------------------------------- */

/** profile → set of jtis whose upgrade this process accepted and still pipes. */
const liveSockets = new Map<string, Set<string>>();

export function liveSocketCount(profile: string): number {
  return liveSockets.get(profile)?.size ?? 0;
}

export function liveSocketJtis(profile: string): string[] {
  return [...(liveSockets.get(profile) ?? [])];
}

/** Simulates a forge-control restart: memory empty, file untouched. Tests only. */
export function resetLiveSocketsForTests(): void {
  liveSockets.clear();
}

/* ---------------------------------------------------------------------------
 * The activity file.
 * ------------------------------------------------------------------------- */

function isIsoOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseActivity(text: string, filePath: string): TakeoverActivity {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    throw new Error(`${filePath} is not JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath} must hold an object, got ${JSON.stringify(raw).slice(0, 80)}`);
  }
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (!isCount(o.connected)) problems.push("connected");
  if (!isCount(o.connects)) problems.push("connects");
  if (!isIsoOrNull(o.first_connect_at)) problems.push("first_connect_at");
  if (!isIsoOrNull(o.last_connect_at)) problems.push("last_connect_at");
  if (!isIsoOrNull(o.last_disconnect_at)) problems.push("last_disconnect_at");
  if (typeof o.written_at !== "string" || !Number.isFinite(Date.parse(o.written_at))) {
    problems.push("written_at");
  }
  if (problems.length > 0) {
    throw new Error(`${filePath} has malformed field(s): ${problems.join(", ")}`);
  }
  return {
    connected: o.connected as number,
    connects: o.connects as number,
    first_connect_at: o.first_connect_at as string | null,
    last_connect_at: o.last_connect_at as string | null,
    last_disconnect_at: o.last_disconnect_at as string | null,
    written_at: o.written_at as string,
  };
}

/**
 * `null` only when the file does not exist. Any other failure — unreadable,
 * not JSON, wrong shape — throws with the path, because a clock built on a
 * half-read record is a session that dies silently later.
 */
export async function readActivity(
  profile: string,
  stateRoot: string = getStateRoot(),
): Promise<TakeoverActivity | null> {
  const filePath = activityPath(profile, stateRoot);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${filePath}: ${(err as Error).message}`);
  }
  return parseActivity(text, filePath);
}

let tmpCounter = 0;

async function writeActivityAtomic(filePath: string, activity: TakeoverActivity): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${JSON.stringify(activity, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, filePath);
  } catch (err: unknown) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new Error(`cannot write ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Two upgrades for the same profile can land in the same tick; without a
 * queue the second read-modify-write overwrites the first and `connects`
 * under-counts. One chain per activity file.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  writeChains.set(key, next);
  next
    .finally(() => {
      if (writeChains.get(key) === next) writeChains.delete(key);
    })
    .catch(() => undefined);
  return next;
}

function emptyActivity(writtenAt: string): TakeoverActivity {
  return {
    connected: 0,
    connects: 0,
    first_connect_at: null,
    last_connect_at: null,
    last_disconnect_at: null,
    written_at: writtenAt,
  };
}

/**
 * Called when an upgrade is ACCEPTED, before the socket is piped. Rejects
 * when the record cannot be written — the caller must then refuse the socket
 * (503 `activity_unwritable`): a session without a record is a session no
 * clock will ever end.
 */
export async function recordConnect(
  profile: string,
  jti: string,
  options: ActivityOptions = {},
): Promise<TakeoverActivity> {
  assertProfile(profile);
  const stateRoot = options.stateRoot ?? getStateRoot();
  const nowIso = (options.now ?? new Date()).toISOString();
  const filePath = activityPath(profile, stateRoot);

  let set = liveSockets.get(profile);
  if (!set) {
    set = new Set<string>();
    liveSockets.set(profile, set);
  }
  if (set.has(jti)) {
    throw new Error(`jti ${jti} is already recorded as connected for profile ${profile}`);
  }
  set.add(jti);

  try {
    return await serialised(filePath, async () => {
      const previous = (await readActivity(profile, stateRoot)) ?? emptyActivity(nowIso);
      const next: TakeoverActivity = {
        connected: liveSocketCount(profile),
        connects: previous.connects + 1,
        first_connect_at: previous.first_connect_at ?? nowIso,
        last_connect_at: nowIso,
        last_disconnect_at: previous.last_disconnect_at,
        written_at: nowIso,
      };
      await writeActivityAtomic(filePath, next);
      return next;
    });
  } catch (err: unknown) {
    // The socket is about to be refused; it must not linger as "connected".
    set.delete(jti);
    if (set.size === 0) liveSockets.delete(profile);
    throw err;
  }
}

/**
 * Called once when either side of the pipe closes. Throws on an unknown jti
 * (a double disconnect is a bookkeeping bug worth hearing about) and on a
 * write failure; the socket is already gone either way, so the caller logs.
 */
export async function recordDisconnect(
  profile: string,
  jti: string,
  options: ActivityOptions = {},
): Promise<TakeoverActivity> {
  assertProfile(profile);
  const stateRoot = options.stateRoot ?? getStateRoot();
  const nowIso = (options.now ?? new Date()).toISOString();
  const filePath = activityPath(profile, stateRoot);

  const set = liveSockets.get(profile);
  if (!set?.has(jti)) {
    throw new Error(`jti ${jti} is not recorded as connected for profile ${profile}`);
  }
  set.delete(jti);
  if (set.size === 0) liveSockets.delete(profile);

  return serialised(filePath, async () => {
    const previous = (await readActivity(profile, stateRoot)) ?? emptyActivity(nowIso);
    const next: TakeoverActivity = {
      ...previous,
      connected: liveSocketCount(profile),
      last_disconnect_at: nowIso,
      written_at: nowIso,
    };
    await writeActivityAtomic(filePath, next);
    return next;
  });
}

/* ---------------------------------------------------------------------------
 * The session view — GET /api/uploads/:id/takeover/session (PLAN.md §1.4).
 * ------------------------------------------------------------------------- */

export interface TakeoverSessionView {
  profile: string;
  /** Xvfb, x11vnc and websockify all alive — strict, unlike `takeover_up`. */
  stack_up: boolean;
  /** session.json exists and its supervisor pid answers `kill -0`. */
  supervisor_live: boolean;
  connected_sockets: number;
  connects: number;
  takeover_started_at: string | null;
  last_disconnect_at: string | null;
  idle_deadline: string | null;
  takeover_deadline: string | null;
  hard_deadline: string | null;
  /** min(non-null deadlines) − now; null without a live supervisor or deadlines. */
  remaining_ms: number | null;
  now: string;
  ended: LastShutdown | null;
}

export interface SessionViewInput {
  profile: string;
  activity: TakeoverActivity | null;
  session: ProfileSession | null;
  takeover: ProfileTakeover | null;
  lastShutdown: LastShutdown | null;
  now: Date;
  /** Injected so the view stays pure under test; production uses `isPidAlive`. */
  pidAlive?: (pid: number | null | undefined) => boolean;
}

function toIsoOrNull(value: string | number | null | undefined, field: string): string | null {
  const ms = deadlineToMs(value);
  if (ms === null) {
    if (value === null || value === undefined) return null;
    throw new Error(`session.json ${field} is not a timestamp: ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

export function computeSessionView(input: SessionViewInput): TakeoverSessionView {
  const pidAlive = input.pidAlive ?? isPidAlive;
  const { activity, session, takeover, lastShutdown } = input;

  const supervisor_live = session !== null && pidAlive(session.pid);
  const stack_up =
    takeover !== null &&
    pidAlive(takeover.xvfb?.pid) &&
    pidAlive(takeover.x11vnc?.pid) &&
    pidAlive(takeover.websockify?.pid);

  const idle_deadline = toIsoOrNull(session?.idle_deadline, "idle_deadline");
  const takeover_deadline = toIsoOrNull(session?.takeover_deadline, "takeover_deadline");
  const hard_deadline = toIsoOrNull(session?.hard_deadline, "hard_deadline");

  let remaining_ms: number | null = null;
  if (supervisor_live) {
    const candidates = [idle_deadline, takeover_deadline, hard_deadline]
      .filter((d): d is string => d !== null)
      .map((d) => Date.parse(d));
    if (candidates.length > 0) remaining_ms = Math.min(...candidates) - input.now.getTime();
  }

  return {
    profile: input.profile,
    stack_up,
    supervisor_live,
    connected_sockets: activity?.connected ?? 0,
    connects: activity?.connects ?? 0,
    takeover_started_at:
      toIsoOrNull(session?.takeover_started_at, "takeover_started_at") ??
      activity?.first_connect_at ??
      null,
    last_disconnect_at: activity?.last_disconnect_at ?? null,
    idle_deadline,
    takeover_deadline,
    hard_deadline,
    remaining_ms,
    now: input.now.toISOString(),
    ended: supervisor_live ? null : lastShutdown,
  };
}

/**
 * Reads the four state files and builds the view. `connected_sockets` is
 * taken from THIS process's memory, not from the file: after a forge-control
 * restart the file still says what the previous process knew, and memory is
 * the only honest answer until the next write corrects it.
 */
export async function loadSessionView(
  profile: string,
  options: ActivityOptions = {},
): Promise<TakeoverSessionView> {
  assertProfile(profile);
  const stateRoot = options.stateRoot ?? getStateRoot();
  const now = options.now ?? new Date();
  const [activityFromFile, session, takeover, lastShutdown] = await Promise.all([
    readActivity(profile, stateRoot),
    readProfileSession(profile, stateRoot),
    readProfileTakeover(profile, stateRoot),
    readJsonFile<LastShutdown>(lastShutdownPath(profile, stateRoot)),
  ]);
  const activity =
    activityFromFile === null ? null : { ...activityFromFile, connected: liveSocketCount(profile) };
  return computeSessionView({
    profile,
    activity,
    session,
    takeover,
    lastShutdown: lastShutdown && typeof lastShutdown.reason === "string" ? lastShutdown : null,
    now,
  });
}

/* ---------------------------------------------------------------------------
 * Ending a session — POST /api/uploads/:id/takeover/end.
 * ------------------------------------------------------------------------- */

export interface EndSessionResult {
  ended: true;
  profile: string;
  actions: unknown[];
}

export interface EndSessionOptions {
  timeoutMs?: number;
  /** Tests point this at a stand-in; production resolves the real script. */
  scriptPath?: string;
}

export class EndSessionError extends Error {
  readonly stderrTail: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, stderrTail: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    super(message);
    this.name = "EndSessionError";
    this.stderrTail = stderrTail;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export function isEndSessionError(err: unknown): err is EndSessionError {
  return err instanceof EndSessionError;
}

const STDERR_TAIL_CHARS = 2_000;

/**
 * forge-control/src/lib → ../../../scripts/research-browser.mjs (repo root).
 *
 * `RESEARCH_BROWSER_SCRIPT` overrides it, for tests only: the real script
 * hard-codes `/opt/ai-os/browser-profiles/.state` (it does NOT read
 * STATE_ROOT the way this process does), so a route test that let it run
 * would `close` a live profile. Same trust level as STATE_ROOT itself —
 * whoever sets this process's environment already owns the box.
 */
export function defaultResearchBrowserScript(): string {
  const override = process.env.RESEARCH_BROWSER_SCRIPT;
  if (override !== undefined && override !== "") return override;
  return fileURLToPath(new URL("../../../scripts/research-browser.mjs", import.meta.url));
}

/**
 * The ONE code path that ends a takeover, whoever asks — Done button, agent,
 * or (via the supervisor's own clock) nobody. It runs `research-browser.mjs
 * close <profile>`, which writes the stop file, waits for the supervisor to
 * shut down cleanly, then tears down websockify/x11vnc/Xvfb regardless. The
 * profile directory is untouched; that is the persistent part.
 *
 * Resolves with the script's own JSON status (`actions`), rejects with an
 * `EndSessionError` carrying the stderr tail on a non-zero exit, a timeout,
 * or output that is not the JSON status the script promises.
 */
export async function endSession(
  profile: string,
  options: EndSessionOptions = {},
): Promise<EndSessionResult> {
  assertProfile(profile);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const scriptPath = options.scriptPath ?? defaultResearchBrowserScript();

  return new Promise<EndSessionResult>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "close", profile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS * 2);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new EndSessionError(`cannot spawn ${scriptPath}: ${err.message}`, stderr.slice(-STDERR_TAIL_CHARS), null, null));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.slice(-STDERR_TAIL_CHARS);
      if (timedOut) {
        reject(new EndSessionError(`close ${profile} did not finish within ${timeoutMs} ms`, tail, code, signal));
        return;
      }
      if (code !== 0) {
        reject(new EndSessionError(`close ${profile} exited ${code ?? `by ${signal}`}`, tail, code, signal));
        return;
      }
      let status: unknown;
      try {
        status = JSON.parse(stdout);
      } catch (err: unknown) {
        reject(new EndSessionError(`close ${profile} printed no JSON status: ${(err as Error).message}`, tail, code, signal));
        return;
      }
      const actions = (status as { actions?: unknown } | null)?.actions;
      if (!Array.isArray(actions)) {
        reject(new EndSessionError(`close ${profile} status carries no actions array`, tail, code, signal));
        return;
      }
      resolve({ ended: true, profile, actions });
    });
  });
}
