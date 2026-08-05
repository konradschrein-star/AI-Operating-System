#!/usr/bin/env node
// research-browser.mjs — the persistent-profile browser harness the research lane runs on.
// Named profiles keep a logged-in Chrome session alive across runs; when a service puts up a
// login wall the tool brings up a noVNC "takeover" stack, screenshots the wall, and queues a
// reminder telling Konrad exactly which URL to open to log in ONCE by hand. After that the
// profile is authenticated and no human is in the loop again.
//
// WHY THIS EXISTS INSTEAD OF THE auto-browser SKILL: that skill talks to a controller on
// http://127.0.0.1:8000 with noVNC on :6081. Neither is installed on this host — verified
// 2026-08-05, both return connect-failure (curl exit 7 / http_code 000), there is no
// /opt/auto-browser, and /root/.claude.json has an empty mcpServers list. That SKILL.md lives
// inside a Hermes docker volume and describes a DIFFERENT machine. This file reimplements its
// SEMANTICS (named profile, save/reuse, takeover URL) on what IS installed here: playwright
// resolved at runtime from outside this repo, system Google Chrome, Xvfb, x11vnc, websockify,
// and /usr/share/novnc.
//
// NO PASSWORDS ARE STORED ANYWHERE. This tool never reads, types, prompts for, or writes a
// credential. The only thing that persists is Chrome's own user-data-dir under
// /opt/ai-os/browser-profiles/<profile>/ — session cookies and Chrome's profile state, nothing
// else. Konrad types his password himself, into a real Chrome window, over a loopback-only
// noVNC session. There is no code path in this file that could do otherwise.
//
// ZERO REPO DEPENDENCIES, deliberately: docs/plan/03-quality.md gates on the diff touching no
// package.json and no pnpm-lock.yaml. playwright is NOT a dependency of forge-control; it is
// resolved at runtime via createRequire from PLAYWRIGHT_MODULE or /opt/hermes-workspace. Every
// other moving part is a system binary. The writeFd/writeSync stdout helpers below are copied
// from scripts/gemini-qa.mjs rather than shared — docs/plan/02-architecture.md section 6.1
// requires these scripts to stay standalone-copyable, so the duplication is the design.
//
// NO SILENT FALLBACKS: nothing is retried behind your back, no substitute browser is picked,
// no missing prerequisite is worked around. Every failure prints what actually happened, which
// path or pid it happened on, and exits non-zero.
//
// usage: scripts/research-browser.mjs <open|status|takeover|close> <profile> [flags]
//        scripts/research-browser.mjs --help
//
// exit codes:
//   0  success — JSON status on stdout
//   1  runtime error (browser launch, X/VNC startup, IPC timeout, reminder POST failure)
//   2  missing prerequisite (playwright module, Chrome binary, Xvfb/x11vnc/websockify/noVNC)
//   3  usage error (bad subcommand, bad profile name, bad flag, bad --url)
//   4  LOGIN REQUIRED — a login wall was detected. The takeover stack is up, the wall is
//      screenshotted, a reminder is queued, and the browser is left RUNNING so a human can
//      take over. This is a distinct code precisely so a caller can tell "needs Konrad" from
//      "broke"; it is not an error.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  renameSync,
  statSync,
  chmodSync,
  openSync,
  closeSync,
  writeSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SELF = 'research-browser.mjs';

// ---------------------------------------------------------------------------
// Synchronous, drain-guaranteed output — COPIED VERBATIM IN SHAPE from
// scripts/gemini-qa.mjs (see the header: 02-architecture.md section 6.1 forbids factoring
// this into a shared module, and R405 finding 2 is why it exists at all).
//
// process.stdout/stderr are ASYNCHRONOUS when they point at a pipe, and the researcher lane
// captures this script through a pipe. process.stdout.write() only queues the bytes;
// process.exit() then discards whatever has not drained, truncating at the 64 KiB pipe buffer.
// This tool's stdout is a JSON status a caller parses — a silent cut produces a parse error
// that looks like a bug in the tool rather than a bug in the plumbing.
//
// writeSync() on the raw fd completes before exit() can discard anything. EAGAIN is the
// non-blocking-pipe "buffer full, retry" signal, not a failure; EPIPE means the reader is
// already gone (`| head`) and there is nobody left to write to.
// ---------------------------------------------------------------------------
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

function writeFd(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        Atomics.wait(SLEEP_SLOT, 0, 0, 5); // 5 ms, synchronous: nothing else may run first
        continue;
      }
      if (err.code === 'EPIPE') return; // reader closed
      throw err;
    }
  }
}

/** All stdout goes through here — never process.stdout.write (see above). */
const writeOut = (text) => writeFd(1, text);
/** All stderr goes through here — never process.stderr.write (see above). */
const writeErr = (text) => writeFd(2, text);

// ---------------------------------------------------------------------------
// Exit-code contract and the error type that carries it
// ---------------------------------------------------------------------------
export const EXIT = {
  OK: 0,
  RUNTIME: 1,
  PREREQ: 2,
  USAGE: 3,
  LOGIN_REQUIRED: 4,
};

/**
 * A failure that already knows which exit code it deserves. The pure helpers throw this
 * instead of calling process.exit, which is what makes them unit-testable in-process;
 * main() is the single place that turns one into an exit. Impure code paths use die()
 * directly, matching scripts/gemini-qa.mjs house style.
 */
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function die(code, message) {
  writeErr(`${SELF}: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Paths and layout
//
//   /opt/ai-os/browser-profiles/<profile>/          Chrome user-data-dir. Session cookies and
//                                                   Chrome's own profile state, NOTHING ELSE.
//                                                   Created 0700, owner-only.
//   /opt/ai-os/browser-profiles/.state/<profile>/   this tool's runtime bookkeeping: session
//                                                   and takeover pids, the last login
//                                                   evaluation, the request/response queue,
//                                                   process logs. Kept OUT of the profile dir
//                                                   so the profile dir stays exactly what its
//                                                   name says it is.
//   /opt/ai-os/browser-profiles/.state/displays/<n> display registry: which profile owns :<n>.
//
// A profile name can never be ".state" — PROFILE_RE forbids the dot.
// ---------------------------------------------------------------------------
export const PROFILES_ROOT = '/opt/ai-os/browser-profiles';
export const STATE_ROOT = `${PROFILES_ROOT}/.state`;
export const DISPLAY_REGISTRY = `${STATE_ROOT}/displays`;
export const UPLOADS_ROOT = '/opt/ai-os/uploads';

/** Profile names are directory names, URL-safe, and must never need escaping anywhere. */
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const profileDir = (profile) => join(PROFILES_ROOT, profile);
export const stateDir = (profile) => join(STATE_ROOT, profile);

// ---------------------------------------------------------------------------
// Display and port allocation
//
// Deterministic per profile so two profiles never land on the same X display: a hash picks the
// PREFERRED slot, and the first assignment is recorded in the display registry. A hash alone
// can collide, so the registry is authoritative — on collision the allocator probes forward
// and persists the result, and a profile keeps its display forever after.
// ---------------------------------------------------------------------------
export const DISPLAY_BASE = 90;
export const DISPLAY_SPAN = 60; // displays :90 .. :149
export const VNC_PORT_BASE = 5900; // x11vnc convention: 5900 + display
export const NOVNC_PORT_BASE = 6900; // 6900 + (display - DISPLAY_BASE)

/** FNV-1a, 32-bit. Small, dependency-free, and stable across node versions. */
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The PREFERRED display number for a profile. Pure; collisions are resolved by the registry. */
export function displaySlot(profile) {
  return DISPLAY_BASE + (fnv1a32(profile) % DISPLAY_SPAN);
}

export function portsForDisplay(displayNum) {
  if (
    !Number.isInteger(displayNum) ||
    displayNum < DISPLAY_BASE ||
    displayNum >= DISPLAY_BASE + DISPLAY_SPAN
  ) {
    throw new CliError(
      EXIT.RUNTIME,
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

/**
 * The noVNC URL. LOOPBACK ONLY, ALWAYS — x11vnc and websockify are both bound to 127.0.0.1,
 * so this URL is unreachable from the internet by construction. Konrad reaches it through the
 * SSH tunnel below, which is the only supported access path.
 */
export const novncUrl = (novncPort) =>
  `http://127.0.0.1:${novncPort}/vnc.html?autoconnect=1&resize=scale`;

export const SSH_TARGET = process.env.RESEARCH_BROWSER_SSH_TARGET ?? 'root@65.108.6.149';

export const sshTunnelCommand = (novncPort, target = SSH_TARGET) =>
  `ssh -N -L ${novncPort}:127.0.0.1:${novncPort} ${target}`;

// ---------------------------------------------------------------------------
// Screenshot convention — a CONTRACT, not an implementation detail.
//
//   /opt/ai-os/uploads/<run_id>/<compact-ISO8601>-<label>.png
//   e.g. /opt/ai-os/uploads/7f3a91c2aabb/20260805T101530Z-perplexity-login-wall.png
//
// The operator-visibility project is building its renderer against this exact shape, and this
// tool builds NO UI of its own. forge-control serves the files at /api/uploads/<run_id>/<name>
// (forge-control/src/routes/uploads.ts).
//
// SERVABILITY, verified 2026-08-05: that route gates the id on /^[a-f0-9]{12}$/ and 400s
// anything else — every one of the 28 existing upload directories is exactly 12 hex chars,
// written by crypto.randomBytes(6).toString("hex"). A run id of another shape still gets the
// documented path and URL (the convention is honoured verbatim), but the URL will 400. Rather
// than mangle the caller's id into something servable, every screenshot entry carries an
// explicit `url_servable` flag and a stderr note. Guessing would produce a URL pointing at a
// file that is not there.
// ---------------------------------------------------------------------------
export const SERVABLE_RUN_ID_RE = /^[a-f0-9]{12}$/;

/**
 * The fallback run id, used only when neither --run-id nor FORGE_RUN_ID is set. It is 12 hex
 * characters ON PURPOSE: a mnemonic like "adhoc" would be rejected by the uploads route, so
 * every ad-hoc screenshot would be unviewable in the Console. This sentinel is servable, and
 * it is obviously a sentinel.
 */
export const ADHOC_RUN_ID = 'deadbeefcafe';

export function isServableRunId(runId) {
  return SERVABLE_RUN_ID_RE.test(runId);
}

/**
 * Reduce a label to [a-z0-9-] so the resulting URL is always valid. Runs of anything else
 * collapse to a single dash; leading/trailing dashes go; the result is capped so a pathological
 * label cannot produce an ENAMETOOLONG at screenshot time.
 */
export function sanitiseLabel(label) {
  const cleaned = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return cleaned === '' ? 'screenshot' : cleaned;
}

/** Same treatment for a run id, minus the dashes: it is a single path segment. */
export function sanitiseRunId(runId) {
  const cleaned = String(runId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 64);
  return cleaned === '' ? null : cleaned;
}

/** 2026-08-05T10:15:30.123Z → 20260805T101530Z. Compact ISO 8601, second resolution, UTC. */
export function compactStamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export const screenshotName = (date, label) => `${compactStamp(date)}-${sanitiseLabel(label)}.png`;
export const screenshotPath = (runId, name) => join(UPLOADS_ROOT, runId, name);
export const uploadsUrl = (runId, name) => `/api/uploads/${runId}/${name}`;

/**
 * --run-id, else FORGE_RUN_ID, else the sentinel. Returns the source too, so the JSON says
 * where the id came from instead of leaving a caller to guess why it changed.
 */
export function resolveRunId(runIdFlag, env = process.env) {
  const fromFlag = sanitiseRunId(runIdFlag);
  if (fromFlag !== null) return { runId: fromFlag, source: 'flag' };
  const fromEnv = sanitiseRunId(env.FORGE_RUN_ID);
  if (fromEnv !== null) return { runId: fromEnv, source: 'env:FORGE_RUN_ID' };
  return { runId: ADHOC_RUN_ID, source: 'fallback-sentinel' };
}

export function screenshotRecord(runId, date, label) {
  const name = screenshotName(date, label);
  return {
    label: sanitiseLabel(label),
    path: screenshotPath(runId, name),
    url: uploadsUrl(runId, name),
    url_servable: isServableRunId(runId),
  };
}

// ---------------------------------------------------------------------------
// SERVICES — the login-wall signal table.
//
// Perplexity is the FIRST ENTRY, not a hardcoded special case: adding a logged-in research
// surface means adding an object here, nothing else. `generic` is the fallback for any host
// with no entry — it carries only the two signals that are true of essentially every login
// page on the web, and deliberately claims nothing about being logged IN.
//
// hosts             — which service a --url belongs to (matched against the hostname)
// home              — where `open <profile>` goes with no --url
// loginUrlPatterns  — a FINAL url matching one of these is a login wall (hard signal)
// loggedOutSelectors— visible ⇒ logged out (soft signal)
// loggedInSelectors — visible ⇒ logged in (positive signal; overrides the soft negative)
// ---------------------------------------------------------------------------
export const SERVICES = {
  perplexity: {
    title: 'Perplexity',
    home: 'https://www.perplexity.ai/',
    hosts: [/(^|\.)perplexity\.ai$/i],
    loginUrlPatterns: [/\/sign-?in\b/i, /\/login\b/i, /(^|\.)accounts\.google\.com$/i],
    loggedOutSelectors: [
      'a[href*="/sign-in"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
    ],
    loggedInSelectors: [
      'button[aria-label*="Account" i]',
      'a[href*="/settings/account"]',
      'textarea[placeholder*="Ask" i]',
    ],
  },
  generic: {
    title: 'this site',
    home: null,
    hosts: [],
    loginUrlPatterns: [/\/sign-?in\b/i, /\/login\b/i, /(^|\.)accounts\.google\.com$/i],
    loggedOutSelectors: [],
    loggedInSelectors: [],
  },
};

/**
 * Which SERVICES entry applies. Precedence: explicit --service, then the --url's hostname,
 * then a profile name that happens to be a service key, then `generic`.
 */
export function resolveService({ service = null, url = null, profile = null }) {
  if (service !== null) {
    const entry = SERVICES[service];
    if (entry === undefined) {
      throw new CliError(
        EXIT.USAGE,
        `unknown --service "${service}"; known services: ${Object.keys(SERVICES).join(' ')}`,
      );
    }
    return { key: service, ...entry };
  }

  if (url !== null) {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      throw new CliError(EXIT.USAGE, `--url is not a valid URL: ${url} (${err.message})`);
    }
    for (const [key, entry] of Object.entries(SERVICES)) {
      if (entry.hosts.some((re) => re.test(hostname))) return { key, ...entry };
    }
    // An explicit --url that matches no entry is `generic` — the profile NAME must not
    // override it. Running Perplexity's selectors against example.com because the profile
    // happens to be called "perplexity" would evaluate the wrong page against the wrong
    // signals. The profile name is only a default for "which surface", not an assertion.
    return { key: 'generic', ...SERVICES.generic };
  }

  if (profile !== null && SERVICES[profile] !== undefined) {
    return { key: profile, ...SERVICES[profile] };
  }
  return { key: 'generic', ...SERVICES.generic };
}

/**
 * THE LOGIN-WALL EVALUATOR — pure, and the reason the signal collection above it is kept
 * separate. Every input is data a caller can synthesise, which is how the test suite exercises
 * this without a browser.
 *
 * Precedence, and why:
 *  - HARD signals (a final URL on a login path, a visible password field) win outright. A page
 *    asking for a password is a login wall whatever else it renders.
 *  - A positive loggedInSelector beats the SOFT loggedOutSelectors — sites commonly keep a
 *    dead "Sign in" node in the DOM after auth, and a visible account control is the stronger
 *    claim.
 *  - Silence proves nothing: no signals at all means needs_login false, authenticated null.
 *    Reporting `null` rather than `true` is the whole point — this tool never guesses that a
 *    session is good.
 */
export function evaluateLoginWall(service, signals) {
  const reasons = [];
  const finalUrl = signals.finalUrl ?? '';
  const passwordFieldCount = signals.passwordFieldCount ?? 0;
  const loggedOutHits = signals.loggedOutHits ?? [];
  const loggedInHits = signals.loggedInHits ?? [];

  let urlHost = '';
  let urlPath = finalUrl;
  try {
    const parsed = new URL(finalUrl);
    urlHost = parsed.hostname;
    urlPath = `${parsed.pathname}${parsed.search}`;
  } catch {
    // A non-absolute URL is matched as a bare path. Not a failure: about:blank and "" are
    // legitimate states for a page that never navigated, and they carry no login signal.
  }

  const urlHit = (service.loginUrlPatterns ?? []).find((re) => re.test(urlPath) || re.test(urlHost));
  if (urlHit !== undefined) reasons.push(`final url matches login pattern ${urlHit} (${finalUrl})`);
  if (passwordFieldCount > 0) {
    reasons.push(`${passwordFieldCount} visible password field(s) on the page`);
  }
  const hardSignal = urlHit !== undefined || passwordFieldCount > 0;

  for (const sel of loggedOutHits) reasons.push(`logged-out selector visible: ${sel}`);
  for (const sel of loggedInHits) reasons.push(`logged-in selector visible: ${sel}`);

  if (hardSignal) {
    return {
      needsLogin: true,
      authenticated: false,
      reasons,
      decision: loggedInHits.length > 0 ? 'hard-signal-overrides-logged-in' : 'hard-signal',
    };
  }
  if (loggedInHits.length > 0) {
    return { needsLogin: false, authenticated: true, reasons, decision: 'logged-in-selector' };
  }
  if (loggedOutHits.length > 0) {
    return { needsLogin: true, authenticated: false, reasons, decision: 'logged-out-selector' };
  }
  return { needsLogin: false, authenticated: null, reasons, decision: 'no-signal' };
}

// ---------------------------------------------------------------------------
// The login reminder, and not queueing it twice
// ---------------------------------------------------------------------------
export const REMINDERS_URL = process.env.FORGE_API_ROOT
  ? `${process.env.FORGE_API_ROOT}/api/reminders`
  : 'http://127.0.0.1:7700/api/reminders';

/** forge-control refuses text over this (forge-control/src/lib/reminder-text.ts). */
export const REMINDER_TEXT_MAX = 500;
export const REMINDER_DEDUP_WINDOW_MS = 60 * 60 * 1000; // one hour, per the brief
export const REMINDER_WHEN = 'in 5m';

/** The machine-readable marker that makes dedup exact instead of fuzzy string matching. */
export const reminderMarker = (profile, service) =>
  `[research-browser login profile=${profile} service=${service}]`;

/**
 * The reminder text. Under REMINDER_TEXT_MAX by construction and asserted below — forge-control
 * rejects an over-length reminder with a 400 rather than truncating it (R604/R605), so a
 * too-long reminder is a silent no-notification, i.e. a stuck research lane.
 */
export function buildLoginReminderText({ profile, service, serviceTitle, novncPort, sshTarget }) {
  const text =
    `Research browser needs a ONE-TIME login: ${serviceTitle}, profile "${profile}". ` +
    `1) tunnel: ${sshTunnelCommand(novncPort, sshTarget)} ` +
    `2) open ${novncUrl(novncPort)} ` +
    `3) log in by hand in that Chrome window, then leave it. ` +
    `The profile keeps the cookies; nothing stores your password. ` +
    `${reminderMarker(profile, service)}`;
  if (text.length > REMINDER_TEXT_MAX) {
    throw new CliError(
      EXIT.RUNTIME,
      `login reminder text is ${text.length} chars, over forge-control's ${REMINDER_TEXT_MAX} ` +
        `limit — it would be rejected with a 400 and Konrad would never be told. Shorten it.`,
    );
  }
  return text;
}

/**
 * Postgres renders timestamptz as "2026-08-05 15:59:23.232128+00", which is not ISO 8601 and
 * not portably parseable. Normalised here rather than trusted to Date's lenient path.
 * Returns null when it genuinely cannot be read — callers must decide what that means, and
 * must not silently treat it as "now".
 */
export function parsePgTimestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let text = value.trim().replace(' ', 'T');
  // "+00" / "-05" → "+00:00" / "-05:00"; a bare offset hour is not valid ISO 8601.
  text = text.replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Has an identical login reminder for this profile+service already been queued inside the
 * window? Pure, so the window logic is testable without the API.
 *
 * An UNPARSEABLE created_at counts as NOT a match, on purpose. The two failure modes are not
 * symmetric: a duplicate reminder is noise on a phone, while a suppressed reminder means
 * Konrad is never told and the research lane is stuck forever. Noise is the cheaper mistake.
 * The unreadable timestamp is reported in `skipped` so it is never invisible.
 */
export function findRecentLoginReminder(reminders, { profile, service, nowMs, windowMs }) {
  const marker = reminderMarker(profile, service);
  const skipped = [];
  for (const rem of reminders ?? []) {
    if (typeof rem?.text !== 'string' || !rem.text.includes(marker)) continue;
    if (rem.status === 'dismissed') continue;
    const createdMs = parsePgTimestamp(rem.created_at);
    if (createdMs === null) {
      skipped.push({ id: rem.id ?? null, reason: `unreadable created_at: ${rem.created_at}` });
      continue;
    }
    const ageMs = nowMs - createdMs;
    if (ageMs >= 0 && ageMs <= windowMs) {
      return { match: rem, ageMs, skipped };
    }
  }
  return { match: null, ageMs: null, skipped };
}

// ---------------------------------------------------------------------------
// Prerequisite resolution — playwright, then Chrome. Both exit 2 naming every path tried.
// ---------------------------------------------------------------------------
export const PLAYWRIGHT_CANDIDATE_PATHS = ['/opt/hermes-workspace/node_modules/playwright'];

/**
 * playwright is resolved AT RUNTIME, from outside this repo, because adding it to
 * forge-control/package.json would fail the docs/plan/03-quality.md dependency gate.
 * Order: PLAYWRIGHT_MODULE, then the known hermes-workspace install.
 */
function resolvePlaywright() {
  const require = createRequire('/');
  const tried = [];
  const candidates = [];
  const fromEnv = (process.env.PLAYWRIGHT_MODULE ?? '').trim();
  if (fromEnv !== '') candidates.push({ source: 'PLAYWRIGHT_MODULE', spec: fromEnv });
  for (const spec of PLAYWRIGHT_CANDIDATE_PATHS) candidates.push({ source: 'builtin path', spec });

  for (const candidate of candidates) {
    try {
      const mod = require(candidate.spec);
      if (typeof mod?.chromium?.launchPersistentContext !== 'function') {
        tried.push(`${candidate.spec} (${candidate.source}) — loaded but has no chromium.launchPersistentContext`);
        continue;
      }
      return { mod, path: require.resolve(candidate.spec), source: candidate.source };
    } catch (err) {
      tried.push(`${candidate.spec} (${candidate.source}) — ${err.code ?? 'error'}: ${err.message}`);
    }
  }

  die(
    EXIT.PREREQ,
    `cannot resolve the playwright module. Tried, in order:\n` +
      tried.map((t) => `  - ${t}\n`).join('') +
      `  playwright is intentionally NOT a dependency of this repo (docs/plan/03-quality.md\n` +
      `  gates on an empty package.json/pnpm-lock.yaml diff). Point PLAYWRIGHT_MODULE at an\n` +
      `  installed playwright, or install one at ${PLAYWRIGHT_CANDIDATE_PATHS[0]}.`,
  );
}

export const CHROME_CANDIDATE_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
];

/**
 * System Google Chrome is PREFERRED over playwright's bundled chromium: real Chrome trips
 * fewer bot defenses, and it decouples this tool from playwright's browser-revision pin (the
 * bundled path below is revision-specific and breaks on a playwright upgrade).
 */
function resolveChrome() {
  const tried = [];
  const candidates = [];
  const fromEnv = (process.env.RESEARCH_BROWSER_CHROME ?? '').trim();
  if (fromEnv !== '') candidates.push(fromEnv);
  candidates.push(...CHROME_CANDIDATE_PATHS);

  for (const path of candidates) {
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        tried.push(`${path} — not a regular file`);
        continue;
      }
      return path;
    } catch (err) {
      tried.push(`${path} — ${err.code ?? 'error'}`);
    }
  }
  die(
    EXIT.PREREQ,
    `no Chrome/Chromium executable found. Tried, in order:\n` +
      tried.map((t) => `  - ${t}\n`).join('') +
      `  Set RESEARCH_BROWSER_CHROME to an executable to override.`,
  );
}

const TAKEOVER_BINARIES = {
  xvfb: '/usr/bin/Xvfb',
  x11vnc: '/usr/bin/x11vnc',
  websockify: '/usr/bin/websockify',
};
export const NOVNC_WEB_ROOT = '/usr/share/novnc';

/**
 * A window manager is OPTIONAL for automation and close to essential for a human takeover:
 * without one, X windows get no focus management, so a login popup (Google OAuth opens one)
 * can be impossible to type into over VNC. It is not in TAKEOVER_BINARIES because its absence
 * must not fail a run — but it is never silently absent either: `window_manager` in the JSON
 * says which one is running, or null plus a note about what that costs.
 */
export const WM_CANDIDATE_PATHS = ['/usr/bin/openbox', '/usr/bin/fluxbox', '/usr/bin/i3'];

export function findWindowManager(paths = WM_CANDIDATE_PATHS, exists = existsSync) {
  return paths.find((p) => exists(p)) ?? null;
}

function assertTakeoverPrereqs() {
  const missing = [];
  for (const [name, path] of Object.entries(TAKEOVER_BINARIES)) {
    if (!existsSync(path)) missing.push(`${name}: ${path}`);
  }
  if (!existsSync(join(NOVNC_WEB_ROOT, 'vnc.html'))) {
    missing.push(`noVNC web root: ${join(NOVNC_WEB_ROOT, 'vnc.html')}`);
  }
  if (missing.length > 0) {
    die(
      EXIT.PREREQ,
      `the takeover stack is not installed. Missing:\n` +
        missing.map((m) => `  - ${m}\n`).join('') +
        `  Install with: apt-get install -y xvfb x11vnc websockify novnc`,
    );
  }
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------
function ensureDir(path, mode) {
  mkdirSync(path, { recursive: true, mode });
  if (mode !== undefined) {
    // recursive mkdir does not chmod a directory that already existed.
    try {
      chmodSync(path, mode);
    } catch (err) {
      die(EXIT.RUNTIME, `cannot set mode ${mode.toString(8)} on ${path}: ${err.message}`);
    }
  }
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    die(EXIT.RUNTIME, `cannot read ${path}: ${err.code ?? 'error'} ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt state is reported, never silently reset — a "fix" that deletes it would hide
    // whatever produced it.
    die(EXIT.RUNTIME, `${path} is not valid JSON (${err.message}); inspect or remove it by hand`);
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    // rename(2) is atomic within a filesystem: a reader never sees a half-written state file,
    // which matters because session.json is polled by other processes while it is rewritten.
    renameSync(tmp, path);
  } catch (err) {
    die(EXIT.RUNTIME, `cannot write ${path}: ${err.code ?? 'error'} ${err.message}`);
  }
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') die(EXIT.RUNTIME, `cannot remove ${path}: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, owned by someone else
  }
}

/**
 * Guard against pid reuse before signalling anything: the process must still look like the
 * one we recorded. Killing a pid we merely remember is how a tool ends up killing something
 * unrelated after a reboot.
 */
function pidCmdlineMatches(pid, token) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes(token);
  } catch {
    return false;
  }
}

function terminate(pid, token, what) {
  if (!isPidAlive(pid)) return { pid, what, result: 'not-running' };
  if (!pidCmdlineMatches(pid, token)) {
    return {
      pid,
      what,
      result: 'skipped-pid-reuse',
      detail: `pid ${pid} is alive but its cmdline does not contain "${token}" — refusing to signal it`,
    };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { pid, what, result: 'terminated' };
  } catch (err) {
    return { pid, what, result: 'signal-failed', detail: `${err.code ?? 'error'} ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Display assignment (registry-backed, so the hash may collide harmlessly)
// ---------------------------------------------------------------------------
function assignDisplay(profile) {
  ensureDir(DISPLAY_REGISTRY, 0o700);
  const pinned = join(stateDir(profile), 'display');
  try {
    const num = Number.parseInt(readFileSync(pinned, 'utf8').trim(), 10);
    if (Number.isInteger(num)) return portsForDisplay(num);
    die(EXIT.RUNTIME, `${pinned} does not contain a display number; remove it to re-allocate`);
  } catch (err) {
    if (err.code !== 'ENOENT') die(EXIT.RUNTIME, `cannot read ${pinned}: ${err.message}`);
  }

  const preferred = displaySlot(profile);
  for (let step = 0; step < DISPLAY_SPAN; step++) {
    const num = DISPLAY_BASE + ((preferred - DISPLAY_BASE + step) % DISPLAY_SPAN);
    const claim = join(DISPLAY_REGISTRY, String(num));
    try {
      const fd = openSync(claim, 'wx', 0o600); // atomic: exactly one profile wins the slot
      writeSync(fd, `${profile}\n`);
      closeSync(fd);
    } catch (err) {
      if (err.code !== 'EEXIST') die(EXIT.RUNTIME, `cannot claim display :${num}: ${err.message}`);
      const owner = readFileSync(claim, 'utf8').trim();
      if (owner !== profile) continue; // someone else's display — probe on
    }
    writeFileSync(pinned, `${num}\n`, { mode: 0o600 });
    return portsForDisplay(num);
  }
  die(
    EXIT.RUNTIME,
    `all ${DISPLAY_SPAN} managed displays (:${DISPLAY_BASE}-:${DISPLAY_BASE + DISPLAY_SPAN - 1}) ` +
      `are claimed by other profiles; see ${DISPLAY_REGISTRY}`,
  );
}

// ---------------------------------------------------------------------------
// Takeover stack: Xvfb → x11vnc → websockify. All three detached, all logged, all recorded.
// ---------------------------------------------------------------------------
function spawnDetached(profile, name, bin, args, envExtra = undefined) {
  const logPath = join(stateDir(profile), `${name}.log`);
  let fd;
  try {
    fd = openSync(logPath, 'a', 0o600);
  } catch (err) {
    die(EXIT.RUNTIME, `cannot open ${logPath}: ${err.message}`);
  }
  const envNote = envExtra === undefined ? '' : `${Object.entries(envExtra).map(([k, v]) => `${k}=${v}`).join(' ')} `;
  writeFd(fd, `\n=== ${new Date().toISOString()} ${envNote}${bin} ${args.join(' ')} ===\n`);
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: envExtra === undefined ? process.env : { ...process.env, ...envExtra },
  });
  child.unref();
  closeSync(fd);
  if (child.pid === undefined) {
    die(EXIT.RUNTIME, `spawning ${bin} produced no pid; see ${logPath}`);
  }
  return { pid: child.pid, log: logPath };
}

// ---------------------------------------------------------------------------
// Readiness. Spawning is not starting: Xvfb needs ~100-500 ms to create its socket, x11vnc
// cannot bind until the display exists, and websockify cannot proxy until x11vnc listens.
// Without these waits a failure downstream reports as "the supervisor did not come up in 90s"
// and the actual cause — measured on this box: Xvfb SEGFAULTING — is only visible to someone
// who thinks to read three log files. Every wait names the process, the thing it waited for,
// and the tail of that process's own log.
// ---------------------------------------------------------------------------
export const READY_TIMEOUT_MS = 15_000;

/** Is 127.0.0.1:<port> accepting connections right now? */
function tcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Wait until `check()` is true, failing loudly the moment the process dies. Polling a dead
 * process until a timeout is the difference between a 15-second answer and a 90-second riddle.
 */
async function waitUntilReady({ name, pid, log, what, check, timeoutMs = READY_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (!isPidAlive(pid)) {
      die(
        EXIT.RUNTIME,
        `${name} (pid ${pid}) exited before ${what} was ready.\n` +
          `  Its log ${log} ends with:\n${tailFile(log, 1500)}`,
      );
    }
    if (Date.now() >= deadline) {
      die(
        EXIT.RUNTIME,
        `${name} (pid ${pid}) is running but ${what} did not become ready within ` +
          `${timeoutMs / 1000}s.\n  Its log ${log} ends with:\n${tailFile(log, 1500)}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * A stale /tmp/.X<n>-lock left by a crashed server blocks Xvfb forever. The lock file contains
 * the owning pid: if that pid is dead the lock cannot belong to a running X server and is safe
 * to remove. If it is ALIVE, this refuses and names the pid rather than killing a live server
 * that might not be ours.
 */
function clearStaleXLock(displayNum) {
  const lock = `/tmp/.X${displayNum}-lock`;
  let raw;
  try {
    raw = readFileSync(lock, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { cleared: false, reason: 'no lock file' };
    die(EXIT.RUNTIME, `cannot read ${lock}: ${err.message}`);
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (isPidAlive(pid)) {
    die(
      EXIT.RUNTIME,
      `display :${displayNum} is already in use by a live X server (pid ${pid}, ${lock}). ` +
        `This tool will not kill an X server it did not start. Stop that process, or remove ` +
        `${join(stateDir('<profile>'), 'display')} to move the profile to another display.`,
    );
  }
  removeIfPresent(lock);
  removeIfPresent(`/tmp/.X11-unix/X${displayNum}`);
  return { cleared: true, reason: `stale lock from dead pid ${pid}` };
}

const takeoverStatePath = (profile) => join(stateDir(profile), 'takeover.json');

function readTakeover(profile) {
  const state = readJson(takeoverStatePath(profile));
  if (state === null) return null;
  const live = {
    xvfb: isPidAlive(state.xvfb?.pid) && pidCmdlineMatches(state.xvfb.pid, `:${state.displayNum}`),
    // The WM takes no display argument, so its cmdline is just the binary — that is the only
    // token available to guard against pid reuse.
    wm: state.wm?.pid !== undefined && isPidAlive(state.wm.pid) && pidCmdlineMatches(state.wm.pid, state.wm.bin),
    x11vnc:
      isPidAlive(state.x11vnc?.pid) && pidCmdlineMatches(state.x11vnc.pid, `:${state.displayNum}`),
    websockify:
      isPidAlive(state.websockify?.pid) &&
      pidCmdlineMatches(state.websockify.pid, String(state.novncPort)),
  };
  // The WM is deliberately NOT part of `up`: it is a takeover comfort, not a requirement, and a
  // box without one must still report a working stack.
  return { ...state, live, up: live.xvfb && live.x11vnc && live.websockify };
}

/**
 * Bring up (or top up) the takeover stack for a profile. Idempotent: each of the three
 * processes is started only if its recorded pid is not alive.
 *
 * SECURITY: x11vnc binds -localhost (127.0.0.1) and websockify binds 127.0.0.1 explicitly.
 * The VNC surface is NEVER on a public interface. -nopw is safe ONLY because of that: the
 * access control is the loopback bind plus SSH, not a VNC password.
 */
async function ensureTakeover(profile, ports) {
  assertTakeoverPrereqs();
  ensureDir(stateDir(profile), 0o700);
  const existing = readTakeover(profile);
  const state = {
    displayNum: ports.displayNum,
    display: ports.display,
    vncPort: ports.vncPort,
    novncPort: ports.novncPort,
    xvfb: existing?.xvfb ?? null,
    wm: existing?.wm ?? null,
    x11vnc: existing?.x11vnc ?? null,
    websockify: existing?.websockify ?? null,
    started_at: existing?.started_at ?? new Date().toISOString(),
  };
  const started = [];

  if (!existing?.live?.xvfb) {
    clearStaleXLock(ports.displayNum);
    state.xvfb = spawnDetached(profile, 'xvfb', TAKEOVER_BINARIES.xvfb, [
      ports.display,
      '-screen',
      '0',
      '1600x1000x24',
      // -extension GLX is NOT optional on this box: measured 2026-08-05, Xvfb 2:21.1.x here
      // SEGFAULTS (signal 11) during startup with GLX enabled, on any resolution. The same
      // command with GLX disabled starts fine, and the pre-existing Xvfb :99 on this host
      // carries the same flag. A headless X server has no use for GLX anyway.
      '-extension',
      'GLX',
      '-nolisten',
      'tcp',
    ]);
    started.push('xvfb');
    await waitUntilReady({
      name: 'Xvfb',
      pid: state.xvfb.pid,
      log: state.xvfb.log,
      what: `the X socket /tmp/.X11-unix/X${ports.displayNum}`,
      check: async () => existsSync(`/tmp/.X11-unix/X${ports.displayNum}`),
    });
  }
  if (!existing?.live?.wm) {
    const wmBin = findWindowManager();
    if (wmBin === null) {
      state.wm = null;
      writeErr(
        `${SELF}: no window manager found (tried ${WM_CANDIDATE_PATHS.join(', ')}). Automation is ` +
          `unaffected, but a human taking over via noVNC will have no window focus management — ` +
          `a login popup may be impossible to type into. Install one: apt-get install -y openbox\n`,
      );
    } else {
      // The WM inherits DISPLAY through the environment; it takes no display argument.
      const wmStartedAt = Date.now();
      state.wm = {
        ...spawnDetached(profile, 'wm', wmBin, [], { DISPLAY: ports.display }),
        bin: wmBin,
      };
      started.push(`wm:${wmBin}`);
      await waitUntilReady({
        name: `window manager ${wmBin}`,
        pid: state.wm.pid,
        log: state.wm.log,
        what: 'the process to settle on the display',
        // No cheap, dependency-free WM handshake exists, so this only proves it did not exit
        // immediately — which IS the realistic failure (it cannot open the display).
        check: async () => Date.now() - wmStartedAt > 700,
        timeoutMs: 5_000,
      });
    }
  }
  if (!existing?.live?.x11vnc) {
    state.x11vnc = spawnDetached(profile, 'x11vnc', TAKEOVER_BINARIES.x11vnc, [
      '-display',
      ports.display,
      '-rfbport',
      String(ports.vncPort),
      '-localhost', // loopback only — never a public interface
      '-nopw', // safe only because of -localhost + SSH tunnel; see the header
      '-forever',
      '-shared',
      '-noxdamage',
      '-quiet',
    ]);
    started.push('x11vnc');
    await waitUntilReady({
      name: 'x11vnc',
      pid: state.x11vnc.pid,
      log: state.x11vnc.log,
      what: `the VNC port 127.0.0.1:${ports.vncPort}`,
      check: () => tcpPortOpen(ports.vncPort),
    });
  }
  if (!existing?.live?.websockify) {
    state.websockify = spawnDetached(profile, 'websockify', TAKEOVER_BINARIES.websockify, [
      '--web',
      NOVNC_WEB_ROOT,
      `127.0.0.1:${ports.novncPort}`, // loopback only
      `127.0.0.1:${ports.vncPort}`,
    ]);
    started.push('websockify');
    await waitUntilReady({
      name: 'websockify',
      pid: state.websockify.pid,
      log: state.websockify.log,
      what: `the noVNC port 127.0.0.1:${ports.novncPort}`,
      check: () => tcpPortOpen(ports.novncPort),
    });
  }

  writeJsonAtomic(takeoverStatePath(profile), state);
  return { ...state, started, novnc_url: novncUrl(ports.novncPort) };
}

function teardownTakeover(profile) {
  const state = readTakeover(profile);
  if (state === null) return [];
  const actions = [
    state.websockify?.pid
      ? terminate(state.websockify.pid, String(state.novncPort), 'websockify')
      : { what: 'websockify', result: 'no-pid-recorded' },
    state.x11vnc?.pid
      ? terminate(state.x11vnc.pid, `:${state.displayNum}`, 'x11vnc')
      : { what: 'x11vnc', result: 'no-pid-recorded' },
    // The WM goes before Xvfb: it dies on its own when the display disappears, but ordering it
    // first keeps the teardown deterministic instead of racing the X server's exit.
    state.wm?.pid
      ? terminate(state.wm.pid, state.wm.bin, `window manager (${state.wm.bin})`)
      : { what: 'window manager', result: 'none-was-running' },
    state.xvfb?.pid
      ? terminate(state.xvfb.pid, `:${state.displayNum}`, 'Xvfb')
      : { what: 'Xvfb', result: 'no-pid-recorded' },
  ];
  removeIfPresent(takeoverStatePath(profile));
  return actions;
}

// ---------------------------------------------------------------------------
// The supervisor and its file-queue IPC.
//
// WHY A SUPERVISOR AT ALL: playwright closes the browser when the process that launched it
// exits, so a CLI that launched Chrome and exited could never leave anything on screen for a
// human to take over — and `close` would have nothing to close. So `open` never drives the
// browser itself. It starts (or reuses) a DETACHED supervisor that owns the persistent
// context, and talks to it through a request/response directory pair.
//
//   .state/<profile>/session.json   supervisor pid + display + deadlines (its liveness proof)
//   .state/<profile>/req/<id>.json  a request from a CLI invocation
//   .state/<profile>/res/<id>.json  the supervisor's answer
//   .state/<profile>/stop           touch to ask the supervisor to shut down
//   .state/<profile>/auth.json      the last login evaluation, for cheap `status`
//   .state/<profile>/start.lock/    held while a supervisor is starting, so two concurrent
//                                   `open`s cannot launch two browsers on one user-data-dir
// ---------------------------------------------------------------------------
const sessionPath = (profile) => join(stateDir(profile), 'session.json');
const stopPath = (profile) => join(stateDir(profile), 'stop');
const authPath = (profile) => join(stateDir(profile), 'auth.json');
const reqDir = (profile) => join(stateDir(profile), 'req');
const resDir = (profile) => join(stateDir(profile), 'res');
const startLock = (profile) => join(stateDir(profile), 'start.lock');
const SUPERVISOR_TOKEN = '__supervise';

export const STARTUP_TIMEOUT_MS = 90_000;
export const REQUEST_TIMEOUT_MS = 120_000;
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 h of no requests → shut down
export const LOGIN_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // a human has to get to it
export const HARD_MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const POLL_MS = 250;

function readSession(profile) {
  const session = readJson(sessionPath(profile));
  if (session === null) return null;
  if (!isPidAlive(session.pid) || !pidCmdlineMatches(session.pid, SUPERVISOR_TOKEN)) {
    return { ...session, live: false };
  }
  return { ...session, live: true };
}

function newRequestId() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
}

async function waitFor(predicate, timeoutMs, onTimeout) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) return onTimeout();
    await sleep(POLL_MS);
  }
}

function tailFile(path, bytes = 4000) {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.length > bytes ? `...\n${raw.slice(-bytes)}` : raw;
  } catch (err) {
    return `<${path} unreadable: ${err.code ?? err.message}>`;
  }
}

/** Start a supervisor if none is live, and return the live session. */
async function ensureSupervisor(profile, ports) {
  const existing = readSession(profile);
  if (existing?.live) return existing;

  ensureDir(reqDir(profile), 0o700);
  ensureDir(resDir(profile), 0o700);
  removeIfPresent(stopPath(profile));

  let weStarted = false;
  try {
    mkdirSync(startLock(profile), { mode: 0o700 }); // atomic mutex
    weStarted = true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      die(EXIT.RUNTIME, `cannot create ${startLock(profile)}: ${err.message}`);
    }
    // Another invocation is mid-launch. Wait for ITS session rather than racing it.
  }

  if (weStarted) {
    if (existing !== null) removeIfPresent(sessionPath(profile)); // stale, pid is gone
    const selfPath = fileURLToPath(import.meta.url);
    const logPath = join(stateDir(profile), 'supervisor.log');
    let fd;
    try {
      fd = openSync(logPath, 'a', 0o600);
    } catch (e) {
      rmSync(startLock(profile), { recursive: true, force: true });
      return die(EXIT.RUNTIME, `cannot open ${logPath}: ${e.message}`);
    }
    writeFd(fd, `\n=== ${new Date().toISOString()} supervising ${profile} on ${ports.display} ===\n`);
    const child = spawn(
      process.execPath,
      [selfPath, SUPERVISOR_TOKEN, profile, '--display-num', String(ports.displayNum)],
      { detached: true, stdio: ['ignore', fd, fd], env: process.env },
    );
    child.unref();
    closeSync(fd);
    if (child.pid === undefined) {
      rmSync(startLock(profile), { recursive: true, force: true });
      die(EXIT.RUNTIME, `spawning the supervisor produced no pid; see ${logPath}`);
    }
  }

  return waitFor(
    () => {
      const session = readSession(profile);
      return session?.live ? session : null;
    },
    STARTUP_TIMEOUT_MS,
    () => {
      rmSync(startLock(profile), { recursive: true, force: true });
      return die(
        EXIT.RUNTIME,
        `the browser supervisor for profile "${profile}" did not come up within ` +
          `${STARTUP_TIMEOUT_MS / 1000}s. Its log tail:\n` +
          `${tailFile(join(stateDir(profile), 'supervisor.log'))}`,
      );
    },
  );
}

/** Hand a request to the live supervisor and wait for its answer. */
async function callSupervisor(profile, request) {
  const id = newRequestId();
  writeJsonAtomic(join(reqDir(profile), `${id}.json`), { id, ...request });
  const responsePath = join(resDir(profile), `${id}.json`);

  const response = await waitFor(
    () => readJson(responsePath),
    REQUEST_TIMEOUT_MS,
    () =>
      die(
        EXIT.RUNTIME,
        `the browser supervisor for "${profile}" did not answer request ${id} within ` +
          `${REQUEST_TIMEOUT_MS / 1000}s. Its log tail:\n` +
          `${tailFile(join(stateDir(profile), 'supervisor.log'))}`,
      ),
  );
  removeIfPresent(responsePath);
  return response;
}

// ---------------------------------------------------------------------------
// Reminder queueing (impure; the decision logic above it is pure)
// ---------------------------------------------------------------------------
async function fetchJson(step, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new CliError(EXIT.RUNTIME, `${step} — network error contacting ${url}: ${err.message}`);
  }
  const body = await res.text().catch((err) => `<body unreadable: ${err.message}>`);
  if (!res.ok) {
    throw new CliError(EXIT.RUNTIME, `${step} failed\nHTTP ${res.status} ${res.statusText}\n${body}`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new CliError(EXIT.RUNTIME, `${step} returned non-JSON: ${err.message}\n${body}`);
  }
}

/**
 * Queue the one-time-login reminder, unless an identical one for this profile+service was
 * queued in the last hour. The GET runs first — the dedup window is why.
 */
async function queueLoginReminder({ profile, service, serviceTitle, novncPort }) {
  const listed = await fetchJson('GET /api/reminders', REMINDERS_URL, {
    headers: { accept: 'application/json' },
  });
  const { match, ageMs, skipped } = findRecentLoginReminder(listed?.reminders, {
    profile,
    service,
    nowMs: Date.now(),
    windowMs: REMINDER_DEDUP_WINDOW_MS,
  });
  for (const s of skipped) {
    writeErr(
      `${SELF}: reminder ${s.id ?? '<no id>'} matches this profile+service but ${s.reason} — ` +
        `treating it as NOT a duplicate (a missing reminder is worse than a repeated one)\n`,
    );
  }
  if (match !== null) {
    return {
      queued: false,
      reason: 'deduplicated',
      existing_id: match.id ?? null,
      age_s: Math.round(ageMs / 1000),
      window_s: REMINDER_DEDUP_WINDOW_MS / 1000,
    };
  }

  const text = buildLoginReminderText({
    profile,
    service,
    serviceTitle,
    novncPort,
    sshTarget: SSH_TARGET,
  });
  const created = await fetchJson('POST /api/reminders', REMINDERS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, when: REMINDER_WHEN, source: `research-browser:${profile}` }),
  });
  return {
    queued: true,
    reason: 'no identical reminder within the dedup window',
    id: created?.reminder?.id ?? null,
    due_at: created?.reminder?.due_at ?? null,
    when: REMINDER_WHEN,
    text_length: text.length,
  };
}

// ---------------------------------------------------------------------------
// THE SUPERVISOR — runs detached, owns the persistent context for its whole life
// ---------------------------------------------------------------------------
async function collectSignals(page, service) {
  const signalErrors = [];
  const countVisible = async (selectors) => {
    const hits = [];
    for (const sel of selectors ?? []) {
      try {
        if (await page.locator(sel).first().isVisible()) hits.push(sel);
      } catch (err) {
        // A selector that cannot be evaluated is reported in the JSON, not swallowed.
        signalErrors.push(`${sel} — ${err.message.split('\n')[0]}`);
      }
    }
    return hits;
  };

  let passwordFieldCount = 0;
  try {
    passwordFieldCount = await page.locator('input[type="password"]:visible').count();
  } catch (err) {
    signalErrors.push(`input[type="password"]:visible — ${err.message.split('\n')[0]}`);
  }

  return {
    finalUrl: page.url(),
    title: await page.title().catch((err) => `<title unreadable: ${err.message}>`),
    passwordFieldCount,
    loggedOutHits: await countVisible(service.loggedOutSelectors),
    loggedInHits: await countVisible(service.loggedInSelectors),
    signalErrors,
  };
}

async function supervise(profile, displayNum) {
  const ports = portsForDisplay(displayNum);
  const dir = stateDir(profile);
  ensureDir(dir, 0o700);
  ensureDir(reqDir(profile), 0o700);
  ensureDir(resDir(profile), 0o700);

  // The X display must exist before a HEADED Chrome can start. Headed is required, not
  // cosmetic: a headless browser has nothing for a human to take over.
  await ensureTakeover(profile, ports);
  const { mod: playwright, path: playwrightPath } = resolvePlaywright();
  const chromePath = resolveChrome();
  ensureDir(profileDir(profile), 0o700);

  writeErr(`${SELF}[supervisor]: playwright ${playwrightPath}, chrome ${chromePath}\n`);

  const context = await playwright.chromium.launchPersistentContext(profileDir(profile), {
    headless: false, // a takeover needs a real window on the real display
    executablePath: chromePath,
    viewport: { width: 1600, height: 1000 },
    env: { ...process.env, DISPLAY: ports.display },
    // --no-sandbox: this runs as root, where Chrome's sandbox refuses to start at all.
    // --disable-dev-shm-usage: /dev/shm is small in containers; Chrome crashes without this.
    // --disable-blink-features=AutomationControlled + dropping --enable-automation: fewer bot
    //   defenses trip on a browser that does not announce itself as automated.
    // --disable-features=CDPScreenshotNewSurface: REQUIRED HERE, measured 2026-08-05. playwright
    //   passes --enable-features=CDPScreenshotNewSurface, and on this box that path makes every
    //   Page.captureScreenshot fail with "Unable to capture screenshot" for a HEADED browser on
    //   Xvfb (reproduced with and without a window manager; --disable-features restores the
    //   working path and produces a byte-identical PNG to --disable-gpu). This flag was chosen
    //   over --disable-gpu / --use-angle=swiftshader, which also fix it, because it changes
    //   nothing about rendering: --disable-gpu is visible to WebGL fingerprinting, and this tool
    //   exists to survive bot defenses. If a future Chrome drops the feature name the flag
    //   becomes a no-op and screenshots fail LOUDLY again (exit 1, the error above) — never
    //   silently.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=CDPScreenshotNewSurface',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  let idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
  const hardDeadline = Date.now() + HARD_MAX_SESSION_MS;

  const writeSessionFile = () =>
    writeJsonAtomic(sessionPath(profile), {
      pid: process.pid,
      profile,
      display: ports.display,
      displayNum: ports.displayNum,
      vncPort: ports.vncPort,
      novncPort: ports.novncPort,
      profile_dir: profileDir(profile),
      chrome: chromePath,
      playwright: playwrightPath,
      started_at: new Date().toISOString(),
      idle_deadline: new Date(idleDeadline).toISOString(),
      hard_deadline: new Date(hardDeadline).toISOString(),
    });

  writeSessionFile();
  rmSync(startLock(profile), { recursive: true, force: true }); // the session file is the proof now

  const shutdown = async (reason) => {
    writeErr(`${SELF}[supervisor]: shutting down (${reason})\n`);
    await context.close().catch((err) => writeErr(`${SELF}[supervisor]: context.close: ${err.message}\n`));
    removeIfPresent(sessionPath(profile));
    removeIfPresent(stopPath(profile));
    teardownTakeover(profile);
    process.exit(EXIT.OK);
  };

  for (;;) {
    if (existsSync(stopPath(profile))) await shutdown('stop file');
    if (Date.now() > hardDeadline) await shutdown(`hard session cap ${HARD_MAX_SESSION_MS / 3600000}h`);
    if (Date.now() > idleDeadline) await shutdown(`idle for ${IDLE_TIMEOUT_MS / 60000} min`);

    let names = [];
    try {
      names = readdirSync(reqDir(profile)).filter((n) => n.endsWith('.json'));
    } catch (err) {
      writeErr(`${SELF}[supervisor]: cannot read ${reqDir(profile)}: ${err.message}\n`);
    }

    for (const name of names) {
      const path = join(reqDir(profile), name);
      const request = readJson(path);
      removeIfPresent(path);
      if (request === null) continue;

      let response;
      try {
        response = await handleRequest({ profile, page, ports, request });
      } catch (err) {
        response = {
          ok: false,
          exit_code: err instanceof CliError ? err.code : EXIT.RUNTIME,
          error: `${err.name ?? 'Error'}: ${err.message}`,
        };
        writeErr(`${SELF}[supervisor]: request ${request.id} failed: ${err.stack ?? err.message}\n`);
      }

      idleDeadline =
        Date.now() +
        (response?.payload?.login?.needs_login === true ? LOGIN_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS);
      writeSessionFile();
      writeJsonAtomic(join(resDir(profile), `${request.id}.json`), { id: request.id, ...response });
    }

    await sleep(POLL_MS);
  }
}

/** One navigate-evaluate-screenshot cycle, plus the login handshake when a wall shows up. */
async function handleRequest({ profile, page, ports, request }) {
  const service = resolveService({ service: request.service, url: request.url, profile });
  const url = request.url;

  let navigation = null;
  if (typeof url === 'string' && url !== '') {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      navigation = { requested: url, http_status: res?.status() ?? null };
    } catch (err) {
      throw new CliError(EXIT.RUNTIME, `navigating to ${url} failed: ${err.message.split('\n')[0]}`);
    }
  }

  const signals = await collectSignals(page, service);
  const verdict = evaluateLoginWall(service, signals);

  // Default label: the wall names itself, so a screenshot is self-describing on disk.
  const label =
    typeof request.label === 'string' && request.label.trim() !== ''
      ? request.label
      : verdict.needsLogin
        ? `${service.key}-login-wall`
        : `${service.key}-open`;

  const shot = screenshotRecord(request.run_id, new Date(), label);
  ensureDir(dirname(shot.path), 0o755); // forge-control must be able to serve it
  try {
    await page.screenshot({ path: shot.path });
  } catch (err) {
    throw new CliError(EXIT.RUNTIME, `screenshot to ${shot.path} failed: ${err.message.split('\n')[0]}`);
  }
  if (!shot.url_servable) {
    writeErr(
      `${SELF}[supervisor]: run id "${request.run_id}" is not 12 hex chars, so ` +
        `GET ${shot.url} will 400 (forge-control/src/routes/uploads.ts ID_RE). The file itself ` +
        `is at ${shot.path}.\n`,
    );
  }

  const takeover = await ensureTakeover(profile, ports);
  let reminder = null;
  if (verdict.needsLogin && request.queue_reminder !== false) {
    reminder = await queueLoginReminder({
      profile,
      service: service.key,
      serviceTitle: service.title,
      novncPort: ports.novncPort,
    });
  }

  writeJsonAtomic(authPath(profile), {
    checked_at: new Date().toISOString(),
    service: service.key,
    url: signals.finalUrl,
    authenticated: verdict.authenticated,
    needs_login: verdict.needsLogin,
    decision: verdict.decision,
    reasons: verdict.reasons,
  });

  return {
    ok: true,
    exit_code: verdict.needsLogin ? EXIT.LOGIN_REQUIRED : EXIT.OK,
    payload: {
      navigation,
      page: { url: signals.finalUrl, title: signals.title },
      service: service.key,
      login: {
        needs_login: verdict.needsLogin,
        authenticated: verdict.authenticated,
        decision: verdict.decision,
        reasons: verdict.reasons,
        signal_errors: signals.signalErrors,
      },
      takeover: {
        up: true,
        display: ports.display,
        vnc_port: ports.vncPort,
        novnc_port: ports.novncPort,
        novnc_url: takeover.novnc_url,
        ssh_tunnel: sshTunnelCommand(ports.novncPort),
        bound_to: '127.0.0.1 only — never a public interface',
        window_manager: takeover.wm?.bin ?? null,
      },
      reminder,
      screenshots: [shot],
    },
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
export const SUBCOMMANDS = ['open', 'status', 'takeover', 'close'];

export const USAGE = `usage: ${SELF} <subcommand> <profile> [flags]
       ${SELF} --help

A persistent-profile browser harness for the research lane. Named profiles keep a logged-in
Chrome session across runs; a login wall triggers a noVNC takeover so a human can log in ONCE,
by hand, and never again. NO PASSWORD IS EVER STORED, READ, OR TYPED BY THIS TOOL.

subcommands:
  open <profile> [--url URL] [--label L] [--run-id ID] [--service S] [--no-reminder]
        Launch or attach a Chrome persistentContext on ${PROFILES_ROOT}/<profile>/,
        navigate, evaluate the login signals, screenshot, print JSON status.
        On a login wall: exit ${EXIT.LOGIN_REQUIRED}, browser LEFT RUNNING for takeover.
  status <profile> [--probe] [--run-id ID]
        Is a session live, is the profile authenticated, what is the takeover URL.
        Cheap by default (reads the last recorded evaluation). --probe re-navigates to the
        service home through the live session for an authoritative answer.
  takeover <profile>
        Ensure Xvfb + x11vnc + websockify are up for this profile's display; print the
        noVNC URL and the SSH tunnel command. Does not need a browser.
  close <profile>
        Tear down the browser and the whole takeover stack for this profile.

flags:
  --url URL        page to open (default: the resolved service's home; required for 'generic')
  --label L        screenshot label, sanitised to [a-z0-9-]
                   (default: <service>-open, or <service>-login-wall on a wall)
  --run-id ID      screenshot directory under ${UPLOADS_ROOT}/
                   (default: $FORGE_RUN_ID, else the sentinel "${ADHOC_RUN_ID}")
  --service S      force a SERVICES entry: ${Object.keys(SERVICES).join(' ')}
                   (default: inferred from --url's host, then from the profile name)
  --probe          'status' only: re-navigate and re-evaluate instead of reading cached state
  --no-reminder    'open' only: detect the wall and exit ${EXIT.LOGIN_REQUIRED} but queue no reminder
  --help, -h       print this help and exit 0
  Flags accept either "--url X" or "--url=X".

profiles:
  ${PROFILES_ROOT}/<profile>/
      Chrome user-data-dir, mode 0700. Session cookies and Chrome's own profile state,
      NOTHING ELSE. No passwords, ever.
  ${STATE_ROOT}/<profile>/
      this tool's pids, logs, display pin and last login evaluation.
  Profile names must match ${PROFILE_RE}.

screenshots:
  ${UPLOADS_ROOT}/<run_id>/<compact-ISO8601>-<label>.png
  served by forge-control at /api/uploads/<run_id>/<name>. Both the absolute path and the URL
  appear in the JSON. That route only accepts a 12-hex run id, so every entry also carries
  url_servable — a differently shaped run id still gets the documented path, and says so.

takeover / security:
  x11vnc binds -localhost and websockify binds 127.0.0.1. The VNC surface is NEVER exposed on
  a public interface. Reach it with:
    ${sshTunnelCommand(NOVNC_PORT_BASE, SSH_TARGET)}     (port varies per profile)

exit codes:
  0  success — JSON status on stdout
  1  runtime error (browser launch, X/VNC startup, IPC timeout, reminder POST failure)
  2  missing prerequisite (playwright module, Chrome, Xvfb/x11vnc/websockify/noVNC)
  3  usage error
  4  LOGIN REQUIRED — wall detected, takeover up, wall screenshotted, reminder queued, browser
     left running. Distinct on purpose: this means "needs Konrad", not "broke".

examples:
  ${SELF} open perplexity
  ${SELF} open scratch --url https://example.com --label smoke --run-id 0aa1fce7813c
  ${SELF} status perplexity --probe
  ${SELF} takeover perplexity
  ${SELF} close scratch
`;

export function parseArgs(argv) {
  const opts = {
    subcommand: null,
    profile: null,
    url: null,
    label: null,
    runId: null,
    service: null,
    probe: false,
    reminder: true,
    help: false,
  };
  const takesValue = new Set(['--url', '--label', '--run-id', '--service']);
  const boolFlags = new Set(['--probe', '--no-reminder']);
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      return opts;
    }

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);

      if (boolFlags.has(name)) {
        if (eq !== -1) throw new CliError(EXIT.USAGE, `flag ${name} takes no value`);
        if (name === '--probe') opts.probe = true;
        else opts.reminder = false;
        continue;
      }
      if (!takesValue.has(name)) throw new CliError(EXIT.USAGE, `unknown flag: ${arg}`);

      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        value = argv[++i];
        if (value === undefined) throw new CliError(EXIT.USAGE, `flag ${name} requires a value`);
      }
      if (value === '') throw new CliError(EXIT.USAGE, `flag ${name} requires a non-empty value`);

      if (name === '--url') opts.url = value;
      else if (name === '--label') opts.label = value;
      else if (name === '--run-id') opts.runId = value;
      else opts.service = value;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length === 0) throw new CliError(EXIT.USAGE, `missing subcommand`);
  const [subcommand, profile, ...extra] = positional;
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new CliError(
      EXIT.USAGE,
      `unknown subcommand "${subcommand}"; expected one of: ${SUBCOMMANDS.join(' ')}`,
    );
  }
  if (profile === undefined) {
    throw new CliError(EXIT.USAGE, `subcommand "${subcommand}" requires a <profile> argument`);
  }
  if (extra.length > 0) {
    throw new CliError(EXIT.USAGE, `unexpected extra argument(s): ${extra.join(' ')}`);
  }
  if (!PROFILE_RE.test(profile)) {
    throw new CliError(
      EXIT.USAGE,
      `invalid profile name "${profile}" — must match ${PROFILE_RE} (lowercase letters, ` +
        `digits and dashes, starting alphanumeric, max 39 chars)`,
    );
  }
  if (opts.probe && subcommand !== 'status') {
    throw new CliError(EXIT.USAGE, `--probe applies to 'status' only, not '${subcommand}'`);
  }
  if (!opts.reminder && subcommand !== 'open') {
    throw new CliError(EXIT.USAGE, `--no-reminder applies to 'open' only, not '${subcommand}'`);
  }

  opts.subcommand = subcommand;
  opts.profile = profile;
  return opts;
}

/** The URL an 'open'/'--probe' should navigate to, or a usage error explaining what is missing. */
export function resolveTargetUrl(opts, service) {
  if (opts.url !== null) return opts.url;
  if (service.home !== null) return service.home;
  throw new CliError(
    EXIT.USAGE,
    `--url is required: no service was matched for profile "${opts.profile}" (fell back to ` +
      `"${service.key}", which has no default home). Pass --url, or --service ` +
      `${Object.keys(SERVICES)
        .filter((k) => SERVICES[k].home !== null)
        .join('|')}.`,
  );
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------
function baseStatus(profile, subcommand, ports, runInfo) {
  return {
    tool: 'research-browser',
    subcommand,
    profile,
    profile_dir: profileDir(profile),
    state_dir: stateDir(profile),
    display: ports.display,
    run_id: runInfo.runId,
    run_id_source: runInfo.source,
    run_id_servable: isServableRunId(runInfo.runId),
  };
}

async function cmdOpen(opts) {
  const runInfo = resolveRunId(opts.runId);
  const service = resolveService({ service: opts.service, url: opts.url, profile: opts.profile });
  const url = resolveTargetUrl(opts, service);
  const ports = assignDisplay(opts.profile);

  await ensureSupervisor(opts.profile, ports);
  const response = await callSupervisor(opts.profile, {
    action: 'navigate',
    url,
    label: opts.label,
    run_id: runInfo.runId,
    service: service.key,
    queue_reminder: opts.reminder,
  });

  if (response.ok !== true) {
    return die(
      response.exit_code ?? EXIT.RUNTIME,
      `open failed: ${response.error ?? 'no error text from the supervisor'}\n` +
        `  supervisor log tail:\n${tailFile(join(stateDir(opts.profile), 'supervisor.log'))}`,
    );
  }

  const session = readSession(opts.profile);
  return {
    status: { ...baseStatus(opts.profile, 'open', ports, runInfo), ...response.payload,
      session: { live: session?.live === true, pid: session?.pid ?? null, started_at: session?.started_at ?? null } },
    exitCode: response.exit_code,
  };
}

async function cmdStatus(opts) {
  const runInfo = resolveRunId(opts.runId);
  const ports = assignDisplay(opts.profile);
  const session = readSession(opts.profile);
  const takeover = readTakeover(opts.profile);
  const service = resolveService({ service: opts.service, url: opts.url, profile: opts.profile });

  if (opts.probe) {
    const url = resolveTargetUrl(opts, service);
    await ensureSupervisor(opts.profile, ports);
    const response = await callSupervisor(opts.profile, {
      action: 'navigate',
      url,
      label: opts.label ?? `${service.key}-status-probe`,
      run_id: runInfo.runId,
      service: service.key,
      queue_reminder: false, // a status check must not page a human
    });
    if (response.ok !== true) {
      return die(
        response.exit_code ?? EXIT.RUNTIME,
        `status --probe failed: ${response.error ?? 'no error text from the supervisor'}`,
      );
    }
    const after = readSession(opts.profile);
    return {
      status: {
        ...baseStatus(opts.profile, 'status', ports, runInfo),
        probe: 'live — navigated and re-evaluated just now',
        ...response.payload,
        session: { live: after?.live === true, pid: after?.pid ?? null, started_at: after?.started_at ?? null },
      },
      exitCode: response.exit_code,
    };
  }

  const auth = readJson(authPath(opts.profile));
  return {
    status: {
      ...baseStatus(opts.profile, 'status', ports, runInfo),
      probe: 'cached — run `status <profile> --probe` for an authoritative answer',
      service: service.key,
      session: {
        live: session?.live === true,
        pid: session?.pid ?? null,
        started_at: session?.started_at ?? null,
        idle_deadline: session?.idle_deadline ?? null,
        stale_state_file: session !== null && session.live === false,
      },
      login: auth === null
        ? { authenticated: null, needs_login: null, checked_at: null,
            note: 'this profile has never been evaluated — run open or status --probe' }
        : { authenticated: auth.authenticated, needs_login: auth.needs_login,
            decision: auth.decision, reasons: auth.reasons, checked_at: auth.checked_at,
            url: auth.url },
      profile_exists: existsSync(profileDir(opts.profile)),
      takeover: {
        up: takeover?.up === true,
        processes: takeover?.live ?? null,
        display: ports.display,
        vnc_port: ports.vncPort,
        novnc_port: ports.novncPort,
        novnc_url: novncUrl(ports.novncPort),
        ssh_tunnel: sshTunnelCommand(ports.novncPort),
        bound_to: '127.0.0.1 only — never a public interface',
        window_manager: takeover?.wm?.bin ?? null,
      },
    },
    exitCode: EXIT.OK,
  };
}

async function cmdTakeover(opts) {
  const runInfo = resolveRunId(opts.runId);
  const ports = assignDisplay(opts.profile);
  ensureDir(stateDir(opts.profile), 0o700);
  const takeover = await ensureTakeover(opts.profile, ports);
  const session = readSession(opts.profile);
  return {
    status: {
      ...baseStatus(opts.profile, 'takeover', ports, runInfo),
      takeover: {
        up: true,
        started_now: takeover.started,
        display: ports.display,
        vnc_port: ports.vncPort,
        novnc_port: ports.novncPort,
        novnc_url: takeover.novnc_url,
        ssh_tunnel: sshTunnelCommand(ports.novncPort),
        bound_to: '127.0.0.1 only — never a public interface',
        window_manager: takeover.wm?.bin ?? null,
        logs: {
          xvfb: takeover.xvfb?.log ?? null,
          wm: takeover.wm?.log ?? null,
          x11vnc: takeover.x11vnc?.log ?? null,
          websockify: takeover.websockify?.log ?? null,
        },
      },
      session: { live: session?.live === true, pid: session?.pid ?? null },
      note:
        session?.live === true
          ? 'a browser session is live on this display'
          : 'no browser is running on this display yet — run `open <profile>` to put one there',
    },
    exitCode: EXIT.OK,
  };
}

async function cmdClose(opts) {
  const runInfo = resolveRunId(opts.runId);
  const ports = assignDisplay(opts.profile);
  const session = readSession(opts.profile);
  const actions = [];

  if (session?.live) {
    // Ask first: the supervisor closes the context cleanly and tears down its own stack.
    ensureDir(stateDir(opts.profile), 0o700);
    writeFileSync(stopPath(opts.profile), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const gone = await waitFor(() => (readSession(opts.profile) === null ? true : null), 20_000, () => false);
    if (gone) {
      actions.push({ what: 'supervisor', result: 'stopped-gracefully', pid: session.pid });
    } else {
      actions.push({ what: 'supervisor', result: 'stop-file-ignored-20s', pid: session.pid });
      actions.push(terminate(session.pid, SUPERVISOR_TOKEN, 'supervisor (SIGTERM)'));
      removeIfPresent(sessionPath(opts.profile));
      removeIfPresent(stopPath(opts.profile));
    }
  } else {
    if (session !== null) {
      actions.push({ what: 'supervisor', result: 'stale-session-file-removed', pid: session.pid });
      removeIfPresent(sessionPath(opts.profile));
    } else {
      actions.push({ what: 'supervisor', result: 'not-running' });
    }
    removeIfPresent(stopPath(opts.profile));
  }

  // Whatever the supervisor did or did not clean up, the stack must be gone when this returns.
  actions.push(...teardownTakeover(opts.profile));
  rmSync(startLock(opts.profile), { recursive: true, force: true });

  return {
    status: {
      ...baseStatus(opts.profile, 'close', ports, runInfo),
      actions,
      note:
        `the profile directory ${profileDir(opts.profile)} is NOT touched — its cookies are the ` +
        `whole point of a persistent profile`,
    },
    exitCode: EXIT.OK,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(argv) {
  // The detached supervisor re-enters this file. Handled before parseArgs because
  // __supervise is an internal protocol, not part of the CLI surface.
  if (argv[0] === SUPERVISOR_TOKEN) {
    const profile = argv[1];
    const idx = argv.indexOf('--display-num');
    const displayNum = idx === -1 ? Number.NaN : Number.parseInt(argv[idx + 1], 10);
    if (!PROFILE_RE.test(profile ?? '') || !Number.isInteger(displayNum)) {
      die(EXIT.USAGE, `internal: ${SUPERVISOR_TOKEN} <profile> --display-num <n> (got: ${argv.join(' ')})`);
    }
    await supervise(profile, displayNum);
    return; // supervise() never returns; it exits from shutdown()
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliError) die(err.code, `${err.message}\n\n${USAGE}`);
    throw err;
  }
  if (opts.help) {
    writeOut(USAGE);
    process.exit(EXIT.OK);
  }

  ensureDir(PROFILES_ROOT, 0o700);
  ensureDir(STATE_ROOT, 0o700);
  ensureDir(stateDir(opts.profile), 0o700);

  const handlers = { open: cmdOpen, status: cmdStatus, takeover: cmdTakeover, close: cmdClose };
  const { status, exitCode } = await handlers[opts.subcommand](opts);

  // stdout FIRST, then the exit — writeOut is synchronous, so nothing is lost to exit().
  writeOut(`${JSON.stringify(status, null, 2)}\n`);
  if (exitCode === EXIT.LOGIN_REQUIRED) {
    writeErr(
      `${SELF}: LOGIN REQUIRED for profile "${opts.profile}" — the browser is still running.\n` +
        `  Open ${status.takeover?.novnc_url}\n` +
        `  Tunnel first: ${status.takeover?.ssh_tunnel}\n`,
    );
  }
  process.exit(exitCode);
}

/**
 * Only run as a program when invoked as one. The test suite imports the pure helpers above
 * from this same file, which is what keeps them testable without a browser, a display or a
 * network — importing must therefore not launch anything.
 */
function isMain() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return statSync(entry).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isMain()) {
  await main(process.argv.slice(2)).catch((err) => {
    if (err instanceof CliError) die(err.code, err.message);
    die(EXIT.RUNTIME, `unhandled: ${err?.stack ?? err}`);
  });
}
