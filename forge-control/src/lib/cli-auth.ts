/**
 * The CLI sign-in broker — turning a terminal paste-a-code OAuth into a button.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `agy` (Antigravity CLI) is the ONLY path from this box to Konrad's Google AI
 * plan: Google retired the standalone Gemini CLI's individual Code Assist
 * client on 2026-06-18, so `gemini` writes valid credentials and then answers
 * `IneligibleTierError` on every call. agy's login has no browser callback this
 * server can catch — redirect_uri is https://antigravity.google/oauth-callback —
 * so a human must read a code off Google's page and paste it back.
 *
 * That is brokerable. What is NOT brokerable is doing it through a chat thread:
 * the paste window is a hard 60 SECONDS, measured on process exit across three
 * clean runs at 60.544–60.548s, and a message round-trip costs more than that.
 * Three chat attempts failed on exactly this. In a settings panel the URL and
 * the paste box are on one screen and a miss costs one click, so the window
 * stops being the deciding factor. Every design choice below follows from that
 * single number.
 *
 * ── WHAT DECIDES `connected` ─────────────────────────────────────────────────
 * The PROBE, never the pane. When the pane exits we run the same
 * `agy models` probe the connections row already uses. This is deliberate and
 * it is the load-bearing choice in the file:
 *
 *   - `/root/.gemini/oauth_creds.json` exists RIGHT NOW, 1826 bytes, for a CLI
 *     that cannot serve a single token. Credentials on disk are not a session.
 *     Anything that concluded "connected" from a file's existence would be
 *     wrong today, on this box, with this file.
 *   - A pane string is a UI decision by a vendor. If a future agy release
 *     rewords its success line, a marker-matching broker turns every successful
 *     login into a reported failure. The probe cannot drift that way.
 *
 * So `probe` is non-null exactly when a probe has run, and `connected` requires
 * `probe.ok`. That is the same invariant the rest of the settings surface holds
 * ("an unprobed connection is amber, never green") rather than a second opinion
 * about the same substrate.
 */

import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AGY_BIN,
  AGY_PROBE_ARGS,
  AGY_PROBE_TIMEOUT_MS,
  classifyAgyProbe,
  runCommand,
  type CommandOutcome,
  type ConnectionRecord,
} from "./connection-status.ts";

const TMUX_BIN = "/usr/bin/tmux";
const SECRET_TOOL_BIN = "/usr/bin/secret-tool";

/** Absolute, always. pm2's environment has no `/root/.local/bin` — that export
 *  lives in `.bashrc`, which pm2 never sources — so a PATH walk or a bare
 *  `spawn("agy")` reports "not installed" for a binary that is right there,
 *  while a human testing the same code over SSH sees it work perfectly. */
const CLAUDE_BIN = "/usr/bin/claude";

export type CliAuthProvider = "agy" | "gemini-cli" | "claude";

export const CLI_AUTH_PROVIDERS: readonly CliAuthProvider[] = [
  "agy",
  "gemini-cli",
  "claude",
];

export function isCliAuthProvider(v: string): v is CliAuthProvider {
  return (CLI_AUTH_PROVIDERS as readonly string[]).includes(v);
}

/**
 * There is no eighth state and no "submitted". A pasted code is `exchanging`
 * until the CLI answers; then it is `connected`, `failed` or `expired`. An
 * optimistic "submitted" is precisely the lie this surface exists to delete.
 */
export type CliAuthState =
  | "idle"
  | "starting"
  | "awaiting_code"
  | "exchanging"
  | "connected"
  | "expired"
  | "failed";

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
  url: string | null;
  prompt: string | null;
  window_seconds: number | null;
  started_at: string | null;
  expires_at: string | null;
  detail: string;
  action: string;
  probe: CliAuthProbe | null;
}

export interface CliAuthTarget {
  slug: string;
  config_dir: string;
}

/* ── Provider definitions ─────────────────────────────────────────────────── */

interface ProviderDef {
  /** Absolute path, checked with access(X_OK). Never resolved through PATH. */
  bin: string;
  label: string;
  /** Verbatim prompt the CLI blocks on. Matched against pane content. */
  pastePrompt: string;
  /**
   * A menu the CLI shows BEFORE it will print a URL, and which must be
   * dismissed with Enter.
   *
   * This exists because of a gap that only a real run exposes: every
   * measurement of agy's flow was taken with `agy -p '<prompt>'`, which goes
   * straight to the consent URL. The broker cannot use `-p` — that would run a
   * model call after the login and spend tokens for nothing — so it launches
   * the bare TUI, and the bare TUI first asks "Select login method: 1. Google
   * OAuth / 2. Use a Google Cloud project" and blocks. The measured flow and
   * the shipped flow were therefore not the same flow, and the first live
   * start timed out at 20s staring at a menu.
   *
   * Option 1 is pre-selected, so a bare Enter takes it. Null when the provider
   * shows no menu.
   */
  preUrlMenu: { marker: string; keys: readonly string[] } | null;
  /** Regex that finds the consent URL in the pane. */
  urlPattern: RegExp;
  /**
   * Query parameters the consent URL MUST contain to be usable.
   *
   * A terminal truncates at the pane edge, and a truncated URL is still a
   * syntactically valid URL — it just silently drops the parameters that make
   * the OAuth request work. Handing one to Konrad spends a click and a sign-in
   * on a link that dies at Google. So completeness is asserted, not assumed:
   * an incomplete match is treated as "the URL has not finished rendering",
   * and the poll keeps going.
   */
  requiredUrlParams: readonly string[];
  /**
   * The hard consent window, or null when NOBODY HAS MEASURED ONE. Null is not
   * "unlimited" — the UI must say "unmeasured" rather than draw a countdown
   * from a guess.
   */
  windowSeconds: number | null;
  /**
   * Lines that mean the window expired, and lines that mean the code was bad.
   *
   * THESE MUST NOT MATCH THE SHARED TAIL. agy ends BOTH failures with
   * `Error: authentication failed or timed out`; only the preceding line
   * separates them. Matching the tail makes every bad paste render as "your
   * window expired", sending Konrad to re-race 60 seconds he never lost while
   * hiding the real cause (a stale URL, a code from a previous launch, a code
   * already spent). A wrong code also fails in ~0.4s versus a full 60s, so
   * elapsed time corroborates the classification.
   */
  expiryMarkers: readonly string[];
  failureMarkers: readonly string[];
  /** Advisory only — success is decided by the probe. Mined from the binary. */
  successMarkers: readonly string[];
  /** Whether this provider can be signed in at all through this broker. */
  loginSupported: boolean;
  /** Why not, when it cannot. Rendered verbatim. */
  loginUnsupportedReason: string | null;
}

const PROVIDERS: Record<CliAuthProvider, ProviderDef> = {
  agy: {
    bin: AGY_BIN,
    label: "Antigravity CLI (agy)",
    pastePrompt: "Or, paste the authorization code here and press Enter:",
    preUrlMenu: { marker: "Select login method", keys: ["Enter"] },
    urlPattern: /https:\/\/accounts\.google\.com\/o\/oauth2[^\s]*/,
    requiredUrlParams: ["redirect_uri=", "response_type=", "state=", "scope="],
    windowSeconds: 60,
    expiryMarkers: ["Error: authentication timed out."],
    failureMarkers: ["invalid_grant", "invalid_request", "invalid code"],
    // Both literals exist in agy 1.1.18. The second is the BROWSER callback
    // page and must never appear in a pane; it is listed so nobody reuses this
    // array against an HTTP response.
    successMarkers: [
      "Authentication successful!",
      "Authentication successful! You can close this window.",
    ],
    loginSupported: true,
    loginUnsupportedReason: null,
  },

  "gemini-cli": {
    bin: "/usr/bin/gemini",
    label: "Gemini CLI",
    pastePrompt: "Enter the authorization code:",
    preUrlMenu: null,
    urlPattern: /https:\/\/accounts\.google\.com\/o\/oauth2[^\s]*/,
    requiredUrlParams: ["redirect_uri=", "response_type="],
    windowSeconds: null,
    expiryMarkers: [],
    failureMarkers: ["IneligibleTierError", "Failed to authenticate"],
    successMarkers: [],
    loginSupported: false,
    loginUnsupportedReason:
      "Google retired this client. Signing in still works mechanically — the code is " +
      "exchanged and credentials are written to /root/.gemini/oauth_creds.json — and then " +
      "every call fails IneligibleTierError, exit 55: \"This client is no longer supported " +
      "for Gemini Code Assist for individuals... migrate to the Antigravity suite of " +
      "products.\" A Connect button here could only ever produce a signed-in-looking row " +
      "that serves nothing, so there is not one. Use the Antigravity CLI (agy) row instead " +
      "— that is Google's own recommended replacement — or the Gemini API key row, which is " +
      "billed per token rather than drawn from the Google AI plan.",
  },

  claude: {
    bin: CLAUDE_BIN,
    label: "Claude Code",
    // NOT MEASURED. Left here as the documented shape only; loginSupported is
    // false so nothing reads it as fact. Filling this in requires one observed
    // run of `claude auth login --claudeai` on a pty, which was cut short.
    pastePrompt: "",
    preUrlMenu: null,
    urlPattern: /https:\/\/claude\.ai\/[^\s]*/,
    requiredUrlParams: [],
    windowSeconds: null,
    expiryMarkers: [],
    failureMarkers: [],
    successMarkers: [],
    loginSupported: false,
    loginUnsupportedReason:
      "Not yet wired. The prompt string, URL shape and paste window for " +
      "`claude auth login --claudeai` have not been observed on a pty on this box, and a " +
      "paste-a-code affordance built against an assumed flow is the failure this broker " +
      "exists to avoid. Claude account `arved` is already healthy and serving; adding a " +
      "SECOND account still needs a terminal until that one measurement is taken.",
  },
};

export function providerLabel(p: CliAuthProvider): string {
  return PROVIDERS[p].label;
}

/* ── Substrate checks ─────────────────────────────────────────────────────── */

/**
 * `true`, `false`, or `null` for "could not decide".
 *
 * NULL IS LOAD-BEARING. An errno that is not ENOENT/EACCES — EIO, ELOOP, a
 * mount that went away — folded into `false` prints "not installed" because a
 * disk hiccuped, and sends Konrad to install software that is already there.
 */
async function binaryPresent(bin: string): Promise<boolean | null> {
  try {
    await access(bin, FS.X_OK);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EACCES") return false;
    return null;
  }
}

export interface KeyringVerdict {
  /** true = unlocked AND writable. false = present but unusable. null = undecidable. */
  usable: boolean | null;
  detail: string;
}

/**
 * Prove the keyring by ROUND TRIP, never by looking for a process.
 *
 * agy persists its OAuth token through go-keyring, which has NO FILE FALLBACK.
 * A running `gnome-keyring-daemon` whose collection is LOCKED accepts the token
 * and silently discards it — so you win the 60-second race and lose the
 * credential anyway, which is the most expensive possible way to learn this.
 * "A daemon is running" is not the property that matters; "the collection is
 * unlocked and writable" is, and only a store→lookup→clear proves it.
 *
 * (`pgrep gnome-keyring-daemon` cannot even establish the weaker property:
 * process NAMES over 15 characters never match without `-f`, and the warning
 * goes to stderr, so `pgrep ... || echo NOT RUNNING` prints a confident false
 * negative for a daemon that is very much alive.)
 */
export async function keyringUsable(): Promise<KeyringVerdict> {
  const present = await binaryPresent(SECRET_TOOL_BIN);
  if (present === null) {
    return { usable: null, detail: `Could not stat ${SECRET_TOOL_BIN}.` };
  }
  if (present === false) {
    return {
      usable: null,
      detail:
        `${SECRET_TOOL_BIN} is not installed, so the keyring cannot be verified from here. ` +
        "That is not the same as the keyring being locked — it means this check cannot decide.",
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? "unix:path=/run/user/0/bus",
  };
  // pm2's environment carries DBUS_SESSION_BUS_ADDRESS no more reliably than it
  // carries /root/.local/bin on PATH, hence the explicit default above.

  const service = `forge-cli-auth-probe-${randomUUID().slice(0, 8)}`;
  const value = randomUUID(); // throwaway; never a real credential
  let dir: string | null = null;

  try {
    dir = await mkdtemp(join(tmpdir(), "forge-keyring-"));
    const probeFile = join(dir, "v");
    await writeFile(probeFile, value, { mode: 0o600 });

    const store = await runCommand(
      "/bin/sh",
      [
        "-c",
        `${SECRET_TOOL_BIN} store --label=forge-cli-auth-probe service ${service} account probe < ${probeFile}`,
      ],
      { timeoutMs: 15_000, env },
    );
    if (store.code !== 0) {
      return {
        usable: false,
        detail:
          "The keyring rejected a write, so agy could not persist a token even after a " +
          `successful sign-in.${store.stderr.trim() ? `\n\nSTDERR: ${store.stderr.trim()}` : ""}`,
      };
    }

    const lookup = await runCommand(
      SECRET_TOOL_BIN,
      ["lookup", "service", service, "account", "probe"],
      { timeoutMs: 15_000, env },
    );
    const readBack = lookup.stdout.trim() === value;

    return readBack
      ? {
          usable: true,
          detail:
            "The Secret Service stored a throwaway value and returned it unchanged, so agy " +
            "will persist its token once the sign-in completes.",
        }
      : {
          usable: false,
          detail:
            "The keyring accepted a write but did not return the value, so a token would be " +
            "silently lost. Run /root/.local/bin/agy-keyring-unlock.sh and try again.",
        };
  } catch (err) {
    return {
      usable: null,
      detail: `The keyring probe itself failed: ${(err as Error).message}`,
    };
  } finally {
    // Always, even on failure — a probe must not leave residue in a credential store.
    await runCommand(
      SECRET_TOOL_BIN,
      ["clear", "service", service, "account", "probe"],
      { timeoutMs: 15_000, env },
    ).catch(() => undefined);
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ── tmux pane driver ─────────────────────────────────────────────────────── */

async function tmux(args: readonly string[], timeoutMs = 10_000): Promise<CommandOutcome> {
  return await runCommand(TMUX_BIN, args, { timeoutMs, env: process.env });
}

async function capturePane(session: string): Promise<string | null> {
  const out = await tmux(["capture-pane", "-p", "-J", "-t", session]);
  if (out.code !== 0) return null;
  return out.stdout;
}

/**
 * Is the pane's process gone?
 *
 * `#{pane_dead}` ONLY. `#{pane_dead_status}` and `#{pane_dead_time}` never
 * populate for agy — 5/5 exits, ruled out as a tick lag by re-reading and ruled
 * out as a tmux limitation by a control `/bin/sh -c 'exit 7'` session which
 * populates both fine. A branch keyed on a numeric status this provider never
 * emits cannot be taken, so it is not a bug that fires: it is dead code that
 * reads as thorough.
 */
async function paneDead(session: string): Promise<boolean> {
  const out = await tmux(["display-message", "-p", "-t", session, "#{pane_dead}"]);
  if (out.code !== 0) return true; // no session at all
  return out.stdout.trim() === "1";
}

async function sessionExists(session: string): Promise<boolean> {
  const out = await tmux(["has-session", "-t", session]);
  return out.code === 0;
}

async function killSession(session: string): Promise<void> {
  await tmux(["kill-session", "-t", session]).catch(() => undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Session store ────────────────────────────────────────────────────────── */

interface Session {
  id: string;
  provider: CliAuthProvider;
  tmuxName: string;
  target: CliAuthTarget | null;
  url: string | null;
  startedAt: number;
  expiresAt: number | null;
  state: CliAuthState;
  detail: string;
  probe: CliAuthProbe | null;
}

/** One live login per provider. forge-control is a single process; a second
 *  concurrent login for the same CLI would race the same credential store. */
const sessions = new Map<CliAuthProvider, Session>();

function keyOf(provider: CliAuthProvider): CliAuthProvider {
  return provider;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function render(s: Session | null, provider: CliAuthProvider, action: string, detail?: string): CliAuthStatus {
  const def = PROVIDERS[provider];
  if (s === null) {
    return {
      provider,
      state: "idle",
      session_id: null,
      url: null,
      prompt: null,
      window_seconds: def.windowSeconds,
      started_at: null,
      expires_at: null,
      detail: detail ?? "No sign-in is in progress.",
      action,
      probe: null,
    };
  }
  return {
    provider,
    state: s.state,
    session_id: s.id,
    // A URL outlives its usefulness the moment the pane dies: the PKCE verifier
    // is minted per launch, so a code obtained from a dead session's URL can
    // never be exchanged. Nulling it here is what stops the UI offering a link
    // that leads to a closed door.
    url: s.state === "awaiting_code" ? s.url : null,
    prompt: s.state === "awaiting_code" ? def.pastePrompt : null,
    window_seconds: def.windowSeconds,
    started_at: iso(s.startedAt),
    expires_at: s.expiresAt === null ? null : iso(s.expiresAt),
    detail: detail ?? s.detail,
    action,
    probe: s.probe,
  };
}

/* ── Probe: the only thing that may say `connected` ───────────────────────── */

async function probeProvider(provider: CliAuthProvider): Promise<ConnectionRecord> {
  const checkedAt = new Date().toISOString();
  if (provider === "agy") {
    const outcome = await runCommand(AGY_BIN, AGY_PROBE_ARGS, {
      timeoutMs: AGY_PROBE_TIMEOUT_MS,
    });
    return classifyAgyProbe(outcome, checkedAt);
  }
  return {
    ok: false,
    identity: null,
    detail: `No probe is defined for ${provider}.`,
    checked_at: checkedAt,
  };
}

function toProbeView(r: ConnectionRecord): CliAuthProbe {
  return {
    ok: r.ok,
    identity: r.identity,
    detail: r.detail,
    checked_at: r.checked_at,
  };
}

/* ── Verbs ────────────────────────────────────────────────────────────────── */

export interface StartResult {
  status: CliAuthStatus;
  httpStatus: number;
}

export async function startLogin(
  provider: CliAuthProvider,
  target: CliAuthTarget | null,
): Promise<StartResult> {
  const def = PROVIDERS[provider];

  if (!def.loginSupported) {
    return {
      httpStatus: 409,
      status: render(null, provider, "Use the row's alternative, described above.", def.loginUnsupportedReason ?? "This provider cannot be signed in from here."),
    };
  }

  const present = await binaryPresent(def.bin);
  if (present === false) {
    return {
      httpStatus: 409,
      status: render(null, provider, `Install the CLI, then reload this panel.`, `${def.bin} is not present or not executable.`),
    };
  }
  if (present === null) {
    return {
      httpStatus: 503,
      status: render(null, provider, "Retry; if this persists, check the filesystem.", `Could not determine whether ${def.bin} exists — the check itself failed, which is not the same as the binary being absent.`),
    };
  }

  // THE KEYRING IS A PRECONDITION OF STARTING, NOT A DETAIL OF FINISHING.
  // Minting a URL against a locked keyring spends Konrad's 60 seconds on a
  // token that will be thrown away.
  if (provider === "agy") {
    const kr = await keyringUsable();
    if (kr.usable === false) {
      return {
        httpStatus: 409,
        status: render(null, provider, "Run /root/.local/bin/agy-keyring-unlock.sh on this box, then click Connect again.", `Refusing to start: ${kr.detail} agy stores its token through the OS keyring and has no file fallback, so a sign-in completed now would be discarded.`),
      };
    }
    // `null` (undecidable) does NOT block. Refusing to start because a probe
    // could not decide would make a broken checker into a broken feature.
  }

  await cancelLogin(provider);

  const id = randomUUID();
  const tmuxName = `cliauth-${provider}-${id.slice(0, 8)}`;
  const startedAt = Date.now();

  const env: string[] = [];
  if (provider === "claude" && target !== null) {
    env.push(`CLAUDE_CONFIG_DIR=${target.config_dir}`);
  }
  const launch = `${env.join(" ")} ${def.bin}`.trim();

  // `exec bash` on purpose: the pane must survive the CLI so its final lines can
  // be read after exit. It is also exactly why liveness is `#{pane_dead}` and
  // classification is pane CONTENT — the shell outlives the process, so
  // `has-session` would report a login that ended an hour ago as still running.
  // WIDTH 1000 IS LOAD-BEARING, NOT A PREFERENCE.
  // The bare TUI renders the consent URL inside its own layout and TRUNCATES it
  // to the pane width. At 200 columns the captured URL was 198 characters and
  // looked perfectly well-formed while missing redirect_uri, scope and state —
  // a dead link that fails at Google with no hint as to why. At 1000 the full
  // 704-character URL is captured. (The earlier `agy -p` measurements never saw
  // this: print mode writes the URL raw, so it never met the TUI's layout.)
  const created = await tmux([
    "new-session", "-d", "-s", tmuxName, "-x", "1000", "-y", "50",
    `${launch}; exec bash`,
  ]);
  if (created.code !== 0) {
    return {
      httpStatus: 500,
      status: render(null, provider, "Retry.", `Could not start a terminal session: ${created.stderr.trim() || "tmux refused"}`),
    };
  }

  const session: Session = {
    id,
    provider,
    tmuxName,
    target,
    url: null,
    startedAt,
    expiresAt: null,
    state: "starting",
    detail: "Starting the CLI.",
    probe: null,
  };
  sessions.set(keyOf(provider), session);

  // Poll for the consent URL, dismissing the login-method menu on the way if
  // this provider shows one. `menuDismissed` is a latch: sending Enter twice
  // would answer whatever question came AFTER the menu.
  let menuDismissed = def.preUrlMenu === null;
  for (let i = 0; i < 25; i++) {
    const pane = await capturePane(tmuxName);
    if (pane !== null) {
      if (!menuDismissed && def.preUrlMenu !== null && pane.includes(def.preUrlMenu.marker)) {
        for (const key of def.preUrlMenu.keys) {
          await tmux(["send-keys", "-t", tmuxName, key]);
        }
        menuDismissed = true;
        await sleep(1000);
        continue;
      }
      const m = def.urlPattern.exec(pane);
      if (m !== null && urlIsComplete(def, m[0])) {
        session.url = m[0];
        session.state = "awaiting_code";
        // The window starts when the PROMPT appears, not when we spawned.
        session.expiresAt =
          def.windowSeconds === null ? null : Date.now() + def.windowSeconds * 1000;
        session.detail =
          def.windowSeconds === null
            ? "Open the link, sign in, and paste the code Google shows you."
            : `Open the link, sign in, and paste the code Google shows you. This CLI accepts the code for ${def.windowSeconds} seconds — if it lapses, click Relaunch for a fresh link.`;
        return { httpStatus: 200, status: render(session, provider, "Open the link, then paste the code below.") };
      }
    }
    await sleep(1000);
  }

  const tail = (await capturePane(tmuxName)) ?? "";
  await killSession(tmuxName);
  sessions.delete(keyOf(provider));
  return {
    httpStatus: 504,
    status: render(null, provider, "Click Connect to try again.", `The CLI did not print a COMPLETE sign-in URL within 25 seconds. A URL truncated by the terminal is rejected rather than published, because it would fail at Google with no explanation.${tail.trim() ? `\n\nTerminal said:\n${tail.trim().slice(-600)}` : ""}`),
  };
}

/**
 * Classify what the pane says AFTER a code has been delivered.
 *
 * Expiry and failure are matched on their SPECIFIC lines, never on the shared
 * tail both paths end with.
 */
/** Every required parameter present, or it is not a URL we will publish. */
function urlIsComplete(def: ProviderDef, url: string): boolean {
  return def.requiredUrlParams.every((p) => url.includes(p));
}

function classifyPane(def: ProviderDef, pane: string): "expired" | "failed" | null {
  for (const m of def.expiryMarkers) if (pane.includes(m)) return "expired";
  for (const m of def.failureMarkers) if (pane.includes(m)) return "failed";
  return null;
}

export async function submitCode(
  provider: CliAuthProvider,
  code: string,
): Promise<{ status: CliAuthStatus; httpStatus: number }> {
  const def = PROVIDERS[provider];
  const s = sessions.get(keyOf(provider)) ?? null;

  if (s === null || s.state !== "awaiting_code") {
    return {
      httpStatus: 409,
      status: render(s, provider, "Click Connect to start a fresh sign-in.", "There is no sign-in waiting for a code. The PKCE verifier is minted per launch, so a code from an earlier attempt can never be exchanged — start a new one."),
    };
  }

  if (!(await sessionExists(s.tmuxName)) || (await paneDead(s.tmuxName))) {
    s.state = "expired";
    s.detail = "The CLI exited before the code arrived.";
    return { httpStatus: 409, status: render(s, provider, "Click Relaunch for a fresh link.") };
  }

  s.state = "exchanging";

  // The code reaches the pane through a 0600 file, never an argv (which `ps`
  // publishes) and never a shell string (which history keeps). It is shredded
  // immediately, and it is never logged, never echoed, never put in a URL.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "forge-cliauth-"));
    const codeFile = join(dir, "c");
    await writeFile(codeFile, code.trim(), { mode: 0o600 });

    const load = await tmux(["load-buffer", "-b", `ca-${s.id.slice(0, 8)}`, codeFile]);
    if (load.code !== 0) {
      s.state = "failed";
      s.detail = "Could not hand the code to the terminal.";
      return { httpStatus: 500, status: render(s, provider, "Click Relaunch and try again.") };
    }
    await tmux(["paste-buffer", "-b", `ca-${s.id.slice(0, 8)}`, "-t", s.tmuxName]);
    await tmux(["send-keys", "-t", s.tmuxName, "Enter"]);
    await tmux(["delete-buffer", "-b", `ca-${s.id.slice(0, 8)}`]).catch(() => undefined);
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // A wrong code fails in ~0.4s; a real exchange takes a few seconds. Poll for
  // the process to exit, then let the PROBE decide what happened.
  //
  // Timed from the PASTE, not from the session start: the session clock
  // includes however long Konrad spent in the browser, so "rejected
  // immediately" measured from it would be meaningless the moment a sign-in
  // takes more than five seconds — which is every real one.
  const submittedAt = Date.now();
  const deadline = submittedAt + 45_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const dead = await paneDead(s.tmuxName);
    const pane = (await capturePane(s.tmuxName)) ?? "";
    const verdict = classifyPane(def, pane);

    if (verdict !== null || dead) {
      const record = await probeProvider(provider);
      s.probe = toProbeView(record);

      if (record.ok) {
        s.state = "connected";
        s.url = null;
        s.detail = record.identity
          ? `Signed in as ${record.identity}.`
          : `Signed in. ${record.detail}`;
        await killSession(s.tmuxName);
        return { httpStatus: 200, status: render(s, provider, "Nothing to do.") };
      }

      const elapsedMs = Date.now() - submittedAt;
      s.state = verdict === "expired" ? "expired" : "failed";
      s.url = null;
      s.detail =
        verdict === "expired"
          ? `The ${def.windowSeconds}-second window closed before the code was accepted.`
          : `The CLI rejected that code${elapsedMs < 5_000 ? " immediately" : ""} — it is stale, already used, or was copied from a different sign-in attempt.\n\n${record.detail}`;
      await killSession(s.tmuxName);
      return { httpStatus: 200, status: render(s, provider, "Click Relaunch for a fresh link, then paste the new code.") };
    }
  }

  s.state = "failed";
  s.detail = "The CLI neither accepted nor rejected the code within 45 seconds.";
  await killSession(s.tmuxName);
  return { httpStatus: 200, status: render(s, provider, "Click Relaunch and try again.") };
}

export async function readLogin(provider: CliAuthProvider): Promise<CliAuthStatus> {
  const def = PROVIDERS[provider];
  const s = sessions.get(keyOf(provider)) ?? null;

  if (s === null) {
    return render(
      null,
      provider,
      def.loginSupported ? "Click Connect to sign in." : "See the note above.",
      def.loginSupported ? "No sign-in is in progress." : def.loginUnsupportedReason ?? "",
    );
  }

  if (s.state === "awaiting_code") {
    const lapsed = s.expiresAt !== null && Date.now() > s.expiresAt;
    const gone = !(await sessionExists(s.tmuxName)) || (await paneDead(s.tmuxName));
    if (lapsed || gone) {
      s.state = "expired";
      s.url = null;
      s.detail = `The ${def.windowSeconds ?? "?"}-second window closed. The link is dead — its PKCE verifier died with the process.`;
      return render(s, provider, "Click Relaunch for a fresh link.");
    }
  }

  const action =
    s.state === "awaiting_code"
      ? "Open the link, then paste the code below."
      : s.state === "connected"
        ? "Nothing to do."
        : s.state === "expired" || s.state === "failed"
          ? "Click Relaunch for a fresh link."
          : "Waiting for the CLI.";
  return render(s, provider, action);
}

export async function cancelLogin(provider: CliAuthProvider): Promise<CliAuthStatus> {
  const s = sessions.get(keyOf(provider)) ?? null;
  if (s !== null) {
    await killSession(s.tmuxName);
    sessions.delete(keyOf(provider));
  }
  return render(null, provider, "Click Connect to sign in.", "No sign-in is in progress.");
}

/** Exposed for the route's unsupported-provider copy. */
export function loginUnsupportedReason(p: CliAuthProvider): string | null {
  return PROVIDERS[p].loginUnsupportedReason;
}

export function loginSupported(p: CliAuthProvider): boolean {
  return PROVIDERS[p].loginSupported;
}
